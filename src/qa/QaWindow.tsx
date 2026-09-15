import { useEffect, useRef, useState } from "react";
import { stepsOf } from "./parseQa";
import { dragHasFiles, filesFromDrop, isImageFile, saveDroppedFile } from "../util/drop";
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
  // Dropped screenshots: while dragging over the notes, any drop error, and a
  // preview per saved path. Previews are object URLs for files dropped in THIS
  // window; a QA reopened from history has paths but no previews, and shows names.
  const [dropping, setDropping] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const resultsRef = useRef(results);
  resultsRef.current = results;

  // Receive the items (ask for them on mount) + live server status updates.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void listen<QaLoadPayload>(QA.load, (e) => {
      setItems(e.payload.items);
      setIdx(0);
      // Start from the verdicts this QA was saved with (reopened from history),
      // or from nothing. Never from whatever the previous QA left in this window.
      setResults(Object.fromEntries((e.payload.results ?? []).map((r) => [r.id, r])));
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
    setResults((r) => ({ ...r, [item.id]: { ...r[item.id], id: item.id, verdict: r[item.id]?.verdict ?? null, notes } }));
  };
  /** Replace this item's screenshots and tell the main window right away, so a
   *  crash or a force-close cannot lose them. */
  const setImages = (images: string[]) => {
    if (!item) return;
    const cur = resultsRef.current[item.id];
    const next: QaResult = { ...cur, id: item.id, verdict: cur?.verdict ?? null, notes: cur?.notes ?? "", images };
    setResults((r) => ({ ...r, [item.id]: next }));
    void emit(QA.result, next);
  };

  const onDropImages = async (e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return; // dragged text: let the textarea have it
    e.preventDefault();
    setDropping(false);
    if (!item) return;
    const files = filesFromDrop(e.dataTransfer);
    const images = files.filter(isImageFile);
    if (!images.length) {
      setDropErr(files.length ? "Only images can be attached here." : null);
      return;
    }
    setDropErr(files.length > images.length ? "Skipped the files that aren't images." : null);
    try {
      const saved = await Promise.all(
        images.map(async (file) => ({ file, path: await saveDroppedFile(file) })),
      );
      setPreviews((p) => {
        const n = { ...p };
        for (const { file, path } of saved) n[path] = URL.createObjectURL(file);
        return n;
      });
      const existing = resultsRef.current[item.id]?.images ?? [];
      setImages([...existing, ...saved.map((s) => s.path)]);
    } catch (err) {
      setDropErr(`Couldn't attach the image: ${err}`);
    }
  };

  const flush = () => {
    if (!item) return;
    const r = resultsRef.current[item.id];
    if (r) void emit(QA.result, r);
  };
  const decide = (verdict: Verdict) => {
    if (!item) return;
    const next: QaResult = { ...results[item.id], id: item.id, verdict, notes: results[item.id]?.notes ?? "" };
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
            {(() => {
              // Steps as a real list, one per line, however the orchestrator
              // formatted them; unstructured prose falls back to a paragraph.
              const steps = stepsOf(item);
              if (steps.length === 0) {
                return <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-300">{item.whatToCheck}</p>;
              }
              return (
                <ol className="space-y-1.5 text-xs leading-relaxed text-gray-300">
                  {steps.map((step, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-semibold text-accent">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap">{step}</span>
                    </li>
                  ))}
                </ol>
              );
            })()}
          </div>

          <textarea
            value={result?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={flush}
            onDragOver={(e) => {
              if (!dragHasFiles(e.dataTransfer)) return;
              e.preventDefault();
              setDropping(true);
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => void onDropImages(e)}
            placeholder="Notes (optional · kept even if you close) — drop screenshots here…"
            className={`mt-3 min-h-[72px] flex-1 resize-none rounded-lg border bg-card px-3 py-2 text-xs leading-relaxed text-gray-100 outline-none transition-colors placeholder:text-muted/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/30 ${
              dropping ? "border-accent bg-accent/5" : "border-edge"
            }`}
          />
          {(result?.images?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {result!.images!.map((path) => {
                const name = path.split(/[\\/]/).pop() ?? path;
                return (
                  <div key={path} title={path} className="group relative">
                    {previews[path] ? (
                      <img
                        src={previews[path]}
                        alt={name}
                        className="h-14 w-14 rounded-md border border-edge object-cover"
                      />
                    ) : (
                      <div className="flex h-14 max-w-[9rem] items-center rounded-md border border-edge bg-card px-2 text-[10px] text-muted">
                        <span className="truncate">🖼 {name}</span>
                      </div>
                    )}
                    <button
                      onClick={() => setImages((result?.images ?? []).filter((p) => p !== path))}
                      title="Remove"
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-red-500/80 text-[9px] text-white group-hover:flex"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {dropErr && <p className="mt-1 text-[11px] text-red-300">{dropErr}</p>}

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
