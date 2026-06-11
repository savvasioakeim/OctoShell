import { useEffect, useReducer } from "react";
import type { ShellController, ShellSnapshot } from "../shell/ShellController";
import type { Group } from "../App";

export interface RailTab {
  id: string;
  name: string;
  controller: ShellController;
  /** If set, this is a worktree nested under that parent project. */
  parentId?: string;
}

interface Props {
  tabs: RailTab[];
  activeId: string;
  onSelect: (id: string) => void;
  groups: Group[];
  assign: Record<string, string>;
  /** Measured Y center (px from rail top) per project id, for row alignment. */
  rowYs: Record<string, number>;
}

type Status = "idle" | "active" | "done" | "error";

// OctoShell's status palette for the rail (the brand's "cables").
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

/** Derive an agent's status from its live snapshot. */
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
function useAllSnapshots(tabs: RailTab[]): Map<string, ShellSnapshot> {
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

/**
 * The "cables" rail — OctoShell's visual identity. A narrow leftmost column with
 * a vertical bus and one status node per agent (project), color-coded live
 * (idle/active/done/error). Click a node to jump to that project. Future:
 * named groups + tentacle curves.
 */
// Rail geometry.
const W = 52;
const CENTER = 26;
const HEAD_Y = 14;
const SPACING = 30; // vertical gap between agent nodes
const GROUP_GAP = 16; // extra gap before a new group
const AMP = 11; // how far the tentacle waves left/right of center

export function CablesRail({ tabs, activeId, onSelect, groups, assign, rowYs }: Props) {
  const snaps = useAllSnapshots(tabs);

  // Order: ungrouped first, then each non-empty group — matching the sidebar.
  // Each top-level project is followed by its nested worktree children.
  const isChild = (t: RailTab) => !!t.parentId && tabs.some((p) => p.id === t.parentId);
  const childrenOf = (id: string) => tabs.filter((t) => t.parentId === id && isChild(t));
  const ordered: { t: RailTab; group: Group | null; child: boolean }[] = [];
  const pushWithKids = (t: RailTab, group: Group | null) => {
    ordered.push({ t, group, child: false });
    childrenOf(t.id).forEach((c) => ordered.push({ t: c, group, child: true }));
  };
  tabs
    .filter((t) => !isChild(t) && !groups.some((g) => g.id === assign[t.id]))
    .forEach((t) => pushWithKids(t, null));
  const groupStarts = new Set<number>();
  groups.forEach((g) => {
    const members = tabs.filter((t) => !isChild(t) && assign[t.id] === g.id);
    if (members.length) {
      groupStarts.add(ordered.length);
      members.forEach((t) => pushWithKids(t, g));
    }
  });

  // Y = the measured row center (so each node lines up with its project row).
  // Fall back to even spacing until the first measurement arrives.
  let fallback = HEAD_Y + 28;
  const pts = ordered.map((o, i) => {
    if (i > 0 && groupStarts.has(i)) fallback += GROUP_GAP;
    const y = rowYs[o.t.id] ?? fallback;
    fallback += SPACING;
    return { ...o, x: CENTER + Math.sin(i * 0.9) * AMP, y, i };
  });

  // Tentacle drawn per-segment so a grouped node's segment takes the group color,
  // while ungrouped segments keep the purple→teal gradient.
  let px = CENTER;
  let py = HEAD_Y;
  const segs = pts.map((p) => {
    const cy = (py + p.y) / 2;
    const seg = {
      key: p.t.id,
      d: `M ${px} ${py} C ${px} ${cy} ${p.x} ${cy} ${p.x} ${p.y}`,
      stroke: p.group ? p.group.color : "url(#octo-tentacle)",
    };
    px = p.x;
    py = p.y;
    return seg;
  });

  return (
    <div className="h-full shrink-0 overflow-hidden bg-ink" style={{ width: W }}>
      <svg width={W} height="100%" style={{ display: "block" }}>
        <defs>
          <linearGradient id="octo-tentacle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7E57C2" />
            <stop offset="100%" stopColor="#7fdbca" />
          </linearGradient>
        </defs>

        {segs.map((s) => (
          <path key={s.key} d={s.d} fill="none" stroke={s.stroke} strokeWidth={2.5} strokeLinecap="round" opacity={0.7} />
        ))}

        {/* the octopus "head" / root */}
        <circle cx={CENTER} cy={HEAD_Y} r={5} fill="#7E57C2" style={{ filter: "drop-shadow(0 0 6px #7E57C2)" }} />

        {pts.map((p) => {
          const st = statusOf(snaps.get(p.t.id));
          const color = COLOR[st];
          const isActive = p.t.id === activeId;
          return (
            <circle
              key={p.t.id}
              cx={p.x}
              cy={p.y}
              r={isActive ? 6.5 : p.child ? 3.5 : 5}
              fill={color} // fill = status
              stroke={p.group ? p.group.color : "#15181F"} // ring = group
              strokeWidth={2}
              className={st === "active" ? "octo-cable-pulse" : ""}
              style={{ filter: `drop-shadow(0 0 ${st === "active" ? 6 : 3}px ${color})`, cursor: "pointer" }}
              onClick={() => onSelect(p.t.id)}
            >
              <title>{`${p.t.name} — ${LABEL[st]}${p.group ? ` · ${p.group.name}` : ""}`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
