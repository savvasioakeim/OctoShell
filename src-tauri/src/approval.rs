//! Per-tool approval bridge.
//!
//! When approval is enabled for an agent run, Claude is launched with
//! `--permission-prompt-tool mcp__octo__approve` pointing at a tiny stdio MCP
//! server (the *sidecar*, written to disk at startup) plus a `--settings` block
//! that routes sensitive tools to "ask". Whenever the agent wants to run such a
//! tool, the sidecar opens a localhost TCP line to this bridge, which surfaces
//! the request to the UI (`approval://request`) and BLOCKS until the user
//! approves or denies (`approval_respond`). The decision is written back and the
//! sidecar returns it to Claude. The sidecar auto-allows nothing — any failure
//! defaults to deny.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// Tools that require approval when approval mode is on (mutating / executing).
/// Read-only tools (Read/Glob/Grep) stay auto-allowed so review isn't spammed.
pub const ASK_TOOLS: &str =
    r#"{"permissions":{"ask":["Bash","Edit","Write","NotebookEdit","MultiEdit"]}}"#;

/// The sidecar MCP server (Node, stdio). Forwards every request to the user via
/// the bridge and defaults to deny on any error — never an auto-allow.
const SIDECAR_JS: &str = r#"
const net = require("net");
const PORT = parseInt(process.env.OCTO_PORT, 10);
const SESSION = process.env.OCTO_SESSION || "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const TOKEN = process.env.OCTO_TOKEN || "";
function ask(args, cb) {
  let done = false;
  const finish = (d) => { if (!done) { done = true; cb(d); } };
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write(JSON.stringify({ token: TOKEN, session: SESSION, tool_name: args.tool_name, input: args.input || {}, tool_use_id: args.tool_use_id || "" }) + "\n");
  });
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    const i = buf.indexOf("\n");
    if (i >= 0) { sock.end(); try { finish(JSON.parse(buf.slice(0, i))); } catch { finish({ allow: false, message: "bridge parse error" }); } }
  });
  sock.on("error", () => finish({ allow: false, message: "approval bridge unavailable" }));
}
function handle(m) {
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "octo", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve", description: "Ask the OctoShell user to approve or deny a tool call.", inputSchema: { type: "object", additionalProperties: true } }] } });
  else if (m.method === "tools/call") {
    const a = (m.params && m.params.arguments) || {};
    ask(a, (dec) => {
      const reply = dec && dec.allow
        ? { behavior: "allow", updatedInput: (dec.updatedInput != null ? dec.updatedInput : (a.input || {})) }
        : { behavior: "deny", message: (dec && dec.message) || "Denied by the user" };
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(reply) }] } });
    });
  } else if (m.id != null && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
"#;

/// The dev-server sidecar MCP server (Node, stdio). Always attached to agents, so
/// an agent that needs a dev server asks OctoShell for one instead of burying
/// `npm run dev &` in a Bash call -- where nobody can see it, stop it, or know
/// which port it took. Every call goes through the same token-checked bridge as
/// approvals; the UI does the actual start, so what an agent starts appears in
/// the Services panel next to what you started.
const SERVICES_JS: &str = r#"
const net = require("net");
const PORT = parseInt(process.env.OCTO_PORT, 10);
const SESSION = process.env.OCTO_SESSION || "";
const TOKEN = process.env.OCTO_TOKEN || "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function call(op, args, cb) {
  let done = false;
  const finish = (d) => { if (!done) { done = true; cb(d); } };
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write(JSON.stringify({ token: TOKEN, session: SESSION, op, args: args || {} }) + "\n");
  });
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    const i = buf.indexOf("\n");
    if (i >= 0) { sock.end(); try { finish(JSON.parse(buf.slice(0, i))); } catch { finish({ ok: false, error: "bridge parse error" }); } }
  });
  sock.on("error", () => finish({ ok: false, error: "OctoShell is not reachable" }));
}
const TOOLS = [
  { name: "list_dev_servers", description: "List every dev server OctoShell is managing: project, command, status (starting/running/exited), URL, port, pid, and who started it. Call this BEFORE starting one -- the server you need may already be running.", inputSchema: { type: "object", properties: {} } },
  { name: "start_dev_server", description: "Start a dev server for THIS project, managed by OctoShell (visible to the user in the Services panel, stoppable, port-tracked). Use this instead of running a dev server in Bash. If this project already has one starting or running, returns that one instead of starting a duplicate. Waits briefly and returns status, URL and the first log lines.", inputSchema: { type: "object", properties: { command: { type: "string", description: "Command to run. Omit to use the project's configured dev command (else `npm run dev`)." }, port: { type: "number", description: "Port the server should use, if it needs a specific one." }, restart: { type: "boolean", description: "Restart this project's server even if it is already running." } } } },
  { name: "stop_dev_server", description: "Stop a dev server this project owns, by id from list_dev_servers.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "dev_server_logs", description: "Recent output of a managed dev server, by id from list_dev_servers. Use it to see why a server failed or which URL it printed.", inputSchema: { type: "object", properties: { id: { type: "string" }, lines: { type: "number", description: "How many trailing lines (default 60, max 300)." } }, required: ["id"] } },
  { name: "update_task_progress", description: "Record progress on the task you were given, in OctoShell's task journal for this project. Call it when you finish a meaningful step, when you are blocked, and ONCE AT THE END. The user's QA for this work is built from this journal, so the final call must say concretely what changed and how a person can verify it.", inputSchema: { type: "object", properties: { summary: { type: "string", description: "What you just did or found, in a sentence or two." }, status: { type: "string", enum: ["in_progress", "blocked", "done"] }, changed: { type: "string", description: "What changed: features, behaviour, files (on the final call)." }, how_to_verify: { type: "string", description: "Concrete steps a person can follow to check it works: where to click, what to expect (on the final call)." } }, required: ["summary"] } },
];
const OPS = { list_dev_servers: "list", start_dev_server: "start", stop_dev_server: "stop", dev_server_logs: "logs", update_task_progress: "task" };
function handle(m) {
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "octo_services", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  else if (m.method === "tools/call") {
    const name = m.params && m.params.name;
    const op = OPS[name];
    if (!op) { send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "unknown tool " + name }] } }); return; }
    call(op, (m.params && m.params.arguments) || {}, (r) => {
      send({ jsonrpc: "2.0", id: m.id, result: { isError: !(r && r.ok), content: [{ type: "text", text: JSON.stringify(r, null, 2) }] } });
    });
  } else if (m.id != null && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
"#;

/// Length-aware constant-time byte comparison (no early-exit timing leak).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

static COUNTER: AtomicU64 = AtomicU64::new(1);
fn next_id() -> String {
    format!("ap-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

struct Decision {
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
}

/// Managed Tauri state: the localhost port, the sidecar path, and the maps of
/// in-flight requests awaiting a UI decision. Cheap to clone (all shared state is
/// Arc-backed) so async callers (acp.rs) can hold an owned handle across awaits.
#[derive(Default, Clone)]
pub struct ApprovalBridge {
    port: Arc<Mutex<u16>>,
    script: Arc<Mutex<Option<String>>>,
    /// Shared secret the sidecar must present on every request. Without it, any
    /// local process could connect to the localhost listener and pop a spoofed
    /// approval prompt in the UI. Generated once at startup, passed to the
    /// sidecar via the OCTO_TOKEN env var.
    token: Arc<Mutex<String>>,
    /// Sidecar (Claude MCP) waiters — resolved on a blocking std thread.
    pending: Arc<Mutex<HashMap<String, Sender<Decision>>>>,
    /// In-process async waiters (ACP permission requests) — resolved via a tokio
    /// oneshot so acp.rs can `.await` the user's decision directly.
    async_pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Decision>>>>,
    /// The dev-server sidecar's path (see SERVICES_JS).
    services_script: Arc<Mutex<Option<String>>>,
    /// Dev-server requests waiting for the UI to act and answer.
    services_pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
}

impl ApprovalBridge {
    /// Ask the user to approve/deny a tool the ACP agent wants to run. Emits the
    /// same `approval://request` event the UI already renders, then awaits the
    /// decision (`approval_respond`). A dropped channel (app closing) means deny.
    pub async fn request(
        &self,
        app: &AppHandle,
        session: String,
        tool_name: String,
        input: Value,
    ) -> (bool, Option<Value>) {
        let request_id = next_id();
        let (tx, rx) = tokio::sync::oneshot::channel::<Decision>();
        self.async_pending.lock().unwrap().insert(request_id.clone(), tx);
        let _ = app.emit(
            "approval://request",
            ApprovalEvent {
                id: session,
                request_id,
                tool_name,
                input,
                tool_use_id: String::new(),
            },
        );
        match rx.await {
            Ok(d) => (d.allow, d.updated_input),
            Err(_) => (false, None), // app closed the request
        }
    }
}

/// Generate an unpredictable token for the approval bridge. Uses the OS-seeded
/// `RandomState` as the entropy source (no extra crate) — enough to stop a local
/// process from guessing it and spoofing approval prompts.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for i in 0..2u8 {
        let mut h = RandomState::new().build_hasher();
        h.write_u8(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

#[derive(Clone, Serialize)]
struct ServicesEvent {
    id: String, // octoshell session (project) id that asked
    #[serde(rename = "requestId")]
    request_id: String,
    op: String,
    args: Value,
}

#[derive(Clone, Serialize)]
struct ApprovalEvent {
    id: String, // octoshell session (project) id
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "toolName")]
    tool_name: String,
    input: Value,
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
}

#[derive(Deserialize)]
struct WireReq {
    #[serde(default)]
    token: String,
    session: String,
    /// Present on a dev-server request ("list" | "start" | "stop" | "logs");
    /// absent on an approval, which is what every older sidecar sends.
    #[serde(default)]
    op: Option<String>,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    tool_use_id: String,
}

impl ApprovalBridge {
    /// Write the sidecar to disk and bind the localhost listener. Call once.
    pub fn start(&self, app: AppHandle) {
        let dir = std::env::temp_dir().join("octoshell");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("permission-mcp.cjs");
        if std::fs::write(&path, SIDECAR_JS).is_ok() {
            *self.script.lock().unwrap() = Some(path.to_string_lossy().to_string());
        }

        let services_path = dir.join("services-mcp.cjs");
        if std::fs::write(&services_path, SERVICES_JS).is_ok() {
            *self.services_script.lock().unwrap() = Some(services_path.to_string_lossy().to_string());
        }

        let token = random_token();
        *self.token.lock().unwrap() = token.clone();

        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return,
        };
        *self.port.lock().unwrap() = listener.local_addr().map(|a| a.port()).unwrap_or(0);

        let pending = self.pending.clone();
        let services_pending = self.services_pending.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                let pending = pending.clone();
                let services_pending = services_pending.clone();
                let token = token.clone();
                thread::spawn(move || handle_conn(app, pending, services_pending, stream, token));
            }
        });
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
    pub fn script_path(&self) -> Option<String> {
        self.script.lock().unwrap().clone()
    }
    pub fn token(&self) -> String {
        self.token.lock().unwrap().clone()
    }
    pub fn services_script_path(&self) -> Option<String> {
        self.services_script.lock().unwrap().clone()
    }
}

fn handle_conn(
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, Sender<Decision>>>>,
    services_pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    stream: TcpStream,
    expected_token: String,
) {
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
        return;
    }
    let req: WireReq = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(_) => return,
    };
    // Reject anything that doesn't present our secret — a local process trying to
    // spoof an approval prompt. Constant-time compare to avoid a timing oracle.
    if !constant_time_eq(req.token.as_bytes(), expected_token.as_bytes()) {
        return;
    }

    if let Some(op) = req.op {
        answer_services(&app, &services_pending, stream, req.session, op, req.args);
        return;
    }

    let request_id = next_id();
    let (tx, rx) = channel::<Decision>();
    pending.lock().unwrap().insert(request_id.clone(), tx);

    let _ = app.emit(
        "approval://request",
        ApprovalEvent {
            id: req.session,
            request_id: request_id.clone(),
            tool_name: req.tool_name,
            input: req.input,
            tool_use_id: req.tool_use_id,
        },
    );

    // Block until the UI responds; a dropped channel (app closing) means deny.
    let decision = rx.recv().unwrap_or(Decision {
        allow: false,
        message: Some("OctoShell closed the request".into()),
        updated_input: None,
    });
    pending.lock().unwrap().remove(&request_id);

    let reply = if decision.allow {
        serde_json::json!({ "allow": true, "updatedInput": decision.updated_input })
    } else {
        serde_json::json!({ "allow": false, "message": decision.message.unwrap_or_else(|| "Denied".into()) })
    };
    let mut w = stream;
    let _ = writeln!(w, "{reply}");
    let _ = w.flush();
    let _ = w.shutdown(Shutdown::Both);
}

/// The UI's verdict for an in-flight approval request.
#[tauri::command]
pub fn approval_respond(
    bridge: State<'_, ApprovalBridge>,
    request_id: String,
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    // ACP async waiters first (tokio oneshot), then the sidecar std-mpsc waiters.
    if let Some(tx) = bridge.async_pending.lock().unwrap().remove(&request_id) {
        let _ = tx.send(Decision { allow, message, updated_input });
        return Ok(());
    }
    let tx = bridge.pending.lock().unwrap().remove(&request_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(Decision { allow, message, updated_input });
            Ok(())
        }
        None => Err("unknown or already-resolved approval request".into()),
    }
}

/// Hand a dev-server request to the UI and write its answer back to the sidecar.
///
/// The UI owns the service list (names, logs, who started what), so it does the
/// work; this only carries the question and the reply. A UI that never answers --
/// the project was closed mid-request -- gets a timeout rather than a hung agent.
fn answer_services(
    app: &AppHandle,
    services_pending: &Arc<Mutex<HashMap<String, Sender<Value>>>>,
    stream: TcpStream,
    session: String,
    op: String,
    args: Value,
) {
    let request_id = next_id();
    let (tx, rx) = channel::<Value>();
    services_pending.lock().unwrap().insert(request_id.clone(), tx);
    let _ = app.emit(
        "services://request",
        ServicesEvent { id: session, request_id: request_id.clone(), op, args },
    );
    let reply = rx
        .recv_timeout(std::time::Duration::from_secs(90))
        .unwrap_or_else(|_| serde_json::json!({ "ok": false, "error": "OctoShell did not answer (is this project still open?)" }));
    services_pending.lock().unwrap().remove(&request_id);
    let mut w = stream;
    let _ = writeln!(w, "{reply}");
    let _ = w.flush();
    let _ = w.shutdown(Shutdown::Both);
}

/// The UI's answer to a dev-server request from an agent.
#[tauri::command]
pub fn services_respond(
    bridge: State<'_, ApprovalBridge>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    match bridge.services_pending.lock().unwrap().remove(&request_id) {
        Some(tx) => {
            let _ = tx.send(result);
            Ok(())
        }
        None => Err("unknown or already-answered services request".into()),
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// Every approval sidecar in the wild sends no `op`. Adding dev-server ops to
    /// the same wire must not turn those into something else, or approval mode
    /// silently stops asking.
    #[test]
    fn an_approval_without_op_is_still_an_approval() {
        let r: WireReq = serde_json::from_str(
            r#"{"token":"t","session":"s","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"u"}"#,
        )
        .unwrap();
        assert!(r.op.is_none());
        assert_eq!(r.tool_name, "Bash");
    }

    #[test]
    fn a_services_request_carries_its_op_and_args() {
        let r: WireReq = serde_json::from_str(
            r#"{"token":"t","session":"s","op":"start","args":{"command":"npm run dev"}}"#,
        )
        .unwrap();
        assert_eq!(r.op.as_deref(), Some("start"));
        assert_eq!(r.args["command"], "npm run dev");
        assert_eq!(r.tool_name, "", "a services request has no tool name, and needs none");
    }

    #[test]
    fn a_request_without_a_session_is_rejected() {
        // The session is what routes a request to one project; without it the UI
        // could not know whose server this is.
        assert!(serde_json::from_str::<WireReq>(r#"{"token":"t","op":"list"}"#).is_err());
    }
}
