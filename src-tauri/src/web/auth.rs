//! # Single-tenant authentication
//!
//! Harbr is single-user software. There are no accounts — one shared
//! `HARBR_AUTH_TOKEN` is exchanged at `POST /api/login` for an HMAC-signed
//! session cookie, and [`require_auth`] gates every other route including the
//! WebSocket upgrades.
//!
//! The threat model is blunt: a caller who reaches any command route can spawn
//! processes on the host. So the middleware is deny-by-default with a short
//! explicit exemption list, rather than an allow-list of protected paths that
//! a newly added route could forget to join.

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::AppState;
use crate::errors::CommandError;

type HmacSha256 = Hmac<Sha256>;

/// Name of the session cookie.
pub const SESSION_COOKIE: &str = "ship_session";

/// Delay applied to a failed login. Enough to make an online brute force of a
/// 16+ character token hopeless without needing a rate-limit table.
const FAILED_LOGIN_DELAY: Duration = Duration::from_millis(500);

/// Routes reachable without a session. Everything else is denied.
///
/// `/api/login` must be open (it's how you get a session) and `/api/health` is
/// deliberately contentless so a load balancer can poll it. Static assets are
/// served outside this middleware — they're the unprivileged SPA bundle, and
/// the app shows its login screen when an `/api` call comes back 401.
const PUBLIC_PATHS: &[&str] = &["/api/login", "/api/health"];

/// Body of `POST /api/login`.
#[derive(Deserialize)]
pub struct LoginBody {
    pub token: String,
}

/// Render a `CommandError` as an HTTP response using the same
/// `{ok, data|error}` envelope the command routes use, so a rejection from the
/// transport layer is indistinguishable in shape from a rejection from a
/// command and the frontend needs only one error path.
pub fn error_response(status: StatusCode, err: CommandError) -> Response {
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": err })),
    )
        .into_response()
}

fn unauthorized() -> Response {
    error_response(
        StatusCode::UNAUTHORIZED,
        CommandError::NotAuthenticated {
            service: "Harbr".to_string(),
        },
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Mint a signed session cookie value: `<expiry_unix>.<hex_mac>`.
pub fn sign_session(key: &[u8; 32], expires_at: u64) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(expires_at.to_string().as_bytes());
    format!("{expires_at}.{}", hex::encode(mac.finalize().into_bytes()))
}

/// Verify a session cookie value. Returns the expiry on success.
///
/// The MAC is checked with `verify_slice` (constant time) *before* the expiry
/// is trusted, so a forged cookie can't be distinguished from an expired one
/// by timing.
pub fn verify_session(key: &[u8; 32], value: &str) -> Option<u64> {
    let (exp_raw, mac_hex) = value.split_once('.')?;
    let signature = hex::decode(mac_hex).ok()?;

    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(exp_raw.as_bytes());
    mac.verify_slice(&signature).ok()?;

    let expires_at: u64 = exp_raw.parse().ok()?;
    (expires_at > now_secs()).then_some(expires_at)
}

/// Pull one cookie's value out of a `Cookie` header.
///
/// Hand-rolled rather than pulling in a cookie crate: one header, one name, and
/// the parse is three lines. Handles the `a=1; b=2` form browsers actually send.
fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

/// Whether a request's `Origin` is acceptable.
///
/// Absent `Origin` is allowed: browsers attach it to every cross-site request,
/// so its absence means a non-browser client — which still needs a valid
/// session cookie to get anywhere. Present-but-mismatched is refused, which
/// together with `SameSite=Strict` is the CSRF defense.
pub fn origin_allowed(headers: &HeaderMap, expected: Option<&str>) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let origin = origin.trim_end_matches('/');

    match expected {
        Some(expected) => origin.eq_ignore_ascii_case(expected.trim_end_matches('/')),
        // No configured public origin: fall back to same-origin, comparing the
        // Origin's authority against the Host the request was addressed to.
        None => {
            let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
            match (origin.split_once("://"), host) {
                (Some((_, origin_host)), Some(host)) => origin_host.eq_ignore_ascii_case(host),
                _ => false,
            }
        }
    }
}

/// Deny-by-default auth middleware. Applied to the whole `/api` router.
pub async fn require_auth(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let headers = request.headers();

    // CSRF: state-changing requests must not carry a foreign Origin. Checked
    // before the exemption list so `/api/login` is covered too — otherwise a
    // hostile page could silently log the browser into an attacker's session.
    let websocket_upgrade = matches!(path, "/api/events" | "/api/pty");
    let origin_missing = headers.get(header::ORIGIN).is_none();
    if (websocket_upgrade && origin_missing)
        || ((!request.method().is_safe() || websocket_upgrade)
            && !origin_allowed(headers, state.config.public_origin.as_deref()))
    {
        return error_response(
            StatusCode::FORBIDDEN,
            CommandError::Validation {
                field: "Origin".to_string(),
                reason: "request origin is not allowed".to_string(),
            },
        );
    }

    if PUBLIC_PATHS.contains(&path) {
        return next.run(request).await;
    }

    match cookie_value(headers, SESSION_COOKIE) {
        Some(value) if verify_session(&state.config.session_key, value).is_some() => {
            next.run(request).await
        }
        _ => unauthorized(),
    }
}

/// `POST /api/login` — exchange the shared token for a session cookie.
pub async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> Response {
    // Constant-time compare via HMAC of both sides under the session key: two
    // equal-length digests, so neither the token's length nor its prefix leaks
    // through the comparison.
    let digest = |s: &str| {
        let mut mac = HmacSha256::new_from_slice(&state.config.session_key)
            .expect("HMAC accepts any key length");
        mac.update(s.as_bytes());
        mac.finalize().into_bytes()
    };

    if digest(&body.token) != digest(&state.config.auth_token) {
        tokio::time::sleep(FAILED_LOGIN_DELAY).await;
        tracing::warn!("Rejected login attempt with an invalid token");
        return unauthorized();
    }

    let expires_at = now_secs() + state.config.session_ttl_secs;
    let cookie = format!(
        "{SESSION_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        sign_session(&state.config.session_key, expires_at),
        state.config.session_ttl_secs,
        // Secure would make the cookie undeliverable over plain http://, which
        // is how a loopback-bound instance is reached. Set it only once the
        // deployment has declared an https origin.
        if state
            .config
            .public_origin
            .as_deref()
            .is_some_and(|o| o.starts_with("https://"))
        {
            "; Secure"
        } else {
            ""
        }
    );

    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({ "ok": true, "data": null })),
    )
        .into_response()
}

/// `POST /api/logout` — clear the session cookie.
pub async fn logout() -> Response {
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
        )],
        Json(serde_json::json!({ "ok": true, "data": null })),
    )
        .into_response()
}

/// `GET /api/session` — reachable only with a valid cookie, so a 200 here is
/// the frontend's "am I logged in?" probe and a 401 is its cue to show login.
pub async fn session() -> Response {
    Json(serde_json::json!({ "ok": true, "data": { "authenticated": true } })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn session_cookie_round_trips() {
        let expires_at = now_secs() + 60;
        let value = sign_session(&KEY, expires_at);
        assert_eq!(verify_session(&KEY, &value), Some(expires_at));
    }

    #[test]
    fn rejects_a_tampered_expiry() {
        let value = sign_session(&KEY, now_secs() + 60);
        let (_, mac) = value.split_once('.').unwrap();
        // Push the expiry far into the future while keeping the original MAC.
        let forged = format!("{}.{mac}", now_secs() + 999_999);
        assert_eq!(verify_session(&KEY, &forged), None);
    }

    #[test]
    fn rejects_a_tampered_signature() {
        let value = sign_session(&KEY, now_secs() + 60);
        let (exp, mac) = value.split_once('.').unwrap();
        let mut bytes = hex::decode(mac).unwrap();
        bytes[0] ^= 0xff;
        assert_eq!(
            verify_session(&KEY, &format!("{exp}.{}", hex::encode(bytes))),
            None
        );
    }

    #[test]
    fn rejects_another_keys_cookie() {
        let value = sign_session(&[9u8; 32], now_secs() + 60);
        assert_eq!(verify_session(&KEY, &value), None);
    }

    #[test]
    fn rejects_an_expired_cookie() {
        let value = sign_session(&KEY, now_secs() - 1);
        assert_eq!(verify_session(&KEY, &value), None);
    }

    #[test]
    fn rejects_malformed_cookies() {
        for value in ["", ".", "abc", "123.", "123.zz", "notanumber.aabb"] {
            assert_eq!(verify_session(&KEY, value), None, "value `{value}`");
        }
    }

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn extracts_one_cookie_from_a_multi_cookie_header() {
        let map = headers(&[(header::COOKIE, "other=1; ship_session=abc.def; last=2")]);
        assert_eq!(cookie_value(&map, SESSION_COOKIE), Some("abc.def"));
        assert_eq!(cookie_value(&map, "missing"), None);
        assert_eq!(cookie_value(&HeaderMap::new(), SESSION_COOKIE), None);
    }

    #[test]
    fn origin_check_matches_the_configured_origin() {
        let expected = Some("https://ship.example.com");
        assert!(origin_allowed(
            &headers(&[(header::ORIGIN, "https://ship.example.com")]),
            expected
        ));
        // Trailing slash is normalized away on both sides.
        assert!(origin_allowed(
            &headers(&[(header::ORIGIN, "https://ship.example.com/")]),
            expected
        ));
        assert!(!origin_allowed(
            &headers(&[(header::ORIGIN, "https://evil.example.com")]),
            expected
        ));
        // Scheme is part of the origin — http is not https.
        assert!(!origin_allowed(
            &headers(&[(header::ORIGIN, "http://ship.example.com")]),
            expected
        ));
    }

    #[test]
    fn origin_check_falls_back_to_host_when_unconfigured() {
        assert!(origin_allowed(
            &headers(&[
                (header::ORIGIN, "http://localhost:1420"),
                (header::HOST, "localhost:1420"),
            ]),
            None
        ));
        assert!(!origin_allowed(
            &headers(&[
                (header::ORIGIN, "http://evil.test"),
                (header::HOST, "localhost:1420"),
            ]),
            None
        ));
        // Origin present but no Host to compare against → refuse.
        assert!(!origin_allowed(
            &headers(&[(header::ORIGIN, "http://localhost:1420")]),
            None
        ));
    }

    #[test]
    fn absent_origin_is_allowed_for_non_browser_clients() {
        assert!(origin_allowed(&HeaderMap::new(), Some("https://ship.test")));
        assert!(origin_allowed(&HeaderMap::new(), None));
    }
}
