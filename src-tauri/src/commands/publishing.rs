//! # Publishing Commands
//!
//! Commands for publishing to GitHub, staging, and production.

use crate::commands::ai::resolve_commit_message;
use crate::commands::git::git_stage_and_commit;
// Network git ops (pull/push) go through the workspace-scoped helper so a
// publish authenticates as the project's workspace GitHub login, matching the
// gh-based repo-create path.
use crate::commands::git::run_git_net;
use crate::commands::github::ensure_git_identity;
use crate::errors::CommandError;
use crate::types::PublishResult;
use crate::utils::validate_project_path;
use tracing::{debug, error, info, instrument, warn};

/// GitHub's push-time auth/permission rejections. The phrasing varies by
/// transport and failure mode: SSH's "Permission denied", the credential
/// helper's "could not read Username", HTTPS "Permission to <repo>.git denied
/// to <user>." (words split by the repo name — issue #321), and HTTPS
/// "remote: Write access to repository not granted." with a 403
/// (issue #343). All mean "reconnect GitHub or check your access", so all
/// map to NotAuthenticated instead of an opaque process error.
fn push_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let is_auth = stderr.contains("Permission denied")
        || stderr.contains("could not read Username")
        || (lower.contains("permission to") && lower.contains("denied to"))
        || lower.contains("write access to repository not granted");
    if is_auth {
        return Some(CommandError::NotAuthenticated {
            service: format!("github (AUTH_ERROR: {stderr})"),
        });
    }
    None
}

/// GitHub pre-receive rejections that contain the literal word "rejected" but
/// are NOT the benign "someone else pushed first" race: the broad
/// `stderr.contains("rejected")` arms below matched them and told the user to
/// "pull changes first" — advice that can't fix either condition. Both are
/// user-fixable states with one specific remedy, so they get their own
/// message and stay out of telemetry (`Expected`).
///
/// - `GH001` / "exceeds GitHub's file size limit": a file over 100 MB — the
///   fix is removing the file or switching to Git LFS (issue #626).
/// - `GH005` / "refs longer than 255 bytes": the branch name itself is too
///   long for GitHub — the fix is renaming the branch (issue #636; the
///   frontend's `sanitizeBranchName` now caps generated names too).
///
/// Must run BEFORE any generic "rejected"/"non-fast-forward" check.
/// (`pub(crate)`: also used by `create_pull_request`'s auto-push, issue #654.)
pub(crate) fn push_pre_receive_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    if lower.contains("exceeds github's file size limit") || lower.contains("gh001") {
        // Best-effort: name the offending file(s) from lines like
        // "remote: error: File Archiv.zip is 120.17 MB; this exceeds GitHub's
        // file size limit of 100.00 MB".
        let files: Vec<&str> = stderr
            .lines()
            .filter(|l| l.to_lowercase().contains("file size limit"))
            .filter_map(|l| l.split("File ").nth(1))
            .filter_map(|rest| rest.split(" is ").next())
            .filter(|name| !name.is_empty())
            .collect();
        let detail = if files.is_empty() {
            String::new()
        } else {
            format!(" ({})", files.join(", "))
        };
        return Some(CommandError::expected(format!(
            "GitHub rejected this push because a file is larger than its 100 MB limit{detail}. \
             Remove the file from the branch (or use Git LFS for large files) and push again — \
             pulling changes won't help."
        )));
    }
    if lower.contains("gh005")
        || lower.contains("refs longer than")
        || lower.contains("ref too long")
    {
        return Some(CommandError::expected(
            "GitHub rejected this push because the branch name is too long (GitHub limits refs \
             to 255 bytes). Rename the branch to something shorter and push again — pulling \
             changes won't help.",
        ));
    }
    None
}

/// GitHub's transient server-side failure while accepting a push: the remote
/// replies "remote: Internal Server Error" (plus a Request ID / Time pair) and
/// git prints "! [remote rejected] <branch> -> <branch> (Internal Server
/// Error)". That line contains the literal word "rejected", so without this
/// check it fell into the generic "rejected" arms and the user was told
/// "someone else pushed — pull first", advice that can't fix a GitHub 5xx;
/// the actual remedy is simply retrying (issue #678, same class as the
/// GH001/GH005 misclassifications above). A GitHub-side blip, not an app
/// malfunction — Expected keeps it out of telemetry.
///
/// Must run BEFORE any generic "rejected"/"non-fast-forward" check.
/// (`pub(crate)`: also used by `create_pull_request`'s auto-push.)
pub(crate) fn push_transient_server_error(stderr: &str) -> Option<CommandError> {
    stderr
        .to_lowercase()
        .contains("internal server error")
        .then(|| {
            CommandError::expected(
                "GitHub had a temporary problem accepting this push (a server error on \
                 GitHub's side). Nothing is wrong with your changes — wait a moment and \
                 try again.",
            )
        })
}

/// Push-time "the remote repo doesn't exist" rejections — the linked repo was
/// deleted, renamed, transferred, or made inaccessible outside the app.
/// Environment, not malfunction: telemetry-flooding this on every publish
/// attempt for a stale remote helps nobody (issue #435).
/// (`pub(crate)`: also reached through `git::classify_git_net_error`, so
/// push_branch/delete_branch/create_pull_request classify it too — issue #825.)
pub(crate) fn push_missing_remote_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    let missing = lower.contains("repository not found")
        || (lower.contains("repository") && lower.contains("not found") && lower.contains("fatal"));
    missing.then(|| {
        CommandError::expected(
            "The linked GitHub repository couldn't be found — it may have been deleted, renamed,              or you may no longer have access. Check the repository on GitHub or reconnect it,              then try again.",
        )
    })
}

#[tauri::command]
#[instrument(name = "publish_to_github", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_github(
    project_path: String,
    commit_message: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to GitHub");

    // Get current branch name
    let branch_output = crate::utils::git_command_in(&validated_path)?
        .args(["branch", "--show-current"])
        .output()
        .map_err(CommandError::from)?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    let branch = if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    };

    // Pull latest changes first (rebase to keep history clean)
    let pull_output = run_git_net(
        &["pull", "--rebase", "origin", &branch],
        &validated_path,
        "pull --rebase",
    )
    .await;

    // Handle pull errors - log unexpected ones but don't fail
    match pull_output {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // These errors are expected for new repos/branches
            let is_expected_error = stderr.contains("no tracking")
                || stderr.contains("Couldn't find remote ref")
                || stderr.contains("There is no tracking information")
                || stderr.contains("fatal: couldn't find remote ref");

            if !is_expected_error {
                warn!(error = %stderr, "Unexpected pull error (continuing anyway)");
            } else {
                debug!(error = %stderr, "Expected pull error for new repo/branch");
            }
        }
        Err(e) => {
            warn!(error = %e, "Failed to execute git pull");
        }
        _ => {}
    }

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit through the shared helper: it retries sparse-checkout
    // refusals (issue #275) and treats an empty commit as a no-op instead of a
    // hard failure (issue #274), unlike the hand-rolled sequence it replaces.
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to origin
    let output = run_git_net(&["push", "-u", "origin", &branch], &validated_path, "push").await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Large-file / ref-too-long pre-receive declines carry a specific fix
        // of their own (issues #626/#636) — and without this arm they'd fall
        // through to the auto-reported generic Process error below.
        if let Some(err) = push_pre_receive_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push declined by GitHub pre-receive check");
            return Err(err);
        }
        // GitHub-side 5xx during the push — retryable, not a malfunction
        // (issue #678).
        if let Some(err) = push_transient_server_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push failed on a GitHub server error");
            return Err(err);
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, branch = %branch, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, branch = %branch, "Push to GitHub failed");
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!(branch = %branch, "Published to GitHub successfully");
    Ok(())
}

#[tauri::command]
#[instrument(name = "publish_to_staging", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_staging(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to staging");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes. A real staging/commit failure must not be
    // swallowed — the push below would silently deploy stale code (benign cases
    // like "nothing to commit" and sparse-checkout are handled in the helper).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to staging branch - Vercel auto-deploys via GitHub integration
    // Note: Using regular push instead of force push to avoid overwriting others' work
    let push_output = run_git_net(
        &["push", "-u", "origin", "HEAD:staging"],
        &validated_path,
        "push staging",
    )
    .await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Pre-receive declines (GH001 large file, GH005 ref too long) contain
        // the word "rejected" but are NOT the diverged-branch race — check
        // them first or the user gets "pull changes first" advice that can't
        // fix anything (issues #626/#636).
        if let Some(err) = push_pre_receive_error(&stderr) {
            warn!(error = %stderr, "Push declined by GitHub pre-receive check");
            return Err(err);
        }
        // GitHub-side 5xx: contains "rejected" but isn't the diverged-branch
        // race — must run before that arm (issue #678).
        if let Some(err) = push_transient_server_error(&stderr) {
            warn!(error = %stderr, "Push failed on a GitHub server error");
            return Err(err);
        }
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, "Push rejected - staging branch has diverged");
            // Retain the legacy PUSH_REJECTED sentinel so the frontend can
            // still discriminate this case via substring match. A concurrent
            // push landing first is a benign race with dedicated UI, not a
            // malfunction — Expected keeps it out of telemetry (issue #617,
            // same class as #312/#521/#609).
            return Err(CommandError::expected(format!(
                "PUSH_REJECTED: Staging branch has diverged. Pull changes first or resolve conflicts.\n{stderr}"
            )));
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, "Failed to push to staging");
            return Err(CommandError::Process {
                cmd: "git push staging".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!("Published to staging successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[tauri::command]
#[instrument(name = "publish_to_production", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_to_production(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = resolve_commit_message(&validated_path, commit_message).await;
    info!(message = %message, "Publishing to production");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit any changes (real failures propagate — see staging).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to main branch - Vercel auto-deploys to production via GitHub integration
    let push_output = run_git_net(
        &["push", "-u", "origin", "HEAD:main"],
        &validated_path,
        "push main",
    )
    .await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Pre-receive declines have their own fix and would otherwise be
        // auto-reported as a generic Process error (issues #626/#636).
        if let Some(err) = push_pre_receive_error(&stderr) {
            warn!(error = %stderr, "Push declined by GitHub pre-receive check");
            return Err(err);
        }
        // GitHub-side 5xx during the push — retryable, not a malfunction
        // (issue #678).
        if let Some(err) = push_transient_server_error(&stderr) {
            warn!(error = %stderr, "Push failed on a GitHub server error");
            return Err(err);
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, "Failed to push to production");
            return Err(CommandError::Process {
                cmd: "git push main".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!("Published to production successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

/// Publish (push) the current branch to origin
#[tauri::command]
#[instrument(name = "publish_branch", skip(project_path, commit_message), fields(project = %project_path))]
pub async fn publish_branch(
    project_path: String,
    commit_message: Option<String>,
) -> Result<PublishResult, CommandError> {
    let validated_path = validate_project_path(&project_path).map_err(CommandError::from)?;
    let message = resolve_commit_message(&validated_path, commit_message).await;

    // Get current branch name
    let branch_output = crate::utils::git_command_in(&validated_path)?
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(CommandError::from)?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    // In a detached HEAD (checked-out tag/commit, mid-rebase) `rev-parse
    // --abbrev-ref HEAD` literally returns "HEAD", which we'd then hand git as
    // a push destination — git refuses with an unreadable "not a full refname"
    // wall of text and telemetry logs it as a defect. A normal git state with a
    // user-side fix, so stop before committing anything (issue #794; same guard
    // get_current_branch got in #317).
    if branch == "HEAD" {
        warn!("Publish blocked: repository is in a detached HEAD state");
        return Err(CommandError::expected(
            "This project isn't on a branch right now (git calls this a detached HEAD — it \
             happens mid-rebase or after checking out a specific commit or tag). Switch to a \
             branch first, then publish.",
        ));
    }
    info!(branch = %branch, message = %message, "Publishing branch");

    // Ensure git identity matches GitHub account before committing
    let _ = ensure_git_identity(&validated_path);

    // Stage and commit through the shared helper. The old hand-rolled sequence
    // discarded `git add -A`'s result entirely, so a staging failure surfaced
    // later as an inexplicable "Uncommitted changes" on switch (issue #273);
    // the helper also handles sparse-checkout (#275) and empty commits (#274).
    git_stage_and_commit(&validated_path, &message).map_err(CommandError::from)?;

    // Push to origin
    let push_output =
        run_git_net(&["push", "-u", "origin", &branch], &validated_path, "push").await?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Pre-receive declines (GH001 large file, GH005 ref too long) contain
        // the word "rejected" but are NOT the concurrent-push race — check
        // them first or the frontend shows the "someone else pushed, pull
        // first" modal for a problem pulling can't fix (issues #626/#636).
        if let Some(err) = push_pre_receive_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push declined by GitHub pre-receive check");
            return Err(err);
        }
        // GitHub-side 5xx: "! [remote rejected] … (Internal Server Error)"
        // contains "rejected" but isn't the concurrent-push race — must run
        // before that arm or the user gets pull-first advice for a transient
        // GitHub outage (issue #678).
        if let Some(err) = push_transient_server_error(&stderr) {
            warn!(error = %stderr, branch = %branch, "Push failed on a GitHub server error");
            return Err(err);
        }
        // Check for common errors
        if stderr.contains("rejected") || stderr.contains("non-fast-forward") {
            warn!(error = %stderr, branch = %branch, "Push rejected");
            // Someone else pushed first — an anticipated race the frontend
            // already handles via the PUSH_REJECTED sentinel (GitErrorHandler's
            // push_rejected case). Expected serializes identically to Other on
            // the wire, so the substring match keeps working (issue #617).
            return Err(CommandError::expected(format!("PUSH_REJECTED:{stderr}")));
        }
        if let Some(err) = push_auth_error(&stderr) {
            error!(error = %stderr, branch = %branch, "Authentication error");
            return Err(err);
        }
        if let Some(err) = push_missing_remote_error(&stderr) {
            return Err(err);
        }
        if !stderr.contains("Everything up-to-date") {
            error!(error = %stderr, branch = %branch, "Push failed");
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: push_output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    info!(branch = %branch, "Branch published successfully");
    Ok(PublishResult {
        url: String::new(),
        state: "QUEUED".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{push_pre_receive_error, push_transient_server_error};
    use crate::commands::git::run_git_net;
    use crate::errors::CommandError;
    use std::path::Path;

    // The #678 shape: GitHub's edge returning a transient 5xx while accepting
    // the push. Contains "! [remote rejected]" — must classify Expected with
    // retry guidance instead of falling into the pull-first PUSH_REJECTED arm.
    #[test]
    fn transient_server_error_classifies_github_ise() {
        let stderr = "remote: Internal Server Error        \nremote: Request ID 65EF:1EC443:289A4B:2BCFC2:6A7DD5C5        \nremote: Time 2026-08-13T14:33:42Z\nTo https://github.com/o/r.git\n ! [remote rejected] main -> main (Internal Server Error)\nerror: failed to push some refs to 'https://github.com/o/r.git'\n";
        let err = push_transient_server_error(stderr).expect("must classify the GitHub 5xx");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(
            msg.contains("try again"),
            "must suggest retrying, got: {msg}"
        );
        assert!(
            !msg.contains("PUSH_REJECTED") && !msg.to_lowercase().contains("pull"),
            "must not steer toward the pull-first flow, got: {msg}"
        );
        // Not a pre-receive decline — the sibling helper must not claim it.
        assert!(push_pre_receive_error(stderr).is_none());
    }

    // An ordinary non-fast-forward race and the pre-receive declines must NOT
    // match — they keep their existing paths.
    #[test]
    fn transient_server_error_ignores_other_push_failures() {
        assert!(push_transient_server_error(
            " ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'"
        )
        .is_none());
        assert!(push_transient_server_error(
            "remote: error: GH001: Large files detected.\n ! [remote rejected] x -> x (pre-receive hook declined)"
        )
        .is_none());
        assert!(push_transient_server_error("").is_none());
    }

    // The #626 shape: GH001 large-file decline contains "rejected" but is not
    // the concurrent-push race — it must classify Expected with LFS guidance
    // and name the offending file.
    #[test]
    fn pre_receive_error_classifies_gh001_large_file() {
        let stderr = "remote: error: Trace: 3539f6eaf2da6d14bbb65f8b9db2f684f713c6d5732665c678bdc1bb29d18696\nremote: error: See https://gh.io/lfs for more information.\nremote: error: File Archiv.zip is 120.17 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.\n ! [remote rejected] feat/x -> feat/x (pre-receive hook declined)\nerror: failed to push some refs to 'https://github.com/o/r.git'";
        let err = push_pre_receive_error(stderr).expect("must classify GH001");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("100 MB"), "got: {msg}");
        assert!(msg.contains("Archiv.zip"), "must name the file, got: {msg}");
        assert!(msg.contains("LFS"), "must point at Git LFS, got: {msg}");
        assert!(
            !msg.contains("PUSH_REJECTED"),
            "must not trigger the pull-first modal"
        );
    }

    // The #636 shape: GH005 ref-too-long decline — the only fix is renaming
    // the branch, not pulling.
    #[test]
    fn pre_receive_error_classifies_gh005_ref_too_long() {
        let stderr = "remote: error: GH005: Sorry, refs longer than 255 bytes are not allowed.\nremote: ref too long: \"refs/heads/user/some-extremely-long-generated-branch-name\"\n ! [remote rejected] x -> x (pre-receive hook declined)\nerror: failed to push some refs to 'https://github.com/o/r.git'";
        let err = push_pre_receive_error(stderr).expect("must classify GH005");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("branch name is too long"), "got: {msg}");
        assert!(msg.contains("Rename"), "must suggest renaming, got: {msg}");
    }

    // An ordinary non-fast-forward race must NOT classify — it stays on the
    // existing PUSH_REJECTED path with its dedicated pull-first UI.
    #[test]
    fn pre_receive_error_ignores_ordinary_push_race() {
        let stderr = " ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected because the tip of your current branch is behind";
        assert!(push_pre_receive_error(stderr).is_none());
        assert!(push_pre_receive_error("").is_none());
        // Other pre-receive declines (branch protection etc.) fall through to
        // the existing arms too.
        assert!(push_pre_receive_error(
            "remote: error: GH006: Protected branch update failed for refs/heads/main"
        )
        .is_none());
    }

    /// The network git helper must actually execute git through the timeout path
    /// (the whole point of A8 — replacing blocking `.output()` so a hung remote
    /// can't freeze publishing). `--version` needs no repo or remote, so this is
    /// deterministic and guards the `create_command` + `run_with_timeout` wiring.
    #[tokio::test]
    async fn run_git_net_executes_git_through_timeout() {
        let out = run_git_net(&["--version"], Path::new("."), "--version")
            .await
            .expect("git --version should run within the timeout");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("git version"));
    }
}
