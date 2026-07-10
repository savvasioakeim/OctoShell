// Agent provider abstraction: each CLI streams its own newline-delimited JSON,
// and we normalise every line into the same small event shape the ShellController
// renders into blocks. Adding a provider = one parser here (+ args in agent.rs).

// "claude"/"gemini" are the bespoke stream-json integrations (agent.rs). The
// `acp-*` providers all speak the Agent Client Protocol (acp.rs) — one backend
// path, many agents. Adding an ACP agent = one entry in ACP_AGENTS below.
export type AgentProvider =
  | "claude"
  | "gemini"
  | "acp-claude"
  | "acp-gemini"
  | "acp-codex"
  | "acp-opencode"
  | "acp-cursor"
  | "acp-copilot"
  | "acp-kiro"
  | "acp-ollama";

/** An ACP-speaking agent: how to launch it, and how to set its model. */
export interface AcpAgentDef {
  /** Launch command (whitespace-split; `AcpAgent::from_str` parses it). */
  command: string;
  /** Env var that selects the model, prefixed onto the command as
   *  `NAME=value` (ACP parses leading NAME=value tokens as env vars). Null when
   *  the agent doesn't take a model via env. */
  modelEnv: string | null;
  /** Docker image to run the WHOLE adapter inside when the sandbox setting is on
   *  (host isolation for every command the agent runs — not just delegated
   *  terminals). Null = no sandbox support (adapter needs a host-installed CLI we
   *  can't provide in a generic image); those fall back to host execution. */
  dockerImage: string | null;
  /** The adapter's launch command in Linux form (no `cmd /c` shim), run inside
   *  the container via `sh -c`. Null when `dockerImage` is null. */
  dockerCommand: string | null;
  /** Interactive command (Linux form) that runs the UNDERLYING CLI inside the
   *  shared sandbox volume so the user can complete its login flow once; its
   *  credentials land in the volume and every sandboxed session reuses them.
   *  Null = no sandbox support or no interactive login. */
  loginCommand: string | null;
}

/** Registry of ACP agents, keyed by provider id. On Windows npx/gemini are .cmd
 *  shims, so they go through cmd.exe. */
export const ACP_AGENTS: Record<string, AcpAgentDef> = {
  "acp-claude": {
    command: "cmd /c npx -y @agentclientprotocol/claude-agent-acp",
    modelEnv: "ANTHROPIC_MODEL",
    // claude-code (which the adapter wraps) needs node ≥22.
    dockerImage: "node:22",
    dockerCommand: "npx -y @agentclientprotocol/claude-agent-acp",
    loginCommand: "npx -y @anthropic-ai/claude-code@latest",
  },
  "acp-gemini": {
    // Gemini CLI speaks ACP natively; model is selected via its own -m flag,
    // appended in acpCommandFor rather than an env var.
    // NOTE: Google sunset the Gemini CLI for INDIVIDUAL accounts on 2026-06-18,
    // superseded by the Antigravity CLI (`agy`, announced 2026-05-19). The
    // gemini-cli binary still installs and drives Code Assist Standard/
    // Enterprise. `agy` itself doesn't speak ACP yet (an --acp/stdio JSON-RPC
    // mode is only a feature request, google-antigravity/antigravity-cli#31),
    // and the Antigravity *IDE* is a GUI Electron app with no headless entry
    // point — so neither can be added as an adapter here yet. Revisit once
    // `agy` ships either --acp or a stream-json headless mode.
    command: "cmd /c npx -y -- @google/gemini-cli@latest --experimental-acp",
    modelEnv: null,
    dockerImage: "node:22",
    dockerCommand: "npx -y -- @google/gemini-cli@latest --experimental-acp",
    loginCommand: "npx -y -- @google/gemini-cli@latest",
  },
  "acp-codex": {
    // OpenAI Codex via Zed's ACP adapter. Model selection through the adapter
    // isn't confirmed yet, so it runs the agent's default (no modelEnv).
    command: "cmd /c npx -y @zed-industries/codex-acp@latest",
    modelEnv: null,
    dockerImage: "node:22",
    dockerCommand: "npx -y @zed-industries/codex-acp@latest",
    // The adapter wraps the codex CLI; its interactive run offers the login flow.
    loginCommand: "npx -y @openai/codex@latest",
  },
  // The rest speak ACP natively but need their own CLI installed & on PATH
  // (like the native gemini provider). Commands are the canonical ACP-stdio
  // invocations. Model selection per-agent isn't wired yet → agent default.
  // No generic image ships their CLI, so they can't be sandboxed (dockerImage
  // null → host execution even when the sandbox setting is on).
  "acp-opencode": { command: "cmd /c opencode acp", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  // Local models via Ollama, driven through OpenCode's ACP server. OpenCode owns
  // the agent loop (tool-use, edits) and speaks ACP; Ollama is just the model
  // backend (OpenAI-compatible endpoint at localhost:11434). The model is passed
  // as `-m ollama/<model>` (gemini-style trailing flag, modelEnv null), so the
  // OLLAMA_MODELS values already carry the `ollama/` provider prefix. Requires
  // OpenCode installed with an `ollama` provider configured in its config; the
  // model runs fully local (no login, no cloud), hence loginCommand null. No
  // generic image ships OpenCode+Ollama, so it isn't sandboxable (dockerImage
  // null → host execution).
  "acp-ollama": { command: "cmd /c opencode acp", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  "acp-cursor": { command: "cmd /c cursor-agent acp", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  "acp-copilot": { command: "cmd /c copilot --acp --stdio", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  "acp-kiro": { command: "cmd /c kiro-cli acp --trust-all-tools", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
};

/** Build the launch command for an ACP provider, injecting the selected model:
 *  as an env prefix when the agent uses one, else (gemini) as a trailing `-m`.
 *  `opencodeConfig` (acp-ollama only) is an OctoShell-owned OpenCode config path;
 *  it's injected as a leading `OPENCODE_CONFIG=<path>` env prefix so local runs
 *  pick up our ollama provider + inference defaults (base URL, temperature,
 *  num_ctx). The path is space-free (see the backend's `opencode_config`), so the
 *  ACP whitespace tokeniser keeps it as one token. */
/** A "profile" (a named config/account folder) is set per provider via a
 *  provider-specific env var. These are the CLIs whose config dir OctoShell can
 *  point at a chosen folder — the equivalent of Claude's CLAUDE_CONFIG_DIR:
 *    - acp-codex   → CODEX_HOME        (config + auth + sessions)
 *    - acp-cursor  → CURSOR_CONFIG_DIR (cli-config.json + auth)
 *    - acp-copilot → COPILOT_HOME      (config + auth)
 *    - acp-opencode→ XDG_DATA_HOME     (opencode's data dir incl. auth.json)
 *  Gemini's GEMINI_CONFIG_DIR is ignored on Windows (upstream bug), and
 *  ollama/kiro have no per-account config dir, so they're intentionally absent. */
const CONFIG_DIR_ENV: Partial<Record<AgentProvider, string>> = {
  "acp-claude": "CLAUDE_CONFIG_DIR",
  "acp-codex": "CODEX_HOME",
  "acp-cursor": "CURSOR_CONFIG_DIR",
  "acp-copilot": "COPILOT_HOME",
  "acp-opencode": "XDG_DATA_HOME",
};

/** The env var that points this provider's config/account dir, or null if it has
 *  no per-account config dir OctoShell can drive. */
export function configDirEnvFor(provider: AgentProvider): string | null {
  return CONFIG_DIR_ENV[provider] ?? null;
}

/** True if a profile (config-dir/account) picker is meaningful for this provider.
 *  Native `claude` applies it via its own env (agent.rs/ai.rs), the ACP CLIs via
 *  the command env prefix (see acpCommandFor). */
export function supportsProfile(provider: AgentProvider): boolean {
  return provider === "claude" || configDirEnvFor(provider) !== null;
}

export function acpCommandFor(
  provider: AgentProvider,
  model: string | null,
  opts?: { opencodeConfig?: string | null; configDir?: string | null },
): string {
  const def = ACP_AGENTS[provider];
  if (!def) return "";
  let cmd = def.command;
  if (model) cmd = def.modelEnv ? `${def.modelEnv}=${model} ${cmd}` : `${cmd} -m ${model}`;
  // Profile selection: point the CLI's config/account dir env var at the chosen
  // folder (forward-slashed so backslashes don't confuse the ACP tokeniser). NOTE:
  // the tokeniser is whitespace-split, so a profile path containing spaces won't
  // pass through — practically these dirs (…/.codex, …/.cursor) have no spaces.
  const cfgEnv = configDirEnvFor(provider);
  if (opts?.configDir && cfgEnv) {
    cmd = `${cfgEnv}=${opts.configDir.replace(/\\/g, "/")} ${cmd}`;
  }
  if (opts?.opencodeConfig) cmd = `OPENCODE_CONFIG=${opts.opencodeConfig} ${cmd}`;
  return cmd;
}

/** Write the OctoShell-owned OpenCode config for a local (acp-ollama) run and
 *  return its path for {@link acpCommandFor}; null for any other provider or on
 *  failure (the run then just falls back to OpenCode's own config). */
export async function prepareOpencodeConfig(
  provider: AgentProvider,
  ollama: { baseUrl: string; temperature: number; contextWindow: number },
): Promise<string | null> {
  if (provider !== "acp-ollama") return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("opencode_config", {
      baseUrl: ollama.baseUrl,
      temperature: ollama.temperature,
      numCtx: ollama.contextWindow,
    });
  } catch {
    return null;
  }
}

/** One-time interactive login for a sandboxed ACP agent: runs the provider's
 *  UNDERLYING CLI in the shared `$HOME` volume so its login (OAuth/device-code)
 *  is stored there and reused by every sandboxed worktree — separate from the
 *  host login. Run in an OctoShell terminal (it renders the interactive TUI);
 *  the user completes the browser step. `-it` gets a TTY from the PTY; no
 *  `cmd /c` (PowerShell runs it). Null when the provider can't be sandboxed. */
export function sandboxLoginCommandFor(provider: AgentProvider): string | null {
  const def = ACP_AGENTS[provider];
  if (!def || !def.dockerImage || !def.loginCommand) return null;
  return `docker run -it --rm --user node -e HOME=/home/node -v ${SANDBOX_HOME_VOLUME}:/home/node ${def.dockerImage} ${def.loginCommand}`;
}

/** The shared named volume holding sandbox logins + npm cache (must match
 *  SANDBOX_HOME_VOLUME in acp.rs). */
const SANDBOX_HOME_VOLUME = "octoshell-claude-home";

/** The image + Linux launch command for running an ACP adapter INSIDE a Docker
 *  container (whole-adapter sandboxing). Returns null when the provider has no
 *  sandbox support (needs a host CLI) — the caller then runs it on the host even
 *  with the sandbox setting on. Model injection mirrors {@link acpCommandFor}. */
export function acpSandboxCommandFor(
  provider: AgentProvider,
  model: string | null,
): { image: string; command: string } | null {
  const def = ACP_AGENTS[provider];
  if (!def || !def.dockerImage || !def.dockerCommand) return null;
  let command = def.dockerCommand;
  if (model) {
    command = def.modelEnv ? `${def.modelEnv}=${model} ${command}` : `${command} -m ${model}`;
  }
  return { image: def.dockerImage, command };
}

/** True for any provider that runs over ACP (acp.rs). */
export function isAcp(provider: AgentProvider): boolean {
  return provider.startsWith("acp");
}

/** Coerce a persisted/unknown provider string to a valid one, migrating the
 *  legacy generic "acp" id (→ "acp-claude") and defaulting anything unrecognised
 *  to "claude". Prevents a stale localStorage value from crashing the UI. */
export function normalizeProvider(p: unknown): AgentProvider {
  if (p === "acp") return "acp-claude"; // legacy id, pre provider/model split
  return PROVIDERS.some((x) => x.value === p) ? (p as AgentProvider) : "claude";
}

/** One planned step of a task (the agent's TodoWrite list), with its live status.
 *  Drives the trace progress bar. */
export interface AgentStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export const PROVIDERS: { value: AgentProvider; label: string; icon: string }[] = [
  { value: "claude", label: "Claude", icon: "🐙" },
  { value: "gemini", label: "Gemini", icon: "✦" },
  { value: "acp-claude", label: "Claude (ACP)", icon: "🐙" },
  { value: "acp-codex", label: "Codex (ACP)", icon: "⬡" },
  { value: "acp-opencode", label: "OpenCode (ACP)", icon: "▣" },
  { value: "acp-cursor", label: "Cursor (ACP)", icon: "▮" },
  { value: "acp-copilot", label: "Copilot (ACP)", icon: "🛩" },
  { value: "acp-kiro", label: "Kiro (ACP)", icon: "◆" },
  { value: "acp-gemini", label: "Gemini (ACP)", icon: "✦" },
  { value: "acp-ollama", label: "Local · Ollama (ACP)", icon: "🦙" },
];

/** A normalised stream event. Exactly one field is meaningful per event. */
export interface NormEvent {
  /** Session id (from the provider's init event) — for multi-turn resume. */
  session?: string;
  /** Assistant text. `delta` = a streaming chunk to append (gemini); otherwise a
   *  complete message (claude). */
  text?: string;
  delta?: boolean;
  /** A tool invocation. */
  tool?: { id: string; name: string; input: string };
  /** The agent's full plan (ACP `plan` update): the ordered steps with status,
   *  replacing the current progress wholesale. Drives the trace bar for ACP
   *  agents (the equivalent of the native path's TaskCreate/TaskUpdate). */
  steps?: AgentStep[];
  /** A tool's result, keyed back to the tool's id. */
  result?: { id: string; content: string; isError: boolean };
  /** Token usage for the turn (from the provider's final result event). */
  usage?: { input: number; output: number; costUsd?: number };
  /** Current context-window occupancy after the turn (latest, not summed). */
  context?: { used: number; window: number };
  /** True when billing is per-token (API key) — then cost ($) is meaningful.
   *  On a subscription this is false and cost is hidden. */
  apiKey?: boolean;
  /** Epoch seconds when the subscription rate-limit window resets (from the
   *  rate_limit_event). The headless stream exposes the reset time but not a
   *  used-percentage. */
  rateReset?: number;
}

/** A tool_result `content` is either a string or an array of content parts. */
function normalizeToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text : ""))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

export function parseAgentLine(provider: AgentProvider, line: string): NormEvent[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  if (provider === "gemini") return parseGemini(ev);
  if (isAcp(provider)) return parseAcp(ev);
  return parseClaude(ev);
}

// --- ACP (Agent Client Protocol, via acp.rs) ---
// Each line is one serialized ACP `SessionUpdate`, internally tagged by
// `sessionUpdate` (snake_case) with the variant's fields inlined. One
// implementation covers every ACP-speaking agent (Claude, Gemini, …).
function parseAcp(ev: any): NormEvent[] {
  const out: NormEvent[] = [];
  const kind = ev?.sessionUpdate;

  if (kind === "agent_message_chunk") {
    // Streaming assistant text. `content` is a ContentBlock; render text parts.
    const text = acpText(ev.content);
    if (text) out.push({ text, delta: true });
    // agent_thought_chunk (internal reasoning) and user_message_chunk (our own
    // prompt echo) are intentionally ignored.
  } else if (kind === "tool_call") {
    // A new tool invocation. `title` is the human label; input is best-effort
    // from rawInput (shape is agent-specific).
    const input =
      ev.rawInput != null ? stringifyInput(ev.rawInput) : acpToolContent(ev.content);
    out.push({
      tool: {
        id: String(ev.toolCallId ?? out.length),
        name: String(ev.title ?? ev.kind ?? "tool"),
        input,
      },
    });
  } else if (kind === "tool_call_update") {
    // Status/result update for a running tool call. Surface a result only once
    // the call reaches a terminal status.
    const status = ev.fields?.status ?? ev.status;
    if (status === "completed" || status === "failed") {
      out.push({
        result: {
          id: String(ev.toolCallId ?? ""),
          content: acpToolContent(ev.fields?.content ?? ev.content),
          isError: status === "failed",
        },
      });
    }
  } else if (kind === "plan") {
    // The agent's task plan. `entries` is the full ordered list every time
    // (ACP re-sends the whole plan on each change), so map it wholesale to steps
    // and let the controller replace the trace bar's progress. ACP plan status is
    // "pending" | "in_progress" | "completed" — the same shape as AgentStep.
    const entries = Array.isArray(ev.entries) ? ev.entries : [];
    const steps: AgentStep[] = entries
      .map((e: any) => ({
        text: String(e?.content ?? e?.title ?? "").trim(),
        status:
          e?.status === "in_progress" || e?.status === "completed"
            ? e.status
            : "pending",
      }))
      .filter((s: AgentStep) => s.text);
    if (steps.length) out.push({ steps });
  }
  // usage_update / mode / config updates → ACP v1 has no standardised token
  // usage update, so the meters stay driven by the native path only.
  return out;
}

/** Extract plain text from an ACP ContentBlock (`{type:"text",text}`), else "". */
function acpText(content: any): string {
  if (content?.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

/** Flatten ACP ToolCallContent[] (each `{type:"content",content:ContentBlock}`
 *  or a diff) into a readable string. */
function acpToolContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "content" ? acpText(c.content) : acpText(c)))
      .filter(Boolean)
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function stringifyInput(raw: any): string {
  if (typeof raw === "string") return raw;
  if (typeof raw?.command === "string") return raw.command; // shell-style tools
  return JSON.stringify(raw, null, 2);
}

// --- Claude Code (claude --output-format stream-json --include-partial-messages) ---
// Assistant TEXT arrives token-by-token via `stream_event` text deltas, so the
// consolidated `assistant` event is used only for tool_use (its text would
// duplicate the streamed deltas). `result` carries the turn's token usage.
function parseClaude(ev: any): NormEvent[] {
  const out: NormEvent[] = [];
  if (typeof ev?.session_id === "string") out.push({ session: ev.session_id });

  if (ev?.type === "system" && ev.subtype === "init") {
    // apiKeySource "none" = a Claude subscription (no per-token billing).
    out.push({ apiKey: typeof ev.apiKeySource === "string" && ev.apiKeySource !== "none" });
  } else if (ev?.type === "rate_limit_event") {
    const r = ev.rate_limit_info?.resetsAt;
    if (typeof r === "number") out.push({ rateReset: r });
  } else if (ev?.type === "stream_event") {
    const se = ev.event;
    if (se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
      out.push({ text: se.delta.text, delta: true });
    }
    // message_start/stop, content_block_start/stop, thinking deltas → ignore.
  } else if (ev?.type === "assistant") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use") {
        const input =
          c.name === "Bash" && typeof c.input?.command === "string"
            ? c.input.command
            : JSON.stringify(c.input ?? {}, null, 2);
        out.push({ tool: { id: c.id, name: c.name ?? "tool", input } });
      }
      // text is skipped here — it already streamed via stream_event deltas.
    }
  } else if (ev?.type === "user") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_result") {
        out.push({
          result: { id: c.tool_use_id, content: normalizeToolContent(c.content), isError: !!c.is_error },
        });
      }
    }
  } else if (ev?.type === "result" && ev.usage) {
    out.push({
      usage: {
        input: (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0),
        output: ev.usage.output_tokens ?? 0,
        costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      },
    });
    // Current context-window occupancy: the turn's whole prompt (new + cached)
    // over the primary model's window (from modelUsage).
    const window = Object.values<any>(ev.modelUsage ?? {}).reduce(
      (mx, m) => Math.max(mx, m?.contextWindow ?? 0),
      0,
    );
    const used =
      (ev.usage.input_tokens ?? 0) +
      (ev.usage.cache_read_input_tokens ?? 0) +
      (ev.usage.cache_creation_input_tokens ?? 0);
    if (window > 0) out.push({ context: { used, window } });
  }
  return out;
}

// --- Gemini CLI (gemini -o stream-json) ---
// init{session_id} · message{role,content,delta} · result{status,stats}.
// Assistant text arrives as streaming deltas. Tool-event field names are not yet
// confirmed against a live tool run, so they're handled best-effort.
function parseGemini(ev: any): NormEvent[] {
  const out: NormEvent[] = [];
  if (ev?.type === "init" && typeof ev.session_id === "string") {
    out.push({ session: ev.session_id });
  } else if (ev?.type === "message") {
    // Skip the model's internal "thoughts"; render only user/assistant content.
    if (ev.role === "assistant" && !ev.thought && typeof ev.content === "string" && ev.content) {
      out.push({ text: ev.content, delta: !!ev.delta });
    }
    // role "user" is just the echo of our own prompt → ignore.
  } else if (ev?.type === "tool_use") {
    const name = ev.tool_name ?? ev.name ?? "tool";
    // `update_topic` is Gemini's internal planning tool — noise, not real work.
    if (name === "update_topic") return out;
    const params = ev.parameters ?? ev.args ?? ev.input ?? {};
    const input =
      typeof params === "string" ? params
      : typeof params.command === "string" ? params.command // shell-style tools
      : JSON.stringify(params, null, 2);
    out.push({
      tool: {
        id: String(ev.tool_id ?? ev.id ?? out.length),
        name,
        input,
      },
    });
  } else if (ev?.type === "tool_result") {
    out.push({
      result: {
        id: String(ev.tool_id ?? ev.id ?? ""),
        content: normalizeToolContent(ev.output ?? ev.content),
        isError: ev.status === "error" || !!ev.is_error,
      },
    });
  } else if (ev?.type === "result") {
    const u = geminiUsage(ev.stats);
    if (u) out.push({ usage: u });
  }
  return out;
}

/** Best-effort token totals from Gemini's `result.stats` (shape varies by
 *  version, so dig defensively; returns null if nothing recognizable). */
function geminiUsage(stats: any): { input: number; output: number } | null {
  if (!stats || typeof stats !== "object") return null;
  let input = 0;
  let output = 0;
  const models = stats.models ?? stats.metrics?.models;
  if (models && typeof models === "object") {
    for (const m of Object.values<any>(models)) {
      const t = m?.tokens ?? m;
      input += t?.prompt ?? t?.input ?? t?.promptTokenCount ?? 0;
      output += t?.candidates ?? t?.output ?? t?.candidatesTokenCount ?? 0;
    }
  }
  return input || output ? { input, output } : null;
}
