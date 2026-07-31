//! # Assets Commands
//!
//! Commands for managing asset files in a project. The managed folder defaults
//! to `/public` but can be re-pointed per project (e.g. `src/assets` for Astro
//! image pipelines) via `assets_root` in `.shipstudio/project.json`.

use crate::commands::git::{load_project_metadata, save_project_metadata};
use crate::errors::CommandError;
use crate::types::Asset;
use crate::utils::{normalize_separators, resolve_workspace_path, validate_project_path};
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
    if crate::utils::has_parent_dir_component(asset_path) {
        return Err("Invalid path: path traversal not allowed".to_string());
    }

    let full_path = root_dir.join(asset_path);

    // Canonicalize to resolve any symlinks and ensure it's within the root.
    // For new files that don't exist yet, we need to check the parent
    let check_path = if full_path.exists() {
        crate::utils::canonicalize_tagged(&full_path, "assets")?
    } else {
        // For non-existent paths, verify parent exists and is within the root
        let parent = full_path
            .parent()
            .ok_or_else(|| format!("Invalid path {}: no parent directory", full_path.display()))?;
        if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
        let canonical_parent = crate::utils::canonicalize_tagged(parent, "assets")?;
        let canonical_root = if root_dir.exists() {
            crate::utils::canonicalize_tagged(root_dir, "assets")?
        } else {
            return Err("Assets folder does not exist".to_string());
        };
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("Security error: path is outside the assets folder".to_string());
        }
        return Ok(full_path);
    };

    let canonical_root = crate::utils::canonicalize_tagged(root_dir, "assets")?;

    if !check_path.starts_with(&canonical_root) {
        return Err("Security error: path is outside the assets folder".to_string());
    }

    Ok(check_path)
}

/// Helper to convert a file path to Asset struct
fn path_to_asset(path: &PathBuf, root_dir: &PathBuf) -> Result<Asset, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;

    // Forward slashes on every OS: the Assets panel groups files into folders and
    // renders breadcrumbs by splitting `path` on `/`. On Windows `to_string_lossy()`
    // would hand back backslashes and flatten the tree. No-op on macOS/Linux.
    let relative_path = normalize_separators(
        &path
            .strip_prefix(root_dir)
            .map_err(|e| {
                format!(
                    "Failed to get path of {} relative to assets root {}: {e}",
                    path.display(),
                    root_dir.display()
                )
            })?
            .to_string_lossy(),
    );

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
    let canonical_dir = crate::utils::canonicalize_tagged(&dir, "assets")?;
    let canonical_workspace = crate::utils::canonicalize_tagged(&workspace, "assets")?;
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
    if file_name.contains('/') || file_name.contains('\\') || file_name == ".." || file_name == "."
    {
        return Err(("Invalid filename: path separators not allowed".to_string()).into());
    }

    // Build destination path
    let dest_dir = if destination.is_empty() || destination == "/" {
        root_dir.clone()
    } else {
        // Validate and resolve destination path
        let dest = destination.trim_start_matches('/');
        if crate::utils::has_parent_dir_component(dest) {
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
    let canonical_root = crate::utils::canonicalize_tagged(&root_dir, "assets")?;
    let canonical_dest = crate::utils::canonicalize_tagged(&dest_dir, "assets")?;
    if !canonical_dest.starts_with(&canonical_root) {
        return Err(
            ("Security error: destination is outside the assets folder".to_string()).into(),
        );
    }

    // Refuse to write through a symlink at the final component: a malicious
    // repo could pre-plant `public/logo.png` as a symlink to ~/.zshenv, and
    // `fs::write` follows symlinks, so the containment check on the parent dir
    // above isn't enough on its own.
    if let Ok(meta) = fs::symlink_metadata(&file_path) {
        if meta.file_type().is_symlink() {
            return Err(
                ("Security error: refusing to overwrite a symlinked asset path".to_string()).into(),
            );
        }
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
    let canonical_root = crate::utils::canonicalize_tagged(&root_dir, "assets")?;
    let canonical_path = crate::utils::canonicalize_tagged(&full_path, "assets")?;
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
    if new_name.contains('/') || new_name.contains('\\') || new_name == ".." || new_name == "." {
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
    let canonical_root = crate::utils::canonicalize_tagged(&root_dir, "assets")?;
    let canonical_parent = crate::utils::canonicalize_tagged(parent, "assets")?;
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
    if crate::utils::has_parent_dir_component(&folder_path) {
        return Err(("Invalid path: path traversal not allowed".to_string()).into());
    }

    let folder_name = folder_path.trim_start_matches('/');
    if folder_name.is_empty() {
        return Err(("Folder name cannot be empty".to_string()).into());
    }

    let full_path = root_dir.join(folder_name);

    // Ensure it's within the assets folder
    let canonical_root = crate::utils::canonicalize_tagged(&root_dir, "assets")?;

    // For the new folder, check parent is within the assets folder
    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent = crate::utils::canonicalize_tagged(parent, "assets")?;
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

/// Core of `export_asset`, factored out so it can be unit-tested against a
/// temp directory (the command wrapper requires a real ShipStudio project
/// path). Copies `asset_path` (relative to `root_dir`) to `destination`.
fn export_asset_to(
    root_dir: &Path,
    asset_path: &str,
    destination: &str,
    overwrite: bool,
) -> Result<String, CommandError> {
    let source = validate_asset_path(root_dir, asset_path)?;

    if !source.is_file() {
        return Err(CommandError::Validation {
            field: "asset_path".to_string(),
            reason: "Only files can be downloaded".to_string(),
        });
    }

    let dest = PathBuf::from(destination);
    if !dest.is_absolute() {
        return Err(CommandError::Validation {
            field: "destination".to_string(),
            reason: "Destination must be an absolute path".to_string(),
        });
    }

    if dest.exists() {
        // Never silently replace a file: the caller must opt in (the native
        // save dialog has already asked the user to confirm replacement).
        if !overwrite {
            return Err(CommandError::Validation {
                field: "destination".to_string(),
                reason: "A file already exists at the destination".to_string(),
            });
        }
        if dest.is_dir() {
            return Err(CommandError::Validation {
                field: "destination".to_string(),
                reason: "Destination is a folder".to_string(),
            });
        }
        // Copying a file onto itself truncates it — refuse instead.
        let canonical_dest =
            dunce::canonicalize(&dest).map_err(|e| format!("Invalid destination: {e}"))?;
        if canonical_dest == source {
            return Err(CommandError::Validation {
                field: "destination".to_string(),
                reason: "Destination is the same file as the asset".to_string(),
            });
        }
    } else {
        let parent = dest
            .parent()
            .ok_or("Invalid destination: no parent directory")?;
        if !parent.exists() {
            return Err(CommandError::Validation {
                field: "destination".to_string(),
                reason: "Destination folder does not exist".to_string(),
            });
        }
    }

    fs::copy(&source, &dest).map_err(|e| format!("Failed to export asset: {e}"))?;

    Ok(dest.to_string_lossy().to_string())
}

/// Export (download) an asset: copy it out of the project's assets folder to a
/// caller-supplied absolute destination path (chosen via a native save dialog).
/// Returns the destination path that was written.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn export_asset(
    project_path: String,
    asset_path: String,
    destination: String,
    overwrite: bool,
) -> Result<String, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let project = resolve_workspace_path(&repo_root);
    let root_dir = assets_root_dir(&repo_root, &project);

    export_asset_to(&root_dir, &asset_path, &destination, overwrite)
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

    /// Temp assets root containing `logo.png`, plus an empty output dir.
    fn export_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("public");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("logo.png"), b"png-bytes").unwrap();
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        (tmp, root, out)
    }

    #[test]
    fn export_asset_copies_file_to_destination() {
        let (_tmp, root, out) = export_fixture();
        let dest = out.join("logo.png");

        let written = export_asset_to(&root, "logo.png", &dest.to_string_lossy(), false).unwrap();

        assert_eq!(written, dest.to_string_lossy());
        assert_eq!(std::fs::read(&dest).unwrap(), b"png-bytes");
        // Source is untouched.
        assert_eq!(std::fs::read(root.join("logo.png")).unwrap(), b"png-bytes");
    }

    #[test]
    fn export_asset_rejects_path_traversal() {
        let (tmp, root, out) = export_fixture();
        std::fs::write(tmp.path().join("secret.txt"), b"secret").unwrap();
        let dest = out.join("secret.txt");

        let err = export_asset_to(&root, "../secret.txt", &dest.to_string_lossy(), false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("traversal"), "unexpected error: {err}");
        assert!(!dest.exists());
    }

    #[test]
    fn export_asset_refuses_existing_destination_without_overwrite() {
        let (_tmp, root, out) = export_fixture();
        let dest = out.join("logo.png");
        std::fs::write(&dest, b"pre-existing").unwrap();

        let err = export_asset_to(&root, "logo.png", &dest.to_string_lossy(), false).unwrap_err();
        assert!(matches!(err, CommandError::Validation { .. }));
        // Untouched without overwrite…
        assert_eq!(std::fs::read(&dest).unwrap(), b"pre-existing");

        // …replaced with overwrite.
        export_asset_to(&root, "logo.png", &dest.to_string_lossy(), true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"png-bytes");
    }

    #[test]
    fn export_asset_rejects_relative_destination() {
        let (_tmp, root, _out) = export_fixture();
        let err = export_asset_to(&root, "logo.png", "relative/logo.png", false).unwrap_err();
        assert!(matches!(err, CommandError::Validation { .. }));
    }

    #[test]
    fn export_asset_rejects_directories() {
        let (_tmp, root, out) = export_fixture();
        std::fs::create_dir_all(root.join("images")).unwrap();
        let dest = out.join("images");

        let err = export_asset_to(&root, "images", &dest.to_string_lossy(), false).unwrap_err();
        assert!(matches!(err, CommandError::Validation { .. }));
    }
}
