//! The half of the feed that needs nobody to adopt anything.
//!
//! Everything here comes out of `git log` and `gh pr list`, so it works on the
//! first launch, on a repo nobody else has ever opened in Harbr, and for
//! the teammate who pushes from the terminal and always will. That is the whole
//! point: the feature has to be useful at zero adoption or it never gets any.
//!
//! ## What a row is
//!
//! Not one row per commit — that is the git log with faces on it the design
//! doc rejects. Commits are grouped into a **stint**: the same author, on the
//! same branch, with no gap longer than [`STINT_GAP_MS`]. That is as close to
//! "a sitting of work" as a repo can prove, and it is what a push usually is.
//!
//! The headline is the newest commit's subject, **verbatim**. It is often bad
//! ("wip", "fix"), and it is allowed to be: a bad headline is an honest report
//! of a bad commit message, and it is the argument for the skill made in the
//! UI. Rewriting it with an LLM would invent the one thing this row cannot
//! know.
//!
//! ## Attributing a commit to a branch
//!
//! `git log --all` knows commits, not branches. So the walk is per-ref instead:
//! for each branch, `git log <base>..<branch>` gives the commits that are
//! *that branch's own work*, and the base branch is walked directly for
//! everything already integrated. A commit reachable from several branches is
//! attributed once, preferring the topic branch over the base — the branch it
//! was written on is the one a reader wants to see.

use std::collections::{HashMap, HashSet};

use crate::commands::github::get_gh_command_for_project;
use crate::external_command::run_with_timeout;
use crate::utils::git_command_in;

use super::transport::TEAM_BRANCH;
use super::{TeamActor, TeamCommit, TeamUpdateStatus};

/// How long a walk of local history may take. Generous: a cold `git log` on a
/// large repo is slow once and warm afterwards, and the Team panel is polled in
/// the background rather than blocking anything the user is looking at.
const GIT_TIMEOUT_SECS: u64 = 30;

/// Network-facing `gh` calls. Matches `pull_requests.rs`.
const GH_TIMEOUT_SECS: u64 = 60;

/// The gap that ends a stint. Two commits more than this far apart are two
/// separate pieces of work even from the same person on the same branch —
/// roughly "after lunch is a different sitting".
const STINT_GAP_MS: i64 = 4 * 60 * 60 * 1000;

/// The longest a single stint may span, and the most commits it may hold.
///
/// The gap rule alone is not enough, and a real repo proves it in seconds:
/// someone committing every half hour for a fortnight never opens a gap, so the
/// whole fortnight chains into one row. Against this repo that produced a
/// single card reading "Release v1.2.0 — 77 commits, 135 files, 8,695 lines",
/// which is not a thing anybody did; it is two weeks of work wearing the last
/// commit's subject.
///
/// Both caps are needed. The span catches the slow chain; the count catches a
/// rebase or a squash-merge that lands two hundred commits in one second.
const STINT_MAX_SPAN_MS: i64 = 8 * 60 * 60 * 1000;
const STINT_MAX_COMMITS: usize = 12;

/// How far back the feed looks. Longer than anyone scrolls, short enough that
/// a decade-old repo does not walk its whole history on every poll.
const HISTORY_DAYS: u32 = 30;

/// Per-branch commit cap, so one branch with ten thousand commits cannot
/// dominate the walk.
const MAX_COMMITS_PER_BRANCH: u32 = 200;

/// How many branches are walked at once. Enough to hide the per-spawn cost,
/// low enough that a repo with a hundred live branches does not launch a
/// hundred gits and lose to its own context switching.
const WALK_CONCURRENCY: usize = 8;

/// A commit as git reports it, before it is grouped into anything.
#[derive(Debug, Clone)]
pub struct RawCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    /// Unix milliseconds, author date.
    pub at: i64,
    pub author_name: String,
    pub author_email: String,
    pub branch: String,
    /// The commit body — everything under the subject, trailers stripped. This
    /// is the "why", written where every other tool can already read it.
    pub body: Option<String>,
    /// Which agent wrote it, from a `Made-With` trailer.
    pub made_with: Option<String>,
    /// True for a commit with more than one parent. Merges are real work
    /// landing, but their subject ("Merge pull request #139 from …") describes
    /// the merge rather than the change.
    pub is_merge: bool,
    /// What this commit touched, read from the same `git log --numstat` that
    /// produced everything above. Empty for a merge, which `git log` shows no
    /// diff for — [`files_for`] handles that case separately.
    pub files: Vec<super::TeamFileTouch>,
}

/// A group of commits by one person, on one branch, in one sitting.
#[derive(Debug, Clone)]
pub struct Stint {
    pub commits: Vec<RawCommit>,
    pub branch: String,
    pub author_name: String,
    pub author_email: String,
    /// Newest commit's timestamp — a stint is dated by when it finished.
    pub at: i64,
    /// Which agent wrote the work, if any commit in the stint said so.
    pub made_with: Option<String>,
}

impl Stint {
    /// The newest commit — the one whose subject becomes the headline.
    pub fn tip(&self) -> &RawCommit {
        &self.commits[0]
    }

    pub fn evidence(&self) -> Vec<TeamCommit> {
        self.commits
            .iter()
            .map(|commit| TeamCommit {
                sha: commit.short_sha.clone(),
                message: commit.subject.clone(),
            })
            .collect()
    }
}

/// An open or recently closed pull request, keyed by its head branch.
#[derive(Debug, Clone)]
pub struct PrSummary {
    pub number: i64,
    pub state: String,
    pub url: String,
    pub review_requested: bool,
    pub has_reviews: bool,
}

impl PrSummary {
    /// Status for work sitting behind this PR.
    ///
    /// `in-review` requires evidence that a review actually exists or was
    /// asked for; an open PR nobody has looked at is `needs-review`, which is
    /// the state the reader can act on.
    pub fn status(&self) -> TeamUpdateStatus {
        match self.state.as_str() {
            "MERGED" => TeamUpdateStatus::Merged,
            // A PR that was closed without merging is *finished* — reviewed or
            // not. Checking the review flags first said "In review" about work
            // abandoned months ago, which is the kind of confidently wrong
            // status that makes a whole feed untrustworthy.
            "CLOSED" => TeamUpdateStatus::Working,
            _ if self.has_reviews || self.review_requested => TeamUpdateStatus::InReview,
            _ => TeamUpdateStatus::NeedsReview,
        }
    }
}

/// A single `git log` field separator. Chosen because it cannot appear in a
/// commit subject, author name or email — unlike the tab and pipe characters a
/// first pass would reach for, both of which do.
const FIELD: &str = "\u{1f}";
/// Record separator, same reasoning.
const RECORD: &str = "\u{1e}";

/// Run a git command in the project and return stdout, or `None` if it failed.
///
/// Failure is not propagated: every caller here is enriching a feed, and a repo
/// with no commits, no remote, or no such branch is an ordinary state rather
/// than an error to put in front of the user.
async fn git_stdout(project: &std::path::Path, args: &[&str]) -> Option<String> {
    let mut cmd = git_command_in(project).ok()?;
    cmd.args(args);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        format!("git {}", args.first().copied().unwrap_or("?")),
        GIT_TIMEOUT_SECS,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The branch a repo integrates into: `origin/HEAD` if the remote says so,
/// else whichever of the usual names exists.
///
/// Deliberately asks the remote first. A repo whose default is `develop` or
/// `trunk` is not exotic, and treating `main` as the base there would show
/// every commit on the real base branch as unmerged work in flight.
pub async fn default_base_branch(project: &std::path::Path) -> Option<String> {
    if let Some(out) = git_stdout(project, &["symbolic-ref", "refs/remotes/origin/HEAD"]).await {
        if let Some(name) = out.trim().rsplit('/').next() {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    for candidate in ["main", "master", "develop", "trunk"] {
        let reference = format!("refs/heads/{candidate}");
        if git_stdout(project, &["rev-parse", "--verify", "--quiet", &reference])
            .await
            .is_some()
        {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Branches worth walking: every local branch plus every `origin/` branch,
/// deduplicated to the short name, **newest first and stale ones dropped**.
///
/// Remote branches matter more than local ones here — a teammate's work only
/// exists locally as `origin/their-branch`, and they are the entire reason this
/// feature exists.
///
/// The date filter is not a nicety. This repository has 195 refs, and the walk
/// spawned a `git log` for every one of them: two seconds of process churn to
/// learn that 180 branches have not moved since May. A ref whose tip predates
/// the window has nothing the feed can show, and `for-each-ref` will sort and
/// report the tip date in the same call it was already making.
async fn branches(project: &std::path::Path, cutoff_secs: i64) -> Vec<String> {
    let Some(out) = git_stdout(
        project,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )
    .await
    else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for line in out.lines() {
        let Some((raw, at)) = line.trim().split_once('\t') else {
            continue;
        };
        // `origin/HEAD` is a symbolic pointer at the base branch, not a branch
        // of its own; walking it double-counts the base.
        if raw.is_empty() || raw == "origin/HEAD" {
            continue;
        }
        // Sorted newest-first, so the first stale ref ends the list.
        if at.trim().parse::<i64>().unwrap_or(0) < cutoff_secs {
            break;
        }
        let short = raw.strip_prefix("origin/").unwrap_or(raw);
        // The ref comments travel on is this feature's own plumbing, not
        // anybody's work. Left in, every comment sync appears in the feed as
        // "Harbr comments from …" — the machinery reporting on itself,
        // pushing the actual work down the page.
        //
        // Checked after the prefix is stripped so it covers both forms. In
        // practice the ref is `origin/shipstudio-team`, since no local branch
        // is ever created — matching only the bare name would have looked
        // right and caught nothing.
        if short == TEAM_BRANCH {
            continue;
        }
        if seen.insert(short.to_string()) {
            names.push(raw.to_string());
        }
    }
    names
}

/// The trailer naming the agent behind a commit. Conventional, and already
/// written by Harbr's own push.
const MADE_WITH_TRAILER: &str = "Made-With";

/// A commit body worth showing.
///
/// Trailers are stripped. `Co-Authored-By`, `Made-With` and friends are
/// metadata *about* the commit rather than the explanation *of* it, and
/// rendering them as prose drops an email address into the middle of someone's
/// reasoning.
fn clean_body(body: &str) -> Option<String> {
    let is_trailer = |line: &str| {
        let trimmed = line.trim();
        trimmed.split_once(": ").is_some_and(|(key, _)| {
            !key.is_empty()
                && !key.contains(' ')
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
    };

    let text = body
        .lines()
        .filter(|line| !is_trailer(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// Parse one `git log` record produced by [`log_format`].
///
/// A chunk is the formatted fields followed by this commit's `--numstat`
/// lines, so the trailing field separator marks where one ends and the other
/// begins.
fn parse_commit(chunk: &str, branch: &str) -> Option<RawCommit> {
    let mut parts = chunk.split(FIELD);
    let sha = parts.next()?.trim().to_string();
    let short_sha = parts.next()?.trim().to_string();
    let at_secs: i64 = parts.next()?.trim().parse().ok()?;
    let author_name = parts.next()?.trim().to_string();
    let author_email = parts.next()?.trim().to_lowercase();
    let parents = parts.next()?.trim().to_string();
    let subject = parts.next()?.trim().to_string();
    let body = parts.next().unwrap_or("").to_string();
    // `%(trailers:…,valueonly=true)` yields an empty string when the trailer is
    // absent and the bare value when it is present.
    let made_with = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let numstat = parts.next().unwrap_or("");

    if sha.is_empty() {
        return None;
    }

    Some(RawCommit {
        sha,
        short_sha,
        at: at_secs * 1000,
        author_name,
        author_email,
        // A merge has two or more parents, so the parent list has a space in it.
        is_merge: parents.split_whitespace().count() > 1,
        subject,
        body: clean_body(&body),
        branch: branch.to_string(),
        made_with,
        files: parse_numstat(numstat),
    })
}

/// `git`'s `--numstat` block: `<added>\t<removed>\t<path>` per line.
fn parse_numstat(block: &str) -> Vec<super::TeamFileTouch> {
    block
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let (added, removed, path) = (parts.next()?, parts.next()?, parts.next()?);
            if path.is_empty() {
                return None;
            }
            Some(super::TeamFileTouch {
                path: path.to_string(),
                // Binary files report "-" for both counts. They changed; by how
                // much is not a number, so it stays zero rather than a guess.
                added: added.trim().parse().unwrap_or(0),
                removed: removed.trim().parse().unwrap_or(0),
            })
        })
        .collect()
}

/// Fields, in the order [`parse_commit`] reads them.
///
/// The record separator leads rather than trails, which matters: `--numstat`
/// prints its lines *after* the formatted header, so a trailing separator would
/// leave every commit's file list stranded in the next commit's chunk.
fn log_format() -> String {
    format!(
        // `%b` is the commit body — the paragraph under the subject, where
        // "why" has always belonged. Reading it is the whole reason updates
        // need no record format of their own.
        "{RECORD}%H{FIELD}%h{FIELD}%at{FIELD}%an{FIELD}%ae{FIELD}%P{FIELD}%s{FIELD}%b{FIELD}%(trailers:key={key},valueonly=true){FIELD}",
        key = MADE_WITH_TRAILER,
    )
}

/// Walk every branch and return the commits of the last [`HISTORY_DAYS`] days,
/// each attributed to one branch.
pub async fn walk_commits(project: &std::path::Path, base: Option<&str>) -> Vec<RawCommit> {
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        - i64::from(HISTORY_DAYS) * 86_400;

    let since = format!("--since={HISTORY_DAYS} days ago");
    let max = format!("--max-count={MAX_COMMITS_PER_BRANCH}");
    let format = format!("--format={}", log_format());

    // Topic branches first so that when a commit is reachable from both, the
    // branch it was written on wins.
    let mut refs = branches(project, cutoff).await;
    if let Some(base) = base {
        refs.sort_by_key(|name| {
            let short = name.strip_prefix("origin/").unwrap_or(name);
            short == base
        });
    }

    // Branches are read concurrently but folded in the order above, so a
    // commit reachable from two of them still lands on the topic branch every
    // time. Ordering the *results* rather than the *work* is what lets this be
    // parallel without becoming non-deterministic.
    let jobs: Vec<(String, Vec<String>)> = refs
        .iter()
        .map(|reference| {
            let short = reference
                .strip_prefix("origin/")
                .unwrap_or(reference)
                .to_string();
            // A topic branch is walked as its own work only (`base..branch`);
            // the base branch is walked directly, since everything on it *is*
            // the integrated history.
            let range = match base {
                Some(base) if base != short => format!("{base}..{reference}"),
                _ => reference.clone(),
            };
            // Merges are kept. On the base branch they are usually the *only*
            // record that a PR landed, and "Theo merged #139" is a real thing
            // that happened to the project.
            //
            // `--numstat` here rather than a `git show` per commit later. That
            // was 300 extra process spawns and four seconds on this repo, to
            // compute something this call already had in hand.
            let args = vec![
                "log".to_string(),
                range,
                since.clone(),
                max.clone(),
                format.clone(),
                "--numstat".to_string(),
            ];
            (short, args)
        })
        .collect();

    let mut by_sha: HashMap<String, RawCommit> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    // Chunked rather than all at once: a repo with a hundred live branches
    // would otherwise launch a hundred gits together and lose to its own
    // context switching.
    for batch in jobs.chunks(WALK_CONCURRENCY) {
        let outputs =
            futures_util::future::join_all(batch.iter().map(|(short, args)| async move {
                let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
                (short.as_str(), git_stdout(project, &borrowed).await)
            }))
            .await;

        for (short, out) in outputs {
            let Some(out) = out else { continue };
            for chunk in out.split(RECORD) {
                let chunk = chunk.trim_start_matches('\n');
                if chunk.trim().is_empty() {
                    continue;
                }
                let Some(commit) = parse_commit(chunk, short) else {
                    continue;
                };
                if !by_sha.contains_key(&commit.sha) {
                    order.push(commit.sha.clone());
                    by_sha.insert(commit.sha.clone(), commit);
                }
            }
        }
    }

    let mut commits: Vec<RawCommit> = order
        .into_iter()
        .filter_map(|sha| by_sha.remove(&sha))
        .collect();
    commits.sort_by(|a, b| b.at.cmp(&a.at));
    commits
}

/// Group commits into stints. Input must be newest-first.
pub fn group_into_stints(commits: Vec<RawCommit>) -> Vec<Stint> {
    let mut stints: Vec<Stint> = Vec::new();

    for commit in commits {
        let joined = stints.iter_mut().rev().find(|stint| {
            stint.author_email == commit.author_email
                && stint.branch == commit.branch
                && stint.commits.len() < STINT_MAX_COMMITS
                && stint.at - commit.at <= STINT_MAX_SPAN_MS
                // Commits arrive newest-first, so the open stint's oldest
                // commit is the one to measure the gap against.
                && stint
                    .commits
                    .last()
                    .is_some_and(|oldest| oldest.at - commit.at <= STINT_GAP_MS)
        });

        match joined {
            Some(stint) => {
                if stint.made_with.is_none() {
                    stint.made_with = commit.made_with.clone();
                }
                stint.commits.push(commit);
            }
            None => stints.push(Stint {
                branch: commit.branch.clone(),
                author_name: commit.author_name.clone(),
                author_email: commit.author_email.clone(),
                at: commit.at,
                made_with: commit.made_with.clone(),
                commits: vec![commit],
            }),
        }
    }

    stints
}

/// Files a stint touched, with line counts.
///
/// Free for an ordinary stint: `walk_commits` already read every commit's
/// `--numstat` in the same `git log` that produced the commit itself, so this
/// is a fold rather than a fetch.
///
/// ## Merges are diffed against their first parent, and only when alone
///
/// A merge has no single diff, so `git log --numstat` shows none for one. That
/// is the right default: whenever the stint holds ordinary commits too, those
/// already account for the same lines and adding the merge would count them
/// twice.
///
/// A stint that is *only* a merge is the case where showing nothing is wrong.
/// "Merged pull request #881 — 0 files" is not restraint, it is a row with its
/// content missing, and it is what this did against a real repo. There the
/// first-parent diff is exactly the right number: what the merge brought in.
/// That costs one `git diff`, for the handful of stints shaped that way.
pub async fn files_for(project: &std::path::Path, stint: &Stint) -> Vec<super::TeamFileTouch> {
    let merges_only = stint.commits.iter().all(|commit| commit.is_merge);

    // Gathered first, folded second: a closure that borrows both accumulators
    // has to be dead before either can be read back, and saying so with a
    // `drop` is a note-to-self where a scope is a rule.
    let mut touched: Vec<super::TeamFileTouch> = Vec::new();
    if merges_only {
        for commit in &stint.commits {
            let first_parent = format!("{}^1", commit.sha);
            let Some(out) =
                git_stdout(project, &["diff", "--numstat", &first_parent, &commit.sha]).await
            else {
                continue;
            };
            touched.extend(parse_numstat(&out));
        }
    } else {
        for commit in stint.commits.iter().filter(|c| !c.is_merge) {
            touched.extend(commit.files.iter().cloned());
        }
    }

    // Summed per path, in the order each path was first touched, so the list
    // reads as the work happened rather than alphabetically.
    let mut totals: HashMap<String, (u32, u32)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for file in touched {
        let entry = totals.entry(file.path.clone()).or_insert_with(|| {
            order.push(file.path);
            (0, 0)
        });
        entry.0 += file.added;
        entry.1 += file.removed;
    }

    order
        .into_iter()
        .filter_map(|path| {
            totals
                .remove(&path)
                .map(|(added, removed)| super::TeamFileTouch {
                    path,
                    added,
                    removed,
                })
        })
        .collect()
}

/// Pull requests keyed by head branch, open and recently merged.
///
/// Returns an empty map rather than an error when `gh` is missing, the repo has
/// no remote, or the user is not signed in. All three are ordinary states —
/// the feed degrades to commits, which is still the feed.
pub async fn pull_requests(project: &std::path::Path) -> HashMap<String, PrSummary> {
    let mut cmd = get_gh_command_for_project(project);
    cmd.args([
        "pr",
        "list",
        "--state",
        "all",
        "--json",
        "number,headRefName,state,url,reviewRequests,reviews",
        "--limit",
        "50",
    ])
    .current_dir(project);

    let Ok(output) = run_with_timeout(
        tokio::process::Command::from(cmd),
        "gh pr list (team)".to_string(),
        GH_TIMEOUT_SECS,
    )
    .await
    else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) else {
        return HashMap::new();
    };

    let mut by_branch: HashMap<String, PrSummary> = HashMap::new();
    for row in rows {
        let (Some(number), Some(branch)) = (
            row.get("number").and_then(|v| v.as_i64()),
            row.get("headRefName").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let summary = PrSummary {
            number,
            state: row
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("OPEN")
                .to_string(),
            url: row
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            review_requested: row
                .get("reviewRequests")
                .and_then(|v| v.as_array())
                .is_some_and(|list| !list.is_empty()),
            has_reviews: row
                .get("reviews")
                .and_then(|v| v.as_array())
                .is_some_and(|list| !list.is_empty()),
        };
        // A branch can carry several PRs over its life. The highest number is
        // the current one; an older closed PR must not outrank an open reopen.
        by_branch
            .entry(branch.to_string())
            .and_modify(|existing| {
                if summary.number > existing.number {
                    *existing = summary.clone();
                }
            })
            .or_insert(summary);
    }
    by_branch
}

/// Repo collaborators, by lowercase login.
///
/// This is the only source of an avatar or a role. It needs push access, so it
/// 403s on a repo you can merely read — in which case the feed keeps the names
/// git already gave it and shows initials, rather than showing nobody.
pub async fn collaborators(
    project: &std::path::Path,
    repo: &str,
) -> HashMap<String, (Option<String>, Option<super::TeamRole>)> {
    let mut cmd = get_gh_command_for_project(project);
    cmd.args([
        "api",
        "--paginate",
        &format!("repos/{repo}/collaborators?per_page=100"),
    ])
    .current_dir(project);

    let Ok(output) = run_with_timeout(
        tokio::process::Command::from(cmd),
        "gh api collaborators".to_string(),
        GH_TIMEOUT_SECS,
    )
    .await
    else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // `--paginate` concatenates JSON arrays; parse each one it can.
    let mut people = HashMap::new();
    for value in serde_json::Deserializer::from_str(&stdout).into_iter::<serde_json::Value>() {
        let Ok(serde_json::Value::Array(rows)) = value else {
            continue;
        };
        for row in rows {
            let Some(login) = row.get("login").and_then(|v| v.as_str()) else {
                continue;
            };
            let avatar = row
                .get("avatar_url")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let permissions = row.get("permissions");
            let role = permissions.and_then(|p| {
                let flag = |key: &str| p.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
                if flag("admin") {
                    Some(super::TeamRole::Admin)
                } else if flag("maintain") {
                    Some(super::TeamRole::Maintainer)
                } else if flag("push") {
                    Some(super::TeamRole::Write)
                } else if flag("pull") {
                    Some(super::TeamRole::Read)
                } else {
                    None
                }
            });
            people.insert(login.to_lowercase(), (avatar, role));
        }
    }
    people
}

/// Map a git author to a GitHub login when the email says so.
///
/// GitHub's noreply addresses carry the login (`12345+octocat@users.noreply…`),
/// which is the one case where the mapping is a fact rather than a guess. Any
/// other email is left unmapped: matching `jane@acme.com` to a login by
/// display-name similarity is exactly the kind of invention that puts the wrong
/// person's face on someone else's work.
pub fn login_from_email(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let handle = local.split_once('+').map_or(local, |(_, rest)| rest);
    (!handle.is_empty()).then(|| handle.to_lowercase())
}

/// How many pages of `repos/{repo}/commits` to read for the identity map.
/// 100 per page; three covers a busy month without paging forever.
const IDENTITY_PAGES: u32 = 3;

/// Ask GitHub which login authored each recent commit.
///
/// This exists because one person routinely commits under several git emails —
/// `jane@acme.com` at work, `1234+jane@users.noreply.github.com` from the web
/// editor — and [`login_from_email`] can only resolve the second. Against a real
/// repo that put the same person in the People list twice, once with an avatar
/// and once without.
///
/// The fix has to be authoritative or not done at all. GitHub already maintains
/// the email→account mapping, including verified secondary addresses, and its
/// commits API returns the answer per commit. That is a *fact*; inferring it
/// from matching display names is the guess this rule exists to prevent.
///
/// Returns email → login. Empty when `gh` is missing, unauthenticated, or the
/// repo is private to someone else — in which case identities stay split, which
/// is wrong-looking but never wrong.
pub async fn identity_map(project: &std::path::Path, repo: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();

    for page in 1..=IDENTITY_PAGES {
        let mut cmd = get_gh_command_for_project(project);
        cmd.args([
            "api",
            &format!("repos/{repo}/commits?per_page=100&page={page}"),
        ])
        .current_dir(project);

        let Ok(output) = run_with_timeout(
            tokio::process::Command::from(cmd),
            "gh api commits (team identities)".to_string(),
            GH_TIMEOUT_SECS,
        )
        .await
        else {
            break;
        };
        if !output.status.success() {
            break;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(&stdout)
        else {
            break;
        };
        if rows.is_empty() {
            break;
        }

        for row in rows {
            // `author` is the GitHub *account*; `commit.author` is what git
            // recorded. A commit whose email GitHub cannot place has
            // `author: null`, and that is left unmapped rather than filled in.
            let (Some(login), Some(email)) = (
                row.pointer("/author/login").and_then(|v| v.as_str()),
                row.pointer("/commit/author/email").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            map.insert(email.to_lowercase(), login.to_lowercase());
        }
    }

    map
}

/// The signed-in user's own git email, so at minimum *you* are one person.
///
/// The cheap half of [`identity_map`], and the one that always works: it needs
/// no network, no `gh`, and no repo permissions. Worth having on its own,
/// because you appearing in your own team list twice is the most visible form
/// of the bug and the one most likely to be read as the feature being broken.
pub async fn own_git_email(project: &std::path::Path) -> Option<String> {
    let out = git_stdout(project, &["config", "user.email"]).await?;
    let email = out.trim().to_lowercase();
    (!email.is_empty()).then_some(email)
}

/// The branch that is checked out, or `None` on a detached HEAD.
#[allow(dead_code)]
pub async fn current_branch(project: &std::path::Path) -> Option<String> {
    let out = git_stdout(project, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let name = out.trim().to_string();
    (!name.is_empty() && name != "HEAD").then_some(name)
}

/// The name git would put on a commit from here.
///
/// Read from config rather than invented, and read even outside a repository —
/// `git config` answers from the global file, which is what makes a comment on
/// a plain folder carry a real name instead of a placeholder.
pub async fn own_git_name(project: &std::path::Path) -> Option<String> {
    let out = git_stdout(project, &["config", "user.name"]).await?;
    let name = out.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// The web URL for a commit or a PR on the project's remote.
pub fn github_url_for(repo: Option<&str>, pr: Option<&PrSummary>, sha: &str) -> Option<String> {
    if let Some(pr) = pr {
        if !pr.url.is_empty() {
            return Some(pr.url.clone());
        }
    }
    repo.map(|repo| format!("https://github.com/{repo}/commit/{sha}"))
}

/// Everything GitHub was able to tell us about who is who.
///
/// Bundled rather than passed as four arguments because these three are always
/// resolved together and are meaningless apart.
#[derive(Debug, Default)]
pub struct People {
    /// login → (avatar, role), from the collaborators API.
    pub collaborators: HashMap<String, (Option<String>, Option<super::TeamRole>)>,
    /// git email → login, from the commits API. See [`identity_map`].
    pub identities: HashMap<String, String>,
    /// The signed-in login, lowercased.
    pub me: Option<String>,
}

impl People {
    /// The login behind a git email, if one can be established as fact.
    ///
    /// Two sources, both authoritative, neither a guess: GitHub's own
    /// email→account mapping, and the login encoded in a noreply address.
    pub fn login_for(&self, email: &str) -> Option<String> {
        let email = email.to_lowercase();
        self.identities
            .get(&email)
            .cloned()
            .or_else(|| login_from_email(&email))
    }
}

/// Actor for a git author, enriched with whatever GitHub could confirm.
pub fn actor_for(name: &str, email: &str, people: &People) -> TeamActor {
    let login = people.login_for(email);
    let avatar = login
        .as_ref()
        .and_then(|login| people.collaborators.get(login))
        .and_then(|(avatar, _)| avatar.clone());
    TeamActor {
        login,
        name: name.to_string(),
        avatar_url: avatar,
    }
}

/// Whether there is any history here to read.
///
/// A question, not a guard. Everything this module derives comes from history,
/// so a folder without it gets no updates and no members — but comments are
/// files and work regardless, which is why the caller branches on this instead
/// of failing on it.
pub async fn is_repo(project: &std::path::Path) -> bool {
    project.join(".git").exists()
}

/// Tests that build a real repository and walk it.
///
/// The unit tests below operate on structs this module fabricates, which means
/// they cannot catch the failure that actually matters: a `--format` string
/// whose fields do not line up with the parser reading them. That bug produces
/// a plausible-looking empty feed and no error anywhere. So these do it for
/// real — `git init`, commit, branch, and read it back.
#[cfg(test)]
mod repo_tests {
    use super::*;

    struct Repo {
        dir: std::path::PathBuf,
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Repo {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ss-team-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("mkdir");
            let repo = Repo { dir };
            repo.git(&["init", "--initial-branch=main"]);
            repo.git(&["config", "user.name", "Maya Reed"]);
            repo.git(&[
                "config",
                "user.email",
                "9+mayareed@users.noreply.github.com",
            ]);
            // Hooks and signing come from the developer's own global config
            // and would make this test pass or fail based on their machine.
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&self.dir)
                .output()
                .expect("git runs");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        fn commit(&self, file: &str, body: &str, message: &str) {
            std::fs::write(self.dir.join(file), body).expect("write");
            self.git(&["add", file]);
            self.git(&["commit", "-m", message]);
        }
    }

    #[tokio::test]
    async fn the_comment_ref_never_shows_up_as_somebody_s_work() {
        // Comments travel on their own branch, and every sync commits to it.
        // Walked like any other ref, the feed filled with "Harbr comments
        // from …" rows — the machinery reporting on itself and pushing the
        // actual work down the page.
        let repo = Repo::new("team-ref-hidden");
        repo.commit("a.txt", "one\n", "Real work");
        repo.git(&["checkout", "-q", "-b", TEAM_BRANCH]);
        repo.commit("b.txt", "records\n", "Harbr comments from Maya Reed");
        repo.git(&["checkout", "-q", "main"]);

        // The form this actually takes in a real clone: no local branch is ever
        // created, only the remote-tracking ref. A check against the bare name
        // would pass the local case above and miss every real one.
        let tip = repo.git(&["rev-parse", TEAM_BRANCH]);
        repo.git(&[
            "update-ref",
            &format!("refs/remotes/origin/{TEAM_BRANCH}"),
            tip.trim(),
        ]);
        repo.git(&["branch", "-D", TEAM_BRANCH]);

        let subjects: Vec<String> = walk_commits(&repo.dir, Some("main"))
            .await
            .into_iter()
            .map(|commit| commit.subject)
            .collect();

        assert!(
            subjects.iter().any(|subject| subject == "Real work"),
            "the actual work went missing"
        );
        assert!(
            !subjects.iter().any(|s| s.contains("Harbr comments")),
            "the transport's own commits leaked into the feed: {subjects:?}"
        );
    }

    #[tokio::test]
    async fn reads_back_what_git_actually_wrote() {
        let repo = Repo::new("walk");
        repo.commit("a.txt", "one\n", "Add the first thing");
        repo.commit(
            "b.txt",
            "two\n",
            "Rebuild the pricing tiers\n\nThe flex row could not hold three columns.\n\nMade-With: Claude Code",
        );

        let commits = walk_commits(&repo.dir, Some("main")).await;
        assert_eq!(commits.len(), 2, "both commits come back");

        // Newest first.
        let tip = &commits[0];
        assert_eq!(tip.subject, "Rebuild the pricing tiers");
        assert_eq!(tip.branch, "main");
        assert_eq!(tip.author_name, "Maya Reed");
        assert!(!tip.is_merge);
        assert!(tip.at > 1_600_000_000_000, "milliseconds, not seconds");

        // The body survives the round trip through git's own formatting, with
        // the trailer kept out of the prose. This is the row's "why", so a
        // format string that mangles it silently empties the feed.
        assert_eq!(
            tip.body.as_deref(),
            Some("The flex row could not hold three columns.")
        );
        assert_eq!(tip.made_with.as_deref(), Some("Claude Code"));
        assert_eq!(commits[1].body, None, "a subject-only commit has no body");
        assert_eq!(commits[1].made_with, None);

        // And the noreply address still yields the login.
        assert_eq!(
            login_from_email(&tip.author_email).as_deref(),
            Some("mayareed")
        );
    }

    #[tokio::test]
    async fn attributes_a_commit_to_the_branch_it_was_written_on() {
        let repo = Repo::new("branch");
        repo.commit("a.txt", "one\n", "Base");
        repo.git(&["checkout", "-b", "feat/pricing"]);
        repo.commit("b.txt", "two\n", "Topic work");

        let commits = walk_commits(&repo.dir, Some("main")).await;
        assert_eq!(commits.len(), 2);

        let by_subject: std::collections::HashMap<&str, &str> = commits
            .iter()
            .map(|c| (c.subject.as_str(), c.branch.as_str()))
            .collect();
        // The topic commit belongs to the topic branch, and the base commit —
        // reachable from both — is attributed once, to the base.
        assert_eq!(by_subject.get("Topic work"), Some(&"feat/pricing"));
        assert_eq!(by_subject.get("Base"), Some(&"main"));
    }

    #[tokio::test]
    async fn a_subject_containing_the_field_separator_cannot_corrupt_the_parse() {
        let repo = Repo::new("sep");
        // Tabs and pipes are the separators a first pass reaches for, and both
        // are legal in a commit subject. This is why the format uses ASCII
        // unit/record separators instead.
        repo.commit("a.txt", "one\n", "Fix a|b\tand c");

        let commits = walk_commits(&repo.dir, Some("main")).await;
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "Fix a|b\tand c");
    }

    #[tokio::test]
    async fn counts_the_lines_a_stint_actually_touched() {
        let repo = Repo::new("numstat");
        repo.commit("a.txt", "one\ntwo\nthree\n", "Add three lines");
        repo.commit("a.txt", "one\n", "Cut it back to one");

        let commits = walk_commits(&repo.dir, Some("main")).await;
        let stints = group_into_stints(commits);
        assert_eq!(stints.len(), 1, "one sitting of work");

        let files = files_for(&repo.dir, &stints[0]).await;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");
        // 3 added by the first commit; the second only deletes the last two
        // lines, so it adds nothing.
        assert_eq!(files[0].added, 3);
        assert_eq!(files[0].removed, 2);
    }

    #[tokio::test]
    async fn finds_the_base_branch_without_being_told() {
        let repo = Repo::new("base");
        repo.commit("a.txt", "one\n", "Base");
        assert_eq!(
            default_base_branch(&repo.dir).await.as_deref(),
            Some("main")
        );
    }

    #[tokio::test]
    async fn a_merge_is_marked_as_one_and_is_not_counted_twice() {
        let repo = Repo::new("merge");
        repo.commit("a.txt", "one\n", "Base");
        repo.git(&["checkout", "-b", "feat/x"]);
        repo.commit("b.txt", "two\n", "Topic work");
        repo.git(&["checkout", "main"]);
        repo.git(&[
            "merge",
            "--no-ff",
            "feat/x",
            "-m",
            "Merge pull request #7 from acme/feat-x",
        ]);

        let commits = walk_commits(&repo.dir, Some("main")).await;
        let merge = commits
            .iter()
            .find(|c| c.subject.starts_with("Merge pull request"))
            .expect("the merge commit is in the walk");
        assert!(merge.is_merge);

        let topic = commits
            .iter()
            .find(|c| c.subject == "Topic work")
            .expect("the topic commit is in the walk");

        let as_stint = |commits: Vec<RawCommit>| Stint {
            branch: "main".to_string(),
            author_name: merge.author_name.clone(),
            author_email: merge.author_email.clone(),
            at: merge.at,
            made_with: None,
            commits,
        };

        // A merge on its own is the row's whole content, so it is diffed
        // against its first parent: b.txt, one line.
        let alone = files_for(&repo.dir, &as_stint(vec![merge.clone()])).await;
        assert_eq!(alone.len(), 1);
        assert_eq!(alone[0].path, "b.txt");
        assert_eq!(alone[0].added, 1);

        // Beside the commits it brought in, the merge is skipped — otherwise
        // b.txt is counted once for the topic commit and again for the merge.
        let together = files_for(&repo.dir, &as_stint(vec![merge.clone(), topic.clone()])).await;
        assert_eq!(together.len(), 1);
        assert_eq!(together[0].path, "b.txt");
        assert_eq!(together[0].added, 1, "counted once, not twice");
    }

    #[tokio::test]
    async fn a_long_run_of_commits_is_broken_into_readable_rows() {
        let repo = Repo::new("cap");
        // Fifteen commits inside one four-hour gap. Without the caps this is a
        // single card claiming fifteen commits under the last one's subject.
        for i in 0..15 {
            repo.commit("a.txt", &format!("line {i}\n"), &format!("Step {i}"));
        }
        let stints = group_into_stints(walk_commits(&repo.dir, Some("main")).await);
        assert!(stints.len() >= 2, "the run is split, not one giant row");
        assert!(
            stints.iter().all(|s| s.commits.len() <= 12),
            "no stint exceeds the cap"
        );
        assert_eq!(
            stints.iter().map(|s| s.commits.len()).sum::<usize>(),
            15,
            "and nothing is lost in the splitting"
        );
    }

    #[tokio::test]
    async fn a_directory_that_is_not_a_repo_is_answered_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("ss-team-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");

        // A question with an answer, not an error. Comments live in files and
        // work here; only the history-derived half is missing.
        assert!(!is_repo(&dir).await);

        // And everything else degrades to empty rather than erroring.
        assert!(walk_commits(&dir, None).await.is_empty());
        assert!(default_base_branch(&dir).await.is_none());
        assert!(pull_requests(&dir).await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, at_secs: i64, email: &str, branch: &str) -> RawCommit {
        RawCommit {
            sha: sha.to_string(),
            short_sha: sha[..7.min(sha.len())].to_string(),
            subject: format!("work {sha}"),
            body: None,
            at: at_secs * 1000,
            author_name: "Maya Reed".to_string(),
            author_email: email.to_string(),
            branch: branch.to_string(),
            made_with: None,
            is_merge: false,
            files: Vec::new(),
        }
    }

    #[test]
    fn groups_one_persons_run_of_commits_into_one_stint() {
        let commits = vec![
            commit("aaa", 10_000, "maya@x.com", "feat/pricing"),
            commit("bbb", 9_000, "maya@x.com", "feat/pricing"),
            commit("ccc", 8_000, "maya@x.com", "feat/pricing"),
        ];
        let stints = group_into_stints(commits);
        assert_eq!(stints.len(), 1);
        assert_eq!(stints[0].commits.len(), 3);
        // Dated by when the run finished, not when it started.
        assert_eq!(stints[0].at, 10_000_000);
    }

    #[test]
    fn splits_on_a_long_gap() {
        let day = 24 * 60 * 60;
        let commits = vec![
            commit("aaa", 100_000, "maya@x.com", "feat/pricing"),
            commit("bbb", 100_000 - day, "maya@x.com", "feat/pricing"),
        ];
        assert_eq!(group_into_stints(commits).len(), 2);
    }

    #[test]
    fn never_merges_two_peoples_work() {
        let commits = vec![
            commit("aaa", 10_000, "maya@x.com", "feat/pricing"),
            commit("bbb", 9_900, "theo@x.com", "feat/pricing"),
        ];
        assert_eq!(group_into_stints(commits).len(), 2);
    }

    #[test]
    fn never_merges_across_branches() {
        let commits = vec![
            commit("aaa", 10_000, "maya@x.com", "feat/pricing"),
            commit("bbb", 9_900, "maya@x.com", "fix/nav"),
        ];
        assert_eq!(group_into_stints(commits).len(), 2);
    }

    #[test]
    fn a_stint_inherits_the_trailer_from_whichever_commit_carried_it() {
        let mut second = commit("bbb", 9_000, "maya@x.com", "feat/pricing");
        second.made_with = Some("01K4J8Q2".to_string());
        let stints = group_into_stints(vec![
            commit("aaa", 10_000, "maya@x.com", "feat/pricing"),
            second,
        ]);
        assert_eq!(stints.len(), 1);
        assert_eq!(stints[0].made_with.as_deref(), Some("01K4J8Q2"));
    }

    #[test]
    fn reads_a_login_out_of_a_github_noreply_address() {
        assert_eq!(
            login_from_email("12345+octocat@users.noreply.github.com").as_deref(),
            Some("octocat")
        );
        assert_eq!(
            login_from_email("octocat@users.noreply.github.com").as_deref(),
            Some("octocat")
        );
    }

    #[test]
    fn refuses_to_guess_a_login_from_an_ordinary_address() {
        assert_eq!(login_from_email("jane@acme.com"), None);
        assert_eq!(login_from_email("not-an-email"), None);
    }

    #[test]
    fn parses_a_log_record_including_its_body_and_trailer() {
        // The body is the row's "why", so it has to survive the round trip
        // through the format string intact — and the trailer under it has to
        // stay out of the prose.
        let body = "The flex row could not hold three columns.\n\nMade-With: Claude Code";
        let chunk = format!(
            "abcdef1234{FIELD}abcdef1{FIELD}1757251200{FIELD}Maya Reed{FIELD}Maya@X.com{FIELD}parent1{FIELD}Rebuild the pricing tiers{FIELD}{body}{FIELD}Claude Code"
        );
        let commit = parse_commit(&chunk, "feat/pricing").expect("parses");
        assert_eq!(commit.sha, "abcdef1234");
        assert_eq!(commit.at, 1_757_251_200_000);
        // Emails are compared, so they are normalised on the way in.
        assert_eq!(commit.author_email, "maya@x.com");
        assert_eq!(commit.subject, "Rebuild the pricing tiers");
        assert_eq!(
            commit.body.as_deref(),
            Some("The flex row could not hold three columns."),
            "the trailer leaked into the prose"
        );
        assert_eq!(commit.made_with.as_deref(), Some("Claude Code"));
        assert!(!commit.is_merge);
    }

    #[test]
    fn a_commit_with_only_a_subject_has_no_body_rather_than_an_empty_one() {
        let chunk = format!(
            "abc{FIELD}abc{FIELD}1757251200{FIELD}Theo{FIELD}t@x.com{FIELD}p1{FIELD}wip{FIELD}{FIELD}"
        );
        let commit = parse_commit(&chunk, "main").expect("parses");
        assert_eq!(commit.body, None);
        assert_eq!(commit.made_with, None);
    }

    #[test]
    fn a_commit_with_two_parents_is_a_merge() {
        let chunk = format!(
            "abc{FIELD}abc{FIELD}1757251200{FIELD}Theo{FIELD}t@x.com{FIELD}p1 p2{FIELD}Merge pull request #139{FIELD}"
        );
        let commit = parse_commit(&chunk, "main").expect("parses");
        assert!(commit.is_merge);
        assert_eq!(commit.made_with, None);
    }

    #[test]
    fn an_open_pr_nobody_has_looked_at_needs_review() {
        let pr = PrSummary {
            number: 12,
            state: "OPEN".to_string(),
            url: String::new(),
            review_requested: false,
            has_reviews: false,
        };
        assert_eq!(pr.status(), TeamUpdateStatus::NeedsReview);
    }

    #[test]
    fn a_requested_review_moves_it_to_in_review() {
        let pr = PrSummary {
            number: 12,
            state: "OPEN".to_string(),
            url: String::new(),
            review_requested: true,
            has_reviews: false,
        };
        assert_eq!(pr.status(), TeamUpdateStatus::InReview);
    }

    #[test]
    fn a_pr_closed_without_merging_is_finished_not_in_review() {
        // A real repo turned up a PR closed years ago that still had reviews on
        // it. Checking the review flags first reported it as "In review", which
        // is the kind of confidently wrong status that discredits a whole feed.
        let pr = PrSummary {
            number: 467,
            state: "CLOSED".to_string(),
            url: String::new(),
            review_requested: true,
            has_reviews: true,
        };
        assert_eq!(pr.status(), TeamUpdateStatus::Working);
    }

    #[test]
    fn merged_beats_everything() {
        let pr = PrSummary {
            number: 12,
            state: "MERGED".to_string(),
            url: String::new(),
            review_requested: true,
            has_reviews: true,
        };
        assert_eq!(pr.status(), TeamUpdateStatus::Merged);
    }

    #[test]
    fn prefers_the_prs_own_url_and_falls_back_to_the_commit() {
        let pr = PrSummary {
            number: 12,
            state: "OPEN".to_string(),
            url: "https://github.com/acme/site/pull/12".to_string(),
            review_requested: false,
            has_reviews: false,
        };
        assert_eq!(
            github_url_for(Some("acme/site"), Some(&pr), "abc").as_deref(),
            Some("https://github.com/acme/site/pull/12")
        );
        assert_eq!(
            github_url_for(Some("acme/site"), None, "abc").as_deref(),
            Some("https://github.com/acme/site/commit/abc")
        );
        // No remote means no URL — never a constructed one.
        assert_eq!(github_url_for(None, None, "abc"), None);
    }
}
