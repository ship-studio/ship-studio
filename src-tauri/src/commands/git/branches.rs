//! Git branch management — list, create, delete, switch branches.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{BranchInfo, SwitchResult};
use crate::utils::{create_command, validate_project_path};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{debug, error, info, instrument, warn};

/// Timeout for git network operations (fetch, push). Matches git/sync.rs.
const GIT_NETWORK_TIMEOUT_SECS: u64 = 60;

/// Run a network-facing git command with a timeout.
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

/// Tracks the last time `git fetch` was run per project path.
/// Prevents redundant network I/O when the frontend polls `list_branches` frequently.
static LAST_FETCH: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Minimum interval between git fetch calls for the same project.
const FETCH_THROTTLE: Duration = Duration::from_secs(30);

use super::{
    get_ahead_behind_batch, get_current_branch_sync, git_has_any_changes, load_project_metadata,
    save_project_metadata,
};

/// List all branches (local and remote) with metadata
#[tauri::command]
#[instrument(name = "list_branches", skip(project_path), fields(project = %project_path))]
pub async fn list_branches(project_path: String) -> Result<Vec<BranchInfo>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    debug!("Listing branches");

    // Fetch all remotes in background (throttled to avoid redundant network I/O).
    // Non-blocking: branch listing proceeds immediately with local data.
    // Fetched remote data is available on the next list_branches call.
    let should_fetch = LAST_FETCH.lock().map_or(true, |map| {
        map.get(&project_path)
            .map_or(true, |t| t.elapsed() > FETCH_THROTTLE)
    });
    if should_fetch {
        // Mark as fetched immediately to prevent duplicate spawns
        if let Ok(mut map) = LAST_FETCH.lock() {
            map.insert(project_path.clone(), Instant::now());
        }
        let fetch_path = validated_path.clone();
        // Run fetch in a timed-out background task so a hung remote can't
        // leak a worker thread or pin connections forever.
        tokio::spawn(async move {
            let _ = run_git_net(
                &["fetch", "--all", "--prune"],
                &fetch_path,
                "fetch --all --prune",
            )
            .await;
        });
    }

    // Get all branches (local and remote)
    let output = create_command("git")
        .args(["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(committerdate:unix)|%(authorname)|%(HEAD)"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(("Failed to list branches".to_string()).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // First pass: collect branch metadata without ahead/behind
    struct BranchData {
        name: String,
        is_current: bool,
        is_remote: bool,
        last_commit_date: u64,
        last_commit_author: String,
    }
    let mut branch_data: Vec<BranchData> = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }

        let raw_name = parts[0].trim();
        if raw_name == "HEAD" || raw_name.contains("HEAD") || raw_name == "origin" {
            continue;
        }

        let (name, is_remote) = if raw_name.starts_with("origin/") {
            (
                raw_name
                    .strip_prefix("origin/")
                    .unwrap_or(raw_name)
                    .to_string(),
                true,
            )
        } else {
            (raw_name.to_string(), false)
        };

        if name.is_empty() || name == "origin" {
            continue;
        }

        if seen_names.contains(&name) {
            continue;
        }
        seen_names.insert(name.clone());

        branch_data.push(BranchData {
            name,
            is_current: parts[4].trim() == "*",
            is_remote,
            last_commit_date: parts[2].parse::<u64>().unwrap_or(0) * 1000,
            last_commit_author: parts[3].to_string(),
        });
    }

    // Batch ahead/behind in a single subprocess instead of one per branch
    let branch_names: Vec<&str> = branch_data.iter().map(|b| b.name.as_str()).collect();
    let ahead_behind = get_ahead_behind_batch(&validated_path, &branch_names, "origin/main");

    let mut branches: Vec<BranchInfo> = branch_data
        .into_iter()
        .map(|b| {
            let (ahead, behind) = ahead_behind.get(&b.name).copied().unwrap_or((0, 0));
            BranchInfo {
                is_default: b.name == "main" || b.name == "master",
                name: b.name,
                is_current: b.is_current,
                is_remote: b.is_remote,
                last_commit_date: b.last_commit_date,
                last_commit_author: b.last_commit_author,
                ahead_of_main: ahead,
                behind_main: behind,
            }
        })
        .collect();

    // Sort: current first, then default branches, then by last commit date (newest first)
    branches.sort_by(|a, b| {
        if a.is_current != b.is_current {
            return b.is_current.cmp(&a.is_current);
        }
        if a.is_default != b.is_default {
            return b.is_default.cmp(&a.is_default);
        }
        b.last_commit_date.cmp(&a.last_commit_date)
    });

    debug!(branch_count = branches.len(), "Branches listed");
    Ok(branches)
}

/// Get the current branch name
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_current_branch(project_path: String) -> Result<String, CommandError> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_current_branch(&project_path) {
        return Ok(cached);
    }

    let validated_path = validate_project_path(&project_path)?;

    let output = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(("Not a git repository".to_string()).into());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" {
        return Err(("Detached HEAD state".to_string()).into());
    }

    // Cache the result
    GIT_CACHE.set_current_branch(&project_path, branch.clone());

    Ok(branch)
}

/// Switch to a different branch
#[tauri::command]
#[instrument(name = "switch_branch", skip(project_path), fields(project = %project_path, target_branch = %branch_name))]
pub async fn switch_branch(
    project_path: String,
    branch_name: String,
    auto_stash: bool,
) -> Result<SwitchResult, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let mut stashed = false;
    let mut stash_applied = false;
    let mut pending_stash_from: Option<String> = None;

    // Get current branch name before switching
    let current_branch = get_current_branch_sync(&validated_path).unwrap_or_default();
    info!(from_branch = %current_branch, to_branch = %branch_name, auto_stash, "Switching branch");

    // Load project metadata to check for existing stash info
    let mut metadata = load_project_metadata(&validated_path);

    // Check for uncommitted changes
    let has_changes = git_has_any_changes(&validated_path)?;

    if has_changes && auto_stash {
        let stash_output = create_command("git")
            .args([
                "stash",
                "push",
                "-m",
                &format!("Auto-stash by Ship Studio (from {current_branch})"),
            ])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if stash_output.status.success() {
            let stdout = String::from_utf8_lossy(&stash_output.stdout);
            stashed = !stdout.contains("No local changes");

            // Save stash info to project metadata
            if stashed {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                metadata.stash_info = Some(crate::types::StashInfo {
                    from_branch: current_branch.clone(),
                    stashed_at: now,
                });
                if let Err(e) = save_project_metadata(&validated_path, &metadata) {
                    warn!("Failed to save stash metadata: {}", e);
                }
            }
        }
    } else if has_changes && !auto_stash {
        return Ok(SwitchResult {
            success: false,
            stashed_changes: false,
            pending_stash_from: None,
            stash_applied: false,
            error: Some("Uncommitted changes. Please stash or commit them first.".to_string()),
        });
    }

    // Try to checkout the branch
    let checkout_output = create_command("git")
        .args(["checkout", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        // Checkout failed - restore the stash if we made one
        if stashed {
            if let Err(e) = create_command("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output()
            {
                warn!("Failed to restore stash after checkout failure: {}", e);
            }

            // Clear stash info since we popped it
            metadata.stash_info = None;
            if let Err(e) = save_project_metadata(&validated_path, &metadata) {
                warn!("Failed to save project metadata after stash pop: {}", e);
            }
        }

        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Ok(SwitchResult {
            success: false,
            stashed_changes: false,
            pending_stash_from: None,
            stash_applied: false,
            error: Some(stderr.to_string()),
        });
    }

    // Checkout succeeded - check if we should auto-apply a stash
    // Reload metadata in case it was updated
    metadata = load_project_metadata(&validated_path);

    if let Some(ref stash_info) = metadata.stash_info {
        // If we're switching back to the branch where we stashed from, offer to apply
        if stash_info.from_branch == branch_name {
            // Try to auto-apply the stash
            let pop_output = create_command("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output();

            if let Ok(output) = pop_output {
                if output.status.success() {
                    stash_applied = true;
                    // Clear stash info
                    metadata.stash_info = None;
                    if let Err(e) = save_project_metadata(&validated_path, &metadata) {
                        warn!("Failed to save project metadata after stash apply: {}", e);
                    }
                } else {
                    // Stash pop failed (maybe conflicts) - let user know there's a pending stash
                    pending_stash_from = Some(stash_info.from_branch.clone());
                }
            }
        } else {
            // We have a stash but it's for a different branch - just note it
            pending_stash_from = Some(stash_info.from_branch.clone());
        }
    }

    // Pull latest changes from remote
    if let Err(e) = create_command("git")
        .args(["pull", "--ff-only"])
        .current_dir(&validated_path)
        .output()
    {
        warn!("Failed to pull latest changes after branch switch: {}", e);
    }

    // Touch next.config file to trigger Next.js full rebuild
    let config_files = ["next.config.js", "next.config.mjs", "next.config.ts"];
    for config in &config_files {
        let config_path = validated_path.join(config);
        if config_path.exists() {
            let _ = create_command("touch").arg(&config_path).output();
            break;
        }
    }

    // Invalidate all caches after branch switch
    GIT_CACHE.invalidate(&project_path);
    if let Ok(mut map) = LAST_FETCH.lock() {
        map.remove(&project_path);
    }

    info!(
        stashed_changes = stashed,
        stash_applied,
        pending_stash = pending_stash_from.is_some(),
        "Branch switch completed successfully"
    );

    Ok(SwitchResult {
        success: true,
        stashed_changes: stashed,
        pending_stash_from,
        stash_applied,
        error: None,
    })
}

/// Create a new branch from a base branch
#[tauri::command]
#[instrument(name = "create_branch", skip(project_path), fields(project = %project_path, branch = %branch_name, from = %from_branch))]
pub async fn create_branch(
    project_path: String,
    branch_name: String,
    from_branch: String,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    info!("Creating new branch");

    // Validate branch name
    if branch_name.contains(' ') || branch_name.contains("..") || branch_name.starts_with('-') {
        warn!(branch = %branch_name, "Invalid branch name");
        return Err(("Invalid branch name".to_string()).into());
    }

    // Get the current branch name
    let current_branch_output = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current_branch_output.stdout)
        .trim()
        .to_string();

    let is_from_current =
        from_branch == current_branch || from_branch == format!("origin/{current_branch}");

    if is_from_current {
        // Create branch from current HEAD (preserves local changes)
        let output = create_command("git")
            .args(["checkout", "-b", &branch_name])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err((stderr.to_string()).into());
        }
    } else {
        // Creating from a different branch - fetch and use origin
        let _ = run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await;

        let base_ref = if from_branch.starts_with("origin/") {
            from_branch
        } else {
            format!("origin/{from_branch}")
        };

        let output = create_command("git")
            .args(["checkout", "-b", &branch_name, &base_ref])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(error = %stderr, "Failed to create branch");
            return Err((stderr.to_string()).into());
        }
    }

    // Invalidate branch cache after creating a new branch
    GIT_CACHE.invalidate(&project_path);
    if let Ok(mut map) = LAST_FETCH.lock() {
        map.remove(&project_path);
    }

    info!("Branch created successfully");
    Ok(())
}

/// Delete a branch (local and optionally remote)
#[tauri::command]
#[instrument(name = "delete_branch", skip(project_path), fields(project = %project_path, branch = %branch_name))]
pub async fn delete_branch(
    project_path: String,
    branch_name: String,
    delete_remote: bool,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    info!(delete_remote, "Deleting branch");

    // Don't allow deleting main/master
    if branch_name == "main" || branch_name == "master" {
        warn!("Attempted to delete main branch");
        return Err(("Cannot delete the main branch".to_string()).into());
    }

    // Get current branch to make sure we're not on it
    let current = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current.stdout).trim().to_string();
    if current_branch == branch_name {
        return Err(
            "Cannot delete the current branch. Switch to another branch first."
                .to_string()
                .into(),
        );
    }

    // Delete local branch
    let local_output = create_command("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !local_output.status.success() {
        let stderr = String::from_utf8_lossy(&local_output.stderr);
        if !stderr.contains("not found") {
            return Err((stderr.to_string()).into());
        }
    }

    // Delete remote branch if requested
    if delete_remote {
        let remote_output = run_git_net(
            &["push", "origin", "--delete", &branch_name],
            &validated_path,
            "push origin --delete",
        )
        .await?;

        if !remote_output.status.success() {
            let stderr = String::from_utf8_lossy(&remote_output.stderr);
            if !stderr.contains("remote ref does not exist") {
                error!(error = %stderr, "Failed to delete remote branch");
                return Err((format!("Failed to delete remote branch: {stderr}")).into());
            }
        }
    }

    // Invalidate caches so next list_branches gets fresh data
    GIT_CACHE.invalidate(&project_path);
    if let Ok(mut map) = LAST_FETCH.lock() {
        map.remove(&project_path);
    }

    info!("Branch deleted successfully");
    Ok(())
}
