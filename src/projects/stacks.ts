// What OctoShell knows about project stacks: how to recognise one, and what its
// dev/test/build commands are.
//
// This knowledge used to live in three places, in three languages: regexes in
// serviceDetect.ts, a PowerShell probe embedded in a TypeScript string literal in
// MacroBar.tsx, and package-manager detection in service.rs. Teaching OctoShell
// about a new stack meant finding all three — and the PowerShell-in-a-string one
// was unreadable, untestable and impossible to extend from outside.
//
// Now a stack is one object. Detection is data (marker files), the shell probe is
// GENERATED from that data rather than hand-written (for both script shells, in
// shellScripts.ts), and the decision is made in TypeScript where it can be read
// and tested.

import { stackProbeScript } from "../platform/shellScripts";

/** One project stack: how to spot it, and what to run in it. */
export interface StackDef {
  /** Stable id. */
  id: string;
  /** Shown to the user when we name the stack. */
  label: string;
  /** Files that identify this stack. Any one of them present is a match; they're
   *  checked in the order stacks are listed, so put the more specific first. */
  markers: string[];
  /** Test command. Omit when the stack has no conventional one. */
  test?: string;
  /** A package.json script that must EXIST for `test` to be valid. Without it,
   *  `npm test` on a project with no test script just fails confusingly. */
  requiresPackageScript?: string;
  /** Command fragments meaning "a long-running server that never returns", so
   *  OctoShell can offer to run it as a managed service instead of wedging a
   *  shell or an agent turn. */
  serverPatterns?: RegExp[];
}

/** THE stack table. Order matters for detection: first match wins. */
export const STACKS: StackDef[] = [
  {
    id: "node",
    label: "Node / JavaScript",
    markers: ["package.json"],
    test: "npm test",
    requiresPackageScript: "test",
    serverPatterns: [
      /\bnpm\s+(run\s+)?(dev|start|serve|preview)\b/i,
      /\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b/i,
      /\bnext\s+(dev|start)\b/i,
      /\bvite\b(?!\s+build)/i, // `vite` / `vite preview`, but not `vite build`
      /\bnuxt\s+(dev|start)\b/i,
      /\b(ng|astro|remix|gatsby)\s+(dev|serve|start)\b/i,
      /\breact-scripts\s+start\b/i,
      /\bnode\s+\S*server\S*\.(js|mjs|cjs|ts)\b/i,
      /\bnodemon\b/i,
    ],
  },
  {
    id: "rust",
    label: "Rust",
    markers: ["Cargo.toml"],
    test: "cargo test",
  },
  {
    id: "python",
    label: "Python",
    markers: ["pyproject.toml", "pytest.ini", "setup.py"],
    test: "pytest",
    serverPatterns: [
      /\b(uvicorn|gunicorn|flask\s+run|python\s+-m\s+http\.server|manage\.py\s+runserver)\b/i,
    ],
  },
  {
    id: "go",
    label: "Go",
    markers: ["go.mod"],
    test: "go test ./...",
  },
  {
    id: "ruby",
    label: "Ruby",
    markers: ["Gemfile"],
    serverPatterns: [/\brails\s+s(erver)?\b/i],
  },
  {
    id: "php",
    label: "PHP",
    markers: ["composer.json"],
    serverPatterns: [/\bphp\s+-S\b/i],
  },
];

/** Server commands that belong to no particular stack — plain static servers a
 *  user may run in any project. Kept apart so they aren't mistaken for evidence
 *  of a stack. */
const GENERIC_SERVER_PATTERNS: RegExp[] = [/\b(http-server|serve)\b/i];

/** Built-ins plus whatever enabled mods contribute. Mods come AFTER, so a mod can
 *  add a stack but never shadow a built-in one for the same marker — the built-in
 *  match still wins. Resolved on each call rather than cached: mods can be toggled
 *  at runtime, and these lists are tiny. */
export function allStacks(): StackDef[] {
  return [...STACKS, ...modStacks()];
}

/** Injected by the mods layer at startup. A function, not an import, so this
 *  module stays dependency-free and testable — and so mods are strictly additive
 *  to a table that works with none installed. */
let modStacks: () => StackDef[] = () => [];

/** Called once by the mods store; see modStore.start(). */
export function setModStackSource(fn: () => StackDef[]): void {
  modStacks = fn;
}

/** True if `command` looks like a long-running server worth managing.
 *  Powers only the automatic suggestion — the user can always force either way. */
export function isServerCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  const patterns = [...allStacks().flatMap((s) => s.serverPatterns ?? []), ...GENERIC_SERVER_PATTERNS];
  return patterns.some((re) => re.test(c));
}

/** Every marker file any stack cares about, de-duplicated. */
export function allMarkers(): string[] {
  return [...new Set(allStacks().flatMap((s) => s.markers))];
}

/** A one-liner (for this host's script shell) that reports which marker files
 *  exist in the cwd and, when there's a package.json, which npm scripts it
 *  defines. Generated from the table so a new stack needs no shell code — and it
 *  stays ONE round trip. Emits compact JSON: `{"markers":[...],"scripts":[...]}`. */
export function buildProbe(): string {
  return stackProbeScript(allMarkers());
}

/** What {@link buildProbe} reports back. */
export interface ProbeResult {
  markers: string[];
  scripts: string[];
}

/** Parse the probe's JSON. Returns empty lists on anything unexpected, so a
 *  weird shell response degrades to "no stack detected" instead of throwing. */
export function parseProbe(out: string): ProbeResult {
  try {
    const j = JSON.parse(out.trim());
    return {
      markers: Array.isArray(j?.markers) ? j.markers.map(String) : [],
      scripts: Array.isArray(j?.scripts) ? j.scripts.map(String) : [],
    };
  } catch {
    return { markers: [], scripts: [] };
  }
}

/** Every stack whose markers are present, in table order. A repo can genuinely
 *  be several at once — a Tauri app is Node at the root and Rust underneath. */
export function matchingStacks(probe: ProbeResult): StackDef[] {
  const present = new Set(probe.markers);
  return allStacks().filter((s) => s.markers.some((m) => present.has(m)));
}

/** The first stack whose markers are present, or undefined. */
export function detectStack(probe: ProbeResult): StackDef | undefined {
  return matchingStacks(probe)[0];
}

/** The test command for a detected project, or null when there isn't a usable
 *  one — including the case that matters in practice: a package.json with no
 *  `test` script, where `npm test` would fail with a confusing error. */
export function testCommandFor(probe: ProbeResult): { command: string; stack: StackDef } | null {
  // Fall through to the NEXT matching stack rather than giving up on the first.
  // The old chained probe stopped at package.json, so a repo that is Node at the
  // root and Rust underneath reported "no tests" whenever its package.json had no
  // test script — even with a perfectly good `cargo test` sitting there.
  for (const stack of matchingStacks(probe)) {
    if (!stack.test) continue;
    if (stack.requiresPackageScript && !probe.scripts.includes(stack.requiresPackageScript)) continue;
    return { command: stack.test, stack };
  }
  return null;
}

/** Human-readable list of the stacks we can find a test command for — used in
 *  the "nothing found" message so it names what was actually looked for. */
export function testableStackLabels(): string {
  return allStacks()
    .filter((s) => s.test)
    .map((s) => s.label)
    .join(" / ");
}
