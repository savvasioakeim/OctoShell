// Answers the mobile server's questions about live app state.
//
// The server can't read this itself, and that isn't an oversight. The project
// list lives in localStorage, and everything that matters on a phone — which
// agent is busy, what it just said, what the last command printed — lives only in
// memory in the ShellControllers. The database has none of it. So the server asks
// the running app, exactly the way approval.rs asks the user for a decision.
//
// Answers are DERIVED here rather than shipped raw: a session's blocks are a
// single JSON blob of hundreds of KB, which is fine on the desktop and
// unacceptable over mobile data. Every reply is trimmed and paginated.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { Block, ShellController } from "../shell/ShellController";

/** What the server sends us. */
interface AskEvent {
  id: string;
  kind: string;
  params: Record<string, unknown>;
}

/** The projects the bridge can see, supplied by App. */
export interface BridgeProject {
  id: string;
  name: string;
  controller: ShellController;
}

/** Longest single text we'll send. A phone shows a few lines; the rest is noise
 *  that costs the user's data plan. */
const TEXT_CAP = 1500;
/** Command output is the worst offender — a build log is megabytes. */
const OUTPUT_CAP = 800;

function truncate(s: string, max: number): string {
  const t = s ?? "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** One block, flattened to what a phone can actually show. Deliberately not the
 *  Block union: the wire shape should stay stable while the internal one moves. */
export function wireBlock(b: Block, index: number): Record<string, unknown> {
  const base = { index, kind: b.kind, at: b.startedAt };
  switch (b.kind) {
    case "command":
      return {
        ...base,
        command: truncate(b.command, 300),
        status: b.status,
        exitCode: b.exitCode ?? null,
        output: truncate(b.outputText ?? "", OUTPUT_CAP),
      };
    case "agentText":
      return { ...base, role: b.role, text: truncate(b.text, TEXT_CAP) };
    case "agentTool":
      return {
        ...base,
        tool: b.toolName,
        status: b.status,
        input: truncate(b.toolInput ?? "", 200),
      };
    case "agentApproval":
      return { ...base, tool: b.toolName, status: b.status, input: truncate(b.toolInput ?? "", 200) };
    default:
      return base;
  }
}

/** One page of a feed, addressed by INDEX rather than by an offset from the end.
 *
 *  That choice matters: an agent writing new blocks grows the array while the
 *  phone is paging back through it, and an end-relative offset would slide under
 *  the reader — showing the same block twice, or skipping one. Indices don't move.
 *
 *  Exported for tests; the off-by-ones here are the kind that look right. */
export function pageBlocks(
  total: number,
  before: number | null | undefined,
  limit: number,
): { start: number; end: number; nextBefore: number | null } {
  const end = before === undefined || before === null
    ? total
    : Math.max(0, Math.min(before, total));
  const start = Math.max(0, end - Math.max(1, limit));
  return { start, end, nextBefore: start > 0 ? start : null };
}

/** Start answering the server's questions. Returns an unsubscribe. */
export function startMobileBridge(getProjects: () => BridgeProject[]): () => void {
  let unlisten: UnlistenFn | undefined;
  let stopped = false;

  const answer = (id: string, data: unknown) => {
    void invoke("mobile_respond", { id, data }).catch(() => {
      /* the server may have stopped mid-question; nothing to do */
    });
  };

  const handle = (e: AskEvent) => {
    const projects = getProjects();
    try {
      if (e.kind === "projects") {
        answer(
          e.id,
          {
            projects: projects.map((p) => {
              const s = p.controller.getSnapshot();
              const last = s.blocks[s.blocks.length - 1];
              return {
                id: p.id,
                name: p.name,
                cwd: s.cwd,
                agentBusy: s.agentBusy,
                shellBusy: s.busy,
                blocks: s.blocks.length,
                // Enough for a list row: what is this project doing right now.
                lastAt: last?.startedAt ?? null,
                provider: s.agentProvider,
              };
            }),
          },
        );
        return;
      }

      if (e.kind === "session") {
        const id = String(e.params.id ?? "");
        const project = projects.find((p) => p.id === id);
        if (!project) {
          answer(e.id, { error: `no open project with id ${id}` });
          return;
        }
        const blocks = project.controller.getSnapshot().blocks;
        const before = e.params.before === undefined || e.params.before === null
          ? null
          : Number(e.params.before);
        const { start, end, nextBefore } = pageBlocks(blocks.length, before, Number(e.params.limit ?? 20));
        answer(e.id, {
          id,
          name: project.name,
          total: blocks.length,
          from: start,
          to: end,
          // null when there is nothing older, so the phone can hide "load more".
          nextBefore,
          blocks: blocks.slice(start, end).map((b, i) => wireBlock(b, start + i)),
        });
        return;
      }

      answer(e.id, { error: `unknown request "${e.kind}"` });
    } catch (err) {
      // Always answer. An unanswered question ties up a phone request until the
      // server's timeout, and tells the user nothing about why.
      answer(e.id, { error: String(err) });
    }
  };

  void listen<AskEvent>("mobile://request", (ev) => {
    if (!stopped) handle(ev.payload);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });

  return () => {
    stopped = true;
    unlisten?.();
  };
}
