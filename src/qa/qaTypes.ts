// Shared types for QA Mode — the acceptance half of the orchestration loop.
// When the orchestrator finishes the tasks you dispatched, it can emit a
// ```octo-qa block describing what to check per feature; OctoShell opens a
// floating, always-on-top window that walks you through each one (approve /
// decline / skip + notes), starting the relevant server on demand. Declines (and
// notes) feed back as fresh dispatches to each feature's branch agent.
//
// NOTE: "QA Mode" is the human acceptance pass (this window). It is distinct from
// the automated *review agent* (src/review/*), which vets a coding agent's diff
// BEFORE QA is ever offered.

export type Verdict = "approve" | "decline";

/** Which server a start request / status refers to: the feature's own server
 *  (usually the frontend) or a backend it needs to function end-to-end. */
export type ServerRole = "frontend" | "backend";

/** A backend the feature needs to actually run (e.g. a FE feature needs its API).
 *  OctoShell starts it from the matching worktree if one exists, else the repo's
 *  base branch. */
export interface QaBackend {
  /** The backend repo/project name (e.g. "ridebly-be"). */
  project: string;
  /** Command that starts the backend dev server. */
  command: string;
  /** The backend's OWN branch, when it differs from the feature branch (a single
   *  ticket can span repos with different branch names). QA runs the backend from
   *  the worktree on THIS branch; without it, it matches the feature branch and
   *  falls back to the base (dev) checkout — which lacks the new API. */
  branch?: string;
}

/** One feature to QA, as produced by the orchestrator. */
export interface QaItem {
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
  backend?: QaBackend;
  /** What the reviewer should verify, in prose. */
  whatToCheck: string;
}

/** The reviewer's decision for one item (notes kept even with no verdict yet). */
export interface QaResult {
  id: string;
  verdict: Verdict | null;
  notes: string;
}

// ---- cross-window event channel names (main ⇄ QA webview) ----
export const QA = {
  /** qa → main: window mounted, requests its items. */
  ready: "qa://ready",
  /** main → qa: the items to review. */
  load: "qa://load",
  /** qa → main: a per-item decision/notes changed. */
  result: "qa://result",
  /** qa → main: start this item's managed server. */
  startServer: "qa://start-server",
  /** main → qa: a server's url/status for an item. */
  server: "qa://server",
  /** qa → main: the reviewer finished or closed the window. */
  closed: "qa://closed",
} as const;

export interface QaLoadPayload {
  items: QaItem[];
}
/** qa → main: start this item's server of the given role. */
export interface QaStartServerPayload {
  id: string;
  role: ServerRole;
}
export interface QaServerPayload {
  id: string;
  role: ServerRole;
  url?: string;
  status: "starting" | "running" | "error" | "warning";
  /** Human-readable detail — the error reason, or a warning (e.g. "no worktree for
   *  this branch — running from base (dev); the new API may be missing"). Shown so
   *  a failed/degraded start says WHY instead of silently doing the wrong thing. */
  message?: string;
}
