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
use tauri::{AppHandle, Emitter, State};

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
    ) -> Result<(), String> {
        // One active turn per session: replace any in-flight run.
        if let Some(mut old) = self.runs.lock().unwrap().remove(&id) {
            let _ = old.kill();
        }

        let mut cmd = Command::new(CLAUDE_BIN);
        cmd.arg("--print")
            .arg(&prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            // Run autonomously: tools (Bash, Edit, …) execute without an
            // interactive approval prompt that would otherwise hang headless.
            .arg("--dangerously-skip-permissions");
        if let Some(r) = &resume {
            cmd.arg("--resume").arg(r);
        }
        if let Some(m) = &model {
            cmd.arg("--model").arg(m);
        }
        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
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
            format!("could not launch `{CLAUDE_BIN}` (is Claude Code installed and on PATH?): {e}")
        })?;
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
            let _ = child.kill();
        }
        Ok(())
    }
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    id: String,
    prompt: String,
    cwd: String,
    resume: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    manager.send(app, id, prompt, cwd, resume, model)
}

#[tauri::command]
pub fn agent_cancel(manager: State<'_, AgentManager>, id: String) -> Result<(), String> {
    manager.cancel(&id)
}
