import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShellController } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";

/**
 * One stateful button that walks a branch through its PR lifecycle:
 *
 *   Create PR → Check PR → (changes requested?) Update PR → Check PR → … → Done
 *
 * - **Create**: push the branch + `gh pr create --fill`.
 * - **Check**: `gh pr view` → merged/closed ⇒ Done · CHANGES_REQUESTED ⇒ Update.
 * - **Update**: feed the review comments to the project's agent to fix + push,
 *   then return to Check. Loops until the PR merges/closes (or the branch changes).
 *
 * State (PR number + phase) is kept per branch and persisted, so it survives
 * restarts and follows you as you switch branches. Needs the `gh` CLI (authed).
 */
type Phase = "create" | "check" | "update" | "done";
type PrMap = Record<string, { pr: number; phase: Phase }>;

interface GhPr {
  number: number;
  state: string; // OPEN | MERGED | CLOSED
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
}

async function cap(cwd: string, command: string): Promise<string> {
  return (await invoke<string>("run_capture", { cwd, command })).trim();
}

async function queryPr(cwd: string): Promise<GhPr | null> {
  try {
    const out = await cap(cwd, "gh pr view --json number,state,reviewDecision 2>$null");
    return out ? (JSON.parse(out) as GhPr) : null;
  } catch {
    return null;
  }
}

export function SmartPrButton({ controller }: { controller: ShellController }) {
  const cwd = controller.getCwd();
  const id = controller.sessionId;
  const [branch, setBranch] = useState("");
  const [map, setMap] = useState<PrMap>(() => loadJSON<PrMap>(KEY.pr(id), {}));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { saveJSON(KEY.pr(id), map); }, [id, map]);

  const refreshBranch = useCallback(async () => {
    if (!cwd) { setBranch(""); return; }
    try {
      setBranch(await cap(cwd, "git rev-parse --abbrev-ref HEAD 2>$null"));
    } catch {
      setBranch("");
    }
  }, [cwd]);
  useEffect(() => { void refreshBranch(); }, [refreshBranch]);

  if (!cwd || !branch) return null; // only for git projects

  const entry = map[branch];
  const phase: Phase = entry?.phase ?? "create";
  const setPhase = (p: Phase, pr?: number) =>
    setMap((m) => ({ ...m, [branch]: { pr: pr ?? entry?.pr ?? 0, phase: p } }));
  const flash = (t: string) => { setMsg(t); window.setTimeout(() => setMsg(""), 4000); };

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { flash(String(e)); } finally { setBusy(false); }
  };

  const doCreate = run(async () => {
    await cap(cwd, `git push -u origin ${branch} 2>&1`);
    let pr = await queryPr(cwd);
    if (!pr) { await cap(cwd, "gh pr create --fill 2>&1"); pr = await queryPr(cwd); }
    if (pr) { setPhase("check", pr.number); flash(`PR #${pr.number} έτοιμο`); }
    else flash("Δεν δημιουργήθηκε PR — δες το terminal");
  });

  const doCheck = run(async () => {
    const pr = await queryPr(cwd);
    if (!pr) { setPhase("create"); flash("Δεν υπάρχει PR για το branch"); return; }
    if (pr.state === "MERGED" || pr.state === "CLOSED") { setPhase("done", pr.number); flash(pr.state); }
    else if (pr.reviewDecision === "CHANGES_REQUESTED") { setPhase("update", pr.number); flash("Ζητήθηκαν αλλαγές"); }
    else flash(pr.reviewDecision === "APPROVED" ? "Approved ✓ — έτοιμο για merge" : "Καμία αλλαγή ακόμα");
  });

  const doUpdate = run(async () => {
    const n = entry!.pr;
    const comments = await cap(cwd, `gh pr view ${n} --comments 2>&1`);
    controller.runAgent(
      `Στο PR #${n} ζητήθηκαν αλλαγές (changes requested). Διάβασε τα παρακάτω review comments, ` +
        `κάνε τις απαραίτητες διορθώσεις στον κώδικα, και μετά commit + push στο ίδιο branch.\n\n${comments}`,
    );
    setPhase("check", n);
    flash("Στάλθηκε στον agent → μετά πάτα Check");
  });

  const doDone = () => setMap((m) => { const c = { ...m }; delete c[branch]; return c; });

  const cfg: Record<Phase, { label: string; onClick: () => void; cls: string }> = {
    create: { label: "🚀 Create PR", onClick: doCreate, cls: "bg-edge/70 hover:bg-accent/30" },
    check: { label: `🔍 Check PR #${entry?.pr ?? ""}`, onClick: doCheck, cls: "bg-edge/70 hover:bg-accent/30" },
    update: {
      label: `🔧 Update PR #${entry?.pr ?? ""}`,
      onClick: doUpdate,
      cls: "border border-accent/60 bg-accent/25 hover:bg-accent/30 text-gray-100",
    },
    done: { label: `✅ Merged #${entry?.pr ?? ""}`, onClick: doDone, cls: "bg-edge/70 hover:bg-accent/30" },
  };
  const c = cfg[phase];

  return (
    <div className="flex items-center gap-1.5">
      {msg && (
        <span className="truncate text-[11px] text-muted" style={{ maxWidth: 180 }} title={msg}>
          {msg}
        </span>
      )}
      <button
        onClick={c.onClick}
        disabled={busy}
        title="Smart PR: Create → Check → Update (ο agent λύνει τα reviews) → loop μέχρι merge"
        className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs disabled:opacity-50 ${c.cls}`}
      >
        {busy ? "…" : c.label}
      </button>
    </div>
  );
}
