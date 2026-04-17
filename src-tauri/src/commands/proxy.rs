//! # Preview Proxy Commands
//!
//! Tauri command wrappers for the preview reverse proxy.
//! The proxy injects a navigation tracking script into HTML responses
//! so the frontend can detect when the user navigates within the preview iframe.

/// Start a reverse proxy for the preview iframe.
/// Returns the proxy's listening port.
use crate::errors::CommandError;

#[tauri::command]
#[tracing::instrument]
pub async fn start_preview_proxy(
    window_label: String,
    target_port: u16,
) -> Result<u16, CommandError> {
    crate::proxy::start_preview_proxy(window_label, target_port)
        .await
        .map_err(CommandError::from)
}

/// Stop the preview proxy for the given window.
#[tauri::command]
#[tracing::instrument]
pub fn stop_preview_proxy(window_label: String) -> Result<(), CommandError> {
    crate::proxy::stop_preview_proxy(&window_label);
    Ok(())
}
