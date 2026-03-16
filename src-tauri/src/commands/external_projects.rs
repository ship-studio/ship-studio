//! # External Project Management Commands
//!
//! Commands for registering and managing projects that live outside ~/ShipStudio.

use crate::types::{
    ExternalProject, ExternalProjectsConfig, EXTERNAL_PROJECTS_CONFIG_SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

// ============ Helper Functions ============

/// Get the path to the external projects config file
fn get_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("external-projects.json"))
}

/// Load the external projects config from disk
pub fn load_config() -> Result<ExternalProjectsConfig, String> {
    let config_path = get_config_path()?;

    if !config_path.exists() {
        return Ok(ExternalProjectsConfig {
            schema_version: EXTERNAL_PROJECTS_CONFIG_SCHEMA_VERSION,
            projects: Vec::new(),
        });
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read external projects config: {e}"))?;

    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse external projects config: {e}"))
}

/// Save the external projects config to disk
pub fn save_config(config: &ExternalProjectsConfig) -> Result<(), String> {
    let config_path = get_config_path()?;

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize external projects config: {e}"))?;

    std::fs::write(&config_path, contents)
        .map_err(|e| format!("Failed to write external projects config: {e}"))?;

    Ok(())
}

/// Check if a canonical path is a registered external project path
pub fn is_registered_external_path(canonical: &Path) -> Result<bool, String> {
    let config = load_config()?;
    for project in &config.projects {
        let project_path = Path::new(&project.path);
        if let Ok(project_canonical) = dunce::canonicalize(project_path) {
            if canonical.starts_with(&project_canonical) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

// ============ Tauri Commands ============

/// Opens a native folder picker and registers the selected folder as an external project.
/// Returns the path of the registered project, or None if cancelled.
#[tauri::command]
pub async fn register_external_project(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select Project Folder")
        .blocking_pick_folder();

    let folder_path = match folder {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid folder path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    // Validate project has package.json or HTML files
    let is_valid_project = folder_path.join("package.json").exists()
        || crate::commands::projects::has_html_files(&folder_path);

    if !is_valid_project {
        // Check one level deep for a nested project
        let mut nested_projects: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&folder_path) {
            for entry in entries.flatten() {
                if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                    let sub = entry.path();
                    // Skip hidden dirs
                    if entry
                        .file_name()
                        .to_str()
                        .map_or(false, |n| n.starts_with('.'))
                    {
                        continue;
                    }
                    if sub.join("package.json").exists()
                        || crate::commands::projects::has_html_files(&sub)
                    {
                        if let Some(name) = entry.file_name().to_str() {
                            nested_projects.push(name.to_string());
                        }
                    }
                }
            }
        }

        if nested_projects.len() == 1 {
            return Err(format!(
                "The project appears to be inside the \"{}\" subfolder. Please select that folder instead.",
                nested_projects[0]
            ));
        } else if nested_projects.len() > 1 {
            return Err(format!(
                "This folder contains multiple projects inside it: {}. Please select the specific project folder you want to import.",
                nested_projects.join(", ")
            ));
        }

        return Err(
            "Selected folder doesn't appear to be a project — no package.json or .html files found."
                .to_string(),
        );
    }

    // Canonicalize the path
    let canonical = dunce::canonicalize(&folder_path).map_err(|e| format!("Invalid path: {e}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Check if already inside ~/ShipStudio
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");
    if canonical.starts_with(&shipstudio_dir) {
        return Err(
            "This project is already inside ~/ShipStudio. It will appear automatically."
                .to_string(),
        );
    }

    // Check if already registered
    let mut config = load_config()?;
    if config.projects.iter().any(|p| {
        dunce::canonicalize(Path::new(&p.path))
            .map(|c| c == canonical)
            .unwrap_or(false)
    }) {
        return Err("This project is already registered.".to_string());
    }

    // Register
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    config.projects.push(ExternalProject {
        path: canonical_str.clone(),
        registered_at: now,
    });

    save_config(&config)?;

    Ok(Some(canonical_str))
}

/// Removes an external project from the registry (does not delete files).
#[tauri::command]
pub async fn unregister_external_project(path: String) -> Result<(), String> {
    let mut config = load_config()?;

    let canonical = dunce::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));

    let initial_len = config.projects.len();
    config.projects.retain(|p| {
        let project_canonical =
            dunce::canonicalize(Path::new(&p.path)).unwrap_or_else(|_| PathBuf::from(&p.path));
        project_canonical != canonical
    });

    if config.projects.len() == initial_len {
        return Err("Project not found in external projects list.".to_string());
    }

    save_config(&config)?;
    Ok(())
}

/// Register an external project by path (no folder picker dialog).
///
/// Called automatically when a project outside ~/ShipStudio is opened
/// (e.g., via session restore or URL params) to ensure backend commands
/// don't fail with "Security error: path is outside ShipStudio directory".
///
/// Returns Ok(true) if newly registered, Ok(false) if already registered or inside ~/ShipStudio.
#[tauri::command]
pub async fn ensure_external_project_registered(path: String) -> Result<bool, String> {
    let canonical =
        dunce::canonicalize(Path::new(&path)).map_err(|e| format!("Invalid path: {e}"))?;

    // Skip if already inside ~/ShipStudio
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");
    if canonical.starts_with(&shipstudio_dir) {
        return Ok(false);
    }

    // Skip if already registered
    if is_registered_external_path(&canonical)? {
        return Ok(false);
    }

    // Register it
    let canonical_str = canonical.to_string_lossy().to_string();
    let mut config = load_config()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    config.projects.push(ExternalProject {
        path: canonical_str.clone(),
        registered_at: now,
    });

    save_config(&config)?;
    tracing::info!("Auto-registered external project: {}", canonical_str);

    Ok(true)
}

/// Check if a project path is an external project.
#[tauri::command]
pub async fn is_project_external(path: String) -> Result<bool, String> {
    let canonical =
        dunce::canonicalize(Path::new(&path)).map_err(|e| format!("Invalid path: {e}"))?;

    let config = load_config()?;
    for project in &config.projects {
        let project_path = Path::new(&project.path);
        if let Ok(project_canonical) = dunce::canonicalize(project_path) {
            if canonical == project_canonical {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
