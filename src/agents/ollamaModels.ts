// Shared, live list of locally-installed Ollama models, so every model picker
// (the per-session InputBar dropdown, the Settings model selects, the Local LLM
// tab) offers exactly what the user has actually pulled — no hardcoded, staleable
// lists. A module singleton (like settingsStore) fetched once from `ollama_tags`
// and refreshable; components subscribe via useSyncExternalStore.

import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settingsStore } from "../settings/settingsStore";

interface OllamaModelsSnapshot {
  /** Installed model tags (e.g. "qwen2.5-coder:7b"), sorted. */
  models: string[];
  /** True once a fetch has completed at least once (success or empty). */
  loaded: boolean;
}

let snapshot: OllamaModelsSnapshot = { models: [], loaded: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): OllamaModelsSnapshot {
  return snapshot;
}

/** Re-query Ollama for the installed models. De-duped: concurrent callers share
 *  one in-flight request. Best-effort — an unreachable daemon yields an empty
 *  list (but still marks `loaded`, so pickers show just "Agent default"). */
export async function refreshOllamaModels(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    let models: string[] = [];
    try {
      const base = settingsStore.getSnapshot().ollama.baseUrl;
      models = await invoke<string[]>("ollama_tags", { baseUrl: base });
    } catch {
      models = [];
    } finally {
      snapshot = { models, loaded: true };
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/** Subscribe to the installed-model list, triggering a first fetch on mount. */
export function useOllamaModels(): OllamaModelsSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (!snap.loaded) void refreshOllamaModels();
  }, [snap.loaded]);
  return snap;
}

/** Build a model-picker option list from installed tags: a leading "Agent
 *  default" (null → let the adapter/OpenCode choose) then each installed model,
 *  values carrying the `ollama/` prefix OpenCode expects. */
export function ollamaModelOptions(models: string[]): { label: string; value: string | null }[] {
  return [
    { label: "Agent default", value: null },
    ...models.map((m) => ({ label: m, value: `ollama/${m}` })),
  ];
}
