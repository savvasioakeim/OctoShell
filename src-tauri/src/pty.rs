//! Multi-session PTY management with **semantic block** detection.
//!
//! Each tab owns one `pwsh.exe` session. We inject a small *shell integration*
//! script (OSC 133 / FinalTerm markers + OSC 7 cwd reporting) so the backend
//! can tell exactly where each command's output begins and ends, plus its exit
//! code — the same technique Warp and VS Code use. A per-session
//! [`SemanticParser`] consumes the raw PTY stream and emits structured events:
//!
//! All per-session stream events ride ONE Tauri `Channel` (so order is preserved
//! between output and the markers that follow it):
//!   * `Raw(bytes)`        — command output, only between C and D. Binary, so
//!     heavy output never pays a base64 encode/decode (large chunks ride the
//!     channel's fetch transport).
//!   * `{t:"end",code}`    — a command finished, with its exit code
//!   * `{t:"cwd",cwd}`     — the working directory changed
//!   * `{t:"ready"}`       — the shell is idle and ready for the next command
//!
//! `pty://exit` (session ended) stays a normal event — it fires once, after the
//! read loop ends, so it can't race anything.
//!
//! The blocking PTY read happens on a dedicated OS thread per session so heavy
//! output never stalls the async runtime or the UI.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

/// PowerShell shell-integration script, injected at startup via `-EncodedCommand`.
///
/// It overrides `prompt` to emit OSC 133 D (previous command end + exit code),
/// OSC 7 (cwd), and OSC 133 A/B (prompt boundaries). On the first prompt it also
/// installs an Enter handler that emits OSC 133 C (command start) — registered
/// lazily because PSReadLine is only loaded once the interactive prompt begins.
const SHELL_INTEGRATION: &str = r#"
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

/// A single live terminal session.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Thread-safe registry of every open session.
#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Clone, Serialize)]
struct IdPayload {
    id: String,
}

/// Encode a script as PowerShell `-EncodedCommand` (UTF-16LE → base64).
/// Avoids all command-line quoting issues.
fn encode_ps(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    STANDARD.encode(utf16)
}

fn shell_args(shell: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encode_ps(SHELL_INTEGRATION)]);
    cmd
}

impl PtyManager {
    pub fn open(
        &self,
        app: AppHandle,
        id: String,
        cwd: String,
        shell: String,
        on_output: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        // Replace any existing session with this id (e.g. after a dev hot-reload),
        // so we never leave an orphaned shell + reader thread behind.
        if let Some(mut old) = self.sessions.lock().unwrap().remove(&id) {
            let _ = old.child.kill();
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let start_dir = if cwd.is_empty() {
            std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
        } else {
            cwd
        };

        // Spawn the requested shell in the start dir. PowerShell gets the OSC-133
        // shell-integration script injected (the source of our per-command blocks);
        // CMD and WSL are spawned raw — they work as plain terminals but, lacking
        // that integration, don't produce semantic command blocks (flagged in the
        // Settings UI).
        let spawn = |builder: CommandBuilder| {
            let mut b = builder;
            b.cwd(&start_dir);
            pair.slave.spawn_command(b)
        };
        let child = match shell.as_str() {
            "cmd" => spawn(CommandBuilder::new("cmd.exe")),
            "wsl" => spawn(CommandBuilder::new("wsl.exe")),
            // "powershell" (default): prefer pwsh 7, fall back to Windows PowerShell.
            _ => spawn(shell_args("pwsh.exe")).or_else(|_| spawn(shell_args("powershell.exe"))),
        }
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

        // Tie the shell (and every command it runs) to OctoShell's lifetime so a
        // crash or hot-reload can't leave an orphaned pwsh.exe behind.
        if let Some(pid) = child.process_id() {
            crate::jobctl::add(pid);
        }

        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        self.sessions.lock().unwrap().insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );

        let sessions = self.sessions.clone();
        thread::spawn(move || run_reader(app, sessions, id, reader, on_output));
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or("unknown session id")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id).ok_or("unknown session id")?;
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.child.kill();
        }
        Ok(())
    }
}

/// One parsed item travelling from the blocking reader thread to the aggregator.
/// Order on the `mpsc` channel is the true stream order, so control events stay
/// correctly interleaved with the output that precedes them.
enum Msg {
    Output(Vec<u8>),
    Control(String),
    Eof,
}

/// Coalesce heavy output into ~60fps frames before it hits the WebView.
///
/// PTY stdout is bursty: `npm install` or two agents logging at once can return
/// hundreds of small reads in a few ms. Sending each one over the IPC channel
/// would flood the JS side with events and re-renders, strangling the UI thread.
/// Instead we batch output and flush at most once per frame (or when the buffer
/// caps), so the frontend gets steady, digestible chunks no matter how hard the
/// shell screams.
const FRAME: Duration = Duration::from_millis(16);
/// Hard cap on a single batch — flush early under a firehose so memory stays flat
/// and the first bytes of a huge burst reach the screen without waiting.
const FLUSH_BYTES: usize = 256 * 1024;

/// Output (binary) AND control events (small JSON) BOTH ride the one channel.
/// The channel preserves send order, so a `command-end` can never overtake the
/// final output chunk it follows. On the JS side an ArrayBuffer is output; a
/// JSON object is a control event.
fn flush_pending(ch: &Channel<InvokeResponseBody>, pending: &mut Vec<u8>) -> bool {
    if pending.is_empty() {
        return true;
    }
    ch.send(InvokeResponseBody::Raw(std::mem::take(pending))).is_ok()
}

/// Per-session pipeline: a blocking reader thread parses the raw stream into
/// semantic events; this (the aggregator) batches output into frames and emits
/// everything over the session's IPC channel.
fn run_reader(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    id: String,
    mut reader: Box<dyn Read + Send>,
    on_output: Channel<InvokeResponseBody>,
) {
    let (tx, rx) = mpsc::channel::<Msg>();

    // Reader thread: the blocking PTY read happens here so heavy output never
    // stalls the aggregator's frame timer. It parses each read into semantic
    // events and forwards them in stream order; the parser is stateful, so
    // markers split across read boundaries are reassembled correctly.
    {
        let id = id.clone();
        // Optional raw-stream dump for debugging (set OCTO_PTY_LOG to enable).
        let dbg_path =
            std::env::var_os("OCTO_PTY_LOG").map(|_| std::env::temp_dir().join("octoshell_pty.log"));
        thread::spawn(move || {
            let mut parser = SemanticParser::new();
            // A larger read buffer lets the OS coalesce heavy output into fewer,
            // bigger reads before we even parse.
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(p) = &dbg_path {
                            debug_dump(p, &id, &buf[..n]);
                        }
                        for ev in parser.feed(&buf[..n]) {
                            let msg = match ev {
                                Sem::Output(bytes) => Msg::Output(bytes),
                                Sem::CommandEnd(code) => {
                                    Msg::Control(format!(r#"{{"t":"end","code":{code}}}"#))
                                }
                                Sem::Cwd(cwd) => Msg::Control(
                                    serde_json::json!({ "t": "cwd", "cwd": cwd }).to_string(),
                                ),
                                Sem::Ready => Msg::Control(r#"{"t":"ready"}"#.to_string()),
                            };
                            if tx.send(msg).is_err() {
                                return; // aggregator gone
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(Msg::Eof);
        });
    }

    // Aggregator: drain parsed events, holding output in `pending` until the
    // frame deadline fires, the size cap is hit, or a control event forces an
    // ordered flush. `deadline` is armed the moment the first byte of a frame
    // arrives, so a lone line still reaches the screen within one frame.
    let mut pending: Vec<u8> = Vec::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let timeout = match deadline {
            Some(d) => d.saturating_duration_since(Instant::now()),
            None => Duration::from_secs(3600), // nothing buffered: block until data
        };
        match rx.recv_timeout(timeout) {
            Ok(Msg::Output(bytes)) => {
                if pending.is_empty() {
                    deadline = Some(Instant::now() + FRAME);
                }
                pending.extend_from_slice(&bytes);
                if pending.len() >= FLUSH_BYTES {
                    if !flush_pending(&on_output, &mut pending) {
                        break; // WebView gone
                    }
                    deadline = None;
                }
            }
            Ok(Msg::Control(json)) => {
                // Emit accumulated output first, then the marker — in order.
                if !flush_pending(&on_output, &mut pending) {
                    break;
                }
                deadline = None;
                if on_output.send(InvokeResponseBody::Json(json)).is_err() {
                    break; // WebView gone
                }
            }
            Ok(Msg::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = flush_pending(&on_output, &mut pending);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !flush_pending(&on_output, &mut pending) {
                    break;
                }
                deadline = None;
            }
        }
    }

    sessions.lock().unwrap().remove(&id);
    let _ = app.emit("pty://exit", IdPayload { id });
}

/// TEMP DEBUG: append an escaped view of a raw PTY chunk to a log file.
fn debug_dump(path: &std::path::Path, id: &str, bytes: &[u8]) {
    use std::io::Write as _;
    let mut s = String::with_capacity(bytes.len() + 16);
    for &b in bytes {
        match b {
            0x1b => s.push_str("<ESC>"),
            0x07 => s.push_str("<BEL>"),
            b'\r' => s.push_str("<CR>"),
            b'\n' => s.push_str("<LF>\n"),
            0x20..=0x7e => s.push(b as char),
            _ => s.push_str(&format!("<{b:02x}>")),
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{id}] {s}");
    }
}

// ---------------------------------------------------------------------------
// Semantic parser
// ---------------------------------------------------------------------------

enum Sem {
    Output(Vec<u8>),
    CommandEnd(i32),
    Cwd(String),
    Ready,
}

#[derive(PartialEq)]
enum PState {
    Normal,
    Esc,
    Csi,
    Osc,
    OscEsc, // saw ESC inside OSC, waiting for '\' (ST terminator)
}

/// Incremental terminal-stream parser. Detects OSC 133 (semantic prompt) and
/// OSC 7 (cwd) markers, forwarding everything else as output **only while a
/// command is running** (between markers C and D). Handles escape sequences and
/// markers split across read boundaries.
struct SemanticParser {
    running: bool,
    state: PState,
    seq: Vec<u8>, // raw bytes of the in-progress escape sequence
    out: Vec<u8>, // accumulated forwardable bytes
}

impl SemanticParser {
    fn new() -> Self {
        Self { running: false, state: PState::Normal, seq: Vec::new(), out: Vec::new() }
    }

    fn flush_out(&mut self, events: &mut Vec<Sem>) {
        if !self.out.is_empty() {
            events.push(Sem::Output(std::mem::take(&mut self.out)));
        }
    }

    fn feed(&mut self, input: &[u8]) -> Vec<Sem> {
        let mut events = Vec::new();
        for &byte in input {
            match self.state {
                PState::Normal => {
                    if byte == 0x1b {
                        self.seq.clear();
                        self.seq.push(byte);
                        self.state = PState::Esc;
                    } else if self.running {
                        self.out.push(byte);
                    }
                }
                PState::Esc => {
                    self.seq.push(byte);
                    match byte {
                        b'[' => self.state = PState::Csi,
                        b']' => self.state = PState::Osc,
                        0x1b => {
                            // Restart on a fresh ESC.
                            self.seq.clear();
                            self.seq.push(0x1b);
                        }
                        _ => self.finish_passthrough(), // short ESC sequence
                    }
                }
                PState::Csi => {
                    self.seq.push(byte);
                    // CSI ends on a final byte in 0x40..=0x7e.
                    if (0x40..=0x7e).contains(&byte) {
                        self.finish_passthrough();
                    }
                }
                PState::Osc => {
                    if byte == 0x07 {
                        self.finish_osc(&mut events); // BEL terminator
                    } else if byte == 0x1b {
                        self.seq.push(byte);
                        self.state = PState::OscEsc;
                    } else {
                        self.seq.push(byte);
                    }
                }
                PState::OscEsc => {
                    self.seq.push(byte);
                    if byte == b'\\' {
                        self.finish_osc(&mut events); // ST terminator
                    } else {
                        self.state = PState::Osc; // false alarm, keep collecting
                    }
                }
            }
        }
        self.flush_out(&mut events);
        events
    }

    /// A non-OSC escape sequence (CSI colors, cursor moves, …): forward verbatim
    /// when running, otherwise drop (it's prompt/echo noise).
    fn finish_passthrough(&mut self) {
        if self.running {
            self.out.extend_from_slice(&self.seq);
        }
        self.seq.clear();
        self.state = PState::Normal;
    }

    fn finish_osc(&mut self, events: &mut Vec<Sem>) {
        // `seq` is: ESC ']' <content...> [terminator]. The BEL terminator is
        // never pushed to `seq`, so only strip the 2-byte ST (ESC '\') when present.
        let term_len = if self.seq.ends_with(b"\x1b\\") { 2 } else { 0 };
        let end = self.seq.len().saturating_sub(term_len);
        let content = String::from_utf8_lossy(&self.seq[2..end]).into_owned();

        if let Some(rest) = content.strip_prefix("133;") {
            match rest.chars().next() {
                Some('C') => {
                    self.flush_out(events);
                    self.running = true;
                }
                Some('D') => {
                    self.flush_out(events);
                    if self.running {
                        let code = rest
                            .strip_prefix("D;")
                            .and_then(|c| c.parse::<i32>().ok())
                            .unwrap_or(0);
                        events.push(Sem::CommandEnd(code));
                        self.running = false;
                    }
                }
                Some('B') => events.push(Sem::Ready),
                _ => {} // 'A' or unknown
            }
        } else if let Some(url) = content.strip_prefix("7;") {
            if let Some(cwd) = parse_cwd(url) {
                events.push(Sem::Cwd(cwd));
            }
        } else if self.running {
            // Unknown OSC (e.g. hyperlinks): preserve fidelity.
            self.out.extend_from_slice(&self.seq);
        }

        self.seq.clear();
        self.state = PState::Normal;
    }
}

/// Parse `file://HOST/C:/Users/...` into a Windows path `C:\Users\...`.
fn parse_cwd(url: &str) -> Option<String> {
    let path = url.strip_prefix("file://")?;
    // Drop the host component (up to the first '/').
    let rest = path.splitn(2, '/').nth(1)?;
    Some(rest.replace("%20", " ").replace('/', "\\"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_new_tab(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cwd: String,
    shell: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    manager.open(app, id, cwd, shell.unwrap_or_else(|| "powershell".into()), on_output)
}

#[tauri::command]
pub fn write_to_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    input: String,
) -> Result<(), String> {
    manager.write(&id, &input)
}

#[tauri::command]
pub fn resize_terminal(
    manager: State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&id, rows, cols)
}

#[tauri::command]
pub fn close_tab(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.close(&id)
}

/// One-shot captured subprocess (e.g. `git status`) for macros — not a PTY.
#[tauri::command]
pub fn run_capture(cwd: String, command: String) -> Result<String, String> {
    use std::process::Command;

    let shell = if which("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
    let mut cmd = Command::new(shell);
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.stderr.is_empty() {
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(s)
}

/// The empty completion result, used as a safe fallback everywhere.
const EMPTY_COMPLETION: &str = r#"{"ri":0,"rl":0,"m":[]}"#;

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

/// A live completion subprocess and its piped stdio.
struct EngineProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

/// Owns the single warm pwsh completion process. Managed as Tauri state.
#[derive(Default, Clone)]
pub struct CompletionEngine {
    inner: Arc<Mutex<Option<EngineProc>>>,
}

impl CompletionEngine {
    fn spawn() -> Result<EngineProc, String> {
        use std::process::{Command, Stdio};
        let shell = if which("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
        let mut cmd = Command::new(shell);
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_ps(COMPLETE_LOOP)])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

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
    pub fn warm(&self) {
        let mut g = self.inner.lock().unwrap();
        if g.is_none() {
            if let Ok(mut proc) = Self::spawn() {
                let _ = Self::round_trip(&mut proc, "", "Get-", 4);
                *g = Some(proc);
            }
        }
    }

    /// One request/response round-trip over the persistent pipe.
    fn round_trip(proc: &mut EngineProc, cwd: &str, line: &str, cursor: usize) -> Result<String, String> {
        let req = format!(
            "{} {} {}\n",
            STANDARD.encode(cwd),
            STANDARD.encode(line),
            cursor
        );
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

    fn complete(&self, cwd: &str, line: &str, cursor: usize) -> Result<String, String> {
        let mut g = self.inner.lock().unwrap();
        if g.is_none() {
            *g = Some(Self::spawn()?);
        }

        // Try once; if the pipe is broken (process died) respawn and retry.
        let first = Self::round_trip(g.as_mut().unwrap(), cwd, line, cursor);
        let s = match first {
            Ok(s) => s,
            Err(_) => {
                if let Some(mut old) = g.take() {
                    let _ = old.child.kill();
                }
                *g = Some(Self::spawn()?);
                Self::round_trip(g.as_mut().unwrap(), cwd, line, cursor)?
            }
        };
        Ok(if s.is_empty() { EMPTY_COMPLETION.to_string() } else { s })
    }
}

/// Tab completion via PowerShell's own engine (`TabExpansion2`), served by a
/// persistent warm runspace ([`CompletionEngine`]).
///
/// We can't use pwsh's interactive completion because the input editor isn't a
/// live terminal — so on Tab the frontend calls this with the current line and
/// caret column, and the warm pwsh asks the real completion engine (cmdlets,
/// paths, parameters, variables). The result is JSON:
///   `{ "ri": <replacementIndex>, "rl": <replacementLength>,
///      "m": [ { "t": completionText, "l": listItemText, "k": resultType } ] }`
#[tauri::command]
pub fn shell_complete(
    engine: State<'_, CompletionEngine>,
    cwd: String,
    line: String,
    cursor: usize,
) -> Result<String, String> {
    engine.complete(&cwd, &line, cursor)
}

/// Open a folder in VS Code (`code <path>`). Spawned detached — we don't wait.
#[tauri::command]
pub fn open_editor(path: String) -> Result<(), String> {
    use std::process::Command;
    if path.trim().is_empty() {
        return Err("no project folder yet".into());
    }

    #[cfg(windows)]
    let mut cmd = {
        // `code` is a .cmd shim on Windows, so it must go through the shell.
        let mut c = Command::new("cmd");
        c.args(["/c", "code", &path]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("code");
        c.arg(&path);
        c
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open VS Code (is `code` on PATH?): {e}"))
}

/// Reveal a folder in the OS file manager (Explorer / Finder / xdg-open).
/// Spawned detached — we don't wait. Explorer can exit non-zero even on success,
/// which is why we only care that the spawn itself succeeded.
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    use std::process::Command;
    if path.trim().is_empty() {
        return Err("no project folder yet".into());
    }

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open file manager: {e}"))
}

fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}
