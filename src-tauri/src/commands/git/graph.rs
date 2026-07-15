//! Branch-graph visual data and the per-project default-base-branch setting.
//!
//! `get_branch_graph` composes purely local git data — the branch list, each
//! branch's fork parent (recorded lineage → `git merge-base` heuristic →
//! default branch), and ahead/behind vs that parent. It performs no network or
//! `gh` calls, so it stays fast and works offline; PR arrows are overlaid on the
//! frontend from the workspace-scoped PR list it already holds.

use crate::errors::CommandError;
use crate::types::BranchGraphNode;
use crate::utils::{create_command, validate_project_path};
use std::collections::HashSet;
use tracing::debug;

use super::{get_ahead_behind, load_project_metadata, save_project_metadata};

/// One discovered branch and where its ref lives (local vs remote-only).
struct RawBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    last_commit_date: u64,
    /// True when a remote-tracking ref (origin/<name>) exists — published.
    pushed: bool,
}

impl RawBranch {
    /// A fully-qualified, injection-safe ref for git plumbing. Always starts
    /// with `refs/`, so an attacker-controlled branch name can never be parsed
    /// as a flag.
    fn git_ref(&self) -> String {
        if self.is_remote {
            format!("refs/remotes/origin/{}", self.name)
        } else {
            format!("refs/heads/{}", self.name)
        }
    }
}

/// List local + remote-only branches (deduped, local wins) with commit dates.
/// Mirrors `list_branches` but does no background fetch — the graph reflects
/// whatever refs are already present.
fn list_raw_branches(path: &std::path::Path) -> Vec<RawBranch> {
    let output = create_command("git")
        .args([
            "branch",
            "-a",
            "--format=%(refname:short)|%(committerdate:unix)|%(HEAD)",
        ])
        .current_dir(path)
        .output();

    let stdout = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => return Vec::new(),
    };

    // Names with a remote-tracking ref (published to GitHub).
    let mut remote_names: HashSet<String> = HashSet::new();
    for line in stdout.lines() {
        let raw = line.split('|').next().unwrap_or("").trim();
        if let Some(name) = raw.strip_prefix("origin/") {
            if !name.is_empty() && name != "HEAD" {
                remote_names.insert(name.to_string());
            }
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut branches: Vec<RawBranch> = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 3 {
            continue;
        }
        let raw_name = parts[0].trim();
        if raw_name.is_empty() || raw_name == "origin" || raw_name.contains("HEAD") {
            continue;
        }

        let (name, is_remote) = match raw_name.strip_prefix("origin/") {
            Some(stripped) => (stripped.to_string(), true),
            None => (raw_name.to_string(), false),
        };
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }

        let pushed = is_remote || remote_names.contains(&name);
        branches.push(RawBranch {
            name,
            is_current: parts[2].trim() == "*",
            is_remote,
            last_commit_date: parts[1].trim().parse::<u64>().unwrap_or(0) * 1000,
            pushed,
        });
    }

    branches
}

/// Just the set of branch names (used for default-branch detection).
fn branch_name_set(path: &std::path::Path) -> HashSet<String> {
    list_raw_branches(path)
        .into_iter()
        .map(|b| b.name)
        .collect()
}

/// The repo's conventional default branch, if present.
fn detect_default_branch(names: &HashSet<String>) -> Option<String> {
    if names.contains("main") {
        Some("main".to_string())
    } else if names.contains("master") {
        Some("master".to_string())
    } else {
        None
    }
}

/// Commit hash a ref points at.
fn rev_parse(path: &std::path::Path, git_ref: &str) -> Option<String> {
    let out = create_command("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            git_ref,
        ])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The merge-base commit of two refs, plus its committer timestamp.
fn merge_base(path: &std::path::Path, a: &str, b: &str) -> Option<(String, i64)> {
    let out = create_command("git")
        .args(["merge-base", a, b])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if hash.is_empty() {
        return None;
    }
    let date_out = create_command("git")
        .args(["show", "-s", "--format=%ct", &hash])
        .current_dir(path)
        .output()
        .ok()?;
    let date = String::from_utf8_lossy(&date_out.stdout)
        .trim()
        .parse::<i64>()
        .unwrap_or(0);
    Some((hash, date))
}

/// Guess which branch `target` was forked from, when we have no recorded
/// lineage. Among all other branches, pick the one whose merge-base with
/// `target` is the most recent — that's the closest common ancestor and the
/// most likely fork point. Candidates that fully contain `target` (merge-base ==
/// target's tip) are skipped, since `target` is then their ancestor, not child.
fn infer_base<'a>(
    path: &std::path::Path,
    target: &RawBranch,
    candidates: &[&'a RawBranch],
    default_branch: Option<&'a str>,
) -> Option<String> {
    let target_ref = target.git_ref();
    let target_tip = rev_parse(path, &target_ref);

    let mut best: Option<(&'a str, i64)> = None;
    for cand in candidates {
        if cand.name == target.name {
            continue;
        }
        let (mb_hash, mb_date) = match merge_base(path, &target_ref, &cand.git_ref()) {
            Some(v) => v,
            None => continue,
        };
        // `target` is contained in `cand` → `cand` is a descendant, not a parent.
        if target_tip.as_deref() == Some(mb_hash.as_str()) {
            continue;
        }
        let better = match best {
            None => true,
            // Prefer a more recent fork point; break ties toward the default branch.
            Some((_, best_date)) if mb_date > best_date => true,
            Some((best_name, best_date)) => {
                mb_date == best_date
                    && Some(cand.name.as_str()) == default_branch
                    && Some(best_name) != default_branch
            }
        };
        if better {
            best = Some((cand.name.as_str(), mb_date));
        }
    }

    best.map(|(name, _)| name.to_string())
        .or_else(|| default_branch.map(|d| d.to_string()))
}

/// Most-recent branches consulted as merge-base candidates when a branch has
/// no recorded lineage. Each candidate costs two git subprocesses per branch,
/// so this bounds a repo with many branches to a predictable worst case; the
/// long tail falls back to the default branch, which the elbow rendering
/// degrades to gracefully.
const MAX_INFER_CANDIDATES: usize = 8;

/// Build the branch-graph node list for the visual. Local git only.
///
/// The git subprocess calls are blocking, and inference can spawn dozens of
/// them — `spawn_blocking` keeps them off the async runtime so a large repo
/// can't stall every other command while the graph builds.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn get_branch_graph(project_path: String) -> Result<Vec<BranchGraphNode>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    tokio::task::spawn_blocking(move || build_branch_graph(&validated_path))
        .await
        .map_err(|e| format!("Branch graph task failed: {e}"))?
}

fn build_branch_graph(
    validated_path: &std::path::Path,
) -> Result<Vec<BranchGraphNode>, CommandError> {
    let raw = list_raw_branches(validated_path);

    let names: HashSet<String> = raw.iter().map(|b| b.name.clone()).collect();
    let metadata = load_project_metadata(&validated_path);
    let lineage = metadata.branch_lineage.unwrap_or_default();
    // Configured default base wins; otherwise fall back to main/master.
    let default_branch = metadata
        .default_base_branch
        .filter(|b| names.contains(b))
        .or_else(|| detect_default_branch(&names));

    // Bounded merge-base candidate pool: the default branch plus the most
    // recently committed branches. Inference cost is per-target × per-candidate
    // subprocesses, so an unbounded pool goes quadratic on branch-heavy repos.
    let infer_candidates: Vec<&RawBranch> = {
        let mut by_recency: Vec<&RawBranch> = raw.iter().collect();
        by_recency.sort_by(|a, b| b.last_commit_date.cmp(&a.last_commit_date));
        let mut pool: Vec<&RawBranch> = by_recency
            .iter()
            .filter(|b| default_branch.as_deref() == Some(b.name.as_str()))
            .copied()
            .collect();
        for b in by_recency {
            if pool.len() >= MAX_INFER_CANDIDATES {
                break;
            }
            if default_branch.as_deref() != Some(b.name.as_str()) {
                pool.push(b);
            }
        }
        pool
    };

    let local_names = names_local(&raw);
    let mut nodes: Vec<BranchGraphNode> = Vec::with_capacity(raw.len());
    for b in &raw {
        let is_default = default_branch.as_deref() == Some(b.name.as_str());

        // Resolve the fork parent: recorded lineage first (and only if that base
        // still exists), then a merge-base guess. The default branch is a root.
        let base = if is_default {
            None
        } else {
            match lineage.get(&b.name) {
                Some(recorded) if names.contains(recorded) && recorded != &b.name => {
                    Some(recorded.clone())
                }
                _ => infer_base(
                    validated_path,
                    b,
                    &infer_candidates,
                    default_branch.as_deref(),
                ),
            }
        };

        // Ahead/behind measured against the resolved base ref.
        let (ahead, behind) = match &base {
            Some(base_name) => {
                let base_ref = base_git_ref(&local_names, base_name);
                get_ahead_behind(&validated_path, &b.git_ref(), &base_ref)
            }
            None => (0, 0),
        };

        nodes.push(BranchGraphNode {
            name: b.name.clone(),
            base,
            is_current: b.is_current,
            is_default,
            is_remote: b.is_remote,
            ahead,
            behind,
            last_commit_date: b.last_commit_date,
            pushed: b.pushed,
        });
    }

    // Roots first, then by recency, so parents render above their children.
    nodes.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then(b.last_commit_date.cmp(&a.last_commit_date))
    });

    debug!(node_count = nodes.len(), "Branch graph built");
    Ok(nodes)
}

/// Names of branches that exist as local refs (for base-ref resolution).
fn names_local(raw: &[RawBranch]) -> HashSet<String> {
    raw.iter()
        .filter(|b| !b.is_remote)
        .map(|b| b.name.clone())
        .collect()
}

/// Resolve a base branch name to a git ref, preferring the local branch.
fn base_git_ref(local_names: &HashSet<String>, name: &str) -> String {
    if local_names.contains(name) {
        format!("refs/heads/{name}")
    } else {
        format!("refs/remotes/origin/{name}")
    }
}

/// The project's configured default base branch, falling back to the repo's
/// conventional default (main/master) when unset.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn get_default_base_branch(project_path: String) -> Result<Option<String>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let metadata = load_project_metadata(&validated_path);
    if let Some(branch) = metadata.default_base_branch {
        return Ok(Some(branch));
    }
    Ok(detect_default_branch(&branch_name_set(&validated_path)))
}

/// Set (or clear, with `None`/empty) the project's default base branch.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn set_default_base_branch(
    project_path: String,
    branch: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let mut metadata = load_project_metadata(&validated_path);
    metadata.default_base_branch = branch.filter(|b| !b.trim().is_empty());
    save_project_metadata(&validated_path, &metadata)?;
    Ok(())
}
