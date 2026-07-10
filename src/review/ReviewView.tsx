// The Review view: the central column's second face, shown when this session's
// automated review agent is active. A pinned (collapsible) task-context block on
// top, the review agent's conversation in the middle, and an input that talks to
// the REVIEW agent (not the coding agent). Toggled from the Coding⇄Review switch
// in the top toolbar; a soft neon pulse signals the reviewer is working.

import { useState, useSyncExternalStore } from "react";
import type { ShellController } from "../shell/ShellController";
import type { ReviewSnapshot } from "./ReviewAgentController";
import { Feed } from "../blocks/Feed";

export type CenterView = "coding" | "review";

/** Subscribe a component to a session's review-agent store. */
export function useReview(controller: ShellController): ReviewSnapshot {
  return useSyncExternalStore(controller.review.subscribe, controller.review.getSnapshot);
}

/** The Coding⇄Review segmented switch — a small floating panel in the chat card's
 *  top-right corner (rendered only when a review agent exists for the session).
 *  The Review segment glows amber when selected and PULSES while the review agent
 *  is working, so its activity reads at a glance without a separate label. */
export function ReviewSwitch({
  view,
  onChange,
  busy,
}: {
  view: CenterView;
  onChange: (v: CenterView) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-edge bg-chrome shadow-sm">
      <button
        onClick={() => onChange("coding")}
        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
          view === "coding" ? "bg-accent/25 text-accent" : "text-muted hover:bg-edge hover:text-gray-200"
        }`}
      >
        Coding
      </button>
      <button
        onClick={() => onChange("review")}
        title={busy ? "Review agent is working…" : "Review agent"}
        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
          view === "review"
            ? "bg-amber-400/15 text-amber-300"
            : busy
              ? "text-amber-300/80"
              : "text-muted hover:bg-edge hover:text-gray-200"
        } ${busy ? "animate-pulse" : ""}`}
      >
        Review
      </button>
    </div>
  );
}

/** The pinned task-context block: 2 lines by default, expandable to the full
 *  prompt the review agent was anchored to. */
function PinnedContext({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="shrink-0 border-b border-edge bg-slate-900/50 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            📌 Task context
          </div>
          <p className={`whitespace-pre-wrap text-xs leading-relaxed text-gray-400 ${open ? "" : "line-clamp-2"}`}>
            {text}
          </p>
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? "Collapse" : "Expand"}
          className="mt-0.5 shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-edge hover:text-gray-200"
        >
          <svg
            viewBox="0 0 12 12"
            className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 4.5 6 7.5l3-3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** The review-agent input: an accent-bordered box that routes to the REVIEW agent
 *  (Enter to send, Shift+Enter for a newline). */
function ReviewInput({ controller, busy }: { controller: ShellController; busy: boolean }) {
  const [value, setValue] = useState("");
  const send = () => {
    const t = value.trim();
    if (!t || busy) return;
    controller.review.reply(t);
    setValue("");
  };
  return (
    <div className="shrink-0 border-t border-edge p-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder="Reply to Reviewer or approve changes… (Enter to send)"
        className="w-full resize-none rounded-lg border border-purple-500/50 bg-card px-3 py-2 text-sm leading-relaxed text-gray-100 outline-none transition-colors placeholder:text-muted/60 focus:border-purple-400 focus:ring-1 focus:ring-purple-500/40"
      />
    </div>
  );
}

/** The full Review view: pinned context · review-agent feed · reviewer input. */
export function ReviewPanel({ controller, snap }: { controller: ShellController; snap: ReviewSnapshot }) {
  return (
    <>
      <PinnedContext text={snap.contextPrompt} />
      <Feed blocks={snap.blocks} controller={controller} altScreen={false} interacting={false} />
      <ReviewInput controller={controller} busy={snap.busy} />
    </>
  );
}
