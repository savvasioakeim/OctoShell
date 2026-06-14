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
