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
pub mod files;
pub mod pty;

use axum::{
    extract::State,
    http::StatusCode,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use std::sync::{Arc, OnceLock};
use tower_http::services::{ServeDir, ServeFile};

pub use config::Config;

use crate::errors::CommandError;

pub(crate) const PREVIEW_PROXY_SLOT: &str = "__ship_preview_proxy__";
pub(crate) const STATIC_SERVER_SLOT: &str = "__ship_static_server__";
static RUNTIME_CONFIG: OnceLock<Arc<Config>> = OnceLock::new();

pub(crate) fn runtime_config() -> Option<&'static Config> {
    RUNTIME_CONFIG.get().map(Arc::as_ref)
}

/// Bind one of the bounded, operator-published preview ports and reserve it
/// before another Harbr session can claim the same port.
pub(crate) async fn bind_preview_listener(
    window_label: &str,
    slot: &str,
) -> Result<tokio::net::TcpListener, String> {
    let config = runtime_config().ok_or("web server configuration is not initialized")?;
    for port in config.preview_ports.0..=config.preview_ports.1 {
        if crate::state::is_port_reserved(port) {
            continue;
        }
        let Ok(listener) = tokio::net::TcpListener::bind((config.preview_bind, port)).await else {
            continue;
        };
        if crate::state::reserve_port(window_label, slot, port) {
            return Ok(listener);
        }
    }
    Err(format!(
        "No free preview port in {}-{}",
        config.preview_ports.0, config.preview_ports.1
    ))
}

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
        .route("/api/capabilities", get(files::capabilities))
        .route("/api/browse", get(files::browse))
        .route("/api/file", get(files::file))
        .route("/api/fs/exists", get(files::exists))
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
    let config = Arc::new(Config::from_env()?);

    if config.is_externally_bound() {
        let banner = format!(
            "================================================================\n\
             Harbr is bound to {} — NOT loopback.\n\
             This server grants shell access to the host to anyone holding\n\
             HARBR_AUTH_TOKEN. Put TLS and a reverse proxy in front of it.\n\
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
            "Static directory {} does not exist — the UI will 404. Run `pnpm build` or set HARBR_STATIC_DIR.",
            config.static_dir.display()
        );
    }

    let bind = config.bind;
    let _ = RUNTIME_CONFIG.set(config.clone());
    let state = AppState {
        config,
        events: crate::emit::init_broadcast(),
        sessions: Arc::default(),
    };

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("Failed to bind {bind}: {e}"))?;

    tracing::info!("Harbr server listening on http://{bind}");

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
                preview_url_template: None,
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
            Request::post("/api/cmd/get_default_agent_id")
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
        assert!(json["data"].is_null() || json["data"].is_string(), "body was {body}");
    }

    #[tokio::test]
    async fn command_session_header_overrides_a_spoofed_window_argument() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        state.sessions.lock().unwrap().insert("web-header".into());
        assert!(crate::state::reserve_port(
            "web-header",
            "/tmp/header-project",
            39_991
        ));
        assert!(crate::state::reserve_port(
            "web-spoofed",
            "/tmp/header-project",
            39_992
        ));

        let (status, body) = send(
            state,
            Request::post("/api/cmd/get_reserved_port_for_window")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::COOKIE, cookie)
                .header("x-ship-window", "web-header")
                .body(Body::from(
                    r#"{"windowLabel":"web-spoofed","projectPath":"/tmp/header-project"}"#,
                ))
                .unwrap(),
        )
        .await;
        crate::state::release_port_for_project("web-header", "/tmp/header-project");
        crate::state::release_port_for_project("web-spoofed", "/tmp/header-project");

        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body).expect("JSON body");
        assert_eq!(json["data"], serde_json::json!(39_991));
    }

    #[tokio::test]
    async fn a_command_rejects_a_stale_browser_session() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::post("/api/cmd/get_default_agent_id")
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

    #[tokio::test]
    async fn capabilities_are_authenticated_and_disable_native_features() {
        let state = test_state();
        let (status, _) = send(
            state.clone(),
            Request::get("/api/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::get("/api/capabilities")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body).expect("JSON body");
        assert_eq!(json["data"]["filePicker"], serde_json::json!(true));
        assert_eq!(json["data"]["screenshots"], serde_json::json!(false));
        assert_eq!(json["data"]["updater"], serde_json::json!(false));
    }

    #[tokio::test]
    async fn file_route_rejects_paths_outside_projects() {
        let state = test_state();
        let cookie = valid_cookie(&state);
        let (status, body) = send(
            state,
            Request::get("/api/file?path=/etc/passwd")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("Validation"));
    }
}
