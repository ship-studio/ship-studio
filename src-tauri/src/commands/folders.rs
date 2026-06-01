//! # Folder Management Commands
//!
//! Commands for organizing projects into folders on the dashboard.

use crate::errors::CommandError;
use crate::types::{Folder, FolderConfig, FolderInfo, FOLDER_CONFIG_SCHEMA_VERSION};
use std::path::PathBuf;

// ============ Helper Functions ============

/// Get the path to the global folders config file
fn get_folders_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("folders.json"))
}

/// Load the folder config from disk
fn load_folder_config() -> Result<FolderConfig, String> {
    let config_path = get_folders_config_path()?;

    if !config_path.exists() {
        return Ok(FolderConfig {
            schema_version: FOLDER_CONFIG_SCHEMA_VERSION,
            folders: Vec::new(),
        });
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read folders config: {e}"))?;

    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse folders config: {e}"))
}

/// Save the folder config to disk
fn save_folder_config(config: &FolderConfig) -> Result<(), String> {
    let config_path = get_folders_config_path()?;

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize folders config: {e}"))?;

    std::fs::write(&config_path, contents)
        .map_err(|e| format!("Failed to write folders config: {e}"))?;

    Ok(())
}

/// Rekey a project's path from `old_path` to `new_path` across all folders
/// after a folder rename, preserving folder membership. No-op (and no write)
/// if the project isn't filed in any folder. Not a Tauri command — called
/// internally by `rename_project`.
pub fn rename_project_path(old_path: &str, new_path: &str) -> Result<(), CommandError> {
    let mut config = load_folder_config()?;
    let mut changed = false;
    for folder in &mut config.folders {
        for p in &mut folder.project_paths {
            if p == old_path {
                *p = new_path.to_string();
                folder.updated_at = now_ms();
                changed = true;
            }
        }
    }
    if changed {
        save_folder_config(&config)?;
    }
    Ok(())
}

/// Get current timestamp in milliseconds
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Generate a UUID v4
fn generate_uuid() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut hasher = DefaultHasher::new();
    timestamp.hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    let random = hasher.finish();

    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (timestamp & 0xFFFFFFFF) as u32,
        ((timestamp >> 32) & 0xFFFF) as u16,
        (random & 0xFFF) as u16,
        (((random >> 12) & 0x3FFF) | 0x8000) as u16,
        (random >> 26) & 0xFFFFFFFFFFFF
    )
}

/// Load a project thumbnail as base64
fn load_thumbnail_base64(project_path: &str) -> Option<String> {
    let thumbnail_path = std::path::Path::new(project_path)
        .join(".shipstudio")
        .join("thumbnail.png");

    if !thumbnail_path.exists() {
        return None;
    }

    let bytes = std::fs::read(&thumbnail_path).ok()?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let b64 = STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

// ============ Tauri Commands ============

/// List all folders with preview information
#[tauri::command]
#[tracing::instrument]
pub async fn list_folders() -> Result<Vec<FolderInfo>, CommandError> {
    let config = load_folder_config()?;

    let mut folder_infos = Vec::new();

    for folder in config.folders {
        // Load up to 4 thumbnails for preview
        let preview_thumbnails: Vec<Option<String>> = folder
            .project_paths
            .iter()
            .take(4)
            .map(|path| load_thumbnail_base64(path))
            .collect();

        folder_infos.push(FolderInfo {
            id: folder.id,
            name: folder.name,
            project_count: folder.project_paths.len() as u32,
            preview_thumbnails,
            updated_at: folder.updated_at,
        });
    }

    // Sort by updated_at descending (most recently updated first)
    folder_infos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    Ok(folder_infos)
}

/// Create a new folder
#[tauri::command]
#[tracing::instrument(skip(name), fields(name = %name))]
pub async fn create_folder(name: String) -> Result<Folder, CommandError> {
    if name.trim().is_empty() {
        return Err(("Folder name cannot be empty".to_string()).into());
    }

    let mut config = load_folder_config()?;

    let now = now_ms();
    let folder = Folder {
        id: generate_uuid(),
        name: name.trim().to_string(),
        project_paths: Vec::new(),
        created_at: now,
        updated_at: now,
    };

    config.folders.push(folder.clone());
    save_folder_config(&config)?;

    Ok(folder)
}

/// Rename an existing folder
#[tauri::command]
#[tracing::instrument(skip(folder_id, name), fields(folder_id = %folder_id, name = %name))]
pub async fn rename_folder(folder_id: String, name: String) -> Result<(), CommandError> {
    if name.trim().is_empty() {
        return Err(("Folder name cannot be empty".to_string()).into());
    }

    let mut config = load_folder_config()?;

    let folder = config
        .folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or("Folder not found")?;

    folder.name = name.trim().to_string();
    folder.updated_at = now_ms();

    save_folder_config(&config)?;

    Ok(())
}

/// Delete a folder (projects become unfiled)
#[tauri::command]
#[tracing::instrument(skip(folder_id), fields(folder_id = %folder_id))]
pub async fn delete_folder(folder_id: String) -> Result<(), CommandError> {
    let mut config = load_folder_config()?;

    let initial_len = config.folders.len();
    config.folders.retain(|f| f.id != folder_id);

    if config.folders.len() == initial_len {
        return Err(("Folder not found".to_string()).into());
    }

    save_folder_config(&config)?;

    Ok(())
}

/// Add a project to a folder
#[tauri::command]
#[tracing::instrument(skip(folder_id, project_path), fields(folder_id = %folder_id, project = %project_path))]
pub async fn add_project_to_folder(
    folder_id: String,
    project_path: String,
) -> Result<(), CommandError> {
    let mut config = load_folder_config()?;

    // First, remove the project from any existing folder
    for folder in &mut config.folders {
        folder.project_paths.retain(|p| p != &project_path);
    }

    // Add to the target folder
    let folder = config
        .folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or("Folder not found")?;

    if !folder.project_paths.contains(&project_path) {
        folder.project_paths.push(project_path);
        folder.updated_at = now_ms();
    }

    save_folder_config(&config)?;

    Ok(())
}

/// Remove a project from a folder
#[tauri::command]
#[tracing::instrument(skip(folder_id, project_path), fields(folder_id = %folder_id, project = %project_path))]
pub async fn remove_project_from_folder(
    folder_id: String,
    project_path: String,
) -> Result<(), CommandError> {
    let mut config = load_folder_config()?;

    let folder = config
        .folders
        .iter_mut()
        .find(|f| f.id == folder_id)
        .ok_or("Folder not found")?;

    folder.project_paths.retain(|p| p != &project_path);
    folder.updated_at = now_ms();

    save_folder_config(&config)?;

    Ok(())
}

/// Move a project to a folder (or remove from all folders if folder_id is None)
#[tauri::command]
#[tracing::instrument(skip_all, fields(project = %project_path))]
pub async fn move_project_to_folder(
    project_path: String,
    folder_id: Option<String>,
) -> Result<(), CommandError> {
    let mut config = load_folder_config()?;

    // Remove the project from all folders first
    for folder in &mut config.folders {
        folder.project_paths.retain(|p| p != &project_path);
    }

    // If a folder_id is provided, add the project to that folder
    if let Some(id) = folder_id {
        let folder = config
            .folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or("Folder not found")?;

        folder.project_paths.push(project_path);
        folder.updated_at = now_ms();
    }

    save_folder_config(&config)?;

    Ok(())
}

/// Get the folder ID for a project (if any)
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn get_project_folder(project_path: String) -> Result<Option<String>, CommandError> {
    let config = load_folder_config()?;

    for folder in config.folders {
        if folder.project_paths.contains(&project_path) {
            return Ok(Some(folder.id));
        }
    }

    Ok(None)
}

/// Get all project paths that are in folders (used to filter unfiled projects)
#[tauri::command]
pub async fn get_filed_project_paths() -> Result<Vec<String>, CommandError> {
    let config = load_folder_config()?;

    let mut paths = Vec::new();
    for folder in config.folders {
        paths.extend(folder.project_paths);
    }

    Ok(paths)
}

/// Get projects in a specific folder
#[tauri::command]
pub async fn get_folder_projects(folder_id: String) -> Result<Vec<String>, CommandError> {
    let config = load_folder_config()?;

    let folder = config
        .folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or("Folder not found")?;

    Ok(folder.project_paths.clone())
}

/// Get folder details by ID
#[tauri::command]
pub async fn get_folder(folder_id: String) -> Result<Option<Folder>, CommandError> {
    let config = load_folder_config()?;

    Ok(config.folders.into_iter().find(|f| f.id == folder_id))
}
