//! The one place OS differences live.
//!
//! OctoShell grew up on Windows, and every module that spawned a process used to
//! carry its own `#[cfg(windows)]` block: hide the console window, find the home
//! directory, kill a process tree. Those blocks are now functions here, each with
//! a macOS/Linux implementation beside the Windows one, so a caller asks for what
//! it needs ("hide the console", "kill the tree") and never has to know how a
//! given platform does it.
//!
//! The Windows behaviour is unchanged: the same flags and the same commands, just
//! called from one place.

use std::path::PathBuf;
use std::process::Command;

/// The OS name the frontend keys platform-specific copy and scripts on.
pub const OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

/// The user's home directory, without pulling in the `dirs` crate:
/// `USERPROFILE` on Windows, `HOME` elsewhere.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(PathBuf::from)
}

/// Where large, regenerable files live (the ~90 MB embedding model). Each OS has
/// a conventional spot: `%LOCALAPPDATA%`, `~/Library/Caches`, `$XDG_CACHE_HOME`.
pub fn cache_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".cache")));
    #[cfg(target_os = "macos")]
    let base = home_dir().map(|h| h.join("Library").join("Caches"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".cache")));
    base.unwrap_or_else(std::env::temp_dir).join("OctoShell")
}

/// A scratch directory OctoShell owns for files it regenerates on every launch
/// (the approval sidecar, shell-integration rc files). Under the OS temp dir,
/// which on macOS is per-user and space-free.
pub fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join("octoshell")
}

// ───────────────────────────── spawning ─────────────────────────────

/// Stop a spawned console program from flashing a window. Windows only; a no-op
/// elsewhere, where there is no console window to flash.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Make the child the leader of its own process group, so [`kill_tree`] can end
/// it together with everything it spawns (`sh -c npm run dev` → npm → node). On
/// Windows the Job Object plays this role (see `jobctl.rs`), so this is a no-op.
pub fn own_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// [`own_process_group`] for a tokio command.
pub fn own_process_group_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Configure a long-lived helper (a dev server, an agent CLI): no console window,
/// and its own process group so it can be stopped as a tree.
pub fn background(cmd: &mut Command) {
    hide_console(cmd);
    own_process_group(cmd);
}

/// Run a short helper and return its stdout, or None if it couldn't be run.
pub fn capture(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ───────────────────────────── killing ─────────────────────────────

/// Terminate a process AND its descendants.
///
/// Windows: `taskkill /T /F`, the only reliable tree kill without extra job
/// plumbing. Unix: the process was spawned as a group leader (see
/// [`own_process_group`]), so signal the whole group: TERM first, a short grace
/// period for servers that clean up on exit, then KILL for whatever ignored it.
pub fn kill_tree(pid: u32) {
    kill_trees(&[pid]);
}

/// [`kill_tree`] for several processes at once, sharing one grace period so app
/// exit doesn't pay it per process.
pub fn kill_trees(pids: &[u32]) {
    #[cfg(windows)]
    for pid in pids {
        let _ = capture("taskkill", &["/T", "/F", "/PID", &pid.to_string()]);
    }
    #[cfg(unix)]
    {
        let groups: Vec<i32> = pids.iter().filter_map(|&p| signal_target(p)).collect();
        if groups.is_empty() {
            return;
        }
        for &g in &groups {
            unsafe {
                libc::kill(g, libc::SIGTERM);
            }
        }
        // Grace: poll for the leaders to go away, up to ~500ms.
        for _ in 0..25 {
            let alive = groups.iter().any(|&g| unsafe { libc::kill(g, 0) } == 0);
            if !alive {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        for &g in &groups {
            unsafe {
                libc::kill(g, libc::SIGKILL);
            }
        }
    }
}

/// Force-kill ONE process (no descendants) — for a foreign process we merely
/// found holding a port, which is not ours to tree-kill.
pub fn kill_pid(pid: u32) -> bool {
    #[cfg(windows)]
    {
        capture("taskkill", &["/F", "/PID", &pid.to_string()]).is_some()
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) == 0 }
    }
}

/// What to signal for `pid`: its whole process group when it leads one of its
/// own, else just the process. Never our own group — a child that was NOT put in
/// its own group shares ours, and signalling that would kill OctoShell itself.
#[cfg(unix)]
fn signal_target(pid: u32) -> Option<i32> {
    let pid = pid as i32;
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid < 0 {
        return None; // already gone
    }
    let ours = unsafe { libc::getpgrp() };
    Some(if pgid == pid && pgid != ours { -pgid } else { pid })
}

/// PIDs of the direct children of `pid` — i.e. whatever a shell is currently
/// running. Empty when the shell is idle at its prompt.
pub fn child_pids(pid: u32) -> Vec<u32> {
    #[cfg(windows)]
    let out = {
        let script = format!(
            "Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}' | Select-Object -ExpandProperty ProcessId"
        );
        capture("powershell", &["-NoProfile", "-NonInteractive", "-Command", &script]).unwrap_or_default()
    };
    #[cfg(not(windows))]
    let out = capture("pgrep", &["-P", &pid.to_string()]).unwrap_or_default();
    out.lines().filter_map(|l| l.trim().parse::<u32>().ok()).collect()
}

// ───────────────────────────── PATH lookups ─────────────────────────────

/// True if `exe` (an exact file name) is on PATH.
pub fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

/// PATH lookup for a *command* by bare name, matching however it's actually
/// installed. On Windows a CLI shipped via npm is a shim — `foo`, `foo.cmd`,
/// `foo.ps1` — not `foo.exe`, so a plain `which("foo.exe")` misses it (this is
/// exactly why the Gemini CLI showed up as "not found"). We try the bare name
/// plus every extension in PATHEXT (falling back to the common shim set).
pub fn which_cmd(name: &str) -> bool {
    if which(name) {
        return true;
    }
    #[cfg(windows)]
    {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".into());
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            // PATHEXT entries include the leading dot, e.g. ".CMD".
            if which(&format!("{name}{}", ext.to_ascii_lowercase())) {
                return true;
            }
        }
        // .ps1 shims (npm) aren't in the default PATHEXT — check explicitly.
        which(&format!("{name}.ps1"))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Give a GUI-launched OctoShell the PATH the user's terminal has.
///
/// On macOS an app opened from Finder, the Dock or Spotlight inherits launchd's
/// PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — and nothing the user set up in their
/// shell: no Homebrew, no nvm/fnm Node, no `~/.local/bin`. Every CLI OctoShell
/// drives (`claude`, `node`, `gh`, `git` from Homebrew) would then be "not
/// found" even though it works fine in Terminal. So, before anything is spawned,
/// ask the user's login shell what PATH it ends up with and adopt it. This is
/// what VS Code and other editors do. A no-op on Windows and when launched from
/// a terminal that already has a real PATH.
pub fn adopt_login_shell_path() {
    #[cfg(unix)]
    {
        let Some(path) = login_shell_path() else { return };
        // Union: the login PATH first, then anything we already had that it lacks
        // (never lose an entry a launcher deliberately added).
        let mut entries: Vec<PathBuf> = std::env::split_paths(&path).collect();
        if let Some(cur) = std::env::var_os("PATH") {
            for p in std::env::split_paths(&cur) {
                if !entries.contains(&p) {
                    entries.push(p);
                }
            }
        }
        if let Ok(joined) = std::env::join_paths(entries) {
            std::env::set_var("PATH", joined);
        }
    }
}

/// Ask the user's login shell for its PATH. `-l` runs the login files (where
/// PATH is usually set), `-i` the rc file (nvm/fnm hooks live there); the
/// sentinel isolates PATH from any banner the rc files print. None when the
/// shell can't be run, hangs, or prints nothing usable.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = Command::new(&shell);
    cmd.args(["-lic", "printf '__OCTO_PATH__%s__OCTO_PATH__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    own_process_group(&mut cmd);
    let out = run_with_timeout(cmd, std::time::Duration::from_secs(4))?;
    let start = out.find("__OCTO_PATH__")?;
    let rest = &out[start + "__OCTO_PATH__".len()..];
    let end = rest.find("__OCTO_PATH__")?;
    let path = rest[..end].trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Run `cmd` to completion, returning its stdout — or None if it didn't finish
/// within `timeout` (it is killed) or couldn't be started. Used for the one
/// startup probe that must never be able to hang the app.
#[cfg(unix)]
fn run_with_timeout(mut cmd: Command, timeout: std::time::Duration) -> Option<String> {
    use std::io::Read;
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read on a helper thread: a pipe that fills would otherwise block the child.
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let began = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if began.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            _ => {
                kill_tree(child.id());
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

// ───────────────────────────── script shell ─────────────────────────────

/// The shell one-shot scripts run through (`run_capture`): PowerShell on
/// Windows, POSIX `sh` elsewhere. The frontend's `shellScripts.ts` writes each
/// script for both, so a caller never has to know which one it got.
pub fn script_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        let shell = if which("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
        let mut cmd = Command::new(shell);
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }
}

/// How to install a missing external tool on this OS, for error messages.
pub fn install_hint(tool: &str) -> String {
    match (OS, tool) {
        ("windows", "cloudflared") => "winget install --id Cloudflare.cloudflared".into(),
        ("macos", "cloudflared") => "brew install cloudflared".into(),
        (_, "cloudflared") => "see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation".into(),
        ("windows", t) => format!("winget install {t}"),
        ("macos", t) => format!("brew install {t}"),
        (_, t) => format!("install `{t}` with your package manager"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_a_real_binary() {
        #[cfg(windows)]
        assert!(which("cmd.exe"));
        #[cfg(unix)]
        assert!(which("sh"));
        assert!(!which("definitely-not-a-binary-octoshell"));
    }

    #[cfg(unix)]
    #[test]
    fn kill_tree_ends_the_whole_group() {
        // A shell that spawns a grandchild: killing only the shell would orphan
        // the sleeper, which is exactly the Windows-Job-Object gap this closes.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        background(&mut cmd);
        let child = cmd.spawn().expect("spawn");
        let shell_pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let kids = child_pids(shell_pid);
        assert!(!kids.is_empty(), "the shell should have started its sleeper");

        kill_tree(shell_pid);
        std::thread::sleep(std::time::Duration::from_millis(100));
        for k in kids {
            // Signal 0 = "does it exist"; ESRCH means it is gone.
            assert_ne!(unsafe { libc::kill(k as i32, 0) }, 0, "grandchild {k} survived kill_tree");
        }
    }

    #[cfg(unix)]
    #[test]
    fn adopting_the_login_path_never_loses_entries() {
        let before: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap()).collect();
        adopt_login_shell_path();
        let after: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap()).collect();
        eprintln!("PATH before: {} entries, after: {} entries", before.len(), after.len());
        for p in before {
            assert!(after.contains(&p), "{} was dropped from PATH", p.display());
        }
        // What the login shell reports must be in there too (this is the point).
        // Version managers such as fnm mint a fresh per-shell directory on every
        // start, so those entries legitimately differ between two probes.
        let probe = login_shell_path().expect("the login shell should answer");
        for p in std::env::split_paths(&probe) {
            if p.to_string_lossy().contains("multishells") {
                continue;
            }
            assert!(after.contains(&p), "{} from the login shell was not adopted", p.display());
        }
    }
}
