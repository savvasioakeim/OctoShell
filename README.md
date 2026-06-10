# 🐙 OctoShell

Ένα power-user terminal workspace για Windows με αρχιτεκτονική **Semantic Blocks** (à la Warp): το terminal είναι ένα *feed* από αυτόνομα command blocks, όχι ένα ενιαίο text stream. Χτισμένο με **Tauri v2 + Rust** (back-end) και **React + TypeScript + Tailwind + xterm.js/WebGL** (front-end).

## Χαρακτηριστικά

- **Semantic Blocks feed** — κάθε εκτέλεση (command + output) είναι ένα αυτόνομο block με header (εντολή, ώρα, status), content και hover actions (Copy output / Copy command / Ask AI).
- **OSC 133 shell integration** — η Rust κάνει inject ένα PowerShell prompt + PSReadLine Enter-handler που εκπέμπει OSC 133 A/B/C/D markers (+ OSC 7 για cwd). Ένας semantic parser στη Rust ανιχνεύει με ακρίβεια όρια εντολών & exit codes — robust, χωρίς εύθραυστο prompt-regex.
- **Shared live term + freeze** — ένα μόνο WebGL xterm renderάρει το τρέχον block· όταν τελειώσει, το output γίνεται freeze σε colored & **επιλέξιμο HTML** (copy-paste σαν text editor σε όλα τα blocks). Έτσι κρατάμε ένα WebGL context όσα blocks κι αν υπάρχουν.
- **AI Assistant sidebar** — chat με πρόσβαση στο ιστορικό των blocks + cwd. Δύο transports: `ANTHROPIC_API_KEY` → Anthropic API· αλλιώς fallback στο τοπικό `claude` CLI (Claude Code), χωρίς key.
- **Macro buttons** — π.χ. *Git Smart Commit*: αναλύει το output του προηγούμενου block (ή ένα fresh `git status`) και **προτείνει** την εντολή στο input field (ο χρήστης εγκρίνει & πατά Enter — όχι αυτόματη εκτέλεση).

## Αρχιτεκτονική

```
Frontend (React/Vite)                          Backend (Rust)
─────────────────────                          ──────────────
InputBar ──submit──► ShellController ──write──► PtyManager: Arc<Mutex<HashMap<id, PtySession>>>
                          │                       │ pwsh.exe + injected OSC 133 prompt
   Feed ◄── snapshot ─────┤                       │ 1 blocking OS-thread / PTY
   (TerminalBlock × N)    │                       ▼
        live xterm  ◄─────┤◄── pty://output ───── SemanticParser (στρώνει το stream)
        frozen HTML       │◄── pty://command-end ─  → Output / CommandEnd(code)
                          │◄── pty://cwd / ready    → Cwd / Ready
AiSidebar / MacroBar ──ai_chat / run_capture──►   ai.rs (API ή claude CLI) · captured subprocess
```

**Ροή ενός block:** ο χρήστης γράφει στο `InputBar` → `ShellController.submit` φτιάχνει block (status=running) και στέλνει `cmd\r` → η Rust εκπέμπει OSC 133 C (start) → output ρέει στο shared live xterm → OSC 133 D;`<code>` → ο controller κάνει freeze το output σε HTML, θέτει success/error, και ελευθερώνει το live term για το επόμενο block.

**High-throughput χωρίς freeze:** blocking `read()` σε ξεχωριστό OS-thread ανά PTY · output σε batches 8 KB base64 · ο semantic parser είναι incremental (χειρίζεται escape sequences/markers σπασμένα σε read boundaries).

## Προαπαιτούμενα

- Node.js 18+, Rust 1.77+
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) για Windows (WebView2 + MSVC build tools)

## Setup & Run

```powershell
npm install
# Προαιρετικό: $env:ANTHROPIC_API_KEY = "sk-ant-..."
# Χωρίς key, το sidebar χρησιμοποιεί αυτόματα το τοπικό `claude` CLI.
npm run tauri dev
```

> Αν δεν υπάρχουν icons, τρέξε `npm run tauri icon path\to\logo.png`.

## Δομή

```
src/
  main.tsx · App.tsx · styles.css
  shell/ShellController.ts   # model: feed, shared live xterm, PTY events, store
  shell/useShell.ts          # useSyncExternalStore hook
  blocks/TerminalBlock.tsx   # ένα block (header/content/actions)
  blocks/Feed.tsx · InputBar.tsx
  ai/AiClient.ts · AiSidebar.tsx
  macros/MacroBar.tsx
  util/ansi.ts               # ANSI→HTML (colored, selectable) + base64
src-tauri/src/
  lib.rs                     # Tauri builder + command registry
  pty.rs                     # PtyManager + SemanticParser + OSC 133 injection
  ai.rs                      # ai_chat (API ή claude CLI fallback)
```

## Γνωστοί περιορισμοί (MVP)

- **Full-screen / alt-screen προγράμματα** (vim, htop, less, REPLs) δεν ταιριάζουν στο block model — χρειάζονται ένα raw fallback pane (μελλοντικά).
- **Multi-line εντολές** στο input υποστηρίζονται με Shift+Enter, αλλά το PSReadLine Enter-handler κάνει AcceptLine πάντα — σύνθετα multi-line constructs μπορεί να σπάσουν.
- **Tab completion** δεν προωθείται προς το shell (το input είναι κανονικό text field).
- Ένα session (`"main"`). Ο `ShellController` δέχεται `sessionId`, οπότε multi-tab = πολλαπλά instances (επόμενο βήμα).

## Σημειώσεις ασφάλειας

- Τα macros **δεν** εκτελούν αυτόματα — προτείνουν εντολή στο input για έγκριση.
- Το `run_capture` τρέχει με `-NoProfile -NonInteractive`. Μην του περνάς untrusted input χωρίς validation.
