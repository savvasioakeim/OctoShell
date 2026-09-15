// What each project's agent was asked to do, and what it says it has done.
//
// QA for one worktree needs to know what the work WAS. The orchestrator's chat is
// the wrong place to look — it scrolls, it gets replaced by a new chat, and a
// worktree you dispatched by hand never passed through it. So every project keeps
// its own journal, keyed by working directory:
//
//   * every prompt its agent receives (from you, the orchestrator, or the phone);
//   * every progress note the agent files through its `update_task_progress` tool.
//
// "QA this worktree" hands that journal to the orchestrator, which turns it into a
// single QA item. A module singleton (like serviceStore) so the agent bridge, the
// sidebar menu and anything else read one copy.

import { useSyncExternalStore } from "react";
import { KEY, loadJSON, saveJSON } from "../util/persist";

export type TaskStatus = "in_progress" | "blocked" | "done";

export interface JournalEntry {
  at: number;
  /** A prompt the agent received, or progress the agent reported. */
  kind: "prompt" | "progress";
  /** Who sent a prompt: "user" | "orchestrator" | "phone". Unset on progress. */
  from?: string;
  /** The prompt, or the agent's summary of the step. */
  text: string;
  status?: TaskStatus;
  /** What changed — typically only on the final note. */
  changed?: string;
  /** How a person can check it — what QA is built from. */
  howToVerify?: string;
}

export interface Journal {
  cwd: string;
  entries: JournalEntry[];
}

/** Old entries go first; a long-running worktree should not grow without bound. */
const MAX_ENTRIES = 60;
/** A pasted log in a prompt should not be what fills localStorage. */
const MAX_TEXT = 4000;

/** Paths from different tools disagree about slashes and case. */
function norm(cwd: string): string {
  return cwd.trim().split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

function clip(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}… [truncated]` : t;
}

class TaskJournalStore {
  private map: Record<string, Journal> = loadJSON<Record<string, Journal>>(KEY.taskJournal, {});
  private listeners = new Set<() => void>();

  getSnapshot = (): Record<string, Journal> => this.map;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private push(cwd: string, entry: JournalEntry): void {
    const k = norm(cwd);
    if (!k) return;
    const prev = this.map[k] ?? { cwd, entries: [] };
    const entries = [...prev.entries, entry].slice(-MAX_ENTRIES);
    this.map = { ...this.map, [k]: { cwd: prev.cwd, entries } };
    saveJSON(KEY.taskJournal, this.map);
    this.listeners.forEach((l) => l());
  }

  /** Record a prompt the project's agent is about to run. */
  addPrompt(cwd: string, text: string, from: string): void {
    const t = clip(text);
    if (t) this.push(cwd, { at: Date.now(), kind: "prompt", from, text: t });
  }

  /** Record a progress note the agent filed about its own work. */
  addProgress(
    cwd: string,
    note: { summary: string; status: TaskStatus; changed?: string; howToVerify?: string },
  ): void {
    const text = clip(note.summary);
    if (!text) return;
    this.push(cwd, {
      at: Date.now(),
      kind: "progress",
      text,
      status: note.status,
      changed: clip(note.changed),
      howToVerify: clip(note.howToVerify),
    });
  }

  get(cwd: string): Journal | undefined {
    return this.map[norm(cwd)];
  }

  /** Forget a project's journal (e.g. the worktree is gone). */
  clear(cwd: string): void {
    const k = norm(cwd);
    if (!(k in this.map)) return;
    const { [k]: _gone, ...rest } = this.map;
    this.map = rest;
    saveJSON(KEY.taskJournal, this.map);
    this.listeners.forEach((l) => l());
  }

  /** The journal as plain text for the orchestrator: oldest first, labelled, so it
   *  can tell what was asked from what was reported. Empty when nothing is known. */
  textFor(cwd: string): string {
    const j = this.get(cwd);
    if (!j || j.entries.length === 0) return "";
    return j.entries
      .map((e) => {
        const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 16);
        if (e.kind === "prompt") return `[${when}] PROMPT from ${e.from ?? "user"}:\n${e.text}`;
        const lines = [`[${when}] PROGRESS (${e.status ?? "in_progress"}): ${e.text}`];
        if (e.changed) lines.push(`  changed: ${e.changed}`);
        if (e.howToVerify) lines.push(`  how to verify: ${e.howToVerify}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }
}

export const taskJournal = new TaskJournalStore();

/** Subscribe a component to one project's journal. */
export function useTaskJournal(cwd: string | undefined): Journal | undefined {
  const map = useSyncExternalStore(taskJournal.subscribe, taskJournal.getSnapshot);
  return cwd ? map[norm(cwd)] : undefined;
}
