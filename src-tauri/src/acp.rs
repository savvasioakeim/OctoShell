//! Agent Client Protocol (ACP) provider — the provider-agnostic path.
//!
//! OctoShell acts as an ACP **client** driving any ACP-speaking agent (Claude via
//! `@agentclientprotocol/claude-agent-acp`, Gemini natively, …) over a spawned
//! subprocess, speaking JSON-RPC. Unlike the bespoke `claude`/`gemini` stream-json
//! integrations in `agent.rs`, one implementation here covers every ACP agent:
//! streaming, sessions, plans and permission requests all ride the protocol.
//!
//! Events reuse the SAME channel as `agent.rs` so the existing frontend listeners
//! consume ACP with zero new wiring — the ShellController dispatches by provider:
//!   * `agent://event` — `{ id, data }` where `data` is one serialized ACP
//!     `SessionUpdate` (JSON, tagged by `sessionUpdate`); `providers.ts::parseAcp`
//!     maps it to feed blocks.
//!   * `agent://done`  — `{ id, code, error }` when the session task ends.
//!
//! Lifecycle: the first `acp_send` for a session spawns a long-lived task that
//! initializes the agent, opens a session, then loops reading prompts off an
//! mpsc channel — so later `acp_send`s for the same id continue the SAME
//! conversation (not a fresh one-shot). `acp_cancel` drops the sender, ending the
//! loop and closing the connection.
//!
//! STATUS: streaming + multi-prompt session, permission bridging, and client
//! terminal execution are all wired:
//!   * permission requests route through `approval.rs` (same UI flow as native
//!     claude) — the user approves/denies each tool the agent wants to run.
//!   * the client advertises the `terminal` capability and executes the agent's
//!     `terminal/*` commands: on the host by default, or inside the worktree's
//!     Docker container via `SandboxManager` when the global sandbox setting
//!     (`SandboxConfig`) is on — transparent sandboxing of the agent's commands.
//!   * the agent's `plan` updates feed the trace progress bar (see
//!     `providers.ts::parseAcp`).

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ContentBlock, CreateTerminalRequest, CreateTerminalResponse, InitializeRequest,
    KillTerminalRequest, KillTerminalResponse, NewSessionRequest, PermissionOptionKind,
    PromptRequest, ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TerminalExitStatus, TerminalId, TerminalOutputRequest,
    TerminalOutputResponse, TextContent, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot, watch, Notify};

use crate::approval::ApprovalBridge;
use crate::docker::{SandboxConfig, SandboxManager, SandboxOptions};
use crate::platform;

/// Base image for sandboxed ACP terminal commands. `node:20` carries a POSIX
/// shell plus node/npm — the common case; swap per-project later if needed.
const SANDBOX_IMAGE: &str = "node:20";

/// Docker named volume that holds the sandboxed adapter's `$HOME` — the one-time
/// Claude login (`.claude`/`.claude.json`) plus the npm/npx cache. Shared across
/// EVERY sandboxed session/worktree, so the user logs in once, not per worktree.
const SANDBOX_HOME_VOLUME: &str = "octoshell-claude-home";

/// The shared `docker run` prefix for running an agent wholesale inside a
/// container: non-root, resource-capped, labelled for orphan cleanup, with the
/// shared login/$HOME volume and the worktree bind-mounted at `/app`. Used by
/// the ACP whole-adapter sandbox here AND by agent.rs for the native claude
/// provider — keep the hardening in ONE place.
pub fn docker_run_prefix(worktree: &str) -> Vec<String> {
    // Docker Desktop accepts forward-slash Windows paths; normalise so the drive
    // colon is unambiguous in the `src:dst` mount spec.
    let wt = worktree.replace('\\', "/");
    let mut a: Vec<String> = [
        "run", "-i", "--rm",
        // Non-root: claude-code refuses --dangerously-skip-permissions as root,
        // and it's safer hardening regardless.
        "--user", "node", "-e", "HOME=/home/node",
        // Host-isolation guardrails (mirror docker.rs).
        "--memory=2g", "--pids-limit=512", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges",
        // Label so a crash/hot-reload orphan can be swept by cleanup_orphans.
        "--label", "app.octoshell.sandbox=1",
        // Shared $HOME volume: one-time login + npm cache, reused across worktrees.
        "-v", &format!("{SANDBOX_HOME_VOLUME}:/home/node"),
        // The worktree — the only host path the agent can touch.
        "-v", &format!("{wt}:/app"),
        "-w", "/app",
    ]
    .into_iter()
    .map(String::from)
    .collect();

    // Forward an API key only if we actually have one (empty would look invalid
    // to claude-code); `-e NAME` without `=value` passes our env value through
    // without exposing it in the argv/process list.
    if std::env::var("ANTHROPIC_API_KEY").map(|v| !v.is_empty()).unwrap_or(false) {
        a.push("-e".into());
        a.push("ANTHROPIC_API_KEY".into());
    }
    a
}

/// True if `s` is a leading `NAME=value` env assignment (valid identifier before
/// the `=`), matching how ACP parses env-var prefixes.
fn is_env_assign(s: &str) -> bool {
    match s.split_once('=') {
        Some((name, _)) if !name.is_empty() => {
            let mut chars = name.chars();
            let first = chars.next().unwrap();
            (first.is_ascii_alphabetic() || first == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// Build the `docker run` argv that launches an ACP adapter inside a container,
/// wrapping the WHOLE agent so every command it runs is contained. Returns an
/// argv (not a string) so worktree paths with spaces can't break the split.
///
/// `inner` is the adapter's Linux command, optionally with leading `NAME=value`
/// env prefixes (e.g. `ANTHROPIC_MODEL=sonnet npx -y …`); those become container
/// `-e` vars. Auth: the shared home volume carries the one-time Claude login, and
/// if OctoShell itself has `ANTHROPIC_API_KEY` set we forward it (API-key mode —
/// Claude Code prefers it when present). The worktree is bind-mounted at `/app`.
fn docker_launch_args(image: &str, inner: &str, worktree: &str) -> Vec<String> {
    // `AcpAgent::from_args` wants the full argv including the program itself.
    let mut a = vec!["docker".to_string()];
    a.extend(docker_run_prefix(worktree));

    // Split leading env assignments out of `inner` into container `-e` vars; the
    // remainder is the command run via `sh -c`.
    let tokens: Vec<&str> = inner.split_whitespace().collect();
    let split = tokens.iter().position(|t| !is_env_assign(t)).unwrap_or(tokens.len());
    for e in &tokens[..split] {
        a.push("-e".into());
        a.push((*e).to_string());
    }
    a.push(image.to_string());
    a.push("sh".into());
    a.push("-c".into());
    a.push(tokens[split..].join(" "));
    a
}

// ───────────────────────────── client terminals ─────────────────────────────
// ACP lets the CLIENT execute the agent's shell commands (terminal/create →
// output/wait/kill/release). By default we run them on the host and buffer their
// output. When the global sandbox setting (SandboxConfig) is ON, terminal/create
// instead routes the command through the docker SandboxManager — the #3↔#10
// synergy — for transparent sandboxing of the agent's own commands.

static TERM_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One running (or finished) client-side terminal.
#[derive(Clone)]
struct Terminal {
    output: Arc<Mutex<String>>,
    truncated: Arc<Mutex<bool>>,
    /// Exit code once the process ends (None while running).
    exit: Arc<Mutex<Option<Option<i32>>>>,
    /// Notified when the process exits (so wait_for_exit can await it).
    done: Arc<Notify>,
    pid: Option<u32>,
}

type Terminals = Arc<Mutex<HashMap<String, Terminal>>>;

/// Splice client-terminal output into a session update before it reaches the UI.
///
/// When the agent runs a command through `terminal/*`, the tool_call update it
/// sends back carries only `{"type":"terminal","terminalId":…}` — a *reference*.
/// WE own that terminal's output, so the frontend had nothing to render: every
/// terminal tool showed up as an empty block, and a failing command was an empty
/// RED block with no way to see what went wrong. Resolve the reference here, into
/// `output` (and `exitCode`) alongside the id. Recursive: the reference can sit
/// anywhere in the update's content array.
fn inject_terminal_output(v: &mut serde_json::Value, terminals: &Terminals) {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(tid) = map.get("terminalId").and_then(|t| t.as_str()).map(str::to_string) {
                let found = terminals.lock().unwrap().get(&tid).cloned();
                if let Some(t) = found {
                    let mut out = t.output.lock().unwrap().clone();
                    if *t.truncated.lock().unwrap() {
                        out.insert_str(0, "[earlier output truncated]\n");
                    }
                    map.insert("output".into(), serde_json::Value::String(out));
                    // `exit` is None while running; Some(None) means "ended, no code".
                    if let Some(code) = *t.exit.lock().unwrap() {
                        map.insert(
                            "exitCode".into(),
                            code.map(|c| serde_json::Value::from(c)).unwrap_or(serde_json::Value::Null),
                        );
                    }
                }
            }
            for (_, val) in map.iter_mut() {
                inject_terminal_output(val, terminals);
            }
        }
        serde_json::Value::Array(items) => {
            for val in items {
                inject_terminal_output(val, terminals);
            }
        }
        _ => {}
    }
}

/// Drain a child stream into the shared output buffer, honouring the byte limit.
fn spawn_reader<R>(stream: Option<R>, buf: Arc<Mutex<String>>, truncated: Arc<Mutex<bool>>, limit: Option<u64>)
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    let Some(mut r) = stream else { return };
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match r.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut b = buf.lock().unwrap();
                    if let Some(lim) = limit {
                        if b.len() as u64 >= lim {
                            *truncated.lock().unwrap() = true;
                            break;
                        }
                    }
                    b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                }
            }
        }
    });
}

/// Spawn a terminal for the agent, register it, and return its id. Output streams
/// into the buffer; a waiter task records the exit code and notifies waiters —
/// ALWAYS (even on spawn failure) so `wait_for_exit` can never hang.
fn create_terminal(req: &CreateTerminalRequest, terminals: &Terminals) -> String {
    let id = format!("term-{}", TERM_COUNTER.fetch_add(1, Ordering::Relaxed));
    let output = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(Mutex::new(false));
    let exit: Arc<Mutex<Option<Option<i32>>>> = Arc::new(Mutex::new(None));
    let done = Arc::new(Notify::new());
    let limit = req.output_byte_limit;

    let mut cmd = tokio::process::Command::new(&req.command);
    cmd.args(&req.args);
    for e in &req.env {
        cmd.env(&e.name, &e.value);
    }
    if let Some(cwd) = &req.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (tokio Command inherent)
    // Its own process group, so `kill` ends whatever the command spawned too.
    platform::own_process_group_tokio(&mut cmd);

    let pid = match cmd.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            // Into the kill-on-close job like every other spawn: a tool the ACP
            // agent starts here is otherwise the one process tree that outlives
            // OctoShell (Windows doesn't kill children with their parent).
            if let Some(p) = pid {
                crate::jobctl::add(p);
            }
            spawn_reader(child.stdout.take(), output.clone(), truncated.clone(), limit);
            spawn_reader(child.stderr.take(), output.clone(), truncated.clone(), limit);
            let exit_w = exit.clone();
            let done_w = done.clone();
            tokio::spawn(async move {
                let code = child.wait().await.ok().and_then(|s| s.code());
                *exit_w.lock().unwrap() = Some(code);
                done_w.notify_waiters();
            });
            pid
        }
        Err(e) => {
            output.lock().unwrap().push_str(&format!("failed to start terminal: {e}"));
            *exit.lock().unwrap() = Some(Some(-1));
            done.notify_waiters();
            None
        }
    };

    terminals
        .lock()
        .unwrap()
        .insert(id.clone(), Terminal { output, truncated, exit, done, pid });
    id
}

/// Like [`create_terminal`], but runs the command inside the worktree's Docker
/// sandbox container (via [`SandboxManager::exec_capture`]) instead of on the
/// host — used when the global sandbox setting is on. Returns immediately with
/// the terminal id; a spawned task streams the container's combined output into
/// the buffer and records the exit code, ALWAYS notifying `done` so
/// `wait_for_exit` can't hang. Docker execs have no host pid, so `kill` is a
/// no-op for these (the container is torn down when the session/tab closes).
fn create_terminal_sandboxed(
    req: &CreateTerminalRequest,
    terminals: &Terminals,
    mgr: &SandboxManager,
    session_worktree: &str,
) -> String {
    let id = format!("term-{}", TERM_COUNTER.fetch_add(1, Ordering::Relaxed));
    let output = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(Mutex::new(false));
    let exit: Arc<Mutex<Option<Option<i32>>>> = Arc::new(Mutex::new(None));
    let done = Arc::new(Notify::new());
    let limit = req.output_byte_limit;

    // The agent sends command + args separately; the sandbox runs a single shell
    // line (`sh -c`), so join them. Prefer the request's cwd, else the session's.
    let mut parts = vec![req.command.clone()];
    parts.extend(req.args.iter().cloned());
    let cmdline = parts.join(" ");
    let worktree = req
        .cwd
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| session_worktree.to_string());

    terminals.lock().unwrap().insert(
        id.clone(),
        Terminal {
            output: output.clone(),
            truncated: truncated.clone(),
            exit: exit.clone(),
            done: done.clone(),
            pid: None,
        },
    );

    let mgr = mgr.clone();
    let out_cb = output.clone();
    let trunc_cb = truncated.clone();
    tokio::spawn(async move {
        let on_chunk = move |chunk: &str, _stderr: bool| {
            let mut b = out_cb.lock().unwrap();
            if let Some(lim) = limit {
                if b.len() as u64 >= lim {
                    *trunc_cb.lock().unwrap() = true;
                    return;
                }
            }
            b.push_str(chunk);
        };
        let code = mgr
            .exec_capture(worktree, cmdline, SANDBOX_IMAGE.to_string(), SandboxOptions::default(), on_chunk)
            .await;
        let final_code = match code {
            Ok(c) => Some(c as i32),
            Err(e) => {
                output.lock().unwrap().push_str(&format!("\nsandbox error: {e}"));
                Some(-1)
            }
        };
        *exit.lock().unwrap() = Some(final_code);
        done.notify_waiters();
    });
    id
}

/// Build the ACP exit status from a captured code (None = killed/unknown).
fn exit_status(code: Option<i32>) -> TerminalExitStatus {
    let st = TerminalExitStatus::new();
    match code {
        Some(c) if c >= 0 => st.exit_code(c as u32),
        _ => st,
    }
}

/// Kill a terminal's process tree (best-effort).
fn kill_pid(pid: Option<u32>) {
    if let Some(pid) = pid {
        platform::kill_tree(pid);
    }
}

#[derive(Clone, Serialize)]
struct AcpEvent {
    id: String,
    data: String, // one serialized ACP SessionUpdate (JSON)
}

#[derive(Clone, Serialize)]
struct AcpDone {
    id: String,
    code: i32,
    error: Option<String>,
}

/// One live ACP session: its prompt channel plus whether its adapter was
/// launched inside the Docker sandbox (so a toggle flip can respawn it).
struct AcpSession {
    tx: mpsc::UnboundedSender<String>,
    sandboxed: bool,
    /// Cancel switch for the turn IN FLIGHT. Dropping `tx` only unblocks the
    /// prompt loop between turns — while a prompt is being awaited the loop is
    /// parked on the agent's response, not on `rx`, so `cancel` couldn't interrupt
    /// it. A `watch<bool>` flipped to true aborts the in-flight prompt immediately
    /// (it retains its value, so there's no notify race).
    cancel: watch::Sender<bool>,
    /// When true, tool-permission requests are auto-approved (⚡ Auto) instead of
    /// prompting the user (🛡 Approve). Shared with the session's permission handler
    /// and updated on each `acp_send`, so the toggle applies mid-session.
    auto_approve: Arc<AtomicBool>,
}

/// Thread-safe registry of live ACP sessions, keyed by the caller-chosen session
/// id.
#[derive(Default, Clone)]
pub struct AcpManager {
    sessions: Arc<Mutex<HashMap<String, AcpSession>>>,
    /// In-flight one-shot orchestrator turns, keyed by request id, each holding a
    /// cancel trigger so the Stop button can abort them (see `acp_oneshot`).
    oneshots: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AcpManager {
    /// Send `prompt` to session `id`. Spawns the session task on first use (with
    /// `command` as the agent's launch command line, e.g.
    /// `npx @agentclientprotocol/claude-agent-acp`); subsequent calls reuse the
    /// running task so the conversation continues — UNLESS the sandbox setting
    /// changed since it was spawned: the session is long-lived, so a host-spawned
    /// adapter would silently keep running on the host after the user turns the
    /// sandbox ON (and vice versa). On mismatch, drop the old session and respawn.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        app: AppHandle,
        id: String,
        prompt: String,
        cwd: String,
        command: String,
        sandbox_image: Option<String>,
        sandbox_command: Option<String>,
        auto_approve: bool,
    ) {
        let want_sandbox = app.state::<SandboxConfig>().enabled()
            && sandbox_image.is_some()
            && sandbox_command.is_some();
        // Existing session in the right mode → just queue the prompt (and refresh
        // the approval mode, so toggling ⚡Auto/🛡Approve takes effect next turn).
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.get(&id) {
                if s.sandboxed == want_sandbox {
                    s.auto_approve.store(auto_approve, Ordering::Relaxed);
                    let _ = s.tx.send(prompt);
                    return;
                }
                // Mode changed: dropping the sender ends the old session's loop.
                sessions.remove(&id);
            }
        }

        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let auto_approve_flag = Arc::new(AtomicBool::new(auto_approve));
        // Seed the first prompt before anyone else can observe the session.
        let _ = tx.send(prompt);
        self.sessions.lock().unwrap().insert(
            id.clone(),
            AcpSession {
                tx: tx.clone(),
                sandboxed: want_sandbox,
                cancel: cancel_tx,
                auto_approve: auto_approve_flag.clone(),
            },
        );

        let sessions = self.sessions.clone();
        let my_tx = tx;
        tauri::async_runtime::spawn(async move {
            let err = run_session(app.clone(), id.clone(), cwd, command, sandbox_image, sandbox_command, rx, cancel_rx, auto_approve_flag)
                .await
                .err()
                .map(|e| e.to_string());
            // Only clean up OUR entry: a sandbox-toggle respawn may have already
            // replaced it with a fresh session — that one must not be torn down,
            // and OUR `done` must stay silent (the new session owns the in-flight
            // turn; an early done would flip the UI to idle mid-turn).
            let superseded = {
                let mut s = sessions.lock().unwrap();
                match s.get(&id) {
                    Some(e) if e.tx.same_channel(&my_tx) => {
                        s.remove(&id);
                        false
                    }
                    Some(_) => true,   // replaced by a respawn
                    None => false,     // cancelled / normal teardown
                }
            };
            if !superseded {
                let code = if err.is_some() { 1 } else { 0 };
                let _ = app.emit("agent://done", AcpDone { id, code, error: err });
            }
        });
    }

    /// End a session: dropping the sender makes the prompt loop see the channel
    /// close, return, and tear down the connection. Also aborts a one-shot
    /// orchestrator turn registered under the same id (firing its cancel trigger).
    pub fn cancel(&self, id: &str) {
        // Flip the cancel switch FIRST (aborts the in-flight prompt), then drop the
        // session. Removing it alone wouldn't interrupt a turn already awaiting the
        // agent's response — the loop isn't on `rx` then.
        if let Some(s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.cancel.send(true);
        }
        if let Some(tx) = self.oneshots.lock().unwrap().remove(id) {
            let _ = tx.send(());
        }
    }

    fn register_oneshot(&self, id: String, tx: oneshot::Sender<()>) {
        self.oneshots.lock().unwrap().insert(id, tx);
    }
    fn clear_oneshot(&self, id: &str) {
        self.oneshots.lock().unwrap().remove(id);
    }
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Normalise a session cwd to an absolute path. The ACP adapters (claude, codex)
/// reject "." or any relative path with `cwd must be an absolute path`, and an
/// empty cwd reaches us whenever a project is dispatched to before its shell has
/// reported one (e.g. a just-created worktree). Resolve against the app's working
/// directory rather than failing the turn.
fn absolute_start_dir(cwd: &str) -> String {
    let raw = cwd.trim();
    let here = || {
        std::env::current_dir()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    };
    if raw.is_empty() || raw == "." {
        here()
    } else if std::path::Path::new(raw).is_absolute() {
        raw.to_string()
    } else {
        std::env::current_dir()
            .map(|d| d.join(raw).to_string_lossy().to_string())
            .unwrap_or_else(|_| raw.to_string())
    }
}

/// Drive one ACP session end to end: spawn the agent, initialize, open a session,
/// then loop feeding prompts from `rx` until the channel closes.
async fn run_session(
    app: AppHandle,
    id: String,
    cwd: String,
    command: String,
    sandbox_image: Option<String>,
    sandbox_command: Option<String>,
    mut rx: mpsc::UnboundedReceiver<String>,
    mut cancel_rx: watch::Receiver<bool>,
    auto_approve: Arc<AtomicBool>,
) -> Result<(), BoxError> {
    let start_dir = absolute_start_dir(&cwd);

    // Sandbox routing. When the global flag is on AND the provider supports it
    // (image+command supplied), run the WHOLE adapter inside Docker — every
    // command the agent runs is then contained, regardless of whether it uses the
    // client terminal capability. Otherwise launch the adapter on the host.
    let sandbox_cfg = app.state::<SandboxConfig>().inner().clone();
    let sandbox_mgr = app.state::<SandboxManager>().inner().clone();
    let sandboxed = sandbox_cfg.enabled() && sandbox_image.is_some() && sandbox_command.is_some();
    let agent = if sandboxed {
        let image = sandbox_image.as_ref().unwrap();
        let inner = sandbox_command.as_ref().unwrap();
        let args = docker_launch_args(image, inner, &start_dir);
        AcpAgent::from_args(args)?
    } else {
        AcpAgent::from_str(&command)?
    };
    // Inside the container the worktree is bind-mounted at /app; the host path
    // doesn't exist there, so the ACP session cwd must be the in-container path.
    let session_cwd = if sandboxed { "/app".to_string() } else { start_dir.clone() };

    // Clones for the per-connection handler closures (each closure moves its own).
    let app_notif = app.clone();
    let id_notif = id.clone();
    // Permission handler: route the agent's tool-approval requests through the
    // shared ApprovalBridge (same UI flow as the native claude path).
    let app_perm = app.clone();
    let id_perm = id.clone();
    let bridge = app.state::<ApprovalBridge>().inner().clone();
    let auto_perm = auto_approve.clone();
    // Client-terminal registry, shared across the terminal/* handlers.
    let terminals: Terminals = Arc::new(Mutex::new(HashMap::new()));
    let term_create = terminals.clone();
    let term_out = terminals.clone();
    let term_wait = terminals.clone();
    let term_kill = terminals.clone();
    let term_rel = terminals.clone();
    let term_notif = terminals.clone();
    // The worktree used for sandboxed terminal commands (the session's cwd).
    let term_worktree = start_dir.clone();
    // Per-TURN completion signal. An ACP session is long-lived across turns, so
    // the prompt loop keeps running after each turn finishes — we must tell the UI
    // "this turn ended" ourselves, or the agent stays stuck in `running` forever
    // (and the review pass, which fires on turn-end, never runs). We emit
    // `agent://done` after every completed prompt; the session stays alive for the
    // next one. (Cancel/error/teardown still emit their own done in the spawn.)
    let app_turn = app.clone();
    let id_turn = id.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                // Forward every session update to the UI as serialized JSON; the
                // frontend maps `sessionUpdate` variants to feed blocks.
                if let Ok(mut v) = serde_json::to_value(&n.update) {
                    // Terminal tool calls reference output we hold; inline it so the
                    // feed can show the command's real output (and failures).
                    inject_terminal_output(&mut v, &term_notif);
                    if let Ok(data) = serde_json::to_string(&v) {
                        let _ = app_notif.emit("agent://event", AcpEvent { id: id_notif.clone(), data });
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, _conn| {
                // Ask the user (via the ApprovalBridge → approval://request UI),
                // then map their yes/no onto the agent's offered options.
                let input = serde_json::to_value(&req.tool_call).unwrap_or(serde_json::Value::Null);
                // Best-effort human label from the tool_call payload.
                let tool_name = input
                    .get("title")
                    .and_then(|v| v.as_str())
                    .or_else(|| input.get("fields").and_then(|f| f.get("title")).and_then(|v| v.as_str()))
                    .unwrap_or("tool")
                    .to_string();
                // ⚡ Auto mode: approve without prompting. 🛡 Approve mode: ask the
                // user via the ApprovalBridge (approval://request UI) as before.
                let allow = if auto_perm.load(Ordering::Relaxed) {
                    true
                } else {
                    bridge.request(&app_perm, id_perm.clone(), tool_name, input).await.0
                };
                let allow_opt = req
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                        )
                    })
                    .or_else(|| req.options.first())
                    .map(|o| o.option_id.clone());
                let reject_opt = req
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways
                        )
                    })
                    .map(|o| o.option_id.clone());
                let outcome = match if allow { allow_opt } else { reject_opt } {
                    Some(oid) => {
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(oid))
                    }
                    None => RequestPermissionOutcome::Cancelled,
                };
                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        // ── terminal/* : the agent asks us to run its shell commands ──
        .on_receive_request(
            async move |req: CreateTerminalRequest, responder, _conn| {
                // Route through Docker when the global sandbox flag is on, else
                // run on the host. Either way returns a terminal id immediately.
                let id = if sandbox_cfg.enabled() {
                    create_terminal_sandboxed(&req, &term_create, &sandbox_mgr, &term_worktree)
                } else {
                    create_terminal(&req, &term_create)
                };
                responder.respond(CreateTerminalResponse::new(TerminalId::new(id)))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: TerminalOutputRequest, responder, _conn| {
                let key = req.terminal_id.0.to_string();
                let t = term_out.lock().unwrap().get(&key).cloned();
                let resp = match t {
                    Some(t) => {
                        let out = t.output.lock().unwrap().clone();
                        let trunc = *t.truncated.lock().unwrap();
                        let mut r = TerminalOutputResponse::new(out, trunc);
                        if let Some(code) = t.exit.lock().unwrap().clone() {
                            r = r.exit_status(exit_status(code));
                        }
                        r
                    }
                    None => TerminalOutputResponse::new(String::new(), false),
                };
                responder.respond(resp)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: WaitForTerminalExitRequest, responder, _conn| {
                let key = req.terminal_id.0.to_string();
                let t = term_wait.lock().unwrap().get(&key).cloned();
                let status = match t {
                    Some(t) => loop {
                        // Register interest BEFORE checking, so a notify between
                        // the check and the await can't be missed.
                        let notified = t.done.notified();
                        if let Some(code) = t.exit.lock().unwrap().clone() {
                            break exit_status(code);
                        }
                        notified.await;
                    },
                    None => TerminalExitStatus::new(),
                };
                responder.respond(WaitForTerminalExitResponse::new(status))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: KillTerminalRequest, responder, _conn| {
                let pid = term_kill.lock().unwrap().get(&req.terminal_id.0.to_string()).and_then(|t| t.pid);
                kill_pid(pid);
                responder.respond(KillTerminalResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: ReleaseTerminalRequest, responder, _conn| {
                let t = term_rel.lock().unwrap().remove(&req.terminal_id.0.to_string());
                if let Some(t) = t {
                    kill_pid(t.pid);
                }
                responder.respond(ReleaseTerminalResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |conn: ConnectionTo<Agent>| async move {
            // Advertise the terminal capability so the agent routes its shell
            // commands to us (create/output/wait/kill/release above).
            let mut init = InitializeRequest::new(ProtocolVersion::V1);
            init.client_capabilities.terminal = true;
            conn.send_request(init).block_task().await?;
            let session = conn
                .send_request(NewSessionRequest::new(session_cwd))
                .block_task()
                .await?;
            let session_id = session.session_id;

            // Long-lived: process prompts as they arrive. The loop ends when the
            // channel closes (app exit / respawn) OR the cancel switch flips — the
            // latter aborts even a prompt that's mid-flight, so Stop / take-over is
            // immediate instead of waiting out the current turn.
            loop {
                let prompt = tokio::select! {
                    _ = cancel_rx.wait_for(|c| *c) => break,
                    maybe = rx.recv() => match maybe {
                        Some(p) => p,
                        None => break,
                    },
                };
                let send = conn
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new(prompt))],
                    ))
                    .block_task();
                tokio::select! {
                    _ = cancel_rx.wait_for(|c| *c) => break,
                    res = send => {
                        res?;
                        // Turn finished cleanly — flip the UI to idle and let the
                        // review pass kick in. The session stays alive for the next
                        // prompt (a fresh `acp_send` reuses it).
                        let _ = app_turn.emit(
                            "agent://done",
                            AcpDone { id: id_turn.clone(), code: 0, error: None },
                        );
                    }
                }
            }
            Ok(())
        })
        .await?;
    Ok(())
}

/// One-shot ACP turn for the ORCHESTRATOR (a pure planner). Unlike [`run_session`]
/// this doesn't stream to the UI, keep a live session, or advertise the terminal
/// capability — it spawns the adapter, opens a session, sends ONE prompt, collects
/// the assistant's text, and tears down. This lets any ACP agent back the
/// orchestrator (which only needs text back, then OctoShell parses its
/// `octo-actions` block). A 3-minute timeout guards against an agent that hangs
/// waiting on an unhandled tool-permission request.
pub async fn run_oneshot(
    command: String,
    cwd: String,
    prompt: String,
    cancel: oneshot::Receiver<()>,
) -> Result<String, BoxError> {
    // The ACP session cwd MUST be absolute (the claude/codex adapters reject "."
    // or any relative path). The one-shot planner does no file ops, so resolve a
    // relative/empty cwd against the app's working directory to a real absolute
    // path rather than failing the turn.
    let start_dir = {
        let raw = cwd.trim();
        if raw.is_empty() || raw == "." {
            std::env::current_dir()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        } else if std::path::Path::new(raw).is_absolute() {
            raw.to_string()
        } else {
            std::env::current_dir()
                .map(|d| d.join(raw).to_string_lossy().to_string())
                .unwrap_or_else(|_| raw.to_string())
        }
    };
    let agent = AcpAgent::from_str(&command)?;

    // Accumulate assistant text from `agent_message_chunk` notifications. We parse
    // the serialized update the same way the frontend does (sessionUpdate variant).
    let buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let buf_n = buf.clone();

    let drive = agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                if let Ok(val) = serde_json::to_value(&n.update) {
                    if val.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk") {
                        if let Some(t) = val
                            .get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|v| v.as_str())
                        {
                            buf_n.lock().unwrap().push_str(t);
                        }
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(agent, move |conn: ConnectionTo<Agent>| async move {
            // No terminal capability advertised: a planner runs no tools.
            conn.send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let session = conn
                .send_request(NewSessionRequest::new(start_dir))
                .block_task()
                .await?;
            conn.send_request(PromptRequest::new(
                session.session_id,
                vec![ContentBlock::Text(TextContent::new(prompt))],
            ))
            .block_task()
            .await?;
            Ok(())
        });

    // Race the turn against the 180s timeout AND the Stop trigger; either ends it
    // (dropping `drive` tears down the connection/subprocess).
    tokio::select! {
        res = tokio::time::timeout(std::time::Duration::from_secs(180), drive) => match res {
            Ok(r) => r?,
            Err(_) => return Err("the ACP orchestrator turn timed out (180s)".into()),
        },
        _ = cancel => return Err("cancelled".into()),
    }
    let out = buf.lock().unwrap().clone();
    Ok(out)
}

/// Command entry: run a one-shot ACP orchestrator turn and return its text.
/// Registered under `request_id` so `acp_cancel(request_id)` (fired by the Stop
/// button) can abort it mid-flight.
#[tauri::command]
pub async fn acp_oneshot(
    manager: State<'_, AcpManager>,
    request_id: String,
    command: String,
    cwd: String,
    prompt: String,
) -> Result<String, String> {
    let (tx, rx) = oneshot::channel::<()>();
    manager.register_oneshot(request_id.clone(), tx);
    let result = run_oneshot(command, cwd, prompt, rx).await;
    manager.clear_oneshot(&request_id);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_send(
    app: AppHandle,
    manager: State<'_, AcpManager>,
    id: String,
    prompt: String,
    cwd: String,
    command: String,
    sandbox_image: Option<String>,
    sandbox_command: Option<String>,
    auto_approve: bool,
) -> Result<(), String> {
    manager.send(app, id, prompt, cwd, command, sandbox_image, sandbox_command, auto_approve);
    Ok(())
}

#[tauri::command]
pub fn acp_cancel(manager: State<'_, AcpManager>, id: String) -> Result<(), String> {
    manager.cancel(&id);
    Ok(())
}
