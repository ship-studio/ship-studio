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
mod graph;
mod stash;
mod status;
mod sync;
mod worktree;

pub use branches::*;
pub use graph::*;
pub use stash::*;
pub use status::*;
pub use sync::*;
pub use worktree::*;

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::PrerequisiteCheck;
use crate::utils::{find_executable, get_extended_path, validate_project_path};
use tracing::{debug, error, info, instrument};

/// Default timeout for git network operations (fetch / pull / push). 60s is
/// generous but protects the UI/worker against an indefinitely-hanging remote.
const GIT_NETWORK_TIMEOUT_SECS: u64 = 60;

/// Run a git command that touches the network (fetch / pull / push), scoped to
/// the workspace the project at `cwd` belongs to.
///
/// Git over HTTPS authenticates through a credential helper, which by default
/// resolves to the machine's *global* GitHub login — so a push/fetch for a
/// project in a non-default workspace would otherwise go out as the wrong
/// account (or 403). The `gh`- and PR-based paths already scope themselves via
/// `get_gh_command_for_project`; this is the matching scope for raw `git`.
///
/// We inject the project's workspace env (notably `GH_CONFIG_DIR`) and route
/// credential resolution through `gh` for *every* workspace, so the app never
/// depends on the user having configured git themselves (`gh auth setup-git`).
/// `gh` reads the `GH_CONFIG_DIR` we inject: for an isolated workspace that's
/// its scoped login; for the Default workspace none is injected, so `gh` falls
/// back to the machine's native login — the same identity every other GitHub
/// feature in the app already uses. If `gh` isn't installed we skip the override
/// and fall back to git's native credential resolution.
pub(crate) async fn run_git_net(
    args: &[&str],
    cwd: &std::path::Path,
    label: &str,
) -> Result<std::process::Output, CommandError> {
    let workspace_env = crate::commands::accounts::get_env_vars_for_project(cwd);

    // git_command_in also passes `-c safe.directory=<cwd>` (issue #305) and
    // sets the working directory.
    let mut cmd = crate::utils::git_command_in(cwd)?;

    // Force HTTPS credential resolution through gh (which reads the GH_CONFIG_DIR
    // injected below) for every workspace. The empty `credential.helper=` first
    // clears any inherited helper (e.g. osxkeychain) so a globally-cached
    // credential can't shadow gh. These are git *global* options, so they must
    // precede the subcommand in `args`.
    if let Some(gh) = find_executable("gh") {
        cmd.arg("-c").arg("credential.helper=");
        // Git hands a `!`-prefixed helper to `sh -c`, which word-splits on
        // spaces — so the path must be quoted or a default Windows install
        // (`C:\Program Files\GitHub CLI\gh.exe`) becomes the command `C:\Program`
        // (issue #265). Single quotes keep backslashes literal under POSIX sh.
        cmd.arg("-c").arg(format!(
            "credential.helper=!'{}' auth git-credential",
            gh.display()
        ));
    }

    cmd.args(args)
        .env("PATH", get_extended_path())
        // Never block on an interactive credential prompt: a GUI-spawned git has
        // no usable tty, so a prompt would hang the worker. Fail fast instead.
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(workspace_env);

    let mut tokio_cmd = tokio::process::Command::from(cmd);
    // Reap the child when the timeout drops the future — otherwise a hung
    // git (and its gh credential-helper subprocess) would keep running in the
    // background, holding .git locks and stalling the next push/fetch too
    // (issue #556; same pattern as projects/mod.rs et al.).
    tokio_cmd.kill_on_drop(true);
    run_with_timeout(tokio_cmd, format!("git {label}"), GIT_NETWORK_TIMEOUT_SECS).await
}

// ============ Git Helper Functions ============

/// Checks if there are uncommitted changes (staged or unstaged tracked files).
///
/// Spawns are labeled and retried on transient EAGAIN — a bare "Resource
/// temporarily unavailable (os error 35)" with no call-site context was
/// reaching telemetry from these frequently-polled helpers (issue #555).
pub fn git_has_uncommitted_changes(
    path: &std::path::Path,
) -> Result<bool, crate::errors::CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(["status", "--porcelain", "-uno"]);
    let status =
        crate::external_command::spawn_with_pressure_retry("git status", || cmd.output())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Checks if there are any changes (including untracked) in the working directory.
pub fn git_has_any_changes(path: &std::path::Path) -> Result<bool, crate::errors::CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(["status", "--porcelain"]);
    let status =
        crate::external_command::spawn_with_pressure_retry("git status", || cmd.output())?;

    Ok(!String::from_utf8_lossy(&status.stdout).trim().is_empty())
}

/// Append `.shipstudio/` to the repo's `.git/info/exclude` when it isn't
/// ignored yet. Same effect as the .gitignore entry the frontend maintains,
/// but repo-local and never committed — so the staging path can enforce it
/// without creating a working-tree change (issue #431). Best-effort: any
/// failure just leaves behavior as it was.
fn ensure_shipstudio_excluded(path: &std::path::Path) {
    // Resolve the common git dir so worktrees are handled too (their `.git`
    // is a file pointing elsewhere, and exclude lives in the common dir).
    let Ok(mut cmd) = crate::utils::git_command_in(path) else {
        return;
    };
    let Ok(out) = cmd.args(["rev-parse", "--git-common-dir"]).output() else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let git_dir_raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if git_dir_raw.is_empty() {
        return;
    }
    let git_dir = {
        let p = std::path::Path::new(&git_dir_raw);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            path.join(p)
        }
    };
    let exclude_path = git_dir.join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let already = existing.lines().any(|l| {
        let t = l.trim();
        t == ".shipstudio/" || t == ".shipstudio" || t == "/.shipstudio/" || t == "/.shipstudio"
    });
    if already {
        return;
    }
    let _ = std::fs::create_dir_all(git_dir.join("info"));
    let sep = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = std::fs::write(
        &exclude_path,
        format!("{existing}{sep}# ShipStudio metadata (added by Ship Studio)\n.shipstudio/\n"),
    );
}

/// Stages all changes and commits with the given message.
/// Returns true if a commit was made, false if nothing to commit.
pub fn git_stage_and_commit(path: &std::path::Path, message: &str) -> Result<bool, String> {
    // Defense-in-depth backstop for #345: even if a too-broad path slipped past
    // registration, never run `git add -A` across the home tree.
    if crate::utils::is_forbidden_project_root(path) {
        return Err(format!(
            "Refusing to stage changes in '{}': it is the home directory or wider, not a project folder",
            path.display()
        ));
    }
    // Make sure .shipstudio/ is excluded BEFORE `git add -A` walks the tree:
    // the frontend's ensure-gitignore calls are best-effort and can be skipped
    // by timing or code path, and an unignored leftover Chrome thumbnail
    // profile (locked Cookies DB and all) aborts the entire staging operation
    // on Windows (issue #431). Uses .git/info/exclude rather than .gitignore
    // so enforcing the guard never itself creates a working-tree change (a
    // clean repo must stay "nothing to commit"). Best-effort.
    ensure_shipstudio_excluded(path);

    // Stage all changes. Retried on index.lock contention — the background
    // snapshot watcher (and any agent CLI) can hold the lock at the exact
    // moment a commit/publish fires (#377).
    let add_output = crate::utils::output_retrying_index_lock(|| {
        let mut cmd = crate::utils::git_command_in(path)?;
        cmd.args(["add", "-A"]);
        crate::external_command::spawn_with_pressure_retry("git add", || cmd.output())
    })
    .map_err(String::from)?;

    if !add_output.status.success() {
        let add_stderr = String::from_utf8_lossy(&add_output.stderr).to_string();
        // In a sparse-checkout repo, `git add -A` exits 1 when untracked files
        // exist outside the sparse cone (e.g. a CMS sync writing into an
        // excluded dir) — blocking every commit/publish even though the in-cone
        // changes are fine (issue #275). Retry with --sparse, which stages
        // out-of-cone paths instead of refusing.
        if add_stderr.contains("outside of your sparse-checkout definition") {
            let mut sparse_cmd = crate::utils::git_command_in(path)?;
            sparse_cmd.args(["add", "-A", "--sparse"]);
            let sparse_output = crate::external_command::spawn_with_pressure_retry(
                "git add --sparse",
                || sparse_cmd.output(),
            )
            .map_err(String::from)?;
            if !sparse_output.status.success() {
                return Err(String::from_utf8_lossy(&sparse_output.stderr).to_string());
            }
        } else {
            return Err(add_stderr);
        }
    }

    // Check if there are staged changes to commit
    let has_changes = git_has_any_changes(path)?;

    if !has_changes {
        return Ok(false);
    }

    // Commit — same index.lock retry as the staging step (#377).
    let commit_output = crate::utils::output_retrying_index_lock(|| {
        let mut cmd = crate::utils::git_command_in(path)?;
        cmd.args(["commit", "-m", message]);
        crate::external_command::spawn_with_pressure_retry("git commit", || cmd.output())
    })
    .map_err(String::from)?;

    if !commit_output.status.success() {
        // `status --porcelain` can report entries `add -A` couldn't stage (e.g.
        // a nested git repo), so the commit can still come up empty. Git prints
        // "nothing to commit" to *stdout* and leaves stderr blank — treat it as
        // the no-op it is instead of surfacing an empty error (issue #274).
        let stdout = String::from_utf8_lossy(&commit_output.stdout);
        if stdout.contains("nothing to commit") || stdout.contains("working tree clean") {
            return Ok(false);
        }
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        };
        return Err(detail);
    }

    Ok(true)
}

/// Get the current branch name synchronously (for internal use)
pub fn get_current_branch_sync(path: &std::path::Path) -> Option<String> {
    let output = crate::utils::git_command_in(path)
        .ok()?
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
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
    let Ok(mut cmd) = crate::utils::git_command_in(path) else {
        return (0, 0);
    };
    let output = cmd
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{branch}...{compare_to}"),
        ])
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
        let Ok(mut cmd) = crate::utils::git_command_in(path) else {
            break;
        };
        let output = cmd
            .args(["rev-list", "--left-right", "--count", "--end-of-options"])
            .arg(&range)
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
///
/// Normalized to forward slashes: the frontend builds project paths by
/// concatenating `/` onto this value, so a native Windows backslash path here
/// produces mixed-separator paths (`C:\Users\x\ShipStudio/proj`) that break
/// `@tauri-apps/plugin-fs` scope resolution (issue #257).
#[tauri::command]
#[tracing::instrument]
pub async fn get_shipstudio_dir() -> Result<String, CommandError> {
    Ok(crate::utils::normalize_separators(
        &crate::utils::projects_root()?.to_string_lossy(),
    ))
}

/// Creates the configured projects root directory if it doesn't exist.
/// Forward-slash normalized for the same reason as [`get_shipstudio_dir`].
#[tauri::command]
#[tracing::instrument]
pub async fn ensure_shipstudio_dir() -> Result<String, CommandError> {
    let projects_dir = crate::utils::projects_root()?;

    if !projects_dir.exists() {
        std::fs::create_dir_all(&projects_dir).map_err(|e| {
            format!(
                "Failed to create projects directory '{}': {e}",
                projects_dir.display()
            )
        })?;
    }

    Ok(crate::utils::normalize_separators(
        &projects_dir.to_string_lossy(),
    ))
}

#[tauri::command]
#[instrument(name = "init_git_repo", skip(project_path), fields(project = %project_path))]
pub async fn init_git_repo(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    info!("Initializing git repository");

    // Initialize git repo
    let output = crate::utils::git_command_in(&validated_path)?
        .args(["init"])
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

    /// Issue #431: `git add -A` must never walk into .shipstudio (Chrome
    /// thumbnail profiles with locked files live there). The staging path
    /// enforces the exclusion itself via .git/info/exclude — without creating
    /// a working-tree change.
    #[test]
    fn stage_and_commit_excludes_shipstudio_dir() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::create_dir_all(tmp.path().join(".shipstudio").join("thumbnail_profile")).unwrap();
        std::fs::write(
            tmp.path()
                .join(".shipstudio")
                .join("thumbnail_profile")
                .join("Cookies"),
            "locked-ish",
        )
        .unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        let committed = git_stage_and_commit(tmp.path(), "first").unwrap();
        assert!(committed);
        let tracked = Command::new("git")
            .args(["ls-files"])
            .current_dir(tmp.path())
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&tracked.stdout).to_string();
        assert!(
            !listing.contains(".shipstudio"),
            ".shipstudio must not be staged, got: {listing}"
        );
        assert!(listing.contains("a.txt"));
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

    /// Issue #275: with sparse-checkout enabled, untracked files outside the
    /// cone make `git add -A` exit 1 — staging must retry with `--sparse`
    /// instead of aborting every commit/publish for the whole repo.
    #[test]
    fn stage_and_commit_survives_files_outside_sparse_cone() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        std::fs::create_dir_all(tmp.path().join("src/app")).unwrap();
        std::fs::write(tmp.path().join("src/app/a.txt"), "in cone").unwrap();
        std::fs::create_dir_all(tmp.path().join("src/images")).unwrap();
        std::fs::write(tmp.path().join("src/images/b.txt"), "out of cone").unwrap();
        commit_all(tmp.path(), "initial");
        assert!(Command::new("git")
            .args(["sparse-checkout", "set", "src/app"])
            .current_dir(tmp.path())
            .status()
            .expect("git sparse-checkout")
            .success());
        // A build/CMS step writes into the excluded directory.
        std::fs::create_dir_all(tmp.path().join("src/images/airtable")).unwrap();
        std::fs::write(tmp.path().join("src/images/airtable/x.webp"), "img").unwrap();

        let result = git_stage_and_commit(tmp.path(), "sync assets");
        assert!(
            result.is_ok(),
            "sparse-checkout stray files must not abort commit: {result:?}"
        );
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
