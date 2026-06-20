//! UI state persistence commands.
//!
//! Per-project UI preferences stored in `.shipstudio/project.json`:
//! last-opened timestamp, branch prefix preference, hide-main-branch-warning,
//! auto-accept mode, and terminal tab state.

use crate::commands::accounts::DEFAULT_ACCOUNT_ID;
use crate::errors::CommandError;
use crate::types::{Account, ProjectMetadata, TerminalState};
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

    // IMPORTANT: opening a project must NEVER change its Workspace. A project is
    // tagged with its Workspace at creation/import time (see the frontend
    // creation funnels) or by an explicit "Move to workspace"; an untagged
    // project is always treated as Default (see `effective_account_id`).
    //
    // This previously stamped the *active* account onto any untagged project on
    // open, which silently moved legacy/Default projects into whichever
    // Workspace happened to be active when you opened them — a data-integrity
    // bug. Do not reintroduce it.

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

    let is_external = crate::commands::external_projects::is_registered_external_path(&project)?;

    // Each workspace lists projects from its own folder. If the target workspace
    // uses a *different* folder, relocate the project there so it actually shows
    // up after the move — otherwise it would be tagged to a workspace whose
    // folder it doesn't live in, and disappear from the dashboard. External
    // projects keep their on-disk location (they list via the registry, not the
    // folder scan), so we only retag those.
    if !is_external {
        let target_root = crate::utils::projects_root_for_account(&account_id);
        let target_root_canon =
            dunce::canonicalize(&target_root).unwrap_or_else(|_| target_root.clone());
        let current_parent_canon = project
            .parent()
            .and_then(|p| dunce::canonicalize(p).ok());

        let needs_move = current_parent_canon.is_some_and(|cp| cp != target_root_canon);

        if needs_move {
            // Refuse while the project is open — its live PTYs/dev server would be
            // moved out from under them.
            let is_open = crate::state::get_window_for_project(&project_path).is_some()
                || crate::state::get_session(&project_path)
                    .is_some_and(|s| s.status == crate::state::SessionStatus::Active);
            if is_open {
                return Err(
                    "Close this project before moving it to another workspace."
                        .to_string()
                        .into(),
                );
            }

            let name = project.file_name().ok_or("Invalid project path")?;
            let dest = target_root.join(name);
            if dest.exists() {
                return Err(format!(
                    "A project named \"{}\" already exists in that workspace's folder.",
                    name.to_string_lossy()
                )
                .into());
            }
            std::fs::create_dir_all(&target_root)
                .map_err(|e| format!("Failed to create the workspace's projects folder: {e}"))?;

            // Move the folder (rename, with cross-volume copy fallback).
            super::move_dir(&project, &dest)?;

            // Tag the project at its NEW location, then rekey path-keyed stores.
            write_project_account_id(&dest, &account_id)?;
            let dest_str = dest.to_string_lossy().to_string();
            if let Err(e) = super::pins::rename_pinned_path(&project_path, &dest_str) {
                tracing::warn!(error = %e, "Failed to rekey pins after workspace move");
            }
            if let Err(e) = crate::commands::folders::rename_project_path(&project_path, &dest_str) {
                tracing::warn!(error = %e, "Failed to rekey folder membership after workspace move");
            }
            crate::state::rename_session_path(&project_path, &dest_str);
            return Ok(());
        }
    }

    // No relocation needed (external, or already in the target folder): just retag.
    write_project_account_id(&project, &account_id)
}

/// Write a project's Workspace tag into its `.shipstudio/project.json`. The
/// Default workspace is stored as `None` so legacy/untagged projects stay
/// visible there.
fn write_project_account_id(
    project: &std::path::Path,
    account_id: &str,
) -> Result<(), CommandError> {
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

    metadata.account_id = if account_id == DEFAULT_ACCOUNT_ID {
        None
    } else {
        Some(account_id.to_string())
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

/// The Workspace (Account) a project effectively belongs to, given the set of
/// workspaces that currently exist. This is the **single source of truth** that
/// both credential injection ([`project_account_id_sync`]) and dashboard
/// visibility (`project_visible_for_account`) resolve through, so the two can
/// never disagree. The rule:
///   - tagged with a workspace that still exists → that workspace
///   - tagged with a since-deleted workspace      → Default
///   - untagged (legacy, pre-Workspaces)          → Default
///
/// Pure (no IO): callers pass the live account list so this can run per-project
/// in the dashboard listing loop without re-reading app state each time.
pub fn effective_account_id_in(metadata: Option<&ProjectMetadata>, accounts: &[Account]) -> String {
    if let Some(id) = metadata.and_then(|m| m.account_id.as_deref()) {
        if accounts.iter().any(|a| a.id == id) {
            return id.to_string();
        }
    }
    DEFAULT_ACCOUNT_ID.to_string()
}

/// Convenience wrapper over [`effective_account_id_in`] for single-call sites
/// that don't already hold the account list — reads app state once itself.
pub fn effective_account_id(metadata: Option<&ProjectMetadata>) -> String {
    let state = crate::commands::setup::read_app_state();
    effective_account_id_in(metadata, &state.accounts)
}

/// Synchronous resolver for the Workspace (Account) id a project belongs to,
/// reading `.shipstudio/project.json`'s `account_id`. Shared by env-injection
/// call sites (terminal spawn, git push, PR create, AI gen) that need it off the
/// async path so they inherit the *project's* workspace credentials rather than
/// whichever workspace is globally active. Resolution goes through
/// [`effective_account_id`] so credentials match what the dashboard shows.
pub fn project_account_id_sync(project_path: &std::path::Path) -> String {
    let metadata_path = project_path.join(".shipstudio").join("project.json");
    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok());
    effective_account_id(metadata.as_ref())
}

/// Returns the Workspace (Account) id the current project belongs to.
/// Falls back to the active account id if the project has no `account_id`.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_account_id(project_path: String) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(project_account_id_sync(&project))
}

#[cfg(test)]
mod effective_account_tests {
    use super::*;

    fn account(id: &str) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_string(),
            color: "#000".to_string(),
            is_default: id == DEFAULT_ACCOUNT_ID,
            created_at: 0,
            projects_root: None,
        }
    }

    fn tagged(id: &str) -> ProjectMetadata {
        ProjectMetadata {
            account_id: Some(id.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn tagged_with_existing_workspace_resolves_to_that_workspace() {
        let accounts = [account(DEFAULT_ACCOUNT_ID), account("ws-1")];
        let meta = tagged("ws-1");
        assert_eq!(effective_account_id_in(Some(&meta), &accounts), "ws-1");
    }

    #[test]
    fn tagged_with_deleted_workspace_falls_back_to_default() {
        // "ws-gone" is not in the live account list (workspace was deleted).
        let accounts = [account(DEFAULT_ACCOUNT_ID), account("ws-1")];
        let meta = tagged("ws-gone");
        assert_eq!(
            effective_account_id_in(Some(&meta), &accounts),
            DEFAULT_ACCOUNT_ID
        );
    }

    #[test]
    fn untagged_resolves_to_default() {
        let accounts = [account(DEFAULT_ACCOUNT_ID), account("ws-1")];
        let meta = ProjectMetadata::default(); // account_id: None
        assert_eq!(
            effective_account_id_in(Some(&meta), &accounts),
            DEFAULT_ACCOUNT_ID
        );
        assert_eq!(effective_account_id_in(None, &accounts), DEFAULT_ACCOUNT_ID);
    }
}
