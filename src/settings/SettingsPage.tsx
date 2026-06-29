import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CLAUDE_MODELS,
  modelsFor,
  settingsStore,
  useSettings,
  type AutoCleanMode,
  type DefaultShell,
  type Profile,
  type SttEngine,
  type TraceSpeed,
} from "./settingsStore";
import { PROVIDERS, type AgentProvider } from "../agents/providers";
import { vacuumDb, type VacuumResult } from "../util/db";

type TabId = "ai" | "workspace" | "appearance" | "system";
const TABS: { id: TabId; label: string }[] = [
  { id: "ai", label: "👤 Profiles & AI" },
  { id: "workspace", label: "🌿 Workspace & Git" },
  { id: "appearance", label: "🎨 Appearance" },
  { id: "system", label: "🗄️ System & Database" },
];

/** Monospace fonts offered for the terminal/feed ("" = the app's theme default). */
const FONTS: { label: string; value: string }[] = [
  { label: "Theme default", value: "" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Cascadia Code", value: "Cascadia Code" },
  { label: "Fira Code", value: "Fira Code" },
  { label: "Consolas", value: "Consolas" },
  { label: "IBM Plex Mono", value: "IBM Plex Mono" },
];

/**
 * Full-page application settings, organised into tabs: the per-surface AI
 * defaults & profiles, the Git/worktree automation, the look & feel, and storage
 * maintenance. Everything reads/writes the shared {@link settingsStore}.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>("ai");

  return (
    <div className="flex h-full flex-col bg-well text-gray-100">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-100">Settings</h1>
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm text-muted transition-colors hover:bg-edge hover:text-gray-200"
        >
          ✕ Κλείσιμο
        </button>
      </div>

      <div className="flex flex-1 gap-2 overflow-hidden px-2 pb-2">
        {/* Vertical tab rail — its own panel. */}
        <nav className="flex w-52 shrink-0 flex-col gap-1 rounded-xl border border-edge bg-panel p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                tab === t.id
                  ? "bg-edge text-accent"
                  : "text-muted hover:bg-edge/50 hover:text-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content — one panel; sections are nested cards inside it. */}
        <div className="flex-1 overflow-y-auto rounded-xl border border-edge bg-panel p-4">
          <div className="mx-auto max-w-2xl space-y-3">
            {tab === "ai" && <AiTab />}
            {tab === "workspace" && <WorkspaceTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "system" && <SystemTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Profiles & AI
// ---------------------------------------------------------------------------
function AiTab() {
  const { profiles, agent, orchestrator, globalRules, spendLimitUsd } = useSettings();

  const addProfile = async () => {
    const dir = await open({ directory: true, title: "Διάλεξε φάκελο profile (CLAUDE_CONFIG_DIR)" });
    if (typeof dir !== "string") return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || "profile";
    settingsStore.addProfile(name, dir);
  };

  return (
    <>
      <Section title="Claude Code Profiles" desc="Λογαριασμοί (CLAUDE_CONFIG_DIR) — κοινοί για agents και orchestrator.">
        <div className="space-y-1.5">
          {profiles.length === 0 && (
            <p className="text-xs text-muted">Κανένα profile ακόμα — πρόσθεσε τον φάκελο ενός λογαριασμού.</p>
          )}
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded border border-edge px-2 py-1.5 text-sm">
              <span className="font-medium">{p.name}</span>
              <span className="flex-1 truncate text-xs text-muted">{p.configDir}</span>
              <button
                onClick={() => settingsStore.removeProfile(p.id)}
                title="Διαγραφή"
                className="text-muted hover:text-red-300"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => void addProfile()}
            className="rounded bg-accent/20 px-3 py-1.5 text-sm text-accent hover:bg-accent/30"
          >
            + Πρόσθεσε profile…
          </button>
        </div>
      </Section>

      <Section title="Agents — default" desc="Με τι ξεκινούν οι νέοι agents (ισχύει για νέα sessions).">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Provider">
            <Select
              value={agent.provider}
              onChange={(v) => settingsStore.setAgentDefaults({ provider: v as AgentProvider })}
              options={PROVIDERS.map((p) => ({ label: p.label, value: p.value }))}
            />
          </Field>
          <Field label="Model">
            <ModelSelect value={agent.model} onChange={(v) => settingsStore.setAgentDefaults({ model: v })} />
          </Field>
          <Field label="Profile">
            <ProfileSelect
              profiles={profiles}
              value={agent.profileId}
              onChange={(v) => settingsStore.setAgentDefaults({ profileId: v })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Orchestrator — default" desc="Με τι τρέχει ο Workspace Assistant.">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Provider">
            <Select
              value={orchestrator.provider}
              onChange={(v) =>
                // Reset the model: a claude alias ("opus") is meaningless to gemini
                // and vice-versa, so fall back to each provider's "Default".
                settingsStore.setOrchestratorDefaults({ provider: v as AgentProvider, model: null })
              }
              options={PROVIDERS.map((p) => ({ label: p.label, value: p.value }))}
            />
          </Field>
          <Field label="Model">
            <ModelSelect
              provider={orchestrator.provider}
              value={orchestrator.model}
              onChange={(v) => settingsStore.setOrchestratorDefaults({ model: v })}
            />
          </Field>
          {orchestrator.provider === "claude" ? (
            <Field label="Profile">
              <ProfileSelect
                profiles={profiles}
                value={orchestrator.profileId}
                onChange={(v) => settingsStore.setOrchestratorDefaults({ profileId: v })}
              />
            </Field>
          ) : (
            <Field label="Profile">
              <p className="px-1 pt-1.5 text-xs text-muted">
                Τα profiles ισχύουν μόνο στο Claude.
              </p>
            </Field>
          )}
        </div>
      </Section>

      <Section
        title="Global rules (system prompt)"
        desc="Κανόνες που προστίθενται στις οδηγίες ΚΑΘΕ agent και του orchestrator — π.χ. «Γράφε μόνο TypeScript με strict types»."
      >
        <textarea
          value={globalRules}
          onChange={(e) => settingsStore.setGlobalRules(e.target.value)}
          placeholder={"- Ακολούθησε τα linting rules του project\n- Μην προσθέτεις dependencies χωρίς λόγο"}
          className="min-h-[120px] w-full resize-y rounded border border-edge bg-well px-2 py-1.5 text-sm leading-relaxed text-gray-100 outline-none focus:border-accent"
        />
      </Section>

      <Section
        title="Token spend limit (safety brake)"
        desc="Όριο κόστους ($) ανά session. Όταν ξεπεραστεί, το OctoShell σταματά orchestrator + agents. Ισχύει μόνο σε λογαριασμό με χρέωση per-token (API key)· σε subscription το κόστος δεν αναφέρεται."
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={spendLimitUsd != null}
            onChange={(on) => settingsStore.setSpendLimit(on ? 5 : null)}
            label={spendLimitUsd != null ? "Ενεργό" : "Ανενεργό"}
          />
          {spendLimitUsd != null && (
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={spendLimitUsd}
                onChange={(e) => settingsStore.setSpendLimit(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
              />
              <span className="text-sm text-muted">/ session</span>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Workspace & Git
// ---------------------------------------------------------------------------
function WorkspaceTab() {
  const { workspace } = useSettings();
  const set = (patch: Parameters<typeof settingsStore.setWorkspace>[0]) => settingsStore.setWorkspace(patch);

  return (
    <>
      <Section title="Worktrees" desc="Πώς ο orchestrator απομονώνει και καθαρίζει τη δουλειά.">
        <div className="space-y-3">
          <ToggleRow
            label="Ο orchestrator φτιάχνει worktrees"
            desc="Κάθε task τρέχει σε δικό του git worktree (απομονωμένα/παράλληλα) αντί στον agent του ίδιου του project."
            checked={workspace.orchestratorWorktrees}
            onChange={(v) => set({ orchestratorWorktrees: v })}
          />
          <ToggleRow
            label="Auto-copy .env* στα νέα worktrees"
            desc="Αντιγράφει .env / .env.local κ.λπ. (untracked secrets) ώστε η εφαρμογή να τρέχει μέσα στο worktree."
            checked={workspace.copyEnv}
            onChange={(v) => set({ copyEnv: v })}
          />
          <Field label="Auto-clean — πότε διαγράφεται ένα worktree">
            <Select
              value={workspace.autoClean}
              onChange={(v) => set({ autoClean: v as AutoCleanMode })}
              options={[
                { label: "Ποτέ (χειροκίνητα)", value: "off" },
                { label: "Μετά το review approve", value: "onApprove" },
                { label: "Μετά το merge/close του PR", value: "onMerge" },
              ]}
            />
          </Field>
          <Field label="Base branch για νέα worktrees">
            <input
              value={workspace.baseBranch}
              onChange={(e) => set({ baseBranch: e.target.value })}
              placeholder="(default: HEAD του κύριου worktree, π.χ. main/dev)"
              className="rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
            />
          </Field>
        </div>
      </Section>

      <Section title="Terminal" desc="Τι shell σηκώνει το native PTY.">
        <Field label="Default shell">
          <Select
            value={workspace.defaultShell}
            onChange={(v) => set({ defaultShell: v as DefaultShell })}
            options={[
              { label: "PowerShell (pwsh)", value: "powershell" },
              { label: "CMD", value: "cmd" },
              { label: "WSL / Ubuntu", value: "wsl" },
            ]}
          />
        </Field>
        {workspace.defaultShell !== "powershell" && (
          <p className="mt-2 text-xs text-amber-300/80">
            ⚠️ Τα per-command blocks & exit codes είναι φτιαγμένα για PowerShell. Σε CMD/WSL ο terminal δουλεύει, αλλά
            χωρίς τη σημασιολογική ανάλυση εντολών. Ισχύει στα ΝΕΑ terminals.
          </p>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — Appearance
// ---------------------------------------------------------------------------
function AppearanceTab() {
  const { appearance, sttEngine } = useSettings();
  const set = (patch: Parameters<typeof settingsStore.setAppearance>[0]) => settingsStore.setAppearance(patch);

  return (
    <>
      <Section title="Typography" desc="Γραμματοσειρά για terminal & feed (πρέπει να είναι εγκατεστημένη στο σύστημα).">
        <Field label="Font">
          <Select value={appearance.fontFamily} onChange={(v) => set({ fontFamily: v })} options={FONTS} />
        </Field>
      </Section>

      <Section title="PCB trace animation" desc="Πόσο γρήγορα «ρέουν» τα traces του circuit board όταν δουλεύουν agents.">
        <Field label="Ταχύτητα">
          <Select
            value={appearance.traceSpeed}
            onChange={(v) => set({ traceSpeed: v as TraceSpeed })}
            options={[
              { label: "Fast", value: "fast" },
              { label: "Normal", value: "normal" },
              { label: "Stealth (αργό)", value: "stealth" },
              { label: "Static (καθόλου)", value: "static" },
            ]}
          />
        </Field>
      </Section>

      <Section title="Sound effects" desc="Subtle ρετρό sci-fi ήχοι όταν ολοκληρώνεται ένα task ή σκάει error.">
        <ToggleRow
          label="SFX"
          desc="Ένα διακριτικό beep στην ολοκλήρωση / σφάλμα ενός agent."
          checked={appearance.sfx}
          onChange={(v) => set({ sfx: v })}
        />
      </Section>

      <Section
        title="Speech-to-text (υπαγόρευση)"
        desc="Το 🎤 κουμπί στο input. Το «Web» χρησιμοποιεί τη δωρεάν μηχανή φωνής του browser. Το Whisper (τοπικό/API) έρχεται σύντομα."
      >
        <Field label="Engine">
          <Select
            value={sttEngine}
            onChange={(v) => settingsStore.setSttEngine(v as SttEngine)}
            options={[
              { label: "Web (δωρεάν)", value: "web" },
              { label: "Whisper (σύντομα)", value: "whisper" },
            ]}
          />
        </Field>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — System & Database
// ---------------------------------------------------------------------------
function SystemTab() {
  const { system } = useSettings();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VacuumResult | null>(null);

  const runVacuum = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await vacuumDb());
    } finally {
      setBusy(false);
    }
  };

  const fmtKB = (n: number) => `${(n / 1024).toFixed(0)} KB`;

  return (
    <>
      <Section title="Scrollback buffer" desc="Πόσες γραμμές terminal output κρατά στη μνήμη κάθε terminal (μεγαλύτερο = περισσότερη ιστορία, λίγη παραπάνω RAM). Ισχύει στα νέα terminals.">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={200}
            max={50000}
            step={500}
            value={system.scrollback}
            onChange={(e) =>
              settingsStore.setSystem({ scrollback: Math.max(200, Math.min(50000, Number(e.target.value) || 1000)) })
            }
            className="w-32 rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
          />
          <span className="text-sm text-muted">γραμμές</span>
        </div>
      </Section>

      <Section
        title="Compact database (Vacuum)"
        desc="Συμπιέζει τα αποθηκευμένα ιστορικά — κόβει τα βαριά ενδιάμεσα tool-output streams των agents κρατώντας την ουσία — και ανακτά χώρο στη βάση."
      >
        <button
          onClick={() => void runVacuum()}
          disabled={busy}
          className="rounded bg-accent/20 px-3 py-1.5 text-sm text-accent hover:bg-accent/30 disabled:opacity-60"
        >
          {busy ? "Συμπίεση…" : "🧹 Compact τώρα"}
        </button>
        {result && (
          <p className="mt-2 text-xs text-muted">
            {result.sessions} sessions · {result.trimmed} tool-outputs συμπιέστηκαν ·{" "}
            {fmtKB(result.before)} → <span className="text-emerald-300/90">{fmtKB(result.after)}</span>
          </p>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
      <p className="mb-3 text-xs text-muted">{desc}</p>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-edge bg-well px-2 py-1.5 text-sm text-gray-100 outline-none focus:border-accent"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Model picker mapping the null "Default" to a "" sentinel for the native select.
 *  The option list follows the provider (claude aliases vs gemini models). */
function ModelSelect({
  value,
  onChange,
  provider = "claude",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  provider?: AgentProvider;
}) {
  const models = provider === "claude" ? CLAUDE_MODELS : modelsFor(provider);
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={models.map((m) => ({ label: m.label, value: m.value ?? "" }))}
    />
  );
}

/** Profile picker; "" = home default (no CLAUDE_CONFIG_DIR override). */
function ProfileSelect({
  profiles,
  value,
  onChange,
}: {
  profiles: Profile[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[{ label: "Default (home)", value: "" }, ...profiles.map((p) => ({ label: p.name, value: p.id }))]}
    />
  );
}

/** A small pill toggle. */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs ${
        checked ? "border-accent/50 bg-accent/20 text-accent" : "border-edge text-muted hover:bg-edge/50"
      }`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${checked ? "bg-accent" : "bg-edge"}`} />
      {label}
    </button>
  );
}

/** A labelled toggle row with a description. */
function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-edge px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm text-gray-100">{label}</div>
        <div className="text-xs text-muted">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={checked ? "On" : "Off"} />
    </div>
  );
}
