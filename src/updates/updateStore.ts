// Finding, and installing, a new OctoShell.
//
// A module singleton (like serviceStore) because two surfaces need the same
// answer: the prompt that appears when a release lands, and the Settings page
// where you can ask on demand or turn the asking off. Duplicating the check
// would mean two requests and two disagreeing opinions about what is installed.
//
// Nothing here trusts the download: `tauri-plugin-updater` verifies the release's
// ed25519 signature against the public key baked into the app before running
// anything, and refuses the update if it does not match. That is the whole
// reason auto-install is acceptable at all — see docs/updates.md.

import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { KEY, loadJSON, saveJSON } from "../util/persist";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "none"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** The version on offer, once we know it. */
  version: string | null;
  /** Release notes from the release body, when the feed carries them. */
  notes: string | null;
  /** 0-100 while downloading, else null. Null also means "size unknown". */
  progress: number | null;
  error: string | null;
  /** When we last completed a check, so the 24h timer survives a reload. */
  lastCheck: number;
  /** The running version, for "you have X" in the prompt. */
  current: string | null;
}

/** How often an app left open keeps looking. */
const DAY_MS = 86_400_000;

class UpdateStore {
  private state: UpdateState = {
    phase: "idle",
    version: null,
    notes: null,
    progress: null,
    error: null,
    lastCheck: loadJSON<number>(KEY.updateLastCheck, 0),
    current: null,
  };
  private listeners = new Set<() => void>();
  /** The verified update object, held between "available" and "install". */
  private pending: Update | null = null;
  private timer: number | null = null;

  getSnapshot = (): UpdateState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Ask GitHub whether there is something newer.
   *
   *  `manual` is what the Settings button passes: it reports "you're up to date"
   *  instead of staying quiet, because a button that appears to do nothing reads
   *  as broken. */
  async check(manual = false): Promise<void> {
    if (this.state.phase === "checking" || this.state.phase === "downloading") return;
    this.set({ phase: "checking", error: null });
    try {
      if (!this.state.current) {
        this.set({ current: await getVersion().catch(() => null) });
      }
      const update = await check();
      this.state.lastCheck = Date.now();
      saveJSON(KEY.updateLastCheck, this.state.lastCheck);
      if (update) {
        this.pending = update;
        this.set({
          phase: "available",
          version: update.version,
          notes: update.body ?? null,
        });
      } else {
        this.pending = null;
        this.set({ phase: "none", version: null, notes: null });
      }
    } catch (e) {
      // An unreachable GitHub, or no updater key configured yet. Only worth
      // surfacing when the user asked; a background check fails in silence.
      this.set({ phase: manual ? "error" : "idle", error: String(e) });
    }
  }

  /** Download, verify, install, and restart into the new version. */
  async install(): Promise<void> {
    const update = this.pending;
    if (!update) return;
    this.set({ phase: "downloading", progress: 0, error: null });
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          this.set({ progress: total > 0 ? 0 : null });
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total > 0) this.set({ progress: Math.min(100, (got / total) * 100) });
        } else if (ev.event === "Finished") {
          this.set({ phase: "ready", progress: 100 });
        }
      });
      await relaunch();
    } catch (e) {
      this.set({ phase: "error", error: String(e), progress: null });
    }
  }

  /** Put the prompt away without deciding anything: the next check asks again. */
  dismiss(): void {
    if (this.state.phase === "available" || this.state.phase === "none" || this.state.phase === "error") {
      this.set({ phase: "idle", error: null });
    }
  }

  /** Start the background rhythm: one check now (if we are due) and one a day.
   *
   *  Returns a teardown, so a settings change that turns checking off actually
   *  stops the timer rather than leaving it ticking behind a disabled switch. */
  startAutoChecks(): () => void {
    this.stopAutoChecks();
    const due = () => Date.now() - this.state.lastCheck >= DAY_MS;
    // A launch always looks, unless one already happened today.
    if (due()) void this.check();
    this.timer = window.setInterval(() => {
      if (due()) void this.check();
    }, 60 * 60 * 1000); // hourly tick; `due` is what rations it to daily
    return () => this.stopAutoChecks();
  }

  stopAutoChecks(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const updateStore = new UpdateStore();

export function useUpdate(): UpdateState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
}
