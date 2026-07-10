//! Optional Docker sandbox for agent commands.
//!
//! By default an agent's shell command (`npm test`, `cargo build`, …) runs
//! natively on the host. That's fast, but it trusts the agent. This module
//! offers an alternative execution path: run the command inside a throwaway
//! Docker container that bind-mounts ONLY the agent's git worktree at `/app`,
//! with capped CPU/RAM/PIDs and dropped capabilities.
//!
//! Threat model — what this DOES and does NOT protect:
//!   * Protects the HOST: a runaway (infinite loop, fork bomb) can't exhaust the
//!     host's CPU/RAM/PIDs, and the container can't touch host files outside the
//!     mounted worktree.
//!   * Does NOT protect the worktree itself: the mount is read-write, so a
//!     `rm -rf /app` still destroys the worktree (that's the agent's own repo —
//!     by design it must be able to edit it).
//!   * Does NOT stop exfiltration by default: the container has full network
//!     access, so a malicious dependency can still phone home with anything in
//!     the worktree (e.g. a committed `.env`). A future `network` knob
//!     (`network_mode: "none"`) is the mitigation for post-install steps.
//! In short: this is host isolation, not a security sandbox for untrusted code.
//!
//! Two entry points:
//!   * [`run_in_sandbox`] — a self-contained, one-shot function (create → exec →
//!     stream → remove). This is the production function: it streams stdout/
//!     stderr through a caller callback in real time and returns the combined
//!     output. The exec's exit code is delivered to the callback as a final
//!     `SandboxEvent::Exit` so the agent can tell pass from fail.
//!   * [`SandboxManager`] — the app-wired path. Reuses one long-lived container
//!     per worktree (session) across many commands for speed, emits
//!     `sandbox://log` / `sandbox://exit` Tauri events (mirroring `service.rs`),
//!     and exposes `sandbox_exec` / `sandbox_stop` commands.
//!
//! Requires a running local Docker daemon (Docker Desktop on Windows connects
//! over the `//./pipe/docker_engine` named pipe, handled by Bollard's local
//! defaults). If Docker isn't up, callers get a clean, explanatory error and can
//! fall back to native execution.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, LogOutput, RemoveContainerOptions,
    StartContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, Mount, MountTypeEnum};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Where the worktree is mounted inside the container; commands run from here.
const WORKDIR: &str = "/app";

/// Docker label stamped on every sandbox container, so startup cleanup can find
/// and remove orphans left behind by a crash/hot-reload.
const SANDBOX_LABEL: &str = "app.octoshell.sandbox";

/// A real-time event from a sandboxed run, handed to the streaming callback.
pub enum SandboxEvent<'a> {
    /// A chunk of process output (`stderr` = true for the error stream).
    Log { line: &'a str, stderr: bool },
    /// The command finished with this exit code (0 = success).
    Exit { code: i64 },
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Per-run sandbox knobs. Baked into the container at creation (a reused session
/// container keeps the options from its first `exec`).
#[derive(Clone, Copy)]
pub struct SandboxOptions {
    /// Give the container network access. Default true — installs/builds need it;
    /// set false to block worktree exfiltration on offline steps (`npm test`).
    pub network: bool,
    /// Mount the worktree read-only (lint/typecheck steps). Default false.
    pub read_only: bool,
}

impl Default for SandboxOptions {
    fn default() -> Self {
        Self { network: true, read_only: false }
    }
}

/// Connect to the local Docker daemon and verify it's actually up.
///
/// `connect_with_local_defaults` picks the right transport per platform (named
/// pipe on Windows, unix socket elsewhere); `ping` turns a daemon that's
/// installed-but-not-running into a clear error instead of a later timeout.
async fn connect() -> Result<Docker, BoxError> {
    let docker = Docker::connect_with_local_defaults()
        .map_err(|e| format!("could not reach the Docker daemon (is Docker Desktop running?): {e}"))?;
    docker
        .ping()
        .await
        .map_err(|e| format!("Docker daemon is not responding (is Docker Desktop running?): {e}"))?;
    Ok(docker)
}

/// Pull `image` if it isn't present locally, so the first run on a fresh machine
/// doesn't fail with "no such image". No-op when the image already exists.
async fn ensure_image(docker: &Docker, image: &str) -> Result<(), BoxError> {
    if docker.inspect_image(image).await.is_ok() {
        return Ok(());
    }
    let opts = CreateImageOptions {
        from_image: image.to_string(),
        ..Default::default()
    };
    let mut stream = docker.create_image(Some(opts), None, None);
    // Drain the pull progress; surface the first failure (bad tag, no network…).
    while let Some(item) = stream.next().await {
        item.map_err(|e| format!("failed to pull image `{image}`: {e}"))?;
    }
    Ok(())
}

/// Create and start a sleeping container bound to `worktree_path` → `/app`, with
/// guardrails so untrusted code can't exhaust the host. Returns the container id.
///
/// The container runs `tail -f /dev/null` (portable across node/python/alpine)
/// purely to stay alive; the real work happens via `exec` calls into it.
async fn create_container(
    docker: &Docker,
    worktree_path: &str,
    image: &str,
    name: Option<&str>,
    opts: SandboxOptions,
) -> Result<String, BoxError> {
    ensure_image(docker, image).await?;

    let host_config = HostConfig {
        // Bind-mount the worktree. Using a Mount (rather than the "src:dst" binds
        // string) sidesteps the Windows drive-letter colon clashing with the
        // host:container separator (e.g. C:\work\wt → /app).
        mounts: Some(vec![Mount {
            target: Some(WORKDIR.to_string()),
            source: Some(worktree_path.to_string()),
            typ: Some(MountTypeEnum::BIND),
            // When read_only, the agent can't modify the worktree (lint/typecheck
            // steps). Off by default (build/test usually write).
            read_only: Some(opts.read_only),
            ..Default::default()
        }]),
        // Cut the container off the network when the caller opts out — the
        // mitigation for a malicious dependency exfiltrating the worktree. `None`
        // (network on) is the default: installs and most builds need it.
        network_mode: (!opts.network).then(|| "none".to_string()),
        // Guardrails against runaway/untrusted code eating the host:
        memory: Some(2 * 1024 * 1024 * 1024), // 2 GiB hard cap
        nano_cpus: Some(2_000_000_000),       // ~2 CPUs
        pids_limit: Some(512),                // fork-bomb ceiling
        // Drop all Linux capabilities and block privilege escalation — free,
        // safe-by-default hardening (the workloads we run — build/test — need
        // neither). Reduces the blast radius if untrusted code runs.
        cap_drop: Some(vec!["ALL".to_string()]),
        security_opt: Some(vec!["no-new-privileges".to_string()]),
        ..Default::default()
    };

    let config = Config {
        image: Some(image.to_string()),
        working_dir: Some(WORKDIR.to_string()),
        cmd: Some(vec!["tail".to_string(), "-f".to_string(), "/dev/null".to_string()]),
        host_config: Some(host_config),
        tty: Some(false),
        // Label every sandbox container so orphans (left by a crash/hot-reload,
        // where `sandbox_stop` never ran) can be found and swept on startup —
        // see `cleanup_orphans`. The daemon outlives us, so containers are NOT
        // covered by the kill-on-close Job Object that guards our host processes.
        labels: Some(HashMap::from([
            (SANDBOX_LABEL.to_string(), "1".to_string()),
            ("app.octoshell.worktree".to_string(), worktree_path.to_string()),
        ])),
        ..Default::default()
    };

    let opts = name.map(|n| CreateContainerOptions {
        name: n.to_string(),
        platform: None,
    });
    let created = docker
        .create_container(opts, config)
        .await
        .map_err(|e| format!("could not create sandbox container: {e}"))?;
    docker
        .start_container(&created.id, None::<StartContainerOptions<String>>)
        .await
        .map_err(|e| format!("could not start sandbox container: {e}"))?;
    Ok(created.id)
}

/// Force-remove every sandbox container we ever created (identified by our
/// label), regardless of which OctoShell run created it. Call once at startup:
/// containers live on the Docker daemon, which outlives our process, so a crash
/// or hot-reload that skipped `sandbox_stop` leaves sleeping containers behind.
/// Best-effort — a missing daemon just returns.
pub async fn cleanup_orphans() {
    let Ok(docker) = connect().await else { return };
    let mut filters = HashMap::new();
    filters.insert("label", vec![SANDBOX_LABEL]);
    let opts = ListContainersOptions {
        all: true,
        filters,
        ..Default::default()
    };
    if let Ok(list) = docker.list_containers(Some(opts)).await {
        for c in list {
            if let Some(id) = c.id {
                remove_container(&docker, &id).await;
            }
        }
    }
}

/// Force-stop and remove a container, ignoring "already gone" errors.
async fn remove_container(docker: &Docker, id: &str) {
    let _ = docker
        .remove_container(
            id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
}

/// Exec `command` inside an already-running container, streaming each stdout/
/// stderr chunk to `on_event` as it arrives, and return the captured combined
/// output plus the exit code. The command is run through `sh -c` so shell syntax
/// (pipes, `&&`, globs) works as the agent expects.
async fn exec_in_container(
    docker: &Docker,
    container_id: &str,
    command: &str,
    on_event: &mut (dyn FnMut(SandboxEvent) + Send),
) -> Result<(String, i64), BoxError> {
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(vec!["sh".to_string(), "-c".to_string(), command.to_string()]),
                working_dir: Some(WORKDIR.to_string()),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("could not create exec: {e}"))?;

    let mut combined = String::new();
    if let StartExecResults::Attached { mut output, .. } = docker
        .start_exec(&exec.id, None)
        .await
        .map_err(|e| format!("could not start exec: {e}"))?
    {
        while let Some(chunk) = output.next().await {
            let (bytes, stderr) = match chunk.map_err(|e| format!("exec stream error: {e}"))? {
                LogOutput::StdOut { message } => (message, false),
                LogOutput::StdErr { message } => (message, true),
                // Console/StdIn frames don't occur for a detached-stdin exec.
                _ => continue,
            };
            let text = String::from_utf8_lossy(&bytes);
            on_event(SandboxEvent::Log { line: &text, stderr });
            combined.push_str(&text);
        }
    }

    // The exit code is only known once the stream has drained.
    let code = docker
        .inspect_exec(&exec.id)
        .await
        .map_err(|e| format!("could not inspect exec result: {e}"))?
        .exit_code
        .unwrap_or(-1);
    on_event(SandboxEvent::Exit { code });
    Ok((combined, code))
}

/// One-shot sandboxed execution: spin up a throwaway container for
/// `worktree_path`, run `command` in it (streaming output via `on_event`), tear
/// the container down, and return the combined stdout+stderr.
///
/// `base_image` is the image to use (e.g. `"node:20"`, `"python:3.11"`); it's
/// pulled automatically if missing. The exit code is reported through `on_event`
/// as a final [`SandboxEvent::Exit`] (a non-zero code is a *test/build failure*,
/// not a function error, so it does not become an `Err`).
///
/// Errors (`Err`) are reserved for infrastructure problems: Docker not running,
/// image pull failure, mount/exec failures.
///
/// Kept as a standalone entry point even though the app wires the reusable
/// [`SandboxManager`] path; callers wanting a no-session, fire-and-forget run use this.
#[allow(dead_code)]
pub async fn run_in_sandbox(
    worktree_path: &str,
    command: &str,
    base_image: &str,
    opts: SandboxOptions,
    on_event: &mut (dyn FnMut(SandboxEvent) + Send),
) -> Result<String, BoxError> {
    let docker = connect().await?;
    let container_id = create_container(&docker, worktree_path, base_image, None, opts).await?;
    // Always tear the container down, even if the exec errors mid-stream.
    let result = exec_in_container(&docker, &container_id, command, on_event).await;
    remove_container(&docker, &container_id).await;
    result.map(|(output, _code)| output)
}

// ───────────────────────────── app integration ─────────────────────────────

#[derive(Clone, Serialize)]
struct SandboxLog {
    id: String,
    line: String,
    stderr: bool,
}

#[derive(Clone, Serialize)]
struct SandboxExit {
    id: String,
    code: i64,
}

/// Thread-safe registry of session containers, keyed by worktree path. Keeping a
/// container alive across commands (instead of one-shotting each) avoids paying
/// container create/start on every `npm test` in a tight self-healing loop.
#[derive(Default, Clone)]
pub struct SandboxManager {
    containers: Arc<Mutex<HashMap<String, String>>>, // worktree_path -> container id
}

impl SandboxManager {
    /// Get the session container for `worktree_path`, creating and caching it on
    /// first use. Concurrency-safe: after an `.await`ed `create_container`, we
    /// re-check under the lock — a parallel caller for the SAME worktree may have
    /// cached its own container meanwhile; if so we use theirs and tear down the
    /// redundant one we just made (otherwise the loser leaks, running
    /// `tail -f /dev/null` forever, unreferenced). The std Mutex is never held
    /// across an await.
    async fn container_for(
        &self,
        docker: &Docker,
        worktree_path: &str,
        base_image: &str,
        opts: SandboxOptions,
    ) -> Result<String, BoxError> {
        if let Some(cid) = self.containers.lock().unwrap().get(worktree_path).cloned() {
            return Ok(cid);
        }
        let cid = create_container(docker, worktree_path, base_image, None, opts).await?;
        let winner = {
            let mut map = self.containers.lock().unwrap();
            match map.get(worktree_path) {
                Some(existing) => Some(existing.clone()),
                None => {
                    map.insert(worktree_path.to_string(), cid.clone());
                    None
                }
            }
        };
        match winner {
            Some(w) => {
                remove_container(docker, &cid).await;
                Ok(w)
            }
            None => Ok(cid),
        }
    }

    /// Run `command` in `worktree_path`'s session container, forwarding each
    /// stdout/stderr chunk to `on_chunk` (rather than to `sandbox://*` events),
    /// and return the exit code. This is the ACP `terminal/*` path: the agent asks
    /// OctoShell to run a shell command, and when the global sandbox setting is on
    /// we run it in Docker instead of on the host — transparent sandboxing of the
    /// agent's own commands (the #3↔#10 synergy). A failed exec forgets and tears
    /// down the (possibly dead) cached container so the next call rebuilds it.
    pub async fn exec_capture(
        &self,
        worktree_path: String,
        command: String,
        base_image: String,
        opts: SandboxOptions,
        mut on_chunk: impl FnMut(&str, bool) + Send,
    ) -> Result<i64, BoxError> {
        let docker = connect().await?;
        let container_id = self
            .container_for(&docker, &worktree_path, &base_image, opts)
            .await?;
        let mut emit = |ev: SandboxEvent| {
            if let SandboxEvent::Log { line, stderr } = ev {
                on_chunk(line, stderr);
            }
        };
        match exec_in_container(&docker, &container_id, &command, &mut emit).await {
            Ok((_out, code)) => Ok(code),
            Err(e) => {
                self.containers.lock().unwrap().remove(&worktree_path);
                remove_container(&docker, &container_id).await;
                Err(e)
            }
        }
    }

    /// Run `command` for `worktree_path`'s session container (creating it on
    /// first use), streaming output to the UI via `sandbox://log` and finishing
    /// with `sandbox://exit`. `id` is the caller's stream id (echoed in events).
    /// Returns the exit code so the agent knows pass/fail.
    pub async fn exec(
        &self,
        app: AppHandle,
        id: String,
        worktree_path: String,
        command: String,
        base_image: String,
        opts: SandboxOptions,
    ) -> Result<i64, BoxError> {
        let docker = connect().await?;
        let container_id = self
            .container_for(&docker, &worktree_path, &base_image, opts)
            .await?;

        let mut emit = |ev: SandboxEvent| match ev {
            SandboxEvent::Log { line, stderr } => {
                let _ = app.emit(
                    "sandbox://log",
                    SandboxLog {
                        id: id.clone(),
                        line: line.to_string(),
                        stderr,
                    },
                );
            }
            SandboxEvent::Exit { code } => {
                let _ = app.emit("sandbox://exit", SandboxExit { id: id.clone(), code });
            }
        };

        match exec_in_container(&docker, &container_id, &command, &mut emit).await {
            Ok((_out, code)) => Ok(code),
            Err(e) => {
                // The cached container may be dead (removed out from under us);
                // forget it so the next call rebuilds a fresh one — AND tear it
                // down on the daemon in case it's still alive, so it can't leak.
                self.containers.lock().unwrap().remove(&worktree_path);
                remove_container(&docker, &container_id).await;
                Err(e)
            }
        }
    }

    /// Tear down the session container for a worktree (call when a project tab
    /// closes). Best-effort: a missing daemon or container is not an error.
    pub async fn stop(&self, worktree_path: &str) {
        let cid = self.containers.lock().unwrap().remove(worktree_path);
        if let Some(cid) = cid {
            if let Ok(docker) = connect().await {
                remove_container(&docker, &cid).await;
            }
        }
    }

    /// Tear down every tracked session container (call on app exit). A crash
    /// won't run this — startup [`cleanup_orphans`] is the real safety net — but
    /// on a clean shutdown it removes our containers promptly instead of leaving
    /// them for the next launch's sweep. Best-effort.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = {
            let mut map = self.containers.lock().unwrap();
            map.drain().map(|(_, id)| id).collect()
        };
        if ids.is_empty() {
            return;
        }
        if let Ok(docker) = connect().await {
            for id in ids {
                remove_container(&docker, &id).await;
            }
        }
    }
}

#[tauri::command]
pub async fn sandbox_exec(
    app: AppHandle,
    manager: State<'_, SandboxManager>,
    id: String,
    worktree_path: String,
    command: String,
    base_image: String,
    network: Option<bool>,
    read_only: Option<bool>,
) -> Result<i64, String> {
    // Clone the Arc-backed manager out of State so we don't borrow it across the
    // await (Tauri async-command ergonomics).
    let manager = manager.inner().clone();
    let opts = SandboxOptions {
        network: network.unwrap_or(true),
        read_only: read_only.unwrap_or(false),
    };
    manager
        .exec(app, id, worktree_path, command, base_image, opts)
        .await
        .map_err(|e| e.to_string())
}

// ───────────────────────────── global sandbox toggle ─────────────────────────
// A single app-wide flag: when on, ACP agents' `terminal/*` commands run inside
// Docker (via `SandboxManager::exec_capture`) instead of on the host. Off by
// default (host exec — works without Docker). The frontend Settings toggle and
// the orchestrator both drive it through `set_sandbox_enabled`.

/// Managed Tauri state holding the global "sandbox agent commands" flag.
#[derive(Default, Clone)]
pub struct SandboxConfig {
    enabled: Arc<AtomicBool>,
}

impl SandboxConfig {
    /// Whether ACP terminal commands should be routed through Docker.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
    pub fn set(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }
}

/// Toggle the global sandbox flag (Settings checkbox / orchestrator).
#[tauri::command]
pub fn set_sandbox_enabled(config: State<'_, SandboxConfig>, enabled: bool) -> Result<(), String> {
    config.set(enabled);
    Ok(())
}

#[tauri::command]
pub async fn sandbox_stop(
    manager: State<'_, SandboxManager>,
    worktree_path: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    manager.stop(&worktree_path).await;
    Ok(())
}
