import type { ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";

/** Inline markdown: **bold** and `code`. Returns React nodes for one line. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+?\*\*|`[^`]+?`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={key++} className="font-semibold text-white">{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={key++} className="rounded bg-edge px-1 text-[0.9em] text-accent">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Prose between code fences: headings, blockquotes, blank lines, inline marks. */
function Prose({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        if (/^#{1,6}\s/.test(line)) {
          return (
            <div key={i} className="mb-1 mt-2 font-semibold text-gray-100">
              {renderInline(line.replace(/^#{1,6}\s/, ""))}
            </div>
          );
        }
        if (/^>\s?/.test(line)) {
          return (
            <div
              key={i}
              className="border-edge pl-2 text-muted"
              style={{ borderLeftWidth: 2, borderLeftStyle: "solid" }}
            >
              {renderInline(line.replace(/^>\s?/, ""))}
            </div>
          );
        }
        if (line.trim() === "") return <div key={i} className="h-2" />;
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {renderInline(line)}
          </div>
        );
      })}
    </>
  );
}

/**
 * Lightweight markdown renderer shared by the agent feed and the assistant:
 * fenced code (syntax-highlighted) split from prose, with inline bold/code,
 * headings and blockquotes. Intentionally minimal — not a full CommonMark impl.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/```/);
  return (
    <div className={className ?? "text-sm text-gray-100"}>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Prose key={i} text={part} />;
        const nl = part.indexOf("\n");
        const lang = nl >= 0 ? part.slice(0, nl).trim() : "";
        const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, "");
        return (
          <CodeBlock
            key={i}
            code={code}
            lang={lang}
            className="my-1 overflow-x-auto rounded bg-well px-2 py-1.5 text-[14px] text-gray-200"
          />
        );
      })}
    </div>
  );
}
