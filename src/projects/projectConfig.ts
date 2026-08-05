// Per-project script overrides. OctoShell otherwise GUESSES a project's dev-server
// command (the orchestrator's QA blocks default to "npm run dev", and service.rs
// repairs it against package.json) — which picks the wrong script for repos whose
// dev server lives under a different name (e.g. ridebly-be, whose server is under
// `start`). This lets the user pin the exact commands per project, removing the
// guess entirely.
//
// Keyed by the project's working directory (normalised). v1 is per-cwd: a worktree
// and its base repo are separate entries — fine, since you configure the project
// you actually run QA against. Persisted to localStorage; shared app-wide as a
// module singleton and exposed to React via useSyncExternalStore.

import { useSyncExternalStore } from "react";
import { KEY, loadJSON, saveJSON } from "../util/persist";

export interface ProjectScripts {
  /** Command that starts this project's dev server (used by QA / managed run). */
  dev?: string;
  /** Command that runs this project's test suite. */
  test?: string;
}

/** Normalise a filesystem path into a stable map key (case- and slash-insensitive
 *  — Windows paths vary in both). */
function normKey(cwd: string): string {
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

type Store = Record<string, ProjectScripts>;

class ProjectConfigStore {
  private map: Store = loadJSON<Store>(KEY.projectScripts, {});
  private listeners = new Set<() => void>();

  getSnapshot = (): Store => this.map;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** The configured scripts for a project cwd (empty object if none set). */
  get(cwd: string): ProjectScripts {
    if (!cwd) return {};
    return this.map[normKey(cwd)] ?? {};
  }

  /** Set (or clear) one field for a project cwd. Empty string clears it. */
  set(cwd: string, field: keyof ProjectScripts, value: string): void {
    if (!cwd) return;
    const k = normKey(cwd);
    const next: Store = { ...this.map };
    const entry: ProjectScripts = { ...next[k] };
    const v = value.trim();
    if (v) entry[field] = v;
    else delete entry[field];
    if (Object.keys(entry).length) next[k] = entry;
    else delete next[k];
    this.map = next;
    saveJSON(KEY.projectScripts, this.map);
    this.listeners.forEach((l) => l());
  }
}

export const projectConfigStore = new ProjectConfigStore();

/** React hook: the scripts configured for one project cwd (re-renders on change). */
export function useProjectScripts(cwd: string): ProjectScripts {
  const map = useSyncExternalStore(projectConfigStore.subscribe, projectConfigStore.getSnapshot);
  return cwd ? map[normKey(cwd)] ?? {} : {};
}
