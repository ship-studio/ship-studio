//! # Project Management Commands
//!
//! Commands for managing projects and project metadata.
//!
//! Organized into submodules:
//! - `detection` — project type detection and page scanning
//! - `metadata` — reading/writing `.shipstudio/project.json` metadata
//! - `ui_state` — per-project UI state (last-opened, branch prefix, etc.)
//! - `dev_server` — dev server configuration + cache clearing
//! - `templates` — zip template extraction and export
//! - `window_registry` — multi-window project management

mod detection;
mod dev_server;
mod metadata;
mod pins;
mod sessions;
mod templates;
mod ui_state;
mod window_registry;

pub use detection::*;
pub use dev_server::*;
pub use metadata::*;
pub use pins::*;
pub use sessions::*;
pub use templates::*;
pub use ui_state::*;
pub use window_registry::*;

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{DashboardProject, PageInfo, ProjectInfo, ProjectMetadata, ProjectType};
use crate::utils::{
    canonicalize_tagged, create_command, is_retryable_delete_error, remove_dir_all_robust,
    validate_project_path,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ============ Helper Functions ============

/// Hard ceiling for each per-project git call during dashboard scans. Local
/// git commands normally finish in milliseconds; anything slower (repo on a
/// stale network mount, wedged index lock, …) must not stall the dashboard —
/// the project degrades to "no git info" instead (issue #168).
const GIT_SCAN_TIMEOUT_SECS: u64 = 3;

/// How many projects have their git metadata scanned concurrently. Bounded so
/// a dashboard with hundreds of projects doesn't fork an unbounded number of
/// git processes at once.
const GIT_SCAN_CONCURRENCY: usize = 16;

/// Ceiling for the *whole* git pass, across every project. Without it the
/// worst case is `projects / GIT_SCAN_CONCURRENCY * GIT_SCAN_TIMEOUT_SECS` —
/// half a minute for a few hundred repos — because each project only bounds
/// itself. Projects not reached before the deadline degrade to "no git info",
/// exactly like a project that timed out on its own.
const GIT_SCAN_TOTAL_BUDGET_SECS: u64 = 6;

/// [`GIT_SCAN_TOTAL_BUDGET_SECS`] as a `Duration`.
fn git_scan_budget() -> std::time::Duration {
    std::time::Duration::from_secs(GIT_SCAN_TOTAL_BUDGET_SECS)
}

/// Ceiling for one whole `get_dashboard_projects` call. The filesystem pass
/// runs on the blocking pool, where a wedged network mount can hang a thread
/// indefinitely; this is what turns that into an error the dashboard can show
/// instead of a spinner that never stops.
const DASHBOARD_SCAN_BUDGET_SECS: u64 = 25;

/// Run a short, time-bounded scan command and return its output, degrading to
/// `None` on spawn failure or timeout. The child is killed on timeout so a
/// hung git process is never left orphaned.
///
/// `program` is a parameter (rather than hardcoding `git`) so tests can
/// exercise the timeout path with a script that sleeps.
async fn run_scan_command(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout_secs: u64,
) -> Option<std::process::Output> {
    let mut cmd = create_command(program);
    cmd.args(args).current_dir(cwd);
    let mut tokio_cmd = tokio::process::Command::from(cmd);
    // Reap the child when the timeout drops the future — otherwise a hung git
    // would keep running (and holding locks) in the background.
    tokio_cmd.kill_on_drop(true);
    run_with_timeout(
        tokio_cmd,
        format!("{program} {} (dashboard scan)", args.join(" ")),
        timeout_secs,
    )
    .await
    .ok()
}

/// Resolve the checked-out branch by reading `.git/HEAD` directly — one small
/// file read instead of a `git rev-parse` fork per project per dashboard load.
/// Those forks are the ones that logged 733 three-second timeouts in a day.
///
/// Handles worktree and submodule `.git` *files* (`gitdir: <path>`). Returns
/// `None` for a detached HEAD and for a directory with no `.git` of its own,
/// which is also what `get_uncommitted_count` has always required — so the two
/// halves of a row's git info now agree about what counts as a repo.
fn branch_from_head_file(project_path: &Path) -> Option<String> {
    let dot_git = project_path.join(".git");
    let git_dir = if dot_git.is_file() {
        let contents = std::fs::read_to_string(&dot_git).ok()?;
        let target = Path::new(contents.strip_prefix("gitdir:")?.trim());
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            project_path.join(target)
        }
    } else if dot_git.is_dir() {
        dot_git
    } else {
        return None;
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let name = head.trim().strip_prefix("ref: refs/heads/")?;
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Helper to count uncommitted changes (tracked files only; time-bounded,
/// `None` on timeout). Results — failures included — are cached in `GIT_CACHE`
/// for 30s, so the repeat dashboard loads that used to re-fork `git status`
/// for every project hit the cache instead. Git write operations invalidate
/// the entry through the existing `invalidate`/`invalidate_status` paths, so a
/// commit or a branch switch is reflected immediately.
async fn get_uncommitted_count(project_path: &Path) -> Option<u32> {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return None;
    }

    let cache_key = project_path.to_string_lossy().to_string();
    if let Some(cached) = crate::cache::GIT_CACHE.get_scan_status(&cache_key) {
        return cached;
    }

    // Use -uno to ignore untracked files like .DS_Store
    let output = run_scan_command(
        "git",
        &["status", "--porcelain", "-uno"],
        project_path,
        GIT_SCAN_TIMEOUT_SECS,
    )
    .await;

    let count = output.filter(|o| o.status.success()).map(|o| {
        let stdout = String::from_utf8_lossy(&o.stdout);
        stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32
    });
    crate::cache::GIT_CACHE.set_scan_status(&cache_key, count);
    count
}

/// Counts uncommitted changes for many projects concurrently. Each git call
/// is bounded by [`GIT_SCAN_TIMEOUT_SECS`] and the pass as a whole by
/// [`GIT_SCAN_TOTAL_BUDGET_SECS`], so neither one slow repo nor several
/// hundred of them can hold the dashboard. Results are returned in input
/// order, `None` where the count could not be had.
async fn scan_uncommitted_counts(
    paths: Vec<PathBuf>,
    budget: std::time::Duration,
) -> Vec<Option<u32>> {
    let deadline = tokio::time::Instant::now() + budget;
    stream::iter(paths)
        .map(|path| async move {
            match tokio::time::timeout_at(deadline, get_uncommitted_count(&path)).await {
                Ok(count) => count,
                Err(_) => {
                    tracing::debug!(
                        project = %path.display(),
                        "dashboard git scan budget exhausted; reporting no git status"
                    );
                    None
                }
            }
        })
        .buffered(GIT_SCAN_CONCURRENCY)
        .collect()
        .await
}

/// Issue #162: a project silently missing from the dashboard is
/// indistinguishable from data loss to users. Every filter that hides a
/// directory from the project list must log through here so the exclusion
/// shows up loudly in the logs (logging only — no behavior change).
fn warn_project_excluded(path: &Path, reason: &str) {
    tracing::warn!(
        path = %path.display(),
        reason,
        "project directory excluded from dashboard list"
    );
}

/// Check if a directory is a valid project.
/// Accepts any directory inside ~/ShipStudio that has project files,
/// a .gitignore (blank projects), or a .shipstudio metadata folder.
///
/// The language-ecosystem markers match `looks_like_project_root` in
/// external_projects.rs — the manual "Select Project Folder" picker used to
/// reject a Rust/Go/Python/Ruby/Java/PHP project that the automatic
/// registration path would happily accept (issue #251).
pub(crate) fn is_valid_project(path: &std::path::Path) -> bool {
    const ECOSYSTEM_MARKERS: &[&str] = &[
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "Gemfile",
        "pom.xml",
        "build.gradle",
        "composer.json",
    ];
    // A home directory very often carries a stray `.git`/`.gitignore`, but it
    // must never count as a project — see is_forbidden_project_root (#345).
    if crate::utils::is_forbidden_project_root(path) {
        return false;
    }
    path.is_dir()
        && (path.join("package.json").exists()
            || detection::static_site_dir(path).is_some()
            || path.join(".gitignore").exists()
            || path.join(".shipstudio").exists()
            || path.join(".git").exists()
            || ECOSYSTEM_MARKERS.iter().any(|m| path.join(m).exists()))
}

/// Counts app-managed git worktrees for a project: subdirectories of
/// `<projects_root>/.worktrees/<project_dir_name>`. Filesystem-only (no git)
/// so the dashboard scan stays cheap; `None` when there are none.
fn count_managed_worktrees(project_path: &std::path::Path) -> Option<usize> {
    let dir_name = project_path.file_name()?;
    let container = crate::utils::projects_root()
        .ok()?
        .join(".worktrees")
        .join(dir_name);
    let count = std::fs::read_dir(container)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .count();
    if count > 0 {
        Some(count)
    } else {
        None
    }
}

/// Whether a project should be shown on the dashboard for the given active
/// Workspace (Account). Resolves through the shared `effective_account_id_in`
/// helper so visibility and credential routing never disagree: a project is
/// shown in the workspace it effectively belongs to (tagged-and-existing → that
/// workspace; untagged or tagged-to-a-deleted-workspace → Default). `accounts`
/// is the live workspace list, passed in so this stays IO-free in the loop.
fn project_visible_for_account(
    metadata: Option<&ProjectMetadata>,
    active_account_id: &str,
    accounts: &[crate::types::Account],
) -> bool {
    ui_state::effective_account_id_in(metadata, accounts) == active_account_id
}

const REMOVED_PROJECTS_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Guards removed-project registry read/mutate/write cycles so simultaneous
/// remove and restore actions cannot overwrite each other's changes.
static REMOVED_PROJECTS_CONFIG_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

#[cfg(test)]
static REMOVED_PROJECTS_CONFIG_PATH_OVERRIDE: std::sync::LazyLock<
    std::sync::Mutex<Option<PathBuf>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// One dashboard-hidden project entry in the app-level removal registry.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct RemovedProject {
    /// Canonical project directory path recorded at removal time.
    path: String,
    /// Millisecond Unix timestamp used for audit/debugging.
    removed_at: u64,
}

/// Persistent app-level registry for local projects hidden from the dashboard.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct RemovedProjectsConfig {
    /// Schema version for future migrations.
    schema_version: u32,
    /// Canonical project paths hidden from automatic local project scans.
    #[serde(default)]
    projects: Vec<RemovedProject>,
}

impl Default for RemovedProjectsConfig {
    fn default() -> Self {
        Self {
            schema_version: REMOVED_PROJECTS_CONFIG_SCHEMA_VERSION,
            projects: Vec::new(),
        }
    }
}

impl RemovedProjectsConfig {
    /// Returns true when the registry already hides the canonical project path.
    fn contains_path(&self, canonical_path: &Path) -> bool {
        self.projects
            .iter()
            .any(|project| stored_path_matches(&project.path, canonical_path))
    }
}

/// Returns the app-level path for the removed-projects registry.
fn removed_projects_config_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = REMOVED_PROJECTS_CONFIG_PATH_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(path);
    }

    Ok(crate::utils::default_projects_root()?
        .join(".shipstudio")
        .join("removed-projects.json"))
}

/// Loads the removed-projects registry, returning an empty config only when it
/// has not been created yet.
fn load_removed_projects_config() -> Result<RemovedProjectsConfig, String> {
    let config_path = removed_projects_config_path()?;

    if !config_path.exists() {
        return Ok(RemovedProjectsConfig::default());
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read removed projects config: {e}"))?;

    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse removed projects config: {e}"))
}

/// Persists the removed-projects registry to disk.
fn save_removed_projects_config(config: &RemovedProjectsConfig) -> Result<(), String> {
    let config_path = removed_projects_config_path()?;

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize removed projects config: {e}"))?;

    let file_name = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("removed-projects.json");
    let temp_path = config_path.with_file_name(format!(".{file_name}.tmp"));

    std::fs::write(&temp_path, contents)
        .map_err(|e| format!("Failed to write removed projects config: {e}"))?;

    std::fs::rename(&temp_path, &config_path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to replace removed projects config: {e}")
    })
}

/// Canonicalizes a path when possible, preserving the original path if it no
/// longer exists.
fn canonical_or_original(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Compares a stored registry path to the current canonical project path.
fn stored_path_matches(stored_path: &str, canonical_path: &Path) -> bool {
    canonical_or_original(Path::new(stored_path)) == canonical_path
}

/// Returns the current wall-clock time in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Records a canonical local project path as hidden from dashboard scans.
fn mark_project_removed(canonical: &Path) -> Result<(), CommandError> {
    let _guard = REMOVED_PROJECTS_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut config = load_removed_projects_config()?;
    if !config.contains_path(canonical) {
        config.projects.push(RemovedProject {
            path: canonical.to_string_lossy().to_string(),
            removed_at: now_ms(),
        });
    }
    save_removed_projects_config(&config)?;
    Ok(())
}

/// Removes a canonical path from the hidden-project registry.
pub(crate) fn restore_removed_project(canonical: &Path) -> Result<bool, CommandError> {
    let _guard = REMOVED_PROJECTS_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut config = load_removed_projects_config()?;
    let initial_len = config.projects.len();
    config
        .projects
        .retain(|project| !stored_path_matches(&project.path, canonical));

    let restored = config.projects.len() != initial_len;
    if restored {
        save_removed_projects_config(&config)?;
    }

    Ok(restored)
}

// ============ Tauri Commands ============

/// Open the projects root for scanning, naming the folder on failure. On
/// macOS, TCC answers EPERM (os error 1) when the app lacks Files-and-Folders
/// access to the folder (Desktop/Documents/iCloud/external volumes) — an
/// environment gap with a user-side fix, not a malfunction (issue #307).
fn read_projects_dir(dir: &std::path::Path) -> Result<std::fs::ReadDir, CommandError> {
    std::fs::read_dir(dir).map_err(|e| {
        if cfg!(target_os = "macos") && e.raw_os_error() == Some(1) {
            CommandError::expected(format!(
                "Harbr isn't allowed to read your projects folder ({}). Grant access in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then reload the dashboard.",
                dir.display()
            ))
        } else {
            CommandError::from(format!(
                "Failed to read projects folder {}: {e}",
                dir.display()
            ))
        }
    })
}

#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn list_projects() -> Result<Vec<ProjectInfo>, CommandError> {
    let shipstudio_dir = crate::utils::projects_root()?;
    // Account resolution must never break project listing: degrade to "no active
    // account" (everything visible) on failure rather than erroring the whole list.
    let active_account_id = crate::commands::accounts::get_active_account_id().unwrap_or_default();
    // Live workspace list, read once so the visibility check stays IO-free per project.
    let accounts = crate::commands::setup::read_app_state().accounts;
    let removed_projects = load_removed_projects_config()?;

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = read_projects_dir(&shipstudio_dir)?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to read an entry in projects folder {}: {e}",
                shipstudio_dir.display()
            )
        })?;
        let path = entry.path();
        if is_valid_project(&path) {
            let canonical = canonical_or_original(&path);
            if removed_projects.contains_path(&canonical) {
                warn_project_excluded(&path, "listed in removed-projects.json registry");
                continue;
            }

            let thumbnail_path = path.join(".shipstudio").join("thumbnail.png");
            let thumbnail = if thumbnail_path.exists() {
                Some(thumbnail_path.to_string_lossy().to_string())
            } else {
                None
            };

            let metadata_path = path.join(".shipstudio").join("project.json");
            let metadata = if metadata_path.exists() {
                std::fs::read_to_string(&metadata_path)
                    .ok()
                    .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            } else {
                None
            };

            if !project_visible_for_account(metadata.as_ref(), &active_account_id, &accounts) {
                warn_project_excluded(
                    &path,
                    "belongs to a different workspace (account visibility filter)",
                );
                continue;
            }

            let last_opened = metadata.as_ref().and_then(|m| m.last_opened);

            projects.push(ProjectInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                thumbnail,
                last_opened,
            });
        } else if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            warn_project_excluded(&path, "not recognized as a project (no project markers)");
        }
    }

    // Append external projects
    if let Ok(ext_config) = crate::commands::external_projects::load_config() {
        for ext in &ext_config.projects {
            let ext_path = std::path::Path::new(&ext.path);
            if ext_path.exists() && is_valid_project(ext_path) {
                let name = ext_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "external".to_string());

                let thumbnail_path = ext_path.join(".shipstudio").join("thumbnail.png");
                let thumbnail = if thumbnail_path.exists() {
                    Some(thumbnail_path.to_string_lossy().to_string())
                } else {
                    None
                };

                let metadata_path = ext_path.join(".shipstudio").join("project.json");
                let metadata = if metadata_path.exists() {
                    std::fs::read_to_string(&metadata_path)
                        .ok()
                        .and_then(|contents| {
                            serde_json::from_str::<ProjectMetadata>(&contents).ok()
                        })
                } else {
                    None
                };

                if !project_visible_for_account(metadata.as_ref(), &active_account_id, &accounts) {
                    warn_project_excluded(
                        ext_path,
                        "external project belongs to a different workspace (account visibility filter)",
                    );
                    continue;
                }

                let last_opened = metadata.as_ref().and_then(|m| m.last_opened);

                projects.push(ProjectInfo {
                    name,
                    path: ext_path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                });
            } else {
                warn_project_excluded(
                    ext_path,
                    "registered external project is missing or not recognized as a project",
                );
            }
        }
    }

    projects.sort_by(|a, b| match (a.last_opened, b.last_opened) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(projects)
}

/// Everything the dashboard scan reads *once* rather than per project:
/// workspace visibility inputs, the removed-project registry and the external
/// project registry. Split out so the per-project loop stays IO-free apart
/// from the project directory itself, and so tests can drive the scan with
/// deterministic inputs instead of the machine's real app state.
struct DashboardScanInputs {
    active_account_id: String,
    accounts: Vec<crate::types::Account>,
    removed_projects: RemovedProjectsConfig,
    /// Registered external project directories, in registry order.
    external_paths: Vec<PathBuf>,
}

impl DashboardScanInputs {
    /// Read the real app-level inputs. Blocking filesystem work — call from a
    /// blocking context, never on a tokio worker thread.
    fn read() -> Result<Self, CommandError> {
        Ok(Self {
            // Account resolution must never break the dashboard: degrade to "no active
            // account" (everything visible) on failure rather than erroring the whole list.
            active_account_id: crate::commands::accounts::get_active_account_id()
                .unwrap_or_default(),
            accounts: crate::commands::setup::read_app_state().accounts,
            removed_projects: load_removed_projects_config()?,
            external_paths: crate::commands::external_projects::load_config()
                .map(|c| c.projects.iter().map(|p| PathBuf::from(&p.path)).collect())
                .unwrap_or_default(),
        })
    }
}

/// First pass of the dashboard scan: filesystem-only collection of every
/// visible project under `root` plus the registered external projects.
///
/// Entirely synchronous — every `std::fs` call in the dashboard scan lives
/// here, so the caller can run the whole pass inside a single
/// `spawn_blocking` instead of scattering blocking opens across tokio worker
/// threads. Returns the projects in display order (locals in directory order,
/// then externals) alongside the matching per-project paths the git pass
/// needs, in the same order.
fn collect_dashboard_projects(
    root: &Path,
    inputs: &DashboardScanInputs,
) -> Result<(Vec<DashboardProject>, Vec<PathBuf>), CommandError> {
    let mut projects = Vec::new();
    let mut scan_paths: Vec<PathBuf> = Vec::new();

    if !root.exists() {
        return Ok((projects, scan_paths));
    }

    for entry in read_projects_dir(root)? {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to read an entry in projects folder {}: {e}",
                root.display()
            )
        })?;
        let path = entry.path();
        if is_valid_project(&path) {
            let canonical = canonical_or_original(&path);
            if inputs.removed_projects.contains_path(&canonical) {
                warn_project_excluded(&path, "listed in removed-projects.json registry");
                continue;
            }

            let Some(project) = build_dashboard_project(
                &path,
                entry.file_name().to_string_lossy().to_string(),
                false,
                inputs,
            ) else {
                continue;
            };
            projects.push(project);
            scan_paths.push(path);
        } else if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            warn_project_excluded(&path, "not recognized as a project (no project markers)");
        }
    }

    // Append external projects
    for path in &inputs.external_paths {
        if path.exists() && is_valid_project(path) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "external".to_string());
            let Some(project) = build_dashboard_project(path, name, true, inputs) else {
                continue;
            };
            projects.push(project);
            scan_paths.push(path.clone());
        } else {
            warn_project_excluded(
                path,
                "registered external project is missing or not recognized as a project",
            );
        }
    }

    Ok((projects, scan_paths))
}

/// Build one dashboard row from a project directory. `None` when the project
/// belongs to a different workspace (the row is excluded and warned about).
///
/// Git metadata is left as `None` here and filled in by the git pass.
fn build_dashboard_project(
    path: &Path,
    name: String,
    is_external: bool,
    inputs: &DashboardScanInputs,
) -> Option<DashboardProject> {
    let thumbnail_path = path.join(".shipstudio").join("thumbnail.png");
    let thumbnail = if thumbnail_path.exists() {
        Some(thumbnail_path.to_string_lossy().to_string())
    } else {
        None
    };

    let metadata_path = path.join(".shipstudio").join("project.json");
    let metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
    } else {
        None
    };

    if !project_visible_for_account(
        metadata.as_ref(),
        &inputs.active_account_id,
        &inputs.accounts,
    ) {
        warn_project_excluded(
            path,
            if is_external {
                "external project belongs to a different workspace (account visibility filter)"
            } else {
                "belongs to a different workspace (account visibility filter)"
            },
        );
        return None;
    }

    // Deliberately NOT ensuring `.shipstudio/` is gitignored here. Listing the
    // dashboard used to read — and sometimes write — a `.gitignore` in every
    // one of the user's repositories on every render. Rendering a list must not
    // mutate the things it lists. The write already happens where it belongs:
    // at project creation (`useProjectCreation`) and on every project open
    // (`useProjectLifecycle`), both through the `ensure_gitignore_has_shipstudio`
    // command, which is where a project that predates the entry gets fixed.

    Some(DashboardProject {
        name,
        path: path.to_string_lossy().to_string(),
        thumbnail,
        last_opened: metadata.as_ref().and_then(|m| m.last_opened),
        // Read straight off `.git/HEAD` — no subprocess, so it belongs in this
        // synchronous pass. Only the uncommitted count still needs git itself.
        git_branch: branch_from_head_file(path),
        uncommitted_count: None,
        auto_accept_mode: metadata.as_ref().and_then(|m| m.auto_accept_mode),
        hide_main_branch_warning: metadata.as_ref().and_then(|m| m.hide_main_branch_warning),
        is_external,
        workspace_subpath: metadata.as_ref().and_then(|m| m.workspace_subpath.clone()),
        worktree_count: count_managed_worktrees(path),
    })
}

/// Order the dashboard: most recently opened first, never-opened last by name.
fn sort_dashboard_projects(projects: &mut [DashboardProject]) {
    projects.sort_by(|a, b| match (a.last_opened, b.last_opened) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });
}

/// The whole dashboard scan for one projects root, with the app-level inputs
/// supplied by the caller. Split from the command so tests and the timing
/// harness drive exactly the code the command runs.
///
/// The filesystem pass runs on the blocking pool. It has to: it is on the
/// order of a hundred `std::fs` calls per project, and running them on a tokio
/// worker parks that worker for the whole scan. With three simultaneous
/// dashboard calls that was three workers parked at once, and nothing left to
/// run the rest of the app — which is exactly what a `sample` of the wedged
/// process showed.
async fn scan_dashboard_projects_in(
    root: PathBuf,
    inputs: DashboardScanInputs,
) -> Result<Vec<DashboardProject>, CommandError> {
    let (mut projects, scan_paths) =
        tokio::task::spawn_blocking(move || collect_dashboard_projects(&root, &inputs))
            .await
            .map_err(|e| CommandError::from(format!("Dashboard scan panicked: {e}")))??;

    // Second pass: concurrent, time-bounded `git status` (one entry per
    // project, in the same order projects were pushed above). A repo that
    // errors or times out simply keeps `uncommitted_count: None`.
    let counts = scan_uncommitted_counts(scan_paths, git_scan_budget()).await;
    for (project, uncommitted_count) in projects.iter_mut().zip(counts) {
        project.uncommitted_count = uncommitted_count;
    }

    sort_dashboard_projects(&mut projects);
    Ok(projects)
}

/// The most recent run of a coalesced operation, with the instant that run
/// *started*.
struct Coalesced<T> {
    started_at: std::time::Instant,
    value: T,
}

/// Run `work`, unless an equivalent run that started after `arrived_at` has
/// already produced an answer — in which case take that answer instead.
///
/// This is coalescing, not caching, and the distinction is the whole point: a
/// caller is only ever handed a result from a run that began *after the caller
/// asked*, so it can never see something staler than a scan of its own would
/// have been. Three simultaneous dashboard loads therefore cost one scan, and
/// a load issued a moment after a project was deleted still rescans.
///
/// The lock is held across the work, so callers queue rather than pile on.
async fn coalesce<T, E, F, Fut>(
    slot: &tokio::sync::Mutex<Option<Coalesced<T>>>,
    arrived_at: std::time::Instant,
    work: F,
) -> Result<T, E>
where
    T: Clone,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut guard = slot.lock().await;
    if let Some(last) = guard.as_ref() {
        if last.started_at >= arrived_at {
            return Ok(last.value.clone());
        }
    }
    let started_at = std::time::Instant::now();
    let value = work().await?;
    *guard = Some(Coalesced {
        started_at,
        value: value.clone(),
    });
    Ok(value)
}

/// Coalescing slot for [`get_dashboard_projects`]. Three concurrent identical
/// calls used to run the same expensive scan three times over.
static DASHBOARD_SCAN_GATE: tokio::sync::Mutex<Option<Coalesced<Vec<DashboardProject>>>> =
    tokio::sync::Mutex::const_new(None);

/// Returns enhanced project list for dashboard with git info
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn get_dashboard_projects() -> Result<Vec<DashboardProject>, CommandError> {
    let arrived_at = std::time::Instant::now();
    coalesce(&DASHBOARD_SCAN_GATE, arrived_at, || async {
        let scan = async {
            let root = crate::utils::projects_root()?;
            // Reading app state, the removed-project registry and the
            // external-project registry is three more file opens — off the
            // runtime with everything else.
            let inputs = tokio::task::spawn_blocking(DashboardScanInputs::read)
                .await
                .map_err(|e| CommandError::from(format!("Dashboard scan panicked: {e}")))??;
            scan_dashboard_projects_in(root, inputs).await
        };

        tokio::time::timeout(
            std::time::Duration::from_secs(DASHBOARD_SCAN_BUDGET_SECS),
            scan,
        )
        .await
        .map_err(|_| {
            CommandError::expected(format!(
                "Reading your projects folder took longer than {DASHBOARD_SCAN_BUDGET_SECS}s and was stopped. This usually means a project is on a disconnected network drive or an unmounted volume."
            ))
        })?
    })
    .await
}

/// Scans a project's pages/routes directory for page routes.
/// Supports Next.js, SvelteKit, Astro, Nuxt, and static HTML projects.
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_pages(project_path: String) -> Result<Vec<PageInfo>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let project_type = detection::detect_project_type(&project);

    match project_type {
        ProjectType::Astro => {
            let pages_dir = project.join("src").join("pages");
            if pages_dir.exists() {
                let mut pages = detection::scan_astro_pages(&pages_dir, &pages_dir)?;
                // With Astro i18n, non-default locale folders mirror the
                // default-language pages — hide the duplicates so the page
                // selector lists each page once.
                let locale_prefixes = crate::commands::i18n::astro_locale_prefixes(&project);
                if !locale_prefixes.is_empty() {
                    pages.retain(|p| {
                        let first = p
                            .route
                            .trim_start_matches('/')
                            .split('/')
                            .next()
                            .unwrap_or("");
                        !locale_prefixes.iter().any(|l| l == first)
                    });
                }
                detection::sort_pages(&mut pages);
                return Ok(pages);
            }
            Ok(Vec::new())
        }
        ProjectType::Sveltekit => {
            let routes_dir = project.join("src").join("routes");
            if routes_dir.exists() {
                let mut pages = detection::scan_sveltekit_pages(&routes_dir, &routes_dir)?;
                detection::sort_pages(&mut pages);
                return Ok(pages);
            }
            Ok(Vec::new())
        }
        ProjectType::Nuxt => {
            let pages_dir = project.join("pages");
            if pages_dir.exists() {
                let mut pages = detection::scan_nuxt_pages(&pages_dir, &pages_dir)?;
                detection::sort_pages(&mut pages);
                return Ok(pages);
            }
            Ok(Vec::new())
        }
        ProjectType::Statichtml => {
            // Scan the directory the static server actually serves from (the
            // root, or Vercel-style public/) so routes match served URLs.
            let site_dir = detection::static_site_dir(&project).unwrap_or(project.clone());
            let mut pages = detection::scan_html_pages(&site_dir, &site_dir)?;
            detection::sort_pages(&mut pages);
            Ok(pages)
        }
        ProjectType::Vite => Ok(Vec::new()),
        // Native mobile apps have no web page routes; the `app/` dir of an Expo
        // Router project is NOT a Next.js app router and must not be scanned.
        ProjectType::Reactnative | ProjectType::Flutter => Ok(Vec::new()),
        _ => {
            // Default to Next.js: App Router first (app/ or src/app/), then
            // the Pages Router (pages/ or src/pages/) — projects with routes
            // only under src/pages/ used to come back empty ("No pages
            // found").
            for app_dir in [project.join("app"), project.join("src").join("app")] {
                if app_dir.exists() {
                    let mut pages = detection::scan_nextjs_pages(&app_dir, &app_dir)?;
                    detection::sort_pages(&mut pages);
                    // Stripping the [locale] segment can alias routes (e.g. a
                    // stray app/page.tsx next to app/[locale]/page.tsx) —
                    // list each once.
                    pages.dedup_by(|a, b| a.route == b.route);
                    return Ok(pages);
                }
            }
            for pages_dir in [project.join("pages"), project.join("src").join("pages")] {
                if pages_dir.exists() {
                    let mut pages = detection::scan_nextjs_pages_router(&pages_dir, &pages_dir)?;
                    detection::sort_pages(&mut pages);
                    pages.dedup_by(|a, b| a.route == b.route);
                    return Ok(pages);
                }
            }
            Ok(Vec::new())
        }
    }
}

/// Opens a folder in Finder (macOS)
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn open_in_finder(path: String) -> Result<(), CommandError> {
    let path = validate_project_path(&path)?;

    #[cfg(target_os = "macos")]
    {
        crate::utils::create_command("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        crate::utils::create_command("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        crate::utils::create_command("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Ensures .shipstudio/ is in the project's .gitignore
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn ensure_gitignore_has_shipstudio(project_path: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let gitignore_path = project.join(".gitignore");

    let entry = ".shipstudio/";

    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)
            .map_err(|e| format!("Failed to read .gitignore: {e}"))?
    } else {
        String::new()
    };

    let already_ignored = content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == entry
            || trimmed == ".shipstudio"
            || trimmed == "/.shipstudio/"
            || trimmed == "/.shipstudio"
    });

    if already_ignored {
        return Ok(());
    }

    let new_content = if content.is_empty() {
        format!("# ShipStudio metadata\n{entry}\n")
    } else if content.ends_with('\n') {
        format!("{content}\n# ShipStudio metadata\n{entry}\n")
    } else {
        format!("{content}\n\n# ShipStudio metadata\n{entry}\n")
    };

    std::fs::write(&gitignore_path, new_content)
        .map_err(|e| format!("Failed to write .gitignore: {e}"))?;

    Ok(())
}

/// Creates a blank project directory with a .gitignore.
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn create_blank_project(project_path: String) -> Result<(), CommandError> {
    // Can't use validate_project_path because the directory doesn't exist yet.
    // Instead, validate that the parent is within an allowed projects root.
    let path = std::path::Path::new(&project_path);
    let parent = path.parent().ok_or("Invalid project path")?;
    let canonical_parent =
        dunce::canonicalize(parent).map_err(|e| format!("Invalid parent path: {e}"))?;
    if !crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical_parent.starts_with(root))
    {
        return Err(("Project must be inside the projects directory".to_string()).into());
    }

    std::fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create project directory: {e}"))?;

    // Add .shipstudio/ to gitignore
    let gitignore = path.join(".gitignore");
    std::fs::write(&gitignore, ".shipstudio/\n")
        .map_err(|e| format!("Failed to create .gitignore: {e}"))?;

    Ok(())
}

/// Removes the .git directory from a project so it starts fresh (not connected to template repo).
#[ship_studio_macros::ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn remove_git_history(project_path: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let git_dir = project.join(".git");

    if git_dir.exists() {
        std::fs::remove_dir_all(&git_dir)
            .map_err(|e| format!("Failed to remove .git directory: {e}"))?;
    }

    Ok(())
}

// `make_writable_recursive` / `is_retryable_delete_error` /
// `remove_dir_all_robust` were extracted to `crate::utils` so
// `delete_asset` (assets.rs) can share the Windows lock-retry treatment
// (issue #696). `rename_robust` stays here — it's only used by this module.

/// Blocking rename with the same lock-retry treatment as
/// [`remove_dir_all_robust`]: a transient Windows sharing violation
/// (antivirus scan, Search indexer, a just-suspended session's child not
/// fully exited) failed the single unretried `fs::rename` immediately with
/// "os error 32" (issue #559). Call from `spawn_blocking` — the sleeps can
/// hold a thread for seconds.
fn rename_robust(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut delay = std::time::Duration::from_millis(100);
    let mut retries = 10;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if retries > 0 && is_retryable_delete_error(&e) => {
                tracing::info!(
                    "rename blocked by a file lock ({}), retrying: {}",
                    from.display(),
                    e
                );
                retries -= 1;
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(1));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Deletes a project directory. Only allows deletion from ~/ShipStudio.
/// External projects cannot be deleted — use unregister_external_project instead.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn delete_project(path: String) -> Result<(), CommandError> {
    // Canonicalize FIRST (resolves symlinks and `..`) so the containment check
    // below can't be defeated by a lexical path like `~/ShipStudio/../../.ssh`.
    // `Path::starts_with` is purely lexical and would otherwise pass such a path
    // straight through to `remove_dir_all`. `canonicalize_tagged` classifies a
    // vanished folder as `CommandError::Expected` instead of a raw IO error —
    // the project was already gone from disk, not an app malfunction (#877).
    let canonical = canonicalize_tagged(&path, "delete_project")?;

    // Check if this is an external project. A by-design guard with a
    // user-side path forward, not a malfunction — Expected keeps it out of
    // telemetry (issue #699).
    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        return Err(CommandError::expected(
            "Cannot delete external projects. Use 'Remove from Harbr' instead.",
        ));
    }

    if !crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(("Can only delete projects from the projects directory".to_string()).into());
    }

    let path_str = canonical.to_string_lossy().to_string();

    // 1. Suspend the session first (kills PTYs + mobile previews) so nothing
    //    holds handles inside the tree — the usual Windows deletion blocker.
    suspend_session_internal(&path_str).await;

    // 2. Unregister the session entirely. Failure isn't fatal to the delete,
    //    but say so — a ghost registry entry explains later oddities.
    if let Err(err) = unregister_project_session(path_str).await {
        tracing::warn!(
            project = %canonical.display(),
            error = %err,
            "Failed to unregister session before deleting project"
        );
    }

    // 3. Delete the directory robustly (read-only attributes, transient
    //    Windows locks). The chmod walk + retry sleeps are blocking work, so
    //    keep them off the async runtime.
    let target = canonical.clone();
    tokio::task::spawn_blocking(move || remove_dir_all_robust(&target))
        .await
        .map_err(|e| format!("Project deletion task failed: {e}"))?
        .map_err(|e| format!("Failed to delete project directory: {e}"))?;

    // 4. Clear dashboard references (pins, folders) — after the delete, so a
    //    failed delete doesn't strip the pin off a project that still exists.
    clear_project_dashboard_references(&canonical, Some(&path)).await;
    Ok(())
}

/// Clears path-keyed dashboard references after a project has already been
/// removed from the visible project set.
async fn clear_project_dashboard_references(canonical: &Path, dashboard_key: Option<&str>) {
    let canonical_str = canonical.to_string_lossy().to_string();
    let mut keys = Vec::new();

    if let Some(key) = dashboard_key {
        if !key.is_empty() {
            keys.push(key.to_string());
        }
    }

    if !keys.iter().any(|key| key == &canonical_str) {
        keys.push(canonical_str);
    }

    for key in keys {
        if let Err(err) = crate::commands::folders::move_project_to_folder(key.clone(), None).await
        {
            tracing::warn!(
                project = %canonical.display(),
                dashboard_key = %key,
                error = %err,
                "Failed to clear project folder assignment after removal"
            );
        }

        if let Err(err) = crate::commands::projects::unpin_project(key.clone()).await {
            tracing::warn!(
                project = %canonical.display(),
                dashboard_key = %key,
                error = %err,
                "Failed to unpin project after removal"
            );
        }
    }
}

/// Removes a project from Harbr's dashboard without deleting its files.
///
/// Projects inside a configured projects folder are discovered automatically, so
/// this records the exact project path in Harbr's app config and list
/// scans skip it afterward. External projects keep using their existing
/// registry removal path.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn remove_project_from_app(path: String) -> Result<(), CommandError> {
    let canonical = validate_project_path(&path)?;

    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        crate::commands::external_projects::unregister_external_project(path.clone()).await?;
        clear_project_dashboard_references(&canonical, Some(&path)).await;
        return Ok(());
    }

    if !crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(
            "Can only remove projects that live in a Harbr projects folder."
                .to_string()
                .into(),
        );
    }

    mark_project_removed(&canonical)?;
    clear_project_dashboard_references(&canonical, Some(&path)).await;

    Ok(())
}

/// Validate a proposed new project folder name, returning the trimmed value.
///
/// A project name becomes a directory name, so it must be a single path
/// component: no separators, no `.`/`..`, no leading dot (hidden dirs), not
/// empty, not absurdly long.
fn validate_project_name(name: &str) -> Result<String, CommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CommandError::Validation {
            field: "new_name".into(),
            reason: "Project name cannot be empty".into(),
        });
    }
    if trimmed.len() > 255 {
        return Err(CommandError::Validation {
            field: "new_name".into(),
            reason: "Project name is too long".into(),
        });
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(CommandError::Validation {
            field: "new_name".into(),
            reason: "Project name cannot contain slashes".into(),
        });
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CommandError::Validation {
            field: "new_name".into(),
            reason: "Invalid project name".into(),
        });
    }
    if trimmed.starts_with('.') {
        return Err(CommandError::Validation {
            field: "new_name".into(),
            reason: "Project name cannot start with a dot".into(),
        });
    }
    Ok(trimmed.to_string())
}

/// Renames a project's directory on disk and rekeys all path-keyed stores.
///
/// Only ~/ShipStudio projects can be renamed (external projects are rejected,
/// matching `delete_project`). Refuses to rename while the project is open in
/// a *different* window; a hot background session (the rail keeps PTYs and dev
/// servers alive after the user returns to the dashboard) is suspended first
/// so the folder isn't moved out from under live processes. Everything inside
/// the directory — git remotes, `.vercel`, `.shipstudio` metadata — travels
/// with the move untouched. Returns the new absolute path.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(window))]
pub async fn rename_project(
    window: tauri::Window,
    old_path: String,
    new_name: String,
) -> Result<String, CommandError> {
    // Canonicalize FIRST (resolves symlinks and `..`); `Path::starts_with` is
    // lexical, so checking the raw `old_path` would let `~/ShipStudio/../../foo`
    // escape the sandbox and rename arbitrary directories. State stores are
    // still keyed by the original `old_path` string the frontend passed.
    // `canonicalize_tagged` classifies a vanished folder as
    // `CommandError::Expected` instead of a raw IO error (#877).
    let project_path = canonicalize_tagged(&old_path, "rename_project")?;
    let project_path = project_path.as_path();

    // Reject external projects (their folders live outside ~/ShipStudio). A
    // by-design refusal with a user-side path forward, not a malfunction —
    // Expected keeps it out of telemetry (issue #699).
    if crate::commands::external_projects::is_registered_external_path(project_path)? {
        return Err(CommandError::expected(
            "Renaming external projects isn't supported yet. Remove it from the list and re-add it under a new folder name.",
        ));
    }

    // Must live inside an allowed projects root.
    if !crate::utils::allowed_project_roots()
        .iter()
        .any(|root| project_path.starts_with(root))
    {
        return Err(("Can only rename projects in the projects directory".to_string()).into());
    }

    // Validate + normalize the requested name.
    let new_name = validate_project_name(&new_name)?;

    // The rename UI only exists on the dashboard, so if the window registry
    // says *this* window owns the project, the entry is stale — the user
    // navigated back to the dashboard, which never unregisters (hot-session
    // contract). Clear it and continue. A *different* window owning it means
    // the project may genuinely be on screen there: refuse.
    if let Some(owning_label) = crate::state::get_window_for_project(&old_path) {
        if owning_label != window.label() {
            return Err(
                "This project is open in another window. Close that window, then rename."
                    .to_string()
                    .into(),
            );
        }
        crate::state::unregister_project_window(&old_path);
    }

    // A hot background session (PTYs / dev server kept alive by the rail)
    // would have the folder moved out from under its live processes. Suspend
    // it first — same teardown as the rail's close button; the pin survives
    // and is rekeyed below, so the user can cold-start it at the new path.
    if let Some(session) = crate::state::get_session(&old_path) {
        if session.status == crate::state::SessionStatus::Active {
            let killed = sessions::suspend_session_internal(&old_path).await;
            tracing::info!(
                "Suspended hot session before rename: project={}, killed_ptys={}",
                old_path,
                killed
            );
        }
    }

    // Destination is a sibling directory with the new name.
    let parent = project_path
        .parent()
        .ok_or("Invalid project path (no parent)")?;
    let new_path = parent.join(&new_name);

    // No-op if the name didn't actually change.
    if new_path.as_path() == project_path {
        return Ok(old_path);
    }
    if new_path.exists() {
        // A by-design validation refusal the user corrects by picking another
        // name — Expected keeps it out of telemetry (issue #599).
        return Err(CommandError::expected(format!(
            "A project named \"{new_name}\" already exists."
        )));
    }

    // Robust rename: retry transient Windows file locks (antivirus, Search
    // indexer, a just-suspended session's children still winding down) with
    // the same backoff schedule delete_project uses — a single unretried
    // rename surfaced "os error 32" straight to the user (issues #253/#559).
    // spawn_blocking keeps the retry sleeps off the async runtime.
    {
        let src = project_path.to_path_buf();
        let dst = new_path.clone();
        tokio::task::spawn_blocking(move || rename_robust(&src, &dst))
            .await
            .map_err(|e| format!("Project rename task failed: {e}"))?
            .map_err(|e| format!("Failed to rename project: {e}"))?;
    }

    let new_path_str = new_path.to_string_lossy().to_string();

    // Rekey path-keyed stores. Best-effort: the rename already succeeded, so a
    // store hiccup must not surface as a hard failure — log and continue.
    if let Err(e) = pins::rename_pinned_path(&old_path, &new_path_str) {
        tracing::warn!(error = %e, "Failed to rekey pins after project rename");
    }
    if let Err(e) = crate::commands::folders::rename_project_path(&old_path, &new_path_str) {
        tracing::warn!(error = %e, "Failed to rekey folder membership after project rename");
    }
    crate::state::rename_session_path(&old_path, &new_path_str);

    tracing::info!("Renamed project: {} -> {}", old_path, new_path_str);
    Ok(new_path_str)
}

// ============ Move projects between roots ============

/// Projects in a source root bucketed by how they'd move into a destination root.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovableProjects {
    /// Projects that can be moved cleanly.
    pub movable: Vec<String>,
    /// Projects whose name already exists in the destination.
    pub collisions: Vec<String>,
    /// Projects currently open in a window or running a hot session.
    pub open: Vec<String>,
}

/// One project skipped during a move, with a human-readable reason.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedProject {
    pub name: String,
    pub reason: String,
}

/// Outcome of moving projects between roots.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub moved: Vec<String>,
    pub skipped: Vec<SkippedProject>,
}

/// Whether a project path is open in a window or has an active hot session.
fn is_project_open(path: &str) -> bool {
    if crate::state::get_window_for_project(path).is_some() {
        return true;
    }
    matches!(
        crate::state::get_session(path),
        Some(s) if s.status == crate::state::SessionStatus::Active
    )
}

/// Recursively copy a directory tree (cross-volume fallback for [`move_dir`]).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&from)?;
                std::os::unix::fs::symlink(target, &to)?;
            }
            #[cfg(not(unix))]
            {
                std::fs::copy(&from, &to)?;
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a directory, falling back to copy+delete when `rename` can't cross volumes.
fn move_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(src, dst).map_err(|e| format!("copy failed: {e}"))?;
    std::fs::remove_dir_all(src).map_err(|e| format!("cleanup after copy failed: {e}"))?;
    Ok(())
}

/// Bucket immediate project subfolders of `from` by movable / collision / open.
/// Hidden dirs (e.g. the `.shipstudio` app-config dir, which stays at the default
/// root regardless of where projects live) are skipped.
fn scan_movable(
    from: &std::path::Path,
    to: &std::path::Path,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut movable = Vec::new();
    let mut collisions = Vec::new();
    let mut open = Vec::new();
    let Ok(entries) = std::fs::read_dir(from) else {
        return (movable, collisions, open);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !is_valid_project(&path) {
            continue;
        }
        let src_str = path.to_string_lossy().to_string();
        if is_project_open(&src_str) {
            open.push(name);
        } else if to.join(&name).exists() {
            collisions.push(name);
        } else {
            movable.push(name);
        }
    }
    movable.sort();
    collisions.sort();
    open.sort();
    (movable, collisions, open)
}

/// Preview which projects in `from` can be moved into `to` (drives the move prompt).
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn list_movable_projects(
    from: String,
    to: String,
) -> Result<MovableProjects, CommandError> {
    let from_dir = std::path::Path::new(&from);
    let to_dir = std::path::Path::new(&to);
    // Same folder (or missing source) → nothing to move.
    if !from_dir.is_dir() || dunce::canonicalize(from_dir).ok() == dunce::canonicalize(to_dir).ok()
    {
        return Ok(MovableProjects {
            movable: vec![],
            collisions: vec![],
            open: vec![],
        });
    }
    let (movable, collisions, open) = scan_movable(from_dir, to_dir);
    Ok(MovableProjects {
        movable,
        collisions,
        open,
    })
}

/// Move project folders from one projects root into another.
///
/// Skips projects that are currently open or whose name collides in the
/// destination. For each moved project, rekeys pins, folder membership, and
/// session state so the dashboard stays consistent. Returns a per-project report.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn move_projects_to_root(from: String, to: String) -> Result<MoveReport, CommandError> {
    let from_dir = std::path::Path::new(&from);
    let to_dir = std::path::Path::new(&to);

    if !from_dir.is_dir() {
        return Err((format!("Source folder doesn't exist: {from}")).into());
    }
    if !to_dir.is_dir() {
        return Err((format!("Destination folder doesn't exist: {to}")).into());
    }
    if dunce::canonicalize(from_dir).ok() == dunce::canonicalize(to_dir).ok() {
        return Ok(MoveReport {
            moved: vec![],
            skipped: vec![],
        });
    }

    let mut moved = Vec::new();
    let mut skipped = Vec::new();

    let entries = std::fs::read_dir(from_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let src = entry.path();
        if !is_valid_project(&src) {
            continue;
        }
        let src_str = src.to_string_lossy().to_string();
        if is_project_open(&src_str) {
            skipped.push(SkippedProject {
                name,
                reason: "currently open — close it first".into(),
            });
            continue;
        }
        let dst = to_dir.join(&name);
        if dst.exists() {
            skipped.push(SkippedProject {
                name,
                reason: "a folder with the same name already exists in the destination".into(),
            });
            continue;
        }
        match move_dir(&src, &dst) {
            Ok(()) => {
                let dst_str = dst.to_string_lossy().to_string();
                // Rekey path-keyed stores (best-effort; the move already succeeded).
                if let Err(e) = pins::rename_pinned_path(&src_str, &dst_str) {
                    tracing::warn!(error = %e, "Failed to rekey pins after project move");
                }
                if let Err(e) = crate::commands::folders::rename_project_path(&src_str, &dst_str) {
                    tracing::warn!(error = %e, "Failed to rekey folder membership after project move");
                }
                crate::state::rename_session_path(&src_str, &dst_str);
                moved.push(name);
            }
            Err(e) => skipped.push(SkippedProject { name, reason: e }),
        }
    }

    tracing::info!("Moved {} project(s) from {} to {}", moved.len(), from, to);
    Ok(MoveReport { moved, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{LazyLock, Mutex};

    static REMOVED_PROJECTS_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    struct RemovedProjectsConfigOverride {
        _tmp: tempfile::TempDir,
    }

    impl RemovedProjectsConfigOverride {
        fn install() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("removed-projects.json");
            *REMOVED_PROJECTS_CONFIG_PATH_OVERRIDE
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(path);
            Self { _tmp: tmp }
        }
    }

    impl Drop for RemovedProjectsConfigOverride {
        fn drop(&mut self) {
            *REMOVED_PROJECTS_CONFIG_PATH_OVERRIDE
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// Issue #251: the manual "Select Project Folder" picker must accept the
    /// same language-ecosystem projects the automatic registration path does.
    #[test]
    fn is_valid_project_accepts_ecosystem_manifests() {
        for marker in ["Cargo.toml", "go.mod", "pyproject.toml", "Gemfile"] {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(tmp.path().join(marker), "").unwrap();
            assert!(
                is_valid_project(tmp.path()),
                "{marker} alone should mark a valid project"
            );
        }
        let empty = tempfile::tempdir().unwrap();
        assert!(!is_valid_project(empty.path()));
    }

    #[test]
    fn validate_project_name_accepts_normal_names() {
        assert_eq!(validate_project_name("my-app").unwrap(), "my-app");
        assert_eq!(validate_project_name("My App 2").unwrap(), "My App 2");
        // Surrounding whitespace is trimmed.
        assert_eq!(validate_project_name("  spaced  ").unwrap(), "spaced");
    }

    #[test]
    fn validate_project_name_rejects_invalid_names() {
        assert!(validate_project_name("").is_err());
        assert!(validate_project_name("   ").is_err());
        assert!(validate_project_name("a/b").is_err());
        assert!(validate_project_name("a\\b").is_err());
        assert!(validate_project_name(".").is_err());
        assert!(validate_project_name("..").is_err());
        assert!(validate_project_name(".hidden").is_err());
        assert!(validate_project_name(&"x".repeat(256)).is_err());
    }

    /// Create a minimal valid project directory (a `.gitignore` makes
    /// `is_valid_project` return true).
    fn make_project(root: &std::path::Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), ".shipstudio/\n").unwrap();
    }

    #[test]
    fn scan_movable_buckets_clean_collision_and_skips_hidden() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();

        make_project(from.path(), "alpha"); // movable
        make_project(from.path(), "beta"); // collides below
        make_project(to.path(), "beta"); // destination already has beta

        // A hidden config dir and a non-project dir must be ignored.
        std::fs::create_dir_all(from.path().join(".shipstudio")).unwrap();
        std::fs::create_dir_all(from.path().join("not-a-project")).unwrap();

        let (movable, collisions, open) = scan_movable(from.path(), to.path());

        assert_eq!(movable, vec!["alpha".to_string()]);
        assert_eq!(collisions, vec!["beta".to_string()]);
        assert!(open.is_empty());
    }

    #[test]
    fn move_dir_relocates_a_directory_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("nested").join("file.txt"), "hello").unwrap();

        move_dir(&src, &dst).unwrap();

        assert!(!src.exists());
        assert_eq!(
            std::fs::read_to_string(dst.join("nested").join("file.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn removed_projects_registry_marks_and_restores_path_without_deleting_files() {
        let _guard = REMOVED_PROJECTS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _override = RemovedProjectsConfigOverride::install();
        let tmp = tempfile::tempdir().unwrap();
        make_project(tmp.path(), "alpha");
        let project = dunce::canonicalize(tmp.path().join("alpha")).unwrap();

        mark_project_removed(&project).unwrap();

        let config = load_removed_projects_config().unwrap();
        assert!(config.contains_path(&project));
        assert!(project.exists());

        assert!(restore_removed_project(&project).unwrap());

        let config = load_removed_projects_config().unwrap();
        assert!(!config.contains_path(&project));
        assert!(project.exists());
    }

    #[test]
    fn removed_projects_registry_is_idempotent() {
        let _guard = REMOVED_PROJECTS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _override = RemovedProjectsConfigOverride::install();
        let tmp = tempfile::tempdir().unwrap();
        make_project(tmp.path(), "alpha");
        let project = dunce::canonicalize(tmp.path().join("alpha")).unwrap();

        mark_project_removed(&project).unwrap();
        mark_project_removed(&project).unwrap();

        let config = load_removed_projects_config().unwrap();
        assert_eq!(config.projects.len(), 1);
    }

    #[tokio::test]
    async fn scan_command_times_out_and_degrades_to_none() {
        // A "git" that hangs: the scan must give up after the timeout and
        // yield None instead of blocking (issue #168).
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("hung-git.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let started = std::time::Instant::now();
        let output = run_scan_command(script.to_str().unwrap(), &[], tmp.path(), 1).await;

        assert!(output.is_none(), "hung command must degrade to None");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "timeout must bound the call well below the script's sleep"
        );
    }

    #[tokio::test]
    async fn git_scan_helpers_degrade_to_none_outside_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(branch_from_head_file(tmp.path()), None);
        assert_eq!(get_uncommitted_count(tmp.path()).await, None);
    }

    #[tokio::test]
    async fn scan_uncommitted_counts_returns_one_entry_per_path_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        make_project(tmp.path(), "alpha");
        make_project(tmp.path(), "beta");
        let paths = vec![tmp.path().join("alpha"), tmp.path().join("beta")];

        let counts = scan_uncommitted_counts(paths, git_scan_budget()).await;

        // Neither project is a git repo — both must degrade gracefully
        // rather than erroring or being dropped.
        assert_eq!(counts.len(), 2);
        assert!(counts.iter().all(|count| count.is_none()));
    }

    #[test]
    fn branch_from_head_file_reads_a_normal_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let git_dir = tmp.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/foo-bar\n").unwrap();
        assert_eq!(
            branch_from_head_file(tmp.path()),
            Some("feature/foo-bar".to_string())
        );
    }

    #[test]
    fn branch_from_head_file_is_none_for_detached_head_and_non_repos() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(branch_from_head_file(tmp.path()), None);
        let git_dir = tmp.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(
            git_dir.join("HEAD"),
            "1234567890abcdef1234567890abcdef12345678\n",
        )
        .unwrap();
        assert_eq!(branch_from_head_file(tmp.path()), None);
    }

    #[test]
    fn branch_from_head_file_follows_a_worktree_gitdir_pointer() {
        // Linked worktrees and submodules have a `.git` FILE pointing at the
        // real git directory.
        let tmp = tempfile::tempdir().unwrap();
        let real_git = tmp.path().join("repo-git");
        std::fs::create_dir(&real_git).unwrap();
        std::fs::write(real_git.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();
        let wt = tmp.path().join("worktree");
        std::fs::create_dir(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../repo-git\n").unwrap();
        assert_eq!(branch_from_head_file(&wt), Some("wt-branch".to_string()));
    }

    #[test]
    fn removed_projects_registry_reports_invalid_json() {
        let _guard = REMOVED_PROJECTS_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _override = RemovedProjectsConfigOverride::install();
        let path = removed_projects_config_path().unwrap();
        std::fs::write(&path, "{not valid json").unwrap();

        let err = load_removed_projects_config().expect_err("invalid registry should fail closed");

        assert!(err.contains("Failed to parse removed projects config"));
    }

    #[test]
    fn rename_robust_renames_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("old-name");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("file.txt"), "hi").unwrap();
        let dst = tmp.path().join("new-name");

        rename_robust(&src, &dst).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(dst.join("file.txt")).unwrap(), "hi");
    }

    #[test]
    fn rename_robust_surfaces_non_retryable_errors_immediately() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let dst = tmp.path().join("dst");
        let err = rename_robust(&missing, &dst).unwrap_err();
        // NotFound is not a lock — must not burn ~8s of retries.
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    // Tests for `is_retryable_delete_error` / `remove_dir_all_robust` /
    // `remove_file_robust` moved to `crate::utils` alongside the extracted
    // helpers (issue #696).

    /// Issue #877: a project folder that's already gone from disk (deleted,
    /// renamed, or moved outside Harbr) must classify as `Expected`
    /// with plain-English guidance, not a raw IO error built from the
    /// `dunce::canonicalize` failure text.
    #[tokio::test]
    async fn delete_project_on_a_vanished_folder_is_expected() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("never-existed");

        let err = delete_project(gone.to_string_lossy().to_string())
            .await
            .expect_err("a missing folder must fail");

        assert!(
            matches!(err, CommandError::Expected { .. }),
            "expected CommandError::Expected, got {err:?}"
        );
        let message = err.to_string();
        assert!(
            message.contains("no longer exists"),
            "message should explain the folder is gone, got: {message}"
        );
        assert!(
            !message.contains("os error"),
            "message should not leak the raw OS error, got: {message}"
        );
    }
}

/// Tests and the timing harness for the dashboard scan.
///
/// The scan's defect was never visible on an idle machine: blocking `std::fs`
/// work executed directly on tokio worker threads only starves the runtime
/// once the workers are contended. So the harness measures two things, not
/// one — wall time *and* how late an unrelated 10ms heartbeat task runs while
/// the scan is in flight. The second number is the actual bug.
///
/// Measured on an M-series Mac, release build, 164 synthetic projects each a
/// real git repository, load average 8–13, before and after run back to back
/// four times from two prebuilt test binaries:
///
/// | | before | after |
/// | --- | --- | --- |
/// | filesystem pass, one scan | 7.9–10.3 ms | 17.6–18.0 ms |
/// | git pass, one scan | 668–684 ms | 362–394 ms |
/// | one scan, total | 677–692 ms | 380–412 ms |
/// | three concurrent scans, wall | 2.055–2.070 s | 0.956–1.106 s |
/// | worst 10ms-heartbeat lateness | 159–196 ms | 50–91 ms |
/// | three concurrent, through the coalescer | — | 0.379–0.381 s |
///
/// The filesystem pass got *slower* on purpose: reading `.git/HEAD` moved into
/// it from the forked git pass, which is what removed 164 `git rev-parse`
/// processes per scan.
///
/// What these numbers do not reproduce is the reported magnitude — 39.7s at
/// load average 10, 2238s at load average 23. This machine's SSD answers an
/// `open()` in microseconds, so 164 projects is ~10ms of filesystem work here
/// no matter how the runtime is arranged. What is reproduced is the mechanism
/// and its shape: blocking work on the workers makes every other task in the
/// app wait for it, and the same three concurrent calls used to do the same
/// scan three times.
#[cfg(test)]
mod scan_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // ---------- synthetic tree ----------

    /// Build `n` project directories that look like the real thing: a
    /// package.json, a `.shipstudio/project.json` with a `last_opened`, a
    /// `.gitignore` that already ignores `.shipstudio/` (the steady state on a
    /// real machine), and a real, clean git repository.
    fn synthetic_root(n: usize) -> (tempfile::TempDir, tempfile::TempDir) {
        let scratch = tempfile::tempdir().expect("tempdir");
        let tmp = tempfile::tempdir().expect("tempdir");
        // The template lives outside the scanned root — it is itself a valid
        // project directory, and one extra row would quietly make every "164"
        // in a report a lie.
        let template = make_template_repo(scratch.path());
        for i in 0..n {
            let dir = tmp.path().join(format!("project-{i:04}"));
            make_synthetic_project(&dir, Some(1_700_000_000_000 + i as u64), Some(&template));
        }
        (tmp, scratch)
    }

    /// One synthetic project directory. `last_opened` of `None` writes no
    /// metadata file at all (the never-opened case). `template` is a `.git`
    /// directory to clone by copy — forking `git init` + `git commit` a few
    /// hundred times makes the harness setup slower than the thing it
    /// measures, and a copied `.git` behaves identically for both the
    /// `.git/HEAD` read and `git status`.
    fn make_synthetic_project(dir: &Path, last_opened: Option<u64>, template: Option<&Path>) {
        std::fs::create_dir_all(dir).expect("project dir");
        std::fs::write(dir.join("package.json"), TEMPLATE_PACKAGE_JSON).expect("package.json");
        std::fs::write(dir.join(".gitignore"), TEMPLATE_GITIGNORE).expect("gitignore");
        if let Some(ts) = last_opened {
            let meta = dir.join(".shipstudio");
            std::fs::create_dir_all(&meta).expect("meta dir");
            std::fs::write(
                meta.join("project.json"),
                format!(
                    r#"{{"_description":"Harbr project","schema_version":4,"last_opened":{ts}}}"#
                ),
            )
            .expect("project.json");
        }
        match template {
            Some(git) => copy_dir(git, &dir.join(".git")),
            None => make_git_repo_here(dir),
        }
    }

    const TEMPLATE_PACKAGE_JSON: &str = r#"{"name":"synthetic","version":"1.0.0"}"#;
    const TEMPLATE_GITIGNORE: &str = "node_modules\n.shipstudio/\n";

    /// A real repository with one commit, whose `.git` is copied into every
    /// synthetic project. Returns the path of that `.git` directory.
    fn make_template_repo(under: &Path) -> PathBuf {
        let dir = under.join(".template");
        std::fs::create_dir_all(&dir).expect("template dir");
        std::fs::write(dir.join("package.json"), TEMPLATE_PACKAGE_JSON).expect("package.json");
        std::fs::write(dir.join(".gitignore"), TEMPLATE_GITIGNORE).expect("gitignore");
        make_git_repo_here(&dir);
        dir.join(".git")
    }

    /// `git init` + one commit, in `dir`. Panics loudly rather than silently
    /// producing a repo-less directory, which would make the harness measure
    /// something other than what it claims to.
    fn make_git_repo_here(dir: &Path) {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "harness@example.invalid"]);
        run(&["config", "user.name", "Harness"]);
        run(&["config", "commit.gpgsign", "false"]);
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "initial"]);
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).expect("copy dest");
        for entry in std::fs::read_dir(from).expect("read_dir").flatten() {
            let src = entry.path();
            let dst = to.join(entry.file_name());
            if src.is_dir() {
                copy_dir(&src, &dst);
            } else {
                std::fs::copy(&src, &dst).expect("copy file");
            }
        }
    }

    /// Scan inputs with nothing hidden and no external projects, so a test
    /// scan never depends on the developer's own app state.
    fn empty_inputs() -> DashboardScanInputs {
        DashboardScanInputs {
            active_account_id: crate::commands::accounts::DEFAULT_ACCOUNT_ID.to_string(),
            accounts: Vec::new(),
            removed_projects: RemovedProjectsConfig::default(),
            external_paths: Vec::new(),
        }
    }

    // ---------- exclusion-warning capture ----------

    /// Records every `warn_project_excluded` event as `(path, reason)` so a
    /// test can assert the scan still reports exactly the same exclusions.
    #[derive(Clone, Default)]
    struct ExclusionCapture {
        events: Arc<Mutex<Vec<(String, String)>>>,
    }

    #[derive(Default)]
    struct FieldGrab {
        path: Option<String>,
        reason: Option<String>,
        message: Option<String>,
    }

    impl tracing::field::Visit for FieldGrab {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            match field.name() {
                "path" => self.path = Some(value.to_string()),
                "reason" => self.reason = Some(value.to_string()),
                "message" => self.message = Some(value.to_string()),
                _ => {}
            }
        }
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            let rendered = format!("{value:?}");
            let rendered = rendered.trim_matches('"').to_string();
            match field.name() {
                "path" => self.path = Some(rendered),
                "reason" => self.reason = Some(rendered),
                "message" => self.message = Some(rendered),
                _ => {}
            }
        }
    }

    impl<S> tracing_subscriber::Layer<S> for ExclusionCapture
    where
        S: tracing::Subscriber,
    {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut grab = FieldGrab::default();
            event.record(&mut grab);
            if grab.message.as_deref() == Some("project directory excluded from dashboard list") {
                if let (Some(path), Some(reason)) = (grab.path, grab.reason) {
                    self.events
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((path, reason));
                }
            }
        }
    }

    /// Run `f` with exclusion warnings captured, returning them in order.
    ///
    /// `tracing::subscriber::with_default` is thread-local, so `f` must do its
    /// logging on *this* thread — which is why the exclusion test calls the
    /// synchronous collection pass directly rather than the async scan that
    /// hands that pass to the blocking pool. Every exclusion warning the
    /// dashboard emits comes from that pass, so nothing is lost, but a future
    /// exclusion added elsewhere would not be seen here.
    fn capture_exclusions<T>(f: impl FnOnce() -> T) -> (T, Vec<(String, String)>) {
        use tracing_subscriber::layer::SubscriberExt;
        let capture = ExclusionCapture::default();
        let subscriber = tracing_subscriber::registry().with(capture.clone());
        let out = tracing::subscriber::with_default(subscriber, f);
        let events = capture
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        (out, events)
    }

    fn block_on<F: std::future::Future>(workers: usize, fut: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(workers)
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(fut)
    }

    // ---------- behaviour pinning ----------

    #[test]
    fn scan_lists_every_project_in_last_opened_order_with_git_metadata() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        // Two opened projects (newest first) and one never opened (last).
        make_synthetic_project(&root.join("older"), Some(1_000), None);
        make_synthetic_project(&root.join("newer"), Some(2_000), None);
        make_synthetic_project(&root.join("never"), None, None);

        let projects = block_on(2, async {
            scan_dashboard_projects_in(root.to_path_buf(), empty_inputs())
                .await
                .expect("scan")
        });

        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["newer", "older", "never"]);
        // Every field the dashboard renders comes back populated.
        assert!(projects.iter().all(|p| !p.is_external));
        assert!(projects.iter().all(|p| p.thumbnail.is_none()));
        assert_eq!(
            projects
                .iter()
                .map(|p| p.git_branch.clone())
                .collect::<Vec<_>>(),
            vec![
                Some("main".to_string()),
                Some("main".to_string()),
                Some("main".to_string())
            ],
        );
        assert_eq!(projects[0].last_opened, Some(2_000));
        assert_eq!(projects[2].last_opened, None);
    }

    #[test]
    fn scan_reports_the_same_exclusions_it_always_did() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        make_synthetic_project(&root.join("kept"), Some(1), None);
        make_synthetic_project(&root.join("hidden"), Some(2), None);
        // A directory with no project markers at all.
        std::fs::create_dir_all(root.join("not-a-project")).expect("dir");
        // Hidden directories are skipped silently, as before.
        std::fs::create_dir_all(root.join(".cache")).expect("dir");

        let mut inputs = empty_inputs();
        inputs.removed_projects.projects.push(RemovedProject {
            path: root.join("hidden").to_string_lossy().to_string(),
            removed_at: 0,
        });
        // A registered external project that no longer exists on disk.
        let gone = root.join("gone-external");
        inputs.external_paths.push(gone.clone());

        let ((projects, _paths), exclusions) =
            capture_exclusions(|| collect_dashboard_projects(root, &inputs).expect("collect"));

        assert_eq!(
            projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["kept"]
        );

        let mut got: Vec<(String, String)> = exclusions;
        got.sort();
        let mut want = vec![
            (
                root.join("hidden").display().to_string(),
                "listed in removed-projects.json registry".to_string(),
            ),
            (
                root.join("not-a-project").display().to_string(),
                "not recognized as a project (no project markers)".to_string(),
            ),
            (
                gone.display().to_string(),
                "registered external project is missing or not recognized as a project".to_string(),
            ),
        ];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn scan_of_a_missing_root_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("nope");
        let projects = block_on(2, async {
            scan_dashboard_projects_in(missing.clone(), empty_inputs())
                .await
                .expect("scan")
        });
        assert!(projects.is_empty());
    }

    // ---------- coalescing ----------

    /// Three simultaneous scans must cost one scan. Counting the runs is the
    /// claim; timing them would only be a proxy for it.
    #[test]
    fn concurrent_calls_run_the_work_once() {
        let slot: tokio::sync::Mutex<Option<Coalesced<u32>>> = tokio::sync::Mutex::const_new(None);
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let results: Vec<u32> = block_on(3, async {
            let mut handles = Vec::new();
            let arrived = Instant::now();
            for _ in 0..3 {
                let runs = runs.clone();
                let slot = &slot;
                handles.push(async move {
                    coalesce::<u32, (), _, _>(slot, arrived, || async {
                        runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Ok(7)
                    })
                    .await
                    .expect("coalesced")
                });
            }
            futures_util::future::join_all(handles).await
        });

        assert_eq!(results, vec![7, 7, 7]);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// A call that arrives *after* the previous run finished must not be given
    /// that run's answer — otherwise deleting a project would leave it on the
    /// dashboard, which is the failure mode a plain TTL cache would have.
    #[test]
    fn a_later_call_rescans_rather_than_reusing_the_last_answer() {
        let slot: tokio::sync::Mutex<Option<Coalesced<usize>>> =
            tokio::sync::Mutex::const_new(None);
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let (first, second) = block_on(2, async {
            let run = || {
                let runs = runs.clone();
                async move { Ok::<_, ()>(runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst)) }
            };
            let first = coalesce(&slot, Instant::now(), run).await.expect("first");
            // Distinct arrival instants: `Instant` on macOS has nanosecond
            // resolution, but sleep a beat so the ordering is unambiguous.
            tokio::time::sleep(Duration::from_millis(5)).await;
            let second = coalesce(&slot, Instant::now(), run).await.expect("second");
            (first, second)
        });

        assert_eq!((first, second), (0, 1));
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    // ---------- git pass budget ----------

    /// The per-project timeout alone bounds the pass at
    /// `projects / concurrency * per-project timeout`. The whole-pass budget is
    /// what keeps a few hundred wedged repos from holding the dashboard for
    /// half a minute; projects it does not reach degrade to "no git status",
    /// exactly like a project that timed out on its own.
    #[test]
    fn an_exhausted_budget_degrades_every_project_instead_of_waiting() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        make_synthetic_project(&root.join("a"), Some(1), None);
        make_synthetic_project(&root.join("b"), Some(2), None);
        let paths = vec![root.join("a"), root.join("b")];

        let (with_budget, without) = block_on(2, async {
            // Zero budget first: `get_uncommitted_count` caches its result, and
            // a cached value resolves on the first poll — which a timeout that
            // has already elapsed still lets through. Cold first, so the
            // assertion below is about the budget and not about the cache.
            let without = scan_uncommitted_counts(paths.clone(), Duration::ZERO).await;
            let with_budget = scan_uncommitted_counts(paths.clone(), git_scan_budget()).await;
            (with_budget, without)
        });

        // Clean repos: the real scan finds zero changes. If this said `None`
        // the test below would pass vacuously.
        assert_eq!(with_budget, vec![Some(0), Some(0)]);
        assert_eq!(without, vec![None, None]);
    }

    // ---------- timing harness ----------

    /// How many projects the harness builds by default — the size of the
    /// reporter's real `~/ShipStudio`. Override with `SCAN_HARNESS_N`.
    const HARNESS_PROJECT_COUNT: usize = 164;
    /// Worker threads for the harness runtime, and the number of simultaneous
    /// dashboard calls. Three of each reproduces the reported failure exactly:
    /// three concurrent `get_dashboard_projects` calls with three tokio worker
    /// threads blocked in `std::fs::read_to_string`, leaving nothing to run
    /// the rest of the app.
    const HARNESS_WORKERS: usize = 3;
    const HARNESS_CONCURRENT_CALLS: usize = 3;

    /// Ticks every 10ms and records the worst lateness. This is the number the
    /// defect is actually about: a scan that blocks the tokio workers shows up
    /// here as a long gap, and every other task in the app is stalled for
    /// exactly that long. Wall time alone would not show it.
    async fn heartbeat(stop: Arc<std::sync::atomic::AtomicBool>) -> Duration {
        let mut worst = Duration::ZERO;
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let at = Instant::now();
            tokio::time::sleep(Duration::from_millis(10)).await;
            let late = at.elapsed().saturating_sub(Duration::from_millis(10));
            if late > worst {
                worst = late;
            }
        }
        worst
    }

    fn loadavg() -> String {
        std::process::Command::new("uptime")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }

    fn harness_n() -> usize {
        std::env::var("SCAN_HARNESS_N")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(HARNESS_PROJECT_COUNT)
    }

    /// ```text
    /// cargo test --release --lib dashboard_scan_timing -- --ignored --nocapture
    /// SCAN_HARNESS_N=2000 cargo test --release --lib dashboard_scan_timing -- --ignored --nocapture
    /// ```
    ///
    /// Builds a synthetic tree of N real git projects and issues
    /// [`HARNESS_CONCURRENT_CALLS`] simultaneous dashboard scans on a
    /// [`HARNESS_WORKERS`]-worker runtime, with a 10ms heartbeat task running
    /// alongside. Reports the load average, because none of these numbers mean
    /// anything without it.
    #[test]
    #[ignore = "timing harness — run explicitly with --ignored --nocapture"]
    fn dashboard_scan_timing() {
        let n = harness_n();
        let before_load = loadavg();
        let (tmp, _scratch) = synthetic_root(n);
        let root = tmp.path().to_path_buf();

        let (burst, worst_late, counts) = block_on(HARNESS_WORKERS, async {
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hb = tokio::spawn(heartbeat(stop.clone()));
            // Let the heartbeat establish a baseline before the burst.
            tokio::time::sleep(Duration::from_millis(100)).await;

            let t0 = Instant::now();
            let mut handles = Vec::new();
            for _ in 0..HARNESS_CONCURRENT_CALLS {
                let root = root.clone();
                handles.push(tokio::spawn(async move {
                    scan_dashboard_projects_in(root.clone(), empty_inputs())
                        .await
                        .expect("scan")
                        .len()
                }));
            }
            let mut counts = Vec::new();
            for h in handles {
                counts.push(h.await.expect("join"));
            }
            let burst = t0.elapsed();

            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            let worst = hb.await.expect("heartbeat");
            (burst, worst, counts)
        });

        // A harness that silently scanned an empty tree would report a
        // wonderful number about nothing.
        assert!(
            counts.iter().all(|c| *c == n),
            "expected {n}, got {counts:?}"
        );

        // Same burst again, this time through the coalescer the command wraps
        // the scan in. It runs against a *second, untouched* tree: the first
        // burst leaves `GIT_CACHE` warm for its own paths, and reusing them
        // would credit the coalescer with the cache's work.
        let (tmp2, _scratch2) = synthetic_root(n);
        let root = tmp2.path().to_path_buf();
        let coalesced_burst = block_on(HARNESS_WORKERS, async {
            let slot: tokio::sync::Mutex<Option<Coalesced<usize>>> =
                tokio::sync::Mutex::const_new(None);
            let slot = &slot;
            let t0 = Instant::now();
            let arrived = Instant::now();
            let mut futs = Vec::new();
            for _ in 0..HARNESS_CONCURRENT_CALLS {
                let root = root.clone();
                futs.push(async move {
                    coalesce::<usize, CommandError, _, _>(slot, arrived, || async {
                        Ok(scan_dashboard_projects_in(root, empty_inputs())
                            .await?
                            .len())
                    })
                    .await
                    .expect("coalesced scan")
                });
            }
            let got = futures_util::future::join_all(futs).await;
            assert!(got.iter().all(|c| *c == n), "expected {n}, got {got:?}");
            t0.elapsed()
        });

        println!("\n=== dashboard scan timing harness ===");
        println!("projects              : {n}");
        println!("concurrent calls      : {HARNESS_CONCURRENT_CALLS}");
        println!("tokio worker threads  : {HARNESS_WORKERS}");
        println!("load before           : {before_load}");
        println!("load after            : {}", loadavg());
        println!("burst wall time       : {burst:?}   <- what the user waits");
        println!("worst heartbeat late  : {worst_late:?}   <- runtime starvation");
        println!("burst, coalesced      : {coalesced_burst:?}");
        println!("=====================================\n");
    }

    /// ```text
    /// cargo test --release --lib dashboard_scan_phases -- --ignored --nocapture
    /// ```
    ///
    /// Splits one scan into its two passes so the timing harness's numbers can
    /// be attributed: the synchronous filesystem collection, and the git pass
    /// that forks per project.
    #[test]
    #[ignore = "timing harness — run explicitly with --ignored --nocapture"]
    fn dashboard_scan_phases() {
        let n = harness_n();
        let (tmp, _scratch) = synthetic_root(n);
        let root = tmp.path().to_path_buf();

        let (fs_pass, git_pass, total, count) = block_on(HARNESS_WORKERS, async {
            let inputs = empty_inputs();
            let t0 = Instant::now();
            let (mut projects, paths) =
                collect_dashboard_projects(&root, &inputs).expect("collect");
            let fs_pass = t0.elapsed();

            let t1 = Instant::now();
            let git = scan_uncommitted_counts(paths, git_scan_budget()).await;
            let git_pass = t1.elapsed();
            for (p, c) in projects.iter_mut().zip(git) {
                p.uncommitted_count = c;
            }
            let count = projects.len();
            // Assert on what the pass produced, not merely that it ran.
            assert!(
                projects
                    .iter()
                    .all(|p| p.git_branch.as_deref() == Some("main")),
                "git pass produced no branches — the harness would be timing nothing"
            );
            (fs_pass, git_pass, t0.elapsed(), count)
        });

        assert_eq!(count, n);
        println!("\n=== dashboard scan phase split ===");
        println!("projects   : {n}");
        println!("load       : {}", loadavg());
        println!("fs pass    : {fs_pass:?}");
        println!("git pass   : {git_pass:?}");
        println!("total      : {total:?}");
        println!("==================================\n");
    }
}
