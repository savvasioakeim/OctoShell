// Main-window side of Review Mode: spawns the floating review webview, feeds it
// the items, relays "start server" requests to the managed-service layer, and
// delivers the reviewer's verdicts back to the caller (AiSidebar) when the window
// closes. The review webview has no access to the main app's state, so every
// interaction crosses via Tauri events (see RV in reviewTypes).

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  RV,
  type ReviewItem,
  type ReviewResult,
  type ReviewServerPayload,
  type ReviewStartServerPayload,
  type ServerRole,
} from "./reviewTypes";

export interface ReviewHandlers {
  /** Start this feature's managed server of the given role (frontend or backend);
   *  resolve with its URL (or nothing). */
  onStartServer: (item: ReviewItem, role: ServerRole) => Promise<string | undefined>;
  /** The reviewer finished/closed — final verdicts (incl. notes-only items). */
  onClosed: (results: ReviewResult[]) => void;
}

// One review session at a time; tear down the previous wiring before a new open.
let active: (() => void) | null = null;

export async function openReviewWindow(items: ReviewItem[], handlers: ReviewHandlers): Promise<void> {
  active?.();
  const unsubs: Array<() => void> = [];
  const cleanup = () => {
    unsubs.forEach((u) => u());
    if (active === cleanup) active = null;
  };
  active = cleanup;

  // The window asks for its items on mount.
  unsubs.push(await listen(RV.ready, () => void emitTo("review", RV.load, { items })));

  // Relay a "start server" click to the managed-service layer, echoing status.
  unsubs.push(
    await listen<ReviewStartServerPayload>(RV.startServer, async (e) => {
      const { id, role } = e.payload;
      const item = items.find((it) => it.id === id);
      if (!item) return;
      const starting: ReviewServerPayload = { id, role, status: "starting" };
      void emitTo("review", RV.server, starting);
      const url = await handlers.onStartServer(item, role).catch(() => undefined);
      const done: ReviewServerPayload = { id, role, status: url ? "running" : "error", url };
      void emitTo("review", RV.server, done);
    }),
  );

  // Final verdicts on close.
  unsubs.push(
    await listen<{ results: ReviewResult[] }>(RV.closed, (e) => {
      handlers.onClosed(e.payload.results ?? []);
      cleanup();
    }),
  );

  // Re-use an open review window if there is one; else create it (≈ 1/3 × 1/2 screen).
  const existing = await WebviewWindow.getByLabel("review");
  if (existing) {
    await existing.setFocus();
    void emitTo("review", RV.load, { items });
    return;
  }
  const w = Math.max(320, Math.round((window.screen.availWidth || 1280) / 3));
  const h = Math.max(360, Math.round((window.screen.availHeight || 800) / 2));
  const win = new WebviewWindow("review", {
    url: "/",
    title: "OctoShell · Review",
    width: w,
    height: h,
    minWidth: 280,
    minHeight: 320,
    resizable: true,
    alwaysOnTop: true,
    decorations: false,
  });
  void win.once("tauri://error", (e) => {
    console.error("review window failed:", e);
    cleanup();
  });
}
