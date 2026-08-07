//! Git branch management — list, create, delete, switch branches.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::types::{BranchInfo, SwitchResult};
use crate::utils::{create_command, validate_project_path};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{debug, error, info, instrument, warn};

// Network git ops (fetch, push --delete) go through the workspace-scoped helper
// in the parent module so they authenticate as the project's workspace login.
use super::run_git_net;

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

    // Get all branches (local and remote). Labeled + EAGAIN-retried: this is
    // polled frequently, so a transient spawn failure used to reach telemetry
    // as a bare "os error 35" with no call-site context (issue #555).
    let mut branch_cmd = crate::utils::git_command_in(&validated_path)?;
    branch_cmd.args(["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(committerdate:unix)|%(authorname)|%(HEAD)"]);
    let output =
        crate::external_command::spawn_with_pressure_retry("git branch -a", || branch_cmd.output())?;

    if !output.status.success() {
        // Include git's stderr — a bare "Failed to list branches" is
        // undiagnosable from telemetry (issue #252).
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to list branches: {}", stderr.trim())).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Names that have a remote-tracking ref (origin/<name>) — i.e. published to
    // GitHub. Collected across all lines so a local branch knows whether its
    // remote counterpart exists.
    let mut remote_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in stdout.lines() {
        let raw = line.split('|').next().unwrap_or("").trim();
        if let Some(name) = raw.strip_prefix("origin/") {
            if !name.is_empty() && name != "HEAD" {
                remote_names.insert(name.to_string());
            }
        }
    }

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
            // Published if it's a remote branch itself, or a local branch with a
            // matching origin/<name> ref.
            let pushed = b.is_remote || remote_names.contains(&b.name);
            BranchInfo {
                is_default: b.name == "main" || b.name == "master",
                name: b.name,
                is_current: b.is_current,
                is_remote: b.is_remote,
                last_commit_date: b.last_commit_date,
                last_commit_author: b.last_commit_author,
                ahead_of_main: ahead,
                behind_main: behind,
                pushed,
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

    let mut head_cmd = crate::utils::git_command_in(&validated_path)?;
    head_cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let output =
        crate::external_command::spawn_with_pressure_retry("git rev-parse", || head_cmd.output())?;

    if !output.status.success() {
        return Err(("Not a git repository".to_string()).into());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" {
        // A normal git state (checked-out tag/commit, mid-rebase), not a
        // malfunction — every caller already treats it as recoverable, so
        // keep it out of telemetry (issue #317).
        return Err(crate::errors::CommandError::expected("Detached HEAD state"));
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
    // Reject ref names that could be parsed by git as an option (argument
    // injection) — same guard create_branch already applies.
    if branch_name.starts_with('-') || branch_name.contains("..") {
        return Err(("Invalid branch name".to_string()).into());
    }
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
        let mut stash_cmd = crate::utils::git_command_in(&validated_path)?;
        stash_cmd.args([
            "stash",
            "push",
            "-m",
            &format!("Auto-stash by Ship Studio (from {current_branch})"),
        ]);
        let stash_output = crate::external_command::spawn_with_pressure_retry(
            "git stash push",
            || stash_cmd.output(),
        )?;

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
    let mut checkout_cmd = crate::utils::git_command_in(&validated_path)?;
    checkout_cmd.args(["checkout", "--end-of-options", &branch_name]);
    let checkout_output = crate::external_command::spawn_with_pressure_retry("git checkout", || {
        checkout_cmd.output()
    })?;

    if !checkout_output.status.success() {
        // Checkout failed - restore the stash if we made one
        if stashed {
            if let Err(e) = crate::utils::git_command_in(&validated_path)?
                .args(["stash", "pop"])
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
        // Pre-2.24 git doesn't understand the `--end-of-options` injection
        // guard and fails resolving it as a pathspec — turn that confusing
        // two-line error into a clear "your git is too old" (issue #364).
        let error_message = if stderr.contains("pathspec '--end-of-options'") {
            // Remediation must match the OS the app is running on — telling a
            // Windows user to `brew install git` is a dead end (issue #513).
            let remediation = if cfg!(target_os = "windows") {
                "run `winget install --id Git.Git` or download the installer from \
                 git-scm.com/download/win"
            } else if cfg!(target_os = "linux") {
                "install it with your distribution's package manager (e.g. `apt install git`, \
                 `dnf install git`, or `pacman -S git`)"
            } else {
                "update the Xcode Command Line Tools or run `brew install git`"
            };
            format!(
                "Your installed Git is too old for Ship Studio (Git 2.24 from 2019 or newer \
                 is required). Update Git — {remediation} — then try again."
            )
        } else if stderr.contains("resolve your current index first")
            || stderr.contains("needs merge")
        {
            // An abandoned merge left unmerged entries in the index — the
            // conflict-resolution flow deliberately leaves git mid-merge, and
            // closing it without finishing strands the repo there. Git's raw
            // "you need to resolve your current index first" says nothing a
            // user can act on (issue #417).
            "A merge with unresolved conflicts is still in progress in this project. Finish \
             resolving the conflicts (or discard the merge) before switching branches — the \
             Resolve Conflicts flow will pick up where it left off."
                .to_string()
        } else {
            stderr.to_string()
        };
        return Ok(SwitchResult {
            success: false,
            stashed_changes: false,
            pending_stash_from: None,
            stash_applied: false,
            error: Some(error_message),
        });
    }

    // Checkout succeeded - check if we should auto-apply a stash
    // Reload metadata in case it was updated
    metadata = load_project_metadata(&validated_path);

    if let Some(ref stash_info) = metadata.stash_info {
        // If we're switching back to the branch where we stashed from, offer to apply
        if stash_info.from_branch == branch_name {
            // Try to auto-apply the stash
            let pop_output = crate::utils::git_command_in(&validated_path)?
                .args(["stash", "pop"])
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
    if let Err(e) = crate::utils::git_command_in(&validated_path)?
        .args(["pull", "--ff-only"])
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
    let mut head_cmd = crate::utils::git_command_in(&validated_path)?;
    head_cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let current_branch_output =
        crate::external_command::spawn_with_pressure_retry("git rev-parse", || head_cmd.output())?;

    let current_branch = String::from_utf8_lossy(&current_branch_output.stdout)
        .trim()
        .to_string();

    let is_from_current =
        from_branch == current_branch || from_branch == format!("origin/{current_branch}");

    // Capture the plain base name (strip any `origin/` prefix) before the checkout
    // logic below moves `from_branch` — used to record fork lineage afterward.
    let base_name = from_branch
        .strip_prefix("origin/")
        .unwrap_or(&from_branch)
        .to_string();

    if is_from_current {
        // Create branch from current HEAD (preserves local changes)
        let mut co_cmd = crate::utils::git_command_in(&validated_path)?;
        co_cmd.args(["checkout", "-b", &branch_name]);
        let output = crate::external_command::spawn_with_pressure_retry("git checkout -b", || {
            co_cmd.output()
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err((stderr.to_string()).into());
        }
    } else {
        // Creating from a branch other than the one checked out. Prefer a LOCAL
        // branch of that name and only fall back to the remote-tracking ref when
        // no local branch exists (e.g. a teammate's branch we've only fetched).
        // The old code always used `origin/<name>`, which failed for local-only
        // branches once users could branch from any branch (not just always-
        // pushed main): `origin/<name> is not a commit`.
        let plain = from_branch
            .strip_prefix("origin/")
            .unwrap_or(&from_branch)
            .to_string();
        let explicit_remote = from_branch.starts_with("origin/");

        let local_exists = !explicit_remote
            && crate::utils::git_command_in(&validated_path)?
                .args(["show-ref", "--verify", "--quiet"])
                .arg(format!("refs/heads/{plain}"))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        let base_ref = if local_exists {
            // Branch off the local tip; no network needed (may be unpushed).
            plain.clone()
        } else {
            // Only the remote has it — fetch, then use the tracking ref.
            let _ = run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await;
            format!("origin/{plain}")
        };

        let mut co_cmd = crate::utils::git_command_in(&validated_path)?;
        co_cmd.args(["checkout", "-b", &branch_name, &base_ref]);
        let output = crate::external_command::spawn_with_pressure_retry("git checkout -b", || {
            co_cmd.output()
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Uncommitted changes blocking the checkout is an everyday state
            // the frontend already resolves with its commit-or-stash modal —
            // error!() would page telemetry for it (issue #502). The raw
            // stderr must still be returned: BranchesTab matches its wording.
            if stderr.contains("overwritten by checkout")
                || stderr.contains("commit your changes or stash")
            {
                warn!(error = %stderr, "Branch creation blocked by uncommitted changes");
            } else {
                error!(error = %stderr, "Failed to create branch");
            }
            return Err((stderr.to_string()).into());
        }
    }

    // Record where this branch was cut from so the branch-graph visual can draw
    // its fork lineage.
    let mut metadata = load_project_metadata(&validated_path);
    metadata
        .branch_lineage
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(branch_name.clone(), base_name);
    if let Err(e) = save_project_metadata(&validated_path, &metadata) {
        warn!(error = %e, "Failed to persist branch lineage");
    }

    // Invalidate branch cache after creating a new branch
    GIT_CACHE.invalidate(&project_path);
    if let Ok(mut map) = LAST_FETCH.lock() {
        map.remove(&project_path);
    }

    info!("Branch created successfully");
    Ok(())
}

/// Publish a single branch to GitHub without opening a PR: `git push -u origin
/// <branch>`. Pushes the named local branch (which need not be checked out) and
/// sets its upstream. Used by the per-branch "Publish" action.
#[tauri::command]
#[instrument(name = "push_branch", skip(project_path), fields(project = %project_path, branch = %branch_name))]
pub async fn push_branch(project_path: String, branch_name: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Reject names git couldn't safely take as a ref argument.
    if branch_name.is_empty()
        || branch_name.contains(' ')
        || branch_name.contains("..")
        || branch_name.starts_with('-')
    {
        return Err(("Invalid branch name".to_string()).into());
    }

    info!("Publishing branch to GitHub");
    let output = run_git_net(
        &["push", "-u", "origin", &branch_name],
        &validated_path,
        "push branch",
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // An already-published, unchanged branch is a success, not an error.
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, "Failed to publish branch");
            return Err((stderr.to_string()).into());
        }
    }

    // Branch now has a remote counterpart — refresh cached branch data.
    GIT_CACHE.invalidate(&project_path);
    if let Ok(mut map) = LAST_FETCH.lock() {
        map.remove(&project_path);
    }

    info!("Branch published successfully");
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

    // Reject ref names git could parse as an option (argument injection).
    if branch_name.starts_with('-') || branch_name.contains("..") {
        return Err(("Invalid branch name".to_string()).into());
    }

    // Don't allow deleting main/master
    if branch_name == "main" || branch_name == "master" {
        warn!("Attempted to delete main branch");
        return Err(("Cannot delete the main branch".to_string()).into());
    }

    // Get current branch to make sure we're not on it
    let mut head_cmd = crate::utils::git_command_in(&validated_path)?;
    head_cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let current =
        crate::external_command::spawn_with_pressure_retry("git rev-parse", || head_cmd.output())?;

    let current_branch = String::from_utf8_lossy(&current.stdout).trim().to_string();
    if current_branch == branch_name {
        // By-design guard, not a malfunction — Expected keeps the (rare)
        // post-merge-cleanup race out of telemetry (issue #458).
        return Err(crate::errors::CommandError::expected(
            "Cannot delete the current branch. Switch to another branch first.",
        ));
    }

    // Delete local branch
    let mut del_cmd = crate::utils::git_command_in(&validated_path)?;
    del_cmd.args(["branch", "-D", "--", &branch_name]);
    let local_output =
        crate::external_command::spawn_with_pressure_retry("git branch -D", || del_cmd.output())?;

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

        // Prune the local remote-tracking ref. A successful `push --delete` already
        // drops it, but when the remote branch was deleted out-of-band first — e.g.
        // GitHub's "automatically delete head branches" runs at merge time — the push
        // fails as handled above and `origin/<branch>` lingers. Since `list_branches`
        // surfaces remote-tracking refs as branches, that stale ref makes the branch
        // look undeleted (the reported "auto clean doesn't delete the branch anymore").
        // `-rD` is a harmless no-op when the ref is already gone or there's no remote.
        let _ = crate::utils::git_command_in(&validated_path)?
            .args(["branch", "-rD", &format!("origin/{branch_name}")])
            .output();
    }

    // Drop the deleted branch's lineage record — without this the map grows
    // forever across a project's life. Entries whose *base* was this branch
    // stay: their child branches still exist and the graph falls back to
    // merge-base inference for them.
    let mut metadata = load_project_metadata(&validated_path);
    if let Some(lineage) = metadata.branch_lineage.as_mut() {
        if lineage.remove(&branch_name).is_some() {
            if let Err(e) = save_project_metadata(&validated_path, &metadata) {
                warn!(error = %e, "Failed to prune branch lineage after delete");
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
