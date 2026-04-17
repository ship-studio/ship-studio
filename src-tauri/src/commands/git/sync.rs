//! Git sync commands — fetch, pull, merge, commit, discard.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::{create_command, validate_project_path};
use std::path::Path;

use super::git_stage_and_commit;

/// Default timeout for git network operations (fetch/pull/push). 60s is
/// generous but protects against indefinite hangs when a remote is unreachable.
const GIT_NETWORK_TIMEOUT_SECS: u64 = 60;

/// Run a network-facing git command with a timeout. Returns stringified errors
/// to match existing callers. `label` is used for tracing and timeout messages.
async fn run_git_with_timeout(
    args: &[&str],
    cwd: &Path,
    label: &str,
) -> Result<std::process::Output, String> {
    let mut cmd = create_command("git");
    cmd.args(args).current_dir(cwd);
    let tokio_cmd = tokio::process::Command::from(cmd);
    run_with_timeout(tokio_cmd, format!("git {label}"), GIT_NETWORK_TIMEOUT_SECS)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch all branches from remotes
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn fetch_all_branches(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output = run_git_with_timeout(
        &["fetch", "--all", "--prune"],
        &validated_path,
        "fetch --all",
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to fetch: {stderr}")).into());
    }

    Ok(())
}

/// Pull latest changes from remote for current branch
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn git_pull(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output =
        run_git_with_timeout(&["pull", "--ff-only"], &validated_path, "pull --ff-only").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to pull: {stderr}")).into());
    }

    // Invalidate status cache after pull
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Pull remote changes and merge (may result in conflicts)
#[tauri::command]
#[tracing::instrument(skip(project_path, merge_branch), fields(project = %project_path, branch = ?merge_branch))]
pub async fn pull_and_merge(
    project_path: String,
    merge_branch: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // First fetch to ensure we have latest refs. Ignore failure (best-effort).
    let _ = run_git_with_timeout(&["fetch", "origin"], &validated_path, "fetch origin").await;

    let output = if let Some(branch) = merge_branch {
        let merge_ref = format!("origin/{branch}");
        run_git_with_timeout(&["merge", &merge_ref], &validated_path, "merge").await?
    } else {
        run_git_with_timeout(
            &["pull", "--no-rebase"],
            &validated_path,
            "pull --no-rebase",
        )
        .await?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");

    // Check for merge conflicts
    if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
        return Err((format!("MERGE_CONFLICT:{combined}")).into());
    }

    if !output.status.success() {
        return Err((format!("Failed to merge: {stderr}")).into());
    }

    Ok(())
}

/// Discard all uncommitted changes in the working directory
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn discard_changes(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Discard changes to tracked files
    let checkout_output = create_command("git")
        .args(["checkout", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err((format!("Failed to discard changes: {stderr}")).into());
    }

    // Remove untracked files
    let clean_output = create_command("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr);
        return Err((format!("Failed to clean untracked files: {stderr}")).into());
    }

    // Invalidate status caches after discarding changes
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Stage all changes and create a commit with the given message.
/// Returns true if a commit was made, false if there was nothing to commit.
#[tauri::command]
#[tracing::instrument(skip(project_path, message), fields(project = %project_path))]
pub async fn commit_changes(project_path: String, message: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let committed = git_stage_and_commit(&validated_path, &message)?;
    if committed {
        GIT_CACHE.invalidate_status(&project_path);
    }
    Ok(committed)
}
