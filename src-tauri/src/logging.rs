//! # Logging Infrastructure
//!
//! Structured logging using the `tracing` ecosystem.
//! Logs are written to daily rotating files in the app's log directory.

use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    fmt::{self, format::FmtSpan},
    layer::SubscriberExt,
    util::SubscriberInitExt,
    EnvFilter,
};

// Hold the guard to keep the non-blocking writer alive
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

// Hold the Sentry guard for the lifetime of the process so events get flushed on exit.
static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();

const SENTRY_DSN: &str =
    "https://ca46a435b1b22d7b60f2a83817395fb6@o4511226863353856.ingest.us.sentry.io/4511226875412480";

/// Initialize Sentry. Must be called before `init_logging()` so the
/// `sentry_tracing` layer can forward events. Skipped in debug builds unless
/// the `SENTRY_FORCE=1` env var is set.
pub fn init_sentry() {
    let force = std::env::var("SENTRY_FORCE").ok().as_deref() == Some("1");
    let enabled = !cfg!(debug_assertions) || force;
    if !enabled {
        return;
    }

    let environment = if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    };

    let guard = sentry::init((
        SENTRY_DSN,
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            environment: Some(environment.into()),
            send_default_pii: false,
            before_send: Some(std::sync::Arc::new(|mut event| {
                scrub_event(&mut event);
                Some(event)
            })),
            before_breadcrumb: Some(std::sync::Arc::new(|mut breadcrumb| {
                if let Some(msg) = breadcrumb.message.as_mut() {
                    *msg = scrub_string(msg);
                }
                Some(breadcrumb)
            })),
            ..Default::default()
        },
    ));
    let _ = SENTRY_GUARD.set(guard);
}

fn scrub_string(s: &str) -> String {
    // Strip local paths so Sentry doesn't see usernames or project folder names.
    let re_unix = regex_lite_replace(s, "/Users/", "/Users/<redacted>");
    let re_home = regex_lite_replace(&re_unix, "/home/", "/home/<redacted>");
    regex_lite_replace(&re_home, "C:\\Users\\", "C:\\Users\\<redacted>")
}

fn regex_lite_replace(input: &str, prefix: &str, replacement: &str) -> String {
    // Replace `<prefix><username>` with `<replacement>` where username runs until
    // the next path separator or whitespace. Avoids a full regex crate dependency.
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(replacement);
        let after = &rest[idx + prefix.len()..];
        let end = after
            .find(|c: char| c == '/' || c == '\\' || c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    if let Some(msg) = event.message.as_mut() {
        *msg = scrub_string(msg);
    }
    for exception in event.exception.values.iter_mut() {
        if let Some(value) = exception.value.as_mut() {
            *value = scrub_string(value);
        }
    }
    for breadcrumb in event.breadcrumbs.values.iter_mut() {
        if let Some(msg) = breadcrumb.message.as_mut() {
            *msg = scrub_string(msg);
        }
    }
}

/// Get the log directory path
fn get_log_dir() -> PathBuf {
    // Use platform-specific log directories
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Logs/ShipStudio"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-logs"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ShipStudio/logs"))
            .unwrap_or_else(|| PathBuf::from("C:/temp/ship-studio-logs"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ship-studio/logs"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-logs"))
    }
}

/// Initialize the logging system
///
/// Sets up:
/// - Daily rotating log files
/// - JSON formatted logs for easy parsing
/// - Console output in debug builds
/// - Environment-based log level filtering
pub fn init_logging() -> Result<(), String> {
    let log_dir = get_log_dir();

    // Create log directory if it doesn't exist
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {e}"))?;

    // Set up file appender with daily rotation
    let file_appender = tracing_appender::rolling::daily(&log_dir, "ship-studio.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Store the guard to keep the writer alive
    LOG_GUARD
        .set(guard)
        .map_err(|_| "Logging already initialized")?;

    // Create the file layer with JSON formatting
    let file_layer = fmt::layer()
        .json()
        .with_writer(non_blocking)
        .with_span_events(FmtSpan::CLOSE)
        .with_current_span(true)
        .with_target(true)
        .with_file(true)
        .with_line_number(true);

    // Create environment filter
    // Default to info level, can be overridden with RUST_LOG env var
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("ship_studio_lib=info,warn"));

    // Build the subscriber
    let subscriber = tracing_subscriber::registry().with(filter).with(file_layer);

    // In debug builds, also log to console
    #[cfg(debug_assertions)]
    let subscriber = subscriber.with(fmt::layer().with_target(true).with_level(true).compact());

    // Forward tracing events to Sentry. The layer is a no-op if Sentry wasn't
    // initialized (e.g. debug builds without SENTRY_FORCE=1), so it's safe to
    // attach unconditionally.
    let subscriber = subscriber.with(sentry_tracing::layer());

    subscriber.init();

    tracing::info!(
        log_dir = %log_dir.display(),
        version = env!("CARGO_PKG_VERSION"),
        "Ship Studio logging initialized"
    );

    Ok(())
}

/// Get the current log file path (for debugging/support)
#[tauri::command]
pub fn get_log_path() -> String {
    get_log_dir().to_string_lossy().to_string()
}

/// Log a message from the frontend
#[tauri::command]
pub fn log_frontend_event(level: String, message: String, context: Option<serde_json::Value>) {
    let ctx = context.map(|c| c.to_string()).unwrap_or_default();

    match level.as_str() {
        "error" => tracing::error!(source = "frontend", context = %ctx, "{}", message),
        "warn" => tracing::warn!(source = "frontend", context = %ctx, "{}", message),
        "debug" => tracing::debug!(source = "frontend", context = %ctx, "{}", message),
        _ => tracing::info!(source = "frontend", context = %ctx, "{}", message),
    }
}
