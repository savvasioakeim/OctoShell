import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Block, ShellController } from "../shell/ShellController";
import { TerminalBlock } from "./TerminalBlock";
import { AgentApprovalBlockView, AgentTextBlockView, AgentToolBlockView } from "./AgentBlock";

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
            const running =
              ((b.kind === "command" || b.kind === "agentTool") && b.status === "running") ||
              (b.kind === "agentApproval" && b.status === "pending");
            const node =
              b.kind === "agentText" ? (
                <AgentTextBlockView block={b} />
              ) : b.kind === "agentApproval" ? (
                <AgentApprovalBlockView block={b} onRespond={(rid, allow) => controller.respondApproval(rid, allow)} />
              ) : b.kind === "agentTool" ? (
                <AgentToolBlockView block={b} />
              ) : (
                <TerminalBlock
                  block={b}
                  interactive={altScreen && b.status === "running"}
                  interacting={interacting && b.status === "running"}
                  onLiveHost={controller.attachLiveHost.bind(controller)}
                  onFocusLive={() => controller.focusLive()}
                  onAskAi={(blk) => controller.onAskAi(blk)}
                />
              );
            // The running block hosts the live xterm — it must always stay
            // mounted. Settled blocks are virtualized: unmounted while off-screen
            // (their height preserved) so memory/DOM stay flat with long history.
            if (running) return <div key={b.id}>{node}</div>;
            return (
              <VirtualBlock key={b.id} id={b.id} root={scrollRef}>
                {node}
              </VirtualBlock>
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

// Remembered rendered heights, keyed by block id, surviving unmount/remount.
// So when a project switch remounts the whole feed, placeholders start at the
// real heights from last time — no scroll jump while blocks lazily mount in.
const heightCache = new Map<string, number>();
// Placeholder height for a block we've never rendered yet (first-ever view).
const EST_HEIGHT = 120;

// Time-sliced mount scheduler. When a whole window of blocks enters view at once
// (a project switch, or a fast scroll), mounting them all in one React commit is
// a single long task (~8ms/block × N) — the freeze. Instead we mount a few per
// animation frame, so the work spreads across frames and the main thread stays
// responsive. The 800px lookahead gives these staggered mounts runway to finish
// before the block is actually on screen.
const MOUNTS_PER_FRAME_DEFAULT = 3;
let mountsPerFrame = MOUNTS_PER_FRAME_DEFAULT;
const mountQueue: Array<() => void> = [];
let pumping = false;

/** Raise the per-frame mount budget during startup preload (the overlay hides
 *  any jank), then drop back to the interactive default. */
export function setMountBudget(n: number): void {
  mountsPerFrame = n > 0 ? n : MOUNTS_PER_FRAME_DEFAULT;
}

/** How many block mounts are still queued — drives the startup progress bar. */
export function pendingMountCount(): number {
  return mountQueue.length;
}

function pumpMounts() {
  pumping = false;
  for (let i = 0; i < mountsPerFrame && mountQueue.length; i++) mountQueue.shift()!();
  if (mountQueue.length) {
    pumping = true;
    requestAnimationFrame(pumpMounts);
  }
}

function scheduleMount(cb: () => void): () => void {
  mountQueue.push(cb);
  if (!pumping) {
    pumping = true;
    requestAnimationFrame(pumpMounts);
  }
  return () => {
    const i = mountQueue.indexOf(cb);
    if (i >= 0) mountQueue.splice(i, 1);
  };
}

/**
 * Virtualization by occlusion: a settled block renders only while it's near the
 * viewport, and UNMOUNTS once scrolled far away — leaving a placeholder of its
 * known height. This keeps the live DOM small (≈ one viewport-worth of blocks)
 * no matter how long the history, so layout/reflow stays cheap. The visible→
 * mounted transition goes through the frame-budgeted scheduler so a burst of
 * blocks never mounts in one long task; the 800px lookahead mounts a block
 * before it scrolls into view.
 */
function VirtualBlock({
  id,
  root,
  children,
}: {
  id: string;
  root: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const heightRef = useRef(heightCache.get(id) ?? EST_HEIGHT);

  useLayoutEffect(() => {
    if (mounted && ref.current) {
      const h = ref.current.getBoundingClientRect().height;
      if (h > 0) {
        heightRef.current = h;
        heightCache.set(id, h);
      }
    }
  });

  useEffect(() => {
    const el = ref.current;
    const rootEl = root.current;
    if (!el || !rootEl) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      root: rootEl,
      rootMargin: "800px 0px", // mount well before it enters the viewport
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  // On-screen (within lookahead): mount via the scheduler. Off-screen: unmount,
  // so the DOM never grows beyond what's near the viewport.
  useEffect(() => {
    if (!visible) {
      setMounted(false);
      return;
    }
    if (mounted) return;
    return scheduleMount(() => setMounted(true));
  }, [visible, mounted]);

  return (
    <div ref={ref} style={mounted ? undefined : { height: heightRef.current }}>
      {mounted ? children : null}
    </div>
  );
}
