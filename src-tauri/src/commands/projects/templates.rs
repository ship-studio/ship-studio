//! Template extraction and export commands.
//!
//! Handles creating new projects from zip templates and exporting
//! existing projects as zip template files.

use super::detection::has_html_files;
use crate::errors::CommandError;
use std::io::{Read, Write};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::ZipArchive;

/// Extracts a zip template file to create a new project.
/// The zip file should contain a single root directory (like GitHub downloads).
/// Returns the path to the created project.
///
/// Accepts either:
/// - `zip_data`: Raw zip bytes (from browser File API)
/// - `zip_path`: Path to a zip file on disk (from Tauri drag-drop)
#[tauri::command]
#[tracing::instrument]
pub async fn extract_template_zip(
    project_name: String,
    zip_data: Option<Vec<u8>>,
    zip_path: Option<String>,
) -> Result<String, CommandError> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    // Ensure ShipStudio directory exists
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create ShipStudio directory: {e}"))?;
    }

    // Sanitize project name
    let safe_name = project_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect::<String>();

    if safe_name.is_empty() {
        return Err(("Invalid project name".to_string()).into());
    }

    let project_path = shipstudio_dir.join(&safe_name);

    // Check if project already exists
    if project_path.exists() {
        return Err((format!("A project named '{safe_name}' already exists")).into());
    }

    // Get zip data either from direct bytes or by reading from path
    let data = if let Some(bytes) = zip_data {
        bytes
    } else if let Some(path) = zip_path {
        std::fs::read(&path).map_err(|e| format!("Failed to read zip file: {e}"))?
    } else {
        return Err(("No zip data or path provided".to_string()).into());
    };

    // Create a cursor from the zip data
    let cursor = std::io::Cursor::new(data);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip file: {e}"))?;

    if archive.is_empty() {
        return Err(("Zip file is empty".to_string()).into());
    }

    // Detect if zip has a single root directory (GitHub-style download)
    // by checking the first entry
    let first_entry_name = archive
        .by_index(0)
        .map_err(|e| format!("Failed to read zip entry: {e}"))?
        .name()
        .to_string();

    let root_prefix = if first_entry_name.contains('/') {
        // Get the root directory name (e.g., "repo-main/")
        let parts: Vec<&str> = first_entry_name.split('/').collect();
        if parts.len() > 1 && !parts[0].is_empty() {
            Some(format!("{}/", parts[0]))
        } else {
            None
        }
    } else {
        None
    };

    // Verify all entries have the same root prefix if we detected one
    let strip_root = if let Some(ref prefix) = root_prefix {
        let all_have_prefix = (0..archive.len()).all(|i| {
            archive
                .by_index(i)
                .map(|f| f.name().starts_with(prefix))
                .unwrap_or(false)
        });
        all_have_prefix
    } else {
        false
    };

    // Create project directory
    std::fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create project directory: {e}"))?;

    // Extract files
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let mut outpath = file.name().to_string();

        // Strip root directory if present
        if strip_root {
            if let Some(ref prefix) = root_prefix {
                outpath = outpath.strip_prefix(prefix).unwrap_or(&outpath).to_string();
            }
        }

        // Skip empty paths (the root directory itself)
        if outpath.is_empty() {
            continue;
        }

        // Security: prevent zip-slip. A substring `..` check is insufficient —
        // an absolute entry name (e.g. `/Users/me/.zshenv`) contains no `..`,
        // and `Path::join` with an absolute path DISCARDS the base, writing
        // outside the project. Reject any entry that isn't a plain relative path
        // (no root, no drive prefix, no `..` component).
        let rel = std::path::Path::new(&outpath);
        let is_safe_relative = rel.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        });
        if !is_safe_relative {
            tracing::warn!(entry = %outpath, "Skipping unsafe zip entry during template extraction");
            continue;
        }

        let dest_path = project_path.join(rel);

        if file.is_dir() {
            std::fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        } else {
            // Ensure parent directory exists
            if let Some(parent) = dest_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent directory: {e}"))?;
                }
            }

            // Extract file
            let mut outfile = std::fs::File::create(&dest_path)
                .map_err(|e| format!("Failed to create file: {e}"))?;

            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| format!("Failed to read file from zip: {e}"))?;

            outfile
                .write_all(&buffer)
                .map_err(|e| format!("Failed to write file: {e}"))?;

            // Set executable permission for scripts on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    if mode & 0o111 != 0 {
                        // Has execute bit. Set a fixed 0o755 rather than the
                        // raw archive mode so a malicious template can't ship a
                        // setuid/setgid binary.
                        let mut perms = std::fs::metadata(&dest_path)
                            .map_err(|e| format!("Failed to get file metadata: {e}"))?
                            .permissions();
                        perms.set_mode(0o755);
                        std::fs::set_permissions(&dest_path, perms).ok();
                    }
                }
            }
        }
    }

    // Verify it's a valid project (has package.json, HTML files, or a
    // Shopify theme layout)
    if !project_path.join("package.json").exists()
        && !has_html_files(&project_path)
        && !project_path.join("layout").join("theme.liquid").exists()
    {
        // Clean up invalid project
        std::fs::remove_dir_all(&project_path).ok();
        return Err("Invalid template: no package.json, .html files, or Shopify theme layout found. Please use a valid project template."
            .to_string()
            .into());
    }

    Ok(project_path.to_string_lossy().to_string())
}

/// Directories to exclude when exporting a project as a template
const EXPORT_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".shipstudio",
    ".next",
    ".vercel",
    "dist",
    "build",
    ".turbo",
    ".cache",
    ".svelte-kit",
    ".nuxt",
    ".output",
    "out",
];

/// Exports a project as a zip template file.
/// Opens a save dialog for the user to choose the destination.
/// Returns the path to the saved file, or None if cancelled.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn export_project_as_template(
    app: AppHandle,
    project_path: String,
) -> Result<Option<String>, CommandError> {
    let project = std::path::PathBuf::from(&project_path);

    // Validate project exists
    if !project.exists() {
        return Err(("Project does not exist".to_string()).into());
    }

    // Get project name for default filename
    let project_name = project
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let default_filename = format!("{project_name}-template.zip");

    // Open save dialog
    let file_path = app
        .dialog()
        .file()
        .set_file_name(&default_filename)
        .add_filter("Zip Archive", &["zip"])
        .blocking_save_file();

    let save_path = match file_path {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid file path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    // Create the zip file
    let file =
        std::fs::File::create(&save_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // Walk the project directory
    for entry in WalkDir::new(&project) {
        let entry = entry.map_err(|e| format!("Failed to read directory: {e}"))?;
        let path = entry.path();

        // Get relative path from project root
        let relative_path = path
            .strip_prefix(&project)
            .map_err(|e| format!("Failed to get relative path: {e}"))?;

        // Skip if empty path (the root itself)
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        // Check if this path should be excluded
        let should_exclude = relative_path.components().any(|component| {
            if let std::path::Component::Normal(name) = component {
                if let Some(name_str) = name.to_str() {
                    return EXPORT_EXCLUDED_DIRS.contains(&name_str);
                }
            }
            false
        });

        if should_exclude {
            continue;
        }

        let relative_path_str = relative_path.to_string_lossy();

        if path.is_dir() {
            // Add directory entry
            zip.add_directory(format!("{relative_path_str}/"), options)
                .map_err(|e| format!("Failed to add directory to zip: {e}"))?;
        } else {
            // Add file entry
            zip.start_file(&relative_path_str, options)
                .map_err(|e| format!("Failed to start file in zip: {e}"))?;

            let mut file_content = Vec::new();
            std::fs::File::open(path)
                .map_err(|e| format!("Failed to open file: {e}"))?
                .read_to_end(&mut file_content)
                .map_err(|e| format!("Failed to read file: {e}"))?;

            zip.write_all(&file_content)
                .map_err(|e| format!("Failed to write file to zip: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip file: {e}"))?;

    Ok(Some(save_path.to_string_lossy().to_string()))
}
