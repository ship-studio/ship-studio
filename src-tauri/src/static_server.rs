//! # Static File Server
//!
//! A lightweight HTTP server that serves static files from a project directory.
//! Used for previewing plain HTML/CSS/JS projects that don't have a framework
//! dev server (no `npm run dev`).
//!
//! Runs behind the existing preview proxy, which handles navigation tracking
//! script injection and error overlays.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Body type for static server responses.
type ServerBody = BoxBody<Bytes, hyper::Error>;

/// Convert full bytes into a ServerBody.
fn full_body(data: Bytes) -> ServerBody {
    Full::new(data).map_err(|never| match never {}).boxed()
}

/// MIME type mappings for common static file extensions.
const MIME_TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("htm", "text/html; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("js", "application/javascript; charset=utf-8"),
    ("mjs", "application/javascript; charset=utf-8"),
    ("json", "application/json; charset=utf-8"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("eot", "application/vnd.ms-fontobject"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("ogg", "audio/ogg"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("pdf", "application/pdf"),
    ("txt", "text/plain; charset=utf-8"),
    ("xml", "application/xml"),
    ("wasm", "application/wasm"),
    ("map", "application/json"),
];

/// Get the MIME type for a file extension.
fn get_mime_type(extension: &str) -> &'static str {
    let ext_lower = extension.to_lowercase();
    for (ext, mime) in MIME_TYPES {
        if *ext == ext_lower {
            return mime;
        }
    }
    "application/octet-stream"
}

/// Extensions that should trigger a live reload when changed.
const WATCH_EXTENSIONS: &[&str] = &[
    "html", "htm", "css", "js", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
];

/// Directories to ignore when watching for file changes.
const WATCH_IGNORE_DIRS: &[&str] = &[".git", "node_modules", ".shipstudio", ".DS_Store"];

/// Minimum interval between file change events (debounce).
const DEBOUNCE_MS: u64 = 300;

/// A running static server instance.
struct StaticServerInstance {
    port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    _task_handle: JoinHandle<()>,
    watcher_shutdown_tx: Option<oneshot::Sender<()>>,
}

/// Maps window_label -> StaticServerInstance
static STATIC_SERVER_INSTANCES: LazyLock<Mutex<HashMap<String, StaticServerInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Start a static file server for the given window, serving files from `project_path`.
/// Returns the server's listening port. Also starts a file watcher that emits
/// `static-file-changed` Tauri events when project files are modified.
pub async fn start_static_server(
    app: tauri::AppHandle,
    window_label: String,
    project_path: String,
) -> Result<u16, String> {
    // Stop any existing server for this window
    stop_static_server(&window_label);

    let project_root = PathBuf::from(&project_path);
    if !project_root.exists() || !project_root.is_dir() {
        return Err(format!(
            "Project path does not exist or is not a directory: {project_path}"
        ));
    }

    // Serve from `public/` (Vercel's static-deploy convention) when the project
    // root has no HTML of its own — the same rule `detect_project_type` uses to
    // classify the project as static in the first place. Falls back to the root
    // so force-static projects with unusual layouts still serve something.
    let serve_root =
        crate::commands::projects::static_site_dir(&project_root).unwrap_or(project_root.clone());

    // Canonicalize once at startup for path traversal checks
    let canonical_root = dunce::canonicalize(&serve_root)
        .map_err(|e| format!("Failed to canonicalize project path: {e}"))?;

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind static server port: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get static server address: {e}"))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task_handle = tokio::spawn(async move {
        tracing::info!(
            "[StaticServer] Started on port {} serving {}",
            port,
            canonical_root.display()
        );

        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, addr)) => {
                            let root = canonical_root.clone();
                            tokio::spawn(handle_connection(stream, addr, root));
                        }
                        Err(e) => {
                            tracing::error!("[StaticServer] Accept error: {}", e);
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    tracing::info!("[StaticServer] Shutting down on port {}", port);
                    break;
                }
            }
        }
    });

    // Start file watcher for live reload
    let watcher_shutdown_tx =
        start_file_watcher(app, window_label.clone(), PathBuf::from(&project_path));

    let instance = StaticServerInstance {
        port,
        shutdown_tx: Some(shutdown_tx),
        _task_handle: task_handle,
        watcher_shutdown_tx: Some(watcher_shutdown_tx),
    };

    STATIC_SERVER_INSTANCES
        .lock()
        .map_err(|e| format!("Failed to acquire static server lock: {e}"))?
        .insert(window_label.clone(), instance);

    tracing::info!(
        "[StaticServer] Registered for window '{}' on port {}",
        window_label,
        port
    );
    Ok(port)
}

/// Stop the static server for the given window.
pub fn stop_static_server(window_label: &str) {
    if let Ok(mut instances) = STATIC_SERVER_INSTANCES.lock() {
        if let Some(mut instance) = instances.remove(window_label) {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            if let Some(tx) = instance.watcher_shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!(
                "[StaticServer] Stopped server for window '{}' (port {})",
                window_label,
                instance.port
            );
        }
    }
}

/// Stop all running static servers (called during app cleanup).
pub fn stop_all_static_servers() {
    if let Ok(mut instances) = STATIC_SERVER_INSTANCES.lock() {
        for (label, mut instance) in instances.drain() {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            if let Some(tx) = instance.watcher_shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!(
                "[StaticServer] Stopped server for window '{}' (cleanup)",
                label
            );
        }
    }
}

/// Check if a file path should trigger a reload based on its extension and location.
fn should_trigger_reload(path: &Path) -> bool {
    // Check if path contains any ignored directory segments
    let path_str = path.to_string_lossy();
    for ignored in WATCH_IGNORE_DIRS {
        if path_str.contains(ignored) {
            return false;
        }
    }

    // Check extension
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        WATCH_EXTENSIONS.iter().any(|&e| e == ext_lower)
    } else {
        false
    }
}

/// Start a file watcher that emits Tauri events when project files change.
/// Returns a shutdown channel sender to stop the watcher.
fn start_file_watcher(
    app: tauri::AppHandle,
    window_label: String,
    project_path: PathBuf,
) -> oneshot::Sender<()> {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    // Use an mpsc channel to bridge notify's sync callback to our async context
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<()>(16);

    // Shared flag to signal the watcher thread to stop
    let should_stop = Arc::new(AtomicBool::new(false));
    let stop_flag = should_stop.clone();

    // Create the watcher on a std thread (notify uses sync callbacks)
    let watch_path = project_path.clone();
    std::thread::spawn(move || {
        let tx = event_tx;
        let mut watcher =
            match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    // Only trigger on content-modifying events
                    match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                            // Check if any changed path is a watched file type
                            let dominated_change =
                                event.paths.iter().any(|p| should_trigger_reload(p));
                            if dominated_change {
                                // Non-blocking send — if the channel is full, skip (debounce handles it)
                                let _ = tx.try_send(());
                            }
                        }
                        _ => {}
                    }
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("[FileWatcher] Failed to create watcher: {}", e);
                    return;
                }
            };

        if let Err(e) = watcher.watch(&watch_path, RecursiveMode::Recursive) {
            tracing::error!("[FileWatcher] Failed to watch path: {}", e);
            return;
        }

        tracing::info!(
            "[FileWatcher] Watching {} for changes",
            watch_path.display()
        );

        // Keep the watcher alive until shutdown flag is set
        loop {
            std::thread::park_timeout(Duration::from_secs(1));
            if stop_flag.load(Ordering::Relaxed) {
                tracing::info!(
                    "[FileWatcher] Watcher thread exiting for {}",
                    watch_path.display()
                );
                break;
            }
        }
        // watcher is dropped here, cleaning up OS resources
    });

    // Spawn a tokio task to receive events and emit Tauri events with debouncing
    let label_clone = window_label.clone();
    tokio::spawn(async move {
        let mut last_emit = Instant::now() - Duration::from_secs(1); // Allow immediate first event

        loop {
            tokio::select! {
                Some(()) = event_rx.recv() => {
                    // Debounce: skip if too soon since last emit
                    let now = Instant::now();
                    if now.duration_since(last_emit) < Duration::from_millis(DEBOUNCE_MS) {
                        continue;
                    }

                    // Small delay to batch rapid consecutive changes
                    tokio::time::sleep(Duration::from_millis(100)).await;

                    // Drain any queued events that arrived during the delay
                    while event_rx.try_recv().is_ok() {}

                    last_emit = Instant::now();
                    tracing::debug!("[FileWatcher] Emitting static-file-changed for '{}'", label_clone);
                    let _ = app.emit(
                        "static-file-changed",
                        serde_json::json!({ "windowLabel": label_clone }),
                    );
                }
                _ = &mut shutdown_rx => {
                    tracing::info!("[FileWatcher] Shutting down for '{}'", label_clone);
                    should_stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    });

    shutdown_tx
}

/// Handle a single incoming TCP connection.
async fn handle_connection(stream: tokio::net::TcpStream, addr: SocketAddr, project_root: PathBuf) {
    let io = TokioIo::new(stream);

    let service = service_fn(move |req: Request<Incoming>| {
        let root = project_root.clone();
        async move { handle_request(req, &root).await }
    });

    if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
        tracing::debug!("[StaticServer] Connection error from {}: {}", addr, e);
    }
}

/// Handle a single HTTP request by serving the corresponding file.
async fn handle_request(
    req: Request<Incoming>,
    project_root: &Path,
) -> Result<Response<ServerBody>, hyper::Error> {
    // Strip query params and decode the path
    let uri_path = req.uri().path();

    // Decode percent-encoded characters
    let decoded_path = urlencoding::decode(uri_path).unwrap_or_else(|_| uri_path.into());

    // Resolve the file path with fallbacks
    match resolve_file_path(project_root, &decoded_path) {
        Some(file_path) => serve_file(&file_path).await,
        None => {
            // 404 - File not found
            let body = "<html><body><h1>404 - Not Found</h1></body></html>";
            Ok(Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Content-Type", "text/html; charset=utf-8")
                .body(full_body(Bytes::from(body)))
                .unwrap())
        }
    }
}

/// Resolve a URL path to a file on disk, trying fallbacks:
/// 1. Exact path (e.g., /styles.css -> styles.css)
/// 2. Path + ".html" (e.g., /about -> about.html)
/// 3. Path + "/index.html" (e.g., /docs -> docs/index.html)
/// 4. /index.html (for root path)
///
/// Returns None if no matching file exists or if path traversal is detected.
fn resolve_file_path(project_root: &Path, url_path: &str) -> Option<PathBuf> {
    // Normalize: strip leading slash, handle root
    let relative = url_path.trim_start_matches('/');

    // Build candidate paths
    let candidates: Vec<PathBuf> = if relative.is_empty() {
        // Root path -> try index.html
        vec![project_root.join("index.html")]
    } else {
        vec![
            // 1. Exact path
            project_root.join(relative),
            // 2. Path + ".html"
            project_root.join(format!("{relative}.html")),
            // 3. Path + "/index.html"
            project_root.join(relative).join("index.html"),
        ]
    };

    for candidate in candidates {
        if candidate.is_file() {
            // Security: prevent path traversal by verifying the resolved path
            // is within the project root
            if let Ok(canonical) = dunce::canonicalize(&candidate) {
                if canonical.starts_with(project_root) {
                    return Some(canonical);
                } else {
                    tracing::warn!(
                        "[StaticServer] Path traversal blocked: {} -> {}",
                        url_path,
                        canonical.display()
                    );
                }
            }
        }
    }

    None
}

/// Transient file-descriptor pressure: EMFILE (os error 24, this process's fd
/// budget) or ENFILE (os error 23, the system-wide open-file table). Both are
/// usually momentary — another process releases descriptors within
/// milliseconds — so a read that fails with them deserves a retry, not an
/// instant 500 (issue #575). The raw-code fallbacks are Unix-gated: on
/// Windows os errors 23/24 mean unrelated things.
fn is_fd_pressure(e: &std::io::Error) -> bool {
    let rendered = e.to_string();
    rendered.contains("Too many open files")
        || (cfg!(unix) && matches!(e.raw_os_error(), Some(23) | Some(24)))
}

/// Run `op`, retrying a couple of times with a short backoff when it fails
/// with transient fd pressure (see [`is_fd_pressure`]). Any other failure —
/// and fd pressure that survives every retry — is returned unchanged.
async fn with_fd_pressure_retry<T, F, Fut>(mut op: F) -> std::io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
{
    const ATTEMPTS: u64 = 3;
    for attempt in 1..=ATTEMPTS {
        match op().await {
            Err(e) if attempt < ATTEMPTS && is_fd_pressure(&e) => {
                tracing::warn!(
                    attempt,
                    error = %e,
                    "[StaticServer] read hit transient fd pressure (EMFILE/ENFILE); retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(75 * attempt)).await;
            }
            other => return other,
        }
    }
    unreachable!("loop returns on the final attempt")
}

/// Ceiling for a single static-asset read. `tokio::fs::read` pre-allocates
/// the whole buffer from the metadata length, so a bogus length — a cloud
/// placeholder (Dropbox/iCloud dataless file) or a corrupt directory entry —
/// makes the allocation itself fail with `ErrorKind::OutOfMemory` (issue
/// #697). No sane static preview asset approaches this; refuse up front with
/// a clear message instead of attempting the allocation.
const MAX_STATIC_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// True when a reported file length is beyond what the static server will
/// buffer into memory (see [`MAX_STATIC_FILE_BYTES`]).
fn exceeds_static_read_cap(len: u64) -> bool {
    len > MAX_STATIC_FILE_BYTES
}

/// Allocation failure while buffering the file. With no OS error attached
/// this is the pre-allocation from a bogus metadata length failing (issue
/// #697) — a file-metadata/environment condition, not a server bug.
fn is_allocation_failure(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::OutOfMemory
}

/// Read a file from disk and return it as an HTTP response with the correct MIME type.
async fn serve_file(file_path: &Path) -> Result<Response<ServerBody>, hyper::Error> {
    // Cap reads before allocating: a metadata length beyond the ceiling is
    // almost certainly bogus (cloud placeholder / corrupt entry) and would
    // otherwise fail as OutOfMemory inside tokio::fs::read (issue #697).
    // Metadata errors fall through — the read below reports them properly.
    if let Ok(meta) = tokio::fs::metadata(file_path).await {
        if exceeds_static_read_cap(meta.len()) {
            tracing::warn!(
                "[StaticServer] Refusing to serve {}: reported size {} bytes exceeds the {} MB static-asset ceiling (likely a cloud placeholder or corrupt metadata)",
                file_path.display(),
                meta.len(),
                MAX_STATIC_FILE_BYTES / (1024 * 1024)
            );
            let body = "<html><body><h1>413 - File Too Large</h1><p>This file reports a size beyond what the static preview will serve. If it lives in cloud storage (Dropbox/iCloud), make sure it is fully downloaded locally.</p></body></html>";
            return Ok(Response::builder()
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .header("Content-Type", "text/html; charset=utf-8")
                .body(full_body(Bytes::from(body)))
                .unwrap());
        }
    }

    match with_fd_pressure_retry(|| tokio::fs::read(file_path)).await {
        Ok(contents) => {
            let mime = file_path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(get_mime_type)
                .unwrap_or("application/octet-stream");

            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime)
                .header("Cache-Control", "no-cache, no-store, must-revalidate")
                .header("Access-Control-Allow-Origin", "*")
                .body(full_body(Bytes::from(contents)))
                .unwrap())
        }
        Err(e) => {
            // Log the raw os error code distinctly so fd-pressure failures
            // (23/24) are easy to filter from other read failures (#575).
            // Pressure that survived every retry is machine-wide fd
            // exhaustion — an environment condition, not a server bug — so
            // it logs at warn instead of auto-filing an error report.
            if is_fd_pressure(&e) {
                tracing::warn!(
                    "[StaticServer] Failed to read file {} after fd-pressure retries (os error {:?}): {}",
                    file_path.display(),
                    e.raw_os_error(),
                    e
                );
            } else if is_allocation_failure(&e) {
                // A read that still hits OutOfMemory (racing metadata change,
                // or genuine memory pressure) is a file-metadata/allocation
                // condition of the environment, not an app bug — warn, don't
                // auto-file a report (issue #697).
                tracing::warn!(
                    "[StaticServer] Failed to allocate for file {} (os error {:?}): {} — likely bogus metadata length (cloud placeholder / corrupt entry) or memory pressure",
                    file_path.display(),
                    e.raw_os_error(),
                    e
                );
            } else {
                tracing::error!(
                    "[StaticServer] Failed to read file {} (os error {:?}): {}",
                    file_path.display(),
                    e.raw_os_error(),
                    e
                );
            }
            let body = "<html><body><h1>500 - Internal Server Error</h1></body></html>";
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "text/html; charset=utf-8")
                .body(full_body(Bytes::from(body)))
                .unwrap())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ===== #575: fd-pressure classification + bounded read retry =====

    #[test]
    fn fd_pressure_matches_emfile_and_enfile_shapes() {
        // ENFILE — the reported #575 shape (system-wide table exhausted).
        assert!(is_fd_pressure(&std::io::Error::other(
            "Too many open files in system (os error 23)"
        )));
        // EMFILE — per-process budget exhausted.
        assert!(is_fd_pressure(&std::io::Error::other(
            "Too many open files (os error 24)"
        )));
        // Raw-code fallback for localized strerror text (Unix only).
        #[cfg(unix)]
        {
            assert!(is_fd_pressure(&std::io::Error::from_raw_os_error(23)));
            assert!(is_fd_pressure(&std::io::Error::from_raw_os_error(24)));
        }
    }

    #[test]
    fn fd_pressure_rejects_other_errors() {
        assert!(!is_fd_pressure(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "No such file or directory (os error 2)"
        )));
        assert!(!is_fd_pressure(&std::io::Error::other(
            "Operation not permitted (os error 1)"
        )));
    }

    #[tokio::test]
    async fn fd_retry_recovers_after_transient_pressure() {
        let calls = std::cell::Cell::new(0u32);
        let result = with_fd_pressure_retry(|| {
            calls.set(calls.get() + 1);
            let n = calls.get();
            async move {
                if n < 3 {
                    Err(std::io::Error::other(
                        "Too many open files in system (os error 23)",
                    ))
                } else {
                    Ok(vec![1u8, 2, 3])
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), vec![1, 2, 3]);
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn fd_retry_gives_up_after_bounded_attempts() {
        let calls = std::cell::Cell::new(0u32);
        let result: std::io::Result<Vec<u8>> = with_fd_pressure_retry(|| {
            calls.set(calls.get() + 1);
            async { Err(std::io::Error::other("Too many open files (os error 24)")) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.get(), 3, "must be bounded, not infinite");
    }

    #[tokio::test]
    async fn fd_retry_does_not_retry_other_errors() {
        let calls = std::cell::Cell::new(0u32);
        let result: std::io::Result<Vec<u8>> = with_fd_pressure_retry(|| {
            calls.set(calls.get() + 1);
            async {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "No such file or directory (os error 2)",
                ))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.get(), 1);
    }

    // ===== #697: size cap + OutOfMemory classification =====

    #[test]
    fn static_read_cap_refuses_bogus_lengths_and_passes_real_assets() {
        // Real static assets — even huge videos — sit under the ceiling.
        assert!(!exceeds_static_read_cap(0));
        assert!(!exceeds_static_read_cap(25 * 1024 * 1024));
        assert!(!exceeds_static_read_cap(MAX_STATIC_FILE_BYTES));
        // A cloud-placeholder / corrupt metadata length gets refused before
        // tokio::fs::read pre-allocates from it.
        assert!(exceeds_static_read_cap(MAX_STATIC_FILE_BYTES + 1));
        assert!(exceeds_static_read_cap(u64::MAX));
    }

    #[test]
    fn allocation_failure_is_classified_environmental() {
        // The #697 shape: ErrorKind::OutOfMemory with no OS error attached —
        // the pre-allocation from a bogus metadata length failing.
        assert!(is_allocation_failure(&std::io::Error::from(
            std::io::ErrorKind::OutOfMemory
        )));
        // Ordinary read failures keep the error-level path.
        assert!(!is_allocation_failure(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
        assert!(!is_allocation_failure(&std::io::Error::other(
            "Too many open files (os error 24)"
        )));
    }

    #[tokio::test]
    async fn serve_file_still_serves_ordinary_files() {
        // The new metadata pre-check must not break the normal path.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.html");
        fs::write(&path, "<html>ok</html>").unwrap();
        let resp = serve_file(&path).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[test]
    fn test_get_mime_type() {
        assert_eq!(get_mime_type("html"), "text/html; charset=utf-8");
        assert_eq!(get_mime_type("css"), "text/css; charset=utf-8");
        assert_eq!(get_mime_type("js"), "application/javascript; charset=utf-8");
        assert_eq!(get_mime_type("png"), "image/png");
        assert_eq!(get_mime_type("unknown"), "application/octet-stream");
        // Case insensitive
        assert_eq!(get_mime_type("HTML"), "text/html; charset=utf-8");
        assert_eq!(get_mime_type("CSS"), "text/css; charset=utf-8");
    }

    #[test]
    fn test_resolve_file_path_root() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("index.html"), "<html></html>").unwrap();

        let canonical_root = dunce::canonicalize(dir.path()).unwrap();
        let result = resolve_file_path(&canonical_root, "/");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("index.html"));
    }

    #[test]
    fn test_serves_from_public_when_root_has_no_html() {
        // Vercel-style layout: all site files under public/, nothing at root.
        let dir = TempDir::new().unwrap();
        let public = dir.path().join("public");
        fs::create_dir_all(&public).unwrap();
        fs::write(public.join("index.html"), "<html></html>").unwrap();
        fs::write(public.join("styles.css"), "body {}").unwrap();

        let serve_root = crate::commands::projects::static_site_dir(dir.path())
            .expect("public/ html must yield a serve root");
        let canonical = dunce::canonicalize(&serve_root).unwrap();
        let index = resolve_file_path(&canonical, "/").unwrap();
        assert!(index.ends_with("public/index.html"));
        let css = resolve_file_path(&canonical, "/styles.css").unwrap();
        assert!(css.ends_with("public/styles.css"));
    }

    #[test]
    fn test_resolve_file_path_exact() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("styles.css"), "body {}").unwrap();

        let canonical_root = dunce::canonicalize(dir.path()).unwrap();
        let result = resolve_file_path(&canonical_root, "/styles.css");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("styles.css"));
    }

    #[test]
    fn test_resolve_file_path_html_fallback() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("about.html"), "<html></html>").unwrap();

        let canonical_root = dunce::canonicalize(dir.path()).unwrap();
        let result = resolve_file_path(&canonical_root, "/about");
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("about.html"));
    }

    #[test]
    fn test_resolve_file_path_index_fallback() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("docs");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("index.html"), "<html></html>").unwrap();

        let canonical_root = dunce::canonicalize(dir.path()).unwrap();
        let result = resolve_file_path(&canonical_root, "/docs");
        assert!(result.is_some());
        let resolved = result.unwrap();
        assert!(resolved.ends_with("index.html"));
    }

    #[test]
    fn test_resolve_file_path_not_found() {
        let dir = TempDir::new().unwrap();

        let canonical_root = dunce::canonicalize(dir.path()).unwrap();
        let result = resolve_file_path(&canonical_root, "/nonexistent");
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_file_path_traversal_blocked() {
        let dir = TempDir::new().unwrap();
        // Create a file outside the project root
        let parent = dir.path().parent().unwrap();
        let outside_file = parent.join("outside.html");
        // Only test if we can create the file
        if fs::write(&outside_file, "outside").is_ok() {
            let canonical_root = dunce::canonicalize(dir.path()).unwrap();
            let result = resolve_file_path(&canonical_root, "/../outside.html");
            assert!(result.is_none());
            fs::remove_file(&outside_file).ok();
        }
    }
}
