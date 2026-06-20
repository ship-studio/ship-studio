//! # Git Commands
//!
//! Commands for Git operations, branch management, and repository management.
//!
//! Organized into submodules:
//! - `status` — change detection, file diffs, branch status
//! - `branches` — list, create, delete, switch branches
//! - `sync` — fetch, pull, merge, commit, discard
//! - `stash` — stash management, backups, restore

mod branches;
mod stash;
mod status;
mod sync;

pub use branches::*;
pub use stash::*;
pub use status::*;
pub use sync::*;

use crate::errors::CommandError;
use crate::types::PrerequisiteCheck;
use crate::utils::{create_command, find_executable, validate_project_path};
use tracing::{debug, error, info, instrument};

// ============ Git Helper Functions ============

/// Checks if there are uncommitted changes (staged or unstaged tracked files).
pub fn git_has_uncommitted_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = create_command("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Checks if there are any changes (including untracked) in the working directory.
pub fn git_has_any_changes(path: &std::path::Path) -> Result<bool, String> {
    let status = create_command("git")
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
    let add_output = create_command("git")
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
    let commit_output = create_command("git")
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
    let output = create_command("git")
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
    let output = create_command("git")
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{branch}...{compare_to}"),
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

/// Batch-calculates ahead/behind for multiple branches in a single subprocess.
/// Returns a HashMap of branch_name -> (ahead, behind).
pub fn get_ahead_behind_batch(
    path: &std::path::Path,
    branch_names: &[&str],
    compare_to: &str,
) -> std::collections::HashMap<String, (i32, i32)> {
    let mut results = std::collections::HashMap::new();

    if branch_names.is_empty() {
        return results;
    }

    // Run git as argv per branch (NOT via a shell). Branch names are
    // attacker-controlled repository content — a name like `x';rm -rf ~;'` is a
    // valid git ref, so interpolating it into a `sh -c` string was a command
    // injection. Passing it as a literal argument to `git` removes the shell
    // entirely. The leading `--end-of-options` stops a `-`-leading ref from
    // being parsed as a flag.
    for name in branch_names {
        let range = format!("{name}...{compare_to}");
        let output = create_command("git")
            .args(["rev-list", "--left-right", "--count", "--end-of-options"])
            .arg(&range)
            .current_dir(path)
            .output();

        let (ahead, behind) = match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let parts: Vec<&str> = stdout.trim().split('\t').collect();
                if parts.len() == 2 {
                    (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
                } else {
                    (0, 0)
                }
            }
            // Branch may not exist on remote, etc. — default to (0, 0).
            _ => (0, 0),
        };
        results.insert((*name).to_string(), (ahead, behind));
    }

    results
}

/// Helper to load project metadata with automatic schema migration
pub(crate) fn load_project_metadata(
    project_path: &std::path::Path,
) -> crate::types::ProjectMetadata {
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
pub(crate) fn save_project_metadata(
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

// ============ Tauri Commands ============

/// Checks if required tools (node, npm, git, gh, claude) are installed.
#[tauri::command]
#[instrument(name = "check_prerequisites")]
pub async fn check_prerequisites() -> Vec<PrerequisiteCheck> {
    let commands = vec!["node", "npm", "git", "gh", "claude"];
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

/// Returns the configured projects root directory (custom or default `~/ShipStudio`).
#[tauri::command]
#[tracing::instrument]
pub async fn get_shipstudio_dir() -> Result<String, CommandError> {
    Ok(crate::utils::projects_root()?.to_string_lossy().to_string())
}

/// Creates the configured projects root directory if it doesn't exist.
#[tauri::command]
#[tracing::instrument]
pub async fn ensure_shipstudio_dir() -> Result<String, CommandError> {
    let projects_dir = crate::utils::projects_root()?;

    if !projects_dir.exists() {
        std::fs::create_dir_all(&projects_dir).map_err(|e| e.to_string())?;
    }

    Ok(projects_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[instrument(name = "init_git_repo", skip(project_path), fields(project = %project_path))]
pub async fn init_git_repo(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    info!("Initializing git repository");

    // Initialize git repo
    let output = create_command("git")
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
        return Err(stderr.into());
    }

    // Stage and commit all files
    git_stage_and_commit(&validated_path, "Initial commit from Ship Studio")
        .map_err(CommandError::from)?;

    info!("Git repository initialized successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    /// Initialize a fresh git repo in `dir` with a local user identity so
    /// commits work in CI environments without global git config.
    fn init_repo(dir: &std::path::Path) {
        assert!(Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir)
            .status()
            .expect("git init")
            .success());
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com")] {
            assert!(Command::new("git")
                .args(["config", k, v])
                .current_dir(dir)
                .status()
                .expect("git config")
                .success());
        }
    }

    fn commit_all(dir: &std::path::Path, msg: &str) {
        assert!(Command::new("git")
            .args(["add", "-A"])
            .current_dir(dir)
            .status()
            .expect("git add")
            .success());
        assert!(Command::new("git")
            .args(["commit", "-q", "-m", msg])
            .current_dir(dir)
            .status()
            .expect("git commit")
            .success());
    }

    #[test]
    fn has_uncommitted_changes_false_on_clean_repo() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        commit_all(tmp.path(), "initial");
        let result = git_has_uncommitted_changes(tmp.path()).unwrap();
        assert!(!result, "clean repo should report no uncommitted changes");
    }

    #[test]
    fn has_uncommitted_changes_true_after_modifying_tracked_file() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        commit_all(tmp.path(), "initial");
        std::fs::write(tmp.path().join("a.txt"), "modified").unwrap();
        let result = git_has_uncommitted_changes(tmp.path()).unwrap();
        assert!(result, "modified tracked file must register as uncommitted");
    }

    #[test]
    fn has_uncommitted_changes_ignores_untracked_files() {
        // -uno flag means untracked files are NOT counted.
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        commit_all(tmp.path(), "initial");
        std::fs::write(tmp.path().join("new.txt"), "untracked").unwrap();
        let result = git_has_uncommitted_changes(tmp.path()).unwrap();
        assert!(
            !result,
            "untracked file should NOT count as uncommitted (uno)"
        );
    }

    #[test]
    fn has_any_changes_includes_untracked() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        commit_all(tmp.path(), "initial");
        assert!(!git_has_any_changes(tmp.path()).unwrap());
        std::fs::write(tmp.path().join("untracked.txt"), "new").unwrap();
        assert!(
            git_has_any_changes(tmp.path()).unwrap(),
            "untracked file must register as any-changes"
        );
    }

    #[test]
    fn stage_and_commit_returns_true_when_changes_exist() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        let committed = git_stage_and_commit(tmp.path(), "first commit").unwrap();
        assert!(committed, "fresh file should produce a commit");
        // Verify with rev-parse that HEAD exists
        let rev = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(tmp.path())
            .output()
            .unwrap();
        assert!(rev.status.success(), "HEAD must exist after commit");
    }

    #[test]
    fn stage_and_commit_returns_false_when_nothing_to_commit() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        commit_all(tmp.path(), "initial");
        // No changes since last commit
        let committed = git_stage_and_commit(tmp.path(), "should be noop").unwrap();
        assert!(!committed, "no changes should return false");
    }

    #[test]
    fn current_branch_sync_returns_branch_name() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        commit_all(tmp.path(), "init");
        let branch = get_current_branch_sync(tmp.path());
        assert_eq!(branch.as_deref(), Some("main"));
    }

    #[test]
    fn ahead_behind_batch_returns_zeroes_for_unknown_remote() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        commit_all(tmp.path(), "init");
        let result = get_ahead_behind_batch(tmp.path(), &["main"], "origin/main");
        // origin/main doesn't exist (no remote), so the fallback inside the
        // shell script prints 0\t0 for that branch.
        assert_eq!(
            result.get("main").copied(),
            Some((0, 0)),
            "unknown remote should degrade to (0,0)"
        );
    }
}
