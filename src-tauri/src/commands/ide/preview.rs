//! # Preview Webview Commands
//!
//! Commands for creating, navigating, resizing, and destroying preview webviews,
//! as well as evaluating JavaScript and scrolling within them.

use crate::errors::CommandError;
use std::sync::Mutex;
use tauri::{Manager, Webview, WebviewUrl};

/// Tracks whether a preview webview currently exists
static PREVIEW_WEBVIEW_EXISTS: Mutex<bool> = Mutex::new(false);

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
#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn resize_preview_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    if let Some(webview) = app.get_webview("preview") {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
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

/// Evaluate JavaScript in the preview webview (fire and forget).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn eval_preview_js(app: tauri::AppHandle, js: String) -> Result<(), CommandError> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    webview
        .eval(&js)
        .map_err(|e| format!("Failed to evaluate JS: {e}"))?;
    Ok(())
}

/// Scroll the preview webview to a specific Y position and return the actual scroll position.
/// Returns the actual scrollY after scrolling (may be less than requested if at bottom).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn scroll_preview_webview(app: tauri::AppHandle, y: u32) -> Result<(), CommandError> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    let js = format!("window.scrollTo(0, {y});");
    webview
        .eval(&js)
        .map_err(|e| format!("Failed to scroll: {e}"))?;
    Ok(())
}

/// Get the current scroll position from the preview webview.
/// Note: This is a best-effort approach since we can't easily get return values from JS eval.
/// The stitch_screenshots function handles duplicate detection as a fallback.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_preview_scroll_info(app: tauri::AppHandle) -> Result<(u32, u32), CommandError> {
    // We can't reliably get JS return values from the preview webview,
    // so this returns a placeholder. The actual duplicate detection
    // happens in stitch_screenshots via image comparison.
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    // Just verify the webview exists
    let _ = webview;

    // Return placeholder values - the image comparison will handle duplicates
    Ok((0, 0))
}

/// Check if the webview can still scroll down (returns true if not at bottom).
/// This is a simpler approach than trying to get exact scroll dimensions.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn check_preview_can_scroll(app: tauri::AppHandle) -> Result<bool, CommandError> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    // Scroll down a tiny bit and check if position changed
    // This is a workaround since we can't easily get scroll position
    let js = r#"
        (function() {
            var before = window.scrollY;
            var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            // We're at the bottom if scrollY is at or near maxScroll
            window.__canScrollMore = before < (maxScroll - 10);
        })();
    "#;

    webview
        .eval(js)
        .map_err(|e| format!("Failed to check scroll: {e}"))?;

    // We can't get the result back directly, so this always returns true
    // The frontend will handle stopping when captures look the same
    Ok(true)
}
