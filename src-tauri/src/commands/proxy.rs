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
    project_path: String,
    target_port: u16,
) -> Result<u16, CommandError> {
    crate::proxy::start_preview_proxy(window_label, project_path, target_port)
        .await
        .map_err(CommandError::from)
}

/// Stop the preview proxy for one project in a window.
#[tauri::command]
#[tracing::instrument]
pub async fn stop_preview_proxy(
    window_label: String,
    project_path: String,
) -> Result<(), CommandError> {
    crate::proxy::stop_preview_proxy(&window_label, &project_path).await;
    Ok(())
}

/// Probe the dev server's root or a specified route for its real HTTP status.
///
/// The webview can't do this itself: a cross-origin fetch to localhost needs
/// `mode: 'no-cors'`, whose opaque response hides the status — so a wedged
/// server that answers 404 for every route still looks "ready" (issue #243).
/// Returns `None` when the server is unreachable or times out, `Some(status)`
/// otherwise. Uses `localhost` (not 127.0.0.1) so servers bound to either
/// stack are reached, and GET (not HEAD, which dev servers often reject).
#[tauri::command]
#[tracing::instrument]
pub async fn probe_preview_status(
    port: u16,
    timeout_ms: u64,
    path: Option<String>,
) -> Result<Option<u16>, CommandError> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| CommandError::Other {
            message: format!("probe client: {e}"),
        })?;

    let path = path.unwrap_or_else(|| "/".to_string());
    if !path.starts_with('/')
        || path.starts_with("//")
        || path
            .chars()
            .any(|character| matches!(character, '#' | '?' | '\\'))
        || path.chars().any(char::is_whitespace)
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: "Expected a safe absolute route path".to_string(),
        });
    }
    match client
        .get(format!("http://localhost:{port}{path}"))
        .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store")
        .send()
        .await
    {
        Ok(resp) => Ok(Some(resp.status().as_u16())),
        Err(_) => Ok(None),
    }
}
