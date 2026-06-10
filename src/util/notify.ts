import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

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

/**
 * Fire a desktop notification — but only when the app isn't already in the
 * foreground (no point pinging the user about something they're watching).
 * Best-effort: silently no-ops if permission is denied or the plugin errors.
 */
export async function notify(title: string, body: string): Promise<void> {
  // The user is looking at the window — they don't need a notification.
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* ignore — notifications are a nicety, never critical */
  }
}
