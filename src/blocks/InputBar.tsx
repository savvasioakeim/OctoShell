import { useEffect, useRef, useState } from "react";
import type { Mode, ShellController } from "../shell/ShellController";
import { kindLabel, longestCommonPrefix, requestCompletion, type CMatch } from "../shell/completion";
import { PROVIDERS, type AgentProvider } from "../agents/providers";
import { isServerCommand } from "../services/serviceDetect";
import { serviceStore } from "../services/serviceStore";
import { settingsStore, useSettings } from "../settings/settingsStore";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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

// Models offered per provider (`value` → the CLI's `--model`/`-m`). Curated:
// neither CLI exposes a headless "list models" command, so an unavailable name
// just errors visibly on that turn. Gemini names are the ones this build reports.
const MODELS_BY_PROVIDER: Record<AgentProvider, { label: string; value: string | null }[]> = {
  claude: [
    { label: "Default", value: null },
    { label: "Fable", value: "fable" },
    { label: "Opus", value: "opus" },
    { label: "Sonnet", value: "sonnet" },
    { label: "Haiku", value: "haiku" },
  ],
  gemini: [
    { label: "Default (auto)", value: null },
    { label: "3 Pro", value: "gemini-3.1-pro-preview" },
    { label: "3 Flash", value: "gemini-3-flash-preview" },
    { label: "3 Flash Lite", value: "gemini-3.1-flash-lite" },
  ],
};

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
export function InputBar({ controller, cwd, busy, value, altScreen, interacting, mode, agentBusy, agentModel, agentProvider, agentConfigDir, agentTokens, agentContext, agentApiKey, agentRateReset, agentApproval }: Props) {
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
    const picked = await open({ multiple: true, title: "Διάλεξε αρχείο/α" });
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
      controller.setInput("# (speech-to-text δεν υποστηρίζεται σ' αυτό το WebView)");
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

  // Drag & drop a file/image onto this input → attach its real filesystem path
  // (Tauri exposes the path; the browser File API would not). The drop event is
  // window-wide, so we only act when the cursor is over THIS bar — inactive
  // panels (display:none → empty rect) and other bars ignore it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        const el = barRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const { x, y } = e.payload.position;
        if (x < r.left * dpr || x > r.right * dpr || y < r.top * dpr || y > r.bottom * dpr) return;
        const paths = e.payload.paths ?? [];
        if (paths.length) {
          addAttachments(paths);
          ref.current?.focus();
        }
      })
      .then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, [controller]);

  const addAgentProfile = async () => {
    const dir = await open({ directory: true, title: "Διάλεξε φάκελο profile (CLAUDE_CONFIG_DIR)" });
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
  const models = MODELS_BY_PROVIDER[agentProvider];
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
    <div ref={barRef} className="border-t border-edge bg-transparent px-3 py-2">
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
          title="Επισύναψε αρχείο (path)"
          className="shrink-0 rounded-md transition-opacity hover:opacity-80"
        >
          <img src={attachIcon} alt="Attach" className="h-6 w-6 rounded-md" />
        </button>
        {/* Speech-to-text — dictate into the input. */}
        <button
          onClick={toggleStt}
          title={recording ? "Σταμάτα την υπαγόρευση" : "Υπαγόρευση (speech-to-text)"}
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
              {prov.icon} {prov.label}
            </button>
            {providerMenu && (
              <ul
                className="absolute bottom-full left-0 z-30 mb-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
                style={{ minWidth: "7rem" }}
              >
                {PROVIDERS.map((p) => (
                  <li key={p.value}>
                    <button
                      onClick={() => { controller.setAgentProvider(p.value); setProviderMenu(false); }}
                      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-edge ${
                        p.value === agentProvider ? "text-accent" : "text-gray-200"
                      }`}
                    >
                      <span>{p.icon}</span>
                      <span className="flex-1">{p.label}</span>
                      {p.value === agentProvider && <span>✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {agent && (
          <div className="relative">
            <button
              onClick={() => setModelMenu((o) => !o)}
              title="Μοντέλο agent (ισχύει από το επόμενο turn)"
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

        {agent && agentProvider === "claude" && (
          <div className="relative">
            <button
              onClick={() => setProfileMenu((o) => !o)}
              title="Claude Code profile (λογαριασμός) — ισχύει από το επόμενο turn"
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
                    + Πρόσθεσε profile…
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}

        {agent && agentProvider === "claude" && (
          <button
            onClick={() => controller.setAgentApproval(!agentApproval)}
            title={
              agentApproval
                ? "Approval: ο agent ρωτά πριν από Bash/Edit/Write"
                : "Auto: ο agent τρέχει χωρίς έγκριση"
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
            title="Σύνολο tokens αυτής της συνεδρίας (απεσταλμένα / ληφθέντα)"
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
        {agent && !agentApiKey && fmtReset(agentRateReset) && (
          <span
            className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted"
            title="Πότε μηδενίζει το 5ωρο όριο της συνδρομής"
          >
            ↻ {fmtReset(agentRateReset)}
          </span>
        )}
        <span className="flex-1" />
        {agent ? (
          agentBusy && <span className="shrink-0 text-accent">● {prov.label} σκέφτεται…</span>
        ) : altScreen || interacting ? (
          <span className="shrink-0 text-accent">⌨ κλικ για νέα εντολή</span>
        ) : (
          busy && <span className="shrink-0 text-yellow-400">● running…</span>
        )}
      </div>

      {/* Path row — under the switcher. Click to copy the working directory. */}
      <button
        onClick={copyPath}
        title="Κλικ για copy του path"
        className="mb-1.5 flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted hover:text-gray-200"
      >
        <span className="shrink-0">📁</span>
        <span className="truncate">{cwd || "~"}</span>
        {copied && <span className="shrink-0 text-accent">✓</span>}
      </button>

      {serverOffer && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px]">
          <span className="text-sky-200">🌐 Μοιάζει με server — να το τρέξω managed (δικό του port, δικά του logs);</span>
          <button
            onClick={() => runManaged(serverOffer)}
            className="rounded bg-sky-500/30 px-1.5 py-0.5 text-sky-100 hover:bg-sky-500/40"
          >
            Ναι, managed
          </button>
          <button
            onClick={() => runShell(serverOffer)}
            className="rounded border border-edge px-1.5 py-0.5 text-muted hover:bg-edge hover:text-gray-200"
          >
            Τρέξε κανονικά
          </button>
          <button
            onClick={() => setServerOffer(null)}
            title="Άκυρο"
            className="ml-auto text-muted hover:text-gray-200"
          >
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
                title="Αφαίρεση"
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
                  ? "Στείλε για να πάρεις τον έλεγχο (διακόπτει το τρέχον turn)…"
                  : "Ρώτησε ή ανάθεσε στον claude…  (Enter = αποστολή, Tab = path complete)"
                : "Γράψε εντολή…  (Enter = run, Tab = autocomplete, Shift+Enter = νέα γραμμή)"
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
