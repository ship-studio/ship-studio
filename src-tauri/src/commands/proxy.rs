//! # Preview Proxy Commands
//!
//! Tauri command wrappers for the preview reverse proxy.
//! The proxy injects a navigation tracking script into HTML responses
//! so the frontend can detect when the user navigates within the preview iframe.

/// Start a reverse proxy for the preview iframe.
/// Returns the proxy's listening port.
use crate::errors::CommandError;
use ship_studio_macros::ship_command;

#[ship_command]
#[tracing::instrument]
pub async fn start_preview_proxy(
    window_label: String,
    target_port: u16,
) -> Result<u16, CommandError> {
    crate::proxy::start_preview_proxy(window_label, target_port)
        .await
        .map_err(CommandError::from)
}

/// Report whether the dev server on `port` is accepting connections.
///
/// The frontend's own readiness probe is a `fetch` from the page, which only
/// works when the browser can reach the dev server directly — true on the
/// desktop app (everything is localhost), false for a remote browser, where the
/// dev server listens on a loopback port the client cannot dial and a TLS page
/// would refuse the plain-http request as mixed content anyway. Probing from
/// the backend puts the check on the machine that actually owns the port.
///
/// A TCP connect is deliberately all this does: an HTTP request would block for
/// the length of an on-demand route compile, which is exactly the state the
/// caller is waiting *through*, not an error.
#[ship_command]
#[tracing::instrument]
pub async fn probe_dev_server(port: u16) -> Result<bool, CommandError> {
    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
    let connect = tokio::net::TcpStream::connect(("127.0.0.1", port));
    Ok(matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, connect).await,
        Ok(Ok(_))
    ))
}

/// Stop the preview proxy for the given window.
#[ship_command]
#[tracing::instrument]
pub fn stop_preview_proxy(window_label: String) -> Result<(), CommandError> {
    crate::proxy::stop_preview_proxy(&window_label);
    Ok(())
}

/// Probe the dev server's root and return its real HTTP status code.
///
/// The webview can't do this itself: a cross-origin fetch to localhost needs
/// `mode: 'no-cors'`, whose opaque response hides the status — so a wedged
/// server that answers 404 for every route still looks "ready" (issue #243).
/// Returns `None` when the server is unreachable or times out, `Some(status)`
/// otherwise. Uses `localhost` (not 127.0.0.1) so servers bound to either
/// stack are reached, and GET (not HEAD, which dev servers often reject).
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn probe_preview_status(port: u16, timeout_ms: u64) -> Result<Option<u16>, CommandError> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| CommandError::Other {
            message: format!("probe client: {e}"),
        })?;

    match client.get(format!("http://localhost:{port}/")).send().await {
        Ok(resp) => Ok(Some(resp.status().as_u16())),
        Err(_) => Ok(None),
    }
}
