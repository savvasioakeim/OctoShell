import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Block, ShellController } from "../shell/ShellController";
import { TerminalBlock } from "./TerminalBlock";
import { AgentTextBlockView, AgentToolBlockView } from "./AgentBlock";

interface Props {
  blocks: Block[];
  controller: ShellController;
  /** A full-screen app (alt-screen) is running — the running block is interactive. */
  altScreen: boolean;
  /** The live terminal currently holds keyboard focus. */
  interacting: boolean;
}

/** Treat the viewport as "at bottom" within this many px (stick-to-bottom slack). */
const NEAR_BOTTOM_PX = 60;

/**
 * The scrollable feed of command blocks.
 *
 * Smart scroll (stick-to-bottom): new output follows the bottom ONLY while the
 * user is already there. If they scroll up to read, live output and new blocks
 * no longer yank them down; a floating "↓" button (with a new-message count)
 * lets them jump back when ready.
 */
export function Feed({ blocks, controller, altScreen, interacting }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether we should keep the viewport pinned to the bottom. A ref (not state)
  // so the live-output ResizeObserver reads it without re-subscribing.
  const stickRef = useRef(true);
  const prevLen = useRef(blocks.length);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, []);

  // The user's own scrolling decides whether we keep following the bottom.
  const onScroll = useCallback(() => {
    const near = isNearBottom();
    stickRef.current = near;
    setAtBottom(near);
    if (near) setNewCount(0);
  }, [isNearBottom]);

  // New blocks: follow if pinned, otherwise bump the "new messages" badge.
  useLayoutEffect(() => {
    const added = blocks.length - prevLen.current;
    prevLen.current = blocks.length;
    if (stickRef.current) scrollToBottom();
    else if (added > 0) setNewCount((n) => n + added);
  }, [blocks.length, scrollToBottom]);

  // Live output grows a block's height without changing blocks.length — observe
  // the content box so a pinned viewport keeps following streaming output, while
  // a user who scrolled up is left undisturbed.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="octo-feed h-full overflow-y-auto p-3"
      >
        <div ref={contentRef} className="space-y-3">
          {blocks.length === 0 && (
            <div className="select-none p-6 text-center text-sm text-muted">
              🐙 OctoShell — γράψε μια εντολή παρακάτω για να ξεκινήσεις.
            </div>
          )}
          {blocks.map((b) => {
            if (b.kind === "agentText") return <AgentTextBlockView key={b.id} block={b} />;
            if (b.kind === "agentTool") return <AgentToolBlockView key={b.id} block={b} />;
            const running = b.status === "running";
            return (
              <TerminalBlock
                key={b.id}
                block={b}
                interactive={altScreen && running}
                interacting={interacting && running}
                onLiveHost={controller.attachLiveHost.bind(controller)}
                onFocusLive={() => controller.focusLive()}
                onAskAi={(blk) => controller.onAskAi(blk)}
              />
            );
          })}
        </div>
      </div>

      {!atBottom && (
        <button
          onClick={() => scrollToBottom("smooth")}
          title="Μετάβαση στο κάτω μέρος"
          className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 rounded-full border border-edge bg-panel/90 px-3 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:bg-accent/30 hover:text-white"
        >
          {newCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
              {newCount}
            </span>
          )}
          <span>↓ {newCount > 0 ? "νέα" : "Κάτω"}</span>
        </button>
      )}
    </div>
  );
}
