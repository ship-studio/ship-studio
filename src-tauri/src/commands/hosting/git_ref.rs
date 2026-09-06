//! Resolving the commit a hosting provider could plausibly have deployed.
//!
//! The question the UI answers is "did my push go live?", so the subject is
//! whatever the *remote* has — `origin/<branch>` — not local `HEAD`. A provider
//! can only build what it was able to fetch, and showing a status against an
//! unpushed local commit would be confidently wrong.

use super::model::CommitRef;
use crate::errors::CommandError;
use crate::external_command::spawn_with_pressure_retry;
use crate::utils::git_command_in;
use std::path::Path;

/// Run a git command in the project and return trimmed stdout, or `None` if it
/// failed for any reason. Callers treat absence as "unknown", never as an error
/// — a missing upstream is a normal state, not a fault.
fn git_output(project: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = git_command_in(project).ok()?;
    cmd.args(args);
    let output =
        spawn_with_pressure_retry(&format!("git {}", args.join(" ")), || cmd.output()).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The current branch name, or `None` in detached HEAD — where "the branch I
/// pushed" has no meaning and the UI should say nothing rather than guess.
fn current_branch(project: &Path) -> Option<String> {
    git_output(project, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")
}

/// Resolve the commit to ask providers about.
///
/// Prefers `origin/<branch>`. When there is no upstream the branch has never
/// been pushed, so `has_upstream` is false and the UI explains that deployments
/// appear after the first push rather than showing an empty status.
pub fn pushed_commit(project: &Path) -> Result<CommitRef, CommandError> {
    let branch = current_branch(project).ok_or_else(|| {
        CommandError::expected("This project isn't on a branch, so there's nothing to check.")
    })?;

    let remote_ref = format!("origin/{branch}");
    let (sha, has_upstream) = match git_output(project, &["rev-parse", &remote_ref]) {
        Some(sha) => (sha, true),
        None => (
            git_output(project, &["rev-parse", "HEAD"])
                .ok_or_else(|| CommandError::expected("This project has no commits yet."))?,
            false,
        ),
    };

    let short_sha = sha.chars().take(7).collect::<String>();

    // One call for both fields; `%x00` keeps a subject containing newlines from
    // being mistaken for the timestamp line.
    let meta = git_output(project, &["log", "-1", "--format=%s%x00%ct", &sha]);
    let (subject, committed_at) = match meta {
        Some(raw) => {
            let mut parts = raw.split('\0');
            let subject = parts
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let committed_at = parts
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|secs| secs * 1000);
            (subject, committed_at)
        }
        None => (None, None),
    };

    Ok(CommitRef {
        sha,
        short_sha,
        subject,
        committed_at,
        branch,
        has_upstream,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Build a throwaway repo with one commit. Returns None when git isn't
    /// usable in the test environment, so the suite degrades rather than fails.
    fn repo_with_one_commit() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path();
        let run = |args: &[&str]| -> bool {
            Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(path.join("file.txt"), b"hello").ok()?;
        run(&["add", "."]);
        if !run(&["commit", "-q", "-m", "Add the first thing"]) {
            return None;
        }
        Some(dir)
    }

    #[test]
    fn a_never_pushed_branch_reports_no_upstream_and_still_resolves_head() {
        let Some(dir) = repo_with_one_commit() else {
            return;
        };
        let commit = pushed_commit(dir.path()).expect("resolves against HEAD");

        assert!(
            !commit.has_upstream,
            "a fresh repo has no origin, so nothing has been pushed"
        );
        assert_eq!(commit.sha.len(), 40);
        assert_eq!(commit.short_sha.len(), 7);
        assert!(commit.sha.starts_with(&commit.short_sha));
        assert_eq!(commit.subject.as_deref(), Some("Add the first thing"));
        assert!(commit.committed_at.unwrap_or(0) > 1_000_000_000_000);
    }

    #[test]
    fn a_repo_with_no_commits_is_an_expected_state_not_a_crash() {
        let Ok(dir) = tempfile::tempdir() else {
            return;
        };
        let ok = Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return;
        }

        let err = pushed_commit(dir.path()).unwrap_err();
        assert!(
            matches!(err, CommandError::Expected { .. }),
            "an empty repo is a normal state and must not be reported to telemetry"
        );
    }
}
