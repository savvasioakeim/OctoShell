// The Ports panel (sidebar tab). Shows the machine's LISTENING TCP ports plus any
// tracked ports the user pinned in Settings (even when free), each with the owning
// process and a kill button. This is the "see & manage open ports" surface — e.g.
// close a stale dev server squatting on 3000.

import { useState } from "react";
import { usePorts, portsStore, type PortInfo } from "./portsStore";
import { useSettings } from "../settings/settingsStore";

interface Row {
  port: number;
  /** Processes listening on this port (empty = free / not in use). */
  procs: PortInfo[];
  tracked: boolean;
}

export function PortsView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const ports = usePorts();
  const { trackedPorts } = useSettings().workspace;
  const [killing, setKilling] = useState<number | null>(null);

  // Merge live listeners with tracked ports: group listeners by port, then union
  // with the tracked set so pinned-but-free ports still show. Tracked ports first
  // (in the user's order), then the rest ascending.
  const byPort = new Map<number, PortInfo[]>();
  for (const p of ports) {
    const arr = byPort.get(p.port) ?? [];
    arr.push(p);
    byPort.set(p.port, arr);
  }
  const trackedSet = new Set(trackedPorts);
  const trackedRows: Row[] = trackedPorts.map((port) => ({
    port,
    procs: byPort.get(port) ?? [],
    tracked: true,
  }));
  const otherRows: Row[] = [...byPort.keys()]
    .filter((port) => !trackedSet.has(port))
    .sort((a, b) => a - b)
    .map((port) => ({ port, procs: byPort.get(port) ?? [], tracked: false }));

  const kill = async (port: number) => {
    setKilling(port);
    try {
      await portsStore.kill(port);
    } finally {
      setKilling(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-2">
      <Group label="Tracked">
        {trackedRows.map((r) => (
          <PortRow key={`t-${r.port}`} row={r} killing={killing === r.port} onKill={() => kill(r.port)} />
        ))}
        <button
          onClick={onOpenSettings}
          className="mt-1 w-full rounded-md border border-dashed border-edge px-2 py-1.5 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-gray-200"
        >
          ＋ Edit tracked ports in Settings
        </button>
      </Group>

      {otherRows.length > 0 && (
        <Group label={`Other listening (${otherRows.length})`}>
          {otherRows.map((r) => (
            <PortRow key={`o-${r.port}`} row={r} killing={killing === r.port} onKill={() => kill(r.port)} />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted/80">{label}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function PortRow({ row, killing, onKill }: { row: Row; killing: boolean; onKill: () => void }) {
  const inUse = row.procs.length > 0;
  // Labelled explicitly: a bare number next to a process name reads as a version
  // or a count as easily as a process id.
  const proc = row.procs.map((p) => `${p.process} (PID: ${p.pid})`).join(", ");
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
        inUse ? "border-edge bg-card" : "border-edge/50 bg-well/30"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${inUse ? "bg-emerald-400" : "bg-edge"}`} />
      <span className="font-mono font-semibold text-gray-100">:{row.port}</span>
      <span className="min-w-0 flex-1 truncate text-muted" title={proc}>
        {inUse ? proc : "free"}
      </span>
      {inUse && (
        <button
          onClick={onKill}
          disabled={killing}
          title={`Kill the process on :${row.port}`}
          className="shrink-0 rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
        >
          {killing ? "…" : "Kill"}
        </button>
      )}
    </div>
  );
}
