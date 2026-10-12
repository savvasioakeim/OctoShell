import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { settingsStore } from "../settings/settingsStore";

/** Cached permission state, so we only ask the OS once per run. */
let granted: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

/** Whether this side of the app may interrupt the user right now, per the
 *  Notifications setting. Exported because the phone push in ShellController
 *  has to answer the same question before it leaves the machine. */
export function notifyAllowed(from: "agent" | "orchestrator"): boolean {
  const { scope } = settingsStore.getSnapshot().notifications;
  if (scope === "off") return false;
  if (scope === "all") return true;
  return scope === (from === "agent" ? "agents" : "orchestrator");
}

/**
 * Fire a desktop notification — but only when the app isn't already in the
 * foreground (no point pinging the user about something they're watching),
 * and only when `from` is a side the user asked to hear from.
 * Best-effort: silently no-ops if permission is denied or the plugin errors.
 */
export async function notify(title: string, body: string, from: "agent" | "orchestrator" = "agent"): Promise<void> {
  // The user is looking at the window — they don't need a notification.
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (!notifyAllowed(from)) return;
  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* ignore — notifications are a nicety, never critical */
  }
}
