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

// --- Claude Code (claude --output-format stream-json) ---
function parseClaude(ev: any): NormEvent[] {
  const out: NormEvent[] = [];
  if (typeof ev?.session_id === "string") out.push({ session: ev.session_id });
  if (ev?.type === "assistant") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) out.push({ text: c.text });
      else if (c.type === "tool_use") {
        const input =
          c.name === "Bash" && typeof c.input?.command === "string"
            ? c.input.command
            : JSON.stringify(c.input ?? {}, null, 2);
        out.push({ tool: { id: c.id, name: c.name ?? "tool", input } });
      }
    }
  } else if (ev?.type === "user") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_result") {
        out.push({
          result: { id: c.tool_use_id, content: normalizeToolContent(c.content), isError: !!c.is_error },
        });
      }
    }
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
    const params = ev.parameters ?? ev.args ?? ev.input ?? {};
    const input =
      typeof params === "string" ? params
      : typeof params.command === "string" ? params.command // shell-style tools
      : JSON.stringify(params, null, 2);
    out.push({
      tool: {
        id: String(ev.tool_id ?? ev.id ?? out.length),
        name: ev.tool_name ?? ev.name ?? "tool",
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
  }
  return out;
}
