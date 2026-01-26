//! # Pull Request Commands
//!
//! Commands for managing GitHub pull requests.

use crate::commands::github::get_gh_command;
use crate::types::PullRequestInfo;
use crate::utils::validate_project_path;

/// List pull requests for the repository
#[tauri::command]
pub async fn list_pull_requests(project_path: String) -> Result<Vec<PullRequestInfo>, String> {
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
        return Err(stderr.to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse PR list: {}", e))?;

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

/// Create a new pull request
#[tauri::command]
pub async fn create_pull_request(
    project_path: String,
    title: String,
    body: Option<String>,
    base: String,
) -> Result<String, String> {
    let validated_path = validate_project_path(&project_path)?;

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
        return Err(stderr.to_string());
    }

    // Output contains the PR URL
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(url)
}

/// Merge a pull request
#[tauri::command]
pub async fn merge_pull_request(project_path: String, pr_number: i32) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = get_gh_command()
        .args(["pr", "merge", &pr_number.to_string(), "--merge"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    Ok(())
}
