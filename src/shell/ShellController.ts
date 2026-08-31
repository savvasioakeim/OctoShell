import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ansiToHtml, stripAnsi } from "../util/ansi";
import { KEY, loadJSON, removeKey, saveJSON } from "../util/persist";
import { deleteBlocksDb, loadBlocksDb, saveBlocksDb } from "../util/db";
import { notify } from "../util/notify";
import { playSfx } from "../util/sfx";
import { acpCommandFor, acpSandboxCommandFor, isAcp, normalizeProvider, parseAgentLine, prepareOpencodeConfig, type AgentProvider, type AgentStep } from "../agents/providers";
import { settingsStore } from "../settings/settingsStore";
import { ReviewAgentController, buildReviewPrompt, fetchReviewOverview } from "../review/ReviewAgentController";

/** Keep at most this many historical blocks per session in storage. */
const MAX_PERSISTED_BLOCKS = 80;

/** The CLI's native task-tracker tools (this build's replacement for TodoWrite).
 *  Their calls drive the trace progress bar and are hidden from the feed. */
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

/** Injected on every Claude turn so the app gets a reliable task-step signal: the
 *  agent breaks the task into an ordered task list (TaskCreate) up front and keeps
 *  it updated (TaskUpdate) as it goes. OctoShell renders that as the trace bar. */
const STEP_PROTOCOL = [
  "<<OCTOSHELL TASK STEPS — MANDATORY>>",
  "This applies to EVERY task you are given (typed directly or dispatched by the orchestrator), including ones already phrased as \"do these steps\".",
  "1. Before doing anything else, use the TaskCreate tool to lay out the task as a short ordered list of concrete, user-meaningful steps (aim for 3–7) — one TaskCreate call per step. Do this even if the task looks simple or sequential — do NOT just describe the steps in prose.",
  "2. Use TaskUpdate to mark EXACTLY ONE step `in_progress` at a time. The moment a step is finished, immediately call TaskUpdate to set it `completed` and the next one `in_progress`.",
  "3. Phrase each step's subject as a short outcome (e.g. \"Create todo.txt\", \"Write the tests\"), not internal chatter.",
  "This task list is the ONLY thing that drives the user's live progress bar, so it must exist and stay accurate from the first action to the last.",
  "<</OCTOSHELL TASK STEPS>>",
].join("\n");

// The ACP equivalent: ACP agents don't have OctoShell's TaskCreate/TaskUpdate
// tools — they expose their OWN planning/todo tool, which the adapter forwards to
// us as ACP `plan` session updates (parseAcp → e.steps → the trace bar). So we ask
// for a plan in tool-agnostic terms; the agent's native plan tool then lights the
// same trace bar / nodes / percentage the native path drives.
const ACP_STEP_PROTOCOL = [
  "<<OCTOSHELL TASK STEPS — MANDATORY>>",
  "This applies to EVERY task you are given (typed directly or dispatched by the orchestrator), including ones already phrased as \"do these steps\".",
  "1. Before doing anything else, use your planning / todo tool to lay out the task as a short ordered list of concrete, user-meaningful steps (aim for 3–7). Do this even if the task looks simple or sequential — do NOT just describe the steps in prose.",
  "2. Keep that plan updated as you work: exactly ONE step in-progress at a time, and mark each step completed the moment it's done, before starting the next.",
  "3. Phrase each step's subject as a short outcome (e.g. \"Create todo.txt\", \"Write the tests\"), not internal chatter.",
  "This plan is the ONLY thing that drives the user's live progress bar, so it must exist and stay accurate from the first action to the last.",
  "<</OCTOSHELL TASK STEPS>>",
].join("\n");

export type BlockStatus = "running" | "success" | "error";

/** Input routing: a typed line either runs in the shell or is sent to the agent. */
export type Mode = "shell" | "agent";

/** A control marker sent (as JSON) over the PTY stream channel, interleaved in
 *  order with the raw output bytes. */
type PtyControl =
  | { t: "end"; code: number }
  | { t: "cwd"; cwd: string }
  | { t: "ready" };

interface BaseBlock {
  id: string;
  startedAt: number;
}

/** A shell command and its output, delimited by OSC 133 markers. */
export interface CommandBlock extends BaseBlock {
  kind: "command";
  command: string;
  status: BlockStatus;
  exitCode?: number;
  cwd: string;
  /** Set once the command finishes: colored, selectable HTML of the output. */
  frozenHtml?: string;
  /** Plain-text output, for "Copy Output" and AI context. */
  outputText: string;
}

/** One message in an agent turn — the user's prompt or an assistant reply. */
export interface AgentTextBlock extends BaseBlock {
  kind: "agentText";
  role: "user" | "assistant";
  text: string;
  /** Which agent produced this (assistant messages) — for the block header. */
  provider?: AgentProvider;
  /** Where a user message came from, when it wasn't typed here. Recorded so a
   *  task that arrived over the network is never indistinguishable from one the
   *  person at the keyboard typed. */
  via?: "phone";
}

/** One tool the agent invoked (e.g. a Bash command) and its result. */
export interface AgentToolBlock extends BaseBlock {
  kind: "agentTool";
  toolName: string;
  /** Human-readable input: the command for Bash, else pretty-printed JSON. */
  toolInput: string;
  status: BlockStatus; // running until the tool_result arrives
  result?: string;
  isError?: boolean;
}

/** A pending (or resolved) per-tool approval the agent is waiting on. */
export interface AgentApprovalBlock extends BaseBlock {
  kind: "agentApproval";
  requestId: string;
  toolName: string;
  /** Human-readable: the command for Bash, else pretty JSON. */
  toolInput: string;
  status: "pending" | "approved" | "denied";
}

export type Block = CommandBlock | AgentTextBlock | AgentToolBlock | AgentApprovalBlock;

export function isCommandBlock(b: Block): b is CommandBlock {
  return b.kind === "command";
}

export interface ShellSnapshot {
  blocks: Block[];
  cwd: string;
  busy: boolean;
  input: string;
  /** Current input routing. */
  mode: Mode;
  /** An agent turn is in flight. */
  agentBusy: boolean;
  /** The in-flight agent turn was dispatched by the orchestrator (not the user),
   *  so the board lights up the whole tentacle route to this agent. */
  agentOrchestrated: boolean;
  /** Selected agent model (null = CLI default), applied from the next turn. */
  agentModel: string | null;
  /** Which agent CLI drives this project. */
  agentProvider: AgentProvider;
  /** Selected Claude Code profile dir for this agent (null = home default). */
  agentConfigDir: string | null;
  /** Per-tool approval mode (Claude only): the agent asks before sensitive tools. */
  agentApproval: boolean;
  /** True while ≥1 approval request is pending the user's decision. */
  agentNeedsInput: boolean;
  /** Cumulative token usage for this session's agent (null until first turn ends
   *  or if the provider doesn't report it). */
  agentTokens: { input: number; output: number; costUsd: number } | null;
  /** Latest context-window occupancy (used / window), for the usage meter. */
  agentContext: { used: number; window: number } | null;
  /** The CLI conversation the next turn would resume into — null means the next
   *  prompt starts a fresh context window. Exposed so the UI can offer (and only
   *  offer) a reset when there is actually something to reset. */
  agentSessionId: string | null;
  /** Task progress from the agent's todo list (TodoWrite): the ordered planned
   *  steps with status. Null until the agent writes a plan. Drives the trace bar. */
  agentProgress: AgentStep[] | null;
  /** True when the agent bills per-token (API key) → cost is shown. On a
   *  subscription it's false and cost is hidden. */
  agentApiKey: boolean;
  /** Epoch seconds when the subscription rate-limit (5h) window resets, or null. */
  agentRateReset: number | null;
  /** True while the running command is in the terminal's alternate screen
   *  buffer (vim, htop, less, a REPL, `git rebase -i`…). The running block then
   *  becomes a full interactive terminal. */
  altScreen: boolean;
  /** True when the live terminal holds keyboard focus — i.e. the user is typing
   *  directly into the running command (claude, a prompt, a REPL). */
  interacting: boolean;
  /** True once the user has actually worked in this project THIS session (ran a
   *  command or an agent). Restored history does NOT set it — a project you
   *  haven't touched since opening the app stays "untouched", so background work
   *  (git polling, PR checks) can skip the projects you're not using. */
  touched: boolean;
}

const MAX_ROWS = 24;

/**
 * Owns one PTY session and renders the "feed" of semantic blocks.
 *
 * Rendering strategy: a SINGLE shared WebGL xterm renders whichever command is
 * currently running. When the command finishes we serialize the buffer to
 * selectable HTML (via {@link ansiToHtml}) and hand the live terminal back to a
 * hidden host for reuse. This keeps exactly one WebGL context alive regardless
 * of how many blocks the feed contains, and makes finished output selectable
 * like a text editor.
 *
 * It is framework-agnostic: it exposes a `subscribe`/`getSnapshot` store that
 * React consumes via `useSyncExternalStore`.
 */
export class ShellController {
  /** Set by the host to route "Ask AI about this" clicks. */
  onAskAi: (block: CommandBlock) => void = () => {};

  /** Set by the host (AiSidebar): the user pressed Stop on this agent, so it must
   *  be dropped from the orchestrator's live-watch set — otherwise the busy→idle
   *  edge from the cancel would re-trigger a continuation and re-drive it. */
  onUserStopped: () => void = () => {};

  /** Human-readable project name, set by the host (used in notifications). */
  displayName = "";

  private liveTerm: Terminal;
  private fit: FitAddon;
  private serializer: SerializeAddon;
  private liveHost: HTMLDivElement;

  private blocks: Block[] = [];
  private current: CommandBlock | null = null;
  private cwd = "";
  private busy = false;
  private inputValue = "";
  private altScreen = false;
  private interacting = false;
  /** Set once the user runs a command/agent here this session (see snapshot). */
  private touched = false;

  // ---- agent state ----
  private mode: Mode = "shell";
  private agentBusy = false;
  /** Set when the current turn was started by the orchestrator. */
  private agentOrchestrated = false;
  /** A user prompt typed while a turn was in flight: we cancel the running turn
   *  and run this one once it ends (so the user can always take over the agent,
   *  without two concurrent turns racing the backend). */
  private pendingUserPrompt: string | null = null;
  /** claude session id, for `--resume` across turns. */
  private agentSessionId: string | null = null;
  /** The last prompt sent to the agent — replayed if a `--resume` turns out stale. */
  private lastAgentPrompt: string | null = null;
  /** Guards the one-shot fresh-session retry so a real failure can't loop. */
  private resumeRetried = false;
  /** Selected model for this project's agent (null = CLI default). Applies from
   *  the NEXT turn — `claude --model` can't change a turn already in flight. */
  private agentModel: string | null = null;
  /** Which agent CLI drives this project (claude / gemini). */
  private agentProvider: AgentProvider = "claude";
  /** Claude Code profile (CLAUDE_CONFIG_DIR) for this project's agent; null = home. */
  private agentConfigDir: string | null = null;
  /** Per-tool approval mode (Claude only). */
  private agentApproval = false;
  /** Running token total for this session's agent (null = none reported yet). */
  private agentTokens: { input: number; output: number; costUsd: number } | null = null;
  /** Latest context-window occupancy reported by the agent. */
  private agentContext: { used: number; window: number } | null = null;
  /** Latest task progress from the agent's todo list (null until it plans). */
  private agentProgress: AgentStep[] | null = null;
  // Task progress, accumulated from the CLI's TaskCreate/TaskUpdate tool calls
  // (kept across turns — the task list is per-session). We deliberately DON'T map a
  // TaskUpdate's `taskId` back to a specific created task: the CLI's ids aren't
  // guaranteed to start at 1 (a resumed session continues an earlier counter), so
  // any id→index guess breaks. Instead we count: N created = N steps, and the
  // number of distinct ids marked `completed` = how many are done. Accurate for the
  // common in-order case, and robust to whatever ids the CLI hands out.
  /** Step subjects in creation order (one per TaskCreate). */
  private agentTaskTexts: string[] = [];
  /** Latest status seen per TaskUpdate id — deduped, so counts don't double up. */
  private agentTaskStatus = new Map<string, AgentStep["status"]>();
  /** Whether the agent bills per-token (API key) vs. a subscription. */
  private agentApiKey = false;
  /** Epoch seconds of the next subscription rate-limit reset (account-wide). */
  private agentRateReset: number | null = null;
  /** Maps a tool_use id to the AgentToolBlock id, so its result can update it. */
  private agentTools = new Map<string, string>();
  /** The currently-open assistant text block id, so streaming deltas (gemini)
   *  append to it instead of creating a block per chunk. */
  private streamingTextId: string | null = null;

  private rowHeightPx = 17;
  private resizeQueued = false;
  private unlisteners: UnlistenFn[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Height is monotonic within a command (high-water mark) so an interactive TUI
  // that moves the cursor up to redraw (claude, npm prompts, spinners) doesn't
  // make the block oscillate/flicker. Reset on each new command.
  private hwmRows = 1;
  // Width (cols) is PINNED for a command's whole lifetime. Changing cols while a
  // command streams makes xterm/ConPTY reflow already-printed lines — which
  // garbles tabular output (e.g. `ls`/Get-ChildItem): columns merge, rows
  // duplicate/reorder. We measure once at first output and hold it until the
  // command finishes. 0 = not yet pinned.
  private lockedCols = 0;
  // Last size reported to the PTY — avoids redundant resizes (each one makes the
  // child app redraw, which itself causes flicker).
  private lastRows = 0;
  private lastCols = 0;

  // ---- external store ----
  private listeners = new Set<() => void>();
  private snapshot: ShellSnapshot = {
    blocks: [],
    cwd: "",
    busy: false,
    input: "",
    altScreen: false,
    interacting: false,
    touched: false,
    mode: "shell",
    agentBusy: false,
    agentOrchestrated: false,
    agentModel: null,
    agentProvider: "claude",
    agentConfigDir: null,
    agentApproval: false,
    agentNeedsInput: false,
    agentTokens: null,
    agentContext: null,
    agentSessionId: null,
    agentProgress: null,
    agentApiKey: false,
    agentRateReset: null,
  };

  /** This session's automated review agent (own conversation; see option β). Idle
   *  until a coding turn dispatched by the orchestrator completes with the review
   *  agent enabled in Settings. */
  readonly review: ReviewAgentController;

  constructor(public readonly sessionId: string) {
    this.review = new ReviewAgentController(sessionId);
    // A hidden, off-screen home for the live terminal between commands.
    this.liveHost = document.createElement("div");
    this.liveHost.style.cssText = "position:absolute;left:-99999px;top:0;width:900px;height:400px;";
    document.body.appendChild(this.liveHost);

    const fontStack = (family: string) =>
      family
        ? `${JSON.stringify(family)}, JetBrains Mono, Cascadia Code, Consolas, monospace`
        : "JetBrains Mono, Cascadia Code, Consolas, monospace";
    const font = fontStack(settingsStore.getSnapshot().appearance.fontFamily);
    // Live-apply font changes from Settings to this (long-lived) terminal too —
    // otherwise the picker only visibly affects frozen blocks until a new
    // terminal is opened, which reads as "the setting does nothing".
    settingsStore.subscribe(() => {
      const next = fontStack(settingsStore.getSnapshot().appearance.fontFamily);
      if (this.liveTerm && this.liveTerm.options.fontFamily !== next) {
        this.liveTerm.options.fontFamily = next;
      }
    });
    this.liveTerm = new Terminal({
      fontFamily: font,
      fontSize: 15,
      scrollback: settingsStore.getSnapshot().system.scrollback,
      cursorBlink: false, // enabled only while focused/alt-screen (saves idle repaints)
      allowProposedApi: true,
      theme: { background: "#15181F", foreground: "#A6ACCD" }, // matches `card`
    });
    this.fit = new FitAddon();
    this.serializer = new SerializeAddon();
    this.liveTerm.loadAddon(this.fit);
    this.liveTerm.loadAddon(this.serializer);
    this.liveTerm.open(this.liveHost);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.liveTerm.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL unavailable, falling back to canvas:", e);
    }

    // Route everything xterm produces (interactive keystrokes when focused, plus
    // automatic device-status replies) straight to the running command's stdin.
    // In normal block mode xterm is never focused, so this only carries the
    // occasional terminal query reply; in alt-screen mode it carries the user's
    // full-screen-app keyboard input.
    this.liveTerm.onData((d) => this.sendRaw(d));

    // Copy-on-select for the live terminal: in the running command's terminal
    // Ctrl+C interrupts (it can't also mean "copy"), so there's otherwise no way
    // to copy output — e.g. an auth URL a CLI prints during an interactive login.
    // Whenever there's a non-empty selection, mirror it to the clipboard. (Paste
    // works already: Ctrl+V fires a browser paste that xterm forwards to stdin.)
    this.liveTerm.onSelectionChange(() => {
      const sel = this.liveTerm.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });

    // Detect entry/exit of the alternate screen buffer (vim/htop/less/REPLs).
    this.liveTerm.buffer.onBufferChange(() => this.onBufferChange());

    // Track keyboard focus on the live terminal so the UI can show where typing
    // goes (the running command vs. the new-command input).
    const ta = this.liveTerm.textarea;
    if (ta) {
      ta.addEventListener("focus", () => this.setInteracting(true));
      ta.addEventListener("blur", () => this.setInteracting(false));
    }

    this.measureRowHeight();
  }

  private setInteracting(v: boolean): void {
    if (v === this.interacting) return;
    this.interacting = v;
    this.liveTerm.options.cursorBlink = v || this.altScreen; // blink only when in use
    this.emit();
  }

  /** Give keyboard focus to the running command's terminal (click-to-type). */
  focusLive(): void {
    if (this.current) this.liveTerm.focus();
  }

  private onBufferChange(): void {
    const alt = this.liveTerm.buffer.active.type === "alternate";
    if (alt === this.altScreen) return;
    this.altScreen = alt;
    this.liveTerm.options.cursorBlink = alt || this.interacting;
    if (alt) this.liveTerm.focus(); // hand the keyboard to the full-screen app
    this.scheduleResize();
    this.emit();
  }

  // ---- store API (for useSyncExternalStore) ----
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): ShellSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = {
      blocks: [...this.blocks],
      cwd: this.cwd,
      busy: this.busy,
      input: this.inputValue,
      altScreen: this.altScreen,
      interacting: this.interacting,
      touched: this.touched,
      mode: this.mode,
      agentBusy: this.agentBusy,
      agentOrchestrated: this.agentOrchestrated,
      agentModel: this.agentModel,
      agentProvider: this.agentProvider,
      agentConfigDir: this.agentConfigDir,
      agentApproval: this.agentApproval,
      agentNeedsInput: this.blocks.some((b) => b.kind === "agentApproval" && b.status === "pending"),
      agentTokens: this.agentTokens,
      agentContext: this.agentContext,
      agentSessionId: this.agentSessionId,
      agentProgress: this.agentProgress,
      agentApiKey: this.agentApiKey,
      agentRateReset: this.agentRateReset,
    };
    this.listeners.forEach((l) => l());
    this.scheduleSave();
  }

  /** Wire PTY events and spawn the shell. Call once before first render. */
  async init(cwd = ""): Promise<void> {
    // Seed the cwd from the caller instead of waiting for the shell's first OSC 7
    // report: a freshly created worktree can be dispatched to before the prompt
    // renders, and an empty cwd reaches the ACP adapter as "." — which claude/codex
    // reject ("cwd must be an absolute path"), killing the turn before it starts.
    if (cwd) this.cwd = cwd;
    // One channel carries everything for this session, IN ORDER: raw output
    // bytes (ArrayBuffer) on the hot path — no base64 — and the control markers
    // (JSON objects) that delimit commands. Routing them together means a
    // command-end can never overtake the output bytes it follows.
    const stream = new Channel<ArrayBuffer | PtyControl>();
    stream.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) {
        this.onOutput(new Uint8Array(msg));
        return;
      }
      switch (msg.t) {
        case "end":
          this.finishCurrent(msg.code ?? 0);
          break;
        case "cwd":
          this.cwd = msg.cwd ?? this.cwd;
          this.emit();
          break;
        case "ready":
          this.busy = false;
          this.emit();
          break;
      }
    };

    this.unlisteners.push(
      await listen<{ id: string; data: string }>("agent://event", (e) => {
        if (e.payload.id === this.sessionId) this.onAgentEvent(e.payload.data);
      }),
      await listen<{ id: string; code: number; error?: string }>("agent://done", (e) => {
        if (e.payload.id === this.sessionId) this.onAgentDone(e.payload.error, e.payload.code);
      }),
      await listen<{ id: string; requestId: string; toolName: string; input: unknown; toolUseId: string }>(
        "approval://request",
        (e) => {
          if (e.payload.id === this.sessionId) this.onApprovalRequest(e.payload);
        },
      ),
    );
    await invoke("open_new_tab", {
      id: this.sessionId,
      cwd,
      shell: settingsStore.getSnapshot().workspace.defaultShell,
      onOutput: stream,
    });
    this.hydrate();
  }

  /** Restore persisted agent prefs (sync, small) + history (async, from SQLite).
   *  Anything this session never explicitly set falls back to the workspace
   *  agent defaults (Settings), so new agents start on the configured account. */
  private hydrate(): void {
    const d = settingsStore.getSnapshot().agent;
    this.agentSessionId = loadJSON<string | null>(KEY.agent(this.sessionId), null);
    this.agentModel = loadJSON<string | null>(KEY.model(this.sessionId), d.model);
    // normalizeProvider migrates the legacy "acp" id and guards against any
    // stale/unknown persisted value (which would otherwise crash the picker).
    this.agentProvider = normalizeProvider(loadJSON(KEY.provider(this.sessionId), d.provider));
    this.agentConfigDir = loadJSON<string | null>(KEY.agentCfgDir(this.sessionId), settingsStore.configDirFor(d.profileId));
    this.agentApproval = loadJSON<boolean>(KEY.approval(this.sessionId), false);
    if (this.agentSessionId || this.agentModel || this.agentConfigDir) this.emit();
    void this.hydrateBlocks();
  }

  /** Load settled history from SQLite, migrating any old localStorage history. */
  private async hydrateBlocks(): Promise<void> {
    let saved: Block[] | null = null;
    const data = await loadBlocksDb(this.sessionId);
    if (data) {
      try { saved = JSON.parse(data) as Block[]; } catch { saved = null; }
    } else {
      // One-time migration: copy the old localStorage history into SQLite, and
      // only drop the localStorage copy once SQLite confirms the write — so a
      // broken SQLite can never lose existing history.
      const legacy = loadJSON<Block[]>(KEY.blocks(this.sessionId), []);
      if (legacy.length) {
        saved = legacy;
        void saveBlocksDb(this.sessionId, JSON.stringify(legacy), Date.now()).then((ok) => {
          if (ok) removeKey(KEY.blocks(this.sessionId));
        });
      }
    }
    // Apply only if nothing has happened yet, so we never clobber a live block
    // the user started during the brief async load.
    if (saved && saved.length && this.blocks.length === 0) {
      this.blocks = saved;
      this.emit();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
  }

  /** History safe to store: nothing still in flight, capped to the newest N. */
  private settledBlocks(): Block[] {
    return this.blocks
      .filter(
        (b) =>
          !((b.kind === "command" || b.kind === "agentTool") && b.status === "running") &&
          !(b.kind === "agentApproval" && b.status === "pending"),
      )
      .slice(-MAX_PERSISTED_BLOCKS);
  }

  private persist(): void {
    // Blocks → SQLite (async, off the UI thread). Prefs → localStorage.
    void saveBlocksDb(this.sessionId, JSON.stringify(this.settledBlocks()), Date.now());
    saveJSON(KEY.agent(this.sessionId), this.agentSessionId);
    saveJSON(KEY.model(this.sessionId), this.agentModel);
    saveJSON(KEY.provider(this.sessionId), this.agentProvider);
    saveJSON(KEY.agentCfgDir(this.sessionId), this.agentConfigDir);
    saveJSON(KEY.approval(this.sessionId), this.agentApproval);
  }

  /** Toggle per-tool approval (Claude only): asks before sensitive tools. */
  setAgentApproval(on: boolean): void {
    this.agentApproval = on;
    saveJSON(KEY.approval(this.sessionId), on);
    this.emit();
  }

  /** A pending tool-approval arrived from the agent — show it for a decision. */
  private onApprovalRequest(p: { requestId: string; toolName: string; input: unknown }): void {
    const inp = p.input as { command?: string } | undefined;
    const toolInput =
      p.toolName === "Bash" && typeof inp?.command === "string"
        ? inp.command
        : JSON.stringify(p.input ?? {}, null, 2);
    this.blocks.push({
      id: crypto.randomUUID(),
      kind: "agentApproval",
      requestId: p.requestId,
      toolName: p.toolName,
      toolInput,
      status: "pending",
      startedAt: Date.now(),
    });
    this.emit();
    const where = this.displayName || "OctoShell";
    notify(`🛡 ${where}: the agent needs approval`, `${p.toolName} — waiting for your ✓`);
  }

  /** Send the user's approve/deny decision back to the waiting agent. */
  respondApproval(requestId: string, allow: boolean): void {
    const block = this.blocks.find(
      (b) => b.kind === "agentApproval" && b.requestId === requestId,
    );
    if (block && block.kind === "agentApproval") {
      block.status = allow ? "approved" : "denied";
    }
    invoke("approval_respond", { requestId, allow }).catch(console.error);
    this.emit();
  }

  /** Choose the model for this project's agent (null = CLI default). */
  setAgentModel(model: string | null): void {
    this.agentModel = model;
    saveJSON(KEY.model(this.sessionId), model);
    // ACP bakes the model into the adapter at spawn and reuses the session across
    // prompts, so a running adapter must be torn down for the new model to apply.
    if (isAcp(this.agentProvider)) this.resetAcpSession();
    this.emit();
  }

  /** End any running ACP adapter for this session so the next prompt respawns
   *  with the current provider/model. No-op if none is running. */
  private resetAcpSession(): void {
    invoke("acp_cancel", { id: this.sessionId }).catch(() => {});
  }

  /** Choose the Claude Code profile (account config dir) for this project's agent.
   *  Applies from the NEXT turn; null = home default. A stale resume under the new
   *  account is recovered automatically (see onAgentDone). */
  setAgentConfigDir(configDir: string | null): void {
    if (configDir === this.agentConfigDir) return;
    this.agentConfigDir = configDir;
    // Switching accounts invalidates the old session — start fresh next turn.
    this.agentSessionId = null;
    saveJSON(KEY.agentCfgDir(this.sessionId), configDir);
    saveJSON(KEY.agent(this.sessionId), null);
    this.emit();
  }

  /** Switch the agent CLI (claude ↔ gemini). Resets the session id since a
   *  session can't carry across providers; the next turn starts fresh. */
  setAgentProvider(provider: AgentProvider): void {
    if (provider === this.agentProvider) return;
    // Tear down a running ACP adapter before switching, or the next prompt would
    // hit the OLD agent (backend keys sessions by id, not provider).
    if (isAcp(this.agentProvider)) this.resetAcpSession();
    this.agentProvider = provider;
    this.agentSessionId = null;
    this.agentModel = null; // model names are provider-specific
    this.agentTokens = null; // usage resets with the session
    this.agentContext = null;
    saveJSON(KEY.provider(this.sessionId), provider);
    saveJSON(KEY.agent(this.sessionId), null);
    saveJSON(KEY.model(this.sessionId), null);
    this.emit();
  }

  /** Forget this session's persisted history (e.g. when the project is closed). */
  forget(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    void deleteBlocksDb(this.sessionId);
    removeKey(KEY.blocks(this.sessionId)); // legacy localStorage history, if any
    removeKey(KEY.agent(this.sessionId));
    removeKey(KEY.model(this.sessionId));
    removeKey(KEY.provider(this.sessionId));
    removeKey(KEY.agentCfgDir(this.sessionId));
    removeKey(KEY.approval(this.sessionId));
  }

  /** Start the agent's next turn from an EMPTY context window.
   *
   *  The CLI keeps one long conversation per session and we resume into it, so an
   *  agent on a base branch can carry knowledge from days ago — after which the
   *  branch has moved on and half of what it "knows" is quietly wrong. Dropping
   *  the session id makes the next prompt a fresh conversation that re-reads the
   *  repo instead of trusting its memory of it.
   *
   *  The visible feed and the SQLite history are deliberately untouched: what the
   *  USER can scroll back to is a separate thing from what the MODEL carries. */
  newAgentSession(): void {
    if (this.agentBusy) return; // never cut a running turn's session out from under it
    // An ACP adapter holds the conversation in its own process, so the id alone
    // isn't the session — the adapter has to go too, or the next prompt lands in
    // the old context regardless.
    if (isAcp(this.agentProvider)) this.resetAcpSession();
    this.agentSessionId = null;
    this.agentTokens = null;
    this.agentContext = null;
    this.resumeRetried = false;
    saveJSON(KEY.agent(this.sessionId), null);
    this.blocks.push({
      id: crypto.randomUUID(),
      kind: "agentText",
      role: "assistant",
      text: "🧠 New agent session — the next task starts with an empty context window.",
      startedAt: Date.now(),
    });
    this.emit();
  }

  /** Clear the visible feed (keeps the agent conversation thread alive). */
  clear(): void {
    if (this.busy || this.agentBusy) return; // don't drop a running block
    this.blocks = [];
    this.current = null;
    this.emit();
  }

  // ---- command lifecycle ----

  submit(command: string): void {
    const cmd = command.trimEnd();
    if (!cmd) return;
    this.touched = true;

    const block: CommandBlock = {
      id: crypto.randomUUID(),
      kind: "command",
      command: cmd,
      startedAt: Date.now(),
      status: "running",
      cwd: this.cwd,
      outputText: "",
    };
    this.blocks.push(block);
    this.current = block;
    this.busy = true;
    this.inputValue = "";
    this.hwmRows = 1; // fresh high-water mark for this command
    this.lockedCols = 0; // re-measure width once for this command, then hold it
    this.liveTerm.clear();
    this.emit();

    invoke("write_to_terminal", { id: this.sessionId, input: cmd + "\r" }).catch(console.error);
  }

  /** React attaches the running block's content host here (callback ref). */
  attachLiveHost(blockId: string, el: HTMLElement | null): void {
    if (!el) {
      // Block unmounted (e.g. tab switch): park the live term off-screen so it
      // keeps rendering. It re-attaches when the block remounts.
      if (this.liveTerm.element) this.liveHost.appendChild(this.liveTerm.element);
      return;
    }
    if (!this.current || this.current.id !== blockId) return;
    el.appendChild(this.liveTerm.element!);
    this.scheduleResize();
    // NOTE: do NOT focus the xterm — typing happens in the InputBar, so focus
    // must stay there.
  }

  /** Send raw bytes to the running command's stdin (e.g. answering a prompt). */
  sendRaw(data: string): void {
    invoke("write_to_terminal", { id: this.sessionId, input: data }).catch(console.error);
  }

  private onOutput(bytes: Uint8Array): void {
    if (!this.current) return; // stray output between commands
    this.liveTerm.write(bytes);
    this.scheduleResize();
  }

  private finishCurrent(code: number): void {
    const block = this.current;
    if (!block) return;

    const ansi = this.serializer.serialize({ scrollback: MAX_ROWS * 50 });
    block.frozenHtml = ansiToHtml(ansi);
    block.outputText = stripAnsi(ansi).replace(/\s+$/, "");
    block.status = code === 0 ? "success" : "error";
    block.exitCode = code;

    // Reclaim the live terminal for the next command.
    this.liveHost.appendChild(this.liveTerm.element!);
    this.liveTerm.clear();
    this.liveTerm.blur(); // let the InputBar take focus back
    this.current = null;
    this.altScreen = false;
    this.lockedCols = 0; // free the width again until the next command starts
    this.emit();
  }

  // ---- auto-height (grow the live term to its content, capped) ----

  private measureRowHeight(): void {
    const row = this.liveTerm.element?.querySelector(".xterm-rows")?.firstElementChild as HTMLElement | undefined;
    const h = row?.getBoundingClientRect().height;
    if (h && h > 4) this.rowHeightPx = h;
  }

  private scheduleResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      this.applyResize();
    });
  }

  private applyResize(): void {
    const host = this.liveTerm.element?.parentElement;
    if (!host || host === this.liveHost || host.clientWidth === 0) return;

    this.measureRowHeight();

    if (this.altScreen) {
      // Full-screen app: fill the feed so vim/htop get the whole viewport, and
      // let xterm own its inner scroll. Fit rows/cols to that height.
      const feed = host.closest(".octo-feed") as HTMLElement | null;
      const avail = feed ? feed.clientHeight - 24 : Math.round(window.innerHeight * 0.6);
      host.style.height = `${Math.max(120, avail)}px`;
      try {
        this.fit.fit();
      } catch {
        /* not laid out yet */
      }
      this.reportSize();
      return;
    }

    // Size the terminal grid EXACTLY ONCE per command: fixed cols × MAX_ROWS.
    // Resizing the grid mid-stream makes ConPTY repaint and reflow lines that
    // were already printed, which garbles tabular output (`ls`, Get-ChildItem)
    // — and differently each run, because it races the output. So we measure the
    // width once (proposeDimensions reads, never reflows like fit()), resize one
    // time, and from then on only grow the VISIBLE height via CSS.
    if (this.lockedCols === 0) {
      const dims = this.fit.proposeDimensions();
      const cols = dims?.cols && dims.cols > 0 ? dims.cols : this.liveTerm.cols;
      this.lockedCols = cols;
      if (cols !== this.liveTerm.cols || this.liveTerm.rows !== MAX_ROWS) {
        this.liveTerm.resize(cols, MAX_ROWS);
      }
      this.reportSize();
    }

    // Grow only the visible block height (monotonic high-water mark), capped at
    // MAX_ROWS. The fixed grid's empty trailing rows are simply clipped, and a
    // cursor-up redraw can't shrink the block (no flicker). NO terminal resize.
    const buf = this.liveTerm.buffer.active;
    const used = buf.baseY + buf.cursorY + 1;
    const rows = Math.min(MAX_ROWS, Math.max(this.hwmRows, used, 1));
    this.hwmRows = rows;
    host.style.height = `${rows * this.rowHeightPx}px`;
  }

  /** Tell the PTY the current size — but only when it actually changed, so the
   *  child app isn't told to redraw on every frame. */
  private reportSize(): void {
    const rows = this.liveTerm.rows;
    const cols = this.liveTerm.cols;
    if (rows === this.lastRows && cols === this.lastCols) return;
    this.lastRows = rows;
    this.lastCols = cols;
    invoke("resize_terminal", { id: this.sessionId, rows, cols }).catch(() => {});
  }

  // ---- input + interaction ----

  setInput(value: string): void {
    this.inputValue = value;
    this.emit();
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.emit();
  }

  /** Force-kill the command running in this shell (the Kill button).
   *
   *  Ctrl+C only reaches the foreground process, and npm/cmd shims swallow it —
   *  an unmanaged dev server started from the prompt therefore can't be stopped
   *  from the terminal at all. This kills the shell's child process tree instead,
   *  keeping the tab itself alive. Failures surface in the terminal rather than
   *  the console, so a Kill that does nothing says why. */
  async killCommand(): Promise<void> {
    if (!this.busy) return;
    try {
      await invoke("kill_foreground", { id: this.sessionId });
    } catch (e) {
      this.blocks.push({
        id: crypto.randomUUID(),
        kind: "agentText",
        role: "assistant",
        text: `⚠️ Couldn't kill the running command: ${e}`,
        startedAt: Date.now(),
      });
      this.emit();
    }
  }

  /** Ctrl+C: interrupt the running command, or cancel the agent turn. */
  interrupt(): void {
    if (this.mode === "agent") {
      if (this.agentBusy) this.cancelAgent();
      return;
    }
    if (this.busy) invoke("write_to_terminal", { id: this.sessionId, input: "\x03" }).catch(console.error);
  }

  // ---- agent lifecycle ----

  /** Send a prompt to the local `claude` agent; render its stream as blocks.
   *  `orchestrated` marks turns the assistant dispatched (vs. the user typing),
   *  so the board can light the whole tentacle route to this agent. */
  runAgent(prompt: string, opts?: { orchestrated?: boolean; via?: "phone" }): boolean {
    const text = prompt.trim();
    if (!text) return false;
    if (this.agentBusy) {
      // A turn is in flight. The orchestrator never preempts (it dispatches to
      // idle agents) — refused, and the CALLER must handle the false (silently
      // dropping a dispatch here is how QA fixes went missing). A USER
      // message takes over: cancel the running turn and queue this prompt to
      // fire from onAgentDone — never two turns at once.
      if (opts?.orchestrated) return false;
      this.pendingUserPrompt = text;
      this.inputValue = "";
      this.cancelAgent();
      this.emit();
      return true;
    }
    this.touched = true;

    this.blocks.push({
      id: crypto.randomUUID(),
      kind: "agentText",
      role: "user",
      text,
      startedAt: Date.now(),
      via: opts?.via,
    });
    this.agentBusy = true;
    this.agentOrchestrated = !!opts?.orchestrated;
    this.inputValue = "";
    this.lastAgentPrompt = text;
    this.resumeRetried = false;
    // Each turn is a fresh task: clear the step counters so the trace bar tracks
    // THIS prompt's plan (the agent re-plans per dispatch), not stale ones.
    this.agentTaskTexts = [];
    this.agentTaskStatus.clear();
    this.agentProgress = null;
    this.emit();

    this.sendToAgent(text, this.agentSessionId);
    return true;
  }

  /** Spawn one agent turn. Split out so a failed `--resume` can be retried as a
   *  fresh session without re-pushing the user's message. */
  private sendToAgent(prompt: string, resume: string | null): void {
    this.streamingTextId = null;
    const rules = settingsStore.getSnapshot().globalRules.trim();
    // Global rules are injected once, at the START of a session (resume === null):
    // on continuation turns they're already in the agent's context.
    const rulesBlock = resume === null && rules ? `<<GLOBAL RULES (always follow these)>>\n${rules}\n<</GLOBAL RULES>>` : "";
    // The step protocol drives the trace progress bar, so reliability matters more
    // than token thrift: re-inject it on EVERY turn that can drive it. The native
    // claude path uses TaskCreate/TaskUpdate; ACP agents use their own plan/todo
    // tool (forwarded as ACP `plan` updates). Gemini's native CLI has neither, so
    // it gets nothing. Otherwise a continuation/orchestrated turn would skip it and
    // the agent falls back to ad-hoc "STEP 1… STEP 2…" prose we can't parse.
    const stepRule =
      this.agentProvider === "claude"
        ? STEP_PROTOCOL
        : isAcp(this.agentProvider)
          ? ACP_STEP_PROTOCOL
          : "";
    const preamble = [rulesBlock, stepRule].filter(Boolean).join("\n\n");
    const full = preamble ? `${preamble}\n\n${prompt}` : prompt;

    // ACP path: one long-lived session drives the chosen ACP agent over the
    // protocol. The selected model is baked into the launch command (env prefix
    // for Claude, `-m` for Gemini). Approval & terminal wiring land in acp.rs
    // iteration 2; resume is implicit (the session stays alive across prompts).
    if (isAcp(this.agentProvider)) {
      // When the global sandbox setting is on, the backend runs the whole adapter
      // inside Docker using these params (image + Linux command); otherwise it
      // ignores them and launches `command` on the host.
      const sandbox = acpSandboxCommandFor(this.agentProvider, this.agentModel);
      // For local (acp-ollama) runs, generate the OpenCode config (base URL +
      // temperature + context window) first and inject it via OPENCODE_CONFIG.
      void prepareOpencodeConfig(this.agentProvider, settingsStore.getSnapshot().ollama).then((cfg) => {
        invoke("acp_send", {
          id: this.sessionId,
          prompt: full,
          cwd: this.cwd,
          command: acpCommandFor(this.agentProvider, this.agentModel, {
            opencodeConfig: cfg,
            configDir: this.agentConfigDir,
          }),
          sandboxImage: sandbox?.image ?? null,
          sandboxCommand: sandbox?.command ?? null,
          // 🛡 Approve = prompt per tool; ⚡ Auto = approve without prompting.
          autoApprove: !this.agentApproval,
        }).catch((err) => {
          this.onAgentDone(String(err));
        });
      });
      return;
    }

    invoke("agent_send", {
      id: this.sessionId,
      prompt: full,
      cwd: this.cwd,
      resume,
      model: this.agentModel,
      provider: this.agentProvider,
      approval: this.agentApproval,
      configDir: this.agentConfigDir,
    }).catch((err) => {
      this.onAgentDone(String(err));
    });
  }

  cancelAgent(): void {
    const cmd = isAcp(this.agentProvider) ? "acp_cancel" : "agent_cancel";
    invoke(cmd, { id: this.sessionId }).catch(() => {});
  }

  /** User pressed Stop in the agent bar: abort the in-flight turn AND unlock the
   *  orchestrator's live-watch hold on this agent, so stopping means stopped — no
   *  auto-continuation kicks it off again. Also drops any queued take-over prompt. */
  stop(): void {
    if (!this.agentBusy) return;
    this.pendingUserPrompt = null;
    this.onUserStopped();
    this.cancelAgent();
  }

  /** Parse one stream-json line (provider-specific) into normalized events and
   *  append/update blocks. Streaming text deltas (gemini) accumulate into one
   *  assistant block; complete messages (claude) each get their own. */
  private onAgentEvent(data: string): void {
    const events = parseAgentLine(this.agentProvider, data);
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
          this.blocks.push({ id, kind: "agentText", role: "assistant", text: e.text, startedAt: now, provider: this.agentProvider });
        }
      } else if (e.tool) {
        this.streamingTextId = null;
        // The CLI's native task-tracker tools (this build's replacement for
        // TodoWrite) drive the trace progress bar. We consume them for progress
        // and DON'T render them as feed blocks — the trace represents them.
        if (TASK_TOOLS.has(e.tool.name)) {
          this.applyTaskOp(e.tool.name, e.tool.input);
        } else {
          const id = crypto.randomUUID();
          this.agentTools.set(e.tool.id, id);
          this.blocks.push({ id, kind: "agentTool", toolName: e.tool.name, toolInput: e.tool.input, status: "running", startedAt: now });
        }
      } else if (e.result) {
        const block = this.blocks.find((b) => b.id === this.agentTools.get(e.result!.id));
        if (block && block.kind === "agentTool") {
          block.result = e.result.content;
          block.isError = e.result.isError;
          block.status = e.result.isError ? "error" : "success";
        }
      } else if (e.steps) {
        // ACP plan update: the agent re-sends its whole plan, so replace the
        // trace-bar progress wholesale (the native path's count-based machinery
        // doesn't apply — ACP gives explicit per-step status).
        this.agentProgress = e.steps.length ? e.steps : null;
      } else if (e.usage) {
        // Accumulate the turn's usage into the session running total.
        const t = this.agentTokens ?? { input: 0, output: 0, costUsd: 0 };
        this.agentTokens = {
          input: t.input + e.usage.input,
          output: t.output + e.usage.output,
          costUsd: t.costUsd + (e.usage.costUsd ?? 0),
        };
      } else if (e.context) {
        // Merge, don't replace: occupancy arrives on every message_start and the
        // window size only on the final result, so each event carries one half.
        // Replacing wholesale would blank the other half every time.
        const prev = this.agentContext;
        this.agentContext = {
          used: e.context.used ?? prev?.used ?? 0,
          window: e.context.window ?? prev?.window ?? 0,
        };
      } else if (e.apiKey !== undefined) {
        this.agentApiKey = e.apiKey;
      } else if (e.rateReset !== undefined) {
        this.agentRateReset = e.rateReset;
      }
    }
    this.emit();
  }

  /** Fold a TaskCreate/TaskUpdate call into the session task counters and re-derive
   *  the progress steps (see the field comments for why this is count-based). */
  private applyTaskOp(name: string, inputJson: string): void {
    let input: { subject?: string; description?: string; taskId?: string; status?: string };
    try {
      input = JSON.parse(inputJson);
    } catch {
      return;
    }
    if (name === "TaskCreate") {
      const text = (input.subject || input.description || "").trim();
      if (!text) return;
      this.agentTaskTexts.push(text);
    } else if (name === "TaskUpdate") {
      const id = String(input.taskId ?? "");
      if (!id) return;
      if (input.status === "deleted") {
        this.agentTaskStatus.delete(id);
      } else if (input.status === "pending" || input.status === "in_progress" || input.status === "completed") {
        this.agentTaskStatus.set(id, input.status);
      }
    } else {
      return; // TaskList / TaskGet are reads — no state change
    }
    this.rederiveProgress();
  }

  /** Build the ordered `agentProgress` steps from the task counters: the first
   *  `completed` nodes are done, the next is in-progress (if any task is active),
   *  the rest pending. Texts come from creation order. */
  private rederiveProgress(): void {
    const total = this.agentTaskTexts.length;
    if (!total) {
      this.agentProgress = null;
      return;
    }
    const statuses = [...this.agentTaskStatus.values()];
    const completed = Math.min(statuses.filter((s) => s === "completed").length, total);
    const hasActive = statuses.some((s) => s === "in_progress");
    this.agentProgress = this.agentTaskTexts.map((text, i) => ({
      text,
      status: i < completed ? "completed" : i === completed && hasActive ? "in_progress" : "pending",
    }));
  }

  private onAgentDone(error?: string, code = 0): void {
    // A stale `--resume` (the stored session vanished — e.g. the profile/account
    // was switched, or tokens ran out under the old account) fails with "No
    // conversation found". Recover transparently: drop the dead session id and
    // replay the same prompt as a FRESH session, once.
    if (
      code !== 0 &&
      error &&
      /no conversation found/i.test(error) &&
      this.agentSessionId &&
      this.lastAgentPrompt &&
      !this.resumeRetried
    ) {
      this.resumeRetried = true;
      this.agentSessionId = null;
      saveJSON(KEY.agent(this.sessionId), null);
      this.agentTools.clear();
      this.streamingTextId = null;
      this.sendToAgent(this.lastAgentPrompt, null);
      return;
    }

    // Capture before the reset below: was the turn we just finished an orchestrated
    // dispatch? (Only those get an automated review pass.)
    const wasOrchestrated = this.agentOrchestrated;
    this.agentBusy = false;
    this.agentOrchestrated = false;
    this.streamingTextId = null;
    // Any tool still "running" — or approval still pending — means the turn ended
    // (or was cancelled) before resolving; settle them so the UI isn't stuck.
    for (const b of this.blocks) {
      if (b.kind === "agentTool" && b.status === "running") b.status = "error";
      if (b.kind === "agentApproval" && b.status === "pending") b.status = "denied";
    }
    this.agentTools.clear();
    // Only surface stderr as an error block on a real failure — many CLIs (e.g.
    // gemini) print harmless warnings to stderr while exiting 0.
    const failed = code !== 0;
    if (failed && error) {
      this.blocks.push({
        id: crypto.randomUUID(),
        kind: "agentText",
        role: "assistant",
        text: `⚠️ ${error}`,
        startedAt: Date.now(),
        provider: this.agentProvider,
      });
    }
    this.emit();

    // A user message typed during the turn we just ended — run it now (the agent
    // is idle, so this starts cleanly with no concurrent turn).
    if (this.pendingUserPrompt) {
      const p = this.pendingUserPrompt;
      this.pendingUserPrompt = null;
      this.runAgent(p);
      return;
    }

    // A dispatched task just finished cleanly — kick off the automated review pass
    // (when enabled). The review agent vets the diff before QA is ever offered.
    if (!failed && wasOrchestrated && this.cwd && settingsStore.getSnapshot().reviewAgent.enabled) {
      void this.startReviewPass();
    }

    // Ping the user if they've tabbed away — "fan out & walk away".
    const where = this.displayName || "OctoShell";
    const title = failed ? `🐙 ${where}: the agent stopped` : `🐙 ${where}: the agent finished`;
    notify(title, failed && error ? error : "The turn completed.");
    // ...and their phone, if one is subscribed. The desktop notification only
    // reaches someone at the desk, which is the one place this event is already
    // visible. Says WHAT happened and WHERE, never the report: the payload is
    // encrypted, but it still lands on a lock screen, and the detail is one tap
    // away in the app.
    void invoke("push_notify", {
      title,
      body: failed ? "It stopped early — open OctoShell to see why." : "Open OctoShell to read the report.",
    }).catch(() => {
      /* nothing subscribed, or no network — never worth interrupting the turn */
    });
    playSfx(failed ? "error" : "done");
  }

  /** Assemble and launch a review pass for the work just completed: the
   *  orchestrator's task prompt as context + a compact git orientation. Best-effort;
   *  an orientation-fetch failure still starts the review (the agent inspects git). */
  private async startReviewPass(): Promise<void> {
    const context = this.lastAgentPrompt ?? "";
    const overview = await fetchReviewOverview(this.cwd);
    const prompt = buildReviewPrompt(context, overview);
    await this.review.start({ contextPrompt: context, prompt, cwd: this.cwd });
  }

  /** Manually (re)start the independent review agent on this session's diff — used
   *  by the orchestrator's `review` action and any "review this now" affordance.
   *  Same pass as the automatic one; no-op without a cwd (nothing to inspect). */
  async requestReview(): Promise<void> {
    if (!this.cwd) return;
    await this.startReviewPass();
  }

  getBlocks(): Block[] {
    return this.blocks;
  }
  /** Most recent shell command block (for macros / "Ask AI"). */
  getLastCommandBlock(): CommandBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === "command") return b;
    }
    return undefined;
  }
  getCwd(): string {
    return this.cwd;
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.unlisteners.forEach((u) => u());
    invoke("close_tab", { id: this.sessionId }).catch(() => {});
    this.cancelAgent();
    this.review.dispose();
    this.liveTerm.dispose();
    this.liveHost.remove();
  }
}
