import { useEffect, useState } from "react";
import { highlightToHtml } from "../util/highlight";

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
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
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
