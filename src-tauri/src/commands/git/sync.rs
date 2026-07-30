//! Git sync commands — fetch, pull, merge, commit, discard.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::utils::validate_project_path;

use super::git_stage_and_commit;
// Network git ops (fetch, pull, merge) go through the workspace-scoped helper in
// the parent module so they authenticate as the project's workspace login.
use super::run_git_net;

/// Git's normal refusal to pull a branch that has never been pushed (no
/// upstream configured) or whose upstream is gone — an anticipated state the
/// frontend already turns into a "push it first" toast, not a malfunction.
/// The message text is preserved verbatim so that frontend match keeps
/// working; only the telemetry classification changes (issue #312).
fn is_missing_upstream(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("no tracking information")
        || lower.contains("no such ref was fetched")
        || lower.contains("couldn't find remote ref")
}

/// Fetch all branches from remotes
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn fetch_all_branches(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output = run_git_net(
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

    let output = run_git_net(&["pull", "--ff-only"], &validated_path, "pull --ff-only").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_missing_upstream(&stderr) {
            return Err(CommandError::expected(format!("Failed to pull: {stderr}")));
        }
        return Err((format!("Failed to pull: {stderr}")).into());
    }

    // Invalidate status cache after pull
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Pull remote changes and merge (may result in conflicts).
///
/// Returns git's own summary output (e.g. "Already up to date." or the
/// fast-forward/merge stats) so the UI can report what actually happened
/// instead of a generic "done".
#[tauri::command]
#[tracing::instrument(skip(project_path, merge_branch), fields(project = %project_path, branch = ?merge_branch))]
pub async fn pull_and_merge(
    project_path: String,
    merge_branch: Option<String>,
) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // First fetch to ensure we have latest refs. Ignore failure (best-effort).
    let _ = run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await;

    let output = if let Some(branch) = merge_branch {
        let merge_ref = format!("origin/{branch}");
        run_git_net(&["merge", &merge_ref], &validated_path, "merge").await?
    } else {
        run_git_net(
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
        if is_missing_upstream(&stderr) {
            return Err(CommandError::expected(format!("Failed to merge: {stderr}")));
        }
        return Err((format!("Failed to merge: {stderr}")).into());
    }

    // The working tree may have changed under us — same reason git_pull invalidates.
    GIT_CACHE.invalidate_status(&project_path);

    Ok(combined)
}

/// Discard all uncommitted changes in the working directory
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn discard_changes(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Discard changes to tracked files
    let checkout_output = crate::utils::git_command_in(&validated_path)?
        .args(["checkout", "."])
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err((format!("Failed to discard changes: {stderr}")).into());
    }

    // Remove untracked files
    let clean_output = crate::utils::git_command_in(&validated_path)?
        .args(["clean", "-fd"])
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
    // Self-heal a missing user.name/user.email from the gh CLI identity before
    // committing, mirroring push_to_github — without it, Submit for Review's
    // auto-commit dies on git's "Please tell me who you are" (issue #276).
    let _ = crate::commands::github::ensure_git_identity(&validated_path);
    let committed = git_stage_and_commit(&validated_path, &message)?;
    if committed {
        GIT_CACHE.invalidate_status(&project_path);
    }
    Ok(committed)
}
