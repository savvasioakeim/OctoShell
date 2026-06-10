import { useEffect, useState } from "react";
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
}

interface SavedProject {
  id: string;
  name: string;
  cwd: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export interface GitStat {
  branch: string;
  added: number;
  removed: number;
}

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

  // Restore previously-open projects once, on startup. Dedup by folder so an
  // accumulated/duplicated saved list never spawns dozens of PTYs + WebGL
  // contexts (which would freeze the app). One tab per unique cwd.
  useEffect(() => {
    const saved = loadJSON<SavedProject[]>(KEY.projects, []);
    const seen = new Set<string>();
    const unique = saved.filter((p) => p.cwd && !seen.has(p.cwd) && (seen.add(p.cwd), true));
    let cancelled = false;
    (async () => {
      const restored: Tab[] = [];
      for (const p of unique) {
        const controller = new ShellController(p.id);
        await controller.init(p.cwd);
        restored.push({ id: p.id, name: p.name, cwd: p.cwd, controller });
      }
      if (!cancelled && restored.length) setTabs((t) => [...t, ...restored]);
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
      .map((t) => ({ id: t.id, name: t.name, cwd: t.cwd }));
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

  const closeProject = (id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const tab = prev.find((t) => t.id === id);
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
          tabs={tabs.map((t) => ({ id: t.id, name: t.name }))}
          activeId={active.id}
          onSelect={setActiveId}
          onClose={closeProject}
          onNew={newProject}
          width={layout.left}
          stats={gitStats}
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
  const { blocks, cwd, busy, input, altScreen, interacting, mode, agentBusy, agentModel } = useShell(controller);

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
      />
    </section>
  );
}
