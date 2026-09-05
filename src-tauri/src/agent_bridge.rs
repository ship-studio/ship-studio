//! # Agent Preview Bridge
//!
//! A loopback MCP server (Streamable HTTP transport) that lets the AI agent
//! running in the workspace terminal use the live preview: read console
//! output and network requests, inspect the DOM, navigate, reload, and take
//! screenshots.
//!
//! Security model: the server binds 127.0.0.1 and only answers on the path
//! `/mcp/<token>` where the token is random per server instance. The full URL
//! (including the token) is handed to the agent CLI via `mcp add`, so the
//! agent never handles a credential — but a malicious webpage spraying
//! loopback ports can't guess the path, and any request carrying a browser
//! `Origin` header is rejected outright (MCP CLI clients never send one).
//!
//! Tool calls are not executed here: each `tools/call` is forwarded to the
//! window's frontend as an `agent-bridge-request` event, and the frontend
//! (which owns the inspect store and the preview iframe) answers via the
//! `agent_bridge_respond` command. This module only speaks MCP.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

type ServerBody = BoxBody<Bytes, hyper::Error>;

fn full_body(data: Bytes) -> ServerBody {
    Full::new(data).map_err(|never| match never {}).boxed()
}

/// Maximum accepted request body (JSON-RPC messages are tiny; this is a
/// safety cap, not a tuning knob).
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a forwarded tool call waits for the frontend before giving up.
const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 20;
/// Screenshots go through Playwright; the first run may install a headless
/// Chromium, which takes minutes.
const SCREENSHOT_TOOL_TIMEOUT_SECS: u64 = 240;

/// MCP protocol revisions this server knows. We echo the client's requested
/// version when it's one of these; otherwise we answer with our latest.
const KNOWN_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION: &str = "2025-03-26";

/// The single global bridge server (one per app process).
struct GlobalBridge {
    port: u16,
    token: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    _task_handle: JoinHandle<()>,
}

static GLOBAL_BRIDGE: LazyLock<Mutex<Option<GlobalBridge>>> = LazyLock::new(|| Mutex::new(None));

/// In-flight tool calls awaiting a frontend answer, keyed by request id.
static PENDING_REQUESTS: LazyLock<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Projects whose preview frontend currently has a live bridge listener.
/// Lets tool calls fail fast with an honest message instead of waiting out
/// the full timeout when the preview panel isn't mounted.
static ATTACHED_PROJECTS: LazyLock<Mutex<std::collections::HashSet<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// Mark a project's preview listener as attached/detached (canonical path).
pub fn set_project_attached(canonical_project_path: &str, attached: bool) {
    if let Ok(mut set) = ATTACHED_PROJECTS.lock() {
        if attached {
            set.insert(canonical_project_path.to_string());
        } else {
            set.remove(canonical_project_path);
        }
    }
}

fn is_project_attached(canonical_project_path: &str) -> bool {
    ATTACHED_PROJECTS
        .lock()
        .map(|set| set.contains(canonical_project_path))
        .unwrap_or(false)
}

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// The bridge's persistent identity, stored in its OWN file (next to
/// app_state.json). It deliberately does not live inside app_state.json:
/// that file is read-modify-written by many commands (and by older app
/// versions whose struct doesn't know these fields), so anything stored
/// there can be silently clobbered by a concurrent or older writer.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct BridgeIdentity {
    token: Option<String>,
    port: Option<u16>,
}

fn identity_path() -> Option<std::path::PathBuf> {
    crate::commands::setup::get_app_state_path()
        .parent()
        .map(|dir| dir.join("agent_bridge.json"))
}

fn read_identity() -> BridgeIdentity {
    identity_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_identity(identity: &BridgeIdentity) {
    let Some(path) = identity_path() else {
        tracing::warn!("[AgentBridge] No home dir — bridge identity will rotate next run");
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(identity) {
        Ok(json) => {
            // The file holds the bridge's bearer token — the only thing standing
            // between a local process and the preview tools. Create it owner-only
            // rather than writing first and chmod-ing after: the default umask
            // would otherwise leave the token world-readable for the window
            // between the write and the fix-up.
            let write_result = {
                #[cfg(unix)]
                {
                    use std::io::Write;
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(&path)
                        .and_then(|mut f| f.write_all(json.as_bytes()))
                }
                #[cfg(not(unix))]
                {
                    std::fs::write(&path, json)
                }
            };

            if let Err(e) = write_result {
                tracing::warn!(
                    "[AgentBridge] Could not persist bridge identity (registrations will rotate next run): {}",
                    e
                );
                return;
            }

            // `mode` above only applies when the file is *created*, so anyone
            // upgrading from a build that wrote this at umask still has a
            // world-readable token sitting on disk. Normalize every time.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(e) =
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                {
                    tracing::warn!(
                        "[AgentBridge] Could not restrict bridge identity permissions — the token may be readable by other local users: {}",
                        e
                    );
                }
            }
        }
        Err(e) => tracing::warn!("[AgentBridge] Could not serialize bridge identity: {}", e),
    }
}

/// Per-project MCP URL. The project path rides in the URL (base64url) so the
/// one global server can route each tool call to the window that has that
/// project open — and so a registration written into the agent's config today
/// still routes correctly in any future app run.
fn project_bridge_url(port: u16, token: &str, canonical_project_path: &str) -> String {
    use base64::Engine;
    let encoded =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(canonical_project_path.as_bytes());
    format!("http://127.0.0.1:{port}/mcp/{token}/{encoded}")
}

/// URL segment for agents with GLOBAL MCP configs (Codex, Opencode, Cursor):
/// instead of a baked-in project path, tool calls resolve to the currently
/// focused Ship Studio project at call time.
pub const ACTIVE_PROJECT_SEGMENT: &str = "active";

fn decode_project_segment(segment: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(segment.trim_end_matches('/'))
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// Start the global bridge server (idempotent — later calls return the
/// running instance). Called once at app startup so the server exists before
/// any agent session spawns.
///
/// The token and port persist in app state: a `claude mcp add` registration
/// done in one app run must keep working in every later run. If the stored
/// port is taken (another Ship Studio instance, or an unrelated process), we
/// fall back to an ephemeral port and persist the new one — per-project
/// registrations self-correct the next time that project is opened.
pub async fn start_global_agent_bridge(app: tauri::AppHandle) -> Result<(u16, String), String> {
    // Kill switch: support/debug escape hatch if the bridge misbehaves in the
    // field. With the server down, agents just see one failed-to-connect MCP
    // entry and everything else works normally.
    if std::env::var("SHIPSTUDIO_DISABLE_AGENT_BRIDGE").is_ok_and(|v| !v.is_empty() && v != "0") {
        return Err(
            "Agent bridge disabled by SHIPSTUDIO_DISABLE_AGENT_BRIDGE environment variable"
                .to_string(),
        );
    }

    if let Ok(guard) = GLOBAL_BRIDGE.lock() {
        if let Some(existing) = guard.as_ref() {
            return Ok((existing.port, existing.token.clone()));
        }
    }

    let mut identity = read_identity();
    let token = match identity.token.clone() {
        Some(t) if !t.is_empty() => t,
        _ => uuid::Uuid::new_v4().simple().to_string(),
    };

    // Prefer the port from the last run so registered URLs stay valid.
    let mut listener = None;
    if let Some(stored_port) = identity.port {
        match TcpListener::bind(("127.0.0.1", stored_port)).await {
            Ok(l) => listener = Some(l),
            Err(e) => {
                tracing::warn!(
                    "[AgentBridge] Stored port {} unavailable ({}) — binding a new one",
                    stored_port,
                    e
                );
            }
        }
    }
    let listener = match listener {
        Some(l) => l,
        None => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind agent bridge port: {e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get agent bridge address: {e}"))?
        .port();

    // Persist the stable identity for future runs.
    if identity.token.as_deref() != Some(token.as_str()) || identity.port != Some(port) {
        identity.token = Some(token.clone());
        identity.port = Some(port);
        write_identity(&identity);
    }

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let token_for_task = token.clone();
    let task_handle = tokio::spawn(async move {
        tracing::info!("[AgentBridge] Global MCP server started on port {}", port);
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, _addr)) => {
                            let app = app.clone();
                            let token = token_for_task.clone();
                            tokio::spawn(async move {
                                let io = TokioIo::new(stream);
                                let service = service_fn(move |req: Request<Incoming>| {
                                    let app = app.clone();
                                    let token = token.clone();
                                    async move { handle_http(app, token, req).await }
                                });
                                if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                                    tracing::debug!("[AgentBridge] Connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => tracing::error!("[AgentBridge] Accept error: {}", e),
                    }
                }
                _ = &mut shutdown_rx => {
                    tracing::info!("[AgentBridge] Shutting down on port {}", port);
                    break;
                }
            }
        }
    });

    if let Ok(mut guard) = GLOBAL_BRIDGE.lock() {
        *guard = Some(GlobalBridge {
            port,
            token: token.clone(),
            shutdown_tx: Some(shutdown_tx),
            _task_handle: task_handle,
        });
    }

    Ok((port, token))
}

/// URL for one project's MCP registration; starts the server if needed.
pub async fn agent_bridge_url_for_project(
    app: tauri::AppHandle,
    canonical_project_path: &str,
) -> Result<String, String> {
    let (port, token) = start_global_agent_bridge(app).await?;
    Ok(project_bridge_url(port, &token, canonical_project_path))
}

/// URL for agents whose MCP config is global (Codex, Opencode, Cursor):
/// routes to the focused Ship Studio project at call time.
pub async fn agent_bridge_active_url(app: tauri::AppHandle) -> Result<String, String> {
    let (port, token) = start_global_agent_bridge(app).await?;
    Ok(format!(
        "http://127.0.0.1:{port}/mcp/{token}/{ACTIVE_PROJECT_SEGMENT}"
    ))
}

/// Stop the global bridge (app cleanup).
pub fn stop_all_agent_bridges() {
    if let Ok(mut guard) = GLOBAL_BRIDGE.lock() {
        if let Some(mut bridge) = guard.take() {
            if let Some(tx) = bridge.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[AgentBridge] Stopped global bridge (cleanup)");
        }
    }
}

/// Resolve an in-flight tool call with the frontend's answer.
/// Returns false when the request already timed out (or never existed).
pub fn resolve_bridge_request(request_id: u64, result: Value) -> bool {
    let sender = PENDING_REQUESTS
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    match sender {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
}

// ============================================================================
// HTTP layer
// ============================================================================

fn plain_response(status: StatusCode, body: &'static str) -> Response<ServerBody> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(full_body(Bytes::from(body)))
        .unwrap()
}

fn json_response(value: Value) -> Response<ServerBody> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .body(full_body(Bytes::from(value.to_string())))
        .unwrap()
}

/// Requests carrying a browser `Origin` header are cross-origin fetches from
/// a webpage — never an MCP CLI client. Reject them all: combined with the
/// random URL token this closes off CSRF and DNS-rebinding attacks.
fn is_browser_origin(req: &Request<Incoming>) -> bool {
    req.headers().get("origin").is_some()
}

/// The Host header must be loopback — a DNS-rebinding request arrives with
/// the attacker's hostname.
fn has_valid_host(req: &Request<Incoming>) -> bool {
    match req.headers().get("host").and_then(|h| h.to_str().ok()) {
        Some(host) => {
            let host = host.split(':').next().unwrap_or("");
            host == "127.0.0.1" || host == "localhost" || host == "[::1]"
        }
        // HTTP/1.1 requires Host; anything without it is not a real client.
        None => false,
    }
}

async fn handle_http(
    app: tauri::AppHandle,
    token: String,
    req: Request<Incoming>,
) -> Result<Response<ServerBody>, hyper::Error> {
    if is_browser_origin(&req) || !has_valid_host(&req) {
        tracing::warn!("[AgentBridge] Rejected request with browser Origin or foreign Host");
        return Ok(plain_response(StatusCode::FORBIDDEN, "Forbidden"));
    }

    // Path shape: /mcp/<token>/<base64url(project path)>, or the literal
    // segment "active" for agents whose MCP config is global (Codex,
    // Opencode, Cursor) — resolved to the focused project per tool call.
    let expected_prefix = format!("/mcp/{token}/");
    let Some(segment) = req.uri().path().strip_prefix(&expected_prefix) else {
        return Ok(plain_response(StatusCode::NOT_FOUND, "Not found"));
    };
    let project_path = if segment.trim_end_matches('/') == ACTIVE_PROJECT_SEGMENT {
        ACTIVE_PROJECT_SEGMENT.to_string()
    } else {
        match decode_project_segment(segment) {
            Some(p) if !p.is_empty() => p,
            _ => return Ok(plain_response(StatusCode::NOT_FOUND, "Not found")),
        }
    };

    match *req.method() {
        Method::POST => {
            let body = req.into_body().collect().await?.to_bytes();
            if body.len() > MAX_BODY_BYTES {
                return Ok(plain_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Payload too large",
                ));
            }
            let message: Value = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(e) => {
                    return Ok(json_response(error_response(
                        Value::Null,
                        -32700,
                        &format!("Parse error: {e}"),
                    )))
                }
            };
            if message.is_array() {
                return Ok(json_response(error_response(
                    Value::Null,
                    -32600,
                    "Batch requests are not supported",
                )));
            }
            // JSON-RPC notification (no id): acknowledge without a body.
            if message.get("id").is_none_or(Value::is_null) {
                return Ok(Response::builder()
                    .status(StatusCode::ACCEPTED)
                    .body(full_body(Bytes::new()))
                    .unwrap());
            }
            let response = handle_rpc(&app, &project_path, &message).await;
            Ok(json_response(response))
        }
        // We don't offer a server-initiated SSE stream.
        Method::GET => Ok(plain_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
        // Session termination is a no-op for this stateless server.
        Method::DELETE => Ok(plain_response(StatusCode::OK, "")),
        _ => Ok(plain_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        )),
    }
}

// ============================================================================
// JSON-RPC / MCP layer
// ============================================================================

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn success_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(LATEST_PROTOCOL_VERSION);
    let version = if KNOWN_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        LATEST_PROTOCOL_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "ship-studio-preview",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "PREFERRED tools for anything involving THIS project's own site: viewing pages, clicking buttons, filling forms, reading console/network output, taking screenshots. They drive the live preview inside Ship Studio that the user is already watching — always use these instead of generic browser automation (Chrome extensions, Playwright, opening a browser) when the target is this project's pages; they are faster, need no setup, and the user sees an agent cursor mark every action. Start with preview_status to see what's running and which pages exist. After making code changes, use preview_console to check for runtime errors and preview_screenshot to see the rendered result. preview_click/preview_type/preview_scroll interact with the page like a user would; preview_navigate switches pages. When NOT to use these: (1) other websites, the deployed production site, or tasks needing an existing logged-in browser session — use a browser automation tool if one is available; (2) anything requiring the user personally — signing in with real credentials, OAuth/social-login popups, payments or checkout, camera/microphone permissions, or judging how the site feels on their real devices and browsers — there, ask the user to check it themselves in their own browser and tell them what to look for.",
    })
}

struct ToolDef {
    name: &'static str,
    description: &'static str,
    timeout_secs: u64,
    input_schema: fn() -> Value,
}

const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "preview_console",
        description: "Read recent console output (logs, warnings, errors, uncaught exceptions, unhandled rejections) captured from the Ship Studio live preview of this project. Use after making changes to check for runtime errors.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "level": { "type": "string", "enum": ["all", "error", "warn"], "description": "Filter: 'error' = errors only, 'warn' = warnings and errors, 'all' (default) = everything." },
                "limit": { "type": "integer", "description": "Max entries, most recent first kept (default 50)." }
            }
        }),
    },
    ToolDef {
        name: "preview_network",
        description: "List recent network requests (fetch/XHR) made by the preview page, with method, status, and duration. Useful for spotting failing API calls.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "failed_only": { "type": "boolean", "description": "Only requests that errored or returned status >= 400." },
                "limit": { "type": "integer", "description": "Max entries, most recent kept (default 50)." }
            }
        }),
    },
    ToolDef {
        name: "preview_dom",
        description: "Get a fresh serialized snapshot of the preview page's current DOM tree as an HTML outline. Use to verify what actually rendered.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDef {
        name: "preview_navigate",
        description: "Navigate the live preview to a path within the app, e.g. '/about'. The user sees the preview change.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path within the app, starting with '/'." }
            },
            "required": ["path"]
        }),
    },
    ToolDef {
        name: "preview_reload",
        description: "Reload the current preview page.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDef {
        name: "preview_status",
        description: "One-call situational summary of the live preview: dev server state, current page, the app's available pages/routes, and console/network error counts. Call this first when something seems off or before navigating.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({ "type": "object", "properties": {} }),
    },
    ToolDef {
        name: "preview_click",
        description: "Click an element in the preview page, found by CSS selector (optionally narrowed by contained text). Fires real pointer/mouse events, so framework handlers run. The user sees an agent cursor land on the element.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string", "description": "CSS selector for the target element, e.g. 'button.submit' or 'a[href=\"/about\"]'." },
                "text": { "type": "string", "description": "Only match elements whose text contains this (case-insensitive)." },
                "index": { "type": "integer", "description": "Which match to click when several elements match (0-based, default 0)." }
            },
            "required": ["selector"]
        }),
    },
    ToolDef {
        name: "preview_type",
        description: "Type into an input, textarea, or contenteditable in the preview page (replaces its current value; works with React controlled inputs). Optionally submit afterwards.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string", "description": "CSS selector for the field, e.g. 'input[name=\"email\"]'." },
                "value": { "type": "string", "description": "The text to enter (replaces the field's current value)." },
                "text": { "type": "string", "description": "Only match elements whose text contains this (case-insensitive)." },
                "index": { "type": "integer", "description": "Which match to use when several elements match (0-based, default 0)." },
                "submit": { "type": "boolean", "description": "Submit the field's form (or press Enter) after typing." }
            },
            "required": ["selector", "value"]
        }),
    },
    ToolDef {
        name: "preview_scroll",
        description: "Scroll the preview page — to an element (by CSS selector), or to 'top'/'bottom', or to an absolute Y offset.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string", "description": "Scroll this element into view." },
                "text": { "type": "string", "description": "Only match elements whose text contains this (case-insensitive)." },
                "to": { "type": "string", "enum": ["top", "bottom"], "description": "Scroll to the top or bottom of the page." },
                "y": { "type": "number", "description": "Absolute Y offset in pixels." }
            }
        }),
    },
    ToolDef {
        name: "preview_query",
        description: "Inspect specific elements in the preview by CSS selector: returns match count, visibility, and each match's HTML (capped). More precise and cheaper than reading the whole DOM with preview_dom.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string", "description": "CSS selector to match, e.g. '.hero h1' or 'form input'." },
                "text": { "type": "string", "description": "Only match elements whose text contains this (case-insensitive)." }
            },
            "required": ["selector"]
        }),
    },
    ToolDef {
        name: "preview_set_viewport",
        description: "Set the preview's viewport width to test responsive behavior — a device preset or an exact pixel width. The page re-lays-out at that true width, and preview_screenshot captures at it. The user sees the preview resize.",
        timeout_secs: DEFAULT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "preset": { "type": "string", "enum": ["mobile", "tablet", "laptop", "desktop", "full"], "description": "Device preset: mobile=375px, tablet=768px, laptop=1024px, desktop=1440px, full=fit the pane." },
                "width": { "type": "integer", "description": "Exact viewport width in pixels (200-3000). Overrides preset." }
            }
        }),
    },
    ToolDef {
        name: "preview_screenshot",
        description: "Take a screenshot of the current preview page and return it as an image (also saved under .shipstudio/screenshots/). The first use may take a few minutes while a headless browser is installed.",
        timeout_secs: SCREENSHOT_TOOL_TIMEOUT_SECS,
        input_schema: || json!({
            "type": "object",
            "properties": {
                "full_page": { "type": "boolean", "description": "Capture the full scrollable page instead of just the viewport (slower)." }
            }
        }),
    },
];

fn tools_list_result() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.input_schema)(),
            })
        })
        .collect();
    json!({ "tools": tools })
}

async fn handle_rpc(app: &tauri::AppHandle, project_path: &str, message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");

    match method {
        "initialize" => success_response(id, initialize_result(params)),
        "ping" => success_response(id, json!({})),
        "tools/list" => success_response(id, tools_list_result()),
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let arguments = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            match TOOLS.iter().find(|t| t.name == name) {
                Some(tool) => {
                    let result = dispatch_tool(app, project_path, tool, arguments).await;
                    success_response(id, result)
                }
                None => error_response(id, -32602, &format!("Unknown tool: {name}")),
            }
        }
        _ => error_response(id, -32601, &format!("Method not found: {method}")),
    }
}

/// Forward a tool call to the frontend of the window that has this project
/// open, and wait for its answer. Failures come back as in-band tool errors
/// (isError: true) rather than protocol errors, so the agent can read what
/// went wrong and adapt.
async fn dispatch_tool(
    app: &tauri::AppHandle,
    project_path: &str,
    tool: &ToolDef,
    arguments: Value,
) -> Value {
    // Route by project. Per-project URLs (Claude Code) carry the path; the
    // "active" URL (global-config agents: Codex, Opencode, Cursor) resolves
    // to the focused Ship Studio project at call time.
    let resolved_project = if project_path == ACTIVE_PROJECT_SEGMENT {
        match resolve_active_project(app) {
            Ok(p) => p,
            Err(message) => return tool_error_result(&message),
        }
    } else {
        project_path.to_string()
    };
    let project_path = resolved_project.as_str();

    let Some(window_label) = crate::state::get_window_for_project(project_path) else {
        return tool_error_result(
            "This project isn't open in Ship Studio right now. Ask the user to open the project (its preview provides these tools).",
        );
    };

    // Fail fast when the preview frontend isn't listening — waiting out the
    // timeout would just stall the agent for no reason.
    if !is_project_attached(project_path) {
        return tool_error_result(
            "The project is open in Ship Studio, but its web preview isn't active, so these tools can't run. If this is a web project, ask the user to switch to its workspace (the preview loads there). If it's a native mobile project (Expo / React Native / Flutter), it uses the simulator preview instead — these web-preview tools don't apply; verify through code, build output, and the user.",
        );
    }

    let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<Value>();

    if let Ok(mut pending) = PENDING_REQUESTS.lock() {
        pending.insert(request_id, tx);
    } else {
        return tool_error_result(
            "Ship Studio's agent bridge is in a broken state (lock poisoned). Restart Ship Studio.",
        );
    }

    let payload = json!({
        "requestId": request_id,
        "tool": tool.name,
        "arguments": arguments,
    });
    tracing::info!(
        "[AgentBridge] Tool call '{}' (request {}) for window '{}'",
        tool.name,
        request_id,
        window_label
    );

    if let Err(e) = app.emit_to(&window_label, "agent-bridge-request", payload) {
        if let Ok(mut pending) = PENDING_REQUESTS.lock() {
            pending.remove(&request_id);
        }
        return tool_error_result(&format!(
            "Could not reach the Ship Studio preview window: {e}"
        ));
    }

    match tokio::time::timeout(Duration::from_secs(tool.timeout_secs), rx).await {
        Ok(Ok(result)) => {
            // The frontend answers with a full MCP CallToolResult. Guard the
            // shape so a bug there can't produce a protocol-corrupting reply.
            if result.get("content").map(Value::is_array).unwrap_or(false) {
                result
            } else {
                tool_error_result("The preview returned a malformed tool result (missing 'content'). This is a Ship Studio bug.")
            }
        }
        Ok(Err(_)) | Err(_) => {
            if let Ok(mut pending) = PENDING_REQUESTS.lock() {
                pending.remove(&request_id);
            }
            tool_error_result(&format!(
                "The preview did not respond within {}s. The preview panel may not be open in Ship Studio, or the dev server may not be running. Ask the user to open the preview.",
                tool.timeout_secs
            ))
        }
    }
}

/// Which project should an "active"-URL tool call act on?
/// The focused Ship Studio window's project wins; with nothing focused
/// (agent running while the user looks elsewhere), a single open project is
/// unambiguous; several open projects without focus is unanswerable.
fn resolve_active_project(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let open = crate::state::get_open_project_windows();
    if open.is_empty() {
        return Err(
            "No project is open in Ship Studio right now. Ask the user to open the project you're working on (its preview provides these tools).".to_string(),
        );
    }
    for (label, window) in app.webview_windows() {
        if window.is_focused().unwrap_or(false) {
            if let Some((project, _)) = open.iter().find(|(_, l)| *l == label) {
                return Ok(project.clone());
            }
        }
    }
    if open.len() == 1 {
        return Ok(open[0].0.clone());
    }
    Err(format!(
        "Several projects are open in Ship Studio ({}) and none is focused, so it's unclear which preview to use. Ask the user to focus the project you're working on.",
        open.iter()
            .map(|(p, _)| p.rsplit('/').next().unwrap_or(p))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn tool_error_result(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_echoes_known_protocol_version() {
        let params = json!({ "protocolVersion": "2024-11-05" });
        let result = initialize_result(Some(&params));
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["serverInfo"]["name"], "ship-studio-preview");
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[test]
    fn test_initialize_falls_back_on_unknown_protocol_version() {
        let params = json!({ "protocolVersion": "1999-01-01" });
        let result = initialize_result(Some(&params));
        assert_eq!(result["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn test_initialize_without_params() {
        let result = initialize_result(None);
        assert_eq!(result["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn test_tools_list_contains_all_tools() {
        let result = tools_list_result();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), TOOLS.len());
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"preview_console"));
        assert!(names.contains(&"preview_screenshot"));
        assert!(names.contains(&"preview_navigate"));
        // Every tool must have a valid object schema.
        for tool in tools {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(!tool["description"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn test_error_response_shape() {
        let resp = error_response(json!(7), -32601, "Method not found: nope");
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 7);
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn test_resolve_unknown_request_returns_false() {
        assert!(!resolve_bridge_request(999_999, json!({})));
    }

    #[test]
    fn test_tool_error_result_is_in_band() {
        let result = tool_error_result("boom");
        assert_eq!(result["isError"], true);
        assert_eq!(result["content"][0]["type"], "text");
        assert_eq!(result["content"][0]["text"], "boom");
    }

    #[test]
    fn test_project_bridge_url_roundtrip() {
        let project = "/Users/me/ShipStudio/my site"; // spaces must survive
        let url = project_bridge_url(4123, "abc123", project);
        assert!(url.starts_with("http://127.0.0.1:4123/mcp/abc123/"));
        let segment = url.rsplit('/').next().unwrap();
        assert_eq!(decode_project_segment(segment).as_deref(), Some(project));
    }

    #[test]
    fn test_decode_project_segment_rejects_garbage() {
        assert!(decode_project_segment("!!!not-base64!!!").is_none());
        // Empty decodes to an empty string, which handle_http rejects.
        assert_eq!(decode_project_segment("").as_deref(), Some(""));
    }
}
