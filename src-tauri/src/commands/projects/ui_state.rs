//! UI state persistence commands.
//!
//! Per-project UI preferences stored in `.shipstudio/project.json`:
//! last-opened timestamp, branch prefix preference, hide-main-branch-warning,
//! auto-accept mode, and terminal tab state.

use crate::commands::accounts::{get_active_account_id, DEFAULT_ACCOUNT_ID};
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

    // Stamp the project with the Workspace (Account) it was first opened in,
    // so the dashboard can scope project visibility per Workspace.
    if metadata.account_id.is_none() {
        if let Ok(active_account_id) = crate::commands::accounts::get_active_account_id() {
            metadata.account_id = Some(active_account_id);
        }
    }

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

/// Reassigns a project to a different Workspace (Account) by updating
/// `account_id` in `.shipstudio/project.json`. The project folder is not
/// moved on disk — only the metadata tag changes.
///
/// Passing `account_id = "default"` moves the project to the Default
/// workspace; the stored value is set to `None` so that legacy projects
/// (which have no `account_id`) remain naturally visible in Default.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, account = %account_id))]
pub async fn move_project_to_account(
    project_path: String,
    account_id: String,
) -> Result<(), CommandError> {
    // Validate the id before it's persisted into project.json — it later builds
    // filesystem paths (CLAUDE_CONFIG_DIR etc.) when this project spawns a PTY.
    crate::commands::accounts::validate_account_id(&account_id)?;
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

    // Default workspace uses None so legacy projects remain visible there.
    metadata.account_id = if account_id == DEFAULT_ACCOUNT_ID {
        None
    } else {
        Some(account_id)
    };

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

/// Synchronous resolver for the Workspace (Account) id a project belongs to:
/// reads `.shipstudio/project.json`'s `account_id`, falling back to the active
/// account when the project isn't tagged. Shared by the async command below and
/// by env-injection call sites (terminal spawn, git push, PR create, AI gen)
/// that need it off the async path so they inherit the *project's* workspace
/// credentials rather than whichever workspace is globally active.
pub fn project_account_id_sync(project_path: &std::path::Path) -> String {
    let metadata_path = project_path.join(".shipstudio").join("project.json");
    if let Ok(contents) = std::fs::read_to_string(&metadata_path) {
        if let Ok(metadata) = serde_json::from_str::<ProjectMetadata>(&contents) {
            if let Some(id) = metadata.account_id {
                // Only honor the tag if that workspace still exists. When a
                // workspace is deleted, its projects keep a now-dangling
                // account_id on disk; treating it as the active/Default account
                // keeps the UI indicator and the injected credentials in sync
                // (otherwise the sidebar shows "Default" while terminals quietly
                // use the deleted workspace's orphaned config dir).
                let state = crate::commands::setup::read_app_state();
                if state.accounts.iter().any(|a| a.id == id) {
                    return id;
                }
            }
        }
    }
    // No tag, or the tagged workspace was deleted → Default (the active account).
    get_active_account_id().unwrap_or_else(|_| DEFAULT_ACCOUNT_ID.to_string())
}

/// Returns the Workspace (Account) id the current project belongs to.
/// Falls back to the active account id if the project has no `account_id`.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_account_id(project_path: String) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(project_account_id_sync(&project))
}
