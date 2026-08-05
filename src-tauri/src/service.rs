//! Managed long-running services (dev servers and the like).
//!
//! Agents must NOT run blocking servers — a `npm run dev` never returns, so the
//! agent's turn hangs forever (and the orchestrator can't move on). And a user
//! juggling five Next apps shouldn't hand-pick ports. So OctoShell owns server
//! processes itself: it allocates a free port, injects it (`PORT` env), captures
//! the combined log stream, detects the actually-bound URL from the output, and
//! ties the process to the kill-on-close [`crate::jobctl`] job so it can't be
//! orphaned. Review mode and a future "Services" panel drive this.
//!
//! Events emitted (all carry the caller-chosen service `id`):
//!   * `service://ready` — `{ id, port, url }` once a bound port is known
//!   * `service://log`   — `{ id, line }` for each stdout/stderr line
//!   * `service://exit`  — `{ id, code }` when the process ends

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// A running managed service: its process plus the port we assigned it.
struct Service {
    child: Child,
    /// The port we injected/reserved for this service (released on stop/exit).
    port: u16,
}

/// Thread-safe registry of running services, keyed by a caller-chosen id (one
/// service per id; starting again replaces the old one).
#[derive(Default, Clone)]
pub struct ServiceManager {
    services: Arc<Mutex<HashMap<String, Service>>>,
    /// Ports handed out but not yet owned by a spawned child, so two concurrent
    /// starts can't both grab the same "free" port between allocation and bind.
    reserved: Arc<Mutex<HashSet<u16>>>,
}

#[derive(Clone, Serialize)]
struct ServiceReady {
    id: String,
    port: u16,
    url: String,
}

#[derive(Clone, Serialize)]
struct ServiceLog {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ServiceExit {
    id: String,
    code: i32,
}

/// The port a service gets: the project's OWN port, always. `hint` (explicit or
/// from .env), else 3000.
///
/// We deliberately do NOT hunt for a free port. Shifting a busy 3000 to 3001 made
/// every consumer guess which port a server actually landed on — QA opened the
/// wrong URL, a frontend called an API that had moved, and the "free" bind-test
/// raced the child's real bind anyway. A dev server is only useful on the port its
/// project expects, so instead of moving ours out of the way we clear the port
/// (see `free_port`): the newest start wins and the stale server dies.
fn service_port(hint: Option<u16>) -> u16 {
    hint.filter(|p| *p != 0).unwrap_or(3000)
}

/// Make `port` available by killing whatever still listens on it, and say so.
/// Every kill is announced on the service log — silently taking a port from
/// another process is exactly the kind of invisible action that costs debugging
/// time later. Returns the log lines describing what was stopped.
fn free_port(port: u16) -> Vec<String> {
    let mut notes = Vec::new();
    if TcpListener::bind(("127.0.0.1", port)).is_ok() {
        return notes; // already free
    }
    for pid in pids_on_port(port) {
        #[cfg(windows)]
        let killed = capture("taskkill", &["/F", "/T", "/PID", &pid.to_string()]).is_some();
        #[cfg(not(windows))]
        let killed = Command::new("kill").arg("-9").arg(pid.to_string()).status().is_ok();
        notes.push(if killed {
            format!("octoshell: port {port} was in use by pid {pid} — stopped it to free the port")
        } else {
            format!("octoshell: port {port} is in use by pid {pid} and could NOT be freed — the server will likely fail to bind")
        });
    }
    if notes.is_empty() {
        notes.push(format!(
            "octoshell: port {port} looks busy but no owning process was found — the server may fail to bind"
        ));
    }
    notes
}

/// The project's own `PORT=` from its .env files. We inject `PORT` into the
/// child's environment, and an injected env var BEATS dotenv (dotenv never
/// overrides existing vars) — so if the project declares a port, we must use it
/// as the allocation hint or we silently override the port the app expects.
fn env_port_hint(cwd: &str) -> Option<u16> {
    for f in [".env.local", ".env.development.local", ".env.development", ".env"] {
        let Ok(text) = std::fs::read_to_string(Path::new(cwd).join(f)) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix("PORT") else { continue };
            let Some(v) = rest.trim_start().strip_prefix('=') else { continue };
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if let Ok(p) = v.parse::<u16>() {
                if p > 0 {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// If `command` invokes an npm script the project doesn't have, swap in the best
/// script it DOES have (dev → start → serve → preview). Callers (the
/// orchestrator's review blocks in particular) guess "npm run dev" for every
/// repo; a backend that only defines "start" then dies with `Missing script:
/// "dev"` instead of coming up.
fn fix_npm_script(cwd: &str, command: &str) -> String {
    let c = command.trim();
    let requested = if c == "npm start" {
        Some("start")
    } else if let Some(rest) = c.strip_prefix("npm run ") {
        rest.split_whitespace().next()
    } else {
        None
    };
    let Some(req) = requested else { return command.into() };
    let Ok(text) = std::fs::read_to_string(Path::new(cwd).join("package.json")) else {
        return command.into();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return command.into();
    };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else {
        return command.into();
    };
    if scripts.contains_key(req) {
        return command.into();
    }
    for cand in ["dev", "start", "serve", "preview"] {
        if scripts.contains_key(cand) {
            return if cand == "start" {
                "npm start".into()
            } else {
                format!("npm run {cand}")
            };
        }
    }
    command.into()
}

/// The dependency-install command for a JS project, chosen by its lockfile
/// (npm / pnpm / yarn / bun). Defaults to `npm install`.
fn install_command(cwd: &str) -> &'static str {
    let dir = Path::new(cwd);
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm install"
    } else if dir.join("yarn.lock").exists() {
        "yarn install"
    } else if dir.join("bun.lockb").exists() {
        "bun install"
    } else {
        "npm install"
    }
}

/// True when a directory is absent or has no entries. A `git worktree add` leaves
/// an EMPTY `node_modules` in some setups (and a never-installed repo has one too),
/// so a bare `.exists()` check isn't enough — an empty dir still means "install me".
fn dir_missing_or_empty(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => true, // missing / unreadable
    }
}

/// Wrap a server command so it FIRST installs dependencies when they're missing.
/// A JS project (has `package.json`) with no — or an EMPTY — `node_modules` (the
/// norm for a fresh `git worktree`, which never inherits them) would otherwise
/// crash on its first import (e.g. `ERR_MODULE_NOT_FOUND`). Returns `command`
/// unchanged when there's nothing to guard. We decide here (not with a runtime
/// `if not exist`, which can't tell an empty dir from a populated one) and, when an
/// install is needed, prepend it UNCONDITIONALLY. Its output streams through the
/// same stdout pipe, so the user sees progress.
fn with_install_guard(cwd: &str, command: &str) -> String {
    if cwd.is_empty() {
        return command.into();
    }
    let dir = Path::new(cwd);
    if !dir.join("package.json").exists() || !dir_missing_or_empty(&dir.join("node_modules")) {
        return command.into();
    }
    let install = install_command(cwd);
    #[cfg(windows)]
    {
        format!("echo octoshell: installing dependencies ({install})... && {install} && ( {command} )")
    }
    #[cfg(not(windows))]
    {
        format!("echo 'octoshell: installing dependencies ({install})...'; {install} || exit 1; {command}")
    }
}

/// Pull a bound port out of a typical dev-server log line (e.g.
/// "Local:   http://localhost:5173/"). Lets us report the URL the server ACTUALLY
/// bound — covering frameworks that ignore `PORT` or auto-increment on conflict.
fn parse_port(line: &str) -> Option<u16> {
    let lower = line.to_lowercase();
    for marker in ["localhost:", "127.0.0.1:", "0.0.0.0:"] {
        if let Some(idx) = lower.find(marker) {
            let rest = &line[idx + marker.len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(p) = digits.parse::<u16>() {
                if p > 0 {
                    return Some(p);
                }
            }
        }
    }
    None
}

impl ServiceManager {
    pub fn start(
        &self,
        app: AppHandle,
        id: String,
        cwd: String,
        command: String,
        port_hint: Option<u16>,
    ) -> Result<u16, String> {
        // One service per id: replace any existing run.
        self.stop(&id);

        // Repair a guessed npm script against the project's real package.json.
        let fixed = fix_npm_script(&cwd, &command);
        if fixed != command {
            let _ = app.emit(
                "service://log",
                ServiceLog {
                    id: id.clone(),
                    line: format!("octoshell: `{command}` is not in this package's scripts — running `{fixed}` instead"),
                },
            );
        }
        // A fresh worktree (or a never-installed repo) has no node_modules, so the
        // server would crash on its first import. Auto-install first when missing.
        let command = with_install_guard(&cwd, &fixed);

        // The project's own port, always — then clear it, so starting a server
        // replaces whatever was on that port instead of drifting to another one.
        let port = service_port(port_hint.or_else(|| env_port_hint(&cwd)));
        // Retire any MANAGED service already on this port through `stop`, so its
        // bookkeeping (map entry, reservation) is cleaned up rather than leaving a
        // zombie entry pointing at a process free_port would just kill.
        let stale: Vec<String> = self
            .services
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.port == port)
            .map(|(k, _)| k.clone())
            .collect();
        for other in stale {
            let _ = app.emit(
                "service://log",
                ServiceLog {
                    id: id.clone(),
                    line: format!("octoshell: stopping `{other}` — it was serving port {port}"),
                },
            );
            self.stop(&other);
        }
        for line in free_port(port) {
            let _ = app.emit("service://log", ServiceLog { id: id.clone(), line });
        }
        self.reserved.lock().unwrap().insert(port);

        // The command is a shell line ("npm run dev"); npm/next are shims, so run
        // it through the platform shell rather than spawning the binary directly.
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(&command);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command);
            c
        };

        if !cwd.is_empty() {
            cmd.current_dir(&cwd);
        }
        // Inject the assigned port; most node servers honour PORT.
        cmd.env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start service `{command}`: {e}"))?;
        // Tie it (and whatever it spawns) to OctoShell's lifetime.
        crate::jobctl::add(child.id());
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("no stderr pipe")?;
        self.services
            .lock()
            .unwrap()
            .insert(id.clone(), Service { child, port });
        // KEEP the reservation for the service's whole lifetime. A node dev server
        // takes a second or two to actually bind, so dropping it here let a second
        // start that fired in that window see the port as "free" and hand it out
        // again — both children then got PORT=3000 and the second died with
        // EADDRINUSE. The reservation is released in `stop` and when the process
        // exits (the reaper below).

        // Announce the injected port immediately so callers (review mode) have a
        // URL to hit; the stdout reader may refine it if the server prints another.
        let _ = app.emit(
            "service://ready",
            ServiceReady {
                id: id.clone(),
                port,
                url: format!("http://localhost:{port}"),
            },
        );

        // Shared "detected bound port" (0 = not yet): BOTH stdout and stderr race
        // to parse the first bound-URL line (many dev servers print their banner
        // on stderr), the first hit across either stream wins, and stdout's
        // reaper reads it back to release the refined port on exit.
        let port_detected = Arc::new(AtomicU16::new(0));
        // stderr: stream as logs AND detect the bound port (banner often here).
        spawn_log_reader(
            app.clone(),
            id.clone(),
            Box::new(stderr),
            port_detected.clone(),
            port,
            self.reserved.clone(),
        );
        // stdout: stream logs, refine the bound port, and reap the child on EOF.
        let services = self.services.clone();
        let reserved = self.reserved.clone();
        spawn_stdout_reader(app, id, Box::new(stdout), port_detected, port, services, reserved);

        Ok(port)
    }

    pub fn stop(&self, id: &str) {
        if let Some(mut s) = self.services.lock().unwrap().remove(id) {
            // The service runs as `cmd /c <command>` (or `sh -c`), so `child` is the
            // WRAPPER shell — killing only it leaves the real server (node/etc.) alive
            // and still holding its port. Kill the whole process TREE by pid, then
            // reap the handle. (Windows: taskkill /T; Unix: negative-pid group kill.)
            let pid = s.child.id();
            #[cfg(windows)]
            {
                let _ = capture("taskkill", &["/F", "/T", "/PID", &pid.to_string()]);
            }
            #[cfg(not(windows))]
            {
                // Best-effort: kill the process group if we're its leader, else the pid.
                let _ = Command::new("kill").arg("-TERM").arg(format!("-{pid}")).status();
                let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
            }
            let _ = s.child.kill();
            self.reserved.lock().unwrap().remove(&s.port);
        }
    }
}

/// Try to pull a bound port out of one log line. On the first successful parse
/// across EITHER stream (guarded by the shared `detected` flag), reserve the
/// real port and emit `service://ready`. First hit wins; later lines are ignored.
fn maybe_emit_port(
    line: &str,
    detected: &AtomicU16,
    reserved: &Mutex<HashSet<u16>>,
    app: &AppHandle,
    id: &str,
    announced_port: u16,
) {
    if detected.load(Ordering::Relaxed) != 0 {
        return;
    }
    let Some(p) = parse_port(line) else { return }; // parse_port only yields p > 0
    // Claim the win atomically (0 → p) — the other stream may parse the same
    // instant; whoever swaps first owns the detection.
    if detected
        .compare_exchange(0, p, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    if p != announced_port {
        // The server bound a different port than we injected (it ignores PORT or
        // auto-incremented). Reserve the real one too so we never hand it out.
        reserved.lock().unwrap().insert(p);
        let _ = app.emit(
            "service://ready",
            ServiceReady { id: id.to_string(), port: p, url: format!("http://localhost:{p}") },
        );
    }
}

/// A plain log-draining reader (used for stderr): emit each line and share in the
/// port-detection race (banners are often on stderr), but never reap.
fn spawn_log_reader(
    app: AppHandle,
    id: String,
    stream: Box<dyn Read + Send>,
    port_detected: Arc<AtomicU16>,
    announced_port: u16,
    reserved: Arc<Mutex<HashSet<u16>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(l) = line else { break };
            maybe_emit_port(&l, &port_detected, &reserved, &app, &id, announced_port);
            if app
                .emit("service://log", ServiceLog { id: id.clone(), line: l })
                .is_err()
            {
                return; // WebView gone
            }
        }
    });
}

/// The stdout reader owns reaping: it streams logs (sharing the port-detection
/// race with stderr), then on EOF removes the child, waits for its exit code,
/// and emits `service://exit`.
fn spawn_stdout_reader(
    app: AppHandle,
    id: String,
    stream: Box<dyn Read + Send>,
    port_detected: Arc<AtomicU16>,
    announced_port: u16,
    services: Arc<Mutex<HashMap<String, Service>>>,
    reserved: Arc<Mutex<HashSet<u16>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(l) = line else { break };
            maybe_emit_port(&l, &port_detected, &reserved, &app, &id, announced_port);
            if app
                .emit("service://log", ServiceLog { id: id.clone(), line: l })
                .is_err()
            {
                return;
            }
        }
        // stdout closed → process is finishing. Reap it (unless already stopped)
        // and release every port it held (the injected one and any refined one).
        let code = match services.lock().unwrap().remove(&id) {
            Some(mut s) => {
                reserved.lock().unwrap().remove(&s.port);
                s.child.wait().ok().and_then(|st| st.code()).unwrap_or(-1)
            }
            None => -1,
        };
        // Also release the refined port, if either stream detected a different one.
        let refined = port_detected.load(Ordering::Relaxed);
        if refined != 0 {
            reserved.lock().unwrap().remove(&refined);
        }
        let _ = app.emit("service://exit", ServiceExit { id, code });
    });
}

#[tauri::command]
pub fn service_start(
    app: AppHandle,
    manager: State<'_, ServiceManager>,
    id: String,
    cwd: String,
    command: String,
    port: Option<u16>,
) -> Result<u16, String> {
    manager.start(app, id, cwd, command, port)
}

#[tauri::command]
pub fn service_stop(manager: State<'_, ServiceManager>, id: String) -> Result<(), String> {
    manager.stop(&id);
    Ok(())
}

/// One listening TCP port, with the process holding it (best-effort name).
#[derive(Serialize, Clone)]
pub struct PortInfo {
    port: u16,
    pid: u32,
    process: String,
}

/// Run a command with no console window (Windows), capturing stdout.
fn capture(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// PIDs currently LISTENING on `port` (Windows: parsed from `netstat -ano`).
#[cfg(windows)]
fn pids_on_port(port: u16) -> Vec<u32> {
    let Some(text) = capture("netstat", &["-ano", "-p", "tcp"]) else { return vec![] };
    let mut pids = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // Proto Local Foreign State PID
        if f.len() >= 5 && f[3].eq_ignore_ascii_case("LISTENING") {
            if f[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) == Some(port) {
                if let Ok(pid) = f[4].parse::<u32>() {
                    if pid != 0 && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

#[cfg(not(windows))]
fn pids_on_port(port: u16) -> Vec<u32> {
    let Some(text) = capture("lsof", &["-tiTCP", &format!("-sTCP:LISTEN"), "-P", "-n", &format!("-i:{port}")]) else { return vec![] };
    text.lines().filter_map(|l| l.trim().parse::<u32>().ok()).collect()
}

/// Every LISTENING TCP port on the machine, with its owning process. Powers the
/// Ports panel — so the user can see and kill whatever holds a port (e.g. a stale
/// dev server on 3000). Deduped by (port, pid), sorted by port.
#[tauri::command]
pub fn list_ports() -> Vec<PortInfo> {
    #[cfg(windows)]
    {
        // PID → image name, from one tasklist call (CSV, no header).
        let mut names: HashMap<u32, String> = HashMap::new();
        if let Some(tl) = capture("tasklist", &["/fo", "csv", "/nh"]) {
            for line in tl.lines() {
                let cols: Vec<&str> = line.split("\",\"").collect();
                if cols.len() >= 2 {
                    let name = cols[0].trim_matches('"').to_string();
                    if let Ok(pid) = cols[1].trim_matches('"').trim().parse::<u32>() {
                        names.insert(pid, name);
                    }
                }
            }
        }
        let Some(text) = capture("netstat", &["-ano", "-p", "tcp"]) else { return vec![] };
        let mut seen: HashSet<(u16, u32)> = HashSet::new();
        let mut out: Vec<PortInfo> = Vec::new();
        for line in text.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 5 && f[3].eq_ignore_ascii_case("LISTENING") {
                let port = f[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok());
                let pid = f[4].parse::<u32>().ok();
                if let (Some(port), Some(pid)) = (port, pid) {
                    if pid != 0 && seen.insert((port, pid)) {
                        let process = names.get(&pid).cloned().unwrap_or_else(|| "?".into());
                        out.push(PortInfo { port, pid, process });
                    }
                }
            }
        }
        out.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
        out
    }
    #[cfg(not(windows))]
    {
        let Some(text) = capture("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]) else { return vec![] };
        let mut seen: HashSet<(u16, u32)> = HashSet::new();
        let mut out: Vec<PortInfo> = Vec::new();
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 9 {
                let pid = f[1].parse::<u32>().ok();
                let port = f[8].rsplit(':').next().and_then(|p| p.parse::<u16>().ok());
                if let (Some(pid), Some(port)) = (pid, port) {
                    if seen.insert((port, pid)) {
                        out.push(PortInfo { port, pid, process: f[0].to_string() });
                    }
                }
            }
        }
        out.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
        out
    }
}

/// Kill whatever process is LISTENING on `port` (all of them). Used by the Ports
/// panel's per-port kill button. Returns the count killed.
#[tauri::command]
pub fn kill_port(port: u16) -> Result<u32, String> {
    let pids = pids_on_port(port);
    if pids.is_empty() {
        return Ok(0);
    }
    let mut killed = 0;
    for pid in pids {
        #[cfg(windows)]
        let ok = capture("taskkill", &["/F", "/PID", &pid.to_string()]).is_some();
        #[cfg(not(windows))]
        let ok = Command::new("kill").arg("-9").arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false);
        if ok {
            killed += 1;
        }
    }
    Ok(killed)
}
