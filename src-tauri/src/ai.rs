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
    // MCP server names the orchestrator may use (from Settings). Empty/None =
    // planner-only (no MCP servers loaded, the safe default).
    allowed_mcp: Option<Vec<String>>,
    // When true, the orchestrator gets READ-ONLY inspection tools (Read/Grep/Glob +
    // a git/gh/ls read-only Bash allowlist) so it can verify state instead of
    // guessing. Never Edit/Write or unrestricted Bash — it must not write code.
    readonly: Option<bool>,
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
            chat_via_cli(runs, request_id, provider, messages, system, model, config_dir, allowed_mcp, readonly)
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
// MCP server discovery (for the Settings "orchestrator MCP access" toggles)
// ---------------------------------------------------------------------------

/// Where Claude Code keeps its config (and the user's `mcpServers`). A profile
/// pins `CLAUDE_CONFIG_DIR` to a folder holding its own `.claude.json`; with no
/// profile ("Default") it's `~/.claude.json`.
fn claude_config_path(config_dir: Option<&str>) -> Option<std::path::PathBuf> {
    match config_dir.filter(|s| !s.is_empty()) {
        Some(dir) => Some(std::path::Path::new(dir).join(".claude.json")),
        None => home_dir().map(|h| h.join(".claude.json")),
    }
}

/// The user's home directory, without pulling in the `dirs` crate: `USERPROFILE`
/// on Windows, `HOME` elsewhere.
fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(std::path::PathBuf::from)
}

/// The `mcpServers` object from the resolved config, or empty if none/unreadable.
fn mcp_servers_map(config_dir: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    claude_config_path(config_dir)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("mcpServers").and_then(|m| m.as_object()).cloned())
        .unwrap_or_default()
}

/// One MCP server the user has configured, for the Settings checklist.
#[derive(Serialize)]
pub struct McpServerInfo {
    pub name: String,
    /// "http", "sse", or "stdio" — shown as a small hint in the UI.
    pub transport: String,
}

/// List the MCP servers configured for a given profile (or the home default),
/// so the user can tick which ones the orchestrator is allowed to use.
#[tauri::command]
pub fn list_mcp_servers(config_dir: Option<String>) -> Vec<McpServerInfo> {
    let map = mcp_servers_map(config_dir.as_deref());
    let mut out: Vec<McpServerInfo> = map
        .iter()
        .map(|(name, def)| {
            let transport = if def.get("url").is_some() {
                def.get("type").and_then(|t| t.as_str()).unwrap_or("http").to_string()
            } else {
                "stdio".to_string()
            };
            McpServerInfo { name: name.clone(), transport }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
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
    allowed_mcp: Option<Vec<String>>,
    readonly: Option<bool>,
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
        // MCP access is opt-in per server (Settings → MCP access). We NEVER load
        // the whole config blindly: one hung remote MCP used to block the reply
        // forever, and blanket tool access let the orchestrator edit files. So:
        //   * nothing selected → `--strict-mcp-config` (no MCP at all — pure
        //     planner, zero hang risk). This is the default.
        //   * some selected → load ONLY those servers via an inline `--mcp-config`
        //     (still strict, so config servers stay out), and pre-approve just
        //     THEIR tools with `--allowedTools mcp__<server>`. That lets the
        //     orchestrator call them headlessly WITHOUT `--dangerously-skip-
        //     permissions`, so Bash / file edits stay denied. Startup/tool
        //     timeouts bound a stuck server instead of hanging the turn.
        let selected: Vec<String> = allowed_mcp
            .unwrap_or_default()
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .collect();
        cmd.arg("--strict-mcp-config");
        // Pre-approved tools accumulate here (headless `--print` denies anything not
        // listed), then go out as ONE `--allowedTools`.
        let mut allowed_tools: Vec<String> = Vec::new();
        // READ-ONLY inspection toolset (Settings → Orchestrator). Lets the planner
        // verify reality — git/gh/ls + file reads — but NEVER Edit/Write or blanket
        // Bash, so it can't write code (only dispatched agents do). Anything not
        // listed is denied by the headless CLI, so even a confused attempt is inert.
        if readonly.unwrap_or(false) {
            for t in [
                "Read", "Grep", "Glob",
                "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
                "Bash(git show:*)", "Bash(git branch:*)", "Bash(git worktree list:*)",
                "Bash(git remote:*)", "Bash(git rev-parse:*)", "Bash(git stash list:*)",
                "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr checks:*)",
                "Bash(gh run list:*)", "Bash(gh run view:*)",
                "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
                "Bash(rg:*)", "Bash(find:*)", "Bash(which:*)", "Bash(npm ls:*)",
            ] {
                allowed_tools.push(t.to_string());
            }
        }
        if !selected.is_empty() {
            let all = mcp_servers_map(config_dir.as_deref());
            let mut chosen = serde_json::Map::new();
            for name in &selected {
                if let Some(def) = all.get(name) {
                    chosen.insert(name.clone(), def.clone());
                }
            }
            if !chosen.is_empty() {
                for n in chosen.keys() {
                    allowed_tools.push(format!("mcp__{n}"));
                }
                let cfg = serde_json::json!({ "mcpServers": chosen }).to_string();
                cmd.arg("--mcp-config").arg(cfg);
                cmd.env("MCP_TIMEOUT", "8000"); // server startup budget (ms)
                cmd.env("MCP_TOOL_TIMEOUT", "60000"); // per-tool-call budget (ms)
            }
        }
        if !allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(allowed_tools.join(","));
        }
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
        Some(st) => {
            // `claude --print` writes its error to STDOUT (often as text/JSON), not
            // stderr, so a bare exit code with empty stderr told us nothing. Surface
            // whichever stream carried a message, preferring stderr, then stdout.
            let detail = if !err_s.trim().is_empty() {
                err_s.trim().to_string()
            } else if !out_s.trim().is_empty() {
                out_s.trim().to_string()
            } else {
                "(no output on stderr or stdout)".to_string()
            };
            Err(format!("{provider} CLI exited with {st}: {detail}"))
        }
        None => Err(format!("{provider} CLI: could not get exit status")),
    }
}
