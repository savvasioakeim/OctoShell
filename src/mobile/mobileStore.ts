// Sharing state for the phone companion, shared app-wide as a module singleton.
//
// The countdown is the reason this is a store rather than local component state:
// an expiring share must stop looking live everywhere at once, and the backend
// reaps the session on the next status call — so the ticking here is also what
// makes expiry actually take the listener down when no one is looking at Settings.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface MobileState {
  sharing: boolean;
  /** Shown large so it can be read off this screen and typed on the phone. */
  code: string | null;
  port: number | null;
  expiresAt: number | null;
  secondsLeft: number | null;
  /** True while the backend is refusing codes after too many wrong attempts. */
  locked: boolean;
  busy: boolean;
  error: string | null;
}

/** Wire shape from Rust (serde renames nothing, so these are snake-free). */
interface WireStatus {
  sharing: boolean;
  code: string | null;
  port: number | null;
  expires_at: number | null;
  seconds_left: number | null;
  locked: boolean;
}

const EMPTY: MobileState = {
  sharing: false,
  code: null,
  port: null,
  expiresAt: null,
  secondsLeft: null,
  locked: false,
  busy: false,
  error: null,
};

/** Expiry choices. Deliberately short by default: a share you forgot about is
 *  the failure mode, so the list starts at an hour and the longest is a day —
 *  which is also the backend's hard clamp. */
export const EXPIRY_CHOICES: { label: string; minutes: number }[] = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
  { label: "12 hours", minutes: 720 },
  { label: "24 hours (max)", minutes: 1440 },
];

class MobileStore {
  private state: MobileState = EMPTY;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  getSnapshot = (): MobileState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(next: Partial<MobileState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  private apply(w: WireStatus): void {
    this.set({
      sharing: w.sharing,
      code: w.code,
      port: w.port,
      expiresAt: w.expires_at,
      secondsLeft: w.seconds_left,
      locked: w.locked,
      busy: false,
      error: null,
    });
    if (w.sharing) this.startTicking();
    else this.stopTicking();
  }

  /** Ask the backend once — also how a reload recovers a share already running. */
  async refresh(): Promise<void> {
    try {
      this.apply(await invoke<WireStatus>("mobile_status"));
    } catch (e) {
      this.set({ busy: false, error: String(e) });
    }
  }

  private startTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const left = this.state.secondsLeft;
      if (left === null) return;
      if (left <= 1) {
        // Let the backend confirm rather than guessing locally: mobile_status is
        // what actually reaps the expired session and drops the listener.
        void this.refresh();
        return;
      }
      this.set({ secondsLeft: left - 1 });
    }, 1000);
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async start(minutes: number): Promise<void> {
    this.set({ busy: true, error: null });
    try {
      this.apply(await invoke<WireStatus>("mobile_start", { minutes }));
    } catch (e) {
      this.set({ busy: false, error: String(e) });
    }
  }

  async stop(): Promise<void> {
    this.set({ busy: true, error: null });
    try {
      this.apply(await invoke<WireStatus>("mobile_stop"));
    } catch (e) {
      this.set({ busy: false, error: String(e) });
    }
  }
}

export const mobileStore = new MobileStore();

export function useMobile(): MobileState {
  return useSyncExternalStore(mobileStore.subscribe, mobileStore.getSnapshot);
}

/** "3h 12m" / "12m 04s" — compact enough for a countdown that updates each second
 *  without the layout jumping. */
export function fmtCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}
