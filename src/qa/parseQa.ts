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
  const steps = Array.isArray(it.steps) ? it.steps.map(str).filter(Boolean) : [];
  if (!title && !whatToCheck && steps.length === 0) return null;
  return {
    id: crypto.randomUUID(),
    title: title || "(untitled feature)",
    project: str(it.project) || undefined,
    branch: str(it.branch ?? it.worktree) || undefined,
    startCommand: str(it.startCommand ?? it.start ?? it.command) || undefined,
    backend: normalizeBackend(it.backend),
    whatToCheck: whatToCheck || (steps.length ? "" : "(no description provided)"),
    ...(steps.length ? { steps } : {}),
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

/** A step marker at the start of a line: "1.", "2)", "-", "*", "•", or "Step 3:". */
const LINE_MARKER = /^\s*(?:(?:step\s*)?\d+\s*[.):]|[-*•])\s+/i;

/**
 * The checks for one QA item as separate steps.
 *
 * `steps` from the model wins. Otherwise this rescues `whatToCheck` — which the
 * orchestrator sometimes writes as one run-on paragraph with its numbering
 * inline ("1. Open X 2. Click Y 3. ...") — by splitting on its markers. Prose
 * with no markers at all comes back empty, meaning "show it as a paragraph":
 * guessing sentence boundaries would invent steps nobody wrote.
 */
export function stepsOf(item: Pick<QaItem, "steps" | "whatToCheck">): string[] {
  if (item.steps?.length) return item.steps;
  return splitSteps(item.whatToCheck);
}

export function splitSteps(text: string): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];

  // Already on separate lines: keep the lines that carry a marker, and fold any
  // unmarked continuation line into the step above it.
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => LINE_MARKER.test(l)).length;
  if (lines.length > 1 && marked >= 2) {
    const out: string[] = [];
    for (const l of lines) {
      if (LINE_MARKER.test(l)) out.push(l.replace(LINE_MARKER, "").trim());
      else if (out.length) out[out.length - 1] += ` ${l}`;
      else out.push(l); // an intro line before the first step
    }
    return out.filter(Boolean);
  }

  // One paragraph with inline numbering. Only a real 1, 2, 3… sequence counts, so
  // "wait 5. Then reload" is not mistaken for step five.
  const flat = lines.join(" ");
  const nums = [...flat.matchAll(/(?:^|\s)(\d+)[.)]\s+/g)];
  const seq = nums.filter((m, i) => Number(m[1]) === i + 1);
  if (seq.length >= 2 && seq.length === nums.length) {
    const out: string[] = [];
    const intro = flat.slice(0, seq[0].index).trim();
    if (intro) out.push(intro);
    seq.forEach((m, i) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < seq.length ? seq[i + 1].index : flat.length;
      const step = flat.slice(start, end).trim();
      if (step) out.push(step);
    });
    return out;
  }

  // Inline bullets: " - Open X - Click Y". Needs spaces around the dash, so a
  // hyphenated word ("log-in") never splits.
  const bullets = flat.split(/\s+[-•*]\s+/).map((s) => s.replace(/^[-•*]\s+/, "").trim()).filter(Boolean);
  if (bullets.length >= 3) return bullets;

  return [];
}
