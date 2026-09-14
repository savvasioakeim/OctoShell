//! Web Push: waking the phone when an agent finishes, without a second app.
//!
//! # Why this and not a notification service
//!
//! A page — even one installed to a home screen — cannot run while it is closed.
//! The only way to reach it is Web Push, which means the browser's own push
//! service (FCM on Android). That sounds like handing Google your notifications,
//! and it is worth being precise about why it isn't:
//!
//! **The payload is encrypted end to end** (RFC 8291). The browser publishes a
//! public key when it subscribes; we encrypt with it; the push service has no
//! key and cannot read the message. It sees that *something* was delivered, its
//! size and its timing — never its content.
//!
//! That makes Web Push the only option that needs no extra app on the phone AND
//! keeps the content private. A notification service like ntfy would need its own
//! app installed and — on its public instance — post to a topic anyone who learns
//! the name can read.
//!
//! # What is stored
//!
//! One JSON file next to the database: the VAPID key pair (generated once, this
//! server's identity to the push service) and the subscriptions phones have
//! handed us. Subscriptions are per-origin, so they die when the address changes
//! — which is why a quick tunnel is only good enough for trying this out, and a
//! named tunnel is what makes it stick.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::p256::PublicKey;
use web_push_native::{Auth, WebPushBuilder};

/// How long a push may sit at the service before it's dropped. Short on purpose:
/// "an agent finished" is worthless an hour later, and a stale buzz is worse than
/// no buzz.
const TTL: Duration = Duration::from_secs(30 * 60);

/// A subscription as the browser hands it over.
#[derive(Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    /// The browser's public key, base64url (no padding).
    pub p256dh: String,
    /// The auth secret, base64url (no padding).
    pub auth: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    /// PEM of the ES256 key pair. Generated once; changing it invalidates every
    /// subscription, because the push service ties them to this identity.
    vapid_pem: Option<String>,
    subs: Vec<Subscription>,
}

#[derive(Default, Clone)]
pub struct PushState(Arc<Mutex<Option<Store>>>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("push.json"))
}

fn load(app: &AppHandle) -> Store {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

impl PushState {
    fn with<R>(&self, app: &AppHandle, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut guard = self.0.lock().unwrap();
        if guard.is_none() {
            *guard = Some(load(app));
        }
        f(guard.as_mut().expect("just loaded"))
    }
}

/// The key pair, generating and persisting one on first use.
fn key_pair(app: &AppHandle, state: &PushState) -> Result<ES256KeyPair, String> {
    let pem = state.with(app, |s| {
        if s.vapid_pem.is_none() {
            let kp = ES256KeyPair::generate();
            s.vapid_pem = kp.to_pem().ok();
            let _ = save(app, s);
        }
        s.vapid_pem.clone()
    });
    let pem = pem.ok_or("could not create a VAPID key")?;
    ES256KeyPair::from_pem(&pem).map_err(|e| format!("bad VAPID key: {e}"))
}

/// The VAPID public key as the 65-byte uncompressed P-256 point browsers want.
///
/// jwt-simple hands back the COMPRESSED form (33 bytes), and `pushManager
/// .subscribe` rejects that — with an error that names nothing useful. So it is
/// re-encoded here, and a test pins the length and leading 0x04.
fn application_server_key(kp: &ES256KeyPair) -> Result<Vec<u8>, String> {
    use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint;
    let compressed = kp.public_key().to_bytes();
    let pk = PublicKey::from_sec1_bytes(&compressed).map_err(|e| format!("bad VAPID point: {e}"))?;
    Ok(pk.to_encoded_point(false).as_bytes().to_vec())
}

/// The `applicationServerKey` the page passes to `pushManager.subscribe`.
#[tauri::command]
pub fn push_public_key(app: AppHandle, state: tauri::State<'_, PushState>) -> Result<String, String> {
    let kp = key_pair(&app, &state)?;
    Ok(URL_SAFE_NO_PAD.encode(application_server_key(&kp)?))
}

/// Remember a subscription. Replacing by endpoint keeps re-subscribing (which a
/// browser does on its own schedule) from piling up duplicates that would each
/// produce their own buzz.
#[tauri::command]
pub fn push_subscribe(
    app: AppHandle,
    state: tauri::State<'_, PushState>,
    sub: Subscription,
) -> Result<usize, String> {
    state.with(&app, |s| {
        s.subs.retain(|x| x.endpoint != sub.endpoint);
        s.subs.push(sub);
        let _ = save(&app, s);
        Ok(s.subs.len())
    })
}

#[tauri::command]
pub fn push_unsubscribe(
    app: AppHandle,
    state: tauri::State<'_, PushState>,
    endpoint: String,
) -> Result<usize, String> {
    state.with(&app, |s| {
        s.subs.retain(|x| x.endpoint != endpoint);
        let _ = save(&app, s);
        Ok(s.subs.len())
    })
}

/// How many devices are subscribed — so the UI can say whether this does anything.
#[tauri::command]
pub fn push_count(app: AppHandle, state: tauri::State<'_, PushState>) -> usize {
    state.with(&app, |s| s.subs.len())
}

/// Decode a subscription's keys into what the encryption needs.
fn decode(sub: &Subscription) -> Result<(PublicKey, Auth), String> {
    let p = URL_SAFE_NO_PAD
        .decode(sub.p256dh.trim())
        .map_err(|e| format!("bad p256dh: {e}"))?;
    let a = URL_SAFE_NO_PAD
        .decode(sub.auth.trim())
        .map_err(|e| format!("bad auth: {e}"))?;
    let public = PublicKey::from_sec1_bytes(&p).map_err(|e| format!("bad p256dh point: {e}"))?;
    if a.len() != 16 {
        return Err(format!("auth secret is {} bytes, expected 16", a.len()));
    }
    Ok((public, *Auth::from_slice(&a)))
}

/// Send one notification to every subscribed device.
///
/// Returns how many were delivered. Subscriptions the push service rejects as
/// gone (404/410) are DROPPED rather than retried forever — a phone that was
/// reset would otherwise keep costing a failed request on every agent turn.
#[tauri::command]
pub async fn push_notify(
    app: AppHandle,
    state: tauri::State<'_, PushState>,
    title: String,
    body: String,
) -> Result<usize, String> {
    let subs = state.with(&app, |s| s.subs.clone());
    if subs.is_empty() {
        return Ok(0);
    }
    let kp = key_pair(&app, &state)?;
    // Deliberately minimal: a title and one line. The payload is encrypted, but
    // it still lands on a lock screen someone else may be looking at, and the
    // details are one tap away in the app.
    let payload = serde_json::json!({ "title": title, "body": body }).to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut sent = 0usize;
    let mut gone: Vec<String> = Vec::new();
    for sub in &subs {
        let Ok((public, auth)) = decode(sub) else { continue };
        let Ok(uri) = sub.endpoint.parse::<http::Uri>() else { continue };
        let built = WebPushBuilder::new(uri, public, auth)
            .with_valid_duration(TTL)
            .with_vapid(&kp, "mailto:octoshell@localhost")
            .build(payload.clone());
        let Ok(req) = built else { continue };

        let mut headers = reqwest::header::HeaderMap::new();
        for (k, v) in req.headers() {
            headers.insert(k.clone(), v.clone());
        }
        match client
            .post(sub.endpoint.clone())
            .headers(headers)
            .body(req.body().clone())
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => sent += 1,
            Ok(r) if r.status() == 404 || r.status() == 410 => gone.push(sub.endpoint.clone()),
            _ => {}
        }
    }
    if !gone.is_empty() {
        state.with(&app, |s| {
            s.subs.retain(|x| !gone.contains(&x.endpoint));
            let _ = save(&app, s);
        });
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_key_round_trips_through_pem() {
        // If this breaks, every phone silently stops receiving: the key is the
        // identity the push service ties subscriptions to, so failing to reload
        // the SAME one is indistinguishable from "no notifications work".
        let kp = ES256KeyPair::generate();
        let pem = kp.to_pem().expect("pem");
        let back = ES256KeyPair::from_pem(&pem).expect("reload");
        assert_eq!(
            kp.public_key().to_bytes(),
            back.public_key().to_bytes(),
        );
    }

    #[test]
    fn the_application_server_key_is_an_uncompressed_point() {
        let kp = ES256KeyPair::generate();
        let raw = application_server_key(&kp).expect("encode");
        // 0x04 followed by X and Y, 65 bytes. Browsers reject anything else, and
        // they reject it at subscribe() time with a message that says nothing.
        assert_eq!(raw.len(), 65);
        assert_eq!(raw[0], 0x04);
        let encoded = URL_SAFE_NO_PAD.encode(raw);
        assert!(!encoded.contains('='), "must be unpadded base64url");
        assert!(!encoded.contains('+') && !encoded.contains('/'), "must be URL-safe");
    }

    #[test]
    fn subscription_keys_are_validated_not_trusted() {
        let bad_auth = Subscription {
            endpoint: "https://example.com/x".into(),
            p256dh: URL_SAFE_NO_PAD.encode(ES256KeyPair::generate().public_key().to_bytes()),
            auth: URL_SAFE_NO_PAD.encode([0u8; 8]), // too short
        };
        assert!(decode(&bad_auth).unwrap_err().contains("8 bytes"));

        let bad_point = Subscription {
            endpoint: "https://example.com/x".into(),
            p256dh: URL_SAFE_NO_PAD.encode([1u8; 65]),
            auth: URL_SAFE_NO_PAD.encode([0u8; 16]),
        };
        assert!(decode(&bad_point).is_err());
    }

    #[test]
    fn a_real_subscription_decodes() {
        let kp = ES256KeyPair::generate();
        let sub = Subscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
            p256dh: URL_SAFE_NO_PAD.encode(kp.public_key().to_bytes()),
            auth: URL_SAFE_NO_PAD.encode([7u8; 16]),
        };
        assert!(decode(&sub).is_ok());
    }
}
