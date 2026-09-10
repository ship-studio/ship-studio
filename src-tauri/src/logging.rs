//! # Logging Infrastructure
//!
//! Structured logging using the `tracing` ecosystem.
//! Logs are written to daily rotating files in the app's log directory.

use ship_studio_macros::ship_command;
use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    fmt::{self},
    layer::SubscriberExt,
    util::SubscriberInitExt,
    EnvFilter,
};

// Hold the guard to keep the non-blocking writer alive
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

pub(crate) fn scrub_string(s: &str) -> String {
    // Strip local paths before they reach local support logs.
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

/// Get the log directory path
fn get_log_dir() -> PathBuf {
    // Use platform-specific log directories
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Logs/Harbr"))
            .unwrap_or_else(|| PathBuf::from("/tmp/harbr-logs"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("Harbr/logs"))
            .unwrap_or_else(|| PathBuf::from("C:/temp/harbr-logs"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("harbr/logs"))
            .unwrap_or_else(|| PathBuf::from("/tmp/harbr-logs"))
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

    // File logging is best-effort: a full disk (or a log directory we can't
    // create or open) must not take the whole app down at startup. Both the
    // directory creation and the appender build used to abort — the appender
    // via `rolling::daily`'s internal panic — leaving the user with a crash
    // instead of a running app (issue #827). Fall back to console-only logging.
    let file_writer = match std::fs::create_dir_all(&log_dir).and_then(|()| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("harbr.log")
            // Uncapped rotation was an unbounded-disk-growth bug: daily files
            // were never deleted, so the log directory grew forever (measured
            // at ~45MB/day per running instance before the span-close noise
            // cut below). Two weeks is generous for support/debugging and
            // now costs single-digit MB/day per file after that cut.
            .max_log_files(14)
            .build(&log_dir)
            .map_err(std::io::Error::other)
    }) {
        Ok(appender) => {
            let (non_blocking, guard) = tracing_appender::non_blocking(appender);
            // Store the guard to keep the writer alive
            LOG_GUARD
                .set(guard)
                .map_err(|_| "Logging already initialized")?;
            Some(non_blocking)
        }
        Err(e) => {
            eprintln!("Harbr: file logging disabled ({}): {e}", log_dir.display());
            None
        }
    };

    // Create the file layer with JSON formatting. `Option<Layer>` is itself a
    // layer, so the disabled case is a no-op rather than a separate build path.
    //
    // No `with_span_events(FmtSpan::CLOSE)` here (deliberately — it used to be
    // on). Every `#[tracing::instrument]`'d command emits one INFO-level
    // "close" record per call with a busy/idle duration, and on a real
    // release-build log this was measured at 91.5% of all lines and 90.2% of
    // all bytes (112,417 of 122,916 lines; ~41MB of a 45MB daily file) —
    // almost entirely microsecond-scale entries like
    // `get_dashboard_projects`/`list_accounts`/`snapshot_status` that nobody
    // reads. Turning it off removes that volume without touching a single
    // `info!`/`warn!`/`error!` call site: those keep firing at their own
    // level with the same span context (the span's fields still populate the
    // "span" object on every event via `with_current_span` below) because
    // this only stops the *synthetic* close record, not span creation. The
    // actual diagnostic signal — ~10.5k lines/day of real messages — is
    // unaffected.
    let file_layer = file_writer.map(|writer| {
        fmt::layer()
            .json()
            .with_writer(writer)
            .with_current_span(true)
            .with_target(true)
            .with_file(true)
            .with_line_number(true)
    });

    // Create environment filter
    // Default to info level, can be overridden with RUST_LOG env var
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("ship_studio_lib=info,warn"));

    // Build the subscriber
    let subscriber = tracing_subscriber::registry().with(filter).with(file_layer);

    // In debug builds, also log to console
    #[cfg(debug_assertions)]
    let subscriber = subscriber.with(fmt::layer().with_target(true).with_level(true).compact());

    subscriber.init();

    tracing::info!(
        log_dir = %log_dir.display(),
        version = env!("CARGO_PKG_VERSION"),
        "Harbr logging initialized"
    );

    Ok(())
}

/// Logging for the self-hosted server binary.
///
/// Deliberately *not* [`init_logging`]: that one writes a rotating JSON file to
/// a desktop log directory and only mirrors to the console in debug builds.
/// Both are wrong in a container — the log directory is ephemeral and a release
/// build would emit nothing at all. A server logs to stdout and lets whatever
/// supervises it (Docker, systemd) do the collecting.
#[cfg(feature = "web")]
pub fn init_server_logging() -> Result<(), String> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("ship_studio_lib=info,warn"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_level(true).compact())
        .try_init()
        .map_err(|e| format!("Failed to initialize logging: {e}"))
}

/// Get the current log file path (for debugging/support)
#[ship_command]
pub fn get_log_path() -> String {
    get_log_dir().to_string_lossy().to_string()
}

/// Log a message from the frontend
#[ship_command]
pub fn log_frontend_event(level: String, message: String, context: Option<serde_json::Value>) {
    let ctx = context.map(|c| c.to_string()).unwrap_or_default();

    match level.as_str() {
        "error" => tracing::error!(source = "frontend", context = %ctx, "{}", message),
        "warn" => tracing::warn!(source = "frontend", context = %ctx, "{}", message),
        "debug" => tracing::debug!(source = "frontend", context = %ctx, "{}", message),
        _ => tracing::info!(source = "frontend", context = %ctx, "{}", message),
    }
}
