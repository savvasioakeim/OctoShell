// "Point at it instead of describing it": the capture half of QA Mode.
//
// A reviewer testing a feature has the app under test in front, not the QA
// window. So the trigger is an OS-level shortcut, not a key handler here: by the
// time a DOM keydown could reach this webview, the window would have had to take
// focus, which is exactly what you don't want mid-test.
//
// It is a key and not a spoken word for the same reason. Recognition only
// settles a word or two after you say it, so "here" would fire a second late,
// pointing at wherever the pointer drifted to — and it would fire on every
// ordinary "here" in a sentence.

import { invoke } from "@tauri-apps/api/core";

/** One written PNG: the path an agent opens, plus an inline preview. */
export interface Shot {
  path: string;
  /** `data:` URL — the window can't read `path` (no asset protocol). */
  thumb: string;
}

export interface PointerShot {
  /** Full frame first, then the detail crop when the monitor is bigger than it. */
  shots: Shot[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The QA capture shortcut.
 *
 * Deliberately not Alt+Shift+something: on Windows that is the keyboard-layout
 * switch, which anyone typing in two languages presses all day.
 */
export const CAPTURE_SHORTCUT = "CommandOrControl+Alt+Q";

/** Human-readable form of {@link CAPTURE_SHORTCUT} for the UI. */
export const CAPTURE_HINT =
  navigator.platform.toLowerCase().includes("mac") ? "⌘⌥Q" : "Ctrl+Alt+Q";

/** Grab the monitor under the pointer, with the pointer ringed. */
export function capturePointer(): Promise<PointerShot> {
  return invoke<PointerShot>("capture_pointer", {});
}
