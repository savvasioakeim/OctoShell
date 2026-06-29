// Reactive registry of OctoShell-managed services, shared app-wide as a module
// singleton (like AiClient) so the InputBar can start one and the bottom
// ServiceBar can render them without threading props through the tree. Backed by
// the Rust ServiceManager via ServiceClient; subscribes to its event stream once.

import { useSyncExternalStore } from "react";
import {
  onServiceExit,
  onServiceLog,
  onServiceReady,
  startService,
  stopService,
} from "./ServiceClient";

export type ServiceStatus = "starting" | "running" | "exited";

export interface ServiceEntry {
  id: string;
  /** Project/worktree label this server belongs to. */
  name: string;
  command: string;
  cwd: string;
  status: ServiceStatus;
  port?: number;
  url?: string;
  exitCode?: number;
  logs: string[];
}

/** Keep at most this many log lines per service (a dev server is chatty). */
const MAX_LOG = 500;

class ServiceStore {
  private map = new Map<string, ServiceEntry>();
  private listeners = new Set<() => void>();
  private snap: ServiceEntry[] = [];
  private started = false;

  /** Attach the backend event listeners once (call on app mount). */
  init(): void {
    if (this.started) return;
    this.started = true;
    void onServiceReady((e) =>
      this.patch(e.id, (s) => {
        s.status = "running";
        s.port = e.port;
        s.url = e.url;
      }),
    );
    void onServiceLog((e) =>
      this.patch(e.id, (s) => {
        s.logs.push(e.line);
        if (s.logs.length > MAX_LOG) s.logs.splice(0, s.logs.length - MAX_LOG);
      }),
    );
    void onServiceExit((e) =>
      this.patch(e.id, (s) => {
        s.status = "exited";
        s.exitCode = e.code;
      }),
    );
  }

  /** Start a managed service and track it. Returns its id and (once the backend
   *  assigns one) the base URL. */
  async start(meta: { name: string; cwd: string; command: string; portHint?: number }): Promise<{ id: string; url?: string }> {
    const id = crypto.randomUUID();
    this.map.set(id, {
      id,
      name: meta.name,
      command: meta.command,
      cwd: meta.cwd,
      status: "starting",
      logs: [],
    });
    this.emit();
    try {
      const port = await startService(id, meta.cwd, meta.command, meta.portHint);
      const url = `http://localhost:${port}`;
      this.patch(id, (s) => {
        if (s.status === "starting") {
          s.port = port;
          s.url = url;
        }
      });
      return { id, url };
    } catch (e) {
      this.patch(id, (s) => {
        s.status = "exited";
        s.logs.push(`⚠️ ${e}`);
      });
      return { id };
    }
  }

  /** Stop a running service (the exit event flips it to "exited"). */
  async stop(id: string): Promise<void> {
    await stopService(id).catch(() => {});
    this.patch(id, (s) => {
      if (s.status !== "exited") s.status = "exited";
    });
  }

  /** Stop (if needed) and start the same command again under the same id/row, so
   *  the user can retry a server that failed (e.g. a transient port clash). */
  async restart(id: string): Promise<void> {
    const s = this.map.get(id);
    if (!s) return;
    await stopService(id).catch(() => {});
    this.patch(id, (e) => {
      e.status = "starting";
      e.exitCode = undefined;
      e.port = undefined;
      e.url = undefined;
      e.logs = [];
    });
    try {
      const port = await startService(id, s.cwd, s.command);
      this.patch(id, (e) => {
        if (e.status === "starting") {
          e.port = port;
          e.url = `http://localhost:${port}`;
        }
      });
    } catch (e) {
      this.patch(id, (e2) => {
        e2.status = "exited";
        e2.logs.push(`⚠️ ${e}`);
      });
    }
  }

  /** Drop an entry from the list entirely (e.g. clearing an exited row). */
  remove(id: string): void {
    if (this.map.delete(id)) this.emit();
  }

  private patch(id: string, fn: (s: ServiceEntry) => void): void {
    const s = this.map.get(id);
    if (!s) return; // event for an id we don't track — ignore
    fn(s);
    this.emit();
  }

  private emit(): void {
    this.snap = [...this.map.values()];
    this.listeners.forEach((l) => l());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): ServiceEntry[] => this.snap;
}

export const serviceStore = new ServiceStore();

/** Subscribe a component to the live list of managed services. */
export function useServices(): ServiceEntry[] {
  return useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot);
}
