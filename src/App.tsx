import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ShellController } from "./shell/ShellController";
import { sandboxLoginCommandFor } from "./agents/providers";
import { useShell } from "./shell/useShell";
import { Feed, pendingMountCount, setMountBudget } from "./blocks/Feed";
import { ReviewPanel, ReviewSwitch, useReview, type CenterView } from "./review/ReviewView";
import { InputBar } from "./blocks/InputBar";
import { AiSidebar } from "./ai/AiSidebar";
import { MacroBar } from "./macros/MacroBar";
import { TraceProgress } from "./blocks/TraceProgress";
import { ProjectSidebar } from "./projects/ProjectSidebar";
import { Titlebar } from "./chrome/Titlebar";
import { ServiceBar } from "./services/ServiceBar";
import { serviceStore } from "./services/serviceStore";
import { SettingsPage } from "./settings/SettingsPage";
import { settingsStore, useSettings } from "./settings/settingsStore";
import { KEY, loadJSON, saveJSON } from "./util/persist";
import { OnboardingOverlay } from "./onboarding/OnboardingOverlay";

interface Tab {
  id: string;
  name: string;
  cwd: string;
  controller: ShellController;
  /** Set when this project is an isolated git worktree: which repo to clean up
   *  on close, and which project it was branched from (for nested display). */
  worktree?: { repoRoot: string; parentId: string };
}

interface SavedProject {
  id: string;
  name: string;
  cwd: string;
  worktree?: { repoRoot: string; parentId: string };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export interface GitStat {
  branch: string;
  added: number;
  removed: number;
}

export interface Group {
  id: string;
  name: string;
  color: string;
}

interface GroupsState {
  groups: Group[];
  assign: Record<string, string>; // projectId → groupId
}

export const GROUP_COLORS = ["#82AAFF", "#C792EA", "#4ade80", "#f78c6c", "#f07178", "#7fdbca", "#ffcb6b", "#ff5370"];

// One-shot probe: "<branch>|<git diff --shortstat HEAD>". Empty branch ⇒ not a repo.
const GIT_PROBE =
  "\"$(git rev-parse --abbrev-ref HEAD 2>$null)|$(git diff --shortstat HEAD 2>$null)\"";

function parseGitStat(out: string): GitStat | null {
  const [branch, stat = ""] = out.trim().split("|");
  if (!branch) return null;
  const add = /(\d+) insertion/.exec(stat)?.[1];
  const del = /(\d+) deletion/.exec(stat)?.[1];
  return { branch: branch.trim(), added: add ? Number(add) : 0, removed: del ? Number(del) : 0 };
}

/**
 * Poll git branch + diff stat, but ONLY for the projects you're actually using —
 * the active one plus any you've "touched" (ran a command/agent in) this session.
 * With 15 work projects open but 1-2 in use, polling all of them spawned a `git
 * status` (pwsh) per repo every cycle for no reason. Untouched projects are
 * skipped; switching to one probes it once so its badge is fresh.
 */
function useGitStats(tabs: Tab[], activeId: string): Map<string, GitStat> {
  const [stats, setStats] = useState<Map<string, GitStat>>(new Map());
  const key = tabs.map((t) => `${t.id}:${t.cwd}`).join(",");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  // Probe a specific set of tabs and MERGE results, so projects we skip keep
  // their existing badge instead of being wiped.
  const probe = useCallback(async (which: Tab[]) => {
    const updates = await Promise.all(
      which.map(async (t): Promise<[string, GitStat | null]> => {
        if (!t.cwd) return [t.id, null];
        try {
          const out = await invoke<string>("run_capture", { cwd: t.cwd, command: GIT_PROBE });
          return [t.id, parseGitStat(out)];
        } catch {
          return [t.id, null];
        }
      }),
    );
    setStats((prev) => {
      const next = new Map(prev);
      for (const [id, stat] of updates) {
        if (stat) next.set(id, stat);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // 60s poll of only the relevant projects, and only while the window is visible.
  useEffect(() => {
    let alive = true;
    const relevant = () =>
      tabsRef.current.filter(
        (t) => t.id === activeRef.current || t.controller.getSnapshot().touched,
      );
    const tick = () => { if (!document.hidden && alive) void probe(relevant()); };
    tick();
    const iv = setInterval(tick, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, [key, probe]);

  // Switching to a project probes just that one, so its badge updates on demand.
  useEffect(() => {
    const t = tabs.find((x) => x.id === activeId);
    if (t) void probe([t]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, probe]);

  return stats;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** A draggable vertical divider that resizes the panel beside it. */
function ResizeHandle({ onDrag, onReset }: { onDrag: (dx: number) => void; onReset: () => void }) {
  // Pointer capture (not document mouse listeners): the move/up events are bound
  // to the handle element and captured to it, so an alt-tab or a mouse-up outside
  // the window still delivers `lostpointercapture`/`pointerup` → we always clean
  // up. The old document-listener version leaked on a missed mouseup, leaving a
  // global mousemove handler that re-rendered the whole app on every cursor move.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onDrag(dx);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.removeEventListener("lostpointercapture", end);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      style={{ cursor: "col-resize" }}
      title="Drag to resize · double-click to reset"
      className="group flex w-2 shrink-0 items-center justify-center"
    >
      <span className="h-10 w-0.5 rounded-full bg-edge transition-colors group-hover:bg-accent" />
    </div>
  );
}

export function App({ initial }: { initial: ShellController }) {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: initial.sessionId, name: "home", cwd: "", controller: initial },
  ]);
  const [activeId, setActiveId] = useState(initial.sessionId);
  const [hydrated, setHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Startup preload: once projects are restored we eagerly mount every block of
  // every project (desktop app — it's all local), behind a loading overlay, so
  // switching/scrolling afterwards has zero lag. `preloading` drives both the
  // overlay and the `eager` flag on every panel.
  // Preload disabled: eager-mounting every project's blocks built a huge
  // always-laid-out DOM whose reflows froze the UI. We keep a small DOM instead
  // (each panel virtualizes its feed). Left wired but off in case we revisit it.
  const [preloading, setPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  const [onboarding, setOnboarding] = useState(() => !loadJSON<boolean>(KEY.onboardingDone, false));
  // User-resizable panel widths (px), persisted across restarts.
  const [layout, setLayout] = useState(() => loadJSON(KEY.layout, { left: 200, right: 344 }));

  useEffect(() => { saveJSON(KEY.layout, layout); }, [layout]);

  // Keep all three columns shrinking together: when the window gets too narrow
  // for the saved side widths + a usable center, scale the side columns down
  // proportionally (display only — the saved layout is untouched, so widening the
  // window restores them).
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { effLeft, effRight } = useMemo(() => {
    const CENTER_MIN = 300; // keep the center usable before the sides give way
    const CHROME = 40; // outer p-2 padding + the two resize handles
    const avail = winW - CHROME;
    let l = layout.left;
    let r = layout.right;
    const over = l + r + CENTER_MIN - avail;
    if (over > 0) {
      const side = l + r;
      l = Math.max(150, l - (over * l) / side);
      r = Math.max(220, r - (over * r) / side);
    }
    return { effLeft: Math.round(l), effRight: Math.round(r) };
  }, [winW, layout.left, layout.right]);

  // Drive the preload: turbo the mount budget while the overlay covers the UI,
  // watch the scheduler's queue drain, then reveal the app. A frame cap is a
  // safety net so we never get stuck on the overlay (e.g. nothing to preload).
  useEffect(() => {
    if (!hydrated || !preloading) return;
    setMountBudget(16);
    let peak = 0;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames += 1;
      const pending = pendingMountCount();
      peak = Math.max(peak, pending);
      setPreloadProgress(peak > 0 ? Math.min(1, 1 - pending / peak) : 0);
      const drained = peak > 0 && pending === 0;
      const nothingToDo = peak === 0 && frames > 24; // ~0.4s with no work queued
      const timedOut = frames > 1800; // ~30s hard cap, never trap the user
      if (drained || nothingToDo || timedOut) {
        setMountBudget(0); // back to interactive default
        setPreloadProgress(1);
        setPreloading(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hydrated, preloading]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // Keep each controller's display name in sync (used in agent notifications).
  useEffect(() => {
    tabs.forEach((t) => { t.controller.displayName = t.name; });
  }, [tabs]);

  const gitStats = useGitStats(tabs, activeId);

  // Project groups (workspace-global), persisted.
  const [groupsState, setGroupsState] = useState<GroupsState>(() =>
    loadJSON<GroupsState>(KEY.groups, { groups: [], assign: {} }),
  );
  useEffect(() => { saveJSON(KEY.groups, groupsState); }, [groupsState]);

  const createGroup = (name: string): string => {
    const id = crypto.randomUUID();
    setGroupsState((s) => ({
      ...s,
      groups: [...s.groups, { id, name: name.trim() || "Group", color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length] }],
    }));
    return id;
  };
  const assignGroup = (projectId: string, groupId: string | null) =>
    setGroupsState((s) => {
      const assign = { ...s.assign };
      if (groupId) assign[projectId] = groupId;
      else delete assign[projectId];
      return { ...s, assign };
    });

  const setGroupColor = (groupId: string, color: string) =>
    setGroupsState((s) => ({ ...s, groups: s.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) }));
  const renameGroup = (groupId: string, name: string) =>
    setGroupsState((s) => ({
      ...s,
      groups: s.groups.map((g) => (g.id === groupId ? { ...g, name: name.trim() || g.name } : g)),
    }));
  const deleteGroup = (groupId: string) =>
    setGroupsState((s) => {
      const assign = { ...s.assign };
      for (const k of Object.keys(assign)) if (assign[k] === groupId) delete assign[k];
      return { groups: s.groups.filter((g) => g.id !== groupId), assign };
    });
  const reorderGroup = (dragId: string, targetId: string, pos: "before" | "after") => {
    if (dragId === targetId) return;
    setGroupsState((s) => {
      const from = s.groups.findIndex((g) => g.id === dragId);
      if (from < 0) return s;
      const arr = [...s.groups];
      const [moved] = arr.splice(from, 1);
      let to = arr.findIndex((g) => g.id === targetId);
      if (to < 0) return s;
      if (pos === "after") to += 1;
      arr.splice(to, 0, moved);
      return { ...s, groups: arr };
    });
  };

  // Drag-to-reorder a project relative to another (order persists via the
  // projects effect, which saves in `tabs` order).
  const reorderProject = (dragId: string, targetId: string, pos: "before" | "after") => {
    if (dragId === targetId) return;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === dragId);
      if (from < 0) return prev;
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      let to = arr.findIndex((t) => t.id === targetId);
      if (to < 0) return prev;
      if (pos === "after") to += 1;
      arr.splice(to, 0, moved);
      return arr;
    });
  };

  // Restore previously-open projects ONCE. The ref guard is essential: React
  // Fast Refresh (HMR) re-runs effects while preserving state, so without it
  // every code edit would re-append the saved projects → duplicate tabs (each
  // spawning its own PTY + WebGL context). Dedup by folder too, and never add a
  // cwd that's already open — belt and suspenders against duplicates.
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    const saved = loadJSON<SavedProject[]>(KEY.projects, []);
    const seen = new Set<string>();
    const unique = saved.filter((p) => p.cwd && !seen.has(p.cwd) && (seen.add(p.cwd), true));
    let cancelled = false;
    (async () => {
      const restored: Tab[] = [];
      for (const p of unique) {
        const controller = new ShellController(p.id);
        await controller.init(p.cwd);
        restored.push({ id: p.id, name: p.name, cwd: p.cwd, controller, worktree: p.worktree });
      }
      if (!cancelled && restored.length) {
        setTabs((t) => {
          const have = new Set(t.map((x) => x.cwd));
          return [...t, ...restored.filter((r) => !have.has(r.cwd))];
        });
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the project list (everything except the always-present home tab),
  // deduped by folder so the stored list can never grow unbounded.
  useEffect(() => {
    if (!hydrated) return;
    const seen = new Set<string>();
    const saved: SavedProject[] = tabs
      .filter((t) => t.id !== initial.sessionId && t.cwd && !seen.has(t.cwd) && (seen.add(t.cwd), true))
      .map((t) => ({ id: t.id, name: t.name, cwd: t.cwd, worktree: t.worktree }));
    saveJSON(KEY.projects, saved);
  }, [tabs, hydrated, initial.sessionId]);

  const newProject = async () => {
    const folder = await open({ directory: true, multiple: false, title: "Pick a project folder" });
    if (typeof folder !== "string") return;
    // Already open? Just focus it instead of spawning a duplicate.
    const existing = tabs.find((t) => t.cwd === folder);
    if (existing) { setActiveId(existing.id); return; }
    const controller = new ShellController(crypto.randomUUID());
    await controller.init(folder);
    const tab: Tab = { id: controller.sessionId, name: basename(folder), cwd: folder, controller };
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  };

  /** Core worktree creation: branch a git worktree off `srcId`, register it as a
   *  nested tab with its OWN controller/agent session, and return it. Returns an
   *  `{ error }` instead of throwing so each caller surfaces it its own way. Shared
   *  by the sidebar "New worktree" button and the orchestrator's worktree-dispatch
   *  — both go through here so an orchestrator-made worktree is a first-class
   *  session (shows in the bar, gets its own agent), not an invisible on-disk dir. */
  const createWorktree = async (srcId: string, branch: string): Promise<Tab | { error: string }> => {
    const src = tabs.find((t) => t.id === srcId);
    if (!src?.cwd) return { error: "not a git project (home is not a repo)" };
    const branchName = branch.trim().replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^-+|-+$/g, "");
    if (!branchName) return { error: "invalid branch name" };
    const dirName = branchName.replace(/\//g, "-");
    // New worktrees branch off the configured base branch (Settings → Workspace),
    // or the main worktree's HEAD when unset. Sanitised the same way as the branch.
    const baseBranch = settingsStore.getSnapshot().workspace.baseBranch.trim().replace(/[^A-Za-z0-9._/-]/g, "");
    const baseArg = baseBranch ? ` "${baseBranch}"` : "";
    // Resolve the MAIN worktree, ignore the managed folder locally, create the
    // worktree + branch, and print its path (or ERR:…). One pwsh round-trip.
    const script =
      "$main=(git worktree list --porcelain|Where-Object{$_ -like 'worktree *'}|Select-Object -First 1);" +
      "if(-not $main){Write-Output 'ERR:not a git repo';return};" +
      "$main=($main.Substring(9).Trim() -replace '\\\\','/');" +
      `$wt="$main/.octoshell/worktrees/${dirName}";` +
      "$excl=\"$main/.git/info/exclude\";" +
      "if((Test-Path $excl) -and -not (Select-String -Path $excl -Pattern 'octoshell' -Quiet)){Add-Content -Path $excl -Value '.octoshell/'};" +
      `$r=git -C "$main" worktree add -b "${branchName}" "$wt"${baseArg} 2>&1;` +
      `if($LASTEXITCODE -ne 0){$r=git -C "$main" worktree add "$wt" "${branchName}" 2>&1};` +
      "if($LASTEXITCODE -ne 0){Write-Output ('ERR:'+($r -join ' '))}else{Write-Output $wt}";
    let out = "";
    try {
      out = (await invoke<string>("run_capture", { cwd: src.cwd, command: script })).trim();
    } catch (e) {
      out = "ERR:" + e;
    }
    const last = out.split(/\r?\n/).pop()?.trim() ?? "";
    if (!last || last.startsWith("ERR:")) {
      return { error: last.replace(/^ERR:/, "") || "unknown" };
    }
    const wtPath = last;
    const repoRoot = wtPath.split("/.octoshell/")[0];
    // Copy untracked/gitignored root-level .env* from the base checkout into the
    // new worktree. `git worktree add` only materialises TRACKED files, so secrets
    // (Maps key, NEXT_PUBLIC_API_URL, …) are missing and a dev server here would
    // crash on launch. Best-effort: never block worktree creation on this. Gated by
    // the Settings → Workspace "auto-copy .env*" toggle.
    if (settingsStore.getSnapshot().workspace.copyEnv) {
      try {
        await invoke<string>("run_capture", {
          cwd: repoRoot,
          command:
            "Get-ChildItem -Path . -Filter '.env*' -File -Force | " +
            `ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path '${wtPath}' $_.Name) -Force }`,
        });
      } catch {
        /* missing .env / copy failure is non-fatal */
      }
    }
    const controller = new ShellController(crypto.randomUUID());
    await controller.init(wtPath);
    const tab: Tab = {
      id: controller.sessionId,
      name: dirName,
      cwd: wtPath,
      controller,
      worktree: { repoRoot, parentId: src.id },
    };
    // Insert right after the parent (and its existing worktrees) so it nests.
    setTabs((t) => {
      const arr = [...t];
      let idx = arr.findIndex((x) => x.id === src.id);
      if (idx < 0) { arr.push(tab); return arr; }
      idx += 1;
      while (idx < arr.length && arr[idx].worktree?.parentId === src.id) idx += 1;
      arr.splice(idx, 0, tab);
      return arr;
    });
    return tab;
  };

  /** Sidebar "New worktree" button: branch off the active project, focus the new
   *  tab, and on failure echo the git error into the source project's input. */
  const newWorktree = async (branch: string) => {
    const src = tabs.find((t) => t.id === activeId) ?? tabs[0];
    const result = await createWorktree(src?.id ?? "", branch);
    if ("error" in result) {
      src?.controller.setInput(`# Worktree error: ${result.error}`);
      return;
    }
    setActiveId(result.id);
  };

  /** Orchestrator worktree-dispatch: branch off `srcId`, focus it, and hand the
   *  new session back so the assistant can run an agent in it. Null on failure. */
  const createWorktreeForAgent = async (
    srcId: string,
    branch: string,
  ): Promise<{ id: string; name: string; controller: ShellController } | null> => {
    const result = await createWorktree(srcId, branch);
    if ("error" in result) return null;
    setActiveId(result.id);
    return { id: result.id, name: result.name, controller: result.controller };
  };

  const closeProject = (id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const tab = prev.find((t) => t.id === id);
      // Isolated worktree → remove it from git (best-effort) on close.
      if (tab?.worktree) {
        invoke("run_capture", {
          cwd: tab.worktree.repoRoot,
          command: `git worktree remove "${tab.cwd}" --force 2>&1`,
        }).catch(() => {});
      }
      tab?.controller.forget();
      tab?.controller.dispose();
      const remaining = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(remaining[remaining.length - 1].id);
      return remaining;
    });
  };

  // Auto-clean (Settings → Workspace = "onMerge"): periodically ask GitHub whether
  // each worktree's PR has merged/closed and, if so, remove the worktree. Reads via
  // refs so the long-lived interval always sees the latest tabs/close handler.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeProjectRef = useRef(closeProject);
  closeProjectRef.current = closeProject;
  useEffect(() => {
    const tick = async () => {
      if (settingsStore.getSnapshot().workspace.autoClean !== "onMerge") return;
      for (const t of tabsRef.current) {
        if (!t.worktree) continue;
        let state = "";
        try {
          state = (
            await invoke<string>("run_capture", {
              cwd: t.cwd,
              command: "$b=git branch --show-current; if($b){gh pr view $b --json state -q .state 2>$null}",
            })
          )
            .trim()
            .toUpperCase();
        } catch {
          continue; // gh missing / not authed / no PR — skip silently
        }
        if (state.includes("MERGED") || state.includes("CLOSED")) closeProjectRef.current(t.id);
      }
    };
    const iv = setInterval(() => void tick(), 120000);
    return () => clearInterval(iv);
  }, []);

  // Workspace keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "t") { e.preventDefault(); void newProject(); }
      else if (e.key === "w") { e.preventDefault(); closeProject(activeId); }
      else if (e.shiftKey && (e.key === "K" || e.key === "k")) { e.preventDefault(); active.controller.clear(); }
      else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < tabs.length) { e.preventDefault(); setActiveId(tabs[i].id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId]);

  // Attach the managed-services event stream once, so the bottom ServiceBar shows
  // any server OctoShell starts (from the shell offer or, later, QA mode).
  useEffect(() => {
    serviceStore.init();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <ThemeApplier />
      {onboarding && <OnboardingOverlay onDone={() => setOnboarding(false)} />}
      {!onboarding && preloading && <StartupOverlay progress={preloadProgress} count={tabs.length} />}
      <Titlebar />
      <div className="relative flex flex-1 flex-col overflow-hidden bg-well">
        <div className="flex flex-1 overflow-hidden p-2">
        <ProjectSidebar
          tabs={tabs.map((t) => ({ id: t.id, name: t.name, parentId: t.worktree?.parentId, controller: t.controller }))}
          activeId={active.id}
          onSelect={setActiveId}
          onClose={closeProject}
          onNew={newProject}
          onNewWorktree={newWorktree}
          onOpenSettings={() => setSettingsOpen(true)}
          stats={gitStats}
          groups={groupsState.groups}
          assign={groupsState.assign}
          onAssign={assignGroup}
          onCreateGroup={createGroup}
          onReorder={reorderProject}
          onReorderGroup={reorderGroup}
          onSetGroupColor={setGroupColor}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
          palette={GROUP_COLORS}
          width={effLeft}
        />
        <ResizeHandle
          onDrag={(dx) => setLayout((l) => ({ ...l, left: clamp(l.left + dx, 160, 460) }))}
          onReset={() => setLayout((l) => ({ ...l, left: 208 }))}
        />

        {/* Every project's center panel stays mounted (so switching back doesn't
            rebuild it), but inactive ones use display:none so they're excluded
            from layout — otherwise the browser reflows every project's blocks on
            any DOM change, which froze the UI. Each panel virtualizes its own
            feed, so the live laid-out DOM stays ≈ one viewport. */}
        <div className="relative flex-1 overflow-hidden rounded-xl border border-edge bg-panel">
          {tabs.map((t) => (
            <CenterPanel key={t.id} controller={t.controller} active={t.id === active.id} />
          ))}
        </div>

        <ResizeHandle
          onDrag={(dx) => setLayout((l) => ({ ...l, right: clamp(l.right - dx, 232, 760) }))}
          onReset={() => setLayout((l) => ({ ...l, right: 344 }))}
        />
        <AiSidebar
          tabs={tabs.map((t) => ({ id: t.id, name: t.name, controller: t.controller }))}
          activeId={active.id}
          onSelect={setActiveId}
          onCreateWorktree={createWorktreeForAgent}
          onCloseProject={closeProject}
          width={effRight}
        />
        </div>
        <ServiceBar />
        {settingsOpen && (
          <div className="absolute inset-0 z-40">
            <SettingsPage
              onClose={() => setSettingsOpen(false)}
              onShowOnboarding={() => {
                setSettingsOpen(false);
                setOnboarding(true);
              }}
              onSandboxLogin={() => {
                // Run the one-time sandbox login in the active project's terminal
                // (OctoShell renders the CLI's interactive TUI); the user does
                // the browser device-code step there. Provider-aware: uses the
                // active project's agent CLI, falling back to the Claude adapter
                // when that provider has no sandbox login (e.g. native providers).
                const provider = active.controller.getSnapshot().agentProvider;
                const cmd = sandboxLoginCommandFor(provider) ?? sandboxLoginCommandFor("acp-claude");
                if (!cmd) return;
                active.controller.setMode("shell");
                active.controller.submit(cmd);
                setSettingsOpen(false);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Full-window startup splash shown while every project's history is mounted into
 *  memory, so the app proper opens already-warm (zero lag on later switches). */
function StartupOverlay({ progress, count }: { progress: number; count: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-ink">
      <div className="octo-spinner text-5xl">🐙</div>
      <div className="text-sm font-medium text-gray-200">Loading OctoShell…</div>
      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-edge">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-muted">
        {count} project{count === 1 ? "" : "s"} · {pct}%
      </div>
    </div>
  );
}

/** Applies the Appearance settings to the document root: the monospace font CSS
 *  variable (terminal/feed pick it up) and the PCB trace-speed class. */
function ThemeApplier() {
  const { appearance } = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--octo-mono",
      appearance.fontFamily
        ? `"${appearance.fontFamily}", "JetBrains Mono", "Cascadia Code", Consolas, monospace`
        : "",
    );
    root.classList.remove("trace-fast", "trace-normal", "trace-stealth", "trace-static");
    if (appearance.traceSpeed !== "normal") root.classList.add(`trace-${appearance.traceSpeed}`);
  }, [appearance.fontFamily, appearance.traceSpeed]);
  return null;
}

/** Center column: top bar (cwd + macros) · feed · input — for one session.
 *  Kept mounted even when not `active`; hidden via display:none so its state and
 *  built DOM persist across project switches. */
const CenterPanel = memo(function CenterPanel({
  controller,
  active,
}: {
  controller: ShellController;
  active: boolean;
}) {
  const { blocks, cwd, busy, input, altScreen, interacting, mode, agentBusy, agentOrchestrated, agentModel, agentProvider, agentConfigDir, agentTokens, agentContext, agentProgress, agentApiKey, agentRateReset, agentApproval } = useShell(controller);
  const reviewSnap = useReview(controller);
  const [view, setView] = useState<CenterView>("coding");
  // The Review view only exists while a review agent is active; fall back to Coding
  // if it's gone (or was never started).
  const showReview = view === "review" && reviewSnap.active;

  return (
    <section
      className={`absolute inset-0 flex-col gap-2 overflow-hidden p-2 ${active ? "flex" : "hidden"}`}
    >
      <div className="flex shrink-0 items-center gap-2 rounded-lg border border-edge bg-card px-3 py-1.5">
        {/* Task progress lives up top: a trace bar that fills as the agent completes
            its planned steps. Empty when there's no active plan (the cwd path now
            lives under the Shell/Agent switch in the input bar). */}
        <div className="min-w-0 flex-1">
          {agentProgress && agentProgress.length > 0 && <TraceProgress steps={agentProgress} />}
        </div>
        <MacroBar controller={controller} active={active} />
      </div>
      {/* Chat panel — the conversation feed with the command input pinned below.
          In Review view it swaps to the review agent's feed + reviewer input. When a
          review agent exists, a thin header strip holds the Coding⇄Review switch in
          its own top-right panel (in the layout, so content never falls under it). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-edge bg-card">
      {reviewSnap.active && (
        <div className="flex shrink-0 justify-end border-b border-edge bg-chrome/40 px-2 py-1.5">
          <ReviewSwitch view={view} onChange={setView} busy={reviewSnap.busy} />
        </div>
      )}
      {showReview ? (
        <ReviewPanel controller={controller} snap={reviewSnap} />
      ) : (
      <>
      <Feed blocks={blocks} controller={controller} altScreen={altScreen} interacting={interacting} />
      <InputBar
        controller={controller}
        cwd={cwd}
        busy={busy}
        value={input}
        altScreen={altScreen}
        interacting={interacting}
        mode={mode}
        agentBusy={agentBusy}
        agentOrchestrated={agentOrchestrated}
        agentModel={agentModel}
        agentProvider={agentProvider}
        agentConfigDir={agentConfigDir}
        agentTokens={agentTokens}
        agentContext={agentContext}
        agentApiKey={agentApiKey}
        agentRateReset={agentRateReset}
        agentApproval={agentApproval}
      />
      </>
      )}
      </div>
    </section>
  );
});
