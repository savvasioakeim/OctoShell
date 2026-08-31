import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { EXPIRY_CHOICES, fmtCountdown, mobileStore, useMobile } from "../mobile/mobileStore";
import { modStore, useMods } from "../mods/modStore";
import { PERMISSION_LABELS } from "../mods/modTypes";
import { exportWorkspace, importWorkspace, peekWorkspace, type Snapshot } from "../util/workspaceTransfer";
import {
  modelsFor,
  settingsStore,
  useSettings,
  type AutoCleanMode,
  type DefaultShell,
  type OllamaSettings,
  type Profile,
  type SttEngine,
  type TraceSpeed,
} from "./settingsStore";
import { PROVIDERS, supportsProfile, type AgentProvider } from "../agents/providers";
import { useOllamaModels, ollamaModelOptions, refreshOllamaModels } from "../agents/ollamaModels";
import { strategyStore, useStrategy } from "../strategy/strategyStore";
import type { StrategyRole } from "../strategy/roles";
import { vacuumDb, type VacuumResult } from "../util/db";
import { memoryStore, useMemoryStats } from "../memory/memoryStore";
import { projectConfigStore, useProjectScripts } from "../projects/projectConfig";

type TabId = "ai" | "local" | "roles" | "projects" | "workspace" | "appearance" | "system";
const TABS: { id: TabId; label: string }[] = [
  { id: "ai", label: "Profiles & AI" },
  { id: "local", label: "Local LLM" },
  { id: "roles", label: "Strategy Roles" },
  { id: "projects", label: "Project Scripts" },
  { id: "workspace", label: "Workspace & Git" },
  { id: "appearance", label: "Appearance" },
  { id: "system", label: "System & Database" },
];

/** An open project, passed in so the Project Scripts tab can list them. */
export interface SettingsProject {
  id: string;
  name: string;
  cwd: string;
  /** Set when this project is a worktree nested under that parent project. */
  parentId?: string;
}

/** Monospace fonts offered for the terminal/feed ("" = the app's theme default). */
const FONTS: { label: string; value: string }[] = [
  { label: "Theme default", value: "" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "Fira Code", value: "Fira Code" },
  { label: "Consolas", value: "Consolas" },
  { label: "IBM Plex Mono", value: "IBM Plex Mono" },
];

/**
 * Full-page application settings, organised into tabs: the per-surface AI
 * defaults & profiles, the Git/worktree automation, the look & feel, and storage
 * maintenance. Everything reads/writes the shared {@link settingsStore}.
 */
export function SettingsPage({
  onClose,
  onSandboxLogin,
  onShowOnboarding,
  initialTab,
  focusProjectCwd,
  projects = [],
}: {
  onClose: () => void;
  onSandboxLogin: () => void;
  onShowOnboarding: () => void;
  initialTab?: string;
  focusProjectCwd?: string;
  projects?: SettingsProject[];
}) {
  const [tab, setTab] = useState<TabId>((initialTab as TabId) || "ai");

  return (
    <div className="flex h-full flex-col bg-well text-gray-100">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-100">Settings</h1>
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm text-muted transition-colors hover:bg-edge hover:text-gray-200"
        >
          ✕ Close
        </button>
      </div>

      <div className="flex flex-1 gap-2 overflow-hidden px-2 pb-2">
        {/* Vertical tab rail — its own panel. */}
        <nav className="flex w-52 shrink-0 flex-col gap-1 rounded-xl border border-edge bg-panel p-2">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  active ? "bg-edge" : "text-muted hover:bg-edge/50 hover:text-gray-200"
                }`}
              >
                <span className={active ? "text-grad font-semibold" : undefined}>{t.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Content — one panel; sections are nested cards inside it. */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-edge bg-panel p-4">
          <div className="mx-auto max-w-2xl space-y-3">
            {tab === "ai" && <AiTab />}
            {tab === "local" && <LocalLlmTab />}
            {tab === "roles" && <StrategyRolesTab />}
            {tab === "projects" && <ProjectScriptsTab projects={projects} focusCwd={focusProjectCwd} />}
            {tab === "workspace" && <WorkspaceTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "system" && <SystemTab onSandboxLogin={onSandboxLogin} onShowOnboarding={onShowOnboarding} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Profiles & AI
// ---------------------------------------------------------------------------
function AiTab() {
  const { profiles, agent, orchestrator, globalRules, spendLimitUsd, reviewAgent, orchestratorReadonly } = useSettings();

  const addProfile = async () => {
    const dir = await open({ directory: true, title: "Pick a profile folder (CLAUDE_CONFIG_DIR)" });
    if (typeof dir !== "string") return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || "profile";
    settingsStore.addProfile(name, dir);
  };

  return (
    <>
      <Section title="Claude Code Profiles" desc="Accounts (CLAUDE_CONFIG_DIR) — shared by agents and the orchestrator.">
        <div className="space-y-1.5">
          {profiles.length === 0 && (
            <p className="text-xs text-muted">No profiles yet — add an account's folder.</p>
          )}
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded border border-edge px-2 py-1.5 text-sm">
              <span className="font-medium">{p.name}</span>
              <span className="flex-1 truncate text-xs text-muted">{p.configDir}</span>
              <button
                onClick={() => settingsStore.removeProfile(p.id)}
                title="Delete"
                className="text-muted hover:text-red-300"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => void addProfile()}
            className="btn-grad rounded px-3 py-1.5 text-sm font-medium"
          >
            + Add profile…
          </button>
        </div>
      </Section>

      <Section title="Agents — default" desc="What new agents start with (applies to new sessions).">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Provider">
            <Select
              value={agent.provider}
              // Reset the model on a provider switch: a claude alias ("opus") is
              // meaningless to gemini/ollama and vice-versa (mirrors the orchestrator).
              onChange={(v) => settingsStore.setAgentDefaults({ provider: v as AgentProvider, model: null })}
              options={PROVIDERS.map((p) => ({ label: p.label, value: p.value }))}
            />
          </Field>
          <Field label="Model">
            <ModelSelect
              provider={agent.provider}
              value={agent.model}
              onChange={(v) => settingsStore.setAgentDefaults({ model: v })}
            />
          </Field>
          <Field label="Profile">
            {supportsProfile(agent.provider) ? (
              <ProfileSelect
                profiles={profiles}
                value={agent.profileId}
                onChange={(v) => settingsStore.setAgentDefaults({ profileId: v })}
              />
            ) : (
              <p className="px-1 pt-1.5 text-xs text-muted">No account/profile for this provider.</p>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Orchestrator — default" desc="What the Workspace Assistant runs with.">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Provider">
            <Select
              value={orchestrator.provider}
              onChange={(v) =>
                // Reset the model: a claude alias ("opus") is meaningless to gemini
                // and vice-versa, so fall back to each provider's "Default".
                settingsStore.setOrchestratorDefaults({ provider: v as AgentProvider, model: null })
              }
              // Every provider can back the orchestrator: claude/gemini via their
              // CLIs, acp-ollama via Ollama's HTTP chat, and the other ACP adapters
              // via a one-shot ACP turn (acp_oneshot). The orchestrator only needs
              // text back, so no tools/streaming are required.
              options={PROVIDERS.map((p) => ({ label: p.label, value: p.value }))}
            />
          </Field>
          <Field label="Model">
            <ModelSelect
              provider={orchestrator.provider}
              value={orchestrator.model}
              onChange={(v) => settingsStore.setOrchestratorDefaults({ model: v })}
            />
          </Field>
          {supportsProfile(orchestrator.provider) ? (
            <Field label="Profile">
              <ProfileSelect
                profiles={profiles}
                value={orchestrator.profileId}
                onChange={(v) => settingsStore.setOrchestratorDefaults({ profileId: v })}
              />
            </Field>
          ) : (
            <Field label="Profile">
              <p className="px-1 pt-1.5 text-xs text-muted">
                No account/profile for this provider.
              </p>
            </Field>
          )}
          <div className="mt-3">
            <ToggleRow
              label="Read-only inspection"
              desc="Let the orchestrator run read-only commands (git status/log/diff, git worktree list, gh pr view, ls/cat/rg…) and read files, so it verifies reality instead of guessing. It can NEVER write code or run other commands — only dispatched agents do that."
              checked={orchestratorReadonly}
              onChange={(v) => settingsStore.setOrchestratorReadonly(v)}
            />
          </div>
        </div>
      </Section>

      <OrchestratorMcpSection />

      <MemorySection />

      <Section
        title="Review agent"
        desc="An automated agent that reviews each coding agent's diff (with the orchestrator's task context) BEFORE it's offered for QA. Findings appear in the project's Review view; the orchestrator only offers QA once all reviews pass."
      >
        <ToggleRow
          label="Use a review agent"
          desc="When on, each dispatched coding agent's work is auto-reviewed before QA. Off = straight to QA as before."
          checked={reviewAgent.enabled}
          onChange={(v) => settingsStore.setReviewAgent({ enabled: v })}
        />
        {reviewAgent.enabled && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Provider">
              <Select
                value={reviewAgent.provider}
                onChange={(v) => settingsStore.setReviewAgent({ provider: v as AgentProvider, model: null })}
                options={PROVIDERS.map((p) => ({ label: p.label, value: p.value }))}
              />
            </Field>
            <Field label="Model">
              <ModelSelect
                provider={reviewAgent.provider}
                value={reviewAgent.model}
                onChange={(v) => settingsStore.setReviewAgent({ model: v })}
              />
            </Field>
            {supportsProfile(reviewAgent.provider) && (
              <Field label="Profile">
                <ProfileSelect
                  profiles={profiles}
                  value={reviewAgent.profileId}
                  onChange={(v) => settingsStore.setReviewAgent({ profileId: v })}
                />
              </Field>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Global rules (system prompt)"
        desc="Rules appended to EVERY agent’s and the orchestrator’s instructions — e.g. “Write only TypeScript with strict types”."
      >
        <textarea
          value={globalRules}
          onChange={(e) => settingsStore.setGlobalRules(e.target.value)}
          placeholder={"- Follow the project's linting rules\n- Don't add dependencies without a reason"}
          className="min-h-[120px] w-full resize-y rounded border border-edge bg-well px-2 py-1.5 text-sm leading-relaxed text-gray-100 outline-none focus:border-accent"
        />
      </Section>

      <Section
        title="Token spend limit (safety brake)"
        desc="Cost limit ($) per session. When exceeded, OctoShell stops the orchestrator + agents. Only applies with per-token billing (API key); on a subscription no cost is reported."
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={spendLimitUsd != null}
            onChange={(on) => settingsStore.setSpendLimit(on ? 5 : null)}
            label={spendLimitUsd != null ? "Enabled" : "Disabled"}
          />
          {spendLimitUsd != null && (
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={spendLimitUsd}
                onChange={(e) => settingsStore.setSpendLimit(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
              />
              <span className="text-sm text-muted">/ session</span>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}

interface McpServer {
  name: string;
  transport: string;
}

/** Lists the MCP servers from the orchestrator's Claude config and lets the user
 *  tick which ones it may use. Only the ticked servers' tools are pre-approved;
 *  file/Bash tools are never granted, and nothing selected = pure planner. */
function OrchestratorMcpSection() {
  const { profiles, orchestrator, orchestratorMcp } = useSettings();
  const configDir = profiles.find((p) => p.id === orchestrator.profileId)?.configDir ?? null;
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Servers offered by enabled mods. They are listed here, not auto-enabled: a
  // mod can put a server in front of you, never tick the box for you.
  // useMods() is the subscription: the list itself comes from the store (which
  // applies the enabled/disabled filter), and `mods` is what tells us to recompute
  // when a mod is toggled or reloaded.
  const mods = useMods();
  const modServers = useMemo(() => Object.keys(modStore.mcpServers()), [mods]);

  useEffect(() => {
    let live = true;
    setServers(null);
    setErr(null);
    invoke<McpServer[]>("list_mcp_servers", { configDir })
      .then((s) => live && setServers(s))
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [configDir]);

  return (
    <Section
      title="Orchestrator MCP access"
      desc="Which of your configured MCP servers the orchestrator may use. Only the ticked servers' tools are enabled (and pre-approved) — it can never edit files or run shell commands through this. Leave all unticked for a pure planner. Applies to the Claude/Gemini orchestrator transport."
    >
      {err && <p className="text-xs text-red-300">Couldn't read MCP config: {err}</p>}
      {!err && servers === null && <p className="text-xs text-muted">Loading MCP servers…</p>}
      {!err && servers?.length === 0 && modServers.length === 0 && (
        <p className="text-xs text-muted">
          No MCP servers found in this profile's Claude config ({configDir ? configDir : "~/.claude.json"}).
        </p>
      )}
      {servers && servers.length > 0 && (
        <div className="space-y-1">
          {servers.map((s) => {
            const checked = orchestratorMcp.includes(s.name);
            return (
              <label
                key={s.name}
                className="flex cursor-pointer items-center gap-2 rounded border border-edge px-2 py-1.5 text-sm hover:border-accent"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => settingsStore.setOrchestratorMcp(s.name, e.target.checked)}
                  className="accent-accent"
                />
                <span className="font-medium">{s.name}</span>
                <span className="ml-auto rounded bg-well px-1.5 py-0.5 text-[10px] uppercase text-muted">
                  {s.transport}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {modServers.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] uppercase tracking-wider text-muted/70">From mods</p>
          {modServers.map((name) => {
            const shadowed = servers?.some((s) => s.name === name) ?? false;
            return (
              <label
                key={name}
                className="flex cursor-pointer items-center gap-2 rounded border border-edge px-2 py-1.5 text-sm hover:border-accent"
              >
                <input
                  type="checkbox"
                  checked={orchestratorMcp.includes(name)}
                  disabled={shadowed}
                  onChange={(e) => settingsStore.setOrchestratorMcp(name, e.target.checked)}
                  className="accent-accent"
                />
                <span className="font-medium">{name}</span>
                {shadowed && (
                  <span className="text-[10px] text-amber-300/90" title="Your own config already defines this name, and it wins.">
                    shadowed by your config
                  </span>
                )}
                <span className="ml-auto rounded bg-well px-1.5 py-0.5 text-[10px] uppercase text-muted">mod</span>
              </label>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Local LLM (Ollama)
// ---------------------------------------------------------------------------
type Conn =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; version: string }
  | { state: "err"; msg: string };

/** Connection · downloader · agent-assignment · advanced knobs for local models. */
function LocalLlmTab() {
  const { ollama, orchestrator, agent, reviewAgent } = useSettings();
  const [conn, setConn] = useState<Conn>({ state: "idle" });
  const [models, setModels] = useState<string[]>([]);
  const [pullTag, setPullTag] = useState("");
  const [browse, setBrowse] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pull, setPull] = useState<{ active: boolean; pct: number; status: string }>({
    active: false,
    pct: -1,
    status: "",
  });

  const refreshModels = async (baseUrl: string) => {
    try {
      setModels(await invoke<string[]>("ollama_tags", { baseUrl }));
    } catch {
      setModels([]);
    }
  };

  const test = async () => {
    setConn({ state: "testing" });
    try {
      const version = await invoke<string>("ollama_version", { baseUrl: ollama.baseUrl });
      setConn({ state: "ok", version });
      void refreshModels(ollama.baseUrl);
    } catch (e) {
      setConn({ state: "err", msg: String(e) });
      setModels([]);
    }
  };

  // Auto-probe on first open. (baseUrl-only dep so re-testing on every keystroke is
  // avoided; the explicit Test button covers manual edits.)
  useEffect(() => {
    void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live pull-progress from the backend's `ollama://pull` NDJSON stream.
  useEffect(() => {
    const un = listen<{ model: string; status: string; percent: number }>("ollama://pull", (e) => {
      setPull((p) => (p.active ? { active: true, pct: e.payload.percent, status: e.payload.status } : p));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const runPull = async (raw: string) => {
    const tag = raw.trim();
    if (!tag || pull.active) return;
    setBrowse(false);
    setPull({ active: true, pct: -1, status: `starting ${tag}…` });
    try {
      await invoke("ollama_pull", { baseUrl: ollama.baseUrl, model: tag });
      setPull({ active: false, pct: 100, status: `✓ pulled ${tag}` });
      setPullTag("");
      void refreshModels(ollama.baseUrl);
      void refreshOllamaModels(); // keep the shared list (InputBar, selects) in sync
    } catch (e) {
      setPull({ active: false, pct: -1, status: `✕ ${String(e)}` });
    }
  };

  const deleteModel = async (tag: string) => {
    setConfirmDelete(null);
    try {
      await invoke("ollama_delete", { baseUrl: ollama.baseUrl, model: tag });
      setPull({ active: false, pct: -1, status: `🗑 deleted ${tag}` });
      void refreshModels(ollama.baseUrl);
      void refreshOllamaModels();
    } catch (e) {
      setPull({ active: false, pct: -1, status: `✕ ${String(e)}` });
    }
  };

  // In the Local picker each persona must resolve to a concrete downloaded model
  // (a vague "OpenCode default" wouldn't tell you which model — or even that it's
  // local). So the options are exactly the installed models.
  const localOptions = models.map((m) => ({ label: m, value: `ollama/${m}` }));
  const firstLocal = models.length ? `ollama/${models[0]}` : null;

  return (
    <>
      <Section
        title="Ollama connection"
        desc="OctoShell drives local models through Ollama (via OpenCode's ACP server) — zero token cost. Point this at your running daemon."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Ollama base URL">
            <input
              value={ollama.baseUrl}
              onChange={(e) => settingsStore.setOllama({ baseUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="w-64 rounded-lg border border-edge bg-well px-2.5 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
            />
          </Field>
          <button
            onClick={() => void test()}
            disabled={conn.state === "testing"}
            className="btn-grad rounded-lg px-3 py-1.5 text-sm font-medium"
          >
            {conn.state === "testing" ? "Testing…" : "Test connection"}
          </button>
          <ConnBadge conn={conn} />
        </div>
      </Section>

      <Section
        title="Local models"
        desc="Models already pulled to this machine, plus a downloader to grab any tag from the Ollama library directly from here."
      >
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">Installed</div>
          {conn.state !== "ok" ? (
            <p className="text-xs text-muted">Connect to Ollama to list local models.</p>
          ) : models.length === 0 ? (
            <p className="text-xs text-muted">No models pulled yet — download one below.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {models.map((m) => (
                <span
                  key={m}
                  className="group flex items-center gap-1.5 rounded-full border border-edge bg-well py-1 pl-2.5 pr-1.5 font-mono text-[11px] text-gray-300"
                >
                  {m}
                  <button
                    onClick={() => setConfirmDelete(m)}
                    disabled={pull.active}
                    title={`Delete ${m}`}
                    className="rounded-full px-1 text-muted transition-colors hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Pull a model tag">
            <input
              value={pullTag}
              onChange={(e) => setPullTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runPull(pullTag)}
              placeholder="qwen2.5-coder:7b"
              className="w-64 rounded-lg border border-edge bg-well px-2.5 py-1.5 font-mono text-sm text-gray-100 outline-none focus:border-accent"
            />
          </Field>
          <button
            onClick={() => void runPull(pullTag)}
            disabled={pull.active || !pullTag.trim()}
            className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/30 disabled:opacity-60"
          >
            {pull.active ? "Pulling…" : "⬇ Pull model"}
          </button>
          <button
            onClick={() => setBrowse(true)}
            disabled={pull.active}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-edge disabled:opacity-60"
          >
            Browse models
          </button>
        </div>

        {(pull.active || pull.status) && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
              <span className="truncate">{pull.status || "Pulling…"}</span>
              {pull.pct >= 0 && <span className="tabular-nums text-amber-300">{pull.pct}%</span>}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-well">
              <div
                className={`h-full rounded-full bg-amber-400 transition-all ${
                  pull.active && pull.pct < 0 ? "w-1/3 animate-pulse" : ""
                }`}
                style={pull.pct >= 0 ? { width: `${pull.pct}%` } : undefined}
              />
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Agent assignment"
        desc="Route each agent persona to the cloud or a local model. “Local” switches that surface to the Ollama (ACP) provider; pick which downloaded model powers it."
      >
        <div className="space-y-2">
          <AssignRow
            label="Orchestrator"
            provider={orchestrator.provider}
            model={orchestrator.model}
            localOptions={localOptions}
            onCloud={() => settingsStore.setOrchestratorDefaults({ provider: "claude", model: null })}
            onLocal={() => settingsStore.setOrchestratorDefaults({ provider: "acp-ollama", model: firstLocal })}
            onModel={(v) => settingsStore.setOrchestratorDefaults({ model: v })}
          />
          <AssignRow
            label="Coding agents"
            provider={agent.provider}
            model={agent.model}
            localOptions={localOptions}
            onCloud={() => settingsStore.setAgentDefaults({ provider: "claude", model: null })}
            onLocal={() => settingsStore.setAgentDefaults({ provider: "acp-ollama", model: firstLocal })}
            onModel={(v) => settingsStore.setAgentDefaults({ model: v })}
          />
          <AssignRow
            label="Reviewer agent"
            provider={reviewAgent.provider}
            model={reviewAgent.model}
            localOptions={localOptions}
            onCloud={() => settingsStore.setReviewAgent({ provider: "claude", model: null })}
            onLocal={() => settingsStore.setReviewAgent({ provider: "acp-ollama", model: firstLocal })}
            onModel={(v) => settingsStore.setReviewAgent({ model: v })}
          />
          <p className="rounded-lg border border-edge bg-well px-3 py-2 text-xs leading-relaxed text-muted">
            💡 Pro-tip: assign a pedantic local model (e.g. <span className="font-mono text-gray-300">qwen2.5-coder:14b</span>)
            exclusively to the Reviewer agent to scan for regressions offline at zero token cost. Small models
            (&lt;7B) often lack reliable tool-calling — prefer Qwen2.5-Coder ≥7B for agentic work.
          </p>
        </div>
      </Section>

      <AdvancedLocal ollama={ollama} />

      {browse && (
        <ModelCatalog
          installed={models}
          onPull={(tag) => void runPull(tag)}
          onDelete={(tag) => setConfirmDelete(tag)}
          onClose={() => setBrowse(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete local model?"
          message={
            <>
              This permanently removes <span className="font-mono text-gray-200">{confirmDelete}</span> from
              this machine and frees its disk space. You can pull it again later, but that re-downloads it.
            </>
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void deleteModel(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}

/** A themed yes/no confirmation modal (replaces the native confirm()). */
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-xl border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-gray-200 transition-colors hover:bg-edge"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              danger
                ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                : "bg-accent/20 text-accent hover:bg-accent/30"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A curated catalog of popular Ollama models for the Browse modal. Ollama has no
 *  official "list the whole library" API, so this is a hand-picked shortlist
 *  (coding-first) — the free-text Pull box still handles any other tag. */
const MODEL_CATALOG: { tag: string; desc: string; size: string; tools: boolean }[] = [
  { tag: "qwen2.5-coder:7b", desc: "Strong agentic coder — best all-round local pick", size: "4.7 GB", tools: true },
  { tag: "qwen2.5-coder:14b", desc: "Sharper reasoning; great for the reviewer", size: "9.0 GB", tools: true },
  { tag: "qwen2.5-coder:32b", desc: "Top local coding quality (needs a big GPU)", size: "20 GB", tools: true },
  { tag: "qwen2.5-coder:3b", desc: "Light coder for modest machines", size: "1.9 GB", tools: true },
  { tag: "deepseek-coder-v2:16b", desc: "MoE coder, fast for its quality", size: "8.9 GB", tools: true },
  { tag: "llama3.1:8b", desc: "General-purpose, reliable tool-calling", size: "4.7 GB", tools: true },
  { tag: "mistral:7b", desc: "Fast general model with tool support", size: "4.1 GB", tools: true },
  { tag: "gemma3:12b", desc: "Google Gemma 3 — capable general model", size: "8.1 GB", tools: false },
  { tag: "gemma3:4b", desc: "Small Gemma 3 — chat/orchestration only", size: "3.3 GB", tools: false },
  { tag: "phi4:14b", desc: "Microsoft Phi-4 — strong reasoning", size: "9.1 GB", tools: false },
];

/** Browse modal. Two sources, so it's neither stale nor metadata-poor:
 *   • Recommended — the curated {@link MODEL_CATALOG} (hand-picked, carries the
 *     tools/no-tools + size hints that matter for agentic work).
 *   • Live library — fetched at open from ollama.com/library (families, popular
 *     first), with a filter box. Fresh, but names only; pulling a family gets its
 *     `:latest`. Falls back gracefully when the live fetch fails. */
function ModelCatalog({
  installed,
  onPull,
  onDelete,
  onClose,
}: {
  installed: string[];
  onPull: (tag: string) => void;
  onDelete: (tag: string) => void;
  onClose: () => void;
}) {
  const [lib, setLib] = useState<string[] | null>(null);
  const [libErr, setLibErr] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    invoke<string[]>("ollama_library")
      .then((l) => alive && setLib(l))
      .catch(() => alive && setLibErr(true));
    return () => {
      alive = false;
    };
  }, []);

  const hasTag = (tag: string) => installed.includes(tag);
  const hasFamily = (name: string) => installed.some((t) => t.split(":")[0] === name);
  // The concrete installed tag for a family (to delete): the first match.
  const familyTag = (name: string) => installed.find((t) => t.split(":")[0] === name) ?? name;
  const DeleteBtn = ({ tag }: { tag: string }) => (
    <button
      onClick={() => onDelete(tag)}
      title={`Delete ${tag}`}
      className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted transition-colors hover:bg-red-500/20 hover:text-red-300"
    >
      ✕
    </button>
  );
  const q = filter.trim().toLowerCase();
  const families = (lib ?? []).filter((n) => !q || n.includes(q)).slice().sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-100">📚 Browse models</h3>
            <p className="text-[11px] text-muted">Recommended picks + the live Ollama library.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-gray-200">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {/* Recommended (curated, with tools/size guidance) */}
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Recommended for OctoShell
          </div>
          {MODEL_CATALOG.map((m) => (
            <div key={m.tag} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-edge/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-gray-100">{m.tag}</span>
                  <span className="text-[10px] text-muted">{m.size}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                      m.tools ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
                    }`}
                  >
                    {m.tools ? "tools" : "no tools"}
                  </span>
                </div>
                <div className="truncate text-xs text-muted">{m.desc}</div>
              </div>
              {hasTag(m.tag) ? (
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-xs text-emerald-300">✓ Installed</span>
                  <DeleteBtn tag={m.tag} />
                </div>
              ) : (
                <button
                  onClick={() => onPull(m.tag)}
                  className="shrink-0 rounded-md bg-amber-500/20 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/30"
                >
                  ⬇ Pull
                </button>
              )}
            </div>
          ))}

          {/* Live library */}
          <div className="mt-3 flex items-center justify-between px-2 pb-1 pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              Ollama library {lib && `(${lib.length})`}
            </span>
            {lib && (
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-32 rounded border border-edge bg-well px-2 py-0.5 text-xs text-gray-100 outline-none focus:border-accent"
              />
            )}
          </div>
          {libErr ? (
            <p className="px-3 py-2 text-xs text-muted">
              Couldn’t load the live library (offline or the page changed). Recommended list still works, and
              you can type any tag in the Pull box.
            </p>
          ) : lib === null ? (
            <p className="px-3 py-2 text-xs text-muted">Loading the live library…</p>
          ) : (
            families.map((name) => (
              <div key={name} className="flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-edge/40">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-200">
                  {name}
                  <span className="ml-1.5 text-[10px] text-muted">:latest</span>
                </span>
                {hasFamily(name) ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-xs text-emerald-300">✓</span>
                    <DeleteBtn tag={familyTag(name)} />
                  </div>
                ) : (
                  <button
                    onClick={() => onPull(name)}
                    className="shrink-0 rounded-md border border-edge px-2.5 py-0.5 text-xs text-gray-200 hover:bg-edge"
                  >
                    ⬇ Pull
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ConnBadge({ conn }: { conn: Conn }) {
  if (conn.state === "ok") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px] shadow-emerald-400/50" />
        Ollama active{conn.version && ` (v${conn.version})`}
      </span>
    );
  }
  if (conn.state === "err") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-300/90">
        <span className="h-2 w-2 rounded-full bg-red-400/70" />
        Not detected — ensure Ollama is running
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className="h-2 w-2 rounded-full bg-edge" />
      {conn.state === "testing" ? "Checking…" : "Not tested"}
    </span>
  );
}

/** One persona row in the assignment grid: Cloud⇄Local segmented toggle + (when
 *  Local) a downloaded-model picker. */
function AssignRow({
  label,
  provider,
  model,
  localOptions,
  onCloud,
  onLocal,
  onModel,
}: {
  label: string;
  provider: AgentProvider;
  model: string | null;
  localOptions: { label: string; value: string }[];
  onCloud: () => void;
  onLocal: () => void;
  onModel: (v: string | null) => void;
}) {
  const isLocal = provider === "acp-ollama";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge px-3 py-2">
      <span className="w-28 shrink-0 text-sm font-medium text-gray-100">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-edge">
        <button
          onClick={onCloud}
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
            !isLocal ? "bg-accent/25 text-accent" : "text-muted hover:bg-edge"
          }`}
        >
          Cloud API
        </button>
        <button
          onClick={onLocal}
          className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
            isLocal ? "bg-amber-400/15 text-amber-300" : "text-muted hover:bg-edge"
          }`}
        >
          Local LLM
        </button>
      </div>
      {isLocal &&
        (localOptions.length === 0 ? (
          <span className="text-xs text-amber-300/80">Pull a model first (above) ↑</span>
        ) : (
          <div className="min-w-0 flex-1">
            <Select
              value={model ?? ""}
              onChange={(v) => onModel(v || null)}
              options={[{ label: "Select a model…", value: "" }, ...localOptions]}
            />
          </div>
        ))}
    </div>
  );
}

/** Expandable advanced accordion: context window + temperature for local runs. */
function AdvancedLocal({ ollama }: { ollama: OllamaSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-edge/30"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
          <span className="h-3.5 w-0.5 rounded-full bg-accent/70" />
          Advanced — context & sampling
        </h2>
        <span className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-edge/60 p-4">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-muted">Context window</span>
              <span className="tabular-nums text-xs text-gray-300">
                {ollama.contextWindow.toLocaleString()} tokens
              </span>
            </div>
            <input
              type="range"
              min={2048}
              max={131072}
              step={2048}
              value={ollama.contextWindow}
              onChange={(e) => settingsStore.setOllama({ contextWindow: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-muted">Temperature</span>
              <span className="tabular-nums text-xs text-gray-300">{ollama.temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={ollama.temperature}
              onChange={(e) => settingsStore.setOllama({ temperature: Number(e.target.value) })}
              className="w-full accent-accent"
            />
            <p className="mt-1 text-[11px] text-muted">
              Lower = stricter/deterministic (good for review &amp; refactors). Higher = more creative.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — Workspace & Git
// ---------------------------------------------------------------------------
function WorkspaceTab() {
  const { workspace } = useSettings();
  const set = (patch: Parameters<typeof settingsStore.setWorkspace>[0]) => settingsStore.setWorkspace(patch);

  return (
    <>
      <Section title="Worktrees" desc="How the orchestrator isolates and cleans up work.">
        <div className="space-y-3">
          <ToggleRow
            label="Orchestrator creates worktrees"
            desc="Each task runs in its own git worktree (isolated/parallel) instead of the project’s own agent."
            checked={workspace.orchestratorWorktrees}
            onChange={(v) => set({ orchestratorWorktrees: v })}
          />
          <ToggleRow
            label="Auto-copy .env* into new worktrees"
            desc="Copies .env / .env.local etc. (untracked secrets) so the app runs inside the worktree."
            checked={workspace.copyEnv}
            onChange={(v) => set({ copyEnv: v })}
          />
          <ToggleRow
            label="Copy dependencies into new worktrees"
            desc="Copies the base repo's installed deps (node_modules, vendor, …) so the worktree's dev server / tests run without a reinstall. A git worktree never inherits these."
            checked={workspace.copyDeps}
            onChange={(v) => set({ copyDeps: v })}
          />
          <TrackedPortsField ports={workspace.trackedPorts} onChange={(v) => set({ trackedPorts: v })} />
          <Field label="Auto-clean — when a worktree is deleted">
            <Select
              value={workspace.autoClean}
              onChange={(v) => set({ autoClean: v as AutoCleanMode })}
              options={[
                { label: "Never (manual)", value: "off" },
                { label: "After review approve", value: "onApprove" },
                { label: "After PR merge/close", value: "onMerge" },
              ]}
            />
          </Field>
          <Field label="Base branch for new worktrees">
            <input
              value={workspace.baseBranch}
              onChange={(e) => set({ baseBranch: e.target.value })}
              placeholder="(default: main worktree HEAD, e.g. main/dev)"
              className="rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
            />
          </Field>
        </div>
      </Section>

      <Section title="Terminal" desc="Which shell the native PTY spawns.">
        <Field label="Default shell">
          <Select
            value={workspace.defaultShell}
            onChange={(v) => set({ defaultShell: v as DefaultShell })}
            options={[
              { label: "PowerShell (pwsh)", value: "powershell" },
              { label: "CMD", value: "cmd" },
              { label: "WSL / Ubuntu", value: "wsl" },
            ]}
          />
        </Field>
        {workspace.defaultShell !== "powershell" && (
          <p className="mt-2 text-xs text-amber-300/80">
            ⚠️ Per-command blocks & exit codes are built for PowerShell. On CMD/WSL the terminal works, but
            without semantic command parsing. Applies to NEW terminals.
          </p>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — Appearance
// ---------------------------------------------------------------------------
function AppearanceTab() {
  const { appearance, sttEngine } = useSettings();
  const set = (patch: Parameters<typeof settingsStore.setAppearance>[0]) => settingsStore.setAppearance(patch);

  return (
    <>
      <Section title="Typography" desc="Font for terminal & feed (must be installed on the system).">
        <Field label="Font">
          <Select value={appearance.fontFamily} onChange={(v) => set({ fontFamily: v })} options={FONTS} />
        </Field>
      </Section>

      <Section title="PCB trace animation" desc="How fast the circuit-board traces flow while agents are working.">
        <Field label="Speed">
          <Select
            value={appearance.traceSpeed}
            onChange={(v) => set({ traceSpeed: v as TraceSpeed })}
            options={[
              { label: "Fast", value: "fast" },
              { label: "Normal", value: "normal" },
              { label: "Stealth (slow)", value: "stealth" },
              { label: "Static (none)", value: "static" },
            ]}
          />
        </Field>
      </Section>

      <Section title="Sound effects" desc="Subtle retro sci-fi sounds when a task completes or an error hits.">
        <ToggleRow
          label="SFX"
          desc="A subtle beep on agent completion / error."
          checked={appearance.sfx}
          onChange={(v) => set({ sfx: v })}
        />
      </Section>

      <Section
        title="Speech-to-text (dictation)"
        desc="The 🎤 button in the input. “Web” uses the browser’s free speech engine. Whisper (local/API) is coming soon."
      >
        <Field label="Engine">
          <Select
            value={sttEngine}
            onChange={(v) => settingsStore.setSttEngine(v as SttEngine)}
            options={[
              { label: "Web (free)", value: "web" },
              { label: "Whisper (soon)", value: "whisper" },
            ]}
          />
        </Field>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — System & Database
// ---------------------------------------------------------------------------
function SystemTab({ onSandboxLogin, onShowOnboarding }: { onSandboxLogin: () => void; onShowOnboarding: () => void }) {
  const { system } = useSettings();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VacuumResult | null>(null);

  const runVacuum = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await vacuumDb());
    } finally {
      setBusy(false);
    }
  };

  const fmtKB = (n: number) => `${(n / 1024).toFixed(0)} KB`;

  return (
    <>
      <Section title="Scrollback buffer" desc="How many lines of terminal output each terminal keeps in memory (bigger = more history, a bit more RAM). Applies to new terminals.">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={200}
            max={50000}
            step={500}
            value={system.scrollback}
            onChange={(e) =>
              settingsStore.setSystem({ scrollback: Math.max(200, Math.min(50000, Number(e.target.value) || 1000)) })
            }
            className="w-32 rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
          />
          <span className="text-sm text-muted">lines</span>
        </div>
      </Section>

      <Section
        title="Docker sandbox for ACP agents"
        desc="When ON, ACP agents’ shell commands run inside a throwaway Docker container (host isolation: capped CPU/RAM/PIDs, dropped capabilities) instead of directly on the host. Needs Docker Desktop running; otherwise the command fails with a clear message. Does not protect the worktree itself or against exfiltration."
      >
        <ToggleRow
          label="Sandbox agent commands"
          desc="Runs the ENTIRE ACP agent inside a container (every command isolated). Off = host execution."
          checked={system.sandboxAgentCommands}
          onChange={(v) => settingsStore.setSystem({ sandboxAgentCommands: v })}
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={onSandboxLogin}
            className="btn-grad rounded px-3 py-1.5 text-sm font-medium"
          >
            Sandbox agent login (one-time)
          </button>
          <span className="text-xs text-muted">
            Opens a login in the active project's terminal, for that project's selected agent CLI
            (Claude/Gemini/Codex — otherwise Claude). Authorize in the browser; the login is stored
            separately from your host login and covers every worktree.
          </span>
        </div>
      </Section>

      <MobileSharingSection />

      <ModsSection />

      <WorkspaceTransferSection />

      <Section
        title="First-launch health check"
        desc="Checks that the CLIs OctoShell drives (agent CLIs, PowerShell 7, GitHub CLI) are on PATH. Shown once automatically on first launch."
      >
        <button
          onClick={onShowOnboarding}
          className="btn-grad rounded px-3 py-1.5 text-sm font-medium"
        >
          Re-run health check
        </button>
      </Section>

      <Section
        title="Compact database (Vacuum)"
        desc="Compacts stored history — trims agents’ heavy intermediate tool-output streams while keeping the essence — and reclaims database space."
      >
        <button
          onClick={() => void runVacuum()}
          disabled={busy}
          className="btn-grad rounded px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Compacting…" : "Compact now"}
        </button>
        {result && (
          <p className="mt-2 text-xs text-muted">
            {result.sessions} sessions · {result.trimmed} tool-outputs compacted ·{" "}
            {fmtKB(result.before)} → <span className="text-emerald-300/90">{fmtKB(result.after)}</span>
          </p>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tab — Project Scripts (per-project dev/test command overrides)
// ---------------------------------------------------------------------------
function ProjectScriptsTab({ projects, focusCwd }: { projects: SettingsProject[]; focusCwd?: string }) {
  // De-dupe by cwd (a repo + its worktrees can share a path root); keep first seen.
  const seen = new Set<string>();
  const rows = projects.filter((p) => {
    const k = p.cwd.toLowerCase();
    if (!p.cwd || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Group each top-level repo with its worktrees nested under it, so the page
  // mirrors the sidebar's repo → worktree hierarchy instead of a flat list.
  const byId = new Map(rows.map((p) => [p.id, p]));
  const parents = rows.filter((p) => !p.parentId || !byId.has(p.parentId));
  const childrenOf = (id: string) => rows.filter((p) => p.parentId === id && byId.has(p.parentId!));

  return (
    <Section
      title="Project scripts"
      desc="Pin the exact dev-server and test commands per project. When set, OctoShell uses these instead of guessing — so QA and managed-run stop falling back to the wrong npm script. Leave a field blank to keep auto-detection."
    >
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No open projects.</p>
      ) : (
        <div className="space-y-5">
          {parents.map((repo) => {
            const worktrees = childrenOf(repo.id);
            return (
              <div key={repo.id} className="space-y-2">
                <ProjectScriptRow project={repo} focused={sameCwd(repo.cwd, focusCwd)} />
                {worktrees.length > 0 && (
                  <div className="ml-3 space-y-2 border-l border-edge/70 pl-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted/70">Worktrees</div>
                    {worktrees.map((wt) => (
                      <ProjectScriptRow key={wt.id} project={wt} focused={sameCwd(wt.cwd, focusCwd)} worktree />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function sameCwd(a: string, b?: string): boolean {
  return !!b && a.toLowerCase() === b.toLowerCase();
}

function ProjectScriptRow({
  project,
  focused,
  worktree = false,
}: {
  project: SettingsProject;
  focused: boolean;
  worktree?: boolean;
}) {
  const scripts = useProjectScripts(project.cwd);
  const configured = !!(scripts.dev || scripts.test);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  return (
    <div
      ref={ref}
      className={`rounded-lg border px-3.5 py-3 transition-colors ${
        focused
          ? "border-accent/70 bg-accent/[0.07] ring-1 ring-accent/40"
          : worktree
            ? "border-edge/70 bg-well/30"
            : "border-edge bg-card"
      }`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className={worktree ? "text-accent/70" : "text-muted"}>{worktree ? "⑃" : "▼"}</span>
        <span className="text-sm font-semibold text-gray-100">{project.name}</span>
        {configured && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">
            custom
          </span>
        )}
        <span className="ml-auto truncate text-[11px] text-muted" title={project.cwd}>{project.cwd}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">Dev server</span>
          <input
            defaultValue={scripts.dev ?? ""}
            onChange={(e) => projectConfigStore.set(project.cwd, "dev", e.target.value)}
            placeholder="e.g. npm run dev · npm start"
            className="w-full rounded bg-ink px-2 py-1.5 text-xs text-gray-100 outline-none placeholder:text-muted/50 focus:ring-1 focus:ring-accent/50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">Tests</span>
          <input
            defaultValue={scripts.test ?? ""}
            onChange={(e) => projectConfigStore.set(project.cwd, "test", e.target.value)}
            placeholder="e.g. npm test"
            className="w-full rounded bg-ink px-2 py-1.5 text-xs text-gray-100 outline-none placeholder:text-muted/50 focus:ring-1 focus:ring-accent/50"
          />
        </label>
      </div>
    </div>
  );
}

/** Editable list of ports the Ports panel always shows (the "basic ports we use"),
 *  as chips plus an add field. */
function TrackedPortsField({ ports, onChange }: { ports: number[]; onChange: (v: number[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const n = parseInt(draft.trim(), 10);
    if (n > 0 && n < 65536 && !ports.includes(n)) onChange([...ports, n]);
    setDraft("");
  };
  return (
    <div className="rounded-lg border border-edge bg-card px-3 py-2.5">
      <div className="text-sm font-medium text-gray-100">Tracked ports</div>
      <p className="mb-2 mt-0.5 text-xs text-muted">
        Always shown in the sidebar’s Ports panel (even when free), on top of whatever is actually listening.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {ports.map((p) => (
          <span key={p} className="flex items-center gap-1 rounded border border-edge bg-well/50 px-1.5 py-0.5 font-mono text-xs text-gray-200">
            :{p}
            <button onClick={() => onChange(ports.filter((x) => x !== p))} title="Remove" className="text-muted hover:text-red-300">
              ✕
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          onBlur={add}
          placeholder="add port…"
          className="w-24 rounded bg-ink px-2 py-0.5 text-xs text-gray-100 outline-none placeholder:text-muted/50 focus:ring-1 focus:ring-accent/50"
        />
      </div>
    </div>
  );
}

/** Workspace memory: what it costs and what it currently holds.
 *
 *  The numbers are shown rather than hidden because the whole reason this is a
 *  setting is that resident RAM matters to some users — a toggle without a
 *  figure asks them to trust an unknown cost. */
/** Move the project list + session ids between the dev build and the installed
 *  app. They already share one SQLite file (same app identifier), but NOT
 *  localStorage — WebView2 scopes that per origin, and the two builds serve from
 *  different ones. Since the session ids live there, a fresh install shows an
 *  empty workspace while every chat sits unreachable in the shared database. */
function WorkspaceTransferSection() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void peekWorkspace().then(setSnap);
  }, []);

  const doExport = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const s = await exportWorkspace();
      setSnap(s);
      setMsg(`Saved ${s.keys} settings to the shared database. Now open the other build and press Import.`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!confirm("Replace this build's projects and settings with the saved snapshot? Your current ones are overwritten.")) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const n = await importWorkspace();
      setMsg(`Imported ${n} settings — reloading…`);
      // Every store reads localStorage at module load, so a reload is the only
      // way the new state actually takes effect.
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <Section
      title="Transfer workspace between builds"
      desc="Your chat history and memory already live in one shared database, but the project list and its session ids do not — so a fresh install starts empty. Export here, then Import in the other build to bring everything across."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => void doExport()} disabled={busy} className="btn-grad rounded px-3 py-1.5 text-sm font-medium disabled:opacity-60">
          Export from this build
        </button>
        <button onClick={() => void doImport()} disabled={busy || !snap} className="rounded border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-edge disabled:opacity-40">
          Import into this build
        </button>
        <span className="text-xs text-muted">
          {snap
            ? `Snapshot: ${snap.keys} settings from ${snap.origin}, ${new Date(snap.at).toLocaleString()}`
            : "No snapshot saved yet."}
        </span>
      </div>
      {msg && <p className="mt-2 text-xs text-emerald-300">{msg}</p>}
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
    </Section>
  );
}

/** Installed mods: what's on disk, what it contributes, and what's wrong with it.
 *  Broken mods are listed WITH their errors rather than hidden — a mod that
 *  silently fails to appear is the worst outcome for someone who just installed
 *  one and is looking for it. */
function ModsSection() {
  const { mods, dir, loading, error } = useMods();
  const [, force] = useState(0);

  const ok = mods.filter((m) => m.manifest && !m.errors.length);
  const broken = mods.filter((m) => m.errors.length);

  return (
    <Section
      title="Mods"
      desc="Add agents, project types and MCP servers by dropping a folder into the mods directory. A mod is data only — nothing in it is ever executed, and it can only contribute what its manifest declares."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void modStore.refresh()}
          disabled={loading}
          className="btn-grad rounded px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {loading ? "Scanning…" : "Reload mods"}
        </button>
        <button
          onClick={() => void navigator.clipboard?.writeText(dir)}
          disabled={!dir}
          title={dir}
          className="rounded border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-edge disabled:opacity-40"
        >
          Copy folder path
        </button>
        <span className="text-xs text-muted">
          {mods.length === 0
            ? "No mods installed."
            : `${ok.length} loaded${broken.length ? ` · ${broken.length} with errors` : ""}`}
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

      {mods.length > 0 && (
        <div className="mt-3 space-y-2">
          {mods.map((m) => {
            const enabled = m.manifest ? modStore.isEnabled(m.manifest.id) : false;
            const bad = m.errors.length > 0;
            return (
              <div
                key={m.dir}
                className={`rounded-md border px-3 py-2 ${bad ? "border-red-500/40 bg-red-500/[0.06]" : "border-edge bg-card"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                    {m.manifest?.name ?? m.dir}
                    {m.manifest && (
                      <span className="text-muted"> · v{m.manifest.version}</span>
                    )}
                    {m.manifest?.author && <span className="text-muted"> · {m.manifest.author}</span>}
                  </span>
                  {!bad && m.manifest && (
                    <button
                      onClick={() => {
                        modStore.setEnabled(m.manifest!.id, !enabled);
                        force((n) => n + 1);
                      }}
                      className={`shrink-0 rounded border px-2 py-0.5 text-[11px] ${
                        enabled
                          ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-300"
                          : "border-edge text-muted hover:bg-edge"
                      }`}
                    >
                      {enabled ? "Enabled" : "Disabled"}
                    </button>
                  )}
                </div>

                {m.manifest?.description && (
                  <p className="mt-1 text-xs text-muted">{m.manifest.description}</p>
                )}

                {/* The permission list is the whole truth: validation rejects any
                    contribution whose permission isn't declared here. */}
                {m.manifest && m.manifest.permissions.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {m.manifest.permissions.map((p) => (
                      <li key={p} className="text-[11px] text-amber-300/90">
                        • {PERMISSION_LABELS[p]}
                      </li>
                    ))}
                  </ul>
                )}

                {bad && (
                  <ul className="mt-1 space-y-0.5">
                    {m.errors.map((e, i) => (
                      <li key={i} className="text-[11px] text-red-300">
                        ✕ {e}
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-1 truncate font-mono text-[10px] text-muted/70" title={m.path}>
                  {m.dir}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/** Start and stop the phone companion, and show the access code.
 *
 *  The code is rendered large and monospaced because its whole job is to be read
 *  off this screen and typed on another; the countdown is there because a share
 *  you forgot about is the failure mode this feature has. */
/** The tunnel address as a QR code, so the phone can just point at it.
 *  Rendered to SVG (crisp at any size, no canvas) and only re-rendered when the
 *  URL changes. */
function TunnelQr({ url }: { url: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toString(url, { type: "svg", margin: 1, width: 168 })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [url]);
  if (!svg) return null;
  return (
    <div
      className="mt-2 inline-block rounded-md bg-white p-2"
      // The SVG comes from the QR library over a URL we produced ourselves, not
      // from anything a user or mod supplied.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function MobileSharingSection() {
  const m = useMobile();
  const { mobile: mobileCfg } = useSettings();
  const [minutes, setMinutes] = useState(EXPIRY_CHOICES[0].minutes);

  useEffect(() => {
    // Recovers a share that survived a window reload.
    void mobileStore.refresh();
  }, []);

  return (
    <Section
      title="Phone companion"
      desc="Share this workspace with your phone: see what the agents are doing from anywhere. The server only exists while sharing is on — stopping it removes the socket, not just the permission."
    >
      <div className="mb-3 space-y-2 rounded-md border border-edge bg-card px-3 py-2">
        <Field label="Public address">
          <Select
            value={mobileCfg.mode}
            onChange={(v) => settingsStore.setMobile({ mode: v as "quick" | "named" })}
            options={[
              { label: "Quick tunnel — random address, gone when you stop", value: "quick" },
              { label: "Named tunnel — your own domain, stays put", value: "named" },
            ]}
          />
        </Field>
        {mobileCfg.mode === "named" ? (
          <div className="space-y-2">
            <Field label="Tunnel token (Cloudflare → Zero Trust → Networks → Tunnels)">
              <input
                type="password"
                value={mobileCfg.token}
                onChange={(e) => settingsStore.setMobile({ token: e.target.value })}
                placeholder="eyJhIjoi…"
                className="w-full rounded border border-edge bg-well px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Public hostname you routed to it">
              <input
                value={mobileCfg.hostname}
                onChange={(e) => settingsStore.setMobile({ hostname: e.target.value })}
                placeholder="mobile.example.com"
                className="w-full rounded border border-edge bg-well px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="Local port (must match the tunnel's public-hostname service)">
              <input
                type="number"
                value={mobileCfg.port}
                onChange={(e) => settingsStore.setMobile({ port: Number(e.target.value) || 8787 })}
                className="w-32 rounded border border-edge bg-well px-2 py-1.5 text-sm"
              />
            </Field>
            {/* This is the trade the mode makes, and it should be impossible to
                miss: a permanent address is findable, where a quick tunnel's is
                random and gone in an hour. */}
            <p className="text-xs text-amber-300">
              A permanent address can be found by anyone, and it points at a machine where agents
              may run without asking. Put <strong>Cloudflare Access</strong> in front of this
              hostname (free, Zero Trust → Access → Applications) so a request never reaches this
              machine without a verified identity. The access code then becomes a second factor
              rather than the only one.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Needs nothing configured. The address is random and stops existing when you stop
            sharing — which is a security property, not a shortcoming. It also changes every time,
            so an app saved to your phone's home screen won't keep working; use a named tunnel for
            that.
          </p>
        )}
      </div>

      <div className="mb-3">
        <ToggleRow
          label="Let the phone send tasks to agents"
          desc="Without this, the phone can read and answer approvals but never start work. With it, anyone holding the access code can make an agent run code on this machine. Tasks that arrive this way are marked 📱 in the feed so they are never mistaken for something you typed here."
          checked={mobileCfg.allowDispatch}
          onChange={(v) => settingsStore.setMobile({ allowDispatch: v })}
        />
      </div>

      <div className="mb-3">
        <ToggleRow
          label="Also allow phones on this WiFi"
          desc="Listens on the local network as well, so a phone on the same WiFi can connect with no tunnel and nothing in between — which also means Cloudflare never sees your agents' output. It does widen access from this machine to everyone on the network, and it is plain HTTP, so the app can't be installed to a home screen over it."
          checked={mobileCfg.lan}
          onChange={(v) => settingsStore.setMobile({ lan: v })}
        />
      </div>

      {!m.sharing ? (
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={EXPIRY_CHOICES.map((c) => ({ label: c.label, value: String(c.minutes) }))}
          />
          <button
            onClick={() => void mobileStore.start(minutes)}
            disabled={m.busy}
            className="btn-grad rounded px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {m.busy ? "Starting…" : "Start sharing"}
          </button>
          <span className="text-xs text-muted">
            Nothing is reachable until you start, and it stops by itself when the time is up.
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4 rounded-md border border-accent/40 bg-accent/[0.06] px-3 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted">Access code</p>
              <p className="select-all font-mono text-3xl font-semibold tracking-[0.2em] text-gray-100">
                {m.code}
              </p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-[10px] uppercase tracking-widest text-muted">Stops in</p>
              <p className="font-mono text-xl text-gray-200">
                {m.secondsLeft === null ? "—" : fmtCountdown(m.secondsLeft)}
              </p>
            </div>
          </div>

          {m.locked && (
            <p className="text-xs text-amber-300">
              Too many wrong codes — the door is shut for a while. Stop and start again to reset it
              with a fresh code.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void mobileStore.stop()}
              disabled={m.busy}
              className="rounded border border-red-500/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-60"
            >
              Stop sharing
            </button>
            <span className="font-mono text-xs text-muted">http://127.0.0.1:{m.port}</span>
          </div>

          {m.lan && (
            <div className="rounded-md border border-edge bg-card px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-muted">On this WiFi</p>
              {m.lanAddress ? (
                <>
                  <button
                    onClick={() => void navigator.clipboard?.writeText(`http://${m.lanAddress}:${m.port}`)}
                    className="block w-full truncate text-left font-mono text-sm text-sky-300 hover:text-sky-200"
                    title="Copy"
                  >
                    http://{m.lanAddress}:{m.port} ⧉
                  </button>
                  <TunnelQr url={`http://${m.lanAddress}:${m.port}`} />
                  <p className="mt-1 text-xs text-muted">
                    Nothing in between, so no one outside your network sees this. Windows may ask
                    to allow OctoShell on private networks the first time — say yes, or the phone
                    just times out.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted">No local network address found.</p>
              )}
            </div>
          )}

          <div className="rounded-md border border-edge bg-card px-3 py-2">
            {m.tunnelUrl ? (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-muted">Open this on your phone</p>
                <button
                  onClick={() => void navigator.clipboard?.writeText(m.tunnelUrl!)}
                  className="block w-full truncate text-left font-mono text-sm text-sky-300 hover:text-sky-200"
                  title="Copy"
                >
                  {m.tunnelUrl} ⧉
                </button>
                {/* The point of the QR: this address is a random string of words
                    that nobody wants to retype on a phone keyboard. */}
                <TunnelQr url={m.tunnelUrl} />
                {m.tunnelConnections !== null && m.tunnelConnections < m.tunnelHealthyConnections && (
                  <p className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                    Connected to only <strong>{m.tunnelConnections} of {m.tunnelHealthyConnections}</strong>{" "}
                    Cloudflare locations. The address may work from this computer and fail from your
                    phone, because a request arriving somewhere the tunnel isn't connected has
                    nowhere to go. Stop and start the public address to try for a full set.
                  </p>
                )}
                {m.tunnelUrlIsNew && (
                  <p className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                    This address is <strong>new</strong>. Anything pointing at the previous one — a
                    saved link, your phone's history, an installed app — will say the site can't be
                    reached. Scan the code again, or use a named tunnel to stop the address moving.
                  </p>
                )}
                <p className="text-xs text-muted">
                  Anyone with this address reaches the code screen — the code, and the lockout
                  behind it, are what protect the machine. It closes when you stop sharing.
                </p>
                <button
                  onClick={() => void mobileStore.stopTunnel()}
                  className="rounded border border-edge px-2 py-1 text-xs text-muted hover:bg-edge"
                >
                  Close the public address
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void mobileStore.startTunnel()}
                  disabled={m.tunnelBusy}
                  className="rounded border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-edge disabled:opacity-60"
                >
                  {m.tunnelBusy ? "Opening…" : "Open a public address"}
                </button>
                <span className="text-xs text-muted">
                  {mobileCfg.mode === "named"
                    ? `Runs your named tunnel and serves it at ${mobileCfg.hostname || "the hostname above"}.`
                    : "Runs a Cloudflare quick tunnel so your phone can reach this machine. Without it, the server is local only."}
                </span>
              </div>
            )}
            {m.tunnelError && <p className="mt-2 text-xs text-amber-300">{m.tunnelError}</p>}
          </div>
        </div>
      )}

      {m.error && <p className="mt-2 text-xs text-red-300">{m.error}</p>}
    </Section>
  );
}

function MemorySection() {
  const { memory } = useSettings();
  const stats = useMemoryStats();
  const [busy, setBusy] = useState(false);

  const mb = (stats.bytes / (1024 * 1024)).toFixed(1);
  const forgetAll = async () => {
    setBusy(true);
    try {
      await memoryStore.forgetAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Workspace memory"
      desc="Remembers what happened across sessions — agent reports, review verdicts, dispatched tasks — and recalls the relevant ones by MEANING, not exact words. Everything runs locally; nothing is sent anywhere."
    >
      <ToggleRow
        label="Remember past work"
        desc="First use downloads a ~90 MB embedding model (once). While on, memories are indexed in RAM for instant recall; turning it off frees that memory immediately."
        checked={memory.enabled}
        onChange={(v) => settingsStore.setMemory({ enabled: v })}
      />

      {memory.enabled && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Keep history for">
              <Select
                value={String(memory.retentionMonths)}
                onChange={(v) => settingsStore.setMemory({ retentionMonths: Number(v) })}
                options={[
                  { label: "1 month", value: "1" },
                  { label: "3 months", value: "3" },
                  { label: "6 months", value: "6" },
                  { label: "12 months", value: "12" },
                  { label: "24 months", value: "24" },
                ]}
              />
            </Field>
            <Field label="Memories per answer">
              <Select
                value={String(memory.topK)}
                onChange={(v) => settingsStore.setMemory({ topK: Number(v) })}
                options={[3, 6, 10].map((n) => ({ label: String(n), value: String(n) }))}
              />
            </Field>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Shorter retention uses less memory — and usually gives better answers, since a
            two-year-old note about since-rewritten code misleads more than it helps.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-edge px-3 py-2 text-xs text-muted">
            <span>
              <span className="text-gray-200">{stats.memories}</span> memories
            </span>
            <span>
              <span className="text-gray-200">{stats.indexed}</span> indexed
            </span>
            <span>
              RAM <span className="text-gray-200">{mb} MB</span>
            </span>
            {stats.pending > 0 && (
              <span className="text-amber-300/80">{stats.pending} awaiting indexing…</span>
            )}
            {stats.model && <span className="ml-auto opacity-70">{stats.model}</span>}
          </div>

          {stats.error && (
            <div className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
              {stats.error}
              <div className="mt-1 text-red-300/70">
                Recall falls back to keyword matching, so answers may miss anything phrased
                differently from the original note.
              </div>
            </div>
          )}

          <button
            onClick={() => void forgetAll()}
            disabled={busy || stats.memories === 0}
            className="mt-3 rounded-lg border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
          >
            {busy ? "Forgetting…" : "Forget everything"}
          </button>
        </>
      )}
    </Section>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-edge bg-card transition-colors hover:border-edge/80">
      <div className="border-b border-edge/60 bg-gradient-to-r from-accent/[0.07] to-transparent px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
          <span className="h-3.5 w-0.5 rounded-full bg-accent/70" />
          {title}
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</p>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-edge bg-well px-2.5 py-1.5 text-sm text-gray-100 outline-none transition-colors hover:border-accent/40 focus:border-accent"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Model picker mapping the null "Default" to a "" sentinel for the native select.
 *  The option list follows the provider (claude aliases, gemini models, or — for
 *  local Ollama — the user's ACTUALLY installed models, fetched live). */
function ModelSelect({
  value,
  onChange,
  provider = "claude",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  provider?: AgentProvider;
}) {
  // Always call the hook (rules-of-hooks); only used for the ollama provider.
  const ollama = useOllamaModels();
  const models = provider === "acp-ollama" ? ollamaModelOptions(ollama.models) : modelsFor(provider);
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={models.map((m) => ({ label: m.label, value: m.value ?? "" }))}
    />
  );
}

/** Profile picker; "" = home default (no CLAUDE_CONFIG_DIR override). */
function ProfileSelect({
  profiles,
  value,
  onChange,
}: {
  profiles: Profile[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[{ label: "Default (home)", value: "" }, ...profiles.map((p) => ({ label: p.name, value: p.id }))]}
    />
  );
}

/** A sliding switch toggle (track + knob). */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex shrink-0 items-center gap-2 text-xs"
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`relative inline-flex h-[18px] w-8 items-center rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-edge"
        }`}
      >
        <span
          className={`absolute h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[16px]" : "translate-x-[2px]"
          }`}
        />
      </span>
      {label && <span className={checked ? "text-accent" : "text-muted"}>{label}</span>}
    </button>
  );
}

/** A labelled toggle row with a description. */
function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        checked ? "border-accent/30 bg-accent/[0.05]" : "border-edge"
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-100">{label}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</div>
      </div>
      <div className="pt-0.5">
        <Toggle checked={checked} onChange={onChange} label={checked ? "On" : "Off"} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab — Strategy Roles
// ---------------------------------------------------------------------------

/** Manage the roles a Strategy Mode participant can take. Built-in roles are
 *  locked (prompt is viewable, not editable — clone to tweak); custom roles are
 *  fully editable. A role's prompt primes the participant (who it is in the
 *  discussion) before it ever sees the user's request. */
function StrategyRolesTab() {
  const { roles } = useStrategy();
  const builtins = roles.filter((r) => r.builtin);
  const custom = roles.filter((r) => !r.builtin);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-100">Strategy Roles</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          A role gives a Strategy Mode participant an identity and a short prompt that primes it —
          who it is in the discussion — before it reads your request. Built-in roles are locked so
          you always have safe defaults; clone one or add your own to customise.
        </p>
      </div>

      <section className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Built-in (locked)</div>
        {builtins.map((r) => (
          <RoleCard key={r.id} role={r} />
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Your roles</div>
          <button
            onClick={() => strategyStore.addRole()}
            className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:bg-edge/50 hover:text-gray-200"
          >
            ＋ Add role
          </button>
        </div>
        {custom.length === 0 && (
          <div className="rounded-lg border border-dashed border-edge px-3 py-4 text-center text-xs text-muted">
            No custom roles yet. Add one, or clone a built-in to use it as a template.
          </div>
        )}
        {custom.map((r) => (
          <RoleCard key={r.id} role={r} />
        ))}
      </section>
    </div>
  );
}

function RoleCard({ role }: { role: StrategyRole }) {
  const [open, setOpen] = useState(!role.builtin);
  return (
    <div className={`rounded-lg border bg-card ${role.builtin ? "border-edge" : "border-accent/30"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {role.builtin ? (
          <>
            <span className="text-xs">🔒</span>
            <span className="flex-1 text-sm font-medium text-gray-100">{role.name}</span>
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            >
              {open ? "Hide prompt" : "View prompt"}
            </button>
            <button
              onClick={() => strategyStore.cloneRole(role.id)}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:bg-edge/50 hover:text-gray-200"
              title="Copy into an editable custom role"
            >
              ⎘ Clone
            </button>
          </>
        ) : (
          <>
            <input
              value={role.name}
              onChange={(e) => strategyStore.updateRole(role.id, { name: e.target.value })}
              className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-sm font-medium text-gray-100 outline-none focus:border-accent"
            />
            <button
              onClick={() => strategyStore.deleteRole(role.id)}
              className="rounded px-1.5 py-1 text-[11px] text-muted hover:text-red-300"
              title="Delete role"
            >
              ✕
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="border-t border-edge px-3 py-2">
          {role.builtin ? (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-300">{role.prompt}</p>
          ) : (
            <textarea
              value={role.prompt}
              onChange={(e) => strategyStore.updateRole(role.id, { prompt: e.target.value })}
              rows={4}
              placeholder="Describe who this participant is and the lens they bring to the discussion…"
              className="w-full resize-y rounded border border-edge bg-panel px-2 py-1.5 text-xs leading-relaxed text-gray-200 outline-none focus:border-accent"
            />
          )}
        </div>
      )}
    </div>
  );
}
