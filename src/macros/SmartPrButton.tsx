import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShellController } from "../shell/ShellController";
import { KEY, loadJSON, saveJSON } from "../util/persist";

/**
 * One stateful button that walks a branch through its PR lifecycle:
 *
 *   Create → Check → Resolve → Update → Check → … → Done
 *
 * - **Create**: push the branch + `gh pr create --fill`.
 * - **Check**: `gh pr view` → merged/closed ⇒ Done · new review feedback ⇒ Resolve.
 * - **Resolve**: feed the review comments to the agent to fix + commit (NO push),
 *   so you can review the agent's changes before they go up.
 * - **Update**: push the reviewed fixes, then return to Check. Loops until merge.
 *
 * State (PR number + phase) is kept per branch and persisted, so it survives
 * restarts and follows you as you switch branches. Needs the `gh` CLI (authed).
 */
type Phase = "create" | "check" | "resolve" | "update" | "done";
// `seen` = number of reviews/comments already handled, so re-checking doesn't
// re-trigger Update for feedback the agent already addressed.
type PrMap = Record<string, { pr: number; phase: Phase; seen: number }>;

interface GhPr {
  number: number;
  state: string; // OPEN | MERGED | CLOSED
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  /** Total reviews + issue comments — our "is there new feedback?" signal. */
  feedback: number;
}

async function cap(cwd: string, command: string): Promise<string> {
  return (await invoke<string>("run_capture", { cwd, command })).trim();
}

async function queryPr(cwd: string): Promise<GhPr | null> {
  try {
    const out = await cap(cwd, "gh pr view --json number,state,reviewDecision,reviews,comments 2>$null");
    if (!out) return null;
    const j = JSON.parse(out);
    return {
      number: j.number,
      state: j.state,
      reviewDecision: j.reviewDecision ?? null,
      feedback: (j.reviews?.length ?? 0) + (j.comments?.length ?? 0),
    };
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

  // Read the latest map without making refreshBranch depend on it.
  const mapRef = useRef(map);
  useEffect(() => { mapRef.current = map; }, [map]);

  // Detect the current branch and, the first time we see a branch, derive its
  // state from GitHub: an open PR ⇒ start at "check", otherwise "create".
  const refreshBranch = useCallback(async () => {
    if (!cwd) { setBranch(""); return; }
    let b = "";
    try {
      b = await cap(cwd, "git rev-parse --abbrev-ref HEAD 2>$null");
    } catch {
      setBranch("");
      return;
    }
    setBranch(b);
    if (b && !mapRef.current[b]) {
      const pr = await queryPr(cwd); // queries the current branch's PR
      if (pr && pr.state === "OPEN") {
        setMap((m) => (m[b] ? m : { ...m, [b]: { pr: pr.number, phase: "check", seen: 0 } }));
      }
    }
  }, [cwd]);
  useEffect(() => { void refreshBranch(); }, [refreshBranch]);

  // Re-detect the branch after a shell command finishes (catches `git checkout`)
  // and when the window regains focus (branch changed outside the app).
  useEffect(() => {
    let prevBusy = false;
    const recheck = () => void refreshBranch();
    const unsub = controller.subscribe(() => {
      const s = controller.getSnapshot();
      if (prevBusy && !s.busy) recheck();
      prevBusy = s.busy;
    });
    window.addEventListener("focus", recheck);
    return () => { unsub(); window.removeEventListener("focus", recheck); };
  }, [controller, refreshBranch]);

  if (!cwd || !branch) return null; // only for git projects

  const entry = map[branch];
  const phase: Phase = entry?.phase ?? "create";
  const setEntry = (p: Phase, pr?: number, seen?: number) =>
    setMap((m) => ({
      ...m,
      [branch]: { pr: pr ?? entry?.pr ?? 0, phase: p, seen: seen ?? entry?.seen ?? 0 },
    }));
  const flash = (t: string) => { setMsg(t); window.setTimeout(() => setMsg(""), 4000); };

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { flash(String(e)); } finally { setBusy(false); }
  };

  const doCreate = run(async () => {
    await cap(cwd, `git push -u origin ${branch} 2>&1`);
    let pr = await queryPr(cwd);
    if (!pr) { await cap(cwd, "gh pr create --fill 2>&1"); pr = await queryPr(cwd); }
    // seen=0 so any feedback already on the PR (e.g. when adopting an existing
    // one) shows up as actionable on the next Check.
    if (pr) { setEntry("check", pr.number, 0); flash(`PR #${pr.number} έτοιμο`); }
    else flash("Δεν δημιουργήθηκε PR — δες το terminal");
  });

  const doCheck = run(async () => {
    const pr = await queryPr(cwd);
    if (!pr) { setEntry("create"); flash("Δεν υπάρχει PR για το branch"); return; }
    if (pr.state === "MERGED" || pr.state === "CLOSED") { setEntry("done", pr.number); flash(pr.state); return; }
    // New feedback (formal CHANGES_REQUESTED, or any review/comment we haven't
    // handled yet — needed since you can't request-changes on your own PR).
    const hasNew = pr.reviewDecision === "CHANGES_REQUESTED" || pr.feedback > (entry?.seen ?? 0);
    if (hasNew) { setEntry("resolve", pr.number); flash("Νέα σχόλια — πάτα Resolve"); }
    else flash(pr.reviewDecision === "APPROVED" ? "Approved ✓ — έτοιμο για merge" : "Κανένα νέο σχόλιο");
  });

  // Resolve: the agent reads the review comments and fixes the code + commits,
  // but does NOT push — so you can review the changes before they go up.
  const doResolve = run(async () => {
    const n = entry!.pr;
    const comments = await cap(cwd, `gh pr view ${n} --comments 2>&1`);
    const pr = await queryPr(cwd);
    controller.runAgent(
      `Στο PR #${n} ζητήθηκαν αλλαγές. Διάβασε τα παρακάτω review comments, ` +
        `κάνε τις απαραίτητες διορθώσεις στον κώδικα και κάνε **commit**. ` +
        `ΜΗΝ κάνεις push — θα γίνει χειροκίνητα μετά από review.\n\n${comments}`,
    );
    // Mark this feedback as handled so the loop converges after the push.
    setEntry("update", n, pr?.feedback ?? entry?.seen ?? 0);
    flash("Στάλθηκε στον agent → δες τις αλλαγές, μετά Update");
  });

  // Update: push the agent's (reviewed) fixes, then back to Check.
  const doUpdate = run(async () => {
    const n = entry!.pr;
    await cap(cwd, `git push origin ${branch} 2>&1`);
    setEntry("check", n);
    flash("Έγινε push → πάτα Check");
  });

  const doDone = () => setMap((m) => { const c = { ...m }; delete c[branch]; return c; });

  const n = entry?.pr ?? "";
  const highlight = "border border-accent/60 bg-accent/25 hover:bg-accent/30 text-gray-100";
  const plain = "bg-edge/70 hover:bg-accent/30";
  const cfg: Record<Phase, { label: string; onClick: () => void; cls: string }> = {
    create: { label: "🚀 Create PR", onClick: doCreate, cls: plain },
    check: { label: `🔍 Check PR #${n}`, onClick: doCheck, cls: plain },
    resolve: { label: `🤖 Resolve changes #${n}`, onClick: doResolve, cls: highlight },
    update: { label: `⬆️ Update PR #${n}`, onClick: doUpdate, cls: highlight },
    done: { label: `✅ Merged #${n}`, onClick: doDone, cls: plain },
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
        title="Smart PR: Create → Check → Resolve (ο agent φτιάχνει + commit) → Update (push) → loop μέχρι merge"
        className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs disabled:opacity-70 ${c.cls}`}
      >
        <span className="inline-flex items-center gap-1.5">
          {busy && <span className="octo-spinner" aria-hidden />}
          {c.label}
        </span>
      </button>
    </div>
  );
}
