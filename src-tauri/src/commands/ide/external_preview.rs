//! Isolated external-site child webview used by the in-app browser preview.
//!
//! This webview has no application bridge, uses a non-persistent data store,
//! and is scoped to the invoking parent window.

use crate::errors::CommandError;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{Manager, Webview, WebviewUrl, Wry};
use url::Url;

static PREVIEW_OWNERS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn child_label(parent: &str) -> String {
    format!("external-preview-{parent}")
}

fn preview_url(
    raw: &str,
    blocked_origin: Option<(String, String, u16)>,
) -> Result<Url, CommandError> {
    let parsed = Url::parse(raw)
        .map_err(|_| CommandError::expected("Enter a valid website URL to preview."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::expected(
            "The embedded browser only supports HTTP and HTTPS pages.",
        ));
    }
    if is_application_origin(&parsed, blocked_origin) {
        return Err(CommandError::expected(
            "Ship Studio application pages cannot be opened in the external preview.",
        ));
    }
    Ok(parsed)
}

fn is_application_origin(url: &Url, app_origin: Option<(String, String, u16)>) -> bool {
    if url.host_str() == Some("tauri.localhost") {
        return true;
    }
    let Some(raw_host) = url.host_str() else {
        return false;
    };
    let host = raw_host.trim_start_matches('[').trim_end_matches(']');
    let origin_matches = app_origin.is_some_and(|(scheme, app_host, port)| {
        let app_host = app_host.trim_start_matches('[').trim_end_matches(']');
        let is_loopback = matches!(app_host, "localhost" | "127.0.0.1" | "::1");
        url.scheme() == scheme
            && url.port_or_known_default() == Some(port)
            && (host == app_host
                || (is_loopback && matches!(host, "localhost" | "127.0.0.1" | "::1")))
    });
    if origin_matches {
        return true;
    }
    if !cfg!(debug_assertions) {
        return false;
    }
    if !matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return false;
    }
    let app_port = std::env::var("SHIPSTUDIO_DEV_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(1420);
    url.scheme() == "http"
        && url.port_or_known_default() == Some(app_port)
        && matches!(
            host,
            "localhost" | "127.0.0.1" | "::1" | "localhost.localdomain"
        )
}

fn child_for<'a>(app: &'a tauri::AppHandle, parent: &Webview<Wry>) -> Option<tauri::Webview<Wry>> {
    app.get_webview(&child_label(parent.window().label()))
}

fn parent_label(parent: &Webview<Wry>) -> Result<String, CommandError> {
    let label = parent.window().label().to_string();
    let invoking_label = parent.label();
    let allowed = label == "main"
        || ["project-", "window-"].iter().any(|prefix| {
            label.strip_prefix(prefix).is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            })
        });
    if invoking_label != label || !allowed {
        return Err(CommandError::expected(
            "The external preview can only be opened from a Ship Studio project window.",
        ));
    }
    Ok(label)
}

fn app_origin(parent: &Webview<Wry>) -> Option<(String, String, u16)> {
    let url = parent.url().ok()?;
    Some((
        url.scheme().to_string(),
        url.host_str()?.to_string(),
        url.port_or_known_default()?,
    ))
}

fn clamp_to_parent(
    parent: &tauri::Window<Wry>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let scale = parent.scale_factor().unwrap_or(1.0);
    if let Ok(size) = parent.inner_size() {
        let logical: tauri::LogicalSize<f64> = size.to_logical(scale);
        return (
            (width).min((logical.width - x).max(0.0)),
            height.min((logical.height - y).max(0.0)),
        );
    }
    (width, height)
}

fn owns_preview(parent: &str, owner_id: &str) -> bool {
    PREVIEW_OWNERS
        .lock()
        .ok()
        .and_then(|owners| owners.get(parent).map(|current| current == owner_id))
        .unwrap_or(false)
}

/// Create or update the isolated external preview child webview.
#[tauri::command]
#[tracing::instrument(skip(app, invoking_webview))]
pub async fn create_external_preview_webview(
    app: tauri::AppHandle,
    invoking_webview: Webview<Wry>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    owner_id: String,
) -> Result<(), CommandError> {
    let parent_name = parent_label(&invoking_webview)?;
    let blocked_origin = app_origin(&invoking_webview);
    let parsed = preview_url(&url, blocked_origin.clone())?;
    PREVIEW_OWNERS
        .lock()
        .map_err(|_| CommandError::expected("Could not acquire the preview owner lock."))?
        .insert(parent_name.clone(), owner_id);
    let parent = invoking_webview.window();
    let (width, height) = clamp_to_parent(&parent, x, y, width, height);
    if let Some(child) = child_for(&app, &invoking_webview) {
        child.navigate(parsed).map_err(|error| {
            CommandError::expected(format!("Could not navigate the preview: {error}"))
        })?;
        child
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|error| {
                CommandError::expected(format!("Could not position the preview: {error}"))
            })?;
        child
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|error| {
                CommandError::expected(format!("Could not resize the preview: {error}"))
            })?;
        child.show().map_err(|error| {
            CommandError::expected(format!("Could not show the preview: {error}"))
        })?;
        return Ok(());
    }
    let parent_window = parent;
    let builder = tauri::webview::WebviewBuilder::new(
        child_label(invoking_webview.window().label()),
        WebviewUrl::External(parsed),
    )
    .incognito(true)
    .on_navigation(move |url| {
        matches!(url.scheme(), "http" | "https")
            && !is_application_origin(url, blocked_origin.clone())
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    parent_window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|error| {
            CommandError::expected(format!("Could not create the isolated preview: {error}"))
        })?;
    Ok(())
}

/// Navigate the invoking window's external preview after validating the URL.
#[tauri::command]
#[tracing::instrument(skip(app, invoking_webview))]
pub async fn navigate_external_preview_webview(
    app: tauri::AppHandle,
    invoking_webview: Webview<Wry>,
    url: String,
    owner_id: String,
) -> Result<(), CommandError> {
    let parent_name = parent_label(&invoking_webview)?;
    if !owns_preview(&parent_name, &owner_id) {
        return Ok(());
    }
    let parsed = preview_url(&url, app_origin(&invoking_webview))?;
    if let Some(child) = child_for(&app, &invoking_webview) {
        child.navigate(parsed).map_err(|error| {
            CommandError::expected(format!("Could not navigate the preview: {error}"))
        })?;
    }
    Ok(())
}

/// Resize and reposition the invoking window's external preview.
#[tauri::command]
#[tracing::instrument(skip(app, invoking_webview))]
pub async fn resize_external_preview_webview(
    app: tauri::AppHandle,
    invoking_webview: Webview<Wry>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    owner_id: String,
) -> Result<(), CommandError> {
    let parent_name = parent_label(&invoking_webview)?;
    if !owns_preview(&parent_name, &owner_id) {
        return Ok(());
    }
    if let Some(child) = child_for(&app, &invoking_webview) {
        let (width, height) = clamp_to_parent(&child.window(), x, y, width, height);
        child
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|error| {
                CommandError::expected(format!("Could not position the preview: {error}"))
            })?;
        child
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|error| {
                CommandError::expected(format!("Could not resize the preview: {error}"))
            })?;
    }
    Ok(())
}

/// Show or hide the invoking window's external preview without ending its session.
#[tauri::command]
#[tracing::instrument(skip(app, invoking_webview))]
pub async fn set_external_preview_webview_visible(
    app: tauri::AppHandle,
    invoking_webview: Webview<Wry>,
    visible: bool,
    owner_id: String,
) -> Result<(), CommandError> {
    let parent_name = parent_label(&invoking_webview)?;
    if !owns_preview(&parent_name, &owner_id) {
        return Ok(());
    }
    if let Some(child) = child_for(&app, &invoking_webview) {
        let result = if visible { child.show() } else { child.hide() };
        result.map_err(|error| {
            CommandError::expected(format!("Could not update preview visibility: {error}"))
        })?;
    }
    Ok(())
}

/// Destroy the invoking window's external preview and its ephemeral store.
#[tauri::command]
#[tracing::instrument(skip(app, invoking_webview))]
pub async fn destroy_external_preview_webview(
    app: tauri::AppHandle,
    invoking_webview: Webview<Wry>,
    owner_id: String,
) -> Result<(), CommandError> {
    let parent_name = parent_label(&invoking_webview)?;
    if !owns_preview(&parent_name, &owner_id) {
        return Ok(());
    }
    if let Some(child) = child_for(&app, &invoking_webview) {
        child.close().map_err(|error| {
            CommandError::expected(format!("Could not close the preview: {error}"))
        })?;
    }
    if let Ok(mut owners) = PREVIEW_OWNERS.lock() {
        owners.remove(&parent_name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_preview_rejects_privileged_and_non_http_urls() {
        for raw in [
            "tauri://localhost/index.html",
            "https://tauri.localhost/index.html",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(
                preview_url(raw, None).is_err(),
                "unexpectedly allowed {raw}"
            );
        }
    }

    #[test]
    fn external_preview_blocks_calling_app_origin_and_loopback_aliases() {
        let app_origin = Some(("http".into(), "127.0.0.1".into(), 1440));
        for raw in [
            "http://127.0.0.1:1440/index.html",
            "http://localhost:1440/index.html",
            "http://[::1]:1440/index.html",
        ] {
            let parsed = Url::parse(raw).expect("valid URL");
            assert!(
                is_application_origin(&parsed, app_origin.clone()),
                "unexpectedly allowed {raw}"
            );
        }
        assert!(preview_url("http://localhost:5173/", app_origin).is_ok());
    }

    #[test]
    fn preview_ownership_ignores_stale_tokens() {
        let parent = format!("test-parent-{}", uuid::Uuid::new_v4());
        PREVIEW_OWNERS
            .lock()
            .unwrap()
            .insert(parent.clone(), "new".into());
        assert!(!owns_preview(&parent, "old"));
        assert!(owns_preview(&parent, "new"));
        PREVIEW_OWNERS.lock().unwrap().remove(&parent);
    }
}
