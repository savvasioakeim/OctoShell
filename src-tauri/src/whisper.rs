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

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

pub use candle_transformers::models::whisper::SAMPLE_RATE;

use candle_core::{Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as w, audio, model::Whisper, Config};

/// The mel filter bank, vendored from candle's whisper example (80 bins x 201
/// frequencies of f32). It is a fixed table, not a model weight, so baking the
/// 64KB into the binary keeps it out of the download and out of the user's way.
const MEL_FILTERS: &[u8] = include_bytes!("../assets/melfilters.bytes");

fn mel_filters() -> Vec<f32> {
    MEL_FILTERS
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

/// A model held in memory between dictations.
///
/// Loading `small` off disk and into tensors takes seconds, which would be paid
/// on every single phrase. The cache holds one model: switching size evicts the
/// previous one rather than keeping both, because the whole point of the size
/// choice is that someone's machine cannot afford both.
struct Loaded {
    id: String,
    model: Whisper,
    tokenizer: tokenizers::Tokenizer,
}

fn cache() -> &'static Mutex<Option<Loaded>> {
    static CACHE: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn load(dir: &Path, id: &str) -> Result<(), String> {
    let mut slot = cache().lock().map_err(|_| "model lock poisoned")?;
    if slot.as_ref().is_some_and(|l| l.id == id) {
        return Ok(());
    }
    if !installed(dir) {
        return Err(format!("{} is not downloaded yet", spec(id).map(|s| s.label).unwrap_or(id)));
    }

    // Drop the previous model before building the next, so two sets of weights
    // are never resident at once on a machine that chose a size to avoid that.
    *slot = None;

    let cfg: Config = serde_json::from_str(
        &std::fs::read_to_string(dir.join("config.json"))
            .map_err(|e| format!("could not read config.json: {e}"))?,
    )
    .map_err(|e| format!("config.json is not a Whisper config: {e}"))?;
    let tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| format!("could not read tokenizer.json: {e}"))?;
    let vb = unsafe {
        VarBuilder::from_mmaped_safetensors(&[dir.join("model.safetensors")], w::DTYPE, &Device::Cpu)
            .map_err(|e| format!("could not read the weights: {e}"))?
    };
    let model = Whisper::load(&vb, cfg).map_err(|e| format!("could not build the model: {e}"))?;
    *slot = Some(Loaded { id: id.to_string(), model, tokenizer });
    Ok(())
}

fn token_id(tk: &tokenizers::Tokenizer, s: &str) -> Result<u32, String> {
    tk.token_to_id(s).ok_or_else(|| format!("the tokenizer has no {s} token"))
}

/// Greedy decode of one 30-second window.
///
/// Greedy rather than candle's full temperature-fallback loop: dictation is a
/// person speaking deliberately into a microphone, not noisy found audio, and
/// the fallback costs up to six decodes per window for cases that barely arise
/// here. If transcripts come back degenerate on real use, that is the knob.
fn decode_window(
    model: &mut Whisper,
    tk: &tokenizers::Tokenizer,
    features: &Tensor,
    sot: u32,
    lang: u32,
    suppress: &[u32],
) -> Result<Vec<u32>, String> {
    let transcribe = token_id(tk, w::TRANSCRIBE_TOKEN)?;
    let no_ts = token_id(tk, w::NO_TIMESTAMPS_TOKEN)?;
    let eot = token_id(tk, w::EOT_TOKEN)?;
    let mut tokens = vec![sot, lang, transcribe, no_ts];
    let limit = model.config.max_target_positions / 2;

    for i in 0..limit {
        let input = Tensor::new(tokens.as_slice(), &Device::Cpu)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| e.to_string())?;
        // The kv-cache is flushed only on the first pass; afterwards the decoder
        // reuses it, which is what keeps the loop from being quadratic.
        let out = model
            .decoder
            .forward(&input, features, i == 0)
            .map_err(|e| format!("decoding failed: {e}"))?;
        let (_, seq, _) = out.dims3().map_err(|e| e.to_string())?;
        let last = out.i((0, seq - 1)).map_err(|e| e.to_string())?;
        let mut logits = model
            .decoder
            .final_linear(&last.unsqueeze(0).map_err(|e| e.to_string())?)
            .and_then(|t| t.squeeze(0))
            .and_then(|t| t.squeeze(0))
            .map_err(|e| e.to_string())?
            .to_vec1::<f32>()
            .map_err(|e| e.to_string())?;
        for &s in suppress {
            if let Some(v) = logits.get_mut(s as usize) {
                *v = f32::NEG_INFINITY;
            }
        }
        let next = argmax(&logits);
        if next == eot {
            break;
        }
        tokens.push(next);
    }
    // Drop the prompt: only what the model produced is transcript.
    Ok(tokens.split_off(4))
}

fn argmax(v: &[f32]) -> u32 {
    v.iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(i, _)| i as u32)
        .unwrap_or(0)
}

/// Pick the spoken language from the first window.
///
/// Whisper's language tokens sit in one contiguous run straight after
/// `<|startoftranscript|>`, so masking the logits to that range and taking the
/// best one identifies the language without this code having to carry a list of
/// 99 language codes that could drift out of step with the vocabulary.
fn detect_language(
    model: &mut Whisper,
    features: &Tensor,
    sot: u32,
    translate: u32,
) -> Result<u32, String> {
    let input = Tensor::new(&[sot], &Device::Cpu)
        .and_then(|t| t.unsqueeze(0))
        .map_err(|e| e.to_string())?;
    let out = model
        .decoder
        .forward(&input, features, true)
        .map_err(|e| format!("language detection failed: {e}"))?;
    let logits = model
        .decoder
        .final_linear(&out.i((0, 0)).and_then(|t| t.unsqueeze(0)).map_err(|e| e.to_string())?)
        .and_then(|t| t.squeeze(0))
        .and_then(|t| t.squeeze(0))
        .map_err(|e| e.to_string())?
        .to_vec1::<f32>()
        .map_err(|e| e.to_string())?;

    // The run is sot+1 .. translate: `<|startoftranscript|>`, then the 99
    // language tokens, then the task tokens. Note eot CANNOT bound this — it
    // sits below sot in the vocabulary, not above it.
    let first = sot as usize + 1;
    let last = (translate as usize).min(logits.len());
    if first >= last {
        return Err("the vocabulary has no language tokens".into());
    }
    let best = argmax(&logits[first..last]) as usize + first;
    Ok(best as u32)
}

/// What one dictation produced, with the numbers needed to judge whether this
/// model size is usable on this machine.
#[derive(Serialize)]
pub struct Transcript {
    pub text: String,
    /// The language token Whisper chose, e.g. `<|el|>`, as text.
    pub language: String,
    /// Seconds of audio captured.
    pub audio_seconds: f64,
    /// Wall-clock milliseconds spent recognising it.
    pub took_ms: u64,
    /// The recording hit [`crate::mic::MAX_SECONDS`] and was cut short.
    pub truncated: bool,
}

/// Run the model over captured audio. Blocking and CPU-bound.
fn transcribe(dir: &Path, id: &str, pcm: Vec<f32>, truncated: bool) -> Result<Transcript, String> {
    let started = std::time::Instant::now();
    let audio_seconds = pcm.len() as f64 / SAMPLE_RATE as f64;
    load(dir, id)?;

    let mut slot = cache().lock().map_err(|_| "model lock poisoned")?;
    let loaded = slot.as_mut().ok_or("the model was unloaded mid-transcription")?;
    let Loaded { model, tokenizer, .. } = loaded;

    let sot = token_id(tokenizer, w::SOT_TOKEN)?;
    let translate = token_id(tokenizer, w::TRANSLATE_TOKEN)?;
    let suppress = model.config.suppress_tokens.clone();
    let n_mels = model.config.num_mel_bins;

    let mel = audio::pcm_to_mel(&model.config, &pcm, &mel_filters());
    let frames = mel.len() / n_mels;
    let mel = Tensor::from_vec(mel, (1, n_mels, frames), &Device::Cpu)
        .map_err(|e| format!("could not build the spectrogram: {e}"))?;

    let mut language: Option<u32> = None;
    let mut out = String::new();
    // Whisper only ever sees 30 seconds at a time, so longer dictation is walked
    // window by window. A final short window is zero-padded, which is what the
    // model was trained on, rather than skipped.
    let mut start = 0usize;
    while start < frames {
        let end = (start + w::N_FRAMES).min(frames);
        let mut window = mel
            .narrow(2, start, end - start)
            .map_err(|e| format!("could not slice the spectrogram: {e}"))?;
        if end - start < w::N_FRAMES {
            let pad = Tensor::zeros((1, n_mels, w::N_FRAMES - (end - start)), w::DTYPE, &Device::Cpu)
                .map_err(|e| e.to_string())?;
            window = Tensor::cat(&[&window, &pad], 2).map_err(|e| e.to_string())?;
        }

        model.reset_kv_cache();
        let features = model
            .encoder
            .forward(&window, true)
            .map_err(|e| format!("the encoder failed: {e}"))?;

        // Detect once, on the first window, then hold it: re-detecting per
        // window lets a quiet stretch flip mid-sentence into another language.
        let lang = match language {
            Some(l) => l,
            None => {
                let l = detect_language(model, &features, sot, translate)?;
                language = Some(l);
                l
            }
        };

        let tokens = decode_window(model, tokenizer, &features, sot, lang, &suppress)?;
        let piece = tokenizer
            .decode(&tokens, true)
            .map_err(|e| format!("could not read the transcript back: {e}"))?;
        if !piece.trim().is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(piece.trim());
        }
        start = end;
    }

    let language = language
        .and_then(|l| tokenizer.id_to_token(l))
        .unwrap_or_else(|| "unknown".to_string());
    Ok(Transcript {
        text: out,
        language,
        audio_seconds,
        took_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

/// Begin capturing. Fails fast when the chosen model is missing, so nobody
/// speaks a whole note only to be told afterwards that nothing could read it.
#[tauri::command]
pub fn whisper_record_start(app: AppHandle, id: String) -> Result<(), String> {
    let spec = spec(&id)?;
    if !installed(&model_dir(&app, &id)?) {
        return Err(format!("Download {} first", spec.label));
    }
    crate::mic::start()
}

/// Stop capturing and transcribe what was said.
#[tauri::command]
pub async fn whisper_record_stop(app: AppHandle, id: String) -> Result<Transcript, String> {
    let (pcm, truncated) = crate::mic::stop()?;
    if pcm.len() < SAMPLE_RATE / 10 {
        return Err("that was too short to transcribe".into());
    }
    // Recognition saturates a core for seconds; on the async runtime it would
    // stall every other command, including the UI's own.
    let dir = model_dir(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || transcribe(&dir, &id, pcm, truncated))
        .await
        .map_err(|e| format!("transcription task failed: {e}"))?
}

/// Throw away a recording without transcribing it.
#[tauri::command]
pub fn whisper_record_cancel() -> Result<(), String> {
    let _ = crate::mic::stop();
    Ok(())
}

/// Whether a capture is in progress, so the UI can recover its own state after
/// a reload rather than showing a stopped button over a live microphone.
#[tauri::command]
pub fn whisper_recording() -> bool {
    crate::mic::is_recording()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end through the real model: mel → encoder → language detection →
    /// greedy decode. Ignored because it needs a downloaded model, and pointed
    /// at one with `OCTOSHELL_WHISPER_DIR`.
    ///
    /// The decode loop is the part of this file that cannot be checked by
    /// reading it: every step is a tensor reshape that compiles whatever the
    /// dimensions are, and a wrong one surfaces as a runtime shape error or, far
    /// worse, as fluent nonsense. So this drives a real tensor all the way
    /// through and prints the timing, which is also the only honest way to say
    /// how slow a given model size is on a given machine.
    ///
    ///   cargo test --manifest-path src-tauri/Cargo.toml whisper -- --ignored --nocapture
    #[test]
    #[ignore = "needs a downloaded model (set OCTOSHELL_WHISPER_DIR)"]
    fn runs_the_whole_pipeline() {
        let dir = std::env::var("OCTOSHELL_WHISPER_DIR")
            .expect("set OCTOSHELL_WHISPER_DIR to a folder holding the three model files");
        let dir = std::path::PathBuf::from(dir);
        let id = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(installed(&dir), "{} has no model files", dir.display());

        // Five seconds of a 220Hz tone under an envelope. It is not speech, so
        // the text is not the point: what is being proved is that the shapes
        // line up and a transcript comes back at all.
        let n = SAMPLE_RATE * 5;
        let pcm: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                (t * 220.0 * std::f32::consts::TAU).sin() * 0.3 * (1.0 - t / 5.0)
            })
            .collect();

        let out = transcribe(&dir, &id, pcm, false).expect("transcription failed");
        println!(
            "model={id} audio={:.1}s took={}ms ratio={:.2}x language={}",
            out.audio_seconds,
            out.took_ms,
            out.took_ms as f64 / 1000.0 / out.audio_seconds,
            out.language
        );
        println!("text: {:?}", out.text);
        assert!(out.language.starts_with("<|"), "language token looks wrong: {}", out.language);
        assert!(out.took_ms > 0);
    }
}
