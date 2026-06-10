import { useSyncExternalStore } from "react";
import type { ShellController, ShellSnapshot } from "./ShellController";

/** Subscribe a React component to the controller's external store. */
export function useShell(controller: ShellController): ShellSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}
