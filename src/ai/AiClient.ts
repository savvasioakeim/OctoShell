import { invoke } from "@tauri-apps/api/core";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Thin wrapper over the Rust `ai_chat` command. The actual HTTP request and the
 * API key live in the backend, so secrets never touch the WebView.
 */
export class AiClient {
  async chat(messages: ChatMessage[], system?: string): Promise<string> {
    return await invoke<string>("ai_chat", { messages, system });
  }
}
