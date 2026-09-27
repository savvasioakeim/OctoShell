// Orchestration: the workspace assistant can PROPOSE actions on other projects'
// agents — but it never executes them itself. It emits a fenced ```octo-actions
// JSON block in its reply; we parse that out, hide it from the rendered text, and
// surface each action as a confirmation card. Only the user's click runs them.

/** A worktree (or base checkout) whose work this task depends on, or which
 *  depends on it. Several, because one backend can feed many frontends. */
export interface PeerRef {
  project: string;
  /** The peer's branch. Absent means its base checkout. */
  branch?: string;
}

export type OrchestratorAction =
  | { kind: "dispatch"; project: string; prompt: string; branch?: string; peers?: PeerRef[] }
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

/** The related worktrees on a dispatch. Objects ({project, branch}) are the
 *  documented shape; the "project#branch" shorthand a model sometimes reaches for
 *  is accepted too, because a dropped link is worse than a sloppily written one. */
function normalizePeers(raw: any): PeerRef[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: PeerRef[] = [];
  for (const it of list) {
    if (typeof it === "string") {
      const [project, branch] = it.split("#");
      if (project?.trim()) {
        out.push(branch?.trim() ? { project: project.trim(), branch: branch.trim() } : { project: project.trim() });
      }
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const project = typeof it.project === "string" ? it.project.trim() : "";
    if (!project) continue;
    const b = it.branch ?? it.worktree;
    const branch = typeof b === "string" && b.trim() ? b.trim() : undefined;
    out.push(branch ? { project, branch } : { project });
  }
  return out;
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
    const peers = normalizePeers(item.peers ?? item.related);
    const base = branch
      ? { kind: "dispatch" as const, project, prompt, branch }
      : { kind: "dispatch" as const, project, prompt };
    return peers.length ? { ...base, peers } : base;
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
