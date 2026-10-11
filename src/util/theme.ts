// The app's colour theme, taken from a VS Code theme.
//
// We already ship Shiki for code highlighting, and a Shiki theme is a real VS
// Code theme: a `colors` map with a couple of hundred editor keys. So the same
// file that colours a code block can colour the whole window, and someone
// arriving from VS Code can have OctoShell look like the editor they already
// know.
//
// We do NOT read those keys one by one. A theme fills in whichever of the 200
// keys its author cared about, so `panel.background` or `editorGroup.border` is
// often missing or a translucent overlay, and an app built straight off them
// comes out different in kind from theme to theme. Instead we take the two keys
// every theme really defines -- the editor's background and foreground -- and
// derive our five surfaces from them by lightness, which is how our own palette
// was built in the first place. Accent and border come from the theme when it
// states them opaquely, and fall back to a derived value when it does not.
//
// Dark themes only, deliberately: see `THEMES` below.

import { bundledThemesInfo } from "shiki/themes";

/** Our palette: the eight `@theme` colours in styles.css, in the same words.
 *  Surfaces darkest first: well · chrome · card · panel · ink. */
export interface Palette {
  chrome: string;
  ink: string;
  panel: string;
  card: string;
  well: string;
  edge: string;
  accent: string;
  muted: string;
  /** The editor foreground, for the terminal and anything drawing raw text. */
  fg: string;
}

/** A theme the user can pick, by its Shiki id. */
export interface ThemeOption {
  id: string;
  label: string;
}

/** The theme the app ships with. */
export const DEFAULT_THEME = "material-theme-palenight";

/** OctoShell's own palette, the one written by hand in styles.css against
 *  Palenight. The default theme resolves to exactly this rather than to a
 *  derivation of it, so choosing the default is choosing the app's own look --
 *  including the violet accent, which comes from the worktree gradient and not
 *  from any VS Code key. */
export const OCTO_PALETTE: Palette = {
  chrome: "#14161c",
  ink: "#232734",
  panel: "#1c202b",
  card: "#15181f",
  well: "#0d0f14",
  edge: "#313747",
  accent: "#7c5cff",
  muted: "#8087a8",
  fg: "#babed8",
};

/** Every dark VS Code theme Shiki bundles, under the name its author gave it.
 *
 *  The list comes from Shiki rather than from us, so a Shiki upgrade that adds
 *  themes adds them here too. `bundledThemesInfo` is only ids, names and a lazy
 *  import per theme, so holding it costs nothing: no theme's colours load until
 *  one is picked.
 *
 *  Light themes are filtered out on purpose rather than forgotten. The app's
 *  text colours are still around two hundred hardcoded light-on-dark Tailwind
 *  greys, so a light background would leave most of the UI unreadable, and
 *  offering it would be offering something broken. Making those theme-driven is
 *  the separate piece of work that light themes wait on. */
export const THEMES: ThemeOption[] = bundledThemesInfo
  .filter((t) => t.type === "dark")
  .map((t) => ({
    id: t.id,
    label: t.id === DEFAULT_THEME ? `${t.displayName} (default)` : t.displayName,
  }))
  .sort((a, b) => (a.id === DEFAULT_THEME ? -1 : b.id === DEFAULT_THEME ? 1 : a.label.localeCompare(b.label)));

export function isKnownTheme(id: string): boolean {
  return THEMES.some((t) => t.id === id);
}

// --- colour arithmetic -----------------------------------------------------
// Small and local on purpose: a colour library would be a dependency for forty
// lines of lightness maths.

interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0..1; VS Code themes use #rrggbbaa freely, and we have to flatten it. */
  a: number;
}

/** Parse #rgb, #rgba, #rrggbb or #rrggbbaa. Null for anything else. */
export function parseHex(hex: string | undefined): Rgb | null {
  if (!hex) return null;
  const h = hex.trim().replace(/^#/, "");
  const short = h.length === 3 || h.length === 4;
  if (!short && h.length !== 6 && h.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  const at = (i: number) => {
    const s = short ? h[i].repeat(2) : h.slice(i * 2, i * 2 + 2);
    return parseInt(s, 16);
  };
  const a = (short ? h.length === 4 : h.length === 8) ? at(3) / 255 : 1;
  return { r: at(0), g: at(1), b: at(2), a };
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
const toHex = (c: Rgb) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** Blend `top` over `bottom` by `top`'s alpha. A translucent theme key only
 *  means anything once it sits on the surface it was drawn over. */
function flatten(top: Rgb, bottom: Rgb): Rgb {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** Mix two colours, `t` = 0 is all `a`, 1 is all `b`. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
}

/** Perceived lightness, 0..1 (sRGB luma — good enough to rank surfaces). */
function luma(c: Rgb): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/** Lighten (`t` > 0) or darken (`t` < 0) towards white or black, keeping hue.
 *  Scaled by how dark the colour already is, so a near-black base still
 *  separates into distinct surfaces instead of five identical ones. */
function shade(c: Rgb, t: number): Rgb {
  const target: Rgb = t > 0 ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
  return mix(c, target, Math.abs(t));
}

/** Contrast ratio between two colours, the WCAG shape of it (1 = identical). */
function contrast(a: Rgb, b: Rgb): number {
  const l1 = luma(a) + 0.05;
  const l2 = luma(b) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

/** How colourful, 0..1 (HSL saturation). Used to tell a theme's signature
 *  colour from the grey it uses for chrome. */
function saturation(c: Rgb): number {
  const max = Math.max(c.r, c.g, c.b) / 255;
  const min = Math.min(c.r, c.g, c.b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}

// --- deriving the palette --------------------------------------------------

/** The subset of a VS Code theme we read. */
export interface ThemeColors {
  [key: string]: string | undefined;
}

/**
 * Turn a VS Code theme's colours into our palette.
 *
 * The editor background is our reading surface (`card`), because that is the
 * surface the theme was designed to be read on. Everything else steps away from
 * it by lightness, in the order our own palette uses: the code well sinks
 * below, the titlebar sits below the panels, and the frame sits above them. A
 * theme that happens to state a panel or sidebar colour is still ignored here,
 * so the five surfaces keep their relationship whatever the theme fills in.
 */
export function paletteFrom(colors: ThemeColors): Palette {
  const editorBg = parseHex(colors["editor.background"]) ?? { r: 0x15, g: 0x18, b: 0x1f, a: 1 };
  const fg = parseHex(colors["editor.foreground"]) ?? { r: 0xba, g: 0xbe, b: 0xd8, a: 1 };
  // A near-black editor (Vitesse Black) cannot be darkened: #000 darkened is
  // still #000, and all five surfaces collapse into one. There the editor colour
  // becomes the code well, the darkest layer, and the ramp is built one step up
  // from it so the surfaces above still separate.
  const base = luma(editorBg) < 0.04 ? shade(editorBg, 0.07) : editorBg;
  // A dark base has little room below it, so the ramp leans upwards; a lighter
  // one (Nord, Gruvbox Soft) has room both ways.
  const deep = luma(base) < 0.12;

  const card = base;
  const well = luma(editorBg) < 0.04 ? editorBg : shade(base, deep ? -0.35 : -0.45);
  const chrome = shade(base, deep ? -0.18 : -0.28);
  const panel = shade(base, deep ? 0.07 : 0.05);
  const ink = shade(base, deep ? 0.14 : 0.1);

  // Borders: the theme's own if it states one we can see against the panels,
  // otherwise a step up from the base. `editorGroup.border` is often a black or
  // white overlay, which flattening resolves into something usable.
  // Borders: the theme's own if it states one that reads as a border, otherwise
  // a step up from the base. The upper bound matters as much as the lower one:
  // Dracula puts its signature purple in `editorGroup.border`, and taking that
  // literally outlines every panel in neon. A border separates surfaces, so it
  // has to differ from them a little and not a lot.
  const borderKeys = ["panel.border", "editorGroup.border", "editorWidget.border", "input.border"];
  let edge: Rgb | null = null;
  for (const k of borderKeys) {
    const c = parseHex(colors[k]);
    if (!c) continue;
    const flat = flatten(c, panel);
    const d = Math.abs(luma(flat) - luma(panel));
    if (d > 0.02 && d < 0.2 && saturation(flat) < 0.55) {
      edge = flat;
      break;
    }
  }
  edge ??= shade(base, deep ? 0.26 : 0.2);

  // Accent: the colour the theme uses to say "this one". Taken from the first
  // key that holds something usable, where usable means colourful enough to read
  // as an accent and not so pale it reads as text. That second test is what
  // keeps Monokai's near-white cursor and Gruvbox's cream out of it, and lets
  // Dracula's pink badge through instead of the grey-blue in its focus ring.
  const accentKeys = [
    "textLink.foreground",
    "editorCursor.foreground",
    "activityBarBadge.background",
    "button.background",
    "progressBar.background",
    "focusBorder",
    "editorGroup.border",
  ];
  let accent: Rgb | null = null;
  for (const k of accentKeys) {
    const c = parseHex(colors[k]);
    if (!c) continue;
    const flat = flatten(c, card);
    if (saturation(flat) >= 0.15 && luma(flat) <= 0.72 && contrast(flat, card) >= 2.2) {
      accent = flat;
      break;
    }
  }
  // Nothing usable: keep our violet, which reads on any dark surface.
  accent ??= parseHex(OCTO_PALETTE.accent)!;

  // Secondary text: the foreground pulled towards the surface, far enough to
  // read as quieter but not so far it stops being legible. Themes whose
  // foreground is already close to their background (Solarized, Everforest) get
  // less of the pull rather than an unreadable grey.
  let muted = mix(fg, card, 0.42);
  for (let t = 0.42; t > 0 && contrast(muted, card) < 2.6; t -= 0.07) {
    muted = mix(fg, card, Math.max(0, t - 0.07));
  }

  return {
    chrome: toHex(chrome),
    ink: toHex(ink),
    panel: toHex(panel),
    card: toHex(card),
    well: toHex(well),
    edge: toHex(edge),
    accent: toHex(accent),
    muted: toHex(muted),
    fg: toHex(fg),
  };
}

// --- loading and applying --------------------------------------------------

/** A Shiki theme file, as much of it as we care about. */
interface ShikiTheme {
  colors?: ThemeColors;
  type?: string;
}

const loaded = new Map<string, Promise<ShikiTheme | null>>();

/** Load one theme's colours, through the lazy import Shiki ships with it. Each
 *  theme is its own chunk, so picking one costs a single small load and the
 *  other forty never arrive. Cached, because the highlighter asks for the same
 *  file the palette just used. */
export function loadThemeFile(id: string): Promise<ShikiTheme | null> {
  let p = loaded.get(id);
  if (!p) {
    const entry = bundledThemesInfo.find((t) => t.id === id);
    p = entry
      ? entry.import().then((m) => m.default as ShikiTheme).catch(() => null)
      : Promise.resolve(null);
    loaded.set(id, p);
  }
  return p;
}

/** The CSS custom properties the palette maps onto, as styles.css declares
 *  them. Setting them on the root overrides the `@theme` defaults, so every
 *  `bg-card` / `border-edge` / `text-muted` in the app follows. */
export function applyPalette(p: Palette, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--color-chrome", p.chrome);
  root.style.setProperty("--color-ink", p.ink);
  root.style.setProperty("--color-panel", p.panel);
  root.style.setProperty("--color-card", p.card);
  root.style.setProperty("--color-well", p.well);
  root.style.setProperty("--color-edge", p.edge);
  root.style.setProperty("--color-accent", p.accent);
  root.style.setProperty("--color-muted", p.muted);
  root.style.setProperty("--octo-fg", p.fg);
}

/** Put the whole `@theme` palette back, by dropping our overrides. */
export function clearPalette(root: HTMLElement = document.documentElement): void {
  for (const n of ["chrome", "ink", "panel", "card", "well", "edge", "accent", "muted"]) {
    root.style.removeProperty(`--color-${n}`);
  }
  root.style.removeProperty("--octo-fg");
}

// --- what is painted right now ----------------------------------------------
// Not everything reads colours through CSS. xterm takes its background and
// foreground as JavaScript values, and it is long-lived, so it has to be told
// when the palette changes rather than re-created. Hence a tiny store: the
// palette in force, and whoever wants to hear about the next one.

let current: Palette = OCTO_PALETTE;
const listeners = new Set<(p: Palette) => void>();

/** Where the last applied palette is kept, so the next launch can paint it
 *  before React mounts. Deliberately not in the settings store: this is a cache
 *  of a derived result, and the setting itself is the theme's id. */
const CACHE_KEY = "octoshell.theme.palette";

/**
 * Paint the palette from the previous run, synchronously.
 *
 * A theme is a lazy chunk, so resolving the chosen one takes a moment, and
 * until it lands the window shows the stylesheet's own colours. For anyone on a
 * theme of their own that is a flash of the wrong palette on every single
 * launch. The previous result is a sound guess at the next one, so it goes up
 * first and the real load either confirms it or corrects it a moment later.
 *
 * Call before the first render. Safe to call with nothing stored.
 */
export function applyCachedPalette(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Palette>;
    // Every key must be a colour we recognise: a half-written or hand-edited
    // cache should do nothing rather than paint a broken window.
    const keys = Object.keys(OCTO_PALETTE) as (keyof Palette)[];
    if (!keys.every((k) => typeof saved[k] === "string" && parseHex(saved[k]))) return;
    current = saved as Palette;
    applyPalette(current);
  } catch {
    /* no storage, or nothing valid in it: the stylesheet's palette stands */
  }
}

/** The palette in force. Correct from the first paint: the default is what the
 *  stylesheet already says, so a reader before any theme loads is not wrong. */
export function currentPalette(): Palette {
  return current;
}

/** Hear about every palette change, including the one at startup. Returns the
 *  unsubscribe, so a disposed terminal stops being notified. */
export function onPalette(cb: (p: Palette) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Load a theme and paint it. Resolves to the palette actually applied, or null
 *  when the theme could not be loaded (the current look is then left alone). */
export async function applyTheme(id: string): Promise<Palette | null> {
  const palette =
    // The default is the app's own palette, not a derivation of it.
    id === DEFAULT_THEME ? OCTO_PALETTE : paletteOf(await loadThemeFile(id));
  if (!palette) return null;
  applyPalette(palette);
  current = palette;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(palette));
  } catch {
    /* a full or blocked localStorage only costs the next launch its head start */
  }
  listeners.forEach((l) => l(palette));
  return palette;
}

function paletteOf(theme: { colors?: ThemeColors } | null): Palette | null {
  return theme?.colors ? paletteFrom(theme.colors) : null;
}
