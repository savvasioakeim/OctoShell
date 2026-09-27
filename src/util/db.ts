// Local SQLite store for block history. Blocks are the large, ever-growing data;
// keeping them in localStorage meant synchronous main-thread writes and a hard
// ~5-10MB cap. SQLite is async (off the UI thread) and uncapped. Small prefs
// (agent session / model / provider / approval) stay in localStorage.
//
// One row per session holds the whole settled-blocks array as a JSON string —
// same shape we used in localStorage, so the migration is a straight copy.
import Database from "@tauri-apps/plugin-sql";

let dbPromise: Promise<Database> | null = null;

function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:octoshell.db");
  return dbPromise;
}

/** The JSON blob of blocks for a session, or null if none stored yet. */
export async function loadBlocksDb(sessionId: string): Promise<string | null> {
  try {
    const rows = await (await db()).select<{ data: string }[]>(
      "SELECT data FROM blocks WHERE session_id = $1",
      [sessionId],
    );
    return rows.length ? rows[0].data : null;
  } catch (e) {
    console.warn("loadBlocksDb failed", e);
    return null;
  }
}

/** Upsert a session's blocks JSON. Returns true on success — callers migrating
 *  from localStorage MUST only delete the old copy once this confirms true, so a
 *  broken SQLite never causes history loss. */
export async function saveBlocksDb(sessionId: string, data: string, at: number): Promise<boolean> {
  try {
    await (await db()).execute(
      "INSERT INTO blocks (session_id, data, updated_at) VALUES ($1, $2, $3) " +
        "ON CONFLICT(session_id) DO UPDATE SET data = $2, updated_at = $3",
      [sessionId, data, at],
    );
    return true;
  } catch (e) {
    console.warn("saveBlocksDb failed", e);
    return false;
  }
}

/** Drop a session's stored history (project closed). */
export async function deleteBlocksDb(sessionId: string): Promise<void> {
  try {
    await (await db()).execute("DELETE FROM blocks WHERE session_id = $1", [sessionId]);
  } catch (e) {
    console.warn("deleteBlocksDb failed", e);
  }
}

export interface VacuumResult {
  sessions: number;
  trimmed: number;
  before: number;
  after: number;
}

/** Compact stored history. The unbounded space hog is the agent tool-result
 *  strings (a `git log` or `npm install` can be tens of thousands of lines);
 *  command output is already capped, and assistant text is "the essence" we keep.
 *  So we trim oversized tool results, then run SQLite `VACUUM` to reclaim the
 *  freed pages (SQLite never auto-compacts). Returns byte stats for the UI. */
export async function vacuumDb(resultCap = 6000): Promise<VacuumResult> {
  const d = await db();
  const rows = await d.select<{ session_id: string; data: string }[]>(
    "SELECT session_id, data FROM blocks",
  );
  let before = 0;
  let after = 0;
  let trimmed = 0;
  for (const row of rows) {
    before += row.data.length;
    let blocks: any[];
    try {
      blocks = JSON.parse(row.data);
    } catch {
      after += row.data.length;
      continue;
    }
    for (const b of blocks) {
      if (b && b.kind === "agentTool" && typeof b.result === "string" && b.result.length > resultCap) {
        const dropped = b.result.length - resultCap;
        b.result = b.result.slice(0, resultCap) + `\n…(${dropped} chars compacted)…`;
        trimmed += 1;
      }
    }
    const json = JSON.stringify(blocks);
    after += json.length;
    if (json !== row.data) {
      await d.execute("UPDATE blocks SET data = $1 WHERE session_id = $2", [json, row.session_id]);
    }
  }
  try {
    await d.execute("VACUUM");
  } catch (e) {
    console.warn("VACUUM failed", e);
  }
  return { sessions: rows.length, trimmed, before, after };
}

// ---------------------------------------------------------------------------
// Orchestrator chats.
//
// These lived in localStorage until it quietly filled up: `setItem` throws on
// quota, our helper swallows it, and the app happily carried on with writes that
// never landed — so a restart reopened the last state small enough to fit, and
// every conversation since appeared to vanish. Chat history grows without bound,
// so it belongs here next to the block history.

/** Every stored chat, newest first. Null means the read failed (keep whatever
 *  the caller already had rather than showing an empty list). */
export async function loadChatsDb(): Promise<{ id: string; data: string }[] | null> {
  try {
    return await (await db()).select<{ id: string; data: string }[]>(
      "SELECT id, data FROM chats ORDER BY updated_at DESC",
    );
  } catch (e) {
    console.warn("loadChatsDb failed", e);
    return null;
  }
}

/** Upsert one chat. Returns true on success — a migration must only drop the
 *  localStorage copy once this confirms the row is really stored. */
export async function saveChatDb(session: { id: string; updatedAt?: number }): Promise<boolean> {
  try {
    await (await db()).execute(
      "INSERT INTO chats (id, data, updated_at) VALUES ($1, $2, $3) " +
        "ON CONFLICT(id) DO UPDATE SET data = $2, updated_at = $3",
      [session.id, JSON.stringify(session), session.updatedAt ?? Date.now()],
    );
    return true;
  } catch (e) {
    console.warn("saveChatDb failed", e);
    return false;
  }
}

export async function deleteChatDb(id: string): Promise<void> {
  try {
    await (await db()).execute("DELETE FROM chats WHERE id = $1", [id]);
  } catch (e) {
    console.warn("deleteChatDb failed", e);
  }
}
