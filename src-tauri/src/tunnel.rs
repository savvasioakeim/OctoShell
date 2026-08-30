//! Exposing the mobile server through a Cloudflare quick tunnel.
//!
//! `cloudflared tunnel --url http://127.0.0.1:<port>` prints a random
//! `https://<words>.trycloudflare.com` address and proxies to us. No account, no
//! DNS, no inbound firewall change — which is why it beats the alternatives for a
//! feature whose whole point is "works from my phone, right now".
//!
//! Three properties matter here:
//!
//! - **The tunnel is not the security boundary.** It hands out a public HTTPS URL
//!   to anyone who learns it. The access code and lockout in `mobile.rs` are what
//!   protect the machine; the tunnel only removes the network problem.
//! - **It dies with sharing.** Stopping drops the child, and the child is in the
//!   job object, so it cannot outlive OctoShell even on a crash. A tunnel still
//!   pointing at a port after you stopped sharing would be the worst artefact
//!   this feature could leave behind.
//! - **Absence is normal, not an error.** Most people don't have `cloudflared`.
//!   Failing to find it must produce an explanation and an install hint, not a
//!   silent nothing — the local server keeps working either way.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long to wait for cloudflared to print its URL before giving up. It
/// normally appears in a second or two; beyond this something is wrong and the
/// user deserves to be told rather than watching a spinner.
const URL_TIMEOUT: Duration = Duration::from_secs(25);

/// A running tunnel.
struct Running {
    child: Child,
    url: String,
}

impl Drop for Running {
    fn drop(&mut self) {
        // Best effort: the job object is the real guarantee, this is just tidy.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default, Clone)]
pub struct TunnelManager(Arc<Mutex<Option<Running>>>);

#[derive(Serialize, Clone)]
pub struct TunnelStatus {
    pub running: bool,
    pub url: Option<String>,
}

/// Pull the first `https://…trycloudflare.com` out of a log line.
///
/// cloudflared decorates its output with box-drawing characters and timestamps,
/// so this scans for the scheme rather than trying to match a whole line format
/// that is not part of any contract and changes between releases.
fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']).to_string();
    if url.contains("trycloudflare.com") {
        Some(url)
    } else {
        None
    }
}

impl TunnelManager {
    pub fn status(&self) -> TunnelStatus {
        let guard = self.0.lock().unwrap();
        match guard.as_ref() {
            Some(r) => TunnelStatus { running: true, url: Some(r.url.clone()) },
            None => TunnelStatus { running: false, url: None },
        }
    }

    /// Stop any running tunnel. Idempotent.
    pub fn stop(&self) {
        *self.0.lock().unwrap() = None; // Drop kills the child
    }
}

/// Start a quick tunnel to `port` and return its public URL.
#[tauri::command]
pub async fn tunnel_start(
    manager: tauri::State<'_, TunnelManager>,
    port: u16,
) -> Result<TunnelStatus, String> {
    let mgr = TunnelManager(manager.inner().0.clone());
    mgr.stop(); // never leave a second tunnel pointing at an old port

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("cloudflared");
        cmd.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(
                    "cloudflared isn't installed or isn't on PATH. Install it with \
                     `winget install --id Cloudflare.cloudflared`, then try again."
                        .to_string(),
                )
            }
            Err(e) => return Err(format!("could not start cloudflared: {e}")),
        };
        crate::jobctl::add(child.id());

        // cloudflared prints the URL on stderr, but that has moved between
        // versions — read BOTH rather than depending on which stream it picked.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let mut readers = Vec::new();
        for stream in [
            stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let found = found.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Some(u) = extract_url(&line) {
                        let mut g = found.lock().unwrap();
                        if g.is_none() {
                            *g = Some(u);
                        }
                        // Keep draining: a full pipe would block cloudflared.
                    }
                }
            }));
        }

        let began = Instant::now();
        loop {
            if let Some(url) = found.lock().unwrap().clone() {
                let status = TunnelStatus { running: true, url: Some(url.clone()) };
                *mgr.0.lock().unwrap() = Some(Running { child, url });
                return Ok(status);
            }
            // A cloudflared that exits without printing a URL (no network, blocked
            // egress) must surface as an error rather than as a 25-second wait.
            if let Ok(Some(exit)) = child.try_wait() {
                return Err(format!(
                    "cloudflared stopped before giving a URL ({exit}). Check that outbound HTTPS is allowed."
                ));
            }
            if began.elapsed() > URL_TIMEOUT {
                let _ = child.kill();
                return Err("cloudflared didn't produce a URL in time.".to_string());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    })
    .await
    .map_err(|e| format!("tunnel task failed: {e}"))?
}

#[tauri::command]
pub fn tunnel_stop(manager: tauri::State<'_, TunnelManager>) -> TunnelStatus {
    manager.stop();
    manager.status()
}

#[tauri::command]
pub fn tunnel_status(manager: tauri::State<'_, TunnelManager>) -> TunnelStatus {
    manager.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_url_in_cloudflareds_decorated_output() {
        // The first case is VERBATIM output from cloudflared 2026.8.2, captured by
        // running it — not a remembered shape. The others are older forms kept so
        // a version bump that reverts the formatting doesn't break the feature.
        let cases = [
            "2026-08-30T18:15:01Z INF |  https://contributed-native-anybody-tales.trycloudflare.com                                |",
            "2026-08-30T12:00:00Z INF |  https://brave-lion-tiny-fox.trycloudflare.com  |",
            "|  https://abc-def.trycloudflare.com                                       |",
            "INF Your quick Tunnel has been created! Visit it at https://x-y-z.trycloudflare.com",
        ];
        for c in cases {
            assert!(
                extract_url(c).map(|u| u.contains("trycloudflare.com")).unwrap_or(false),
                "failed to extract from: {c}"
            );
        }
    }

    #[test]
    fn ignores_urls_that_are_not_the_tunnel() {
        // cloudflared logs its own docs and update links; picking one of those up
        // would hand the user an address that has nothing to do with their machine.
        assert_eq!(extract_url("INF see https://developers.cloudflare.com/argo-tunnel"), None);
        // Also real: cloudflared announces the request BEFORE it has a URL, and
        // that line names trycloudflare.com without one. Matching on the domain
        // instead of the scheme would have returned a truncated address here.
        assert_eq!(extract_url("2026-08-30T18:14:56Z INF Requesting new quick Tunnel on trycloudflare.com..."), None);
        assert_eq!(extract_url("no url here at all"), None);
    }

    #[test]
    fn trims_trailing_punctuation() {
        assert_eq!(
            extract_url("Visit it at https://a-b-c.trycloudflare.com."),
            Some("https://a-b-c.trycloudflare.com".to_string())
        );
    }
}
