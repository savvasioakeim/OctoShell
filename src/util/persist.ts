// Tiny localStorage-backed persistence. WebView2 keeps localStorage in the app's
// user-data folder, so it survives restarts. All access is guarded — a quota
// error or disabled storage degrades gracefully to "no persistence".

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded / storage unavailable — skip */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---- key helpers (one namespace, per-session suffixes) ----
export const KEY = {
  projects: "octoshell.projects",
  assistant: "octoshell.assistant",
  layout: "octoshell.layout",
  groups: "octoshell.groups",
  actions: "octoshell.actions",
  blocks: (id: string) => `octoshell.blocks.${id}`,
  agent: (id: string) => `octoshell.agent.${id}`,
  model: (id: string) => `octoshell.model.${id}`,
  provider: (id: string) => `octoshell.provider.${id}`,
  pr: (id: string) => `octoshell.pr.${id}`,
};
