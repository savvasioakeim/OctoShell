import { useState } from "react";
import type { AgentTextBlock, AgentToolBlock } from "../shell/ShellController";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { PROVIDERS } from "../agents/providers";

/** Tool result collapses past this height with an inner scrollbar. */
const RESULT_MAX_PX = 280;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A user prompt or an assistant reply. */
export function AgentTextBlockView({ block }: { block: AgentTextBlock }) {
  const isUser = block.role === "user";
  const prov = PROVIDERS.find((p) => p.value === block.provider) ?? PROVIDERS[0];
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isUser ? "border-edge bg-edge/30" : "border-accent/30 bg-card"
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <span className={isUser ? "font-semibold text-gray-300" : "font-semibold text-accent"}>
          {isUser ? "🧑 you" : `${prov.icon} ${prov.label.toLowerCase()}`}
        </span>
        <span className="text-muted">{fmtTime(block.startedAt)}</span>
      </div>
      <Markdown text={block.text} />
    </div>
  );
}

/** A tool the agent invoked (command/input) plus its result. */
export function AgentToolBlockView({ block }: { block: AgentToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const isBash = block.toolName === "Bash";
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
        {block.result !== undefined && block.result !== "" && (
          <div className="relative mt-1.5">
            <pre
              className="overflow-auto whitespace-pre-wrap break-words rounded bg-well/60 px-2 py-1.5 text-[14px] text-gray-300"
              style={expanded ? undefined : { maxHeight: RESULT_MAX_PX }}
            >
              {block.result}
            </pre>
            {block.result.length > 600 && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="mt-1 rounded bg-edge/80 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-accent/40"
              >
                {expanded ? "▲ Σύμπτυξη" : "▼ Εμφάνιση όλων"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

