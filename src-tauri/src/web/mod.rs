//! # Self-hosted web server
//!
//! Replaces Tauri's IPC transport with HTTP + WebSocket so the same backend can
//! be driven from a browser. Everything under `/api` is behind [`auth`]; the
//! built frontend is served as ordinary static files.
//!
//! Compiled only under the `web` cargo feature — the desktop build never links
//! any of this, and stays the reference implementation for correct behavior.

pub mod auth;
pub mod commands;
pub mod config;
pub mod events;
pub mod pty;

use axum::{
    extract::State,
    http::StatusCode,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};

pub use config::Config;

use crate::errors::CommandError;

/// Shared state handed to every route.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub events: tokio::sync::broadcast::Sender<crate::emit::Frame>,
    pub sessions: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

/// `GET /api/health` — unauthenticated liveness probe. Deliberately says
/// nothing about the host beyond the app version.
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "data": { "status": "ok", "version": env!("CARGO_PKG_VERSION") }
    }))
}

/// Catch-all for unmatched `/api/*` paths, so a typo'd endpoint returns a JSON
/// 404 instead of falling through to the SPA's `index.html`.
async fn api_not_found(State(_): State<AppState>) -> Response {
    auth::error_response(
        StatusCode::NOT_FOUND,
        CommandError::Other {
            message: "unknown endpoint".to_string(),
        },
    )
}

/// Build the full application router.
pub fn router(state: AppState) -> Router {
    let index = state.config.static_dir.join("index.html");
    let static_files = ServeDir::new(&state.config.static_dir).fallback(ServeFile::new(index));

    // `route_layer` applies the auth middleware to these routes only — the
    // static bundle is public (it holds no data; every call it makes is gated).
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/session", get(auth::session))
        .route("/api/cmd/{name}", post(commands::dispatch))
        .route("/api/events", get(events::events))
        .route("/api/pty", get(pty::pty))
        // Explicit wildcard rather than `.fallback` — the outer router owns the
        // fallback (the SPA), and `merge` would silently drop this one.
        .route("/api/{*rest}", get(api_not_found).post(api_not_found))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ))
        .with_state(state);

    Router::new().merge(api).fallback_service(static_files)
}

/// Read config from the environment, bind, and serve until shutdown.
pub async fn serve() -> Result<(), String> {
    let config = Config::from_env()?;

    if config.is_externally_bound() {
        let banner = format!(
            "================================================================\n\
             Ship Studio is bound to {} — NOT loopback.\n\
             This server grants shell access to the host to anyone holding\n\
             SHIP_AUTH_TOKEN. Put TLS and a reverse proxy in front of it.\n\
             ================================================================",
            config.bind
        );
        // Straight to stderr as well as the log: a security warning must not be
        // swallowed by an unlucky RUST_LOG filter.
        eprintln!("{banner}");
        tracing::warn!("{banner}");
    }

    if !config.static_dir.is_dir() {
        tracing::warn!(
            "Static directory {} does not exist — the UI will 404. Run `pnpm build` or set SHIP_STATIC_DIR.",
            config.static_dir.display()
        );
    }

    let bind = config.bind;
    let state = AppState {
        config: Arc::new(config),
        events: crate::emit::init_broadcast(),
        sessions: Arc::default(),
    };

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("Failed to bind {bind}: {e}"))?;

    tracing::info!("Ship Studio server listening on http://{bind}");

    axum::serve(listener, router(state))
        .await
        .map_err(|e| format!("Server error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request};
    use tower::ServiceExt;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState {
            config: Arc::new(Config {
                bind: "127.0.0.1:1420".parse().unwrap(),
                auth_token: "test-token-that-is-long-enough".to_string(),
                session_key: [42u8; 32],
                public_origin: Some("http://localhost:1420".to_string()),
                static_dir: std::path::PathBuf::from("dist"),
                preview_ports: (3100, 3130),
                preview_bind: "127.0.0.1".parse().unwrap(),
                session_ttl_secs: 3600,
            }),
            events,
            sessions: Arc::default(),
        }
    }

    fn valid_cookie(state: &AppState) -> String {
        let exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 600;
        format!(
            "{}={}",
            auth::SESSION_COOKIE,
            auth::sign_session(&state.config.session_key, exp)
        )
    }

    async fn send(state: AppState, request: Request<Body>) -> (StatusCode, String) {
        let response = router(state).oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).to_string())
    }

    fn websocket_request(path: &str, cookie: Option<&str>, origin: &str) -> Request<Body> {
        let mut request = Request::get(path)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header(header::ORIGIN, origin);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn websocket_upgrade_requires_a_session() {
        let (status, _) = send(
            test_state(),
            websocket_request(
                "/api/events?window_label=main",
                None,
                "http://localhost:1420",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn websocket_upgrade_rejects_a_foreign_origin() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, _) = send(
            state,
            websocket_request(
                "/api/events?window_label=main",
                Some(&cookie),
                "https://attacker.example",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn pty_websocket_rejects_a_foreign_origin() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, _) = send(
            state,
            websocket_request("/api/pty", Some(&cookie), "https://attacker.example"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn health_needs_no_session() {
        let (status, body) = send(
            test_state(),
            Request::get("/api/health").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"status\":\"ok\""));
        // Must not leak host detail.
        assert!(!body.contains("token"));
    }

    #[tokio::test]
    async fn protected_route_without_a_cookie_is_401() {
        let (status, body) = send(
            test_state(),
            Request::get("/api/session").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("\"type\":\"NotAuthenticated\""));
    }

    #[tokio::test]
    async fn protected_route_with_a_tampered_cookie_is_401() {
        let state = test_state();
        let cookie = valid_cookie(&state).replace(['a', '1'], "b");
        let (status, _) = send(
            state,
            Request::get("/api/session")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn protected_route_with_a_valid_cookie_is_200() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::get("/api/session")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"authenticated\":true"));
    }

    #[tokio::test]
    async fn login_with_the_right_token_sets_a_cookie() {
        let state = test_state();
        let response = router(state.clone())
            .oneshot(
                Request::post("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "http://localhost:1420")
                    .body(Body::from(r#"{"token":"test-token-that-is-long-enough"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.contains("HttpOnly"), "cookie must be HttpOnly");
        assert!(
            cookie.contains("SameSite=Strict"),
            "cookie must be SameSite=Strict"
        );
        // http origin → no Secure flag, or a loopback deployment can't log in.
        assert!(!cookie.contains("Secure"));

        let value = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        assert!(auth::verify_session(&state.config.session_key, value).is_some());
    }

    #[tokio::test]
    async fn login_with_the_wrong_token_is_401() {
        let (status, _) = send(
            test_state(),
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .body(Body::from(r#"{"token":"wrong-token-but-long-enough"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn login_from_a_foreign_origin_is_403() {
        let (status, body) = send(
            test_state(),
            Request::post("/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "https://evil.example.com")
                .body(Body::from(r#"{"token":"test-token-that-is-long-enough"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("\"type\":\"Validation\""));
    }

    #[tokio::test]
    async fn state_changing_request_from_a_foreign_origin_is_403_even_with_a_session() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, _) = send(
            state,
            Request::post("/api/logout")
                .header(header::COOKIE, cookie)
                .header(header::ORIGIN, "https://evil.example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn command_routes_require_a_session() {
        let (status, body) = send(
            test_state(),
            Request::post("/api/cmd/list_projects")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("\"type\":\"NotAuthenticated\""));
    }

    #[tokio::test]
    async fn a_command_call_returns_the_ok_envelope() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        state.sessions.lock().unwrap().insert("web-test".into());
        let (status, body) = send(
            state,
            Request::post("/api/cmd/get_active_session_count")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::COOKIE, cookie)
                .header("x-ship-window", "web-test")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body).expect("JSON body");
        assert_eq!(json["ok"], serde_json::json!(true));
        assert!(json["data"].is_number(), "body was {body}");
    }

    #[tokio::test]
    async fn a_command_rejects_a_stale_browser_session() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::post("/api/cmd/get_active_session_count")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::COOKIE, cookie)
                .header("x-ship-window", "web-not-connected")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("browser session"));
    }

    #[tokio::test]
    async fn a_failing_command_still_returns_200_with_ok_false() {
        // The envelope carries the verdict; a command error is not a transport
        // error, and the frontend must not have to treat it as one.
        let state = test_state();
        let cookie = valid_cookie(&state);
        state.sessions.lock().unwrap().insert("web-test".into());
        let (status, body) = send(
            state,
            Request::post("/api/cmd/detect_project_type_command")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::COOKIE, cookie)
                .header("x-ship-window", "web-test")
                .body(Body::from(r#"{"projectPath":"/definitely/not/here"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body).expect("JSON body");
        assert_eq!(json["ok"], serde_json::json!(false));
        // The tagged discriminator must survive untouched — `asCommandError`
        // in src/lib/errors.ts keys off exactly this.
        assert!(json["error"]["type"].is_string(), "body was {body}");
    }

    #[tokio::test]
    async fn an_unknown_command_is_404() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::post("/api/cmd/no_such_command")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::COOKIE, cookie)
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("unknown command"));
    }

    #[tokio::test]
    async fn a_command_call_from_a_foreign_origin_is_403() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, _) = send(
            state,
            Request::post("/api/cmd/list_projects")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "https://evil.example.com")
                .header(header::COOKIE, cookie)
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn unknown_api_paths_return_json_not_the_spa() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::get("/api/nope")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains("unknown endpoint"));
    }
}
