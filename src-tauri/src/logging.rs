//! # Logging Infrastructure
//!
//! Structured logging using the `tracing` ecosystem.
//! Logs are written to daily rotating files in the app's log directory.

use once_cell::sync::OnceCell;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    fmt::{self, format::FmtSpan},
    layer::SubscriberExt,
    util::SubscriberInitExt,
    EnvFilter,
};

// Hold the guard to keep the non-blocking writer alive
static LOG_GUARD: OnceCell<WorkerGuard> = OnceCell::new();

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
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

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
