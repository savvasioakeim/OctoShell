import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AiClient, type ChatMessage } from "./AiClient";
import type { Block, CommandBlock, ShellController, ShellSnapshot } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import { Markdown } from "../blocks/Markdown";
import { parseActions, type OrchestratorAction } from "./actions";

/** Per-action lifecycle once the model proposed it (keyed `msgIndex:actionIndex`). */
type ActionState = "done" | "dismissed" | "error";

const client = new AiClient();

export interface ProjectRef {
  id: string;
  name: string;
  controller: ShellController;
}

interface Props {
  tabs: ProjectRef[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Width in px (user-resizable). */
  width: number;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)…" : s;
}

/** A compact, model-readable digest of a project's recent activity. */
function summarizeBlocks(blocks: Block[], max = 6): string {
  const recent = blocks.slice(-max).map((b) => {
    if (b.kind === "command") {
      return `$ ${b.command}  [${b.status}${b.exitCode ? ` ${b.exitCode}` : ""}]\n${truncate(b.outputText, 200)}`;
    }
    if (b.kind === "agentText") {
      const who = b.role === "user" ? "🧑 user" : `🤖 ${b.provider ?? "agent"}`;
      return `${who}: ${truncate(b.text, 300)}`;
    }
    return `🔧 ${b.toolName}: ${truncate(b.toolInput, 120)}${b.result ? `\n→ ${truncate(b.result, 150)}` : ""}`;
  });
  return recent.join("\n");
}

/** Subscribe to every project's store and re-render on any change. */
function useAllSnapshots(projects: ProjectRef[]): Map<string, ShellSnapshot> {
  const [, force] = useReducer((x) => x + 1, 0);
  const ids = projects.map((p) => p.id).join(",");
  useEffect(() => {
    const unsubs = projects.map((p) => p.controller.subscribe(force));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const map = new Map<string, ShellSnapshot>();
  for (const p of projects) map.set(p.id, p.controller.getSnapshot());
  return map;
}

/**
 * Workspace-wide AI assistant. It has live context of EVERY open project — the
 * terminal blocks and the agent's messages/tool-calls — so the user can ask
 * about and coordinate work across all of them from one place. The "Agents"
 * overview lets the user jump to a project or cancel a running agent.
 */
export function AiSidebar({ tabs, activeId, onSelect, width }: Props) {
  const snaps = useAllSnapshots(tabs);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadJSON<ChatMessage[]>(KEY.assistant, []));
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Which proposed actions the user already confirmed/dismissed — persisted so a
  // restart never re-shows a handled action as pending (and risks re-dispatch).
  const [actionState, setActionState] = useState<Record<string, ActionState>>(() =>
    loadJSON<Record<string, ActionState>>(KEY.actions, {}),
  );
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, thinking]);

  // Auto-grow the input like the main InputBar (chat-style, capped then scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  useEffect(() => {
    saveJSON(KEY.assistant, messages);
  }, [messages]);

  const buildSystem = useCallback((): string => {
    const sections = tabs
      .map((p) => {
        const snap = snaps.get(p.id);
        const status = `agent: ${snap?.agentBusy ? "running" : "idle"}, shell: ${snap?.busy ? "busy" : "idle"}`;
        const activeMark = p.id === activeId ? " (active)" : "";
        const body = snap && snap.blocks.length ? summarizeBlocks(snap.blocks) : "(no activity yet)";
        return `## ${p.name} — ${snap?.cwd || "(home)"} [${status}]${activeMark}\n${body}`;
      })
      .join("\n\n");
    const names = tabs.map((p) => p.name).join(", ") || "(none)";
    return [
      "You are OctoShell's workspace assistant for a Windows PowerShell dev environment.",
      "You can see every open project and what its terminal and its coding agent are doing.",
      "Help the user understand, compare and coordinate work across all projects. When suggesting shell commands, target PowerShell (pwsh).",
      // --- Orchestration protocol ---
      [
        "# Orchestration",
        "You can act as an orchestrator: propose tasks for the projects' coding agents to carry out, or cancel a running agent. You DO NOT run anything yourself — every action you propose is shown to the user as a confirmation card and only runs if they click it. So always also explain in prose what you're proposing and why.",
        "When (and only when) the user wants you to make an agent do work, or to coordinate/dispatch tasks, append ONE fenced block to your reply, exactly like:",
        "```octo-actions",
        '[{"action":"dispatch","project":"<exact project name>","prompt":"<clear, self-contained task for that project\'s agent>"}]',
        "```",
        "Rules:",
        "- Use the EXACT project names from the list below. Available projects: " + names + ".",
        '- "dispatch" sends a fresh prompt to that project\'s agent. Write the prompt as a complete instruction (the agent only sees that text, not this chat).',
        '- "cancel" stops a running agent: {"action":"cancel","project":"<name>"}.',
        "- Prefer dispatching to idle agents; don't interrupt a busy one unless the user asks.",
        "- Propose multiple actions (one array, multiple objects) to fan work across projects in parallel.",
        "- Emit the block ONLY when proposing real work. For plain questions, just answer — no block.",
      ].join("\n"),
      `# Open projects\n${sections}`,
    ].join("\n\n");
  }, [tabs, snaps, activeId]);

  const ask = useCallback(
    async (userText: string) => {
      const next = [...messages, { role: "user" as const, content: userText }];
      setMessages(next);
      setThinking(true);
      try {
        const reply = await client.chat(next, buildSystem());
        setMessages([...next, { role: "assistant", content: reply }]);
      } catch (err) {
        setMessages([...next, { role: "assistant", content: `⚠️ ${err}` }]);
      } finally {
        setThinking(false);
      }
    },
    [messages, buildSystem],
  );

  useEffect(() => {
    saveJSON(KEY.actions, actionState);
  }, [actionState]);

  /** Resolve a project the model named. Exact (case-insensitive) name first, then
   *  a substring match; among ties, prefer the one in the state the action needs
   *  (a running agent to cancel, an idle one to dispatch to). */
  const resolveProject = useCallback(
    (name: string, want: "idle" | "running"): ProjectRef | undefined => {
      const lc = name.toLowerCase().trim();
      const exact = tabs.filter((p) => p.name.toLowerCase().trim() === lc);
      const pool = exact.length ? exact : tabs.filter((p) => p.name.toLowerCase().includes(lc));
      if (!pool.length) return undefined;
      const byState = pool.find((p) => {
        const busy = !!snaps.get(p.id)?.agentBusy;
        return want === "running" ? busy : !busy;
      });
      return byState ?? pool[0];
    },
    [tabs, snaps],
  );

  /** Execute a confirmed action against the resolved project's controller. */
  const runAction = useCallback(
    (key: string, a: OrchestratorAction) => {
      const p = resolveProject(a.project, a.kind === "cancel" ? "running" : "idle");
      if (!p) {
        setActionState((s) => ({ ...s, [key]: "error" }));
        return;
      }
      if (a.kind === "dispatch") {
        p.controller.setMode("agent");
        p.controller.runAgent(a.prompt);
      } else {
        p.controller.cancelAgent();
      }
      onSelect(p.id);
      setActionState((s) => ({ ...s, [key]: "done" }));
    },
    [resolveProject, onSelect],
  );

  const dismissAction = useCallback((key: string) => {
    setActionState((s) => ({ ...s, [key]: "dismissed" }));
  }, []);

  // Route every project's per-block "Ask AI" button to this one assistant.
  useEffect(() => {
    for (const p of tabs) {
      p.controller.onAskAi = (block: CommandBlock) => {
        onSelect(p.id);
        const q =
          block.status === "error"
            ? `Στο project "${p.name}" αυτή η εντολή απέτυχε (exit ${block.exitCode}). Τι πήγε στραβά και πώς το διορθώνω;\n\n$ ${block.command}\n${truncate(block.outputText)}`
            : `Στο project "${p.name}", εξήγησε το output:\n\n$ ${block.command}\n${truncate(block.outputText)}`;
        void ask(q);
      };
    }
  }, [tabs, ask, onSelect]);

  return (
    <aside className="flex shrink-0 flex-col bg-panel" style={{ width }}>
      <div className="border-b border-edge px-3 py-2 text-sm font-semibold text-accent">🐙 Workspace Assistant</div>

      {/* Agents overview — status + jump + cancel across all projects. */}
      <div className="border-b border-edge px-3 py-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Agents</div>
        <div className="space-y-0.5">
          {tabs.map((p) => {
            const snap = snaps.get(p.id);
            const running = !!snap?.agentBusy;
            return (
              <div key={p.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-edge/50">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    running ? "bg-yellow-400 animate-pulse" : snap?.busy ? "bg-sky-400" : "bg-edge"
                  }`}
                />
                <button onClick={() => onSelect(p.id)} className="flex-1 truncate text-left text-gray-200">
                  {p.name}
                </button>
                <span className="text-[10px] text-muted">
                  {running ? "agent…" : snap?.busy ? "shell…" : "idle"}
                </span>
                {running && (
                  <button
                    onClick={() => p.controller.cancelAgent()}
                    title="Cancel agent"
                    className="rounded px-1 text-red-300 hover:bg-red-500/20"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {messages.length === 0 && (
          <div className="text-muted">
            Ρώτησέ με για οποιοδήποτε project — βλέπω τι τρέχει σε terminals και agents παντού.
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="whitespace-pre-wrap break-words rounded bg-edge/60 px-2 py-1.5">
                {m.content}
              </div>
            );
          }
          const { clean, actions } = parseActions(m.content);
          const pending = actions.filter((_, j) => !actionState[`${i}:${j}`]);
          return (
            <div key={i} className="rounded bg-accent/10 px-2 py-1.5">
              {clean && <Markdown text={clean} />}
              {actions.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {actions.map((a, j) => {
                    const key = `${i}:${j}`;
                    return (
                      <ActionCard
                        key={key}
                        action={a}
                        state={actionState[key]}
                        onConfirm={() => runAction(key, a)}
                        onDismiss={() => dismissAction(key)}
                      />
                    );
                  })}
                  {pending.length > 1 && (
                    <button
                      onClick={() =>
                        actions.forEach((a, j) => {
                          const key = `${i}:${j}`;
                          if (!actionState[key]) runAction(key, a);
                        })
                      }
                      className="w-full rounded bg-accent/20 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/30"
                    >
                      ▶ Run all ({pending.length})
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {thinking && <div className="rounded bg-accent/10 px-2 py-1.5 text-muted">…</div>}
      </div>

      <div className="border-t border-edge p-2">
        <div className="flex items-end gap-2 rounded-lg border border-accent/40 bg-card px-3 py-2.5 focus-within:border-accent">
          <span
            className="select-none font-semibold leading-relaxed text-accent"
            style={{ transform: "translateY(4px)" }}
          >
            ✦
          </span>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const v = input.trim();
                if (v) { void ask(v); setInput(""); }
              }
            }}
            placeholder="Ρώτησε για όλα τα projects…"
            className="max-h-[220px] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-gray-100 caret-accent outline-none placeholder:text-muted/50"
          />
        </div>
      </div>
    </aside>
  );
}

/** A single proposed orchestration action — a confirm/dismiss card, or its
 *  resolved outcome. Nothing runs until the user clicks Confirm. */
function ActionCard({
  action,
  state,
  onConfirm,
  onDismiss,
}: {
  action: OrchestratorAction;
  state?: ActionState;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const isDispatch = action.kind === "dispatch";

  if (state === "done") {
    return (
      <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-300">
        ✓ {isDispatch ? "Έστειλα task στο" : "Σταμάτησα τον agent στο"} <b>{action.project}</b>
      </div>
    );
  }
  if (state === "dismissed") {
    return (
      <div className="rounded border border-edge bg-edge/30 px-2 py-1.5 text-xs text-muted line-through">
        {isDispatch ? "Dispatch →" : "Cancel"} {action.project}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
        ⚠️ Δεν βρέθηκε project «{action.project}»
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent">
        <span>{isDispatch ? "🚀" : "🛑"}</span>
        <span>
          {isDispatch ? "Στείλε task στο" : "Σταμάτα τον agent στο"} {action.project}
        </span>
      </div>
      {isDispatch && (
        <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-well/60 px-2 py-1 text-xs text-gray-300">
          {action.prompt}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          onClick={onConfirm}
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/80"
        >
          ✓ Confirm
        </button>
        <button
          onClick={onDismiss}
          className="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge/50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
