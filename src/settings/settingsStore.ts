// Shared app settings: the single source of truth for Claude Code profiles and
// the per-surface defaults (agents vs the orchestrator). A module singleton (like
// serviceStore) so the Settings page, the orchestrator sidebar, and every agent
// read/write one consistent set without prop-threading.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  /** Copy the base repo's installed dependency dirs (node_modules, vendor, …) into
   *  a freshly-created worktree, so its dev server / tests run without a reinstall.
   *  A git worktree never inherits these. */
  copyDeps: boolean;
  /** Ports to always show in the Ports panel (even when free), on top of whatever
   *  is actually listening. The "basic ports we use", editable by the user. */
  trackedPorts: number[];
  /** Which native shell the terminal launches. */
  defaultShell: DefaultShell;
  /** On exit, fold each session's older history into a summary block instead of
   *  letting the persist cap silently drop it. */
  compactOnExit: boolean;
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
  /** Run ACP agents' shell commands inside a Docker sandbox (host isolation)
   *  instead of directly on the host. Off by default (needs a Docker daemon). */
  sandboxAgentCommands: boolean;
}
/** The automated review agent: a second agent that vets each coding agent's diff
 *  (with the orchestrator's task context) BEFORE QA is ever offered. Distinct from
 *  QA mode (the human acceptance window). */
export interface ReviewAgentSettings {
  /** Master switch — when off, no review agents ever spawn. */
  enabled: boolean;
  /** Which CLI backs the review agent (same provider list as coding agents). */
  provider: AgentProvider;
  /** Selected model (null = provider default). */
  model: string | null;
  /** Selected profile (a Claude Code CLAUDE_CONFIG_DIR account); null = home
   *  default. Lets the reviewer run under a different account than the coder. */
  profileId: string | null;
}

/** Local LLM (Ollama) integration: the base endpoint plus the shared generation
 *  knobs applied when an agent runs on a local model. Model *assignment* stays on
 *  each surface's provider/model picker (pick the `Local · Ollama (ACP)` provider);
 *  these are the connection + inference defaults. */
export interface OllamaSettings {
  /** Ollama HTTP endpoint (default http://localhost:11434). */
  baseUrl: string;
  /** Context window (num_ctx) for local runs, in tokens. */
  contextWindow: number;
  /** Sampling temperature (0 = strict/deterministic … 1 = creative). */
  temperature: number;
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
  /** Automated pre-QA review agent (global). */
  reviewAgent: ReviewAgentSettings;
  /** Local LLM (Ollama) connection + inference defaults. */
  ollama: OllamaSettings;
  /** MCP server names the ORCHESTRATOR is allowed to use (from the user's Claude
   *  config). Empty = planner-only (no MCP loaded). Ticked per server in Settings
   *  → MCP access; only their tools are pre-approved, never file/Bash tools. */
  orchestratorMcp: string[];
  /** Give the orchestrator READ-ONLY inspection tools (Read/Grep/Glob + a git/gh/ls
   *  read-only Bash allowlist) so it can verify state instead of guessing. Never
   *  Edit/Write or unrestricted Bash — code is written only by dispatched agents. */
  orchestratorReadonly: boolean;
  /** Workspace memory: semantic recall over past reports/reviews/dispatches. */
  memory: MemorySettings;
}

export interface MemorySettings {
  /** Off by default: the first use downloads ~90 MB of model weights, and the
   *  index costs resident RAM. Both should be the user's choice, not a surprise. */
  enabled: boolean;
  /** Memories older than this are deleted. The primary bound on RAM — and a
   *  quality control, since stale history misleads more than it helps. */
  retentionMonths: number;
  /** How many memories are injected into the orchestrator's context. */
  topK: number;
}

const DEFAULT_WORKSPACE: WorkspaceSettings = {
  orchestratorWorktrees: true,
  autoClean: "off",
  baseBranch: "",
  copyEnv: true,
  copyDeps: true,
  trackedPorts: [3000, 5173, 1420, 8080, 4000],
  defaultShell: "powershell",
  compactOnExit: true,
};
const DEFAULT_APPEARANCE: AppearanceSettings = {
  fontFamily: "",
  traceSpeed: "normal",
  sfx: false,
};
const DEFAULT_SYSTEM: SystemSettings = { scrollback: 1000, sandboxAgentCommands: false };
const DEFAULT_MEMORY: MemorySettings = { enabled: false, retentionMonths: 6, topK: 6 };
const DEFAULT_REVIEW_AGENT: ReviewAgentSettings = { enabled: false, provider: "claude", model: null, profileId: null };
const DEFAULT_OLLAMA: OllamaSettings = {
  baseUrl: "http://localhost:11434",
  contextWindow: 8192,
  temperature: 0.2,
};

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
      reviewAgent: { ...DEFAULT_REVIEW_AGENT, ...loadJSON<Partial<ReviewAgentSettings>>(KEY.reviewAgent, {}) },
      ollama: { ...DEFAULT_OLLAMA, ...loadJSON<Partial<OllamaSettings>>(KEY.ollamaSettings, {}) },
      orchestratorMcp: loadJSON<string[]>(KEY.orchestratorMcp, []),
      orchestratorReadonly: loadJSON<boolean>(KEY.orchestratorReadonly, true),
      memory: { ...DEFAULT_MEMORY, ...loadJSON<Partial<MemorySettings>>(KEY.memorySettings, {}) },
    };
    // Push the persisted sandbox flag to the backend once at startup so the ACP
    // terminal routing matches the UI from the first turn (fire-and-forget).
    this.pushSandbox();
  }

  /** Mirror the global sandbox flag to the Rust `SandboxConfig` so acp.rs routes
   *  terminal commands accordingly. Fire-and-forget (harmless before Tauri is up). */
  private pushSandbox(): void {
    invoke("set_sandbox_enabled", { enabled: this.state.system.sandboxAgentCommands }).catch(() => {});
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
    saveJSON(KEY.reviewAgent, next.reviewAgent);
    saveJSON(KEY.ollamaSettings, next.ollama);
    saveJSON(KEY.orchestratorMcp, next.orchestratorMcp);
    saveJSON(KEY.orchestratorReadonly, next.orchestratorReadonly);
    saveJSON(KEY.memorySettings, next.memory);
    this.listeners.forEach((l) => l());
  }

  setOrchestratorReadonly(on: boolean): void {
    this.commit({ ...this.state, orchestratorReadonly: on });
  }

  setMemory(patch: Partial<MemorySettings>): void {
    this.commit({ ...this.state, memory: { ...this.state.memory, ...patch } });
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
    if (patch.sandboxAgentCommands !== undefined) this.pushSandbox();
  }
  setReviewAgent(patch: Partial<ReviewAgentSettings>): void {
    this.commit({ ...this.state, reviewAgent: { ...this.state.reviewAgent, ...patch } });
  }
  setOllama(patch: Partial<OllamaSettings>): void {
    this.commit({ ...this.state, ollama: { ...this.state.ollama, ...patch } });
  }
  /** Toggle whether the orchestrator may use a given MCP server. */
  setOrchestratorMcp(name: string, allowed: boolean): void {
    const set = new Set(this.state.orchestratorMcp);
    if (allowed) set.add(name);
    else set.delete(name);
    this.commit({ ...this.state, orchestratorMcp: [...set] });
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

/** Models offered for gemini (passed to `-m`; null = CLI default). Kept in sync
 *  with InputBar's MODELS_BY_PROVIDER.gemini — the names this build reports. */
export const GEMINI_MODELS: { label: string; value: string | null }[] = [
  { label: "Default (auto)", value: null },
  { label: "Gemini 3 Pro", value: "gemini-3.1-pro-preview" },
  { label: "Gemini 3 Flash", value: "gemini-3-flash-preview" },
  { label: "Gemini 3 Flash Lite", value: "gemini-3.1-flash-lite" },
];

/** Models offered for local Ollama (via OpenCode's ACP server). Values carry the
 *  `ollama/` provider prefix OpenCode expects (`-m ollama/<model>`); null = let
 *  OpenCode use its configured default. These are common local coding models —
 *  the user must have pulled them (`ollama pull …`) and configured the `ollama`
 *  provider in OpenCode. Qwen2.5-Coder is the strongest at agentic tool-use;
 *  Gemma is lighter but weaker at multi-step tool calls. */
export const OLLAMA_MODELS: { label: string; value: string | null }[] = [
  { label: "Default (OpenCode)", value: null },
  { label: "Qwen2.5 Coder 14B", value: "ollama/qwen2.5-coder:14b" },
  { label: "Qwen2.5 Coder 7B", value: "ollama/qwen2.5-coder:7b" },
  { label: "Qwen2.5 Coder 3B", value: "ollama/qwen2.5-coder:3b" },
  { label: "Gemma 3 4B", value: "ollama/gemma3:4b" },
];

/** Providers with no wired-up model picker (model selection isn't plumbed through
 *  their adapter yet) — they run their own default, so only "Default" is offered.
 *  Prevents e.g. Codex from wrongly showing Claude's model aliases. */
const DEFAULT_ONLY: { label: string; value: string | null }[] = [{ label: "Default", value: null }];

/** The model list for a given provider. */
export function modelsFor(provider: AgentProvider): { label: string; value: string | null }[] {
  if (provider === "claude" || provider === "acp-claude") return CLAUDE_MODELS;
  if (provider === "gemini" || provider === "acp-gemini") return GEMINI_MODELS;
  if (provider === "acp-ollama") return OLLAMA_MODELS;
  return DEFAULT_ONLY; // codex, cursor, copilot, kiro, opencode — default only
}
