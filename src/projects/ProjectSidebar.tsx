import type { GitStat } from "../App";

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
  /** Width in px (user-resizable). */
  width: number;
  /** Per-project git branch + diff stat (optional). */
  stats: Map<string, GitStat>;
}

/** Left rail: one entry per open project (PTY session), plus "New project". */
export function ProjectSidebar({ tabs, activeId, onSelect, onClose, onNew, width, stats }: Props) {
  return (
    <nav className="flex shrink-0 flex-col bg-panel" style={{ width }}>
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <span className="text-base">🐙</span>
        <span className="text-sm font-semibold text-gray-100">OctoShell</span>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-muted">Projects</div>
        {tabs.map((t) => {
          const active = t.id === activeId;
          const stat = stats.get(t.id);
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={`group cursor-pointer rounded px-2 py-1.5 transition-colors ${
                active ? "bg-accent/25 text-gray-100" : "text-muted hover:bg-edge/60"
              }`}
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
        })}
      </div>

      <button
        onClick={onNew}
        className="m-2 rounded-lg border border-accent/60 bg-accent/25 px-3 py-2 text-sm font-semibold text-gray-100 transition-colors hover:bg-accent/30"
      >
        ＋ New project
      </button>
    </nav>
  );
}
