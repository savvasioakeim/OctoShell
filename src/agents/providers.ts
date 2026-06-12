// Agent provider abstraction: each CLI streams its own newline-delimited JSON,
// and we normalise every line into the same small event shape the ShellController
// renders into blocks. Adding a provider = one parser here (+ args in agent.rs).

export type AgentProvider = "claude" | "gemini";

export const PROVIDERS: { value: AgentProvider; label: string; icon: string }[] = [
  { value: "claude", label: "Claude", icon: "🐙" },
  { value: "gemini", label: "Gemini", icon: "✦" },
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
  return provider === "gemini" ? parseGemini(ev) : parseClaude(ev);
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
