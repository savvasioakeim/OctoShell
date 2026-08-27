/**
 * SQLite persistence for workspace memory.
 *
 * The frontend owns the database (same `tauri-plugin-sql` connection as
 * `util/db.ts`); Rust owns embedding, the resident vector index and ranking.
 * Keeping SQL on one side avoids two writers on one SQLite file.
 *
 * Rows here deliberately OUTLIVE a project: `deleteBlocksDb` wipes a session's
 * live conversation when a project closes, and that is exactly the history worth
 * remembering.
 */
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

let dbPromise: Promise<Database> | null = null;
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:octoshell.db");
  return dbPromise;
}

/** What kind of event a memory records. Weighted differently when ranking. */
export type MemoryKind = "report" | "review" | "dispatch" | "qa" | "note";

export interface MemoryInput {
  kind: MemoryKind;
  project: string;
  branch?: string | null;
  cwd?: string | null;
  text: string;
  meta?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  project: string;
  branch: string | null;
  cwd: string | null;
  text: string;
  meta: string | null;
  created_at: number;
}

/** A chunk awaiting (or carrying) its vector. */
interface ChunkRow {
  id: string;
  memory_id: string;
  ord: number;
  text: string;
  embedding: number[] | null;
}

/**
 * Store a memory and its chunks.
 *
 * The embedding is NOT computed here: chunks land with `embedding = NULL` and a
 * background pass fills them in. A slow or failed model must never block the
 * dispatch that produced the memory.
 */
export async function addMemory(m: MemoryInput): Promise<string | null> {
  const text = m.text?.trim();
  if (!text) return null;
  try {
    const d = await db();
    const id = crypto.randomUUID();
    const createdAt = m.createdAt ?? Date.now();
    await d.execute(
      "INSERT INTO memory (id, kind, project, branch, cwd, text, meta, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        m.kind,
        m.project,
        m.branch ?? null,
        m.cwd ?? null,
        text,
        m.meta ? JSON.stringify(m.meta) : null,
        createdAt,
      ],
    );
    // Chunking lives in Rust so it is tested once and shared with the embedder.
    const bodies = await invoke<string[]>("memory_chunk", { text });
    for (let i = 0; i < bodies.length; i++) {
      const chunkId = `${id}:${i}`;
      await d.execute(
        "INSERT INTO memory_chunk (id, memory_id, ord, text) VALUES ($1,$2,$3,$4)",
        [chunkId, id, i, bodies[i]],
      );
      // FTS mirrors the chunk text so exact terms (branch names, PR numbers)
      // stay findable even when the vector index is empty or disabled.
      await d.execute("INSERT INTO memory_fts (text, chunk_id) VALUES ($1,$2)", [bodies[i], chunkId]);
    }
    return id;
  } catch (e) {
    console.warn("addMemory failed", e);
    return null;
  }
}

/** Chunks with no vector yet, oldest first, for the background embed pass. */
export async function pendingChunks(limit = 64): Promise<
  Array<{ chunkId: string; text: string; project: string; branch: string | null; kind: string; createdAt: number }>
> {
  try {
    const rows = await (await db()).select<
      Array<{ id: string; text: string; project: string; branch: string | null; kind: string; created_at: number }>
    >(
      "SELECT c.id, c.text, m.project, m.branch, m.kind, m.created_at " +
        "FROM memory_chunk c JOIN memory m ON m.id = c.memory_id " +
        "WHERE c.embedding IS NULL ORDER BY m.created_at ASC LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({
      chunkId: r.id,
      text: r.text,
      project: r.project,
      branch: r.branch,
      kind: r.kind,
      createdAt: r.created_at,
    }));
  } catch (e) {
    console.warn("pendingChunks failed", e);
    return [];
  }
}

export async function saveEmbedding(
  chunkId: string,
  embedding: number[],
  model: string,
  dim: number,
): Promise<void> {
  try {
    await (await db()).execute(
      "UPDATE memory_chunk SET embedding = $1, model = $2, dim = $3 WHERE id = $4",
      [embedding, model, dim, chunkId],
    );
  } catch (e) {
    console.warn("saveEmbedding failed", e);
  }
}

/** Embedded chunks, paged — fed to the Rust index at startup. */
export async function embeddedChunks(
  offset: number,
  limit: number,
): Promise<
  Array<{
    chunkId: string;
    memoryId: string;
    project: string;
    kind: string;
    createdAt: number;
    embedding: number[];
  }>
> {
  try {
    const rows = await (await db()).select<
      Array<{
        id: string;
        memory_id: string;
        project: string;
        kind: string;
        created_at: number;
        embedding: number[];
      }>
    >(
      "SELECT c.id, c.memory_id, m.project, m.kind, m.created_at, c.embedding " +
        "FROM memory_chunk c JOIN memory m ON m.id = c.memory_id " +
        "WHERE c.embedding IS NOT NULL ORDER BY m.created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return rows.map((r) => ({
      chunkId: r.id,
      memoryId: r.memory_id,
      project: r.project,
      kind: r.kind,
      createdAt: r.created_at,
      embedding: r.embedding,
    }));
  } catch (e) {
    console.warn("embeddedChunks failed", e);
    return [];
  }
}

/**
 * Keyword search — the half of retrieval that vectors are bad at.
 *
 * FTS5 is strict about its query syntax (bare `-`, `"` or `*` raise "fts5:
 * syntax error"), and user questions contain exactly those. So each word becomes
 * a quoted term and everything else is dropped.
 */
export async function keywordSearch(query: string, limit = 30): Promise<string[]> {
  const terms = query
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 1)
    .slice(0, 12)
    .map((w) => `"${w.replace(/"/g, "")}"`);
  if (!terms.length) return [];
  try {
    const rows = await (await db()).select<Array<{ chunk_id: string }>>(
      "SELECT chunk_id FROM memory_fts WHERE memory_fts MATCH $1 ORDER BY rank LIMIT $2",
      [terms.join(" OR "), limit],
    );
    return rows.map((r) => r.chunk_id);
  } catch (e) {
    console.warn("keywordSearch failed", e);
    return [];
  }
}

/** Fetch memories by id, preserving the caller's ranking order. */
export async function memoriesByIds(ids: string[]): Promise<MemoryRow[]> {
  if (!ids.length) return [];
  try {
    const holes = ids.map((_, i) => `$${i + 1}`).join(",");
    const rows = await (await db()).select<MemoryRow[]>(
      `SELECT * FROM memory WHERE id IN (${holes})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is MemoryRow => !!r);
  } catch (e) {
    console.warn("memoriesByIds failed", e);
    return [];
  }
}

/** Chunk bodies of one memory, in order — used to widen a hit into context. */
export async function chunksOf(memoryId: string): Promise<ChunkRow[]> {
  try {
    return await (await db()).select<ChunkRow[]>(
      "SELECT id, memory_id, ord, text, NULL as embedding FROM memory_chunk WHERE memory_id = $1 ORDER BY ord",
      [memoryId],
    );
  } catch (e) {
    console.warn("chunksOf failed", e);
    return [];
  }
}

/**
 * Delete memories older than `months`.
 *
 * This is the setting that bounds resident memory — and it improves answers too:
 * a two-year-old report about since-rewritten code is actively misleading.
 * Returns the deleted ids so the caller can drop them from the Rust index.
 */
export async function pruneOlderThan(months: number): Promise<string[]> {
  if (!Number.isFinite(months) || months <= 0) return [];
  const cutoff = Date.now() - months * 30 * 86_400_000;
  try {
    const d = await db();
    const rows = await d.select<Array<{ id: string }>>(
      "SELECT id FROM memory WHERE created_at < $1",
      [cutoff],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const holes = ids.map((_, i) => `$${i + 1}`).join(",");
    // FTS is a plain table (no external-content triggers), so it needs its own
    // delete or it would keep matching text whose memory is gone.
    await d.execute(
      `DELETE FROM memory_fts WHERE chunk_id IN (SELECT id FROM memory_chunk WHERE memory_id IN (${holes}))`,
      ids,
    );
    await d.execute(`DELETE FROM memory_chunk WHERE memory_id IN (${holes})`, ids);
    await d.execute(`DELETE FROM memory WHERE id IN (${holes})`, ids);
    return ids;
  } catch (e) {
    console.warn("pruneOlderThan failed", e);
    return [];
  }
}

export async function memoryCounts(): Promise<{ memories: number; pending: number }> {
  try {
    const d = await db();
    const [m] = await d.select<Array<{ n: number }>>("SELECT COUNT(*) as n FROM memory");
    const [p] = await d.select<Array<{ n: number }>>(
      "SELECT COUNT(*) as n FROM memory_chunk WHERE embedding IS NULL",
    );
    return { memories: m?.n ?? 0, pending: p?.n ?? 0 };
  } catch {
    return { memories: 0, pending: 0 };
  }
}

/** Wipe everything (Settings → "Forget all"). */
export async function clearMemory(): Promise<void> {
  try {
    const d = await db();
    await d.execute("DELETE FROM memory_fts");
    await d.execute("DELETE FROM memory_chunk");
    await d.execute("DELETE FROM memory");
  } catch (e) {
    console.warn("clearMemory failed", e);
  }
}
