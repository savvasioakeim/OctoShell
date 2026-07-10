// First-launch health check, rendered as a PCB "node & trace" pipeline: each
// dependency is a node on a vertical trace, green when present, red when a
// required one is missing (a break in the pipeline). Makes sure the CLIs
// OctoShell drives are on PATH before the user hits a cryptic spawn failure
// deep inside a run. Shown once; still dismissible (Continue anyway) so a user
// who knows what they're doing isn't hard-blocked.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KEY, saveJSON } from "../util/persist";

interface HealthCheck {
  claude: boolean;
  gemini: boolean;
  node: boolean;
  gh: boolean;
  pwsh: boolean;
}

type NodeState = "pass" | "fail" | "neutral";

interface Dep {
  key: keyof HealthCheck;
  label: string;
  why: string;
}

// The AI engines — only ONE is required (any is a valid front door). `node` is
// listed as the ACP runtime: it's what `npx`-launches Codex/OpenCode/Cursor/…
// on demand, so a machine with just Node can still drive agents.
const ENGINES: Dep[] = [
  { key: "claude", label: "Claude Code CLI", why: "The orchestrator for native agent workflows." },
  { key: "gemini", label: "Gemini CLI", why: "Native Google Gemini integration." },
  { key: "node", label: "ACP agents (Codex, OpenCode, …)", why: "Node.js runtime — launches ACP engines on demand via npx." },
];

// Node & trace colour vocabulary.
const NODE_CLS: Record<NodeState, string> = {
  pass: "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.55)]",
  fail: "bg-red-500 shadow-[0_0_9px_2px_rgba(245,158,11,0.5)]",
  neutral: "bg-gray-600",
};
const SEG_CLS: Record<NodeState, string> = {
  pass: "bg-emerald-400/45 group-hover:bg-emerald-400/80",
  fail: "bg-red-500/45 group-hover:bg-red-500/80",
  neutral: "bg-edge group-hover:bg-gray-500/60",
};

// Per-dependency install hierarchy, in strict priority order:
//   1. package-manager command (winget on Windows, or npm for the npm CLIs),
//   2. official GitHub repo/releases (fallback A),
//   3. official homepage (fallback B — the least link-rot-prone).
interface InstallGuide {
  cmd?: string;
  repo?: { label: string; url: string };
  home?: { label: string; url: string };
}
const GUIDES: Record<keyof HealthCheck, InstallGuide> = {
  claude: {
    cmd: "npm install -g @anthropic-ai/claude-code",
    repo: { label: "anthropics/claude-code", url: "https://github.com/anthropics/claude-code" },
    home: { label: "claude.com/claude-code", url: "https://claude.com/claude-code" },
  },
  gemini: {
    cmd: "npm install -g @google/gemini-cli",
    repo: { label: "google-gemini/gemini-cli", url: "https://github.com/google-gemini/gemini-cli" },
    home: { label: "ai.google.dev", url: "https://ai.google.dev/gemini-api/docs" },
  },
  node: {
    cmd: "winget install OpenJS.NodeJS",
    home: { label: "nodejs.org", url: "https://nodejs.org" },
  },
  pwsh: {
    cmd: "winget install Microsoft.PowerShell",
    home: { label: "Microsoft Docs", url: "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows" },
  },
  gh: {
    cmd: "winget install GitHub.cli",
    repo: { label: "cli/cli", url: "https://github.com/cli/cli" },
    home: { label: "cli.github.com", url: "https://cli.github.com" },
  },
};

const CopyIcon = () => (
  <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.4" />
    <path d="M9.5 4.5V3A1.5 1.5 0 0 0 8 1.5H3A1.5 1.5 0 0 0 1.5 3v5A1.5 1.5 0 0 0 3 9.5h1.5" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 7.5 6 11l5.5-8" />
  </svg>
);
const ExternalIcon = () => (
  <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2h4v4M12 2 6.5 7.5M11 8.5V11a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5H6" />
  </svg>
);

/** A copyable command block: click the button → clipboard, swap to a checkmark
 *  for 2s. Layout is fixed-width so the swap never reflows the row. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
        copied ? "text-emerald-400" : "text-muted hover:bg-white/10 hover:text-gray-200"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** The failed-node "Quick Action & Installation Guide": command → repo → home,
 *  in muted amber tones so it never competes with the primary CTA. */
function InstallGuide({ k }: { k: keyof HealthCheck }) {
  const g = GUIDES[k];
  if (!g) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2">
      {g.cmd && (
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 text-[11px] text-amber-200/90">
            {g.cmd}
          </code>
          <CopyButton text={g.cmd} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[11px]">
        {g.repo && (
          <a
            href={g.repo.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-amber-200/70 underline-offset-2 hover:text-amber-100 hover:underline"
          >
            <ExternalIcon /> {g.repo.label}
          </a>
        )}
        {g.home && (
          <a
            href={g.home.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-gray-200 hover:underline"
          >
            <ExternalIcon /> {g.home.label}
          </a>
        )}
      </div>
    </div>
  );
}

/** One row on a trace: a rail (top segment · node · bottom segment) + content.
 *  `first`/`last` hide the dangling segment ends; `sub` shrinks the rail for
 *  the nested engine drawer. */
function TraceRow({
  state,
  first,
  last,
  sub,
  title,
  children,
}: {
  state: NodeState;
  first?: boolean;
  last?: boolean;
  sub?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex gap-3" title={title}>
      <div className={`flex flex-col items-center ${sub ? "w-4" : "w-6"}`}>
        <span className={`h-[19px] w-px transition-colors ${first ? "bg-transparent" : SEG_CLS[state]}`} />
        <span className={`${sub ? "h-2 w-2" : "h-2.5 w-2.5"} shrink-0 rounded-full transition-shadow ${NODE_CLS[state]}`} />
        <span className={`w-px flex-1 transition-colors ${last ? "bg-transparent" : SEG_CLS[state]}`} />
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  );
}

/** Label + optional badge + why + copyable install command. */
function DepBody({
  dep,
  state,
  badge,
}: {
  dep: Dep;
  state: NodeState;
  badge?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-100">{dep.label}</span>
        {badge}
      </div>
      <div className="text-xs text-muted">{dep.why}</div>
      {state === "fail" && <InstallGuide k={dep.key} />}
    </>
  );
}

export function OnboardingOverlay({ onDone }: { onDone: () => void }) {
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    invoke<HealthCheck>("health_check")
      .then((h) => {
        setHealth(h);
        // Auto-expand the engine drawer when no agent is available, so the
        // user immediately sees which one to install.
        if (!(h.claude || h.gemini || h.node)) setDrawer(true);
      })
      .catch(() => setHealth({ claude: true, gemini: true, node: true, gh: true, pwsh: true })); // fail open
  }, []);

  const dismiss = () => {
    saveJSON(KEY.onboardingDone, true);
    onDone();
  };

  const hasAnyEngine = !!health && ENGINES.some((e) => health[e.key]);
  const pwshOk = !!health && health.pwsh;
  const missingRequired = !!health && (!hasAnyEngine || !pwshOk);

  // Engine sub-node: present → pass; absent but another engine present →
  // neutral (a valid alternative, not a failure); absent with none present →
  // fail (a real break, this is what's blocking you).
  const engineState = (present: boolean): NodeState => (present ? "pass" : hasAnyEngine ? "neutral" : "fail");

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-7 bg-ink px-6">
      <div className="text-center">
        <div className="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
          Welcome to OctoShell
        </div>
        <div className="mt-1 text-xs text-muted">
          Environment check: ensuring all dependencies are ready for deployment.
        </div>
      </div>

      <div className="w-full max-w-md overflow-hidden rounded-xl border border-edge bg-panel">
        {health === null ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
            <span className="octo-spinner">🐙</span> Scanning your environment…
          </div>
        ) : (
          <div className="py-2 pl-4 pr-4">
            {/* AI Orchestration Engines — collapsible parent node. */}
            <TraceRow state={hasAnyEngine ? "pass" : "fail"} first>
              <button
                onClick={() => setDrawer((v) => !v)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className="text-sm font-medium text-gray-100">AI Orchestration Engines</span>
                <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  Required · choose 1
                </span>
                <svg
                  viewBox="0 0 12 12"
                  className={`ml-auto h-3 w-3 text-muted transition-transform duration-300 ${drawer ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 2.5 8 6l-4 3.5" />
                </svg>
              </button>
              <div className="mt-0.5 text-xs text-muted">
                {hasAnyEngine ? "At least one engine is ready." : "No agent engine found — install one below."}
              </div>

              {/* Accordion drawer: nested sub-trace of individual engines. */}
              <div
                className={`grid transition-[grid-template-rows] duration-300 ease-out ${
                  drawer ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                }`}
              >
                <div className="overflow-hidden">
                  <div className="mt-2 pl-1">
                    {ENGINES.map((e, i) => {
                      const st = engineState(health[e.key]);
                      return (
                        <TraceRow
                          key={e.key}
                          state={st}
                          sub
                          first={i === 0}
                          last={i === ENGINES.length - 1}
                          title={st === "fail" ? "Missing — see install options below." : undefined}
                        >
                          <DepBody
                            dep={e}
                            state={st}
                            badge={
                              st === "pass" ? (
                                <span className="text-[10px] font-medium text-emerald-400">detected</span>
                              ) : st === "neutral" ? (
                                <span className="text-[10px] text-muted">alternative</span>
                              ) : undefined
                            }
                          />
                        </TraceRow>
                      );
                    })}
                  </div>
                </div>
              </div>
            </TraceRow>

            {/* PowerShell 7 — hard requirement. */}
            <TraceRow
              state={pwshOk ? "pass" : "fail"}
              title={pwshOk ? undefined : "Missing — see install options below."}
            >
              <DepBody
                dep={{ key: "pwsh", label: "PowerShell 7", why: "Core shell & tab-completion engine." }}
                state={pwshOk ? "pass" : "fail"}
                badge={
                  <span className="rounded border border-edge bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    Required
                  </span>
                }
              />
            </TraceRow>

            {/* GitHub CLI — optional, so a miss reads neutral, not a break. */}
            <TraceRow state={health.gh ? "pass" : "neutral"} last>
              <DepBody
                dep={{ key: "gh", label: "GitHub CLI", why: "Integrated PR and remote management." }}
                state={health.gh ? "pass" : "neutral"}
                badge={
                  <span className="rounded border border-edge bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    Optional
                  </span>
                }
              />
            </TraceRow>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        <button
          onClick={dismiss}
          disabled={health === null || missingRequired}
          title={missingRequired ? "Install the missing tools above, then restart OctoShell." : undefined}
          className="rounded-lg bg-gradient-to-r from-purple-600 to-cyan-500 px-6 py-2 text-sm font-semibold text-white transition-all hover:brightness-110 hover:shadow-[0_0_15px_rgba(6,182,212,0.5)] disabled:cursor-not-allowed disabled:from-gray-700 disabled:to-gray-700 disabled:text-muted disabled:shadow-none disabled:saturate-0"
        >
          {missingRequired ? "Fix required dependencies" : "Get started"}
        </button>
        {missingRequired && (
          <button
            onClick={dismiss}
            className="text-[11px] text-muted underline-offset-2 transition-colors hover:text-gray-300 hover:underline"
          >
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}
