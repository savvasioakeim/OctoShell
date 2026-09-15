// The permanent way into QA: a header button with the history behind it.

import { useRef, useState } from "react";
import { qaHistory, tally, useQaHistory, type QaSession } from "./qaHistory";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function QaHistoryButton({ onOpen }: { onOpen: (s: QaSession) => void }) {
  const sessions = useQaHistory();
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);

  // Sessions nobody has reviewed yet — what the badge is for.
  const unreviewed = sessions.filter((s) => s.results === null).length;

  const toggle = () => {
    if (pos) return setPos(null);
    const r = btn.current?.getBoundingClientRect();
    // Fixed, not absolute: the header strip clips its overflow.
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <>
      <button
        ref={btn}
        onClick={toggle}
        title="QA — every QA the orchestrator proposed, with your verdicts"
        className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] ${
          pos
            ? "border-emerald-400/60 bg-emerald-500/15 text-gray-100"
            : "border-emerald-500/40 text-muted hover:bg-emerald-500/15 hover:text-gray-200"
        }`}
      >
        <span className="text-sm leading-none">🔍</span>
        QA
        {unreviewed > 0 && (
          <span className="rounded bg-emerald-500/30 px-1 text-[9px] font-semibold text-emerald-100">{unreviewed}</span>
        )}
      </button>

      {pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
          <div
            className="fixed z-50 max-h-[60vh] w-80 overflow-y-auto rounded-lg border border-edge bg-panel py-1 text-xs shadow-xl"
            style={{ top: pos.top, right: pos.right }}
          >
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted">QA history</div>
            {sessions.length === 0 && (
              <p className="px-3 py-2 leading-relaxed text-muted">
                Nothing yet. QA the orchestrator proposes lands here, and so does "QA this worktree" from a
                project's right-click menu.
              </p>
            )}
            {sessions.map((s) => {
              const t = tally(s);
              return (
                <div key={s.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-edge">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setPos(null);
                      onOpen(s);
                    }}
                  >
                    <span className="block truncate text-gray-200">{s.title}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                      <span>
                        {s.items.length} item{s.items.length === 1 ? "" : "s"} · {ago(s.updatedAt)}
                      </span>
                      {s.results === null ? (
                        <span className="text-emerald-300">not reviewed</span>
                      ) : (
                        <>
                          {t.approved > 0 && <span className="text-emerald-300">✓ {t.approved}</span>}
                          {t.declined > 0 && <span className="text-red-300">✗ {t.declined}</span>}
                          {t.pending > 0 && <span>· {t.pending} open</span>}
                        </>
                      )}
                    </span>
                  </button>
                  <button
                    onClick={() => qaHistory.remove(s.id)}
                    title="Remove from history"
                    className="shrink-0 rounded px-1 text-muted opacity-0 hover:text-red-300 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
