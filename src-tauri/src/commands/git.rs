//! # Git Commands
//!
//! Commands for Git operations, branch management, and repository management.

use crate::cache::GIT_CACHE;
use crate::types::{BranchInfo, BranchStatus, ChangedFile, PrerequisiteCheck, SwitchResult};
use crate::utils::{find_executable, validate_project_path};
use std::process::Command;
use tracing::{debug, error, info, instrument, warn};

// ============ Git Helper Functions ============

/// Checks if there are uncommitted changes (staged or unstaged tracked files).
pub fn git_has_uncommitted_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Checks if there are any changes (including untracked) in the working directory.
pub fn git_has_any_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Stages all changes and commits with the given message.
/// Returns true if a commit was made, false if nothing to commit.
pub fn git_stage_and_commit(path: &std::path::Path, message: &str) -> Result<bool, String> {
    // Stage all changes
    let add_output = Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if !add_output.status.success() {
        return Err(String::from_utf8_lossy(&add_output.stderr).to_string());
    }

    // Check if there are staged changes to commit
    let has_changes = git_has_any_changes(path)?;

    if !has_changes {
        return Ok(false);
    }

    // Commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if !commit_output.status.success() {
        return Err(String::from_utf8_lossy(&commit_output.stderr).to_string());
    }

    Ok(true)
}

/// Get the current branch name synchronously (for internal use)
pub fn get_current_branch_sync(path: &std::path::Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" || branch.is_empty() {
        return None;
    }

    Some(branch)
}

/// Calculates how many commits `branch` is ahead/behind compared to `compare_to`.
pub fn get_ahead_behind(path: &std::path::Path, branch: &str, compare_to: &str) -> (i32, i32) {
    let output = Command::new("git")
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{}...{}", branch, compare_to),
        ])
        .current_dir(path)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let counts = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = counts.trim().split('\t').collect();
            if parts.len() == 2 {
                (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    }
}

// ============ Tauri Commands ============

/// Checks if required tools (node, npm, git, gh, vercel, claude) are installed.
#[tauri::command]
#[instrument(name = "check_prerequisites")]
pub async fn check_prerequisites() -> Vec<PrerequisiteCheck> {
    let commands = vec!["node", "npm", "git", "gh", "vercel", "claude"];
    let mut results = Vec::new();

    for cmd in commands {
        let (available, path) = match find_executable(cmd) {
            Some(p) => (true, Some(p.to_string_lossy().to_string())),
            None => (false, None),
        };
        debug!(command = cmd, available, "Prerequisite check");
        results.push(PrerequisiteCheck {
            name: cmd.to_string(),
            available,
            path,
        });
    }

    info!(
        total = results.len(),
        available = results.iter().filter(|r| r.available).count(),
        "Prerequisites checked"
    );
    results
}

/// Returns the path to ~/ShipStudio directory
#[tauri::command]
pub async fn get_shipstudio_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");
    Ok(shipstudio_dir.to_string_lossy().to_string())
}

/// Creates ~/ShipStudio directory if it doesn't exist
#[tauri::command]
pub async fn ensure_shipstudio_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| e.to_string())?;
    }

    Ok(shipstudio_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[instrument(name = "init_git_repo", skip(project_path), fields(project = %project_path))]
pub async fn init_git_repo(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    info!("Initializing git repository");

    // Initialize git repo
    let output = Command::new("git")
        .args(["init"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| {
            error!(error = %e, "Failed to execute git init");
            e.to_string()
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        error!(error = %stderr, "git init failed");
        return Err(stderr);
    }

    // Stage and commit all files
    git_stage_and_commit(&validated_path, "Initial commit from Ship Studio")?;

    info!("Git repository initialized successfully");
    Ok(())
}

#[tauri::command]
pub async fn check_git_has_changes(project_path: String) -> Result<bool, String> {
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
    let unpushed = Command::new("git")
        .args(["log", "@{u}..", "--oneline"])
        .current_dir(&project)
        .output();

    let result = match unpushed {
        Ok(output) => {
            let has_unpushed = !String::from_utf8_lossy(&output.stdout).trim().is_empty();
            Ok(has_unpushed)
        }
        Err(_) => {
            // No upstream set, check if we have commits
            let commits = Command::new("git")
                .args(["log", "--oneline", "-1"])
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
pub async fn get_changed_files(project_path: String) -> Result<Vec<ChangedFile>, String> {
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

    // Run git status --porcelain -uno (exclude untracked files)
    let output = Command::new("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(&project)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to get git status".to_string());
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

#[tauri::command]
pub async fn get_branch_status(project_path: String) -> Result<BranchStatus, String> {
    let validated_path = validate_project_path(&project_path)?;

    // Check for local changes (tracked files only)
    let local_changes = git_has_uncommitted_changes(&validated_path)?;

    // Fetch latest from origin (log errors but don't fail)
    match Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output()
    {
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
            warn!(error = %e, "Failed to execute git fetch");
        }
        _ => {}
    }

    // Check if staging branch exists on remote
    let staging_check = Command::new("git")
        .args(["ls-remote", "--heads", "origin", "staging"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let staging_exists = !String::from_utf8_lossy(&staging_check.stdout)
        .trim()
        .is_empty();

    // Get commits ahead/behind for staging
    let (staging_ahead, staging_behind) = if staging_exists {
        let output = Command::new("git")
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
    let output = Command::new("git")
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
pub async fn reset_to_branch(project_path: String, branch: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let remote_branch = match branch.as_str() {
        "staging" => "origin/staging",
        "production" | "main" => "origin/main",
        _ => return Err("Invalid branch. Use 'staging' or 'production'.".to_string()),
    };

    // Fetch latest from remote first
    let fetch = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !fetch.status.success() {
        return Err("Failed to fetch from remote".to_string());
    }

    // Reset hard to the remote branch
    let reset = Command::new("git")
        .args(["reset", "--hard", remote_branch])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !reset.status.success() {
        let stderr = String::from_utf8_lossy(&reset.stderr);
        return Err(format!("Failed to reset: {}", stderr));
    }

    // Clean untracked files
    let clean = Command::new("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean.status.success() {
        warn!("git clean failed during reset");
    }

    Ok(())
}

/// List all branches (local and remote) with metadata
#[tauri::command]
#[instrument(name = "list_branches", skip(project_path), fields(project = %project_path))]
pub async fn list_branches(project_path: String) -> Result<Vec<BranchInfo>, String> {
    let validated_path = validate_project_path(&project_path)?;
    debug!("Listing branches");

    // Fetch all remotes first
    let _ = Command::new("git")
        .args(["fetch", "--all", "--prune"])
        .current_dir(&validated_path)
        .output();

    // Get all branches (local and remote)
    let output = Command::new("git")
        .args(["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(committerdate:unix)|%(authorname)|%(HEAD)"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Failed to list branches".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<BranchInfo> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

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

        let is_current = parts[4].trim() == "*";
        let commit_date = parts[2].parse::<u64>().unwrap_or(0) * 1000;
        let author = parts[3].to_string();
        let is_default = name == "main" || name == "master";

        let (ahead, behind) = get_ahead_behind(&validated_path, &name, "origin/main");

        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
            is_default,
            last_commit_date: commit_date,
            last_commit_author: author,
            ahead_of_main: ahead,
            behind_main: behind,
        });
    }

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
pub async fn get_current_branch(project_path: String) -> Result<String, String> {
    // Check cache first
    if let Some(cached) = GIT_CACHE.get_current_branch(&project_path) {
        return Ok(cached);
    }

    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" {
        return Err("Detached HEAD state".to_string());
    }

    // Cache the result
    GIT_CACHE.set_current_branch(&project_path, branch.clone());

    Ok(branch)
}

/// Helper to load project metadata with automatic schema migration
fn load_project_metadata(project_path: &std::path::Path) -> crate::types::ProjectMetadata {
    let metadata_path = project_path.join(".shipstudio/project.json");
    let mut metadata: crate::types::ProjectMetadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        let _ = save_project_metadata(project_path, &metadata);
    }

    metadata
}

/// Helper to save project metadata
fn save_project_metadata(
    project_path: &std::path::Path,
    metadata: &crate::types::ProjectMetadata,
) -> Result<(), String> {
    let shipstudio_dir = project_path.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| e.to_string())?;
    }
    let metadata_path = shipstudio_dir.join("project.json");
    let json = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    std::fs::write(&metadata_path, json).map_err(|e| e.to_string())
}

/// Switch to a different branch
#[tauri::command]
#[instrument(name = "switch_branch", skip(project_path), fields(project = %project_path, target_branch = %branch_name))]
pub async fn switch_branch(
    project_path: String,
    branch_name: String,
    auto_stash: bool,
) -> Result<SwitchResult, String> {
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
        let stash_output = Command::new("git")
            .args([
                "stash",
                "push",
                "-m",
                &format!("Auto-stash by Ship Studio (from {})", current_branch),
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
                let _ = save_project_metadata(&validated_path, &metadata);
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
    let checkout_output = Command::new("git")
        .args(["checkout", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        // Checkout failed - restore the stash if we made one
        if stashed {
            let _ = Command::new("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output();

            // Clear stash info since we popped it
            metadata.stash_info = None;
            let _ = save_project_metadata(&validated_path, &metadata);
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
            let pop_output = Command::new("git")
                .args(["stash", "pop"])
                .current_dir(&validated_path)
                .output();

            if let Ok(output) = pop_output {
                if output.status.success() {
                    stash_applied = true;
                    // Clear stash info
                    metadata.stash_info = None;
                    let _ = save_project_metadata(&validated_path, &metadata);
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
    let _ = Command::new("git")
        .args(["pull", "--ff-only"])
        .current_dir(&validated_path)
        .output();

    // Touch next.config file to trigger Next.js full rebuild
    let config_files = ["next.config.js", "next.config.mjs", "next.config.ts"];
    for config in &config_files {
        let config_path = validated_path.join(config);
        if config_path.exists() {
            let _ = Command::new("touch").arg(&config_path).output();
            break;
        }
    }

    // Invalidate all caches after branch switch
    GIT_CACHE.invalidate(&project_path);

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

/// Get stash info for a project (if any auto-stash exists)
#[tauri::command]
pub async fn get_stash_info(
    project_path: String,
) -> Result<Option<crate::types::StashInfo>, String> {
    let validated_path = validate_project_path(&project_path)?;
    let metadata = load_project_metadata(&validated_path);
    Ok(metadata.stash_info)
}

/// Manually apply and clear the auto-stash
#[tauri::command]
pub async fn apply_stash(project_path: String) -> Result<bool, String> {
    let validated_path = validate_project_path(&project_path)?;

    let pop_output = Command::new("git")
        .args(["stash", "pop"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if pop_output.status.success() {
        // Clear stash info from metadata
        let mut metadata = load_project_metadata(&validated_path);
        metadata.stash_info = None;
        let _ = save_project_metadata(&validated_path, &metadata);
        // Invalidate status cache after applying stash
        GIT_CACHE.invalidate_status(&project_path);
        Ok(true)
    } else {
        let stderr = String::from_utf8_lossy(&pop_output.stderr);
        Err(format!("Failed to apply stash: {}", stderr))
    }
}

/// Drop the auto-stash without applying
#[tauri::command]
pub async fn drop_stash(project_path: String) -> Result<bool, String> {
    let validated_path = validate_project_path(&project_path)?;

    let drop_output = Command::new("git")
        .args(["stash", "drop"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    // Clear stash info from metadata regardless of drop success
    let mut metadata = load_project_metadata(&validated_path);
    metadata.stash_info = None;
    let _ = save_project_metadata(&validated_path, &metadata);

    if drop_output.status.success() {
        Ok(true)
    } else {
        // Stash might already be gone, still clear metadata
        Ok(false)
    }
}

/// Discard all uncommitted changes in the working directory
#[tauri::command]
pub async fn discard_changes(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // Discard changes to tracked files
    let checkout_output = Command::new("git")
        .args(["checkout", "."])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err(format!("Failed to discard changes: {}", stderr));
    }

    // Remove untracked files
    let clean_output = Command::new("git")
        .args(["clean", "-fd"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr);
        return Err(format!("Failed to clean untracked files: {}", stderr));
    }

    // Invalidate status caches after discarding changes
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Create a new branch from a base branch
#[tauri::command]
#[instrument(name = "create_branch", skip(project_path), fields(project = %project_path, branch = %branch_name, from = %from_branch))]
pub async fn create_branch(
    project_path: String,
    branch_name: String,
    from_branch: String,
) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    info!("Creating new branch");

    // Validate branch name
    if branch_name.contains(' ') || branch_name.contains("..") || branch_name.starts_with('-') {
        warn!(branch = %branch_name, "Invalid branch name");
        return Err("Invalid branch name".to_string());
    }

    // Get the current branch name
    let current_branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current_branch_output.stdout)
        .trim()
        .to_string();

    let is_from_current =
        from_branch == current_branch || from_branch == format!("origin/{}", current_branch);

    if is_from_current {
        // Create branch from current HEAD (preserves local changes)
        let output = Command::new("git")
            .args(["checkout", "-b", &branch_name])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.to_string());
        }
    } else {
        // Creating from a different branch - fetch and use origin
        let _ = Command::new("git")
            .args(["fetch", "origin"])
            .current_dir(&validated_path)
            .output();

        let base_ref = if from_branch.starts_with("origin/") {
            from_branch
        } else {
            format!("origin/{}", from_branch)
        };

        let output = Command::new("git")
            .args(["checkout", "-b", &branch_name, &base_ref])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(error = %stderr, "Failed to create branch");
            return Err(stderr.to_string());
        }
    }

    // Invalidate branch cache after creating a new branch
    GIT_CACHE.invalidate(&project_path);

    info!("Branch created successfully");
    Ok(())
}

/// Fetch all branches from remotes
#[tauri::command]
pub async fn fetch_all_branches(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["fetch", "--all", "--prune"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to fetch: {}", stderr));
    }

    Ok(())
}

/// Pull latest changes from remote for current branch
#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    let output = Command::new("git")
        .args(["pull", "--ff-only"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to pull: {}", stderr));
    }

    // Invalidate status cache after pull
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Pull remote changes and merge (may result in conflicts)
#[tauri::command]
pub async fn pull_and_merge(
    project_path: String,
    merge_branch: Option<String>,
) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;

    // First fetch to ensure we have latest refs
    let _ = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(&validated_path)
        .output();

    let output = if let Some(branch) = merge_branch {
        Command::new("git")
            .args(["merge", &format!("origin/{}", branch)])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?
    } else {
        Command::new("git")
            .args(["pull", "--no-rebase"])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    // Check for merge conflicts
    if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
        return Err(format!("MERGE_CONFLICT:{}", combined));
    }

    if !output.status.success() {
        return Err(format!("Failed to merge: {}", stderr));
    }

    Ok(())
}

/// Delete a branch (local and optionally remote)
#[tauri::command]
#[instrument(name = "delete_branch", skip(project_path), fields(project = %project_path, branch = %branch_name))]
pub async fn delete_branch(
    project_path: String,
    branch_name: String,
    delete_remote: bool,
) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    info!(delete_remote, "Deleting branch");

    // Don't allow deleting main/master
    if branch_name == "main" || branch_name == "master" {
        warn!("Attempted to delete main branch");
        return Err("Cannot delete the main branch".to_string());
    }

    // Get current branch to make sure we're not on it
    let current = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    let current_branch = String::from_utf8_lossy(&current.stdout).trim().to_string();
    if current_branch == branch_name {
        return Err(
            "Cannot delete the current branch. Switch to another branch first.".to_string(),
        );
    }

    // Delete local branch
    let local_output = Command::new("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(&validated_path)
        .output()
        .map_err(|e| e.to_string())?;

    if !local_output.status.success() {
        let stderr = String::from_utf8_lossy(&local_output.stderr);
        if !stderr.contains("not found") {
            return Err(stderr.to_string());
        }
    }

    // Delete remote branch if requested
    if delete_remote {
        let remote_output = Command::new("git")
            .args(["push", "origin", "--delete", &branch_name])
            .current_dir(&validated_path)
            .output()
            .map_err(|e| e.to_string())?;

        if !remote_output.status.success() {
            let stderr = String::from_utf8_lossy(&remote_output.stderr);
            if !stderr.contains("remote ref does not exist") {
                error!(error = %stderr, "Failed to delete remote branch");
                return Err(format!("Failed to delete remote branch: {}", stderr));
            }
        }
    }

    info!("Branch deleted successfully");
    Ok(())
}
