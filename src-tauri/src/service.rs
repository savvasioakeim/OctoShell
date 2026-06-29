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
use std::process::{Child, Command, Stdio};
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

        let port = alloc_port(&self.reserved, port_hint);
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

        // stderr: stream as logs (many dev servers print their banner there).
        spawn_log_reader(app.clone(), id.clone(), Box::new(stderr), false, port);
        // stdout: stream logs, refine the bound port, and reap the child on EOF.
        let services = self.services.clone();
        let reserved = self.reserved.clone();
        spawn_stdout_reader(app, id, Box::new(stdout), port, services, reserved);

        Ok(port)
    }

    pub fn stop(&self, id: &str) {
        if let Some(mut s) = self.services.lock().unwrap().remove(id) {
            let _ = s.child.kill();
            self.reserved.lock().unwrap().remove(&s.port);
        }
    }
}

/// A plain log-draining reader (used for stderr): emit each line, optionally
/// refine the bound port, never reap.
fn spawn_log_reader(
    app: AppHandle,
    id: String,
    stream: Box<dyn Read + Send>,
    mut detect_port: bool,
    announced_port: u16,
) {
    thread::spawn(move || {
        let mut last = announced_port;
        for line in BufReader::new(stream).lines() {
            let Ok(l) = line else { break };
            if detect_port {
                if let Some(p) = parse_port(&l) {
                    if p != last {
                        last = p;
                        let _ = app.emit(
                            "service://ready",
                            ServiceReady {
                                id: id.clone(),
                                port: p,
                                url: format!("http://localhost:{p}"),
                            },
                        );
                    }
                    detect_port = false; // first hit wins
                }
            }
            if app
                .emit("service://log", ServiceLog { id: id.clone(), line: l })
                .is_err()
            {
                return; // WebView gone
            }
        }
    });
}

/// The stdout reader owns reaping: it streams logs (refining the port from the
/// first URL it sees), then on EOF removes the child, waits for its exit code,
/// and emits `service://exit`.
fn spawn_stdout_reader(
    app: AppHandle,
    id: String,
    stream: Box<dyn Read + Send>,
    announced_port: u16,
    services: Arc<Mutex<HashMap<String, Service>>>,
    reserved: Arc<Mutex<HashSet<u16>>>,
) {
    thread::spawn(move || {
        let mut last = announced_port;
        let mut detect = true;
        for line in BufReader::new(stream).lines() {
            let Ok(l) = line else { break };
            if detect {
                if let Some(p) = parse_port(&l) {
                    if p != last {
                        // The server bound a different port than we injected (it
                        // ignores PORT or auto-incremented). Reserve the real one
                        // too so we never hand it to another service.
                        reserved.lock().unwrap().insert(p);
                        last = p;
                        let _ = app.emit(
                            "service://ready",
                            ServiceReady {
                                id: id.clone(),
                                port: p,
                                url: format!("http://localhost:{p}"),
                            },
                        );
                    }
                    detect = false;
                }
            }
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
        reserved.lock().unwrap().remove(&last);
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
