//! # Publishing Commands
//!
//! Commands for publishing to GitHub, staging, and production.

use crate::commands::ai::resolve_commit_message;
use crate::commands::git::git_stage_and_commit;
// Network git ops (pull/push) go through the workspace-scoped helper so a
// publish authenticates as the project's workspace GitHub login, matching the
// gh-based repo-create path.
use crate::commands::git::run_git_net;
use crate::commands::github::ensure_git_identity;
use crate::errors::CommandError;
use crate::types::PublishResult;
use crate::utils::validate_project_path;
use tracing::{debug, error, info, instrument, warn};

/// GitHub's push-time auth/permission rejections. The phrasing varies by
/// transport and failure mode: SSH's "Permission denied", the credential
/// helper's "could not read Username", HTTPS "Permission to <repo>.git denied
/// to <user>." (words split by the repo name — issue #321), and HTTPS
/// "remote: Write access to repository not granted." with a 403
/// (issue #343). All mean "reconnect GitHub or check your access", so all
/// map to NotAuthenticated instead of an opaque process error.
fn push_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let is_auth = stderr.contains("Permission denied")
        || stderr.contains("could not read Username")
        || (lower.contains("permission to") && lower.contains("denied to"))
        || lower.contains("write access to repository not granted");
    if is_auth {
        return Some(CommandError::NotAuthenticated {
            service: format!("github (AUTH_ERROR: {stderr})"),
        });
    }
    None
}

/// Push-time "the remote repo doesn't exist" rejections — the linked repo was
/// deleted, renamed, transferred, or made inaccessible outside the app.
/// Environment, not malfunction: telemetry-flooding this on every publish
/// attempt for a stale remote helps nobody (issue #435).
fn push_missing_remote_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let missing = lower.contains("repository not found")
        || (lower.contains("repository") && lower.contains("not found") && lower.contains("fatal"));
    missing.then(|| {
        CommandError::expected(
            "The linked GitHub repository couldn't be found — it may have been deleted, renamed,              or you may no longer have access. Check the repository on GitHub or reconnect it,              then try again.",
        )
    })
}

#[tauri::command]
#[instrument(name = "publish_to_github", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_github(
    project_path: String,
    commit_message: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to GitHub");

    // Get current branch name
    let branch_output = crate::utils::git_command_in(&validated_path)?
        .args(["branch", "--show-current"])
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
    let pull_output = run_git_net(
        &["pull", "--rebase", "origin", &branch],
        &validated_path,
        "pull --rebase",
    )
    .await;

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

    // Stage and commit through the shared helper: it retries sparse-checkout
    // refusals (issue #275) and treats an empty commit as a no-op instead of a
    // hard failure (issue #274), unlike the hand-rolled sequence it replaces.
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to origin
    let output = run_git_net(&["push", "-u", "origin", &branch], &validated_path, "push").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, branch = %branch, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
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
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to staging");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes. A real staging/commit failure must not be
    // swallowed — the push below would silently deploy stale code (benign cases
    // like "nothing to commit" and sparse-checkout are handled in the helper).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to staging branch - Vercel auto-deploys via GitHub integration
    // Note: Using regular push instead of force push to avoid overwriting others' work
    let push_output = run_git_net(
        &["push", "-u", "origin", "HEAD:staging"],
        &validated_path,
        "push staging",
    )
    .await?;

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
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
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
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to production");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes (real failures propagate — see staging).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to main branch - Vercel auto-deploys to production via GitHub integration
    let push_output = run_git_net(
        &["push", "-u", "origin", "HEAD:main"],
        &validated_path,
        "push main",
    )
    .await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
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
    let message = resolve_commit_message(&validated_path, commit_message).await;

    // Get current branch name
    let branch_output = crate::utils::git_command_in(&validated_path)?
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(CommandError::from)?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    info!(branch = %branch, message = %message, "Publishing branch");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit through the shared helper. The old hand-rolled sequence
    // discarded `git add -A`'s result entirely, so a staging failure surfaced
    // later as an inexplicable "Uncommitted changes" on switch (issue #273);
    // the helper also handles sparse-checkout (#275) and empty commits (#274).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to origin
    let push_output =
        run_git_net(&["push", "-u", "origin", &branch], &validated_path, "push").await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Check for common errors
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, branch = %branch, "Push rejected");
            return Err(CommandError::Other {
                message: format!("PUSH_REJECTED:{stderr}"),
            });
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, branch = %branch, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
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

#[cfg(test)]
mod tests {
    use crate::commands::git::run_git_net;
    use std::path::Path;

    /// The network git helper must actually execute git through the timeout path
    /// (the whole point of A8 — replacing blocking `.output()` so a hung remote
    /// can't freeze publishing). `--version` needs no repo or remote, so this is
    /// deterministic and guards the `create_command` + `run_with_timeout` wiring.
    #[tokio::test]
    async fn run_git_net_executes_git_through_timeout() {
        let out = run_git_net(&["--version"], Path::new("."), "--version")
            .await
            .expect("git --version should run within the timeout");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("git version"));
    }
}
