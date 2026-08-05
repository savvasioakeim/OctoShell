// Orchestration: the workspace assistant can PROPOSE actions on other projects'
// agents — but it never executes them itself. It emits a fenced ```octo-actions
// JSON block in its reply; we parse that out, hide it from the rendered text, and
// surface each action as a confirmation card. Only the user's click runs them.

export type OrchestratorAction =
  | { kind: "dispatch"; project: string; prompt: string; branch?: string }
  // `branch` disambiguates: one ticket can have same-named worktrees in several
  // repos, so project alone can't say which agent to hit.
  | { kind: "cancel"; project: string; branch?: string }
  | { kind: "review"; project: string; branch?: string };

/** Matches a ```octo-actions … ``` fenced block (the only place actions live). */
const ACTIONS_FENCE = /```octo-actions\s*\n([\s\S]*?)```/i;

/**
 * Split an assistant reply into its human-readable prose and any proposed
 * actions. The actions fence is removed from `clean` so it never renders as a
 * code block. Tolerant of malformed JSON — bad input just yields no actions.
 */
export function parseActions(text: string): { clean: string; actions: OrchestratorAction[] } {
  const m = text.match(ACTIONS_FENCE);
  if (!m) return { clean: text, actions: [] };

  const clean = text.replace(ACTIONS_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();

  let raw: unknown;
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return { clean, actions: [] };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const actions: OrchestratorAction[] = [];
  for (const item of list) {
    const a = normalize(item);
    if (a) actions.push(a);
  }
  return { clean, actions };
}

/** Validate one parsed item into a typed action (or null if it's malformed). */
function normalize(item: any): OrchestratorAction | null {
  if (!item || typeof item !== "object") return null;
  const verb = String(item.action ?? item.kind ?? "").toLowerCase();
  const project = typeof item.project === "string" ? item.project.trim() : "";
  if (!project) return null;
  // Optional branch/worktree target. On dispatch it names the worktree to run in
  // (created on first use, reused after); on cancel/review it disambiguates which
  // of several same-named worktrees is meant. `worktree` is accepted as an alias.
  const rawBranch = item.branch ?? item.worktree;
  const branch = typeof rawBranch === "string" && rawBranch.trim() ? rawBranch.trim() : undefined;
  if (verb === "dispatch" || verb === "send" || verb === "run") {
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    if (!prompt) return null;
    return branch ? { kind: "dispatch", project, prompt, branch } : { kind: "dispatch", project, prompt };
  }
  if (verb === "cancel" || verb === "stop") {
    return branch ? { kind: "cancel", project, branch } : { kind: "cancel", project };
  }
  // Start OctoShell's built-in (independent) review agent on a project whose
  // dispatched work is finished — vets the diff and emits a verdict that gates QA.
  if (verb === "review") {
    return branch ? { kind: "review", project, branch } : { kind: "review", project };
  }
  return null;
}
