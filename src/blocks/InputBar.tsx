import { useEffect, useRef, useState } from "react";
import type { Mode, ShellController } from "../shell/ShellController";
import { kindLabel, longestCommonPrefix, requestCompletion, type CMatch } from "../shell/completion";
import { PROVIDERS, modelsFor, supportsProfile, isAcp, type AgentProvider } from "../agents/providers";
import { useOllamaModels, ollamaModelOptions } from "../agents/ollamaModels";
import { isServerCommand } from "../projects/stacks";
import { serviceStore } from "../services/serviceStore";
import { settingsStore, useSettings } from "../settings/settingsStore";
import { open } from "@tauri-apps/plugin-dialog";
import { dragHasFiles, filesFromDrop, saveDroppedFile } from "../util/drop";
import shellIcon from "../assets/shell.png";
import agentIcon from "../assets/agent.png";
import attachIcon from "../assets/attach.png";
import micIcon from "../assets/mic.png";

interface Props {
  controller: ShellController;
  cwd: string;
  busy: boolean;
  /** Controlled value (lets macros inject a proposed command). */
  value: string;
  /** A full-screen app owns the keyboard — the input defers to it. */
  altScreen: boolean;
  /** The user is currently typing directly into the running command's terminal. */
  interacting: boolean;
  /** Input routing: shell command vs. agent prompt. */
  mode: Mode;
  /** An agent turn is in flight. */
  agentBusy: boolean;
  /** The in-flight turn was dispatched by the orchestrator (not the user typing). */
  agentOrchestrated: boolean;
  /** Selected agent model (null = CLI default). */
  agentModel: string | null;
  /** Which agent CLI drives this project. */
  agentProvider: AgentProvider;
  /** Selected Claude Code profile dir for this agent (null = home default). */
  agentConfigDir: string | null;
  /** Cumulative token usage for this session's agent (null if unavailable). */
  agentTokens: { input: number; output: number; costUsd: number } | null;
  /** Latest context-window occupancy (used / window). */
  agentContext: { used: number; window: number } | null;
  agentSessionId: string | null;
  /** True when billing per-token (API key) — then cost ($) is shown. */
  agentApiKey: boolean;
  /** Epoch seconds of the next subscription rate-limit reset, or null. */
  agentRateReset: number | null;
  /** Per-tool approval mode (Claude only). */
  agentApproval: boolean;
}

/** "3h 59m" until the given epoch-seconds reset (or "" if past/unknown). */
function fmtReset(epoch: number | null): string {
  if (!epoch) return "";
  const secs = epoch - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Compact token count, e.g. 1234 → "1.2k", 45000 → "45k". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}


interface MenuState {
  items: CMatch[];
  index: number;
  ri: number;
  rl: number;
}

/** The input grows with its content up to this height, then scrolls. */
const INPUT_MAX_PX = 308;

/**
 * The input editor at the bottom of the feed — a normal text input, so editing,
 * selection and paste behave like any modern app (no terminal grid).
 *
 * In **shell** mode Enter submits a command; while one is running, Enter pipes
 * the line to its stdin. In **agent** mode Enter sends the prompt to the local
 * `claude` agent. **Tab** runs PowerShell's completion engine (cmdlets, paths,
 * parameters): a unique/common-prefix match is inserted inline, otherwise a
 * candidate menu opens. Shift+Enter inserts a newline, Ctrl+C interrupts, ↑/↓
 * navigate history (or the completion menu when open).
 */
export function InputBar({ controller, cwd, busy, value, altScreen, interacting, mode, agentBusy, agentModel, agentProvider, agentConfigDir, agentTokens, agentContext, agentSessionId, agentApiKey, agentRateReset, agentApproval }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number>(-1);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [providerMenu, setProviderMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const settings = useSettings();
  const agentProfileName = settings.profiles.find((p) => p.configDir === agentConfigDir)?.name ?? "Default";

  const barRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const copyPath = () => {
    if (!cwd) return;
    void navigator.clipboard.writeText(cwd);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  // File attachments: their paths ride along with the message (handy for agent
  // tasks — "look at this file"). Added via the 📎 button or by drag & drop.
  const [attachments, setAttachments] = useState<string[]>([]);
  const addAttachments = (paths: string[]) =>
    setAttachments((a) => [...a, ...paths.filter((p) => p && !a.includes(p))]);
  const pickFiles = async () => {
    const picked = await open({ multiple: true, title: "Pick file(s)" });
    if (!picked) return;
    addAttachments(Array.isArray(picked) ? picked : [picked]);
    ref.current?.focus();
  };

  // Speech-to-text: dictate into the input. Default engine is the browser's free
  // Web Speech API (settings.sttEngine); Whisper is a planned alternative and for
  // now falls back to the same path. Stops automatically on unmount.
  const [recording, setRecording] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* noop */ } }, []);
  const stopStt = () => { try { recRef.current?.stop(); } catch { /* noop */ } setRecording(false); };
  const startStt = () => {
    const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      controller.setInput("# (speech-to-text is not supported in this WebView)");
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || "el-GR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) txt += e.results[i][0].transcript;
      }
      txt = txt.trim();
      if (txt) {
        const cur = controller.getSnapshot().input ?? "";
        controller.setInput(cur ? `${cur} ${txt}` : txt);
      }
    };
    rec.onend = () => { setRecording(false); recRef.current = null; };
    rec.onerror = () => { setRecording(false); recRef.current = null; };
    recRef.current = rec;
    try { rec.start(); setRecording(true); } catch { setRecording(false); }
  };
  const toggleStt = () => {
    if (recording) { stopStt(); return; }
    // Whisper isn't wired to a backend yet → use the free web engine meanwhile.
    startStt();
  };

  // Drag & drop a file/image onto the bar → attach it. The window runs with
  // `dragDropEnabled: false` (the sidebar needs HTML5 drag & drop for
  // reordering), so Tauri's onDragDropEvent never fires and a drop reaches us as
  // browser File objects with no path. The backend writes the bytes to a scratch
  // file and hands back a real path, which is what agents can actually open.
  const [dropping, setDropping] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const onDrop = async (e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return; // a sidebar item drag — not ours
    e.preventDefault();
    setDropping(false);
    const files = filesFromDrop(e.dataTransfer);
    if (!files.length) return;
    setDropErr(null);
    try {
      const paths = await Promise.all(files.map(saveDroppedFile));
      addAttachments(paths);
      ref.current?.focus();
    } catch (err) {
      setDropErr(`Couldn't attach the dropped file: ${err}`);
    }
  };

  const addAgentProfile = async () => {
    const dir = await open({ directory: true, title: "Pick a profile folder (CLAUDE_CONFIG_DIR)" });
    if (typeof dir !== "string") return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || "profile";
    const p = settingsStore.addProfile(name, dir);
    controller.setAgentConfigDir(p.configDir);
    setProfileMenu(false);
  };
  // A submitted command that looks like a server: we pause to offer running it as
  // a managed service (own port, non-blocking) instead of in the blocking shell.
  const [serverOffer, setServerOffer] = useState<string | null>(null);

  const agent = mode === "agent";
  // The agent chat is never locked: you can always type. Sending while a turn is
  // in flight takes over — it cancels the running turn (orchestrated or not) and
  // runs your message instead (see ShellController.runAgent).
  const prov = PROVIDERS.find((p) => p.value === agentProvider) ?? PROVIDERS[0];
  // Local (Ollama) models are the user's ACTUALLY installed ones (live), not a
  // hardcoded list; every other provider uses its curated set.
  const ollama = useOllamaModels();
  const models =
    agentProvider === "acp-ollama"
      ? ollamaModelOptions(ollama.models)
      : modelsFor(agentProvider);
  const modelLabel = models.find((m) => m.value === agentModel)?.label ?? "Default";

  // Keep focus in the input as state changes — except while the keyboard belongs
  // to the embedded terminal (full-screen app, or the user clicked in).
  useEffect(() => {
    if (!altScreen && !interacting) ref.current?.focus();
  }, [busy, altScreen, interacting, mode]);

  // Restore the caret after a completion rewrites the controlled value.
  useEffect(() => {
    if (pendingCursor.current != null && ref.current) {
      const p = pendingCursor.current;
      pendingCursor.current = null;
      ref.current.selectionStart = ref.current.selectionEnd = p;
    }
  }, [value]);

  // Auto-grow the input to fit its content (chat-style), so a long command is
  // never clipped. Caps at INPUT_MAX_PX, after which it scrolls internally.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
  }, [value]);

  // Keep the highlighted completion in view.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [menu?.index]);

  const setValueWithCaret = (newVal: string, caret: number) => {
    pendingCursor.current = caret;
    controller.setInput(newVal);
  };

  /** Splice `text` into the current line over the [ri, ri+rl) span. */
  const applyText = (text: string, ri: number, rl: number) => {
    const newVal = value.slice(0, ri) + text + value.slice(ri + rl);
    setValueWithCaret(newVal, ri + text.length);
  };

  const acceptMenu = (i: number) => {
    if (!menu) return;
    applyText(menu.items[i].t, menu.ri, menu.rl);
    setMenu(null);
  };

  const tokenAt = (line: string, cursor: number): string => {
    const left = line.slice(0, cursor);
    const m = left.match(/\S*$/);
    return m ? m[0] : "";
  };

  const doComplete = async () => {
    const el = ref.current;
    if (!el) return;
    const cursor = el.selectionStart ?? value.length;

    // In agent mode only complete path-like tokens (avoid command-name noise in prose).
    if (agent && !/[\\/.~]/.test(tokenAt(value, cursor))) return;

    const res = await requestCompletion(cwd, value, cursor);
    if (res.m.length === 0) return;
    if (res.m.length === 1) {
      applyText(res.m[0].t, res.ri, res.rl);
      return;
    }
    // Multiple: extend by the longest common prefix first (bash-like); if that
    // adds nothing, show the candidate menu.
    const lcp = longestCommonPrefix(res.m.map((x) => x.t));
    const span = value.slice(res.ri, res.ri + res.rl);
    if (lcp.length > span.length) {
      applyText(lcp, res.ri, res.rl);
      return;
    }
    setMenu({ items: res.m, index: 0, ri: res.ri, rl: res.rl });
  };

  /** Run `v` as a normal blocking shell command. */
  const runShell = (v: string) => {
    setHistory((h) => [...h, v]);
    setHistIdx(-1);
    setServerOffer(null);
    controller.submit(v);
  };

  /** Run `v` as an OctoShell-managed service: own port, own logs, non-blocking —
   *  so a dev server never wedges the shell (or, when an agent does it, the turn). */
  const runManaged = (v: string) => {
    setHistory((h) => [...h, v]);
    setHistIdx(-1);
    setServerOffer(null);
    controller.setInput("");
    const name = controller.displayName || cwd.split(/[\\/]/).filter(Boolean).pop() || "service";
    void serviceStore.start({ name, cwd, command: v });
  };

  const submit = () => {
    // Attachment paths ride along after the typed text (quoted if they contain
    // spaces), then the chips are cleared.
    const atts = attachments.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
    const compose = (base: string) => (atts ? (base ? `${base} ${atts}` : atts) : base);
    if (agent) {
      const composed = compose(value);
      if (!composed.trim()) return;
      controller.runAgent(composed);
      setAttachments([]);
      return;
    }
    if (busy) {
      controller.sendRaw(value + "\r"); // answer a running command's prompt
      controller.setInput("");
      return;
    }
    const v = compose(value.trim()).trim();
    if (!v) return;
    // Hybrid detection: a server command pauses for the managed-vs-plain choice.
    if (isServerCommand(v)) {
      setServerOffer(v);
      return;
    }
    runShell(v);
    setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Completion menu navigation takes precedence while it's open.
    if (menu) {
      if (e.key === "Tab") {
        e.preventDefault();
        const d = e.shiftKey ? -1 : 1;
        setMenu({ ...menu, index: (menu.index + d + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu({ ...menu, index: (menu.index + 1) % menu.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu({ ...menu, index: (menu.index - 1 + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        acceptMenu(menu.index);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
      // Any other key dismisses the menu and is handled normally.
      setMenu(null);
    }

    if (e.key === "Tab") {
      e.preventDefault();
      void doComplete();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
      e.preventDefault();
      controller.interrupt();
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const i = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      controller.setInput(history[i]);
    } else if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx + 1;
      if (i >= history.length) { setHistIdx(-1); controller.setInput(""); }
      else { setHistIdx(i); controller.setInput(history[i]); }
    }
  };

  return (
    <div
      ref={barRef}
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Ignore the leave events fired while crossing child elements.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
      className={`border-t bg-transparent px-3 py-2 transition-colors ${
        dropping ? "border-accent bg-accent/5" : "border-edge"
      }`}
    >
      {/* Controls: Shell/Agent switch · attach · TTS · agent options · path · status. */}
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        {/* Shell ⇄ Agent switch — tinted to the active mode (blue / purple). */}
        <div
          className={`inline-flex h-6 shrink-0 items-center rounded-full border p-0.5 text-[11px] font-medium transition-colors ${
            agent ? "border-accent/40 bg-accent/10" : "border-sky-500/40 bg-sky-500/10"
          }`}
        >
          <button
            onClick={() => controller.setMode("shell")}
            className={`flex h-full items-center rounded-full px-2 transition-colors ${
              !agent ? "bg-sky-500/30 text-sky-100" : "text-muted hover:text-gray-200"
            }`}
          >
            <ShellIcon /> Shell
          </button>
          <button
            onClick={() => controller.setMode("agent")}
            className={`flex h-full items-center rounded-full px-2 transition-colors ${
              agent ? "bg-accent/30 text-accent" : "text-muted hover:text-gray-200"
            }`}
          >
            <AgentIcon /> Agent
          </button>
        </div>

        {/* Attach a file → its path rides along as an attachment chip. */}
        <button
          onClick={() => void pickFiles()}
          title="Attach a file (path)"
          className="shrink-0 rounded-md transition-opacity hover:opacity-80"
        >
          <img src={attachIcon} alt="Attach" className="h-6 w-6 rounded-md" />
        </button>
        {/* Speech-to-text — dictate into the input. */}
        <button
          onClick={toggleStt}
          title={recording ? "Stop dictation" : "Dictate (speech-to-text)"}
          className={`shrink-0 rounded-md transition-opacity hover:opacity-80 ${
            recording ? "ring-2 ring-pink-400 animate-pulse" : ""
          }`}
        >
          <img src={micIcon} alt="Speech to text" className="h-6 w-6 rounded-md" />
        </button>


        {agent && (
          <div className="relative">
            <button
              onClick={() => setProviderMenu((o) => !o)}
              title="Agent provider (CLI)"
              className="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            >
              {prov.label}
            </button>
            {providerMenu && (
              <div
                className="absolute bottom-full left-0 z-30 mb-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
                style={{ minWidth: "11rem" }}
              >
                {/* Native CLIs vs ACP adapters — two labelled sections, so it's
                    clear which integration path each agent runs on. */}
                {[
                  { header: "Native CLI", items: PROVIDERS.filter((p) => !isAcp(p.value)) },
                  { header: "ACP agents", items: PROVIDERS.filter((p) => isAcp(p.value)) },
                ].map((sec) => (
                  <div key={sec.header} className="border-b border-edge/60 py-1 last:border-b-0">
                    <div className="px-2.5 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-widest text-muted/70">
                      {sec.header}
                    </div>
                    <ul>
                      {sec.items.map((p) => (
                        <li key={p.value}>
                          <button
                            onClick={() => { controller.setAgentProvider(p.value); setProviderMenu(false); }}
                            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                              p.value === agentProvider
                                ? "bg-accent/15 font-medium text-accent"
                                : "text-gray-200 hover:bg-edge"
                            }`}
                          >
                            <span className="flex-1">{p.label.replace(" (ACP)", "")}</span>
                            {p.value === agentProvider && <span className="text-accent">✓</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {agent && (
          <div className="relative">
            <button
              onClick={() => setModelMenu((o) => !o)}
              title="Agent model (applies from the next turn)"
              className="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            >
              ⚙ {modelLabel}
            </button>
            {modelMenu && (
              <ul
                className="absolute bottom-full left-0 z-30 mb-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
                style={{ minWidth: "8rem" }}
              >
                {models.map((m) => (
                  <li key={m.label}>
                    <button
                      onClick={() => { controller.setAgentModel(m.value); setModelMenu(false); }}
                      className={`flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-edge ${
                        m.value === agentModel ? "text-accent" : "text-gray-200"
                      }`}
                    >
                      {m.label}
                      {m.value === agentModel && <span>✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {agent && supportsProfile(agentProvider) && (
          <div className="relative">
            <button
              onClick={() => setProfileMenu((o) => !o)}
              title="Profile (account/config dir) — applies from the next turn"
              className="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            >
              👤 {agentProfileName}
            </button>
            {profileMenu && (
              <ul
                className="absolute bottom-full left-0 z-30 mb-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
                style={{ minWidth: "11rem" }}
              >
                <li>
                  <button
                    onClick={() => { controller.setAgentConfigDir(null); setProfileMenu(false); }}
                    className={`flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-edge ${
                      !agentConfigDir ? "text-accent" : "text-gray-200"
                    }`}
                  >
                    Default (home)
                    {!agentConfigDir && <span>✓</span>}
                  </button>
                </li>
                {settings.profiles.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => { controller.setAgentConfigDir(p.configDir); setProfileMenu(false); }}
                      title={p.configDir}
                      className={`flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-edge ${
                        p.configDir === agentConfigDir ? "text-accent" : "text-gray-200"
                      }`}
                    >
                      <span className="truncate">{p.name}</span>
                      {p.configDir === agentConfigDir && <span>✓</span>}
                    </button>
                  </li>
                ))}
                <li className="border-t border-edge">
                  <button
                    onClick={() => void addAgentProfile()}
                    className="w-full px-2 py-1 text-left text-xs text-accent hover:bg-edge"
                  >
                    + Add profile…
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}

        {agent && (agentProvider === "claude" || isAcp(agentProvider)) && (
          <button
            onClick={() => controller.setAgentApproval(!agentApproval)}
            title={
              agentApproval
                ? "Approval: the agent asks before Bash/Edit/Write"
                : "Auto: the agent runs without approval"
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              agentApproval
                ? "border-amber-400/50 bg-amber-500/15 text-amber-300"
                : "border-edge text-muted hover:bg-edge hover:text-gray-200"
            }`}
          >
            {agentApproval ? "🛡 Approve" : "⚡ Auto"}
          </button>
        )}

        {agent && agentTokens && (agentTokens.input > 0 || agentTokens.output > 0) && (
          <span
            className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted"
            title="Session token totals (sent / received)"
          >
            🪙 ↑{fmtTokens(agentTokens.input)} ↓{fmtTokens(agentTokens.output)}
            {/* Cost is meaningful only on per-token (API key) billing. */}
            {agentApiKey && agentTokens.costUsd > 0 && (
              <span className="text-accent">
                · ${agentTokens.costUsd.toFixed(agentTokens.costUsd < 1 ? 3 : 2)}
              </span>
            )}
          </span>
        )}
        {agent && agentContext && agentContext.window > 0 && (() => {
          const pct = Math.min(100, Math.round((agentContext.used / agentContext.window) * 100));
          const col = pct >= 80 ? "text-red-400" : pct >= 50 ? "text-amber-400" : "text-sky-300/80";
          return (
            <span
              className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted"
              title={`Context window: ${agentContext.used.toLocaleString()} / ${agentContext.window.toLocaleString()} tokens`}
            >
              🧠 {fmtTokens(agentContext.used)}/{fmtTokens(agentContext.window)}
              <span className={col}>· {pct}%</span>
            </span>
          );
        })()}
        {/* Sits next to the occupancy meter on purpose: this button is what the
            meter makes you want when it climbs. Hidden until there IS a session
            to reset, so it can't imply an action that would do nothing. */}
        {agent && agentSessionId && !agentBusy && (
          <button
            onClick={() => controller.newAgentSession()}
            title="New agent session — the next task starts with an empty context window. Your visible history is kept."
            className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted hover:bg-edge hover:text-gray-200"
          >
            ⟲ New session
          </button>
        )}
        {agent && !agentApiKey && fmtReset(agentRateReset) && (
          <span
            className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted"
            title="When the subscription's 5-hour limit resets"
          >
            ↻ {fmtReset(agentRateReset)}
          </span>
        )}
        <span className="flex-1" />
        {agent ? (
          agentBusy && (
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-accent">● {prov.label} is thinking…</span>
              <button
                onClick={() => controller.stop()}
                title="Stop the agent (also releases the orchestrator's live-watch hold)"
                className="flex items-center gap-1 rounded border border-red-400/50 bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-500/25"
              >
                ■ Stop
              </button>
            </span>
          )
        ) : altScreen || interacting ? (
          <span className="shrink-0 text-accent">⌨ click for a new command</span>
        ) : (
          busy && (
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-yellow-400">● running…</span>
              <button
                onClick={() => void controller.killCommand()}
                title="Kill the running command (use when Ctrl+C won't stop it — e.g. a dev server)"
                className="flex items-center gap-1 rounded border border-red-400/50 bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-500/25"
              >
                ■ Kill
              </button>
            </span>
          )
        )}
      </div>

      {/* Path row — under the switcher. Click to copy the working directory. */}
      <button
        onClick={copyPath}
        title="Click to copy the path"
        className="mb-1.5 flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted hover:text-gray-200"
      >
        <span className="shrink-0">📁</span>
        <span className="truncate">{cwd || "~"}</span>
        {copied && <span className="shrink-0 text-accent">✓</span>}
      </button>

      {serverOffer && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px]">
          <span className="text-sky-200">🌐 Looks like a server — run it managed (own port, own logs)?</span>
          <button
            onClick={() => runManaged(serverOffer)}
            className="rounded bg-sky-500/30 px-1.5 py-0.5 text-sky-100 hover:bg-sky-500/40"
          >
            Yes, managed
          </button>
          <button
            onClick={() => runShell(serverOffer)}
            className="rounded border border-edge px-1.5 py-0.5 text-muted hover:bg-edge hover:text-gray-200"
          >
            Run normally
          </button>
          <button
            onClick={() => setServerOffer(null)}
            title="Cancel"
            className="ml-auto text-muted hover:text-gray-200"
          >
            ✕
          </button>
        </div>
      )}

      {dropErr && (
        <div className="mb-1.5 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          <span className="flex-1">{dropErr}</span>
          <button onClick={() => setDropErr(null)} title="Dismiss" className="text-red-300/70 hover:text-red-200">
            ✕
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="flex items-center gap-1 rounded border border-edge bg-card px-1.5 py-0.5 text-[11px] text-gray-200"
            >
              <span className="shrink-0">📎</span>
              <span className="max-w-[160px] truncate" title={p}>{p.split(/[\\/]/).pop() || p}</span>
              <button
                onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                title="Remove"
                className="text-muted hover:text-red-300"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        {menu && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-full overflow-auto rounded-lg border border-edge bg-panel shadow-lg">
            {menu.items.map((it, i) => (
              <li
                key={`${it.t}-${i}`}
                ref={i === menu.index ? selectedRef : undefined}
                onMouseDown={(e) => { e.preventDefault(); acceptMenu(i); }}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${
                  i === menu.index ? "bg-accent/30 text-accent" : "text-gray-200 hover:bg-edge"
                }`}
              >
                <span className="flex-1 truncate font-mono">{it.l || it.t}</span>
                <span className="shrink-0 text-[10px] text-muted">{kindLabel(it.k)}</span>
              </li>
            ))}
          </ul>
        )}

        <div
          className={`flex items-start gap-2 rounded-lg border bg-card px-3 py-2.5 ${
            agent ? "border-accent/40 focus-within:border-accent" : "border-edge focus-within:border-accent/60"
          }`}
        >
          <span className="select-none pt-0.5 font-semibold leading-relaxed text-accent">
            {agent ? "✦" : "❯"}
          </span>
          <textarea
            ref={ref}
            rows={5}
            value={value}
            onChange={(e) => { setMenu(null); controller.setInput(e.target.value); }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            placeholder={
              agent
                ? agentBusy
                  ? "Send to take over (interrupts the current turn)…"
                  : "Ask or delegate to the agent…  (Enter = send, Tab = path complete)"
                : "Type a command…  (Enter = run, Tab = autocomplete, Shift+Enter = new line)"
            }
            className="max-h-[364px] min-h-[5.6rem] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-gray-100 caret-accent outline-none placeholder:text-muted/50"
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

/** Neon terminal-prompt tile for Shell mode / chat-bubble tile for Agent mode. */
const ShellIcon = () => (
  <img src={shellIcon} alt="" aria-hidden className="mr-1 h-4 w-4 rounded-[3px]" />
);
const AgentIcon = () => (
  <img src={agentIcon} alt="" aria-hidden className="mr-1 h-4 w-4 rounded-[3px]" />
);
