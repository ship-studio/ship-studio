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

/// Timeout for establishing the upstream TCP connection. Localhost either
/// accepts immediately or refuses outright; a hang here means a firewalled or
/// wedged port and should fail fast instead of holding the request forever.
const UPSTREAM_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Timeout for the upstream response headers. Must be generous: dev servers
/// compile routes on demand and hold the request open until the compile
/// finishes — tens of seconds on a real dependency tree (the frontend's
/// readiness probe rides the same wait). This is a backstop against a truly
/// hung upstream, not a UX timeout.
const UPSTREAM_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Timeout for buffering an HTML *error* body once response headers have
/// arrived (5xx pages are buffered whole to extract the framework's error
/// message; ordinary HTML streams through `HeadInjector` untimed, like any
/// other streamed response). Headers-then-stall is not a compile wait — after
/// headers the body should flow immediately on localhost.
const HTML_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Cap on how much of an HTML document is held back while scanning for
/// `</head>`. Real heads are a few KB; if the marker hasn't shown up by now
/// the document is degenerate — inject at the head-start position and stream on.
const HEAD_SCAN_CAP: usize = 256 * 1024;

/// Script injected into HTML responses to report navigation events to the parent window.
/// Monkey-patches history.pushState/replaceState and listens for popstate to catch all
/// client-side navigation in frameworks like Next.js, React Router, etc.
///
/// Also posts `shipstudio:alive` unconditionally on parse — the parent's blank-pane
/// watchdog treats it as proof the iframe actually rendered an injected document.
/// A subframe load that WebKit aborts (e.g. an auth redirect loop, issue #179)
/// renders empty and never runs this script, so the watchdog fires and the app
/// can surface the failure instead of showing a silent blank pane.
const NAV_SCRIPT: &str = r#"<script>(function(){window.parent.postMessage({type:'shipstudio:alive'},'*');var n=function(){window.parent.postMessage({type:'shipstudio:navigate',pathname:location.pathname},'*')};var p=history.pushState;var r=history.replaceState;history.pushState=function(){p.apply(this,arguments);n()};history.replaceState=function(){r.apply(this,arguments);n()};window.addEventListener('popstate',n);n()})()</script>"#;

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

/// Hides the preview iframe's *default* browser scrollbars — the chunky white
/// macOS/WebKit bars that frame the rendered site — without hijacking sites that
/// style their own. Injected at the very start of `<head>` (see
/// `inject_at_head_start`) so any site stylesheet, which loads afterward, wins
/// the cascade. We deliberately use zero-size (not `display:none`) and no
/// `!important`, so a site's `::-webkit-scrollbar { width: … }` overrides this
/// and its custom scrollbar still shows. Scrolling itself is unaffected — only
/// the visual bar is suppressed. `scrollbar-width:none` covers Windows WebView2.
const SCROLLBAR_STYLE: &str = r#"<style id="ss-hide-scrollbars">::-webkit-scrollbar{width:0;height:0;background:transparent}html{scrollbar-width:none}</style>"#;

/// Keeps the preview scroll position across full page reloads. Astro reloads the
/// WHOLE document on a `.astro` save (no in-place HMR like React Fast Refresh), so
/// without this the preview snaps to the top on every save — and restoring *after*
/// first paint just makes it visibly jerk (top → back). So we inject this at the
/// very start of `<head>`, take over scroll restoration, and HOLD the repaint
/// (`visibility:hidden`) until the saved position is restored — then reveal. The
/// net effect: a save reloads but the preview stays put, with no visible jump.
/// Keyed by pathname, so a real navigation still starts at the top.
///
/// The hold is released as soon as the document is tall enough to reach the
/// saved position (rAF poll), with DOMContentLoaded/load and a 400ms hard cap
/// as fallbacks — an over-long hold reads as a blank flash unique to the
/// preview. The script body lives in `scroll_restore.html` so it stays readable
/// and can be exercised by jsdom tests like the selection script.
const SCROLL_RESTORE: &str = include_str!("scroll_restore.html");

/// Makes the editor's OWN save feel like Next's in-place Fast Refresh. Astro
/// full-reloads the whole document on a `.astro` save (which is what makes the
/// preview jerk), but the edit is ALREADY shown live and Tailwind pushes its new
/// CSS over a SEPARATE css-update HMR message. So we wrap Vite's HMR WebSocket and
/// swallow just the `full-reload` message — but ONLY in the brief window right after
/// the editor commits a save (`window.__ssSuppressUntil`, set on `ss:commit`),
/// and at most ONE per window: dropping a reload closes the window, so a racing
/// reload from an unrelated change (an agent editing files) still lands instead
/// of leaving the preview permanently stale. CSS updates always pass, so the real
/// compiled CSS applies. Gated to Vite's `vite-hmr` subprotocol so it never touches
/// a site's own sockets. Injected at head start so it wraps WebSocket before
/// `@vite/client` connects.
///
/// The same script also runs the HMR watchdog: it tracks HMR sockets (Vite's
/// `vite-hmr` subprotocol, Next.js's `_next/webpack-hmr` path) and posts
/// `shipstudio:hmr-down` to the parent when they all close and none reopens
/// within 5s — the parent then health-checks the dev server and auto-reloads
/// the preview instead of leaving it silently stale.
///
/// The script body lives in `reload_suppress.html` so the same source is shared
/// with the jsdom behavior test (`src/components/preview/reloadSuppress.test.ts`).
const RELOAD_SUPPRESS: &str = include_str!("reload_suppress.html");

/// Boxed body type that can be either a full buffered body or a streamed body.
type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// Incremental HTML injector: buffers the stream only until `</head>` is seen,
/// injects there, then passes every later chunk straight through.
///
/// Both injection points — right after `<head …>` (styles/early scripts) and
/// right before `</head>` (nav + selection scripts) — live in the document
/// prefix, so once the prefix is cut the standard whole-document pipeline
/// (`inject_nav_script`) applies to it verbatim and the remainder needs no
/// inspection. This is what lets streaming-SSR frameworks (Next.js App Router,
/// Astro) paint progressively in the preview: they flush the head early and
/// stream the body, and buffering the whole document — as the proxy used to —
/// held the first paint until the last byte.
struct HeadInjector {
    /// Buffered prefix; `None` once injection happened (pass-through mode).
    pending: Option<Vec<u8>>,
    /// How far `pending` has been scanned, so each chunk is scanned once
    /// (with marker-length overlap for markers split across chunks).
    scanned: usize,
}

const HEAD_CLOSE: &[u8] = b"</head>";

impl HeadInjector {
    fn new() -> Self {
        Self {
            pending: Some(Vec::new()),
            scanned: 0,
        }
    }

    /// Feed one chunk; returns bytes ready to emit downstream (empty while the
    /// injection point is still being scanned for).
    fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let Some(mut buf) = self.pending.take() else {
            // Pass-through mode: injection already happened.
            return chunk.to_vec();
        };
        buf.extend_from_slice(chunk);
        let start = self.scanned.saturating_sub(HEAD_CLOSE.len() - 1);

        if let Some(rel) = find_subslice(&buf[start..], HEAD_CLOSE) {
            let cut = start + rel + HEAD_CLOSE.len();
            let (prefix, rest) = buf.split_at(cut);
            let mut out = inject_nav_script(prefix);
            out.extend_from_slice(rest);
            out
        } else if buf.len() > HEAD_SCAN_CAP {
            // Degenerate document: no `</head>` in the first 256 KB. Drop
            // every snippet at the head-start position (after `<head …>`,
            // `<html …>`, or the document start) and go pass-through.
            inject_at_head_start(
                &buf,
                &format!(
                    "{SCROLLBAR_STYLE}{RELOAD_SUPPRESS}{SCROLL_RESTORE}{NAV_SCRIPT}{SELECT_SCRIPT}"
                ),
            )
        } else {
            // Marker not seen yet — keep buffering.
            self.scanned = buf.len();
            self.pending = Some(buf);
            Vec::new()
        }
    }

    /// Body ended. A document that never reached `</head>` under the cap gets
    /// the standard whole-document fallback injection (before `</body>`, else
    /// appended) — identical to the old buffered behavior.
    fn finish(mut self) -> Vec<u8> {
        match self.pending.take() {
            Some(buf) => inject_nav_script(&buf),
            None => Vec::new(),
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Body implementation fed by a channel — lets a spawned task transform the
/// upstream stream (head injection) while hyper streams frames to the webview.
struct ChannelBody {
    rx: tokio::sync::mpsc::Receiver<Result<hyper::body::Frame<Bytes>, hyper::Error>>,
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, hyper::Error>>> {
        self.rx.poll_recv(cx)
    }
}

/// Stream an HTML body through [`HeadInjector`]: the (injected) prefix is
/// emitted as soon as `</head>` arrives, everything after it is piped through.
fn streaming_injected_body(mut body: Incoming) -> ProxyBody {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        let mut injector = HeadInjector::new();
        loop {
            match body.frame().await {
                Some(Ok(frame)) => {
                    // Trailers are irrelevant for dev-server HTML — dropped.
                    if let Ok(data) = frame.into_data() {
                        let out = injector.push(&data);
                        if !out.is_empty()
                            && tx
                                .send(Ok(hyper::body::Frame::data(Bytes::from(out))))
                                .await
                                .is_err()
                        {
                            return; // client went away
                        }
                    }
                }
                Some(Err(e)) => {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
                None => break,
            }
        }
        let tail = injector.finish();
        if !tail.is_empty() {
            let _ = tx
                .send(Ok(hyper::body::Frame::data(Bytes::from(tail))))
                .await;
        }
    });
    ChannelBody { rx }.boxed()
}

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

/// Sanitize a CSP header value for the HTTP preview iframe. Removes two
/// directives that are incompatible with serving the previewed app over plain
/// HTTP inside an iframe:
/// - `frame-ancestors` — so the page can be framed inside the preview at all.
/// - `upgrade-insecure-requests` — the preview is served over `http://localhost`,
///   but this directive makes the browser rewrite every subresource request to
///   `https://`. WebKit (which the preview's WKWebView and Safari use) honors it
///   even on localhost, so CSS/images 404 over https and the page renders blank
///   or unstyled; Chromium exempts localhost, so the bug only shows in the
///   WebKit preview. Stripping it only affects the local preview, never the
///   user's deployed site.
///
/// Returns the value untouched when neither directive is present, and `None`
/// when nothing remains (drop the header).
fn sanitize_csp_for_preview(
    value: &hyper::header::HeaderValue,
) -> Option<hyper::header::HeaderValue> {
    let Ok(s) = value.to_str() else {
        // Unparseable CSP — drop it rather than risk it blanking the iframe.
        return None;
    };
    let lower = s.to_ascii_lowercase();
    if !lower.contains("frame-ancestors") && !lower.contains("upgrade-insecure-requests") {
        return Some(value.clone());
    }
    let kept: Vec<&str> = s
        .split(';')
        .map(str::trim)
        .filter(|d| {
            if d.is_empty() {
                return false;
            }
            let dl = d.to_ascii_lowercase();
            !dl.starts_with("frame-ancestors") && dl != "upgrade-insecure-requests"
        })
        .collect();
    if kept.is_empty() {
        return None;
    }
    hyper::header::HeaderValue::from_str(&kept.join("; ")).ok()
}

/// Host of an absolute URL (lowercased, port and userinfo stripped).
/// Returns `None` for relative locations (`/en`, `foo/bar`) — those never
/// leave the proxy, so they're not candidates for loop interception.
fn absolute_url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("//"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Detect a redirect that would trap the preview iframe in an auth-handshake
/// loop (issue #179). Clerk development instances bounce the first navigation
/// through `<slug>.clerk.accounts.dev` to set a handshake cookie; the preview
/// loads the site as a cross-site iframe, WebKit refuses the third-party
/// cookie, and the middleware redirects until WebKit aborts with "too many
/// HTTP redirects" — an empty subframe and a blank pane.
///
/// Matches only when the response is a redirection AND either:
/// - the `Location` host is a Clerk dev-instance host (`*.clerk.accounts.dev`), or
/// - the location / request URI carries Clerk's `__clerk_handshake` param
///   (the bounce-back leg of the same loop — the handshake cookie can never
///   be accepted inside the embedded preview, so this leg always re-loops).
///
/// Ordinary redirects pass through untouched: relative locations (trailing
/// slash, locale redirects) have no host, and external non-Clerk hosts don't
/// match either arm.
fn is_auth_redirect_loop(status: StatusCode, location: Option<&str>, request_uri: &str) -> bool {
    if !status.is_redirection() {
        return false;
    }
    if request_uri.contains("__clerk_handshake") {
        return true;
    }
    let Some(location) = location else {
        return false;
    };
    if location.contains("__clerk_handshake") {
        return true;
    }
    match absolute_url_host(location) {
        Some(host) => host == "clerk.accounts.dev" || host.ends_with(".clerk.accounts.dev"),
        None => false,
    }
}

/// True when the request is a document navigation (a page loading in the
/// iframe) rather than a fetch/XHR/subresource load. Interstitials must only
/// replace navigations — swapping an API response's redirect for 200 HTML
/// would change the resource contract for in-page code.
///
/// Chrome and WebKit send `Sec-Fetch-Dest` (`document` top-level, `iframe` /
/// `frame` for framed navigations — the preview's own case). When the header
/// is absent (older engines), fall back to the `Accept` header: navigations
/// ask for `text/html`, `fetch()` defaults to `*/*` and API calls ask for
/// JSON.
fn is_document_navigation(sec_fetch_dest: Option<&str>, accept: Option<&str>) -> bool {
    if let Some(dest) = sec_fetch_dest {
        let dest = dest.trim();
        return dest.eq_ignore_ascii_case("document")
            || dest.eq_ignore_ascii_case("iframe")
            || dest.eq_ignore_ascii_case("frame");
    }
    accept.is_some_and(|a| a.contains("text/html"))
}

/// Replace every `__clerk_handshake` query-param value with `<redacted>`.
/// The value is a JWT-like handshake token — it must not land in logs or in
/// the interstitial's Copy / Send-to-Claude payload. Host and path stay
/// intact so the reason string remains diagnosable.
fn redact_handshake_values(input: &str) -> String {
    const PARAM: &str = "__clerk_handshake=";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(PARAM) {
        let value_start = idx + PARAM.len();
        out.push_str(&rest[..value_start]);
        out.push_str("<redacted>");
        let tail = &rest[value_start..];
        // A token value ends at the next query delimiter — or at whitespace /
        // a closing paren, because the reason string embeds URIs in prose
        // ("redirect to <url> (requested <uri>)").
        let value_end = tail
            .find(|c: char| c == '&' || c == '#' || c == ')' || c.is_whitespace())
            .unwrap_or(tail.len());
        rest = &tail[value_end..];
    }
    out.push_str(rest);
    out
}

/// Rewrite a `localhost`/`127.0.0.1` Origin header to the dev server's port.
///
/// Requests reaching the proxy come from pages served *by* the proxy, so their
/// Origin names the proxy's ephemeral port. Dev servers that host/origin-check
/// requests (Vite's HMR WebSocket upgrade, CSRF-guarded endpoints) must instead
/// see the origin they expect — their own. Non-localhost origins pass through
/// untouched.
fn rewrite_localhost_origin(
    value: &hyper::header::HeaderValue,
    target_port: u16,
) -> Option<hyper::header::HeaderValue> {
    let s = value.to_str().ok()?;
    let host = s.strip_prefix("http://")?.split(':').next()?;
    if host != "localhost" && host != "127.0.0.1" {
        return None;
    }
    hyper::header::HeaderValue::from_str(&format!("http://{host}:{target_port}")).ok()
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
    // Each timeout site names its phase: all three produce the same bare
    // "deadline has elapsed" otherwise, making a 5s connect stall
    // indistinguishable from a 5-minute hung response (issue #271).
    let stream = tokio::time::timeout(
        UPSTREAM_CONNECT_TIMEOUT,
        TcpStream::connect(format!("localhost:{target_port}")),
    )
    .await
    .map_err(|_| {
        format!("connect to localhost:{target_port} timed out after {UPSTREAM_CONNECT_TIMEOUT:?}")
    })??;
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
    let request_uri = parts.uri.to_string();
    let is_document_nav = is_document_navigation(
        parts
            .headers
            .get("sec-fetch-dest")
            .and_then(|v| v.to_str().ok()),
        parts
            .headers
            .get(hyper::header::ACCEPT)
            .and_then(|v| v.to_str().ok()),
    );
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
        // Rewrite Origin for the same reason — a CSRF/origin-checking dev
        // server must not see the proxy's ephemeral port.
        if key == hyper::header::ORIGIN {
            if let Some(v) = rewrite_localhost_origin(value, target_port) {
                builder = builder.header(key, v);
                continue;
            }
        }
        builder = builder.header(key, value);
    }

    let forwarded_req = builder.body(body)?;

    // Send request and get response
    let resp = tokio::time::timeout(
        UPSTREAM_RESPONSE_TIMEOUT,
        sender.send_request(forwarded_req),
    )
    .await
    .map_err(|_| {
        format!(
            "dev server on localhost:{target_port} didn't answer within {UPSTREAM_RESPONSE_TIMEOUT:?}"
        )
    })??;

    // Intercept auth-handshake redirect loops before they leave the proxy.
    // Forwarding the redirect would bounce the iframe through a third-party
    // auth host until WebKit aborts and renders an empty subframe (issue
    // #179) — instead, synthesize a 200 interstitial that names the cause.
    // Only document navigations are intercepted: a fetch/XHR that hits the
    // same middleware keeps its redirect so in-page code sees the real
    // resource contract, not surprise HTML.
    if is_document_nav && resp.status().is_redirection() {
        let location = resp
            .headers()
            .get(hyper::header::LOCATION)
            .and_then(|v| v.to_str().ok());
        if is_auth_redirect_loop(resp.status(), location, &request_uri) {
            let reason = redact_handshake_values(&format!(
                "HTTP {} redirect to {} (requested {})",
                resp.status().as_u16(),
                location.unwrap_or("(no Location header)"),
                request_uri
            ));
            tracing::warn!(
                "[Proxy] Auth redirect loop intercepted, serving interstitial: {}",
                reason
            );
            let page = build_auth_redirect_interstitial(resp.status().as_u16(), &reason);
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(hyper::header::CACHE_CONTROL, "no-store")
                .body(full_body(Bytes::from(page)))?);
        }
    }

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
        let is_server_error = status.is_server_error();

        let response_body = if is_server_error {
            // Error pages are buffered whole: extracting the framework's error
            // message for the overlay needs the full document, and they're small.
            tracing::warn!(
                "[Proxy] Dev server returned {} for HTML response, injecting error overlay",
                status.as_u16()
            );
            let body_bytes = tokio::time::timeout(HTML_BODY_TIMEOUT, resp.collect())
                .await
                .map_err(|_| {
                    format!(
                        "reading error page body from localhost:{target_port} timed out after {HTML_BODY_TIMEOUT:?}"
                    )
                })??
                .to_bytes();
            if body_bytes.len() < MAX_BODY_SIZE {
                full_body(Bytes::from(inject_error_into_html(
                    &body_bytes,
                    status.as_u16(),
                )))
            } else {
                // Too large to inject, pass through as-is
                full_body(body_bytes)
            }
        } else {
            // Ordinary HTML streams through the head injector — see HeadInjector.
            streaming_injected_body(resp.into_body())
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
            // The injected body no longer matches upstream's cache validators,
            // and the iframe URL carries no cache-busting param — the webview
            // must never reuse a cached copy of injected HTML (replaced with a
            // hard no-store below).
            if key == hyper::header::CACHE_CONTROL
                || key == hyper::header::ETAG
                || key == hyper::header::LAST_MODIFIED
            {
                continue;
            }
            // The page renders inside the preview iframe — drop anti-framing
            // headers (Shopify storefronts send X-Frame-Options: DENY).
            if key == hyper::header::X_FRAME_OPTIONS {
                continue;
            }
            if key == hyper::header::CONTENT_SECURITY_POLICY {
                if let Some(v) = sanitize_csp_for_preview(value) {
                    response = response.header(key, v);
                }
                continue;
            }
            response = response.header(key, value);
        }
        response = response.header(hyper::header::CACHE_CONTROL, "no-store");

        Ok(response.body(response_body)?)
    } else {
        // Stream non-HTML responses through without buffering.
        // This properly handles SSE (text/event-stream), chunked JS/CSS, etc.
        let incoming_body = resp.into_body();

        let mut response = Response::builder().status(status);
        for (key, value) in &headers {
            if key == hyper::header::X_FRAME_OPTIONS {
                continue;
            }
            if key == hyper::header::CONTENT_SECURITY_POLICY {
                if let Some(v) = sanitize_csp_for_preview(value) {
                    response = response.header(key, v);
                }
                continue;
            }
            response = response.header(key, value);
        }

        Ok(response.body(incoming_body.boxed())?)
    }
}

/// Connect failures that mean "the dev server isn't listening right now":
/// refused (nothing bound to the port) or silent (SYN unanswered mid-restart,
/// surfaced as a per-attempt timeout). Both are normal states while a dev
/// server restarts or is stopped — an environment condition, not a proxy bug —
/// so exhausting the retry budget on them logs at warn level instead of
/// auto-filing an error report (issue #532).
fn ws_upstream_unavailable(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
    )
}

/// Handle WebSocket upgrade by forwarding the upgrade to the target and piping
/// the upgraded connections bidirectionally.
async fn handle_websocket_upgrade(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, hyper::Error> {
    // Connect via hostname for IPv4/IPv6 compatibility (see proxy_http_request).
    // Retry briefly on connection-refused: an HMR socket's upgrade often lands
    // mid dev-server restart, and a single missed connect used to hard-fail the
    // upgrade with BAD_GATEWAY instead of riding out the gap (issue #258). The
    // retry loop stays bounded by UPSTREAM_CONNECT_TIMEOUT overall.
    // Race IPv4 and IPv6 loopback concurrently rather than connecting to
    // "localhost": some dev servers (Vite notably) bind only one family, and
    // the sequential address walk behind a hostname connect can burn a whole
    // per-attempt timeout on the dead family before reaching the live one
    // (observed on Windows CI). First successful connection wins; the error
    // surfaces only when both families fail.
    async fn connect_loopback(port: u16) -> std::io::Result<TcpStream> {
        use futures_util::future::select_ok;
        let v4 = Box::pin(TcpStream::connect(("127.0.0.1", port)));
        let v6 = Box::pin(TcpStream::connect(("::1", port)));
        select_ok([v4, v6]).await.map(|(stream, _)| stream)
    }

    let connect_deadline = tokio::time::Instant::now() + UPSTREAM_CONNECT_TIMEOUT;
    // Each attempt gets its own short timeout (capped to what's left of the
    // overall budget) rather than racing the whole deadline: an unready port
    // doesn't always refuse the connection — on Windows especially, the SYN
    // can just go unanswered — and a single hung attempt must not eat the
    // entire retry window (issue #353).
    let per_attempt = std::time::Duration::from_secs(1);
    let mut attempts: u32 = 0;
    let target_stream = loop {
        let remaining = connect_deadline.saturating_duration_since(tokio::time::Instant::now());
        let attempt =
            tokio::time::timeout(remaining.min(per_attempt), connect_loopback(target_port))
                .await
                .map_err(std::io::Error::from)
                .and_then(|r| r);
        attempts += 1;
        match attempt {
            Ok(s) => break s,
            Err(e) => {
                let unavailable = ws_upstream_unavailable(e.kind());
                let retryable = unavailable
                    && tokio::time::Instant::now() + std::time::Duration::from_millis(250)
                        < connect_deadline;
                if retryable {
                    // A timed-out attempt already consumed its slice of the
                    // budget; only refused connections need the backoff pause.
                    if e.kind() == std::io::ErrorKind::ConnectionRefused {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    continue;
                }
                if unavailable {
                    // The whole connect budget elapsed with the port refusing
                    // or silent: the dev server is restarting slowly or
                    // stopped. Expected state — closing the upgrade with 502
                    // makes the browser-side HMR client retry on its own, so
                    // this must not auto-file a bug report (issue #532).
                    tracing::warn!(
                        "[Proxy] WebSocket target localhost:{} unavailable after {} connect attempts over {:?}: {}",
                        target_port,
                        attempts,
                        UPSTREAM_CONNECT_TIMEOUT,
                        e
                    );
                } else {
                    tracing::error!(
                        "[Proxy] WebSocket target connection failed (port {}, attempt {}): {}",
                        target_port,
                        attempts,
                        e
                    );
                }
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(full_body(Bytes::from("WebSocket proxy error")))
                    .unwrap());
            }
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

    // Build request to forward to target. The header rewrite is shared with
    // the one-shot retry below, so it lives in a closure.
    // Rewrite Host/Origin to the dev server's own port, exactly like the
    // HTTP path. Vite host/origin-checks its HMR WebSocket upgrade; leaking
    // the proxy's ephemeral port here gets the HMR socket rejected on
    // stricter setups — the preview then silently stops receiving updates
    // until the dev server is restarted.
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let version = parts.version;
    let headers = parts.headers.clone();
    let build_forward = |body: ProxyBody| -> Result<Request<ProxyBody>, hyper::http::Error> {
        let mut builder = Request::builder()
            .method(method.clone())
            .uri(uri.clone())
            .version(version);
        for (key, value) in &headers {
            if key == hyper::header::HOST {
                builder = builder.header(key, format!("localhost:{target_port}"));
                continue;
            }
            if key == hyper::header::ORIGIN {
                if let Some(v) = rewrite_localhost_origin(value, target_port) {
                    builder = builder.header(key, v);
                    continue;
                }
            }
            builder = builder.header(key, value);
        }
        builder.body(body)
    };

    // A WS upgrade is a bodyless GET — collapse the incoming body to empty so
    // the request can be rebuilt for the retry below.
    drop(body);
    let forwarded_req = match build_forward(empty_body()) {
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
        Err(first_err) => {
            // The TCP connect succeeded but the connection died before the
            // upgrade completed ("connection closed before message
            // completed"). Known dev-server-restart race: the OS accepts into
            // the listen backlog, then the process exits before handling it —
            // so the socket dies mid-request instead of ever refusing. The
            // connect-refused path above already retries; give this the same
            // grace with one reconnect + resend (issue #466).
            tracing::warn!(
                "[Proxy] WebSocket forward to 127.0.0.1:{} failed ({}); retrying once",
                target_port,
                first_err
            );
            // The reconnect's failure is kept as an io::Error so the final
            // branch can classify refused/timed-out retries as the expected
            // dev-server-restart state, exactly like the initial connect loop
            // (issue #552). tokio's timeout Elapsed converts to ErrorKind::
            // TimedOut — the same "SYN unanswered mid-restart" classification
            // the loop above applies. Non-I/O arms (handshake, request build)
            // are wrapped as ErrorKind::Other, which never classifies as
            // expected.
            let retried: Result<Response<hyper::body::Incoming>, std::io::Error> = async {
                let remaining =
                    connect_deadline.saturating_duration_since(tokio::time::Instant::now());
                let remaining = remaining.max(std::time::Duration::from_millis(500));
                let stream = tokio::time::timeout(
                    remaining.min(std::time::Duration::from_secs(2)),
                    connect_loopback(target_port),
                )
                .await
                .map_err(std::io::Error::from)
                .and_then(|r| r)?;
                let (mut retry_sender, retry_conn) = hyper::client::conn::http1::Builder::new()
                    .preserve_header_case(true)
                    .title_case_headers(true)
                    .handshake(TokioIo::new(stream))
                    .await
                    .map_err(std::io::Error::other)?;
                tokio::spawn(async move {
                    if let Err(e) = retry_conn.with_upgrades().await {
                        tracing::debug!("[Proxy] WebSocket retry client conn error: {}", e);
                    }
                });
                let req = build_forward(empty_body()).map_err(std::io::Error::other)?;
                retry_sender
                    .send_request(req)
                    .await
                    .map_err(std::io::Error::other)
            }
            .await;
            match retried {
                Ok(r) => r,
                Err(e) if ws_upstream_unavailable(e.kind()) => {
                    // The retry's reconnect was refused or silent: the dev
                    // server is still down/restarting — the same expected
                    // state the initial connect loop logs at warn (issue
                    // #532), so the retry path must not auto-file a bug
                    // report either (issue #552). The browser-side HMR client
                    // retries on its own after the 502.
                    tracing::warn!(
                        "[Proxy] WebSocket target 127.0.0.1:{} still unavailable on retry: {} (first attempt: {})",
                        target_port,
                        e,
                        first_err
                    );
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(full_body(Bytes::from("WebSocket proxy error")))
                        .unwrap());
                }
                Err(e) => {
                    // Include the upstream port: without it the report is
                    // uncorrelatable (issue #293).
                    tracing::error!(
                        "[Proxy] WebSocket forward to 127.0.0.1:{} failed after retry: {} (first attempt: {})",
                        target_port,
                        e,
                        first_err
                    );
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(full_body(Bytes::from("WebSocket proxy error")))
                        .unwrap());
                }
            }
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

#[cfg(test)]
mod injector_tests {
    use super::{inject_nav_script, HeadInjector, HEAD_SCAN_CAP};

    /// Run the injector over `chunks` and return the concatenated output.
    fn run(chunks: &[&[u8]]) -> Vec<u8> {
        let mut injector = HeadInjector::new();
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(injector.push(chunk));
        }
        out.extend(injector.finish());
        out
    }

    #[test]
    fn single_chunk_matches_buffered_pipeline() {
        let html = b"<html><head><title>t</title></head><body>hi</body></html>";
        assert_eq!(run(&[html]), inject_nav_script(html));
    }

    #[test]
    fn marker_split_across_chunks_matches_buffered_pipeline() {
        let html = b"<html><head><title>t</title></head><body>hi</body></html>";
        // Split inside `</head>` itself — the nastiest boundary.
        for split in 20..40 {
            let (a, b) = html.split_at(split);
            assert_eq!(run(&[a, b]), inject_nav_script(html), "split at {split}");
        }
    }

    #[test]
    fn body_streams_through_untouched_after_head() {
        let mut injector = HeadInjector::new();
        let first = injector.push(b"<html><head></head><body>");
        assert!(!first.is_empty(), "prefix must flush once </head> is seen");
        // Later chunks pass through verbatim — even ones containing head-like
        // markers — because injection already happened.
        assert_eq!(injector.push(b"<p></head></p>"), b"<p></head></p>");
        assert!(injector.finish().is_empty());
    }

    #[test]
    fn no_head_document_falls_back_like_buffered_pipeline() {
        let html = b"<html><body>plain</body></html>";
        assert_eq!(run(&[html]), inject_nav_script(html));
    }

    #[test]
    fn cap_overflow_injects_at_head_start_and_streams_on() {
        // A document whose </head> never arrives within the cap.
        let mut big = b"<html><head>".to_vec();
        big.resize(HEAD_SCAN_CAP + 1024, b'x');
        let mut injector = HeadInjector::new();
        let out = injector.push(&big);
        assert!(!out.is_empty(), "cap overflow must flush");
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("ss-hide-scrollbars"));
        assert!(s.contains("shipstudio:navigate"));
        // And we're in pass-through mode now.
        assert_eq!(injector.push(b"tail"), b"tail");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_auth_redirect_loop, is_document_navigation, redact_handshake_values,
        rewrite_localhost_origin, sanitize_csp_for_preview, ws_upstream_unavailable,
    };
    use hyper::header::HeaderValue;
    use hyper::StatusCode;

    #[test]
    fn ws_connect_failure_classification() {
        // Dev-server-restart states: expected, logged at warn (issue #532).
        assert!(ws_upstream_unavailable(
            std::io::ErrorKind::ConnectionRefused
        ));
        assert!(ws_upstream_unavailable(std::io::ErrorKind::TimedOut));
        // Anything else is a genuine proxy problem and stays at error level.
        assert!(!ws_upstream_unavailable(
            std::io::ErrorKind::PermissionDenied
        ));
        assert!(!ws_upstream_unavailable(
            std::io::ErrorKind::AddrNotAvailable
        ));
        assert!(!ws_upstream_unavailable(std::io::ErrorKind::Other));
    }

    /// The one-shot WS retry path (issue #466) must feed the SAME
    /// classification as the initial connect loop (issue #552): its error is
    /// kept as an io::Error, with a refused reconnect keeping its kind, a
    /// tokio timeout mapping to TimedOut, and non-I/O arms wrapped as Other
    /// so they can never be misclassified as "expected".
    #[tokio::test]
    async fn ws_retry_errors_keep_their_classification() {
        // A reconnect refusal keeps ConnectionRefused → expected (warn).
        let refused = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
        assert!(ws_upstream_unavailable(refused.kind()));

        // The retry's reconnect timeout (tokio Elapsed → io::Error, the same
        // `map_err(std::io::Error::from)` the initial loop uses) → TimedOut →
        // expected (warn).
        let elapsed: Result<(), _> = tokio::time::timeout(
            std::time::Duration::from_millis(1),
            std::future::pending::<()>(),
        )
        .await
        .map_err(std::io::Error::from);
        assert_eq!(
            elapsed.unwrap_err().kind(),
            std::io::ErrorKind::TimedOut,
            "tokio Elapsed must convert to TimedOut for the expected-state classification"
        );

        // Handshake / request-build failures are wrapped via io::Error::other
        // → NOT classified as expected: they stay at error level.
        let other = std::io::Error::other("handshake failed");
        assert!(!ws_upstream_unavailable(other.kind()));
    }

    #[test]
    fn localhost_origin_is_rewritten_to_target_port() {
        let v = HeaderValue::from_static("http://localhost:61234");
        assert_eq!(
            rewrite_localhost_origin(&v, 3000).unwrap(),
            HeaderValue::from_static("http://localhost:3000")
        );
    }

    #[test]
    fn loopback_ip_origin_keeps_its_host_form() {
        let v = HeaderValue::from_static("http://127.0.0.1:61234");
        assert_eq!(
            rewrite_localhost_origin(&v, 3000).unwrap(),
            HeaderValue::from_static("http://127.0.0.1:3000")
        );
    }

    #[test]
    fn portless_localhost_origin_gains_target_port() {
        let v = HeaderValue::from_static("http://localhost");
        assert_eq!(
            rewrite_localhost_origin(&v, 4321).unwrap(),
            HeaderValue::from_static("http://localhost:4321")
        );
    }

    #[test]
    fn non_localhost_origins_pass_through_untouched() {
        for origin in ["https://localhost:1234", "http://example.com:80", "null"] {
            let v = HeaderValue::from_str(origin).unwrap();
            assert!(rewrite_localhost_origin(&v, 3000).is_none());
        }
    }

    #[test]
    fn csp_without_stripped_directives_passes_through() {
        let v = HeaderValue::from_static("default-src 'self'; img-src *");
        assert_eq!(sanitize_csp_for_preview(&v).unwrap(), v);
    }

    #[test]
    fn frame_ancestors_directive_is_removed() {
        let v = HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'; img-src *");
        assert_eq!(
            sanitize_csp_for_preview(&v).unwrap(),
            HeaderValue::from_static("default-src 'self'; img-src *")
        );
    }

    #[test]
    fn csp_that_is_only_frame_ancestors_is_dropped() {
        let v = HeaderValue::from_static("frame-ancestors 'none'");
        assert!(sanitize_csp_for_preview(&v).is_none());
    }

    #[test]
    fn frame_ancestors_match_is_case_insensitive() {
        let v = HeaderValue::from_static("Frame-Ancestors https://admin.shopify.com");
        assert!(sanitize_csp_for_preview(&v).is_none());
    }

    #[test]
    fn upgrade_insecure_requests_directive_is_removed() {
        // The preview is served over http://localhost; this directive makes WebKit
        // rewrite subresources to https and blank them. It must be stripped while
        // the rest of the policy is preserved.
        let v = HeaderValue::from_static(
            "default-src 'self'; img-src 'self'; upgrade-insecure-requests",
        );
        assert_eq!(
            sanitize_csp_for_preview(&v).unwrap(),
            HeaderValue::from_static("default-src 'self'; img-src 'self'")
        );
    }

    #[test]
    fn upgrade_insecure_requests_match_is_case_insensitive() {
        let v = HeaderValue::from_static("Upgrade-Insecure-Requests");
        assert!(sanitize_csp_for_preview(&v).is_none());
    }

    #[test]
    fn frame_ancestors_and_upgrade_insecure_requests_removed_together() {
        let v = HeaderValue::from_static(
            "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests; img-src *",
        );
        assert_eq!(
            sanitize_csp_for_preview(&v).unwrap(),
            HeaderValue::from_static("default-src 'self'; img-src *")
        );
    }

    // ── is_auth_redirect_loop (issue #179) ──────────────────────────────────

    #[test]
    fn redirect_to_clerk_dev_host_is_a_loop() {
        // Clerk dev instances bounce the first navigation through
        // <slug>.clerk.accounts.dev — the exact shape from the bug report.
        assert!(is_auth_redirect_loop(
            StatusCode::TEMPORARY_REDIRECT,
            Some("https://foo-bar-42.clerk.accounts.dev/v1/client/handshake?redirect_url=http%3A%2F%2Flocalhost%3A3000%2F"),
            "/",
        ));
        // Bare apex host counts too.
        assert!(is_auth_redirect_loop(
            StatusCode::FOUND,
            Some("https://clerk.accounts.dev/v1/handshake"),
            "/",
        ));
    }

    #[test]
    fn handshake_param_in_location_is_a_loop() {
        // The bounce-back leg: a local redirect carrying the handshake token.
        assert!(is_auth_redirect_loop(
            StatusCode::TEMPORARY_REDIRECT,
            Some("/?__clerk_handshake=eyJhbGciOiJSUzI1NiJ9"),
            "/",
        ));
    }

    #[test]
    fn handshake_param_on_request_uri_is_a_loop() {
        // The iframe already carries the handshake param and the middleware
        // redirects again — the cookie was refused, so this always re-loops.
        assert!(is_auth_redirect_loop(
            StatusCode::TEMPORARY_REDIRECT,
            Some("/dashboard"),
            "/?__clerk_handshake=eyJhbGciOiJSUzI1NiJ9&_cb=123",
        ));
    }

    #[test]
    fn ordinary_local_redirects_pass_through() {
        // Next.js trailing-slash normalization.
        assert!(!is_auth_redirect_loop(
            StatusCode::PERMANENT_REDIRECT,
            Some("/docs"),
            "/docs/",
        ));
        // Locale redirect.
        assert!(!is_auth_redirect_loop(StatusCode::FOUND, Some("/en"), "/",));
    }

    #[test]
    fn external_non_clerk_redirect_passes_through() {
        assert!(!is_auth_redirect_loop(
            StatusCode::FOUND,
            Some("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
            "/login",
        ));
    }

    #[test]
    fn non_redirect_status_never_matches() {
        assert!(!is_auth_redirect_loop(
            StatusCode::OK,
            Some("https://foo.clerk.accounts.dev/v1/handshake"),
            "/",
        ));
    }

    #[test]
    fn clerk_lookalikes_do_not_match() {
        // A relative path that merely contains the host string is not external.
        assert!(!is_auth_redirect_loop(
            StatusCode::FOUND,
            Some("/foo.clerk.accounts.dev"),
            "/",
        ));
        // A suffix-lookalike host must not match the `ends_with` check.
        assert!(!is_auth_redirect_loop(
            StatusCode::FOUND,
            Some("https://evilclerk.accounts.dev.example.com/"),
            "/",
        ));
    }

    #[test]
    fn missing_location_header_is_not_a_loop() {
        assert!(!is_auth_redirect_loop(StatusCode::FOUND, None, "/"));
    }

    // ── is_document_navigation ──────────────────────────────────────────────

    #[test]
    fn top_level_and_iframe_navigations_are_documents() {
        assert!(is_document_navigation(Some("document"), Some("text/html")));
        assert!(is_document_navigation(Some("iframe"), None));
        assert!(is_document_navigation(Some("frame"), None));
    }

    #[test]
    fn fetch_and_subresources_are_not_documents() {
        // fetch()/XHR send Sec-Fetch-Dest: empty — the Accept fallback must
        // NOT apply when the header is present and says non-document.
        assert!(!is_document_navigation(Some("empty"), Some("text/html")));
        assert!(!is_document_navigation(Some("script"), Some("*/*")));
        assert!(!is_document_navigation(Some("image"), None));
    }

    #[test]
    fn accept_header_fallback_when_sec_fetch_dest_absent() {
        // Older engines without Sec-Fetch-Dest: navigations ask for text/html.
        assert!(is_document_navigation(
            None,
            Some("text/html,application/xhtml+xml,*/*;q=0.8")
        ));
        // API calls ask for JSON (or */*) — pass the redirect through.
        assert!(!is_document_navigation(None, Some("application/json")));
        assert!(!is_document_navigation(None, Some("*/*")));
        assert!(!is_document_navigation(None, None));
    }

    // ── redact_handshake_values ─────────────────────────────────────────────

    #[test]
    fn redacts_handshake_token_keeping_host_and_path() {
        let reason = "HTTP 307 redirect to https://app.example.com/?__clerk_handshake=eyJhbGciOiJSUzI1NiJ9.payload.sig&_cb=1 (requested /)";
        let redacted = redact_handshake_values(reason);
        assert_eq!(
            redacted,
            "HTTP 307 redirect to https://app.example.com/?__clerk_handshake=<redacted>&_cb=1 (requested /)"
        );
    }

    #[test]
    fn redacts_multiple_occurrences_and_end_of_string() {
        let redacted = redact_handshake_values(
            "/?__clerk_handshake=tok1 (requested /cb?__clerk_handshake=tok2)",
        );
        assert!(!redacted.contains("tok1"));
        assert!(!redacted.contains("tok2"));
        assert_eq!(
            redacted,
            "/?__clerk_handshake=<redacted> (requested /cb?__clerk_handshake=<redacted>)"
        );
    }

    #[test]
    fn redaction_leaves_strings_without_the_param_unchanged() {
        let s = "HTTP 307 redirect to https://my-app.clerk.accounts.dev/v1/client/handshake?redirect_url=x (requested /)";
        assert_eq!(redact_handshake_values(s), s);
    }
}

/// End-to-end tests over real sockets: a canned upstream records exactly what
/// the proxy forwards, and the raw response bytes show what a webview would see.
#[cfg(test)]
mod e2e_tests {
    use super::{start_preview_proxy, stop_preview_proxy};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;

    /// Spawn a fake dev server that captures each request's head (through the
    /// blank line) and answers with `response`. Returns its port.
    async fn spawn_upstream(response: &'static str, captured: Arc<Mutex<Vec<String>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let captured = captured.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    captured
                        .lock()
                        .await
                        .push(String::from_utf8_lossy(&head).to_string());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        port
    }

    /// Send raw bytes to the proxy and collect the full response.
    async fn roundtrip(proxy_port: u16, request: String) -> String {
        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        // WS upgrades keep the socket open — read until headers, then stop.
        let mut buf = [0u8; 1024];
        while !resp.windows(4).any(|w| w == b"\r\n\r\n") || resp.starts_with(b"HTTP/1.1 200") {
            match tokio::time::timeout(std::time::Duration::from_secs(5), client.read(&mut buf))
                .await
            {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => resp.extend_from_slice(&buf[..n]),
                Ok(Err(_)) => break,
            }
        }
        String::from_utf8_lossy(&resp).to_string()
    }

    #[tokio::test]
    async fn http_path_rewrites_headers_hardens_caching_and_injects() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let body = "<html><head><title>t</title></head><body>hi</body></html>";
        let upstream = spawn_upstream(
            // Cacheable upstream response — the proxy must strip the validators
            // since the injected body no longer matches them.
            Box::leak(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nCache-Control: max-age=3600\r\nETag: \"abc\"\r\n\r\n{body}",
                    body.len()
                )
                .into_boxed_str(),
            ),
            captured.clone(),
        )
        .await;
        let proxy_port = start_preview_proxy("e2e-http".into(), upstream)
            .await
            .unwrap();

        let resp = roundtrip(
            proxy_port,
            format!(
                "GET / HTTP/1.1\r\nHost: localhost:{proxy_port}\r\nOrigin: http://localhost:{proxy_port}\r\nAccept-Encoding: gzip, br\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        stop_preview_proxy("e2e-http");

        // What the dev server saw: its own port in Host/Origin, no Accept-Encoding.
        let seen = captured.lock().await.join("").to_lowercase();
        assert!(
            seen.contains(&format!("host: localhost:{upstream}")),
            "{seen}"
        );
        assert!(
            seen.contains(&format!("origin: http://localhost:{upstream}")),
            "{seen}"
        );
        assert!(!seen.contains("accept-encoding"), "{seen}");

        // What the webview gets: injected scripts, hard no-store, no validators.
        assert!(resp.contains("ss-reload-suppress"), "{resp}");
        assert!(resp.contains("ss-scroll-restore"), "{resp}");
        assert!(resp.contains("shipstudio:navigate"), "{resp}");
        let lower = resp.to_lowercase();
        assert!(lower.contains("cache-control: no-store"), "{resp}");
        assert!(!lower.contains("etag"), "{resp}");
        assert!(!lower.contains("max-age"), "{resp}");
    }

    #[tokio::test]
    async fn ws_upgrade_rewrites_host_and_origin_for_hmr() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let upstream = spawn_upstream(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n",
            captured.clone(),
        )
        .await;
        let proxy_port = start_preview_proxy("e2e-ws".into(), upstream)
            .await
            .unwrap();

        let resp = roundtrip(
            proxy_port,
            format!(
                "GET / HTTP/1.1\r\nHost: localhost:{proxy_port}\r\nOrigin: http://localhost:{proxy_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n"
            ),
        )
        .await;
        stop_preview_proxy("e2e-ws");

        // The upgrade reached the dev server with ITS port in Host/Origin —
        // Vite origin-checks the HMR socket; the proxy port would get it
        // rejected and silently kill hot updates.
        let seen = captured.lock().await.join("").to_lowercase();
        assert!(
            seen.contains(&format!("host: localhost:{upstream}")),
            "{seen}"
        );
        assert!(
            seen.contains(&format!("origin: http://localhost:{upstream}")),
            "{seen}"
        );
        assert!(seen.contains("sec-websocket-protocol: vite-hmr"), "{seen}");

        // And the upgrade completed through the proxy.
        assert!(resp.starts_with("HTTP/1.1 101"), "{resp}");
    }

    #[tokio::test]
    async fn html_streams_progressively_through_the_proxy() {
        // Upstream sends the head, then HOLDS the rest until we've verified the
        // injected head already reached the client — proving the proxy streams
        // instead of buffering the whole document (progressive SSR paint).
        let head = "<html><head><title>t</title></head><body><p>first</p>";
        let tail = "<p>second</p></body></html>";
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf).await;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n",
                head.len() + tail.len()
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            let _ = release_rx.await;
            stream.write_all(tail.as_bytes()).await.unwrap();
        });

        let proxy_port = start_preview_proxy("e2e-stream".into(), upstream)
            .await
            .unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        client
            .write_all(
                format!(
                    "GET / HTTP/1.1\r\nHost: localhost:{proxy_port}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        // Read until the first body part arrives — the tail hasn't been sent yet.
        let mut received = Vec::new();
        let mut buf = [0u8; 4096];
        while !String::from_utf8_lossy(&received).contains("<p>first</p>") {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), client.read(&mut buf))
                .await
                .expect("head must stream before the body completes")
                .unwrap();
            assert!(n > 0, "connection closed before head arrived");
            received.extend_from_slice(&buf[..n]);
        }
        let so_far = String::from_utf8_lossy(&received).to_string();
        assert!(so_far.contains("ss-reload-suppress"), "{so_far}");
        assert!(so_far.contains("shipstudio:navigate"), "{so_far}");
        assert!(!so_far.contains("<p>second</p>"), "{so_far}");

        // Release the tail and confirm it flows through untouched.
        release_tx.send(()).unwrap();
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), client.read(&mut buf))
                .await
            {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => received.extend_from_slice(&buf[..n]),
                Ok(Err(_)) => break,
            }
        }
        stop_preview_proxy("e2e-stream");
        let full = String::from_utf8_lossy(&received).to_string();
        assert!(full.contains("<p>second</p></body></html>"), "{full}");
    }
}
