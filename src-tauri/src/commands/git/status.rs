//! Git status and diff commands — change detection, file diffs, branch status.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{BranchStatus, ChangedFile};
use crate::utils::{create_command, validate_project_path};
use std::path::Path;
use tracing::warn;

/// Timeout for git network operations (fetch). Keeps UI snappy if the remote hangs.
const GIT_NETWORK_TIMEOUT_SECS: u64 = 60;

async fn run_git_net(
    args: &[&str],
    cwd: &Path,
    label: &str,
) -> Result<std::process::Output, CommandError> {
    let mut cmd = create_command("git");
    cmd.args(args).current_dir(cwd);
    let tokio_cmd = tokio::process::Command::from(cmd);
    run_with_timeout(tokio_cmd, format!("git {label}"), GIT_NETWORK_TIMEOUT_SECS).await
}

use super::git_has_uncommitted_changes;

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn check_git_has_changes(project_path: String) -> Result<bool, CommandError> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_has_changes(&project_path) {
        return Ok(cached);
    }

    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    // Not a git repo = no changes to track
    if !git_dir.exists() {
        return Ok(false);
    }

    // Check for uncommitted changes (staged or unstaged tracked files only)
    if git_has_uncommitted_changes(&project)? {
        GIT_CACHE.set_has_changes(&project_path, true);
        return Ok(true);
    }

    // Check for unpushed commits
    let unpushed = create_command("git")
        .args(["--no-pager", "log", "@{u}..", "--oneline"])
        .current_dir(&project)
        .output();

    let result = match unpushed {
        Ok(output) => {
            let has_unpushed = !String::from_utf8_lossy(&output.stdout).trim().is_empty();
            Ok(has_unpushed)
        }
        Err(_) => {
            // No upstream set, check if we have commits
            let commits = create_command("git")
                .args(["--no-pager", "log", "--oneline", "-1"])
                .current_dir(&project)
                .output()
                .map_err(|e| e.to_string())?;

            Ok(!String::from_utf8_lossy(&commits.stdout).trim().is_empty())
        }
    };

    // Cache the result
    if let Ok(has_changes) = result {
        GIT_CACHE.set_has_changes(&project_path, has_changes);
    }

    result
}

/// Get list of files with uncommitted changes (staged and unstaged, tracked files only)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_changed_files(project_path: String) -> Result<Vec<ChangedFile>, CommandError> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_changed_files(&project_path) {
        return Ok(cached);
    }

    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    // Not a git repo = no changed files
    if !git_dir.exists() {
        return Ok(vec![]);
    }

    // Run git status --porcelain (include untracked files)
    let output = create_command("git")
        .args(["status", "--porcelain"])
        .current_dir(&project)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(("Failed to get git status".to_string()).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<ChangedFile> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }

        // Git status --porcelain format: XY filename
        // X = status in staging area, Y = status in working tree
        let status_chars = &line[0..2];
        let path = line[3..].trim().to_string();

        // Skip empty paths
        if path.is_empty() {
            continue;
        }

        // Determine the status based on git status codes
        let status = match status_chars.chars().collect::<Vec<char>>().as_slice() {
            ['?', '?'] => "untracked",
            ['D', _] | [_, 'D'] => "deleted",
            ['A', _] | [_, 'A'] => "added",
            ['R', _] | [_, 'R'] => "renamed",
            _ => "modified",
        };

        files.push(ChangedFile {
            path,
            status: status.to_string(),
        });
    }

    // Cache the result
    GIT_CACHE.set_changed_files(&project_path, files.clone());

    Ok(files)
}

/// Get the diff for a single uncommitted file
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_file_diff(
    project_path: String,
    file_path: String,
) -> Result<crate::types::FileDiff, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Run git diff HEAD -- <filepath> to get all uncommitted changes
    let output = create_command("git")
        .args(["diff", "HEAD", "--", &file_path])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let diff_content = String::from_utf8_lossy(&output.stdout).to_string();

    // If diff is empty, the file might be untracked (new file)
    if diff_content.trim().is_empty() {
        // Check if file is untracked
        let status_output = create_command("git")
            .args(["status", "--porcelain", "--", &file_path])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        let status = String::from_utf8_lossy(&status_output.stdout);

        // If status starts with "??" or "A ", it's a new file
        if status.starts_with("??") || status.starts_with("A ") {
            // Read the file content and return as all additions
            let full_path = validated_path.join(&file_path);
            let content = std::fs::read_to_string(&full_path)
                .map_err(|e| format!("Failed to read file: {e}"))?;

            let line_count = content.lines().count() as u32;

            return Ok(crate::types::FileDiff {
                file_path,
                is_new_file: true,
                is_deleted: false,
                is_binary: false,
                content,
                additions: line_count,
                deletions: 0,
            });
        }
    }

    // Check if file was deleted
    let is_deleted = diff_content.contains("deleted file mode");

    // Check if binary file
    let is_binary = diff_content.contains("Binary files");

    // Count additions and deletions
    let additions = diff_content
        .lines()
        .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
        .count() as u32;
    let deletions = diff_content
        .lines()
        .filter(|l| l.starts_with('-') && !l.starts_with("---"))
        .count() as u32;

    Ok(crate::types::FileDiff {
        file_path,
        is_new_file: false,
        is_deleted,
        is_binary,
        content: diff_content,
        additions,
        deletions,
    })
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_branch_status(project_path: String) -> Result<BranchStatus, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Check for local changes (tracked files only)
    let local_changes = git_has_uncommitted_changes(&validated_path)?;

    // Fetch latest from origin (log errors but don't fail)
    match run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Don't log if it's just a network issue or no remote
            if !stderr.contains("Could not resolve host")
                && !stderr.contains("Could not read from remote")
            {
                warn!(error = %stderr, "git fetch failed");
            }
        }
        Err(e) => {
            warn!(error = %e, "git fetch failed/timed out");
        }
        _ => {}
    }

    // Check if staging branch exists on remote
    let staging_check = create_command("git")
        .args(["ls-remote", "--heads", "origin", "staging"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let staging_exists = !String::from_utf8_lossy(&staging_check.stdout)
        .trim()
        .is_empty();

    // Get commits ahead/behind for staging
    let (staging_ahead, staging_behind) = if staging_exists {
        let output = create_command("git")
            .args([
                "rev-list",
                "--left-right",
                "--count",
                "HEAD...origin/staging",
            ])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    // Get commits ahead/behind for main
    let output = create_command("git")
        .args(["rev-list", "--left-right", "--count", "HEAD...origin/main"])
        .current_dir(&validated_path)
        .output();

    let (main_ahead, main_behind) = if let Ok(output) = output {
        let counts = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = counts.trim().split('\t').collect();
        if parts.len() == 2 {
            (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Ok(BranchStatus {
        local_changes,
        staging_ahead,
        staging_behind,
        main_ahead,
        main_behind,
        staging_exists,
    })
}

/// Reset local changes to match a remote branch (staging or main/production)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn reset_to_branch(project_path: String, branch: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let remote_branch = match branch.as_str() {
        "staging" => "origin/staging",
        "production" | "main" => "origin/main",
        _ => return Err(("Invalid branch. Use 'staging' or 'production'.".to_string()).into()),
    };

    // Fetch latest from remote first
    let fetch = run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await?;

    if !fetch.status.success() {
        return Err("Failed to fetch from remote".to_string().into());
    }

    // Reset hard to the remote branch
    let reset = create_command("git")
        .args(["reset", "--hard", remote_branch])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !reset.status.success() {
        let stderr = String::from_utf8_lossy(&reset.stderr);
        return Err((format!("Failed to reset: {stderr}")).into());
    }

    // Clean untracked files
    let clean = create_command("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean.status.success() {
        warn!("git clean failed during reset");
    }

    Ok(())
}
