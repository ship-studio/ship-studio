//! Carrying comment records between machines, on a ref of their own.
//!
//! Comments cannot ride your work commits the way update records do. A comment
//! has no work commit to ride, and one written on `feat/x` that only becomes
//! visible when `feat/x` merges is not a comment — it is a note to yourself.
//!
//! So they travel on `refs/heads/shipstudio-team`: a branch nobody checks out,
//! holding nothing but `.shipstudio-team/threads/`. That buys four things at
//! once:
//!
//! - **Cross-branch.** Everyone fetches the same ref regardless of what they
//!   have checked out, so a comment is visible the moment it is pushed.
//! - **Your tree is never touched.** The commit is built with a temporary index
//!   and `commit-tree`, so `git status`, your staged changes and your branch are
//!   exactly as you left them. This runs while you are mid-rebase and does
//!   nothing to you.
//! - **PR diffs stay clean.** Comment traffic is not in any branch you review.
//! - **It is small.** A few KB of JSON, which is what makes fetching it on a
//!   timer defensible where fetching the whole remote would not be.
//!
//! ## Merging is a union, and that is not a simplification
//!
//! Records are immutable and named by ULID. Two machines can never write
//! different content to the same path, so combining two versions of this ref is
//! "take every file from both" — no three-way merge, no conflict, no resolution
//! UI, ever. That property is the entire reason the storage format is what it
//! is, and it is what lets this module get away with being this short.
//!
//! ## What it does not do
//!
//! It never runs on its own. Every entry point here is called by an explicit
//! sync, because a background push to someone's remote is a surprise with their
//! credentials attached. The schedule lives in the frontend, where the user can
//! see it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::external_command::run_with_timeout;
use crate::utils::git_command_in;

use super::TEAM_DIR;

/// The ref comment records live on, on both sides.
pub const TEAM_REF: &str = "refs/heads/shipstudio-team";
/// The branch name comment records live under. Public so the history walk can
/// skip it: this ref is the feature's own plumbing, never anybody's work.
pub const TEAM_BRANCH: &str = "shipstudio-team";
const REMOTE_REF: &str = "refs/remotes/origin/shipstudio-team";

/// The path inside the repository that this ref carries.
const THREADS_PATH: &str = ".shipstudio-team/threads";

/// Local git work. Generous, because a big repo's first `read-tree` is slow.
const GIT_TIMEOUT_SECS: u64 = 30;
/// Anything that talks to the remote.
const NET_TIMEOUT_SECS: u64 = 60;

/// How many times a push retries after losing a race.
///
/// A rejected push means somebody else pushed between our fetch and our push.
/// The fix is to rebuild on their tip and try again — which is cheap, and
/// cannot loop forever because each attempt starts from a newer tip.
const PUSH_ATTEMPTS: u32 = 3;

/// What a sync did, so the UI can say something true about it.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// Records that arrived from other people.
    pub pulled: usize,
    /// Records of ours that are now on the remote.
    pub pushed: usize,
    /// Records written locally that are not on the remote yet.
    pub pending: usize,
    /// Why the remote half did not happen, in the remote's own words.
    pub error: Option<String>,
    /// Whether there is a remote to talk to at all.
    pub has_remote: bool,
}

async fn git(project: &Path, args: &[&str], timeout: u64) -> Result<String, String> {
    let mut cmd = git_command_in(project).map_err(|e| e.to_string())?;
    cmd.args(args);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        format!("git {}", args.first().copied().unwrap_or("?")),
        timeout,
    )
    .await
    .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A git command run against a scratch index, so the user's own index is not
/// touched. This is the whole trick that makes the module safe to run at any
/// moment.
async fn git_with_index(
    project: &Path,
    index: &Path,
    args: &[&str],
    timeout: u64,
) -> Result<String, String> {
    let mut cmd = git_command_in(project).map_err(|e| e.to_string())?;
    cmd.env("GIT_INDEX_FILE", index);
    cmd.args(args);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        format!("git {}", args.first().copied().unwrap_or("?")),
        timeout,
    )
    .await
    .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Keep thread records out of the user's own commits, without editing a file
/// they track.
///
/// `.git/info/exclude` is `.gitignore` that is never committed and never shows
/// up in a diff. Writing their `.gitignore` instead would put our line in their
/// next commit and their next code review, which is not ours to do.
///
/// Idempotent, and it appends rather than rewrites — the file is the user's.
pub fn exclude_threads_from_working_tree(project: &Path) -> std::io::Result<()> {
    let info = project.join(".git").join("info");
    let exclude = info.join("exclude");
    let line = format!("{THREADS_PATH}/");

    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|entry| entry.trim() == line) {
        return Ok(());
    }

    std::fs::create_dir_all(&info)?;
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let addition = format!(
        "{separator}\n# Harbr comment records. They travel on their own ref\n\
         # ({TEAM_BRANCH}) rather than in your branches, so they are never part\n\
         # of your commits or your pull requests.\n{line}\n"
    );
    std::fs::write(&exclude, format!("{existing}{addition}"))
}

/// Every thread record on disk, as repo-relative paths.
fn local_record_paths(project: &Path) -> Vec<String> {
    let root = project.join(TEAM_DIR).join("threads");
    let mut out = Vec::new();
    let Ok(days) = std::fs::read_dir(&root) else {
        return out;
    };
    for day in days.flatten().filter(|d| d.path().is_dir()) {
        let Ok(files) = std::fs::read_dir(day.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                if let (Some(day_name), Some(file_name)) = (
                    day.file_name().to_str(),
                    path.file_name().and_then(|n| n.to_str()),
                ) {
                    out.push(format!("{THREADS_PATH}/{day_name}/{file_name}"));
                }
            }
        }
    }
    out.sort();
    out
}

/// Every record path carried by a ref, or an empty set when the ref is absent.
async fn record_paths_in_ref(project: &Path, git_ref: &str) -> HashSet<String> {
    let listing = git(
        project,
        &["ls-tree", "-r", "--name-only", git_ref, "--", THREADS_PATH],
        GIT_TIMEOUT_SECS,
    )
    .await;

    match listing {
        Ok(text) => text.lines().map(str::to_string).collect(),
        // No such ref is the normal state before anyone has synced.
        Err(_) => HashSet::new(),
    }
}

/// Whether a ref exists locally.
async fn ref_exists(project: &Path, git_ref: &str) -> bool {
    git(
        project,
        &["rev-parse", "--verify", "--quiet", git_ref],
        GIT_TIMEOUT_SECS,
    )
    .await
    .is_ok_and(|out| !out.is_empty())
}

/// Write every record the ref has and the disk does not.
///
/// Only ever creates files. A record is immutable, so a path that already
/// exists locally holds identical content by construction, and overwriting it
/// would be pointless work that could truncate a file another thread is reading.
async fn materialise(project: &Path, git_ref: &str) -> Result<usize, String> {
    if !ref_exists(project, git_ref).await {
        return Ok(0);
    }
    let remote = record_paths_in_ref(project, git_ref).await;
    let mut written = 0;

    for path in remote {
        let target = project.join(&path);
        if target.exists() {
            continue;
        }
        let blob = git(
            project,
            &["show", &format!("{git_ref}:{path}")],
            GIT_TIMEOUT_SECS,
        )
        .await?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Written and renamed, because the reader is a directory scan that can
        // run at any moment — the same reason the writer does it.
        let temp = target.with_extension("json.incoming");
        std::fs::write(&temp, format!("{blob}\n")).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

/// Build a commit holding every local record, on top of `parent`.
///
/// Uses a scratch index file, so nothing here can disturb what the user has
/// staged. Returns `None` when the resulting tree is identical to the parent's
/// — there is nothing to say, and an empty commit on a shared ref is noise
/// every teammate has to fetch.
async fn commit_records(
    project: &Path,
    parent: Option<&str>,
    author: &str,
) -> Result<Option<String>, String> {
    let index = scratch_index_path(project);
    let _ = std::fs::remove_file(&index);

    // Start from the parent's tree so other people's records survive: the index
    // is a full picture of the ref, not a picture of this machine.
    if let Some(parent) = parent {
        git_with_index(project, &index, &["read-tree", parent], GIT_TIMEOUT_SECS).await?;
    }

    let paths = local_record_paths(project);
    if paths.is_empty() && parent.is_none() {
        let _ = std::fs::remove_file(&index);
        return Ok(None);
    }

    if !paths.is_empty() {
        // `--force`, because these paths are deliberately in `.git/info/exclude`.
        // That entry exists to keep records out of the *user's* status and
        // commits; this index is ours, and it is the one place they belong.
        let mut args: Vec<&str> = vec!["add", "--force", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_with_index(project, &index, &args, GIT_TIMEOUT_SECS).await?;
    }

    let tree = git_with_index(project, &index, &["write-tree"], GIT_TIMEOUT_SECS).await?;
    let _ = std::fs::remove_file(&index);

    if let Some(parent) = parent {
        let parent_tree = git(project, &[&format!("{parent}^{{tree}}")], GIT_TIMEOUT_SECS)
            .await
            .unwrap_or_default();
        let parent_tree = if parent_tree.is_empty() {
            git(
                project,
                &["rev-parse", &format!("{parent}^{{tree}}")],
                GIT_TIMEOUT_SECS,
            )
            .await
            .unwrap_or_default()
        } else {
            parent_tree
        };
        if parent_tree == tree {
            return Ok(None);
        }
    }

    let message = format!("Harbr comments from {author}");
    let mut args: Vec<&str> = vec!["commit-tree", &tree, "-m", &message];
    if let Some(parent) = parent {
        args.push("-p");
        args.push(parent);
    }
    let commit = git(project, &args, GIT_TIMEOUT_SECS).await?;
    Ok(Some(commit))
}

/// Where the scratch index lives. Inside `.git`, so it is never the user's
/// problem and is cleaned by anything that cleans the repo.
fn scratch_index_path(project: &Path) -> PathBuf {
    project
        .join(".git")
        .join(format!("shipstudio-team-index-{}", std::process::id()))
}

/// How many local records are not on the remote yet.
///
/// Read rather than remembered: a count kept in memory drifts the moment
/// anything writes a record outside this process — an agent following the
/// bundled skill, or a second Harbr window on the same project.
pub async fn pending_count(project: &Path) -> u32 {
    let local: HashSet<String> = local_record_paths(project).into_iter().collect();
    let published = record_paths_in_ref(project, REMOTE_REF).await;
    local.difference(&published).count() as u32
}

/// Fetch the remote's records, write the new ones to disk, then publish ours.
///
/// Ordered deliberately: read before write. Pulling first means the commit we
/// build already contains everyone else's records, so the push is a
/// fast-forward in the normal case rather than a race we then have to retry.
pub async fn sync(project: &Path, author: &str, has_remote: bool) -> SyncOutcome {
    let mut outcome = SyncOutcome {
        has_remote,
        ..Default::default()
    };

    // Best-effort and never fatal: a repo where this fails still gets local
    // comments, and failing the sync over an ignore file would be absurd.
    let _ = exclude_threads_from_working_tree(project);

    if has_remote {
        match git(
            project,
            &[
                "fetch",
                "--quiet",
                "origin",
                &format!("+{TEAM_REF}:{REMOTE_REF}"),
            ],
            NET_TIMEOUT_SECS,
        )
        .await
        {
            Ok(_) => match materialise(project, REMOTE_REF).await {
                Ok(count) => outcome.pulled = count,
                Err(error) => outcome.error = Some(error),
            },
            Err(error) => {
                // A remote with no such ref yet is not a failure — it is what
                // every repository looks like before the first comment.
                if !is_missing_ref(&error) {
                    outcome.error = Some(error);
                }
            }
        }
    }

    // Local records the remote has not got. This is the number the UI shows,
    // and it is computed rather than tracked, so it cannot drift.
    let local: HashSet<String> = local_record_paths(project).into_iter().collect();
    let published = record_paths_in_ref(project, REMOTE_REF).await;
    let unpublished: Vec<&String> = local.difference(&published).collect();
    outcome.pending = unpublished.len();

    if outcome.pending == 0 || !has_remote || outcome.error.is_some() {
        return outcome;
    }

    match publish(project, author).await {
        Ok(pushed) => {
            outcome.pushed = pushed;
            outcome.pending -= pushed.min(outcome.pending);
        }
        Err(error) => outcome.error = Some(error),
    }
    outcome
}

/// Commit the local records onto the remote tip and push, retrying a lost race.
async fn publish(project: &Path, author: &str) -> Result<usize, String> {
    let mut last_error = String::new();

    for attempt in 0..PUSH_ATTEMPTS {
        if attempt > 0 {
            // Somebody pushed between our read and our write. Take their tip,
            // add ours on top, and try again — the union means there is nothing
            // to resolve.
            let _ = git(
                project,
                &[
                    "fetch",
                    "--quiet",
                    "origin",
                    &format!("+{TEAM_REF}:{REMOTE_REF}"),
                ],
                NET_TIMEOUT_SECS,
            )
            .await;
            let _ = materialise(project, REMOTE_REF).await;
        }

        let parent = ref_exists(project, REMOTE_REF)
            .await
            .then(|| REMOTE_REF.to_string());
        let before = record_paths_in_ref(project, REMOTE_REF).await;

        let Some(commit) = commit_records(project, parent.as_deref(), author).await? else {
            return Ok(0);
        };

        let pushed = local_record_paths(project)
            .into_iter()
            .filter(|path| !before.contains(path))
            .count();

        match git(
            project,
            &["push", "--quiet", "origin", &format!("{commit}:{TEAM_REF}")],
            NET_TIMEOUT_SECS,
        )
        .await
        {
            Ok(_) => {
                // Point the local mirror at what we just pushed, so the next
                // sync's "what is published" answer is right without a fetch.
                let _ = git(
                    project,
                    &["update-ref", REMOTE_REF, &commit],
                    GIT_TIMEOUT_SECS,
                )
                .await;
                return Ok(pushed);
            }
            Err(error) => last_error = error,
        }
    }

    Err(humanise_push_failure(&last_error))
}

/// A remote that has never had this ref pushed to it.
fn is_missing_ref(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("couldn't find remote ref") || lower.contains("could not find remote ref")
}

/// Say what a reader can act on, and keep git's own words for what we cannot
/// explain.
fn humanise_push_failure(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("permission")
        || lower.contains("403")
        || lower.contains("access rights")
        || lower.contains("does not appear to be a git repository")
    {
        return "Comments could not be shared: this account cannot push to the repository. \
                They are saved on this machine."
            .to_string();
    }
    if lower.contains("could not resolve host")
        || lower.contains("network is unreachable")
        || lower.contains("timed out")
    {
        return "Comments could not be shared: the remote is unreachable. They are saved on \
                this machine and will go out on the next sync."
            .to_string();
    }
    if lower.contains("authentication")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
    {
        return "Comments could not be shared: git could not authenticate with the remote. \
                They are saved on this machine."
            .to_string();
    }
    format!("Comments could not be shared. {stderr}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_remote_ref_is_not_reported_as_a_failure() {
        assert!(is_missing_ref(
            "fatal: couldn't find remote ref refs/heads/shipstudio-team"
        ));
        assert!(!is_missing_ref("fatal: Authentication failed"));
    }

    #[test]
    fn push_failures_say_what_happened_to_the_comments() {
        // Every one of these has to end with the person knowing their words are
        // not lost, because that is the only question they have.
        for stderr in [
            "remote: Permission to acme/site.git denied",
            "fatal: could not resolve host: github.com",
            "fatal: could not read Username for 'https://github.com'",
        ] {
            let message = humanise_push_failure(stderr);
            assert!(
                message.contains("saved on this machine"),
                "unhelpful message for {stderr:?}: {message}"
            );
        }
    }

    #[test]
    fn an_unknown_failure_keeps_gits_own_words_rather_than_inventing_a_reason() {
        let message = humanise_push_failure("fatal: the remote end hung up unexpectedly");
        assert!(message.contains("the remote end hung up unexpectedly"));
    }
}
