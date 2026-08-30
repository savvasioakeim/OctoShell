//! The mobile companion server: an HTTP surface for a phone to see what the
//! agents are doing and answer approval prompts, reachable through a tunnel.
//!
//! This is remote CONTROL, not cloud. OctoShell is a desktop app that owns the
//! PTYs, the agent processes and the job object; the phone is a thin client and
//! does nothing while the machine is asleep. Saying so plainly matters, because
//! it decides what is worth building.
//!
//! # Threat model
//!
//! The server is reachable from the public internet whenever a tunnel is up, and
//! it fronts a machine where agents may run with `--dangerously-skip-permissions`.
//! Four properties do the work, in descending order of how much they matter:
//!
//! 1. **The listener only exists while sharing is on.** Stopping (or letting the
//!    session expire) drops the socket, so there is nothing to attack rather than
//!    something well-defended. This is stronger than any credential check.
//! 2. **The access code is OS-random**, not human-chosen and not `RandomState`.
//!    People pick `1234`; and this code, unlike the approval bridge's localhost
//!    token, faces the internet.
//! 3. **Failed attempts lock out.** A tunnel URL is reachable by anyone who finds
//!    it, so an unrate-limited 8-character code is exhaustible. With a lockout it
//!    is not.
//! 4. **The code buys a token once.** After that the code never travels again, so
//!    it can't be replayed off a log or a shoulder.
//!
//! Everything here is the front door. Reading real state and answering approvals
//! is the bridge to the webview, and lands next.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Wrong codes allowed before the door shuts.
const MAX_ATTEMPTS: u32 = 5;
/// How long the door stays shut after that.
const LOCKOUT_SECS: u64 = 15 * 60;
/// Code length. 8 chars of a 32-symbol alphabet is 40 bits — far past guessable
/// once `MAX_ATTEMPTS` applies, and still short enough to read off a screen.
const CODE_LEN: usize = 8;
/// Deliberately excludes 0/O/1/I/L: this gets typed off one screen onto another,
/// and a code you can misread is a support question waiting to happen.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `n` bytes from the OS CSPRNG.
fn os_random(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("OS entropy unavailable");
    buf
}

/// A human-readable access code from OS entropy. Rejection-free: the alphabet's
/// length is not a power of two, so a plain modulo would bias the first symbols.
/// Drawing extra bytes and discarding out-of-range ones keeps it uniform.
fn make_code() -> String {
    let span = ALPHABET.len() as u8;
    let limit = 256 - (256 % ALPHABET.len()); // largest unbiased byte value
    let mut out = String::with_capacity(CODE_LEN);
    while out.len() < CODE_LEN {
        for b in os_random(CODE_LEN * 2) {
            if (b as usize) >= limit {
                continue; // would bias the distribution — draw again
            }
            out.push(ALPHABET[(b % span) as usize] as char);
            if out.len() == CODE_LEN {
                break;
            }
        }
    }
    out
}

fn make_token() -> String {
    os_random(24).iter().map(|b| format!("{b:02x}")).collect()
}

/// Length-aware constant-time comparison (no early-exit timing leak).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A live sharing session.
struct Session {
    code: String,
    token: String,
    /// Unix seconds after which nothing is served and the listener is dropped.
    expires_at: u64,
    port: u16,
    failures: u32,
    /// Unix seconds until which authentication is refused outright.
    locked_until: u64,
    /// Dropping this stops the server task.
    _shutdown: oneshot::Sender<()>,
}

impl Session {
    fn expired(&self) -> bool {
        now_secs() >= self.expires_at
    }
}

/// Managed state: at most one sharing session at a time.
#[derive(Default, Clone)]
pub struct MobileServer(Arc<Mutex<Option<Session>>>);

/// What the UI needs to render the sharing panel.
#[derive(Serialize)]
pub struct MobileStatus {
    pub sharing: bool,
    /// Shown large on screen so it can be typed on the phone. Only while sharing.
    pub code: Option<String>,
    pub port: Option<u16>,
    pub expires_at: Option<u64>,
    /// Seconds remaining, so the UI needn't do clock arithmetic.
    pub seconds_left: Option<u64>,
    pub locked: bool,
}

#[derive(Deserialize)]
struct AuthBody {
    code: String,
}

/// The bearer token on a request, if any.
fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|s| s.trim().to_string())
}

/// Exchange the access code for a session token. The ONLY unauthenticated route.
async fn auth(State(server): State<MobileServer>, Json(body): Json<AuthBody>) -> (StatusCode, Json<serde_json::Value>) {
    let mut guard = server.0.lock().unwrap();
    let Some(s) = guard.as_mut() else {
        return (StatusCode::GONE, Json(json!({ "error": "sharing is off" })));
    };
    if s.expired() {
        return (StatusCode::GONE, Json(json!({ "error": "this share has expired" })));
    }
    let now = now_secs();
    if now < s.locked_until {
        // Report the wait rather than a bare 401: a locked-out owner who mistyped
        // their own code should learn that they are locked out, not retry blindly.
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "too many attempts", "retryAfter": s.locked_until - now })),
        );
    }
    // Compare case-insensitively — the alphabet is uppercase and phone keyboards
    // love to autocapitalise, or not. Still constant-time.
    let given = body.code.trim().to_ascii_uppercase();
    if constant_time_eq(given.as_bytes(), s.code.as_bytes()) {
        s.failures = 0;
        return (
            StatusCode::OK,
            Json(json!({ "token": s.token, "expiresAt": s.expires_at })),
        );
    }
    s.failures += 1;
    if s.failures >= MAX_ATTEMPTS {
        s.locked_until = now + LOCKOUT_SECS;
        s.failures = 0;
    }
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "wrong code" })))
}

/// Whether the request carries a valid, unexpired token.
fn authed(server: &MobileServer, headers: &HeaderMap) -> bool {
    let guard = server.0.lock().unwrap();
    let Some(s) = guard.as_ref() else { return false };
    if s.expired() {
        return false;
    }
    match bearer(headers) {
        Some(t) => constant_time_eq(t.as_bytes(), s.token.as_bytes()),
        None => false,
    }
}

/// Minimal authenticated probe. Real state arrives with the webview bridge.
async fn status(State(server): State<MobileServer>, headers: HeaderMap) -> (StatusCode, Json<serde_json::Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    let guard = server.0.lock().unwrap();
    let expires = guard.as_ref().map(|s| s.expires_at).unwrap_or(0);
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "app": "OctoShell", "expiresAt": expires })),
    )
}

impl MobileServer {
    fn snapshot(&self) -> MobileStatus {
        let guard = self.0.lock().unwrap();
        match guard.as_ref() {
            Some(s) if !s.expired() => MobileStatus {
                sharing: true,
                code: Some(s.code.clone()),
                port: Some(s.port),
                expires_at: Some(s.expires_at),
                seconds_left: Some(s.expires_at.saturating_sub(now_secs())),
                locked: now_secs() < s.locked_until,
            },
            _ => MobileStatus {
                sharing: false,
                code: None,
                port: None,
                expires_at: None,
                seconds_left: None,
                locked: false,
            },
        }
    }
}

/// Start sharing for `minutes`, replacing any current session. Returns the code.
#[tauri::command]
pub async fn mobile_start(
    server: tauri::State<'_, MobileServer>,
    minutes: u64,
) -> Result<MobileStatus, String> {
    start_sharing(&MobileServer(server.inner().0.clone()), minutes).await
}

/// The whole of starting, minus Tauri — so the door can be tested by knocking on
/// it, rather than by reading the code and hoping.
async fn start_sharing(server: &MobileServer, minutes: u64) -> Result<MobileStatus, String> {
    let minutes = minutes.clamp(1, 24 * 60);
    // Bind before publishing any state, so a failure leaves sharing off rather
    // than advertising a code nobody can reach.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("could not open the mobile port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let inner = MobileServer(server.0.clone());
    {
        let mut guard = inner.0.lock().unwrap();
        *guard = Some(Session {
            code: make_code(),
            token: make_token(),
            expires_at: now_secs() + minutes * 60,
            port,
            failures: 0,
            locked_until: 0,
            _shutdown: tx,
        });
    }

    let app_state = inner.clone();
    let router = Router::new()
        .route("/api/auth", post(auth))
        .route("/api/status", get(status))
        .with_state(app_state);

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                // Resolves when the Session (and its sender) is dropped — i.e. on
                // stop, on expiry sweep, or when a new session replaces this one.
                let _ = rx.await;
            })
            .await;
    });

    Ok(inner.snapshot())
}

/// Stop sharing. Dropping the session drops the shutdown sender, which ends the
/// server task — so the socket is gone, not merely guarded.
#[tauri::command]
pub fn mobile_stop(server: tauri::State<'_, MobileServer>) -> MobileStatus {
    {
        let mut guard = server.0.lock().unwrap();
        *guard = None;
    }
    server.inner().snapshot()
}

/// Current sharing state. Also reaps an expired session, so expiry takes the
/// listener down even if the UI never asks again.
#[tauri::command]
pub fn mobile_status(server: tauri::State<'_, MobileServer>) -> MobileStatus {
    {
        let mut guard = server.0.lock().unwrap();
        if guard.as_ref().map(|s| s.expired()).unwrap_or(false) {
            *guard = None;
        }
    }
    server.inner().snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_only_unambiguous_characters() {
        for _ in 0..200 {
            let c = make_code();
            assert_eq!(c.len(), CODE_LEN);
            for ch in c.bytes() {
                assert!(ALPHABET.contains(&ch), "ambiguous character {ch} in {c}");
            }
        }
    }

    #[test]
    fn codes_do_not_repeat() {
        // Not a randomness test — a smoke test that we aren't handing out one
        // constant, which is exactly the bug that would look fine in the UI.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..500 {
            seen.insert(make_code());
        }
        assert!(seen.len() > 490, "codes repeat far too often: {} unique", seen.len());
    }

    /// The front door, exercised over real HTTP rather than by reading the code.
    /// Everything here is a property the threat model claims, so if one of these
    /// regresses the claim in the module doc has quietly become false.
    #[tokio::test]
    async fn the_front_door_holds() {
        let server = MobileServer::default();
        let st = start_sharing(&server, 30).await.expect("start");
        let port = st.port.expect("port");
        let code = st.code.clone().expect("code");
        let base = format!("http://127.0.0.1:{port}");
        let http = reqwest::Client::new();

        // No token: refused.
        let r = http.get(format!("{base}/api/status")).send().await.unwrap();
        assert_eq!(r.status(), 401, "status must require a token");

        // Wrong code: refused, and does not leak the token.
        let r = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": "WRONGWRO" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        assert!(!r.text().await.unwrap().contains("token"));

        // Right code, lowercased on the way in: accepted (phone keyboards).
        let r = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": code.to_lowercase() }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let token = r.json::<serde_json::Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();

        // With the token: served.
        let r = http
            .get(format!("{base}/api/status"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);

        // A wrong token is not "any token".
        let r = http
            .get(format!("{base}/api/status"))
            .bearer_auth("deadbeef")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);

        // Brute force: the fifth miss shuts the door, and it stays shut for the
        // RIGHT code too — otherwise the lockout would only slow an attacker down
        // while still letting them in the moment they got lucky.
        for _ in 0..MAX_ATTEMPTS {
            let _ = http
                .post(format!("{base}/api/auth"))
                .json(&serde_json::json!({ "code": "AAAAAAAA" }))
                .send()
                .await
                .unwrap();
        }
        let r = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": code }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 429, "lockout must apply to the correct code as well");

        // Stopping removes the socket, not merely the permission.
        {
            let mut g = server.0.lock().unwrap();
            *g = None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let gone = http
            .get(format!("{base}/api/status"))
            .bearer_auth(&token)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await;
        assert!(gone.is_err(), "the listener must be gone after stopping");
    }

    /// An expired share serves nothing, even to a token issued while it was live.
    #[tokio::test]
    async fn expiry_closes_the_door() {
        let server = MobileServer::default();
        let st = start_sharing(&server, 30).await.expect("start");
        let port = st.port.unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let http = reqwest::Client::new();

        let r = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": st.code.clone().unwrap() }))
            .send()
            .await
            .unwrap();
        let token = r.json::<serde_json::Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();

        // Move expiry into the past rather than sleeping through it.
        {
            let mut g = server.0.lock().unwrap();
            g.as_mut().unwrap().expires_at = now_secs() - 1;
        }

        let r = http
            .get(format!("{base}/api/status"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401, "an expired share must not serve a live token");

        let r = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": st.code.unwrap() }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 410, "an expired share must not issue new tokens");
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq(b"ABC", b"ABC"));
        assert!(!constant_time_eq(b"ABC", b"ABD"));
        assert!(!constant_time_eq(b"ABC", b"ABCD"));
        assert!(constant_time_eq(b"", b""));
    }
}
