//! Whisper model management for local dictation (Settings › Speech-to-text).
//!
//! Dictation used to run through the webview's own Web Speech API, which
//! recognises nothing locally: it ships audio to the browser vendor's service.
//! That service started rejecting WebView2 in Runtime 153, so on Windows the
//! feature is simply gone, and nothing on our side brings it back. Whisper runs
//! on the user's machine instead, which also means audio never leaves it.
//!
//! No model ships in the installer. A model is downloaded only when the user
//! asks for one, which is the whole point: a 1GB download is a real cost and it
//! should be a choice, not something an installer decides for people.
//!
//!   - [`whisper_models`]   — the catalogue, each entry marked installed or not.
//!   - [`whisper_download`] — fetch one, streaming `whisper://download` events.
//!   - [`whisper_delete`]   — remove one and reclaim the disk.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The three files candle needs to run a Whisper model. The weights are the
/// bulk; the other two are a few hundred KB and a couple of MB.
const FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

/// One downloadable model.
pub struct Spec {
    /// Stable id, used in settings and as the folder name.
    pub id: &'static str,
    /// Hugging Face repo holding the safetensors.
    pub repo: &'static str,
    pub label: &'static str,
    /// Roughly what the download costs, for the picker. The exact figure comes
    /// from the server at download time; this is only to set expectations.
    pub approx_mb: u32,
    /// Shown next to the size so the trade-off is visible before committing to
    /// a download rather than after.
    pub note: &'static str,
}

/// Every size OpenAI publishes as safetensors, smallest first.
///
/// These are fp32 weights, which is why they are several times larger than the
/// quantised GGUF files people may have seen elsewhere. Quantised builds exist
/// but only `tiny` is published in a form candle reads today, and `tiny` is
/// exactly the size where multilingual accuracy collapses — so the compression
/// is available precisely where it is useless.
pub const CATALOGUE: [Spec; 4] = [
    Spec {
        id: "tiny",
        repo: "openai/whisper-tiny",
        label: "Tiny",
        approx_mb: 153,
        note: "Fastest. Accuracy drops sharply outside English.",
    },
    Spec {
        id: "base",
        repo: "openai/whisper-base",
        label: "Base",
        approx_mb: 292,
        note: "A step up from Tiny, still weak on long sentences.",
    },
    Spec {
        id: "small",
        repo: "openai/whisper-small",
        label: "Small",
        approx_mb: 969,
        note: "Recommended. The smallest size that handles other languages well.",
    },
    Spec {
        id: "medium",
        repo: "openai/whisper-medium",
        label: "Medium",
        approx_mb: 3058,
        note: "Most accurate, and slow without a strong machine.",
    },
];

fn spec(id: &str) -> Result<&'static Spec, String> {
    CATALOGUE
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("unknown model \"{id}\""))
}

/// `<app config dir>/whisper`, created on demand.
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    let dir = base.join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Where one model's files live.
fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join(id))
}

/// A model counts as installed only when all three files are present. A partial
/// download leaves `.part` files, which this deliberately ignores, so an
/// interrupted download reads as "not installed" rather than as a broken model
/// that fails later at load time.
fn installed(dir: &Path) -> bool {
    FILES.iter().all(|f| dir.join(f).is_file())
}

fn bytes_on_disk(dir: &Path) -> u64 {
    FILES
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f)).ok())
        .map(|m| m.len())
        .sum()
}

/// Ids currently downloading. A second request for the same model would write
/// the same `.part` files from two streams and interleave the bytes, so it is
/// refused rather than allowed to corrupt the first one.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases its id from {@link in_flight} however the download ends, including
/// an early `?` return.
struct Claim(String);
impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut set) = in_flight().lock() {
            set.remove(&self.0);
        }
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub note: String,
    pub approx_mb: u32,
    pub installed: bool,
    /// Actual bytes used, once installed.
    pub bytes: u64,
    pub downloading: bool,
}

/// The catalogue, with what is on this machine already.
#[tauri::command]
pub fn whisper_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let busy = in_flight().lock().map(|s| s.clone()).unwrap_or_default();
    CATALOGUE
        .iter()
        .map(|s| {
            let dir = model_dir(&app, s.id)?;
            let is = installed(&dir);
            Ok(ModelInfo {
                id: s.id.to_string(),
                label: s.label.to_string(),
                note: s.note.to_string(),
                approx_mb: s.approx_mb,
                installed: is,
                bytes: if is { bytes_on_disk(&dir) } else { 0 },
                downloading: busy.contains(s.id),
            })
        })
        .collect()
}

#[derive(Clone, Serialize)]
struct Progress {
    model: String,
    /// Which of the three files is in flight, for the detail line.
    file: String,
    received: u64,
    total: u64,
    /// Across the whole model, not the current file. -1 when the server did not
    /// say how big the download is.
    percent: i64,
}

/// Ask the server how big each file is, so progress is measured against the real
/// total instead of the catalogue's rounded figure. Without this the bar can sit
/// at 100% with bytes still arriving, or finish at 94%.
async fn total_bytes(client: &reqwest::Client, repo: &str) -> Option<u64> {
    let mut total = 0u64;
    for f in FILES {
        let resp = client.head(url(repo, f)).send().await.ok()?;
        total += resp.content_length()?;
    }
    Some(total)
}

fn url(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{file}")
}

/// Download one model, streaming `whisper://download` progress.
///
/// Each file lands as `<name>.part` and is renamed only once its stream ends, so
/// an interrupted download can never leave something that looks complete. A
/// failure part way through leaves the earlier files in place; the next attempt
/// overwrites them, which costs bandwidth but keeps the logic honest about what
/// is on disk.
#[tauri::command]
pub async fn whisper_download(app: AppHandle, id: String) -> Result<(), String> {
    let spec = spec(&id)?;
    let dir = model_dir(&app, &id)?;

    {
        let mut set = in_flight().lock().map_err(|_| "download lock poisoned")?;
        if !set.insert(id.clone()) {
            return Err(format!("{} is already downloading", spec.label));
        }
    }
    let _claim = Claim(id.clone());

    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let client = reqwest::Client::new();
    let total = total_bytes(&client, spec.repo).await.unwrap_or(0);
    let mut done: u64 = 0;

    for file in FILES {
        let resp = client
            .get(url(spec.repo, file))
            .send()
            .await
            .map_err(|e| format!("could not reach huggingface.co: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("{} returned {} for {file}", spec.label, resp.status()));
        }

        let part = dir.join(format!("{file}.part"));
        let mut out = std::fs::File::create(&part)
            .map_err(|e| format!("could not write {}: {e}", part.display()))?;
        let mut stream = resp.bytes_stream();
        // Emitting on every chunk would be thousands of events for a 1GB file,
        // so progress goes out at most about once a megabyte.
        let mut since_emit: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("download interrupted: {e}"))?;
            std::io::Write::write_all(&mut out, &bytes)
                .map_err(|e| format!("could not write {}: {e}", part.display()))?;
            done += bytes.len() as u64;
            since_emit += bytes.len() as u64;
            if since_emit >= 1_000_000 {
                since_emit = 0;
                emit(&app, &id, file, done, total);
            }
        }
        drop(out);
        std::fs::rename(&part, dir.join(file))
            .map_err(|e| format!("could not finish {}: {e}", part.display()))?;
        emit(&app, &id, file, done, total);
    }
    Ok(())
}

fn emit(app: &AppHandle, model: &str, file: &str, received: u64, total: u64) {
    let percent = if total > 0 {
        ((received as f64 / total as f64) * 100.0).round() as i64
    } else {
        -1
    };
    let _ = app.emit(
        "whisper://download",
        Progress { model: model.to_string(), file: file.to_string(), received, total, percent },
    );
}

/// Remove a downloaded model. Refused while it is downloading, since deleting
/// the directory under the writer would leave the stream writing into nothing.
#[tauri::command]
pub fn whisper_delete(app: AppHandle, id: String) -> Result<(), String> {
    let spec = spec(&id)?;
    if in_flight().lock().map(|s| s.contains(&id)).unwrap_or(false) {
        return Err(format!("{} is still downloading", spec.label));
    }
    let dir = model_dir(&app, &id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not delete {}: {e}", dir.display()))?;
    }
    Ok(())
}
