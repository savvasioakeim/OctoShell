//! Tab completion for the input bar.
//!
//! The input editor isn't a live terminal, so on Tab the frontend sends the
//! current line + caret and gets back candidates in ONE shape, whichever engine
//! produced them:
//!
//!   `{ "ri": <replacementIndex>, "rl": <replacementLength>,
//!      "m": [ { "t": completionText, "l": listItemText, "k": resultType } ] }`
//!
//! Two engines:
//!   * **PowerShell** (Windows) — `TabExpansion2`, served by one warm `pwsh`
//!     process ([`PowerShellEngine`]): cmdlets, parameters, paths, variables.
//!   * **Native** (macOS/Linux) — [`NativeCompleter`], in-process: commands on
//!     PATH plus shell builtins in command position, file paths everywhere else.
//!     Nothing to spawn, so every Tab is instant, and it works for zsh and bash
//!     alike. Result kinds reuse PowerShell's names (`Command`, `ProviderItem`,
//!     `ProviderContainer`) so the frontend's labels need no second vocabulary.

use std::sync::{Arc, Mutex};

/// The empty completion result, used as a safe fallback everywhere.
#[cfg(windows)]
pub const EMPTY_COMPLETION: &str = r#"{"ri":0,"rl":0,"m":[]}"#;

/// Managed Tauri state: whichever engine this platform uses.
#[derive(Default, Clone)]
pub struct CompletionEngine {
    #[cfg(windows)]
    inner: Arc<Mutex<Option<pwsh::EngineProc>>>,
    #[cfg(not(windows))]
    inner: Arc<Mutex<native::NativeCompleter>>,
}

impl CompletionEngine {
    /// Pre-spawn / pre-warm so the first real Tab is instant.
    pub fn warm(&self) {
        #[cfg(windows)]
        pwsh::warm(&self.inner);
        #[cfg(not(windows))]
        self.inner.lock().unwrap().refresh_commands();
    }

    /// Complete `line` at char index `cursor`, relative to `cwd`.
    pub fn complete(&self, cwd: &str, line: &str, cursor: usize) -> Result<String, String> {
        #[cfg(windows)]
        {
            pwsh::complete(&self.inner, cwd, line, cursor)
        }
        #[cfg(not(windows))]
        {
            let mut c = self.inner.lock().unwrap();
            let r = c.complete(cwd, line, cursor);
            serde_json::to_string(&r).map_err(|e| e.to_string())
        }
    }
}

// ───────────────────────────── native (macOS / Linux) ─────────────────────────────

#[cfg(any(not(windows), test))]
mod native {
    /// One candidate, serialized with PowerShell's field names.
    #[derive(serde::Serialize, Debug, PartialEq, Clone)]
    pub struct Candidate {
        /// What to insert in place of the token.
        pub t: String,
        /// What to show in the list.
        pub l: String,
        /// `Command` / `ProviderItem` (file) / `ProviderContainer` (dir).
        pub k: &'static str,
    }

    #[derive(serde::Serialize, Debug, PartialEq)]
    pub struct Completion {
        pub ri: usize,
        pub rl: usize,
        pub m: Vec<Candidate>,
    }

    /// Words the shell itself understands that no PATH scan would find.
    const BUILTINS: &[&str] = &[
        "cd", "export", "source", "alias", "unalias", "echo", "exit", "pwd", "set", "unset", "which",
        "type", "history", "jobs", "fg", "bg", "kill", "eval", "exec", "printf", "read", "test", "true",
        "false", "if", "then", "else", "fi", "for", "while", "do", "done", "case", "esac", "function",
        "return", "local", "let", "shift", "trap", "wait", "umask", "ulimit", "time", "sudo",
    ];

    /// How long the PATH command cache stays fresh. A new install shows up within
    /// this window without a rescan on every Tab.
    const COMMAND_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

    /// In-process completer for POSIX shells.
    #[derive(Default)]
    pub struct NativeCompleter {
        commands: Vec<String>,
        scanned_at: Option<std::time::Instant>,
    }

    impl NativeCompleter {
        /// Rescan PATH for executables (deduped, sorted). Cheap (~ms) but not free,
        /// so it's cached for [`COMMAND_CACHE_TTL`].
        pub fn refresh_commands(&mut self) {
            let mut names: Vec<String> = Vec::new();
            if let Some(paths) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&paths) {
                    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                    for e in entries.flatten() {
                        if is_executable(&e.path()) {
                            names.push(e.file_name().to_string_lossy().into_owned());
                        }
                    }
                }
            }
            names.extend(BUILTINS.iter().map(|s| s.to_string()));
            names.sort();
            names.dedup();
            self.commands = names;
            self.scanned_at = Some(std::time::Instant::now());
        }

        fn commands(&mut self) -> &[String] {
            let stale = self.scanned_at.map(|t| t.elapsed() > COMMAND_CACHE_TTL).unwrap_or(true);
            if stale {
                self.refresh_commands();
            }
            &self.commands
        }

        pub fn complete(&mut self, cwd: &str, line: &str, cursor: usize) -> Completion {
            let chars: Vec<char> = line.chars().collect();
            let cursor = cursor.min(chars.len());
            let (start, token) = current_token(&chars, cursor);
            let ri = start;
            let rl = cursor - start;

            let in_command_position = !chars[..start].iter().any(|c| !c.is_whitespace())
                || preceded_by_separator(&chars, start);
            let looks_like_path = token.contains('/') || token.starts_with('~') || token.starts_with('.');

            let mut m: Vec<Candidate> = Vec::new();
            if in_command_position && !looks_like_path {
                let lower = token.to_lowercase();
                m.extend(
                    self.commands()
                        .iter()
                        .filter(|c| c.to_lowercase().starts_with(&lower))
                        .take(200)
                        .map(|c| Candidate { t: c.clone(), l: c.clone(), k: "Command" }),
                );
            }
            m.extend(complete_path(cwd, &token));
            Completion { ri, rl, m }
        }
    }

    /// The token under the caret: from the last unescaped whitespace before the
    /// caret up to the caret, with `\ ` and simple quotes unescaped. Returns
    /// (start char index, unescaped text).
    fn current_token(chars: &[char], cursor: usize) -> (usize, String) {
        let mut start = cursor;
        while start > 0 {
            let c = chars[start - 1];
            if c.is_whitespace() && !(start >= 2 && chars[start - 2] == '\\') {
                break;
            }
            start -= 1;
        }
        let raw: String = chars[start..cursor].iter().collect();
        (start, unescape(raw.trim_matches(['"', '\''])))
    }

    /// Drop the backslashes a user typed to escape characters in the token
    /// (`my\ dir/foo\(1\)` → `my dir/foo(1)`), so the filesystem lookup sees
    /// the real name. The inverse of [`escape`].
    pub(super) fn unescape(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    /// Backslash-escape everything a POSIX shell would otherwise interpret in
    /// an unquoted word, so the inserted text names the file exactly. Applied to
    /// the WHOLE inserted path — directory part included — since a folder called
    /// `Application Support` is as common as a file with a space.
    pub(super) fn escape(s: &str) -> String {
        const SPECIAL: &str = " \t'\"\\`$&|;<>()[]{}*?!#~";
        let mut out = String::with_capacity(s.len() + 4);
        for (i, c) in s.chars().enumerate() {
            // A leading `~` is tilde expansion the user asked for; keep it.
            let keep = c == '~' && i == 0;
            if !keep && SPECIAL.contains(c) {
                out.push('\\');
            }
            out.push(c);
        }
        out
    }

    /// True when the text before `start` ends with a command separator (`|`, `&&`,
    /// `;`, `(`), so the token is a command name rather than an argument.
    fn preceded_by_separator(chars: &[char], start: usize) -> bool {
        let before: String = chars[..start].iter().collect();
        let t = before.trim_end();
        t.ends_with('|') || t.ends_with("&&") || t.ends_with(';') || t.ends_with('(') || t.ends_with("$(")
    }

    /// File/dir candidates for `token` relative to `cwd`. Directories get a
    /// trailing `/` so the next Tab descends; names with spaces are backslash-escaped
    /// in the inserted text (the list shows them plain).
    fn complete_path(cwd: &str, token: &str) -> Vec<Candidate> {
        let (dir_part, prefix) = match token.rfind('/') {
            Some(i) => (&token[..=i], &token[i + 1..]),
            None => ("", token),
        };
        let expanded_dir = expand_home(if dir_part.is_empty() { "." } else { dir_part });
        let base = if std::path::Path::new(&expanded_dir).is_absolute() {
            std::path::PathBuf::from(&expanded_dir)
        } else {
            std::path::Path::new(if cwd.is_empty() { "." } else { cwd }).join(&expanded_dir)
        };
        let Ok(entries) = std::fs::read_dir(&base) else { return Vec::new() };
        let show_hidden = prefix.starts_with('.');
        let lower = prefix.to_lowercase();
        let mut out: Vec<Candidate> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if !show_hidden && name.starts_with('.') {
                    return None;
                }
                if !name.to_lowercase().starts_with(&lower) {
                    return None;
                }
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                    || std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
                let display = if is_dir { format!("{name}/") } else { name.clone() };
                let inserted = escape(&format!("{dir_part}{display}"));
                Some(Candidate { t: inserted, l: display, k: if is_dir { "ProviderContainer" } else { "ProviderItem" } })
            })
            .collect();
        out.sort_by_key(|c| c.l.to_lowercase());
        out.truncate(300);
        out
    }

    fn expand_home(p: &str) -> String {
        if let Some(rest) = p.strip_prefix('~') {
            if rest.is_empty() || rest.starts_with('/') {
                if let Some(h) = crate::platform::home_dir() {
                    return format!("{}{rest}", h.to_string_lossy());
                }
            }
        }
        p.to_string()
    }

    #[cfg(unix)]
    fn is_executable(p: &std::path::Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }

    #[cfg(not(unix))]
    fn is_executable(p: &std::path::Path) -> bool {
        p.is_file()
    }

}
// ───────────────────────────── PowerShell (Windows) ─────────────────────────────

/// A persistent PowerShell process that answers Tab-completion requests.
///
/// Spawning a fresh `pwsh` per Tab cost ~1.5s (cold start dominates). Instead we
/// keep ONE pwsh alive running a read-eval loop: each request is a single line
/// `<cwd_b64> <line_b64> <cursor>\n` on stdin, and the reply is one line
/// `OCTO\t<json>\n` on stdout. Warm round-trips are well under 100ms.
///
/// base64 dodges all quoting/whitespace issues in the request payload (base64
/// never contains a space, so a space delimiter is safe). Requests are
/// serialized by the mutex, which is fine since each is fast. If the process
/// dies (crash, OOM), the next request transparently respawns and retries once.
#[cfg(windows)]
mod pwsh {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    use base64::{engine::general_purpose::STANDARD, Engine};

    const COMPLETE_LOOP: &str = r#"
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$enc=[System.Text.Encoding]::UTF8
while(($req=[Console]::In.ReadLine()) -ne $null){
  try{
    $p=$req.Split(' ')
    $cwd=if($p[0]){$enc.GetString([Convert]::FromBase64String($p[0]))}else{''}
    $line=if($p.Length -gt 1 -and $p[1]){$enc.GetString([Convert]::FromBase64String($p[1]))}else{''}
    $pos=[int]$p[2]
    if($cwd){Set-Location -LiteralPath $cwd}
    $r=TabExpansion2 -inputScript $line -cursorColumn $pos
    if($r){
      $o=[pscustomobject]@{ri=$r.ReplacementIndex;rl=$r.ReplacementLength;m=@($r.CompletionMatches|%{[pscustomobject]@{t=$_.CompletionText;l=$_.ListItemText;k=$_.ResultType.ToString()}})}
      $json=$o|ConvertTo-Json -Compress -Depth 4
    }else{$json='{"ri":0,"rl":0,"m":[]}'}
  }catch{$json='{"ri":0,"rl":0,"m":[]}'}
  [Console]::Out.WriteLine("OCTO`t$json")
  [Console]::Out.Flush()
}
"#;

    /// Encode a script as PowerShell `-EncodedCommand` (UTF-16LE → base64).
    fn encode_ps(script: &str) -> String {
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        STANDARD.encode(utf16)
    }

    /// A live completion subprocess and its piped stdio.
    pub struct EngineProc {
        child: std::process::Child,
        stdin: std::process::ChildStdin,
        stdout: BufReader<std::process::ChildStdout>,
    }

    fn spawn() -> Result<EngineProc, String> {
        use std::process::{Command, Stdio};
        let shell = if crate::platform::which("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
        let mut cmd = Command::new(shell);
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_ps(COMPLETE_LOOP)])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::platform::hide_console(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        // The warm completion runspace lives for the whole session — tie it to
        // the job so it dies with OctoShell instead of lingering.
        crate::jobctl::add(child.id());
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(EngineProc { child, stdin, stdout })
    }

    /// Pre-spawn the process AND prime PowerShell's command cache so the first
    /// real Tab is instant. The first cmdlet completion in a fresh pwsh costs
    /// ~700ms (it builds the command-name cache); a throwaway request here pays
    /// that once, in the background, before the user ever presses Tab.
    pub fn warm(inner: &Arc<Mutex<Option<EngineProc>>>) {
        let mut g = inner.lock().unwrap();
        if g.is_none() {
            if let Ok(mut proc) = spawn() {
                let _ = round_trip(&mut proc, "", "Get-", 4);
                *g = Some(proc);
            }
        }
    }

    /// One request/response round-trip over the persistent pipe.
    fn round_trip(proc: &mut EngineProc, cwd: &str, line: &str, cursor: usize) -> Result<String, String> {
        let req = format!("{} {} {}\n", STANDARD.encode(cwd), STANDARD.encode(line), cursor);
        proc.stdin.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        proc.stdin.flush().map_err(|e| e.to_string())?;

        // Read until our sentinel line (ignore any stray output).
        let mut buf = String::new();
        loop {
            buf.clear();
            let n = proc.stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("completion engine closed".into());
            }
            if let Some(rest) = buf.trim_end().strip_prefix("OCTO\t") {
                return Ok(rest.to_string());
            }
        }
    }

    pub fn complete(
        inner: &Arc<Mutex<Option<EngineProc>>>,
        cwd: &str,
        line: &str,
        cursor: usize,
    ) -> Result<String, String> {
        let mut g = inner.lock().unwrap();
        if g.is_none() {
            *g = Some(spawn()?);
        }

        // Try once; if the pipe is broken (process died) respawn and retry.
        let first = round_trip(g.as_mut().unwrap(), cwd, line, cursor);
        let s = match first {
            Ok(s) => s,
            Err(_) => {
                if let Some(mut old) = g.take() {
                    let _ = old.child.kill();
                }
                *g = Some(spawn()?);
                round_trip(g.as_mut().unwrap(), cwd, line, cursor)?
            }
        };
        Ok(if s.is_empty() { EMPTY_COMPLETION.to_string() } else { s })
    }
}

#[cfg(test)]
mod tests {
    use super::native::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join("octoshell-completion-tests").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("my dir")).unwrap();
        std::fs::write(d.join("README.md"), "").unwrap();
        std::fs::write(d.join(".hidden"), "").unwrap();
        d
    }

    #[test]
    fn completes_commands_in_command_position() {
        let mut c = NativeCompleter::default();
        let r = c.complete("", "ec", 2);
        assert_eq!((r.ri, r.rl), (0, 2));
        assert!(r.m.iter().any(|m| m.t == "echo" && m.k == "Command"));
    }

    #[test]
    fn completes_paths_as_arguments() {
        let d = tmp_dir("args");
        let mut c = NativeCompleter::default();
        let r = c.complete(d.to_str().unwrap(), "cat RE", 6);
        assert_eq!((r.ri, r.rl), (4, 2));
        assert_eq!(r.m, vec![Candidate { t: "README.md".into(), l: "README.md".into(), k: "ProviderItem" }]);
    }

    #[test]
    fn directories_get_a_trailing_slash_and_spaces_are_escaped() {
        let d = tmp_dir("dirs");
        let mut c = NativeCompleter::default();
        let r = c.complete(d.to_str().unwrap(), "cd ", 3);
        let names: Vec<&str> = r.m.iter().map(|m| m.l.as_str()).collect();
        assert!(names.contains(&"src/"), "{names:?}");
        assert!(names.contains(&"my dir/"), "{names:?}");
        assert!(!names.contains(&".hidden"), "hidden files stay hidden without a dot prefix");
        let spaced = r.m.iter().find(|m| m.l == "my dir/").unwrap();
        assert_eq!(spaced.t, "my\\ dir/");
        assert_eq!(spaced.k, "ProviderContainer");
    }

    #[test]
    fn escapes_the_whole_path_including_the_directory_part() {
        let d = tmp_dir("escape");
        std::fs::create_dir_all(d.join("my dir").join("sub (1)")).unwrap();
        std::fs::write(d.join("my dir").join("note$.txt"), "").unwrap();
        let mut c = NativeCompleter::default();
        // The user typed the directory escaped, as a shell would need it.
        let r = c.complete(d.to_str().unwrap(), "cat my\\ dir/", 12);
        let inserted: Vec<&str> = r.m.iter().map(|m| m.t.as_str()).collect();
        assert!(inserted.contains(&"my\\ dir/sub\\ \\(1\\)/"), "{inserted:?}");
        assert!(inserted.contains(&"my\\ dir/note\\$.txt"), "{inserted:?}");
        assert_eq!((r.ri, r.rl), (4, 8), "replaces the raw, still-escaped token");
        // A leading ~ stays a tilde; nothing else in the name is special.
        assert_eq!(escape("~/plain"), "~/plain");
        assert_eq!(unescape("a\\ b\\(1\\)"), "a b(1)");
    }

    #[test]
    fn descends_into_a_directory_prefix() {
        let d = tmp_dir("descend");
        std::fs::write(d.join("src").join("main.rs"), "").unwrap();
        let mut c = NativeCompleter::default();
        let r = c.complete(d.to_str().unwrap(), "vim src/ma", 10);
        assert_eq!(r.m[0].t, "src/main.rs");
        assert_eq!((r.ri, r.rl), (4, 6));
    }

    #[test]
    fn a_command_after_a_pipe_is_a_command() {
        let mut c = NativeCompleter::default();
        let r = c.complete("", "ls | gr", 7);
        assert_eq!(r.ri, 5);
        assert!(r.m.iter().any(|m| m.t == "grep"));
    }

    #[test]
    fn dot_prefix_shows_hidden_entries_and_never_commands() {
        let d = tmp_dir("hidden");
        let mut c = NativeCompleter::default();
        let r = c.complete(d.to_str().unwrap(), ".h", 2);
        assert!(r.m.iter().all(|m| m.k != "Command"));
        assert!(r.m.iter().any(|m| m.l == ".hidden"));
    }
}
