# 🐙 OctoShell

Ένα power-user terminal workspace για Windows και macOS με αρχιτεκτονική **Semantic Blocks** (à la Warp): το terminal είναι ένα *feed* από αυτόνομα command blocks, όχι ένα ενιαίο text stream. Χτισμένο με **Tauri v2 + Rust** (back-end) και **React + TypeScript + Tailwind + xterm.js/WebGL** (front-end).

## Χαρακτηριστικά

- **Semantic Blocks feed** — κάθε εκτέλεση (command + output) είναι ένα αυτόνομο block με header (εντολή, ώρα, status), content και hover actions (Copy output / Copy command / Ask AI).
- **OSC 133 shell integration** — η Rust κάνει inject ένα PowerShell prompt + PSReadLine Enter-handler που εκπέμπει OSC 133 A/B/C/D markers (+ OSC 7 για cwd). Ένας semantic parser στη Rust ανιχνεύει με ακρίβεια όρια εντολών & exit codes — robust, χωρίς εύθραυστο prompt-regex.
- **Shared live term + freeze** — ένα μόνο WebGL xterm renderάρει το τρέχον block· όταν τελειώσει, το output γίνεται freeze σε colored & **επιλέξιμο HTML** (copy-paste σαν text editor σε όλα τα blocks). Έτσι κρατάμε ένα WebGL context όσα blocks κι αν υπάρχουν.
- **AI Assistant sidebar** — chat με πρόσβαση στο ιστορικό των blocks + cwd. Δύο transports: `ANTHROPIC_API_KEY` → Anthropic API· αλλιώς fallback στο τοπικό `claude` CLI (Claude Code), χωρίς key.
- **Macro buttons** — π.χ. *Git Smart Commit*: αναλύει το output του προηγούμενου block (ή ένα fresh `git status`) και **προτείνει** την εντολή στο input field (ο χρήστης εγκρίνει & πατά Enter — όχι αυτόματη εκτέλεση).
- **Smart PR button** — ένα stateful κουμπί που οδηγεί ένα branch σε όλο τον κύκλο ζωής του PR: *Create → Check → Update → loop μέχρι merge*. Στο Update ο agent διαβάζει τα review comments, λύνει τα ζητούμενα και κάνει commit + push· το state (PR number + phase) κρατιέται per branch και persistάρεται. Χρειάζεται το `gh` CLI (authed).
- **Syntax highlighting** — τα code blocks renderάρονται με **Shiki** (theme *Material Palenight*).

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

- Node.js 18+, Rust 1.85+
- **Windows:** PowerShell 7 (`pwsh`) και τα [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2 + MSVC build tools)
- **macOS:** macOS 12+ με Xcode Command Line Tools (`xcode-select --install`). Το terminal τρέχει το login shell σου, **zsh** (προεπιλογή) ή **bash**· δουλεύει και το `pwsh` αν το έχεις.

## Setup & Run

```powershell
# Windows
npm install
# Προαιρετικό: $env:ANTHROPIC_API_KEY = "sk-ant-..."
# Χωρίς key, το sidebar χρησιμοποιεί αυτόματα το τοπικό `claude` CLI.
npm run tauri dev
```

```bash
# macOS
npm install
# Προαιρετικό: export ANTHROPIC_API_KEY="sk-ant-..."
npm run tauri dev
```

> **macOS Gatekeeper:** ένα unsigned `.app` εμφανίζεται ως «damaged» ή «unidentified developer». Δεξί κλικ → *Open* την πρώτη φορά, ή `xattr -dr com.apple.quarantine /Applications/OctoShell.app`.

## Σημειώσεις για macOS

- Το ίδιο OSC 133 shell integration που έχει το PowerShell στα Windows γίνεται inject σε zsh (μέσω `ZDOTDIR` shim που πρώτα φορτώνει το δικό σου `.zshrc`) και bash (`--rcfile`): command blocks, exit codes και cwd tracking δουλεύουν ίδια. Το prompt, τα aliases και τα plugins σου μένουν ως έχουν.
- Μια εφαρμογή που ανοίγει από το Finder/Dock παίρνει «γυμνό» PATH· το OctoShell υιοθετεί το PATH του login shell σου στην εκκίνηση, ώστε Homebrew, nvm/fnm και `~/.local/bin` εργαλεία (`claude`, `node`, `gh`) να βρίσκονται όπως στο Terminal.
- Tab completion: native (εντολές στο PATH + paths), όχι PowerShell runspace.
- Καθαρισμός διεργασιών: αντί για Job Object, κάθε dev server / agent τρέχει σε δικό του process group, οπότε το stop σκοτώνει όλο το δέντρο και η έξοδος τα μαζεύει όλα.
- Shortcuts με ⌘ αντί για Ctrl (⌘T, ⌘W, ⌘1–9, ⌘⇧K). Το Ctrl+C στο input παραμένει interrupt.

Πώς είναι οργανωμένο το platform layer (και πώς προστίθεται shell ή OS): [docs/platforms.md](docs/platforms.md).

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
- **Tab completion** προωθείται πλέον στο shell μέσω persistent pwsh runspace (`TabExpansion2`).
- Multi-tab projects υποστηρίζονται (ένα `ShellController` ανά project), με resizable panels.

## Σημειώσεις ασφάλειας

- Τα macros **δεν** εκτελούν αυτόματα — προτείνουν εντολή στο input για έγκριση.
- Το `run_capture` τρέχει με `-NoProfile -NonInteractive`. Μην του περνάς untrusted input χωρίς validation.
