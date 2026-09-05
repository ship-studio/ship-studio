//! # Settings Commands
//!
//! Persisted UI preferences (calendar visibility, projects root, etc.).

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::utils::{invalidate_projects_root_cache, projects_root};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const DEFAULT_APP_ICON: &str = "brand";
const APP_ICON_IDS: &[&str] = &["brand", "dark", "light"];

fn normalized_app_icon(value: Option<&str>) -> &'static str {
    match value {
        Some(icon) if APP_ICON_IDS.contains(&icon) => match icon {
            "dark" => "dark",
            "light" => "light",
            _ => DEFAULT_APP_ICON,
        },
        _ => DEFAULT_APP_ICON,
    }
}

fn validate_app_icon(icon: &str) -> Result<(), CommandError> {
    if APP_ICON_IDS.contains(&icon) {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "icon".to_string(),
            reason: "Choose one of brand, dark, or light".to_string(),
        })
    }
}

/// Get the persisted app icon choice.
#[tauri::command]
#[tracing::instrument]
pub fn get_app_icon() -> Result<String, CommandError> {
    Ok(normalized_app_icon(read_app_state().app_icon.as_deref()).to_string())
}

/// Persist the app icon choice and update the native Dock icon immediately.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub fn set_app_icon(app: AppHandle, icon: String) -> Result<(), CommandError> {
    validate_app_icon(&icon)?;
    apply_app_icon(&app, &icon)?;

    let mut state = read_app_state();
    state.app_icon = Some(icon);
    write_app_state(&state).map_err(CommandError::from)
}

/// Apply a saved icon during startup or after a settings change.
pub fn apply_app_icon(app: &AppHandle, icon: &str) -> Result<(), CommandError> {
    validate_app_icon(icon)?;

    #[cfg(target_os = "macos")]
    {
        let bytes = app_icon_bytes(icon);
        app.run_on_main_thread(move || {
            if let Err(error) = set_macos_dock_icon(bytes) {
                tracing::error!(%error, "Failed to update the macOS Dock icon");
            }
        })
        .map_err(|error| format!("Failed to schedule the Dock icon update: {error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, icon);

    Ok(())
}

#[cfg(target_os = "macos")]
fn app_icon_bytes(icon: &str) -> &'static [u8] {
    match icon {
        "dark" => include_bytes!("../../../public/ShipStudio_IconDark.png"),
        "light" => include_bytes!("../../../public/ShipStudio_IconLight.png"),
        _ => include_bytes!("../../../public/ShipStudio_IconBrand.png"),
    }
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(bytes: &[u8]) -> Result<(), &'static str> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSData;

    let data = NSData::with_bytes(bytes);
    let allocated_image: *mut AnyObject = unsafe { msg_send![class!(NSImage), alloc] };
    let image: *mut AnyObject = unsafe { msg_send![allocated_image, initWithData: &*data] };
    if image.is_null() {
        return Err("AppKit could not decode the selected PNG");
    }

    let application: *mut AnyObject =
        unsafe { msg_send![class!(NSApplication), sharedApplication] };
    if application.is_null() {
        return Err("AppKit did not return the shared application");
    }

    unsafe {
        let _: () = msg_send![application, setApplicationIconImage: image];
        let _: () = msg_send![image, release];
    }
    Ok(())
}

/// Get whether the GitHub contribution calendar is hidden on the dashboard.
#[tauri::command]
#[tracing::instrument]
pub fn get_calendar_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.calendar_hidden.unwrap_or(false))
}

/// Set whether the GitHub contribution calendar is hidden (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_calendar_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.calendar_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the macOS Spotify widget is enabled.
///
/// Opt-in: defaults to `false` so no existing install starts talking to
/// Spotify (or triggers a macOS Automation prompt) without being asked.
#[tauri::command]
#[tracing::instrument]
pub fn get_spotify_widget_enabled() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.spotify_widget_enabled.unwrap_or(false))
}

/// Set whether the macOS Spotify widget is enabled (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_spotify_widget_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.spotify_widget_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the Slack community CTA is hidden on the dashboard.
#[tauri::command]
#[tracing::instrument]
pub fn get_slack_cta_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.slack_cta_hidden.unwrap_or(false))
}

/// Set whether the Slack community CTA is hidden (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_slack_cta_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.slack_cta_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the dashboard home header is hidden.
#[tauri::command]
#[tracing::instrument]
pub fn get_dashboard_header_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.dashboard_header_hidden.unwrap_or(false))
}

/// Set whether the dashboard home header is hidden (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_dashboard_header_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.dashboard_header_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the terminal uses WebGL (GPU-accelerated) rendering. Defaults to true.
#[tauri::command]
#[tracing::instrument]
pub fn get_terminal_gpu_enabled() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.terminal_gpu_enabled.unwrap_or(true))
}

/// Set whether the terminal uses WebGL rendering (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_terminal_gpu_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.terminal_gpu_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether workspace actions are consolidated into the window titlebar.
#[tauri::command]
#[tracing::instrument]
pub fn get_compact_workspace_toolbar_enabled() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.compact_workspace_toolbar_enabled.unwrap_or(false))
}

/// Set whether workspace actions are consolidated into the window titlebar.
#[tauri::command]
#[tracing::instrument]
pub fn set_compact_workspace_toolbar_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.compact_workspace_toolbar_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get the project-thumbnail auto-capture consent.
///
/// `None` = the user has never been asked (the frontend shows an in-app
/// explainer before the first auto-capture), `Some(true)` = allowed,
/// `Some(false)` = opted out or a capture failed because macOS Screen
/// Recording permission was denied.
#[tauri::command]
#[tracing::instrument]
pub fn get_thumbnails_enabled() -> Result<Option<bool>, CommandError> {
    Ok(read_app_state().thumbnails_enabled)
}

/// Set the project-thumbnail auto-capture consent (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_thumbnails_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.thumbnails_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get the projects root directory (absolute path). Falls back to the default
/// `~/ShipStudio` when no custom root is configured.
#[tauri::command]
#[tracing::instrument]
pub fn get_projects_root() -> Result<String, CommandError> {
    Ok(projects_root()?.to_string_lossy().to_string())
}

/// Whether the *active* workspace has a custom (non-default) projects folder set.
#[tauri::command]
#[tracing::instrument]
pub fn is_custom_projects_root() -> Result<bool, CommandError> {
    use crate::commands::accounts::DEFAULT_ACCOUNT_ID;
    let state = read_app_state();
    let active_id = state
        .active_account_id
        .as_deref()
        .unwrap_or(DEFAULT_ACCOUNT_ID);

    let on_account = state
        .accounts
        .iter()
        .find(|a| a.id == active_id)
        .and_then(|a| a.projects_root.as_deref())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // The Default workspace also honors the legacy top-level setting.
    let on_legacy_global = active_id == DEFAULT_ACCOUNT_ID
        && state
            .projects_root
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

    Ok(on_account || on_legacy_global)
}

/// Set (or clear) the *active workspace's* projects folder.
///
/// An empty string resets that workspace to the default `~/ShipStudio`. A
/// non-empty value must be an existing, writable, absolute directory. The cache
/// is invalidated so the change takes effect immediately.
#[tauri::command]
#[tracing::instrument]
pub fn set_projects_root(path: String) -> Result<(), CommandError> {
    use crate::commands::accounts::DEFAULT_ACCOUNT_ID;
    let trimmed = path.trim();

    // Validate the folder up front (before touching state).
    let value: Option<String> = if trimmed.is_empty() {
        None
    } else {
        let pb = Path::new(trimmed);
        if !pb.is_absolute() {
            return Err("Projects folder must be an absolute path"
                .to_string()
                .into());
        }
        if !pb.is_dir() {
            return Err(format!("Not a folder: {trimmed}").into());
        }
        // Guardrail: never allow the filesystem root as the projects folder.
        if pb.parent().is_none() {
            return Err("Refusing to use the filesystem root as the projects folder"
                .to_string()
                .into());
        }
        // Confirm the folder is writable (creating projects needs write access).
        let probe = pb.join(".shipstudio-write-test");
        std::fs::write(&probe, b"test").map_err(|e| {
            // "Folder isn't writable" for every failure was misleading: on
            // Windows, a folder that vanished between the is_dir() check and
            // this write (removable/network drive, concurrent delete) reports
            // os error 2 NotFound — a permissions message with no path made
            // that undiagnosable (issue #397).
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "The folder '{trimmed}' is no longer accessible — it may have been \
                     deleted, renamed, or be on a disconnected drive ({e})"
                )
            } else {
                format!("Folder '{trimmed}' isn't writable: {e}")
            }
        })?;
        let _ = std::fs::remove_file(&probe);
        Some(trimmed.to_string())
    };

    let mut state = read_app_state();
    let active_id = state
        .active_account_id
        .clone()
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());

    if let Some(acc) = state.accounts.iter_mut().find(|a| a.id == active_id) {
        acc.projects_root = value;
    } else {
        // No materialized account record yet (e.g. only the implicit Default) —
        // store on the legacy top-level field, which serves as the Default
        // workspace's folder and is read back first by the resolver.
        state.projects_root = value;
    }

    write_app_state(&state).map_err(CommandError::from)?;
    invalidate_projects_root_cache();
    Ok(())
}

/// Open a native folder picker for choosing the projects folder.
/// Returns the selected absolute path, or `None` if the user cancelled.
/// Does not persist anything — the frontend calls `set_projects_root` with the result.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn pick_projects_root(app: AppHandle) -> Result<Option<String>, CommandError> {
    let folder = app
        .dialog()
        .file()
        .set_title("Choose Projects Folder")
        .blocking_pick_folder();

    match folder {
        Some(path) => {
            let pb = path
                .into_path()
                .map_err(|e| format!("Invalid folder path: {e}"))?;
            Ok(Some(pb.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{normalized_app_icon, validate_app_icon};

    #[test]
    fn accepts_the_three_supported_icons() {
        for icon in ["brand", "dark", "light"] {
            assert!(validate_app_icon(icon).is_ok());
        }
    }

    #[test]
    fn rejects_unknown_icons() {
        assert!(validate_app_icon("system").is_err());
    }

    #[test]
    fn invalid_saved_values_use_the_brand_icon() {
        assert_eq!(normalized_app_icon(Some("system")), "brand");
        assert_eq!(normalized_app_icon(None), "brand");
    }
}
