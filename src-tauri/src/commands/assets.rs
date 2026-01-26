//! # Assets Commands
//!
//! Commands for managing files in the /public folder of projects.

use crate::types::Asset;
use crate::utils::validate_project_path;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Validates that an asset path is within the /public directory of the project.
/// Prevents path traversal attacks.
fn validate_asset_path(project_path: &Path, asset_path: &str) -> Result<PathBuf, String> {
    // Check for obvious path traversal attempts
    if asset_path.contains("..") {
        return Err("Invalid path: path traversal not allowed".to_string());
    }

    let public_dir = project_path.join("public");
    let full_path = public_dir.join(asset_path);

    // Canonicalize to resolve any symlinks and ensure it's within public
    // For new files that don't exist yet, we need to check the parent
    let check_path = if full_path.exists() {
        full_path
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?
    } else {
        // For non-existent paths, verify parent exists and is within public
        let parent = full_path
            .parent()
            .ok_or("Invalid path: no parent directory")?;
        if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;
        let canonical_public = if public_dir.exists() {
            public_dir
                .canonicalize()
                .map_err(|e| format!("Invalid path: {}", e))?
        } else {
            return Err("Public directory does not exist".to_string());
        };
        if !canonical_parent.starts_with(&canonical_public) {
            return Err("Security error: path is outside public directory".to_string());
        }
        return Ok(full_path);
    };

    let canonical_public = public_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;

    if !check_path.starts_with(&canonical_public) {
        return Err("Security error: path is outside public directory".to_string());
    }

    Ok(check_path)
}

/// Helper to convert a file path to Asset struct
fn path_to_asset(path: &PathBuf, public_dir: &PathBuf) -> Result<Asset, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {}", e))?;

    let relative_path = path
        .strip_prefix(public_dir)
        .map_err(|_| "Failed to get relative path")?
        .to_string_lossy()
        .to_string();

    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(Asset {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: relative_path,
        full_path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        is_directory: metadata.is_dir(),
        modified_at,
    })
}

/// Recursively list all files in a directory
fn list_files_recursive(
    dir: &PathBuf,
    public_dir: &PathBuf,
    assets: &mut Vec<Asset>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip hidden files/directories
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        if let Ok(asset) = path_to_asset(&path, public_dir) {
            assets.push(asset);
        }

        // Recurse into subdirectories
        if path.is_dir() {
            list_files_recursive(&path, public_dir, assets)?;
        }
    }

    Ok(())
}

/// List all assets in the /public folder (recursive)
#[tauri::command]
pub async fn list_assets(project_path: String) -> Result<Vec<Asset>, String> {
    let project = validate_project_path(&project_path)?;
    let public_dir = project.join("public");

    if !public_dir.exists() {
        return Ok(Vec::new());
    }

    let mut assets = Vec::new();
    list_files_recursive(&public_dir, &public_dir, &mut assets)?;

    // Sort by path for consistent ordering
    assets.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(assets)
}

/// Upload a file to /public (or subfolder)
#[tauri::command]
pub async fn upload_asset(
    project_path: String,
    destination: String,
    file_name: String,
    file_data: Vec<u8>,
) -> Result<Asset, String> {
    let project = validate_project_path(&project_path)?;
    let public_dir = project.join("public");

    // Create public directory if it doesn't exist
    if !public_dir.exists() {
        fs::create_dir_all(&public_dir)
            .map_err(|e| format!("Failed to create public directory: {}", e))?;
    }

    // Validate filename
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Invalid filename: path separators not allowed".to_string());
    }

    // Build destination path
    let dest_dir = if destination.is_empty() || destination == "/" {
        public_dir.clone()
    } else {
        // Validate and resolve destination path
        let dest = destination.trim_start_matches('/');
        if dest.contains("..") {
            return Err("Invalid destination: path traversal not allowed".to_string());
        }
        let dest_path = public_dir.join(dest);
        if !dest_path.exists() {
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
        dest_path
    };

    let file_path = dest_dir.join(&file_name);

    // Ensure final path is within public directory
    let canonical_public = public_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let canonical_dest = dest_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical_dest.starts_with(&canonical_public) {
        return Err("Security error: destination is outside public directory".to_string());
    }

    // Write file
    fs::write(&file_path, file_data).map_err(|e| format!("Failed to write file: {}", e))?;

    path_to_asset(&file_path, &public_dir)
}

/// Delete an asset
#[tauri::command]
pub async fn delete_asset(project_path: String, asset_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let public_dir = project.join("public");
    let full_path = validate_asset_path(&project, &asset_path)?;

    // Double-check it's within public
    let canonical_public = public_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let canonical_path = full_path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical_path.starts_with(&canonical_public) {
        return Err("Security error: path is outside public directory".to_string());
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path).map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(&full_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

/// Rename an asset
#[tauri::command]
pub async fn rename_asset(
    project_path: String,
    asset_path: String,
    new_name: String,
) -> Result<Asset, String> {
    let project = validate_project_path(&project_path)?;
    let public_dir = project.join("public");
    let old_path = validate_asset_path(&project, &asset_path)?;

    // Validate new name
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err("Invalid name: path separators not allowed".to_string());
    }

    if new_name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }

    // Build new path in same directory
    let parent = old_path
        .parent()
        .ok_or("Invalid path: no parent directory")?;
    let new_path = parent.join(&new_name);

    // Check new path is still within public
    let canonical_public = public_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical_parent.starts_with(&canonical_public) {
        return Err("Security error: path is outside public directory".to_string());
    }

    // Check if target already exists
    if new_path.exists() {
        return Err(format!("A file named '{}' already exists", new_name));
    }

    // Rename
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;

    path_to_asset(&new_path, &public_dir)
}

/// Create a folder in /public
#[tauri::command]
pub async fn create_asset_folder(project_path: String, folder_path: String) -> Result<(), String> {
    let project = validate_project_path(&project_path)?;
    let public_dir = project.join("public");

    // Create public directory if it doesn't exist
    if !public_dir.exists() {
        fs::create_dir_all(&public_dir)
            .map_err(|e| format!("Failed to create public directory: {}", e))?;
    }

    // Validate folder path
    if folder_path.contains("..") {
        return Err("Invalid path: path traversal not allowed".to_string());
    }

    let folder_name = folder_path.trim_start_matches('/');
    if folder_name.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }

    let full_path = public_dir.join(folder_name);

    // Ensure it's within public
    let canonical_public = public_dir
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;

    // For the new folder, check parent is within public
    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("Invalid path: {}", e))?;
            if !canonical_parent.starts_with(&canonical_public) {
                return Err("Security error: path is outside public directory".to_string());
            }
        }
    }

    if full_path.exists() {
        return Err("Folder already exists".to_string());
    }

    fs::create_dir_all(&full_path).map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(())
}
