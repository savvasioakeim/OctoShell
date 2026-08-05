// Parse the orchestrator's ```octo-qa fenced block into QA items, and strip it
// from the rendered prose (like parseActions does for ```octo-actions).

import type { QaItem } from "./qaTypes";

const QA_FENCE = /```octo-qa\s*\n([\s\S]*?)```/i;

/** Split an assistant reply into prose with the QA block removed, plus the parsed
 *  QA items (empty + unchanged text when there's no/!malformed block). */
export function parseQa(text: string): { clean: string; items: QaItem[] } {
  const m = text.match(QA_FENCE);
  if (!m) return { clean: text, items: [] };

  const clean = text.replace(QA_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();

  let raw: unknown;
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return { clean, items: [] };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const items: QaItem[] = [];
  for (const it of list) {
    const item = normalize(it);
    if (item) items.push(item);
  }
  return { clean, items };
}

function normalize(it: any): QaItem | null {
  if (!it || typeof it !== "object") return null;
  const title = str(it.title ?? it.feature);
  const whatToCheck = str(it.whatToCheck ?? it.check ?? it.description ?? it.desc);
  if (!title && !whatToCheck) return null;
  return {
    id: crypto.randomUUID(),
    title: title || "(untitled feature)",
    project: str(it.project) || undefined,
    branch: str(it.branch ?? it.worktree) || undefined,
    startCommand: str(it.startCommand ?? it.start ?? it.command) || undefined,
    backend: normalizeBackend(it.backend),
    whatToCheck: whatToCheck || "(no description provided)",
  };
}

/** A backend needs both a repo/project and a start command to be actionable. */
function normalizeBackend(b: any): QaItem["backend"] {
  if (!b || typeof b !== "object") return undefined;
  const project = str(b.project ?? b.repo ?? b.name);
  const command = str(b.command ?? b.startCommand ?? b.start);
  if (!project || !command) return undefined;
  const branch = str(b.branch ?? b.worktree);
  return branch ? { project, command, branch } : { project, command };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
