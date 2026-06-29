import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import {
  RV,
  type ReviewItem,
  type ReviewLoadPayload,
  type ReviewResult,
  type ReviewServerPayload,
  type Verdict,
} from "./reviewTypes";

/**
 * The floating, always-on-top Review Mode window. Walks the reviewer through
 * each feature the orchestrator flagged: shows branch + a one-click managed
 * server to test against, takes notes, and an approve / decline / skip verdict.
 * Everything is relayed to the main window over Tauri events (this webview has no
 * direct access to the main app's state).
 */
export function ReviewWindow() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<Record<string, ReviewResult>>({});
  const [servers, setServers] = useState<Record<string, ReviewServerPayload>>({});
  const [pinned, setPinned] = useState(true);
  const resultsRef = useRef(results);
  resultsRef.current = results;

  // Receive the items (ask for them on mount) + live server status updates.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void listen<ReviewLoadPayload>(RV.load, (e) => {
      setItems(e.payload.items);
      setIdx(0);
    }).then((u) => unsubs.push(u));
    void listen<ReviewServerPayload>(RV.server, (e) => {
      setServers((s) => ({ ...s, [`${e.payload.id}:${e.payload.role}`]: e.payload }));
    }).then((u) => unsubs.push(u));
    void emit(RV.ready);
    return () => unsubs.forEach((u) => u());
  }, []);

  // On close, hand back everything typed so far (even items without a verdict).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await emit(RV.closed, { results: Object.values(resultsRef.current) });
        await getCurrentWindow().destroy();
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const item = items[idx];
  const result = item ? results[item.id] : undefined;
  // Servers are keyed by `${itemId}:${role}` so an item can have both a frontend
  // and a backend running at once.
  const srv = (role: "frontend" | "backend") => (item ? servers[`${item.id}:${role}`] : undefined);
  const feServer = srv("frontend");
  const beServer = srv("backend");

  const setNotes = (notes: string) => {
    if (!item) return;
    setResults((r) => ({ ...r, [item.id]: { id: item.id, verdict: r[item.id]?.verdict ?? null, notes } }));
  };
  const flush = () => {
    if (!item) return;
    const r = resultsRef.current[item.id];
    if (r) void emit(RV.result, r);
  };
  const decide = (verdict: Verdict) => {
    if (!item) return;
    const next: ReviewResult = { id: item.id, verdict, notes: results[item.id]?.notes ?? "" };
    setResults((r) => ({ ...r, [item.id]: next }));
    void emit(RV.result, next);
    // Advance to the next feature; on the last, stay (reviewer can close).
    setIdx((i) => Math.min(i + 1, items.length - 1));
  };

  const togglePin = async () => {
    const v = !pinned;
    setPinned(v);
    await getCurrentWindow().setAlwaysOnTop(v);
  };

  return (
    <div className="flex h-screen flex-col bg-panel text-gray-100">
      {/* Custom chrome: drag region + stick/close. */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-b border-edge px-2 py-1"
      >
        <span data-tauri-drag-region className="select-none text-[11px] font-semibold text-accent">
          🔍 Review
          {items.length > 0 && (
            <span className="ml-1 text-muted">
              {idx + 1}/{items.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={togglePin}
            title={pinned ? "Ξεκαρφίτσωσε (να μην είναι πάντα μπροστά)" : "Καρφίτσωσε πάνω από όλα"}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              pinned ? "bg-accent/25 text-accent" : "text-muted hover:bg-edge"
            }`}
          >
            📌
          </button>
          <button
            onClick={() => void getCurrentWindow().close()}
            title="Κλείσε το review"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-red-500/20 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      </div>

      {!item ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted">
          {items.length === 0 ? "Φόρτωση review…" : "Τέλος review."}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto p-3">
          <div className="text-sm font-semibold text-gray-100">{item.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {item.branch && (
              <span className="rounded bg-edge/60 px-1.5 py-0.5 text-sky-300/90">🌿 {item.branch}</span>
            )}
            <ServerChip
              label="server"
              server={feServer}
              canStart={!!item.startCommand}
              onStart={() => void emit(RV.startServer, { id: item.id, role: "frontend" })}
            />
            {item.backend && (
              <ServerChip
                label={`backend · ${item.backend.project}`}
                server={beServer}
                canStart
                onStart={() => void emit(RV.startServer, { id: item.id, role: "backend" })}
              />
            )}
          </div>

          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-gray-300">
            {item.whatToCheck}
          </p>

          <textarea
            value={result?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={flush}
            placeholder="Σημειώσεις (προαιρετικό· κρατιούνται κι αν κλείσεις)…"
            className="mt-2 min-h-[64px] flex-1 resize-none rounded border border-edge bg-card px-2 py-1.5 text-xs leading-relaxed text-gray-100 outline-none focus:border-accent/60"
          />

          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <VerdictBtn active={result?.verdict === "approve"} tone="approve" onClick={() => decide("approve")}>
              ✓ Approve
            </VerdictBtn>
            <VerdictBtn active={result?.verdict === "decline"} tone="decline" onClick={() => decide("decline")}>
              ✗ Decline
            </VerdictBtn>
          </div>

          <div className="mt-2 flex justify-between text-[11px] text-muted">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="rounded px-1.5 py-0.5 enabled:hover:bg-edge disabled:opacity-40"
            >
              ← προηγ.
            </button>
            <button
              onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
              disabled={idx >= items.length - 1}
              className="rounded px-1.5 py-0.5 enabled:hover:bg-edge disabled:opacity-40"
            >
              επόμ. →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A start/running chip for one managed server (frontend or backend): shows a
 *  Start button until it's up, then the clickable URL to copy. */
function ServerChip({
  label,
  server,
  canStart,
  onStart,
}: {
  label: string;
  server?: ReviewServerPayload;
  canStart: boolean;
  onStart: () => void;
}) {
  if (server?.url) {
    return (
      <button
        onClick={() => void navigator.clipboard?.writeText(server.url!)}
        title={`${label} — αντίγραψε URL`}
        className="rounded bg-edge/60 px-1.5 py-0.5 text-emerald-300/90"
      >
        {server.url.replace(/^https?:\/\//, "")} ⧉
      </button>
    );
  }
  if (!canStart) return null;
  return (
    <button
      onClick={onStart}
      disabled={server?.status === "starting"}
      className="rounded bg-sky-500/25 px-1.5 py-0.5 text-sky-100 hover:bg-sky-500/35 disabled:opacity-60"
    >
      {server?.status === "starting"
        ? `εκκίνηση ${label}…`
        : server?.status === "error"
          ? `⚠ ${label} — ξανά`
          : `▶ ${label}`}
    </button>
  );
}

function VerdictBtn({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: Verdict;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones: Record<Verdict, string> = {
    approve: active ? "bg-emerald-500/30 text-emerald-200 border-emerald-500/50" : "text-emerald-300/80",
    decline: active ? "bg-red-500/30 text-red-200 border-red-500/50" : "text-red-300/80",
  };
  return (
    <button
      onClick={onClick}
      className={`rounded border border-edge px-2 py-1 text-xs font-medium hover:bg-edge/60 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
