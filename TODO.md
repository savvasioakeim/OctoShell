# OctoShell — TODO / Roadmap

> Ενεργή ανάπτυξη. Legend: 🔴 μεγάλο impact · 🟠 μεσαίο · 🟢 μικρό · ⏱️ effort (S/M/L)

---

## 🔭 ΚΑΤΑΣΤΑΣΗ & ΕΠΟΜΕΝΑ (διάβασε πρώτα μετά από compact)

**Ολοκληρωμένα:** smart scroll · Tab-completion runspace · custom titlebar · notifications · Run-tests macro · model switcher (per-provider) · **provider abstraction Claude↔Gemini** (πλήρες, schema verified+fixed) · resizable panels · Shiki highlighting · markdown renderer (agent feed + assistant) · MacroBar redesign · diff badges · **Smart PR button** (Create→Check→Resolve→Update, tested σε PR #1) · **Cables/tentacles rail** + named groups + DnD + alignment · **git-worktree isolation** (+ nesting κάτω από το parent) · cursorBlink/lazy-freeze · Palenight palette.

**Μένουν (μεγάλα):**
- 🔴 **Assistant orchestrator** (#4) — ο βοηθός να δίνει tasks σε agents, με confirmation. (Το τελευταίο μεγάλο.)
- 🔴 **Heavy-output transport** (#1) — binary channel, για βαριά builds (όταν χρειαστεί).
- 🟡 **Virtualize feed** (#1) — πολλά blocks (lazy-freeze το καλύπτει εν μέρει).
- **Codex / Goose providers** (#4) — όχι installed· Goose = δρόμος για free/local LLMs (Ollama).
- ⏸️ Approval UI (αντί `--dangerously-skip-permissions`/yolo) · token streaming · custom app icon.

**Εκκρεμή από συζήτηση:**
- 🐙 **Tentacles redesign** — ο χρήστης έχει συγκεκριμένο όραμα για το rail (θα το εξηγήσει· δύσκολο με πολλά worktrees/projects στην ίδια ομάδα). Το τρέχον rail είναι v1.
- Μικρά Gemini: το `update_topic` (internal planning tool του Gemini) φαίνεται ως tool-block «θόρυβος» — προαιρετικό filter· ripgrep δεν είναι installed (Gemini πέφτει σε GrepTool fallback).

---

## ✅ Ήδη έτοιμα (για context)
- Semantic blocks (OSC 133), shared live xterm + freeze-to-HTML
- Multi-tab projects, alt-screen fallback, click-to-type interactive
- Tab autocomplete (pwsh `TabExpansion2`)
- Agent-native feed (claude headless stream-json, multi-turn `--resume`)
- Cross-project workspace AI assistant (read-only context + cancel/jump)
- Persistence (projects, blocks, agent sessions, assistant chat) — localStorage
- VSCode macro, keyboard shortcuts

---

## 1. Performance
- [x] 🔴 ⏱️M **Tab completion → persistent pwsh runspace** ✅ ΕΓΙΝΕ. Warm round-trips μετρημένα **40–92ms** (από ~1567ms). `CompletionEngine` (ένα warm pwsh, read-eval loop, base64 protocol, auto-respawn) + pre-warm στο startup που προ-χτίζει και το cmdlet cache (το πρώτο Tab instant).
- [ ] 🟠 ⏱️L **Heavy output**: batch τα PTY events + αντικατάσταση `base64`→JSON με binary Tauri `Channel<Vec<u8>>`. Λιγότερο CPU/IPC, ψηλότερο backpressure ceiling.
- [ ] 🟡 ⏱️M **Virtualize το feed** (render μόνο ορατά blocks) — σταθερή μνήμη με πολλά blocks.
- [x] 🟢 ⏱️S Lazy freeze-to-HTML ✅ ΕΓΙΝΕ (IntersectionObserver: το frozen HTML γίνεται inject μόνο όταν το block πλησιάζει το viewport).
- [x] 🟢 ⏱️S cursorBlink off όταν idle ✅ ΕΓΙΝΕ (blink μόνο όταν focused/alt-screen).

**Γνώμη:** #1 πρώτο, είναι το πιο χτυπητό win. #2 όταν αρχίσεις βαριά builds. Το ConPTY drain που έχουμε ήδη μας δίνει το πλεονέκτημα του VS Code (οι εντολές δεν στραγγαλίζονται από το rendering).

---

## 2. UX — συμπεριφορά terminal
- [x] 🔴 ⏱️S **Smart scroll** ✅ ΕΓΙΝΕ. Stick-to-bottom στο `Feed.tsx`: ResizeObserver ακολουθεί live output μόνο όταν ο χρήστης είναι ήδη κάτω· floating «↓» κουμπί με badge αριθμού νέων μηνυμάτων όταν έχει κάνει scroll πάνω.

**Γνώμη:** Καθαρό win, εύκολο, υψηλή αξία καθημερινά. Standard pattern (stick-to-bottom). Να μπει σύντομα.

---

## 3. Window chrome — custom titlebar
- [x] 🟠 ⏱️M **Αφαίρεση του λευκού native title bar** ✅ ΕΓΙΝΕ. `decorations: false` + `src/chrome/Titlebar.tsx`:
  - δικά μας min / maximize-restore / close (Tauri window API, SVG icons, κόκκινο hover στο close)
  - drag region (`data-tauri-drag-region`) → native double-click-maximize + Windows snap
  - branding (🐙 OctoShell)· window permissions προστέθηκαν στο `capabilities/default.json`
  - TODO μελλοντικά: global actions/model chip στο titlebar

**Γνώμη:** Μεγάλο αισθητικό όφελος, κάνει την εφαρμογή να φαίνεται «δική μας». Μεσαίο effort λόγω edge cases (snap/resize σε Windows). Αξίζει — ταιριάζει με το UI cleanup (#5).

---

## 4. Agent δυνατότητες
- [x] 🟠 ⏱️M **Model switcher** ✅ ΕΓΙΝΕ. Chip «⚙ Default/Opus/Sonnet/Haiku» στο InputBar (agent mode) → `setAgentModel`, persisted per-project (`KEY.model`), περνά ως `--model` από το επόμενο turn. (Πλήρης provider abstraction ακόμα ανοιχτή.)
- [x] 🔴 ⏱️L **Agent provider abstraction** ✅ ΕΓΙΝΕ (claude ↔ gemini). `src/agents/providers.ts` normalizer· `agent.rs` per-provider args (gemini: `-p -o stream-json --approval-mode yolo --skip-trust [-m] [--resume latest]`, μέσω `cmd /c` στα Windows)· provider chip 🐙/✦ + per-provider model list· persisted (`KEY.provider`)· gemini deltas → ένα block· switch μηδενίζει session+model· error block μόνο σε exit≠0 (τα gemini warnings σιωπούν)· block header δείχνει τον σωστό provider.
  - **Gemini schema (verified live):** `init{session_id}` · `message{role,content,delta,thought?}` (thoughts skipped) · `tool_use{tool_name,tool_id,parameters}` · `tool_result{tool_id,status,output}` · `result{status,stats}`. Models: `gemini-3.1-pro-preview` / `gemini-3-flash-preview` / `gemini-3.1-flash-lite` (+auto).
  - TODO: Codex/Goose (όχι installed)· φίλτρο για `update_topic` αν θεωρηθεί θόρυβος.
- [ ] 🔴 ⏱️L **Assistant → orchestrator**: ο βοηθός να μπορεί να **δίνει εντολές/tasks** σε άλλους agents, όχι μόνο να βλέπει. Σχέδιο: ο assistant προτείνει «workspace actions» (π.χ. send prompt σε agent X, cancel Y) → ο χρήστης επιβεβαιώνει → η app τις εκτελεί. (Safety: confirm πριν dispatch.)

### Providers — ranked (από research, verified με sources)
Στόχος: solid με τους 3 πιο γνωστούς (Claude/Gemini/OpenAI) αφού θα το χρησιμοποιούν κι άλλοι χρήστες.

1. ✅ **Claude Code** (`claude`) — έτοιμο. `-p --output-format stream-json --verbose`, `--resume`, `--dangerously-skip-permissions`.
2. [x] 🥇 **Gemini CLI** (`gemini`) ✅ ΕΓΙΝΕ — schema verified live, parser fixed, δουλεύει end-to-end (βλ. #4 παραπάνω).
3. [ ] 🥈 **OpenAI Codex CLI** (`codex`) — `codex exec`· `--json`/`--experimental-json` → JSONL αλλά με `thread/turn/item` envelope (όχι 1:1) → χρειάζεται **adapter**. `codex exec resume [ID]`/`--last`, `--yolo` (`--dangerously-bypass-approvals-and-sandbox`), `--ask-for-approval`/`--sandbox`. **Drop-in: MED.** (= ο OpenAI provider που θες «ποτέ δεν ξέρεις».)
4. [ ] 🥉 **opencode** (`opencode run`) — `--format json` (schema **μη-documented**, μόνο 3rd-party), `--continue`/`--session`/`--fork` (reports για bugs), `--dangerously-skip-permissions` (ίδιο όνομα). **Drop-in: MED-HARD.** Bonus: υποστηρίζει local/OpenAI-compatible models → γέφυρα για free LLMs (βλ. #4b).
5. [ ] ❓ Ανεξερεύνητα: **Qwen Code** (fork Gemini, *ίσως* κληρονομεί stream-json), **Amp**, **Goose**, **Crush**, **Aider** (edit-tool, όχι ίδιο agent μοντέλο).

**Design:** ο `AgentProvider` κρύβει το per-CLI schema· ο feed renderer δουλεύει πάνω στα normalized events, άρα κάθε νέος provider = ένας adapter, τίποτα άλλο.

### 4b. Free / local LLMs (π.χ. Llama) — research done ✅
Βασικό: ένα open model (Llama/Qwen/DeepSeek/Mistral) είναι **model, όχι agent** — χρειάζεται agent harness που (α) δείχνει σε local/OpenAI-compatible backend (Ollama/llama.cpp) και (β) βγάζει structured stream. Το harness κάνει το loop, το model δίνει μόνο τα tokens + tool-call intent.

**💡 Killer finding: το Claude Code re-pointάρεται σε Ollama** μέσω Anthropic-compatible API — δηλαδή το **υπάρχον** integration μας τρέχει free local Llama με **ΜΗΔΕΝ νέο parser code**:
```
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""
claude -p --output-format stream-json --model <ollama-model>
```
⚠️ Θέλει tool-capable model με **≥64k context** (το Claude Code απαιτεί μεγάλο context window).

- [ ] 🥇 **Variant 1 — Claude Code → Ollama** (λιγότερος κώδικας): provider variant που εισάγει τα παραπάνω env vars + `--model`. **Μηδέν νέο parsing** (ίδιο stream-json). Το πιο φθηνό free-agent option.
- [ ] 🥈 **Variant 2 — Goose** (καθαρότερο open-agent story): `goose run -t <prompt> --output-format stream-json` με `GOOSE_PROVIDER=ollama`. Έχει purpose-built `stream-json` (text|json|stream-json) → ένας νέος adapter.
- [ ] 🥉 **Codex `--oss`** (Ollama) + `codex exec --json` — αν έχουμε ήδη Codex provider.
- Λοιπά: opencode (local providers ✓, αλλά headless JSON output **μη-επιβεβαιωμένο**)· Qwen Code (Gemini fork, τοπικά μέσω OpenAI-compatible, αλλά stream-json αβέβαιο)· Aider (edit tool, **όχι** agent — skip).
- **Serving**: Ollama → OpenAI-compatible `/v1` + Anthropic-compatible layer· tool/function calling ✓ (αλλά `tool_choice` όχι ακόμα). llama.cpp θέλει `--jinja` για tool calls.
- **Models με αξιόπιστο tool-calling**: Llama 3.1/3.3, Qwen2.5-Coder, Mistral Nemo, Hermes, DeepSeek. ⚠️ Μικρά (7-8B) αδύναμα σε multi-step tools· αξιόπιστο agentic από **30B+**.
- **Hardware (Q4_K_M)**: 7-8B ≈ 6 GB VRAM· **32B ≈ 22-24 GB (sweet spot, μία 24GB κάρτα)**· 70B ≈ 48 GB+. (+~64k context = παραπάνω KV-cache.)

**Απόφαση:** Επίσημος open/local δρόμος = **Δρόμος Β (Goose)** — για λόγους optics. Κρατάμε τους κόσμους χωριστά: **Claude Code → μόνο Claude (cloud)**, **Goose → open/local μοντέλα μέσω Ollama**. Έτσι ποτέ δεν τρέχουμε open μοντέλο μέσα από proprietary tooling (η open community δεν θα το δει με κακό μάτι). Ο Δρόμος Α (Claude→Ollama) μένει ως σημείωση, δεν τον υλοποιούμε.

Πλάνο για το Goose provider (effort: ο adapter είναι μικρός, σαν τον claude parser ~40 γραμμές):
1. `AgentProvider` abstraction (θεμέλιο για όλους — χρειάζεται ούτως ή άλλως).
2. Hands-on spike: τρέχω `goose run --output-format stream-json` ζωντανά για να κλειδώσω schema πεδίων + flags (resume / model selection / yolo) — μηδενίζει το ρίσκο πριν γράψουμε κώδικα.
3. Goose adapter: parse Goose events → normalized events.
- Προϋπόθεση χρήσης (όχι κώδικα): Ollama + tool-capable model (π.χ. Qwen2.5-Coder 32B) + ~24GB GPU.

**Γνώμη / σειρά:** Πρώτα το **provider abstraction** (foundation) — μόλις υπάρχει, ο model switcher (#4.1) και το provider switch (#4.2) βγαίνουν σχεδόν δωρεάν. Το **orchestrator** (#4.3) είναι το πιο φιλόδοξο/ρισκαρισμένο — να γίνει ΤΕΛΕΥΤΑΙΟ, με explicit confirmation, αφού σταθεροποιηθούν τα υπόλοιπα. Το persistence ✅ είναι ήδη εκεί, άρα δεν μας μπλοκάρει.

---

## 5. UI polish (έμπνευση: Conductor — ΙΔΙΟ layout, πιο clean)
- [x] 🟠 ⏱️M **Resizable panels (οριζόντια)** ✅ ΕΓΙΝΕ. Drag handles ανάμεσα στα 3 sections, persisted (`KEY.layout`), min/max clamps, double-click = reset. Το `lockedCols` εξασφαλίζει ότι resize στη μέση εντολής δεν την μπερδεύει.
- [ ] 🟡 ⏱️M Πιο ήρεμο, καθαρό aesthetic: spacing/typography, λεπτότερα borders. _(μερικώς: γραμματοσειρά JetBrains Mono, μεγέθη, σκούρα blocks/inputs έγιναν)_
- [x] 🟡 ⏱️S Status & diff badges στη λίστα projects ✅ ΕΓΙΝΕ (branch `⎇` + `+a −r`, poll κάθε 30s μέσω run_capture).
- [x] 🟢 ⏱️S Model chip στο input ✅ ΕΓΙΝΕ (βλ. #4 model switcher).
- [ ] 🟢 ⏱️S Συνεπή icons/ονοματολογία, hover states.
- [x] 🟠 ⏱️S **MacroBar design** ✅ ΕΓΙΝΕ. Compact icon-first buttons + overflow «⋯» dropdown (MAX_INLINE=3) ώστε να μη σπάει το top bar με περισσότερα macros.
- [x] 🟠 ⏱️M **Syntax highlighting (VS Code-style) σε ΚΩΔΙΚΑ** ✅ ΕΓΙΝΕ (Shiki fine-grained core, Palenight, JS engine χωρίς WASM· σε agent code fences + tool inputs· lazy + cap 20k chars + fallback σε plain). _(αρχικό σχέδιο παρακάτω)_ — όχι σε raw terminal output (αυτό έχει ήδη τα ANSI χρώματα του προγράμματος via `ansiToHtml`). Εφαρμογή σε: (α) code fences στα agent μηνύματα, (β) tool inputs/κώδικα (Edit/Write/Bash), (γ) η εντολή στο block header & στο InputBar (shell tokens). Lib: **Shiki** (ίδιες grammars/themes με VS Code → ίδιο look· πιο βαρύ/async) ή **highlight.js/Prism** (ελαφρύτερο). Perf: highlight μόνο code, lazy + cap μεγέθους.
  - **Theme = ίδιο με του χρήστη: «Material Theme Palenight High Contrast».** Η Shiki φέρνει built-in το `material-theme-palenight` (κατευθείαν χρήση)· για pixel-match της High Contrast παραλλαγής, φορτώνουμε το theme JSON του extension στη Shiki.
- [x] 🟢 ⏱️S **Ευθυγράμμιση παλέτας app → Palenight** ✅ ΕΓΙΝΕ. Tailwind colors → ink `#292D3E`, panel `#252A3A`, edge `#3A3F58`, accent `#7E57C2`, muted `#8087A8`· xterm theme + scrollbar ταιριασμένα. (Το per-token Shiki highlighting σε code παραμένει ανοιχτό — βλ. παραπάνω.)

**Γνώμη:** Incremental polish, χαμηλό ρίσκο. Να γίνει **μαζί με το custom titlebar (#3)** ώστε το πάνω μέρος να δένει οπτικά. Κρατάμε το 3-panel layout.

---

## 6. Agent grouping — «cables / tentacles» rail ✅ ΕΓΙΝΕ (`src/projects/CablesRail.tsx`)
- [x] 🟠 ⏱️L **Στενή στήλη αριστερά** — SVG πλοκάμι (gradient μωβ→teal) με «κεφαλή» 🐙 + κόμβο ανά agent σε κυματιστή καμπύλη.
- [x] Groups με **όνομα**, οπτικά διακριτά (group headers, χρωματιστά· επιλογή χρώματος από δεξί κλικ).
- [x] Κάθε κόμβος = status agent: **fill** = γκρι(idle)/μπλε(τρέχει,pulse)/πράσινο(done)/κόκκινο(error)· **ring** = χρώμα ομάδας.
- [x] Data model για groups + persistence (`KEY.groups`: groups[] + project→group).
- [x] **DnD**: reorder projects & groups, μετακίνηση project σε ομάδα (drop σε header/row). Δεξί κλικ context menus (assign/new/rename/color/delete). `dragDropEnabled:false` στο Tauri ώστε να δουλεύει το HTML5 DnD.
- [x] Tentacle καμπύλες (smooth S-curves) + glow + pulse.

**Γνώμη:** Αυτό είναι η **οπτική ταυτότητα** του OctoShell — ξεχωρίζει από Conductor/Warp. Πολύ καλή ιδέα. Τα χρώματα status ταιριάζουν 1:1 με τα υπάρχοντα states (`agentBusy`/`busy`/last block status), οπότε το logic υπάρχει· το βάρος είναι στο group model + το SVG/CSS των traces. Effort μεγάλο λόγω design, αλλά υψηλή αξία brand.

---

## 7. Παράλληλοι agents & QoL workflow (έμπνευση: Conductor)
> Το Conductor είναι Mac-only & χωρίς Gemini/local — άρα Windows + multi/local-provider = ήδη δική μας διαφοροποίηση. Παίρνουμε επιλεκτικά, κρατάμε terminal-first.

- [x] 🔴 ⏱️L **Git-worktree isolation** ✅ ΕΓΙΝΕ. Κουμπί «🌿 New worktree» (sidebar footer) → `git worktree add -b <branch>` στο `.octoshell/worktrees/<branch>` (locally ignored via `.git/info/exclude`) + ανοίγει νέο project tab εκεί· cleanup (`git worktree remove`) όταν κλείνει το project. Όλο μέσω `run_capture` (frontend, χωρίς Rust). Verified backend create/list/remove. TODO μελλοντικά: αυτόματο worktree ανά agent run· UI για merge/PR από worktree.
- [x] 🟠 ⏱️S **Notifications** ✅ ΕΓΙΝΕ (agent-done). `tauri-plugin-notification` + `src/util/notify.ts`· firing στο `onAgentDone` με όνομα project, μόνο όταν το παράθυρο **δεν** είναι focused. TODO: notification και όταν ο agent χρειάζεται input (μετά το approval UI).

### Macros (quality-of-life — επεκτείνουν την MacroBar· υπάρχει ήδη `run_capture` + agent dispatch)
- [x] 🗑️ **Remove «🔧 Fix Last Error»** ✅ ΕΓΙΝΕ.
- [x] 🟢 ⏱️S **Run tests** macro ✅ ΕΓΙΝΕ. Auto-detect (package.json+test script → `npm test` · Cargo.toml → `cargo test` · pyproject/pytest.ini/setup.py → `pytest` · go.mod → `go test ./...`)· τρέχει ως κανονικό command block. TODO μελλοντικά: per-project test-script override.
- [x] 🟠 ⏱️M **Smart PR button** ✅ ΕΓΙΝΕ (`src/macros/SmartPrButton.tsx`). Create→Check→Update→loop, state per-branch persisted (`KEY.pr`), Update στέλνει τα review comments στον agent. Deps: `gh` (authed). Θέλει test σε πραγματικό PR. _(αρχικό σχέδιο παρακάτω)_
  - **Create PR** → `git push -u` + `gh pr create` (PR description: dispatch στον agent). Αποθηκεύει `{branch → PR#, phase}`.
  - → γίνεται **Check PR** → `gh pr view --json state,reviewDecision,reviews,comments` (+ `gh api .../pulls/{n}/comments` για inline):
    - `MERGED`/`CLOSED` → **Done** (reset)·
    - `CHANGES_REQUESTED` / νέα review comments → ξεκλειδώνει **Update PR**·
    - αλλιώς μένει **Check** (re-check).
  - **Update PR** → στέλνει τα review comments στον agent («λύσε αυτά») → agent edit + push → γυρνά σε **Check PR**.
  - Loop Check→Update→Check μέχρι **merged/closed** ή **αλλαγή branch**.
  - Deps: `gh` CLI (authed). Deterministic εκτός από το Update (= ποιότητα agent).
  - Υλοποίηση σε 2 βήματα: (1) deterministic Create/Check/merged-closed (εύκολο), (2) Update-via-agent + review-comment parsing.
- (Ήδη: 🆚 VSCode · ✨ Git Smart Commit.)

**Γνώμη:** Run tests = εύκολο. Το Smart PR button είναι **εφικτό, MEDIUM** — οι git/gh μηχανισμοί είναι στιβαροί· το βάρος είναι το state machine ανά branch + review-comment parsing + agent dispatch. Το worktree isolation παραμένει το βαρύ/σημαντικό κομμάτι του #7.

---

## 📌 Σειρά για ό,τι ΑΠΟΜΕΝΕΙ (τα 1–7 του αρχικού πλάνου έγιναν)
1. **Assistant orchestrator** (#4) — ο βοηθός δίνει tasks σε agents, με confirmation πριν dispatch. Το επόμενο μεγάλο.
2. **Tentacles redesign** (#6) — αφού ο χρήστης εξηγήσει το όραμά του.
3. **Heavy-output transport / virtualize feed** (#1) — perf, όταν χρειαστεί σε βαριά builds/πολλά blocks.
4. **Codex / Goose providers** (#4) — Goose = free/local LLMs μέσω Ollama (απόφαση: Δρόμος Β).
5. **Approval UI** — αντικαθιστά `--dangerously-skip-permissions`/yolo· ξεκλειδώνει «agent χρειάζεται input» notifications.
6. Λοιπά: token streaming, custom app icon, per-project test-script override, merge/PR-from-worktree UI.
