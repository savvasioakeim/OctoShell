// Shared agent/project status, used by both the circuit board (ProjectSidebar)
// and the orchestrator's Agents panel (AiSidebar) so they always agree on what a
// project is doing and render it the same colour.

import type { ShellSnapshot } from "./ShellController";

export type AgentStatus = "idle" | "active" | "done" | "error";

/** Derive a project's status from its latest snapshot: running now → active,
 *  otherwise the outcome of the last finished command/tool block. */
export function statusOf(s?: ShellSnapshot): AgentStatus {
  if (!s) return "idle";
  if (s.agentBusy || s.busy) return "active";
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i];
    if (b.kind === "command" || b.kind === "agentTool") {
      if (b.status === "error") return "error";
      if (b.status === "success") return "done";
      return "idle";
    }
  }
  return "idle";
}

export const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: "#4b5066", // gray  — nothing running
  active: "#82AAFF", // blue  — shell/agent working
  done: "#4ade80", // green — last action succeeded
  error: "#f87171", // red   — last action failed
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  active: "working",
  done: "done",
  error: "error",
};

/** Compact English labels for tight UI (the orchestrator's Agents panel rows). */
export const STATUS_SHORT: Record<AgentStatus, string> = {
  idle: "idle",
  active: "working",
  done: "done",
  error: "error",
};

/** Sort weight so the panel floats what matters: working → error → done → idle. */
export const STATUS_ORDER: Record<AgentStatus, number> = {
  active: 0,
  error: 1,
  done: 2,
  idle: 3,
};
