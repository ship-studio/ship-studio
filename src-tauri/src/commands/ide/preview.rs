//! # Preview Webview Commands
//!
//! Commands for creating, navigating, resizing, and destroying preview webviews,
//! as well as evaluating JavaScript and scrolling within them.

use crate::errors::CommandError;
use std::sync::Mutex;
use tauri::{Manager, Webview, WebviewUrl};

/// Tracks whether a preview webview currently exists
static PREVIEW_WEBVIEW_EXISTS: Mutex<bool> = Mutex::new(false);

/// Clamp a child-webview rect so it never extends past the window's inner
/// bounds. A child view is hard-clipped at the window edge, so an oversized or
/// offset rect (e.g. the Sanity plugin's stale title-bar offset on overlay-
/// titlebar windows) visibly chops off the bottom of the embedded content
/// (issue #337). Clamping instead lets the page reflow into the visible area.
fn clamp_to_window(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(size) = window.inner_size() {
        let logical: tauri::LogicalSize<f64> = size.to_logical(scale);
        let w = width.min((logical.width - x).max(0.0));
        let h = height.min((logical.height - y).max(0.0));
        return (w, h);
    }
    (width, height)
}

/// Scroll dimensions returned from a webview
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ScrollDimensions {
    pub scroll_height: u32,
    pub viewport_height: u32,
    pub sticky_header_height: u32,
}

/// Creates a native child webview at the specified position.
/// Used for Sanity Studio to support OAuth authentication.
/// Only one preview webview can exist at a time.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(app))]
pub async fn create_preview_webview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    let webview_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    // Access the underlying Window through the Webview
    let webview_ref: &Webview<tauri::Wry> = webview_window.as_ref();
    let window = webview_ref.window();

    // Check if webview already exists
    let mut exists = PREVIEW_WEBVIEW_EXISTS
        .lock()
        .map_err(|e| format!("Failed to acquire webview lock: {e}"))?;
    if *exists {
        // Just navigate the existing webview
        if let Some(webview) = app.get_webview("preview") {
            let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
            webview.navigate(parsed_url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Create the preview webview
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new("preview", WebviewUrl::External(parsed_url))
        .auto_resize();

    let (width, height) = clamp_to_window(&window, x, y, width, height);
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {e}"))?;

    *exists = true;
    Ok(())
}

#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(app))]
pub async fn navigate_preview_webview(
    app: tauri::AppHandle,
    url: String,
) -> Result<(), CommandError> {
    if let Some(webview) = app.get_webview("preview") {
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(app))]
pub async fn resize_preview_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    if let Some(webview) = app.get_webview("preview") {
        let (width, height) = clamp_to_window(&webview.window(), x, y, width, height);
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(app))]
pub async fn destroy_preview_webview(app: tauri::AppHandle) -> Result<(), CommandError> {
    let mut exists = PREVIEW_WEBVIEW_EXISTS
        .lock()
        .map_err(|e| format!("Failed to acquire webview lock: {e}"))?;
    if let Some(webview) = app.get_webview("preview") {
        webview.close().map_err(|e| e.to_string())?;
        *exists = false;
    }
    Ok(())
}
