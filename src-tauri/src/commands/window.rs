//! # Window Management Commands
//!
//! Commands for handling window state, compact mode, and window positioning.
//! Compact mode uses responsive CSS - this module handles window resizing and always-on-top.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::types::{CompactModePreferences, WindowPosition};
use tauri::{LogicalPosition, LogicalSize, Window};

/// Pins the native macOS window controls inside Ship Studio's 46pt custom
/// titlebar. Persistent Auto Layout constraints are required here: AppKit and
/// Wry both lay out the titlebar during live resize, so one-off frame changes
/// visibly alternate with the system position.
#[cfg(target_os = "macos")]
pub fn center_macos_traffic_lights(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let ns_window = window.ns_window()? as usize;
    window.run_on_main_thread(move || unsafe {
        constrain_macos_traffic_lights(ns_window as *mut objc2::runtime::AnyObject);
    })
}

#[cfg(target_os = "macos")]
unsafe fn constrain_macos_traffic_lights(ns_window: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2_foundation::CGRect;

    const TRAFFIC_LIGHT_INSET: f64 = 16.0;

    let close_button: *mut objc2::runtime::AnyObject =
        msg_send![ns_window, standardWindowButton: 0usize];
    if close_button.is_null() {
        return;
    }
    let close_frame: CGRect = msg_send![close_button, frame];
    let miniaturize_button: *mut objc2::runtime::AnyObject =
        msg_send![ns_window, standardWindowButton: 1usize];
    if miniaturize_button.is_null() {
        return;
    }
    let miniaturize_frame: CGRect = msg_send![miniaturize_button, frame];
    let button_spacing = miniaturize_frame.origin.x - close_frame.origin.x;

    let titlebar_view: *mut objc2::runtime::AnyObject = msg_send![close_button, superview];
    if titlebar_view.is_null() {
        return;
    }
    let titlebar_container: *mut objc2::runtime::AnyObject = msg_send![titlebar_view, superview];
    if titlebar_container.is_null() {
        return;
    }
    let container_leading_anchor: *mut objc2::runtime::AnyObject =
        msg_send![titlebar_container, leadingAnchor];
    let container_top_anchor: *mut objc2::runtime::AnyObject =
        msg_send![titlebar_container, topAnchor];

    // NSWindowButton: close = 0, miniaturize = 1, zoom = 2.
    for button_kind in 0usize..=2 {
        let button: *mut objc2::runtime::AnyObject =
            msg_send![ns_window, standardWindowButton: button_kind];
        if button.is_null() {
            continue;
        }

        let _: () = msg_send![button, setTranslatesAutoresizingMaskIntoConstraints: false];
        let leading_anchor: *mut objc2::runtime::AnyObject = msg_send![button, leadingAnchor];
        let top_anchor: *mut objc2::runtime::AnyObject = msg_send![button, topAnchor];
        let leading = TRAFFIC_LIGHT_INSET + button_kind as f64 * button_spacing;
        let leading_constraint: *mut objc2::runtime::AnyObject = msg_send![leading_anchor, constraintEqualToAnchor: container_leading_anchor constant: leading];
        let top_constraint: *mut objc2::runtime::AnyObject = msg_send![top_anchor, constraintEqualToAnchor: container_top_anchor constant: TRAFFIC_LIGHT_INSET];
        let _: () = msg_send![leading_constraint, setActive: true];
        let _: () = msg_send![top_constraint, setActive: true];
    }

    let _: () = msg_send![titlebar_container, layoutSubtreeIfNeeded];
}

/// Compact mode dimensions
const COMPACT_WIDTH: f64 = 450.0;
const COMPACT_HEIGHT_DEFAULT: f64 = 600.0;

/// Default full mode dimensions
const FULL_MODE_WIDTH: f64 = 1200.0;
const FULL_MODE_HEIGHT: f64 = 800.0;

/// Enter compact mode - resize window and enable always-on-top
/// The UI adapts via responsive CSS based on window width
#[tauri::command]
#[tracing::instrument]
pub async fn enter_compact_mode(window: Window) -> Result<(), CommandError> {
    tracing::info!("Entering compact mode");

    // Set always-on-top so window floats above browser
    window
        .set_always_on_top(true)
        .map_err(|e| format!("Failed to set always on top: {e}"))?;

    // Resize to compact dimensions
    window
        .set_size(LogicalSize::new(COMPACT_WIDTH, COMPACT_HEIGHT_DEFAULT))
        .map_err(|e| format!("Failed to set window size: {e}"))?;

    // Always re-center on entry. A previously saved position tends to
    // drift to the corner (either stale from a pre-resize save, or because
    // macOS clamps a position that no longer fits the new size). Centering
    // on every entry is predictable; the user can drag afterward.
    window
        .center()
        .map_err(|e| format!("Failed to center window: {e}"))?;

    // Focus and bring to front
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    tracing::info!("Compact mode entered successfully");
    Ok(())
}

/// Exit compact mode - restore window to full size
#[tauri::command]
#[tracing::instrument]
pub async fn exit_compact_mode(window: Window) -> Result<(), CommandError> {
    tracing::info!("Exiting compact mode");

    // Save current position before exiting
    if let Ok(position) = window.outer_position() {
        let _ = save_compact_position_internal(position.x, position.y);
    }

    // Disable always-on-top
    window
        .set_always_on_top(false)
        .map_err(|e| format!("Failed to disable always on top: {e}"))?;

    // Restore full size
    window
        .set_size(LogicalSize::new(FULL_MODE_WIDTH, FULL_MODE_HEIGHT))
        .map_err(|e| format!("Failed to set window size: {e}"))?;

    // Center window on screen
    window
        .center()
        .map_err(|e| format!("Failed to center window: {e}"))?;

    tracing::info!("Compact mode exited successfully");
    Ok(())
}

/// Toggle always-on-top state for the window
#[tauri::command]
#[tracing::instrument]
pub async fn set_always_on_top(window: Window, enabled: bool) -> Result<(), CommandError> {
    tracing::info!("Setting always on top: {}", enabled);

    window
        .set_always_on_top(enabled)
        .map_err(|e| format!("Failed to set always on top: {e}"))?;

    // Persist the preference
    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.always_on_top = enabled;
    write_app_state(&state)?;

    Ok(())
}

/// Save compact mode window position
#[tauri::command]
#[tracing::instrument]
pub async fn save_compact_position(x: i32, y: i32) -> Result<(), CommandError> {
    save_compact_position_internal(x, y)
}

/// Internal helper to save position (used by both command and exit_compact_mode)
fn save_compact_position_internal(x: i32, y: i32) -> Result<(), CommandError> {
    tracing::debug!("Saving compact position: ({}, {})", x, y);

    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.position = Some(WindowPosition { x, y });
    write_app_state(&state)?;

    Ok(())
}

/// Get current compact mode preferences
#[tauri::command]
#[tracing::instrument]
pub async fn get_compact_preferences() -> Result<CompactModePreferences, CommandError> {
    let state = read_app_state();
    Ok(state.compact_mode.unwrap_or_default())
}

/// Set compact mode window size
/// If height is provided, uses that; otherwise uses default
#[tauri::command]
#[tracing::instrument]
pub async fn set_compact_expanded(
    window: Window,
    expanded: bool,
    height: Option<f64>,
) -> Result<(), CommandError> {
    let final_height = height.unwrap_or(COMPACT_HEIGHT_DEFAULT);
    tracing::debug!(
        "Setting compact size: expanded={}, height={}",
        expanded,
        final_height
    );

    window
        .set_size(LogicalSize::new(COMPACT_WIDTH, final_height))
        .map_err(|e| format!("Failed to set window size: {e}"))?;

    // Persist the preference
    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.is_expanded = expanded;
    write_app_state(&state)?;

    Ok(())
}

/// Get current window position (for drag tracking)
#[tauri::command]
#[tracing::instrument]
pub async fn get_window_position(window: Window) -> Result<WindowPosition, CommandError> {
    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {e}"))?;

    Ok(WindowPosition {
        x: position.x,
        y: position.y,
    })
}

/// Set window position (for drag implementation)
#[tauri::command]
#[tracing::instrument]
pub async fn set_window_position(window: Window, x: i32, y: i32) -> Result<(), CommandError> {
    window
        .set_position(LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| format!("Failed to set window position: {e}"))?;

    Ok(())
}

/// Start dragging the window (native drag)
#[tauri::command]
#[tracing::instrument]
pub async fn start_window_drag(window: Window) -> Result<(), CommandError> {
    window
        .start_dragging()
        .map_err(|e| format!("Failed to start dragging: {e}"))?;

    Ok(())
}

/// Focus and bring window to front (useful after opening external apps)
#[tauri::command]
#[tracing::instrument]
pub async fn focus_window(window: Window) -> Result<(), CommandError> {
    tracing::debug!("Focusing window");

    // Ensure window is visible
    window
        .show()
        .map_err(|e| format!("Failed to show window: {e}"))?;

    // Set focus
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    Ok(())
}

/// Set the window title dynamically
#[tauri::command]
#[tracing::instrument]
pub async fn set_window_title(window: Window, title: String) -> Result<(), CommandError> {
    tracing::debug!("Setting window title: {}", title);

    window
        .set_title(&title)
        .map_err(|e| format!("Failed to set window title: {e}"))?;

    Ok(())
}
