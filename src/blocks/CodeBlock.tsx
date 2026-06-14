import { useEffect, useState } from "react";
import { highlightToHtml, peekHighlight } from "../util/highlight";

interface Props {
  code: string;
  /** Language hint (fence label, "bash", "json", a file extension…). */
  lang: string;
  /** Extra classes for the wrapper (padding, scroll, background). */
  className?: string;
}

/**
 * A code snippet with VS-Code-style (Shiki/Palenight) highlighting. Renders the
 * plain code immediately, then swaps in the colored HTML once Shiki resolves —
 * so it never blocks and degrades gracefully if highlighting is unavailable.
 */
export function CodeBlock({ code, lang, className }: Props) {
  // Seed from the cache so an already-highlighted block (e.g. after a project
  // switch or a virtualization remount) paints colored immediately — no async
  // round-trip, no plain-text flash.
  const [html, setHtml] = useState<string | null>(() => peekHighlight(code, lang) ?? null);

  useEffect(() => {
    const cached = peekHighlight(code, lang);
    if (cached !== undefined) {
      setHtml(cached); // hit (highlighted HTML or null for plain) — no work
      return;
    }
    let alive = true;
    setHtml(null);
    void highlightToHtml(code, lang).then((h) => { if (alive) setHtml(h); });
    return () => { alive = false; };
  }, [code, lang]);

  if (html) {
    return (
      <div
        className={`octo-code ${className ?? ""}`}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <pre className={className}>{code}</pre>;
}
