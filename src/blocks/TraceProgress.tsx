import { Fragment } from "react";
import type { AgentStep } from "../agents/providers";

// Neon endpoints for the trace: purple (#A855F7) → blue (#38BDF8). A node/segment
// at fraction t along the route is colored by interpolating between them, so the
// route visibly shifts from purple (just started) to blue (nearly done).
const TRACE_FROM = [168, 85, 247];
const TRACE_TO = [56, 189, 248];
const TRACE_PENDING = "#313747"; // unlit segment/node (matches `edge`)
function traceColor(t: number): string {
  const c = TRACE_FROM.map((from, i) => Math.round(from + (TRACE_TO[i] - from) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Task progress as a PCB trace: one node per planned step (the agent's task list),
 * connected by trace segments. Three node states, shading purple → blue along the
 * route: completed `●` (solid, lit), the active step `◉` (larger, brighter glow,
 * pulsing), and pending `○` (hollow ring, dim). Hidden when there are no steps.
 */
export function TraceProgress({ steps }: { steps: AgentStep[] | null }) {
  if (!steps || steps.length === 0) return null;
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "completed").length;
  const pct = Math.round((completed / total) * 100);
  const lit = (i: number) => steps[i].status !== "pending"; // completed or active
  const fracAt = (i: number) => (total > 1 ? i / (total - 1) : 1);

  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center">
        {steps.map((s, i) => {
          const col = traceColor(fracAt(i));
          const active = s.status === "in_progress";
          const done = s.status === "completed";
          const label = active ? `Current: ${s.text}` : done ? `✓ ${s.text}` : s.text || `Βήμα ${i + 1}`;
          return (
            <Fragment key={i}>
              {i > 0 && (
                <span
                  className="h-px flex-1 rounded-full transition-colors"
                  style={{
                    background:
                      lit(i - 1) && lit(i)
                        ? `linear-gradient(90deg, ${traceColor(fracAt(i - 1))}, ${traceColor(fracAt(i))})`
                        : TRACE_PENDING,
                  }}
                />
              )}
              {/* Node + instant CSS tooltip (group-hover toggles display → no delay,
                  unlike the native title attribute). cursor-help signals the hint. */}
              <span className="group relative flex shrink-0 cursor-help items-center">
                <span
                  className={`shrink-0 rounded-full transition-all ${
                    active ? "h-3 w-3 animate-pulse" : "h-2 w-2"
                  }`}
                  style={
                    active
                      ? { background: col, boxShadow: `0 0 12px 3px ${col}` } // ◉ focal point
                      : done
                      ? { background: col, boxShadow: `0 0 6px ${col}` } // ● solid + glow
                      : { background: "transparent", border: `1.5px solid ${TRACE_PENDING}` } // ○ hollow
                  }
                />
                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded border border-edge bg-chrome px-2 py-1 text-[11px] text-gray-100 shadow-lg group-hover:block">
                  {label}
                </span>
              </span>
            </Fragment>
          );
        })}
      </div>
      <span className="shrink-0 tabular-nums" style={{ color: traceColor(completed / total) }}>
        {completed}/{total} steps · {pct}%
      </span>
    </div>
  );
}
