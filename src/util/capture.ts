// One-shot script execution, with the two output streams kept apart.
//
// The backend used to hand back stdout and stderr concatenated, so any caller
// reading "the last line" as its answer could be handed a tool's warning
// instead. See `Captured` in pty.rs for the failure that came of it. Everything
// here goes through `captureOut` (the answer) or `capture` (the answer plus why
// it failed) so a caller has to say which one it means.

import { invoke } from "@tauri-apps/api/core";

export interface Captured {
  stdout: string;
  stderr: string;
  /** The child's exit status; null when it was killed by a signal. */
  code: number | null;
}

/** Run a script and get both streams plus the exit status. Use when a failure
 *  needs explaining to the user: `stderr` is what the tool said went wrong. */
export function capture(cwd: string, command: string): Promise<Captured> {
  return invoke<Captured>("run_capture", { cwd, command });
}

/** A script's ANSWER: stdout, trimmed. stderr is deliberately not included — a
 *  warning on stderr is not a result, and letting it stand in for one is the bug
 *  this module exists to prevent. Reach for `capture` when you need it. */
export async function captureOut(cwd: string, command: string): Promise<string> {
  return (await capture(cwd, command)).stdout.trim();
}
