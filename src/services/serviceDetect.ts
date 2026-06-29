// Hybrid server-command detection: OctoShell auto-recognises the usual
// long-running/dev-server commands so it can offer to run them as a managed
// service (own port, own logs, non-blocking) instead of letting them hang a
// shell or — worse — an agent turn. The user can always override (force-manage
// or force-plain); this only powers the automatic suggestion.

/** Command fragments that almost always mean "a server that never returns". */
const SERVER_PATTERNS: RegExp[] = [
  /\bnpm\s+(run\s+)?(dev|start|serve|preview)\b/i,
  /\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b/i,
  /\bnext\s+(dev|start)\b/i,
  /\bvite\b(?!\s+build)/i, // `vite` / `vite preview`, but not `vite build`
  /\bnuxt\s+(dev|start)\b/i,
  /\b(ng|astro|remix|gatsby)\s+(dev|serve|start)\b/i,
  /\breact-scripts\s+start\b/i,
  /\bnode\s+\S*server\S*\.(js|mjs|cjs|ts)\b/i,
  /\bnodemon\b/i,
  /\b(uvicorn|gunicorn|flask\s+run|python\s+-m\s+http\.server|manage\.py\s+runserver)\b/i,
  /\b(rails\s+s(erver)?|php\s+-S|http-server|serve)\b/i,
];

/** True if `command` looks like a long-running server worth managing. */
export function isServerCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  return SERVER_PATTERNS.some((re) => re.test(c));
}
