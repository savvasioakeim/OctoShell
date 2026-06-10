import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

/**
 * Our own window title bar (the native one is removed via `decorations: false`).
 *
 * The draggable area uses `data-tauri-drag-region`, which Tauri handles natively
 * — including double-click-to-maximize and Windows snap. The three controls call
 * the window API directly; the close button gets the conventional red hover.
 */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => void appWindow.isMaximized().then(setMaximized))
      .then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, []);

  const btn =
    "flex h-full w-[46px] items-center justify-center text-muted hover:bg-edge hover:text-white transition-colors";

  return (
    <div
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center justify-between border-b border-edge bg-panel"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 px-3 text-xs">
        <span aria-hidden>🐙</span>
        <span className="font-semibold tracking-wide text-gray-300">OctoShell</span>
      </div>

      <div className="flex h-full">
        <button className={btn} title="Ελαχιστοποίηση" onClick={() => void appWindow.minimize()}>
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1" fill="currentColor" /></svg>
        </button>
        <button
          className={btn}
          title={maximized ? "Επαναφορά" : "Μεγιστοποίηση"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor">
              <rect x="2.5" y="0.5" width="7" height="7" /><rect x="0.5" y="2.5" width="7" height="7" fill="#252A3A" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
          )}
        </button>
        <button
          className="flex h-full w-[46px] items-center justify-center text-muted transition-colors hover:bg-red-600 hover:text-white"
          title="Κλείσιμο"
          onClick={() => void appWindow.close()}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor"><path d="M1 1 L10 10 M10 1 L1 10" /></svg>
        </button>
      </div>
    </div>
  );
}
