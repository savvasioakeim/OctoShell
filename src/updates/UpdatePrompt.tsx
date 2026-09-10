// The "there's a new version" prompt, and the timer behind it.
//
// Deliberately a corner card rather than a modal: an update is never urgent
// enough to interrupt a running agent, and a dialog over the middle of the
// screen would demand an answer at the worst possible moment. It waits.

import { useEffect } from "react";
import { settingsStore, useSettings } from "../settings/settingsStore";
import { updateStore, useUpdate } from "./updateStore";

export function UpdatePrompt() {
  const { autoUpdateCheck } = useSettings();
  const u = useUpdate();

  // The setting is the switch: turning it off stops the timer, turning it back
  // on in Settings starts checking again without a restart.
  useEffect(() => {
    if (!autoUpdateCheck) {
      updateStore.stopAutoChecks();
      return;
    }
    return updateStore.startAutoChecks();
  }, [autoUpdateCheck]);

  const busy = u.phase === "downloading" || u.phase === "ready";
  if (u.phase !== "available" && !busy) return null;

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-[60] w-80 overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl">
      <div className="border-b border-edge/60 bg-gradient-to-r from-accent/[0.12] to-transparent px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
          <span className="h-3.5 w-0.5 rounded-full bg-accent/70" />
          {busy ? "Installing update" : "Update available"}
        </h2>
        <p className="mt-0.5 text-[11px] text-muted">
          OctoShell {u.version}
          {u.current && ` — you have ${u.current}`}
        </p>
      </div>

      <div className="p-3">
        {u.notes && !busy && (
          <div className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-edge bg-well px-2 py-1.5 text-[11px] leading-relaxed text-muted">
            {u.notes}
          </div>
        )}

        {busy ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-edge">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                // A feed without a content-length gives no percentage to show, so
                // the bar sits full-width and pulses rather than lying about 0%.
                style={{ width: u.progress === null ? "100%" : `${u.progress}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              {u.phase === "ready"
                ? "Restarting into the new version…"
                : u.progress === null
                  ? "Downloading…"
                  : `Downloading ${Math.round(u.progress)}%`}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void updateStore.install()}
                className="flex-1 rounded-md bg-accent/25 px-2 py-1.5 text-xs font-semibold text-gray-100 hover:bg-accent/35"
              >
                Install &amp; restart
              </button>
              <button
                onClick={() => updateStore.dismiss()}
                className="rounded-md border border-edge px-2 py-1.5 text-xs text-muted hover:bg-edge/50 hover:text-gray-200"
              >
                Later
              </button>
            </div>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                className="accent-accent"
                onChange={(e) => {
                  if (!e.target.checked) return;
                  settingsStore.setAutoUpdateCheck(false);
                  updateStore.dismiss();
                }}
              />
              Don&apos;t ask again (Settings → System can turn this back on)
            </label>
          </>
        )}

        {u.error && <p className="mt-2 text-[11px] text-red-300">{u.error}</p>}
      </div>
    </div>
  );
}
