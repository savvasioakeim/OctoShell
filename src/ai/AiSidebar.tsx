import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AiClient, type ChatMessage } from "./AiClient";
import type { Block, CommandBlock, ShellController, ShellSnapshot } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import { Markdown } from "../blocks/Markdown";
import { parseActions, type OrchestratorAction } from "./actions";
import { parseQa } from "../qa/parseQa";
import { openQaWindow } from "../qa/qaHost";
import type { QaItem, QaResult } from "../qa/qaTypes";
import { aggregateReviews, type ReviewSnapshot } from "../review/ReviewAgentController";
import { serviceStore } from "../services/serviceStore";
import { supportsProfile } from "../agents/providers";
import { useSettings } from "../settings/settingsStore";
import {
  statusOf,
  STATUS_COLOR,
  STATUS_SHORT,
  STATUS_ORDER,
  type AgentStatus,
} from "../shell/agentStatus";

/** Per-action lifecycle once the model proposed it (keyed `msgIndex:actionIndex`). */
type ActionState = "done" | "dismissed" | "error";

/** A Claude Code profile = a named `CLAUDE_CONFIG_DIR` (its own logged-in account). */
/** One saved assistant conversation. The active session's content is the live
 *  `messages`/`actionState`; the rest sit in storage until switched to. */
interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  actionState: Record<string, ActionState>;
}

/** First real user line → a short title (skips internal live-watch breadcrumbs). */
function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && !m.content.startsWith("👁"));
  return first ? first.content.replace(/\s+/g, " ").slice(0, 40) : "New chat";
}

/** Load chat sessions, migrating the legacy single-chat storage on first run. */
function loadSessions(): ChatSession[] {
  const saved = loadJSON<ChatSession[]>(KEY.assistantSessions, []);
  if (saved.length) return saved;
  const messages = loadJSON<ChatMessage[]>(KEY.assistant, []);
  const actionState = loadJSON<Record<string, ActionState>>(KEY.actions, {});
  return [{ id: crypto.randomUUID(), title: chatTitle(messages), updatedAt: Date.now(), messages, actionState }];
}

const client = new AiClient();

/** Max consecutive auto-continuations in live watch before pausing — a backstop
 *  against an agent/assistant ping-pong that never settles. Reset by any manual
 *  message. */
const MAX_AUTO_STEPS = 15;

/** Per-project digest cap (chars) so one busy project can't eat the whole budget. */
const PROJECT_DIGEST_CAP = 4000;
/** Hard ceiling on the assembled `system` string. Windows caps a process command
 *  line at ~32 KB; the context used to ride on argv, and even folded into the
 *  stdin prompt we keep it well under that to stay safe and cheap. */
const SYSTEM_CHAR_CAP = 28000;

export interface ProjectRef {
  id: string;
  name: string;
  controller: ShellController;
}

interface Props {
  tabs: ProjectRef[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Branch a fresh worktree off `sourceProjectId` and return it as its own
   *  session (its own controller/agent), or null on failure. Lets the orchestrator
   *  dispatch isolated work into a real, visible per-worktree agent. */
  onCreateWorktree?: (sourceProjectId: string, branch: string) => Promise<ProjectRef | null>;
  /** Close + git-remove a project/worktree by id (used by QA auto-clean). */
  onCloseProject?: (id: string) => void;
  /** Width in px (user-resizable). */
  width: number;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)…" : s;
}

/** A compact, model-readable digest of a project's recent activity. */
function summarizeBlocks(blocks: Block[], max = 8): string {
  const recent = blocks.slice(-max).map((b) => {
    if (b.kind === "command") {
      return `$ ${b.command}  [${b.status}${b.exitCode ? ` ${b.exitCode}` : ""}]\n${truncate(b.outputText, 300)}`;
    }
    if (b.kind === "agentText") {
      const who = b.role === "user" ? "🧑 user" : `🤖 ${b.provider ?? "agent"}`;
      return `${who}: ${truncate(b.text, 500)}`;
    }
    if (b.kind === "agentApproval") {
      return `🛡 approval (${b.status}) ${b.toolName}: ${truncate(b.toolInput, 160)}`;
    }
    return `🔧 ${b.toolName}: ${truncate(b.toolInput, 160)}${b.result ? `\n→ ${truncate(b.result, 300)}` : ""}`;
  });
  return recent.join("\n");
}

/** The agent's last written reply in a project — its own report of what it just
 *  did (PR URLs, commit hashes, "done" claims) — plus WHEN it was produced. The
 *  timestamp lets the caller tell a fresh result from one left over from a
 *  PREVIOUS task (the report is "the last assistant message", which stays the old
 *  one until a freshly-dispatched turn writes its own). */
function lastAgentReport(blocks: Block[], max = 1500): { text: string; at: number } | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "agentText" && b.role === "assistant") return { text: truncate(b.text, max), at: b.startedAt };
  }
  return null;
}

/** When the agent was last handed a prompt (user/orchestrator dispatch). If this
 *  is newer than {@link lastAgentReport}, the report predates the in-flight task
 *  and must NOT be read as that task's result. */
function lastDispatchAt(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "agentText" && b.role === "user") return b.startedAt;
  }
  return 0;
}

/** Compact relative age ("12s ago" / "3m ago" / "1h ago") for context labels. */
function fmtAge(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
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

/** Subscribe to every project's REVIEW-agent store and re-render on any change —
 *  so the QA-handoff watcher sees verdicts land in real time. */
function useAllReviews(projects: ProjectRef[]): Map<string, ReviewSnapshot> {
  const [, force] = useReducer((x) => x + 1, 0);
  const ids = projects.map((p) => p.id).join(",");
  useEffect(() => {
    const unsubs = projects.map((p) => p.controller.review.subscribe(force));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const map = new Map<string, ReviewSnapshot>();
  for (const p of projects) map.set(p.id, p.controller.review.getSnapshot());
  return map;
}

/**
 * Workspace-wide AI assistant. It has live context of EVERY open project — the
 * terminal blocks and the agent's messages/tool-calls — so the user can ask
 * about and coordinate work across all of them from one place. The "Agents"
 * overview lets the user jump to a project or cancel a running agent.
 */
export function AiSidebar({ tabs, activeId, onSelect, onCreateWorktree, onCloseProject, width }: Props) {
  const snaps = useAllSnapshots(tabs);
  const reviews = useAllReviews(tabs);
  // Chat sessions: the active session's content IS the live messages/actionState,
  // so "New chat" clears the view without losing history.
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [chatId, setChatId] = useState<string>(() => sessions[0].id);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => sessions[0].messages);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Which proposed actions the user already confirmed/dismissed — persisted so a
  // restart never re-shows a handled action as pending (and risks re-dispatch).
  const [actionState, setActionState] = useState<Record<string, ActionState>>(() => sessions[0].actionState);
  // Autonomy toggles (persisted). `autoRun`: proposed actions run without a click.
  // `liveWatch`: after a dispatch, keep driving the plan — each time a watched
  // agent finishes a turn, the assistant is auto-pinged to take the next step.
  const flags0 = loadJSON<{ autoRun?: boolean; liveWatch?: boolean }>(KEY.orchestrator, {});
  const [autoRun, setAutoRun] = useState(!!flags0.autoRun);
  const [liveWatch, setLiveWatch] = useState(!!flags0.liveWatch);
  // Orchestrator model + Claude Code profile come from the shared settings store
  // (so the Settings page and this picker stay in sync).
  const settings = useSettings();
  const profiles = settings.profiles;
  const aiProvider = settings.orchestrator.provider;
  const aiModel = settings.orchestrator.model;
  const profileId = settings.orchestrator.profileId;
  // Height of the Agents status panel — drag the divider below it to resize, so a
  // long agent list and the chat can share the column however the user wants.
  const [agentsPanelH, setAgentsPanelH] = useState<number>(() => loadJSON(KEY.agentsPanelH, 180));
  // Status filter for the Agents panel ("all" = no filter).
  const [agentFilter, setAgentFilter] = useState<AgentStatus | "all">("all");
  useEffect(() => { saveJSON(KEY.agentsPanelH, agentsPanelH); }, [agentsPanelH]);
  // The orchestrator's account (CLAUDE_CONFIG_DIR) for the claude transport — its
  // provider/model/profile are configured in Settings, not from a header picker.
  const activeProfile = profiles.find((p) => p.id === profileId) ?? null;

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Project ids the orchestrator dispatched to and is now watching.
  const watchedRef = useRef<Set<string>>(new Set());
  // Last-seen agentBusy per project, to detect a busy→idle (turn finished) edge.
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());
  // Action keys already auto-run, so the auto-run effect fires each once.
  const autoRanRef = useRef<Set<string>>(new Set());
  // Auto-continuation steps since the last manual message — a runaway backstop.
  const autoStepsRef = useRef(0);
  // True between firing a watch continuation and consuming its reply (so a reply
  // with no actions can end the watch — "plan complete").
  const consumedContinuationRef = useRef(false);
  // Latest liveWatch, read inside the stable runAction callback.
  const liveWatchRef = useRef(liveWatch);
  liveWatchRef.current = liveWatch;
  // Guards the one-shot reconcile so it runs once per mount, after tabs exist.
  const reconciledRef = useRef(false);
  // The in-flight orchestrator turn's id (so Stop can cancel it), and the set of
  // ids the user cancelled (so their late-arriving result/error is discarded).
  const currentReqRef = useRef<string | null>(null);
  const cancelledReqRef = useRef<Set<string>>(new Set());
  // Latest "over the spend limit" flag, read inside the stable runAction to block
  // new dispatches once the brake has tripped.
  const overSpendRef = useRef(false);
  // One-shot guard so the spend brake fires stopAll once (re-arms when back under).
  const spendTrippedRef = useRef(false);

  // Persist the live-watch set + step counter so a dev-server reload or crash
  // doesn't silently drop the agents we're following (the refs themselves are
  // ephemeral). Call after every mutation of watchedRef/autoStepsRef.
  const saveWatch = useCallback(() => {
    saveJSON(KEY.watch, { ids: [...watchedRef.current], steps: autoStepsRef.current });
  }, []);

  useEffect(() => {
    saveJSON(KEY.orchestrator, { autoRun, liveWatch });
    if (!liveWatch) {
      watchedRef.current.clear();
      prevBusyRef.current.clear();
      autoStepsRef.current = 0;
    } else {
      // Turning watch on mid-flight: adopt any agent that's already running, so a
      // task dispatched before flipping the toggle still gets followed.
      for (const p of tabs) {
        if (p.controller.getSnapshot().agentBusy) {
          watchedRef.current.add(p.id);
          prevBusyRef.current.set(p.id, true);
        }
      }
    }
    saveWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, liveWatch]);

  // Reconcile after a reload/crash: the busy→idle edge the watcher relies on can
  // be lost if the component remounts while a watched agent runs (or finishes
  // while we're gone). Restore the persisted watch set, re-seed prevBusy from the
  // agents' REAL current state, and if a watched agent already went idle while we
  // were away, resume the plan now instead of stalling silently.
  useEffect(() => {
    if (reconciledRef.current || !tabs.length) return;
    reconciledRef.current = true;
    if (!liveWatch) return;
    const saved = loadJSON<{ ids: string[]; steps: number }>(KEY.watch, { ids: [], steps: 0 });
    if (!saved.ids.length) return;
    autoStepsRef.current = saved.steps;
    let finished: ProjectRef | undefined;
    for (const p of tabs) {
      if (!saved.ids.includes(p.id)) continue;
      const busy = !!p.controller.getSnapshot().agentBusy;
      watchedRef.current.add(p.id);
      prevBusyRef.current.set(p.id, busy);
      // Idle + still in the watch set = its completion was never consumed.
      if (!busy && !finished) finished = p;
    }
    saveWatch();
    if (finished && !thinking) continueAfterAgent(finished.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, liveWatch]);

  // Keep the newest orchestrator message in view. Markdown/code highlighting can
  // grow the content a frame or two AFTER this runs, so scroll now and again on
  // the next frame + a short delay, otherwise we land short of the real bottom.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const toBottom = () => el.scrollTo({ top: el.scrollHeight });
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    const t = setTimeout(toBottom, 140);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [messages, thinking]);

  // Auto-grow the input like the main InputBar (chat-style, capped then scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  // Sync the live messages/actionState into the active session and persist the
  // whole session list (replaces the old single-chat persistence).
  useEffect(() => {
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === chatId ? { ...s, messages, actionState, updatedAt: Date.now(), title: chatTitle(messages) } : s,
      );
      saveJSON(KEY.assistantSessions, next);
      return next;
    });
  }, [messages, actionState, chatId]);

  /** Start a fresh conversation (the current one stays saved in the list). */
  const newChat = useCallback(() => {
    const s: ChatSession = { id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now(), messages: [], actionState: {} };
    setSessions((prev) => {
      const next = [s, ...prev];
      saveJSON(KEY.assistantSessions, next);
      return next;
    });
    setChatId(s.id);
    setMessages([]);
    setActionState({});
    setSessionMenu(false);
    // Reset orchestration runtime state so the fresh chat starts clean.
    autoStepsRef.current = 0;
    watchedRef.current.clear();
    prevBusyRef.current.clear();
    consumedContinuationRef.current = false;
    saveWatch();
  }, [saveWatch]);

  /** Switch to an existing session (the current one is already synced to storage). */
  const switchChat = useCallback(
    (id: string) => {
      setSessionMenu(false);
      if (id === chatId) return;
      const target = sessions.find((s) => s.id === id);
      if (!target) return;
      setChatId(id);
      setMessages(target.messages);
      setActionState(target.actionState);
    },
    [chatId, sessions],
  );

  /** Delete a session; if it was active, fall back to the newest remaining one. */
  const deleteChat = useCallback(
    (id: string) => {
      setSessions((prev) => {
        let next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          next = [{ id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now(), messages: [], actionState: {} }];
        }
        saveJSON(KEY.assistantSessions, next);
        if (id === chatId) {
          const f = next[0];
          setChatId(f.id);
          setMessages(f.messages);
          setActionState(f.actionState);
        }
        return next;
      });
      setSessionMenu(false);
    },
    [chatId],
  );

  const buildSystem = useCallback((): string => {
    // Only digest projects worth the bytes: the ones the user actually touched this
    // session (ran a command/agent in) plus the active tab. Digesting all 15 open
    // projects bloated the context past Windows' ~32 KB command-line cap and pushed
    // claude.exe over the edge (os error 206); it was also mostly noise.
    const relevant = tabs.filter((p) => {
      const snap = snaps.get(p.id);
      return p.id === activeId || !!snap?.touched;
    });
    const sections = relevant
      .map((p) => {
        const snap = snaps.get(p.id);
        const status = `agent: ${snap?.agentBusy ? "running" : "idle"}, shell: ${snap?.busy ? "busy" : "idle"}`;
        const activeMark = p.id === activeId ? " (active)" : "";
        const body = snap && snap.blocks.length ? summarizeBlocks(snap.blocks) : "(no activity yet)";
        // The agent's last written report in full — the authoritative outcome the
        // orchestrator must trust (PR URLs, hashes, done-claims) — but ONLY if it's
        // actually from the latest turn. Stamp it with its age and flag it when a
        // newer task was dispatched after it (then the report is from the PREVIOUS
        // task, not the running one) so the orchestrator never reads a stale report
        // as the current result and re-dispatches or "completes" wrongly.
        const report = snap?.blocks.length ? lastAgentReport(snap.blocks, 1000) : null;
        let reportLine = "";
        if (report) {
          const stale = report.at < lastDispatchAt(snap!.blocks);
          const flag = stale
            ? snap?.agentBusy
              ? " ⚠️ STALE — agent is RUNNING a newer task; this is from BEFORE it, NOT the current result. Wait for the new report; don't treat the task as done."
              : " ⚠️ STALE — a newer task was dispatched after this report; it may not reflect the latest state."
            : snap?.agentBusy
              ? " (turn still in progress — may be partial)"
              : "";
          reportLine = `\n📋 agent's last report (${fmtAge(report.at)})${flag}: ${report.text}`;
        }
        const digest = `## ${p.name} — ${snap?.cwd || "(home)"} [${status}]${activeMark}\n${body}${reportLine}`;
        // Cap each project's digest so one chatty project can't dominate the budget.
        return truncate(digest, PROJECT_DIGEST_CAP);
      })
      .join("\n\n");
    // Names list still covers EVERY open project so the orchestrator can dispatch to
    // any of them by exact name, even ones we didn't digest.
    const names = tabs.map((p) => p.name).join(", ") || "(none)";
    const system = [
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
        ...(settings.workspace.orchestratorWorktrees
          ? ['- ISOLATED WORK → add a "branch": {"action":"dispatch","project":"<repo>","branch":"<branch-name>","prompt":"…"}. OctoShell then creates a git worktree off that repo as its OWN project (visible in the sidebar) with its OWN dedicated agent, and runs the prompt there. Use this for any task that should be isolated or run in parallel (e.g. a PR/feature per branch). Then DO NOT instruct the agent to run `git worktree add` itself — that makes an invisible folder handled by the wrong agent; let the "branch" field do it. Fan out parallel work as several branch-dispatches off the same repo, one per branch.']
          : ['- WORKTREES ARE DISABLED in settings: do NOT use the "branch" field. Dispatch every task directly to the named project\'s own agent. If two tasks target the same project, run them sequentially (don\'t interrupt a busy agent).']),
        '- "cancel" stops a running agent: {"action":"cancel","project":"<name>"}.',
        "- Prefer dispatching to idle agents; don't interrupt a busy one unless the user asks.",
        "- NEVER instruct an agent to start a long-running server (`npm run dev`, `next dev`, `vite`, etc.) — a blocking server never returns, so the agent's turn hangs forever. Agents should only build/commit/test-with-exit. Running servers is OctoShell's job: the user (or QA mode) starts them as managed services with their own port. If a task needs a live server, say so in prose and let OctoShell run it — don't put it in a dispatch prompt.",
        "- Propose multiple actions (one array, multiple objects) to fan work across projects in parallel.",
        "- Emit the block ONLY when proposing real work. For plain questions, just answer — no block.",
        "- TRUST the agents' reported results in the context. Never dispatch a task whose only purpose is to re-verify or re-confirm something an agent already reported done (e.g. don't ask 'did the PR get created?' if the agent said it created it). Read the context, believe it, and only dispatch a genuinely NEW next step.",
        "- You are talking to the USER, not to the agents. Your prose is shown to the user; the agents only ever receive the exact `prompt` text inside a dispatch. So write your replies as updates to the user, and make dispatch prompts fully self-contained.",
        // --- Output style (your replies render as Markdown) ---
        "- FORMAT plans and multi-task status as a clean Markdown list — never a wall of prose. When you present steps or report progress across several tasks, use a numbered list (for an ordered plan) or bullets (for parallel work), ONE item per step/task. Start each item with a bold label and a status emoji, e.g. `1. **tracking-config-admin** (ridebly-fe) — ✅ done`, `2. **tracking-config-be** — 🔄 in progress`, `3. **client-injection** — ⏳ queued`. Add at most a short half-line of detail after the dash. Use ✅ done · 🔄 in progress · ⏳ pending/queued · ❌ failed.",
        "- Keep the surrounding prose tight: a one-line intro before the list and a one-line next-step after it. Use `**bold**` for project/branch names and short `code` spans for commands, files and ports so they stand out.",
        "- QA MODE: when the tasks you dispatched are DONE and there's something the user should manually verify, ask in prose if they want to QA, and append a separate ```octo-qa fenced block — a JSON array, one object per feature: {\"title\":\"…\",\"branch\":\"<worktree branch>\",\"project\":\"<repo>\",\"startCommand\":\"<command that starts its dev server, e.g. npm run dev>\",\"whatToCheck\":\"<what the user should look at / how to test>\"}. OctoShell shows an \"Open QA Mode\" button that walks the user feature-by-feature (approve/decline + notes) and can start each server for them. You learned the ticket and what changed — put the concrete check steps in whatToCheck. Emit this block ONLY when there's real, finished work to QA.",
        "- QA BACKEND: if a feature can't be tested without a backend running (e.g. a frontend feature that calls an API), add a \"backend\" field to that item: {\"backend\":{\"project\":\"<backend repo name>\",\"command\":\"<command that starts the backend, e.g. npm run dev>\"}}. The QA window then shows a second \"backend\" start button. OctoShell runs it from the worktree on the SAME branch if one exists, otherwise from the backend repo's base branch — so you only need to name the backend repo and its start command, not a path.",
        ...(autoRun
          ? ["- AUTONOMOUS MODE: your actions run automatically (no user click). Don't ask for confirmation — just propose them and they execute."]
          : []),
        ...(liveWatch
          ? [
              "- LIVE WATCH is on: after an agent finishes a turn you'll automatically be pinged to continue. Drive the whole task to completion across turns — each ping, evaluate the latest result and dispatch the NEXT concrete step (e.g. for a PR flow: make the change & open the PR, then on the next turn review/fix, then verify). When everything is truly complete, say so plainly and emit NO actions block — that ends the loop.",
            ]
          : []),
        ...(settings.reviewAgent.enabled
          ? [
              "- REVIEW AGENT is enabled: after a coding agent finishes a dispatched task, OctoShell automatically runs an independent review agent over its diff BEFORE any QA. Therefore do NOT emit an ```octo-qa block on your own initiative. When every review has passed with no blocking issues, OctoShell pings you with `👁 (review agents)` — ONLY then offer QA. If a review finds a blocking problem, the user resolves it with the review agent first; just keep driving the plan and don't offer QA.",
            ]
          : []),
      ].join("\n"),
      // User's global rules apply to the orchestrator too (the agents get them
      // via the dispatch prompt — see ShellController).
      ...(settings.globalRules.trim()
        ? [`# Global rules (from the user — always honour these)\n${settings.globalRules.trim()}`]
        : []),
      `# Open projects\n${sections}`,
    ].join("\n\n");
    // Final safeguard: never let the context blow past the cap, no matter how many
    // projects got touched. Trim from the end (project digests live there) with a
    // visible note rather than risk overflowing downstream.
    return system.length > SYSTEM_CHAR_CAP
      ? system.slice(0, SYSTEM_CHAR_CAP) + "\n\n…(context truncated to fit limit)…"
      : system;
  }, [tabs, snaps, activeId, autoRun, liveWatch, settings.globalRules, settings.workspace.orchestratorWorktrees]);

  const ask = useCallback(
    async (userText: string) => {
      const next = [...messages, { role: "user" as const, content: userText }];
      setMessages(next);
      setThinking(true);
      const reqId = crypto.randomUUID();
      currentReqRef.current = reqId;
      try {
        const reply = await client.chat(next, buildSystem(), {
          provider: aiProvider,
          model: aiModel,
          // A profile (config/account dir) applies to any provider that has one
          // (Claude native + Claude/Codex/Cursor/Copilot/OpenCode via ACP).
          configDir: supportsProfile(aiProvider) ? activeProfile?.configDir ?? null : null,
          requestId: reqId,
          // Local orchestrator (acp-ollama): talk straight to Ollama's HTTP API.
          baseUrl: aiProvider === "acp-ollama" ? settings.ollama.baseUrl : null,
          numCtx: aiProvider === "acp-ollama" ? settings.ollama.contextWindow : null,
          temperature: aiProvider === "acp-ollama" ? settings.ollama.temperature : null,
        });
        if (cancelledReqRef.current.has(reqId)) return; // user pressed Stop
        setMessages([...next, { role: "assistant", content: reply }]);
      } catch (err) {
        if (cancelledReqRef.current.has(reqId)) return;
        setMessages([...next, { role: "assistant", content: `⚠️ ${err}` }]);
      } finally {
        cancelledReqRef.current.delete(reqId);
        if (currentReqRef.current === reqId) {
          currentReqRef.current = null;
          setThinking(false);
        }
      }
    },
    [messages, buildSystem, aiProvider, aiModel, profileId, profiles],
  );

  /** Emergency stop — like hitting Escape on the whole workspace. Cancels the
   *  orchestrator's in-flight turn AND every running agent, and stops the live-
   *  watch loop so nothing auto-continues. */
  const stopAll = useCallback(() => {
    const id = currentReqRef.current;
    if (id) {
      cancelledReqRef.current.add(id);
      void client.cancel(id);
      currentReqRef.current = null;
    }
    setThinking(false);
    // Halt the autonomy loop so a finished agent can't re-ping the orchestrator.
    watchedRef.current.clear();
    autoStepsRef.current = 0;
    consumedContinuationRef.current = false;
    saveWatch();
    // Stop every agent that's currently working.
    for (const p of tabs) {
      if (p.controller.getSnapshot().agentBusy) p.controller.cancelAgent();
    }
  }, [tabs, saveWatch]);


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

  /** Start watching a freshly-dispatched agent in live watch (follow to finish). */
  const watchDispatched = useCallback(
    (id: string) => {
      if (!liveWatchRef.current) return;
      watchedRef.current.add(id);
      prevBusyRef.current.set(id, true); // it's about to be busy
      saveWatch();
    },
    [saveWatch],
  );

  /** Execute a confirmed action against the resolved project's controller. */
  const runAction = useCallback(
    async (key: string, a: OrchestratorAction) => {
      // Spend brake: refuse NEW agent work once the session cost limit is hit
      // (cancels still go through).
      if (a.kind === "dispatch" && overSpendRef.current) {
        setActionState((s) => ({ ...s, [key]: "error" }));
        return;
      }
      // Worktree dispatch: branch a fresh, isolated session off the named project
      // and run the agent THERE — so it shows in the bar and gets its OWN agent,
      // instead of the named project's single agent doing work across worktrees.
      if (a.kind === "dispatch" && a.branch) {
        const src = resolveProject(a.project, "idle");
        if (!src || !onCreateWorktree) {
          setActionState((s) => ({ ...s, [key]: "error" }));
          return;
        }
        const wt = await onCreateWorktree(src.id, a.branch);
        if (!wt) {
          setActionState((s) => ({ ...s, [key]: "error" }));
          return;
        }
        wt.controller.setMode("agent");
        wt.controller.runAgent(a.prompt, { orchestrated: true });
        watchDispatched(wt.id);
        onSelect(wt.id);
        setActionState((s) => ({ ...s, [key]: "done" }));
        return;
      }

      const p = resolveProject(a.project, a.kind === "cancel" ? "running" : "idle");
      if (!p) {
        setActionState((s) => ({ ...s, [key]: "error" }));
        return;
      }
      if (a.kind === "dispatch") {
        p.controller.setMode("agent");
        p.controller.runAgent(a.prompt, { orchestrated: true });
        watchDispatched(p.id);
      } else {
        p.controller.cancelAgent();
      }
      onSelect(p.id);
      setActionState((s) => ({ ...s, [key]: "done" }));
    },
    [resolveProject, onSelect, onCreateWorktree, watchDispatched],
  );

  const dismissAction = useCallback((key: string) => {
    setActionState((s) => ({ ...s, [key]: "dismissed" }));
  }, []);

  /** Resolve the open worktree/project a QA item refers to (by branch, then
   *  project name). Worktree tabs are named after the sanitized branch. */
  const resolveByBranch = useCallback(
    (item: QaItem): ProjectRef | undefined => {
      const cands = [item.branch, item.project].filter(Boolean).map((s) => s!.toLowerCase().trim());
      for (const c of cands) {
        const exact = tabs.find((p) => p.name.toLowerCase().trim() === c);
        if (exact) return exact;
        const partial = tabs.find(
          (p) => p.name.toLowerCase().includes(c) || c.includes(p.name.toLowerCase()),
        );
        if (partial) return partial;
      }
      return undefined;
    },
    [tabs],
  );

  /** Reviewer finished: batch the outcomes into fresh dispatches — declines (and
   *  approvals that carry a note) become a fix task on that feature's branch agent;
   *  clean approvals and skips do nothing. Then post a summary to the chat. */
  const finishQa = useCallback(
    (results: QaResult[], items: QaItem[]) => {
      const byId = new Map(items.map((i) => [i.id, i]));
      const cleaned: string[] = [];
      const failed: string[] = [];
      const autoClean = settings.workspace.autoClean;
      // Several QA items usually live on the SAME worktree (one branch, many
      // tickets). Dispatching them one-by-one only landed the FIRST — the agent
      // was then busy and every later orchestrated runAgent was refused. So
      // group all fix prompts per tab and send ONE combined dispatch.
      const perTab = new Map<string, { tab: ProjectRef; prompts: string[]; titles: string[] }>();
      for (const r of results) {
        const item = byId.get(r.id);
        if (!item) continue;
        const notes = r.notes?.trim();
        let prompt: string | null = null;
        if (r.verdict === "decline") {
          prompt = `The feature "${item.title}" did NOT pass QA.${notes ? ` Problem: ${notes}.` : ""} Fix it completely. What was being checked: ${item.whatToCheck}`;
        } else if (r.verdict === "approve" && notes) {
          prompt = `The feature "${item.title}" passed QA with one note: ${notes}. Apply that tweak and nothing else.`;
        }
        if (prompt) {
          const tab = resolveByBranch(item);
          if (!tab) {
            failed.push(`${item.title} (no worktree found)`);
            continue;
          }
          const g = perTab.get(tab.id) ?? { tab, prompts: [], titles: [] };
          g.prompts.push(prompt);
          g.titles.push(item.title);
          perTab.set(tab.id, g);
          continue;
        }
        // CLEAN approve (no fix follow-up) → optionally auto-remove its worktree.
        if (r.verdict === "approve" && autoClean === "onApprove" && onCloseProject) {
          const tab = resolveByBranch(item);
          if (tab && item.branch) {
            onCloseProject(tab.id);
            cleaned.push(item.title);
          }
        }
      }
      const dispatched: string[] = [];
      for (const { tab, prompts, titles } of perTab.values()) {
        const prompt =
          prompts.length === 1
            ? prompts[0]
            : `QA produced ${prompts.length} fixes — do ALL of them:\n\n` +
              prompts.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
        tab.controller.setMode("agent");
        if (tab.controller.runAgent(prompt, { orchestrated: true })) {
          watchDispatched(tab.id);
          dispatched.push(...titles);
        } else {
          failed.push(...titles.map((t) => `${t} (the agent in "${tab.name}" was busy)`));
        }
      }
      // The summary doubles as the orchestrator's ONLY record of the QA: it
      // reads the chat history, so verdicts AND the reviewer's notes must be in
      // it (they used to vanish — the orchestrator never saw the notes).
      const lines = results
        .map((r) => {
          const item = byId.get(r.id);
          if (!item) return null;
          const v = r.verdict === "approve" ? "✓ approve" : r.verdict === "decline" ? "✗ decline" : "— no verdict";
          const notes = r.notes?.trim();
          return `- **${item.title}** — ${v}${notes ? ` · note: ${notes}` : ""}`;
        })
        .filter(Boolean)
        .join("\n");
      const summary =
        `🔍 _(automated system note — not an orchestrator reply)_ QA finished:\n${lines || "- (no results)"}` +
        (dispatched.length ? `\n\n🚀 Dispatched fixes: ${dispatched.join(", ")}.` : "") +
        (failed.length ? `\n\n⚠️ NOT dispatched: ${failed.join(", ")}.` : "") +
        (cleaned.length ? `\n\n🧹 Cleaned up worktrees: ${cleaned.join(", ")}.` : "");
      setMessages((m) => [...m, { role: "assistant", content: summary }]);
    },
    [resolveByBranch, watchDispatched, settings.workspace.autoClean, onCloseProject],
  );

  /** Resolve which open project a feature's BACKEND should run from: prefer a
   *  worktree on the SAME branch that belongs to the backend repo (matched via its
   *  working dir), else fall back to the backend repo's base project. */
  const resolveBackend = useCallback(
    (item: QaItem): ProjectRef | undefined => {
      const be = item.backend?.project?.toLowerCase().trim();
      if (!be) return undefined;
      const branch = item.branch?.toLowerCase().trim();
      if (branch) {
        const wt = tabs.find((p) => {
          const n = p.name.toLowerCase().trim();
          const cwd = p.controller.getCwd().toLowerCase();
          return (n === branch || n.includes(branch)) && cwd.includes(be);
        });
        if (wt) return wt;
      }
      return (
        tabs.find((p) => p.name.toLowerCase().trim() === be) ??
        tabs.find((p) => p.name.toLowerCase().includes(be))
      );
    },
    [tabs],
  );

  /** Open the floating QA window for these items, wiring server-start (both the
   *  feature's own server and any backend it needs) and the finish handler. */
  const startQa = useCallback(
    (items: QaItem[]) => {
      void openQaWindow(items, {
        onStartServer: async (item, role) => {
          if (role === "backend") {
            if (!item.backend) return undefined;
            const tab = resolveBackend(item);
            if (!tab) return undefined;
            const { url } = await serviceStore.start({
              name: `${tab.name} (backend)`,
              cwd: tab.controller.getCwd(),
              command: item.backend.command,
            });
            return url;
          }
          if (!item.startCommand) return undefined;
          const tab = resolveByBranch(item);
          if (!tab) return undefined;
          const { url } = await serviceStore.start({
            name: tab.name,
            cwd: tab.controller.getCwd(),
            command: item.startCommand,
          });
          return url;
        },
        onClosed: (results) => finishQa(results, items),
      });
    },
    [resolveByBranch, resolveBackend, finishQa],
  );

  /** A watched agent finished a turn — ping the assistant to continue the plan. */
  const continueAfterAgent = useCallback(
    (name: string) => {
      if (autoStepsRef.current >= MAX_AUTO_STEPS) {
        watchedRef.current.clear();
        saveWatch();
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: `⏹️ Stopped live watch (limit of ${MAX_AUTO_STEPS} automatic steps). Say "continue" if you want more.`,
          },
        ]);
        return;
      }
      autoStepsRef.current += 1;
      saveWatch();
      consumedContinuationRef.current = true;
      // Keep this message SHORT — the agent's actual report lives in the freshly
      // rebuilt system digest below (which never accumulates), so embedding it
      // here would bloat the thread every turn (and overflow the CLI prompt).
      void ask(
        `👁 (live watch) The agent in "${name}" finished a turn. Read its latest report in the projects context, TRUST it, and advance the plan: dispatch ONLY the real next step — or, if everything is complete, reply briefly to the user WITHOUT an actions block.`,
      );
    },
    [ask, saveWatch],
  );

  // Auto-run proposed actions (when enabled) and detect plan completion. Runs on
  // every new assistant message; each action fires at most once (autoRanRef).
  useEffect(() => {
    const i = messages.length - 1;
    const m = messages[i];
    if (!m || m.role !== "assistant") return;
    const { actions } = parseActions(m.content);

    if (autoRun) {
      actions.forEach((a, j) => {
        const key = `${i}:${j}`;
        if (!actionState[key] && !autoRanRef.current.has(key)) {
          autoRanRef.current.add(key);
          runAction(key, a);
        }
      });
    }

    // A watch continuation that proposes no new step usually just means "nothing
    // more to dispatch right now". Only treat it as plan-complete when NO watched
    // agent is still running — otherwise the agents still in flight must stay in
    // the watch set so their completion re-pings us. (Clearing it unconditionally
    // here was the bug where remaining parallel agents finished into silence.)
    if (consumedContinuationRef.current) {
      consumedContinuationRef.current = false;
      if (actions.length === 0) {
        const stillRunning = [...watchedRef.current].some(
          (id) => !!tabs.find((t) => t.id === id)?.controller.getSnapshot().agentBusy,
        );
        if (!stillRunning) {
          watchedRef.current.clear();
          autoStepsRef.current = 0;
          saveWatch();
        }
      }
    }
  }, [messages, autoRun, actionState, runAction, saveWatch, tabs]);

  // Live watch: when a watched agent goes busy→idle, continue the plan. No dep
  // array — it inspects the freshest snapshots on each render (the snapshot store
  // re-renders us whenever an agent's busy state flips).
  useEffect(() => {
    for (const p of tabs) {
      if (!watchedRef.current.has(p.id)) continue;
      const busy = !!snaps.get(p.id)?.agentBusy;
      const prev = prevBusyRef.current.get(p.id) ?? false;
      // Preserve a busy→idle edge we can't act on yet: while the orchestrator is
      // mid-turn (thinking) we can't fire a continuation, so DON'T overwrite prev
      // — otherwise the edge is lost and that agent's completion goes unnoticed.
      // When thinking clears, this effect re-runs and the edge fires then.
      if (prev && !busy && thinking) continue;
      prevBusyRef.current.set(p.id, busy);
      if (prev && !busy && liveWatch && !thinking) {
        continueAfterAgent(p.name);
        break; // one continuation per settle
      }
    }
  });

  // QA handoff (event-driven): when the review agent is enabled and EVERY active
  // review has finished with no blocking findings, ping the orchestrator ONCE to
  // offer QA. A blocking finding (or a review still running) holds the gate — the
  // user resolves it in the project's Review view first. No dep array: it reads the
  // freshest review snapshots (the review store re-renders us on every change).
  const reviewReadyRef = useRef(false);
  useEffect(() => {
    if (!settings.reviewAgent.enabled) return;
    const agg = aggregateReviews([...reviews.values()]);
    if (agg.readyForQa && !reviewReadyRef.current && !thinking) {
      reviewReadyRef.current = true;
      void ask(
        "👁 (review agents) All automated code reviews finished with NO blocking issues. If the dispatched work is complete, tell the user briefly and offer QA — emit an ```octo-qa block for the finished features.",
      );
    } else if (!agg.anyActive || agg.pending > 0 || agg.blocking.length > 0) {
      reviewReadyRef.current = false; // re-arm once reviews are running/gone/blocking
    }
  });

  // Route every project's per-block "Ask AI" button to this one assistant.
  useEffect(() => {
    for (const p of tabs) {
      p.controller.onAskAi = (block: CommandBlock) => {
        onSelect(p.id);
        const q =
          block.status === "error"
            ? `In project "${p.name}" this command failed (exit ${block.exitCode}). What went wrong and how do I fix it?\n\n$ ${block.command}\n${truncate(block.outputText)}`
            : `In project "${p.name}", explain this output:\n\n$ ${block.command}\n${truncate(block.outputText)}`;
        autoStepsRef.current = 0;
        saveWatch();
        void ask(q);
      };
    }
  }, [tabs, ask, onSelect, saveWatch]);

  // How many watched agents are currently working — the compact live status.
  const watchingNow = liveWatch
    ? tabs.filter((p) => watchedRef.current.has(p.id) && snaps.get(p.id)?.agentBusy).length
    : 0;
  const watchStep = autoStepsRef.current;
  // Anything in flight to stop: the orchestrator is thinking or any agent is busy.
  const anyAgentBusy = tabs.some((p) => snaps.get(p.id)?.agentBusy);
  const canStop = thinking || anyAgentBusy;

  // Session spend brake. Costs accumulate per agent only when billed per-token
  // (API key); on a subscription costUsd stays 0, so the brake is effectively
  // inert there (documented in Settings).
  const totalCostUsd = tabs.reduce((sum, p) => sum + (snaps.get(p.id)?.agentTokens?.costUsd ?? 0), 0);
  const spendLimit = settings.spendLimitUsd;
  const overSpend = spendLimit != null && totalCostUsd >= spendLimit;
  overSpendRef.current = overSpend;
  useEffect(() => {
    if (overSpend && !spendTrippedRef.current) {
      spendTrippedRef.current = true;
      stopAll();
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `🛑 You hit the session cost limit ($${spendLimit?.toFixed(2)} / session, current $${totalCostUsd.toFixed(2)}). Stopped the orchestrator + agents. Raise or remove the limit in Settings to continue.`,
        },
      ]);
    } else if (!overSpend) {
      spendTrippedRef.current = false; // re-arm when back under (e.g. limit raised)
    }
  }, [overSpend, spendLimit, totalCostUsd, stopAll]);

  // Agents panel: tag each project with its status, count per status (for the
  // filter tabs), then filter + float the important ones up (active → error →
  // done → idle). Idle rows render dimmed so the working ones read first.
  const agentRows = tabs.map((p) => ({ p, status: statusOf(snaps.get(p.id)) }));
  const agentCounts = agentRows.reduce(
    (acc, r) => ((acc[r.status] += 1), acc),
    { active: 0, error: 0, done: 0, idle: 0 } as Record<AgentStatus, number>,
  );
  const visibleAgents = agentRows
    .filter((r) => agentFilter === "all" || r.status === agentFilter)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const agentTabs: { id: AgentStatus | "all"; label: string; count: number }[] = [
    { id: "all", label: "All", count: agentRows.length },
    { id: "active", label: "Working", count: agentCounts.active },
    { id: "error", label: "Error", count: agentCounts.error },
    { id: "done", label: "Done", count: agentCounts.done },
    { id: "idle", label: "Idle", count: agentCounts.idle },
  ];

  return (
    <aside
      className="flex shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-edge bg-panel p-2"
      style={{ width }}
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-semibold text-accent">Orchestrator</span>
        <div className="flex items-center gap-1">
          <button
            onClick={stopAll}
            disabled={!canStop}
            title="Stop everything — orchestrator + all agents (like Escape)"
            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
              canStop
                ? "bg-red-500/25 text-red-200 hover:bg-red-500/35"
                : "border border-edge text-muted/50"
            }`}
          >
            ⏹ Stop
          </button>
          <button
            onClick={newChat}
            title="New chat (the current one stays saved)"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
          >
            ✚ New
          </button>
          <div className="relative">
            <button
              onClick={() => setSessionMenu((o) => !o)}
              title="Chats"
              className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            >
              💬 {sessions.length}
            </button>
            {sessionMenu && (
              <ul className="absolute right-0 top-full z-30 mt-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-edge bg-panel shadow-lg">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center hover:bg-edge">
                    <button
                      onClick={() => switchChat(s.id)}
                      className={`flex-1 truncate px-2 py-1 text-left text-xs ${s.id === chatId ? "text-accent" : "text-gray-200"}`}
                    >
                      {s.id === chatId && "● "}
                      {s.title || "New chat"}
                    </button>
                    <button
                      onClick={() => deleteChat(s.id)}
                      title="Delete chat"
                      className="px-1.5 text-muted hover:text-red-300"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => setAutoRun((v) => !v)}
            title={autoRun ? "Auto-run: actions run without confirmation" : "Confirm: every action needs a click"}
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
              autoRun ? "bg-amber-500/20 text-amber-300" : "text-muted hover:bg-edge/50 hover:text-gray-200"
            }`}
          >
            {autoRun ? "🔓 Auto" : "🔒 Confirm"}
          </button>
          <button
            onClick={() => setLiveWatch((v) => !v)}
            title={
              liveWatch
                ? "Live watch: continues on its own when an agent finishes"
                : "Live watch off"
            }
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
              liveWatch ? "bg-emerald-500/20 text-emerald-300" : "text-muted hover:bg-edge/50 hover:text-gray-200"
            }`}
          >
            {liveWatch && watchingNow > 0 && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            👁{" "}
            {liveWatch
              ? watchingNow > 0
                ? `${watchingNow} working${watchStep > 0 ? ` · #${watchStep}` : ""}`
                : "Watch"
              : "Watch"}
          </button>
        </div>
      </div>

      {/* Agents pane — status tabs (filter + live counts) + jump + cancel. */}
      <div className="shrink-0 overflow-hidden rounded-lg border border-edge bg-card px-2 pt-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {agentTabs.map((t) => {
            const active = agentFilter === t.id;
            const empty = t.count === 0 && t.id !== "all";
            const dot = t.id === "all" ? null : STATUS_COLOR[t.id];
            return (
              <button
                key={t.id}
                onClick={() => setAgentFilter(t.id)}
                disabled={empty}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  active ? "bg-edge text-gray-100" : "text-muted hover:bg-edge/50"
                } ${empty ? "opacity-40" : ""}`}
              >
                {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />}
                {t.label}
                <span className={active ? "text-accent" : "text-muted/70"}>{t.count}</span>
              </button>
            );
          })}
        </div>
        <div className="space-y-0.5 overflow-y-auto pr-0.5" style={{ height: agentsPanelH }}>
          {visibleAgents.length === 0 && (
            <div className="px-1.5 py-2 text-[11px] text-muted">No agents here.</div>
          )}
          {visibleAgents.map(({ p, status }) => {
            const running = status === "active";
            return (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-edge/50 ${
                  status === "idle" ? "opacity-55" : ""
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
                  style={{ background: STATUS_COLOR[status] }}
                />
                <button onClick={() => onSelect(p.id)} className="flex-1 truncate text-left text-gray-200">
                  {p.name}
                </button>
                {watchedRef.current.has(p.id) && (
                  <span title="Being watched (live watch)" className="text-[10px] text-emerald-300/80">
                    👁
                  </span>
                )}
                <span className="text-[10px]" style={{ color: STATUS_COLOR[status] }}>
                  {STATUS_SHORT[status]}
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
        {/* Drag to resize the agents panel vs. the chat below it. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = agentsPanelH;
            const onMove = (ev: MouseEvent) =>
              setAgentsPanelH(Math.max(60, Math.min(600, startH + (ev.clientY - startY))));
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          title="Drag to resize"
          className="group -mx-2 mt-0.5 flex h-3 cursor-row-resize items-center justify-center"
        >
          <span className="h-0.5 w-8 rounded-full bg-edge group-hover:bg-accent/60" />
        </div>
      </div>

      {/* Chat pane — log (scrolls) with the prompt pinned as its footer. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-edge bg-card">
      <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-2.5 py-2.5 text-sm">
        {messages.length === 0 && (
          <div className="text-muted">
            Ask me about any project — I can see what's running in every terminal and agent.
          </div>
        )}
        {messages.map((m, i) => {
          if (m.role === "user") {
            // Live-watch continuations are internal plumbing — collapse them to a
            // tiny breadcrumb (expandable for debugging) so they aren't noise.
            if (m.content.startsWith("👁")) {
              return <WatchTick key={i} content={m.content} />;
            }
            return (
              <div
                key={i}
                className="whitespace-pre-wrap break-words rounded-lg bg-edge/35 px-3 py-2"
              >
                {m.content}
              </div>
            );
          }
          const parsed = parseActions(m.content);
          const qa = parseQa(parsed.clean);
          const clean = qa.clean;
          const actions = parsed.actions;
          const pending = actions.filter((_, j) => !actionState[`${i}:${j}`]);
          return (
            <div key={i} className="px-0.5 leading-relaxed">
              {clean && <Markdown text={clean} />}
              {qa.items.length > 0 && (
                <button
                  onClick={() => startQa(qa.items)}
                  className="mt-2 w-full rounded bg-emerald-500/20 px-2 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
                >
                  🔍 Open QA Mode ({qa.items.length} feature{qa.items.length > 1 ? "s" : ""})
                </button>
              )}
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
        {thinking && <div className="px-0.5 text-muted">…</div>}
      </div>

      <div className="border-t border-edge p-2">
        <div className="flex items-end gap-2 rounded-lg border border-accent/40 bg-panel px-3 py-2.5 focus-within:border-accent">
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
                if (v) { autoStepsRef.current = 0; saveWatch(); void ask(v); setInput(""); }
              }
            }}
            placeholder="Ask about all your projects…"
            className="max-h-[220px] flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-relaxed text-gray-100 caret-accent outline-none placeholder:text-muted/50"
          />
        </div>
      </div>
      </div>
    </aside>
  );
}

/** A collapsed breadcrumb for an internal live-watch continuation — one muted
 *  line, click to reveal the full prompt (debugging only). */
function WatchTick({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] text-muted/60 hover:text-muted"
        title="Internal live-watch step — click for details"
      >
        👁 live watch · continuation {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap break-words rounded bg-well/40 px-2 py-1 text-[10px] text-muted/70">
          {content}
        </div>
      )}
    </div>
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
        ✓ {isDispatch ? "Sent a task to" : "Stopped the agent in"} <b>{action.project}</b>
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
        ⚠️ No project found: "{action.project}"
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent">
        <span>{isDispatch ? "🚀" : "🛑"}</span>
        <span>
          {isDispatch ? "Send task to" : "Stop the agent in"} {action.project}
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
