//! # Static Server Commands
//!
//! Tauri commands for managing the built-in static file server
//! used by plain HTML/CSS/JS projects.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use ship_studio_macros::ship_command;

/// Start a static file server for a project, returning the port it's listening on.
/// Also starts a file watcher that emits `static-file-changed` events for live reload.
#[ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn start_static_server(
    window_label: String,
    project_path: String,
) -> Result<u16, CommandError> {
    let validated = validate_project_path(&project_path)?;
    crate::static_server::start_static_server(window_label, validated.to_string_lossy().to_string())
        .await
        .map_err(CommandError::from)
}

/// Stop the static file server for a window.
#[ship_command]
#[tracing::instrument]
pub fn stop_static_server(window_label: String) -> Result<(), CommandError> {
    crate::static_server::stop_static_server(&window_label);
    Ok(())
}
