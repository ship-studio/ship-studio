//! # Window Management Commands
//!
//! Commands for handling window state, compact mode, and window positioning.
//! Compact mode uses responsive CSS - this module handles window resizing and always-on-top.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::types::{CompactModePreferences, WindowPosition};
use tauri::{LogicalPosition, LogicalSize, Window};

/// Compact mode dimensions
const COMPACT_WIDTH: f64 = 450.0;
const COMPACT_HEIGHT_DEFAULT: f64 = 600.0;

/// Default full mode dimensions
const FULL_MODE_WIDTH: f64 = 1200.0;
const FULL_MODE_HEIGHT: f64 = 800.0;

/// Enter compact mode - resize window and enable always-on-top
/// The UI adapts via responsive CSS based on window width
#[tauri::command]
pub async fn enter_compact_mode(window: Window) -> Result<(), String> {
    tracing::info!("Entering compact mode");

    // Get saved preferences for position
    let state = read_app_state();
    let position = state.compact_mode.as_ref().and_then(|p| p.position.clone());

    // Set always-on-top so window floats above browser
    window
        .set_always_on_top(true)
        .map_err(|e| format!("Failed to set always on top: {}", e))?;

    // Resize to compact dimensions
    window
        .set_size(LogicalSize::new(COMPACT_WIDTH, COMPACT_HEIGHT_DEFAULT))
        .map_err(|e| format!("Failed to set window size: {}", e))?;

    // Restore saved position if available
    if let Some(pos) = position {
        window
            .set_position(LogicalPosition::new(pos.x as f64, pos.y as f64))
            .map_err(|e| format!("Failed to set position: {}", e))?;
    }

    // Focus and bring to front
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    tracing::info!("Compact mode entered successfully");
    Ok(())
}

/// Exit compact mode - restore window to full size
#[tauri::command]
pub async fn exit_compact_mode(window: Window) -> Result<(), String> {
    tracing::info!("Exiting compact mode");

    // Save current position before exiting
    if let Ok(position) = window.outer_position() {
        let _ = save_compact_position_internal(position.x, position.y);
    }

    // Disable always-on-top
    window
        .set_always_on_top(false)
        .map_err(|e| format!("Failed to disable always on top: {}", e))?;

    // Restore full size
    window
        .set_size(LogicalSize::new(FULL_MODE_WIDTH, FULL_MODE_HEIGHT))
        .map_err(|e| format!("Failed to set window size: {}", e))?;

    // Center window on screen
    window
        .center()
        .map_err(|e| format!("Failed to center window: {}", e))?;

    tracing::info!("Compact mode exited successfully");
    Ok(())
}

/// Toggle always-on-top state for the window
#[tauri::command]
pub async fn set_always_on_top(window: Window, enabled: bool) -> Result<(), String> {
    tracing::info!("Setting always on top: {}", enabled);

    window
        .set_always_on_top(enabled)
        .map_err(|e| format!("Failed to set always on top: {}", e))?;

    // Persist the preference
    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.always_on_top = enabled;
    write_app_state(&state)?;

    Ok(())
}

/// Save compact mode window position
#[tauri::command]
pub async fn save_compact_position(x: i32, y: i32) -> Result<(), String> {
    save_compact_position_internal(x, y)
}

/// Internal helper to save position (used by both command and exit_compact_mode)
fn save_compact_position_internal(x: i32, y: i32) -> Result<(), String> {
    tracing::debug!("Saving compact position: ({}, {})", x, y);

    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.position = Some(WindowPosition { x, y });
    write_app_state(&state)?;

    Ok(())
}

/// Get current compact mode preferences
#[tauri::command]
pub async fn get_compact_preferences() -> Result<CompactModePreferences, String> {
    let state = read_app_state();
    Ok(state.compact_mode.unwrap_or_default())
}

/// Set compact mode window size
/// If height is provided, uses that; otherwise uses default
#[tauri::command]
pub async fn set_compact_expanded(
    window: Window,
    expanded: bool,
    height: Option<f64>,
) -> Result<(), String> {
    let final_height = height.unwrap_or(COMPACT_HEIGHT_DEFAULT);
    tracing::debug!(
        "Setting compact size: expanded={}, height={}",
        expanded,
        final_height
    );

    window
        .set_size(LogicalSize::new(COMPACT_WIDTH, final_height))
        .map_err(|e| format!("Failed to set window size: {}", e))?;

    // Persist the preference
    let mut state = read_app_state();
    let compact_prefs = state.compact_mode.get_or_insert_with(Default::default);
    compact_prefs.is_expanded = expanded;
    write_app_state(&state)?;

    Ok(())
}

/// Get current window position (for drag tracking)
#[tauri::command]
pub async fn get_window_position(window: Window) -> Result<WindowPosition, String> {
    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;

    Ok(WindowPosition {
        x: position.x,
        y: position.y,
    })
}

/// Set window position (for drag implementation)
#[tauri::command]
pub async fn set_window_position(window: Window, x: i32, y: i32) -> Result<(), String> {
    window
        .set_position(LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| format!("Failed to set window position: {}", e))?;

    Ok(())
}

/// Start dragging the window (native drag)
#[tauri::command]
pub async fn start_window_drag(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|e| format!("Failed to start dragging: {}", e))?;

    Ok(())
}

/// Focus and bring window to front (useful after opening external apps)
#[tauri::command]
pub async fn focus_window(window: Window) -> Result<(), String> {
    tracing::debug!("Focusing window");

    // Ensure window is visible
    window
        .show()
        .map_err(|e| format!("Failed to show window: {}", e))?;

    // Set focus
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    Ok(())
}

/// Set the window title dynamically
#[tauri::command]
pub async fn set_window_title(window: Window, title: String) -> Result<(), String> {
    tracing::debug!("Setting window title: {}", title);

    window
        .set_title(&title)
        .map_err(|e| format!("Failed to set window title: {}", e))?;

    Ok(())
}
