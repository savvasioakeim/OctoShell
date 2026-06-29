// Frontend client for OctoShell's managed services (see src-tauri/src/service.rs).
// Thin typed wrapper around the `service_start`/`service_stop` commands plus the
// `service://ready|log|exit` event stream. A higher-level store/UI (Services
// panel, review-mode "open server") builds on this.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ServiceReady {
  id: string;
  port: number;
  url: string;
}
export interface ServiceLog {
  id: string;
  line: string;
}
export interface ServiceExit {
  id: string;
  code: number;
}

/** Start a managed service. `id` is caller-chosen (one service per id; starting
 *  again replaces it). Returns the port OctoShell assigned (refined later via the
 *  `ready` event if the server reports a different one). `portHint` requests a
 *  specific port when free. */
export function startService(
  id: string,
  cwd: string,
  command: string,
  portHint?: number,
): Promise<number> {
  return invoke<number>("service_start", { id, cwd, command, port: portHint ?? null });
}

/** Stop (kill) a managed service by id. No-op if it isn't running. */
export function stopService(id: string): Promise<void> {
  return invoke("service_stop", { id });
}

export function onServiceReady(cb: (e: ServiceReady) => void): Promise<UnlistenFn> {
  return listen<ServiceReady>("service://ready", (e) => cb(e.payload));
}
export function onServiceLog(cb: (e: ServiceLog) => void): Promise<UnlistenFn> {
  return listen<ServiceLog>("service://log", (e) => cb(e.payload));
}
export function onServiceExit(cb: (e: ServiceExit) => void): Promise<UnlistenFn> {
  return listen<ServiceExit>("service://exit", (e) => cb(e.payload));
}
