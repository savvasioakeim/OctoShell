# 🔧 Πλάνο διόρθωσης — ευρήματα code review (2026-07-02)

## Πρόοδος (ενημέρωση session)

- ✅ **#1** race condition + error-path leak (`docker.rs`) — re-check under lock + remove στο error path
- ✅ **#2** ορφανά containers — labels + `cleanup_orphans()` στο startup + `stop_all()` στο exit
- ✅ **#3** honest threat-model doc + `cap_drop: ALL` + `no-new-privileges` + `SandboxOptions`
  (`network` default-on, `read_only` default-off) περασμένα σε `create_container`/`exec`/`sandbox_exec`
- ✅ **#5** CSP στο `tauri.conf.json`
- ✅ **#6** `max_tokens` 1024→8192 + default model → `claude-sonnet-5`
- ✅ **#7** shared-secret token στο approval bridge (constant-time check)
- ✅ **#8** port detection και στο stderr (shared `AtomicU16`, first-hit-wins)
- ✅ **#9** cancel σκοτώνει το process tree (`taskkill /T` στα Windows)
- ✅ **#11 (copy)** honesty 01/02, Windows caption buttons, no-key BYOK, og:image absolute, Tailwind note
- ✅ **#12 (μέρος)** LICENSE (MIT)
- ✅ **#4** wired: το sandbox δεν είναι πια νεκρός κώδικας — ο πραγματικός caller
  είναι το ACP `terminal/*` (βλ. #10 iteration 3α), με global setting
  (`SandboxConfig`, default OFF) που ο orchestrator μπορεί να αλλάζει. Ο σκέτος
  claude/gemini CLI τρέχει το δικό του bash και δεν διακόπτεται — γι' αυτό το
  routing landαρει μέσω ACP, όχι ως toggle πάνω στο native path.
- 🔨 **#10** ACP — **v1 WIRED & COMPILING** (cargo + tsc πράσινα):
  - ✅ `acp.rs`: spawn agent (`AcpAgent::from_str`), initialize → new session →
    long-lived multi-prompt loop (`tokio::mpsc`); notifications → `agent://event`
    (serialized `SessionUpdate`); `agent://done` στο τέλος. Commands `acp_send`/
    `acp_cancel` registered.
  - ✅ Frontend: `parseAcp` (SessionUpdate → NormEvent) στο `providers.ts`, "acp"
    provider (🔌) στον picker, `ShellController` branch → `acp_send`/`acp_cancel`,
    default command `cmd /c npx -y @agentclientprotocol/claude-agent-acp`.
  - ✅ **smoke test PASSED** — ο χρήστης έγραψε prompt, ο Claude ACP agent
    απάντησε streaming. API reconstruction επιβεβαιωμένο end-to-end.
  - ✅ **provider + model selection** (όπως claude/gemini): οι `acp-claude` &
    `acp-gemini` είναι κανονικοί providers στον picker, καθένας με model list.
    Το μοντέλο περνά στον adapter χωρίς backend αλλαγή — `AcpAgent::from_str`
    παρσάρει leading `ANTHROPIC_MODEL=…` (Claude) ή trailing `-m` (Gemini) από το
    launch command (`acpCommandFor`). Αλλαγή provider/model τερματίζει την τρέχουσα
    ACP session (backend keys by id) ώστε το επόμενο prompt να respawn-άρει σωστά.
  - ✅ **iteration 2 (permission + terminal)** — cargo καθαρό:
    - Permission: ο `ApprovalBridge` έγινε Clone + απέκτησε async path (tokio
      oneshot)· ο ACP permission handler ρωτά τον χρήστη μέσω του υπάρχοντος
      `approval://request` flow και mapp-άρει yes/no στα agent options. Το
      `approval_respond` λύνει και τα δύο maps (sidecar + ACP).
    - Terminal: advertise `client_capabilities.terminal = true`· registry με
      create/output/wait/kill/release, host execution (tokio::process), output
      buffering + byte-limit, always-notify-done (το wait δεν κρεμάει ποτέ).
    - ➕ **9 providers**: Claude/Gemini native + ACP: Claude✅, Codex, OpenCode,
      Cursor, Copilot, Kiro, Gemini(Enterprise). Antigravity pending ACP support.
  - ✅ **iteration 3** (cargo + tsc πράσινα — θέλει runtime testing):
    - (α) **terminal → docker swap**: `SandboxManager` απέκτησε `container_for`
      (factored) + `exec_capture` (streaming callback αντί `sandbox://*` events).
      Το `acp.rs::create_terminal_sandboxed` τρέχει την εντολή του agent μέσα στο
      worktree container (image `node:20`) όταν το global flag είναι ON· αλλιώς
      host-exec (default). Docker execs → pid=None (kill no-op· container πέφτει
      στο tab close). Το #3↔#10 landαρισμένο.
    - (β) **plan→trace**: `parseAcp` mapαρει το ACP `plan` update (`entries` με
      status pending/in_progress/completed) → `NormEvent.steps`· ο
      `ShellController` αντικαθιστά wholesale το `agentProgress`. (ACP v1 δεν έχει
      standard token-usage update → τα meters μένουν στο native path.)
    - (γ) **global sandbox setting**: `SandboxConfig` (AtomicBool) managed state +
      `set_sandbox_enabled` command· `settingsStore.system.sandboxAgentCommands`
      (default OFF) το κάνει push στο backend (startup + on change)· ToggleRow στο
      System tab. Ο orchestrator μπορεί να το αλλάξει μέσω του command.
  - ✅ **iteration 4 — whole-adapter Docker sandboxing** (αντικαθιστά στην πράξη
    το 3α): runtime testing έδειξε ότι ο claude ACP adapter ΔΕΝ χρησιμοποιεί το
    client terminal capability (τρέχει Bash εσωτερικά μέσω Agent SDK) — άρα το
    terminal→docker routing δεν πιάνει με κανέναν τρέχοντα adapter. Λύση: όταν το
    sandbox flag είναι ON και ο provider έχει `dockerImage`/`dockerCommand`
    (providers.ts), ο ΟΛΟΚΛΗΡΟΣ adapter τρέχει μέσα σε `docker run -i --rm
    --user node` (node:22, worktree bind-mounted στο /app, session cwd=/app,
    shared volume `octoshell-claude-home` στο /home/node για ένα-και-μοναδικό
    login + npm cache, ANTHROPIC_API_KEY passthrough, caps dropped/memory/pids
    limits). Auth: ξεχωριστό one-time login μέσα στο volume (κουμπί στα Settings
    → System, provider-aware μέσω `sandboxLoginCommandFor`) — ΟΧΙ mount των host
    credentials (token rotation θα αποσύνδεε το host). Το terminal-capability
    path παραμένει για adapters που θα το υποστηρίξουν.
    🧪 Εκκρεμεί: ο χρήστης να ολοκληρώσει το one-time login και να επιβεβαιώσει
    `node -v` → v22 μέσα από sandboxed ACP turn.
  - ✅ **bugfix pass 2026-07-08** (ευρήματα χρήστη από πραγματική χρήση):
    orchestrator hang → `--strict-mcp-config` στο ai.rs (κολλημένος global MCP
    server μπλόκαρε το `claude --print` για πάντα)· review fixes χάνονταν όταν
    πολλά items έδειχναν στο ίδιο worktree (τώρα ένα combined dispatch ανά tab +
    αναφορά αποτυχιών + verdicts/σημειώσεις στο chat context)· service.rs σέβεται
    το `.env` PORT και διορθώνει λάθος npm script από το package.json· drag&drop
    πιάνει σε όλο το παράθυρο· review window redesign.
  - ✅ **local models via Ollama** (`acp-ollama` provider): νέο picker entry «Local ·
    Ollama (ACP)» που τρέχει `opencode acp -m ollama/<model>` — το OpenCode κρατά το
    agent loop/tool-use και μιλάει ACP, το Ollama είναι το model backend (OpenAI-
    compatible `/v1` στο localhost:11434). Model list: Qwen2.5-Coder 14B/7B/3B + Gemma
    3 4B (values με `ollama/` prefix, gemini-style `-m` injection). **Επαληθευμένο
    end-to-end**: OpenCode φορτώνει config → resolve ollama provider → stream μέσω
    ai-sdk → pwsh shell tool. Καίριο εύρημα: το tool-calling απαιτεί tool-capable
    model — το gemma3:1b βγάζει «does not support tools», το qwen2.5-coder:3b βγάζει
    tool-calls αλλά ασταθώς (πολύ μικρό)· **qwen2.5-coder ≥7B συνιστάται** για αξιόπιστο
    agentic tool-use. Προϋπόθεση: ο χρήστης έχει OpenCode εγκατεστημένο με `ollama`
    provider στο config του (aligned με το ότι όποιος τρέχει local LLMs το έχει ήδη).
    Δεν είναι sandboxable (dockerImage null → host execution). Antigravity (`agy`):
    δεν προστέθηκε — μόνο plain-text `--print`, όχι stream-json/ACP (περιμένουμε #31).
  - ✅ **automated REVIEW AGENT + QA rename** (νέο feature, 6 φάσεις, tsc+cargo καθαρά):
    - **Rename** υπάρχον Review-window → **QA mode** (`src/qa/*`, `qa://` channels, `octo-qa`
      fence, window label `qa`, capability `qa.json`) — ελευθερώνει το `review*`.
    - **Review agent** = τρίτος ρόλος (δίπλα σε coding agent + orchestrator): αυτόματα
      ελέγχει το diff κάθε coding agent (με το orchestrator task context) ΠΡΙΝ το QA.
    - Settings: global `reviewAgent {enabled, provider, model}` (checkbox + pickers).
    - `ReviewAgentController` (per-session, PTY-less· δικό του agent-send id
      `review:<sid>`· reuse `parseAgentLine` + Block types). Lifecycle: on orchestrated
      coding turn done (enabled) → `git diff` του worktree (via υπάρχον `run_capture`,
      μηδέν Rust) + task context → review prompt → start. Verdict protocol
      (```octo-review-verdict {blocking,summary}) parsed· `aggregateReviews` gate.
    - 2ο view στο CenterPanel: switch Coding⇄Review (πάνω-δεξιά, ορατό μόνο όταν active),
      pinned 2-line context (expand/collapse), «Reviewer Active…» neon pulse, review feed
      (reuse `Feed`), input που πάει στον review agent (accent border + placeholder).
    - Event-driven handoff: όταν ΟΛΟΙ οι review agents idle & κανένα blocking →
      `👁 (review agents)` ping στον orchestrator να προσφέρει QA· blocking → hold
      (ο χρήστης το λύνει στο review view). System prompt gated ώστε ο orchestrator να
      ΜΗΝ προσφέρει QA μόνος όταν ο review agent είναι on.
    - 🧪 Εκκρεμεί: live end-to-end test (enable review agent → orchestrated dispatch →
      δες review view + verdict + QA handoff).
- ⬜ **#11 (assets)** screenshots + self-healing GIF — χρειάζονται πραγματικά assets
- ✅ **#12 (υπόλοιπο εκτός onboarding)** αγγλικό README (το ελληνικό → README.el.md),
  CONTRIBUTING.md, releases workflow (`.github/workflows/release.yml`, tauri-action σε
  version tags, draft release), SmartScreen σημείωση στο README, security posture section
- ✅ **#12 (onboarding)** health-check screen πρώτου ανοίγματος: νέο `pty::health_check`
  command (χρησιμοποιεί το υπάρχον `which()`) ελέγχει claude/gemini/node/gh/pwsh στο PATH·
  `OnboardingOverlay.tsx` δείχνει checklist με ✓/✕, why + install command ανά εργαλείο.
  **Κανένα agent CLI δεν είναι υποχρεωτικό από μόνο του** — claude/gemini/node
  (=ACP providers μέσω npx) μετράνε ως εναλλακτικές `agentOption`, αρκεί ΕΝΑ να περάσει·
  pwsh παραμένει το μόνο πραγματικά required (default shell), gh optional. "Continue
  anyway" αν λείπει κάτι· persisted flag `octoshell.onboardingDone` (localStorage) το
  δείχνει μόνο μία φορά, πριν το StartupOverlay.
- ⬜ **#13** promotion sequence

**Verify:** `cargo check` καθαρό (exit 0, μηδέν warnings) μετά από κάθε ομάδα αλλαγών.

---


Τα ευρήματα προέκυψαν από πλήρη έλεγχο του codebase (`cargo check` και `tsc --noEmit`
περνούν καθαρά — όλα τα παρακάτω είναι θέματα σχεδίασης/ασφάλειας, όχι compile errors).
Σειρά: πρώτα ό,τι πρέπει να λυθεί **πριν γίνει commit το `docker.rs`**, μετά τα υπόλοιπα.

---

## 1. `docker.rs` — race condition στη δημιουργία container ⚠️ BLOCKER

**Πρόβλημα** (`SandboxManager::exec`, γύρω στις γραμμές 276–287): δύο ταυτόχρονα
`sandbox_exec` για το ίδιο worktree βλέπουν και τα δύο `None` στο map, δημιουργούν
δύο containers, και το δεύτερο `insert` σκεπάζει το πρώτο. Το πρώτο container μένει
για πάντα ζωντανό (τρέχει `tail -f /dev/null`) χωρίς κανείς να κρατά το id του.

**Λύση — per-worktree async mutex αντί για map από ids:**

- Άλλαξε το registry σε `HashMap<String, Arc<tokio::sync::Mutex<Option<String>>>>`
  (worktree → lock γύρω από το container id). Το εξωτερικό std `Mutex` κρατιέται μόνο
  για να πάρεις/φτιάξεις το entry (ποτέ across await), και μετά κάνεις
  `entry.lock().await` — έτσι ο δεύτερος caller για το ίδιο worktree **περιμένει**
  τον πρώτο αντί να φτιάξει δικό του container.
- Εναλλακτικά (μικρότερη αλλαγή αλλά όχι πλήρης λύση): μετά το
  `create_container`, ξανακλείδωσε το map· αν στο μεταξύ μπήκε άλλο id για το ίδιο
  worktree, κάνε `remove_container` σε αυτό που μόλις έφτιαξες και χρησιμοποίησε το
  υπάρχον. (Απλούστερο, αλλά πληρώνεις ένα άχρηστο create/start.)
- Σημείωση: τα execs στο ίδιο container σειριοποιούνται έτσι κι αλλιώς λογικά
  (self-healing loop), οπότε το lock δεν κοστίζει τίποτα στην πράξη.

**Επιπλέον στο ίδιο σημείο — error path leak** (γραμμές ~305–313): όταν το
`exec_in_container` αποτύχει, ο κώδικας κάνει `remove` το id από το map αλλά **δεν
αφαιρεί το container από τον Docker**. Αν το container είναι ακόμα ζωντανό (π.χ. το
σφάλμα ήταν στιγμιαίο πρόβλημα του stream), leakάρει. Διόρθωση: στο error path κάνε
και `remove_container(&docker, &container_id).await` (best-effort) πριν επιστρέψεις
το `Err`.

---

## 2. `docker.rs` — ορφανά containers μετά από crash/έξοδο ⚠️ BLOCKER

**Πρόβλημα:** το Job Object (`jobctl.rs`) σκοτώνει τοπικά processes, αλλά τα
containers ζουν **στον Docker daemon** — δεν είναι παιδιά του OctoShell. Αν η
εφαρμογή κρασάρει, γίνει hot-reload, ή απλά κλείσει χωρίς `sandbox_stop` για κάθε
worktree, τα sleeping containers μένουν για πάντα και μαζεύονται.

**Λύση — label + cleanup στο startup:**

1. Στο `create_container`, πρόσθεσε label στο `Config`:
   ```rust
   labels: Some(HashMap::from([
       ("app.octoshell.sandbox".to_string(), "1".to_string()),
       ("app.octoshell.worktree".to_string(), worktree_path.to_string()),
   ])),
   ```
2. Νέα συνάρτηση `cleanup_orphans()`: `list_containers` με filter
   `label=app.octoshell.sandbox` και force-remove ό,τι βρεθεί. Κάλεσέ τη μία φορά
   στο `setup` του `lib.rs` (σε `tauri::async_runtime::spawn`, best-effort — αν ο
   daemon δεν τρέχει, απλά return).
3. Προαιρετικό δίχτυ ασφαλείας: στο `run()` του Tauri builder, στο
   `RunEvent::Exit`, κάλεσε `SandboxManager::stop_all()` (drain του map και
   remove όλα τα containers). Το startup-cleanup παραμένει απαραίτητο γιατί το
   Exit event δεν τρέχει σε crash.

Το label λύνει και το debugging: `docker ps --filter label=app.octoshell.sandbox`
δείχνει αμέσως τι κρατάει ανοιχτό η εφαρμογή.

---

## 3. `docker.rs` — το sandbox υπόσχεται περισσότερα απ' όσα κάνει ⚠️ ΑΠΟΦΑΣΗ + ΥΛΟΠΟΙΗΣΗ

**Πρόβλημα:** το module doc λέει ότι προστατεύει από «`rm -rf` ή malicious
dependency», αλλά:

- Το bind mount είναι **read-write** → `rm -rf /app` καταστρέφει κανονικά το worktree.
- Το container έχει **πλήρη πρόσβαση δικτύου** → ένα malicious dependency μπορεί να
  κάνει exfiltrate ό,τι υπάρχει στο worktree (π.χ. `.env`, credentials).
- Τα όρια CPU/RAM/PIDs καλύπτουν μόνο το σενάριο «runaway» (infinite loop, fork bomb).

**Λύση — δύο βήματα:**

1. **Διόρθωσε το doc comment τώρα** ώστε να λέει την αλήθεια: το sandbox προστατεύει
   το *host* (resources, filesystem εκτός worktree), **όχι** το worktree και όχι από
   exfiltration. Ένα ψευδές αίσθημα ασφάλειας είναι χειρότερο από κανένα.
2. **Πρόσθεσε knobs** στο `create_container` (νέες παράμετροι ή ένα
   `SandboxOptions` struct) και πέρασέ τα από το `sandbox_exec`:
   - `network: bool` → όταν false, `network_mode: Some("none")` στο `HostConfig`.
     Χρήσιμο default για `npm test`/`cargo build` **μετά** το install (το install
     χρειάζεται δίκτυο — γι' αυτό knob και όχι hardcoded).
   - `read_only_mount: bool` → `Mount { read_only: Some(true), .. }` για καθαρά
     read-only βήματα (lint, typecheck).
   - `cap_drop: Some(vec!["ALL".into()])` και `security_opt:
     Some(vec!["no-new-privileges".into()])` μπορούν να μπουν άφοβα by default.

---

## 4. `docker.rs` — δεν καλείται από πουθενά ℹ️ ΑΠΟΦΑΣΗ

Τα `sandbox_exec`/`sandbox_stop` είναι registered στο `lib.rs`, αλλά κανένα σημείο
του frontend δεν τα καλεί και κανείς δεν ακούει `sandbox://log`/`sandbox://exit`.

**Επιλογές:**
- Αν είναι WIP: κράτα το στο working tree / σε branch μέχρι να συνδεθεί με το UI
  (π.χ. toggle «Run agent commands in Docker» στα Settings + wiring στο σημείο που
  ο agent εκτελεί εντολές). Μην μπει στο main ως «νεκρός» κώδικας.
- Αν συνδεθεί: το φυσικό σημείο είναι το approval flow ή ένα per-project setting·
  το `sandbox_stop(worktree)` πρέπει να καλείται όταν κλείνει ένα project tab
  (δίπλα στο `close_tab`/`forget`).

---

## 5. `tauri.conf.json` — `csp: null` 🔒

**Πρόβλημα:** η εφαρμογή renderάρει HTML που προέρχεται από terminal output και
agent output (frozen blocks μέσω `ansiToHtml`, Markdown). Το escaping στο `ansi.ts`
είναι σωστό, αλλά είναι το **μοναδικό** τείχος — χωρίς CSP, ένα bug εκεί ή στο
Markdown rendering γίνεται XSS με πρόσβαση στο Tauri IPC.

**Λύση:** όρισε CSP στο `app.security.csp`, π.χ.:

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost"
```

- `style-src 'unsafe-inline'` χρειάζεται γιατί το `ansiToHtml` γράφει inline styles
  (και το xterm επίσης). Αν θες να το σφίξεις αργότερα, το Tauri υποστηρίζει
  αυτόματο nonce/hash μόνο για ό,τι κάνει inject το ίδιο — τα δικά μας inline styles
  θέλουν το `'unsafe-inline'`.
- Δοκίμασε μετά: frozen output με χρώματα, εικόνες στο Markdown, τα SFX (αν
  φορτώνουν από asset protocol πρόσθεσε `asset:`/`http://asset.localhost` στο
  `img-src`/`media-src`), και το review window.

---

## 6. `ai.rs` — `max_tokens: 1024` και παλιό default μοντέλο 📏

- **`max_tokens`:** 1024 tokens κόβουν σιωπηλά μεγάλες απαντήσεις στο API path
  (ο χρήστης βλέπει μισή απάντηση χωρίς εξήγηση). Ανέβασέ το σε 4096–8192.
  (Το CLI path δεν έχει τέτοιο όριο — γι' αυτό το πρόβλημα φαίνεται μόνο με
  `ANTHROPIC_API_KEY`.)
- **Μοντέλο:** το `claude-sonnet-4-6` είναι έγκυρο αλλά μία γενιά πίσω· νεότερο
  sonnet: `claude-sonnet-5`. Ιδανικά κάνε το default configurable από τα Settings
  (υπάρχει ήδη model picker για τους agents — μπορεί να τροφοδοτεί και το sidebar).
- Προαιρετικά: όταν το API επιστρέφει `stop_reason: "max_tokens"`, πρόσθεσε ένδειξη
  «η απάντηση κόπηκε» αντί να φαίνεται ολοκληρωμένη.

---

## 7. `approval.rs` — TCP bridge χωρίς authentication 🔒 (χαμηλό ρίσκο)

**Πρόβλημα:** το bridge ακούει σε `127.0.0.1:<random port>` χωρίς κανένα secret.
Οποιοδήποτε τοπικό process μπορεί να συνδεθεί και να εμφανίσει **ψεύτικο** approval
prompt στο UI (spoofing / social engineering — δεν μπορεί να κάνει auto-approve,
αυτό περνά μόνο από το UI).

**Λύση:** ένα shared token:
1. Στο `ApprovalBridge::start`, γέννησε τυχαίο token (π.χ. 32 hex chars) και
   κράτησέ το στο state.
2. Πέρασέ το στο sidecar μέσω env (`OCTO_TOKEN`, δίπλα στο `OCTO_PORT` στο
   `agent.rs`).
3. Ο sidecar το στέλνει ως πεδίο στο JSON request· το `handle_conn` απορρίπτει
   σιωπηλά requests με λάθος/απόν token.

---

## 8. `service.rs` — port detection μόνο στο stdout 🐛 (μικρό)

**Πρόβλημα:** το `spawn_log_reader` για το stderr καλείται με `detect_port=false`,
ενώ το σχόλιο από πάνω λέει «many dev servers print their banner there». Server που
τυπώνει το URL μόνο στο stderr δεν παίρνει ποτέ port refinement.

**Λύση:** το «first hit wins» πρέπει να γίνει κοινό ανάμεσα στα δύο streams: ένα
`Arc<AtomicBool>` (`port_detected`) που μοιράζονται stdout & stderr readers· όποιος
βρει πρώτος URL κάνει το emit και γυρίζει το flag. Έτσι ενεργοποιείται το detection
και στο stderr χωρίς διπλά `service://ready`.

---

## 9. `agent.rs` — το cancel αφήνει ζωντανά τα παιδιά του agent 🧹 (μικρό)

**Πρόβλημα:** `child.kill()` σκοτώνει μόνο το `claude.exe`· τα παιδιά του
(node MCP sidecar, ό,τι Bash έτρεχε) μένουν ζωντανά μέχρι να κλείσει η εφαρμογή
(τότε τα σκοτώνει το job object). Με πολλά cancels μαζεύονται processes.

**Λύση (Windows):** αντί για ένα καθολικό job, βάλε κάθε agent run σε **δικό του**
job object: `jobctl` αποκτά `create_child_job() -> HANDLE` +
`add_to(job, pid)` + `kill_job(job)` (TerminateJobObject). Το `AgentManager`
κρατά `(Child, JobHandle)` και το cancel κάνει `kill_job`. Το nested-jobs
υποστηρίζεται από Windows 8+, οπότε το καθολικό kill-on-close job συνεχίζει να
λειτουργεί ως δίχτυ. Εναλλακτικά, quick-fix χωρίς νέο API:
`taskkill /T /F /PID <pid>` πριν το `kill()`.

---

## 10. Ενσωμάτωση ACP (Agent Client Protocol) 🚀 ΝΕΟ FEATURE

Το ACP (το πρωτόκολλο που ξεκίνησε η Zed — Apache 2.0, πλέον σε δικό του οργανισμό
`agentclientprotocol` στο GitHub) τυποποιεί την επικοινωνία client ↔ coding agent:
JSON-RPC πάνω από stdio, με κοινά μηνύματα για streaming, sessions/resume,
plans/tasks και **permission requests**. Το υποστηρίζουν 25+ agents (Claude Code
μέσω επίσημου adapter, Gemini CLI native, Codex, Copilot CLI, OpenCode, Goose…)
και ως clients οι Zed, JetBrains, VS Code, Neovim.

**Γιατί:** μία υλοποίηση αντικαθιστά τα per-provider integrations. Ό,τι σήμερα
είναι χειροποίητο ανά CLI (stream parsing στο `providers.ts`, approval bridge,
task protocol injection, resume quirks) γίνεται κοινός κώδικας· ανά provider μένει
μόνο η γραμμή εκκίνησης. Λύνει και την ευθραυστότητα του `--output-format
stream-json` (ανεπίσημο format) και το άνισο feature matrix Claude/gemini.

**Σχέδιο υλοποίησης (σταδιακό, χωρίς να σπάσει τίποτα υπάρχον):**

1. **Backend — νέο `src-tauri/src/acp.rs`** με το επίσημο crate
   [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol):
   - `AcpManager` (ίδιο pattern με `AgentManager`): spawn του agent process
     (per-provider command line από config), JSON-RPC πάνω στο stdio.
   - Υλοποίηση του ACP `Client` trait: τα session updates (κείμενο, thinking,
     tool calls, diffs, plan entries) γίνονται emit ως τα ίδια Tauri events που
     ακούει ήδη το frontend (`agent://event` με normalized payload, ή νέο
     `acp://update`).
   - Το `requestPermission` του πρωτοκόλλου δένεται στο υπάρχον
     `approval://request`/`approval_respond` flow — **χωρίς** MCP sidecar και TCP
     bridge για ACP agents (μακροπρόθεσμα αυτό αχρηστεύει το #7 για τους
     περισσότερους providers).
   - Plans/tasks του ACP τροφοδοτούν κατευθείαν το trace progress bar —
     αχρηστεύεται το STEP_PROTOCOL prompt injection για ACP agents.
2. **Frontend:** το ACP γίνεται τρίτος «provider» στο `providers.ts` /
   `agents/`. Επειδή τα events έρχονται ήδη normalized από τη Rust, ο parser
   του είναι σχεδόν passthrough. Στο UI ο χρήστης διαλέγει agent από λίστα
   (αρχικά hardcoded: Claude via `npx @agentclientprotocol/claude-agent-acp`,
   `gemini --experimental-acp`, Codex…) με το γνωστό Windows-shim χειρισμό
   (`cmd /c npx ...`, όπως το gemini σήμερα).
3. **Capability negotiation → UI:** ό,τι δεν υποστηρίζει ένας agent
   (π.χ. resume) κρύβεται/απενεργοποιείται ρητά βάσει των capabilities του
   initialize, όχι με per-provider if.
4. **Αργότερα — ACP Registry:** άντληση του καταλόγου agents από το registry
   (machine-readable install/launch metadata) ώστε νέοι providers να
   προστίθενται χωρίς αλλαγή κώδικα.
5. **Μετάβαση:** τα υπάρχοντα claude/gemini paths μένουν ως έχουν μέχρι το ACP
   path να αποδειχθεί ισοδύναμο σε καθημερινή χρήση· μετά γίνονται fallback.

**Παραδοτέο πρώτης φάσης:** ένα project tab που τρέχει agent μέσω ACP με
streaming blocks, approvals και progress — ακόμα κι αν μόνο για έναν agent.

### 🔒 Κλειδωμένη αρχιτεκτονική & build spec (επιβεβαιωμένο ACP terminal capability)

**Το κλειδί:** στο ACP ο **CLIENT** (το OctoShell) εκτελεί τα terminal commands εκ
μέρους του agent. Ο agent στέλνει `terminal/create {command,args,cwd,env,
outputByteLimit}` → ο client τρέχει την εντολή και επιστρέφει `terminalId` →
`terminal/output {output,truncated,exitStatus}` / `terminal/wait_for_exit
{exitCode,signal}` / `terminal/kill` / `terminal/release`. Ο client ΠΡΕΠΕΙ να
διαφημίσει το `terminal` capability στο `initialize.clientCapabilities`.

**Συνέπεια — αυτό λύνει το #4 interception:** ο σκέτος `claude`/`gemini` CLI τρέχει
το δικό του bash που το OctoShell δεν βλέπει· αλλά ένας **ACP agent** ζητά από το
OctoShell να τρέξει κάθε εντολή. Άρα το OctoShell υλοποιεί το `terminal/create`
**μέσω `sandbox_exec`** (docker) όταν το sandbox setting είναι ON → **διαφανές
sandboxing των εντολών του agent**, κάτι αδύνατο στο σημερινό μοντέλο.

**✅ Κλειδωμένο πραγματικό API** (crate `agent-client-protocol` v1.0.1, edition 2024,
απαιτεί rustc ≥1.85 — έχουμε 1.94· builder-based, tokio async). Από το επίσημο
example `yolo_one_shot_client.rs` — ΑΥΤΟ είναι το ground truth, όχι το docs.rs summary:

```rust
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, TextContent,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};

let agent = AcpAgent::from_str("npx @agentclientprotocol/claude-agent-acp")?; // spawns subprocess
agent_client_protocol::Client.builder()
    .on_receive_notification(
        async move |n: SessionNotification, _cx| { /* n.update → agent://event */ Ok(()) },
        agent_client_protocol::on_receive_notification!(),
    )
    .on_receive_request(
        async move |req: RequestPermissionRequest, responder, _conn| {
            // → approval bridge· responder.respond(RequestPermissionResponse::new(
            //     RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id))))
        },
        agent_client_protocol::on_receive_request!(),
    )
    .connect_with(agent, |conn: ConnectionTo<Agent>| async move {
        conn.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await?;
        let s = conn.send_request(NewSessionRequest::new(cwd)).block_task().await?;
        conn.send_request(PromptRequest::new(s.session_id,
            vec![ContentBlock::Text(TextContent::new(prompt))])).block_task().await?;
        Ok(())
    }).await?;
```

**Δύο ανοιχτά που λύνονται στο write-time (fetch από docs.rs/schema):**
- Τα variants του `SessionNotification.update` (AgentMessageChunk/AgentThoughtChunk/
  ToolCall/ToolCallUpdate/Plan/…) για το mapping → blocks. Ο σκελετός μπορεί να
  γίνει με `{:?}` πρώτα και refine μετά.
- Τα terminal request types (CreateTerminal/TerminalOutput/…) για δεύτερο
  `on_receive_request` handler → `SandboxManager`.

**Long-lived session (ΟΧΙ one-shot όπως το example):** το `connect_with` closure
πρέπει να ΜΕΙΝΕΙ ζωντανό: μέσα του, μετά το NewSession, κάνε `loop { recv prompt
από tokio::mpsc; send PromptRequest }`. Ο `AcpManager` κρατά per-session τον
`mpsc::Sender<String>` για να τροφοδοτεί prompts από το `agent_send`-style command,
και έναν cancel handle.

**Build spec (σειρά):**
1. ✅ `Cargo.toml`: `agent-client-protocol = "1"` (v1.0.1) + `tokio`. **ΕΓΙΝΕ &
   ΕΠΑΛΗΘΕΥΤΗΚΕ** — `cargo check` καθαρό σε 1m16s, exit 0, καμία σύγκρουση με
   tauri/bollard/edition 2024 (rustc 1.94). Το dependency είναι βιώσιμο.
   Επόμενο (βήμα 2): γράψε `acp.rs` skeleton (spawn + builder + one-shot prompt →
   `agent://event`), compile, μετά long-lived session + permission + terminal→sandbox.
2. `acp.rs`: `AcpManager` (registry per session). Spawn agent process
   (per-provider command line, π.χ. `cmd /c npx @agentclientprotocol/claude-agent-acp`),
   JSON-RPC πάνω σε stdin/stdout του child.
3. Υλοποίηση του ACP `Client` trait:
   - `session/update` notifications (text, thinking, tool calls, plan/tasks, diffs)
     → emit ως τα υπάρχοντα `agent://event`/normalized events που ακούει το frontend.
   - `session/request_permission` → σύνδεση στο υπάρχον `approval://request` /
     `approval_respond` flow (αχρηστεύει το MCP sidecar/bridge για ACP agents).
   - **`terminal/*` → `SandboxManager` όταν sandbox ON, αλλιώς host exec**
     (portable_pty ή captured subprocess). Ο `SandboxManager::exec` + `SandboxEvent`
     stream ταιριάζουν ήδη στο `terminal/output` streaming — reuse τους.
   - `terminal` + `fs` capabilities στο `initialize`.
4. Frontend: ACP ως τρίτος provider στο `providers.ts`/`agents/`. Global sandbox
   setting στο `settingsStore` (default ON) που περνά network/read_only στο
   `terminal/*` routing· ο orchestrator μπορεί να το toggle-άρει.
5. Capability negotiation → UI: κρύψε ό,τι δεν υποστηρίζει ο agent (π.χ. resume).
6. Test: manual `npm run tauri dev` με έναν πραγματικό ACP agent (feedback loop
   με τον χρήστη — δεν τρέχει end-to-end στο CI εδώ).

---

## 11. Landing page (`docs/index.html`) 🎨

Η βάση είναι launch-ready (το PCB trace concept δένει με το in-app trace bar, η
δομή 01–06 → principles → FAQ είναι σωστή, το FAQ copy πολύ καλό). Διορθώσεις:

1. **Διατύπωση υπόσχεσης (01/02):** το flow «tickets → worktrees → tests → PRs»
   υπάρχει, αλλά μέσω εντολής στον orchestrator — όχι πλήρως αυτόματα από την
   εφαρμογή. Ξαναγράψε το copy ώστε ο χρήστης να φαίνεται στο loop:
   - Hero prompt: μείνε ως έχει (είναι εντολή χρήστη — ΟΚ), αλλά στο 01 άλλαξε
     το «automatically fans it out» σε κάτι σαν «hand your tickets to the
     orchestrator and it fans them out…».
   - Section 02: το «Every single agent gets its own isolated Git worktree
     **automatically**» → «Point the orchestrator at your tickets and each agent
     works in its own isolated Git worktree» (ή αντίστοιχο — το κλειδί: εσύ
     δίνεις την εντολή, αυτός κάνει τη δουλειά).
2. **Windows caption buttons στο mockup:** το title bar έχει macOS traffic
   lights (● ● ●) σε προϊόν «Native for Windows» — άλλαξέ το σε ─ ▢ ✕.
3. **BYOK copy:** πρόσθεσε/ανάδειξε ότι δουλεύει ΚΑΙ χωρίς API key, με την
   υπάρχουσα συνδρομή Claude Code / Gemini CLI — ισχυρότερο selling point από
   το σκέτο BYOK. (Το FAQ το λέει ήδη σωστά· να ανέβει και στο hero/pillar.)
4. **Production hygiene:**
   - Αντικατάσταση `cdn.tailwindcss.com` με static/built CSS (console warning,
     αργό, όχι για production).
   - `og:image` με **absolute** URL (τα social previews δεν δουλεύουν με relative).
   - Το X/Twitter link δείχνει στο σκέτο `x.com` — βάλε πραγματικό profile ή βγάλ' το.
   - Επιβεβαίωση ότι το GitHub URL (`savvasioakeim/OctoShell`) είναι το τελικό —
     είναι hardcoded σε ~6 σημεία.
5. **Content:** τα 6 placeholders θέλουν αληθινά screenshots, και το section 06
   ένα demo GIF του self-healing loop (test fails → fix → pass) — αυτό το GIF
   είναι το πιο σημαντικό asset όλης της σελίδας.

---

## 12. Open source launch checklist 📦

Τι χρειάζεται για να ανοίξει το repo ΚΑΙ να το υιοθετήσει κόσμος (πέρα από τα
fixes #1–#5). Δεν χρειάζονται νέα features πριν το launch — το ACP (#10) είναι
post-launch.

- [ ] **LICENSE αρχείο (MIT)** — η σελίδα το υπόσχεται ήδη δύο φορές· χωρίς το
      αρχείο το repo δεν είναι τυπικά open source.
- [ ] **Αγγλικό README** με screenshots (το ελληνικό μένει ως `README.el.md`).
      Κοινό-στόχος: Windows devs παγκόσμια.
- [ ] **Releases pipeline:** GitHub Actions workflow (tauri-action) για builds +
      release artifacts. Το κουμπί «Download for Windows (.exe)» της σελίδας
      πρέπει να δείχνει σε πραγματικό release.
- [ ] **SmartScreen:** unsigned .exe = «Windows protected your PC» για τους
      περισσότερους χρήστες. Κατά σειρά κόστους: (α) οδηγίες στο README,
      (β) winget package, (γ) code signing certificate.
- [ ] **Το πρώτο δεκάλεπτο:** φιλικά, καθοδηγητικά μηνύματα όταν λείπει το
      `claude` CLI, το `gh`, ή το pwsh 7 — εκεί σκοντάφτει το 80% των πρώτων
      χρηστών. Ιδανικά ένα onboarding/health-check screen στο πρώτο άνοιγμα.
- [ ] **Τεκμηρίωση security posture:** η εφαρμογή τρέχει agents με
      `--dangerously-skip-permissions` όταν το approval mode είναι κλειστό —
      να γραφτεί ρητά στο README (τι σημαίνει, πώς ανάβεις approvals).
- [ ] **CONTRIBUTING.md + issue templates** — για να μπορεί η κοινότητα να
      βοηθήσει (ειδικά με το #10/ACP adapters αργότερα).
- [ ] **Ευθυγράμμιση σελίδας-εφαρμογής** (#11.1) πριν κοινοποιηθεί οπουδήποτε
      (HN/Reddit): η απόκλιση υπόσχεσης-πραγματικότητας γίνεται πάντα το top
      comment.

---

## 13. Launch / promotion sequence 📣

Εκτελείται ΜΟΝΟ αφού κλείσει το #12 — έχεις μία βολή: αν έρθει προσοχή σε repo
με σπασμένο installer ή placeholder screenshots, δεν ξανάρχεται. Η σειρά έχει
σημασία: κάθε βήμα τροφοδοτεί το επόμενο.

1. **Demo GIF — το asset που κάνει όλα τα υπόλοιπα να δουλέψουν.**
   Το self-healing loop σε ~20": test fails → ο agent διαβάζει το error →
   διορθώνει το αρχείο → ξανατρέχει tests → πράσινο. Δεύτερο GIF (προαιρετικό):
   orchestrator fan-out — «δίνω tickets, ανοίγουν N agents, βλέπω τα traces».
   Μπαίνει σε: README (πρώτο πράγμα), landing (#11.5), κάθε post παρακάτω.
2. **Show HN** — Τρίτη–Πέμπτη πρωί, ώρα US East. Τίτλος τύπου:
   «Show HN: OctoShell – open-source mission control for coding agents,
   Windows-native». Το «Windows-native» ΣΤΟΝ τίτλο — είναι το σπάνιο/hook.
   Πρώτο comment δικό σου: γιατί το έφτιαξες, τι κάνει σήμερα, τι όχι ακόμα
   (η ειλικρίνεια για τα όρια είναι ό,τι καλύτερο σε HN κοινό).
3. **Reddit:** r/rust και r/tauri (το οικοσύστημα αγαπάει showcase projects και
   είναι γενναιόδωρο με stars), r/ClaudeAI, r/programming. Ένα post τη φορά,
   προσαρμοσμένο στο κοινό — όχι copy-paste.
4. **Tauri showcase** — υψηλή πιθανότητα ανάδειξης: το Tauri team προωθεί
   ενεργά σοβαρά projects ως απόδειξη του framework. Αντίστοιχα: awesome-tauri,
   awesome-agent-orchestrators lists (PR με το project).
5. **Στοχευμένα mentions — μετά τα παραπάνω, όχι πριν.** Όχι cold spam· ένα X
   post με το GIF και φυσικό mention, ή απάντηση σε σχετικό thread τους:
   Scott Hanselman / Windows dev community άτομα (αναδεικνύουν Windows dev
   tools ως δουλειά τους), Windows Terminal team, Tauri core. Κόστος μηδέν,
   πιθανότητα μικρή αλλά όχι αμελητέα — και το repo θα είναι έτοιμο αν πιάσει.
6. **Technical posts (1–2 εβδομάδες μετά το launch, κρατούν το momentum):**
   «Parsing OSC 133 semantic prompts on Windows ConPTY» και «Kill-on-close Job
   Objects: no more orphaned processes». Ανεβαίνουν σε HN/r/rust ξεχωριστά —
   δεύτερο και τρίτο κύμα προσοχής, και ταυτόχρονα career asset (απόδειξη
   βάθους, βλ. συνεντεύξεις).
7. **Μετά το πρώτο κύμα:** GitHub Sponsors ενεργό από μέρα 1 (κοστίζει τίποτα),
   απαντάς σε ΚΑΘΕ issue τις πρώτες εβδομάδες (η ταχύτητα maintainer είναι το
   Νο1 σήμα υγείας project), pin ένα «good first issue» set για contributors.

**Μην** χτίσεις προσδοκία γύρω από το «θα με προσέξει ο Χ» — σχεδίασε ώστε αν
σε προσέξει, το repo να τον κερδίσει. Το influencer boost είναι ο δεύτερος
ντόμινο· ο πρώτος είναι πάντα GIF + Show HN.

---

## Προτεινόμενη σειρά εργασίας

| Βήμα | Τι | Γιατί πρώτο |
|------|----|-------------|
| 1 | #1 + #2 (docker leaks) | Μπλοκάρουν το commit του `docker.rs` |
| 2 | #3 (sandbox honesty/knobs) | Ίδιο αρχείο, μία περασιά· καθορίζει το τι υπόσχεσαι |
| 3 | #4 (wiring ή branch) | Απόφαση προϊόντος πριν το merge |
| 4 | #5 (CSP) + #7 (bridge token) | Ασφάλεια, ανεξάρτητα μικρά PRs |
| 5 | #6 (max_tokens/model) | 10λεπτη αλλαγή, ορατό όφελος |
| 6 | #8, #9 | Nice-to-have καθαριότητα |
| 7 | #12 (launch checklist) + #11 (landing) | Ό,τι χρειάζεται για το δημόσιο άνοιγμα — LICENSE/README/releases παράλληλα με τα παραπάνω, το copy alignment πριν από κάθε κοινοποίηση |
| 8 | #13 (launch sequence) | Εκτελείται μόνο με κλεισμένο το #12 — GIF → Show HN → Reddit → showcase → mentions → posts |
| 9 | #10 (ACP) | Το στρατηγικά σημαντικότερο νέο feature — post-launch· μακροπρόθεσμα απλοποιεί/αντικαθιστά τα #7 και το STEP_PROTOCOL |

Κάθε βήμα είναι ανεξάρτητο commit — δεν χρειάζεται big-bang αλλαγή πουθενά.
