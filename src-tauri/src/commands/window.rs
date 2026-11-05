//! # Window Management Commands
//!
//! Commands for handling window state, compact mode, and window positioning.
//! Compact mode uses responsive CSS - this module handles window resizing and always-on-top.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use tauri::Window;

/// Leading inset of the close button, matching AppKit's own placement for a
/// standard titled window. That placement — not the one a 46pt custom titlebar
/// would suggest — is what the shipped build renders, so it is the reference
/// the CSS titlebar safe area (`.workspace-titlebar` padding, 82pt) is sized
/// against: 20 + 2 x spacing (20) + 12pt button = 72pt of occupied width.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_LEADING_INSET: f64 = 20.0;

/// Height of Ship Studio's custom titlebar (the 46pt bar the sidebar-toggle
/// and Home buttons are centred in). The traffic lights are centred in the
/// same box so the whole row reads as one aligned strip — and because the
/// constraints hold in release builds too (they retry until AppKit builds the
/// titlebar), prod gets this placement rather than AppKit's higher default.
/// The top inset is derived from the button's measured height rather than
/// hard-coded, so we never assume how tall the controls are on a given macOS
/// version.
#[cfg(target_os = "macos")]
const CUSTOM_TITLEBAR_HEIGHT: f64 = 46.0;

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
    // version, centring them in the app's 46pt titlebar keeps them on the
    // same axis as the titlebar buttons beside them.
    let top_inset = ((CUSTOM_TITLEBAR_HEIGHT - close_frame.size.height) / 2.0).max(0.0);

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

// ============================================================================
// Keep running when windows close (opt-in, macOS)
// ============================================================================

/// Windows hidden by a close while "Keep running when windows close" is on.
/// Clicking the Dock icon brings them back (`reopen_hidden_windows`).
static HIDDEN_BY_CLOSE: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Whether a window close should hide it rather than quit. Opt-in so nobody
/// who never asked finds Ship Studio still running after closing it.
pub fn keep_running_when_closed() -> bool {
    cfg!(target_os = "macos") && read_app_state().keep_running_when_closed == Some(true)
}

/// Called by the frontend's close-request handler before it quits. With the
/// preference on, hides the window instead (so its agents, terminals and
/// check-ins keep going) and answers `true`; otherwise `false`, and the
/// caller quits exactly as before.
///
/// Hiding rather than destroying matters: a destroyed main window runs the
/// global cleanup that kills agent processes.
#[tauri::command]
#[tracing::instrument(skip(window), fields(label = %window.label()))]
pub async fn close_to_background(window: tauri::WebviewWindow) -> Result<bool, CommandError> {
    if !keep_running_when_closed() {
        return Ok(false);
    }
    hide_to_background(&window).await?;
    Ok(true)
}

/// The quit dialog's "Keep running in background": hide every window, as a
/// close would with "Keep running when closed" on. The Dock icon (or the
/// menu-bar icon) brings them back.
pub async fn hide_all_to_background(app: &tauri::AppHandle) -> Result<(), CommandError> {
    use tauri::Manager;
    for window in app.webview_windows().into_values() {
        if window.label() != crate::agents::quick_entry::LABEL
            && window.is_visible().unwrap_or(false)
        {
            hide_to_background(&window).await?;
        }
    }
    Ok(())
}

async fn hide_to_background(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    let label = window.label().to_string();
    {
        let mut hidden = HIDDEN_BY_CLOSE.lock().unwrap_or_else(|e| e.into_inner());
        if !hidden.contains(&label) {
            hidden.push(label.clone());
        }
    }
    if window.is_fullscreen().unwrap_or(false) {
        // Hiding a full-screen window leaves an empty Space behind; leave
        // full screen first and hide once the animation has had time to run.
        window
            .set_fullscreen(false)
            .map_err(|e| format!("Failed to leave full screen: {e}"))?;
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    window
        .hide()
        .map_err(|e| format!("Failed to hide window: {e}"))?;
    tracing::info!("Window {} hidden; Ship Studio keeps running", label);
    Ok(())
}

/// The Dock icon was clicked with nothing on screen: bring back what a close
/// hid. Falls back to the main window if the list is empty.
pub fn reopen_hidden_windows(app: &tauri::AppHandle) {
    use tauri::Manager;
    let labels: Vec<String> =
        std::mem::take(&mut *HIDDEN_BY_CLOSE.lock().unwrap_or_else(|e| e.into_inner()));
    let windows = app.webview_windows();
    let mut shown = false;
    for label in &labels {
        if let Some(w) = windows.get(label) {
            let _ = w.show();
            let _ = w.set_focus();
            shown = true;
        }
    }
    if !shown {
        if let Some(w) = windows.get("main").or_else(|| {
            windows
                .values()
                .find(|w| w.label() != crate::agents::quick_entry::LABEL)
        }) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// A window shown again some other way (a notification, opening its
/// project) is no longer one the Dock needs to bring back.
pub fn forget_hidden_window(label: &str) {
    HIDDEN_BY_CLOSE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|l| l != label);
}
