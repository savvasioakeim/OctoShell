// Subtle sci-fi SFX for task lifecycle events. Synthesised with the Web Audio
// API (no asset files) and gated by the Appearance setting, so it stays silent
// unless the user opts in. Kept tiny and forgiving — audio must never throw into
// the agent pipeline.

import { settingsStore } from "../settings/settingsStore";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

/** A short two-tone blip. `done` rises (pleasant), `error` falls (alert). */
export function playSfx(kind: "done" | "error"): void {
  if (!settingsStore.getSnapshot().appearance.sfx) return;
  const ac = audio();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const [f1, f2] = kind === "done" ? [660, 990] : [440, 220];
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    gain.connect(ac.destination);

    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f1, now);
    osc.frequency.exponentialRampToValueAtTime(f2, now + 0.12);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    /* never let SFX break the caller */
  }
}
