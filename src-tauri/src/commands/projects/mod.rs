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

use super::git::get_current_branch_sync;
use crate::errors::CommandError;
use crate::types::{DashboardProject, PageInfo, ProjectInfo, ProjectMetadata, ProjectType};
use crate::utils::{create_command, validate_project_path};

// ============ Helper Functions ============

/// Helper to get git branch for a project.
/// Delegates to `git::get_current_branch_sync` to avoid duplication.
fn get_git_branch(project_path: &std::path::Path) -> Option<String> {
    get_current_branch_sync(project_path)
}

/// Helper to count uncommitted changes (tracked files only)
fn get_uncommitted_count(project_path: &std::path::Path) -> Option<u32> {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return None;
    }

    // Use -uno to ignore untracked files like .DS_Store
    let output = create_command("git")
        .args(["status", "--porcelain", "-uno"])
        .current_dir(project_path)
        .output()
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let count = stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        return Some(count);
    }
    None
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
pub(crate) fn is_valid_project(path: &std::path::Path) -> bool {
    path.is_dir()
        && (path.join("package.json").exists()
            || detection::has_html_files(path)
            || path.join(".gitignore").exists()
            || path.join(".shipstudio").exists()
            || path.join(".git").exists())
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

// ============ Tauri Commands ============

#[tauri::command]
#[tracing::instrument]
pub async fn list_projects() -> Result<Vec<ProjectInfo>, CommandError> {
    let shipstudio_dir = crate::utils::projects_root()?;
    // Account resolution must never break project listing: degrade to "no active
    // account" (everything visible) on failure rather than erroring the whole list.
    let active_account_id = crate::commands::accounts::get_active_account_id().unwrap_or_default();
    // Live workspace list, read once so the visibility check stays IO-free per project.
    let accounts = crate::commands::setup::read_app_state().accounts;

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&shipstudio_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if is_valid_project(&path) {
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
                continue;
            }

            let last_opened = metadata.as_ref().and_then(|m| m.last_opened);

            projects.push(ProjectInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                thumbnail,
                last_opened,
            });
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
                    continue;
                }

                let last_opened = metadata.as_ref().and_then(|m| m.last_opened);

                projects.push(ProjectInfo {
                    name,
                    path: ext_path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                });
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

    if !shipstudio_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&shipstudio_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if is_valid_project(&path) {
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
                continue;
            }

            let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
            let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
            let hide_main_branch_warning =
                metadata.as_ref().and_then(|m| m.hide_main_branch_warning);
            let workspace_subpath = metadata.as_ref().and_then(|m| m.workspace_subpath.clone());

            // Ensure .shipstudio/ is gitignored
            let _ = ensure_gitignore_has_shipstudio_sync(&path);

            // Get git info
            let git_branch = get_git_branch(&path);
            let uncommitted_count = get_uncommitted_count(&path);

            projects.push(DashboardProject {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                thumbnail,
                last_opened,
                git_branch,
                uncommitted_count,
                auto_accept_mode,
                hide_main_branch_warning,
                is_external: false,
                workspace_subpath,
            });
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
                    continue;
                }

                let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
                let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
                let hide_main_branch_warning =
                    metadata.as_ref().and_then(|m| m.hide_main_branch_warning);
                let workspace_subpath = metadata.as_ref().and_then(|m| m.workspace_subpath.clone());

                // Ensure .shipstudio/ is gitignored
                let _ = ensure_gitignore_has_shipstudio_sync(&path);

                let git_branch = get_git_branch(&path);
                let uncommitted_count = get_uncommitted_count(&path);

                projects.push(DashboardProject {
                    name,
                    path: path.to_string_lossy().to_string(),
                    thumbnail,
                    last_opened,
                    git_branch,
                    uncommitted_count,
                    auto_accept_mode,
                    hide_main_branch_warning,
                    is_external: true,
                    workspace_subpath,
                });
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
            let mut pages = detection::scan_html_pages(&project, &project)?;
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

/// Deletes a project directory. Only allows deletion from ~/ShipStudio.
/// External projects cannot be deleted — use unregister_external_project instead.
#[tauri::command]
#[tracing::instrument]
pub async fn delete_project(path: String) -> Result<(), CommandError> {
    // Canonicalize FIRST (resolves symlinks and `..`) so the containment check
    // below can't be defeated by a lexical path like `~/ShipStudio/../../.ssh`.
    // `Path::starts_with` is purely lexical and would otherwise pass such a path
    // straight through to `remove_dir_all`.
    let canonical = dunce::canonicalize(&path).map_err(|_| "Project not found".to_string())?;

    // Check if this is an external project
    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        return Err(
            "Cannot delete external projects. Use 'Remove from list' instead."
                .to_string()
                .into(),
        );
    }

    if !crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(("Can only delete projects from the projects directory".to_string()).into());
    }

    std::fs::remove_dir_all(&canonical).map_err(|e| e.to_string())?;
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
    let project_path =
        dunce::canonicalize(&old_path).map_err(|_| "Project not found".to_string())?;
    let project_path = project_path.as_path();

    // Reject external projects (their folders live outside ~/ShipStudio).
    if crate::commands::external_projects::is_registered_external_path(project_path)? {
        return Err(
            "Renaming external projects isn't supported yet. Remove it from the list and re-add it under a new folder name."
                .to_string()
                .into(),
        );
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
        return Err((format!("A project named \"{new_name}\" already exists.")).into());
    }

    std::fs::rename(project_path, &new_path)
        .map_err(|e| format!("Failed to rename project: {e}"))?;

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
}
