# 🐙 OctoShell

**Mission control for coding agents — for Windows and macOS.**

OctoShell is a power-user terminal workspace where an AI **orchestrator** fans your tickets out to multiple coding agents, each working in its **own isolated git worktree**, while you watch every terminal, agent trace, and dev server from one window.

Built with **Tauri v2 + Rust** (backend) and **React + TypeScript + Tailwind + xterm.js/WebGL** (frontend).

> 🇬🇷 Ελληνικά: [README.el.md](README.el.md)

## What it does

- **Orchestrator sidebar** — a workspace-wide AI assistant that sees every open project (terminal blocks, agent reports). Ask it to coordinate work: it proposes `dispatch` actions (confirm-per-click or fully autonomous), creates a **git worktree per task**, and follows each agent to completion with **live watch**.
- **Agents per project/worktree** — Claude Code and Gemini CLI natively, plus **any ACP agent** (Agent Client Protocol: Claude, Gemini, Codex, OpenCode, Cursor, Copilot, Kiro) over one protocol integration. Per-project provider, model, profile and approval mode.
- **Review Mode** — when dispatched features are done, a floating always-on-top window walks you through them one by one: start their dev servers with one click, take notes, approve/decline. Declines are batched back to the right worktree's agent as fix tasks.
- **Managed dev servers** — server commands (`npm run dev`, `vite`, `uvicorn`…) run as managed services with their own port and logs instead of wedging a shell or an agent turn. Respects your project's `.env` `PORT`, validates npm scripts against `package.json`, and detects the actually-bound URL.
- **Docker sandbox (opt-in)** — run an entire ACP agent inside a throwaway container (`--cap-drop=ALL`, memory/pids limits, worktree bind-mounted) with a shared login volume, so one login covers every worktree. Host isolation for every command the agent runs.
- **Semantic Blocks terminal** — the terminal is a feed of self-contained command blocks (à la Warp), driven by OSC 133 shell integration parsed in Rust: exact command boundaries and exit codes, no prompt regex. One shared WebGL xterm renders the live block; finished output freezes into colored, selectable HTML.
- **Agent trace bar** — each agent's plan/steps render as a live PCB-trace progress bar across the top of its project.
- **Smart PR button** — drives a branch through the full PR lifecycle: *Create → Check → Update → loop until merge*, with the agent resolving review comments on Update. Needs an authed `gh` CLI.
- **Everything is local** — your API key (optional) stays in the Rust backend; without one, agents and the orchestrator reuse your existing Claude Code / Gemini CLI subscription login. No key required.

## Prerequisites

**Windows**
- Windows 10/11 with **PowerShell 7** (`pwsh`)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2 + MSVC build tools)

**macOS**
- macOS 12+ with Xcode Command Line Tools (`xcode-select --install`)
- The terminal runs your login shell: **zsh** (default) or **bash**; `pwsh` works too if installed

**Both**
- **Node.js 18+**, **Rust 1.85+**
- For agents: [Claude Code](https://claude.com/claude-code) (`claude`) and/or Gemini CLI on PATH — or any ACP agent CLI
- Optional: `gh` CLI (Smart PR), Docker Desktop (sandbox), `cloudflared` (phone companion over the internet)

## Setup & Run

```powershell
# Windows
npm install
# Optional: $env:ANTHROPIC_API_KEY = "sk-ant-..."
# Without a key, agents & orchestrator use your local `claude` CLI login.
npm run tauri dev
```

```bash
# macOS
npm install
# Optional: export ANTHROPIC_API_KEY="sk-ant-..."
npm run tauri dev
```

Release build: `npm run tauri build` (Windows: NSIS installer, macOS: `.app` + `.dmg`, under `src-tauri/target/release/bundle/`).

> **Windows SmartScreen:** unsigned builds trigger "Windows protected your PC" — click *More info → Run anyway*, or build from source.
>
> **macOS Gatekeeper:** an unsigned `.app` is blocked as "damaged" or "from an unidentified developer". Right-click → *Open* once, or clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/OctoShell.app`. Or build from source.

## macOS notes

- **Shell integration for zsh and bash.** The same OSC 133 command markers that PowerShell emits on Windows are injected into zsh (via a `ZDOTDIR` shim that first sources your own `.zshrc`) and bash (via `--rcfile`), so command blocks, exit codes and cwd tracking work identically. Your prompt, aliases and plugins are untouched.
- **PATH.** An app launched from Finder or the Dock normally gets a bare PATH. OctoShell adopts your login shell's PATH at startup, so Homebrew, nvm/fnm and `~/.local/bin` tools (`claude`, `node`, `gh`) are found just like in Terminal.
- **Tab completion** is served natively (commands on PATH + file paths) instead of by a PowerShell runspace.
- **Process cleanup.** Windows ties every child to a Job Object; on macOS each dev server and agent runs in its own process group, so stopping one ends its whole tree, and a clean exit sweeps them all.
- **Shortcuts** use ⌘ instead of Ctrl (⌘T new project, ⌘W close project, ⌘1–9 switch, ⌘⇧K clear). Ctrl+C in the input still interrupts the running command.
- **Worktree dependency copies** use APFS clones (`cp -c`), so copying a large `node_modules` into a new worktree is instant.

How the platform layer is organised (and how to add a shell or an OS): [docs/platforms.md](docs/platforms.md).

## Architecture (short version)

```
Frontend (React/Vite)                          Backend (Rust)
─────────────────────                          ──────────────
InputBar ──submit──► ShellController ──write──► pty.rs    PtyManager (pwsh / zsh / bash + OSC 133 injection)
   Feed ◄── snapshot ─────┤◄── pty://events ──            SemanticParser (command boundaries/exit codes)
AiSidebar ──ai_chat──────────────────────────► ai.rs      orchestrator (Anthropic API or claude CLI)
ShellController ──agent_send/acp_send────────► agent.rs   claude/gemini stream-json
                                               acp.rs     any ACP agent (JSON-RPC over stdio)
serviceStore ──service_start─────────────────► service.rs managed dev servers (port alloc, log stream)
                                               docker.rs  sandbox containers (bollard)
```

All child processes are tied to a kill-on-close Windows Job Object, or to per-child process groups on macOS/Linux (`jobctl.rs`, `platform.rs`) — closing OctoShell never orphans a shell, agent, or dev server.

## Security posture — read this

- With approval mode **off** (the default "⚡ Auto"), agents run with `--dangerously-skip-permissions`: they can execute any command in your project without asking. Flip the per-project **🛡 Approve** toggle to review Bash/Edit/Write calls before they run.
- Orchestrator actions are confirm-per-click unless you enable **🔓 Auto**; a session **spend limit** (Settings) halts everything when hit.
- The Docker sandbox isolates the **host** from agent commands (resources, filesystem outside the worktree). It does **not** protect the worktree itself or prevent network exfiltration — the mounted worktree is read-write and networking is on (npm installs need it).
- Macros never auto-execute — they propose a command in the input for you to approve.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first areas: ACP agent definitions (`src/agents/providers.ts`), service detection patterns, translations.

## License

[MIT](LICENSE)
