# 🔧 Fix plan — code review findings (2026-07-02)

## Progress (session update)

- ✅ **#1** race condition + error-path leak (`docker.rs`) — re-check under lock + remove on the error path
- ✅ **#2** orphaned containers — labels + `cleanup_orphans()` at startup + `stop_all()` on exit
- ✅ **#3** honest threat-model doc + `cap_drop: ALL` + `no-new-privileges` + `SandboxOptions`
  (`network` default-on, `read_only` default-off) threaded through `create_container`/`exec`/`sandbox_exec`
- ✅ **#5** CSP in `tauri.conf.json`
- ✅ **#6** `max_tokens` 1024→8192 + default model → `claude-sonnet-5`
- ✅ **#7** shared-secret token on the approval bridge (constant-time check)
- ✅ **#8** port detection on stderr too (shared `AtomicU16`, first-hit-wins)
- ✅ **#9** cancel kills the process tree (`taskkill /T` on Windows)
- ✅ **#11 (copy)** honesty in 01/02, Windows caption buttons, no-key BYOK, absolute og:image, Tailwind note
- ✅ **#12 (part)** LICENSE (MIT)
- ✅ **#4** wired: the sandbox is no longer dead code — the real caller is ACP
  `terminal/*` (see #10 iteration 3a), with a global setting (`SandboxConfig`,
  default OFF) the orchestrator can change. The plain claude/gemini CLI runs its
  own bash and can't be intercepted — which is why the routing lands through ACP
  rather than as a toggle over the native path.
- 🔨 **#10** ACP — **v1 WIRED & COMPILING** (cargo + tsc green):
  - ✅ `acp.rs`: spawn agent (`AcpAgent::from_str`), initialize → new session →
    long-lived multi-prompt loop (`tokio::mpsc`); notifications → `agent://event`
    (serialized `SessionUpdate`); `agent://done` at the end. Commands `acp_send`/
    `acp_cancel` registered.
  - ✅ Frontend: `parseAcp` (SessionUpdate → NormEvent) in `providers.ts`, an "acp"
    provider (🔌) in the picker, `ShellController` branch → `acp_send`/`acp_cancel`,
    default command `cmd /c npx -y @agentclientprotocol/claude-agent-acp`.
  - ✅ **smoke test PASSED** — the user typed a prompt and the Claude ACP agent
    replied with streaming. API reconstruction confirmed end to end.
  - ✅ **provider + model selection** (like claude/gemini): `acp-claude` and
    `acp-gemini` are ordinary providers in the picker, each with its own model list.
    The model reaches the adapter with no backend change — `AcpAgent::from_str`
    parses a leading `ANTHROPIC_MODEL=…` (Claude) or a trailing `-m` (Gemini) out of
    the launch command (`acpCommandFor`). Changing provider/model terminates the
    current ACP session (the backend keys by id) so the next prompt respawns cleanly.
  - ✅ **iteration 2 (permission + terminal)** — cargo clean:
    - Permission: `ApprovalBridge` became Clone and gained an async path (tokio
      oneshot); the ACP permission handler asks the user through the existing
      `approval://request` flow and maps yes/no onto the agent's options.
      `approval_respond` resolves both maps (sidecar + ACP).
    - Terminal: advertise `client_capabilities.terminal = true`; a registry with
      create/output/wait/kill/release, host execution (tokio::process), output
      buffering + byte limit, always-notify-done (wait can never hang).
    - ➕ **9 providers**: Claude/Gemini native + ACP: Claude ✅, Codex, OpenCode,
      Cursor, Copilot, Kiro, Gemini (Enterprise). Antigravity pending ACP support.
  - ✅ **iteration 3** (cargo + tsc green — needs runtime testing):
    - (a) **terminal → docker swap**: `SandboxManager` gained `container_for`
      (factored out) plus `exec_capture` (a streaming callback instead of
      `sandbox://*` events). `acp.rs::create_terminal_sandboxed` runs the agent's
      command inside the worktree container (image `node:20`) when the global flag
      is ON; otherwise host exec (the default). Docker execs → pid=None (kill is a
      no-op; the container goes away on tab close). #3 ↔ #10 landed.
    - (b) **plan→trace**: `parseAcp` maps the ACP `plan` update (`entries` with
      status pending/in_progress/completed) → `NormEvent.steps`; `ShellController`
      replaces `agentProgress` wholesale. (ACP v1 has no standard token-usage
      update, so the meters stay on the native path.)
    - (c) **global sandbox setting**: `SandboxConfig` (AtomicBool) managed state +
      a `set_sandbox_enabled` command; `settingsStore.system.sandboxAgentCommands`
      (default OFF) pushes it to the backend (at startup and on change); a ToggleRow
      in the System tab. The orchestrator can change it through the command.
  - ✅ **iteration 4 — whole-adapter Docker sandboxing** (which in practice replaces
    3a): runtime testing showed the claude ACP adapter does NOT use the client
    terminal capability (it runs Bash internally through the Agent SDK) — so
    terminal→docker routing catches nothing with any current adapter. Solution: when
    the sandbox flag is ON and the provider has a `dockerImage`/`dockerCommand`
    (providers.ts), the ENTIRE adapter runs inside `docker run -i --rm --user node`
    (node:22, worktree bind-mounted at /app, session cwd=/app, shared volume
    `octoshell-claude-home` at /home/node for a single login plus npm cache,
    ANTHROPIC_API_KEY passthrough, caps dropped, memory/pids limits). Auth: a
    separate one-time login inside the volume (a button in Settings → System,
    provider-aware via `sandboxLoginCommandFor`) — NOT a mount of the host
    credentials (token rotation would log the host out). The terminal-capability
    path stays for adapters that eventually support it.
    🧪 Pending: the user needs to finish the one-time login and confirm `node -v`
    → v22 from inside a sandboxed ACP turn.
  - ✅ **bugfix pass 2026-07-08** (findings from the user's real-world use):
    orchestrator hang → `--strict-mcp-config` in ai.rs (a wedged global MCP server
    blocked `claude --print` forever); review fixes went missing when several items
    pointed at the same worktree (now one combined dispatch per tab + failure
    reporting + verdicts/notes in the chat context); service.rs respects `.env` PORT
    and corrects a wrong npm script against package.json; drag & drop works across
    the whole window; review window redesign.
  - ✅ **local models via Ollama** (`acp-ollama` provider): a new picker entry
    "Local · Ollama (ACP)" that runs `opencode acp -m ollama/<model>` — OpenCode
    keeps the agent loop / tool use and speaks ACP, while Ollama is the model
    backend (OpenAI-compatible `/v1` on localhost:11434). Model list: Qwen2.5-Coder
    14B/7B/3B + Gemma 3 4B (values prefixed with `ollama/`, gemini-style `-m`
    injection). **Verified end to end**: OpenCode loads config → resolves the ollama
    provider → streams through ai-sdk → pwsh shell tool. Key finding: tool calling
    requires a tool-capable model — gemma3:1b reports "does not support tools",
    qwen2.5-coder:3b emits tool calls but unreliably (too small); **qwen2.5-coder
    ≥7B is recommended** for dependable agentic tool use. Prerequisite: the user has
    OpenCode installed with an `ollama` provider in its config (a fair assumption —
    anyone running local LLMs already does). Not sandboxable (dockerImage null →
    host execution). Antigravity (`agy`): not added — plain-text `--print` only, no
    stream-json/ACP (waiting on #31).
  - ✅ **automated REVIEW AGENT + QA rename** (new feature, 6 phases, tsc + cargo clean):
    - **Rename** the existing Review window → **QA mode** (`src/qa/*`, `qa://`
      channels, `octo-qa` fence, window label `qa`, capability `qa.json`) — which
      frees up `review*`.
    - **Review agent** = a third role (alongside coding agent + orchestrator): it
      automatically reviews each coding agent's diff (with the orchestrator's task
      context) BEFORE QA.
    - Settings: global `reviewAgent {enabled, provider, model}` (checkbox + pickers).
    - `ReviewAgentController` (per session, PTY-less; its own agent-send id
      `review:<sid>`; reuses `parseAgentLine` and the Block types). Lifecycle: when
      an orchestrated coding turn finishes (and it's enabled) → `git diff` of the
      worktree (via the existing `run_capture`, zero Rust) + task context → review
      prompt → start. Verdict protocol (```octo-review-verdict {blocking,summary})
      parsed; `aggregateReviews` gates on it.
    - A second view in CenterPanel: switch Coding ⇄ Review (top right, visible only
      when active), pinned 2-line context (expand/collapse), a "Reviewer Active…"
      neon pulse, the review feed (reusing `Feed`), and an input that goes to the
      review agent (accent border + placeholder).
    - Event-driven handoff: when ALL review agents are idle and nothing is blocking →
      a `👁 (review agents)` ping tells the orchestrator to offer QA; blocking → hold
      (the user resolves it in the review view). The system prompt is gated so the
      orchestrator does NOT offer QA on its own while the review agent is on.
    - 🧪 Pending: a live end-to-end test (enable the review agent → orchestrated
      dispatch → check the review view, the verdict and the QA handoff).
- ⬜ **#11 (assets)** screenshots + self-healing GIF — these need real assets
- ✅ **#12 (everything except onboarding)** English README (the Greek one moved to
  README.el.md), CONTRIBUTING.md, releases workflow
  (`.github/workflows/release.yml`, tauri-action on version tags, draft release),
  a SmartScreen note in the README, and a security posture section
- ✅ **#12 (onboarding)** a first-launch health-check screen: a new
  `pty::health_check` command (using the existing `which()`) checks
  claude/gemini/node/gh/pwsh on PATH; `OnboardingOverlay.tsx` shows a checklist with
  ✓/✕, plus a why and an install command per tool. **No agent CLI is required on its
  own** — claude/gemini/node (= ACP providers via npx) count as alternative
  `agentOption`s, and only ONE has to pass; pwsh remains the only genuinely required
  item (the default shell), gh is optional. "Continue anyway" if something is
  missing; a persisted `octoshell.onboardingDone` flag (localStorage) shows it only
  once, before the StartupOverlay.
- ⬜ **#13** promotion sequence

**Verify:** `cargo check` clean (exit 0, zero warnings) after each group of changes.

---

These findings came out of a full pass over the codebase (`cargo check` and
`tsc --noEmit` both pass cleanly — everything below is a design or security issue,
not a compile error). Order: first whatever must be resolved **before `docker.rs` is
committed**, then the rest.

---

## 1. `docker.rs` — race condition when creating a container ⚠️ BLOCKER

**Problem** (`SandboxManager::exec`, around lines 276–287): two concurrent
`sandbox_exec` calls for the same worktree both see `None` in the map, both create a
container, and the second `insert` overwrites the first. The first container stays
alive forever (running `tail -f /dev/null`) with nobody holding its id.

**Fix — a per-worktree async mutex instead of a map of ids:**

- Change the registry to `HashMap<String, Arc<tokio::sync::Mutex<Option<String>>>>`
  (worktree → a lock around the container id). The outer std `Mutex` is held only
  long enough to fetch or create the entry (never across an await), then you do
  `entry.lock().await` — so a second caller for the same worktree **waits** for the
  first instead of building its own container.
- Alternatively (a smaller change but not a complete fix): after `create_container`,
  re-lock the map; if another id landed for the same worktree in the meantime,
  `remove_container` the one you just built and use the existing one. (Simpler, but
  you pay for a pointless create/start.)
- Note: execs on the same container are logically serialized anyway (the self-healing
  loop), so the lock costs nothing in practice.

**Also at the same spot — an error-path leak** (lines ~305–313): when
`exec_in_container` fails, the code removes the id from the map but does **not**
remove the container from Docker. If the container is still alive (e.g. the error was
a transient stream problem), it leaks. Fix: on the error path also call
`remove_container(&docker, &container_id).await` (best effort) before returning the
`Err`.

---

## 2. `docker.rs` — orphaned containers after a crash or exit ⚠️ BLOCKER

**Problem:** the Job Object (`jobctl.rs`) kills local processes, but containers live
**in the Docker daemon** — they are not children of OctoShell. If the app crashes,
hot-reloads, or simply closes without a `sandbox_stop` per worktree, the sleeping
containers stay forever and pile up.

**Fix — labels plus cleanup at startup:**

1. In `create_container`, add labels to the `Config`:
   ```rust
   labels: Some(HashMap::from([
       ("app.octoshell.sandbox".to_string(), "1".to_string()),
       ("app.octoshell.worktree".to_string(), worktree_path.to_string()),
   ])),
   ```
2. A new `cleanup_orphans()` function: `list_containers` filtered by
   `label=app.octoshell.sandbox`, force-removing whatever it finds. Call it once from
   `setup` in `lib.rs` (inside `tauri::async_runtime::spawn`, best effort — if the
   daemon isn't running, just return).
3. Optional safety net: in the Tauri builder's `run()`, on `RunEvent::Exit`, call
   `SandboxManager::stop_all()` (drain the map and remove every container). The
   startup cleanup is still necessary, because the Exit event doesn't run on a crash.

The label also solves debugging: `docker ps --filter label=app.octoshell.sandbox`
shows immediately what the app is holding open.

---

## 3. `docker.rs` — the sandbox promises more than it delivers ⚠️ DECISION + IMPLEMENTATION

**Problem:** the module doc says it protects against "`rm -rf` or a malicious
dependency", but:

- The bind mount is **read-write** → `rm -rf /app` destroys the worktree for real.
- The container has **full network access** → a malicious dependency can exfiltrate
  anything in the worktree (`.env`, credentials).
- The CPU/RAM/PID limits only cover the "runaway" case (infinite loop, fork bomb).

**Fix — two steps:**

1. **Correct the doc comment now** so it tells the truth: the sandbox protects the
   *host* (resources, the filesystem outside the worktree), **not** the worktree, and
   not against exfiltration. A false sense of security is worse than none.
2. **Add knobs** to `create_container` (new parameters or a `SandboxOptions` struct)
   and thread them through `sandbox_exec`:
   - `network: bool` → when false, `network_mode: Some("none")` in `HostConfig`.
     A useful default for `npm test`/`cargo build` **after** the install (install
     needs the network — hence a knob rather than a hardcoded value).
   - `read_only_mount: bool` → `Mount { read_only: Some(true), .. }` for purely
     read-only steps (lint, typecheck).
   - `cap_drop: Some(vec!["ALL".into()])` and
     `security_opt: Some(vec!["no-new-privileges".into()])` can safely be defaults.

---

## 4. `docker.rs` — nothing calls it ℹ️ DECISION

`sandbox_exec`/`sandbox_stop` are registered in `lib.rs`, but no part of the frontend
calls them and nobody listens for `sandbox://log`/`sandbox://exit`.

**Options:**
- If it's WIP: keep it in the working tree or on a branch until it's wired to the UI
  (e.g. a "Run agent commands in Docker" toggle in Settings plus wiring at the point
  where the agent executes commands). Don't merge it to main as dead code.
- If it gets wired: the natural place is the approval flow or a per-project setting;
  `sandbox_stop(worktree)` must be called when a project tab closes (next to
  `close_tab`/`forget`).

---

## 5. `tauri.conf.json` — `csp: null` 🔒

**Problem:** the app renders HTML derived from terminal output and agent output
(frozen blocks via `ansiToHtml`, Markdown). The escaping in `ansi.ts` is correct, but
it is the **only** wall — without a CSP, one bug there or in the Markdown rendering
becomes XSS with access to the Tauri IPC.

**Fix:** set a CSP in `app.security.csp`, e.g.:

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost"
```

- `style-src 'unsafe-inline'` is needed because `ansiToHtml` writes inline styles (and
  so does xterm). To tighten it later: Tauri supports automatic nonce/hash only for
  what it injects itself — our own inline styles need `'unsafe-inline'`.
- Test afterwards: frozen output with colours, images in Markdown, the SFX (if they
  load from the asset protocol, add `asset:`/`http://asset.localhost` to
  `img-src`/`media-src`), and the review window.

---

## 6. `ai.rs` — `max_tokens: 1024` and an old default model 📏

- **`max_tokens`:** 1024 tokens silently truncate long replies on the API path (the
  user sees half an answer with no explanation). Raise it to 4096–8192. (The CLI path
  has no such limit — which is why this only shows up with `ANTHROPIC_API_KEY`.)
- **Model:** `claude-sonnet-4-6` is valid but a generation behind; the newer sonnet is
  `claude-sonnet-5`. Ideally make the default configurable from Settings (there's
  already a model picker for the agents — it could feed the sidebar too).
- Optional: when the API returns `stop_reason: "max_tokens"`, show a "response was
  truncated" marker instead of letting it look complete.

---

## 7. `approval.rs` — TCP bridge without authentication 🔒 (low risk)

**Problem:** the bridge listens on `127.0.0.1:<random port>` with no secret. Any local
process can connect and show a **fake** approval prompt in the UI (spoofing / social
engineering — it can't auto-approve, that only happens through the UI).

**Fix:** a shared token:
1. In `ApprovalBridge::start`, generate a random token (e.g. 32 hex chars) and keep it
   in state.
2. Pass it to the sidecar through the environment (`OCTO_TOKEN`, next to `OCTO_PORT`
   in `agent.rs`).
3. The sidecar sends it as a field in the JSON request; `handle_conn` silently rejects
   requests with a wrong or missing token.

---

## 8. `service.rs` — port detection only on stdout 🐛 (minor)

**Problem:** `spawn_log_reader` for stderr is called with `detect_port=false`, even
though the comment above it says "many dev servers print their banner there". A server
that prints its URL only on stderr never gets port refinement.

**Fix:** "first hit wins" has to be shared between the two streams: an
`Arc<AtomicBool>` (`port_detected`) shared by the stdout and stderr readers; whichever
finds a URL first emits and flips the flag. That enables detection on stderr without
duplicate `service://ready` events.

---

## 9. `agent.rs` — cancel leaves the agent's children alive 🧹 (minor)

**Problem:** `child.kill()` only kills `claude.exe`; its children (the node MCP
sidecar, whatever Bash was running) stay alive until the app closes (at which point
the job object kills them). With enough cancels, processes accumulate.

**Fix (Windows):** instead of one global job, put each agent run in **its own** job
object: `jobctl` gains `create_child_job() -> HANDLE`, `add_to(job, pid)` and
`kill_job(job)` (TerminateJobObject). `AgentManager` holds `(Child, JobHandle)` and
cancel calls `kill_job`. Nested jobs are supported on Windows 8+, so the global
kill-on-close job keeps working as a safety net. Alternatively, a quick fix with no
new API: `taskkill /T /F /PID <pid>` before `kill()`.

---

## 10. ACP (Agent Client Protocol) integration 🚀 NEW FEATURE

ACP (the protocol Zed started — Apache 2.0, now under its own `agentclientprotocol`
organisation on GitHub) standardises client ↔ coding-agent communication: JSON-RPC
over stdio, with shared messages for streaming, sessions/resume, plans/tasks and
**permission requests**. 25+ agents support it (Claude Code through an official
adapter, Gemini CLI natively, Codex, Copilot CLI, OpenCode, Goose…), and Zed,
JetBrains, VS Code and Neovim act as clients.

**Why:** one implementation replaces the per-provider integrations. Everything that's
hand-rolled per CLI today (stream parsing in `providers.ts`, the approval bridge, task
protocol injection, resume quirks) becomes shared code; all that's left per provider
is the launch line. It also fixes the fragility of `--output-format stream-json` (an
unofficial format) and the uneven Claude/gemini feature matrix.

**Implementation plan (incremental, breaking nothing existing):**

1. **Backend — a new `src-tauri/src/acp.rs`** using the official
   [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol) crate:
   - `AcpManager` (same pattern as `AgentManager`): spawn the agent process
     (per-provider command line from config), JSON-RPC over stdio.
   - Implement the ACP `Client` trait: session updates (text, thinking, tool calls,
     diffs, plan entries) are emitted as the same Tauri events the frontend already
     listens to (`agent://event` with a normalized payload, or a new `acp://update`).
   - The protocol's `requestPermission` hooks into the existing
     `approval://request`/`approval_respond` flow — **no** MCP sidecar and TCP bridge
     for ACP agents (long term, that makes #7 moot for most providers).
   - ACP plans/tasks feed the trace progress bar directly — which removes the
     STEP_PROTOCOL prompt injection for ACP agents.
2. **Frontend:** ACP becomes a third "provider" in `providers.ts` / `agents/`. Because
   the events already arrive normalized from Rust, its parser is almost a passthrough.
   In the UI the user picks an agent from a list (hardcoded at first: Claude via
   `npx @agentclientprotocol/claude-agent-acp`, `gemini --experimental-acp`, Codex…)
   with the usual Windows shim handling (`cmd /c npx ...`, as gemini does today).
3. **Capability negotiation → UI:** anything an agent doesn't support (e.g. resume) is
   hidden or disabled explicitly from the initialize capabilities, not with a
   per-provider if.
4. **Later — ACP Registry:** pull the agent catalogue from the registry
   (machine-readable install/launch metadata) so new providers can be added without
   code changes.
5. **Migration:** the existing claude/gemini paths stay as they are until the ACP path
   proves equivalent in daily use; then they become the fallback.

**First-phase deliverable:** a project tab running an agent over ACP with streaming
blocks, approvals and progress — even if only for one agent.

### 🔒 Locked architecture & build spec (confirmed ACP terminal capability)

**The key:** in ACP the **CLIENT** (OctoShell) executes terminal commands on the
agent's behalf. The agent sends `terminal/create {command,args,cwd,env,
outputByteLimit}` → the client runs the command and returns a `terminalId` →
`terminal/output {output,truncated,exitStatus}` / `terminal/wait_for_exit
{exitCode,signal}` / `terminal/kill` / `terminal/release`. The client MUST advertise
the `terminal` capability in `initialize.clientCapabilities`.

**Consequence — this solves the #4 interception problem:** the plain `claude`/`gemini`
CLI runs its own bash that OctoShell can't see; but an **ACP agent** asks OctoShell to
run every command. So OctoShell implements `terminal/create` **through `sandbox_exec`**
(docker) when the sandbox setting is ON → **transparent sandboxing of the agent's
commands**, which is impossible in today's model.

**✅ Locked, real API** (crate `agent-client-protocol` v1.0.1, edition 2024, requires
rustc ≥1.85 — we have 1.94; builder-based, tokio async). Taken from the official
`yolo_one_shot_client.rs` example — THAT is the ground truth, not the docs.rs summary:

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
            // → approval bridge; responder.respond(RequestPermissionResponse::new(
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

**Two open questions to resolve at write time (fetch from docs.rs/schema):**
- The variants of `SessionNotification.update` (AgentMessageChunk/AgentThoughtChunk/
  ToolCall/ToolCallUpdate/Plan/…) for the mapping to blocks. The skeleton can start
  with `{:?}` and be refined afterwards.
- The terminal request types (CreateTerminal/TerminalOutput/…) for a second
  `on_receive_request` handler → `SandboxManager`.

**Long-lived session (NOT one-shot as in the example):** the `connect_with` closure
has to STAY alive: inside it, after NewSession, run
`loop { recv prompt from tokio::mpsc; send PromptRequest }`. `AcpManager` keeps the
per-session `mpsc::Sender<String>` so it can feed prompts from an `agent_send`-style
command, plus a cancel handle.

**Build spec (in order):**
1. ✅ `Cargo.toml`: `agent-client-protocol = "1"` (v1.0.1) + `tokio`. **DONE &
   VERIFIED** — `cargo check` clean in 1m16s, exit 0, no conflict with
   tauri/bollard/edition 2024 (rustc 1.94). The dependency is viable.
   Next (step 2): write the `acp.rs` skeleton (spawn + builder + one-shot prompt →
   `agent://event`), compile, then long-lived session + permission + terminal→sandbox.
2. `acp.rs`: `AcpManager` (a registry per session). Spawn the agent process
   (per-provider command line, e.g.
   `cmd /c npx @agentclientprotocol/claude-agent-acp`), JSON-RPC over the child's
   stdin/stdout.
3. Implement the ACP `Client` trait:
   - `session/update` notifications (text, thinking, tool calls, plan/tasks, diffs)
     → emitted as the existing `agent://event`/normalized events the frontend listens
     for.
   - `session/request_permission` → hooked into the existing `approval://request` /
     `approval_respond` flow (which makes the MCP sidecar/bridge unnecessary for ACP
     agents).
   - **`terminal/*` → `SandboxManager` when the sandbox is ON, otherwise host exec**
     (portable_pty or a captured subprocess). `SandboxManager::exec` and the
     `SandboxEvent` stream already fit `terminal/output` streaming — reuse them.
   - `terminal` + `fs` capabilities in `initialize`.
4. Frontend: ACP as a third provider in `providers.ts`/`agents/`. A global sandbox
   setting in `settingsStore` (default ON) that passes network/read_only into the
   `terminal/*` routing; the orchestrator can toggle it.
5. Capability negotiation → UI: hide whatever the agent doesn't support (e.g. resume).
6. Test: manual `npm run tauri dev` with a real ACP agent (a feedback loop with the
   user — this doesn't run end to end in CI here).

---

## 11. Landing page (`docs/index.html`) 🎨

The foundation is launch-ready (the PCB trace concept ties into the in-app trace bar,
the 01–06 → principles → FAQ structure is right, the FAQ copy is very good).
Corrections:

1. **How the promise is worded (01/02):** the "tickets → worktrees → tests → PRs" flow
   exists, but through a command to the orchestrator — not fully automatically from
   the app. Rewrite the copy so the user is visibly in the loop:
   - Hero prompt: leave it as is (it's a user command — fine), but in 01 change
     "automatically fans it out" to something like "hand your tickets to the
     orchestrator and it fans them out…".
   - Section 02: "Every single agent gets its own isolated Git worktree
     **automatically**" → "Point the orchestrator at your tickets and each agent works
     in its own isolated Git worktree" (or similar — the key point: you give the
     command, it does the work).
2. **Windows caption buttons in the mockup:** the title bar has macOS traffic lights
   (● ● ●) in a product that says "Native for Windows" — change them to ─ ▢ ✕.
3. **BYOK copy:** add and highlight that it works WITHOUT an API key too, using an
   existing Claude Code / Gemini CLI subscription — a stronger selling point than
   plain BYOK. (The FAQ already says this correctly; it should be raised into the
   hero/pillar.)
4. **Production hygiene:**
   - Replace `cdn.tailwindcss.com` with static/built CSS (console warning, slow, not
     for production).
   - `og:image` with an **absolute** URL (social previews don't work with a relative
     one).
   - The X/Twitter link points at plain `x.com` — use a real profile or remove it.
   - Confirm the GitHub URL (`savvasioakeim/OctoShell`) is final — it's hardcoded in
     ~6 places.
5. **Content:** the 6 placeholders need real screenshots, and section 06 needs a demo
   GIF of the self-healing loop (test fails → fix → pass) — that GIF is the single
   most important asset on the whole page.

---

## 12. Open source launch checklist 📦

What's needed for the repo to open AND for people to adopt it (beyond fixes #1–#5).
No new features are needed before launch — ACP (#10) is post-launch.

- [ ] **LICENSE file (MIT)** — the page already promises it twice; without the file
      the repo isn't formally open source.
- [ ] **English README** with screenshots (the Greek one stays as `README.el.md`).
      Target audience: Windows devs worldwide.
- [ ] **Releases pipeline:** a GitHub Actions workflow (tauri-action) for builds and
      release artifacts. The page's "Download for Windows (.exe)" button has to point
      at a real release.
- [ ] **SmartScreen:** an unsigned .exe means "Windows protected your PC" for most
      users. In order of cost: (a) instructions in the README, (b) a winget package,
      (c) a code signing certificate.
- [ ] **The first ten minutes:** friendly, guiding messages when the `claude` CLI,
      `gh`, or pwsh 7 is missing — that's where 80% of first-time users trip. Ideally
      an onboarding/health-check screen on first launch.
- [ ] **Document the security posture:** the app runs agents with
      `--dangerously-skip-permissions` when approval mode is off — say so explicitly
      in the README (what it means, how to turn approvals on).
- [ ] **CONTRIBUTING.md + issue templates** — so the community can help (especially
      with #10/ACP adapters later).
- [ ] **Align the page with the app** (#11.1) before sharing it anywhere (HN/Reddit):
      a gap between promise and reality always becomes the top comment.

---

## 13. Launch / promotion sequence 📣

Runs ONLY after #12 is closed — you get one shot: if attention arrives at a repo with
a broken installer or placeholder screenshots, it doesn't come back. The order
matters; each step feeds the next.

1. **Demo GIF — the asset that makes everything else work.**
   The self-healing loop in ~20 seconds: test fails → the agent reads the error →
   fixes the file → re-runs the tests → green. A second GIF (optional): orchestrator
   fan-out — "I hand over tickets, N agents open, I watch the traces". It goes in: the
   README (first thing), the landing page (#11.5), and every post below.
2. **Show HN** — Tuesday–Thursday morning, US East time. A title along the lines of
   "Show HN: OctoShell – open-source mission control for coding agents,
   Windows-native". "Windows-native" IN the title — that's the rare part, the hook.
   Post the first comment yourself: why you built it, what it does today, what it
   doesn't do yet (honesty about the limits is the best thing you can bring to an HN
   audience).
3. **Reddit:** r/rust and r/tauri (the ecosystem loves showcase projects and is
   generous with stars), r/ClaudeAI, r/programming. One post at a time, adapted to the
   audience — not copy-paste.
4. **Tauri showcase** — a strong chance of being featured: the Tauri team actively
   promotes serious projects as proof of the framework. Likewise: awesome-tauri,
   awesome-agent-orchestrators lists (open a PR with the project).
5. **Targeted mentions — after the above, not before.** No cold spam; one X post with
   the GIF and a natural mention, or a reply in a relevant thread of theirs: people in
   the Windows dev community who surface Windows dev tools as part of their work, the
   Windows Terminal team, Tauri core. Zero cost, small but non-negligible odds — and
   the repo will be ready if it lands.
6. **Technical posts (1–2 weeks after launch, to keep momentum):** "Parsing OSC 133
   semantic prompts on Windows ConPTY" and "Kill-on-close Job Objects: no more
   orphaned processes". Post them to HN/r/rust separately — a second and third wave of
   attention, and a career asset at the same time (proof of depth, useful in
   interviews).
7. **After the first wave:** GitHub Sponsors live from day one (it costs nothing),
   answer EVERY issue in the first weeks (maintainer responsiveness is the number one
   health signal for a project), and pin a set of "good first issue"s for
   contributors.

**Don't** build expectations around "X will notice me" — design so that if they do
notice, the repo wins them over. The influencer boost is the second domino; the first
is always GIF + Show HN.

---

## Suggested order of work

| Step | What | Why it comes first |
|------|------|--------------------|
| 1 | #1 + #2 (docker leaks) | They block committing `docker.rs` |
| 2 | #3 (sandbox honesty/knobs) | Same file, one pass; it defines what you're promising |
| 3 | #4 (wiring or branch) | A product decision before the merge |
| 4 | #5 (CSP) + #7 (bridge token) | Security, independent small PRs |
| 5 | #6 (max_tokens/model) | A 10-minute change with a visible benefit |
| 6 | #8, #9 | Nice-to-have tidiness |
| 7 | #12 (launch checklist) + #11 (landing) | Everything needed to open publicly — LICENSE/README/releases in parallel with the above, and the copy alignment before any announcement |
| 8 | #13 (launch sequence) | Runs only with #12 closed — GIF → Show HN → Reddit → showcase → mentions → posts |
| 9 | #10 (ACP) | The strategically most important new feature — post-launch; long term it simplifies or replaces #7 and STEP_PROTOCOL |

Every step is an independent commit — no big-bang change is needed anywhere.
