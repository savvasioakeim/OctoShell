import { useState } from "react";
import type { AgentApprovalBlock, AgentTextBlock, AgentToolBlock } from "../shell/ShellController";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { PROVIDERS } from "../agents/providers";

/** Tool result collapses past this height with an inner scrollbar. */
const RESULT_MAX_PX = 280;
/** Until expanded, only this many chars of a result are put in the DOM — a huge
 *  result would otherwise be an expensive text node to lay out on mount. */
const RESULT_CHARS_CAP = 4000;
/** Until expanded, agent prose is capped to this many lines, so a very long
 *  message doesn't build thousands of React nodes the instant it scrolls in. */
const TEXT_LINES_CAP = 160;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A user prompt or an assistant reply. */
export function AgentTextBlockView({ block }: { block: AgentTextBlock }) {
  const [expanded, setExpanded] = useState(false);
  const isUser = block.role === "user";
  const prov = PROVIDERS.find((p) => p.value === block.provider) ?? PROVIDERS[0];

  // Cap very long messages: rendering thousands of markdown nodes on mount is a
  // scroll-stalling cost. Show the head, with a button to reveal the rest.
  const lines = block.text.split("\n");
  const long = lines.length > TEXT_LINES_CAP;
  const text = expanded || !long ? block.text : lines.slice(0, TEXT_LINES_CAP).join("\n");

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isUser ? "border-edge bg-edge/30" : "border-accent/30 bg-card"
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <span className={isUser ? "font-semibold text-gray-300" : "font-semibold text-accent"}>
          {isUser ? "you" : prov.label.toLowerCase()}
        </span>
        <span className="text-muted">{fmtTime(block.startedAt)}</span>
      </div>
      <Markdown text={text} />
      {long && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 rounded bg-edge/80 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-accent/40"
        >
          {expanded ? "▲ Less" : `▼ ${lines.length - TEXT_LINES_CAP} more lines`}
        </button>
      )}
    </div>
  );
}

/** A per-tool approval request: the agent is blocked until the user decides. */
export function AgentApprovalBlockView({
  block,
  onRespond,
}: {
  block: AgentApprovalBlock;
  onRespond: (requestId: string, allow: boolean) => void;
}) {
  const isBash = block.toolName === "Bash";
  const pending = block.status === "pending";
  const border =
    block.status === "approved"
      ? "border-emerald-500/40"
      : block.status === "denied"
      ? "border-red-500/40"
      : "border-amber-400/60";
  return (
    <div className={`rounded-lg border bg-card ${border}`}>
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5 text-xs">
        <span>{pending ? "🛡" : block.status === "approved" ? "✅" : "🚫"}</span>
        <span className="font-semibold text-amber-300">
          {pending ? "Tool approval" : block.status === "approved" ? "Approved" : "Denied"}
        </span>
        <span className="font-semibold text-accent">{block.toolName}</span>
        <span className="text-muted">{fmtTime(block.startedAt)}</span>
      </div>
      <div className="px-3 py-2">
        {isBash ? (
          <div className="flex gap-2 overflow-x-auto rounded bg-well px-2 py-1.5">
            <span className="select-none text-green-300">$</span>
            <CodeBlock code={block.toolInput} lang="bash" className="flex-1 text-[14px]" />
          </div>
        ) : (
          <CodeBlock
            code={block.toolInput}
            lang="json"
            className="overflow-x-auto rounded bg-well px-2 py-1.5 text-[14px] text-gray-200"
          />
        )}
        {pending && (
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => onRespond(block.requestId, true)}
              className="rounded bg-emerald-500/80 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500"
            >
              ✓ Approve
            </button>
            <button
              onClick={() => onRespond(block.requestId, false)}
              className="rounded border border-red-400/50 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/20"
            >
              ✕ Deny
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A tool the agent invoked (command/input) plus its result. */
/** Strip a markdown code fence that wraps an ENTIRE tool result.
 *
 *  ACP adapters hand terminal output back pre-formatted for chat (```console …
 *  ```), but we render results in a <pre> — so the fence markers showed up as
 *  literal ``` lines around every command's output. The payload is already
 *  monospace here, so the fence carries no information: drop it. Anything more
 *  complex (prose plus several fences) is left untouched. */
function unfence(text: string): string {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m && !m[1].includes("```") ? m[1] : text;
}

export function AgentToolBlockView({ block }: { block: AgentToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const isBash = block.toolName === "Bash";
  const result = block.result ? unfence(block.result) : "";
  // A tool can fail with nothing to show (ACP's Terminal reports the failure out
  // of band). An empty red block told the user only that *something* broke, so
  // say that explicitly instead of rendering nothing.
  const silentFailure = !result && (block.isError || block.status === "error");
  const dot =
    block.status === "running"
      ? "bg-yellow-400 animate-pulse"
      : block.status === "error"
      ? "bg-red-400"
      : "bg-green-400";

  return (
    <div className="rounded-lg border border-edge bg-card">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5 text-xs">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span className="font-semibold text-accent">{block.toolName}</span>
        <span className="text-muted">{fmtTime(block.startedAt)}</span>
      </div>
      <div className="px-3 py-2">
        {/* ACP tool calls can arrive with an empty input (the command travels
            via terminal/create) — a bare "{}" block is just noise, skip it. */}
        {block.toolInput.trim() && block.toolInput.trim() !== "{}" ? (
          isBash ? (
            <div className="flex gap-2 overflow-x-auto rounded bg-well px-2 py-1.5">
              <span className="select-none text-green-300">$</span>
              <CodeBlock code={block.toolInput} lang="bash" className="flex-1 text-[14px]" />
            </div>
          ) : (
            <CodeBlock
              code={block.toolInput}
              lang="json"
              className="overflow-x-auto rounded bg-well px-2 py-1.5 text-[14px] text-gray-200"
            />
          )
        ) : null}
        {silentFailure && (
          <div className="mt-1.5 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[12px] text-red-300">
            ⚠️ {block.toolName} failed but returned no output — check the agent's next
            message, or run the command yourself in Shell mode to see the error.
          </div>
        )}
        {result !== "" && (
          <div className="relative mt-1.5">
            <pre
              className={`overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1.5 text-[14px] ${
                block.isError ? "bg-red-500/10 text-red-200" : "bg-well/60 text-gray-300"
              }`}
              style={expanded ? undefined : { maxHeight: RESULT_MAX_PX }}
            >
              {expanded ? result : result.slice(0, RESULT_CHARS_CAP)}
            </pre>
            {result.length > 600 && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="mt-1 rounded bg-edge/80 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-accent/40"
              >
                {expanded ? "▲ Collapse" : "▼ Show all"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
