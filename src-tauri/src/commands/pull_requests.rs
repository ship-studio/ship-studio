//! # Pull Request Commands
//!
//! Commands for managing GitHub pull requests.

use crate::commands::github::get_gh_command;
use crate::errors::CommandError;
use crate::types::PullRequestInfo;
use crate::utils::{create_command, validate_project_path};

/// List pull requests for the repository
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn list_pull_requests(
    project_path: String,
) -> Result<Vec<PullRequestInfo>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output = get_gh_command()
        .args([
            "pr",
            "list",
            "--json",
            "number,title,headRefName,baseRefName,author,state,mergeable,url,createdAt",
            "--limit",
            "20",
        ])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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
    let push_output = create_command("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| format!("Failed to push branch: {e}"))?;

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

    let output = get_gh_command()
        .args(&args)
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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

    let output = get_gh_command()
        .args(["pr", "merge", &pr_number.to_string(), "--merge"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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

    let output = get_gh_command()
        .args(["pr", "checkout", &pr_number.to_string()])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

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

    let output = get_gh_command()
        .args(["pr", "close", &pr_number.to_string()])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to close PR: {stderr}")).into());
    }

    Ok(())
}
