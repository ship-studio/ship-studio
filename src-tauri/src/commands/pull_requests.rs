//! # Pull Request Commands
//!
//! Commands for managing GitHub pull requests.

use crate::commands::github::get_gh_command_for_project;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::PullRequestInfo;
use crate::utils::{create_command, validate_project_path};

/// Timeout for network-facing CLI ops (gh/git) so a hung remote can't freeze a
/// PR command. Matches git/branches.rs.
const NETWORK_TIMEOUT_SECS: u64 = 60;

/// Run an already-configured network-facing command (gh/git) with a timeout,
/// replacing blocking `.output()` so a stalled remote can't hang the UI.
async fn run_net(
    cmd: std::process::Command,
    label: &str,
) -> Result<std::process::Output, CommandError> {
    run_with_timeout(
        tokio::process::Command::from(cmd),
        label.to_string(),
        NETWORK_TIMEOUT_SECS,
    )
    .await
}

/// List pull requests for the repository
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn list_pull_requests(
    project_path: String,
) -> Result<Vec<PullRequestInfo>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let mut cmd = get_gh_command_for_project(&validated_path);
    cmd.args([
        "pr",
        "list",
        "--json",
        "number,title,headRefName,baseRefName,author,state,mergeable,url,createdAt",
        "--limit",
        "20",
    ])
    .current_dir(&validated_path);
    let output = run_net(cmd, "gh pr list").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no pull requests") || stderr.contains("Could not") {
            return Ok(Vec::new());
        }
        return Err((stderr.to_string()).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse PR list: {e}"))?;

    let prs: Vec<PullRequestInfo> = json
        .iter()
        .filter_map(|pr| {
            Some(PullRequestInfo {
                number: pr.get("number")?.as_i64()? as i32,
                title: pr.get("title")?.as_str()?.to_string(),
                head_ref: pr.get("headRefName")?.as_str()?.to_string(),
                base_ref: pr.get("baseRefName")?.as_str()?.to_string(),
                author: pr.get("author")?.get("login")?.as_str()?.to_string(),
                state: pr.get("state")?.as_str()?.to_string(),
                mergeable: pr
                    .get("mergeable")
                    .and_then(|v| v.as_str())
                    .map(|s| s == "MERGEABLE"),
                url: pr.get("url")?.as_str()?.to_string(),
                created_at: pr.get("createdAt")?.as_str()?.to_string(),
            })
        })
        .collect();

    Ok(prs)
}

/// Create a new pull request.
/// Automatically pushes the branch to the remote first if needed.
#[tauri::command]
#[tracing::instrument(skip(project_path, title, body, base), fields(project = %project_path, base = %base))]
pub async fn create_pull_request(
    project_path: String,
    title: String,
    body: Option<String>,
    base: String,
) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Push the branch to the remote first (gh pr create requires this)
    let mut push_cmd = create_command("git");
    push_cmd
        .args(["push", "-u", "origin", "HEAD"])
        .envs(crate::commands::accounts::get_env_vars_for_project(
            &validated_path,
        ))
        .current_dir(&validated_path);
    let push_output = run_net(push_cmd, "git push").await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Ignore "everything up-to-date" which isn't a real error
        if !stderr.contains("Everything up-to-date") {
            return Err((format!("Failed to push branch: {stderr}")).into());
        }
    }

    let body_str = body.unwrap_or_default();
    let args = vec![
        "pr", "create", "--title", &title, "--body", &body_str, "--base", &base,
    ];

    let mut cmd = get_gh_command_for_project(&validated_path);
    cmd.args(&args).current_dir(&validated_path);
    let output = run_net(cmd, "gh pr create").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((stderr.to_string()).into());
    }

    // Output contains the PR URL
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(url)
}

/// Merge a pull request. Returns `CommandError::MergeConflict` when `gh`
/// reports the PR isn't mergeable so the frontend can render a conflict-
/// resolution flow without grepping the stderr for known phrases.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, pr = pr_number))]
pub async fn merge_pull_request(project_path: String, pr_number: i32) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let mut cmd = get_gh_command_for_project(&validated_path);
    cmd.args(["pr", "merge", &pr_number.to_string(), "--merge"])
        .current_dir(&validated_path);
    let output = run_net(cmd, "gh pr merge").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if is_conflict_stderr(&stderr) {
            return Err(CommandError::MergeConflict { pr_number, stderr });
        }
        return Err(stderr.into());
    }

    Ok(())
}

/// Match the stderr fragments `gh pr merge` emits when a PR can't be merged
/// cleanly. Kept narrow so unrelated failures still surface as Process/Other.
fn is_conflict_stderr(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("is not mergeable")
        || lower.contains("merge commit cannot be cleanly created")
        || lower.contains("merge conflicts")
}

/// Checkout a pull request branch locally for review
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, pr = pr_number))]
pub async fn checkout_pull_request(
    project_path: String,
    pr_number: i32,
) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let mut cmd = get_gh_command_for_project(&validated_path);
    cmd.args(["pr", "checkout", &pr_number.to_string()])
        .current_dir(&validated_path);
    let output = run_net(cmd, "gh pr checkout").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to checkout PR: {stderr}")).into());
    }

    // Return the branch name that was checked out
    let branch_output = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    Ok(branch)
}

/// Close a pull request without merging
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, pr = pr_number))]
pub async fn close_pull_request(project_path: String, pr_number: i32) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let mut cmd = get_gh_command_for_project(&validated_path);
    cmd.args(["pr", "close", &pr_number.to_string()])
        .current_dir(&validated_path);
    let output = run_net(cmd, "gh pr close").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to close PR: {stderr}")).into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// run_net must execute a network-facing command through the timeout path
    /// (the fix: blocking `.output()` replaced so a hung remote can't freeze PR
    /// commands). `git --version` is deterministic and needs no repo or remote.
    #[tokio::test]
    async fn run_net_executes_command_through_timeout() {
        let mut cmd = create_command("git");
        cmd.args(["--version"]);
        let out = run_net(cmd, "git --version")
            .await
            .expect("git --version should run within the timeout");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("git version"));
    }

    /// is_conflict_stderr gates the MergeConflict error path; keep its phrase
    /// matching honest so unrelated failures don't masquerade as conflicts.
    #[test]
    fn is_conflict_stderr_matches_only_conflict_phrases() {
        assert!(is_conflict_stderr("Pull request is not mergeable"));
        assert!(is_conflict_stderr("merge commit cannot be cleanly created"));
        assert!(!is_conflict_stderr("could not find pull request"));
    }
}
