//! The shells a tab can host, per platform, and how to launch each one with the
//! shell integration that makes semantic command blocks possible.
//!
//! A tab's PTY runs a real interactive shell. For OctoShell to know where each
//! command's output starts and ends (and its exit code), the shell has to emit
//! OSC 133 markers — `C` when a command starts, `D;<code>` when it ends, `A`/`B`
//! around the prompt — plus OSC 7 with its working directory. Each shell here
//! knows how to get those markers in:
//!
//!   * **PowerShell** — a `prompt` override + an Enter key handler, injected via
//!     `-EncodedCommand` (the original Windows integration, unchanged).
//!   * **zsh** — `precmd`/`preexec` hooks from an rc file OctoShell writes and
//!     points `ZDOTDIR` at; that rc sources the user's own zsh files first, so
//!     their prompt, aliases and PATH are all there. (The same trick VS Code uses.)
//!   * **bash** — the same hooks via `PROMPT_COMMAND` + a `DEBUG` trap, from an
//!     `--rcfile` that sources the user's own files first.
//!
//! `cmd` and WSL are spawned raw: they work as plain terminals but produce no
//! command blocks, which the Settings UI flags (`semantic: false`).
//!
//! The frontend's shell picker is rendered from [`list`], so adding a shell is
//! one entry in this file and nothing anywhere else.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::CommandBuilder;
use serde::Serialize;

use crate::platform;

/// One shell OctoShell knows how to host on this platform.
#[derive(Serialize, Clone)]
pub struct ShellInfo {
    /// The id persisted in Settings (`workspace.defaultShell`).
    pub id: &'static str,
    /// Picker label.
    pub label: &'static str,
    /// True when OctoShell injects shell integration into it, so the terminal
    /// produces per-command blocks with exit codes.
    pub semantic: bool,
    /// Whether the shell's binary is actually installed here.
    pub available: bool,
}

/// PowerShell shell-integration script, injected at startup via `-EncodedCommand`.
///
/// It overrides `prompt` to emit OSC 133 D (previous command end + exit code),
/// OSC 7 (cwd), and OSC 133 A/B (prompt boundaries). On the first prompt it also
/// installs an Enter handler that emits OSC 133 C (command start) — registered
/// lazily because PSReadLine is only loaded once the interactive prompt begins.
const POWERSHELL_INTEGRATION: &str = r#"
function global:prompt {
  if (-not $global:__octoInit) {
    try {
      Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        [Console]::Write("$([char]27)]133;C$([char]7)")
      }
    } catch {}
    try { Set-PSReadLineOption -PredictionSource None } catch {}
    $global:__octoInit = $true
  }
  $e = [char]27; $b = [char]7
  $c = if ($?) { 0 } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }
  $p = (Get-Location).ProviderPath -replace '\\','/'
  "$e]133;D;$c$b$e]7;file://$env:COMPUTERNAME/$p$b$e]133;A$b$e]133;B$b"
}
"#;

/// zsh integration. `precmd` runs before each prompt (so it closes the previous
/// command with D and reports the cwd), `preexec` right after a command line is
/// accepted (C). B rides on the prompt itself, wrapped in `%{ %}` so zsh doesn't
/// count the invisible bytes as prompt width. The cwd is percent-encoded the way
/// OSC 7 expects, and `parse_cwd` decodes it.
const ZSH_INTEGRATION: &str = r#"
# --- OctoShell shell integration (OSC 133 command markers + OSC 7 cwd) ---
__octo_precmd() {
  local __octo_code=$?
  local __octo_pwd=${PWD//\%/%25}
  __octo_pwd=${__octo_pwd// /%20}
  printf '\e]133;D;%d\a' "$__octo_code"
  printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$__octo_pwd"
  printf '\e]133;A\a'
  # B marks where input starts. Re-applied every prompt: themes such as starship
  # rebuild PS1 from their own precmd, which would drop a marker added once.
  local __octo_b=$'%{\e]133;B\a%}'
  [[ "$PS1" == *"$__octo_b"* ]] || PS1+=$__octo_b
}
__octo_preexec() { printf '\e]133;C\a'; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __octo_precmd
add-zsh-hook preexec __octo_preexec
"#;

/// bash integration. bash has no `preexec`; the `DEBUG` trap fires before every
/// command, so a flag armed by the prompt hook makes only the FIRST one per
/// command line emit C (the trap also fires for PROMPT_COMMAND itself, when the
/// flag is already clear). B rides on PS1 inside `\[ \]` (zero-width for bash).
const BASH_INTEGRATION: &str = r#"
# --- OctoShell shell integration (OSC 133 command markers + OSC 7 cwd) ---
__octo_ready=0
# First in PROMPT_COMMAND, so $? is still the user's command's exit code.
__octo_precmd_first() {
  local __octo_code=$?
  local __octo_pwd=${PWD//%/%25}
  __octo_pwd=${__octo_pwd// /%20}
  printf '\e]133;D;%d\a' "$__octo_code"
  printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$__octo_pwd"
  printf '\e]133;A\a'
}
# Last in PROMPT_COMMAND, after any theme has rebuilt PS1: re-apply the B marker
# and arm the DEBUG trap for the next command line.
__octo_precmd_last() {
  local __octo_b='\[\e]133;B\a\]'
  case "$PS1" in *"$__octo_b"*) ;; *) PS1="${PS1}${__octo_b}" ;; esac
  __octo_ready=1
}
__octo_preexec() {
  [ "$__octo_ready" = 1 ] || return
  __octo_ready=0
  printf '\e]133;C\a'
}
PROMPT_COMMAND="__octo_precmd_first${PROMPT_COMMAND:+;$PROMPT_COMMAND};__octo_precmd_last"
trap '__octo_preexec' DEBUG
"#;

/// Encode a script as PowerShell `-EncodedCommand` (UTF-16LE → base64).
/// Avoids all command-line quoting issues.
fn encode_ps(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    STANDARD.encode(utf16)
}

fn powershell_command(shell: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encode_ps(POWERSHELL_INTEGRATION)]);
    cmd
}

/// Every shell this platform offers, in picker order.
pub fn list() -> Vec<ShellInfo> {
    #[cfg(windows)]
    {
        vec![
            ShellInfo {
                id: "powershell",
                label: "PowerShell (pwsh)",
                semantic: true,
                available: platform::which("pwsh.exe") || platform::which("powershell.exe"),
            },
            ShellInfo { id: "cmd", label: "CMD", semantic: false, available: true },
            ShellInfo { id: "wsl", label: "WSL / Ubuntu", semantic: false, available: platform::which("wsl.exe") },
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            ShellInfo { id: "zsh", label: "zsh", semantic: true, available: platform::which("zsh") },
            ShellInfo { id: "bash", label: "bash", semantic: true, available: platform::which("bash") },
            ShellInfo {
                id: "powershell",
                label: "PowerShell (pwsh)",
                semantic: true,
                available: platform::which("pwsh"),
            },
        ]
    }
}

/// The shell a tab gets when Settings names none, or names one this platform
/// doesn't have. Windows: PowerShell. Elsewhere: the user's login shell when it's
/// one we integrate with, else zsh on macOS (the system default since Catalina)
/// and bash on Linux.
pub fn default_id() -> &'static str {
    #[cfg(windows)]
    {
        "powershell"
    }
    #[cfg(not(windows))]
    {
        let login = std::env::var("SHELL").unwrap_or_default();
        let name = login.rsplit('/').next().unwrap_or("");
        match name {
            "zsh" | "bash" => list().into_iter().find(|s| s.id == name && s.available).map(|s| s.id),
            _ => None,
        }
        .unwrap_or(if cfg!(target_os = "macos") { "zsh" } else { "bash" })
    }
}

/// Map a persisted shell id to one this platform can launch. A workspace
/// carried over from another OS may name a shell that doesn't exist here.
pub fn resolve(id: &str) -> &'static str {
    list()
        .into_iter()
        .find(|s| s.id == id && s.available)
        .map(|s| s.id)
        .unwrap_or_else(default_id)
}

/// The launch command for shell `id` (already resolved) in `start_dir`.
///
/// Returns the builders to try in order: PowerShell on Windows prefers `pwsh`
/// and falls back to Windows PowerShell, so the caller attempts each until one
/// spawns.
pub fn commands(id: &str, start_dir: &str) -> Result<Vec<CommandBuilder>, String> {
    let mut variants: Vec<CommandBuilder> = match id {
        "cmd" => vec![CommandBuilder::new("cmd.exe")],
        "wsl" => vec![CommandBuilder::new("wsl.exe")],
        "zsh" => vec![zsh_command()?],
        "bash" => vec![bash_command()?],
        // "powershell": prefer pwsh 7, fall back to Windows PowerShell.
        _ => {
            if cfg!(windows) {
                vec![powershell_command("pwsh.exe"), powershell_command("powershell.exe")]
            } else {
                vec![powershell_command("pwsh")]
            }
        }
    };
    for b in &mut variants {
        b.cwd(start_dir);
        #[cfg(not(windows))]
        {
            // A GUI launch has no locale; without one the shell and every tool
            // under it print UTF-8 as `?`. Only fill the gap, never override.
            if std::env::var_os("LANG").is_none() {
                b.env("LANG", "en_US.UTF-8");
            }
            b.env("TERM", "xterm-256color");
            b.env("COLORTERM", "truecolor");
            b.env("TERM_PROGRAM", "OctoShell");
        }
    }
    Ok(variants)
}

/// Where the rc shims live. Rewritten on every spawn: cheap, and it means an
/// upgrade never runs a stale integration script.
fn integration_dir(shell: &str) -> Result<PathBuf, String> {
    let dir = platform::scratch_dir().join("shell-integration").join(shell);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A zsh rc shim that runs the user's own file of the same name from their real
/// `ZDOTDIR` (or `$HOME`), then — for `.zshrc` only — appends the integration.
/// `ZDOTDIR` is swapped back to the user's for the duration of their file, so
/// anything it sources relatively still resolves, then restored so zsh keeps
/// reading OUR shims for the rest of startup.
fn zsh_shim(name: &str, tail: &str) -> String {
    format!(
        r#"# OctoShell zsh shim: runs your own {name}, then OctoShell's shell integration.
if [[ -f "$OCTO_USER_ZDOTDIR/{name}" ]]; then
  OCTO_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$OCTO_USER_ZDOTDIR
  . "$OCTO_USER_ZDOTDIR/{name}"
  ZDOTDIR=$OCTO_ZDOTDIR
  unset OCTO_ZDOTDIR
fi
{tail}"#
    )
}

fn zsh_command() -> Result<CommandBuilder, String> {
    let dir = integration_dir("zsh")?;
    let user_zdotdir = std::env::var_os("ZDOTDIR")
        .map(PathBuf::from)
        .or_else(platform::home_dir)
        .ok_or("no HOME directory")?;
    // After .zshrc the startup sequence is over: hand ZDOTDIR back so a `zsh`
    // the user types gets their normal config, not our shims again. And keep
    // history where it belongs: macOS's /etc/zshrc defaults HISTFILE to
    // `$ZDOTDIR/.zsh_history`, which with our ZDOTDIR would quietly divert the
    // user's history into a temp folder.
    let restore = "\nif [[ \"$HISTFILE\" == \"$ZDOTDIR\"/* ]]; then HISTFILE=\"$OCTO_USER_ZDOTDIR/.zsh_history\"; fi\n\
                   if [[ -n \"$OCTO_USER_ZDOTDIR_WAS_SET\" ]]; then ZDOTDIR=$OCTO_USER_ZDOTDIR; else unset ZDOTDIR; fi\n\
                   unset OCTO_USER_ZDOTDIR OCTO_USER_ZDOTDIR_WAS_SET\n";
    let files = [
        (".zshenv", String::new()),
        (".zprofile", String::new()),
        (".zshrc", format!("{ZSH_INTEGRATION}{restore}")),
        (".zlogin", String::new()),
    ];
    for (name, tail) in files {
        std::fs::write(dir.join(name), zsh_shim(name, &tail)).map_err(|e| e.to_string())?;
    }
    let mut cmd = CommandBuilder::new("zsh");
    // Login + interactive, like Terminal.app: PATH and the user's prompt both
    // come from their login files.
    cmd.args(["-il"]);
    cmd.env("ZDOTDIR", &dir);
    cmd.env("OCTO_USER_ZDOTDIR", &user_zdotdir);
    if std::env::var_os("ZDOTDIR").is_some() {
        cmd.env("OCTO_USER_ZDOTDIR_WAS_SET", "1");
    }
    Ok(cmd)
}

fn bash_command() -> Result<CommandBuilder, String> {
    let dir = integration_dir("bash")?;
    let home = platform::home_dir().ok_or("no HOME directory")?;
    // `--rcfile` replaces ~/.bashrc, and bash reads NO rc file at all as a login
    // shell — so the shim itself does what a login shell would: /etc/profile,
    // then the first of the user's profile files (which conventionally source
    // ~/.bashrc), like Terminal.app. Linux terminals run non-login shells, so
    // there only ~/.bashrc is read.
    let user_files = if cfg!(target_os = "macos") {
        r#"[ -f /etc/profile ] && . /etc/profile
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"
fi"#
    } else {
        r#"[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc""#
    };
    let rc = format!("# OctoShell bash rc: runs your own startup files, then OctoShell's shell integration.\n{user_files}\n{BASH_INTEGRATION}");
    let path = dir.join("octoshell.bashrc");
    std::fs::write(&path, rc).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("bash");
    cmd.arg("--rcfile");
    cmd.arg(&path);
    cmd.arg("-i");
    cmd.env("HOME", &home);
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_shell_is_one_we_can_launch() {
        let d = default_id();
        assert!(list().iter().any(|s| s.id == d), "default {d} is not in the shell list");
    }

    #[test]
    fn unknown_ids_fall_back_to_the_default() {
        assert_eq!(resolve("fish-from-another-machine"), default_id());
        assert_eq!(resolve(""), default_id());
    }

    #[test]
    fn integration_scripts_carry_every_marker() {
        for s in [POWERSHELL_INTEGRATION, ZSH_INTEGRATION, BASH_INTEGRATION] {
            for marker in ["133;A", "133;B", "133;C", "133;D", "]7;file://"] {
                assert!(s.contains(marker), "missing {marker}");
            }
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn zsh_shims_are_written_and_forward_to_the_user() {
        let cmd = zsh_command().expect("zsh command");
        let _ = cmd;
        let dir = integration_dir("zsh").unwrap();
        for f in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let text = std::fs::read_to_string(dir.join(f)).unwrap_or_else(|_| panic!("{f} missing"));
            assert!(text.contains(&format!("$OCTO_USER_ZDOTDIR/{f}")));
        }
        assert!(std::fs::read_to_string(dir.join(".zshrc")).unwrap().contains("__octo_precmd"));
    }
}
