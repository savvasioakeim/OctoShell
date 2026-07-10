import { useEffect, useRef, useState } from "react";
import { serviceStore, useServices, type ServiceEntry } from "./serviceStore";

/** A status dot reflecting the service lifecycle. */
function StatusDot({ status }: { status: ServiceEntry["status"] }) {
  const cls =
    status === "running"
      ? "bg-emerald-400"
      : status === "starting"
        ? "bg-amber-400 animate-pulse"
        : "bg-edge";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

/**
 * Bottom status bar listing OctoShell-managed servers: each shows its project,
 * assigned port/URL and lifecycle, with stop and an expandable log view. Renders
 * nothing when no service has ever been started, so it stays out of the way.
 */
export function ServiceBar() {
  const services = useServices();
  const [openId, setOpenId] = useState<string | null>(null);

  if (services.length === 0) return null;
  const open = services.find((s) => s.id === openId) ?? null;

  return (
    <div className="shrink-0 border-t border-edge bg-panel/90 text-xs">
      {open && <LogPanel service={open} onClose={() => setOpenId(null)} />}
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-1.5">
        <span className="shrink-0 select-none text-[10px] uppercase tracking-wider text-muted">
          Services
        </span>
        {services.map((s) => {
          const active = s.id === openId;
          return (
            <div
              key={s.id}
              className={`flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 ${
                active ? "border-accent/50 bg-accent/10" : "border-edge"
              }`}
            >
              <StatusDot status={s.status} />
              <button
                onClick={() => setOpenId(active ? null : s.id)}
                title={`${s.command}\n${s.cwd}`}
                className="max-w-[14rem] truncate text-left text-gray-200 hover:text-accent"
              >
                {s.name}
                {s.port ? <span className="text-muted"> :{s.port}</span> : null}
              </button>
              {s.url && s.status === "running" && (
                <button
                  onClick={() => void navigator.clipboard?.writeText(s.url!)}
                  title="Copy URL"
                  className="text-[10px] text-sky-300/80 hover:text-sky-200"
                >
                  {s.url.replace(/^https?:\/\//, "")} ⧉
                </button>
              )}
              <button
                onClick={() => void serviceStore.restart(s.id)}
                title="Restart the server"
                className="text-muted hover:text-accent"
              >
                ↻
              </button>
              {s.status === "exited" ? (
                <button
                  onClick={() => serviceStore.remove(s.id)}
                  title="Clear"
                  className="text-muted hover:text-gray-200"
                >
                  ✕
                </button>
              ) : (
                <button
                  onClick={() => void serviceStore.stop(s.id)}
                  title="Stop the service"
                  className="text-red-300 hover:text-red-200"
                >
                  ◼
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Scrolling tail of a service's captured log output. */
function LogPanel({ service, onClose }: { service: ServiceEntry; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Auto-scroll to the newest line as logs stream in.
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [service.logs.length]);

  return (
    <div className="border-b border-edge">
      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted">
        <span className="truncate">
          {service.name} · <span className="font-mono">{service.command}</span>
          {service.status === "exited" && (
            <span className="text-red-300"> · exited ({service.exitCode ?? "?"})</span>
          )}
        </span>
        <button onClick={onClose} className="hover:text-gray-200" title="Close logs">
          ▾
        </button>
      </div>
      <div
        ref={ref}
        className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words bg-well/40 px-3 py-1.5 font-mono text-[11px] leading-relaxed text-gray-300"
      >
        {service.logs.length ? service.logs.join("\n") : "(no output yet)"}
      </div>
    </div>
  );
}
