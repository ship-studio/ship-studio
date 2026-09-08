//! # Settings Commands
//!
//! Persisted UI preferences (calendar visibility, projects root, etc.).

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::utils::{invalidate_projects_root_cache, projects_root};
use ship_studio_macros::ship_command;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// Get whether the GitHub contribution calendar is hidden on the dashboard.
#[ship_command]
#[tracing::instrument]
pub fn get_calendar_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.calendar_hidden.unwrap_or(false))
}

/// Set whether the GitHub contribution calendar is hidden (persisted to app state).
#[ship_command]
#[tracing::instrument]
pub fn set_calendar_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.calendar_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the Slack community CTA is hidden on the dashboard.
#[ship_command]
#[tracing::instrument]
pub fn get_slack_cta_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.slack_cta_hidden.unwrap_or(false))
}

/// Set whether the Slack community CTA is hidden (persisted to app state).
#[ship_command]
#[tracing::instrument]
pub fn set_slack_cta_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.slack_cta_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the terminal uses WebGL (GPU-accelerated) rendering. Defaults to true.
#[ship_command]
#[tracing::instrument]
pub fn get_terminal_gpu_enabled() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.terminal_gpu_enabled.unwrap_or(true))
}

/// Set whether the terminal uses WebGL rendering (persisted to app state).
#[ship_command]
#[tracing::instrument]
pub fn set_terminal_gpu_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.terminal_gpu_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get the project-thumbnail auto-capture consent.
///
/// `None` = the user has never been asked (the frontend shows an in-app
/// explainer before the first auto-capture), `Some(true)` = allowed,
/// `Some(false)` = opted out or a capture failed because macOS Screen
/// Recording permission was denied.
#[ship_command]
#[tracing::instrument]
pub fn get_thumbnails_enabled() -> Result<Option<bool>, CommandError> {
    Ok(read_app_state().thumbnails_enabled)
}

/// Set the project-thumbnail auto-capture consent (persisted to app state).
#[ship_command]
#[tracing::instrument]
pub fn set_thumbnails_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.thumbnails_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get the projects root directory (absolute path). Falls back to the default
/// `~/ShipStudio` when no custom root is configured.
#[ship_command]
#[tracing::instrument]
pub fn get_projects_root() -> Result<String, CommandError> {
    Ok(projects_root()?.to_string_lossy().to_string())
}

/// Whether the *active* workspace has a custom (non-default) projects folder set.
#[ship_command]
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
#[ship_command]
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
        std::fs::write(&probe, b"test").map_err(|e| format!("Folder isn't writable: {e}"))?;
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
#[ship_command]
#[tracing::instrument]
pub async fn pick_projects_root(
    selected_path: Option<String>,
) -> Result<Option<String>, CommandError> {
    let path = match selected_path {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            let Some(app) = crate::emit::tauri_app() else {
                return Ok(None);
            };
            let Some(path) = app
                .dialog()
                .file()
                .set_title("Choose Projects Folder")
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            path.into_path()
                .map_err(|e| format!("Invalid folder path: {e}"))?
        }
    };
    Ok(Some(path.to_string_lossy().into_owned()))
}
