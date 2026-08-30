// The installed-mods registry: reads manifests off disk, validates them, and
// exposes what the enabled ones contribute.
//
// Module singleton exposed through useSyncExternalStore, like serviceStore and
// memoryStore — so any component can read the same list without prop drilling.
//
// Loading is explicitly a THREE-state affair per mod: valid-and-enabled,
// valid-but-disabled, and broken. Broken mods stay in the list with their errors
// rather than being skipped, because a mod that silently fails to appear is the
// worst possible outcome for someone who just installed one and is looking for it.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import { setModStackSource, type StackDef } from "../projects/stacks";
import { validateManifest, type LoadedMod, type ModMcpServer } from "./modTypes";

interface RawMod {
  dir: string;
  path: string;
  json: string | null;
  error: string | null;
}

export interface ModsState {
  /** Every folder found, valid or not, in a stable order. */
  mods: LoadedMod[];
  /** Absolute path of the mods folder, for "open folder". */
  dir: string;
  loading: boolean;
  /** Set when the whole scan failed (not a per-mod problem). */
  error: string | null;
}

const EMPTY: ModsState = { mods: [], dir: "", loading: false, error: null };

class ModStore {
  private state: ModsState = EMPTY;
  private listeners = new Set<() => void>();
  /** Mod ids the user switched OFF. Absent = enabled, so a freshly installed mod
   *  works without a second step — but see `refresh`: it is only ever loaded
   *  after its permissions have been rendered. */
  private disabled: string[] = loadJSON<string[]>(KEY.modsDisabled, []);
  private started = false;

  getSnapshot = (): ModsState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(next: Partial<ModsState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  /** Load once on app start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Hand the stack table a live view of mod contributions. Done here rather
    // than by importing this store from stacks.ts, so that module keeps no
    // dependencies and mods stay strictly additive to a table that works alone.
    setModStackSource(() => this.stacks());
    void this.refresh();
  }

  /** Re-scan the mods folder. Safe to call any time (e.g. after the user drops a
   *  folder in and presses Reload). */
  async refresh(): Promise<void> {
    this.emit({ loading: true, error: null });
    try {
      const [raw, dir] = await Promise.all([
        invoke<RawMod[]>("mods_list"),
        invoke<string>("mods_dir_path"),
      ]);
      const seen = new Set<string>();
      const mods: LoadedMod[] = raw.map((r) => {
        if (r.json === null) {
          return { dir: r.dir, path: r.path, stacks: [], errors: [r.error ?? "unreadable"] };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.json);
        } catch (e) {
          return { dir: r.dir, path: r.path, stacks: [], errors: [`mod.json is not valid JSON — ${e}`] };
        }
        const res = validateManifest(r.dir, parsed);
        if ("errors" in res) return { dir: r.dir, path: r.path, stacks: [], errors: res.errors };
        // Two folders can't both claim an id; the first in (alphabetical) order
        // keeps it, so the outcome doesn't depend on filesystem enumeration luck.
        if (seen.has(res.manifest.id)) {
          return {
            dir: r.dir,
            path: r.path,
            stacks: [],
            errors: [`duplicate mod id "${res.manifest.id}" — another folder already uses it`],
          };
        }
        seen.add(res.manifest.id);
        return { dir: r.dir, path: r.path, manifest: res.manifest, stacks: res.stacks, errors: [] };
      });
      this.emit({ mods, dir, loading: false });
    } catch (e) {
      this.emit({ loading: false, error: String(e) });
    }
  }

  /** Valid mods the user hasn't switched off. Only these contribute anything. */
  private active(): LoadedMod[] {
    return this.state.mods.filter(
      (m) => m.manifest && !m.errors.length && !this.disabled.includes(m.manifest.id),
    );
  }

  isEnabled(id: string): boolean {
    return !this.disabled.includes(id);
  }

  setEnabled(id: string, on: boolean): void {
    this.disabled = on ? this.disabled.filter((x) => x !== id) : [...new Set([...this.disabled, id])];
    saveJSON(KEY.modsDisabled, this.disabled);
    // The state object itself didn't change, but what the app derives from it
    // did — re-notify so the stack table and the UI both refresh.
    this.emit({});
  }

  /** Stacks contributed by enabled mods, in mod order. */
  stacks(): StackDef[] {
    return this.active().flatMap((m) => m.stacks);
  }

  /** MCP servers contributed by enabled mods, keyed by server name. */
  mcpServers(): Record<string, ModMcpServer> {
    const out: Record<string, ModMcpServer> = {};
    for (const m of this.active()) {
      for (const [name, def] of Object.entries(m.manifest?.contributes.mcpServers ?? {})) {
        out[name] = def;
      }
    }
    return out;
  }
}

export const modStore = new ModStore();

/** React hook: the installed-mods list (re-renders on load and on enable/disable). */
export function useMods(): ModsState {
  return useSyncExternalStore(modStore.subscribe, modStore.getSnapshot);
}
