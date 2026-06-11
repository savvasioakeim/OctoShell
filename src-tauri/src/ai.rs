//! AI backend for the assistant sidebar.
//!
//! Two transports, chosen at call time:
//!   1. **API** — if `ANTHROPIC_API_KEY` is set, call the Anthropic Messages
//!      API directly (key stays server-side, never in the WebView).
//!   2. **CLI fallback** — otherwise shell out to the locally installed
//!      `claude` (Claude Code) in headless print mode, reusing whatever account
//!      the user is already logged into. No key required.

use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

const MODEL: &str = "claude-sonnet-4-6";
const API_URL: &str = "https://api.anthropic.com/v1/messages";

#[cfg(windows)]
const CLAUDE_BIN: &str = "claude.exe";
#[cfg(not(windows))]
const CLAUDE_BIN: &str = "claude";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Entry point invoked from the frontend. Picks API when a key exists,
/// otherwise the `claude` CLI fallback.
#[tauri::command]
pub async fn ai_chat(messages: Vec<ChatMessage>, system: Option<String>) -> Result<String, String> {
    if std::env::var("ANTHROPIC_API_KEY").is_ok() {
        chat_via_api(messages, system).await
    } else {
        // The CLI call is blocking; keep it off the async runtime threads.
        tauri::async_runtime::spawn_blocking(move || chat_via_cli(messages, system))
            .await
            .map_err(|e| e.to_string())?
    }
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
) -> Result<String, String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "model": MODEL,
        "max_tokens": 1024,
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

fn chat_via_cli(messages: Vec<ChatMessage>, system: Option<String>) -> Result<String, String> {
    use std::io::Write;

    let prompt = build_transcript(&messages);

    // The prompt goes over STDIN, not argv. A long orchestration thread can be
    // tens of KB, and Windows caps a process command line at ~32 KB — passing the
    // transcript as an argument blew up with "filename or extension is too long"
    // (os error 206). stdin has no such limit. (`claude --print` reads the prompt
    // from stdin when none is given positionally.)
    let mut cmd = Command::new(CLAUDE_BIN);
    cmd.arg("--print")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(sys) = system {
        if !sys.is_empty() {
            cmd.arg("--append-system-prompt").arg(sys);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("could not launch `{CLAUDE_BIN}` (is Claude Code installed and on PATH?): {e}")
    })?;

    // Write the prompt, then close stdin (drop) so claude sees EOF and proceeds.
    {
        let mut stdin = child.stdin.take().ok_or("could not open claude stdin")?;
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("failed writing prompt to claude: {e}"))?;
    }

    let out = child.wait_with_output().map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(format!(
            "claude CLI exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
