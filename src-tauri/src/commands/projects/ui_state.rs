//! UI state persistence commands.
//!
//! Per-project UI preferences stored in `.shipstudio/project.json`:
//! last-opened timestamp, branch prefix preference, hide-main-branch-warning,
//! auto-accept mode, and terminal tab state.

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, TerminalState};
use crate::utils::validate_project_path;

/// Marks a project as opened by updating its last_opened timestamp
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn mark_project_opened(project_path: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    metadata.last_opened = Some(now);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Gets the branch prefix username preference (defaults to true if not set)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_branch_prefix_preference(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(true);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.branch_prefix_username.unwrap_or(true))
}

/// Sets the branch prefix username preference
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_branch_prefix_preference(
    project_path: String,
    prefix: bool,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.branch_prefix_username = Some(prefix);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Gets whether the main branch warning banner should be hidden for this project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_hide_main_branch_warning(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.hide_main_branch_warning.unwrap_or(false))
}

/// Sets whether the main branch warning banner should be hidden for this project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_hide_main_branch_warning(
    project_path: String,
    hidden: bool,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.hide_main_branch_warning = Some(hidden);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Gets the auto-accept mode preference for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_auto_accept_mode(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.auto_accept_mode.unwrap_or(false))
}

/// Sets the auto-accept mode preference for a project
/// When enabled, Claude will run with --dangerously-skip-permissions flag
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_auto_accept_mode(project_path: String, enabled: bool) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.auto_accept_mode = Some(enabled);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Gets the saved terminal tab state for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_terminal_state(
    project_path: String,
) -> Result<Option<TerminalState>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read project metadata: {e}"))?;
    let metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;

    Ok(metadata.terminal_state)
}

/// Saves the terminal tab state for a project
#[tauri::command]
#[tracing::instrument(skip(state), fields(project = %project_path))]
pub async fn set_terminal_state(
    project_path: String,
    state: TerminalState,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.terminal_state = Some(state);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents_str = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents_str)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}
