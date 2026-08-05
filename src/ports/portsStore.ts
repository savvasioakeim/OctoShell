// Live view of the machine's LISTENING TCP ports, for the sidebar Ports panel.
// Polls the backend `list_ports` on an interval (cheap: one netstat + tasklist)
// and exposes a kill action. Kept as a module singleton so any number of mounts
// share one poll loop.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
}

class PortsStore {
  private ports: PortInfo[] = [];
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs = 0;

  getSnapshot = (): PortInfo[] => this.ports;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    // First subscriber starts the poll loop (and refreshes immediately).
    if (++this.refs === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), 4000);
    }
    return () => {
      this.listeners.delete(cb);
      if (--this.refs === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  async refresh(): Promise<void> {
    try {
      const next = await invoke<PortInfo[]>("list_ports");
      // Only churn React if something actually changed (poll is frequent).
      if (JSON.stringify(next) !== JSON.stringify(this.ports)) {
        this.ports = next;
        this.listeners.forEach((l) => l());
      }
    } catch {
      /* transient netstat failure — keep the last snapshot */
    }
  }

  /** Kill whatever is listening on `port`, then refresh. Returns count killed. */
  async kill(port: number): Promise<number> {
    let n = 0;
    try {
      n = await invoke<number>("kill_port", { port });
    } catch {
      /* ignore — refresh will show it's still there */
    }
    await this.refresh();
    return n;
  }
}

export const portsStore = new PortsStore();

/** React hook: the live list of listening ports (re-renders on change). */
export function usePorts(): PortInfo[] {
  return useSyncExternalStore(portsStore.subscribe, portsStore.getSnapshot);
}
