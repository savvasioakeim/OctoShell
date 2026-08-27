// Move a workspace between the dev build and the installed app.
//
// The two are ONE app in every way that matters — same identifier, so the SQLite
// file (`%APPDATA%\com.octoshell.app\octoshell.db`) holding all block history and
// workspace memory is literally the same file. What does NOT carry over is
// localStorage: WebView2 scopes it per ORIGIN, and dev serves from
// http://localhost:1420 while the bundled app serves from http://tauri.localhost.
//
// That split is worse than it sounds. localStorage holds the project list and the
// per-project session ids, and those session ids are the ONLY link between a
// project and its rows in the blocks table. Without them the history is still in
// the database but orphaned — every chat present and unreachable.
//
// So the transport is the database itself: the one store both origins already
// share. No files, no dialogs, no OS paths to get wrong.

import Database from "@tauri-apps/plugin-sql";

/** Only our own keys move. Anything else in localStorage belongs to a library and
 *  should stay with the origin that created it. */
const PREFIX = "octoshell.";

export interface Snapshot {
  at: number;
  origin: string;
  keys: number;
  data: Record<string, string>;
}

let dbPromise: Promise<Database> | null = null;
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:octoshell.db");
  return dbPromise;
}

/** Created on demand rather than via a Rust migration, so this works on an app
 *  build that predates the feature — which is exactly the case it exists for. */
async function ensureTable(d: Database): Promise<void> {
  await d.execute(
    "CREATE TABLE IF NOT EXISTS workspace_snapshot (" +
      "id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at INTEGER NOT NULL)",
  );
}

/** Snapshot this origin's localStorage into the shared database. */
export async function exportWorkspace(): Promise<Snapshot> {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  }
  const snap: Snapshot = {
    at: Date.now(),
    origin: location.origin,
    keys: Object.keys(data).length,
    data,
  };
  const d = await db();
  await ensureTable(d);
  await d.execute(
    "INSERT INTO workspace_snapshot (id, json, at) VALUES (1, $1, $2) " +
      "ON CONFLICT(id) DO UPDATE SET json = $1, at = $2",
    [JSON.stringify(snap), snap.at],
  );
  return snap;
}

/** The stored snapshot, or null if none was ever exported. */
export async function peekWorkspace(): Promise<Snapshot | null> {
  try {
    const d = await db();
    await ensureTable(d);
    const rows = await d.select<{ json: string }[]>("SELECT json FROM workspace_snapshot WHERE id = 1");
    return rows.length ? (JSON.parse(rows[0].json) as Snapshot) : null;
  } catch (e) {
    console.warn("peekWorkspace failed", e);
    return null;
  }
}

/** Write the stored snapshot into THIS origin's localStorage.
 *
 *  Destructive by design: a half-merged workspace (new project list, old session
 *  ids) points projects at the wrong history, which is worse than either state on
 *  its own. So our keys are cleared first and the snapshot applied whole. The
 *  caller must reload afterwards — every store read localStorage at module load. */
export async function importWorkspace(): Promise<number> {
  const snap = await peekWorkspace();
  if (!snap) throw new Error("no workspace snapshot found — export from the other build first");
  const mine: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) mine.push(k);
  }
  for (const k of mine) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(snap.data)) localStorage.setItem(k, v);
  return Object.keys(snap.data).length;
}
