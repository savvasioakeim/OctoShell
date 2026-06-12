import { useEffect, useRef, useState } from "react";
import type { Mode, ShellController } from "../shell/ShellController";
import { kindLabel, longestCommonPrefix, requestCompletion, type CMatch } from "../shell/completion";
import { PROVIDERS, type AgentProvider } from "../agents/providers";

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
  /** Selected agent model (null = CLI default). */
  agentModel: string | null;
  /** Which agent CLI drives this project. */
  agentProvider: AgentProvider;
  /** Cumulative token usage for this session's agent (null if unavailable). */
  agentTokens: { input: number; output: number; costUsd: number } | null;
}

/** Compact token count, e.g. 1234 → "1.2k", 45000 → "45k". */
function fmtTokens(n: number): string {
  if (n >= 10000) return Math.round(n / 1000) + "k";
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
const INPUT_MAX_PX = 220;

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
export function InputBar({ controller, cwd, busy, value, altScreen, interacting, mode, agentBusy, agentModel, agentProvider, agentTokens }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number>(-1);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [providerMenu, setProviderMenu] = useState(false);

  const agent = mode === "agent";
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

  const submit = () => {
    if (agent) {
      controller.runAgent(value);
      return;
    }
    if (busy) {
      controller.sendRaw(value + "\r"); // answer a running command's prompt
      controller.setInput("");
      return;
    }
    const v = value.trim();
    if (!v) return;
    setHistory((h) => [...h, v]);
    setHistIdx(-1);
    controller.submit(v);
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
    <div className="border-t border-edge bg-panel/80 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
        {/* Shell ⇄ Agent toggle */}
        <div className="flex overflow-hidden rounded border border-edge">
          <ModeBtn active={!agent} onClick={() => controller.setMode("shell")}>shell</ModeBtn>
          <ModeBtn active={agent} onClick={() => controller.setMode("agent")}>🐙 agent</ModeBtn>
        </div>

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

        {agent && agentTokens && (agentTokens.input > 0 || agentTokens.output > 0) && (
          <span
            className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted"
            title={`Σύνολο tokens αυτής της συνεδρίας${agentTokens.costUsd > 0 ? ` · ~$${agentTokens.costUsd.toFixed(3)}` : ""}`}
          >
            🪙 ↑{fmtTokens(agentTokens.input)} ↓{fmtTokens(agentTokens.output)}
          </span>
        )}
        <span className="truncate">{cwd || "~"}</span>
        {agent ? (
          agentBusy && <span className="text-accent">● {prov.label} σκέφτεται… (Ctrl+C ακύρωση)</span>
        ) : altScreen || interacting ? (
          <span className="text-accent">⌨ πληκτρολογείς στην εντολή πάνω — κλικ εδώ για νέα εντολή</span>
        ) : (
          busy && <span className="text-yellow-400">● running… (Enter → stdin · Ctrl+C interrupt)</span>
        )}
      </div>

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
          className={`flex items-end gap-2 rounded-lg border bg-card px-3 py-2.5 ${
            agent ? "border-accent/40 focus-within:border-accent" : "border-edge focus-within:border-accent/60"
          }`}
        >
          <span
            className="select-none font-semibold leading-relaxed text-accent"
            style={{ transform: "translateY(4px)" }}
          >
            {agent ? "✦" : "❯"}
          </span>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => { setMenu(null); controller.setInput(e.target.value); }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            placeholder={
              agent
                ? "Ρώτησε ή ανάθεσε στον claude…  (Enter = αποστολή, Tab = path complete)"
                : "Γράψε εντολή…  (Enter = run, Tab = autocomplete, Shift+Enter = νέα γραμμή)"
            }
            className="max-h-[220px] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-gray-100 caret-accent outline-none placeholder:text-muted/50"
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[11px] transition-colors ${
        active ? "bg-accent/30 text-accent" : "text-muted hover:bg-edge"
      }`}
    >
      {children}
    </button>
  );
}
