// Every QA the orchestrator has proposed, and what you decided in it.
//
// QA used to exist only as a button inside one chat message: scroll past it, or
// start a new chat, and the QA was gone — along with the notes you wrote. This
// keeps each proposal as a session you can reopen from the header, with your
// verdicts and notes restored where you left them.

import { useSyncExternalStore } from "react";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import type { QaItem, QaResult } from "./qaTypes";

export interface QaSession {
  id: string;
  /** When the QA was first proposed. */
  at: number;
  /** When verdicts were last saved. */
  updatedAt: number;
  title: string;
  /** Identifies the chat message it came from, so re-rendering the same message
   *  (or switching back to that chat) does not create a second copy. */
  key?: string;
  items: QaItem[];
  /** Null until the QA window has been closed at least once. */
  results: QaResult[] | null;
}

const MAX_SESSIONS = 50;

/** A short, stable fingerprint of a message's text — enough to recognise it again. */
export function qaKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `m${(h >>> 0).toString(36)}-${text.length}`;
}

function titleFor(items: QaItem[]): string {
  if (items.length === 1) return items[0].title;
  const branches = [...new Set(items.map((i) => i.branch).filter(Boolean))];
  return branches.length === 1 ? `${items.length} features · ${branches[0]}` : `${items.length} features`;
}

class QaHistoryStore {
  private sessions: QaSession[] = loadJSON<QaSession[]>(KEY.qaHistory, []);
  private listeners = new Set<() => void>();

  getSnapshot = (): QaSession[] => this.sessions;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private commit(next: QaSession[]): void {
    this.sessions = next.slice(0, MAX_SESSIONS);
    saveJSON(KEY.qaHistory, this.sessions);
    this.listeners.forEach((l) => l());
  }

  /** Record a proposed QA; returns its session id. A proposal already recorded
   *  under the same key returns the existing session instead of a duplicate. */
  add(p: { items: QaItem[]; key?: string; title?: string }): string {
    if (p.key) {
      const existing = this.sessions.find((s) => s.key === p.key);
      if (existing) return existing.id;
    }
    const now = Date.now();
    const s: QaSession = {
      id: crypto.randomUUID(),
      at: now,
      updatedAt: now,
      title: p.title ?? titleFor(p.items),
      key: p.key,
      items: p.items,
      results: null,
    };
    this.commit([s, ...this.sessions]);
    return s.id;
  }

  get(id: string): QaSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Save the verdicts from a closed QA window. */
  setResults(id: string, results: QaResult[]): void {
    this.commit(
      this.sessions.map((s) => (s.id === id ? { ...s, results, updatedAt: Date.now() } : s)),
    );
  }

  remove(id: string): void {
    this.commit(this.sessions.filter((s) => s.id !== id));
  }
}

export const qaHistory = new QaHistoryStore();

export function useQaHistory(): QaSession[] {
  return useSyncExternalStore(qaHistory.subscribe, qaHistory.getSnapshot);
}

/** Tally of a session's verdicts; `pending` counts items with no decision yet. */
export function tally(s: QaSession): { approved: number; declined: number; pending: number } {
  const byId = new Map((s.results ?? []).map((r) => [r.id, r]));
  let approved = 0;
  let declined = 0;
  for (const it of s.items) {
    const v = byId.get(it.id)?.verdict;
    if (v === "approve") approved++;
    else if (v === "decline") declined++;
  }
  return { approved, declined, pending: s.items.length - approved - declined };
}
