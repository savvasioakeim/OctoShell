// Workspace memory, shared app-wide as a module singleton (same pattern as
// serviceStore/AiClient). Owns the background embedding pass, the startup index
// load, retention sweeps, and the recall used to build orchestrator context.
//
// Nothing here is on the critical path: every write is fire-and-forget and every
// read degrades to keyword-only rather than failing, so a broken model or a
// cold index can never block a dispatch.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  addMemory,
  chunksOf,
  clearMemory,
  embeddedChunks,
  keywordSearch,
  memoriesByIds,
  memoryCounts,
  pendingChunks,
  pruneOlderThan,
  saveEmbedding,
  type MemoryInput,
  type MemoryRow,
} from "./memoryDb";

/** How many chunks to embed per background batch. Batching matters — per-call
 *  overhead dominates for single short strings. */
const EMBED_BATCH = 32;
/** Pause between batches so a large backlog never monopolises the CPU. */
const EMBED_IDLE_MS = 1500;
/** Rows per page when loading the index at startup (bounds IPC payload size). */
const LOAD_PAGE = 500;
/** Retention sweeps are cheap but pointless to repeat; once a day is plenty. */
const SWEEP_MS = 24 * 60 * 60 * 1000;

export interface MemoryStats {
  /** Whether the feature is on (Settings). Off = no writes, no RAM, no model. */
  enabled: boolean;
  memories: number;
  /** Chunks still awaiting a vector. */
  pending: number;
  /** Resident vector bytes, so Settings can show what this actually costs. */
  bytes: number;
  indexed: number;
  model: string;
  /** Set when the model failed to load; recall falls back to keyword-only. */
  error: string | null;
}

/** One recalled memory, ready to render into the system prompt. */
export interface Recalled {
  id: string;
  kind: string;
  project: string;
  branch: string | null;
  createdAt: number;
  text: string;
  /** True when this came from keyword search only (no semantic match). */
  keywordOnly: boolean;
}

const EMPTY: MemoryStats = {
  enabled: false,
  memories: 0,
  pending: 0,
  bytes: 0,
  indexed: 0,
  model: "",
  error: null,
};

class MemoryStore {
  private listeners = new Set<() => void>();
  private snap: MemoryStats = EMPTY;
  private enabled = false;
  private retentionMonths = 6;
  private loading = false;
  private embedding = false;
  private timer: number | null = null;
  private lastSweep = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): MemoryStats => this.snap;

  private emit(patch: Partial<MemoryStats> = {}): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Apply settings. Turning it off clears the index immediately — the point of
   *  the toggle is that the RAM goes away, not just the writes. */
  configure(opts: { enabled: boolean; retentionMonths: number }): void {
    const was = this.enabled;
    this.enabled = opts.enabled;
    this.retentionMonths = opts.retentionMonths;
    this.emit({ enabled: opts.enabled });
    if (opts.enabled && !was) void this.start();
    if (!opts.enabled && was) void this.stop();
  }

  private async stop(): Promise<void> {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await invoke("memory_index_clear");
    } catch {
      /* index already gone */
    }
    this.emit({ ...EMPTY, enabled: false });
  }

  /** Load the index, then keep the embed backlog draining. */
  private async start(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.sweep();
      await this.loadIndex();
      await this.refreshCounts();
    } finally {
      this.loading = false;
    }
    void this.drain();
    if (this.timer === null) {
      this.timer = window.setInterval(() => void this.drain(), EMBED_IDLE_MS);
    }
  }

  private async loadIndex(): Promise<void> {
    for (let offset = 0; ; offset += LOAD_PAGE) {
      const rows = await embeddedChunks(offset, LOAD_PAGE);
      if (!rows.length) break;
      try {
        await invoke<number>("memory_index_put", {
          items: rows.map((r) => ({
            chunkId: r.chunkId,
            memoryId: r.memoryId,
            project: r.project,
            kind: r.kind,
            createdAt: r.createdAt,
            embedding: r.embedding,
          })),
        });
      } catch (e) {
        this.emit({ error: `couldn't load the memory index: ${e}` });
        return;
      }
      if (rows.length < LOAD_PAGE) break;
    }
    await this.refreshStats();
  }

  /** Embed one batch of pending chunks. Runs on a timer; self-throttling. */
  private async drain(): Promise<void> {
    if (!this.enabled || this.embedding) return;
    this.embedding = true;
    try {
      const pending = await pendingChunks(EMBED_BATCH);
      if (!pending.length) return;
      const out = await invoke<
        Array<{ chunkId: string; embedding: number[]; model: string; dim: number }>
      >("memory_embed", {
        items: pending.map((p) => ({
          chunkId: p.chunkId,
          text: p.text,
          project: p.project,
          branch: p.branch,
          kind: p.kind,
          createdAt: p.createdAt,
        })),
      });
      const meta = new Map(pending.map((p) => [p.chunkId, p]));
      const items: unknown[] = [];
      for (const o of out) {
        await saveEmbedding(o.chunkId, o.embedding, o.model, o.dim);
        const m = meta.get(o.chunkId);
        if (!m) continue;
        items.push({
          chunkId: o.chunkId,
          memoryId: o.chunkId.split(":")[0],
          project: m.project,
          kind: m.kind,
          createdAt: m.createdAt,
          embedding: o.embedding,
        });
      }
      if (items.length) await invoke("memory_index_put", { items });
      this.emit({ error: null });
      await this.refreshCounts();
      await this.refreshStats();
    } catch (e) {
      // The model is the only thing that can fail here. Surface it once and keep
      // the app working: recall degrades to keyword search rather than dying.
      this.emit({ error: `semantic indexing unavailable: ${e}` });
    } finally {
      this.embedding = false;
    }
  }

  private async sweep(): Promise<void> {
    if (Date.now() - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = Date.now();
    const gone = await pruneOlderThan(this.retentionMonths);
    if (gone.length) {
      try {
        await invoke("memory_index_remove", { memoryIds: gone });
      } catch {
        /* index will be rebuilt next launch */
      }
    }
  }

  private async refreshCounts(): Promise<void> {
    const { memories, pending } = await memoryCounts();
    this.emit({ memories, pending });
  }

  private async refreshStats(): Promise<void> {
    try {
      const s = await invoke<{ chunks: number; bytes: number; model: string; dim: number }>(
        "memory_stats",
      );
      this.emit({ indexed: s.chunks, bytes: s.bytes, model: s.model });
    } catch {
      /* leave the previous numbers */
    }
  }

  /** Record something worth remembering. Fire-and-forget by design. */
  remember(m: MemoryInput): void {
    if (!this.enabled) return;
    void addMemory(m).then((id) => {
      if (id) void this.refreshCounts();
    });
  }

  /**
   * Recall memories relevant to `query`.
   *
   * Hybrid: the frontend runs FTS (exact terms — branch names, PR numbers) and
   * Rust runs the vector scan, then fuses, weighs by recency/affinity and
   * diversifies. If the model is unavailable we still return keyword hits, and
   * the caller marks them so the orchestrator knows recall was degraded.
   */
  async recall(query: string, activeProject?: string, topK = 6): Promise<Recalled[]> {
    if (!this.enabled || !query.trim()) return [];
    const keywordRanked = await keywordSearch(query, 30);
    let memoryIds: string[] = [];
    let degraded = false;
    try {
      const hits = await invoke<Array<{ chunkId: string; memoryId: string; score: number }>>(
        "memory_search",
        { args: { query, keywordRanked, activeProject: activeProject ?? null, topK, now: Date.now() } },
      );
      memoryIds = dedupe(hits.map((h) => h.memoryId));
    } catch {
      // Model unavailable: fall back to the keyword ranking alone.
      degraded = true;
      memoryIds = dedupe(keywordRanked.map((c) => c.split(":")[0])).slice(0, topK);
    }
    if (!memoryIds.length) return [];
    const rows = await memoriesByIds(memoryIds.slice(0, topK));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      project: r.project,
      branch: r.branch,
      createdAt: r.created_at,
      text: r.text,
      keywordOnly: degraded,
    }));
  }

  /** Widen a recalled memory to at most `cap` chars, preferring its opening
   *  chunks — small-to-big retrieval, but bounded so six memories still fit. */
  async widen(memoryId: string, cap: number): Promise<string> {
    const parts = await chunksOf(memoryId);
    let out = "";
    for (const p of parts) {
      if (out.length + p.text.length > cap) break;
      out += (out ? "\n\n" : "") + p.text;
    }
    return out;
  }

  async forgetAll(): Promise<void> {
    await clearMemory();
    try {
      await invoke("memory_index_clear");
    } catch {
      /* nothing indexed */
    }
    this.emit({ memories: 0, pending: 0, indexed: 0, bytes: 0 });
  }
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export const memoryStore = new MemoryStore();

export function useMemoryStats(): MemoryStats {
  return useSyncExternalStore(memoryStore.subscribe, memoryStore.getSnapshot);
}

export type { MemoryRow };
