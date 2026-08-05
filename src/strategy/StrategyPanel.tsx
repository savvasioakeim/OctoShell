import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShellController } from "../shell/ShellController";
import { Markdown } from "../blocks/Markdown";
import { WorkingNode } from "../blocks/WorkingNode";
import strategyIcon from "../assets/strategy.png";
import { PROVIDERS } from "../agents/providers";
import { modelsFor, useSettings } from "../settings/settingsStore";
import { PARTICIPANT_COLORS, strategyStore, useStrategy } from "./strategyStore";
import { sendPlanToOrchestrator, orchestratorReady } from "./orchestratorBridge";
import type { ExecutionPlan, StrategyParticipant } from "./strategyTypes";

export interface StrategyProject {
  id: string;
  name: string;
  controller: ShellController;
}

interface Props {
  projects: StrategyProject[];
  /** Width of the orchestrator column to leave visible on the right. */
  rightWidth: number;
  onClose: () => void;
}

/** A compact, model-readable digest of the projects the user attached as context.
 *  Kept short — the participants plan, they don't need the whole history. */
function buildContextText(selected: StrategyProject[]): string {
  if (!selected.length) return "";
  return selected
    .map((p) => {
      const snap = p.controller.getSnapshot();
      const recent = snap.blocks
        .slice(-6)
        .map((b) => {
          if (b.kind === "command") return `$ ${b.command}`;
          if (b.kind === "agentText")
            return `${b.role === "user" ? "🧑" : "🤖"} ${b.text.slice(0, 160)}`;
          return null;
        })
        .filter(Boolean)
        .join("\n");
      return `## ${p.name} — ${snap.cwd || "(home)"}\n${recent || "(no recent activity)"}`;
    })
    .join("\n\n");
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

const PANEL_W = 380;
const PANEL_H = 300;

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "execution-plan";
}

/**
 * Strategy Mode — a separate PLANNING workspace. It overlays the left + center
 * columns (the orchestrator stays visible on the right) so several AI
 * participants can debate an approach, moderated by the user, before any coding
 * begins. The output is a reusable Execution Plan.
 */
export function StrategyPanel({ projects, rightWidth, onClose }: Props) {
  const { roster, plans, session, auto, maxRounds } = useStrategy();
  const [request, setRequest] = useState("");
  const [ctxIds, setCtxIds] = useState<string[]>([]);
  const [library, setLibrary] = useState(false);

  const start = () => {
    const selected = projects.filter((p) => ctxIds.includes(p.id));
    void strategyStore.start(request, ctxIds, buildContextText(selected));
  };

  return (
    <div
      className="absolute z-30 flex flex-col overflow-hidden rounded-xl border border-accent/40 bg-panel shadow-2xl"
      style={{ left: 8, top: 8, bottom: 8, right: rightWidth + 16 }}
    >
      {/* Header — makes it obvious this is the planning phase, not implementation. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-gradient-to-r from-accent/15 to-transparent px-4 py-2.5">
        <img src={strategyIcon} alt="" className="h-7 w-7 rounded-md object-contain" />
        <div className="min-w-0 flex-1">
          <div className="text-grad text-sm font-semibold">Strategy Mode</div>
          <div className="truncate text-[11px] text-muted">
            Plan complex work with a moderated multi-agent discussion — before any code is written.
          </div>
        </div>
        <button
          onClick={() => setLibrary((v) => !v)}
          className={`rounded px-2 py-1 text-[11px] font-medium ${
            library ? "bg-accent/25 text-accent" : "text-muted hover:bg-edge hover:text-gray-200"
          }`}
          title="Saved Execution Plans"
        >
          📚 Plans {plans.length > 0 && <span className="text-accent">({plans.length})</span>}
        </button>
        {session?.busy && (
          <button
            onClick={() => strategyStore.stop()}
            className="rounded bg-red-500/25 px-2 py-1 text-[11px] font-semibold text-red-200 hover:bg-red-500/35"
          >
            ⏹ Stop
          </button>
        )}
        {session && (
          <button
            onClick={() => strategyStore.reset()}
            className="rounded px-2 py-1 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
            title="Discard this discussion (roster + saved plans are kept)"
          >
            ✚ New
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-muted hover:bg-edge hover:text-gray-200"
          title="Close Strategy Mode"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {library ? (
          <PlanLibrary
            plans={plans}
            projects={projects}
            onClose={() => setLibrary(false)}
          />
        ) : !session ? (
          <SetupView
            roster={roster}
            projects={projects}
            request={request}
            setRequest={setRequest}
            ctxIds={ctxIds}
            setCtxIds={setCtxIds}
            onStart={start}
          />
        ) : (
          <DiscussionView session={session} auto={auto} maxRounds={maxRounds} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup phase — compose the request, pick context projects, edit the roster.
// ---------------------------------------------------------------------------

function SetupView({
  roster,
  projects,
  request,
  setRequest,
  ctxIds,
  setCtxIds,
  onStart,
}: {
  roster: StrategyParticipant[];
  projects: StrategyProject[];
  request: string;
  setRequest: (s: string) => void;
  ctxIds: string[];
  setCtxIds: (ids: string[]) => void;
  onStart: () => void;
}) {
  const enabled = roster.filter((p) => p.enabled).length;
  const canStart = request.trim().length > 0 && enabled > 0;
  const toggleCtx = (id: string) =>
    setCtxIds(ctxIds.includes(id) ? ctxIds.filter((x) => x !== id) : [...ctxIds, id]);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-5">
      <section>
        <label className="mb-1.5 block text-xs font-semibold text-gray-200">Feature request / task to plan</label>
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={4}
          placeholder="Describe the complex feature or task. The participants will debate the best implementation strategy…"
          className="w-full resize-y rounded-lg border border-edge bg-card px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-muted/50 focus:border-accent"
        />
      </section>

      {projects.length > 0 && (
        <section>
          <div className="mb-1.5 text-xs font-semibold text-gray-200">
            Attach project context <span className="font-normal text-muted">(optional — pick any open projects the agents should be aware of)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => {
              const on = ctxIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggleCtx(p.id)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    on
                      ? "border-accent bg-accent/20 text-accent"
                      : "border-edge text-muted hover:bg-edge/50 hover:text-gray-200"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {p.name}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <RosterEditor roster={roster} />

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={onStart}
          disabled={!canStart}
          className={`rounded-lg px-4 py-2 text-sm font-semibold ${
            canStart
              ? "bg-accent text-white hover:bg-accent/80"
              : "cursor-not-allowed border border-edge text-muted/50"
          }`}
        >
          ▶ Start discussion
        </button>
        <span className="text-xs text-muted">
          {enabled} participant{enabled === 1 ? "" : "s"} · round-by-round, you moderate
        </span>
      </div>
    </div>
  );
}

function RosterEditor({ roster }: { roster: StrategyParticipant[] }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-gray-200">Strategy participants</div>
        <button
          onClick={() => strategyStore.addParticipant()}
          className="rounded border border-edge px-2 py-1 text-[11px] text-muted hover:bg-edge/50 hover:text-gray-200"
        >
          ＋ Add participant
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {roster.map((p) => (
          <ParticipantRow key={p.id} p={p} />
        ))}
        {roster.length === 0 && (
          <div className="rounded-lg border border-dashed border-edge px-3 py-4 text-center text-xs text-muted">
            No participants yet — add at least one to start a discussion.
          </div>
        )}
      </div>
    </section>
  );
}

function ParticipantRow({ p }: { p: StrategyParticipant }) {
  const settings = useSettings();
  const { roles } = useStrategy();
  const up = (patch: Partial<StrategyParticipant>) => strategyStore.updateParticipant(p.id, patch);
  const models = modelsFor(p.provider);

  return (
    <div
      className={`rounded-lg border bg-card p-2.5 ${p.enabled ? "border-edge" : "border-edge/40 opacity-60"}`}
      style={p.enabled ? { borderLeft: `3px solid ${p.color}` } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={p.enabled}
          onChange={(e) => up({ enabled: e.target.checked })}
          title="Include in the discussion"
          className="accent-[var(--octo-accent,#7c5cff)]"
        />
        <select
          value={p.roleId}
          onChange={(e) => up({ roleId: e.target.value })}
          title="Role — this participant's identity/lens in the discussion (managed in Settings → Strategy Roles)"
          className="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-1 text-xs font-semibold text-gray-100 outline-none focus:border-accent"
        >
          <optgroup label="Built-in">
            {roles.filter((r) => r.builtin).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
          {roles.some((r) => !r.builtin) && (
            <optgroup label="Custom">
              {roles.filter((r) => !r.builtin).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          onClick={() => strategyStore.removeParticipant(p.id)}
          title="Remove participant"
          className="rounded px-1 text-muted hover:text-red-300"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={p.provider}
          onChange={(e) => up({ provider: e.target.value as StrategyParticipant["provider"], model: null })}
          className="rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-gray-200 outline-none focus:border-accent"
        >
          {PROVIDERS.map((pr) => (
            <option key={pr.value} value={pr.value}>
              {pr.label}
            </option>
          ))}
        </select>
        <select
          value={p.model ?? ""}
          onChange={(e) => up({ model: e.target.value || null })}
          className="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-gray-200 outline-none focus:border-accent"
        >
          {models.map((m) => (
            <option key={m.label} value={m.value ?? ""}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {PARTICIPANT_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => up({ color: c })}
              className={`h-4 w-4 rounded-full ${p.color === c ? "ring-2 ring-white/70" : ""}`}
              style={{ background: c }}
              title="Set colour"
            />
          ))}
        </div>
      </div>
      {settings.profiles.length > 0 && (
        <select
          value={p.profileId ?? ""}
          onChange={(e) => up({ profileId: e.target.value || null })}
          className="mt-1.5 w-full rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-gray-300 outline-none focus:border-accent"
        >
          <option value="">Default account</option>
          {settings.profiles.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discussion phase — participant panels + round controls + report.
// ---------------------------------------------------------------------------

function DiscussionView({
  session,
  auto,
  maxRounds,
}: {
  session: NonNullable<ReturnType<typeof useStrategy>["session"]>;
  auto: boolean;
  maxRounds: number;
}) {
  const round = session.round; // completed rounds
  // Flow layout: panels sit in a wrapping row and each is individually resizable
  // (native CSS resize). Because it's document flow, growing one panel pushes the
  // others down instead of overlapping. Drag a header onto another to reorder.
  // `tidyNonce` remounts the panels to reset any manual resize back to default.
  const [order, setOrder] = useState<string[]>(() => session.participants.map((p) => p.id));
  const [tidyNonce, setTidyNonce] = useState(0);
  const dragId = useRef<string | null>(null);
  // Keep order in sync if the participant set changes (defensive).
  const ids = session.participants.map((p) => p.id);
  const orderedIds = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
  const ordered = orderedIds.map((id) => session.participants.find((p) => p.id === id)!).filter(Boolean);

  const reorder = (from: string, to: string) => {
    if (from === to) return;
    setOrder(() => {
      const arr = [...orderedIds];
      const fi = arr.indexOf(from);
      const ti = arr.indexOf(to);
      if (fi < 0 || ti < 0) return arr;
      arr.splice(fi, 1);
      arr.splice(ti, 0, from);
      return arr;
    });
  };
  const tidy = () => {
    setOrder(session.participants.map((p) => p.id));
    setTidyNonce((n) => n + 1);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-lg border border-edge bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Planning</div>
          <button
            onClick={tidy}
            className="ml-auto rounded px-2 py-0.5 text-[10px] text-muted hover:bg-edge hover:text-gray-200"
            title="Reset panel order and sizes"
          >
            ⤢ Tidy panels
          </button>
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-200">{session.request}</div>
        <div className="mt-1 text-[11px] text-muted">
          Round {round} · {session.participants.length} participants · drag the corner to resize, drag a header onto another to reorder
          {session.busy && (
            <span className="ml-2 inline-block align-middle">
              <WorkingNode size={7} />
            </span>
          )}
        </div>
      </div>

      {/* Resizable participant panels in a wrapping flow (no overlap). */}
      <div className="flex flex-wrap gap-3">
        {ordered.map((p) => (
          <ParticipantWindow
            key={`${p.id}:${tidyNonce}`}
            participant={p}
            session={session}
            onDragStart={() => (dragId.current = p.id)}
            onDropOn={() => dragId.current && reorder(dragId.current, p.id)}
          />
        ))}
      </div>

      {/* Round controls. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-card px-3 py-2">
        <button
          onClick={() => void strategyStore.runRound()}
          disabled={session.busy || round === 0}
          className={`rounded px-3 py-1.5 text-xs font-semibold ${
            session.busy || round === 0
              ? "cursor-not-allowed border border-edge text-muted/50"
              : "bg-edge text-gray-100 hover:bg-edge/70"
          }`}
          title="Continue the discussion with another round"
        >
          🔄 Next round
        </button>
        <button
          onClick={() => void strategyStore.generateReport()}
          disabled={session.busy || round === 0}
          className={`rounded px-3 py-1.5 text-xs font-semibold ${
            session.busy || round === 0
              ? "cursor-not-allowed border border-edge text-muted/50"
              : "bg-accent text-white hover:bg-accent/80"
          }`}
          title="Synthesize the discussion into a Final Strategy Report"
        >
          📋 Generate Final Report
        </button>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => strategyStore.setAuto(e.target.checked)}
            />
            Auto rounds
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted" title="Hard cap on rounds in auto mode. Auto also stops early when the discussion converges.">
            max
            <input
              type="number"
              min={1}
              max={20}
              value={maxRounds}
              onChange={(e) => strategyStore.setMaxRounds(Number(e.target.value))}
              className="w-12 rounded border border-edge bg-panel px-1.5 py-0.5 text-center text-[11px] text-gray-200 outline-none focus:border-accent"
            />
          </label>
        </div>
      </div>

      {session.report != null && <ReportView session={session} />}
    </div>
  );
}

function ParticipantWindow({
  participant,
  session,
  onDragStart,
  onDropOn,
}: {
  participant: StrategyParticipant;
  session: NonNullable<ReturnType<typeof useStrategy>["session"]>;
  onDragStart: () => void;
  onDropOn: () => void;
}) {
  const mine = session.messages
    .filter((m) => m.participantId === participant.id)
    .sort((a, b) => a.round - b.round);
  const provider = PROVIDERS.find((x) => x.value === participant.provider);
  const [dragOver, setDragOver] = useState(false);

  return (
    // Native CSS resize (`resize: both`) gives a bottom-right grip; because the
    // panel lives in normal flex flow, resizing it reflows the row and pushes the
    // others down/across instead of overlapping. The header is an HTML5 drag
    // source/target for reordering.
    <div
      className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
      style={{
        width: PANEL_W,
        height: PANEL_H,
        minWidth: 220,
        minHeight: 140,
        maxWidth: "100%",
        resize: "both",
        borderColor: participant.color,
        outline: dragOver ? "2px dashed var(--octo-accent,#7c5cff)" : undefined,
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={() => {
        setDragOver(false);
        onDropOn();
      }}
    >
      <div
        draggable
        onDragStart={onDragStart}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-edge px-2.5 py-1.5 select-none active:cursor-grabbing"
        title="Drag onto another panel to reorder"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: participant.color }} />
        <span className="text-xs font-semibold text-gray-100">
          {strategyStore.labelFor(participant, session.participants)}
        </span>
        <span className="ml-auto truncate text-[10px] text-muted">{provider?.label ?? participant.provider}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2.5 py-2 text-xs">
        {mine.length === 0 && <div className="text-muted">Waiting…</div>}
        {mine.map((m) => (
          <div key={m.round}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Round {m.round + 1}
            </div>
            {m.status === "running" ? (
              <WorkingNode />
            ) : m.status === "error" ? (
              <div className="whitespace-pre-wrap break-words text-red-300">{m.content}</div>
            ) : (
              <div className="leading-relaxed text-gray-200">
                <Markdown text={m.content} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Final report + the three end-of-discussion actions.
// ---------------------------------------------------------------------------

function ReportView({
  session,
}: {
  session: NonNullable<ReturnType<typeof useStrategy>["session"]>;
}) {
  const report = session.report ?? "";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [newChat, setNewChat] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState(false);

  const buildAndExport = async () => {
    const plan = strategyStore.buildPlan(title);
    if (!plan) return;
    strategyStore.savePlan(plan);
    setSaved(true);
    await exportMarkdown(plan);
  };

  const saveToLibrary = () => {
    const plan = strategyStore.buildPlan(title);
    if (!plan) return;
    strategyStore.savePlan(plan);
    setSaved(true);
  };

  const execute = () => {
    const framed = framePlanForOrchestrator(report, session.request);
    const ok = sendPlanToOrchestrator({ text: framed, newChat });
    if (ok) setSent(true);
  };

  return (
    <div className="rounded-lg border border-accent/40 bg-card">
      <div className="flex items-center gap-2 border-b border-edge bg-accent/10 px-3 py-2">
        <span className="text-sm">📋</span>
        <span className="text-grad text-sm font-semibold">Final Strategy Report</span>
        <span className="text-[11px] text-muted">= your reusable Execution Plan</span>
        <button
          onClick={() => setEditing((v) => !v)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
        >
          {editing ? "Preview" : "✎ Edit"}
        </button>
      </div>

      {editing ? (
        <textarea
          value={report}
          onChange={(e) => strategyStore.setReport(e.target.value)}
          rows={18}
          className="w-full resize-y bg-well/40 px-3 py-2 font-mono text-xs text-gray-100 outline-none"
        />
      ) : (
        <div className="max-h-[55vh] overflow-y-auto px-4 py-3 text-sm leading-relaxed">
          <Markdown text={report} />
        </div>
      )}

      {/* Actions. */}
      <div className="space-y-2 border-t border-edge px-3 py-3">
        <div className="flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Plan title (for the library / .md file)"
            className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-gray-100 outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={execute}
            disabled={!orchestratorReady()}
            title={orchestratorReady() ? "Hand this plan to the coding orchestrator" : "Orchestrator not available"}
            className={`rounded px-3 py-1.5 text-xs font-semibold ${
              orchestratorReady()
                ? "bg-accent text-white hover:bg-accent/80"
                : "cursor-not-allowed border border-edge text-muted/50"
            }`}
          >
            🚀 Execute Plan
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={newChat} onChange={(e) => setNewChat(e.target.checked)} />
            in a new orchestrator chat
          </label>
          <button
            onClick={saveToLibrary}
            className="rounded border border-edge px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-edge/50"
          >
            💾 Save Plan
          </button>
          <button
            onClick={buildAndExport}
            className="rounded border border-edge px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-edge/50"
          >
            ⬇ Export .md
          </button>
          <button
            onClick={() => void strategyStore.runRound()}
            disabled={session.busy}
            className="rounded border border-edge px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-edge/50 disabled:opacity-50"
          >
            💬 Continue discussion
          </button>
          {saved && <span className="text-[11px] text-emerald-300">✓ saved to library</span>}
          {sent && <span className="text-[11px] text-accent">🚀 handed to the orchestrator →</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved plans library.
// ---------------------------------------------------------------------------

function PlanLibrary({
  plans,
  projects,
  onClose,
}: {
  plans: ExecutionPlan[];
  projects: StrategyProject[];
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = plans.find((p) => p.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-5">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold text-gray-200">Saved Execution Plans</div>
        <span className="text-[11px] text-muted">Reuse a plan any time — execute it without re-running the discussion.</span>
        <button onClick={onClose} className="ml-auto rounded px-2 py-1 text-[11px] text-muted hover:bg-edge hover:text-gray-200">
          ← Back
        </button>
      </div>

      {plans.length === 0 && (
        <div className="rounded-lg border border-dashed border-edge px-4 py-8 text-center text-sm text-muted">
          No saved plans yet. Run a discussion and click <b>Save Plan</b> to keep it here.
        </div>
      )}

      <div className="grid gap-2">
        {plans.map((p) => (
          <div key={p.id} className="rounded-lg border border-edge bg-card">
            <div className="flex items-center gap-2 px-3 py-2">
              <button onClick={() => setOpenId(openId === p.id ? null : p.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium text-gray-100">{p.title}</div>
                <div className="truncate text-[11px] text-muted">{fmtTime(p.createdAt)} · {p.request.slice(0, 80)}</div>
              </button>
              <button
                onClick={() => {
                  const framed = framePlanForOrchestrator(p.markdown, p.request);
                  sendPlanToOrchestrator({ text: framed, newChat: true });
                }}
                disabled={!orchestratorReady()}
                className={`rounded px-2 py-1 text-[11px] font-semibold ${
                  orchestratorReady() ? "bg-accent/80 text-white hover:bg-accent" : "cursor-not-allowed border border-edge text-muted/50"
                }`}
                title="Execute in a new orchestrator chat"
              >
                🚀 Execute
              </button>
              <button
                onClick={() => void exportMarkdown(p)}
                className="rounded px-2 py-1 text-[11px] text-muted hover:bg-edge hover:text-gray-200"
              >
                ⬇ .md
              </button>
              <button
                onClick={() => strategyStore.deletePlan(p.id)}
                className="rounded px-1.5 py-1 text-[11px] text-muted hover:text-red-300"
                title="Delete plan"
              >
                ✕
              </button>
            </div>
            {open?.id === p.id && (
              <div className="max-h-[50vh] overflow-y-auto border-t border-edge px-4 py-3 text-sm leading-relaxed">
                <Markdown text={p.markdown} />
              </div>
            )}
          </div>
        ))}
      </div>
      {/* projects unused here but kept for future per-plan target selection. */}
      {false && <span>{projects.length}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** Frame a plan as a self-contained instruction for the coding orchestrator. */
function framePlanForOrchestrator(markdown: string, request: string): string {
  return [
    "Here is an APPROVED Execution Plan produced in Strategy Mode. Implement it.",
    "Break it into concrete dispatches to the appropriate project agents, following the 'Suggested Implementation Steps' and honouring the 'Acceptance Criteria'. Fan out independent work in parallel where the plan allows.",
    "",
    `Original request: ${request}`,
    "",
    "--- EXECUTION PLAN ---",
    "",
    markdown,
  ].join("\n");
}

/** Save-dialog + backend write of a plan as a Markdown document. */
async function exportMarkdown(plan: ExecutionPlan): Promise<void> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: `${slug(plan.title)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    const body = [
      `# ${plan.title}`,
      "",
      `_Created ${fmtTime(plan.createdAt)}_`,
      "",
      `> **Original request:** ${plan.request}`,
      "",
      plan.markdown,
      "",
    ].join("\n");
    await invoke("write_text_file", { path, contents: body });
  } catch {
    /* user cancelled or write failed — non-fatal */
  }
}
