import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ShellController } from "./shell/ShellController";
import { useShell } from "./shell/useShell";
import { Feed } from "./blocks/Feed";
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

/** Poll each project's git branch + diff stat (lightweight, every 30s). */
function useGitStats(tabs: Tab[]): Map<string, GitStat> {
  const [stats, setStats] = useState<Map<string, GitStat>>(new Map());
  const key = tabs.map((t) => `${t.id}:${t.cwd}`).join(",");
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const next = new Map<string, GitStat>();
      await Promise.all(
        tabs.map(async (t) => {
          if (!t.cwd) return;
          try {
            const out = await invoke<string>("run_capture", { cwd: t.cwd, command: GIT_PROBE });
            const parsed = parseGitStat(out);
            if (parsed) next.set(t.id, parsed);
          } catch {
            /* not a repo / git missing — no badge */
          }
        }),
      );
      if (alive) setStats(next);
    };
    void refresh();
    const iv = setInterval(refresh, 30_000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stats;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** A draggable vertical divider that resizes the panel beside it. */
function ResizeHandle({ onDrag, onReset }: { onDrag: (dx: number) => void; onReset: () => void }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onDrag(dx);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    <div
      onMouseDown={onMouseDown}
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
  // User-resizable panel widths (px), persisted across restarts.
  const [layout, setLayout] = useState(() => loadJSON(KEY.layout, { left: 208, right: 384 }));

  useEffect(() => { saveJSON(KEY.layout, layout); }, [layout]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // Keep each controller's display name in sync (used in agent notifications).
  useEffect(() => {
    tabs.forEach((t) => { t.controller.displayName = t.name; });
  }, [tabs]);

  const gitStats = useGitStats(tabs);

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

        {/* Center is keyed by active id so the panels re-bind to the active controller.
            The assistant is global (one across all projects) — not keyed. */}
        <CenterPanel key={active.id} controller={active.controller} />

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

/** Center column: top bar (cwd + macros) · feed · input — for one session. */
function CenterPanel({ controller }: { controller: ShellController }) {
  const { blocks, cwd, busy, input, altScreen, interacting, mode, agentBusy, agentModel, agentProvider, agentTokens, agentContext, agentApiKey, agentRateReset, agentApproval } = useShell(controller);

  return (
    <section className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge bg-panel px-3 py-1.5">
        <span className="truncate text-xs text-muted">{cwd || "~"}</span>
        <div className="flex-1" />
        <SmartPrButton controller={controller} />
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
}
