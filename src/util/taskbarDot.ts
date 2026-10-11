import { invoke } from "@tauri-apps/api/core";
import { notifyAllowed } from "./notify";

/** The orchestrator's state as the taskbar shows it: the same vocabulary the
 *  nodes inside the app use (see `shell/agentStatus.ts`). */
export type TaskbarDot = "working" | "done" | "error" | "none";

let current: TaskbarDot = "none";

/**
 * Put the orchestrator's state on the app's taskbar button: pulsing blue while
 * it thinks, a green dot when the turn lands, red when it failed.
 *
 * A settled dot is only worth painting when the user is somewhere else, which
 * is the same rule `notify()` follows: a green dot on a window you are already
 * looking at tells you nothing, and it would sit there until the next time you
 * tabbed away and back. `working` is painted either way, because watching the
 * taskbar pulse is a reason to leave the window in the first place.
 */
export function setTaskbarDot(state: TaskbarDot): void {
  // The dot is the orchestrator talking to you, so it answers to the same scope
  // setting as the notifications. Turning it off clears whatever is painted
  // rather than freezing it, which is why this becomes "none" instead of a return.
  if (!notifyAllowed("orchestrator")) state = "none";
  const settled = state === "done" || state === "error";
  const next: TaskbarDot =
    settled && typeof document !== "undefined" && document.hasFocus() ? "none" : state;
  if (next === current) return;
  current = next;
  // Best-effort: the dot is a nicety, and on macOS only the settled states show
  // at all (there is no dock overlay to pulse).
  void invoke("badge_set", { state: next }).catch(() => {});
}

/** Clear a settled dot the moment the window is looked at. A pulse is left
 *  alone: the turn is still running, and the user may tab away again. */
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (current === "done" || current === "error") setTaskbarDot("none");
  });
}
