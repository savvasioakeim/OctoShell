// Lazy, singleton Shiki highlighter for CODE (not raw terminal output — that
// already carries the program's own ANSI colors via ansiToHtml).
//
// We use Shiki's FINE-GRAINED core: only the ~14 grammars we need + the
// JavaScript regex engine (no WASM, no full-bundle that pulls every language).
// Everything is behind a lazy dynamic import, so nothing loads until the first
// code block renders. Theme is Material Theme Palenight (the user's VS Code).
// Any failure falls back to plain text — highlighting is never load-bearing.

import type { HighlighterCore, LanguageInput } from "shiki/core";

const THEME = "material-theme-palenight";

const LANGS = [
  "bash", "powershell", "typescript", "tsx", "javascript", "jsx",
  "json", "css", "html", "python", "rust", "markdown", "diff", "yaml",
] as const;

/** Don't highlight enormous blobs — past this we just show plain text. */
const MAX_HIGHLIGHT_CHARS = 20_000;

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [core, engine, palenight, ...langs] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/material-theme-palenight.mjs"),
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/powershell.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/jsx.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/diff.mjs"),
        import("shiki/langs/yaml.mjs"),
      ]);
      return core.createHighlighterCore({
        themes: [palenight.default],
        langs: langs.map((m) => (m as { default: LanguageInput }).default),
        engine: engine.createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

const ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash",
  ps: "powershell", ps1: "powershell", pwsh: "powershell",
  ts: "typescript", js: "javascript", py: "python", rs: "rust",
  yml: "yaml", md: "markdown",
};

/** Map a free-form language hint (fence label, file ext) to a loaded grammar. */
export function normalizeLang(hint: string): string {
  const l = (hint || "").trim().toLowerCase();
  if (ALIASES[l]) return ALIASES[l];
  return (LANGS as readonly string[]).includes(l) ? l : "text";
}

/**
 * Highlight `code` as `lang`, returning Shiki's `<pre class="shiki">…</pre>`.
 * Returns null when there's nothing to do (unknown lang, too large, or error),
 * signalling the caller to render plain text instead.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const l = normalizeLang(lang);
  if (l === "text" || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const hl = await getHighlighter();
    return hl.codeToHtml(code, { lang: l, theme: THEME });
  } catch {
    return null;
  }
}
