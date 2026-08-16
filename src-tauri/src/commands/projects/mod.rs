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
use crate::utils::{create_command, validate_project_path};
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

/// Helper to get git branch for a project (time-bounded; `None` on timeout).
async fn get_git_branch(project_path: &Path) -> Option<String> {
    let output = run_scan_command(
        "git",
        &["rev-parse", "--abbrev-ref", "HEAD"],
        project_path,
        GIT_SCAN_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" || branch.is_empty() {
        return None;
    }

    Some(branch)
}

/// Helper to count uncommitted changes (tracked files only; time-bounded,
/// `None` on timeout).
async fn get_uncommitted_count(project_path: &Path) -> Option<u32> {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return None;
    }

    // Use -uno to ignore untracked files like .DS_Store
    let output = run_scan_command(
        "git",
        &["status", "--porcelain", "-uno"],
        project_path,
        GIT_SCAN_TIMEOUT_SECS,
    )
    .await?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let count = stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        return Some(count);
    }
    None
}

/// Collects git metadata (current branch + uncommitted count) for many
/// projects concurrently. Each git call is bounded by
/// [`GIT_SCAN_TIMEOUT_SECS`]; a slow or hung repo degrades to `(None, None)`
/// instead of blocking the whole dashboard. Results are returned in input
/// order.
async fn scan_git_info(paths: Vec<PathBuf>) -> Vec<(Option<String>, Option<u32>)> {
    stream::iter(paths)
        .map(
            |path| async move { tokio::join!(get_git_branch(&path), get_uncommitted_count(&path)) },
        )
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

/// Sync helper for ensuring .shipstudio/ is in gitignore
fn ensure_gitignore_has_shipstudio_sync(project: &std::path::Path) -> Result<(), String> {
    let gitignore_path = project.join(".gitignore");
    let entry = ".shipstudio/";

    let content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path).unwrap_or_default()
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

    std::fs::write(&gitignore_path, new_content).ok();
    Ok(())
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
                "Ship Studio isn't allowed to read your projects folder ({}). Grant access in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then reload the dashboard.",
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

#[tauri::command]
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

/// Returns enhanced project list for dashboard with git info
#[tauri::command]
#[tracing::instrument]
pub async fn get_dashboard_projects() -> Result<Vec<DashboardProject>, CommandError> {
    let shipstudio_dir = crate::utils::projects_root()?;
    // Account resolution must never break the dashboard: degrade to "no active
    // account" (everything visible) on failure rather than erroring the whole list.
    let active_account_id = crate::commands::accounts::get_active_account_id().unwrap_or_default();
    // Live workspace list, read once so the visibility check stays IO-free per project.
    let accounts = crate::commands::setup::read_app_state().accounts;
    let removed_projects = load_removed_projects_config()?;

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    // First pass: cheap filesystem-only collection. Git metadata is filled in
    // afterwards, concurrently and time-bounded, so one slow/hung repo can't
    // stall the whole dashboard (issue #168).
    let mut projects = Vec::new();
    let mut scan_paths: Vec<PathBuf> = Vec::new();
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
            let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
            let hide_main_branch_warning =
                metadata.as_ref().and_then(|m| m.hide_main_branch_warning);
            let workspace_subpath = metadata.as_ref().and_then(|m| m.workspace_subpath.clone());

            // Ensure .shipstudio/ is gitignored
            let _ = ensure_gitignore_has_shipstudio_sync(&path);

            projects.push(DashboardProject {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                thumbnail,
                last_opened,
                // Filled in by the concurrent git scan below.
                git_branch: None,
                uncommitted_count: None,
                auto_accept_mode,
                hide_main_branch_warning,
                is_external: false,
                workspace_subpath,
                worktree_count: count_managed_worktrees(&path),
            });
            scan_paths.push(path);
        } else if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            warn_project_excluded(&path, "not recognized as a project (no project markers)");
        }
    }

    // Append external projects
    if let Ok(ext_config) = crate::commands::external_projects::load_config() {
        for ext in &ext_config.projects {
            let path = std::path::PathBuf::from(&ext.path);
            if path.exists() && is_valid_project(&path) {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "external".to_string());

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
                        .and_then(|contents| {
                            serde_json::from_str::<ProjectMetadata>(&contents).ok()
                        })
                } else {
                    None
                };

                if !project_visible_for_account(metadata.as_ref(), &active_account_id, &accounts) {
                    warn_project_excluded(
                        &path,
                        "external project belongs to a different workspace (account visibility filter)",
                    );
                    continue;
                }

                let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
                let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
                let hide_main_branch_warning =
                    metadata.as_ref().and_then(|m| m.hide_main_branch_warning);
                let workspace_subpath = metadata.as_ref().and_then(|m| m.workspace_subpath.clone());

                // Ensure .shipstudio/ is gitignored
                let _ = ensure_gitignore_has_shipstudio_sync(&path);

                projects.push(DashboardProject {
                    name,
                    path: path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                    // Filled in by the concurrent git scan below.
                    git_branch: None,
                    uncommitted_count: None,
                    auto_accept_mode,
                    hide_main_branch_warning,
                    is_external: true,
                    workspace_subpath,
                    worktree_count: count_managed_worktrees(&path),
                });
                scan_paths.push(path);
            } else {
                warn_project_excluded(
                    &path,
                    "registered external project is missing or not recognized as a project",
                );
            }
        }
    }

    // Second pass: concurrent, time-bounded git scans (one entry per project,
    // in the same order projects were pushed above). A repo that errors or
    // times out simply keeps `git_branch: None` / `uncommitted_count: None`.
    let git_info = scan_git_info(scan_paths).await;
    for (project, (git_branch, uncommitted_count)) in projects.iter_mut().zip(git_info) {
        project.git_branch = git_branch;
        project.uncommitted_count = uncommitted_count;
    }

    projects.sort_by(|a, b| match (a.last_opened, b.last_opened) {
        (Some(a_time), Some(b_time)) => b_time.cmp(&a_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });

    Ok(projects)
}

/// Scans a project's pages/routes directory for page routes.
/// Supports Next.js, SvelteKit, Astro, Nuxt, and static HTML projects.
#[tauri::command]
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
            // Default to Next.js app router
            let app_dir = project.join("app");
            if !app_dir.exists() {
                let src_app_dir = project.join("src").join("app");
                if !src_app_dir.exists() {
                    return Ok(Vec::new());
                }
                let mut pages = detection::scan_nextjs_pages(&src_app_dir, &src_app_dir)?;
                detection::sort_pages(&mut pages);
                pages.dedup_by(|a, b| a.route == b.route);
                return Ok(pages);
            }
            let mut pages = detection::scan_nextjs_pages(&app_dir, &app_dir)?;
            detection::sort_pages(&mut pages);
            // Stripping the [locale] segment can alias routes (e.g. a stray
            // app/page.tsx next to app/[locale]/page.tsx) — list each once.
            pages.dedup_by(|a, b| a.route == b.route);
            Ok(pages)
        }
    }
}

/// Opens a folder in Finder (macOS)
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

fn make_writable_recursive(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;

    // Never follow symlinks. A project can link outside itself — pnpm's
    // node_modules links into the machine-global content-addressable store,
    // whose files are deliberately read-only and shared by every project —
    // and chmod-ing through the link would mutate files the delete below
    // never touches. remove_dir_all removes the link itself, not its target,
    // so the link needs no permission help either.
    if metadata.file_type().is_symlink() {
        return Ok(());
    }

    if metadata.file_type().is_dir() {
        for entry in std::fs::read_dir(path)? {
            make_writable_recursive(&entry?.path())?;
        }
    }

    #[cfg(windows)]
    {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
        }
    }
    #[cfg(unix)]
    {
        // Owner-write only — Permissions::set_readonly(false) would make the
        // file world-writable on Unix (clippy::permissions_set_readonly_false).
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o200 == 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o200))?;
        }
    }
    Ok(())
}

/// Whether a failed `remove_dir_all` is worth retrying after a short wait.
///
/// ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) are Windows'
/// "file open by another process" errors — the transient locks (antivirus,
/// Search indexer, a just-killed PTY's children winding down) this retry
/// exists for. ERROR_ACCESS_DENIED (5) covers in-use executables.
fn is_retryable_delete_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
        || e.kind() == std::io::ErrorKind::PermissionDenied
}

/// Blocking delete with read-only clearing and lock retries. Call from
/// `spawn_blocking` — the chmod walk and retry sleeps can hold a thread for
/// seconds on a large node_modules.
fn remove_dir_all_robust(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    // Fast path first: on a healthy tree remove_dir_all just works, and the
    // chmod walk below stats every file — seconds of pure overhead on a large
    // node_modules if paid unconditionally.
    let first_err = match std::fs::remove_dir_all(path) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    tracing::info!(
        "remove_dir_all failed ({}), retrying with read-only clearing: {}",
        path.display(),
        first_err
    );

    // Clear read-only attributes (Windows refuses to delete read-only files;
    // git objects and some packages ship them). Best-effort: a partial chmod
    // still lets most of the tree go.
    if let Err(e) = make_writable_recursive(path) {
        tracing::warn!(
            "Failed to set write permissions recursively on {}: {}",
            path.display(),
            e
        );
    }

    // Backoff schedule totalling ~8s: field reports show antivirus / Search
    // indexer locks routinely outlasting the previous flat ~1s budget (10 ×
    // 100ms), still surfacing "os error 32" to the user (issue #253). Growing
    // sleeps keep the common quick-release case fast while giving a slow
    // scanner time to let go.
    let mut delay = std::time::Duration::from_millis(100);
    let mut retries = 10;
    loop {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if retries > 0 && is_retryable_delete_error(&e) => {
                retries -= 1;
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(1));
            }
            Err(e) => return Err(e),
        }
    }
}

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
#[tauri::command]
#[tracing::instrument]
pub async fn delete_project(path: String) -> Result<(), CommandError> {
    // Canonicalize FIRST (resolves symlinks and `..`) so the containment check
    // below can't be defeated by a lexical path like `~/ShipStudio/../../.ssh`.
    // `Path::starts_with` is purely lexical and would otherwise pass such a path
    // straight through to `remove_dir_all`.
    let canonical = dunce::canonicalize(&path).map_err(|e| CommandError::Io {
        message: format!("Couldn't resolve project path {path}: {e}"),
    })?;

    // Check if this is an external project. A by-design guard with a
    // user-side path forward, not a malfunction — Expected keeps it out of
    // telemetry (issue #699).
    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        return Err(CommandError::expected(
            "Cannot delete external projects. Use 'Remove from Ship Studio' instead.",
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

/// Removes a project from Ship Studio's dashboard without deleting its files.
///
/// Projects inside a configured projects folder are discovered automatically, so
/// this records the exact project path in Ship Studio's app config and list
/// scans skip it afterward. External projects keep using their existing
/// registry removal path.
#[tauri::command]
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
            "Can only remove projects that live in a Ship Studio projects folder."
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
#[tauri::command]
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
    let project_path = dunce::canonicalize(&old_path).map_err(|e| CommandError::Io {
        message: format!("Couldn't resolve project path {old_path}: {e}"),
    })?;
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
#[tauri::command]
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
#[tauri::command]
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
        assert_eq!(get_git_branch(tmp.path()).await, None);
        assert_eq!(get_uncommitted_count(tmp.path()).await, None);
    }

    #[tokio::test]
    async fn scan_git_info_returns_one_entry_per_path_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        make_project(tmp.path(), "alpha");
        make_project(tmp.path(), "beta");
        let paths = vec![tmp.path().join("alpha"), tmp.path().join("beta")];

        let info = scan_git_info(paths).await;

        // Neither project is a git repo — both must degrade gracefully
        // rather than erroring or being dropped.
        assert_eq!(info.len(), 2);
        assert!(info
            .iter()
            .all(|(branch, count)| branch.is_none() && count.is_none()));
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

    // The #559/#253 shape: Windows sharing/lock violations are the transient
    // states the rename/delete retry loops exist for; anything else must fail
    // immediately.
    #[test]
    fn retryable_delete_error_matches_windows_lock_codes() {
        assert!(is_retryable_delete_error(
            &std::io::Error::from_raw_os_error(32) // ERROR_SHARING_VIOLATION
        ));
        assert!(is_retryable_delete_error(
            &std::io::Error::from_raw_os_error(33) // ERROR_LOCK_VIOLATION
        ));
        assert!(is_retryable_delete_error(
            &std::io::Error::from_raw_os_error(5) // ERROR_ACCESS_DENIED
        ));
        assert!(is_retryable_delete_error(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied"
        )));
        assert!(!is_retryable_delete_error(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "gone"
        )));
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

    #[test]
    fn remove_dir_all_robust_deletes_readonly_files() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("readonly_file.txt");
        std::fs::write(&file_path, "test content").unwrap();

        // Set the file to read-only
        let mut perms = std::fs::metadata(&file_path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file_path, perms).unwrap();

        // Verify it is indeed read-only
        assert!(std::fs::metadata(&file_path)
            .unwrap()
            .permissions()
            .readonly());

        // Use remove_dir_all_robust to delete the directory tree
        remove_dir_all_robust(tmp.path()).unwrap();

        // Verify the directory no longer exists
        assert!(!tmp.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn remove_dir_all_robust_never_chmods_through_symlinks() {
        // pnpm-style layout: the project links to a shared store whose files
        // are read-only on purpose. Deleting the project must remove the link
        // itself without touching the store's permissions.
        let store = tempfile::tempdir().unwrap();
        let store_file = store.path().join("shared.txt");
        std::fs::write(&store_file, "shared").unwrap();
        let mut perms = std::fs::metadata(&store_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&store_file, perms).unwrap();

        let project = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(store.path(), project.path().join("node_modules_link")).unwrap();

        remove_dir_all_robust(project.path()).unwrap();

        assert!(!project.path().exists());
        assert!(
            store_file.exists(),
            "symlink target must survive the delete"
        );
        assert!(
            std::fs::metadata(&store_file)
                .unwrap()
                .permissions()
                .readonly(),
            "store file must stay read-only — chmod escaped through the symlink"
        );
    }
}
