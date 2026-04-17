//! # Publishing Commands
//!
//! Commands for publishing to GitHub, staging, and production.

use crate::commands::git::git_stage_and_commit;
use crate::commands::github::ensure_git_identity;
use crate::errors::CommandError;
use crate::types::PublishResult;
use crate::utils::{create_command, validate_project_path};
use tracing::{debug, error, info, instrument, warn};

#[tauri::command]
#[instrument(name = "publish_to_github", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_github(
    project_path: String,
    commit_message: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = commit_message.unwrap_or_else(|| "Update from Ship Studio".to_string());
    info!(message = %message, "Publishing to GitHub");

    // Get current branch name
    let branch_output = create_command("git")
        .args(["branch", "--show-current"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    let branch = if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    };

    // Pull latest changes first (rebase to keep history clean)
    let pull_output = create_command("git")
        .args(["pull", "--rebase", "origin", &branch])
        .current_dir(&validated_path)
        .output();

    // Handle pull errors - log unexpected ones but don't fail
    match pull_output {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // These errors are expected for new repos/branches
            let is_expected_error = stderr.contains("no tracking")
                || stderr.contains("Couldn't find remote ref")
                || stderr.contains("There is no tracking information")
                || stderr.contains("fatal: couldn't find remote ref");

            if !is_expected_error {
                warn!(error = %stderr, "Unexpected pull error (continuing anyway)");
            } else {
                debug!(error = %stderr, "Expected pull error for new repo/branch");
            }
        }
        Err(e) => {
            warn!(error = %e, "Failed to execute git pull");
        }
        _ => {}
    }

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage all changes
    let output = create_command("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    if !output.status.success() {
        return Err(CommandError::Process {
            cmd: "git add -A".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }

    // Check if there are changes to commit
    let status = create_command("git")
        .args(["status", "--porcelain"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    let has_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_changes {
        // Commit changes
        let output = create_command("git")
            .args(["commit", "-m", &message])
            .current_dir(&validated_path)
            .output()
            .map_err(CommandError::from)?;

        if !output.status.success() {
            return Err(CommandError::Process {
                cmd: "git commit".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            });
        }
    }

    // Push to origin
    let output = create_command("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, branch = %branch, "Push to GitHub failed");
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!(branch = %branch, "Published to GitHub successfully");
    Ok(())
}

#[tauri::command]
#[instrument(name = "publish_to_staging", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_staging(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = commit_message.unwrap_or_else(|| "Update from Ship Studio".to_string());
    info!(message = %message, "Publishing to staging");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes
    let _ = git_stage_and_commit(&validated_path, &message);

    // Push to staging branch - Vercel auto-deploys via GitHub integration
    // Note: Using regular push instead of force push to avoid overwriting others' work
    let push_output = create_command("git")
        .args(["push", "-u", "origin", "HEAD:staging"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, "Push rejected - staging branch has diverged");
            // Retain the legacy PUSH_REJECTED sentinel so the frontend can
            // still discriminate this case via substring match.
            return Err(CommandError::Other { message: format!(
                "PUSH_REJECTED: Staging branch has diverged. Pull changes first or resolve conflicts.\n{stderr}"
            ) });
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, "Failed to push to staging");
            return Err(CommandError::Process {
                cmd: "git push staging".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!("Published to staging successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[tauri::command]
#[instrument(name = "publish_to_production", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_production(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = commit_message.unwrap_or_else(|| "Update from Ship Studio".to_string());
    info!(message = %message, "Publishing to production");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes
    let _ = git_stage_and_commit(&validated_path, &message);

    // Push to main branch - Vercel auto-deploys to production via GitHub integration
    let push_output = create_command("git")
        .args(["push", "-u", "origin", "HEAD:main"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, "Failed to push to production");
            return Err(CommandError::Process {
                cmd: "git push main".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!("Published to production successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

/// Publish (push) the current branch to origin
#[tauri::command]
#[instrument(name = "publish_branch", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_branch(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = commit_message.unwrap_or_else(|| "Updates from Ship Studio".to_string());

    // Get current branch name
    let branch_output = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    info!(branch = %branch, message = %message, "Publishing branch");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage all changes
    let _ = create_command("git")
        .args(["add", "-A"])
        .current_dir(&validated_path)
        .output();

    // Check if there are changes to commit
    let status = create_command("git")
        .args(["status", "--porcelain"])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    let has_changes = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if has_changes {
        // Commit changes
        let commit_output = create_command("git")
            .args(["commit", "-m", &message])
            .current_dir(&validated_path)
            .output()
            .map_err(CommandError::from)?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            return Err(CommandError::Process {
                cmd: "git commit".to_string(),
                exit_code: commit_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    // Push to origin
    let push_output = create_command("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&validated_path)
        .output()
        .map_err(CommandError::from)?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Check for common errors
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, branch = %branch, "Push rejected");
            return Err(CommandError::Other {
                message: format!("PUSH_REJECTED:{stderr}"),
            });
        }
        if stderr.contains("Permission denied") || stderr.contains("could not read Username") {
            error!(error = %stderr, branch = %branch, "Authentication error");
            return Err(CommandError::NotAuthenticated {
                service: format!("github (AUTH_ERROR: {stderr})"),
            });
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, branch = %branch, "Push failed");
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!(branch = %branch, "Branch published successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}
