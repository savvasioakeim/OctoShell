//! Local Ollama integration for the Settings › Local LLM panel.
//!
//! Thin, dependency-light wrappers over Ollama's HTTP API (default
//! `http://localhost:11434`), so the WebView never has to reach a raw socket
//! itself (keeps CSP tight and centralises error messages):
//!   - [`ollama_version`] — connection probe (GET /api/version).
//!   - [`ollama_tags`]    — list locally pulled models (GET /api/tags).
//!   - [`ollama_pull`]    — download a model, streaming `ollama://pull`
//!     progress events (POST /api/pull, NDJSON stream).

use std::path::PathBuf;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Normalise a user-supplied base URL: trim, drop a trailing slash, default when
/// empty. Everything else appends `/api/...` to this.
fn base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.is_empty() {
        "http://localhost:11434".to_string()
    } else {
        u.to_string()
    }
}

#[derive(Deserialize)]
struct VersionResp {
    #[serde(default)]
    version: String,
}

/// Probe the daemon; returns its version string (e.g. "0.1.32") on success.
#[tauri::command]
pub async fn ollama_version(base_url: String) -> Result<String, String> {
    let url = format!("{}/api/version", base(&base_url));
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|_| "Not detected — ensure Ollama is running".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned {}", resp.status()));
    }
    let v: VersionResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.version)
}

#[derive(Deserialize)]
struct TagsResp {
    #[serde(default)]
    models: Vec<TagModel>,
}
#[derive(Deserialize)]
struct TagModel {
    #[serde(default)]
    name: String,
}

/// List the models the user has already pulled locally (their tags).
#[tauri::command]
pub async fn ollama_tags(base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base(&base_url));
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|_| "Not detected — ensure Ollama is running".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama returned {}", resp.status()));
    }
    let t: TagsResp = resp.json().await.map_err(|e| e.to_string())?;
    let mut names: Vec<String> = t.models.into_iter().map(|m| m.name).filter(|n| !n.is_empty()).collect();
    names.sort();
    Ok(names)
}

/// One `ollama://pull` progress tick emitted to the frontend during a download.
#[derive(Clone, Serialize)]
struct PullProgress {
    model: String,
    status: String,
    /// 0–100, or -1 when the current phase reports no byte totals.
    percent: i64,
}

/// A single NDJSON line from /api/pull.
#[derive(Deserialize)]
struct PullLine {
    #[serde(default)]
    status: String,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// Delete a locally-pulled model (frees its disk space). `DELETE /api/delete`.
#[tauri::command]
pub async fn ollama_delete(base_url: String, model: String) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("no model to delete".into());
    }
    let url = format!("{}/api/delete", base(&base_url));
    // Send both keys: newer Ollama takes `model`, older took `name`.
    let body = serde_json::json!({ "model": model, "name": model });
    let resp = reqwest::Client::new()
        .delete(&url)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Not detected — ensure Ollama is running".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama delete error {status}: {detail}"));
    }
    Ok(())
}

/// Fetch the list of model families available on the public Ollama library
/// (`ollama.com/library`), most-popular first. Ollama exposes NO official API for
/// this, so we scrape the index page's `/library/<name>` links from the backend
/// (no WebView CSP in the way). Best-effort: the caller falls back to a curated
/// shortlist if this fails or the page markup changes. Returns FAMILY names (e.g.
/// "qwen2.5-coder"); pulling a bare family name fetches its `:latest` tag.
#[tauri::command]
pub async fn ollama_library() -> Result<Vec<String>, String> {
    let resp = reqwest::Client::new()
        .get("https://ollama.com/library?sort=popular")
        .header("user-agent", "OctoShell")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama library returned {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;

    const MARKER: &str = "href=\"/library/";
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (idx, _) in html.match_indices(MARKER) {
        let rest = &html[idx + MARKER.len()..];
        let end = rest.find(['"', '/', '?']).unwrap_or(0);
        let name = &rest[..end];
        if !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            && seen.insert(name.to_string())
        {
            out.push(name.to_string());
        }
    }
    if out.is_empty() {
        return Err("Could not parse the Ollama library page".into());
    }
    Ok(out)
}

/// A space-free, OctoShell-owned directory to drop the generated OpenCode config
/// into. Space-free matters: the path is injected as an `OPENCODE_CONFIG=<path>`
/// env prefix on the ACP launch command, which is whitespace-tokenised — a space
/// in the path would split the token. `C:\Users\Public` is fixed and world-
/// writable on Windows (no username, so never any spaces); `~/.config` elsewhere.
fn config_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\Users\Public\.octoshell")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".config").join("octoshell")
    }
}

/// Write an OctoShell-owned OpenCode config that registers the local `ollama`
/// provider (OpenAI-compatible endpoint) with our inference defaults, and return
/// its path (forward-slashed, space-free) for `OPENCODE_CONFIG`. This lets local
/// runs honour the user's base URL, temperature and context window WITHOUT
/// touching the user's own global OpenCode config.
///
/// `num_ctx`/`temperature` are placed in the provider `options` (best-effort:
/// they're forwarded to the OpenAI-compatible request body; whether Ollama
/// applies `num_ctx` over the `/v1` endpoint depends on the Ollama version).
#[tauri::command]
pub fn opencode_config(base_url: String, temperature: f64, num_ctx: u64) -> Result<String, String> {
    let base = base(&base_url);
    let v1 = format!("{}/v1", base);
    let cfg = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama (local)",
                "options": {
                    "baseURL": v1,
                    "temperature": temperature,
                    "num_ctx": num_ctx,
                },
            }
        }
    });

    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = dir.join("opencode.json");
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write opencode config: {e}"))?;
    // Forward slashes: unambiguous in the env-prefix token, valid on Windows.
    Ok(path.to_string_lossy().replace('\\', "/"))
}

/// Pull (download) a model tag, streaming progress as `ollama://pull` events.
/// Resolves when the stream completes; rejects on any error line or transport
/// failure.
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, base_url: String, model: String) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Enter a model tag to pull".into());
    }
    let url = format!("{}/api/pull", base(&base_url));
    let body = serde_json::json!({ "model": model, "stream": true });

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Not detected — ensure Ollama is running".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama pull error {status}: {detail}"));
    }

    // Ollama streams newline-delimited JSON; frames can split across chunks, so
    // accumulate a buffer and emit one progress event per complete line.
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            if line.is_empty() {
                continue;
            }
            let Ok(pl) = serde_json::from_str::<PullLine>(&line) else { continue };
            if let Some(err) = pl.error {
                return Err(err);
            }
            let percent = match (pl.completed, pl.total) {
                (Some(c), Some(t)) if t > 0 => ((c as f64 / t as f64) * 100.0).round() as i64,
                _ => -1,
            };
            let _ = app.emit(
                "ollama://pull",
                PullProgress { model: model.clone(), status: pl.status, percent },
            );
        }
    }
    Ok(())
}
