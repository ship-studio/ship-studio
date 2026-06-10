//! # Assets Commands
//!
//! Commands for managing asset files in a project. The managed folder defaults
//! to `/public` but can be re-pointed per project (e.g. `src/assets` for Astro
//! image pipelines) via `assets_root` in `.shipstudio/project.json`.

use crate::commands::git::{load_project_metadata, save_project_metadata};
use crate::errors::CommandError;
use crate::types::Asset;
use crate::utils::{resolve_workspace_path, validate_project_path};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Folder the Assets panel manages when no per-project override is set.
const DEFAULT_ASSETS_ROOT: &str = "public";

/// Sanitize a configured assets root: a non-empty relative path with no
/// traversal, no backslashes, and no empty/`.`/`..` segments. Returns `None`
/// when invalid so callers fall back to the default instead of trusting a
/// hand-edited project.json.
fn sanitize_assets_root(root: &str) -> Option<String> {
    let trimmed = root.trim().trim_matches('/');
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || Path::new(trimmed).is_absolute()
        || trimmed
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// The folder the Assets panel manages for this project. `repo_root` locates
/// `.shipstudio/project.json`; the returned dir lives under `workspace`
/// (monorepo-aware), matching the rest of the asset commands.
fn assets_root_dir(repo_root: &Path, workspace: &Path) -> PathBuf {
    let configured = load_project_metadata(repo_root)
        .assets_root
        .as_deref()
        .and_then(sanitize_assets_root);
    workspace.join(configured.as_deref().unwrap_or(DEFAULT_ASSETS_ROOT))
}

/// Validates that an asset path is within the project's assets folder.
/// Prevents path traversal attacks.
fn validate_asset_path(root_dir: &Path, asset_path: &str) -> Result<PathBuf, String> {
    // Check for obvious path traversal attempts
    if asset_path.contains("..") {
        return Err("Invalid path: path traversal not allowed".to_string());
    }

    let full_path = root_dir.join(asset_path);

    // Canonicalize to resolve any symlinks and ensure it's within the root.
    // For new files that don't exist yet, we need to check the parent
    let check_path = if full_path.exists() {
        dunce::canonicalize(&full_path).map_err(|e| format!("Invalid path: {e}"))?
    } else {
        // For non-existent paths, verify parent exists and is within the root
        let parent = full_path
            .parent()
            .ok_or("Invalid path: no parent directory")?;
        if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
        let canonical_parent =
            dunce::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
        let canonical_root = if root_dir.exists() {
            dunce::canonicalize(root_dir).map_err(|e| format!("Invalid path: {e}"))?
        } else {
            return Err("Assets folder does not exist".to_string());
        };
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("Security error: path is outside the assets folder".to_string());
        }
        return Ok(full_path);
    };

    let canonical_root = dunce::canonicalize(root_dir).map_err(|e| format!("Invalid path: {e}"))?;

    if !check_path.starts_with(&canonical_root) {
        return Err("Security error: path is outside the assets folder".to_string());
    }

    Ok(check_path)
}

/// Helper to convert a file path to Asset struct
fn path_to_asset(path: &PathBuf, root_dir: &PathBuf) -> Result<Asset, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;

    let relative_path = path
        .strip_prefix(root_dir)
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
    root_dir: &PathBuf,
    assets: &mut Vec<Asset>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip hidden files/directories
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        if let Ok(asset) = path_to_asset(&path, root_dir) {
            assets.push(asset);
        }

        // Recurse into subdirectories
        if path.is_dir() {
            list_files_recursive(&path, root_dir, assets)?;
        }
    }

    Ok(())
}

/// Get the folder (relative to the project workspace) the Assets panel manages.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_assets_root(project_path: String) -> Result<String, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let configured = load_project_metadata(&repo_root)
        .assets_root
        .as_deref()
        .and_then(sanitize_assets_root);
    Ok(configured.unwrap_or_else(|| DEFAULT_ASSETS_ROOT.to_string()))
}

/// Point the Assets panel at a different folder (e.g. `src/assets`), persisted
/// per project in `.shipstudio/project.json`. Creates the folder if missing.
/// Returns the normalized root that was saved.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_assets_root(project_path: String, root: String) -> Result<String, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&repo_root);

    let sanitized = sanitize_assets_root(&root)
        .ok_or("Enter a folder inside the project, like public or src/assets")?;

    let dir = workspace.join(&sanitized);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create folder: {e}"))?;
    }

    // Canonical containment check — the sanitizer blocks traversal lexically,
    // but symlinked folders could still escape the project.
    let canonical_dir = dunce::canonicalize(&dir).map_err(|e| format!("Invalid path: {e}"))?;
    let canonical_workspace =
        dunce::canonicalize(&workspace).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical_dir.starts_with(&canonical_workspace) {
        return Err(("Security error: folder is outside the project".to_string()).into());
    }

    let mut metadata = load_project_metadata(&repo_root);
    // Store None for the default so untouched projects keep a clean project.json.
    metadata.assets_root = if sanitized == DEFAULT_ASSETS_ROOT {
        None
    } else {
        Some(sanitized.clone())
    };
    save_project_metadata(&repo_root, &metadata)?;

    Ok(sanitized)
}

/// List all assets in the project's assets folder (recursive)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_assets(project_path: String) -> Result<Vec<Asset>, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);

    if !root_dir.exists() {
        return Ok(Vec::new());
    }

    let mut assets = Vec::new();
    list_files_recursive(&root_dir, &root_dir, &mut assets)?;

    // Sort by path for consistent ordering
    assets.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(assets)
}

/// Upload a file to the assets folder (or subfolder)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn upload_asset(
    project_path: String,
    destination: String,
    file_name: String,
    file_data: Vec<u8>,
) -> Result<Asset, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);

    // Create the assets folder if it doesn't exist
    if !root_dir.exists() {
        fs::create_dir_all(&root_dir)
            .map_err(|e| format!("Failed to create assets folder: {e}"))?;
    }

    // Validate filename
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(("Invalid filename: path separators not allowed".to_string()).into());
    }

    // Build destination path
    let dest_dir = if destination.is_empty() || destination == "/" {
        root_dir.clone()
    } else {
        // Validate and resolve destination path
        let dest = destination.trim_start_matches('/');
        if dest.contains("..") {
            return Err(("Invalid destination: path traversal not allowed".to_string()).into());
        }
        let dest_path = root_dir.join(dest);
        if !dest_path.exists() {
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create destination directory: {e}"))?;
        }
        dest_path
    };

    let file_path = dest_dir.join(&file_name);

    // Ensure final path is within the assets folder
    let canonical_root =
        dunce::canonicalize(&root_dir).map_err(|e| format!("Invalid path: {e}"))?;
    let canonical_dest =
        dunce::canonicalize(&dest_dir).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical_dest.starts_with(&canonical_root) {
        return Err(
            ("Security error: destination is outside the assets folder".to_string()).into(),
        );
    }

    // Write file
    fs::write(&file_path, file_data).map_err(|e| format!("Failed to write file: {e}"))?;

    path_to_asset(&file_path, &root_dir).map_err(CommandError::from)
}

/// Delete an asset
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn delete_asset(project_path: String, asset_path: String) -> Result<(), CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);
    let full_path = validate_asset_path(&root_dir, &asset_path)?;

    // Double-check it's within the assets folder
    let canonical_root =
        dunce::canonicalize(&root_dir).map_err(|e| format!("Invalid path: {e}"))?;
    let canonical_path =
        dunce::canonicalize(&full_path).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(("Security error: path is outside the assets folder".to_string()).into());
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path).map_err(|e| format!("Failed to delete directory: {e}"))?;
    } else {
        fs::remove_file(&full_path).map_err(|e| format!("Failed to delete file: {e}"))?;
    }

    Ok(())
}

/// Rename an asset
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn rename_asset(
    project_path: String,
    asset_path: String,
    new_name: String,
) -> Result<Asset, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);
    let old_path = validate_asset_path(&root_dir, &asset_path)?;

    // Validate new name
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err(("Invalid name: path separators not allowed".to_string()).into());
    }

    if new_name.is_empty() {
        return Err(("Name cannot be empty".to_string()).into());
    }

    // Build new path in same directory
    let parent = old_path
        .parent()
        .ok_or("Invalid path: no parent directory")?;
    let new_path = parent.join(&new_name);

    // Check new path is still within the assets folder
    let canonical_root =
        dunce::canonicalize(&root_dir).map_err(|e| format!("Invalid path: {e}"))?;
    let canonical_parent = dunce::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(("Security error: path is outside the assets folder".to_string()).into());
    }

    // Check if target already exists
    if new_path.exists() {
        return Err((format!("A file named '{new_name}' already exists")).into());
    }

    // Rename
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {e}"))?;

    path_to_asset(&new_path, &root_dir).map_err(CommandError::from)
}

/// Create a folder in the assets folder
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn create_asset_folder(
    project_path: String,
    folder_path: String,
) -> Result<(), CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);

    // Create the assets folder if it doesn't exist
    if !root_dir.exists() {
        fs::create_dir_all(&root_dir)
            .map_err(|e| format!("Failed to create assets folder: {e}"))?;
    }

    // Validate folder path
    if folder_path.contains("..") {
        return Err(("Invalid path: path traversal not allowed".to_string()).into());
    }

    let folder_name = folder_path.trim_start_matches('/');
    if folder_name.is_empty() {
        return Err(("Folder name cannot be empty".to_string()).into());
    }

    let full_path = root_dir.join(folder_name);

    // Ensure it's within the assets folder
    let canonical_root =
        dunce::canonicalize(&root_dir).map_err(|e| format!("Invalid path: {e}"))?;

    // For the new folder, check parent is within the assets folder
    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent =
                dunce::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
            if !canonical_parent.starts_with(&canonical_root) {
                return Err(
                    ("Security error: path is outside the assets folder".to_string()).into(),
                );
            }
        }
    }

    if full_path.exists() {
        return Err(("Folder already exists".to_string()).into());
    }

    fs::create_dir_all(&full_path).map_err(|e| format!("Failed to create folder: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_accepts_simple_and_nested_roots() {
        assert_eq!(sanitize_assets_root("public"), Some("public".to_string()));
        assert_eq!(
            sanitize_assets_root("src/assets"),
            Some("src/assets".to_string())
        );
        assert_eq!(
            sanitize_assets_root(" /src/assets/ "),
            Some("src/assets".to_string())
        );
    }

    #[test]
    fn sanitize_rejects_traversal_and_absolute_paths() {
        assert_eq!(sanitize_assets_root(""), None);
        assert_eq!(sanitize_assets_root("   "), None);
        assert_eq!(sanitize_assets_root(".."), None);
        assert_eq!(sanitize_assets_root("../outside"), None);
        assert_eq!(sanitize_assets_root("src/../../etc"), None);
        assert_eq!(sanitize_assets_root("src/./assets"), None);
        assert_eq!(sanitize_assets_root("src//assets"), None);
        assert_eq!(sanitize_assets_root("/"), None);
        assert_eq!(sanitize_assets_root("src\\assets"), None);
    }

    #[test]
    fn assets_root_dir_falls_back_to_public() {
        let tmp = tempfile::tempdir().unwrap();
        // No .shipstudio/project.json → default root.
        let dir = assets_root_dir(tmp.path(), tmp.path());
        assert_eq!(dir, tmp.path().join("public"));
    }

    #[test]
    fn assets_root_dir_reads_configured_root() {
        let tmp = tempfile::tempdir().unwrap();
        let shipstudio = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&shipstudio).unwrap();
        let mut metadata = crate::types::ProjectMetadata::default();
        metadata.assets_root = Some("src/assets".to_string());
        std::fs::write(
            shipstudio.join("project.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();

        let dir = assets_root_dir(tmp.path(), tmp.path());
        assert_eq!(dir, tmp.path().join("src/assets"));
    }

    #[test]
    fn assets_root_dir_ignores_invalid_configured_root() {
        let tmp = tempfile::tempdir().unwrap();
        let shipstudio = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&shipstudio).unwrap();
        let mut metadata = crate::types::ProjectMetadata::default();
        metadata.assets_root = Some("../escape".to_string());
        std::fs::write(
            shipstudio.join("project.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();

        let dir = assets_root_dir(tmp.path(), tmp.path());
        assert_eq!(dir, tmp.path().join("public"));
    }
}
