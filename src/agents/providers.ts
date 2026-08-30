// Agent provider abstraction: each CLI streams its own newline-delimited JSON,
// and we normalise every line into the same small event shape the ShellController
// renders into blocks. Adding a provider = one parser here (+ args in agent.rs).

// "claude"/"gemini" are the bespoke stream-json integrations (agent.rs). The
// `acp-*` providers all speak the Agent Client Protocol (acp.rs) — one backend
// path, many agents.
//
// EVERYTHING known about a provider lives in ONE entry in PROVIDER_DEFS below:
// label, models, profile env var, ACP launch details. That knowledge used to be
// spread over five tables keyed by the same id — the union type, ACP_AGENTS,
// CONFIG_DIR_ENV, PROVIDERS, and modelsFor() over in settingsStore — so adding
// an agent meant editing five places, and missing one produced a provider that
// half-worked with no error anywhere. The accessors below are now views over the
// single table, and `AgentProvider` is DERIVED from its keys: a typo is a
// compile error, and a new provider is one object.

/** One entry in a provider's model picker. `value: null` = let the CLI decide. */
export interface ModelOption {
  label: string;
  value: string | null;
}

/** Models offered for claude (CLI aliases passed to `--model`). */
export const CLAUDE_MODELS: ModelOption[] = [
  { label: "Default", value: null },
  { label: "Fable", value: "fable" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

/** Models offered for gemini (passed to `-m`) — the names this build reports. */
export const GEMINI_MODELS: ModelOption[] = [
  { label: "Default (auto)", value: null },
  { label: "Gemini 3 Pro", value: "gemini-3.1-pro-preview" },
  { label: "Gemini 3 Flash", value: "gemini-3-flash-preview" },
  { label: "Gemini 3 Flash Lite", value: "gemini-3.1-flash-lite" },
];

/** Models offered for local Ollama (via OpenCode's ACP server). Values carry the
 *  `ollama/` provider prefix OpenCode expects (`-m ollama/<model>`). The user must
 *  have pulled them and configured the `ollama` provider in OpenCode.
 *  Qwen2.5-Coder is the strongest at agentic tool use; Gemma is lighter but
 *  weaker at multi-step tool calls. */
export const OLLAMA_MODELS: ModelOption[] = [
  { label: "Default (OpenCode)", value: null },
  { label: "Qwen2.5 Coder 14B", value: "ollama/qwen2.5-coder:14b" },
  { label: "Qwen2.5 Coder 7B", value: "ollama/qwen2.5-coder:7b" },
  { label: "Qwen2.5 Coder 3B", value: "ollama/qwen2.5-coder:3b" },
  { label: "Gemma 3 4B", value: "ollama/gemma3:4b" },
];

/** For providers whose model selection isn't plumbed through their adapter yet —
 *  they run their own default. Stops e.g. Codex from offering Claude's aliases. */
const DEFAULT_ONLY: ModelOption[] = [{ label: "Default", value: null }];

/** An ACP-speaking agent: how to launch it, and how to set its model. */
export interface AcpAgentDef {
  /** Launch command (whitespace-split; `AcpAgent::from_str` parses it). */
  command: string;
  /** Env var that selects the model, prefixed onto the command as
   *  `NAME=value` (ACP parses leading NAME=value tokens as env vars). Null when
   *  the agent doesn't take a model via env — then it gets a trailing `-m`. */
  modelEnv: string | null;
  /** Docker image to run the WHOLE adapter inside when the sandbox setting is on
   *  (host isolation for every command the agent runs — not just delegated
   *  terminals). Null = no sandbox support (the adapter needs a host-installed
   *  CLI we can't provide in a generic image); those fall back to host execution. */
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

/** Everything OctoShell knows about one agent provider. */
export interface ProviderDef {
  /** Shown in every provider picker. */
  label: string;
  /** How the backend drives it: "native" = a CLI whose stream-json we parse
   *  ourselves (agent.rs); "acp" = the Agent Client Protocol (acp.rs). This, not
   *  an `acp-` prefix on the id, is what decides the code path — so a provider
   *  added later can be named anything. */
  transport: "native" | "acp";
  /** The model picker's options. */
  models: ModelOption[];
  /** Env var pointing at this CLI's config/account dir, which is what makes
   *  profiles (multiple logged-in accounts) possible. Null = no such dir, so no
   *  profile picker. */
  configDirEnv: string | null;
  /** Launch details. Required for `transport: "acp"`, absent for native. */
  acp?: AcpAgentDef;
}

/** THE provider table. One entry per agent; the key is the persisted provider id.
 *  On Windows npx/gemini are `.cmd` shims, so their commands go through cmd.exe. */
export const PROVIDER_DEFS = {
  claude: {
    label: "Claude",
    transport: "native",
    models: CLAUDE_MODELS,
    // Applied by agent.rs/ai.rs through the spawned process's env rather than a
    // launch-command prefix — but it is still what enables profiles.
    configDirEnv: "CLAUDE_CONFIG_DIR",
  },
  gemini: {
    label: "Gemini",
    transport: "native",
    models: GEMINI_MODELS,
    // GEMINI_CONFIG_DIR is ignored on Windows (upstream bug), so no profiles.
    configDirEnv: null,
  },
  "acp-claude": {
    label: "Claude (ACP)",
    transport: "acp",
    models: CLAUDE_MODELS,
    configDirEnv: "CLAUDE_CONFIG_DIR",
    acp: {
      command: "cmd /c npx -y @agentclientprotocol/claude-agent-acp",
      modelEnv: "ANTHROPIC_MODEL",
      // claude-code (which the adapter wraps) needs node >= 22.
      dockerImage: "node:22",
      dockerCommand: "npx -y @agentclientprotocol/claude-agent-acp",
      loginCommand: "npx -y @anthropic-ai/claude-code@latest",
    },
  },
  "acp-codex": {
    label: "Codex (ACP)",
    transport: "acp",
    models: DEFAULT_ONLY,
    configDirEnv: "CODEX_HOME",
    acp: {
      // OpenAI Codex via Zed's ACP adapter. Model selection through the adapter
      // isn't confirmed yet, so it runs the agent's default (no modelEnv).
      command: "cmd /c npx -y @zed-industries/codex-acp@latest",
      modelEnv: null,
      dockerImage: "node:22",
      dockerCommand: "npx -y @zed-industries/codex-acp@latest",
      // The adapter wraps the codex CLI; its interactive run offers the login.
      loginCommand: "npx -y @openai/codex@latest",
    },
  },
  "acp-opencode": {
    label: "OpenCode (ACP)",
    transport: "acp",
    models: DEFAULT_ONLY,
    configDirEnv: "XDG_DATA_HOME",
    acp: { command: "cmd /c opencode acp", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  },
  "acp-cursor": {
    label: "Cursor (ACP)",
    transport: "acp",
    models: DEFAULT_ONLY,
    configDirEnv: "CURSOR_CONFIG_DIR",
    acp: { command: "cmd /c cursor-agent acp", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  },
  "acp-copilot": {
    label: "Copilot (ACP)",
    transport: "acp",
    models: DEFAULT_ONLY,
    configDirEnv: "COPILOT_HOME",
    acp: { command: "cmd /c copilot --acp --stdio", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  },
  "acp-kiro": {
    label: "Kiro (ACP)",
    transport: "acp",
    models: DEFAULT_ONLY,
    configDirEnv: null,
    acp: { command: "cmd /c kiro-cli acp --trust-all-tools", modelEnv: null, dockerImage: null, dockerCommand: null, loginCommand: null },
  },
  "acp-gemini": {
    label: "Gemini (ACP)",
    transport: "acp",
    models: GEMINI_MODELS,
    configDirEnv: null,
    acp: {
      // Gemini CLI speaks ACP natively; the model goes in as a trailing -m.
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
  },
  "acp-ollama": {
    label: "Local · Ollama (ACP)",
    transport: "acp",
    models: OLLAMA_MODELS,
    configDirEnv: null,
    acp: {
      // Local models through OpenCode's ACP server: OpenCode owns the agent loop
      // (tool use, edits) and speaks ACP; Ollama is only the model backend
      // (OpenAI-compatible endpoint on localhost:11434). The model arrives as
      // `-m ollama/<model>`, which is why OLLAMA_MODELS values carry the prefix.
      // Runs fully local, so there is no login. No generic image ships
      // OpenCode+Ollama, so it can't be sandboxed either.
      command: "cmd /c opencode acp",
      modelEnv: null,
      dockerImage: null,
      dockerCommand: null,
      loginCommand: null,
    },
  },
} satisfies Record<string, ProviderDef>;

/** Derived from the table's keys — never write this union by hand again. */
export type AgentProvider = keyof typeof PROVIDER_DEFS;

/** The definition behind a provider id. */
export function providerDef(provider: AgentProvider): ProviderDef {
  return PROVIDER_DEFS[provider];
}

/** The env var that points this provider's config/account dir, or null if it has
 *  no per-account config dir OctoShell can drive. */
export function configDirEnvFor(provider: AgentProvider): string | null {
  return PROVIDER_DEFS[provider]?.configDirEnv ?? null;
}

/** True if a profile (config-dir/account) picker is meaningful for this provider.
 *  Native `claude` applies it via its own env (agent.rs/ai.rs), the ACP CLIs via
 *  the command env prefix (see acpCommandFor). */
export function supportsProfile(provider: AgentProvider): boolean {
  return configDirEnvFor(provider) !== null;
}

/** The model list for a provider.
 *
 *  ACP entries get their "no explicit model" option relabelled to "Agent
 *  default", because that is the truth: the adapter picks, not us. The rule lives
 *  here rather than in duplicated per-provider lists — which is how the InputBar's
 *  copy of these lists drifted from this one (different labels, and one model
 *  missing for acp-gemini) before they were merged. */
export function modelsFor(provider: AgentProvider): ModelOption[] {
  const def = PROVIDER_DEFS[provider];
  const models = def?.models ?? DEFAULT_ONLY;
  if (def?.transport !== "acp") return models;
  return models.map((m) => (m.value === null ? { ...m, label: "Agent default" } : m));
}

export function acpCommandFor(
  provider: AgentProvider,
  model: string | null,
  opts?: { opencodeConfig?: string | null; configDir?: string | null },
): string {
  const def = providerDef(provider).acp;
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
  const def = providerDef(provider).acp;
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
  const def = providerDef(provider).acp;
  if (!def || !def.dockerImage || !def.dockerCommand) return null;
  let command = def.dockerCommand;
  if (model) {
    command = def.modelEnv ? `${def.modelEnv}=${model} ${command}` : `${command} -m ${model}`;
  }
  return { image: def.dockerImage, command };
}

/** True for any provider that runs over ACP (acp.rs). Reads the table rather
 *  than the id's spelling, so a provider added later need not be named `acp-*`. */
export function isAcp(provider: AgentProvider): boolean {
  return PROVIDER_DEFS[provider]?.transport === "acp";
}

/** Coerce a persisted/unknown provider string to a valid one, migrating the
 *  legacy generic "acp" id (→ "acp-claude") and defaulting anything unrecognised
 *  to "claude". Prevents a stale localStorage value from crashing the UI. */
export function normalizeProvider(p: unknown): AgentProvider {
  if (p === "acp") return "acp-claude"; // legacy id, pre provider/model split
  return typeof p === "string" && p in PROVIDER_DEFS ? (p as AgentProvider) : "claude";
}

/** One planned step of a task (the agent's TodoWrite list), with its live status.
 *  Drives the trace progress bar. */
export interface AgentStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

// No brand logos: shipping official provider marks carries trademark/asset
// constraints, so agents are identified by name only (labels, no icon).
/** Picker options, derived from the table so the order and labels can never
 *  drift from it. Kept as `{value,label}[]` because every picker consumes that. */
export const PROVIDERS: { value: AgentProvider; label: string }[] = (
  Object.keys(PROVIDER_DEFS) as AgentProvider[]
).map((value) => ({ value, label: PROVIDER_DEFS[value].label }));

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
  /** Current context-window occupancy. Both halves arrive from DIFFERENT events
   *  (occupancy per request, window size only in the final result), so each is
   *  optional and the controller merges them — never treat a missing half as 0. */
  context?: { used?: number; window?: number };
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
      .map((c: any) =>
        c?.type === "terminal" ? acpTerminal(c) : c?.type === "content" ? acpText(c.content) : acpText(c),
      )
      .filter(Boolean)
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** Render a terminal tool-call part. ACP sends only a `terminalId` reference;
 *  acp.rs resolves it and inlines the `output`/`exitCode` we captured, so the
 *  command's real output — and the reason a failure failed — is renderable. */
function acpTerminal(part: any): string {
  const out = typeof part?.output === "string" ? part.output.trimEnd() : "";
  const code = part?.exitCode;
  if (typeof code === "number" && code !== 0) {
    return out ? `${out}\n\n[exited with code ${code}]` : `[exited with code ${code}, no output]`;
  }
  return out;
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
    } else if (se?.type === "message_start" && se.message?.usage) {
      // THE context reading. Each message_start carries the prompt size of THAT
      // single API request, so the last one in a turn is the live occupancy.
      // The `result` event's usage is the turn's SUM across every request, which
      // for a 20-tool-call turn counts the cached prefix 20 times — that's how a
      // 1M window displayed "4M/1M". Sums measure spend; only a single request
      // measures occupancy.
      const u = se.message.usage;
      const used =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (used > 0) out.push({ context: { used } });
    }
    // message_stop, content_block_start/stop, thinking deltas → ignore.
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
    // Only the WINDOW SIZE comes from here (modelUsage). Occupancy is read from
    // message_start above — ev.usage is cumulative for the turn and would grossly
    // overstate it.
    const window = Object.values<any>(ev.modelUsage ?? {}).reduce(
      (mx, m) => Math.max(mx, m?.contextWindow ?? 0),
      0,
    );
    if (window > 0) out.push({ context: { window } });
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
