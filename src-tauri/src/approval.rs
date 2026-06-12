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
function ask(args, cb) {
  let done = false;
  const finish = (d) => { if (!done) { done = true; cb(d); } };
  const sock = net.connect(PORT, "127.0.0.1", () => {
    sock.write(JSON.stringify({ session: SESSION, tool_name: args.tool_name, input: args.input || {}, tool_use_id: args.tool_use_id || "" }) + "\n");
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

static COUNTER: AtomicU64 = AtomicU64::new(1);
fn next_id() -> String {
    format!("ap-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

struct Decision {
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
}

/// Managed Tauri state: the localhost port, the sidecar path, and the map of
/// in-flight requests awaiting a UI decision.
#[derive(Default)]
pub struct ApprovalBridge {
    port: Mutex<u16>,
    script: Mutex<Option<String>>,
    pending: Arc<Mutex<HashMap<String, Sender<Decision>>>>,
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
    session: String,
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

        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return,
        };
        *self.port.lock().unwrap() = listener.local_addr().map(|a| a.port()).unwrap_or(0);

        let pending = self.pending.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                let pending = pending.clone();
                thread::spawn(move || handle_conn(app, pending, stream));
            }
        });
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
    pub fn script_path(&self) -> Option<String> {
        self.script.lock().unwrap().clone()
    }
}

fn handle_conn(
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, Sender<Decision>>>>,
    stream: TcpStream,
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
    let tx = bridge.pending.lock().unwrap().remove(&request_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(Decision { allow, message, updated_input });
            Ok(())
        }
        None => Err("unknown or already-resolved approval request".into()),
    }
}
