import { memo, useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ShellController } from "./shell/ShellController";
import { useShell } from "./shell/useShell";
import { Feed, pendingMountCount, setMountBudget } from "./blocks/Feed";
import { InputBar } from "./blocks/InputBar";
import { AiSidebar } from "./ai/AiSidebar";
import { MacroBar } from "./macros/MacroBar";
import { SmartPrButton } from "./macros/SmartPrButton";
import { ProjectSidebar } from "./projects/ProjectSidebar";
import { Titlebar } from "./chrome/Titlebar";
import { KEY, loadJSON, saveJSON } from "./util/persist";

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
      title="Σύρε για resize · διπλό κλικ για επαναφορά"
      className="w-1 shrink-0 bg-edge transition-colors hover:bg-accent"
    />
  );
}

export function App({ initial }: { initial: ShellController }) {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: initial.sessionId, name: "home", cwd: "", controller: initial },
  ]);
  const [activeId, setActiveId] = useState(initial.sessionId);
  const [hydrated, setHydrated] = useState(false);
  // Startup preload: once projects are restored we eagerly mount every block of
  // every project (desktop app — it's all local), behind a loading overlay, so
  // switching/scrolling afterwards has zero lag. `preloading` drives both the
  // overlay and the `eager` flag on every panel.
  // Preload disabled: eager-mounting every project's blocks built a huge
  // always-laid-out DOM whose reflows froze the UI. We keep a small DOM instead
  // (each panel virtualizes its feed). Left wired but off in case we revisit it.
  const [preloading, setPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  // User-resizable panel widths (px), persisted across restarts.
  const [layout, setLayout] = useState(() => loadJSON(KEY.layout, { left: 208, right: 384 }));

  useEffect(() => { saveJSON(KEY.layout, layout); }, [layout]);

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
      groups: [...s.groups, { id, name: name.trim() || "Ομάδα", color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length] }],
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
    const folder = await open({ directory: true, multiple: false, title: "Διάλεξε project folder" });
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

  const newWorktree = async (branch: string) => {
    const src = tabs.find((t) => t.id === activeId) ?? tabs[0];
    if (!src.cwd) { src.controller.setInput("# Άνοιξε πρώτα ένα git project (το home δεν είναι repo)"); return; }
    const branchName = branch.trim().replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^-+|-+$/g, "");
    if (!branchName) return;
    const dirName = branchName.replace(/\//g, "-");
    // Resolve the MAIN worktree, ignore the managed folder locally, create the
    // worktree + branch, and print its path (or ERR:…). One pwsh round-trip.
    const script =
      "$main=(git worktree list --porcelain|Where-Object{$_ -like 'worktree *'}|Select-Object -First 1);" +
      "if(-not $main){Write-Output 'ERR:not a git repo';return};" +
      "$main=($main.Substring(9).Trim() -replace '\\\\','/');" +
      `$wt="$main/.octoshell/worktrees/${dirName}";` +
      "$excl=\"$main/.git/info/exclude\";" +
      "if((Test-Path $excl) -and -not (Select-String -Path $excl -Pattern 'octoshell' -Quiet)){Add-Content -Path $excl -Value '.octoshell/'};" +
      `$r=git -C "$main" worktree add -b "${branchName}" "$wt" 2>&1;` +
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
      src.controller.setInput(`# Worktree error: ${last.replace(/^ERR:/, "") || "unknown"}`);
      return;
    }
    const wtPath = last;
    const repoRoot = wtPath.split("/.octoshell/")[0];
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
    setActiveId(tab.id);
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

  return (
    <div className="flex h-full flex-col">
      {preloading && <StartupOverlay progress={preloadProgress} count={tabs.length} />}
      <Titlebar />
      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar
          tabs={tabs.map((t) => ({ id: t.id, name: t.name, parentId: t.worktree?.parentId, controller: t.controller }))}
          activeId={active.id}
          onSelect={setActiveId}
          onClose={closeProject}
          onNew={newProject}
          onNewWorktree={newWorktree}
          width={layout.left}
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
        <div className="relative flex-1 overflow-hidden">
          {tabs.map((t) => (
            <CenterPanel key={t.id} controller={t.controller} active={t.id === active.id} />
          ))}
        </div>

        <ResizeHandle
          onDrag={(dx) => setLayout((l) => ({ ...l, right: clamp(l.right - dx, 260, 760) }))}
          onReset={() => setLayout((l) => ({ ...l, right: 384 }))}
        />
        <AiSidebar
          tabs={tabs.map((t) => ({ id: t.id, name: t.name, controller: t.controller }))}
          activeId={active.id}
          onSelect={setActiveId}
          width={layout.right}
        />
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
      <div className="text-sm font-medium text-gray-200">Φόρτωση OctoShell…</div>
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
  const { blocks, cwd, busy, input, altScreen, interacting, mode, agentBusy, agentModel, agentProvider, agentTokens, agentContext, agentApiKey, agentRateReset, agentApproval } = useShell(controller);

  return (
    <section
      className={`absolute inset-0 flex-col overflow-hidden ${active ? "flex" : "hidden"}`}
    >
      <div className="flex items-center gap-3 border-b border-edge bg-panel px-3 py-1.5">
        <span className="truncate text-xs text-muted">{cwd || "~"}</span>
        <div className="flex-1" />
        <SmartPrButton controller={controller} active={active} />
        <MacroBar controller={controller} />
      </div>
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
        agentModel={agentModel}
        agentProvider={agentProvider}
        agentTokens={agentTokens}
        agentContext={agentContext}
        agentApiKey={agentApiKey}
        agentRateReset={agentRateReset}
        agentApproval={agentApproval}
      />
    </section>
  );
});
