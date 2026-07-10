// Main-window side of QA Mode: spawns the floating QA webview, feeds it the
// items, relays "start server" requests to the managed-service layer, and
// delivers the reviewer's verdicts back to the caller (AiSidebar) when the window
// closes. The QA webview has no access to the main app's state, so every
// interaction crosses via Tauri events (see QA in qaTypes).

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  QA,
  type QaItem,
  type QaResult,
  type QaServerPayload,
  type QaStartServerPayload,
  type ServerRole,
} from "./qaTypes";

export interface QaHandlers {
  /** Start this feature's managed server of the given role (frontend or backend);
   *  resolve with its URL (or nothing). */
  onStartServer: (item: QaItem, role: ServerRole) => Promise<string | undefined>;
  /** The reviewer finished/closed — final verdicts (incl. notes-only items). */
  onClosed: (results: QaResult[]) => void;
}

// One QA session at a time; tear down the previous wiring before a new open.
let active: (() => void) | null = null;

export async function openQaWindow(items: QaItem[], handlers: QaHandlers): Promise<void> {
  active?.();
  const unsubs: Array<() => void> = [];
  const cleanup = () => {
    unsubs.forEach((u) => u());
    if (active === cleanup) active = null;
  };
  active = cleanup;

  // The window asks for its items on mount.
  unsubs.push(await listen(QA.ready, () => void emitTo("qa", QA.load, { items })));

  // Relay a "start server" click to the managed-service layer, echoing status.
  unsubs.push(
    await listen<QaStartServerPayload>(QA.startServer, async (e) => {
      const { id, role } = e.payload;
      const item = items.find((it) => it.id === id);
      if (!item) return;
      const starting: QaServerPayload = { id, role, status: "starting" };
      void emitTo("qa", QA.server, starting);
      const url = await handlers.onStartServer(item, role).catch(() => undefined);
      const done: QaServerPayload = { id, role, status: url ? "running" : "error", url };
      void emitTo("qa", QA.server, done);
    }),
  );

  // Final verdicts on close.
  unsubs.push(
    await listen<{ results: QaResult[] }>(QA.closed, (e) => {
      handlers.onClosed(e.payload.results ?? []);
      cleanup();
    }),
  );

  // Re-use an open QA window if there is one; else create it (≈ 1/3 × 1/2 screen).
  const existing = await WebviewWindow.getByLabel("qa");
  if (existing) {
    await existing.setFocus();
    void emitTo("qa", QA.load, { items });
    return;
  }
  const w = Math.max(320, Math.round((window.screen.availWidth || 1280) / 3));
  const h = Math.max(360, Math.round((window.screen.availHeight || 800) / 2));
  const win = new WebviewWindow("qa", {
    url: "/",
    title: "OctoShell · QA",
    width: w,
    height: h,
    minWidth: 280,
    minHeight: 320,
    resizable: true,
    alwaysOnTop: true,
    decorations: false,
  });
  void win.once("tauri://error", (e) => {
    console.error("QA window failed:", e);
    cleanup();
  });
}
