//! Git worktree management — list, add, remove, prune.
//!
//! Surfaces native `git worktree` semantics rather than abstracting them: the
//! list mirrors `git worktree list` (main worktree included), removal keeps the
//! branch, and dirty-tree refusals bubble up so the UI can offer `--force`.
//!
//! App-managed worktrees are created under
//! `<projects_root>/.worktrees/<main_worktree_dir_name>/<sanitized_branch>` —
//! inside the allowed projects root (so `validate_project_path` accepts them)
//! but dot-prefixed so the dashboard scan never lists the container as a
//! project. The container is always named after the repository's MAIN
//! worktree, no matter which checkout the add was invoked from, so one
//! repository's worktrees stay in one family folder.

use crate::cache::GIT_CACHE;
use crate::errors::CommandError;
use crate::utils::{create_command, projects_root, validate_project_path};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tracing::{info, instrument, warn};

use super::{load_project_metadata, save_project_metadata};

/// One entry from `git worktree list --porcelain`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WorktreeInfo {
    pub path: String,
    /// Short commit sha of the checked-out HEAD.
    pub head: String,
    /// Branch name with `refs/heads/` stripped; `None` when detached.
    pub branch: Option<String>,
    /// True for the repository's main worktree (first porcelain entry).
    pub is_main: bool,
    /// True when this entry is the directory the query was made from.
    pub is_current: bool,
    /// Lock reason when locked (empty string if locked without a reason).
    pub locked: Option<String>,
    /// Prune reason when git considers the entry prunable.
    pub prunable: Option<String>,
    /// Unix timestamp (ms) of the checked-out HEAD commit, when resolvable.
    pub last_commit_date: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AddWorktreeResult {
    pub path: String,
    /// Dev-server port persisted into the new worktree's metadata, when a free
    /// one was found.
    pub port: Option<u16>,
}

/// Intermediate parse result, before path comparison decorates it.
#[derive(Debug, PartialEq)]
struct ParsedWorktree {
    path: String,
    head: String,
    branch: Option<String>,
    locked: Option<String>,
    prunable: Option<String>,
}

/// Parses `git worktree list --porcelain` output: blank-line-separated blocks
/// of `worktree <path>` / `HEAD <sha>` / `branch <ref>` | `detached` /
/// `locked[ <reason>]` / `prunable[ <reason>]`. Bare-repo entries are skipped.
fn parse_worktree_porcelain(output: &str) -> Vec<ParsedWorktree> {
    let mut result = Vec::new();
    let mut current: Option<ParsedWorktree> = None;
    let mut is_bare = false;

    let mut flush = |wt: &mut Option<ParsedWorktree>, bare: &mut bool| {
        if let Some(w) = wt.take() {
            if !*bare {
                result.push(w);
            }
        }
        *bare = false;
    };

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut current, &mut is_bare);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current, &mut is_bare);
            current = Some(ParsedWorktree {
                path: path.to_string(),
                head: String::new(),
                branch: None,
                locked: None,
                prunable: None,
            });
        } else if let Some(wt) = current.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                // Full sha here — needed for commit-date lookup; shortened for
                // display when building the public WorktreeInfo.
                wt.head = sha.to_string();
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                wt.branch = Some(
                    branch_ref
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch_ref)
                        .to_string(),
                );
            } else if line == "detached" {
                wt.branch = None;
            } else if line == "bare" {
                is_bare = true;
            } else if line == "locked" {
                wt.locked = Some(String::new());
            } else if let Some(reason) = line.strip_prefix("locked ") {
                wt.locked = Some(reason.to_string());
            } else if line == "prunable" {
                wt.prunable = Some(String::new());
            } else if let Some(reason) = line.strip_prefix("prunable ") {
                wt.prunable = Some(reason.to_string());
            }
        }
    }
    flush(&mut current, &mut is_bare);
    result
}

/// Turns a branch name into a filesystem-safe folder name: path separators
/// become `-`, Windows-illegal characters are dropped, and leading `-`/`.` are
/// stripped so the result can't be parsed as a flag or hide the folder.
fn sanitize_worktree_folder(branch: &str) -> String {
    let mut out: String = branch
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .filter(|c| !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    while out.starts_with('-') || out.starts_with('.') {
        out.remove(0);
    }
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    out.truncate(64);
    if out.is_empty() {
        "worktree".to_string()
    } else {
        out
    }
}

/// Rejects ref names git could parse as an option (argument injection) — the
/// same guard `create_branch`/`switch_branch` apply.
fn guard_ref_name(name: &str, field: &str) -> Result<(), CommandError> {
    if name.is_empty() || name.starts_with('-') || name.contains("..") {
        return Err(CommandError::Validation {
            field: field.to_string(),
            reason: "Invalid ref name".to_string(),
        });
    }
    Ok(())
}

/// First TCP-bindable port in `(start+1)..=(start+100)` that isn't already
/// reserved by a live `(window, project)` pair. `None` when the range is
/// exhausted — callers leave the metadata port unset in that case.
fn pick_free_port(start: u16) -> Option<u16> {
    use std::net::TcpListener;
    for port in (start.saturating_add(1))..=start.saturating_add(100) {
        if crate::state::is_port_reserved(port) {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn run_worktree_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, CommandError> {
    create_command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| CommandError::Io {
            message: e.to_string(),
        })
}

fn process_error(args: &[&str], output: &std::process::Output) -> CommandError {
    CommandError::Process {
        cmd: format!("git {}", args.join(" ")),
        exit_code: output.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    }
}

/// Canonical form for path equality checks (worktree paths reported by git are
/// already resolved, but the queried project path may differ in symlinks/case).
fn canon(path: &str) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

/// The repository's main worktree path as seen from any checkout — the first
/// entry of `git worktree list --porcelain`. None when `cwd` isn't a git
/// repository or git fails.
fn main_worktree_path(cwd: &Path) -> Option<PathBuf> {
    let output = run_worktree_git(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_worktree_porcelain(&stdout)
        .first()
        .map(|w| PathBuf::from(&w.path))
}

/// Resolves commit timestamps (ms) for a set of shas in one git call:
/// `git show -s --format='%H %ct' <shas…>`. Best-effort — an empty map on
/// any failure just leaves `last_commit_date` unset.
fn commit_timestamps_ms(cwd: &Path, shas: &[&str]) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    if shas.is_empty() {
        return map;
    }
    let mut args: Vec<&str> = vec!["show", "-s", "--format=%H %ct"];
    args.extend(shas);
    if let Ok(output) = run_worktree_git(cwd, &args) {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let mut parts = line.split_whitespace();
                if let (Some(sha), Some(secs)) = (parts.next(), parts.next()) {
                    if let Ok(secs) = secs.parse::<u64>() {
                        map.insert(sha.to_string(), secs * 1000);
                    }
                }
            }
        }
    }
    map
}

/// Lists all worktrees of the repository containing `project_path`, main
/// worktree first (git's porcelain order). Returns an empty list for
/// non-git directories so callers can simply hide the feature.
#[tauri::command]
#[instrument(name = "list_worktrees", skip(project_path), fields(project = %project_path))]
pub async fn list_worktrees(project_path: String) -> Result<Vec<WorktreeInfo>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let args = ["worktree", "list", "--porcelain"];
    let output = run_worktree_git(&validated_path, &args)?;
    if !output.status.success() {
        // Not a git repository (or too old a git) — the UI hides the section.
        return Ok(Vec::new());
    }

    let current = canon(&validated_path.to_string_lossy());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_worktree_porcelain(&stdout);
    let shas: Vec<&str> = parsed
        .iter()
        .map(|w| w.head.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    let timestamps = commit_timestamps_ms(&validated_path, &shas);
    let worktrees = parsed
        .into_iter()
        .enumerate()
        .map(|(i, wt)| {
            let is_current = canon(&wt.path) == current;
            WorktreeInfo {
                is_main: i == 0,
                is_current,
                last_commit_date: timestamps.get(&wt.head).copied(),
                path: wt.path,
                head: wt.head.chars().take(7).collect(),
                branch: wt.branch,
                locked: wt.locked,
                prunable: wt.prunable,
            }
        })
        .collect();

    Ok(worktrees)
}

/// Creates a worktree under `<projects_root>/.worktrees/<parent>/<branch>`,
/// checking out `branch` (created from `base_ref`/HEAD when `create_branch`).
/// Seeds the new directory's `.shipstudio/project.json` from the parent
/// (dev command, monorepo subpath, workspace) with a distinct dev-server port,
/// and optionally copies the parent's untracked root `.env*` files.
#[tauri::command]
#[instrument(name = "add_worktree", skip(project_path), fields(project = %project_path, branch = %branch))]
pub async fn add_worktree(
    project_path: String,
    branch: String,
    create_branch: bool,
    base_ref: Option<String>,
    copy_env: bool,
) -> Result<AddWorktreeResult, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    guard_ref_name(&branch, "branch")?;
    if let Some(base) = base_ref.as_deref() {
        guard_ref_name(base, "base_ref")?;
    }

    // Anchor naming, metadata, and .env copies to the repository's MAIN
    // worktree: `project_path` may itself be a linked worktree (creating a
    // worktree while working inside one), and using the invoking directory
    // would scatter one repository's worktrees across differently-named
    // container folders.
    let anchor = main_worktree_path(&validated_path).unwrap_or_else(|| validated_path.clone());
    let parent_dir_name = anchor
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| CommandError::Validation {
            field: "project_path".to_string(),
            reason: "Project path has no directory name".to_string(),
        })?;

    let container = projects_root()?.join(".worktrees").join(&parent_dir_name);
    let dest = container.join(sanitize_worktree_folder(&branch));
    if dest.exists() {
        return Err(CommandError::Validation {
            field: "branch".to_string(),
            reason: format!("A worktree folder already exists at {}", dest.display()),
        });
    }
    std::fs::create_dir_all(&container).map_err(|e| CommandError::Io {
        message: format!("Failed to create worktrees folder: {e}"),
    })?;

    let dest_str = dest.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if create_branch {
        args.extend(["-b", &branch]);
    }
    args.push(&dest_str);
    if create_branch {
        if let Some(base) = base_ref.as_deref() {
            args.push(base);
        }
    } else {
        args.push(&branch);
    }

    info!(dest = %dest.display(), create_branch, "Adding git worktree");
    let output = run_worktree_git(&validated_path, &args)?;
    if !output.status.success() {
        // Pass git's own message through — it covers "already checked out",
        // "already exists", unknown refs, etc. faithfully.
        return Err(process_error(&args, &output));
    }

    // Seed the worktree's own .shipstudio/project.json from the main worktree
    // so the dev server behaves identically (command, monorepo subpath,
    // workspace) — but on its own port, since every project otherwise
    // defaults to 3000.
    let parent_meta = load_project_metadata(&anchor);
    let mut meta = crate::types::ProjectMetadata {
        custom_dev_command: parent_meta.custom_dev_command.clone(),
        workspace_subpath: parent_meta.workspace_subpath.clone(),
        force_static_serve: parent_meta.force_static_serve,
        assets_root: parent_meta.assets_root.clone(),
        account_id: parent_meta.account_id.clone(),
        default_base_branch: parent_meta.default_base_branch.clone(),
        // CMS bindings must survive into worktrees or their previews re-show
        // the connect gate (shopify_store was previously dropped here).
        shopify_store: parent_meta.shopify_store.clone(),
        hubspot_dest: parent_meta.hubspot_dest.clone(),
        ..Default::default()
    };
    let port = pick_free_port(parent_meta.dev_server_port.unwrap_or(3000));
    meta.dev_server_port = port;
    if port.is_none() {
        warn!("No free dev-server port found for new worktree; leaving unset");
    }
    if let Err(e) = save_project_metadata(&dest, &meta) {
        warn!("Failed to seed worktree metadata: {e}");
    }

    if copy_env {
        copy_env_files(&anchor, &dest);
    }

    // Plugins need no copying: all worktrees of one repository resolve to the
    // main worktree's plugin store (see `plugins_owner_root` in commands::plugins).

    GIT_CACHE.invalidate(&project_path);

    Ok(AddWorktreeResult {
        path: dest_str,
        port,
    })
}

/// Copies root-level `.env*` files git didn't check out (they're normally
/// gitignored, so a fresh worktree lacks them and the dev server breaks).
/// Never overwrites a file the checkout already produced.
fn copy_env_files(from: &Path, to: &Path) {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with(".env") {
            continue;
        }
        if !entry.path().is_file() {
            continue;
        }
        let target = to.join(&name);
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::copy(entry.path(), &target) {
            warn!(file = %name_str, "Failed to copy env file to worktree: {e}");
        }
    }
}

/// Removes a linked worktree via `git worktree remove`. Refuses the main
/// worktree. A dirty tree makes git refuse without `force` — the resulting
/// `Process` error carries git's stderr so the UI can offer force-removal.
/// The branch is left alone, matching git's own semantics.
#[tauri::command]
#[instrument(name = "remove_worktree", skip(project_path, worktree_path), fields(project = %project_path, worktree = %worktree_path))]
pub async fn remove_worktree(
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let validated_worktree = validate_project_path(&worktree_path)?;

    // Never remove the main worktree — that's the project itself.
    let list_output = run_worktree_git(&validated_path, &["worktree", "list", "--porcelain"])?;
    if list_output.status.success() {
        let stdout = String::from_utf8_lossy(&list_output.stdout);
        if let Some(main) = parse_worktree_porcelain(&stdout).first() {
            if canon(&main.path) == canon(&validated_worktree.to_string_lossy()) {
                return Err(CommandError::Validation {
                    field: "worktree_path".to_string(),
                    reason: "Cannot remove the main worktree".to_string(),
                });
            }
        }
    }

    let worktree_str = validated_worktree.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        // Twice: once for a dirty tree, once more in case the entry is locked.
        args.extend(["--force", "--force"]);
    }
    args.push(&worktree_str);

    info!(force, "Removing git worktree");
    let output = run_worktree_git(&validated_path, &args)?;
    if !output.status.success() {
        return Err(process_error(&args, &output));
    }

    GIT_CACHE.invalidate(&project_path);
    GIT_CACHE.invalidate(&worktree_path);
    Ok(())
}

/// Runs `git worktree prune` — clears entries whose directories are gone.
#[tauri::command]
#[instrument(name = "prune_worktrees", skip(project_path), fields(project = %project_path))]
pub async fn prune_worktrees(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let args = ["worktree", "prune"];
    let output = run_worktree_git(&validated_path, &args)?;
    if !output.status.success() {
        return Err(process_error(&args, &output));
    }

    GIT_CACHE.invalidate(&project_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_and_linked_worktrees() {
        let porcelain = "\
worktree /Users/me/ShipStudio/myapp
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/main

worktree /Users/me/ShipStudio/.worktrees/myapp/feature-x
HEAD abcdef7890abcdef1234567890abcdef12345678
branch refs/heads/feature-x
";
        let parsed = parse_worktree_porcelain(porcelain);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, "/Users/me/ShipStudio/myapp");
        assert_eq!(parsed[0].head, "1234567890abcdef1234567890abcdef12345678");
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert_eq!(parsed[1].branch.as_deref(), Some("feature-x"));
        assert!(parsed[1].locked.is_none());
        assert!(parsed[1].prunable.is_none());
    }

    #[test]
    fn parses_detached_locked_and_prunable() {
        let porcelain = "\
worktree /repo
HEAD 1111111890abcdef1234567890abcdef12345678
branch refs/heads/main

worktree /wt/detached
HEAD 2222222890abcdef1234567890abcdef12345678
detached

worktree /wt/locked
HEAD 3333333890abcdef1234567890abcdef12345678
branch refs/heads/frozen
locked working on my laptop

worktree /wt/locked-no-reason
HEAD 4444444890abcdef1234567890abcdef12345678
branch refs/heads/cold
locked

worktree /wt/gone
HEAD 5555555890abcdef1234567890abcdef12345678
branch refs/heads/stale
prunable gitdir file points to non-existent location
";
        let parsed = parse_worktree_porcelain(porcelain);
        assert_eq!(parsed.len(), 5);
        assert_eq!(parsed[1].branch, None, "detached HEAD has no branch");
        assert_eq!(parsed[2].locked.as_deref(), Some("working on my laptop"));
        assert_eq!(parsed[3].locked.as_deref(), Some(""));
        assert_eq!(
            parsed[4].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }

    #[test]
    fn parses_single_main_worktree_and_skips_bare() {
        let single = "worktree /repo\nHEAD 9999999890abcdef1234567890abcdef12345678\nbranch refs/heads/main\n";
        assert_eq!(parse_worktree_porcelain(single).len(), 1);

        let bare = "\
worktree /repo.git
bare

worktree /wt/feature
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/feature
";
        let parsed = parse_worktree_porcelain(bare);
        assert_eq!(parsed.len(), 1, "bare entry must be skipped");
        assert_eq!(parsed[0].path, "/wt/feature");
    }

    #[test]
    fn sanitizes_branch_names_into_folder_names() {
        assert_eq!(sanitize_worktree_folder("feature-x"), "feature-x");
        assert_eq!(
            sanitize_worktree_folder("julian/fix-thing"),
            "julian-fix-thing"
        );
        assert_eq!(sanitize_worktree_folder("-leading-dash"), "leading-dash");
        assert_eq!(sanitize_worktree_folder(".hidden"), "hidden");
        assert_eq!(sanitize_worktree_folder("what?is:this*"), "whatisthis");
        assert_eq!(sanitize_worktree_folder("trailing."), "trailing");
        assert_eq!(sanitize_worktree_folder("---"), "worktree");
    }

    #[test]
    fn guards_reject_option_like_and_traversal_refs() {
        assert!(guard_ref_name("feature-x", "branch").is_ok());
        assert!(guard_ref_name("-rf", "branch").is_err());
        assert!(guard_ref_name("a..b", "branch").is_err());
        assert!(guard_ref_name("", "branch").is_err());
    }

    #[test]
    fn pick_free_port_skips_bound_port() {
        use std::net::TcpListener;
        // Bind an ephemeral port, then ask for the range starting just below it:
        // the picker must skip the bound port and return a different free one.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
        let bound = listener.local_addr().unwrap().port();
        if bound == 0 || bound == u16::MAX {
            return; // pathological ephemeral port; skip
        }
        let picked = pick_free_port(bound - 1).expect("a free port should exist");
        assert_ne!(picked, bound, "picker must not return a bound port");
    }

    /// Adding a worktree while inside another worktree must anchor to the
    /// repository's main worktree — the regression scattered one repo's
    /// worktrees across container folders named after whichever checkout
    /// the user happened to invoke from.
    #[test]
    fn main_worktree_path_resolves_from_linked_worktree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let main = tmp.path().join("myrepo");
        std::fs::create_dir(&main).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", tmp.path())
                .output()
                .expect("git runs");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&main, &["init", "-b", "main"]);
        git(&main, &["config", "user.email", "t@t"]);
        git(&main, &["config", "user.name", "t"]);
        git(&main, &["commit", "--allow-empty", "-m", "init"]);
        let linked = tmp.path().join("linked-wt");
        git(
            &main,
            &["worktree", "add", "-b", "side", linked.to_str().unwrap()],
        );

        let from_main = main_worktree_path(&main).expect("resolves from main");
        let from_linked = main_worktree_path(&linked).expect("resolves from linked");
        assert_eq!(from_main.file_name(), main.file_name());
        assert_eq!(
            from_linked.file_name(),
            main.file_name(),
            "linked worktree must resolve to the main worktree, not itself"
        );

        // Non-git directory: no resolution, caller falls back to the input.
        let plain = tmp.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert!(main_worktree_path(&plain).is_none());
    }
}
