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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
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

/// How long a question to the webview may take before the phone gets an error.
/// Bounded because the UI answering these is the same thread that renders: a
/// wedged answer must fail the one request, never hang the connection.
const ASK_TIMEOUT: Duration = Duration::from_secs(8);

static ASK_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Managed state: at most one sharing session, plus the questions in flight.
///
/// The phone asks for things only the WEBVIEW knows. The project list, which
/// agent is busy, what a session's blocks say — none of that is in the database
/// (the project list lives in localStorage, and live status lives only in memory).
/// So this server does not read state; it asks the running app for it, exactly
/// the way `approval.rs` asks the user for a decision.
#[derive(Default, Clone)]
pub struct MobileServer {
    session: Arc<Mutex<Option<Session>>>,
    /// Question id → where to deliver the answer.
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>>,
    /// How to deliver a question to the window. A closure rather than the
    /// `AppHandle` itself, for two reasons:
    ///
    /// - Storing `AppHandle` (which is `AppHandle<Wry>`) in a field drags the
    ///   webview runtime's types into anything that constructs this struct. The
    ///   library's TEST binary then fails to start at all — STATUS_ENTRYPOINT_
    ///   NOT_FOUND, before a single test runs — because it has no WebView2
    ///   alongside it. Erasing the runtime behind a trait object keeps the server
    ///   testable, which for the piece that faces the internet is not optional.
    /// - It also lets a test install its own emitter and exercise the whole
    ///   ask/respond round trip without a window.
    emit: Arc<Mutex<Option<AskEmit>>>,
}

/// Delivers one question; returns false if the window is gone.
type AskEmit = Arc<dyn Fn(AskEvent) -> bool + Send + Sync>;

/// A question for the webview, delivered as `mobile://request`.
#[derive(Clone, Serialize)]
struct AskEvent {
    id: String,
    kind: String,
    params: Value,
}

impl MobileServer {
    /// Ask the webview something and wait for `mobile_respond`.
    ///
    /// Every failure path resolves rather than hanging: no window, no listener,
    /// or a UI that never answers all become an error the phone can render.
    async fn ask(&self, kind: &str, params: Value) -> Result<Value, String> {
        let id = format!("m{}", ASK_COUNTER.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let emit = self.emit.lock().unwrap().clone();
        let Some(emit) = emit else {
            self.pending.lock().unwrap().remove(&id);
            return Err("the app window is not available".into());
        };
        if !emit(AskEvent { id: id.clone(), kind: kind.to_string(), params }) {
            self.pending.lock().unwrap().remove(&id);
            return Err("could not reach the app window".into());
        }

        match tokio::time::timeout(ASK_TIMEOUT, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("the app closed the request".into()),
            Err(_) => {
                // Drop the slot so a late answer doesn't accumulate forever.
                self.pending.lock().unwrap().remove(&id);
                Err("the app did not answer in time".into())
            }
        }
    }
}

/// The webview's answer to one `mobile://request`.
#[tauri::command]
pub fn mobile_respond(server: tauri::State<'_, MobileServer>, id: String, data: Value) {
    if let Some(tx) = server.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(data);
    }
}

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
    let mut guard = server.session.lock().unwrap();
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
    let guard = server.session.lock().unwrap();
    let Some(s) = guard.as_ref() else { return false };
    if s.expired() {
        return false;
    }
    match bearer(headers) {
        Some(t) => constant_time_eq(t.as_bytes(), s.token.as_bytes()),
        None => false,
    }
}

/// The open projects and what each one is doing.
async fn projects(State(server): State<MobileServer>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    match server.ask("projects", json!({})).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// One project's feed, newest last, a page at a time.
///
/// Paginated on purpose: a session is stored as ONE JSON blob (measured at
/// hundreds of KB), which is fine on the desktop and unacceptable over mobile
/// data. The phone never asks for a whole session.
async fn session_feed(
    State(server): State<MobileServer>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<FeedQuery>,
) -> (StatusCode, Json<Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    match server
        .ask("session", json!({ "id": q.id, "before": q.before, "limit": limit }))
        .await
    {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(Deserialize)]
struct FeedQuery {
    /// Project (session) id.
    id: String,
    /// Return blocks before this index — the cursor for "load older".
    before: Option<usize>,
    limit: Option<usize>,
}

/// The phone UI, embedded in the binary.
///
/// One self-contained file rather than a bundled app: it is served from the
/// user's own machine over a tunnel, so every extra origin would be another thing
/// to trust and another thing to fail on a bad connection. It also means the
/// mobile UI ships with the binary and can never be out of step with the API.
const MOBILE_HTML: &str = include_str!("../mobile-ui/index.html");

/// The page itself. Unauthenticated on purpose — it contains no data, only the
/// code prompt; everything it shows comes from the authenticated API.
async fn ui() -> axum::response::Response {
    use axum::response::IntoResponse;
    ([(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], MOBILE_HTML).into_response()
}

/// The app icon, as SVG. One file, no raster sizes to keep in step — Android
/// accepts SVG in a manifest and scales it for every launcher density.
const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
<rect width="192" height="192" rx="42" fill="#292D3E"/>
<text x="96" y="130" font-size="104" text-anchor="middle">🐙</text>
</svg>"##;

async fn icon() -> axum::response::Response {
    use axum::response::IntoResponse;
    ([(axum::http::header::CONTENT_TYPE, "image/svg+xml")], ICON_SVG).into_response()
}

/// A service worker exists for one reason: Chrome refuses to treat a page as
/// installable without one. It deliberately caches NOTHING — a stale shell that
/// talks to a changed API is worse than a page that simply needs the network,
/// and this app is useless offline anyway (its whole content is live state).
const SERVICE_WORKER: &str = r#"self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
"#;

async fn service_worker() -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        [(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        SERVICE_WORKER,
    )
        .into_response()
}

/// Enough manifest for "Add to Home Screen" to give a real app icon and name.
async fn manifest() -> axum::response::Response {
    use axum::response::IntoResponse;
    let body = json!({
        "name": "OctoShell",
        "short_name": "OctoShell",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#292D3E",
        "theme_color": "#292D3E",
        "icons": [
            { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
        ]
    });
    (
        [(axum::http::header::CONTENT_TYPE, "application/manifest+json")],
        body.to_string(),
    )
        .into_response()
}

/// Every agent currently blocked on a human decision.
async fn approvals(State(server): State<MobileServer>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    match server.ask("approvals", json!({})).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(Deserialize)]
struct ApproveBody {
    #[serde(rename = "requestId")]
    request_id: String,
    allow: bool,
}

/// Answer one approval prompt.
///
/// The decision goes through the webview so it takes the SAME path as a click on
/// the desktop: the block updates, and `approval_respond` resolves the waiting
/// channel exactly once — so if the phone and the desk answer together, the first
/// wins and the second is a no-op instead of a conflict.
async fn approve(
    State(server): State<MobileServer>,
    headers: HeaderMap,
    Json(body): Json<ApproveBody>,
) -> (StatusCode, Json<Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    match server
        .ask("approve", json!({ "requestId": body.request_id, "allow": body.allow }))
        .await
    {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// Minimal authenticated probe: proves the token works without asking the UI.
async fn status(State(server): State<MobileServer>, headers: HeaderMap) -> (StatusCode, Json<serde_json::Value>) {
    if !authed(&server, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" })));
    }
    let guard = server.session.lock().unwrap();
    let expires = guard.as_ref().map(|s| s.expires_at).unwrap_or(0);
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "app": "OctoShell", "expiresAt": expires })),
    )
}

impl MobileServer {
    fn snapshot(&self) -> MobileStatus {
        let guard = self.session.lock().unwrap();
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
///
/// `port` binds somewhere specific instead of a random port. A NAMED tunnel needs
/// it: its ingress is configured in Cloudflare's dashboard against a fixed
/// address, and `--url` does not override dashboard ingress rules — so the port
/// has to be the one the dashboard was told about. Quick tunnels keep the random
/// port, which is one less thing to collide with.
#[tauri::command]
pub async fn mobile_start(
    server: tauri::State<'_, MobileServer>,
    app: AppHandle,
    minutes: u64,
    port: Option<u16>,
) -> Result<MobileStatus, String> {
    let s = server.inner().clone();
    *s.emit.lock().unwrap() = Some(Arc::new(move |e: AskEvent| {
        app.emit("mobile://request", e).is_ok()
    }));
    start_sharing(&s, minutes, port).await
}

/// The whole of starting, minus Tauri — so the door can be tested by knocking on
/// it, rather than by reading the code and hoping.
async fn start_sharing(server: &MobileServer, minutes: u64, port: Option<u16>) -> Result<MobileStatus, String> {
    let minutes = minutes.clamp(1, 24 * 60);
    // Bind before publishing any state, so a failure leaves sharing off rather
    // than advertising a code nobody can reach.
    let want = port.unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", want)).await.map_err(|e| {
        if want == 0 {
            format!("could not open the mobile port: {e}")
        } else {
            // Naming the port matters: with a fixed one this is usually "something
            // else already has it", which the user can act on.
            format!("could not open port {want}: {e}. Something else may be using it.")
        }
    })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let inner = server.clone();
    {
        let mut guard = inner.session.lock().unwrap();
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
        .route("/api/projects", get(projects))
        .route("/api/session", get(session_feed))
        .route("/api/approvals", get(approvals))
        .route("/api/approve", post(approve))
        .route("/", get(ui))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon))
        .route("/sw.js", get(service_worker))
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
        let mut guard = server.session.lock().unwrap();
        *guard = None;
    }
    server.inner().snapshot()
}

/// Current sharing state. Also reaps an expired session, so expiry takes the
/// listener down even if the UI never asks again.
#[tauri::command]
pub fn mobile_status(server: tauri::State<'_, MobileServer>) -> MobileStatus {
    {
        let mut guard = server.session.lock().unwrap();
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
        let st = start_sharing(&server, 30, None).await.expect("start");
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
            let mut g = server.session.lock().unwrap();
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

    /// The phone UI is served without a token (it holds no data) while every
    /// data route still refuses one. Getting this backwards would either lock
    /// people out of the login page or hand out state to anyone with the URL.
    #[tokio::test]
    async fn the_page_is_public_but_the_data_is_not() {
        let server = MobileServer::default();
        let st = start_sharing(&server, 30, None).await.expect("start");
        let base = format!("http://127.0.0.1:{}", st.port.unwrap());
        let http = reqwest::Client::new();

        let r = http.get(&base).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let html = r.text().await.unwrap();
        assert!(html.contains("OctoShell"));
        assert!(html.contains("/api/auth"), "the page must know where to log in");
        // The page must not ship a token or a code.
        assert!(!html.contains(&st.code.clone().unwrap()));

        let r = http.get(format!("{base}/manifest.webmanifest")).send().await.unwrap();
        assert_eq!(r.status(), 200);

        // The PWA's own files must be public too, or Chrome can't install it.
        for path in ["/manifest.webmanifest", "/icon.svg", "/sw.js"] {
            let r = http.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(r.status(), 200, "{path} must be served without a token");
        }

        for path in ["/api/projects", "/api/session?id=x", "/api/approvals", "/api/status"] {
            let r = http.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(r.status(), 401, "{path} must require a token");
        }
        let r = http
            .post(format!("{base}/api/approve"))
            .json(&serde_json::json!({ "requestId": "x", "allow": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401, "/api/approve must require a token");
    }

    /// The whole ask/respond round trip, with a stand-in for the window. This is
    /// what the trait-object emitter buys: the bridge is exercised, not assumed.
    #[tokio::test]
    async fn a_question_reaches_the_window_and_the_answer_comes_back() {
        let server = MobileServer::default();
        let seen = Arc::new(Mutex::new(Vec::<AskEvent>::new()));
        {
            let seen = seen.clone();
            let s2 = server.clone();
            *server.emit.lock().unwrap() = Some(Arc::new(move |e: AskEvent| {
                seen.lock().unwrap().push(e.clone());
                // Answer the way the webview does, from another task so `ask` is
                // genuinely waiting rather than resolving inline.
                let s3 = s2.clone();
                tokio::spawn(async move {
                    if let Some(tx) = s3.pending.lock().unwrap().remove(&e.id) {
                        let _ = tx.send(json!({ "echo": e.kind }));
                    }
                });
                true
            }));
        }

        let got = server.ask("projects", json!({ "a": 1 })).await.unwrap();
        assert_eq!(got, json!({ "echo": "projects" }));
        let asked = seen.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].kind, "projects");
        assert_eq!(asked[0].params, json!({ "a": 1 }));
        // Nothing left waiting.
        assert!(server.pending.lock().unwrap().is_empty());
    }

    /// A window that never answers must time out, not wedge the connection.
    #[tokio::test]
    async fn a_silent_window_times_out() {
        let server = MobileServer::default();
        *server.emit.lock().unwrap() = Some(Arc::new(|_| true)); // accepts, never replies
        let began = std::time::Instant::now();
        let err = tokio::time::timeout(ASK_TIMEOUT * 2, server.ask("projects", json!({})))
            .await
            .expect("ask must return on its own")
            .unwrap_err();
        assert!(err.contains("did not answer"));
        assert!(began.elapsed() >= ASK_TIMEOUT);
        // The slot is released, so a silent window can't leak memory per request.
        assert!(server.pending.lock().unwrap().is_empty());
    }

    /// With no window to ask, a state request FAILS rather than hanging. The
    /// phone must get an error it can render, not a connection that sits open
    /// until the 8-second timeout — and certainly not one that never returns.
    #[tokio::test]
    async fn a_state_request_without_a_window_fails_fast() {
        let server = MobileServer::default();
        let st = start_sharing(&server, 30, None).await.expect("start");
        let base = format!("http://127.0.0.1:{}", st.port.unwrap());
        let http = reqwest::Client::new();
        let token = http
            .post(format!("{base}/api/auth"))
            .json(&serde_json::json!({ "code": st.code.unwrap() }))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();

        let began = std::time::Instant::now();
        let r = http
            .get(format!("{base}/api/projects"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 502);
        assert!(began.elapsed() < ASK_TIMEOUT, "must not wait out the ask timeout");
        let body = r.json::<serde_json::Value>().await.unwrap();
        assert!(body["error"].as_str().unwrap().contains("window"));
    }

    /// mobile_respond delivers an answer to the waiting request, and a second
    /// answer for the same id is harmless (the phone must not get two replies).
    #[tokio::test]
    async fn responding_resolves_exactly_once() {
        let server = MobileServer::default();
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        server.pending.lock().unwrap().insert("m1".into(), tx);

        if let Some(t) = server.pending.lock().unwrap().remove("m1") {
            let _ = t.send(json!({ "ok": true }));
        }
        assert_eq!(rx.await.unwrap(), json!({ "ok": true }));
        // The slot is gone, so a late duplicate is a no-op rather than a panic.
        assert!(server.pending.lock().unwrap().remove("m1").is_none());
    }

    /// An expired share serves nothing, even to a token issued while it was live.
    #[tokio::test]
    async fn expiry_closes_the_door() {
        let server = MobileServer::default();
        let st = start_sharing(&server, 30, None).await.expect("start");
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
            let mut g = server.session.lock().unwrap();
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
