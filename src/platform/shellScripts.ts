// Every one-shot script OctoShell runs through `run_capture`, written for BOTH
// script shells: PowerShell on Windows, POSIX `sh` on macOS/Linux.
//
// `run_capture` (pty.rs) hands the script to whichever shell the platform has,
// so a caller asks for e.g. `createWorktreeScript(...)` and never sees a shell.
// Keeping the two dialects side by side in one file is deliberate: a change to
// what a script DOES is made in both at once, and a reviewer can read the
// PowerShell and the sh version of the same intent next to each other.
//
// The PowerShell strings are the originals, moved here verbatim.

import { isWindows, platform } from "./platform";

/** Single-quote a value for POSIX sh: safe for any characters, including `$`,
 *  spaces and quotes. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pick the dialect for this host. */
function pick(ps: string, sh: string): string {
  return isWindows() ? ps : sh;
}

// ───────────────────────────── git status / branch ─────────────────────────────

/** One-shot probe: "<branch>|<git diff --shortstat HEAD>". Empty branch ⇒ not a repo. */
export function gitProbeScript(): string {
  return pick(
    "\"$(git rev-parse --abbrev-ref HEAD 2>$null)|$(git diff --shortstat HEAD 2>$null)\"",
    `printf '%s|%s' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git diff --shortstat HEAD 2>/dev/null)"`,
  );
}

/** The current branch name (empty when not a repo). */
export function currentBranchScript(): string {
  return pick("git rev-parse --abbrev-ref HEAD 2>$null", "git rev-parse --abbrev-ref HEAD 2>/dev/null");
}

/** `git status` + a diff stat, for the Smart Commit macro. */
export function gitStatusAndDiffScript(): string {
  // Shell-neutral: `;` separates commands in both dialects.
  return "git status --porcelain=v1; git diff --stat HEAD";
}

/** "BRANCH: …\nHEAD: <hash> <subject>" — the review agent's pointer to the change. */
export function reviewOverviewScript(): string {
  return pick(
    '"BRANCH: " + (git rev-parse --abbrev-ref HEAD 2>$null);' +
      '"HEAD: " + (git log -1 --format=\'%h %s\' 2>$null)',
    `printf 'BRANCH: %s\\nHEAD: %s' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git log -1 --format='%h %s' 2>/dev/null)"`,
  );
}

// ───────────────────────────── worktrees ─────────────────────────────

/** `git worktree list --porcelain` (stderr folded in). Identical in both shells. */
export function listWorktreesScript(): string {
  return "git worktree list --porcelain 2>&1";
}

/** Resolve the MAIN worktree, ignore the managed folder locally, create the
 *  worktree + branch, and print its path (or `ERR:…`) as the LAST line. One
 *  round-trip.
 *
 *  The folder can exist WITHOUT being a registered worktree: `git worktree
 *  remove` deregisters first, and (on Windows especially) the delete then fails
 *  whenever anything still holds the directory (a shell sitting in it,
 *  node_modules). That orphan folder made every later `worktree add` fail with
 *  "already exists" — the branch was fine, the directory was just in the way.
 *  So: registered → reuse it as-is; orphaned → `worktree repair` first (it may
 *  hold uncommitted work), and only if that fails delete it and recreate. */
export function createWorktreeScript(opts: { dirName: string; branchName: string; baseBranch: string }): string {
  const { dirName, branchName, baseBranch } = opts;
  if (isWindows()) {
    const baseArg = baseBranch ? ` "${baseBranch}"` : "";
    return (
      "$main=(git worktree list --porcelain|Where-Object{$_ -like 'worktree *'}|Select-Object -First 1);" +
      "if(-not $main){Write-Output 'ERR:not a git repo';return};" +
      "$main=($main.Substring(9).Trim() -replace '\\\\','/');" +
      `$wt="$main/.octoshell/worktrees/${dirName}";` +
      "$excl=\"$main/.git/info/exclude\";" +
      "if((Test-Path $excl) -and -not (Select-String -Path $excl -Pattern 'octoshell' -Quiet)){Add-Content -Path $excl -Value '.octoshell/'};" +
      // Pick up commits pushed elsewhere, so a worktree we (re)create starts from
      // the real branch tip rather than a stale local ref. Read-only; never fails
      // the create (offline is fine).
      "git -C \"$main\" fetch --all --quiet 2>&1 | Out-Null;" +
      // Clear registrations whose folder is gone, so `worktree add` isn't blocked
      // by a ghost entry.
      "git -C \"$main\" worktree prune 2>&1 | Out-Null;" +
      "$reg=(git -C \"$main\" worktree list --porcelain) -join \"`n\";" +
      "if(Test-Path $wt){" +
      "  $known=($reg -match [regex]::Escape($wt)) -or ($reg -match [regex]::Escape(($wt -replace '/','\\')));" +
      "  if($known){Write-Output $wt;return};" +
      "  git -C \"$main\" worktree repair \"$wt\" 2>&1 | Out-Null;" +
      "  $reg2=(git -C \"$main\" worktree list --porcelain) -join \"`n\";" +
      "  if(($reg2 -match [regex]::Escape($wt)) -or ($reg2 -match [regex]::Escape(($wt -replace '/','\\')))){Write-Output $wt;return};" +
      "  Remove-Item -LiteralPath $wt -Recurse -Force -ErrorAction SilentlyContinue;" +
      "  if(Test-Path $wt){Write-Output ('ERR:a leftover folder for this worktree could not be deleted (' + $wt + ') - close any shell or editor open in it, then retry');return}" +
      "};" +
      `$r=git -C "$main" worktree add -b "${branchName}" "$wt"${baseArg} 2>&1;` +
      `if($LASTEXITCODE -ne 0){$r=git -C "$main" worktree add "$wt" "${branchName}" 2>&1};` +
      "if($LASTEXITCODE -ne 0){Write-Output ('ERR:'+($r -join ' '))}else{Write-Output $wt}"
    );
  }
  const baseArg = baseBranch ? ` ${shq(baseBranch)}` : "";
  return [
    `main=$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n 1)`,
    `[ -n "$main" ] || { echo 'ERR:not a git repo'; exit 0; }`,
    `wt="$main/.octoshell/worktrees/${dirName}"`,
    `excl="$main/.git/info/exclude"`,
    `if [ -f "$excl" ] && ! grep -q octoshell "$excl"; then echo '.octoshell/' >> "$excl"; fi`,
    `git -C "$main" fetch --all --quiet >/dev/null 2>&1`,
    `git -C "$main" worktree prune >/dev/null 2>&1`,
    `reg=$(git -C "$main" worktree list --porcelain)`,
    `if [ -e "$wt" ]; then`,
    `  case "$reg" in *"$wt"*) echo "$wt"; exit 0;; esac`,
    `  git -C "$main" worktree repair "$wt" >/dev/null 2>&1`,
    `  reg2=$(git -C "$main" worktree list --porcelain)`,
    `  case "$reg2" in *"$wt"*) echo "$wt"; exit 0;; esac`,
    `  rm -rf "$wt" 2>/dev/null`,
    `  if [ -e "$wt" ]; then echo "ERR:a leftover folder for this worktree could not be deleted ($wt) - close any shell or editor open in it, then retry"; exit 0; fi`,
    `fi`,
    `r=$(git -C "$main" worktree add -b ${shq(branchName)} "$wt"${baseArg} 2>&1) || ` +
      `r=$(git -C "$main" worktree add "$wt" ${shq(branchName)} 2>&1) || ` +
      `{ echo "ERR:$(printf '%s' "$r" | tr '\\n' ' ')"; exit 0; }`,
    `echo "$wt"`,
  ].join("\n");
}

/** Copy untracked/gitignored root-level `.env*` from the base checkout into the
 *  new worktree (`git worktree add` only materialises TRACKED files). Run in the
 *  base repo. Best-effort. */
export function copyEnvFilesScript(wtPath: string): string {
  return pick(
    "Get-ChildItem -Path . -Filter '.env*' -File -Force | " +
      `ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path '${wtPath}' $_.Name) -Force }`,
    `for f in .env*; do [ -f "$f" ] && cp -f "$f" ${shq(wtPath)}/"$f"; done; true`,
  );
}

/** Copy the base repo's installed dependency dirs into the worktree — a git
 *  worktree never inherits them. Only relocatable dep dirs (node_modules, PHP/Go
 *  vendor, legacy bower); language dirs that bake absolute paths (Python venvs)
 *  are left for their own tooling. Windows: robocopy (multithreaded). macOS:
 *  `cp -c` clones with APFS copy-on-write, so a huge node_modules lands in
 *  milliseconds and costs no disk until files diverge. Linux: reflink where the
 *  filesystem supports it. Run in the base repo. Best-effort. */
export function copyDependencyDirsScript(wtPath: string): string {
  if (isWindows()) {
    return (
      `$wt='${wtPath}';` +
      "foreach($d in 'node_modules','vendor','bower_components'){" +
      "$s=Join-Path '.' $d; $t=Join-Path $wt $d;" +
      "if((Test-Path $s) -and -not (Test-Path $t)){" +
      "robocopy $s $t /E /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null}}"
    );
  }
  const cp = platform().os === "macos" ? "cp -Rc" : "cp -R --reflink=auto";
  return (
    `wt=${shq(wtPath)}; for d in node_modules vendor bower_components; do ` +
    `if [ -e "$d" ] && [ ! -e "$wt/$d" ]; then ${cp} "$d" "$wt/$d" 2>/dev/null || cp -R "$d" "$wt/$d"; fi; done; true`
  );
}

/** Remove a worktree from git AND sweep its folder. `worktree remove`
 *  deregisters BEFORE deleting, so a lingering handle (a just-closed pty, an
 *  editor, an antivirus scan of node_modules) can leave the folder behind while
 *  git already considers it gone — which then blocks every future `worktree
 *  add` on the same branch. Run in the repo root. */
export function removeWorktreeScript(wtPath: string): string {
  return pick(
    `git worktree remove "${wtPath}" --force 2>&1 | Out-Null;` +
      `if(Test-Path "${wtPath}"){Remove-Item -LiteralPath "${wtPath}" -Recurse -Force -ErrorAction SilentlyContinue};` +
      "git worktree prune 2>&1",
    `git worktree remove ${shq(wtPath)} --force >/dev/null 2>&1; ` +
      `[ -e ${shq(wtPath)} ] && rm -rf ${shq(wtPath)}; ` +
      "git worktree prune 2>&1; true",
  );
}

// ───────────────────────────── GitHub (gh) ─────────────────────────────

/** The state (OPEN/MERGED/CLOSED) of the current branch's PR, or nothing. */
export function branchPrStateScript(): string {
  return pick(
    "$b=git branch --show-current; if($b){gh pr view $b --json state -q .state 2>$null}",
    `b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && gh pr view "$b" --json state -q .state 2>/dev/null; true`,
  );
}

/** The current branch's PR as JSON (number, state, reviewDecision, reviews, comments). */
export function prViewJsonScript(): string {
  const fields = "number,state,reviewDecision,reviews,comments";
  return pick(`gh pr view --json ${fields} 2>$null`, `gh pr view --json ${fields} 2>/dev/null`);
}

/** A PR's review comments, for the agent to resolve. */
export function prCommentsScript(number: number): string {
  return `gh pr view ${number} --comments 2>&1`;
}

/** `gh pr create --fill`. */
export function prCreateScript(): string {
  return "gh pr create --fill 2>&1";
}

/** Push a branch (optionally setting upstream). Branch names are already
 *  sanitised by the caller; quoted anyway on POSIX. */
export function pushBranchScript(branch: string, setUpstream: boolean): string {
  const flag = setUpstream ? "-u " : "";
  return pick(`git push ${flag}origin ${branch} 2>&1`, `git push ${flag}origin ${shq(branch)} 2>&1`);
}

// ───────────────────────────── stacks ─────────────────────────────

/** One-liner that reports which marker files exist in the cwd and, when there's
 *  a package.json, which npm scripts it defines, as compact JSON:
 *  `{"markers":[...],"scripts":[...]}`. Generated from the stack table so a new
 *  stack needs no shell code. */
export function stackProbeScript(markers: string[]): string {
  if (isWindows()) {
    const list = markers.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
    return (
      `$m=@(); foreach($f in @(${list})){ if(Test-Path -LiteralPath $f){ $m+=$f } }; ` +
      `$s=@(); if(Test-Path -LiteralPath 'package.json'){ try{ ` +
      `$s=@((Get-Content package.json -Raw | ConvertFrom-Json).scripts.PSObject.Properties.Name) }catch{} }; ` +
      `@{markers=@($m);scripts=@($s)} | ConvertTo-Json -Compress`
    );
  }
  // Marker names are plain file names; JSON-quote them directly. npm scripts are
  // read with node (the only JSON parser guaranteed wherever npm matters).
  const list = markers.map(shq).join(" ");
  return (
    `m=""; for f in ${list}; do [ -e "$f" ] && m="$m\\"$f\\","; done; ` +
    `s=""; if [ -f package.json ] && command -v node >/dev/null 2>&1; then ` +
    `s=$(node -e 'const p=require(process.cwd()+"/package.json");process.stdout.write(Object.keys(p.scripts||{}).map(k=>JSON.stringify(k)).join(","))' 2>/dev/null); fi; ` +
    `printf '{"markers":[%s],"scripts":[%s]}' "\${m%,}" "$s"`
  );
}
