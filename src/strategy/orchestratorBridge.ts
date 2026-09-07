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

// ---------------------------------------------------------------------------
// Driving the orchestrator from outside (the phone companion).
//
// Sending already works above: the phone hands over text exactly like Strategy
// Mode does. But a conversation you can talk to and not hear back from is
// useless, so the orchestrator also publishes a way to READ and STEER it.
//
// This is one object of live functions, not a snapshot, and that is the whole
// point. The orchestrator's state lives in React; a value captured at
// registration would freeze at mount and the phone would show an empty chat
// forever. Every field here is called at request time.

/** One saved orchestrator conversation, as the phone needs to list it. */
export interface OrchestratorChat {
  id: string;
  title: string;
  updatedAt: number;
  active: boolean;
}

/** What an outside reader can see of the orchestrator conversation. */
export interface OrchestratorView {
  messages: { role: "user" | "assistant"; content: string }[];
  /** A turn is in flight. Outside callers must not start another. */
  thinking: boolean;
  chats: OrchestratorChat[];
}

/** Everything an outside driver may do. Deliberately narrow.
 *
 *  Notably absent is the emergency stop. It cancels every running agent as well
 *  as the current turn, and that is far too much to sit one mis-tap away on a
 *  phone; `stop` here ends the orchestrator's own turn and nothing else. */
export interface OrchestratorControl {
  view: () => OrchestratorView;
  /** Switch to a saved conversation. False when the id is unknown. */
  switchChat: (id: string) => boolean;
  /** Start a fresh conversation. The current one stays saved. */
  newChat: () => void;
  /** Cancel the in-flight turn. Does NOT touch the projects' agents. */
  stop: () => void;
}

let control: OrchestratorControl | null = null;

/** The orchestrator calls this once on mount; returns an unsubscribe. */
export function registerOrchestratorControl(c: OrchestratorControl): () => void {
  control = c;
  return () => {
    if (control === c) control = null;
  };
}

/** The live control surface, or null when no orchestrator is mounted. */
export function orchestratorControl(): OrchestratorControl | null {
  return control;
}

/** The live conversation, or null when no orchestrator is mounted. */
export function orchestratorView(): OrchestratorView | null {
  return control ? control.view() : null;
}
