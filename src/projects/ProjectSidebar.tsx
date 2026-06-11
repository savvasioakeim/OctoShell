import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GitStat, Group } from "../App";

export interface ProjectTab {
  id: string;
  name: string;
}

interface Props {
  tabs: ProjectTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
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
  /** Report each project row's vertical center (px, relative to the rail/sidebar
   *  top) so the cables rail can align its nodes to the rows. */
  onLayout: (rows: Record<string, number>) => void;
}

type Ctx = { x: number; y: number; kind: "project" | "group" | "blank"; id?: string };

/**
 * Left rail: projects organised into named, color-coded, reorderable groups.
 * Drag projects to reorder / move between groups; drag group headers to reorder
 * groups. Right-click for context menus (assign, new group, rename, color,
 * delete). Everything persists.
 */
export function ProjectSidebar(props: Props) {
  const {
    tabs, activeId, onSelect, onClose, onNew, width, stats,
    groups, assign, onAssign, onReorder, onReorderGroup, onLayout,
  } = props;

  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<{ id: string; pos: "before" | "after" } | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [rename, setRename] = useState("");

  // Measure each row's center Y (relative to the nav top, which matches the rail
  // top — they're siblings) so the cables rail aligns its nodes to the rows.
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const rafRef = useRef(0);
  const lastRef = useRef("");
  const measure = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const nav = navRef.current;
      if (!nav) return;
      const top = nav.getBoundingClientRect().top;
      const m: Record<string, number> = {};
      rowRefs.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        m[id] = Math.round(r.top - top + r.height / 2);
      });
      const key = JSON.stringify(m);
      if (key !== lastRef.current) { lastRef.current = key; onLayout(m); }
    });
  }, [onLayout]);

  useLayoutEffect(() => { measure(); }, [measure, tabs, groups, assign, stats, width]);
  useEffect(() => {
    const nav = navRef.current;
    const sc = scrollRef.current;
    if (!nav) return;
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    sc?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      sc?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const groupOf = (id: string) => groups.find((g) => g.id === assign[id]) ?? null;
  const ungrouped = tabs.filter((t) => !groupOf(t.id));
  const endDrag = () => { setDragId(null); setOver(null); setDragGroup(null); setOverGroup(null); };
  const openCtx = (e: React.MouseEvent, kind: Ctx["kind"], id?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, kind, id });
    if (kind === "group") setRename(groups.find((g) => g.id === id)?.name ?? "");
  };

  const renderRow = (t: ProjectTab) => {
    const active = t.id === activeId;
    const stat = stats.get(t.id);
    return (
      <div
        key={t.id}
        ref={(el) => { if (el) rowRefs.current.set(t.id, el); else rowRefs.current.delete(t.id); }}
        draggable
        onClick={() => onSelect(t.id)}
        onContextMenu={(e) => openCtx(e, "project", t.id)}
        onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!dragId || dragId === t.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setOver({ id: t.id, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && dragId !== t.id) {
            onReorder(dragId, t.id, over?.pos ?? "before");
            onAssign(dragId, groupOf(t.id)?.id ?? null);
          }
          endDrag();
        }}
        style={
          over?.id === t.id
            ? { boxShadow: over.pos === "before" ? "inset 0 2px 0 #7E57C2" : "inset 0 -2px 0 #7E57C2" }
            : undefined
        }
        className={`group cursor-pointer rounded px-2 py-1.5 transition-colors ${
          dragId === t.id ? "opacity-50" : ""
        } ${active ? "bg-accent/25 text-gray-100" : "text-muted hover:bg-edge/60"}`}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-accent" : "bg-edge"}`} />
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
          <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] text-muted">
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

  const renderGroupHeader = (g: Group) => (
    <div
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
      style={
        overGroup?.id === g.id
          ? { boxShadow: overGroup.pos === "before" ? "inset 0 2px 0 #7E57C2" : "inset 0 -2px 0 #7E57C2" }
          : undefined
      }
      className={`flex cursor-grab items-center gap-1.5 rounded px-1 py-1 ${dragGroup === g.id ? "opacity-50" : ""}`}
      title="Σύρε για αναδιάταξη · δεξί κλικ για επιλογές"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
      <span className="truncate text-[10px] font-semibold uppercase tracking-wider" style={{ color: g.color }}>
        {g.name}
      </span>
    </div>
  );

  return (
    <nav ref={navRef} className="relative flex shrink-0 flex-col bg-panel" style={{ width }}>
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <span className="text-base">🐙</span>
        <span className="text-sm font-semibold text-gray-100">OctoShell</span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-0.5 overflow-y-auto p-2" onContextMenu={(e) => openCtx(e, "blank")}>
        <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-muted"
          onDragOver={(e) => { if (dragId) e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); if (dragId) onAssign(dragId, null); endDrag(); }}
        >
          Projects
        </div>
        {ungrouped.map(renderRow)}

        {groups.map((g) => {
          const members = tabs.filter((t) => assign[t.id] === g.id);
          return (
            <div key={g.id} className="pt-2">
              {renderGroupHeader(g)}
              {members.map(renderRow)}
            </div>
          );
        })}
      </div>

      <button
        onClick={onNew}
        className="m-2 rounded-lg border border-accent/60 bg-accent/25 px-3 py-2 text-sm font-semibold text-gray-100 transition-colors hover:bg-accent/30"
      >
        ＋ New project
      </button>

      {ctx && <ContextMenu ctx={ctx} close={() => setCtx(null)} {...props} rename={rename} setRename={setRename} />}
    </nav>
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
