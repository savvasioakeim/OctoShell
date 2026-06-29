import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Thin wrapper over the Rust `ai_chat` command. The actual HTTP request and the
 * API key live in the backend, so secrets never touch the WebView.
 */
/** Optional per-call overrides for the assistant's model and Claude Code profile
 *  (a `CLAUDE_CONFIG_DIR` selecting which logged-in account to use). */
export interface ChatOpts {
  /** Which CLI backs the orchestrator turn ("claude" | "gemini"). */
  provider?: string;
  model?: string | null;
  configDir?: string | null;
  /** Id this turn is registered under, so it can be cancelled mid-flight. */
  requestId?: string;
}

export class AiClient {
  async chat(messages: ChatMessage[], system?: string, opts?: ChatOpts): Promise<string> {
    return await invoke<string>("ai_chat", {
      requestId: opts?.requestId ?? crypto.randomUUID(),
      provider: opts?.provider ?? "claude",
      messages,
      system,
      model: opts?.model ?? null,
      configDir: opts?.configDir ?? null,
    });
  }

  /** Kill an in-flight orchestrator turn (the `claude` CLI child) by its id. */
  async cancel(requestId: string): Promise<void> {
    await invoke("ai_cancel", { requestId }).catch(() => {});
  }
}
