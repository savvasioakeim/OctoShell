import { Fragment } from "react";
import type { AgentStep } from "../agents/providers";
import { useAdapt } from "../util/usePalette";

// Neon endpoints for the trace: purple (#A855F7) → blue (#38BDF8). A node/segment
// at fraction t along the route is colored by interpolating between them, so the
// route visibly shifts from purple (just started) to blue (nearly done).
//
// The interpolation is numeric, so neither a CSS variable nor the light-mode
// hue flip can reach it; the result goes through `adapt` instead. The unlit
// colour is just the border colour, so it can be the variable.
const TRACE_FROM = [168, 85, 247];
const TRACE_TO = [56, 189, 248];
const TRACE_PENDING = "var(--color-edge)"; // unlit segment/node
function traceHex(t: number): string {
  const c = TRACE_FROM.map((from, i) => Math.round(from + (TRACE_TO[i] - from) * t));
  return `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Task progress as a PCB trace: one node per planned step (the agent's task list),
 * connected by trace segments. Three node states, shading purple → blue along the
 * route: completed `●` (solid, lit), the active step `◉` (larger, brighter glow,
 * pulsing), and pending `○` (hollow ring, dim). Hidden when there are no steps.
 */
export function TraceProgress({ steps }: { steps: AgentStep[] | null }) {
  const adapt = useAdapt();
  const traceColor = (t: number) => adapt(traceHex(t), 2.2);
  if (!steps || steps.length === 0) return null;
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "completed").length;
  const pct = Math.round((completed / total) * 100);
  const lit = (i: number) => steps[i].status !== "pending"; // completed or active
  const fracAt = (i: number) => (total > 1 ? i / (total - 1) : 1);

  // The always-on title above the bar: the step in progress, else (all done) the
  // last step, else the next pending one. Changes as the active task advances.
  const activeIdx = steps.findIndex((s) => s.status === "in_progress");
  const allDone = completed === total;
  const curIdx = activeIdx >= 0 ? activeIdx : allDone ? total - 1 : Math.min(completed, total - 1);
  const curText = steps[curIdx]?.text?.trim() || `Step ${curIdx + 1}`;
  const curLabel = allDone ? `✓ ${curText}` : curText;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Current task title — always visible, centered, tinted to its trace color. */}
      <div
        className="truncate text-center text-[11px] font-medium leading-none"
        style={{ color: traceColor(fracAt(curIdx)) }}
        title={curLabel}
      >
        {curLabel}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <div className="flex min-w-0 flex-1 items-center">
          {steps.map((s, i) => {
            const col = traceColor(fracAt(i));
            const active = s.status === "in_progress";
            const done = s.status === "completed";
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
              </Fragment>
            );
          })}
        </div>
        <span className="shrink-0 tabular-nums" style={{ color: traceColor(completed / total) }}>
          {completed}/{total} steps · {pct}%
        </span>
      </div>
    </div>
  );
}
