// Shared app settings: the single source of truth for Claude Code profiles and
// the per-surface defaults (agents vs the orchestrator). A module singleton (like
// serviceStore) so the Settings page, the orchestrator sidebar, and every agent
// read/write one consistent set without prop-threading.

import { useSyncExternalStore } from "react";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import type { AgentProvider } from "../agents/providers";

/** A Claude Code profile = a named `CLAUDE_CONFIG_DIR` (its own logged-in account). */
export interface Profile {
  id: string;
  name: string;
  configDir: string;
}

export interface AgentDefaults {
  provider: AgentProvider;
  model: string | null;
  profileId: string | null;
}
export interface OrchestratorDefaults {
  /** Which CLI backs the orchestrator (claude / gemini). */
  provider: AgentProvider;
  model: string | null;
  profileId: string | null;
}

/** When OctoShell auto-removes a worktree (and its local folder). */
export type AutoCleanMode = "off" | "onApprove" | "onMerge";
/** Which native shell the PTY launches. */
export type DefaultShell = "powershell" | "cmd" | "wsl";
/** How fast the PCB trace animations flow while agents work. */
export type TraceSpeed = "fast" | "normal" | "stealth" | "static";
/** Speech-to-text backend: the browser's free Web Speech API, or Whisper. */
export type SttEngine = "web" | "whisper";

export interface WorkspaceSettings {
  /** The orchestrator isolates each dispatched task in its own git worktree. */
  orchestratorWorktrees: boolean;
  /** When to auto-delete a finished worktree. */
  autoClean: AutoCleanMode;
  /** Branch new worktrees are created from ("" = the main worktree's HEAD). */
  baseBranch: string;
  /** Copy `.env*` files into a freshly-created worktree. */
  copyEnv: boolean;
  /** Which native shell the terminal launches. */
  defaultShell: DefaultShell;
}
export interface AppearanceSettings {
  /** Monospace font family for the terminal/feed ("" = theme default). */
  fontFamily: string;
  /** PCB trace animation speed. */
  traceSpeed: TraceSpeed;
  /** Play subtle sci-fi SFX on task done / error. */
  sfx: boolean;
}
export interface SystemSettings {
  /** Max terminal output lines kept per command block before trimming. */
  scrollback: number;
}

export interface SettingsState {
  profiles: Profile[];
  agent: AgentDefaults;
  orchestrator: OrchestratorDefaults;
  /** Global rules appended to the orchestrator and every agent's instructions. */
  globalRules: string;
  /** Session $ spend brake (null = off). Stops everything when exceeded. */
  spendLimitUsd: number | null;
  /** Speech-to-text engine for the mic button (default: free Web Speech API). */
  sttEngine: SttEngine;
  workspace: WorkspaceSettings;
  appearance: AppearanceSettings;
  system: SystemSettings;
}

const DEFAULT_WORKSPACE: WorkspaceSettings = {
  orchestratorWorktrees: true,
  autoClean: "off",
  baseBranch: "",
  copyEnv: true,
  defaultShell: "powershell",
};
const DEFAULT_APPEARANCE: AppearanceSettings = {
  fontFamily: "",
  traceSpeed: "normal",
  sfx: false,
};
const DEFAULT_SYSTEM: SystemSettings = { scrollback: 1000 };

class SettingsStore {
  private state: SettingsState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = {
      profiles: loadJSON<Profile[]>(KEY.aiProfiles, []),
      agent: loadJSON<AgentDefaults>(KEY.agentDefaults, { provider: "claude", model: null, profileId: null }),
      // Seed the orchestrator default from the older standalone orchestrator keys
      // (model/profile) so existing setups carry over.
      // Seed from the older standalone keys, then overlay the persisted object.
      // Typed Partial so an older persisted blob (pre-provider) leaves the
      // "claude" default in place instead of resolving to undefined.
      orchestrator: {
        provider: "claude",
        model: loadJSON<string | null>(KEY.aiModel, null),
        profileId: loadJSON<string | null>(KEY.aiProfile, null),
        ...loadJSON<Partial<OrchestratorDefaults>>(KEY.orchestratorDefaults, {}),
      },
      globalRules: loadJSON<string>(KEY.globalRules, ""),
      spendLimitUsd: loadJSON<number | null>(KEY.spendLimit, null),
      sttEngine: loadJSON<SttEngine>(KEY.sttEngine, "web"),
      // Merge persisted over defaults so a new field added later is filled in.
      workspace: { ...DEFAULT_WORKSPACE, ...loadJSON<Partial<WorkspaceSettings>>(KEY.workspaceSettings, {}) },
      appearance: { ...DEFAULT_APPEARANCE, ...loadJSON<Partial<AppearanceSettings>>(KEY.appearanceSettings, {}) },
      system: { ...DEFAULT_SYSTEM, ...loadJSON<Partial<SystemSettings>>(KEY.systemSettings, {}) },
    };
  }

  getSnapshot = (): SettingsState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private commit(next: SettingsState): void {
    this.state = next;
    saveJSON(KEY.aiProfiles, next.profiles);
    saveJSON(KEY.agentDefaults, next.agent);
    saveJSON(KEY.orchestratorDefaults, next.orchestrator);
    saveJSON(KEY.globalRules, next.globalRules);
    saveJSON(KEY.spendLimit, next.spendLimitUsd);
    saveJSON(KEY.sttEngine, next.sttEngine);
    saveJSON(KEY.workspaceSettings, next.workspace);
    saveJSON(KEY.appearanceSettings, next.appearance);
    saveJSON(KEY.systemSettings, next.system);
    this.listeners.forEach((l) => l());
  }

  addProfile(name: string, configDir: string): Profile {
    const p: Profile = { id: crypto.randomUUID(), name, configDir };
    this.commit({ ...this.state, profiles: [...this.state.profiles, p] });
    return p;
  }

  removeProfile(id: string): void {
    const { agent, orchestrator } = this.state;
    this.commit({
      ...this.state,
      profiles: this.state.profiles.filter((p) => p.id !== id),
      agent: agent.profileId === id ? { ...agent, profileId: null } : agent,
      orchestrator: orchestrator.profileId === id ? { ...orchestrator, profileId: null } : orchestrator,
    });
  }

  setAgentDefaults(patch: Partial<AgentDefaults>): void {
    this.commit({ ...this.state, agent: { ...this.state.agent, ...patch } });
  }
  setOrchestratorDefaults(patch: Partial<OrchestratorDefaults>): void {
    this.commit({ ...this.state, orchestrator: { ...this.state.orchestrator, ...patch } });
  }
  setGlobalRules(rules: string): void {
    this.commit({ ...this.state, globalRules: rules });
  }
  setSpendLimit(usd: number | null): void {
    this.commit({ ...this.state, spendLimitUsd: usd });
  }
  setSttEngine(engine: SttEngine): void {
    this.commit({ ...this.state, sttEngine: engine });
  }
  setWorkspace(patch: Partial<WorkspaceSettings>): void {
    this.commit({ ...this.state, workspace: { ...this.state.workspace, ...patch } });
  }
  setAppearance(patch: Partial<AppearanceSettings>): void {
    this.commit({ ...this.state, appearance: { ...this.state.appearance, ...patch } });
  }
  setSystem(patch: Partial<SystemSettings>): void {
    this.commit({ ...this.state, system: { ...this.state.system, ...patch } });
  }

  /** Resolve a profile id to its config dir (null = home default). */
  configDirFor(profileId: string | null): string | null {
    return this.state.profiles.find((p) => p.id === profileId)?.configDir ?? null;
  }
}

export const settingsStore = new SettingsStore();

/** Subscribe a component to the shared settings. */
export function useSettings(): SettingsState {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
}

/** Models offered for claude (CLI aliases passed to `--model`; null = CLI default). */
export const CLAUDE_MODELS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Fable", value: "fable" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

/** Models offered for gemini (passed to `-m`; null = CLI default). */
export const GEMINI_MODELS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
  { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
];

/** The model list for a given provider. */
export function modelsFor(provider: AgentProvider): { label: string; value: string | null }[] {
  return provider === "gemini" ? GEMINI_MODELS : CLAUDE_MODELS;
}
