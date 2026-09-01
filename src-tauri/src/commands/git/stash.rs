//! Git stash and backup commands — stash management, commit history, restore.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::types::RestoreResult;
use crate::utils::validate_project_path;
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

/// Stash all current changes (tracked + untracked) so the working tree is clean.
///
/// Used by "Stash & create branch": the user has uncommitted changes that would
/// be clobbered by branching off a different base, and chose to set them aside.
/// This is a plain `git stash` (NOT the metadata-tracked auto-stash that switch
/// uses), so the user restores it manually with `git stash pop`. Returns true if
/// something was stashed, false if the tree was already clean.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn stash_changes(project_path: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // `stash push` writes the index just like add/commit/checkout, so it can
    // lose the .git lock race against the background snapshot watcher or any
    // agent CLI running git — retry on contention the same way
    // git_stage_and_commit/discard_changes do (issues #377/#597/#820).
    let output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args([
                "stash",
                "push",
                "--include-untracked",
                "-m",
                "Ship Studio: set aside before creating a branch",
            ])
            .output()
            .map_err(CommandError::from)
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to stash changes: {stderr}")).into());
    }

    GIT_CACHE.invalidate_status(&project_path);
    // `git stash` with nothing to save exits 0 and prints "No local changes…".
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(!stdout.contains("No local changes"))
}

/// Manually apply and clear the auto-stash
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn apply_stash(project_path: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Same index.lock retry as stash_changes — popping rewrites the working
    // tree and index (issue #820).
    let pop_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["stash", "pop"])
            .output()
            .map_err(CommandError::from)
    })?;

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

    // `stash drop` rewrites refs/stash, which takes the same lock family
    // (issue #820).
    let drop_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["stash", "drop"])
            .output()
            .map_err(CommandError::from)
    })?;

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
    let output = crate::utils::git_command_in(&validated_path)?
        .args([
            "--no-pager",
            "log",
            &format!("-{limit}"),
            "--format=%h|%H|%s|%ct|%cr",
        ])
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
    let msg_output = crate::utils::git_command_in(&validated_path)?
        .args(["--no-pager", "log", "-1", "--format=%s", &commit_hash])
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
        // Index-lock retry on every mutating step of the restore, same as the
        // commit/discard paths — a snapshot-watcher collision here aborted the
        // whole restore halfway (issue #820).
        let stash_output = crate::utils::output_retrying_index_lock(|| {
            crate::utils::git_command_in(&validated_path)?
                .args(["stash", "push", "-m", "Auto-stash before restore"])
                .output()
                .map_err(CommandError::from)
        })?;

        if !stash_output.status.success() {
            let stderr = String::from_utf8_lossy(&stash_output.stderr);
            return Err((format!("Failed to stash changes: {stderr}")).into());
        }
    }

    // 2. Create a new branch for the restore
    let branch_name = format!("restore-{short_hash}");

    // Check if branch already exists and delete it if so
    let branch_exists = crate::utils::git_command_in(&validated_path)?
        .args(["rev-parse", "--verify", &branch_name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if branch_exists {
        // Delete the existing branch
        let _ = crate::utils::git_command_in(&validated_path)?
            .args(["branch", "-D", &branch_name])
            .output();
    }

    let create_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["checkout", "-b", &branch_name])
            .output()
            .map_err(CommandError::from)
    })?;

    if !create_output.status.success() {
        // Restore stash if we created one
        if has_changes {
            if let Err(e) = crate::utils::git_command_in(&validated_path)?
                .args(["stash", "pop"])
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
    let checkout_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["checkout", &commit_hash, "--", "."])
            .output()
            .map_err(CommandError::from)
    })?;

    if !checkout_output.status.success() {
        // Switch back to original branch and restore stash
        if let Err(e) = crate::utils::git_command_in(&validated_path)?
            .args(["checkout", &current_branch])
            .output()
        {
            warn!(
                "Failed to switch back to original branch during restore recovery: {}",
                e
            );
        }
        if let Err(e) = crate::utils::git_command_in(&validated_path)?
            .args(["branch", "-D", &branch_name])
            .output()
        {
            warn!("Failed to delete restore branch during recovery: {}", e);
        }
        if has_changes {
            if let Err(e) = crate::utils::git_command_in(&validated_path)?
                .args(["stash", "pop"])
                .output()
            {
                warn!("Failed to restore stash during recovery: {}", e);
            }
        }
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err((format!("Failed to restore files: {stderr}")).into());
    }

    // 4. Stage and commit the restored files. Self-heal a missing
    // user.name/user.email from the gh CLI identity first, mirroring
    // commit_changes/publishing/conflicts — without it the restore commit dies
    // on git's "Please tell me who you are" (issue #679, same class as #276).
    let _ = crate::commands::github::ensure_git_identity(&validated_path);
    let commit_message = format!("Restore to: {target_message}");
    let committed = git_stage_and_commit(&validated_path, &commit_message)?;

    if !committed {
        // No changes means we're already at this state
        // Switch back to original branch and clean up
        if let Err(e) = crate::utils::git_command_in(&validated_path)?
            .args(["checkout", &current_branch])
            .output()
        {
            warn!(
                "Failed to switch back to original branch after no-op restore: {}",
                e
            );
        }
        if let Err(e) = crate::utils::git_command_in(&validated_path)?
            .args(["branch", "-D", &branch_name])
            .output()
        {
            warn!("Failed to delete restore branch after no-op restore: {}", e);
        }
        if has_changes {
            if let Err(e) = crate::utils::git_command_in(&validated_path)?
                .args(["stash", "pop"])
                .output()
            {
                warn!("Failed to restore stash after no-op restore: {}", e);
            }
        }
        return Err(("No changes to restore (already at this backup)".to_string()).into());
    }

    // 5. Push the new branch to remote
    info!("Pushing restore branch");
    let push_output = crate::utils::git_command_in(&validated_path)?
        .args(["push", "-u", "origin", &branch_name])
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

#[cfg(test)]
mod tests {
    use super::CommandError;

    /// Every `git` spawn in this file maps its `io::Error` with
    /// `CommandError::from`, never by hand-constructing `CommandError::Io`.
    /// Six copy-pasted `map_err(|e| CommandError::Io { … })` blocks bypassed
    /// the `From` impl's `windows_out_of_memory` classification, so a Windows
    /// paging-file exhaustion during a stash/checkout reached the user as a
    /// bare OS string and telemetry as an app malfunction (issues #356/#783).
    #[test]
    fn spawn_failures_keep_the_windows_out_of_memory_classification() {
        let oom = std::io::Error::from_raw_os_error(1455);
        let err = CommandError::from(oom);
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        assert!(err.to_string().contains("paging file"), "got: {err}");

        // Ordinary spawn failures still land in Io so telemetry keeps them.
        let other = std::io::Error::other("boom");
        assert!(matches!(CommandError::from(other), CommandError::Io { .. }));
    }
}
