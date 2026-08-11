//! Git sync commands — fetch, pull, merge, commit, discard.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::utils::validate_project_path;

use super::git_stage_and_commit;
// Network git ops (fetch, pull, merge) go through the workspace-scoped helper in
// the parent module so they authenticate as the project's workspace login.
// Pull/merge mutate the index, so they additionally retry on .git/index.lock
// contention like the commit/snapshot/discard paths (issue #639).
use super::{run_git_net, run_git_net_retrying_index_lock};
use tracing::warn;

/// Git's normal refusal to pull a branch that has never been pushed (no
/// upstream configured) or whose upstream is gone — an anticipated state the
/// frontend already turns into a "push it first" toast, not a malfunction.
/// The message text is preserved verbatim so that frontend match keeps
/// working; only the telemetry classification changes (issue #312).
fn is_missing_upstream(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("no tracking information")
        || lower.contains("no such ref was fetched")
        || lower.contains("couldn't find remote ref")
}

/// Git's normal refusal to merge when a tracked (or untracked) file has local
/// edits the incoming merge would touch — an anticipated user state the
/// frontend already turns into a friendly "push or discard first" toast, not a
/// malfunction (issue #521, same class as #312/#502). The raw stderr is
/// preserved verbatim in the returned message because the frontend
/// regex-matches its wording (`/would be overwritten by (merge|checkout)/i`).
pub(crate) fn is_overwrite_refusal(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("would be overwritten by merge")
        || lower.contains("would be overwritten by checkout")
        || lower.contains("commit your changes or stash")
}

/// Git reporting that a merge/pull produced conflicts. Matched on the combined
/// stdout+stderr because git splits the "CONFLICT (content): …" lines and the
/// final "Automatic merge failed; fix conflicts and then commit the result."
/// across the two streams depending on version.
fn is_merge_conflict_output(combined: &str) -> bool {
    combined.contains("CONFLICT") || combined.contains("Automatic merge failed")
}

/// Classify a failed `git clean -fd` whose *only* failures are files another
/// process is holding open (e.g. a running wrangler dev server's SQLite state
/// on Windows — issue #520). Returns the affected paths when every reported
/// removal failure carries a locked-file reason; returns `None` when there are
/// no removal failures or any failure looks like something else, so genuine
/// clean errors are never swallowed.
fn clean_locked_paths(stderr: &str) -> Option<Vec<String>> {
    const FAILURE_MARKERS: [&str; 2] = ["failed to remove ", "unable to unlink "];
    const LOCKED_REASONS: [&str; 5] = [
        "permission denied",
        "access is denied",
        "resource busy",
        "being used by another process",
        "operation not permitted",
    ];

    let mut paths = Vec::new();
    let mut saw_failure = false;
    for line in stderr.lines() {
        let line = line.trim();
        let Some(rest) = FAILURE_MARKERS
            .iter()
            .find_map(|m| line.split_once(m).map(|(_, rest)| rest))
        else {
            continue;
        };
        saw_failure = true;
        let lower = line.to_lowercase();
        if !LOCKED_REASONS.iter().any(|r| lower.contains(r)) {
            // A removal failed for some other reason — not the locked-file
            // case; let the caller surface it as a real error.
            return None;
        }
        // "path/to/thing: Permission denied" → keep just the path.
        let path = rest.rsplit_once(": ").map(|(p, _)| p).unwrap_or(rest);
        if !path.is_empty() {
            paths.push(path.to_string());
        }
    }
    saw_failure.then_some(paths)
}

/// Fetch all branches from remotes
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn fetch_all_branches(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output = run_git_net(
        &["fetch", "--all", "--prune"],
        &validated_path,
        "fetch --all",
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to fetch: {stderr}")).into());
    }

    Ok(())
}

/// Pull latest changes from remote for current branch
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn git_pull(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let output =
        run_git_net_retrying_index_lock(&["pull", "--ff-only"], &validated_path, "pull --ff-only")
            .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_missing_upstream(&stderr) {
            return Err(CommandError::expected(format!("Failed to pull: {stderr}")));
        }
        return Err((format!("Failed to pull: {stderr}")).into());
    }

    // Invalidate status cache after pull
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Pull remote changes and merge (may result in conflicts).
///
/// Returns git's own summary output (e.g. "Already up to date." or the
/// fast-forward/merge stats) so the UI can report what actually happened
/// instead of a generic "done".
#[tauri::command]
#[tracing::instrument(skip(project_path, merge_branch), fields(project = %project_path, branch = ?merge_branch))]
pub async fn pull_and_merge(
    project_path: String,
    merge_branch: Option<String>,
) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // First fetch to ensure we have latest refs. Ignore failure (best-effort).
    let _ = run_git_net(&["fetch", "origin"], &validated_path, "fetch origin").await;

    let output = if let Some(branch) = merge_branch {
        let merge_ref = format!("origin/{branch}");
        run_git_net_retrying_index_lock(&["merge", &merge_ref], &validated_path, "merge").await?
    } else {
        run_git_net_retrying_index_lock(
            &["pull", "--no-rebase"],
            &validated_path,
            "pull --no-rebase",
        )
        .await?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");

    // Check for merge conflicts. A conflict is a fully anticipated state with
    // dedicated resolution UI (the frontend even calls pull_and_merge on
    // purpose to reproduce one) — Expected keeps it out of telemetry (issue
    // #609). The `MERGE_CONFLICT:` prefix and the raw git output are the
    // frontend contract: useBranchManagement string-matches the prefix.
    if is_merge_conflict_output(&combined) {
        warn!("Merge produced conflicts; handing off to the resolution flow");
        return Err(CommandError::expected(format!("MERGE_CONFLICT:{combined}")));
    }

    if !output.status.success() {
        if is_missing_upstream(&stderr) {
            return Err(CommandError::expected(format!("Failed to merge: {stderr}")));
        }
        if is_overwrite_refusal(&stderr) {
            // Uncommitted local edits blocking the merge is an everyday state
            // the frontend already handles with a friendly toast — error!()
            // would page telemetry for it (issue #521).
            warn!(error = %stderr, "Merge blocked by uncommitted local changes");
            return Err(CommandError::expected(format!("Failed to merge: {stderr}")));
        }
        return Err((format!("Failed to merge: {stderr}")).into());
    }

    // The working tree may have changed under us — same reason git_pull invalidates.
    GIT_CACHE.invalidate_status(&project_path);

    Ok(combined)
}

/// Guard for destructive git operations: confirm the repository git resolves
/// from `dir` is rooted at `dir` itself. When the project's own `.git` is
/// missing or broken, git discovery walks *up* the tree and can land on an
/// unrelated ancestor repo (worst case a stray `~/.git`) — at which point
/// `clean -fd` would treat every project file as untracked and delete the lot
/// (issue #346). Refusing with a clear message beats silent data loss.
fn ensure_repo_rooted_at(dir: &std::path::Path) -> Result<(), CommandError> {
    let output = crate::utils::git_command_in(dir)?
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to locate the repository root: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::expected(format!(
            "This folder isn't a git repository, so there are no changes to discard: {stderr}"
        )));
    }

    let toplevel = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let toplevel_canon =
        dunce::canonicalize(&toplevel).unwrap_or_else(|_| std::path::PathBuf::from(&toplevel));
    let dir_canon = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());

    if toplevel_canon != dir_canon {
        return Err(CommandError::expected(format!(
            "Refusing to discard changes: git resolves this project's repository to '{}', not the \
             project folder itself. The project's .git folder may be missing or damaged — \
             discarding here could delete files that belong to the wrong repository.",
            toplevel_canon.display()
        )));
    }

    Ok(())
}

/// Discard all uncommitted changes in the working directory
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn discard_changes(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // `checkout .` and `clean -fd` operate on whatever repository git
    // discovers, not the directory we were handed — verify they match first
    // (issue #346).
    ensure_repo_rooted_at(&validated_path)?;

    // Discard changes to tracked files. `checkout .` writes to the index, so
    // it can lose the .git lock race against the background snapshot watcher
    // or a concurrent commit exactly like add/commit — retry on contention the
    // same way git_stage_and_commit does (issues #377/#597).
    let checkout_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["checkout", "."])
            .output()
            .map_err(|e| crate::errors::CommandError::Io {
                message: e.to_string(),
            })
    })?;

    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr);
        return Err((format!("Failed to discard changes: {stderr}")).into());
    }

    // Remove untracked files — same lock-retry as above (#597).
    let clean_output = crate::utils::output_retrying_index_lock(|| {
        crate::utils::git_command_in(&validated_path)?
            .args(["clean", "-fd"])
            .output()
            .map_err(|e| crate::errors::CommandError::Io {
                message: e.to_string(),
            })
    })?;

    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr);
        // Best-effort on locked files: tracked files were already reset above,
        // and the only remainder is untracked files another process is holding
        // open (e.g. a running wrangler dev server's .wrangler/state on
        // Windows — issue #520). That's a user-environment state, not a
        // malfunction — tell the user which files, keep it out of telemetry.
        // Any other clean failure still surfaces as a real error.
        if let Some(locked) = clean_locked_paths(&stderr) {
            warn!(error = %stderr, "git clean could not remove locked files during discard");
            GIT_CACHE.invalidate_status(&project_path);
            let detail = if locked.is_empty() {
                String::new()
            } else {
                format!(" Locked: {}.", locked.join(", "))
            };
            return Err(CommandError::expected(format!(
                "Your changes were discarded, but some untracked files couldn't be removed \
                 because a running program (like a dev server) is still using them.{detail} \
                 Stop that process and discard again if you want them gone."
            )));
        }
        return Err((format!("Failed to clean untracked files: {stderr}")).into());
    }

    // Invalidate status caches after discarding changes
    GIT_CACHE.invalidate_status(&project_path);

    Ok(())
}

/// Stage all changes and create a commit with the given message.
/// Returns true if a commit was made, false if there was nothing to commit.
#[tauri::command]
#[tracing::instrument(skip(project_path, message), fields(project = %project_path))]
pub async fn commit_changes(project_path: String, message: String) -> Result<bool, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    // Self-heal a missing user.name/user.email from the gh CLI identity before
    // committing, mirroring push_to_github — without it, Submit for Review's
    // auto-commit dies on git's "Please tell me who you are" (issue #276).
    let _ = crate::commands::github::ensure_git_identity(&validated_path);
    let committed = git_stage_and_commit(&validated_path, &message)?;
    if committed {
        GIT_CACHE.invalidate_status(&project_path);
    }
    Ok(committed)
}

#[cfg(test)]
mod tests {
    use super::{
        clean_locked_paths, ensure_repo_rooted_at, is_merge_conflict_output, is_overwrite_refusal,
    };
    use std::process::Command;

    // The #521 shape: git refusing to merge over uncommitted local edits.
    #[test]
    fn overwrite_refusal_matches_gits_merge_refusal() {
        let stderr = "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/components/PortfolioSection.tsx\nPlease commit your changes or stash them before you merge.\nAborting\n";
        assert!(is_overwrite_refusal(stderr));
        assert!(is_overwrite_refusal(
            "error: The following untracked working tree files would be overwritten by merge:"
        ));
        assert!(!is_overwrite_refusal(
            "fatal: refusing to merge unrelated histories"
        ));
        assert!(!is_overwrite_refusal(""));
    }

    // The #601 shape: `gh pr checkout` refusing over uncommitted local edits —
    // same underlying git message, surfaced through gh's stderr.
    #[test]
    fn overwrite_refusal_matches_pr_checkout_refusal() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\thome/home-v1.html\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
        assert!(is_overwrite_refusal(stderr));
    }

    // The #609 shape: a real merge conflict is an anticipated state with
    // dedicated resolution UI, classified Expected upstream.
    #[test]
    fn merge_conflict_output_matches_gits_conflict_report() {
        let combined = "Auto-merging pnpm-lock.yaml\nCONFLICT (content): Merge conflict in pnpm-lock.yaml\nAutomatic merge failed; fix conflicts and then commit the result.\n";
        assert!(is_merge_conflict_output(combined));
        // Either half alone must still match (git splits across streams).
        assert!(is_merge_conflict_output(
            "CONFLICT (content): Merge conflict in a.txt"
        ));
        assert!(is_merge_conflict_output(
            "Automatic merge failed; fix conflicts and then commit the result."
        ));
        assert!(!is_merge_conflict_output("Already up to date.\n"));
        assert!(!is_merge_conflict_output(""));
    }

    // The #520 shape: a running dev server (wrangler) holding untracked files
    // open, so `git clean -fd` can't remove them on Windows.
    #[test]
    fn clean_locked_paths_extracts_locked_files() {
        let stderr = "warning: failed to remove .wrangler/state/v3/do/: Permission denied\n";
        let locked = clean_locked_paths(stderr).expect("locked-file case must classify");
        assert_eq!(locked, vec![".wrangler/state/v3/do/".to_string()]);
    }

    #[test]
    fn clean_locked_paths_handles_unlink_and_windows_wording() {
        let stderr = "warning: unable to unlink .next/trace: The process cannot access the file because it is being used by another process.\nwarning: failed to remove node_modules/.cache/: Access is denied\n";
        let locked = clean_locked_paths(stderr).expect("locked-file case must classify");
        assert_eq!(locked.len(), 2);
        assert!(locked[0].starts_with(".next/trace"));
    }

    #[test]
    fn clean_locked_paths_rejects_other_failures() {
        // No removal failures at all → not the locked case.
        assert!(clean_locked_paths("fatal: not a git repository").is_none());
        assert!(clean_locked_paths("").is_none());
        // A removal failure with a non-lock reason → must stay a hard error.
        assert!(
            clean_locked_paths("warning: failed to remove foo/bar: Input/output error").is_none()
        );
        // Mixed locked + other failure → also a hard error (don't swallow).
        assert!(clean_locked_paths(
            "warning: failed to remove a: Permission denied\nwarning: failed to remove b: Input/output error"
        )
        .is_none());
    }

    fn init_repo(dir: &std::path::Path) {
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir)
            .status()
            .expect("git init")
            .success());
    }

    #[test]
    fn accepts_a_directory_that_is_its_own_repo_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        init_repo(tmp.path());
        assert!(ensure_repo_rooted_at(tmp.path()).is_ok());
    }

    // The #346 shape: no .git at the project itself, but an ancestor has one —
    // git discovery walks up, and clean -fd would treat every project file as
    // untracked garbage of the ancestor repo.
    #[test]
    fn refuses_when_git_resolves_an_ancestor_repo() {
        let tmp = tempfile::TempDir::new().unwrap();
        init_repo(tmp.path());
        let nested = tmp.path().join("project");
        std::fs::create_dir(&nested).unwrap();
        let err = ensure_repo_rooted_at(&nested).expect_err("must refuse ancestor repo");
        assert!(
            err.to_string().contains("Refusing to discard changes"),
            "unexpected error: {err}"
        );
    }
}
