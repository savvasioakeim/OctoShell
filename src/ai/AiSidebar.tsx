import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AiClient, type ChatMessage } from "./AiClient";
import type { Block, CommandBlock, ShellController, ShellSnapshot } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import { Markdown } from "../blocks/Markdown";
import { WorkingNode } from "../blocks/WorkingNode";
import strategyIcon from "../assets/strategy.png";
import { parseActions, type OrchestratorAction } from "./actions";
import { parseQa } from "../qa/parseQa";
import { openQaWindow } from "../qa/qaHost";
import type { QaItem, QaResult } from "../qa/qaTypes";
import { aggregateReviews, type ReviewSnapshot } from "../review/ReviewAgentController";
import { serviceStore } from "../services/serviceStore";
import { projectConfigStore } from "../projects/projectConfig";
import { supportsProfile } from "../agents/providers";
import { modStore } from "../mods/modStore";
import { registerOrchestrator } from "../strategy/orchestratorBridge";
import { useSettings } from "../settings/settingsStore";
import { dragHasFiles, filesFromDrop, saveDroppedFile } from "../util/drop";
import { memoryStore, type Recalled } from "../memory/memoryStore";
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
const PROJECT_DIGEST_CAP = 12000;
/** Hard ceiling on the assembled `system` string (~22K tokens).
 *
 *  These caps were originally sized against Windows' ~32 KB command-line limit,
 *  back when the context rode on argv and overflowing it killed claude.exe with
 *  os error 206. That constraint is GONE: ai.rs sends the whole context over
 *  stdin, which has no length limit. What's left is a cost/attention budget, so
 *  it's set from what the model can actually use well rather than from an OS
 *  limit that no longer applies. Still far below the smallest window (200K). */
const SYSTEM_CHAR_CAP = 90000;
/** Budget for recalled memories. Taken OUT of SYSTEM_CHAR_CAP, never added on
 *  top of it, so enabling memory can never grow the total context. */
const MEMORY_CHAR_CAP = 12000;
/** Per-memory slice, so six memories fit the budget with room for their stamps. */
const MEMORY_ITEM_CAP = 1500;

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
   *  session (its own controller/agent), or `{error}` with the git failure reason.
   *  Lets the orchestrator dispatch isolated work into a real, visible per-worktree
   *  agent. */
  onCreateWorktree?: (
    sourceProjectId: string,
    branch: string,
  ) => Promise<ProjectRef | { error: string } | null>;
  /** Close + git-remove a project/worktree by id (used by QA auto-clean). */
  onCloseProject?: (id: string) => void;
  /** Open the Strategy Mode planning workspace (overlay owned by App). */
  onOpenStrategy?: () => void;
  /** Width in px (user-resizable). */
  width: number;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)…" : s;
}

/** Canonical form for matching a branch against a worktree tab name: lowercased,
 *  trimmed, and slashes folded to dashes — the same transform App.createWorktree
 *  applies to name a worktree tab. Without this, "fix/x" never matches "fix-x". */
function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\//g, "-");
}

/** Is this cwd an OctoShell worktree checkout (vs. the repo's base/dev checkout)?
 *  Used to warn LOUDLY when QA resolves to a base checkout instead of the feature
 *  worktree — the silent version of that fallback made QA test stale code. */
function isWorktreeCwd(cwd: string): boolean {
  return /\.octoshell[\\/]worktrees[\\/]/i.test(cwd);
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
export function AiSidebar({ tabs, activeId, onSelect, onCreateWorktree, onCloseProject, onOpenStrategy, width }: Props) {
  const snaps = useAllSnapshots(tabs);
  const reviews = useAllReviews(tabs);
  // Chat sessions: the active session's content IS the live messages/actionState,
  // so "New chat" clears the view without losing history.
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [chatId, setChatId] = useState<string>(() => sessions[0].id);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => sessions[0].messages);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Files dropped onto the composer. Every orchestrator transport is text-only
  // (the claude/gemini CLIs and the ACP one-shot all take a single prompt
  // string), so an attachment rides along as its scratch-file PATH — which those
  // CLIs can actually open — rather than as inline image data.
  const [drops, setDrops] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const onDropFiles = async (e: React.DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDropping(false);
    const files = filesFromDrop(e.dataTransfer);
    if (!files.length) return;
    setDropErr(null);
    try {
      const paths = await Promise.all(files.map(saveDroppedFile));
      setDrops((d) => [...d, ...paths.filter((p) => p && !d.includes(p))]);
      inputRef.current?.focus();
    } catch (err) {
      setDropErr(`Couldn't attach the dropped file: ${err}`);
    }
  };
  /** Append the dropped paths to the outgoing text (quoted if they have spaces). */
  const withDrops = (text: string): string => {
    if (!drops.length) return text;
    const atts = drops.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
    return text ? `${text}\n\n${atts}` : atts;
  };
  // A plan handed over from Strategy Mode, queued to be asked once (see effects
  // below). Kept in state so the newChat-clear lands before ask() runs.
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  // Which proposed actions the user already confirmed/dismissed — persisted so a
  // restart never re-shows a handled action as pending (and risks re-dispatch).
  const [actionState, setActionState] = useState<Record<string, ActionState>>(() => sessions[0].actionState);
  // Why an action failed, keyed like actionState. Session-local (not persisted):
  // a reason is only meaningful next to the run that produced it.
  const [actionErr, setActionErr] = useState<Record<string, string>>({});
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

  // Keep the memory store in step with settings. It owns the resident index, so
  // switching the toggle off frees the RAM rather than merely stopping writes.
  useEffect(() => {
    memoryStore.configure({
      enabled: settings.memory.enabled,
      retentionMonths: settings.memory.retentionMonths,
    });
  }, [settings.memory.enabled, settings.memory.retentionMonths]);

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

  /** Render recalled memories as a prompt section.
   *
   *  Every entry is stamped with its age and origin. That is not decoration: the
   *  orchestrator already has to distinguish current state from stale reports
   *  (see the STALE handling below), and an unstamped memory reads as present
   *  tense — which is how a two-week-old fix becomes a claim that something is
   *  already done. */
  const memorySection = useCallback((items: Recalled[]): string => {
    if (!items.length) return "";
    const degraded = items.some((m) => m.keywordOnly);
    const head = [
      "# Recalled from earlier work (PAST, not current state)",
      "These are records of what happened before — possibly weeks ago. Treat them as",
      "history: useful for context and precedent, NEVER as evidence that something is",
      "currently true or already done. Verify against the live project digests below.",
      degraded ? "⚠️ Semantic recall unavailable — keyword matches only, so this may be incomplete." : "",
    ]
      .filter(Boolean)
      .join("\n");
    let used = head.length;
    const lines: string[] = [];
    for (const m of items) {
      const where = m.branch ? `${m.project} · ${m.branch}` : m.project;
      const body = truncate(m.text.trim(), MEMORY_ITEM_CAP);
      const entry = `\n\n[${where} · ${m.kind} · ${fmtAge(m.createdAt)}]\n${body}`;
      if (used + entry.length > MEMORY_CHAR_CAP) break;
      used += entry.length;
      lines.push(entry);
    }
    return lines.length ? head + lines.join("") : "";
  }, []);

  const buildSystem = useCallback((recalled: Recalled[] = []): string => {
    // Only digest projects worth the bytes: the ones the user actually touched this
    // session (ran a command/agent in) plus the active tab. This began as a fix for
    // Windows' ~32 KB argv limit (since removed — the context goes over stdin now),
    // but it stands on its own merit: digesting all 15 open projects is mostly
    // noise, and noise costs attention as well as tokens.
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
        // The independent review agent's verdict — so the orchestrator TRUSTS it
        // instead of re-inspecting the diff itself (its report doesn't otherwise
        // reach here). PASS/BLOCKED gates whether QA should be offered.
        let reviewLine = "";
        const rev = p.controller.review.getSnapshot();
        if (rev.active) {
          const state = rev.busy
            ? "running…"
            : rev.verdict
              ? rev.verdict.blocking
                ? "❌ BLOCKED"
                : "✅ PASS"
              : "pending";
          reviewLine = `\n🔎 review agent: ${state}${rev.verdict?.summary ? ` — ${rev.verdict.summary}` : ""}`;
        }
        const digest = `## ${p.name} — ${snap?.cwd || "(home)"} [${status}]${activeMark}\n${body}${reportLine}${reviewLine}`;
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
        '- ALWAYS add "branch" to a "cancel" or "review" whose target is a worktree: {"action":"cancel","project":"<repo>","branch":"<branch-name>"}. The same branch name can exist as a worktree in several repos (a ticket spanning fe+be), and project alone can then hit the wrong agent. With "branch" the target is exact.',
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
        "- QA BACKEND BRANCH: CRITICAL when one ticket spans repos on DIFFERENT branch names (e.g. a fe_be ticket where the BE branch is `feat/rental-booking-notes` but the FE branch is `feat/rental-notes`). The backend must run from ITS OWN worktree, not the feature's. Add the backend's real branch: {\"backend\":{\"project\":\"<repo>\",\"command\":\"…\",\"branch\":\"<the BACKEND's branch>\"}}. Without it, OctoShell matches the feature branch, finds no backend worktree, and silently runs the backend from base (dev) — which LACKS the new API, so the QA tests stale code. Always set backend.branch when the backend's branch name differs from the item's branch.",
        ...(autoRun
          ? ["- AUTONOMOUS MODE: your actions run automatically (no user click). Don't ask for confirmation — just propose them and they execute."]
          : []),
        ...(settings.orchestratorReadonly
          ? [
              "- READ-ONLY TOOLS: you have inspection tools — Read/Grep/Glob for files, and read-only shell commands (git status/log/diff/show/branch/worktree list, gh pr view/list/checks, ls/cat/rg/find). USE them to VERIFY reality before you claim or plan anything — e.g. run `git -C <repo> worktree list` to check a worktree exists, `git log --oneline dev..HEAD` to confirm a fix landed on a branch, `gh pr view <n>` for PR state. Never guess when you can check. You CANNOT write files or run any other command: you have NO Edit/Write and no general Bash — so NEVER try to implement, edit, or commit code yourself; always dispatch that to an agent. If a tool call is denied, it's outside your read-only set — adjust, don't retry.",
            ]
          : []),
        ...(liveWatch
          ? [
              "- LIVE WATCH is on: after an agent finishes a turn you'll automatically be pinged to continue. Drive the whole task to completion across turns — each ping, evaluate the latest result and dispatch the NEXT concrete step (e.g. for a PR flow: make the change & open the PR, then on the next turn review/fix, then verify). When everything is truly complete, say so plainly and emit NO actions block — that ends the loop.",
            ]
          : []),
        ...(settings.reviewAgent.enabled
          ? [
              "- REVIEW AGENT is enabled: after a coding agent finishes a dispatched task, OctoShell automatically runs an independent review agent over its diff BEFORE any QA. Therefore do NOT emit an ```octo-qa block on your own initiative. When every review has passed with no blocking issues, OctoShell pings you with `👁 (review agents)` — ONLY then offer QA. If a review finds a blocking problem, the user resolves it with the review agent first; just keep driving the plan and don't offer QA.",
              '- You can ALSO trigger that review agent yourself when the automatic pass didn\'t run (e.g. a finished task whose review never started): {"action":"review","project":"<name>"}. It launches the SAME independent reviewer (its own fresh agent, not the coding agent) on that project\'s current diff. Use it sparingly — normally the automatic pass covers it.',
            ]
          : []),
      ].join("\n"),
      // User's global rules apply to the orchestrator too (the agents get them
      // via the dispatch prompt — see ShellController).
      ...(settings.globalRules.trim()
        ? [`# Global rules (from the user — always honour these)\n${settings.globalRules.trim()}`]
        : []),
      // Memory goes ABOVE the project digests: the cap below trims from the end,
      // and digests are the cheaper thing to lose (they describe live state the
      // orchestrator can re-inspect; recalled history it cannot).
      ...(recalled.length ? [memorySection(recalled)] : []),
      `# Open projects\n${sections}`,
    ].join("\n\n");
    // Final safeguard: never let the context blow past the cap, no matter how many
    // projects got touched. Trim from the end (project digests live there) with a
    // visible note rather than risk overflowing downstream.
    return system.length > SYSTEM_CHAR_CAP
      ? system.slice(0, SYSTEM_CHAR_CAP) + "\n\n…(context truncated to fit limit)…"
      : system;
  }, [tabs, snaps, activeId, autoRun, liveWatch, memorySection, settings.globalRules, settings.workspace.orchestratorWorktrees, settings.reviewAgent.enabled, settings.orchestratorReadonly]);

  const ask = useCallback(
    async (userText: string) => {
      const next = [...messages, { role: "user" as const, content: userText }];
      setMessages(next);
      setThinking(true);
      const reqId = crypto.randomUUID();
      currentReqRef.current = reqId;
      // Recall BEFORE the turn: every orchestrator transport takes one flattened
      // prompt string (see AiClient), so there is no tool the model could call
      // mid-turn to look something up. Pre-retrieval is what makes memory work
      // on all four transports instead of only the Claude CLI.
      // Internal live-watch continuations are skipped — they're machine pings,
      // not questions, and recalling against them would be noise.
      let recalled: Recalled[] = [];
      if (settings.memory.enabled && !userText.startsWith("👁")) {
        const active = tabs.find((p) => p.id === activeId)?.name;
        recalled = await memoryStore.recall(userText, active, settings.memory.topK);
      }
      try {
        const reply = await client.chat(next, buildSystem(recalled), {
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
          // MCP servers the user allowed the orchestrator to use (Settings → MCP).
          allowedMcp: settings.orchestratorMcp,
          modMcp: modStore.mcpServers(),
          // Read-only inspection tools (verify instead of guess; never write code).
          readonly: settings.orchestratorReadonly,
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
    [messages, buildSystem, aiProvider, aiModel, profileId, profiles, tabs, activeId, settings.memory.enabled, settings.memory.topK],
  );

  // Strategy Mode → orchestrator handoff. Register a receiver; when a plan
  // arrives, optionally start a fresh chat, then queue the plan text. The queued
  // ask runs in a follow-up effect so it sees the cleared messages if newChat
  // fired (both state updates batch into the same render).
  useEffect(
    () =>
      registerOrchestrator(({ text, newChat: fresh }) => {
        if (fresh) newChat();
        setPendingPlan(text);
      }),
    [newChat],
  );
  useEffect(() => {
    if (pendingPlan == null) return;
    const text = pendingPlan;
    setPendingPlan(null);
    autoStepsRef.current = 0;
    saveWatch();
    void ask(text);
  }, [pendingPlan, ask, saveWatch]);

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

  /** Find an ALREADY-OPEN worktree tab for this repo + branch. Strict: it must be a
   *  worktree checkout of THIS repo sitting on THIS branch — never the base tab, so
   *  a branch dispatch can't silently land on dev. Worktree tabs are named after the
   *  sanitized branch (slashes → dashes), hence norm(). */
  const findWorktreeTab = useCallback(
    (project: string, branch: string): ProjectRef | undefined => {
      const proj = project.toLowerCase().trim();
      const b = norm(branch);
      if (!proj || !b) return undefined;
      return tabs.find((p) => {
        const cwd = p.controller.getCwd().toLowerCase();
        const n = norm(p.name);
        return (n === b || n.includes(b)) && isWorktreeCwd(cwd) && cwd.includes(proj);
      });
    },
    [tabs],
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
      // Every failure path records WHY (rendered on the card) — a dispatch that
      // doesn't land must never look like a no-op.
      const fail = (reason: string) => {
        setActionErr((e) => ({ ...e, [key]: reason }));
        setActionState((s) => ({ ...s, [key]: "error" }));
      };
      /** Record what was asked for. The agent's own report (stored separately when
       *  its turn ends) says what happened; this says what the intent was — which
       *  is what "why did we do this?" questions are actually asking about. */
      const rememberDispatch = (target: string, cwd: string) => {
        if (a.kind !== "dispatch") return;
        memoryStore.remember({
          kind: "dispatch",
          project: a.project,
          branch: a.branch ?? null,
          cwd,
          text: `Task dispatched to ${target}:\n${a.prompt}`,
        });
      };
      if (a.kind === "dispatch" && overSpendRef.current) {
        fail("session cost limit reached — raise it in Settings, then retry.");
        return;
      }
      // Worktree dispatch: branch a fresh, isolated session off the named project
      // and run the agent THERE — so it shows in the bar and gets its OWN agent,
      // instead of the named project's single agent doing work across worktrees.
      if (a.kind === "dispatch" && a.branch) {
        // RE-DISPATCH FIRST: if a worktree for this repo+branch is already open, run
        // the task THERE. Creating is only for the first dispatch — `git worktree add`
        // fails once the worktree exists, which used to sink every follow-up task
        // (post-review fixes landed nowhere and the card lied about the reason).
        const open = findWorktreeTab(a.project, a.branch);
        if (open) {
          open.controller.setMode("agent");
          if (!open.controller.runAgent(a.prompt, { orchestrated: true })) {
            fail(`the agent in worktree "${open.name}" is still busy — stop it, then retry.`);
            return;
          }
          watchDispatched(open.id);
          onSelect(open.id);
          rememberDispatch(open.name, open.controller.getCwd());
          setActionState((s) => ({ ...s, [key]: "done" }));
          return;
        }
        const src = resolveProject(a.project, "idle");
        if (!src) {
          fail(`no open project matches "${a.project}" — open the repo, then retry.`);
          return;
        }
        if (!onCreateWorktree) {
          fail("worktree creation is unavailable in this window.");
          return;
        }
        const wt = await onCreateWorktree(src.id, a.branch);
        if (!wt || "error" in wt) {
          fail(`couldn't create worktree "${a.branch}" in ${src.name}: ${wt ? wt.error : "unknown error"}`);
          return;
        }
        wt.controller.setMode("agent");
        wt.controller.runAgent(a.prompt, { orchestrated: true });
        watchDispatched(wt.id);
        onSelect(wt.id);
        rememberDispatch(wt.name, wt.controller.getCwd());
        setActionState((s) => ({ ...s, [key]: "done" }));
        return;
      }

      // cancel/review may carry a branch to pin down WHICH worktree they mean —
      // "feat-x" can exist in both the fe and be repo, and by name alone the target
      // was a coin flip. With a branch the match is exact; without one, fall back to
      // name resolution as before.
      const byBranch = a.kind !== "dispatch" && a.branch ? findWorktreeTab(a.project, a.branch) : undefined;
      if (a.kind !== "dispatch" && a.branch && !byBranch) {
        fail(`no open worktree for "${a.project}" on branch "${a.branch}" — open it, then retry.`);
        return;
      }
      const p = byBranch ?? resolveProject(a.project, a.kind === "cancel" ? "running" : "idle");
      if (!p) {
        fail(`no open project matches "${a.project}" — open it, then retry.`);
        return;
      }
      if (a.kind === "dispatch") {
        p.controller.setMode("agent");
        // runAgent refuses (returns false) when that agent is already busy — an
        // orchestrated dispatch never preempts. Surface it instead of dropping it
        // silently (that's how QA fixes went missing before).
        const ok = p.controller.runAgent(a.prompt, { orchestrated: true });
        if (!ok) {
          fail(`the agent in "${p.name}" is still busy — stop it, then retry.`);
          return;
        }
        watchDispatched(p.id);
        rememberDispatch(p.name, p.controller.getCwd());
      } else if (a.kind === "review") {
        // Fire the independent built-in review agent on this project's diff.
        void p.controller.requestReview();
      } else {
        p.controller.cancelAgent();
      }
      onSelect(p.id);
      setActionState((s) => ({ ...s, [key]: "done" }));
    },
    [resolveProject, findWorktreeTab, onSelect, onCreateWorktree, watchDispatched],
  );

  const dismissAction = useCallback((key: string) => {
    setActionState((s) => ({ ...s, [key]: "dismissed" }));
  }, []);

  /** Resolve the open worktree/project a QA item refers to (by branch, then
   *  project name). Worktree tabs are named after the sanitized branch. */
  const resolveByBranch = useCallback(
    (item: QaItem): ProjectRef | undefined => {
      // Worktree tabs are named after the SANITIZED branch (slashes → dashes, see
      // App.createWorktree), so compare on that canonical form — "fix/x" must match
      // its "fix-x" tab. But the branch alone isn't unique across repos: a branch
      // worktree may exist in a DIFFERENT repo (e.g. a backend-only fix has a BE
      // worktree but no FE one). So scope the branch match to THIS item's project
      // repo (via cwd), and only then fall back to the project's base checkout.
      const proj = item.project?.toLowerCase().trim();
      const branch = item.branch ? norm(item.branch) : "";
      // 1. A worktree of THIS project, on the branch.
      if (branch && proj) {
        const wt = tabs.find((p) => {
          const n = norm(p.name);
          return (n === branch || n.includes(branch)) && p.controller.getCwd().toLowerCase().includes(proj);
        });
        if (wt) return wt;
      }
      // 2. The project's base checkout (its own tab).
      if (proj) {
        const base =
          tabs.find((p) => p.name.toLowerCase().trim() === proj) ??
          tabs.find((p) => p.name.toLowerCase().includes(proj));
        if (base) return base;
      }
      // 3. Last resort: any tab on the branch (branch given but project absent).
      if (branch) {
        return tabs.find((p) => norm(p.name) === branch) ?? tabs.find((p) => norm(p.name).includes(branch));
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
      // Match on the SANITIZED branch (slashes → dashes) so the backend worktree is
      // actually found; the raw "fix/x" never equalled its "fix-x" tab name, which
      // silently ran the backend from its base (dev) branch instead. Prefer the
      // backend's OWN branch when the ticket spans repos with different branch names
      // (e.g. BE feat/rental-booking-… vs FE feat/rental-notes-…).
      const branch = norm(item.backend?.branch || item.branch || "");
      if (branch) {
        const wt = tabs.find((p) => {
          const n = norm(p.name);
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
            if (!item.backend) throw new Error("This item has no backend configured.");
            const tab = resolveBackend(item);
            const wantBranch = item.backend.branch || item.branch;
            if (!tab) {
              throw new Error(
                `No open project/worktree for backend "${item.backend.project}"` +
                  (wantBranch ? ` (branch "${wantBranch}")` : "") +
                  ". Open it in OctoShell, then retry.",
              );
            }
            const cwd = tab.controller.getCwd();
            // A user-pinned dev command wins over the orchestrator's guess.
            const command = projectConfigStore.get(cwd).dev || item.backend.command;
            const { url } = await serviceStore.start({ name: `${tab.name} (backend)`, cwd, command });
            // LOUD fallback: a branch was expected but we resolved to a base checkout.
            const warning =
              wantBranch && !isWorktreeCwd(cwd)
                ? `⚠️ Backend started from the BASE checkout (${tab.name}), not a worktree for "${wantBranch}". If that branch isn't merged into base yet, its new API is MISSING and the QA will test stale code. Open the backend worktree (or set backend.branch), then restart this server.`
                : undefined;
            return { url, warning };
          }
          const tab = resolveByBranch(item);
          if (!tab) {
            throw new Error(
              `No open project/worktree for "${item.project}"` +
                (item.branch ? ` (branch "${item.branch}")` : "") +
                ". Open it in OctoShell, then retry.",
            );
          }
          const cwd = tab.controller.getCwd();
          const command = projectConfigStore.get(cwd).dev || item.startCommand;
          if (!command) {
            throw new Error(
              `No start command for "${item.title}". Set a dev script (right-click the project → Project scripts) or add startCommand to the QA block.`,
            );
          }
          const { url } = await serviceStore.start({ name: tab.name, cwd, command });
          const warning =
            item.branch && !isWorktreeCwd(cwd)
              ? `⚠️ Started from the BASE checkout (${tab.name}), not a worktree for "${item.branch}". You may be testing stale code — open the feature's worktree, then restart this server.`
              : undefined;
          return { url, warning };
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
      // Read the controller LIVE, not the render-time `snaps` map. A dispatch is
      // fired from the auto-run effect in THIS SAME commit, and runAgent flips
      // agentBusy synchronously — but `snaps` was captured before that and still
      // says idle. Combined with watchDispatched's optimistic prev=true, the stale
      // map manufactured a busy→idle edge the instant a task was sent, so every
      // dispatch was immediately followed by a continuation about the PREVIOUS
      // turn ("the dispatch didn't execute, re-sending" → "couldn't dispatch:
      // agent busy"). The orchestrator was permanently one step behind.
      const busy = !!p.controller.getSnapshot().agentBusy;
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

  // Record every finished agent turn into workspace memory. Separate from live
  // watch on purpose: that only tracks agents the orchestrator dispatched, while
  // memory should capture ALL work — including tasks the user ran by hand, which
  // are exactly the ones nothing else in the app remembers.
  const memBusyRef = useRef(new Map<string, boolean>());
  const memSeenRef = useRef(new Set<string>());
  useEffect(() => {
    if (!settings.memory.enabled) return;
    for (const p of tabs) {
      const snap = snaps.get(p.id);
      const busy = !!snap?.agentBusy;
      const prev = memBusyRef.current.get(p.id) ?? false;
      memBusyRef.current.set(p.id, busy);
      if (!(prev && !busy) || !snap) continue;
      const report = lastAgentReport(snap.blocks, 4000);
      if (!report) continue;
      // A turn that ends without producing a new report (cancelled, or a no-op)
      // must not re-store the previous one on every settle.
      const key = `${p.id}:${report.at}`;
      if (memSeenRef.current.has(key)) continue;
      memSeenRef.current.add(key);
      const cwd = snap.cwd || "";
      memoryStore.remember({
        kind: "report",
        project: p.name,
        branch: isWorktreeCwd(cwd) ? p.name : null,
        cwd,
        text: report.text,
        createdAt: report.at,
      });
    }
  });

  // Record review verdicts. Kept separate from reports because a verdict is a
  // judgement about the work ("this was blocked because X"), which is what a
  // later "did we ever hit this problem?" question needs — and it's ranked higher.
  const memVerdictRef = useRef(new Set<string>());
  useEffect(() => {
    if (!settings.memory.enabled) return;
    for (const p of tabs) {
      const rev = p.controller.review.getSnapshot();
      if (!rev.active || rev.busy || !rev.verdict) continue;
      const summary = rev.verdict.summary?.trim();
      if (!summary) continue;
      const key = `${p.id}:${rev.verdict.blocking ? "block" : "pass"}:${summary.slice(0, 80)}`;
      if (memVerdictRef.current.has(key)) continue;
      memVerdictRef.current.add(key);
      const cwd = p.controller.getCwd();
      memoryStore.remember({
        kind: "review",
        project: p.name,
        branch: isWorktreeCwd(cwd) ? p.name : null,
        cwd,
        text: `Review ${rev.verdict.blocking ? "BLOCKED" : "PASSED"}: ${summary}`,
        meta: { blocking: rev.verdict.blocking },
      });
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
      // Stop pressed on this agent → drop it from live watch so the busy→idle edge
      // the cancel produces doesn't fire a continuation that re-drives it.
      p.controller.onUserStopped = () => {
        watchedRef.current.delete(p.id);
        prevBusyRef.current.set(p.id, false); // consume the pending edge
        saveWatch();
      };
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
      {/* Title, then a compact single-row button strip beneath it. */}
      <div className="px-1">
        <div className="flex items-center gap-1.5">
          <span className="text-grad text-sm font-semibold">Orchestrator</span>
          {thinking && <WorkingNode />}
        </div>
        {/* One panel split by a single centre divider: Strategy (the primary
            planning entry) on the left, the run-controls cluster on the right,
            reading as two glued panels joined by that vertical line. */}
        <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-edge bg-card">
          {onOpenStrategy && (
            <div className="flex items-center px-1 py-1">
              <button
                onClick={onOpenStrategy}
                title="Strategy Mode — plan complex work with a moderated multi-agent discussion before coding"
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/15"
              >
                <img src={strategyIcon} alt="" className="h-6 w-6 object-contain" />
                Strategy
              </button>
            </div>
          )}
          <div className="w-px self-stretch bg-edge" />
          <div className="flex flex-1 items-center justify-end gap-1 px-1.5 py-1">
          <button
            onClick={stopAll}
            disabled={!canStop}
            title="Stop everything — orchestrator + all agents (like Escape)"
            className={`inline-flex h-6 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] font-semibold ${
              canStop
                ? "bg-red-500/25 text-red-200 hover:bg-red-500/35"
                : "border border-edge text-muted/50"
            }`}
          >
            <span className="text-sm leading-none">⏹</span> Stop
          </button>
          <button
            onClick={() => {
              setChatSearch("");
              setSessionMenu(true);
            }}
            title="Chats — new chat + switch/search existing"
            className="inline-flex h-6 items-center gap-1 rounded border border-[#7c5cff]/50 px-1.5 text-[10px] text-muted hover:bg-[#7c5cff]/15 hover:text-gray-200"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="url(#chat-grad)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden>
              <defs>
                <linearGradient id="chat-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="24">
                  <stop offset="0%" stopColor="#e879f9" />
                  <stop offset="100%" stopColor="#7c5cff" />
                </linearGradient>
              </defs>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            {sessions.length}
          </button>
          <button
            onClick={() => setAutoRun((v) => !v)}
            title={autoRun ? "Auto-run: actions run without confirmation" : "Confirm: every action needs a click"}
            className={`inline-flex h-6 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] font-medium ${
              autoRun ? "bg-amber-500/20 text-amber-300" : "text-muted hover:bg-edge/50 hover:text-gray-200"
            }`}
          >
            <span className="text-sm leading-none">{autoRun ? "🔓" : "🔒"}</span> {autoRun ? "Auto" : "Confirm"}
          </button>
          <button
            onClick={() => setLiveWatch((v) => !v)}
            title={
              liveWatch
                ? "Live watch: continues on its own when an agent finishes"
                : "Live watch off"
            }
            className={`inline-flex h-6 items-center gap-1 rounded border border-transparent px-1.5 text-[10px] font-medium ${
              liveWatch ? "bg-emerald-500/20 text-emerald-300" : "text-muted hover:bg-edge/50 hover:text-gray-200"
            }`}
          >
            {liveWatch && watchingNow > 0 && <WorkingNode />}
            <span className="text-sm leading-none">👁</span>{" "}
            {liveWatch
              ? watchingNow > 0
                ? `${watchingNow} working${watchStep > 0 ? ` · #${watchStep}` : ""}`
                : "Watch"
              : "Watch"}
          </button>
          </div>
        </div>
      </div>

      {/* Chats modal — new chat at the top, searchable list below (replaces the
          old clipped dropdown). */}
      {sessionMenu && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSessionMenu(false)}
        >
          <div
            className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
              <span className="text-sm font-semibold text-gray-100">Chats</span>
              <span className="text-[11px] text-muted">{sessions.length}</span>
              <button
                onClick={() => setSessionMenu(false)}
                className="ml-auto rounded px-2 py-0.5 text-sm text-muted hover:bg-edge hover:text-gray-200"
              >
                ✕
              </button>
            </div>
            <button
              onClick={newChat}
              className="flex items-center gap-2 border-b border-edge px-3 py-2.5 text-left text-sm font-medium text-accent hover:bg-edge/50"
            >
              <span className="text-base leading-none">✚</span> New chat
            </button>
            <div className="border-b border-edge p-2">
              <input
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                autoFocus
                placeholder="Search chats…"
                className="w-full rounded-lg border border-edge bg-card px-3 py-1.5 text-sm text-gray-100 outline-none placeholder:text-muted/50 focus:border-accent"
              />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto py-1">
              {sessions
                .filter((s) => (s.title || "New chat").toLowerCase().includes(chatSearch.toLowerCase().trim()))
                .map((s) => (
                  <li key={s.id} className="flex items-center hover:bg-edge/50">
                    <button
                      onClick={() => switchChat(s.id)}
                      className={`flex-1 truncate px-3 py-2 text-left text-sm ${s.id === chatId ? "text-accent" : "text-gray-200"}`}
                    >
                      {s.id === chatId && "● "}
                      {s.title || "New chat"}
                    </button>
                    <button
                      onClick={() => deleteChat(s.id)}
                      title="Delete chat"
                      className="px-3 py-2 text-muted hover:text-red-300"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              {sessions.filter((s) => (s.title || "New chat").toLowerCase().includes(chatSearch.toLowerCase().trim())).length === 0 && (
                <li className="px-3 py-6 text-center text-xs text-muted">No matching chats.</li>
              )}
            </ul>
          </div>
        </div>
      )}

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
                        reason={actionErr[key]}
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
        {thinking && (
          <div className="px-0.5">
            <WorkingNode />
          </div>
        )}
      </div>

      <div
        className="border-t border-edge p-2"
        onDragOver={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropping(false);
        }}
        onDrop={(e) => void onDropFiles(e)}
      >
        {dropErr && (
          <div className="mb-1.5 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
            <span className="flex-1">{dropErr}</span>
            <button onClick={() => setDropErr(null)} title="Dismiss" className="text-red-300/70 hover:text-red-200">
              ✕
            </button>
          </div>
        )}
        {drops.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {drops.map((p, i) => (
              <span
                key={`${p}-${i}`}
                className="flex items-center gap-1 rounded border border-edge bg-card px-1.5 py-0.5 text-[11px] text-gray-200"
              >
                <span className="shrink-0">📎</span>
                <span className="max-w-[160px] truncate" title={p}>{p.split(/[\\/]/).pop() || p}</span>
                <button
                  onClick={() => setDrops((d) => d.filter((_, j) => j !== i))}
                  title="Remove"
                  className="text-muted hover:text-red-300"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className={`flex items-end gap-2 rounded-lg border bg-panel px-3 py-2.5 focus-within:border-accent ${
            dropping ? "border-accent bg-accent/5" : "border-accent/40"
          }`}
        >
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
                const v = withDrops(input.trim());
                if (v) { autoStepsRef.current = 0; saveWatch(); void ask(v); setInput(""); setDrops([]); }
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
  reason,
  onConfirm,
  onDismiss,
}: {
  action: OrchestratorAction;
  state?: ActionState;
  /** Why it failed, when known — shown verbatim so a dead dispatch is diagnosable. */
  reason?: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const isDispatch = action.kind === "dispatch";
  const isReview = action.kind === "review";
  // Show the branch alongside the project so the user can see exactly which
  // worktree an action targets before confirming it.
  const target = action.branch ? `${action.project} (${action.branch})` : action.project;
  const doneLabel = isDispatch ? "Sent a task to" : isReview ? "Started review on" : "Stopped the agent in";
  const dismissLabel = isDispatch ? "Dispatch →" : isReview ? "Review" : "Cancel";
  const verbLabel = isDispatch ? "Send task to" : isReview ? "Start review on" : "Stop the agent in";
  const verbIcon = isDispatch ? "🚀" : isReview ? "🔍" : "🛑";

  if (state === "done") {
    return (
      <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-300">
        ✓ {doneLabel} <b>{target}</b>
      </div>
    );
  }
  if (state === "dismissed") {
    return (
      <div className="rounded border border-edge bg-edge/30 px-2 py-1.5 text-xs text-muted line-through">
        {dismissLabel} {target}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
        <div>
          ⚠️ Couldn't {isDispatch ? "dispatch to" : isReview ? "review" : "cancel"} "{target}".
        </div>
        {reason && <div className="mt-0.5 break-words text-[11px] text-red-300/80">{reason}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <span>{verbIcon}</span>
        <span className="text-grad">
          {verbLabel} {target}
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
