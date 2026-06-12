import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ansiToHtml, stripAnsi } from "../util/ansi";
import { KEY, loadJSON, removeKey, saveJSON } from "../util/persist";
import { notify } from "../util/notify";
import { parseAgentLine, type AgentProvider } from "../agents/providers";

/** Keep at most this many historical blocks per session in storage. */
const MAX_PERSISTED_BLOCKS = 80;

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

export type Block = CommandBlock | AgentTextBlock | AgentToolBlock;

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
  /** Cumulative token usage for this session's agent (null until first turn ends
   *  or if the provider doesn't report it). */
  agentTokens: { input: number; output: number; costUsd: number } | null;
  /** Latest context-window occupancy (used / window), for the usage meter. */
  agentContext: { used: number; window: number } | null;
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

  // ---- agent state ----
  private mode: Mode = "shell";
  private agentBusy = false;
  /** Set when the current turn was started by the orchestrator. */
  private agentOrchestrated = false;
  /** claude session id, for `--resume` across turns. */
  private agentSessionId: string | null = null;
  /** Selected model for this project's agent (null = CLI default). Applies from
   *  the NEXT turn — `claude --model` can't change a turn already in flight. */
  private agentModel: string | null = null;
  /** Which agent CLI drives this project (claude / gemini). */
  private agentProvider: AgentProvider = "claude";
  /** Running token total for this session's agent (null = none reported yet). */
  private agentTokens: { input: number; output: number; costUsd: number } | null = null;
  /** Latest context-window occupancy reported by the agent. */
  private agentContext: { used: number; window: number } | null = null;
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
    mode: "shell",
    agentBusy: false,
    agentOrchestrated: false,
    agentModel: null,
    agentProvider: "claude",
    agentTokens: null,
    agentContext: null,
    agentApiKey: false,
    agentRateReset: null,
  };

  constructor(public readonly sessionId: string) {
    // A hidden, off-screen home for the live terminal between commands.
    this.liveHost = document.createElement("div");
    this.liveHost.style.cssText = "position:absolute;left:-99999px;top:0;width:900px;height:400px;";
    document.body.appendChild(this.liveHost);

    this.liveTerm = new Terminal({
      fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
      fontSize: 15,
      scrollback: 5000,
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
      mode: this.mode,
      agentBusy: this.agentBusy,
      agentOrchestrated: this.agentOrchestrated,
      agentModel: this.agentModel,
      agentProvider: this.agentProvider,
      agentTokens: this.agentTokens,
      agentContext: this.agentContext,
      agentApiKey: this.agentApiKey,
      agentRateReset: this.agentRateReset,
    };
    this.listeners.forEach((l) => l());
    this.scheduleSave();
  }

  /** Wire PTY events and spawn the shell. Call once before first render. */
  async init(cwd = ""): Promise<void> {
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
    );
    await invoke("open_new_tab", { id: this.sessionId, cwd, onOutput: stream });
    this.hydrate();
  }

  /** Restore persisted history (finished blocks + agent session) for this id. */
  private hydrate(): void {
    const saved = loadJSON<Block[]>(KEY.blocks(this.sessionId), []);
    if (saved.length) this.blocks = saved;
    this.agentSessionId = loadJSON<string | null>(KEY.agent(this.sessionId), null);
    this.agentModel = loadJSON<string | null>(KEY.model(this.sessionId), null);
    this.agentProvider = loadJSON<AgentProvider>(KEY.provider(this.sessionId), "claude");
    if (saved.length || this.agentSessionId || this.agentModel) this.emit();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
  }

  private persist(): void {
    // Never store an in-flight block (live command or unfinished tool) — only
    // settled history, so a restore never shows a perpetually "running" block.
    const settled = this.blocks.filter(
      (b) => !((b.kind === "command" || b.kind === "agentTool") && b.status === "running"),
    );
    saveJSON(KEY.blocks(this.sessionId), settled.slice(-MAX_PERSISTED_BLOCKS));
    saveJSON(KEY.agent(this.sessionId), this.agentSessionId);
    saveJSON(KEY.model(this.sessionId), this.agentModel);
    saveJSON(KEY.provider(this.sessionId), this.agentProvider);
  }

  /** Choose the model for this project's agent (null = CLI default). */
  setAgentModel(model: string | null): void {
    this.agentModel = model;
    saveJSON(KEY.model(this.sessionId), model);
    this.emit();
  }

  /** Switch the agent CLI (claude ↔ gemini). Resets the session id since a
   *  session can't carry across providers; the next turn starts fresh. */
  setAgentProvider(provider: AgentProvider): void {
    if (provider === this.agentProvider) return;
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
    removeKey(KEY.blocks(this.sessionId));
    removeKey(KEY.agent(this.sessionId));
    removeKey(KEY.model(this.sessionId));
    removeKey(KEY.provider(this.sessionId));
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
  runAgent(prompt: string, opts?: { orchestrated?: boolean }): void {
    const text = prompt.trim();
    if (!text || this.agentBusy) return;

    this.blocks.push({
      id: crypto.randomUUID(),
      kind: "agentText",
      role: "user",
      text,
      startedAt: Date.now(),
    });
    this.agentBusy = true;
    this.agentOrchestrated = !!opts?.orchestrated;
    this.inputValue = "";
    this.emit();

    this.streamingTextId = null;
    invoke("agent_send", {
      id: this.sessionId,
      prompt: text,
      cwd: this.cwd,
      resume: this.agentSessionId,
      model: this.agentModel,
      provider: this.agentProvider,
    }).catch((err) => {
      this.onAgentDone(String(err));
    });
  }

  cancelAgent(): void {
    invoke("agent_cancel", { id: this.sessionId }).catch(() => {});
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
      } else if (e.usage) {
        // Accumulate the turn's usage into the session running total.
        const t = this.agentTokens ?? { input: 0, output: 0, costUsd: 0 };
        this.agentTokens = {
          input: t.input + e.usage.input,
          output: t.output + e.usage.output,
          costUsd: t.costUsd + (e.usage.costUsd ?? 0),
        };
      } else if (e.context) {
        this.agentContext = e.context; // latest occupancy (replace, not sum)
      } else if (e.apiKey !== undefined) {
        this.agentApiKey = e.apiKey;
      } else if (e.rateReset !== undefined) {
        this.agentRateReset = e.rateReset;
      }
    }
    this.emit();
  }

  private onAgentDone(error?: string, code = 0): void {
    this.agentBusy = false;
    this.agentOrchestrated = false;
    this.streamingTextId = null;
    // Any tool still "running" means the turn was cut short.
    for (const b of this.blocks) {
      if (b.kind === "agentTool" && b.status === "running") b.status = "error";
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

    // Ping the user if they've tabbed away — "fan out & walk away".
    const where = this.displayName || "OctoShell";
    notify(
      failed ? `🐙 ${where}: ο agent σταμάτησε` : `🐙 ${where}: ο agent τελείωσε`,
      failed && error ? error : "Το turn ολοκληρώθηκε.",
    );
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
    this.liveTerm.dispose();
    this.liveHost.remove();
  }
}
