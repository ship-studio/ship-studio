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
    target_tls: Option<bool>,
) -> Result<u16, CommandError> {
    crate::proxy::start_preview_proxy(window_label, target_port, target_tls.unwrap_or(false))
        .await
        .map_err(CommandError::from)
}

/// Probe a local dev server over HTTPS, accepting self-signed certificates.
///
/// The webview's fetch cannot probe an HTTPS dev server whose certificate the
/// system does not trust (e.g. HubSpot's mkcert-signed hslocal server before
/// its CA is installed), so TLS-upstream previews probe through here instead.
#[tauri::command]
#[tracing::instrument]
pub async fn probe_dev_server(port: u16, timeout_ms: Option<u64>) -> bool {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(5_000).clamp(500, 60_000));
    let Ok(client) = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .build()
    else {
        return false;
    };
    client
        .get(format!("https://localhost:{port}/"))
        .send()
        .await
        .is_ok()
}

/// Stop the preview proxy for the given window.
#[tauri::command]
#[tracing::instrument]
pub fn stop_preview_proxy(window_label: String) -> Result<(), CommandError> {
    crate::proxy::stop_preview_proxy(&window_label);
    Ok(())
}
