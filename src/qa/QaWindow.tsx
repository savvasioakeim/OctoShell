import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import {
  QA,
  type QaItem,
  type QaLoadPayload,
  type QaResult,
  type QaServerPayload,
  type Verdict,
} from "./qaTypes";

/**
 * The floating, always-on-top QA Mode window. Walks the reviewer through each
 * feature the orchestrator flagged: shows branch + a one-click managed server to
 * test against, takes notes, and an approve / decline / skip verdict. Everything
 * is relayed to the main window over Tauri events (this webview has no direct
 * access to the main app's state).
 */
export function QaWindow() {
  const [items, setItems] = useState<QaItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<Record<string, QaResult>>({});
  const [servers, setServers] = useState<Record<string, QaServerPayload>>({});
  const [pinned, setPinned] = useState(true);
  const resultsRef = useRef(results);
  resultsRef.current = results;

  // Receive the items (ask for them on mount) + live server status updates.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void listen<QaLoadPayload>(QA.load, (e) => {
      setItems(e.payload.items);
      setIdx(0);
    }).then((u) => unsubs.push(u));
    void listen<QaServerPayload>(QA.server, (e) => {
      setServers((s) => ({ ...s, [`${e.payload.id}:${e.payload.role}`]: e.payload }));
    }).then((u) => unsubs.push(u));
    void emit(QA.ready);
    return () => unsubs.forEach((u) => u());
  }, []);

  // On close, hand back everything typed so far (even items without a verdict).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await emit(QA.closed, { results: Object.values(resultsRef.current) });
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
    if (r) void emit(QA.result, r);
  };
  const decide = (verdict: Verdict) => {
    if (!item) return;
    const next: QaResult = { id: item.id, verdict, notes: results[item.id]?.notes ?? "" };
    setResults((r) => ({ ...r, [item.id]: next }));
    void emit(QA.result, next);
    // Advance to the next feature; on the last, stay (reviewer can close).
    setIdx((i) => Math.min(i + 1, items.length - 1));
  };

  const togglePin = async () => {
    const v = !pinned;
    setPinned(v);
    await getCurrentWindow().setAlwaysOnTop(v);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-accent/25 bg-panel text-gray-100 shadow-2xl">
      {/* Custom chrome: drag region + per-item progress dots + stick/close. */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-b border-edge bg-gradient-to-r from-accent/15 via-transparent to-transparent px-3 py-1.5"
      >
        <span data-tauri-drag-region className="flex select-none items-center gap-2 text-[12px] font-semibold text-accent">
          <span>🔍 <span className="text-grad">QA</span></span>
          {items.length > 0 && (
            <span data-tauri-drag-region className="flex items-center gap-1">
              {items.map((it, i) => {
                const v = results[it.id]?.verdict;
                const bg =
                  v === "approve" ? "bg-emerald-400" : v === "decline" ? "bg-red-400" : i === idx ? "bg-accent" : "bg-edge";
                return (
                  <button
                    key={it.id}
                    onClick={() => setIdx(i)}
                    title={it.title}
                    className={`h-2 w-2 rounded-full transition-all ${bg} ${i === idx ? "scale-125 ring-2 ring-accent/40" : "hover:scale-110"}`}
                  />
                );
              })}
              <span className="ml-1 text-[10px] font-normal text-muted">
                {idx + 1}/{items.length}
              </span>
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={togglePin}
            title={pinned ? "Unpin (stop staying on top)" : "Pin above all windows"}
            className={`rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${
              pinned ? "bg-accent/25 text-accent" : "text-muted hover:bg-edge"
            }`}
          >
            📌
          </button>
          <button
            onClick={() => void getCurrentWindow().close()}
            title="Close QA (verdicts are sent)"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-red-500/20 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      </div>

      {!item ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted">
          {items.length === 0 ? "Loading QA…" : "End of QA."}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto px-3.5 py-3">
          <div className="text-[15px] font-semibold leading-snug text-gray-50">{item.title}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            {item.branch && (
              <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300">
                🌿 {item.branch}
              </span>
            )}
            <ServerChip
              label="server"
              server={feServer}
              canStart={!!item.startCommand}
              onStart={() => void emit(QA.startServer, { id: item.id, role: "frontend" })}
            />
            {item.backend && (
              <ServerChip
                label={`backend · ${item.backend.project}`}
                server={beServer}
                canStart
                onStart={() => void emit(QA.startServer, { id: item.id, role: "backend" })}
              />
            )}
          </div>

          <div className="mt-3 rounded-lg border border-edge bg-card/60 px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
              What to check
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-300">{item.whatToCheck}</p>
          </div>

          <textarea
            value={result?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={flush}
            placeholder="Notes (optional · kept even if you close)…"
            className="mt-3 min-h-[72px] flex-1 resize-none rounded-lg border border-edge bg-card px-3 py-2 text-xs leading-relaxed text-gray-100 outline-none transition-colors placeholder:text-muted/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/30"
          />

          <div className="mt-3 grid grid-cols-2 gap-2">
            <VerdictBtn active={result?.verdict === "approve"} tone="approve" onClick={() => decide("approve")}>
              ✓ Approve
            </VerdictBtn>
            <VerdictBtn active={result?.verdict === "decline"} tone="decline" onClick={() => decide("decline")}>
              ✗ Decline
            </VerdictBtn>
          </div>

          <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="rounded-md border border-transparent px-2 py-1 transition-colors enabled:hover:border-edge enabled:hover:bg-edge/60 enabled:hover:text-gray-200 disabled:opacity-40"
            >
              ← prev
            </button>
            <span className="text-[10px] text-muted/60">
              {Object.values(results).filter((r) => r.verdict).length}/{items.length} decided
            </span>
            <button
              onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
              disabled={idx >= items.length - 1}
              className="rounded-md border border-transparent px-2 py-1 transition-colors enabled:hover:border-edge enabled:hover:bg-edge/60 enabled:hover:text-gray-200 disabled:opacity-40"
            >
              next →
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
  server?: QaServerPayload;
  canStart: boolean;
  onStart: () => void;
}) {
  const msg = server?.message;
  const degraded = server?.status === "warning";
  if (server?.url) {
    // Started — but if degraded (e.g. ran from base/dev), say so LOUDLY: amber chip
    // + the reason inline, so the user doesn't unknowingly QA stale code.
    return (
      <span className="inline-flex max-w-[24rem] flex-col gap-0.5">
        <button
          onClick={() => void navigator.clipboard?.writeText(server.url!)}
          title={msg ? `${label} — ${msg}` : `${label} — copy URL`}
          className={`rounded px-1.5 py-0.5 ${degraded ? "bg-amber-500/20 text-amber-200" : "bg-edge/60 text-emerald-300/90"}`}
        >
          {degraded ? "⚠ " : ""}{server.url.replace(/^https?:\/\//, "")} ⧉
        </button>
        {degraded && msg && <span className="text-[10px] leading-snug text-amber-300/90">{msg}</span>}
      </span>
    );
  }
  if (!canStart) return null;
  return (
    <span className="inline-flex max-w-[24rem] flex-col gap-0.5">
      <button
        onClick={onStart}
        disabled={server?.status === "starting"}
        title={msg}
        className="rounded bg-sky-500/25 px-1.5 py-0.5 text-sky-100 hover:bg-sky-500/35 disabled:opacity-60"
      >
        {server?.status === "starting"
          ? `starting ${label}…`
          : server?.status === "error"
            ? `⚠ ${label} — retry`
            : `▶ ${label}`}
      </button>
      {server?.status === "error" && msg && (
        <span className="text-[10px] leading-snug text-red-300/90">{msg}</span>
      )}
    </span>
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
    approve: active
      ? "border-emerald-500/60 bg-emerald-500/30 text-emerald-100 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
      : "border-edge text-emerald-300/80 hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-200",
    decline: active
      ? "border-red-500/60 bg-red-500/30 text-red-100 shadow-[0_0_12px_rgba(239,68,68,0.25)]"
      : "border-edge text-red-300/80 hover:border-red-500/40 hover:bg-red-500/15 hover:text-red-200",
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2 py-1.5 text-xs font-semibold transition-all ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
