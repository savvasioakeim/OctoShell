// Parse the orchestrator's ```octo-review fenced block into review items, and
// strip it from the rendered prose (like parseActions does for ```octo-actions).

import type { ReviewItem } from "./reviewTypes";

const REVIEW_FENCE = /```octo-review\s*\n([\s\S]*?)```/i;

/** Split an assistant reply into prose with the review block removed, plus the
 *  parsed review items (empty + unchanged text when there's no/!malformed block). */
export function parseReview(text: string): { clean: string; items: ReviewItem[] } {
  const m = text.match(REVIEW_FENCE);
  if (!m) return { clean: text, items: [] };

  const clean = text.replace(REVIEW_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();

  let raw: unknown;
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return { clean, items: [] };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const items: ReviewItem[] = [];
  for (const it of list) {
    const item = normalize(it);
    if (item) items.push(item);
  }
  return { clean, items };
}

function normalize(it: any): ReviewItem | null {
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
function normalizeBackend(b: any): ReviewItem["backend"] {
  if (!b || typeof b !== "object") return undefined;
  const project = str(b.project ?? b.repo ?? b.name);
  const command = str(b.command ?? b.startCommand ?? b.start);
  if (!project || !command) return undefined;
  return { project, command };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
