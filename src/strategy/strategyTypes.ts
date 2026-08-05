// Strategy Mode — the data model for a moderated, multi-agent PLANNING workflow
// that runs BEFORE any coding agent starts. Planning and execution are kept
// decoupled: the discussion produces an ExecutionPlan, a first-class, reusable,
// exportable object — not just another chat message.

import type { AgentProvider } from "../agents/providers";

/** A discussion participant. Deliberately metadata-driven (name/role/color) so
 *  specialised roles (Architect, Frontend, QA, Security…) can be added later
 *  WITHOUT refactoring — a role is just a label today. */
export interface StrategyParticipant {
  id: string;
  /** References a StrategyRole by id (built-in or custom). The role IS the
   *  participant's identity — it supplies both the display label and the
   *  identity/lens prompt injected before the user's request. */
  roleId: string;
  provider: AgentProvider;
  model: string | null;
  /** Optional config/account profile (same mechanism as agents/orchestrator). */
  profileId: string | null;
  /** Accent colour for this participant's panel + messages. */
  color: string;
  /** Whether this participant takes part in the next discussion (roster can hold
   *  a bench that isn't all active). */
  enabled: boolean;
}

/** One participant's contribution in one round. */
export interface StrategyMessage {
  participantId: string;
  round: number;
  content: string;
  at: number;
  status: "running" | "done" | "error";
}

/** The synthesized, reusable output of a discussion. A first-class object: it can
 *  be saved to the library, exported to Markdown, edited, and executed at any
 *  time in the future without repeating the discussion. */
export interface ExecutionPlan {
  id: string;
  title: string;
  /** The structured report body (Markdown). */
  markdown: string;
  /** The original feature request this plan was born from. */
  request: string;
  createdAt: number;
  updatedAt: number;
}

/** Phase of the live discussion. */
export type StrategyPhase =
  | "setup" // composing the request / picking participants, nothing run yet
  | "discussing" // at least one round has run
  | "reported"; // a Final Strategy Report has been generated

/** The live discussion state (transient — not the saved plans). */
export interface StrategySession {
  request: string;
  /** Open project ids whose context was attached (for display/re-run). */
  contextProjectIds: string[];
  /** Snapshot of the participants taking part (so editing the roster mid-run
   *  doesn't retroactively rewrite the transcript). */
  participants: StrategyParticipant[];
  messages: StrategyMessage[];
  /** How many rounds have completed (0 = none yet). */
  round: number;
  phase: StrategyPhase;
  /** The generated report Markdown, once produced. */
  report: string | null;
  /** True while a round or the report is being generated. */
  busy: boolean;
}
