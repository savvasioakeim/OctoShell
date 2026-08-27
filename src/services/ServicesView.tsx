// The Services panel (sidebar tab) — the vertical home for OctoShell-managed
// servers, replacing the old bottom ServiceBar. Each row shows the service's
// project, port/URL and lifecycle, with restart/stop/clear and an expandable log.

import { useEffect, useRef, useState } from "react";
import { serviceStore, useServices, type ServiceEntry } from "./serviceStore";

function StatusDot({ status }: { status: ServiceEntry["status"] }) {
  const cls =
    status === "running"
      ? "bg-emerald-400"
      : status === "starting"
        ? "bg-amber-400 animate-pulse"
        : "bg-edge";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

export function ServicesView() {
  const services = useServices();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {services.length === 0 ? (
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-muted">
          No managed services running. OctoShell starts one when you run a server
          command (or from QA mode) — it gets its own port and lives here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {services.map((s) => (
            <ServiceRow
              key={s.id}
              s={s}
              open={s.id === openId}
              onToggle={() => setOpenId(s.id === openId ? null : s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ s, open, onToggle }: { s: ServiceEntry; open: boolean; onToggle: () => void }) {
  return (
    <div className={`rounded-md border ${open ? "border-accent/50 bg-accent/[0.06]" : "border-edge bg-card"}`}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
        <StatusDot status={s.status} />
        <button
          onClick={onToggle}
          title={`${s.command}\n${s.cwd}`}
          className="min-w-0 flex-1 truncate text-left text-gray-200 hover:text-accent"
        >
          {s.name}
          {s.port ? <span className="text-muted"> :{s.port}</span> : null}
        </button>
        <button
          onClick={() => void serviceStore.restart(s.id)}
          title="Restart"
          className="shrink-0 text-muted hover:text-accent"
        >
          ↻
        </button>
        {s.status === "exited" ? (
          <button onClick={() => serviceStore.remove(s.id)} title="Clear" className="shrink-0 text-muted hover:text-gray-200">
            ✕
          </button>
        ) : (
          <button onClick={() => void serviceStore.stop(s.id)} title="Stop" className="shrink-0 text-red-300 hover:text-red-200">
            ◼
          </button>
        )}
      </div>
      {/* Footer line: address on the left, process on the right. The pid shows
          only while the service is alive — once it exits the number names a slot
          the OS has already reused, so keeping it would be actively misleading. */}
      {((s.url && s.status === "running") || (s.pid && s.status !== "exited")) && (
        <div className="flex items-center gap-2 px-2 pb-1 text-[10px]">
          {s.url && s.status === "running" ? (
            <button
              onClick={() => void navigator.clipboard?.writeText(s.url!)}
              title="Copy URL"
              className="min-w-0 flex-1 truncate text-left text-sky-300/80 hover:text-sky-200"
            >
              {s.url} ⧉
            </button>
          ) : (
            <span className="flex-1" />
          )}
          {/* The outer guard already excludes "exited"; TS narrows it here. */}
          {s.pid && (
            <span
              className="shrink-0 font-mono text-muted"
              title={`The process OctoShell started and Stop kills. The dev server it spawns may run under a child pid; the Ports pane shows whichever process is holding the socket.`}
            >
              PID: {s.pid}
            </span>
          )}
        </div>
      )}
      {open && <LogPanel service={s} />}
    </div>
  );
}

function LogPanel({ service }: { service: ServiceEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [service.logs.length]);
  return (
    <div
      ref={ref}
      className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-t border-edge bg-well/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-gray-300"
    >
      {service.logs.length ? service.logs.join("\n") : "(no output yet)"}
      {service.status === "exited" && (
        <div className="text-red-300">· exited ({service.exitCode ?? "?"})</div>
      )}
    </div>
  );
}
