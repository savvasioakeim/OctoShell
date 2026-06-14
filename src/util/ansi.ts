// Utilities for turning a terminal buffer snapshot (produced by xterm's
// SerializeAddon) into selectable, colored HTML — and stripping ANSI for
// plain-text copy / AI context.

/** Decode base64 → bytes (preserves multibyte UTF-8 across PTY chunks). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Remove all escape sequences, leaving plain text. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

const DEFAULT_FG = "#A6ACCD"; // matches the live xterm foreground (Palenight)
const DEFAULT_BG = "#15181F"; // matches `card` (only used for inverse text)

// Standard + bright 16-color palette (0–15).
const BASE16 = [
  "#0b0e14", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
  "#414868", "#ff7a93", "#b9f27c", "#ff9e64", "#7da6ff", "#c0a6f7", "#b4f9f8", "#c0caf5",
];

function color256(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
    const c = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function freshState(): SgrState {
  return { bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function applySgr(state: SgrState, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(state, freshState());
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 7) state.inverse = true;
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 27) state.inverse = false;
    else if (c >= 30 && c <= 37) state.fg = BASE16[c - 30];
    else if (c === 39) state.fg = undefined;
    else if (c >= 40 && c <= 47) state.bg = BASE16[c - 40];
    else if (c === 49) state.bg = undefined;
    else if (c >= 90 && c <= 97) state.fg = BASE16[c - 90 + 8];
    else if (c >= 100 && c <= 107) state.bg = BASE16[c - 100 + 8];
    else if (c === 38 || c === 48) {
      // Extended color: 38;5;n  or  38;2;r;g;b
      const target = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) { state[target] = color256(codes[i + 2]); i += 2; }
      else if (codes[i + 1] === 2) { state[target] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

function styleOf(state: SgrState): string {
  // Note: background colors are intentionally NOT rendered in frozen output.
  // PowerShell's formatted listings (e.g. Get-ChildItem) paint directory names
  // with a blue background that, combined with cursor-positioning, smears across
  // the line and looks like everything is selected. Foreground colors carry the
  // useful information and keep the feed clean.
  const fg = state.inverse ? DEFAULT_BG : state.fg ?? DEFAULT_FG;
  const bg = state.inverse ? state.fg ?? DEFAULT_FG : undefined;
  const parts = [`color:${fg}`];
  if (bg) parts.push(`background:${bg}`);
  if (state.bold) parts.push("font-weight:bold");
  if (state.dim) parts.push("opacity:.7");
  if (state.italic) parts.push("font-style:italic");
  if (state.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

/**
 * Convert an ANSI snapshot (only SGR sequences + text, as emitted by
 * SerializeAddon.serialize()) into HTML wrapped in a <pre>. Result is fully
 * selectable, so copy-paste behaves like a text editor across blocks.
 */
export function ansiToHtml(input: string): string {
  const state = freshState();
  let html = "";
  let text = "";

  const flush = () => {
    if (!text) return;
    html += `<span style="${styleOf(state)}">${escapeHtml(text)}</span>`;
    text = "";
  };

  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    text += input.slice(last, m.index);
    last = re.lastIndex;
    if (m[1] !== undefined) {
      flush();
      const codes = m[1] === "" ? [0] : m[1].split(";").map((n) => parseInt(n, 10) || 0);
      applySgr(state, codes);
    }
    // non-SGR sequences are dropped
  }
  text += input.slice(last);
  flush();
  return `<pre class="block-frozen">${html}</pre>`;
}
