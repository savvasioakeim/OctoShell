// What the frontend knows about the OS it runs on, fetched ONCE from the backend
// at startup (`platform_info`, see pty.rs) and then read synchronously anywhere.
//
// OctoShell was written for Windows first, and a handful of places genuinely
// differ per OS: which shell the terminal spawns, how CLIs are launched (`cmd /c`
// shims vs. real binaries), which modifier key means "app shortcut", and the
// wording of install hints. All of those ask this module instead of sniffing the
// user agent, so the decision is made in one place — and made from the backend's
// truth (which shells are actually installed), not a guess.
//
// The fallback is Windows-shaped on purpose: if the probe ever fails, the app
// behaves exactly as it did before this module existed.

import { invoke } from "@tauri-apps/api/core";

export type OS = "windows" | "macos" | "linux";

/** One shell the terminal can spawn on this machine (see shells.rs). */
export interface ShellInfo {
  id: string;
  label: string;
  /** Produces per-command blocks with exit codes (shell integration injected). */
  semantic: boolean;
  /** Its binary is installed here. */
  available: boolean;
}

export interface PlatformInfo {
  os: OS;
  /** The shell a tab gets when Settings names none this platform has. */
  defaultShell: string;
  shells: ShellInfo[];
  /** The user's home directory (for display; never for path maths). */
  home: string;
}

const WINDOWS_FALLBACK: PlatformInfo = {
  os: "windows",
  defaultShell: "powershell",
  shells: [
    { id: "powershell", label: "PowerShell (pwsh)", semantic: true, available: true },
    { id: "cmd", label: "CMD", semantic: false, available: true },
    { id: "wsl", label: "WSL / Ubuntu", semantic: false, available: true },
  ],
  home: "",
};

let info: PlatformInfo = WINDOWS_FALLBACK;

/** Fetch the platform facts. Called once by `main.tsx` before the first render
 *  so every synchronous reader below sees real data. Safe to call again. */
export async function initPlatform(): Promise<PlatformInfo> {
  try {
    info = await invoke<PlatformInfo>("platform_info");
  } catch (e) {
    console.warn("platform_info failed — assuming Windows", e);
    info = WINDOWS_FALLBACK;
  }
  return info;
}

export function platform(): PlatformInfo {
  return info;
}

export function isWindows(): boolean {
  return info.os === "windows";
}

export function isMac(): boolean {
  return info.os === "macos";
}

/** The shell a persisted Settings value actually resolves to here: itself when
 *  this platform has it, else the platform default (a workspace carried over
 *  from another OS may name a shell that doesn't exist on this one). */
export function effectiveShell(id: string): ShellInfo {
  const found = info.shells.find((s) => s.id === id && s.available);
  return found ?? info.shells.find((s) => s.id === info.defaultShell) ?? info.shells[0];
}

/** Human name of the shell the terminal uses, for prompts and copy
 *  ("PowerShell (pwsh)" / "zsh"). */
export function shellLabel(id?: string): string {
  return effectiveShell(id ?? info.defaultShell).label;
}

/** A CLI's launch command in the form this host runs it. npm-installed CLIs
 *  (`npx`, `gemini`, `opencode`…) are `.cmd` shims on Windows and must go
 *  through `cmd /c`; everywhere else they're real executables. */
export function hostCommand(linuxForm: string): string {
  return isWindows() ? `cmd /c ${linuxForm}` : linuxForm;
}

/** True when the event carries this platform's app-shortcut modifier: ⌘ on
 *  macOS, Ctrl elsewhere. (Terminal signals like Ctrl+C are NOT this — they
 *  stay Ctrl everywhere.) */
export function hasModKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** Display name of the app-shortcut modifier, for tooltips. */
export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** Where the SQLite database lives, for the workspace-transfer explainer. */
export function dbLocationHint(): string {
  switch (info.os) {
    case "macos":
      return "~/Library/Application Support/com.octoshell.app/octoshell.db";
    case "linux":
      return "~/.local/share/com.octoshell.app/octoshell.db";
    default:
      return "%APPDATA%\\com.octoshell.app\\octoshell.db";
  }
}
