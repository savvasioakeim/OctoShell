import { useEffect, useRef, useState } from "react";
import { settingsStore, useSettings } from "../settings/settingsStore";
import {
  formatBytes,
  formatMb,
  onWhisperProgress,
  whisperDelete,
  whisperDownload,
  whisperModels,
  type WhisperModel,
  type WhisperProgress,
} from "./whisperModels";

/**
 * The Whisper model picker in Settings › Speech-to-text.
 *
 * Nothing is downloaded until someone presses a button here, which is the point:
 * a 1GB model is a real cost and belongs to the user's judgement, not to an
 * installer. So every row states its size and its trade-off before the download,
 * not after.
 */
export function WhisperPanel() {
  const { whisperModel } = useSettings();
  const [models, setModels] = useState<WhisperModel[] | null>(null);
  const [progress, setProgress] = useState<Record<string, WhisperProgress>>({});
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setModels(await whisperModels());
    } catch (e) {
      setErr(`Couldn't read the model list: ${e}`);
    }
  };

  useEffect(() => {
    void refresh();
    // The listener outlives a single download, so it is torn down on unmount —
    // leaving it attached would keep writing into a dead component's state every
    // time the panel is reopened.
    let unlisten: (() => void) | null = null;
    let live = true;
    void onWhisperProgress((p) => setProgress((m) => ({ ...m, [p.model]: p }))).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // `download` resolves only when the whole model is on disk, so the row's busy
  // state follows the promise rather than the progress events, which can stop
  // arriving without the download being finished.
  const busyRef = useRef<Set<string>>(new Set());
  const [, bump] = useState(0);
  const setBusy = (id: string, on: boolean) => {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    bump((n) => n + 1);
  };

  const download = async (id: string) => {
    setErr(null);
    setBusy(id, true);
    try {
      await whisperDownload(id);
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(id, false);
      setProgress((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
      void refresh();
    }
  };

  const remove = async (id: string) => {
    setErr(null);
    setConfirming(null);
    try {
      await whisperDelete(id);
    } catch (e) {
      setErr(`${e}`);
    }
    void refresh();
  };

  if (!models) return <p className="text-[11px] text-muted">Reading the model list…</p>;

  return (
    <div className="flex flex-col gap-1.5">
      {models.map((m) => {
        const busy = busyRef.current.has(m.id);
        const p = progress[m.id];
        return (
          <div key={m.id} className="rounded-lg border border-edge bg-card px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-100">{m.label}</span>
                  <span className="text-[11px] tabular-nums text-muted">
                    {m.installed ? formatBytes(m.bytes) : formatMb(m.approxMb)}
                  </span>
                  {m.installed && !busy && m.id === whisperModel && (
                    <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      in use
                    </span>
                  )}
                  {m.installed && !busy && m.id !== whisperModel && (
                    <button
                      onClick={() => settingsStore.setWhisperModel(m.id)}
                      className="rounded-sm px-1.5 py-0.5 text-[10px] text-muted underline decoration-dotted hover:text-gray-200"
                    >
                      use this one
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-muted">{m.note}</p>
              </div>

              {busy ? (
                <span className="shrink-0 text-[11px] tabular-nums text-accent">
                  {p && p.percent >= 0 ? `${p.percent}%` : "starting…"}
                </span>
              ) : m.installed ? (
                confirming === m.id ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => void remove(m.id)}
                      className="rounded-md border border-red-400/60 px-2 py-1 text-[11px] text-red-300 hover:bg-red-400/10"
                    >
                      Delete {formatBytes(m.bytes)}
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted hover:bg-edge"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirming(m.id)}
                    className="shrink-0 rounded-md border border-edge px-2 py-1 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
                  >
                    Delete
                  </button>
                )
              ) : (
                <button
                  onClick={() => void download(m.id)}
                  className="shrink-0 rounded-md border border-accent/60 px-2 py-1 text-[11px] text-accent hover:bg-accent/10"
                >
                  Download {formatMb(m.approxMb)}
                </button>
              )}
            </div>

            {busy && (
              <div className="mt-2">
                <div className="h-1 overflow-hidden rounded-full bg-edge">
                  <div
                    className={`h-full rounded-full bg-accent transition-[width] ${
                      p && p.percent >= 0 ? "" : "animate-pulse w-1/3"
                    }`}
                    style={p && p.percent >= 0 ? { width: `${p.percent}%` } : undefined}
                  />
                </div>
                {p && (
                  <p className="mt-1 text-[10px] tabular-nums text-muted">
                    {p.file} · {formatBytes(p.received)}
                    {p.total > 0 && ` of ${formatBytes(p.total)}`}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
      <p className="text-[11px] leading-snug text-muted">
        Models are stored under the app’s config folder and can be deleted here at any time. Nothing
        is downloaded until you ask for it, and no model ships in the installer.
      </p>
    </div>
  );
}
