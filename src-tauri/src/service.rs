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

/// Find a free TCP port, preferring `hint`, then the familiar dev range
/// (3000–3099), then an OS-assigned ephemeral one. `reserved` guards against two
/// in-flight starts picking the same port. The bind-test races the eventual child
/// bind (we drop the listener so the child can take it), which is acceptable: a
/// hard-coded server that ignores `PORT` may still collide, and that's surfaced
/// via the log stream rather than silently. Returns 0 if nothing is free.
fn alloc_port(reserved: &Mutex<HashSet<u16>>, hint: Option<u16>) -> u16 {
    let free = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    let mut res = reserved.lock().unwrap();
    if let Some(h) = hint {
        if h != 0 && !res.contains(&h) && free(h) {
            res.insert(h);
            return h;
        }
    }
    for p in 3000u16..3100 {
        if !res.contains(&p) && free(p) {
            res.insert(p);
            return p;
        }
    }
    if let Ok(l) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = l.local_addr() {
            let p = addr.port();
            res.insert(p);
            return p;
        }
    }
    0
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
        let command = fixed;

        // Prefer the project's own .env PORT over our 3000-range default.
        let port = alloc_port(&self.reserved, port_hint.or_else(|| env_port_hint(&cwd)));
        if port == 0 {
            return Err("could not allocate a free port".into());
        }

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
