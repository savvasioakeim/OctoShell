import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BlockStatus, CommandBlock } from "../shell/ShellController";

interface Props {
  block: CommandBlock;
  /** This running block hosts a full-screen app (alt-screen): give it the full
   *  viewport and a focus affordance. */
  interactive?: boolean;
  /** The live terminal currently holds keyboard focus (user typing into it). */
  interacting?: boolean;
  /** Called with the content host element for the *running* block, so the
   *  controller can mount the shared live xterm into it. */
  onLiveHost: (blockId: string, el: HTMLElement | null) => void;
  /** Click-to-type: focus the running command's terminal. */
  onFocusLive?: () => void;
  onAskAi: (block: CommandBlock) => void;
}

/** Tall finished output collapses to this many px with an inner scrollbar,
 *  until the user expands it. Keeps a 50k-line build log from eating the feed. */
const COLLAPSED_MAX_PX = 360;

function StatusDot({ status }: { status: BlockStatus }) {
  const map = {
    running: "bg-yellow-400 animate-pulse",
    success: "bg-green-400",
    error: "bg-red-400",
  } as const;
  return <span className={`inline-block h-2 w-2 rounded-full ${map[status]}`} />;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * One semantic block: header (command + time + status) · content (live xterm
 * while running, frozen selectable HTML once finished) · hover action buttons.
 */
export function TerminalBlock({
  block,
  interactive = false,
  interacting = false,
  onLiveHost,
  onFocusLive,
  onAskAi,
}: Props) {
  const isRunning = block.status === "running";
  // "Live keyboard" = the running terminal is the keyboard target: either a
  // full-screen app (alt-screen) or the user clicked in to type directly.
  const liveKeyboard = isRunning && (interactive || interacting);

  // Callback ref: React hands us the content host element; we forward it to the
  // controller, which mounts/relocates the shared live terminal.
  const liveRef = useCallback(
    (el: HTMLDivElement | null) => onLiveHost(block.id, el),
    [block.id, onLiveHost],
  );

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div
      className={`group relative rounded-lg border bg-card shadow-sm transition-colors ${
        liveKeyboard
          ? "border-accent/60 ring-1 ring-accent/40"
          : block.status === "error"
          ? "border-red-500/40"
          : "border-edge"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5 text-xs">
        <StatusDot status={block.status} />
        <code className="flex-1 truncate text-gray-100">{block.command}</code>
        {liveKeyboard && (
          <span className="rounded bg-accent/25 px-1.5 py-0.5 text-accent">
            ⌨ {interactive ? "interactive" : "typing"} · keys go to app
          </span>
        )}
        {block.exitCode !== undefined && block.exitCode !== 0 && (
          <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-300">exit {block.exitCode}</span>
        )}
        <span className="text-muted">{fmtTime(block.startedAt)}</span>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-9 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <ActionBtn label="Copy output" onClick={() => copy(block.outputText)}>⧉ out</ActionBtn>
        <ActionBtn label="Copy command" onClick={() => copy(block.command)}>⧉ cmd</ActionBtn>
        <ActionBtn label="Ask AI about this" onClick={() => onAskAi(block)}>✨ AI</ActionBtn>
      </div>

      {/* Content */}
      <div className="px-2 py-1.5">
        {isRunning ? (
          // Live: controller mounts the shared WebGL xterm here. Clicking focuses
          // the terminal so keystrokes go straight to the running command.
          <div onMouseDown={onFocusLive} className={interactive ? "cursor-text" : "min-h-[18px] cursor-text"}>
            <div ref={liveRef} />
            {!liveKeyboard && (
              <div className="pointer-events-none mt-1 select-none text-[11px] text-muted/70">
                κλικ για να πληκτρολογήσεις απευθείας σε αυτή την εντολή
              </div>
            )}
          </div>
        ) : (
          <FrozenOutput html={block.frozenHtml ?? ""} />
        )}
      </div>
    </div>
  );
}

/** Finished output, capped to {@link COLLAPSED_MAX_PX} with an inner scrollbar
 *  until expanded. Fully selectable either way.
 *
 *  Lazy: the (potentially large) colored HTML is injected only once the block
 *  nears the viewport, so a long feed of finished blocks isn't all in the DOM at
 *  once. Until then it's a light placeholder; once shown, it stays mounted. */
function FrozenOutput({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [shown, setShown] = useState(false);

  // Reveal when scrolled near (rootMargin pre-loads just off-screen).
  useEffect(() => {
    if (shown) return;
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_MAX_PX + 4);
  }, [html, shown]);

  return (
    <div ref={wrapRef} className="relative">
      {shown ? (
        <>
          <div
            ref={ref}
            className="select-text overflow-y-auto text-[15px] leading-[20px]"
            style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_PX }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {overflowing && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 rounded bg-edge/80 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-accent/40"
            >
              {expanded ? "▲ Σύμπτυξη" : "▼ Εμφάνιση όλων"}
            </button>
          )}
        </>
      ) : (
        <div className="h-5" aria-hidden />
      )}
    </div>
  );
}

function ActionBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={label}
      onClick={onClick}
      className="rounded bg-edge/90 px-1.5 py-0.5 text-[11px] text-gray-200 hover:bg-accent/40"
    >
      {children}
    </button>
  );
}
