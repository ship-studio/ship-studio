//! # Preview Reverse Proxy
//!
//! A lightweight HTTP reverse proxy that sits between the preview iframe and the
//! dev server. It injects a navigation tracking script into HTML responses
//! so the parent window can detect when the user navigates within the iframe.
//!
//! Also transparently forwards WebSocket upgrades (for HMR) and streams
//! non-HTML responses (SSE, JS, CSS, images, etc.) without buffering.

mod html;

pub use html::*;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{LazyLock, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Maximum response body size to buffer for HTML injection (50 MB).
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

/// Script injected into HTML responses to report navigation events to the parent window.
/// Monkey-patches history.pushState/replaceState and listens for popstate to catch all
/// client-side navigation in frameworks like Next.js, React Router, etc.
const NAV_SCRIPT: &str = r#"<script>(function(){var n=function(){window.parent.postMessage({type:'shipstudio:navigate',pathname:location.pathname},'*')};var p=history.pushState;var r=history.replaceState;history.pushState=function(){p.apply(this,arguments);n()};history.replaceState=function(){r.apply(this,arguments);n()};window.addEventListener('popstate',n);n()})()</script>"#;

/// Visual-editor selection layer, injected into every preview HTML response but
/// **inert until** the parent posts `ss:activate`. When active it outlines the
/// hovered/selected element (overlay drawn inside the iframe so it tracks scroll
/// automatically), reports a `ss:select` signature {className, tagName, text,
/// ancestorClasses, rect} on click, and live-applies a new class on `ss:mutate`
/// for instant (Webflow-style) feedback before the source write-back commits.
///
/// The script body lives in `select_script.html` so the same source is shared
/// with the jsdom behavior test (`src/components/edit/selectScript.test.ts`).
const SELECT_SCRIPT: &str = include_str!("select_script.html");

/// Boxed body type that can be either a full buffered body or a streamed body.
type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// Convert full bytes into a ProxyBody.
fn full_body(data: Bytes) -> ProxyBody {
    Full::new(data).map_err(|never| match never {}).boxed()
}

/// Convert an empty body into a ProxyBody.
fn empty_body() -> ProxyBody {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed()
}

/// A running proxy instance.
struct ProxyInstance {
    _proxy_port: u16,
    _target_port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    _task_handle: JoinHandle<()>,
}

/// Maps window_label -> ProxyInstance
static PROXY_INSTANCES: LazyLock<Mutex<HashMap<String, ProxyInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Start a reverse proxy for the given window, forwarding to `target_port`.
/// Returns the proxy's listening port.
pub async fn start_preview_proxy(window_label: String, target_port: u16) -> Result<u16, String> {
    // Stop any existing proxy for this window
    stop_preview_proxy(&window_label);

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind proxy port: {e}"))?;

    let proxy_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get proxy address: {e}"))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task_handle = tokio::spawn(async move {
        tracing::info!(
            "[Proxy] Started on port {} -> target port {}",
            proxy_port,
            target_port
        );

        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, addr)) => {
                            tokio::spawn(handle_connection(stream, addr, target_port));
                        }
                        Err(e) => {
                            tracing::error!("[Proxy] Accept error: {}", e);
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    tracing::info!("[Proxy] Shutting down proxy on port {}", proxy_port);
                    break;
                }
            }
        }
    });

    let instance = ProxyInstance {
        _proxy_port: proxy_port,
        _target_port: target_port,
        shutdown_tx: Some(shutdown_tx),
        _task_handle: task_handle,
    };

    PROXY_INSTANCES
        .lock()
        .map_err(|e| format!("Failed to acquire proxy lock: {e}"))?
        .insert(window_label, instance);

    tracing::info!("[Proxy] Proxy registered on port {}", proxy_port);
    Ok(proxy_port)
}

/// Stop the proxy for the given window.
pub fn stop_preview_proxy(window_label: &str) {
    if let Ok(mut instances) = PROXY_INSTANCES.lock() {
        if let Some(mut instance) = instances.remove(window_label) {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[Proxy] Stopped proxy for window '{}'", window_label);
        }
    }
}

/// Stop all running proxies (called during app cleanup).
pub fn stop_all_proxies() {
    if let Ok(mut instances) = PROXY_INSTANCES.lock() {
        for (label, mut instance) in instances.drain() {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[Proxy] Stopped proxy for window '{}' (cleanup)", label);
        }
    }
}

/// Handle a single incoming TCP connection.
async fn handle_connection(stream: TcpStream, addr: SocketAddr, target_port: u16) {
    let io = TokioIo::new(stream);

    let service = service_fn(move |req: Request<Incoming>| handle_request(req, target_port));

    if let Err(e) = http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(io, service)
        .with_upgrades()
        .await
    {
        // Connection reset / closed by client is normal
        tracing::debug!("[Proxy] Connection error from {}: {}", addr, e);
    }
}

/// Handle a single HTTP request by proxying it to the target dev server.
async fn handle_request(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, hyper::Error> {
    let is_websocket = is_upgrade_request(&req);

    if is_websocket {
        return handle_websocket_upgrade(req, target_port).await;
    }

    match proxy_http_request(req, target_port).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            tracing::error!("[Proxy] Request failed: {}", e);
            let body = format!("Proxy error: {e}");
            Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from(body)))
                .unwrap())
        }
    }
}

/// Check if a request is a WebSocket upgrade request.
fn is_upgrade_request(req: &Request<Incoming>) -> bool {
    req.headers()
        .get(hyper::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// Proxy a regular HTTP request (non-WebSocket).
/// HTML responses are buffered and injected with the nav script.
/// All other responses (JS, CSS, images, SSE streams) are forwarded as-is without buffering.
async fn proxy_http_request(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, Box<dyn std::error::Error + Send + Sync>> {
    // Connect to target via hostname so both IPv4 and IPv6 are tried.
    // Vite-based dev servers (Astro, SvelteKit, Nuxt) bind to `localhost` which
    // resolves to `::1` (IPv6) on macOS -- hardcoding 127.0.0.1 fails for those.
    let stream = TcpStream::connect(format!("localhost:{target_port}")).await?;
    let io = TokioIo::new(stream);

    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(io)
        .await?;

    // Spawn connection driver
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!("[Proxy] Client connection error: {}", e);
        }
    });

    // Build forwarded request - strip Accept-Encoding to avoid gzip for HTML,
    // and rewrite Host header to target port so dev servers don't reject it.
    let (parts, body) = req.into_parts();
    let mut builder = Request::builder()
        .method(parts.method)
        .uri(parts.uri.clone())
        .version(parts.version);

    for (key, value) in &parts.headers {
        // Strip Accept-Encoding so dev server returns uncompressed HTML
        if key == hyper::header::ACCEPT_ENCODING {
            continue;
        }
        // Rewrite Host to target port so dev server sees the expected origin
        if key == hyper::header::HOST {
            builder = builder.header(key, format!("localhost:{target_port}"));
            continue;
        }
        builder = builder.header(key, value);
    }

    let forwarded_req = builder.body(body)?;

    // Send request and get response
    let resp = sender.send_request(forwarded_req).await?;

    // Check if response is HTML (needs injection)
    let is_html = resp
        .headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false);

    let status = resp.status();
    let headers = resp.headers().clone();

    if is_html {
        // Buffer HTML response body and inject nav script (and error overlay for 5xx)
        let body_bytes = resp.collect().await?.to_bytes();
        let is_server_error = status.is_server_error();

        let response_body = if body_bytes.len() < MAX_BODY_SIZE {
            let modified = if is_server_error {
                tracing::warn!(
                    "[Proxy] Dev server returned {} for HTML response, injecting error overlay",
                    status.as_u16()
                );
                inject_error_into_html(&body_bytes, status.as_u16())
            } else {
                inject_nav_script(&body_bytes)
            };
            full_body(Bytes::from(modified))
        } else {
            // Too large to inject, pass through as-is
            full_body(body_bytes)
        };

        // For error responses, return 200 so the iframe actually renders our overlay.
        // WebKit may show its own error page for 5xx, hiding our injected content.
        // The actual status code is displayed in the overlay's badge.
        let effective_status = if is_server_error {
            StatusCode::OK
        } else {
            status
        };

        let mut response = Response::builder().status(effective_status);
        for (key, value) in &headers {
            // Skip Content-Length since body size changed; skip Content-Encoding
            if key == hyper::header::CONTENT_LENGTH || key == hyper::header::CONTENT_ENCODING {
                continue;
            }
            response = response.header(key, value);
        }

        Ok(response.body(response_body)?)
    } else {
        // Stream non-HTML responses through without buffering.
        // This properly handles SSE (text/event-stream), chunked JS/CSS, etc.
        let incoming_body = resp.into_body();

        let mut response = Response::builder().status(status);
        for (key, value) in &headers {
            response = response.header(key, value);
        }

        Ok(response.body(incoming_body.boxed())?)
    }
}

/// Handle WebSocket upgrade by forwarding the upgrade to the target and piping
/// the upgraded connections bidirectionally.
async fn handle_websocket_upgrade(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, hyper::Error> {
    // Connect via hostname for IPv4/IPv6 compatibility (see proxy_http_request)
    let target_stream = match TcpStream::connect(format!("localhost:{target_port}")).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket target connection failed: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket proxy error")))
                .unwrap());
        }
    };

    let target_io = TokioIo::new(target_stream);

    // Create client connection with upgrade support
    let (mut sender, conn) = match hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(target_io)
        .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket handshake error: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket handshake error")))
                .unwrap());
        }
    };

    // Drive client connection with upgrades enabled
    tokio::spawn(async move {
        if let Err(e) = conn.with_upgrades().await {
            tracing::debug!("[Proxy] WebSocket client conn error: {}", e);
        }
    });

    // Split the incoming request: extract upgrade future, forward rest to target
    let (mut parts, body) = req.into_parts();

    // Extract the client's OnUpgrade from request extensions (set by hyper server)
    let client_on_upgrade = parts.extensions.remove::<hyper::upgrade::OnUpgrade>();

    // Build request to forward to target
    let mut builder = Request::builder()
        .method(parts.method)
        .uri(parts.uri.clone())
        .version(parts.version);

    for (key, value) in &parts.headers {
        builder = builder.header(key, value);
    }

    let forwarded_req = match builder.body(body) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[Proxy] Failed to build WS forward request: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(full_body(Bytes::from("Internal proxy error")))
                .unwrap());
        }
    };

    // Send upgrade request to target
    let target_resp = match sender.send_request(forwarded_req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket forward failed: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket proxy error")))
                .unwrap());
        }
    };

    if target_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        // Target didn't upgrade - return as regular response
        let status = target_resp.status();
        let headers = target_resp.headers().clone();
        let body_bytes = target_resp
            .collect()
            .await
            .map(|b| b.to_bytes())
            .unwrap_or_default();

        let mut response = Response::builder().status(status);
        for (key, value) in &headers {
            response = response.header(key, value);
        }
        return Ok(response.body(full_body(body_bytes)).unwrap());
    }

    // Target agreed to upgrade! Save response headers before consuming for upgrade.
    let resp_headers = target_resp.headers().clone();

    // Get target's upgraded connection (consumes response)
    let target_upgraded = hyper::upgrade::on(target_resp).await;

    // Build 101 response to return to client (with headers from target)
    let mut response_builder = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    for (key, value) in &resp_headers {
        response_builder = response_builder.header(key, value);
    }
    let client_response = response_builder.body(empty_body()).unwrap();

    // Spawn task to pipe client <-> target after both sides have upgraded
    if let (Some(client_on_upgrade), Ok(target_upgraded)) = (client_on_upgrade, target_upgraded) {
        tokio::spawn(async move {
            match client_on_upgrade.await {
                Ok(client_upgraded) => {
                    let mut client_io = TokioIo::new(client_upgraded);
                    let mut target_io = TokioIo::new(target_upgraded);

                    match tokio::io::copy_bidirectional(&mut client_io, &mut target_io).await {
                        Ok((c2t, t2c)) => {
                            tracing::debug!(
                                "[Proxy] WebSocket closed (client->target: {} bytes, target->client: {} bytes)",
                                c2t, t2c
                            );
                        }
                        Err(e) => {
                            tracing::debug!("[Proxy] WebSocket pipe error: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[Proxy] Client WebSocket upgrade failed: {}", e);
                }
            }
        });
    } else {
        tracing::error!(
            "[Proxy] WebSocket upgrade: missing client upgrade or target upgrade failed"
        );
    }

    Ok(client_response)
}
