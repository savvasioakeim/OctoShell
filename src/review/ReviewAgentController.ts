// The automated REVIEW AGENT for one session (option β: a dedicated, PTY-less
// store per coding session). It drives a second agent — separate from the coding
// agent and the orchestrator — that vets the coding agent's diff (with the
// orchestrator's task context) BEFORE QA is offered. Its conversation is a small
// block feed the user can read and reply to from the project's Review view.
//
// It deliberately reuses the SAME backend as the coding agent (`agent_send` /
// `acp_send`, `agent://event` / `agent://done`) but under its own event id
// (`review:<sessionId>`), so its stream never collides with the coding agent's.
// It does NOT own a PTY or a shell — it is purely an agent conversation.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  acpCommandFor,
  acpSandboxCommandFor,
  isAcp,
  parseAgentLine,
  prepareOpencodeConfig,
  type AgentProvider,
} from "../agents/providers";
import { settingsStore } from "../settings/settingsStore";
import type { Block } from "../shell/ShellController";

/** A tiny pointer to where the change lives — just the branch and the latest
 *  commit (hash + subject). NOT a diff: the review agent runs git itself, so
 *  embedding a big diff/stat is wasteful and can mislead. Uses the existing
 *  `run_capture` — no backend change. Best-effort: "" on failure. */
export async function fetchReviewOverview(cwd: string): Promise<string> {
  const script =
    '"BRANCH: " + (git rev-parse --abbrev-ref HEAD 2>$null);' +
    '"HEAD: " + (git log -1 --format=\'%h %s\' 2>$null)';
  try {
    return (await invoke<string>("run_capture", { cwd, command: script })).trim();
  } catch {
    return "";
  }
}

/** Assemble the review agent's compact opening prompt: the orchestrator's task
 *  context + a one-pointer to the commit. The agent inspects the change itself.
 *  (Phase 4 appends the structured-verdict instruction.) */
export function buildReviewPrompt(context: string, overview: string): string {
  return [
    "You are a REVIEW AGENT — the last automated check before human QA. A coding agent just implemented and committed the task below in this worktree.",
    "",
    "TASK (from the orchestrator):",
    context || "(no task context available)",
    "",
    overview || "(inspect the repo to find the change)",
    "",
    "Inspect the actual change yourself with git (`git show HEAD`, `git diff`, read files as needed) — focus on the commit(s) for THIS task; the branch may carry unrelated prior work. Then give a concise review: what's good and any real problems.",
    "",
    "When you are done, end your FINAL message with exactly one fenced block:",
    "```octo-review-verdict",
    '{"blocking": <true if there is a bug, regression, or incomplete/incorrect work that MUST be fixed before human QA — otherwise false>, "summary": "<one short line — your overall conclusion>"}',
    "```",
    "Emit that block once, as the very last thing in your final message. If the user replies with follow-up, address it and emit a fresh verdict block again at the end.",
  ].join("\n");
}

/** Extract the review agent's structured verdict from its final message, or null
 *  when none is present yet (treated as still-pending). */
export function parseVerdict(text: string): ReviewVerdict | null {
  const m = text.match(/```octo-review-verdict\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].trim());
    return { blocking: !!j.blocking, summary: typeof j.summary === "string" ? j.summary : "" };
  } catch {
    return null;
  }
}

/** The review agent's machine-readable conclusion. `blocking` gates QA: while any
 *  session's verdict is blocking (or still pending), the orchestrator isn't asked
 *  to offer QA. Filled by {@link parseVerdict} (Phase 4). */
export interface ReviewVerdict {
  blocking: boolean;
  summary: string;
}

export interface ReviewSnapshot {
  /** True once a review agent has been started for this session (drives the
   *  Coding⇄Review switch's visibility). */
  active: boolean;
  /** A turn is in flight. */
  busy: boolean;
  /** The conversation feed (assistant text + tool calls). */
  blocks: Block[];
  /** The orchestrator task context this review is anchored to — shown pinned at
   *  the top of the Review view (2-line, expandable). */
  contextPrompt: string;
  /** When the current/last review turn started (for the "Reviewer Active…" pulse
   *  + elapsed timer). */
  startedAt: number | null;
  /** Parsed verdict once the agent finishes a pass (null until then). */
  verdict: ReviewVerdict | null;
}

/** Aggregate state across every session's review agent — the event-driven signal
 *  that decides when the orchestrator may offer QA. */
export interface ReviewAggregate {
  /** At least one session has a review in progress or concluded. */
  anyActive: boolean;
  /** Sessions whose verdict is blocking (their one-line summaries). */
  blocking: string[];
  /** Active reviews still running or without a parsed verdict. */
  pending: number;
  /** All active reviews are idle AND every one is non-blocking → offer QA now. */
  readyForQa: boolean;
}

/** Fold every session's review snapshot into the QA-gating decision. */
export function aggregateReviews(snaps: ReviewSnapshot[]): ReviewAggregate {
  const active = snaps.filter((s) => s.active);
  const anyActive = active.length > 0;
  const blocking = active.filter((s) => s.verdict?.blocking).map((s) => s.verdict!.summary || "(blocking)");
  const pending = active.filter((s) => s.busy || !s.verdict).length;
  const readyForQa = anyActive && pending === 0 && blocking.length === 0;
  return { anyActive, blocking, pending, readyForQa };
}

const EMPTY: ReviewSnapshot = {
  active: false,
  busy: false,
  blocks: [],
  contextPrompt: "",
  startedAt: null,
  verdict: null,
};

export class ReviewAgentController {
  /** Event id for this session's review stream — namespaced so it never collides
   *  with the coding agent's `sessionId`. */
  private readonly reviewId: string;
  private provider: AgentProvider = "claude";
  private model: string | null = null;
  private cwd = "";

  private blocks: Block[] = [];
  private active = false;
  private busy = false;
  private contextPrompt = "";
  private startedAt: number | null = null;
  private verdict: ReviewVerdict | null = null;

  private agentSessionId: string | null = null; // for resume across replies
  private streamingTextId: string | null = null;
  private readonly agentTools = new Map<string, string>(); // tool_use id → block id

  private snapshot: ReviewSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private unlisten: UnlistenFn[] = [];
  private wired = false;

  constructor(sessionId: string) {
    this.reviewId = `review:${sessionId}`;
  }

  getSnapshot = (): ReviewSnapshot => this.snapshot;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  /** Lazily wire the backend event stream — only once a review actually starts, so
   *  idle sessions don't each hold a global listener. */
  private async wire(): Promise<void> {
    if (this.wired) return;
    this.wired = true;
    this.unlisten.push(
      await listen<{ id: string; data: string }>("agent://event", (e) => {
        if (e.payload.id === this.reviewId) this.onEvent(e.payload.data);
      }),
    );
    this.unlisten.push(
      await listen<{ id: string; code: number; error?: string }>("agent://done", (e) => {
        if (e.payload.id === this.reviewId) this.onDone(e.payload.error, e.payload.code);
      }),
    );
  }

  /** Kick off (or restart) the review: the orchestrator task context + the coding
   *  agent's diff become the first prompt. Called by the lifecycle wiring (Phase 3). */
  async start(opts: { contextPrompt: string; prompt: string; cwd: string }): Promise<void> {
    await this.wire();
    const ra = settingsStore.getSnapshot().reviewAgent;
    this.provider = ra.provider;
    this.model = ra.model;
    this.cwd = opts.cwd;
    this.contextPrompt = opts.contextPrompt;

    // Fresh pass: clear the prior conversation & verdict.
    this.blocks = [];
    this.agentTools.clear();
    this.streamingTextId = null;
    this.agentSessionId = null;
    this.verdict = null;
    this.active = true;

    this.pushUser(opts.prompt);
    this.send(opts.prompt, null);
  }

  /** A user reply from the Review view — continues the review conversation. */
  reply(text: string): void {
    const t = text.trim();
    if (!t || this.busy || !this.active) return;
    this.pushUser(t);
    this.verdict = null; // a reply re-opens the question
    this.send(t, this.agentSessionId);
  }

  cancel(): void {
    if (!this.active) return;
    const cmd = isAcp(this.provider) ? "acp_cancel" : "agent_cancel";
    invoke(cmd, { id: this.reviewId }).catch(() => {});
    this.busy = false;
    this.emit();
  }

  private pushUser(text: string): void {
    this.blocks.push({ id: crypto.randomUUID(), kind: "agentText", role: "user", text, startedAt: Date.now() });
    this.streamingTextId = null;
  }

  private send(prompt: string, resume: string | null): void {
    this.busy = true;
    this.startedAt = Date.now();
    this.streamingTextId = null;
    this.emit();

    if (isAcp(this.provider)) {
      const sandbox = acpSandboxCommandFor(this.provider, this.model);
      void prepareOpencodeConfig(this.provider, settingsStore.getSnapshot().ollama).then((cfg) => {
        invoke("acp_send", {
          id: this.reviewId,
          prompt,
          cwd: this.cwd,
          command: acpCommandFor(this.provider, this.model, { opencodeConfig: cfg }),
          sandboxImage: sandbox?.image ?? null,
          sandboxCommand: sandbox?.command ?? null,
        }).catch((err) => this.onDone(String(err)));
      });
      return;
    }
    invoke("agent_send", {
      id: this.reviewId,
      prompt,
      cwd: this.cwd,
      resume,
      model: this.model,
      provider: this.provider,
      approval: false, // the review agent reads/diffs — no per-tool approval gate
      configDir: null,
    }).catch((err) => this.onDone(String(err)));
  }

  private onEvent(data: string): void {
    const events = parseAgentLine(this.provider, data);
    if (!events.length) return;
    const now = Date.now();
    for (const e of events) {
      if (e.session) {
        this.agentSessionId = e.session;
      } else if (e.text !== undefined) {
        const open = this.blocks.find((b) => b.id === this.streamingTextId);
        if (e.delta && open && open.kind === "agentText") {
          open.text += e.text;
        } else {
          const id = crypto.randomUUID();
          this.streamingTextId = e.delta ? id : null;
          this.blocks.push({ id, kind: "agentText", role: "assistant", text: e.text, startedAt: now, provider: this.provider });
        }
      } else if (e.tool) {
        this.streamingTextId = null;
        const id = crypto.randomUUID();
        this.agentTools.set(e.tool.id, id);
        this.blocks.push({ id, kind: "agentTool", toolName: e.tool.name, toolInput: e.tool.input, status: "running", startedAt: now });
      } else if (e.result) {
        const block = this.blocks.find((b) => b.id === this.agentTools.get(e.result!.id));
        if (block && block.kind === "agentTool") {
          block.result = e.result.content;
          block.isError = e.result.isError;
          block.status = e.result.isError ? "error" : "success";
        }
      }
      // usage/context/steps are irrelevant to the review feed → ignored.
    }
    this.emit();
  }

  private onDone(error?: string, code = 0): void {
    this.busy = false;
    this.streamingTextId = null;
    if (error && code !== 0) {
      this.blocks.push({
        id: crypto.randomUUID(),
        kind: "agentText",
        role: "assistant",
        text: `⚠️ Review agent error: ${error}`,
        startedAt: Date.now(),
        provider: this.provider,
      });
    } else {
      // Parse the machine-readable verdict from the agent's final message (Phase 4).
      this.verdict = this.parseVerdict();
    }
    this.emit();
  }

  /** The latest assistant text in the feed (the review agent's conclusion). */
  private lastAssistantText(): string {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "agentText" && b.role === "assistant") return b.text;
    }
    return "";
  }

  /** Parse the review agent's structured verdict from its final message. */
  private parseVerdict(): ReviewVerdict | null {
    return parseVerdict(this.lastAssistantText());
  }

  private emit(): void {
    this.snapshot = {
      active: this.active,
      busy: this.busy,
      blocks: [...this.blocks],
      contextPrompt: this.contextPrompt,
      startedAt: this.startedAt,
      verdict: this.verdict,
    };
    this.listeners.forEach((l) => l());
  }

  dispose(): void {
    this.cancel();
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    this.listeners.clear();
  }
}
