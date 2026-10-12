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
// Light themes work the same way: the surfaces step away from the editor
// background in whichever direction there is room, and the text ramp below
// carries the rest of the app with it.

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
  /** Which way the surfaces run. Light themes need more than inverted
   *  colours: the whole 100-400 end of the Tailwind palette, written for
   *  dark backgrounds all over this app, has to move to its deep end. One
   *  attribute on <html> does that in CSS (see styles.css). */
  mode: "dark" | "light";
  /** The text ramp, strongest first. These land on Tailwind's grey scale,
   *  which is what the app's ~200 `text-gray-*` classes resolve through, so
   *  setting them here turns every one of them theme-driven without touching
   *  a single component. */
  textStrong: string;
  text: string;
  textSoft: string;
  textDim: string;
  /** Readable text on top of `accent` (accent-filled buttons). White is
   *  right on most accents and wrong on a pale one. */
  onAccent: string;
  /** The terminal's 16 ANSI colours, standard 0-7 then bright 8-15. A light
   *  background needs dark ink here or half of any command's output goes
   *  invisible. */
  ansi: string[];
}

/** Palette keys holding a single colour: everything but `mode` and `ansi`. */
const COLOUR_KEYS = [
  "chrome", "ink", "panel", "card", "well", "edge", "accent", "muted", "fg",
  "textStrong", "text", "textSoft", "textDim", "onAccent",
] as const;

/** The terminal's 16 colours when a theme states none of its own.
 *
 *  Two sets, because one cannot serve both: ink that reads on black is
 *  invisible on white and the other way round. The dark set is the one this
 *  app has always used; the light set is the GitHub light terminal palette,
 *  picked because it is designed for a white background and its bright half
 *  stays dark enough to read. */
const DARK_ANSI = [
  "#0b0e14", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
  "#414868", "#ff7a93", "#b9f27c", "#ff9e64", "#7da6ff", "#c0a6f7", "#b4f9f8", "#c0caf5",
];
const LIGHT_ANSI = [
  "#24292e", "#b31d28", "#22863a", "#9a6700", "#0366d6", "#6f42c1", "#1b7c83", "#6a737d",
  "#57606a", "#cb2431", "#1a7f37", "#7a5d00", "#0969da", "#8250df", "#116329", "#424a53",
];

/** The ANSI keys a VS Code theme uses, in palette order. */
const ANSI_KEYS = [
  "terminal.ansiBlack", "terminal.ansiRed", "terminal.ansiGreen", "terminal.ansiYellow",
  "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiCyan", "terminal.ansiWhite",
  "terminal.ansiBrightBlack", "terminal.ansiBrightRed", "terminal.ansiBrightGreen",
  "terminal.ansiBrightYellow", "terminal.ansiBrightBlue", "terminal.ansiBrightMagenta",
  "terminal.ansiBrightCyan", "terminal.ansiBrightWhite",
];

/** A theme the user can pick, by its Shiki id. */
export interface ThemeOption {
  id: string;
  label: string;
  mode: "dark" | "light";
}

/** The theme the app ships with: ours, not the VS Code theme it was drawn
 *  alongside. It used to be called "material-theme-palenight", which was
 *  honest about where the colours came from and misleading about what it
 *  resolved to; settingsStore migrates that saved value to this one. */
export const DEFAULT_THEME = "octo";

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
  mode: "dark",
  // Tailwind grey 100/200/300/400 spelled out. The app was written against
  // these exact values, so the default theme keeps them to the digit and
  // choosing it changes nothing about the shipped look.
  textStrong: "#f3f4f6",
  text: "#e5e7eb",
  textSoft: "#d1d5db",
  textDim: "#9ca3af",
  onAccent: "#ffffff",
  ansi: [...DARK_ANSI],
};

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

/** A shade of `base` that sits at `ratio` contrast from it, `dir` deciding
 *  which side: +1 lighter, -1 darker.
 *
 *  The hue is kept (this only mixes towards white or black) and the search is
 *  a bisection on the mix amount, because luma is not linear in it. When the
 *  ratio is out of reach -- 1.4:1 lighter than an almost-white editor -- it
 *  returns the furthest it got, which is the right answer: as separate as this
 *  background allows.
 */
function atRatio(base: Rgb, ratio: number, dir: 1 | -1): Rgb {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(shade(base, dir * mid), base) < ratio) lo = mid;
    else hi = mid;
  }
  return shade(base, dir * hi);
}

/** How far each surface sits from the reading surface, as a contrast ratio,
 *  and on which side of it. All of them are measured against `card`, the
 *  border included -- it is judged against the panel it is drawn on when the
 *  theme offers one of its own, but derived from the card like the rest.
 *
 *  The dark figures are the app's own palette measured: card to panel is
 *  1.22:1 there, card to the code well 1.32:1, and those relationships are
 *  what makes the window read as layers rather than as one sheet. Every
 *  derived theme is given the same relationships instead of the same
 *  percentages.
 *
 *  Light is not a mirror of it, in direction or in size. On a dark theme the
 *  frame sits above the editor in lightness and the code well below; on a
 *  light one the editor is already the brightest thing there, so everything
 *  structural sits under it and only the order among them is kept: titlebar
 *  closest to the content, then the bars, then the code wells, then the outer
 *  frame.
 *
 *  And they sit much closer together. A dark window is built out of layers of
 *  near-black, where 1.3:1 apart is a subtle step; the same 1.3:1 under white
 *  is a mid-grey, and a window of mid-greys reads as greyed out rather than
 *  as structured. Light interfaces are built the other way round, with
 *  surfaces close together and the lines between them doing the work, so the
 *  surfaces here are within 1.2:1 of the page and the border is the one thing
 *  that goes further. */
const LAYERS = {
  dark: { chrome: [1.054, -1], well: [1.323, -1], panel: [1.221, 1], ink: [1.416, 1], edge: [1.847, 1] },
  light: { chrome: [1.05, -1], panel: [1.09, -1], well: [1.14, -1], ink: [1.2, -1], edge: [1.45, -1] },
} as const;

/** Push `c` away from `on` until it reaches `target` contrast, or until the
 *  surface allows no better. `dir` is which way away is: +1 towards white,
 *  -1 towards black.
 *
 *  A target is a wish, not a promise. On Palenight's editor background the
 *  most contrast any text can have is 4.6:1, because the background itself
 *  is only so dark; demanding 5 there would just paint every theme's text
 *  pure white and throw away the thing we came for. So this walks towards
 *  the target and stops either when it arrives or when a step stops
 *  helping. */
function toContrast(c: Rgb, on: Rgb, target: number, dir: 1 | -1): Rgb {
  let out = c;
  for (let i = 0; i < 24 && contrast(out, on) < target; i++) {
    const next = shade(out, dir * 0.08);
    if (contrast(next, on) <= contrast(out, on) + 0.001) break;
    out = next;
  }
  return out;
}

/** Pull `c` towards `on` for a quieter shade, but no further than `floor`
 *  contrast. The opposite walk: we want it dimmer, and the floor is what
 *  stops dimmer from becoming invisible. */
function towards(c: Rgb, on: Rgb, amount: number, floor: number): Rgb {
  let out = mix(c, on, amount);
  for (let t = amount; t > 0 && contrast(out, on) < floor; t -= 0.04) {
    out = mix(c, on, Math.max(0, t - 0.04));
  }
  return out;
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
  const light = luma(editorBg) > 0.5;

  // Which way "away from the background" is for text: towards white on a dark
  // theme, towards black on a light one. The surfaces state their own
  // directions in LAYERS.
  const sign = light ? -1 : 1;

  // A near-black editor (Vitesse Black) cannot be darkened: #000 darkened is
  // still #000, and all five surfaces collapse into one. There the editor colour
  // becomes the code well, the darkest layer, and the ramp is built one step up
  // from it so the surfaces above still separate.
  //
  // White needs no such escape, and must not be given one. An almost-white
  // editor was being dimmed by 4% here so the surfaces had room above it, from
  // when they still went upwards on a light theme; they go downwards now, and
  // all that dimming did was leave a light window with no white in it, which is
  // most of what made the first attempt look like a filter over the app.
  const floored = luma(editorBg) < 0.04;
  const base = floored ? shade(editorBg, 0.07) : editorBg;
  const layer = LAYERS[light ? "light" : "dark"];
  const at = (k: keyof typeof layer) => atRatio(base, layer[k][0], layer[k][1]);

  const card = base;
  // A near-black editor keeps its own colour for the code well: it is already
  // the darkest thing we could produce, and the ramp was built one step up from
  // it precisely so this surface could be the original.
  const well = floored ? editorBg : at("well");
  const chrome = at("chrome");
  const panel = at("panel");
  const ink = at("ink");

  // Borders: the theme's own if it states one that reads as a border, otherwise
  // a step away from the base. The upper bound matters as much as the lower one:
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
    // Contrast rather than raw lightness for the lower bound: 0.02 of luma is
    // a visible step on a dark panel and nothing at all on a light one, which
    // is how the light themes first came out with borders you could not see.
    if (d < 0.2 && contrast(flat, panel) >= 1.25 && saturation(flat) < 0.55) {
      edge = flat;
      break;
    }
  }
  edge ??= atRatio(base, layer.edge[0], layer.edge[1]);

  // Accent: the colour the theme uses to say "this one". Taken from the first
  // key that holds something usable, where usable means colourful enough to read
  // as an accent and far enough from the surface to be seen on it. The paleness
  // test is what keeps Monokai's near-white cursor and Gruvbox's cream out of it
  // on dark themes, and a light theme's pastel wash out of it on light ones.
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
    const tooPale = light ? luma(flat) >= 0.62 : luma(flat) > 0.72;
    if (saturation(flat) >= 0.15 && !tooPale && contrast(flat, card) >= 2.2) {
      accent = flat;
      break;
    }
  }
  // Nothing usable: keep our violet, darkened on a light theme so it still reads
  // as a filled button rather than a pastel one.
  accent ??= light ? shade(parseHex(OCTO_PALETTE.accent)!, -0.3) : parseHex(OCTO_PALETTE.accent)!;

  // Text on an accent-filled button: whichever of white and near-black reads
  // better on this particular accent. A lightness threshold got this wrong in
  // the middle of the range, where Kanagawa and Tokyo Night sit: both are dark
  // enough to look like they want white and muted enough that white on them is
  // 1.8:1. Comparing the two candidates has no middle to get wrong.
  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const darkInk: Rgb = { r: 0x12, g: 0x14, b: 0x18, a: 1 };
  const onAccent = contrast(white, accent) >= contrast(darkInk, accent) ? white : darkInk;

  // The text ramp, Tailwind grey 100/200/300/400 as the app uses them:
  // headings, body, secondary, and the dimmest labels.
  //
  // The editor foreground is the body text, but only once it is legible on our
  // reading surface. A theme is free to put its text on a background we then
  // step away from, and several do (Solarized, Everforest, Horizon) at a
  // contrast that is fine in an editor and thin for a whole UI of small labels.
  // So it is pushed away from the surface towards 4.5:1 -- as far as the
  // surface allows, which on the lighter dark themes is less than that.
  const text = toContrast(fg, card, 4.5, sign);
  // Emphasis goes further the same way. The two quieter steps come back towards
  // the surface, by a proportion of what the body text managed rather than a
  // fixed amount: the same 16% pull that reads as "slightly quieter" on a dark
  // theme eats half the available contrast on a light one.
  const body = contrast(text, card);
  const textStrong = shade(text, sign * 0.3);
  const textSoft = towards(text, card, 0.16, Math.min(3.2, body * 0.72));
  const textDim = towards(text, card, 0.34, Math.min(2.4, body * 0.52));

  // Secondary text: the body text pulled towards the surface, far enough to read
  // as quieter but not so far it stops being legible.
  const muted = towards(text, card, 0.42, Math.min(2.6, body * 0.56));

  // The terminal. A theme that states its ANSI colours knows better than we do;
  // one that does not gets the set that suits its background.
  //
  // With one floor on top. Slots 0, 7, 8 and 15 are the greyscale ends and are
  // meant to be extreme, but the twelve hues in between are what colours every
  // diff, every test runner and every compiler error, and a handful of themes
  // state a hue that lands within 1.2:1 of their own background. In an editor
  // that colour is only ever used for syntax on a surface the author checked;
  // here it is output on ours. So each hue is walked away from the background
  // until it is at least readable, which leaves the themes that got it right
  // untouched.
  const fallback = light ? LIGHT_ANSI : DARK_ANSI;
  const greyscale = new Set([0, 7, 8, 15]);
  const ansi = ANSI_KEYS.map((k, i) => {
    const c = parseHex(colors[k]);
    if (!c) return fallback[i];
    const flat = flatten(c, card);
    return toHex(greyscale.has(i) ? flat : toContrast(flat, card, 2, sign));
  });

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
    mode: light ? "light" : "dark",
    textStrong: toHex(textStrong),
    text: toHex(text),
    textSoft: toHex(textSoft),
    textDim: toHex(textDim),
    onAccent: toHex(onAccent),
    ansi,
  };
}

/**
 * Adapt a colour picked for a dark window so it still reads on this one.
 *
 * Some colours cannot come from the palette: the eight identity colours a
 * project group is told apart by, the four status colours, the trace's two
 * ends. They mean something by being themselves and by staying the same
 * colour for the same thing, so they are not theme keys. They were all
 * picked against a near-black window, though, which is exactly where a pale
 * mint or a soft blue stops being visible on a light one.
 *
 * This keeps the hue and moves only the lightness, and only as far as it has
 * to: a colour that already reads on the surface comes back untouched. On the
 * app's own palette that is all twelve of them, so the shipped look does not
 * move. On a derived dark theme it is nearly all of them -- what it does catch
 * is the one or two that the theme's own background would have swallowed, the
 * idle grey on the lighter dark themes above all (Catppuccin Frappe, Nord,
 * Gruvbox Soft, Everforest). `target` is lower for a filled dot than for text,
 * because a solid 8px disc is visible at a ratio text would disappear at.
 */
export function adapt(hex: string, target = 2.6, p: Palette = current): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const card = parseHex(p.card);
  if (!card) return hex;
  return toHex(toContrast(flatten(c, card), card, target, p.mode === "light" ? -1 : 1));
}

// --- OctoShell's own themes -------------------------------------------------
//
// Deriving a palette from someone else's editor theme gets you a window that
// is tinted like that theme, which is not the same as a window designed in it.
// The hues are whatever the author chose for syntax, the accent is whatever
// key happened to hold something usable, and on a light background the whole
// thing reads as a wash laid over a dark interface. That path is still here,
// because someone arriving from VS Code wanting their editor's colours is a
// real thing to want, but it should not be the only thing on offer.
//
// These are ours. Each one states the four decisions that matter -- the
// surface you read on, the text, the accent, and which way round it is -- and
// goes through the same derivation as everything else, so the layering, the
// text ramp and the contrast floors are identical to a borrowed theme's and
// the same checks cover them.

interface BuiltinSpec {
  id: string;
  label: string;
  /** The reading surface. Everything else is derived from it. */
  bg: string;
  /** Body text, before the ramp adjusts it for legibility. */
  fg: string;
  accent: string;
  /** The bundled Shiki theme that colours code blocks under this one. Our
   *  palettes are not Shiki themes, so the highlighter needs a nearby one;
   *  what it must share is the background, or code sits in a hole. */
  shiki: string;
}

const BUILTIN_SPECS: BuiltinSpec[] = [
  {
    id: "octo",
    label: "OctoShell",
    // The palette the app was drawn against. Kept to the digit: this one is
    // not derived at all (see BUILTINS below), it is OCTO_PALETTE itself.
    bg: "#15181f",
    fg: "#babed8",
    accent: "#7c5cff",
    shiki: "material-theme-palenight",
  },
  {
    id: "octo-slate",
    label: "OctoShell Slate",
    // Cooler and plainer than the default: a neutral blue-grey with an azure
    // accent, for a window that is meant to recede.
    bg: "#16191e",
    fg: "#c3c9d4",
    accent: "#4cc2ff",
    shiki: "github-dark-dimmed",
  },
  {
    id: "octo-ember",
    label: "OctoShell Ember",
    // Warm dark. The same structure with the temperature turned round, for
    // anyone who finds blue-black screens cold at night.
    bg: "#17140f",
    fg: "#ded5c3",
    accent: "#e0a458",
    shiki: "vesper",
  },
  {
    id: "octo-paper",
    label: "OctoShell Paper",
    // Light, warm white, the brand violet kept as the accent so the app is
    // recognisably itself with the lights on.
    bg: "#faf8f3",
    fg: "#2b2a26",
    accent: "#6d4aff",
    shiki: "vitesse-light",
  },
  {
    id: "octo-daylight",
    label: "OctoShell Daylight",
    // Light and neutral: plain white, a working blue. The one to pick for a
    // bright room or a projector.
    bg: "#ffffff",
    fg: "#1f2430",
    accent: "#0b69d4",
    shiki: "github-light",
  },
  {
    id: "octo-sand",
    label: "OctoShell Sand",
    // Light and warm, off a cream page rather than a white one, which is
    // easier on the eyes over a long day than paper white.
    bg: "#f6f1e7",
    fg: "#332e24",
    accent: "#b4531f",
    shiki: "everforest-light",
  },
];

/** A spec, put through the ordinary derivation. Stating it as the three keys
 *  a VS Code theme would have is not a trick: those are the only keys the
 *  derivation reads anyway, so writing them out means our themes and borrowed
 *  ones go down one path, with one set of invariants over both. */
function builtinPalette(spec: BuiltinSpec): Palette {
  return paletteFrom({
    "editor.background": spec.bg,
    "editor.foreground": spec.fg,
    "textLink.foreground": spec.accent,
  });
}

export interface Builtin extends BuiltinSpec {
  palette: Palette;
}

export const BUILTINS: Builtin[] = BUILTIN_SPECS.map((spec) => ({
  ...spec,
  // The default is the hand-written palette rather than a derivation of its
  // own numbers. The two are close, but "close" is not what the app was built
  // against, and the shipped look should not move because the derivation was
  // improved.
  palette: spec.id === DEFAULT_THEME ? OCTO_PALETTE : builtinPalette(spec),
}));

export function builtin(id: string): Builtin | undefined {
  return BUILTINS.find((b) => b.id === id);
}

/** Every dark VS Code theme Shiki bundles, under the name its author gave it.
 *
 *  The list comes from Shiki rather than from us, so a Shiki upgrade that adds
 *  themes adds them here too. `bundledThemesInfo` is only ids, names and a lazy
 *  import per theme, so holding it costs nothing: no theme's colours load until
 *  one is picked.
 *
 *  Both kinds are offered. The label carries which one a theme is, because a
 *  name alone does not say it ("Vitesse", "Rose Pine Dawn") and picking a light
 *  theme by accident is a jarring thing to undo.
 *
 *  Ours come first, because they are the ones designed against this window
 *  rather than approximated from an editor. */
const BUNDLED: ThemeOption[] = bundledThemesInfo
  .map((t) => ({
    id: t.id,
    label: `${t.displayName} — ${t.type === "light" ? "light" : "dark"}`,
    mode: t.type === "light" ? ("light" as const) : ("dark" as const),
  }))
  .sort((a, b) =>
    a.mode !== b.mode ? (a.mode === "dark" ? -1 : 1) : a.label.localeCompare(b.label),
  );

export const THEMES: ThemeOption[] = [
  ...BUILTINS.map((b) => ({
    id: b.id,
    label: `${b.label}${b.id === DEFAULT_THEME ? " (default)" : ""} — ${b.palette.mode}`,
    mode: b.palette.mode,
  })),
  ...BUNDLED,
];

/** Which bundled Shiki theme colours the code blocks for a theme id. Ours say
 *  so in their spec; a Shiki theme is its own answer. */
export function shikiThemeFor(id: string): string {
  return builtin(id)?.shiki ?? id;
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

/** Our own eight surfaces, as styles.css declares them under `@theme`. */
const SURFACE_VARS = ["chrome", "ink", "panel", "card", "well", "edge", "accent", "muted"] as const;

/** Tailwind's grey scale, mapped onto the text ramp.
 *
 *  This is the whole trick behind theming the app's text. Tailwind 4 compiles
 *  `text-gray-200` to `color: var(--color-gray-200)`, and the app says
 *  `text-gray-100/200/300` in about two hundred places. Redefining those five
 *  variables therefore re-colours every one of them, in both directions, with
 *  no component touched: on a light theme `text-gray-100` resolves to near
 *  black and the headings stay headings. */
const GREY_MAP: [string, keyof Palette][] = [
  ["--color-gray-50", "textStrong"],
  ["--color-gray-100", "textStrong"],
  ["--color-gray-200", "text"],
  ["--color-gray-300", "textSoft"],
  ["--color-gray-400", "textDim"],
];

/** The CSS custom properties the palette maps onto, as styles.css declares
 *  them. Setting them on the root overrides the `@theme` defaults, so every
 *  `bg-card` / `border-edge` / `text-muted` in the app follows. */
export function applyPalette(p: Palette, root: HTMLElement = document.documentElement): void {
  for (const n of SURFACE_VARS) root.style.setProperty(`--color-${n}`, p[n]);
  for (const [v, k] of GREY_MAP) root.style.setProperty(v, p[k] as string);
  root.style.setProperty("--octo-fg", p.fg);
  root.style.setProperty("--color-onaccent", p.onAccent);
  // The terminal colours as CSS too, not only as xterm options: finished
  // commands keep their output as HTML that points at these (see util/ansi),
  // so setting them here re-colours the whole scrollback.
  p.ansi.forEach((c, i) => root.style.setProperty(`--ansi-${i}`, c));
  // The one thing CSS has to know rather than be told colour by colour: the
  // 100-400 end of every Tailwind hue (red-300 for errors, amber-300 for
  // warnings) was chosen for a dark background, and on a light one it has to
  // move to the deep end of the same hue. styles.css does that under this
  // attribute, which is cheaper and more legible than overriding forty
  // variables from here.
  root.dataset.palette = p.mode;
}

/** Put the whole `@theme` palette back, by dropping our overrides. */
export function clearPalette(root: HTMLElement = document.documentElement): void {
  for (const n of SURFACE_VARS) root.style.removeProperty(`--color-${n}`);
  for (const [v] of GREY_MAP) root.style.removeProperty(v);
  root.style.removeProperty("--octo-fg");
  root.style.removeProperty("--color-onaccent");
  for (let i = 0; i < 16; i++) root.style.removeProperty(`--ansi-${i}`);
  delete root.dataset.palette;
}

/** The palette as xterm wants it.
 *
 *  xterm takes colours as values, not through CSS, so the whole set has to
 *  be handed over: the two surfaces, the cursor, the selection, and all 16
 *  ANSI slots. The ANSI set is the part that matters on a light theme --
 *  without it every `ls` and every compiler's red error text is drawn in
 *  ink meant for a black background, on white. */
export function xtermTheme(p: Palette): Record<string, string> {
  const [black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue,
    brightMagenta, brightCyan, brightWhite] = p.ansi;
  return {
    background: p.card,
    foreground: p.fg,
    cursor: p.accent,
    cursorAccent: p.card,
    // Selection is drawn over text, so it has to be a wash rather than a
    // fill; xterm blends this one itself.
    selectionBackground: `${p.accent}59`,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue,
    brightMagenta, brightCyan, brightWhite,
  };
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
    // Every key must hold what its kind says: a half-written cache, or one
    // written by an older version of this code, should do nothing rather than
    // paint a broken window.
    if (!COLOUR_KEYS.every((k) => typeof saved[k] === "string" && parseHex(saved[k]))) return;
    if (saved.mode !== "dark" && saved.mode !== "light") return;
    if (!Array.isArray(saved.ansi) || saved.ansi.length !== 16) return;
    if (!saved.ansi.every((c) => typeof c === "string" && parseHex(c))) return;
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
  // One of ours is already a palette; a bundled one has to be loaded and
  // derived.
  const ours = builtin(id);
  const palette = ours ? ours.palette : paletteOf(await loadThemeFile(id));
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
