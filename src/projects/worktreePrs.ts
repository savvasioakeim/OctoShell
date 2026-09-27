// Deciding which worktrees can be auto-removed, from ONE command per repository.
//
// This used to run a fresh PowerShell per open worktree every two minutes, each
// invoking `git` and then `gh`. On Windows that turned out to be visible: `gh`
// starts a second `gh` (its git credential helper), which starts `tzutil`, which
// allocates its own console -- and with Windows Terminal set as the default
// terminal application, a console allocation opens a real terminal window. With
// nineteen projects open that is nineteen chances to flash a window across
// whatever you were doing, every two minutes.
//
// One `git worktree list` plus one `gh pr list` per repository answers the same
// question, so the fan-out disappears.

import { worktreePrPollScript } from "../platform/shellScripts";

/** Marker separating the two command outputs in a single capture. */
export const SPLIT = "---octo---";

/** The one command whose output `parseMergedWorktrees` reads. Written for both
 *  script shells in the platform layer, so it runs under sh on macOS too. */
export function pollCommand(): string {
  return worktreePrPollScript(SPLIT);
}

/** Compare paths the way two tools that disagree about slashes and case require. */
export function normPath(p: string): string {
  return p.trim().split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Worktree paths whose branch has a PR that is finished (merged or closed).
 *
 * Anything unparseable yields an empty list rather than a guess: this drives
 * REMOVING a worktree, so being wrong deletes someone's working directory.
 */
export function parseMergedWorktrees(output: string): string[] {
  const [treesPart, prsPart] = output.split(SPLIT);
  if (prsPart == null) return []; // gh half missing → we know nothing

  // `git worktree list --porcelain` emits blocks: "worktree <path>", then
  // "branch refs/heads/<name>" (absent when the worktree is detached).
  const branchOf = new Map<string, string>();
  let path: string | null = null;
  for (const raw of treesPart.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && path) {
      branchOf.set(line.slice("branch ".length).replace(/^refs\/heads\//, ""), normPath(path));
      path = null;
    } else if (line === "detached") {
      path = null; // no branch, so no PR to match
    }
  }

  const done = new Set<string>();
  for (const raw of prsPart.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.lastIndexOf(" ");
    if (at < 1) continue;
    const branch = line.slice(0, at);
    const state = line.slice(at + 1).toUpperCase();
    if (state !== "MERGED" && state !== "CLOSED") continue;
    const p = branchOf.get(branch);
    if (p) done.add(p);
  }
  return [...done];
}
