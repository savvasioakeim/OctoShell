/** Confirmation for removing a worktree, with the optional "and the folder" step.
 *
 *  Closing a worktree project used to run `git worktree remove --force` followed
 *  by a recursive delete, with no prompt at all: uncommitted work in that
 *  checkout went with it. The deletion is usually what you want, which is why
 *  the checkbox starts ticked, but it should be a thing you agreed to.
 */
import { useState } from "react";

export function ConfirmRemove({
  title,
  message,
  /** Omit for a removal that is inherently a disk delete, e.g. a worktree that
   *  is not open anywhere: the app has nothing else to forget about it. */
  diskOption,
  confirmLabel = "Remove",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  diskOption?: { label: string; hint?: string };
  confirmLabel?: string;
  onConfirm: (deleteFromDisk: boolean) => void;
  onCancel: () => void;
}) {
  const [fromDisk, setFromDisk] = useState(true);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted">{message}</p>

        {diskOption ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-edge bg-card/40 p-3">
            <input
              type="checkbox"
              checked={fromDisk}
              onChange={(e) => setFromDisk(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-red-400"
            />
            <span>
              <span className="text-xs text-gray-200">{diskOption.label}</span>
              {diskOption.hint ? (
                <span className="mt-1 block text-[11px] leading-relaxed text-muted">
                  {diskOption.hint}
                </span>
              ) : null}
            </span>
          </label>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-gray-200 transition-colors hover:bg-edge"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(diskOption ? fromDisk : true)}
            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm text-red-300 transition-colors hover:bg-red-500/30"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
