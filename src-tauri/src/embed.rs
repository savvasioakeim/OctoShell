//! In-process text embeddings (ONNX via `fastembed`).
//!
//! Semantic recall needs a neural model to turn text into vectors. Hosting that
//! model *inside* OctoShell — rather than calling a local Ollama or a cloud API —
//! is a deliberate trade: it costs binary size, and buys us no external service
//! to install, start, or fail. There is no "why doesn't it remember anything?"
//! caused by a closed tray icon, and no report text ever leaves the machine.
//!
//! The model is downloaded once (to the OS cache dir) on first use and loaded
//! lazily, so a user who never enables memory pays nothing at startup.

use std::sync::{Arc, Mutex, OnceLock};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

/// Dimensions produced by [`MODEL`]. Stored alongside every vector: mixing
/// dimensions (or models) silently would make old vectors incomparable rather
/// than merely stale, so callers must re-embed when this changes.
pub const DIM: usize = 384;

/// `all-MiniLM-L6-v2`: 384 dims, ~90 MB, strong quality-per-byte and the usual
/// default for local semantic search. Bigger models buy little here — our texts
/// are short agent reports, not prose documents.
const MODEL: EmbeddingModel = EmbeddingModel::AllMiniLML6V2;

/// Name recorded with each vector so a model swap is detectable.
pub const MODEL_NAME: &str = "all-MiniLM-L6-v2";

/// The loaded model. `TextEmbedding` is not `Sync`, so it sits behind a mutex;
/// embedding is CPU-bound and batched, so serialising calls costs us nothing.
static MODEL_CELL: OnceLock<Result<Arc<Mutex<TextEmbedding>>, String>> = OnceLock::new();

/// Load (first call: download) the embedding model. Subsequent calls are cheap.
/// The error is cached too — a failed download shouldn't be retried on every
/// keystroke; the user re-triggers it by toggling memory off and on.
fn model() -> Result<Arc<Mutex<TextEmbedding>>, String> {
    MODEL_CELL
        .get_or_init(|| {
            let opts = InitOptions::new(MODEL)
                .with_show_download_progress(false)
                .with_cache_dir(cache_dir());
            TextEmbedding::try_new(opts)
                .map(|m| Arc::new(Mutex::new(m)))
                .map_err(|e| format!("couldn't load the embedding model: {e}"))
        })
        .clone()
}

/// Where the ~90 MB of model weights live. fastembed defaults to a cwd-relative
/// `.fastembed_cache`, which for us would mean writing them into the repo (or
/// into whatever directory the app happened to launch from) and re-downloading
/// per working directory. Pin it to the user's local app data instead.
fn cache_dir() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs_home().map(|h| h.join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("OctoShell").join("models")
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Embed a batch of texts. Batching matters: the per-call overhead dominates for
/// single short strings, so callers should pass whole chunk sets at once.
pub fn embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let m = model()?;
    let mut m = m.lock().map_err(|_| "embedding model poisoned".to_string())?;
    m.embed(texts, None).map_err(|e| format!("embedding failed: {e}"))
}

/// Cosine similarity of two vectors of equal length.
///
/// fastembed returns L2-normalised vectors, so this is really a dot product —
/// but we normalise defensively rather than depend on that invariant holding
/// across model or library versions.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= f32::EPSILON || nb <= f32::EPSILON {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Vectors are stored as raw little-endian f32 BLOBs in SQLite — compact and
/// endian-explicit, so a database file stays portable.
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Inverse of [`to_blob`]. Returns `None` on a truncated or mis-sized blob
/// rather than a garbage vector that would silently poison search results.
pub fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 || b.len() / 4 != DIM {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole feature rests on this: text with the SAME MEANING but DIFFERENT
    /// WORDS must land closer together than unrelated text. If this fails,
    /// semantic recall is worthless no matter how the rest is built.
    #[test]
    #[ignore = "downloads ~90 MB on first run"]
    fn semantically_similar_text_scores_higher() {
        let v = embed(vec![
            "Fixed the redirect loop after token refresh — middleware re-issued the cookie".into(),
            "users could not log in, they kept bouncing back to the sign-in page".into(),
            "Bumped the Tailwind config and regenerated the colour palette".into(),
        ])
        .expect("embedding should succeed");

        assert_eq!(v.len(), 3);
        assert_eq!(v[0].len(), DIM, "DIM must match the model's real output");

        let related = cosine(&v[0], &v[1]);
        let unrelated = cosine(&v[0], &v[2]);
        eprintln!("paraphrase={related:.3}  unrelated={unrelated:.3}");
        assert!(
            related > unrelated,
            "paraphrase ({related}) must outrank unrelated text ({unrelated})"
        );
    }

    #[test]
    fn blob_roundtrip_preserves_values() {
        let v: Vec<f32> = (0..DIM).map(|i| i as f32 * 0.01).collect();
        assert_eq!(from_blob(&to_blob(&v)).unwrap(), v);
    }

    #[test]
    fn malformed_blobs_are_rejected() {
        assert!(from_blob(&[]).is_none());
        assert!(from_blob(&[1, 2, 3]).is_none(), "not a multiple of 4");
        assert!(from_blob(&[0; 4]).is_none(), "right shape, wrong dimension");
    }
}
