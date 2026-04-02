//! # Project Management Commands
//!
//! Commands for managing projects and project metadata.
//!
//! Organized into submodules:
//! - `detection` — project type detection and page scanning
//! - `metadata` — reading/writing `.shipstudio/project.json` metadata
//! - `templates` — zip template extraction and export
//! - `windows` — multi-window project management

mod detection;
mod metadata;
mod templates;
mod windows;

pub use detection::*;
pub use metadata::*;
pub use templates::*;
pub use windows::*;

use super::git::get_current_branch_sync;
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
fn is_valid_project(path: &std::path::Path) -> bool {
    path.is_dir()
        && (path.join("package.json").exists()
            || detection::has_html_files(path)
            || path.join(".gitignore").exists()
            || path.join(".shipstudio").exists()
            || path.join(".git").exists())
}

// ============ Tauri Commands ============

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

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
            let last_opened = if metadata_path.exists() {
                std::fs::read_to_string(&metadata_path)
                    .ok()
                    .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
                    .and_then(|m| m.last_opened)
            } else {
                None
            };

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
                let last_opened = if metadata_path.exists() {
                    std::fs::read_to_string(&metadata_path)
                        .ok()
                        .and_then(|contents| {
                            serde_json::from_str::<ProjectMetadata>(&contents).ok()
                        })
                        .and_then(|m| m.last_opened)
                } else {
                    None
                };

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
pub async fn get_dashboard_projects() -> Result<Vec<DashboardProject>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

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
            let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
            let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
            let hide_main_branch_warning =
                metadata.as_ref().and_then(|m| m.hide_main_branch_warning);

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
                let last_opened = metadata.as_ref().and_then(|m| m.last_opened);
                let auto_accept_mode = metadata.as_ref().and_then(|m| m.auto_accept_mode);
                let hide_main_branch_warning =
                    metadata.as_ref().and_then(|m| m.hide_main_branch_warning);

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
pub async fn list_pages(project_path: String) -> Result<Vec<PageInfo>, String> {
    let project = validate_project_path(&project_path)?;
    let project_type = detection::detect_project_type(&project);

    match project_type {
        ProjectType::Astro => {
            let pages_dir = project.join("src").join("pages");
            if pages_dir.exists() {
                let mut pages = detection::scan_astro_pages(&pages_dir, &pages_dir)?;
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
                return Ok(pages);
            }
            let mut pages = detection::scan_nextjs_pages(&app_dir, &app_dir)?;
            detection::sort_pages(&mut pages);
            Ok(pages)
        }
    }
}

/// Opens a folder in Finder (macOS)
#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
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
pub async fn ensure_gitignore_has_shipstudio(project_path: String) -> Result<(), String> {
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
pub async fn create_blank_project(project_path: String) -> Result<(), String> {
    // Can't use validate_project_path because the directory doesn't exist yet.
    // Instead, validate that the parent is within ~/ShipStudio.
    let path = std::path::Path::new(&project_path);
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");
    let parent = path.parent().ok_or("Invalid project path")?;
    let canonical_parent =
        dunce::canonicalize(parent).map_err(|e| format!("Invalid parent path: {e}"))?;
    if !canonical_parent.starts_with(&shipstudio_dir) {
        return Err("Project must be inside ~/ShipStudio".to_string());
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
pub async fn remove_git_history(project_path: String) -> Result<(), String> {
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
pub async fn delete_project(path: String) -> Result<(), String> {
    let project_path = std::path::Path::new(&path);

    // Check if this is an external project
    if let Ok(canonical) = dunce::canonicalize(project_path) {
        if crate::commands::external_projects::is_registered_external_path(&canonical)? {
            return Err(
                "Cannot delete external projects. Use 'Remove from list' instead.".to_string(),
            );
        }
    }

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    if !project_path.starts_with(&shipstudio_dir) {
        return Err("Can only delete projects from ShipStudio directory".to_string());
    }

    if !project_path.exists() {
        return Err("Project not found".to_string());
    }

    std::fs::remove_dir_all(project_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears project cache directories (.next, node_modules/.cache, etc.)
/// Used when restarting the dev server to ensure a fresh build.
#[tauri::command]
pub async fn clear_project_cache(project_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;

    // List of cache directories to clear
    let cache_dirs = [
        ".next",               // Next.js build cache
        ".svelte-kit",         // SvelteKit build cache
        ".nuxt",               // Nuxt build cache
        ".output",             // Nuxt output directory
        "node_modules/.cache", // Various build tool caches (babel, eslint, etc.)
        ".turbo",              // Turborepo cache
        ".swc",                // SWC compiler cache
    ];

    let mut errors = Vec::new();

    for cache_dir in &cache_dirs {
        let cache_path = project.join(cache_dir);
        if cache_path.exists() {
            if let Err(e) = std::fs::remove_dir_all(&cache_path) {
                errors.push(format!("Failed to remove {cache_dir}: {e}"));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        // Log errors but don't fail - some caches might be locked
        tracing::warn!("Some cache directories could not be cleared: {:?}", errors);
        Ok(())
    }
}
