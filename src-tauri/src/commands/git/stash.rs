//! Git stash and backup commands — stash management, commit history, restore.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::types::RestoreResult;
use crate::utils::{create_command, validate_project_path};
use tracing::{info, instrument, warn};

use super::{
    get_current_branch_sync, git_has_any_changes, git_stage_and_commit, load_project_metadata,
    save_project_metadata,
};

/// Get stash info for a project (if any auto-stash exists)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_stash_info(
    project_path: String,
) -> Result<Option<crate::types::StashInfo>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let metadata = load_project_metadata(&validated_path);
    Ok(metadata.stash_info)
}

/// Manually apply and clear the auto-stash
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn apply_stash(project_path: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let pop_output = create_command("git")
        .args(["stash", "pop"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if pop_output.status.success() {
        // Clear stash info from metadata
        let mut metadata = load_project_metadata(&validated_path);
        metadata.stash_info = None;
        if let Err(e) = save_project_metadata(&validated_path, &metadata) {
            warn!("Failed to save project metadata after stash apply: {}", e);
        }
        // Invalidate status cache after applying stash
        GIT_CACHE.invalidate_status(&project_path);
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&pop_output.stderr);
        Err((format!("Failed to apply stash: {stderr}")).into())
    }
}

/// Drop the auto-stash without applying
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn drop_stash(project_path: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let drop_output = create_command("git")
        .args(["stash", "drop"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    // Clear stash info from metadata regardless of drop success
    let mut metadata = load_project_metadata(&validated_path);
    metadata.stash_info = None;
    if let Err(e) = save_project_metadata(&validated_path, &metadata) {
        warn!("Failed to save project metadata after stash drop: {}", e);
    }

    if drop_output.status.success() {
        Ok(true)
    } else {
        // Stash might already be gone, still clear metadata
        Ok(false)
    }
}

// ============ Backup Commands ============

/// Get list of backups (git commits) for the project
#[tauri::command]
#[instrument(skip_all, fields(path = %project_path))]
pub async fn get_backups(
    project_path: String,
    limit: Option<u32>,
) -> Result<Vec<crate::types::Backup>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let limit = limit.unwrap_or(50);

    info!(limit, "Getting backups");

    // Format: hash|full_hash|message|timestamp|relative_time
    let output = create_command("git")
        .args([
            "--no-pager",
            "log",
            &format!("-{limit}"),
            "--format=%h|%H|%s|%ct|%cr",
        ])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to get git log: {stderr}")).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let backups: Vec<crate::types::Backup> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            if parts.len() >= 5 {
                Some(crate::types::Backup {
                    hash: parts[0].to_string(),
                    full_hash: parts[1].to_string(),
                    message: parts[2].to_string(),
                    timestamp: parts[3].parse().unwrap_or(0),
                    relative_time: parts[4].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    info!(count = backups.len(), "Found backups");
    Ok(backups)
}

/// Restore to a specific backup (git commit)
/// Creates a new branch with the restored content for safe review via PR
#[tauri::command]
#[instrument(skip_all, fields(path = %project_path, hash = %commit_hash))]
pub async fn restore_backup(
    project_path: String,
    commit_hash: String,
) -> Result<RestoreResult, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    info!("Restoring to backup via new branch");

    // Get the short hash for branch naming
    let short_hash = if commit_hash.len() > 7 {
        &commit_hash[..7]
    } else {
        &commit_hash
    };

    // Get the commit message of the target backup
    let msg_output = create_command("git")
        .args(["--no-pager", "log", "-1", "--format=%s", &commit_hash])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let target_message = String::from_utf8_lossy(&msg_output.stdout)
        .trim()
        .to_string();

    // Save current branch name to return to later if needed
    let current_branch =
        get_current_branch_sync(&validated_path).ok_or("Could not determine current branch")?;

    // 1. Stash any uncommitted changes
    let has_changes = git_has_any_changes(&validated_path)?;
    if has_changes {
        info!("Stashing current changes");
        let stash_output = create_command("git")
            .args(["stash", "push", "-m", "Auto-stash before restore"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !stash_output.status.success() {
            let stderr = String::from_utf8_lossy(&stash_output.stderr);
            return Err((format!("Failed to stash changes: {stderr}")).into());
        }
    }

    // 2. Create a new branch for the restore
    let branch_name = format!("restore-{short_hash}");

    // Check if branch already exists and delete it if so
    let branch_exists = create_command("git")
        .args(["rev-parse", "--verify", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if branch_exists {
        // Delete the existing branch
        let _ = create_command("git")
            .args(["branch", "-D", &branch_name])
            .current_dir(&validated_path)
            .output();
    }

    let create_output = create_command("git")
        .args(["checkout", "-b", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !create_output.status.success() {
        // Restore stash if we created one
        if has_changes {
            if let Err(e) = create_command("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output()
            {
                warn!(
                    "Failed to restore stash after branch creation failure: {}",
                    e
                );
            }
        }
        let stderr = String::from_utf8_lossy(&create_output.stderr);
        return Err((format!("Failed to create restore branch: {stderr}")).into());
    }

    // 3. Checkout all files from the target commit
    let checkout_output = create_command("git")
        .args(["checkout", &commit_hash, "--", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        // Switch back to original branch and restore stash
        if let Err(e) = create_command("git")
            .args(["checkout", &current_branch])
            .current_dir(&validated_path)
            .output()
        {
            warn!(
                "Failed to switch back to original branch during restore recovery: {}",
                e
            );
        }
        if let Err(e) = create_command("git")
            .args(["branch", "-D", &branch_name])
            .current_dir(&validated_path)
            .output()
        {
            warn!("Failed to delete restore branch during recovery: {}", e);
        }
        if has_changes {
            if let Err(e) = create_command("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output()
            {
                warn!("Failed to restore stash during recovery: {}", e);
            }
        }
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err((format!("Failed to restore files: {stderr}")).into());
    }

    // 4. Stage and commit the restored files
    let commit_message = format!("Restore to: {target_message}");
    let committed = git_stage_and_commit(&validated_path, &commit_message)?;

    if !committed {
        // No changes means we're already at this state
        // Switch back to original branch and clean up
        if let Err(e) = create_command("git")
            .args(["checkout", &current_branch])
            .current_dir(&validated_path)
            .output()
        {
            warn!(
                "Failed to switch back to original branch after no-op restore: {}",
                e
            );
        }
        if let Err(e) = create_command("git")
            .args(["branch", "-D", &branch_name])
            .current_dir(&validated_path)
            .output()
        {
            warn!("Failed to delete restore branch after no-op restore: {}", e);
        }
        if has_changes {
            if let Err(e) = create_command("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output()
            {
                warn!("Failed to restore stash after no-op restore: {}", e);
            }
        }
        return Err(("No changes to restore (already at this backup)".to_string()).into());
    }

    // 5. Push the new branch to remote
    info!("Pushing restore branch");
    let push_output = create_command("git")
        .args(["push", "-u", "origin", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        warn!(error = %stderr, "Failed to push restore branch");
        // Don't fail - branch was created locally, user can push manually
    }

    // Invalidate cache
    GIT_CACHE.invalidate(&project_path);

    info!(branch = %branch_name, "Restore branch created successfully");
    Ok(RestoreResult {
        branch_name,
        commit_message,
    })
}
