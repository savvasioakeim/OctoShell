// Strategy Mode store: a module singleton (like serviceStore/settingsStore) that
// owns the participant roster, the saved Execution Plan library, and the live
// discussion engine. Planning is fully decoupled from execution — this store
// never dispatches coding agents; it only produces plans. Handing a plan to the
// coding orchestrator goes through orchestratorBridge.

import { useSyncExternalStore } from "react";
import { AiClient, type ChatMessage } from "../ai/AiClient";
import { KEY, loadJSON, saveJSON } from "../util/persist";
import { settingsStore } from "../settings/settingsStore";
import { supportsProfile, type AgentProvider } from "../agents/providers";
import { BUILTIN_ROLES, DEFAULT_ROLE_ID, type StrategyRole } from "./roles";
import type {
  ExecutionPlan,
  StrategyMessage,
  StrategyParticipant,
  StrategySession,
} from "./strategyTypes";

/** Palette for new participants (distinct, readable on the dark panel). */
export const PARTICIPANT_COLORS = [
  "#82AAFF",
  "#C792EA",
  "#4ade80",
  "#f78c6c",
  "#7fdbca",
  "#ffcb6b",
  "#ff5370",
  "#f07178",
];

/** The eight structured sections every Execution Plan report must contain. */
const REPORT_SECTIONS = [
  "Goal",
  "Proposed Architecture",
  "Key Decisions",
  "Alternative Approaches",
  "Risks",
  "Open Questions",
  "Suggested Implementation Steps",
  "Acceptance Criteria",
];

/** A fresh default roster so the panel is usable on first open — two generic
 *  strategists on the user's configured orchestrator provider. Roles are plain
 *  labels (no hardcoded specialisation yet). */
function defaultRoster(): StrategyParticipant[] {
  const { provider, model } = settingsStore.getSnapshot().orchestrator;
  const mk = (roleId: string, i: number): StrategyParticipant => ({
    id: crypto.randomUUID(),
    roleId,
    provider,
    model,
    profileId: null,
    color: PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length],
    enabled: true,
  });
  return [mk("builtin-architect", 0), mk("builtin-qa", 1)];
}

/** Coerce a persisted participant to the current shape — older blobs stored a
 *  free-text `role` and no `roleId`; map them onto the neutral default so the
 *  roster never breaks after the roles upgrade. */
function migrateParticipant(p: any): StrategyParticipant {
  return {
    id: p.id ?? crypto.randomUUID(),
    roleId: typeof p.roleId === "string" ? p.roleId : DEFAULT_ROLE_ID,
    provider: p.provider ?? "claude",
    model: p.model ?? null,
    profileId: p.profileId ?? null,
    color: p.color ?? PARTICIPANT_COLORS[0],
    enabled: p.enabled !== false,
  };
}

interface StrategyState {
  roster: StrategyParticipant[];
  plans: ExecutionPlan[];
  /** Built-in (locked) + user-defined roles. */
  roles: StrategyRole[];
  session: StrategySession | null;
  /** True while auto-run rounds are firing (user can stop). */
  auto: boolean;
  /** Hard cap on total rounds in auto mode (backstop against an endless loop). */
  maxRounds: number;
}

class StrategyStore {
  private state: StrategyState;
  private listeners = new Set<() => void>();
  private client = new AiClient();
  /** Ids of in-flight orchestrator turns for the active round, so stop() cancels. */
  private inflight = new Set<string>();
  /** Set when the user stops — round/report loops check it to bail out. */
  private cancelled = false;

  constructor() {
    const raw = loadJSON<any[]>(KEY.strategyRoster, []);
    const roster = raw.length ? raw.map(migrateParticipant) : defaultRoster();
    // Only CUSTOM roles are persisted; the locked built-ins always come from code
    // (so their prompts stay canonical and can be improved in updates).
    const custom = loadJSON<StrategyRole[]>(KEY.strategyRoles, []).map((r) => ({ ...r, builtin: false }));
    this.state = {
      roster,
      plans: loadJSON<ExecutionPlan[]>(KEY.strategyPlans, []),
      roles: [...BUILTIN_ROLES, ...custom],
      session: null,
      auto: false,
      maxRounds: 4,
    };
  }

  /** All roles (built-ins first, then custom). */
  private customRoles(): StrategyRole[] {
    return this.state.roles.filter((r) => !r.builtin);
  }
  private persistRoles(): void {
    saveJSON(KEY.strategyRoles, this.customRoles());
  }
  /** Resolve a role by id, falling back to the neutral default. */
  roleFor(id: string): StrategyRole {
    return this.state.roles.find((r) => r.id === id) ?? BUILTIN_ROLES[0];
  }

  /** A participant's display label = its role name, disambiguated with a trailing
   *  index when several participants share the same role (e.g. "Architect 2"). */
  labelFor(p: StrategyParticipant, among: StrategyParticipant[]): string {
    const name = this.roleFor(p.roleId).name;
    const sameRole = among.filter((x) => x.roleId === p.roleId);
    if (sameRole.length <= 1) return name;
    return `${name} ${sameRole.findIndex((x) => x.id === p.id) + 1}`;
  }

  getSnapshot = (): StrategyState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit(next: Partial<StrategyState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  private persistRoster(roster: StrategyParticipant[]): void {
    saveJSON(KEY.strategyRoster, roster);
  }
  private persistPlans(plans: ExecutionPlan[]): void {
    saveJSON(KEY.strategyPlans, plans);
  }

  // ---- Roster CRUD ----

  addParticipant(): StrategyParticipant {
    const { provider, model } = settingsStore.getSnapshot().orchestrator;
    const p: StrategyParticipant = {
      id: crypto.randomUUID(),
      roleId: DEFAULT_ROLE_ID,
      provider,
      model,
      profileId: null,
      color: PARTICIPANT_COLORS[this.state.roster.length % PARTICIPANT_COLORS.length],
      enabled: true,
    };
    const roster = [...this.state.roster, p];
    this.persistRoster(roster);
    this.emit({ roster });
    return p;
  }

  updateParticipant(id: string, patch: Partial<StrategyParticipant>): void {
    const roster = this.state.roster.map((p) => (p.id === id ? { ...p, ...patch } : p));
    this.persistRoster(roster);
    this.emit({ roster });
  }

  removeParticipant(id: string): void {
    const roster = this.state.roster.filter((p) => p.id !== id);
    this.persistRoster(roster);
    this.emit({ roster });
  }

  // ---- Roles CRUD (built-ins are locked; only custom roles are mutable) ----

  /** Create a new, empty custom role and return it. */
  addRole(name = "New role", prompt = ""): StrategyRole {
    const role: StrategyRole = { id: crypto.randomUUID(), name, prompt, builtin: false };
    this.emit({ roles: [...this.state.roles, role] });
    this.persistRoles();
    return role;
  }

  /** Clone any role (typically a locked built-in) into an editable custom copy. */
  cloneRole(id: string): StrategyRole {
    const src = this.roleFor(id);
    return this.addRole(`${src.name} (copy)`, src.prompt);
  }

  /** Edit a custom role. Built-ins are immutable (call ignored for them). */
  updateRole(id: string, patch: Partial<Pick<StrategyRole, "name" | "prompt">>): void {
    const roles = this.state.roles.map((r) =>
      r.id === id && !r.builtin ? { ...r, ...patch } : r,
    );
    this.emit({ roles });
    this.persistRoles();
  }

  /** Delete a custom role. Participants using it fall back to the default. */
  deleteRole(id: string): void {
    const role = this.state.roles.find((r) => r.id === id);
    if (!role || role.builtin) return;
    const roles = this.state.roles.filter((r) => r.id !== id);
    const roster = this.state.roster.map((p) =>
      p.roleId === id ? { ...p, roleId: DEFAULT_ROLE_ID } : p,
    );
    this.persistRoster(roster);
    this.emit({ roles, roster });
    this.persistRoles();
  }

  // ---- Plans library ----

  savePlan(plan: ExecutionPlan): void {
    const existing = this.state.plans.find((p) => p.id === plan.id);
    const plans = existing
      ? this.state.plans.map((p) => (p.id === plan.id ? plan : p))
      : [plan, ...this.state.plans];
    this.persistPlans(plans);
    this.emit({ plans });
  }

  deletePlan(id: string): void {
    const plans = this.state.plans.filter((p) => p.id !== id);
    this.persistPlans(plans);
    this.emit({ plans });
  }

  // ---- Discussion engine ----

  /** Begin a discussion: snapshot the enabled participants + the attached project
   *  context, then run the first round. `contextText` is a pre-built digest of the
   *  selected projects (the store doesn't hold controllers). */
  async start(request: string, contextProjectIds: string[], contextText: string): Promise<void> {
    const participants = this.state.roster.filter((p) => p.enabled);
    if (!participants.length || !request.trim()) return;
    this.cancelled = false;
    const session: StrategySession = {
      request: request.trim(),
      contextProjectIds,
      participants,
      messages: [],
      round: 0,
      phase: "setup",
      report: null,
      busy: false,
    };
    this.emit({ session });
    this.contextText = contextText;
    await this.runRound();
  }

  /** Cached context digest for the active session's re-runs. */
  private contextText = "";

  /** Run one discussion round: every participant answers in parallel, seeing the
   *  original request, their own previous answer, and the others' latest answers. */
  async runRound(): Promise<void> {
    const s = this.state.session;
    if (!s || s.busy) return;
    const round = s.round;
    // Seed a running placeholder per participant so their panels show activity.
    const placeholders: StrategyMessage[] = s.participants.map((p) => ({
      participantId: p.id,
      round,
      content: "",
      at: Date.now(),
      status: "running",
    }));
    this.emit({
      session: {
        ...s,
        busy: true,
        phase: "discussing",
        messages: [...s.messages, ...placeholders],
      },
    });

    await Promise.all(
      s.participants.map(async (p) => {
        const reqId = crypto.randomUUID();
        this.inflight.add(reqId);
        try {
          const { system, messages } = this.buildTurn(p, round);
          const reply = await this.client.chat(messages, system, {
            ...this.chatOptsFor(p),
            requestId: reqId,
          });
          if (this.cancelled) return;
          this.patchMessage(p.id, round, { content: reply, status: "done" });
        } catch (err) {
          if (this.cancelled) return;
          this.patchMessage(p.id, round, {
            content: `⚠️ ${err}`,
            status: "error",
          });
        } finally {
          this.inflight.delete(reqId);
        }
      }),
    );

    const cur = this.state.session;
    if (!cur) return;
    const completed = round + 1;
    this.emit({ session: { ...cur, busy: false, round: completed } });

    // Auto mode: keep going, but never forever. Stop on the hard cap; from round
    // 2 on (when participants have actually seen each other), also stop early once
    // a judge decides they've converged — and then produce the report on its own.
    if (this.state.auto && !this.cancelled) {
      if (completed >= this.state.maxRounds) {
        this.emit({ auto: false });
        return;
      }
      if (completed >= 2) {
        const converged = await this.checkConvergence();
        if (this.cancelled) return;
        if (converged) {
          this.emit({ auto: false });
          await this.generateReport();
          return;
        }
      }
      await this.runRound();
    }
  }

  /** Ask the orchestrator model whether the discussion has essentially converged
   *  (broad agreement + the last round added little new). Used only to end auto
   *  mode early; a failure is treated as "not converged" so it keeps going up to
   *  the cap. */
  private async checkConvergence(): Promise<boolean> {
    const s = this.state.session;
    if (!s) return false;
    const reqId = crypto.randomUUID();
    this.inflight.add(reqId);
    try {
      const orch = settingsStore.getSnapshot().orchestrator;
      const configDir = supportsProfile(orch.provider)
        ? settingsStore.configDirFor(orch.profileId)
        : null;
      const lastRound = s.round - 1;
      const answers = s.participants
        .map((p) => {
          const m = s.messages.find(
            (x) => x.participantId === p.id && x.round === lastRound && x.status === "done",
          );
          return m && m.content.trim() ? `### ${this.labelFor(p, s.participants)}\n${m.content}` : null;
        })
        .filter(Boolean)
        .join("\n\n");
      const system =
        "You are moderating a technical design discussion. Judge whether the participants have essentially CONVERGED (they broadly agree and the latest round added little that is materially new) or should CONTINUE debating. Reply with exactly one word on the first line: CONVERGED or CONTINUE.";
      const user = `Original request:\n${s.request}\n\nLatest round proposals:\n\n${answers}`;
      const verdict = await this.client.chat([{ role: "user", content: user }], system, {
        provider: orch.provider,
        model: orch.model,
        configDir,
        requestId: reqId,
      });
      return /converged/i.test(verdict.slice(0, 40));
    } catch {
      return false;
    } finally {
      this.inflight.delete(reqId);
    }
  }

  /** Patch a specific participant's message for a round (immutable update). */
  private patchMessage(
    participantId: string,
    round: number,
    patch: Partial<StrategyMessage>,
  ): void {
    const s = this.state.session;
    if (!s) return;
    const messages = s.messages.map((m) =>
      m.participantId === participantId && m.round === round ? { ...m, ...patch } : m,
    );
    this.emit({ session: { ...s, messages } });
  }

  /** Build one participant's turn: a role/system prompt plus the conversation as
   *  seen from THAT participant (its own prior answers are `assistant`, everyone
   *  else's are folded into the round-summary user message). */
  private buildTurn(
    p: StrategyParticipant,
    round: number,
  ): { system: string; messages: ChatMessage[] } {
    const s = this.state.session!;
    const role = this.roleFor(p.roleId);
    const label = this.labelFor(p, s.participants);
    const system = [
      `You are the ${label} in this discussion.`,
      role.prompt,
      "\nYou are taking part in a moderated strategy discussion. The goal is to PLAN a software task thoroughly BEFORE any coding begins, so implementation mistakes are avoided. A human moderator runs the discussion; several AI participants (including you) debate the best approach. Stay in character for your role above while you do.",
      this.contextText
        ? `\nAttached project context (for reference — do not assume anything not shown):\n${this.contextText}`
        : "",
      "\nHow to contribute:",
      "- Propose a concrete strategy: architecture, key decisions, trade-offs, risks, and clear implementation steps.",
      "- Be opinionated and specific. Prefer clarity over hedging.",
      round > 0
        ? "- You are now seeing the OTHER participants' proposals. CRITIQUE them honestly, then IMPROVE or CHANGE your own proposal in response — do NOT just repeat your previous answer. Call out real disagreements and say why."
        : "- This is the first round: lay out your initial proposal.",
      "- Write in clear Markdown. Keep it focused; avoid large code dumps.",
    ]
      .filter(Boolean)
      .join("\n");

    const messages: ChatMessage[] = [
      { role: "user", content: `Feature request / task to plan:\n\n${s.request}` },
    ];
    // Prior rounds: replay this participant's own answer as `assistant`, then the
    // others' answers of that round as a moderator `user` message.
    for (let r = 0; r < round; r++) {
      const own = s.messages.find(
        (m) => m.participantId === p.id && m.round === r && m.status === "done",
      );
      if (own) messages.push({ role: "assistant", content: own.content });
      const others = s.messages.filter(
        (m) => m.participantId !== p.id && m.round === r && m.status === "done" && m.content.trim(),
      );
      if (others.length) {
        const byName = others
          .map((m) => {
            const other = s.participants.find((x) => x.id === m.participantId);
            const who = other ? this.labelFor(other, s.participants) : "Participant";
            return `### ${who}\n${m.content}`;
          })
          .join("\n\n");
        messages.push({
          role: "user",
          content: `Round ${r + 1} — the other participants proposed:\n\n${byName}\n\nNow critique these and refine your own proposal.`,
        });
      }
    }
    return { system, messages };
  }

  /** Map a participant's provider/model/profile (+ Ollama defaults) to ChatOpts. */
  private chatOptsFor(p: StrategyParticipant) {
    const st = settingsStore.getSnapshot();
    const configDir = supportsProfile(p.provider)
      ? st.profiles.find((x) => x.id === p.profileId)?.configDir ?? null
      : null;
    const isOllama = p.provider === "acp-ollama";
    return {
      provider: p.provider as AgentProvider,
      model: p.model,
      configDir,
      baseUrl: isOllama ? st.ollama.baseUrl : null,
      numCtx: isOllama ? st.ollama.contextWindow : null,
      temperature: isOllama ? st.ollama.temperature : null,
    };
  }

  /** Synthesize the discussion into a structured Final Strategy Report using the
   *  configured orchestrator provider/model. */
  async generateReport(): Promise<void> {
    const s = this.state.session;
    if (!s || s.busy) return;
    this.cancelled = false;
    this.emit({ session: { ...s, busy: true } });
    const reqId = crypto.randomUUID();
    this.inflight.add(reqId);
    try {
      const orch = settingsStore.getSnapshot().orchestrator;
      const configDir = supportsProfile(orch.provider)
        ? settingsStore.configDirFor(orch.profileId)
        : null;
      const transcript = this.transcriptText();
      const system = [
        "You are the lead architect. Synthesize a multi-agent strategy discussion into ONE clear, actionable Execution Plan for a software task.",
        "Weigh the participants' proposals: keep the strongest ideas, resolve disagreements with a clear recommendation, and be decisive.",
        `Output GitHub-flavoured Markdown with EXACTLY these level-2 sections, in this order, each non-empty:\n${REPORT_SECTIONS.map((h) => `## ${h}`).join("\n")}`,
        "Under 'Suggested Implementation Steps' give an ordered, concrete checklist an engineer (or a coding agent) can follow. Under 'Acceptance Criteria' give verifiable conditions for done. Do not add sections beyond these.",
      ].join("\n\n");
      const user = `Original request:\n\n${s.request}\n\n---\n\nDiscussion transcript:\n\n${transcript}`;
      const report = await this.client.chat([{ role: "user", content: user }], system, {
        provider: orch.provider,
        model: orch.model,
        configDir,
        requestId: reqId,
      });
      if (this.cancelled) return;
      const cur = this.state.session;
      if (!cur) return;
      this.emit({ session: { ...cur, report, phase: "reported", busy: false } });
    } catch (err) {
      const cur = this.state.session;
      if (cur) {
        this.emit({
          session: {
            ...cur,
            report: `⚠️ Failed to generate the report: ${err}`,
            phase: "reported",
            busy: false,
          },
        });
      }
    } finally {
      this.inflight.delete(reqId);
    }
  }

  /** Flatten the whole discussion into a labelled, round-by-round transcript. */
  private transcriptText(): string {
    const s = this.state.session;
    if (!s) return "";
    const out: string[] = [];
    for (let r = 0; r < s.round; r++) {
      out.push(`# Round ${r + 1}`);
      for (const p of s.participants) {
        const m = s.messages.find(
          (x) => x.participantId === p.id && x.round === r && x.status === "done",
        );
        if (m && m.content.trim()) out.push(`## ${this.labelFor(p, s.participants)}\n${m.content}`);
      }
    }
    return out.join("\n\n");
  }

  /** Let the report be hand-edited before saving/executing. */
  setReport(report: string): void {
    const s = this.state.session;
    if (s) this.emit({ session: { ...s, report } });
  }

  setAuto(auto: boolean): void {
    this.emit({ auto });
  }

  setMaxRounds(n: number): void {
    this.emit({ maxRounds: Math.max(1, Math.min(20, Math.round(n) || 1)) });
  }

  /** Stop everything in flight (rounds + report) without discarding the session. */
  stop(): void {
    this.cancelled = true;
    for (const id of this.inflight) void this.client.cancel(id);
    this.inflight.clear();
    const s = this.state.session;
    this.emit({ auto: false, session: s ? { ...s, busy: false } : null });
  }

  /** Discard the live discussion (roster + saved plans are kept). */
  reset(): void {
    this.stop();
    this.emit({ session: null });
  }

  /** Turn the current report into an ExecutionPlan object (not yet persisted). */
  buildPlan(title: string): ExecutionPlan | null {
    const s = this.state.session;
    if (!s || !s.report) return null;
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      title: title.trim() || s.request.slice(0, 60) || "Execution Plan",
      markdown: s.report,
      request: s.request,
      createdAt: now,
      updatedAt: now,
    };
  }
}

export const strategyStore = new StrategyStore();

export function useStrategy(): StrategyState {
  return useSyncExternalStore(strategyStore.subscribe, strategyStore.getSnapshot);
}
