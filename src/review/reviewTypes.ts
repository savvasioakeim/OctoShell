// Shared types for Review Mode — the acceptance half of the orchestration loop.
// When the orchestrator finishes the tasks you dispatched, it can emit a
// ```octo-review block describing what to check per feature; OctoShell opens a
// floating, always-on-top window that walks you through each one (approve /
// decline / skip + notes), starting the relevant server on demand. Declines (and
// notes) feed back as fresh dispatches to each feature's branch agent.

export type Verdict = "approve" | "decline";

/** Which server a start request / status refers to: the feature's own server
 *  (usually the frontend) or a backend it needs to function end-to-end. */
export type ServerRole = "frontend" | "backend";

/** A backend the feature needs to actually run (e.g. a FE feature needs its API).
 *  OctoShell starts it from the matching worktree if one exists, else the repo's
 *  base branch. */
export interface ReviewBackend {
  /** The backend repo/project name (e.g. "ridebly-be"). */
  project: string;
  /** Command that starts the backend dev server. */
  command: string;
}

/** One feature to review, as produced by the orchestrator. */
export interface ReviewItem {
  /** Stable id (assigned on parse). */
  id: string;
  /** Short feature label, e.g. "Login rate-limit". */
  title: string;
  /** The repo/project name to re-dispatch a fix to (the branch's parent). */
  project?: string;
  /** The worktree branch this feature lives on. */
  branch?: string;
  /** Shell command that starts this feature's dev server (run managed). */
  startCommand?: string;
  /** A backend the feature needs to run end-to-end (optional). */
  backend?: ReviewBackend;
  /** What the reviewer should verify, in prose. */
  whatToCheck: string;
}

/** The reviewer's decision for one item (notes kept even with no verdict yet). */
export interface ReviewResult {
  id: string;
  verdict: Verdict | null;
  notes: string;
}

// ---- cross-window event channel names (main ⇄ review webview) ----
export const RV = {
  /** review → main: window mounted, requests its items. */
  ready: "review://ready",
  /** main → review: the items to review. */
  load: "review://load",
  /** review → main: a per-item decision/notes changed. */
  result: "review://result",
  /** review → main: start this item's managed server. */
  startServer: "review://start-server",
  /** main → review: a server's url/status for an item. */
  server: "review://server",
  /** review → main: the reviewer finished or closed the window. */
  closed: "review://closed",
} as const;

export interface ReviewLoadPayload {
  items: ReviewItem[];
}
/** review → main: start this item's server of the given role. */
export interface ReviewStartServerPayload {
  id: string;
  role: ServerRole;
}
export interface ReviewServerPayload {
  id: string;
  role: ServerRole;
  url?: string;
  status: "starting" | "running" | "error";
}
