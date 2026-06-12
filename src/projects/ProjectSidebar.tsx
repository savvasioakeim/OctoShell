import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { GitStat, Group } from "../App";
import type { ShellController, ShellSnapshot } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";

export interface ProjectTab {
  id: string;
  name: string;
  /** If set, this project is a worktree nested under that parent project. */
  parentId?: string;
  /** Live controller — drives the board node's status color. */
  controller: ShellController;
}

interface Props {
  tabs: ProjectTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewWorktree: (branch: string) => void;
  width: number;
  stats: Map<string, GitStat>;
  groups: Group[];
  assign: Record<string, string>;
  onAssign: (projectId: string, groupId: string | null) => void;
  onCreateGroup: (name: string) => string;
  onReorder: (dragId: string, targetId: string, pos: "before" | "after") => void;
  onReorderGroup: (dragId: string, targetId: string, pos: "before" | "after") => void;
  onSetGroupColor: (groupId: string, color: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  palette: string[];
}

type Ctx = { x: number; y: number; kind: "project" | "group" | "blank"; id?: string };

// ---------------------------------------------------------------------------
// Agent status (drives the board node colors — OctoShell's "circuit board").
// ---------------------------------------------------------------------------
type Status = "idle" | "active" | "done" | "error";
const COLOR: Record<Status, string> = {
  idle: "#4b5066", // gray  — nothing running
  active: "#82AAFF", // blue  — shell/agent working
  done: "#4ade80", // green — last action succeeded
  error: "#f87171", // red   — last action failed
};
const LABEL: Record<Status, string> = {
  idle: "idle",
  active: "τρέχει",
  done: "ολοκληρώθηκε",
  error: "σφάλμα",
};
function statusOf(s?: ShellSnapshot): Status {
  if (!s) return "idle";
  if (s.agentBusy || s.busy) return "active";
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i];
    if (b.kind === "command" || b.kind === "agentTool") {
      if (b.status === "error") return "error";
      if (b.status === "success") return "done";
      return "idle";
    }
  }
  return "idle";
}

/** Subscribe to every controller and re-render on any change. */
function useAllSnapshots(tabs: ProjectTab[]): Map<string, ShellSnapshot> {
  const [, force] = useReducer((x) => x + 1, 0);
  const ids = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const unsubs = tabs.map((t) => t.controller.subscribe(force));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const m = new Map<string, ShellSnapshot>();
  for (const t of tabs) m.set(t.id, t.controller.getSnapshot());
  return m;
}

// ---------------------------------------------------------------------------
// Board geometry — a PCB-style spine with right-angle branches (group → project
// → worktree). All x's are px from the content's left edge; y's are measured.
// ---------------------------------------------------------------------------
const SPINE_X = 9; // the vertical bus
const PROJECT_X = 44; // project nodes branch right off the spine (long trace)
const WT_X = 74; // worktrees branch right off their project (long trace too)
const GROUP_R = 5;
const NODE_R = 4.5;
const WT_R = 3.5;
const TRACE = "#3a3f58"; // neutral trace (ungrouped / spine)
const WT_TRACE = "#5b7fb0"; // worktree branch hue
const FLOW = "#b794f6"; // orchestrator "tentacle reaching" current (accent)

// Row left padding so labels clear their node, per level.
const PAD = { group: 18, project: 52, worktree: 84 } as const;

type Geo = { rows: Record<string, number>; groups: Record<string, number> };

/**
 * Left rail: a "circuit board" of projects organised into named, color-coded,
 * reorderable groups. A vertical spine runs down the left; group markers sit on
 * it, projects branch off with right-angle traces, and worktrees branch off
 * their project — each branch tipped with a live status node (idle/active/done/
 * error). Click or right-click a node like its row. Drag to reorder / regroup;
 * right-click for menus. Everything persists.
 */
export function ProjectSidebar(props: Props) {
  const {
    tabs, activeId, onSelect, onClose, onNew, onNewWorktree, width, stats,
    groups, assign, onAssign, onReorder, onReorderGroup,
  } = props;

  const snaps = useAllSnapshots(tabs);

  const [wtInput, setWtInput] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [rename, setRename] = useState("");
  const [geo, setGeo] = useState<Geo>({ rows: {}, groups: {} });
  // Collapsed groups (hide their projects) and projects (hide their worktrees),
  // so a busy workspace can be tidied. Persisted.
  const [collapsed, setCollapsed] = useState<{ groups: string[]; projects: string[] }>(() =>
    loadJSON(KEY.collapsed, { groups: [], projects: [] }),
  );
  useEffect(() => { saveJSON(KEY.collapsed, collapsed); }, [collapsed]);
  const gCollapsed = new Set(collapsed.groups);
  const pCollapsed = new Set(collapsed.projects);
  const toggleGroup = (id: string) =>
    setCollapsed((c) => ({
      ...c,
      groups: c.groups.includes(id) ? c.groups.filter((x) => x !== id) : [...c.groups, id],
    }));
  const toggleProject = (id: string) =>
    setCollapsed((c) => ({
      ...c,
      projects: c.projects.includes(id) ? c.projects.filter((x) => x !== id) : [...c.projects, id],
    }));

  // Measure each row's and group header's center Y relative to the content box
  // (which the board SVG overlays and scrolls with), so traces align to rows.
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const groupRefs = useRef<Map<string, HTMLElement>>(new Map());
  const rafRef = useRef(0);
  const lastRef = useRef("");
  const measure = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const box = contentRef.current;
      if (!box) return;
      const top = box.getBoundingClientRect().top;
      const rows: Record<string, number> = {};
      const grps: Record<string, number> = {};
      rowRefs.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        rows[id] = Math.round(r.top - top + r.height / 2);
      });
      groupRefs.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        grps[id] = Math.round(r.top - top + r.height / 2);
      });
      const key = JSON.stringify([rows, grps]);
      if (key !== lastRef.current) {
        lastRef.current = key;
        setGeo({ rows, groups: grps });
      }
    });
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, tabs, groups, assign, stats, width, collapsed]);
  useEffect(() => {
    const box = contentRef.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const groupOf = (id: string) => groups.find((g) => g.id === assign[id]) ?? null;
  // Worktrees nest under their parent; everything else is top-level.
  const isChild = (t: ProjectTab) => !!t.parentId && tabs.some((p) => p.id === t.parentId);
  const childrenOf = (id: string) => tabs.filter((t) => t.parentId === id && isChild(t));
  const topLevel = tabs.filter((t) => !isChild(t));
  const ungrouped = topLevel.filter((t) => !groupOf(t.id));
  const endDrag = () => { setDragId(null); setOver(null); setDragGroup(null); setOverGroup(null); };
  const openCtx = (e: React.MouseEvent, kind: Ctx["kind"], id?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, kind, id });
    if (kind === "group") setRename(groups.find((g) => g.id === id)?.name ?? "");
  };

  const renderRow = (
    t: ProjectTab,
    child = false,
    toggle?: { collapsed: boolean; onToggle: () => void },
  ) => {
    const active = t.id === activeId;
    const stat = stats.get(t.id);
    const style: React.CSSProperties = { paddingLeft: child ? PAD.worktree : PAD.project };
    if (over?.id === t.id) {
      style.boxShadow = over.pos === "before" ? "inset 0 2px 0 #7E57C2" : "inset 0 -2px 0 #7E57C2";
    }
    return (
      <div
        key={t.id}
        draggable={!child}
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => openCtx(e, "project", t.id)}
        onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!dragId || dragId === t.id || child) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setOver({ id: t.id, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!child && dragId && dragId !== t.id) {
            onReorder(dragId, t.id, over?.pos ?? "before");
            onAssign(dragId, groupOf(t.id)?.id ?? null);
          }
          endDrag();
        }}
        style={style}
        className={`group cursor-pointer rounded py-1.5 pr-2 transition-colors ${
          dragId === t.id ? "opacity-50" : ""
        } ${active ? "bg-accent/25 text-gray-100" : "text-muted hover:bg-edge/60"}`}
      >
        {/* Measure the NAME line (not the whole row) so the board node lines up
            with the name even when a branch sub-line is shown below it. */}
        <div
          ref={(el) => { if (el) rowRefs.current.set(t.id, el); else rowRefs.current.delete(t.id); }}
          className="flex items-center gap-2 text-sm"
        >
          {toggle && (
            <button
              onClick={(e) => { e.stopPropagation(); toggle.onToggle(); }}
              className="-ml-3 w-3 shrink-0 text-[10px] text-muted hover:text-gray-200"
              title={toggle.collapsed ? "Ανάπτυξη worktrees" : "Σύμπτυξη worktrees"}
            >
              {toggle.collapsed ? "▸" : "▾"}
            </button>
          )}
          {child && <span className="shrink-0 text-[11px]" title="git worktree">🌿</span>}
          <span className="flex-1 truncate">{t.name}</span>
          {tabs.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
              title="Close project"
            >
              ×
            </button>
          )}
        </div>
        {stat && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
            <span className="truncate">⎇ {stat.branch}</span>
            {(stat.added > 0 || stat.removed > 0) && (
              <span className="ml-auto flex shrink-0 gap-1 font-medium">
                {stat.added > 0 && <span className="text-green-400">+{stat.added}</span>}
                {stat.removed > 0 && <span className="text-red-400">−{stat.removed}</span>}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderGroupHeader = (g: Group, isCollapsed: boolean, onToggle: () => void) => (
    <div
      ref={(el) => { if (el) groupRefs.current.set(g.id, el); else groupRefs.current.delete(g.id); }}
      draggable
      onContextMenu={(e) => openCtx(e, "group", g.id)}
      onDragStart={(e) => { setDragGroup(g.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (dragGroup && dragGroup !== g.id) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setOverGroup({ id: g.id, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
        } else if (dragId) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragGroup && dragGroup !== g.id) onReorderGroup(dragGroup, g.id, overGroup?.pos ?? "before");
        else if (dragId) onAssign(dragId, g.id);
        endDrag();
      }}
      style={{
        paddingLeft: PAD.group,
        ...(overGroup?.id === g.id
          ? { boxShadow: overGroup.pos === "before" ? "inset 0 2px 0 #7E57C2" : "inset 0 -2px 0 #7E57C2" }
          : {}),
      }}
      className={`flex cursor-grab items-center gap-1 rounded py-1 pr-1 ${dragGroup === g.id ? "opacity-50" : ""}`}
      title="Σύρε για αναδιάταξη · δεξί κλικ για επιλογές"
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="w-3 shrink-0 text-[10px] text-muted hover:text-gray-200"
        title={isCollapsed ? "Ανάπτυξη ομάδας" : "Σύμπτυξη ομάδας"}
      >
        {isCollapsed ? "▸" : "▾"}
      </button>
      <span className="truncate text-[10px] font-semibold uppercase tracking-wider" style={{ color: g.color }}>
        {g.name}
      </span>
    </div>
  );

  // A top-level project followed by its nested worktree children (collapsible).
  const renderProject = (t: ProjectTab) => {
    const kids = childrenOf(t.id);
    const isCollapsed = pCollapsed.has(t.id);
    return (
      <Fragment key={t.id}>
        {renderRow(t, false, kids.length ? { collapsed: isCollapsed, onToggle: () => toggleProject(t.id) } : undefined)}
        {!isCollapsed && kids.map((c) => renderRow(c, true))}
      </Fragment>
    );
  };

  return (
    <nav className="relative flex shrink-0 flex-col bg-panel" style={{ width }}>
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <span className="text-base">🐙</span>
        <span className="text-sm font-semibold text-gray-100">OctoShell</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2" onContextMenu={(e) => openCtx(e, "blank")}>
        <div ref={contentRef} className="relative">
          <Board
            tabs={tabs}
            activeId={activeId}
            snaps={snaps}
            groups={groups}
            assign={assign}
            geo={geo}
            childrenOf={childrenOf}
            groupOf={groupOf}
            onSelect={onSelect}
            openCtx={openCtx}
          />

          <div className="space-y-0.5">
            <div
              className="py-1 text-[10px] uppercase tracking-wider text-muted"
              style={{ paddingLeft: PAD.group }}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragId) onAssign(dragId, null); endDrag(); }}
            >
              Projects
            </div>
            {ungrouped.map(renderProject)}

            {groups.map((g) => {
              const members = topLevel.filter((t) => assign[t.id] === g.id);
              const isCollapsed = gCollapsed.has(g.id);
              return (
                <div key={g.id} className="pt-2">
                  {renderGroupHeader(g, isCollapsed, () => toggleGroup(g.id))}
                  {!isCollapsed && members.map(renderProject)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="m-2 space-y-1.5">
        {wtInput !== null ? (
          <input
            autoFocus
            value={wtInput}
            onChange={(e) => setWtInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && wtInput.trim()) { onNewWorktree(wtInput); setWtInput(null); }
              else if (e.key === "Escape") setWtInput(null);
            }}
            onBlur={() => setWtInput(null)}
            placeholder="branch name… (Enter)"
            className="w-full rounded-md border border-edge bg-ink px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-accent placeholder:text-muted/60"
          />
        ) : (
          <button
            onClick={() => setWtInput("")}
            title="Φτιάξε isolated git worktree (νέο branch) από το ενεργό project"
            className="w-full rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-gray-100"
          >
            🌿 New worktree
          </button>
        )}
        <button
          onClick={onNew}
          className="w-full rounded-lg border border-accent/60 bg-accent/25 px-3 py-2 text-sm font-semibold text-gray-100 transition-colors hover:bg-accent/30"
        >
          ＋ New project
        </button>
      </div>

      {ctx && <ContextMenu ctx={ctx} close={() => setCtx(null)} {...props} rename={rename} setRename={setRename} />}
    </nav>
  );
}

/**
 * The circuit-board overlay: an SVG sized to the content box, drawn behind the
 * rows (pointer-events pass through except the nodes). It routes the spine and
 * orthogonal branches from the measured row/group geometry, and renders one
 * interactive status node per group / project / worktree.
 */
function Board({
  tabs, activeId, snaps, groups, assign, geo, childrenOf, groupOf, onSelect, openCtx,
}: {
  tabs: ProjectTab[];
  activeId: string;
  snaps: Map<string, ShellSnapshot>;
  groups: Group[];
  assign: Record<string, string>;
  geo: Geo;
  childrenOf: (id: string) => ProjectTab[];
  groupOf: (id: string) => Group | null;
  onSelect: (id: string) => void;
  openCtx: (e: React.MouseEvent, kind: Ctx["kind"], id?: string) => void;
}) {
  const traces: { key: string; d: string; stroke: string; w: number }[] = [];
  const nodes: React.ReactNode[] = [];
  const ys: number[] = [];
  // Routes (spine → … → node) for agents the orchestrator is currently driving —
  // built after `ys` is known (the route starts at the top of the spine).
  const routeSpecs: { id: string; d: (top: number) => string }[] = [];

  const orchestrated = (id: string) => {
    const s = snaps.get(id);
    return !!(s && s.agentBusy && s.agentOrchestrated);
  };

  const projectNode = (t: ProjectTab) => {
    const y = geo.rows[t.id];
    if (y == null) return;
    ys.push(y);
    const g = groupOf(t.id);
    const stroke = g ? g.color : TRACE;
    // project branch: spine ⟶ project node
    traces.push({ key: `t-${t.id}`, d: `M ${SPINE_X} ${y} H ${PROJECT_X}`, stroke, w: 3 });
    if (orchestrated(t.id)) {
      routeSpecs.push({ id: t.id, d: (top) => `M ${SPINE_X} ${top} V ${y} H ${PROJECT_X}` });
    }

    // worktrees: project ⟶ down ⟶ right (right-angle connector)
    for (const c of childrenOf(t.id)) {
      const cy = geo.rows[c.id];
      if (cy == null) continue;
      ys.push(cy);
      traces.push({ key: `t-${c.id}`, d: `M ${PROJECT_X} ${y} V ${cy} H ${WT_X}`, stroke: WT_TRACE, w: 2.5 });
      if (orchestrated(c.id)) {
        routeSpecs.push({ id: c.id, d: (top) => `M ${SPINE_X} ${top} V ${y} H ${PROJECT_X} V ${cy} H ${WT_X}` });
      }
      nodes.push(node(c, cy, WT_X, WT_R, WT_TRACE));
    }
    nodes.push(node(t, y, PROJECT_X, NODE_R, stroke));
  };

  function node(t: ProjectTab, cy: number, cx: number, r: number, ring: string) {
    const st = statusOf(snaps.get(t.id));
    const isActive = t.id === activeId;
    const orch = orchestrated(t.id);
    const fill = COLOR[st];
    const g = groupOf(t.id);
    // Orchestrated nodes get an accent ring + strong glow (the tentacle's grip);
    // otherwise active = accent highlight, idle = group/neutral ring.
    const strokeColor = orch ? FLOW : isActive ? "#cdb4ff" : ring;
    return (
      <circle
        key={`n-${t.id}`}
        cx={cx}
        cy={cy}
        r={orch || isActive ? r + 1.5 : r}
        fill={fill}
        stroke={strokeColor}
        strokeWidth={orch ? 2.5 : 2}
        className={st === "active" ? "octo-cable-pulse" : ""}
        style={{
          filter: `drop-shadow(0 0 ${orch ? 8 : st === "active" ? 6 : 2}px ${orch ? FLOW : fill})`,
          cursor: "pointer",
          pointerEvents: "auto",
        }}
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => openCtx(e, "project", t.id)}
      >
        <title>{`${t.name} — ${LABEL[st]}${orch ? " · orchestrator" : ""}${g ? ` · ${g.name}` : ""}`}</title>
      </circle>
    );
  }

  // Ungrouped projects branch straight off the spine.
  tabs
    .filter((t) => !t.parentId && !groupOf(t.id))
    .forEach(projectNode);

  // Each group: a marker on the spine, then its projects.
  for (const g of groups) {
    const gy = geo.groups[g.id];
    const members = tabs.filter((t) => !t.parentId && assign[t.id] === g.id);
    if (gy != null && members.length) {
      ys.push(gy);
      nodes.push(
        <circle
          key={`g-${g.id}`}
          cx={SPINE_X}
          cy={gy}
          r={GROUP_R}
          fill={g.color}
          stroke="#15181F"
          strokeWidth={2}
          style={{ filter: `drop-shadow(0 0 3px ${g.color})`, cursor: "pointer", pointerEvents: "auto" }}
          onClick={() => members[0] && onSelect(members[0].id)}
          onContextMenu={(e) => openCtx(e, "group", g.id)}
        >
          <title>{g.name}</title>
        </circle>,
      );
    }
    members.forEach(projectNode);
  }

  const top = ys.length ? Math.min(...ys) : 0;
  const spine =
    ys.length >= 2 ? (
      <line x1={SPINE_X} y1={top} x2={SPINE_X} y2={Math.max(...ys)} stroke={TRACE} strokeWidth={3} strokeLinecap="round" />
    ) : null;

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: "visible" }}>
      <defs>
        {/* Soft accent→teal gradient for the orchestrator route (not flat). */}
        <linearGradient id="octo-flow-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7E57C2" />
          <stop offset="50%" stopColor={FLOW} />
          <stop offset="100%" stopColor="#7fdbca" />
        </linearGradient>
      </defs>
      {spine}
      {traces.map((s) => (
        <path key={s.key} d={s.d} fill="none" stroke={s.stroke} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
      ))}
      {/* Orchestrator "tentacle reaching" — a solid, softly gradient current that
          glows along the full route from the spine top to the driven agent. */}
      {routeSpecs.map((rt) => (
        <path
          key={`route-${rt.id}`}
          className="octo-route"
          d={rt.d(top)}
          fill="none"
          stroke="url(#octo-flow-grad)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 5px ${FLOW})` }}
        />
      ))}
      {nodes}
    </svg>
  );
}

/** Right-click menu — content depends on what was clicked. */
function ContextMenu({
  ctx, close, groups, assign, onAssign, onCreateGroup, onSetGroupColor, onRenameGroup,
  onDeleteGroup, onClose, tabs, palette, rename, setRename,
}: Props & {
  ctx: Ctx;
  close: () => void;
  rename: string;
  setRename: (s: string) => void;
}) {
  const newGroup = (assignTo?: string) => {
    const id = onCreateGroup(`Ομάδα ${groups.length + 1}`);
    if (assignTo) onAssign(assignTo, id);
    close();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div
        className="fixed z-50 overflow-hidden rounded-lg border border-edge bg-panel py-1 text-xs shadow-xl"
        style={{ top: ctx.y, left: ctx.x, width: 200 }}
      >
        {ctx.kind === "blank" && (
          <button className="w-full px-3 py-1.5 text-left text-gray-200 hover:bg-edge" onClick={() => newGroup()}>
            ＋ Νέα ομάδα
          </button>
        )}

        {ctx.kind === "project" && ctx.id && (
          <>
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-muted">Ομάδα</div>
            <button className="w-full px-3 py-1.5 text-left text-gray-200 hover:bg-edge" onClick={() => newGroup(ctx.id)}>
              ＋ Νέα ομάδα (με αυτό)
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-edge"
                onClick={() => { onAssign(ctx.id!, g.id); close(); }}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
                <span className="flex-1 truncate text-gray-200">{g.name}</span>
                {assign[ctx.id!] === g.id && <span className="text-accent">✓</span>}
              </button>
            ))}
            {assign[ctx.id!] && (
              <button className="w-full px-3 py-1.5 text-left text-muted hover:bg-edge" onClick={() => { onAssign(ctx.id!, null); close(); }}>
                Καμία ομάδα
              </button>
            )}
            {tabs.length > 1 && (
              <>
                <div className="my-1 border-t border-edge" />
                <button className="w-full px-3 py-1.5 text-left text-red-300 hover:bg-edge" onClick={() => { onClose(ctx.id!); close(); }}>
                  Κλείσιμο project
                </button>
              </>
            )}
          </>
        )}

        {ctx.kind === "group" && ctx.id && (
          <>
            <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-muted">Ομάδα</div>
            <div className="px-2 py-1">
              <input
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onRenameGroup(ctx.id!, rename); close(); }
                  else if (e.key === "Escape") close();
                }}
                placeholder="Όνομα ομάδας"
                className="w-full rounded bg-ink px-2 py-1 text-xs text-gray-100 outline-none"
                autoFocus
              />
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 py-1.5">
              {palette.map((c) => (
                <button
                  key={c}
                  onClick={() => { onSetGroupColor(ctx.id!, c); close(); }}
                  title={c}
                  className="h-4 w-4 rounded-full ring-1 ring-edge transition-transform hover:scale-125"
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="my-1 border-t border-edge" />
            <button className="w-full px-3 py-1.5 text-left text-red-300 hover:bg-edge" onClick={() => { onDeleteGroup(ctx.id!); close(); }}>
              Διαγραφή ομάδας
            </button>
          </>
        )}
      </div>
    </>
  );
}
