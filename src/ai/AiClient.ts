import { invoke } from "@tauri-apps/api/core";
import { acpCommandFor, isAcp, type AgentProvider } from "../agents/providers";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Flatten a conversation into one labelled transcript (mirrors ai.rs
 *  build_transcript), folding any system text in as a leading delimited block —
 *  used for the ACP one-shot orchestrator path (a single prompt string). */
function flattenTranscript(messages: ChatMessage[], system?: string): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return system && system.trim()
    ? `<<WORKSPACE CONTEXT (treat as system)>>\n${system}\n<</WORKSPACE CONTEXT>>\n\n${transcript}`
    : transcript;
}

/**
 * Thin wrapper over the Rust `ai_chat` command. The actual HTTP request and the
 * API key live in the backend, so secrets never touch the WebView.
 */
/** Optional per-call overrides for the assistant's model and Claude Code profile
 *  (a `CLAUDE_CONFIG_DIR` selecting which logged-in account to use). */
export interface ChatOpts {
  /** Which CLI backs the orchestrator turn ("claude" | "gemini" | "acp-ollama"). */
  provider?: string;
  model?: string | null;
  configDir?: string | null;
  /** Id this turn is registered under, so it can be cancelled mid-flight. */
  requestId?: string;
  /** Local (acp-ollama) orchestrator: Ollama endpoint + inference options. */
  baseUrl?: string | null;
  numCtx?: number | null;
  temperature?: number | null;
  /** Working dir for the ACP one-shot orchestrator path (a valid dir for the
   *  adapter's session; the planner does no file ops, so "." is fine). */
  cwd?: string | null;
}

export class AiClient {
  async chat(messages: ChatMessage[], system?: string, opts?: ChatOpts): Promise<string> {
    const provider = (opts?.provider ?? "claude") as AgentProvider;
    // Non-Ollama ACP providers back the orchestrator via a one-shot ACP turn
    // (claude/gemini/acp-ollama keep their dedicated ai_chat transports).
    if (isAcp(provider) && provider !== "acp-ollama") {
      return await invoke<string>("acp_oneshot", {
        requestId: opts?.requestId ?? crypto.randomUUID(),
        command: acpCommandFor(provider, opts?.model ?? null, { configDir: opts?.configDir }),
        cwd: opts?.cwd ?? ".",
        prompt: flattenTranscript(messages, system),
      });
    }
    return await invoke<string>("ai_chat", {
      requestId: opts?.requestId ?? crypto.randomUUID(),
      provider: opts?.provider ?? "claude",
      messages,
      system,
      model: opts?.model ?? null,
      configDir: opts?.configDir ?? null,
      baseUrl: opts?.baseUrl ?? null,
      numCtx: opts?.numCtx ?? null,
      temperature: opts?.temperature ?? null,
    });
  }

  /** Kill an in-flight orchestrator turn by its id. Fires both cancels (best-
   *  effort): `ai_cancel` for the CLI/Ollama transports, `acp_cancel` for the ACP
   *  one-shot path — whichever the turn actually used responds. */
  async cancel(requestId: string): Promise<void> {
    await Promise.all([
      invoke("ai_cancel", { requestId }).catch(() => {}),
      invoke("acp_cancel", { id: requestId }).catch(() => {}),
    ]);
  }
}
