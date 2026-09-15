//! Agent runner — drives the local `claude` (Claude Code) CLI in headless
//! streaming mode and forwards its newline-delimited JSON events to the UI, so
//! OctoShell can render each assistant message and each tool call/result as its
//! own semantic block instead of one opaque TUI session.
//!
//! Each turn spawns `claude --print <prompt> --output-format stream-json` and a
//! dedicated thread reads stdout line by line, emitting:
//!
//!   * `agent://event` — `{ id, data }` where `data` is one raw JSON line
//!   * `agent://done`  — `{ id, code, error }` when the process exits
//!
//! Parsing of the JSON is intentionally left to the frontend (flexible, and the
//! schema lives in one place). Conversation continuity across turns is handled
//! by passing the previous `session_id` back in via `--resume`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::approval::ApprovalBridge;

#[cfg(windows)]
const CLAUDE_BIN: &str = "claude.exe";
#[cfg(not(windows))]
const CLAUDE_BIN: &str = "claude";

/// Thread-safe registry of in-flight agent runs, keyed by session id, so a run
/// can be cancelled and a new turn replaces any stale one.
#[derive(Default, Clone)]
pub struct AgentManager {
    runs: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Clone, Serialize)]
struct AgentEvent {
    id: String,
    data: String, // one raw JSON line from claude's stream-json output
}

#[derive(Clone, Serialize)]
struct AgentDone {
    id: String,
    code: i32,
    error: Option<String>,
}

impl AgentManager {
    pub fn send(
        &self,
        app: AppHandle,
        id: String,
        prompt: String,
        cwd: String,
        resume: Option<String>,
        model: Option<String>,
        provider: Option<String>,
        approval: bool,
        approval_port: u16,
        approval_script: Option<String>,
        approval_token: String,
        config_dir: Option<String>,
        effort: Option<String>,
        skills_off: Vec<String>,
        services_script: Option<String>,
    ) -> Result<(), String> {
        // One active turn per session: replace any in-flight run.
        if let Some(mut old) = self.runs.lock().unwrap().remove(&id) {
            let _ = old.kill();
        }

        let provider = provider.as_deref().unwrap_or("claude").to_string();
        let resumed = resume.as_deref().map(|r| !r.is_empty()).unwrap_or(false);

        // Sandbox (native claude only): when the global flag is on, run the WHOLE
        // claude-code CLI inside a Docker container (same hardening + shared login
        // volume as the ACP whole-adapter path). Approval mode is forced off in
        // the container — the MCP approval sidecar is a host script talking to a
        // host-loopback TCP bridge, neither of which exists inside — and the
        // sandbox itself is the containment story there.
        let sandbox_enabled = app.state::<crate::docker::SandboxConfig>().enabled();
        let sandboxed = provider == "claude" && sandbox_enabled && !cwd.is_empty();
        let approval = approval && !sandboxed;

        // Per-provider argument list (the binary is chosen below). Both stream
        // newline-delimited JSON and run tools autonomously (yolo / skip-perms).
        let mut args: Vec<String> = Vec::new();
        if provider == "gemini" {
            args.extend([
                "-p".into(), prompt.clone(),
                "-o".into(), "stream-json".into(),
                "--approval-mode".into(), "yolo".into(),
                "--skip-trust".into(),
            ]);
            if let Some(m) = &model { args.push("-m".into()); args.push(m.clone()); }
            // gemini --resume takes "latest"/index (per project dir), not an id.
            if resumed { args.push("--resume".into()); args.push("latest".into()); }
        } else {
            args.extend([
                "--print".into(), prompt.clone(),
                "--output-format".into(), "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(), // token-by-token streaming
                // Eagerly load the full built-in tool set (incl. TodoWrite) rather
                // than the deferred/tool-search subset, so the agent can report its
                // task plan via TodoWrite — which drives our trace progress bar.
                "--tools".into(), "default".into(),
            ]);
            // Approval mode: route sensitive tools to our permission MCP sidecar
            // (which asks the user). Otherwise run fully autonomously.
            // `--settings` carries two unrelated things, so it is assembled once:
            // the approval allow-list, and the skills the user switched off in
            // Settings (`skillOverrides` is a per-skill listing override, so "off"
            // keeps the skill installed but stops it being offered to the model).
            let mut settings = serde_json::Map::new();
            if !skills_off.is_empty() {
                settings.insert(
                    "skillOverrides".into(),
                    serde_json::Value::Object(
                        skills_off.iter().map(|n| (n.clone(), serde_json::json!("off"))).collect(),
                    ),
                );
            }
            // MCP servers OctoShell itself provides, assembled once for one
            // `--mcp-config`. The dev-server tools ride along on every run (a
            // sandboxed run excepted: the sidecar is a host path the container
            // cannot see); the approval server only in approval mode.
            let octo_env = serde_json::json!({
                "OCTO_PORT": approval_port.to_string(),
                "OCTO_SESSION": id.clone(),
                "OCTO_TOKEN": approval_token.clone(),
            });
            let mut mcp_servers = serde_json::Map::new();
            if let Some(script) = services_script.as_ref().filter(|_| !sandboxed) {
                mcp_servers.insert(
                    "octo_services".into(),
                    serde_json::json!({ "command": "node", "args": [script], "env": octo_env }),
                );
            }
            if approval && approval_script.is_some() {
                let script = approval_script.unwrap();
                mcp_servers.insert(
                    "octo".into(),
                    serde_json::json!({ "command": "node", "args": [script], "env": octo_env }),
                );
                args.extend([
                    "--permission-mode".into(), "default".into(),
                    "--permission-prompt-tool".into(), "mcp__octo__approve".into(),
                ]);
                if let Ok(serde_json::Value::Object(ask)) =
                    serde_json::from_str::<serde_json::Value>(crate::approval::ASK_TOOLS)
                {
                    settings.extend(ask);
                }
                // Asking before an agent may LIST or START a managed server would
                // prompt for the one route we want agents to take instead of Bash.
                if let Some(serde_json::Value::Object(perms)) = settings.get_mut("permissions") {
                    perms.insert("allow".into(), serde_json::json!(["mcp__octo_services"]));
                }
            } else {
                args.push("--dangerously-skip-permissions".into());
            }
            if !mcp_servers.is_empty() {
                args.push("--mcp-config".into());
                args.push(serde_json::json!({ "mcpServers": mcp_servers }).to_string());
            }
            if !settings.is_empty() {
                args.push("--settings".into());
                args.push(serde_json::Value::Object(settings).to_string());
            }
            if let Some(r) = &resume { args.push("--resume".into()); args.push(r.clone()); }
            if let Some(m) = &model { args.push("--model".into()); args.push(m.clone()); }
            // How hard the model is asked to think. The CLI ignores an unknown
            // value with a warning rather than failing, but we still only ever
            // send one it accepts (see EFFORT_LEVELS on the TypeScript side).
            if let Some(e) = &effort { args.push("--effort".into()); args.push(e.clone()); }
        }

        // Sandboxed: `docker run … node:22 npx claude-code <args>` — every arg is
        // its own argv element, so the prompt never goes through a shell. The
        // worktree is mounted at /app (the container's cwd); the shared volume
        // carries the one-time sandbox login. On the host: gemini is an npm shim
        // (.cmd/.ps1) on Windows → cmd.exe; claude is a real .exe.
        #[cfg(windows)]
        let mut cmd = if sandboxed {
            let mut c = Command::new("docker");
            c.args(crate::acp::docker_run_prefix(&cwd));
            c.args(["node:22", "npx", "-y", "@anthropic-ai/claude-code@latest"]);
            c.args(&args);
            c
        } else if provider == "gemini" {
            let mut c = Command::new("cmd");
            c.arg("/c").arg("gemini").args(&args);
            c
        } else {
            let mut c = Command::new(CLAUDE_BIN);
            c.args(&args);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = if sandboxed {
            let mut c = Command::new("docker");
            c.args(crate::acp::docker_run_prefix(&cwd));
            c.args(["node:22", "npx", "-y", "@anthropic-ai/claude-code@latest"]);
            c.args(&args);
            c
        } else {
            let mut c = Command::new(if provider == "gemini" { "gemini" } else { CLAUDE_BIN });
            c.args(&args);
            c
        };

        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        // Profile selection (claude): point this agent at the chosen account's
        // config dir. With none, CLEAR the var so we don't inherit whatever account
        // OctoShell's own environment happens to pin (the default home config is
        // used instead) — the same rule as the orchestrator in ai.rs. A sandboxed
        // run ignores profiles: config dirs are host paths, and the container's
        // identity is the shared volume's own login.
        match config_dir.as_deref().filter(|s| !s.is_empty() && !sandboxed) {
            Some(dir) => {
                cmd.env("CLAUDE_CONFIG_DIR", dir);
            }
            None => {
                cmd.env_remove("CLAUDE_CONFIG_DIR");
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("could not launch the `{provider}` agent CLI (installed & on PATH?): {e}")
        })?;
        // Tie the agent (and its MCP sidecar / sub-processes, which inherit job
        // membership) to OctoShell's lifetime so it can't outlive a crash.
        crate::jobctl::add(child.id());
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("no stderr pipe")?;
        self.runs.lock().unwrap().insert(id.clone(), child);

        // Drain stderr on its own thread so a full pipe can't deadlock stdout.
        let err_buf = Arc::new(Mutex::new(String::new()));
        {
            let err_buf = err_buf.clone();
            thread::spawn(move || {
                let mut s = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut s);
                *err_buf.lock().unwrap() = s;
            });
        }

        let runs = self.runs.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) if l.trim().is_empty() => continue,
                    Ok(l) => {
                        if app
                            .emit("agent://event", AgentEvent { id: id.clone(), data: l })
                            .is_err()
                        {
                            return; // WebView gone
                        }
                    }
                    Err(_) => break,
                }
            }

            // stdout closed → the process is finishing. Reap it (unless it was
            // cancelled, in which case it's already been removed).
            let child_opt = runs.lock().unwrap().remove(&id);
            let code = match child_opt {
                Some(mut c) => c.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
                None => -1,
            };
            let error = {
                let e = err_buf.lock().unwrap().clone();
                let e = e.trim().to_string();
                if e.is_empty() {
                    None
                } else {
                    Some(e)
                }
            };
            let _ = app.emit("agent://done", AgentDone { id, code, error });
        });

        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(mut child) = self.runs.lock().unwrap().remove(id) {
            // `child.kill()` only terminates the agent CLI itself, not its
            // descendants (the Node MCP sidecar, any Bash the agent spawned).
            // Those would linger until app exit (the Job Object finally reaps
            // them). Kill the whole tree now so repeated cancels don't pile up.
            kill_tree(&child);
            let _ = child.kill();
        }
        Ok(())
    }
}

/// Terminate a child process AND its descendants. On Windows the only reliable
/// tree-kill without extra job plumbing is `taskkill /T`; elsewhere `child.kill`
/// (called by the caller) is left to handle it.
fn kill_tree(child: &Child) {
    #[cfg(windows)]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = child; // caller's child.kill() handles the single process
    }
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    bridge: State<'_, ApprovalBridge>,
    id: String,
    prompt: String,
    cwd: String,
    resume: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    approval: Option<bool>,
    config_dir: Option<String>,
    effort: Option<String>,
    skills_off: Option<Vec<String>>,
) -> Result<(), String> {
    manager.send(
        app, id, prompt, cwd, resume, model, provider,
        approval.unwrap_or(false), bridge.port(), bridge.script_path(), bridge.token(), config_dir,
        effort, skills_off.unwrap_or_default(), bridge.services_script_path(),
    )
}

#[tauri::command]
pub fn agent_cancel(manager: State<'_, AgentManager>, id: String) -> Result<(), String> {
    manager.cancel(&id)
}
