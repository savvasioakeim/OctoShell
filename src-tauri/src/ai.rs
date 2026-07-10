//! AI backend for the assistant sidebar.
//!
//! Two transports, chosen at call time:
//!   1. **API** — if `ANTHROPIC_API_KEY` is set, call the Anthropic Messages
//!      API directly (key stays server-side, never in the WebView).
//!   2. **CLI fallback** — otherwise shell out to the locally installed
//!      `claude` (Claude Code) in headless print mode, reusing whatever account
//!      the user is already logged into. No key required.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::State;

const MODEL: &str = "claude-sonnet-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
/// Output cap for the sidebar's API transport. 1024 silently truncated longer
/// answers mid-sentence; 8192 covers realistic assistant replies. (The CLI
/// transport has no such cap — this only affected the `ANTHROPIC_API_KEY` path.)
const MAX_TOKENS: u32 = 8192;

#[cfg(windows)]
const CLAUDE_BIN: &str = "claude.exe";
#[cfg(not(windows))]
const CLAUDE_BIN: &str = "claude";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Thread-safe registry of in-flight orchestrator CLI turns, keyed by a caller-
/// chosen request id, so a running turn can be cancelled (its `claude` child
/// killed) the same way an agent turn can.
#[derive(Default, Clone)]
pub struct AiManager {
    runs: Arc<Mutex<HashMap<String, Child>>>,
}

impl AiManager {
    pub fn cancel(&self, id: &str) {
        if let Some(mut child) = self.runs.lock().unwrap().remove(id) {
            let _ = child.kill();
        }
    }
}

/// Entry point invoked from the frontend. Picks API when a key exists,
/// otherwise the `claude` CLI fallback.
///
/// `model` selects the assistant's model (a CLI alias like "opus"/"sonnet", or a
/// full id for the API). `config_dir` selects a Claude Code *profile*: its value
/// becomes `CLAUDE_CONFIG_DIR` for the spawned `claude`, so a chosen account's
/// login is used. A selected profile forces the CLI transport (an env API key
/// must not silently override the account the user picked).
#[tauri::command]
pub async fn ai_chat(
    manager: State<'_, AiManager>,
    request_id: String,
    provider: Option<String>,
    messages: Vec<ChatMessage>,
    system: Option<String>,
    model: Option<String>,
    config_dir: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u64>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let provider = provider.as_deref().unwrap_or("claude").to_string();
    let has_profile = config_dir.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    // Local models (acp-ollama): the orchestrator is a pure planner (no tools), so
    // it talks straight to Ollama's HTTP chat API — no OpenCode/ACP needed.
    if provider == "acp-ollama" {
        chat_via_ollama(messages, system, model, base_url, num_ctx, temperature).await
    } else if provider == "claude" && !has_profile && std::env::var("ANTHROPIC_API_KEY").is_ok() {
        // The Anthropic API path is claude-only; gemini always shells out to its CLI.
        chat_via_api(messages, system, model).await
    } else {
        // The CLI call is blocking; keep it off the async runtime threads. The
        // child is registered under `request_id` so `ai_cancel` can kill it.
        let runs = manager.runs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            chat_via_cli(runs, request_id, provider, messages, system, model, config_dir)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub fn ai_cancel(manager: State<'_, AiManager>, request_id: String) -> Result<(), String> {
    manager.cancel(&request_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Transport 1: Anthropic API
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ApiResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default)]
    text: String,
}

async fn chat_via_api(
    messages: Vec<ChatMessage>,
    system: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|e| e.to_string())?;

    // The model picker hands us CLI aliases ("opus"); the API needs a full id, so
    // only honour an explicit full model id here, else fall back to the default.
    let model = model
        .as_deref()
        .filter(|m| m.starts_with("claude-"))
        .unwrap_or(MODEL);
    let body = serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system.unwrap_or_default(),
        "messages": messages,
    });

    let resp = reqwest::Client::new()
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("AI API error {status}: {detail}"));
    }

    let parsed: ApiResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .content
        .into_iter()
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join(""))
}

// ---------------------------------------------------------------------------
// Transport 1b: local Ollama HTTP chat (orchestrator on a local model)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OllamaChatResp {
    #[serde(default)]
    message: OllamaChatMsg,
    #[serde(default)]
    error: Option<String>,
}
#[derive(Deserialize, Default)]
struct OllamaChatMsg {
    #[serde(default)]
    content: String,
}

/// Non-streaming chat against Ollama's `/api/chat`. `model` may carry the
/// `ollama/` provider prefix (from the model picker) — strip it. `system` becomes
/// a leading system message; `num_ctx`/`temperature` are passed as options so the
/// orchestrator's (often large) workspace context isn't silently truncated.
async fn chat_via_ollama(
    messages: Vec<ChatMessage>,
    system: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    num_ctx: Option<u64>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let base = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/');
    let model = model.unwrap_or_default();
    let model = model.strip_prefix("ollama/").unwrap_or(&model).trim();
    if model.is_empty() {
        return Err("no local model selected for the orchestrator (pick one in Settings › Local LLM)".into());
    }

    let mut msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = system.as_deref().filter(|s| !s.is_empty()) {
        msgs.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in &messages {
        msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    let mut options = serde_json::Map::new();
    if let Some(n) = num_ctx {
        options.insert("num_ctx".into(), n.into());
    }
    if let Some(t) = temperature {
        options.insert("temperature".into(), serde_json::json!(t));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "stream": false,
        "options": options,
    });

    let resp = reqwest::Client::new()
        .post(format!("{base}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "could not reach Ollama (is it running?)".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama error {status}: {detail}"));
    }
    let parsed: OllamaChatResp = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = parsed.error {
        return Err(format!("Ollama: {err}"));
    }
    Ok(parsed.message.content.trim().to_string())
}

// ---------------------------------------------------------------------------
// Transport 2: local `claude` CLI (headless)
// ---------------------------------------------------------------------------

/// Flatten the conversation into a single labelled transcript the CLI can read.
fn build_transcript(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(|m| {
            let who = if m.role == "user" { "User" } else { "Assistant" };
            format!("{who}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn chat_via_cli(
    runs: Arc<Mutex<HashMap<String, Child>>>,
    request_id: String,
    provider: String,
    messages: Vec<ChatMessage>,
    system: Option<String>,
    model: Option<String>,
    config_dir: Option<String>,
) -> Result<String, String> {
    use std::io::Write;

    let transcript = build_transcript(&messages);

    // Everything goes over STDIN, not argv. Windows caps a process command line at
    // ~32 KB, and BOTH the transcript and the workspace context can be tens of KB.
    // Passing either as an argument blew up with "filename or extension is too
    // long" (os error 206). `--append-system-prompt` is the only argv path the CLI
    // offers for system text (there's no file variant), so instead of passing it we
    // fold the workspace context into the stdin prompt as a clearly delimited
    // leading block. stdin has no length limit. (`claude --print` reads the prompt
    // from stdin when none is given positionally.)
    let prompt = match system {
        Some(sys) if !sys.is_empty() => format!(
            "<<WORKSPACE CONTEXT (treat as system)>>\n{sys}\n<</WORKSPACE CONTEXT>>\n\n{transcript}"
        ),
        _ => transcript,
    };

    let is_gemini = provider == "gemini";

    // gemini is an npm shim on Windows (.cmd/.ps1) → must run via cmd.exe; claude
    // is a real .exe. Both read the prompt from stdin (piped below).
    #[cfg(windows)]
    let mut cmd = if is_gemini {
        let mut c = Command::new("cmd");
        c.arg("/c").arg("gemini");
        c
    } else {
        let mut c = Command::new(CLAUDE_BIN);
        c.arg("--print");
        c
    };
    #[cfg(not(windows))]
    let mut cmd = if is_gemini {
        Command::new("gemini")
    } else {
        let mut c = Command::new(CLAUDE_BIN);
        c.arg("--print");
        c
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if is_gemini {
        // A planning turn runs no tools, but yolo + skip-trust stop gemini from
        // pausing for any approval / folder-trust prompt in this non-interactive run.
        cmd.arg("--approval-mode").arg("yolo").arg("--skip-trust");
        if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("-m").arg(m);
        }
    } else {
        if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        // The orchestrator is a pure planner — it runs no tools. But `claude
        // --print` still loads every MCP server from the user's config, and ONE
        // hung remote server blocks the whole reply forever (observed: a stuck
        // remote MCP made the orchestrator never answer anything). Strict mode
        // skips config MCP servers entirely; planning needs none of them.
        cmd.arg("--strict-mcp-config");
        // Profile selection: point this `claude` at the chosen account's config dir.
        // With NO profile ("Default"), explicitly CLEAR the variable instead of just
        // leaving it — OctoShell inherits the parent environment, which may already
        // pin CLAUDE_CONFIG_DIR to one account, and "Default" must mean the true home
        // config (~/.claude.json, where e.g. the user's remote MCP servers live).
        match config_dir.as_deref().filter(|s| !s.is_empty()) {
            Some(dir) => {
                cmd.env("CLAUDE_CONFIG_DIR", dir);
            }
            None => {
                cmd.env_remove("CLAUDE_CONFIG_DIR");
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("could not launch the `{provider}` CLI (is it installed and on PATH?): {e}")
    })?;
    // Tie the assistant CLI to OctoShell's lifetime so it can't be orphaned.
    crate::jobctl::add(child.id());

    // Take the pipes BEFORE registering the child, so the registry only holds the
    // process handle (enough to kill it). Write the prompt, then drop stdin so
    // claude sees EOF and proceeds.
    let mut stdout = child.stdout.take().ok_or("could not open CLI stdout")?;
    let stderr = child.stderr.take().ok_or("could not open CLI stderr")?;
    {
        let mut stdin = child.stdin.take().ok_or("could not open CLI stdin")?;
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("failed writing prompt to the {provider} CLI: {e}"))?;
    }

    // Register so `ai_cancel(request_id)` can kill this turn mid-flight.
    runs.lock().unwrap().insert(request_id.clone(), child);

    // Drain stderr on its own thread so a full pipe can't deadlock the stdout read.
    let err_handle = thread::spawn(move || {
        let mut s = String::new();
        let mut r = stderr;
        let _ = r.read_to_string(&mut s);
        s
    });
    let mut out_s = String::new();
    let _ = stdout.read_to_string(&mut out_s);
    let err_s = err_handle.join().unwrap_or_default();

    // Reap. If the child is gone from the registry, `ai_cancel` removed+killed it.
    let status = match runs.lock().unwrap().remove(&request_id) {
        Some(mut c) => c.wait().ok(),
        None => return Err("cancelled".into()),
    };
    match status {
        Some(st) if st.success() => Ok(out_s.trim().to_string()),
        Some(st) => Err(format!("{provider} CLI exited with {st}: {}", err_s.trim())),
        None => Err(format!("{provider} CLI: could not get exit status")),
    }
}
