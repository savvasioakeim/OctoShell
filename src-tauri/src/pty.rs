//! Multi-session PTY management with **semantic block** detection.
//!
//! Each tab owns one interactive shell (PowerShell on Windows; zsh, bash or
//! pwsh on macOS/Linux — see `shells.rs`). We inject a small *shell integration*
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
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::platform;
use crate::shells;

pub use crate::completion::CompletionEngine;

/// A single live terminal session.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Which spawn this is for its id. A session is reopened under the SAME id
    /// (the frontend restarts an exited shell; dev hot-reload replaces one), and
    /// the old spawn's reader thread only winds down afterwards — it must not
    /// remove the new session from the registry or announce ITS exit.
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Thread-safe registry of every open session.
#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Clone, Serialize)]
struct IdPayload {
    id: String,
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
            platform::home_dir()
                .map(|h| h.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".into())
        } else {
            cwd
        };

        // Spawn the requested shell in the start dir. A shell the platform
        // doesn't have (a setting carried over from another OS) resolves to the
        // platform default. Shells with integration produce semantic command
        // blocks; CMD and WSL are spawned raw and work as plain terminals
        // (flagged in the Settings UI).
        let shell_id = shells::resolve(&shell);
        let mut child = None;
        let mut last_err = String::from("no shell to try");
        for builder in shells::commands(shell_id, &start_dir)? {
            match pair.slave.spawn_command(builder) {
                Ok(c) => {
                    child = Some(c);
                    break;
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        let child = child.ok_or_else(|| format!("failed to spawn shell `{shell_id}`: {last_err}"))?;

        // Tie the shell (and every command it runs) to OctoShell's lifetime so a
        // crash or hot-reload can't leave an orphaned shell behind.
        if let Some(pid) = child.process_id() {
            crate::jobctl::add(pid);
        }

        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        self.sessions.lock().unwrap().insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
                generation,
            },
        );

        let sessions = self.sessions.clone();
        thread::spawn(move || run_reader(app, sessions, id, generation, reader, on_output));
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

    /// Kill the command running IN a session, leaving the shell itself alive.
    ///
    /// Ctrl+C is not enough: a dev server started from the prompt (`npm run dev`)
    /// runs as a grandchild behind npm/cmd shims that swallow the signal, so the
    /// tab sits "running" forever with no way out. Instead we kill every direct
    /// child of the shell — process tree and all — which is exactly the foreground
    /// command and its helpers, never the shell session itself.
    pub fn kill_foreground(&self, id: &str) -> Result<(), String> {
        let shell_pid = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(id).ok_or("no such session")?;
            s.child.process_id().ok_or("session has no pid")?
        };
        let kids = platform::child_pids(shell_pid);
        if kids.is_empty() {
            return Err("nothing is running in this shell".into());
        }
        platform::kill_trees(&kids);
        Ok(())
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
    generation: u64,
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

    // Only OUR session: if the id was already reopened by a newer spawn, that
    // one is live and must stay registered — and its owner must not hear an
    // exit that isn't theirs.
    let superseded = {
        let mut map = sessions.lock().unwrap();
        match map.get(&id) {
            Some(s) if s.generation == generation => {
                map.remove(&id);
                false
            }
            Some(_) => true,
            None => false, // closed via close_tab: still announce the end
        }
    };
    if !superseded {
        let _ = app.emit("pty://exit", IdPayload { id });
    }
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

/// Parse the OSC 7 `file://HOST/path` report into a native path.
///
/// Windows: `file://HOST/C:/Users/...` → `C:\Users\...` (PowerShell reports
/// forward slashes; the rest of the app expects native ones). Elsewhere the path
/// part already starts at the root, and our zsh/bash integration percent-encodes
/// it, so decode `%XX` escapes back.
fn parse_cwd(url: &str) -> Option<String> {
    let path = url.strip_prefix("file://")?;
    // Drop the host component (up to the first '/').
    let idx = path.find('/')?;
    let rest = &path[idx..];
    #[cfg(windows)]
    {
        Some(rest[1..].replace("%20", " ").replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        Some(percent_decode(rest))
    }
}

/// Decode `%XX` escapes (UTF-8 bytes), leaving anything malformed as-is.
#[cfg(any(not(windows), test))]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (hex(bytes.get(i + 1)), hex(bytes.get(i + 2))) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(any(not(windows), test))]
fn hex(b: Option<&u8>) -> Option<u8> {
    match b? {
        c @ b'0'..=b'9' => Some(c - b'0'),
        c @ b'a'..=b'f' => Some(c - b'a' + 10),
        c @ b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
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
    manager.open(app, id, cwd, shell.unwrap_or_else(|| shells::default_id().into()), on_output)
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

/// Stop whatever command is running in a shell tab (the Stop button), without
/// killing the tab. Async so a slow WMI lookup can't stall the UI thread.
#[tauri::command]
pub async fn kill_foreground(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let m = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || m.kill_foreground(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn close_tab(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.close(&id)
}

/// One-shot captured subprocess (e.g. `git status`) for macros — not a PTY.
/// The script runs through the platform's script shell (PowerShell on Windows,
/// `sh` elsewhere); the frontend writes each script for both.
///
/// `async` + `spawn_blocking` is deliberate: a synchronous `#[tauri::command]`
/// runs on the main (UI) thread, so a slow/hanging child (e.g. `git worktree
/// remove` blocking on a locked file) would freeze the whole app. Off-loading to
/// a blocking worker keeps the UI responsive no matter how long the child takes.
#[tauri::command]
pub async fn run_capture(cwd: String, command: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = platform::script_command(&command);
        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        platform::hide_console(&mut cmd);

        let out = cmd.output().map_err(|e| e.to_string())?;
        let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.stderr.is_empty() {
            s.push_str(&String::from_utf8_lossy(&out.stderr));
        }
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tab completion for the input bar — see `completion.rs` for the engines and
/// the JSON shape.
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
    #[cfg(target_os = "macos")]
    let mut cmd = {
        // The `code` shim only exists once the user ran "Install 'code' command
        // in PATH" from VS Code; the app bundle is there regardless, and
        // Launch Services can open it by name.
        if platform::which("code") {
            let mut c = Command::new("code");
            c.arg(&path);
            c
        } else {
            let mut c = Command::new("open");
            c.args(["-a", "Visual Studio Code", &path]);
            c
        }
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("code");
        c.arg(&path);
        c
    };

    platform::hide_console(&mut cmd);

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

    platform::hide_console(&mut cmd);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open file manager: {e}"))
}

/// First-launch health check: is each CLI OctoShell depends on actually on
/// PATH? Drives the onboarding screen so a missing tool shows up as a
/// friendly checklist instead of a cryptic spawn failure deep in an agent
/// run. OctoShell doesn't mandate any *specific* agent CLI — claude, gemini,
/// and every ACP provider (codex, opencode, …) are equally valid front
/// doors — so `node` is reported too: it's what unlocks the `npx`-launched
/// ACP agents even when neither `claude` nor `gemini` is installed.
#[derive(serde::Serialize)]
pub struct HealthCheck {
    claude: bool,
    gemini: bool,
    node: bool,
    gh: bool,
    /// PowerShell 7. Required on Windows (the core shell + completion engine);
    /// merely one shell option elsewhere.
    pwsh: bool,
    /// Whether the platform's core shell is present: pwsh on Windows, the
    /// default integrated shell (zsh/bash) elsewhere. This is the "required
    /// shell" row of the onboarding check.
    shell_ok: bool,
    /// Label for that row, e.g. "PowerShell 7" or "zsh".
    shell_label: String,
    /// "windows" | "macos" | "linux", so the UI can pick install hints.
    platform: &'static str,
}

#[tauri::command]
pub fn health_check() -> HealthCheck {
    // Bare names — `which_cmd` matches .exe, npm shims (.cmd/.ps1) and bare
    // scripts alike, so an npm-installed CLI (e.g. Gemini) is found too.
    let pwsh = platform::which_cmd("pwsh");
    let (shell_ok, shell_label) = if cfg!(windows) {
        (pwsh, "PowerShell 7".to_string())
    } else {
        let id = shells::default_id();
        let ok = shells::list().iter().any(|s| s.id == id && s.available);
        (ok, id.to_string())
    };
    HealthCheck {
        claude: platform::which_cmd("claude"),
        gemini: platform::which_cmd("gemini"),
        node: platform::which_cmd("node"),
        gh: platform::which_cmd("gh"),
        pwsh,
        shell_ok,
        shell_label,
        platform: platform::OS,
    }
}

/// What the frontend needs to know about the OS it's running on, fetched once
/// at startup (see `src/platform/platform.ts`): which shells the terminal can
/// spawn and which is the default, plus the home directory.
#[derive(serde::Serialize)]
pub struct PlatformInfo {
    os: &'static str,
    #[serde(rename = "defaultShell")]
    default_shell: &'static str,
    shells: Vec<shells::ShellInfo>,
    home: String,
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: platform::OS,
        default_shell: shells::default_id(),
        shells: shells::list(),
        home: platform::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cwd_report_for_this_platform() {
        #[cfg(windows)]
        assert_eq!(parse_cwd("file://PC/C:/Users/me/my%20app").as_deref(), Some(r"C:\Users\me\my app"));
        #[cfg(not(windows))]
        {
            assert_eq!(parse_cwd("file://mac.local/Users/me/my%20app").as_deref(), Some("/Users/me/my app"));
            assert_eq!(parse_cwd("file://localhost/tmp/100%25done").as_deref(), Some("/tmp/100%done"));
            assert_eq!(parse_cwd("file:///no/host").as_deref(), Some("/no/host"));
        }
        assert_eq!(parse_cwd("not-a-url"), None);
    }

    #[test]
    fn percent_decoding_leaves_malformed_input_alone() {
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%41%20"), "A ");
    }

    /// The parser is shared by every shell; feed it what zsh's integration
    /// emits for one command and check the block boundaries come out right.
    #[test]
    fn semantic_parser_handles_a_zsh_command_cycle() {
        let mut p = SemanticParser::new();
        let mut events = Vec::new();
        // First prompt: D (ignored, nothing running), cwd, A, prompt text, B.
        events.extend(p.feed(b"\x1b]133;D;0\x07\x1b]7;file://h/Users/x\x07\x1b]133;A\x07% \x1b]133;B\x07"));
        // The user's echoed command line, then C, output, then the next prompt.
        events.extend(p.feed(b"ls\r\n\x1b]133;C\x07README.md\r\n\x1b]133;D;0\x07\x1b]7;file://h/Users/x\x07\x1b]133;A\x07% \x1b]133;B\x07"));
        let mut cwds = 0;
        let mut ends = Vec::new();
        let mut readies = 0;
        let mut output = Vec::new();
        for ev in events {
            match ev {
                Sem::Output(b) => output.extend(b),
                Sem::CommandEnd(c) => ends.push(c),
                Sem::Cwd(c) => {
                    cwds += 1;
                    #[cfg(not(windows))]
                    assert_eq!(c, "/Users/x");
                    #[cfg(windows)]
                    assert_eq!(c, r"Users\x");
                }
                Sem::Ready => readies += 1,
            }
        }
        assert_eq!(String::from_utf8_lossy(&output), "README.md\r\n", "only output between C and D is forwarded");
        assert_eq!(ends, vec![0]);
        assert_eq!(cwds, 2);
        assert_eq!(readies, 2);
    }
}
