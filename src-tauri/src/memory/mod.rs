//! Workspace memory — semantic recall over what actually happened.
//!
//! # Division of labour
//!
//! SQLite is owned by the **frontend** (`tauri-plugin-sql`, see `src/util/db.ts`);
//! this module never opens the database. Two writers on one SQLite file buys
//! nothing here and risks lock contention, so the split is:
//!
//! - **TS**: rows in / rows out, FTS queries — the existing, proven path.
//! - **Rust**: embedding, the resident vector index, cosine, fusion, ranking —
//!   the CPU-bound work that has no business on the UI thread.
//!
//! # Why a resident index
//!
//! Search is an exhaustive scan. That sounds alarming and isn't: at 384 dims a
//! vector is 1.5 KB, so ~10 000 memories is ~15 MB and a full scan is single-digit
//! milliseconds — and unlike an approximate index (HNSW/IVF), it cannot miss a
//! relevant result. The genuine cost would be *reading* those vectors from SQLite
//! per query, so we don't: they load once and live in a flat contiguous buffer.
//!
//! The scaling limit is memory, not time — around 200 000 memories the footprint
//! stops being free. Retention (a user setting) bounds it long before that, and
//! doubles as a quality control since stale history misleads.

mod chunk;
mod rank;

use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::embed::{self, DIM};
use rank::Candidate;

/// Candidates pulled from the vector index before ranking trims them. Wide
/// enough that recency and diversity have something to choose between.
const RETRIEVE: usize = 30;

/// One indexed chunk. The vector itself lives in the shared flat buffer at
/// `offset`; keeping it out of here preserves cache locality during the scan.
#[derive(Debug, Clone)]
struct Entry {
    chunk_id: String,
    memory_id: String,
    project: String,
    kind: String,
    created_at: i64,
    offset: usize,
    /// Tombstone. Removal marks rather than compacts, so every other entry's
    /// offset stays valid; [`Index::rebuild`] reclaims the space.
    dead: bool,
}

#[derive(Default)]
struct Index {
    entries: Vec<Entry>,
    /// All vectors end to end: entry *i* occupies `vectors[offset .. offset+DIM]`.
    vectors: Vec<f32>,
    dead: usize,
}

impl Index {
    fn push(&mut self, e: EntryInput, vector: &[f32]) -> Result<(), String> {
        if vector.len() != DIM {
            return Err(format!("expected {DIM}-dim vector, got {}", vector.len()));
        }
        // Re-indexing an existing chunk replaces it rather than duplicating.
        self.remove(&e.chunk_id);
        let offset = self.vectors.len();
        self.vectors.extend_from_slice(vector);
        self.entries.push(Entry {
            chunk_id: e.chunk_id,
            memory_id: e.memory_id,
            project: e.project,
            kind: e.kind,
            created_at: e.created_at,
            offset,
            dead: false,
        });
        Ok(())
    }

    fn remove(&mut self, chunk_id: &str) {
        for e in self.entries.iter_mut() {
            if !e.dead && e.chunk_id == chunk_id {
                e.dead = true;
                self.dead += 1;
            }
        }
    }

    fn remove_memory(&mut self, memory_id: &str) {
        for e in self.entries.iter_mut() {
            if !e.dead && e.memory_id == memory_id {
                e.dead = true;
                self.dead += 1;
            }
        }
    }

    fn vector(&self, e: &Entry) -> &[f32] {
        &self.vectors[e.offset..e.offset + DIM]
    }

    fn live(&self) -> usize {
        self.entries.len() - self.dead
    }

    /// Drop tombstoned entries and compact the buffer. Cheap enough to run when
    /// tombstones pass a threshold; not worth doing on every removal.
    fn rebuild(&mut self) {
        if self.dead == 0 {
            return;
        }
        let mut vectors = Vec::with_capacity(self.live() * DIM);
        let mut entries = Vec::with_capacity(self.live());
        for e in &self.entries {
            if e.dead {
                continue;
            }
            let offset = vectors.len();
            vectors.extend_from_slice(&self.vectors[e.offset..e.offset + DIM]);
            entries.push(Entry { offset, ..e.clone() });
        }
        self.vectors = vectors;
        self.entries = entries;
        self.dead = 0;
    }
}

struct EntryInput {
    chunk_id: String,
    memory_id: String,
    project: String,
    kind: String,
    created_at: i64,
}

#[derive(Default)]
pub struct MemoryIndex(RwLock<Index>);

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// A chunk handed to the index, with its vector.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexItem {
    pub chunk_id: String,
    pub memory_id: String,
    pub project: String,
    pub kind: String,
    pub created_at: i64,
    /// Raw little-endian f32 bytes, as stored in SQLite.
    pub embedding: Vec<u8>,
}

/// A chunk to embed: text plus the metadata that becomes its context header.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedItem {
    pub chunk_id: String,
    pub text: String,
    pub project: String,
    pub branch: Option<String>,
    pub kind: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedOut {
    pub chunk_id: String,
    pub embedding: Vec<u8>,
    pub model: String,
    pub dim: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub chunk_id: String,
    pub memory_id: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub chunks: usize,
    /// Resident bytes of vector data — shown in Settings so the cost is visible.
    pub bytes: usize,
    pub model: String,
    pub dim: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub query: String,
    /// Chunk ids from the frontend's FTS query, best first. Fused with the
    /// vector ranking; exact hits (branch names, PR numbers) come from here.
    #[serde(default)]
    pub keyword_ranked: Vec<String>,
    #[serde(default)]
    pub active_project: Option<String>,
    #[serde(default)]
    pub top_k: Option<usize>,
    /// Wall clock from the frontend, so recency matches the user's clock.
    pub now: i64,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Split a memory's text into embeddable chunk bodies (headers added at embed
/// time). Exposed so the frontend can persist chunks before any model exists.
#[tauri::command]
pub fn memory_chunk(text: String) -> Vec<String> {
    chunk::split(&text)
}

/// Embed chunks, prepending each one's context header.
///
/// Off the UI thread: the first call may download ~90 MB of weights, and even a
/// warm call is real CPU work.
#[tauri::command]
pub async fn memory_embed(items: Vec<EmbedItem>) -> Result<Vec<EmbedOut>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let texts: Vec<String> = items
            .iter()
            .map(|i| {
                let h = chunk::header(&i.project, i.branch.as_deref(), &i.kind, i.created_at);
                format!("{h}\n{}", i.text)
            })
            .collect();
        let vectors = embed::embed(texts)?;
        if vectors.len() != items.len() {
            return Err(format!("embedded {} chunks but got {} vectors", items.len(), vectors.len()));
        }
        Ok(items
            .into_iter()
            .zip(vectors)
            .map(|(i, v)| EmbedOut {
                chunk_id: i.chunk_id,
                embedding: embed::to_blob(&v),
                model: embed::MODEL_NAME.to_string(),
                dim: DIM,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("embedding task failed: {e}"))?
}

/// Load chunks into the resident index. Called in batches at startup and on
/// every new memory. Malformed vectors are skipped, not fatal: one bad row must
/// not take the whole index down.
#[tauri::command]
pub fn memory_index_put(state: State<'_, MemoryIndex>, items: Vec<IndexItem>) -> Result<usize, String> {
    let mut idx = state.0.write().map_err(|_| "memory index poisoned")?;
    let mut ok = 0;
    for item in items {
        let Some(v) = embed::from_blob(&item.embedding) else { continue };
        let input = EntryInput {
            chunk_id: item.chunk_id,
            memory_id: item.memory_id,
            project: item.project,
            kind: item.kind,
            created_at: item.created_at,
        };
        if idx.push(input, &v).is_ok() {
            ok += 1;
        }
    }
    Ok(ok)
}

/// Forget a memory (retention sweep, or the user deleting it).
#[tauri::command]
pub fn memory_index_remove(state: State<'_, MemoryIndex>, memory_ids: Vec<String>) -> Result<(), String> {
    let mut idx = state.0.write().map_err(|_| "memory index poisoned")?;
    for id in &memory_ids {
        idx.remove_memory(id);
    }
    // Compact once tombstones are a meaningful share of the buffer.
    if idx.dead * 4 > idx.entries.len() {
        idx.rebuild();
    }
    Ok(())
}

#[tauri::command]
pub fn memory_index_clear(state: State<'_, MemoryIndex>) -> Result<(), String> {
    let mut idx = state.0.write().map_err(|_| "memory index poisoned")?;
    *idx = Index::default();
    Ok(())
}

#[tauri::command]
pub fn memory_stats(state: State<'_, MemoryIndex>) -> Result<Stats, String> {
    let idx = state.0.read().map_err(|_| "memory index poisoned")?;
    Ok(Stats {
        chunks: idx.live(),
        bytes: idx.live() * DIM * 4,
        model: embed::MODEL_NAME.to_string(),
        dim: DIM,
    })
}

/// Rank memories against a query: embed it, scan the index, fuse with the
/// frontend's keyword ranking, weigh by recency/affinity, then diversify.
#[tauri::command]
pub async fn memory_search(
    state: State<'_, MemoryIndex>,
    args: SearchArgs,
) -> Result<Vec<Hit>, String> {
    let top_k = args.top_k.unwrap_or(6).clamp(1, 20);
    let query = args.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // Embedding is blocking work; do it before touching the index lock so the
    // lock is never held across an await.
    let qvec = tauri::async_runtime::spawn_blocking(move || embed::embed(vec![query]))
        .await
        .map_err(|e| format!("embedding task failed: {e}"))??
        .into_iter()
        .next()
        .ok_or("embedding returned nothing")?;

    let mut cands: Vec<Candidate> = {
        let idx = state.0.read().map_err(|_| "memory index poisoned")?;

        // Exhaustive scan — see the module docs on why this is the right call at
        // our scale (and why it is more accurate than an approximate index).
        let mut scored: Vec<(f32, &Entry)> = idx
            .entries
            .iter()
            .filter(|e| !e.dead)
            .map(|e| (embed::cosine(&qvec, idx.vector(e)), e))
            .collect();
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.chunk_id.cmp(&b.1.chunk_id))
        });
        scored.truncate(RETRIEVE);

        let vector_ranked: Vec<String> = scored.iter().map(|(_, e)| e.chunk_id.clone()).collect();
        let fused = rank::fuse(&vector_ranked, &args.keyword_ranked);

        // Keyword-only hits carry no cosine score; they still rank via fusion.
        let by_id: std::collections::HashMap<&str, (f32, &Entry)> =
            scored.iter().map(|(s, e)| (e.chunk_id.as_str(), (*s, *e))).collect();

        fused
            .into_iter()
            .filter_map(|(id, fscore)| {
                by_id.get(id.as_str()).map(|(vs, e)| Candidate {
                    chunk_id: e.chunk_id.clone(),
                    memory_id: e.memory_id.clone(),
                    project: e.project.clone(),
                    kind: e.kind.clone(),
                    created_at: e.created_at,
                    vec_score: *vs,
                    score: fscore,
                })
            })
            .collect()
    };

    rank::weigh(&mut cands, args.now, args.active_project.as_deref());

    // Diversify on *content* similarity, approximated by how close the two
    // candidates scored against the same query — cheap, and enough to spot the
    // near-duplicate clusters this exists to break up.
    let picked = rank::mmr(&cands, top_k, |a, b| {
        if a.memory_id == b.memory_id {
            return 1.0; // chunks of one memory are maximally redundant
        }
        1.0 - (a.vec_score - b.vec_score).abs().min(1.0)
    });

    Ok(picked
        .into_iter()
        .map(|c| Hit { chunk_id: c.chunk_id, memory_id: c.memory_id, score: c.score })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec_at(seed: f32) -> Vec<f32> {
        (0..DIM).map(|i| ((i as f32 * 0.01) + seed).sin()).collect()
    }

    fn input(id: &str) -> EntryInput {
        EntryInput {
            chunk_id: id.into(),
            memory_id: format!("m-{id}"),
            project: "p".into(),
            kind: "report".into(),
            created_at: 0,
        }
    }

    #[test]
    fn rejects_wrong_dimension_vectors() {
        let mut idx = Index::default();
        assert!(idx.push(input("a"), &[0.0; 8]).is_err());
        assert_eq!(idx.live(), 0);
    }

    #[test]
    fn reindexing_a_chunk_replaces_it() {
        let mut idx = Index::default();
        idx.push(input("a"), &vec_at(0.1)).unwrap();
        idx.push(input("a"), &vec_at(0.2)).unwrap();
        assert_eq!(idx.live(), 1, "re-indexing must not duplicate");
    }

    #[test]
    fn removal_tombstones_then_rebuild_reclaims() {
        let mut idx = Index::default();
        for i in 0..4 {
            idx.push(input(&format!("c{i}")), &vec_at(i as f32)).unwrap();
        }
        idx.remove_memory("m-c1");
        assert_eq!(idx.live(), 3);
        assert_eq!(idx.vectors.len(), 4 * DIM, "tombstone keeps offsets stable");
        idx.rebuild();
        assert_eq!(idx.live(), 3);
        assert_eq!(idx.vectors.len(), 3 * DIM, "rebuild reclaims space");
    }

    #[test]
    fn rebuild_keeps_vectors_matched_to_their_entries() {
        // The failure this guards against is silent and severe: compaction that
        // misaligns offsets would return real hits pointing at the wrong text.
        let mut idx = Index::default();
        for i in 0..5 {
            idx.push(input(&format!("c{i}")), &vec_at(i as f32)).unwrap();
        }
        idx.remove_memory("m-c0");
        idx.remove_memory("m-c3");
        idx.rebuild();
        for e in &idx.entries {
            let n: f32 = e.chunk_id.trim_start_matches('c').parse().unwrap();
            assert_eq!(idx.vector(e), vec_at(n).as_slice(), "{} misaligned", e.chunk_id);
        }
    }
}
