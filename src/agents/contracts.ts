// What one agent changed that another was relying on.
//
// Agents work in separate worktrees and cannot see each other. That is usually
// the point -- until the backend renames a field the frontend is already writing
// a query against, and the frontend only finds out in QA.
//
// So an agent that changes something others depend on DECLARES it, and the
// declaration is handed to the related agents at the start of their next turn.
// Next turn, not now: a turn is one process run, and the only way to interrupt it
// is to kill it, which would throw away work to deliver news.
//
// Links come from the orchestrator (the `peers` field on a dispatch) and are
// treated as symmetric here: if the frontend was told the backend is related,
// the backend's declarations reach the frontend, without the orchestrator having
// to state the link twice.

import { useSyncExternalStore } from "react";
import { KEY, loadJSON, saveJSON } from "../util/persist";

export interface ContractChange {
  id: string;
  at: number;
  /** Project label of whoever made the change. */
  project: string;
  branch?: string;
  /** The author's working directory — the identity links are matched on. */
  cwd: string;
  /** The author's related worktrees at the time, as working directories. */
  peers: string[];
  /** One sentence: what changed. */
  summary: string;
  /** Where it changed: an endpoint, GraphQL field, shared type, table… */
  surface?: string;
  /** Whether code written against the old shape stops working. */
  breaking: boolean;
  /** What a dependent should do about it. */
  migration?: string;
}

/** Enough to cover a working session; old entries are no longer news. */
const MAX = 150;
const MAX_TEXT = 600;

/** Paths from different tools disagree about slashes and case. */
export function normCwd(cwd: string): string {
  return cwd.trim().split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

function clip(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

class ContractStore {
  private items: ContractChange[] = loadJSON<ContractChange[]>(KEY.contracts, []);
  private listeners = new Set<() => void>();

  getSnapshot = (): ContractChange[] => this.items;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Record a change. Returns the stored entry, or null if there was nothing to say. */
  add(c: {
    project: string;
    branch?: string;
    cwd: string;
    peers: string[];
    summary: string;
    surface?: string;
    breaking?: boolean;
    migration?: string;
  }): ContractChange | null {
    const summary = clip(c.summary);
    if (!summary || !c.cwd) return null;
    const entry: ContractChange = {
      id: crypto.randomUUID(),
      at: Date.now(),
      project: c.project,
      branch: c.branch,
      cwd: normCwd(c.cwd),
      peers: c.peers.map(normCwd).filter(Boolean),
      summary,
      surface: clip(c.surface),
      breaking: !!c.breaking,
      migration: clip(c.migration),
    };
    this.items = [...this.items, entry].slice(-MAX);
    saveJSON(KEY.contracts, this.items);
    this.listeners.forEach((l) => l());
    return entry;
  }

  /**
   * Declarations a worktree has not been told about yet.
   *
   * A declaration reaches you when the author is one of your peers, or when the
   * author listed you as one of theirs — the link is the same link either way,
   * and requiring both sides to state it is how a notification goes missing.
   */
  since(cwd: string, after: number, myPeers: string[]): ContractChange[] {
    const me = normCwd(cwd);
    const mine = new Set(myPeers.map(normCwd));
    return this.items.filter(
      (c) => c.at > after && c.cwd !== me && (mine.has(c.cwd) || c.peers.includes(me)),
    );
  }

  /** Everything one worktree has declared (for "what has the backend been doing?"). */
  byCwd(cwd: string): ContractChange[] {
    const k = normCwd(cwd);
    return this.items.filter((c) => c.cwd === k);
  }

  /** One line per change, as an agent reads it. */
  static format(list: ContractChange[]): string {
    return list
      .map((c) => {
        const who = c.branch ? `${c.project} (${c.branch})` : c.project;
        const head = `- [${who}]${c.breaking ? " BREAKING:" : ""} ${c.summary}`;
        const where = c.surface ? `\n    where: ${c.surface}` : "";
        const fix = c.migration ? `\n    what to do: ${c.migration}` : "";
        return head + where + fix;
      })
      .join("\n");
  }
}

export const contractStore = new ContractStore();
export const formatChanges = ContractStore.format;

export function useContracts(): ContractChange[] {
  return useSyncExternalStore(contractStore.subscribe, contractStore.getSnapshot);
}
