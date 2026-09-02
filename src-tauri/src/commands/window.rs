//! # Window Management Commands
//!
//! Commands for handling window state, compact mode, and window positioning.
//! Compact mode uses responsive CSS - this module handles window resizing and always-on-top.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::types::{CompactModePreferences, WindowPosition};
use tauri::{LogicalPosition, LogicalSize, Window};

/// Leading inset of the close button, matching AppKit's own placement for a
/// standard titled window. That placement — not the one a 46pt custom titlebar
/// would suggest — is what the shipped build renders, so it is the reference
/// the CSS titlebar safe area (`.workspace-titlebar` padding, 82pt) is sized
/// against: 20 + 2 x spacing (20) + 12pt button = 72pt of occupied width.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_LEADING_INSET: f64 = 20.0;

/// Height of the system titlebar AppKit vertically centres the buttons in.
/// The top inset is derived from it and the button's measured height rather
/// than hard-coded, so we never assume how tall the controls are on a given
/// macOS version.
#[cfg(target_os = "macos")]
const SYSTEM_TITLEBAR_HEIGHT: f64 = 28.0;

/// How long to keep waiting for AppKit to build the titlebar before giving up.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_MAX_ATTEMPTS: u32 = 20;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_RETRY_MS: u64 = 100;

/// Pins the native macOS window controls inside Ship Studio's 46pt custom
/// titlebar. Persistent Auto Layout constraints are required here: AppKit and
/// Wry both lay out the titlebar during live resize, so one-off frame changes
/// visibly alternate with the system position.
///
/// The constraints reproduce AppKit's own geometry (see the constants above)
/// so a dev run shows exactly what a release build ships — the two used to
/// disagree because the window's titlebar is built lazily: a dev launch is
/// slow enough that the buttons already exist on the first attempt, while a
/// release launch could reach this before they do, silently skip the
/// constraints, and fall back to whatever the platform did on its own. Hence
/// the retry: attempt until the buttons exist, then install once.
#[cfg(target_os = "macos")]
pub fn center_macos_traffic_lights(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    schedule_macos_traffic_light_constraints(window.clone(), 0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn schedule_macos_traffic_light_constraints(window: tauri::WebviewWindow, attempt: u32) {
    if attempt >= TRAFFIC_LIGHT_MAX_ATTEMPTS {
        tracing::warn!(
            "Traffic-light constraints not installed after {} attempts; window controls keep their default placement",
            TRAFFIC_LIGHT_MAX_ATTEMPTS
        );
        return;
    }

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let retry_window = window.clone();
    let _ = window.run_on_main_thread(move || {
        let installed =
            unsafe { constrain_macos_traffic_lights(ns_window as *mut objc2::runtime::AnyObject) };
        if installed {
            return;
        }
        // Off the main thread so the UI keeps running while we wait.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(TRAFFIC_LIGHT_RETRY_MS));
            schedule_macos_traffic_light_constraints(retry_window, attempt + 1);
        });
    });
}

/// Returns `true` once the constraints are installed; `false` while AppKit has
/// not built the titlebar yet (the caller retries).
#[cfg(target_os = "macos")]
unsafe fn constrain_macos_traffic_lights(ns_window: *mut objc2::runtime::AnyObject) -> bool {
    use objc2::msg_send;
    use objc2_foundation::CGRect;

    let close_button: *mut objc2::runtime::AnyObject =
        msg_send![ns_window, standardWindowButton: 0usize];
    if close_button.is_null() {
        return false;
    }
    let close_frame: CGRect = msg_send![close_button, frame];
    let miniaturize_button: *mut objc2::runtime::AnyObject =
        msg_send![ns_window, standardWindowButton: 1usize];
    if miniaturize_button.is_null() {
        return false;
    }
    let miniaturize_frame: CGRect = msg_send![miniaturize_button, frame];
    let button_spacing = miniaturize_frame.origin.x - close_frame.origin.x;
    // Measured, not assumed: whatever height the controls have on this macOS
    // version, centring them in the system titlebar reproduces the placement
    // an unmodified window would get.
    let top_inset = ((SYSTEM_TITLEBAR_HEIGHT - close_frame.size.height) / 2.0).max(0.0);

    let titlebar_view: *mut objc2::runtime::AnyObject = msg_send![close_button, superview];
    if titlebar_view.is_null() {
        return false;
    }
    let titlebar_container: *mut objc2::runtime::AnyObject = msg_send![titlebar_view, superview];
    if titlebar_container.is_null() {
        return false;
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
        let leading = TRAFFIC_LIGHT_LEADING_INSET + button_kind as f64 * button_spacing;
        let leading_constraint: *mut objc2::runtime::AnyObject = msg_send![leading_anchor, constraintEqualToAnchor: container_leading_anchor constant: leading];
        let top_constraint: *mut objc2::runtime::AnyObject = msg_send![top_anchor, constraintEqualToAnchor: container_top_anchor constant: top_inset];
        let _: () = msg_send![leading_constraint, setActive: true];
        let _: () = msg_send![top_constraint, setActive: true];
    }

    let _: () = msg_send![titlebar_container, layoutSubtreeIfNeeded];
    true
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
