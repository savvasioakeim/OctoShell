// A tiny pub/sub bridge so Strategy Mode can hand an Execution Plan to the
// coding orchestrator (AiSidebar) WITHOUT prop-threading through App. The
// orchestrator registers one handler on mount; Strategy's "Execute Plan" calls
// sendPlanToOrchestrator, which either injects the plan into the current chat or
// starts a fresh one first.

export interface PlanHandoff {
  /** The message to hand the orchestrator (already framed as an instruction). */
  text: string;
  /** Start a brand-new orchestrator chat before injecting (vs. append to the
   *  current one). */
  newChat: boolean;
}

type Handler = (payload: PlanHandoff) => void;

let handler: Handler | null = null;

/** The orchestrator calls this once on mount; returns an unsubscribe. */
export function registerOrchestrator(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** True when an orchestrator is mounted and can receive a plan. */
export function orchestratorReady(): boolean {
  return handler !== null;
}

/** Hand a plan to the orchestrator. Returns false if none is listening. */
export function sendPlanToOrchestrator(payload: PlanHandoff): boolean {
  if (!handler) return false;
  handler(payload);
  return true;
}
