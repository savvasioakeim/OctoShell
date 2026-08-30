// Sharing state for the phone companion, shared app-wide as a module singleton.
//
// The countdown is the reason this is a store rather than local component state:
// an expiring share must stop looking live everywhere at once, and the backend
// reaps the session on the next status call — so the ticking here is also what
// makes expiry actually take the listener down when no one is looking at Settings.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settingsStore } from "../settings/settingsStore";

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
  /** Public URL from cloudflared, or null when only local. */
  tunnelUrl: string | null;
  tunnelBusy: boolean;
  /** Why the tunnel isn't up — usually "cloudflared isn't installed". */
  tunnelError: string | null;
}

/** Wire shape from Rust (serde renames nothing, so these are snake-free). */
interface WireTunnel {
  running: boolean;
  url: string | null;
}

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
  tunnelUrl: null,
  tunnelBusy: false,
  tunnelError: null,
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
    // A share that ended must not leave a tunnel behind pointing at a dead port.
    if (!w.sharing && this.state.tunnelUrl) void this.stopTunnel();
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
      const t = await invoke<WireTunnel>("tunnel_status");
      this.set({ tunnelUrl: t.running ? t.url : null });
    } catch (e) {
      this.set({ busy: false, error: String(e) });
    }
  }

  /** Open a public tunnel to the running share. */
  async startTunnel(): Promise<void> {
    const port = this.state.port;
    if (!port) return;
    this.set({ tunnelBusy: true, tunnelError: null });
    try {
      const cfg = settingsStore.getSnapshot().mobile;
      const named = cfg.mode === "named";
      const t = await invoke<WireTunnel>("tunnel_start", {
        port,
        token: named ? cfg.token : null,
        hostname: named ? cfg.hostname : null,
      });
      this.set({ tunnelUrl: t.url, tunnelBusy: false });
    } catch (e) {
      // Not having cloudflared is the common case, not a crash — the local
      // server keeps working, so this is a note rather than a failure.
      this.set({ tunnelBusy: false, tunnelError: String(e) });
    }
  }

  async stopTunnel(): Promise<void> {
    try {
      await invoke<WireTunnel>("tunnel_stop");
    } finally {
      this.set({ tunnelUrl: null, tunnelError: null });
    }
  }

  private startTicking(): void {
    if (this.timer) return;
    let tick = 0;
    this.timer = setInterval(() => {
      // Every ten seconds, ask whether the tunnel is still alive. cloudflared can
      // die on its own, and a UI still showing its address would send you to a
      // dead link from your phone with nothing to explain it.
      if (this.state.tunnelUrl && ++tick % 10 === 0) {
        void invoke<WireTunnel>("tunnel_status")
          .then((t) => {
            if (!t.running && this.state.tunnelUrl) {
              this.set({ tunnelUrl: null, tunnelError: "The tunnel stopped. Open a new address." });
            }
          })
          .catch(() => {});
      }
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
    const cfg = settingsStore.getSnapshot().mobile;
    try {
      // A named tunnel's ingress points at a fixed port, so the companion has to
      // bind there rather than wherever the OS felt like.
      const port = cfg.mode === "named" ? cfg.port : null;
      this.apply(await invoke<WireStatus>("mobile_start", { minutes, port }));
    } catch (e) {
      this.set({ busy: false, error: String(e) });
    }
  }

  async stop(): Promise<void> {
    this.set({ busy: true, error: null });
    try {
      // Order matters: drop the tunnel FIRST, so there is never a public URL
      // pointing at a port that is about to belong to something else.
      await this.stopTunnel();
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
