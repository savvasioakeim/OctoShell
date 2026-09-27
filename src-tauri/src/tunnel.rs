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
    /// cloudflared's own metrics server, logged at startup. It answers /ready
    /// with how many edge connections are live — the difference between a tunnel
    /// that works and one that works only from where you happen to be standing.
    metrics: Option<String>,
}

/// How many edge connections a healthy quick tunnel keeps. cloudflared spreads
/// them across data centres on purpose: with fewer, a request that lands at a
/// centre the tunnel isn't connected to has nowhere to go, so the address answers
/// from one network and not another. That failure is invisible from the machine
/// running it, which is exactly where you'd be looking.
const HEALTHY_CONNECTIONS: u32 = 4;


impl Drop for Running {
    fn drop(&mut self) {
        // Best effort: the job object / group registry is the real guarantee,
        // this is just tidy.
        crate::platform::kill_tree(self.child.id());
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
    /// Live edge connections, when cloudflared will tell us. None = unknown.
    pub connections: Option<u32>,
    /// What a healthy tunnel should have, so the UI needn't hardcode it.
    pub healthy_connections: u32,
}

/// The address cloudflared logs for its own metrics server, e.g.
/// `Starting metrics server on 127.0.0.1:20241/metrics`.
fn extract_metrics(line: &str) -> Option<String> {
    let idx = line.find("metrics server on ")? + "metrics server on ".len();
    let rest = &line[idx..];
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let addr = rest[..end].trim_end_matches("/metrics");
    if addr.contains(':') {
        Some(addr.to_string())
    } else {
        None
    }
}

/// How many edge connections cloudflared currently has, or None if it won't say.
fn ready_connections(metrics: &str) -> Option<u32> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let body = client.get(format!("http://{metrics}/ready")).send().ok()?.text().ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    v.get("readyConnections")?.as_u64().map(|n| n as u32)
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
        // Reap first: cloudflared can die on its own (network drop, edge refusing
        // the tunnel), and a UI still showing its address would send you to a
        // dead link from your phone with no clue why.
        {
            let mut guard = self.0.lock().unwrap();
            let dead = guard
                .as_mut()
                .map(|r| matches!(r.child.try_wait(), Ok(Some(_))))
                .unwrap_or(false);
            if dead {
                *guard = None;
            }
        }
        let guard = self.0.lock().unwrap();
        match guard.as_ref() {
            Some(r) => TunnelStatus {
                running: true,
                url: Some(r.url.clone()),
                connections: r.metrics.as_deref().and_then(ready_connections),
                healthy_connections: HEALTHY_CONNECTIONS,
            },
            None => TunnelStatus {
                running: false,
                url: None,
                connections: None,
                healthy_connections: HEALTHY_CONNECTIONS,
            },
        }
    }

    /// Stop any running tunnel. Idempotent.
    pub fn stop(&self) {
        *self.0.lock().unwrap() = None; // Drop kills the child
    }
}

/// Start a tunnel to `port` and return its public URL.
///
/// Two modes. A **quick** tunnel needs nothing but the binary and hands back a
/// random `trycloudflare.com` address that dies with the session. A **named**
/// tunnel is one you created in Cloudflare's dashboard: pass its token and the
/// hostname you routed to it, and the address is yours and stays put — which is
/// the only way an installed home-screen app keeps working tomorrow.
///
/// Named mode takes its ingress from the dashboard, so it never sees `--url` and
/// never prints a URL: the hostname the caller supplies IS the address.
#[tauri::command]
pub async fn tunnel_start(
    manager: tauri::State<'_, TunnelManager>,
    port: u16,
    token: Option<String>,
    hostname: Option<String>,
) -> Result<TunnelStatus, String> {
    let mgr = TunnelManager(manager.inner().0.clone());
    mgr.stop(); // never leave a second tunnel pointing at an old port

    let named = match (token.as_deref(), hostname.as_deref()) {
        (Some(t), Some(h)) if !t.trim().is_empty() && !h.trim().is_empty() => {
            Some((t.trim().to_string(), h.trim().trim_end_matches('/').to_string()))
        }
        (Some(t), _) if !t.trim().is_empty() => {
            return Err("a named tunnel also needs the public hostname you routed to it".into())
        }
        _ => None,
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("cloudflared");
        match &named {
            Some((token, _)) => {
                cmd.args(["tunnel", "--no-autoupdate", "run", "--token", token]);
            }
            None => {
                cmd.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")]);
            }
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::platform::background(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "cloudflared isn't installed or isn't on PATH. Install it with `{}`, then try again.",
                    crate::platform::install_hint("cloudflared")
                ))
            }
            Err(e) => return Err(format!("could not start cloudflared: {e}")),
        };
        crate::jobctl::add(child.id());

        // cloudflared prints the URL on stderr, but that has moved between
        // versions — read BOTH rather than depending on which stream it picked.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let metrics: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let mut readers = Vec::new();
        for stream in [
            stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let found = found.clone();
            let metrics = metrics.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Some(u) = extract_url(&line) {
                        let mut g = found.lock().unwrap();
                        if g.is_none() {
                            *g = Some(u);
                        }
                    }
                    if let Some(m) = extract_metrics(&line) {
                        let mut g = metrics.lock().unwrap();
                        if g.is_none() {
                            *g = Some(m);
                        }
                    }
                    // Keep draining either way: a full pipe would block cloudflared.
                }
            }));
        }

        // Named tunnels never print an address — the hostname from the dashboard
        // IS the address. Placed after the readers start so the metrics address
        // is captured for them too: connection health matters just as much on a
        // tunnel you rely on every day.
        if let Some((_, host)) = &named {
            let url = if host.starts_with("http") { host.clone() } else { format!("https://{host}") };
            wait_until_live(&url);
            let m = metrics.lock().unwrap().clone();
            let status = TunnelStatus {
                running: true,
                url: Some(url.clone()),
                connections: m.as_deref().and_then(ready_connections),
                healthy_connections: HEALTHY_CONNECTIONS,
            };
            *mgr.0.lock().unwrap() = Some(Running { child, url, metrics: m });
            return Ok(status);
        }

        let began = Instant::now();
        loop {
            if let Some(url) = found.lock().unwrap().clone() {
                // Give the remaining edge connections a moment to register before
                // reporting health — they come up over a second or two, and
                // reporting 1-of-4 the instant the URL appears would cry wolf.
                std::thread::sleep(Duration::from_millis(1200));
                // cloudflared prints the address BEFORE Cloudflare's edge has
                // finished registering the tunnel, so opening it immediately gives
                // error 1033 — "no tunnel here". Wait for the edge to agree before
                // handing the URL to the UI, or the first thing the user sees on
                // their phone is a Cloudflare error page.
                wait_until_live(&url);
                let m = metrics.lock().unwrap().clone();
                let status = TunnelStatus {
                    running: true,
                    url: Some(url.clone()),
                    connections: m.as_deref().and_then(ready_connections),
                    healthy_connections: HEALTHY_CONNECTIONS,
                };
                *mgr.0.lock().unwrap() = Some(Running { child, url, metrics: m });
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

/// Poll the public address until Cloudflare's edge serves it, or give up.
///
/// Giving up is fine and deliberate: the tunnel is up either way, and a URL that
/// needs another second is better than refusing to show one at all. This only
/// removes the common case of handing over an address a moment too early.
fn wait_until_live(url: &str) {
    const BUDGET: Duration = Duration::from_secs(12);
    let began = Instant::now();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    while began.elapsed() < BUDGET {
        if let Ok(r) = client.get(url).send() {
            // Any answer from OUR server counts, including the 401 an unauthorised
            // probe gets. What we're waiting out is Cloudflare's own 5xx/1033.
            if r.status().as_u16() < 500 {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
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
    fn finds_the_metrics_address() {
        // Verbatim from cloudflared 2026.8.2.
        assert_eq!(
            extract_metrics("2026-08-30T18:15:02Z INF Starting metrics server on 127.0.0.1:20241/metrics"),
            Some("127.0.0.1:20241".to_string())
        );
        assert_eq!(extract_metrics("2026-08-30T18:15:02Z INF Something else entirely"), None);
    }

    #[test]
    fn trims_trailing_punctuation() {
        assert_eq!(
            extract_url("Visit it at https://a-b-c.trycloudflare.com."),
            Some("https://a-b-c.trycloudflare.com".to_string())
        );
    }
}
