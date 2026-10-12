// Lazy, singleton Shiki highlighter for CODE (not raw terminal output — that
// already carries the program's own ANSI colors via ansiToHtml).
//
// We use Shiki's FINE-GRAINED core: only the ~14 grammars we need + the
// JavaScript regex engine (no WASM, no full-bundle that pulls every language).
// Everything is behind a lazy dynamic import, so nothing loads until the first
// code block renders. The theme is whichever VS Code theme the Appearance
// settings name, the same file the window's palette is derived from, so a
// code block and the app around it always come from one theme.
// Any failure falls back to plain text — highlighting is never load-bearing.

import type { HighlighterCore, LanguageInput, ThemeInput } from "shiki/core";
import { DEFAULT_THEME, loadThemeFile, shikiThemeFor } from "./theme";

/** The theme the highlighter is currently colouring with. Shiki needs the
 *  theme's own name when highlighting, and it has to be one it has loaded. */
// The Shiki theme in force. Not the same string as the app theme: ours are
// not Shiki themes, so each names a bundled one to highlight code with.
let theme = shikiThemeFor(DEFAULT_THEME);
/** Bumped on every theme change, so a mounted code block can notice that what
 *  it is showing was coloured by the previous theme. */
let generation = 0;
const themeListeners = new Set<() => void>();

/** Subscribe to theme changes (for `useSyncExternalStore`). */
export function subscribeHighlightTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

/** A value that changes whenever the highlighting theme does. */
export function highlightGeneration(): number {
  return generation;
}

/**
 * Switch the highlighting theme. Loads the theme into the highlighter if it is
 * already running, empties the memo cache (every entry in it was coloured by
 * the old theme) and tells the mounted blocks to ask again.
 *
 * Best-effort: a theme that will not load leaves the current one in place,
 * because half-recoloured code is worse than code in the previous theme.
 */
export async function setHighlightTheme(id: string): Promise<void> {
  // The app theme, mapped to the Shiki theme that goes with it. One of ours
  // is not a Shiki theme at all, so asking for it by name would load nothing
  // and leave code blocks in the previous theme, which on a light window means
  // a dark hole where the code is.
  const shiki = shikiThemeFor(id);
  if (shiki === theme) return;
  if (highlighter) {
    const file = await loadThemeFile(shiki);
    if (!file) return;
    try {
      await highlighter.loadTheme(file as ThemeInput);
    } catch {
      return;
    }
  }
  theme = shiki;
  cache.clear();
  generation++;
  themeListeners.forEach((l) => l());
}

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
      const [core, engine, themeFile, ...langs] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        // Whichever theme is selected by the time the first code block renders.
        loadThemeFile(theme).then((f) => f ?? import("shiki/themes/material-theme-palenight.mjs").then((m) => m.default)),
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
        themes: [themeFile as ThemeInput],
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

// Memoize highlighted output. Shiki's `codeToHtml` is synchronous CPU work, and
// the same block re-highlights every time it remounts — which happens a LOT:
// virtualization remounts on scroll, and a project switch remounts the whole
// feed. Caching makes those instant (and lets callers render the result
// synchronously on mount, with no plain-text flash). Bounded so it can't grow
// without limit over a long session.
const MAX_CACHE = 1200;
const cache = new Map<string, string | null>();
const cacheKey = (code: string, lang: string) => `${normalizeLang(lang)} ${code}`;

/**
 * Synchronously return a previously-computed highlight result. `undefined` means
 * "not computed yet" (caller should await [`highlightToHtml`]); `string`/`null`
 * are the cached result (highlighted HTML, or null for plain text).
 */
export function peekHighlight(code: string, lang: string): string | null | undefined {
  return cache.get(cacheKey(code, lang));
}

function cacheSet(key: string, val: string | null): void {
  if (cache.size >= MAX_CACHE) {
    // Map preserves insertion order — drop the oldest entry.
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, val);
}

// Idle-scheduled highlight queue. `codeToHtml` is synchronous CPU work; running
// it for every block the instant it mounts (a project switch or a scroll burst
// can mount dozens at once) stalls the main thread and freezes scroll/typing.
// Instead we render plain text immediately and colorize during browser idle
// time, a bounded slice at a time, so the UI never blocks. Cached results make
// every re-view instant, so this cost is paid at most once per unique block.
interface Job {
  key: string;
  code: string;
  lang: string; // already normalized
  resolve: (v: string | null) => void;
}

const queue: Job[] = [];
let highlighter: HighlighterCore | null = null;
let draining = false;

const onIdle: (cb: (d: IdleDeadline) => void) => void =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 250 })
    : (cb) => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 8 } as IdleDeadline), 16);

function drain(deadline: IdleDeadline): void {
  // Always make progress on at least one job, then keep going only while there's
  // idle budget left — so a big backlog spreads across frames instead of locking
  // up one. A single `codeToHtml` can't be preempted, hence the per-item cap.
  do {
    const job = queue.shift();
    if (!job) break;
    const hit = cache.get(job.key);
    if (hit !== undefined) {
      job.resolve(hit);
      continue;
    }
    let result: string | null = null;
    try {
      result = highlighter!.codeToHtml(job.code, { lang: job.lang, theme });
    } catch {
      result = null;
    }
    cacheSet(job.key, result);
    job.resolve(result);
  } while (queue.length && (deadline.didTimeout || deadline.timeRemaining() > 6));

  if (queue.length) onIdle(drain);
  else draining = false;
}

async function startDraining(): Promise<void> {
  if (draining) return;
  draining = true;
  if (!highlighter) {
    try {
      highlighter = await getHighlighter();
    } catch {
      // Highlighter unavailable: settle the whole backlog as plain text.
      draining = false;
      let job: Job | undefined;
      while ((job = queue.shift())) {
        cacheSet(job.key, null);
        job.resolve(null);
      }
      return;
    }
  }
  onIdle(drain);
}

/**
 * Highlight `code` as `lang`, returning Shiki's `<pre class="shiki">…</pre>`.
 * Returns null when there's nothing to do (unknown lang, too large, or error),
 * signalling the caller to render plain text instead. Results are memoized and
 * the actual highlighting runs during idle time (see the queue above).
 */
export function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const l = normalizeLang(lang);
  if (l === "text" || code.length > MAX_HIGHLIGHT_CHARS) {
    cacheSet(key, null);
    return Promise.resolve(null);
  }

  return new Promise<string | null>((resolve) => {
    queue.push({ key, code, lang: l, resolve });
    void startDraining();
  });
}
