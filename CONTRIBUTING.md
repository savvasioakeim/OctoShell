# Contributing to OctoShell

Thanks for your interest! OctoShell is a Windows-native Tauri app; contributions of all sizes are welcome.

## Contributor License Agreement (required)

Before your first pull request can be merged, you'll be asked to sign our
[Contributor License Agreement](CLA.md). You keep the copyright to your work; you
grant the maintainer a broad license (including the right to relicense) so the
project's licensing can stay under one owner. The CLA bot comments on your PR with
a one-line statement to post as your signature. It's a one-time step and applies
to your future contributions too.

## Dev setup

1. Install the prerequisites from the [README](README.md#prerequisites) (Node 18+, Rust 1.85+, Tauri deps, PowerShell 7).
2. `npm install`
3. `npm run tauri dev` — Vite hot-reloads the frontend; editing `src-tauri/` triggers a Rust rebuild + app restart.

## Checks before a PR

```powershell
npx tsc --noEmit          # frontend typecheck (must be clean)
cd src-tauri; cargo check # backend (must be clean, zero warnings)
```

There is no e2e suite yet — describe the manual verification you did in the PR (which flow you drove, what you saw).

## Where things live

| Area | Files |
|------|-------|
| Terminal blocks / PTY | `src/shell/ShellController.ts`, `src-tauri/src/pty.rs` |
| Orchestrator | `src/ai/AiSidebar.tsx`, `src-tauri/src/ai.rs` |
| Agents (claude/gemini native) | `src/agents/providers.ts`, `src-tauri/src/agent.rs` |
| ACP agents | `src/agents/providers.ts` (`ACP_AGENTS`), `src-tauri/src/acp.rs` |
| Review mode | `src/review/`, wiring in `AiSidebar.tsx` |
| Managed services | `src/services/`, `src-tauri/src/service.rs` |
| Docker sandbox | `src-tauri/src/docker.rs`, `acp.rs` (`docker_launch_args`) |
| Settings | `src/settings/` |

## Easy wins

- **Add an ACP agent**: one entry in `ACP_AGENTS` (launch command + optional model env + optional Docker image/login for sandboxing). Test that a prompt streams a reply.
- **Server detection**: add a regex to `src/services/serviceDetect.ts` for a framework whose dev command isn't recognised.
- **Port/banner parsing**: `service.rs::parse_port` covers common banners; PRs for frameworks it misses are welcome.

## Guidelines

- Match the existing style: comments explain *why*, not *what*; user-facing strings may be Greek or English (the UI is currently mixed — an i18n pass is a welcome project).
- Keep PRs focused — one fix/feature per PR.
- For bugs, include the repro flow (what you clicked/typed) — most of this app's bugs live in flows, not functions.

## Reporting issues

Open a GitHub issue with: OS version, how you launched (dev/build), what you did, what you expected, what happened. Screenshots of the relevant panel help a lot.
