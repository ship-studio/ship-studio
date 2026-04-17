//! Dev server lifecycle commands.
//!
//! Per-project dev server configuration (custom command, port) stored in
//! `.shipstudio/project.json`, plus cache-clearing used when restarting the
//! dev server to force a fresh build.

use crate::errors::CommandError;
use crate::types::ProjectMetadata;
use crate::utils::validate_project_path;

/// Gets the custom dev command for a project (for generic projects)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_custom_dev_command(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.custom_dev_command)
}

/// Sets the custom dev command for a project (for generic projects)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_custom_dev_command(
    project_path: String,
    command: Option<String>,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.custom_dev_command = command;

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Gets the dev server port for a project (returns None if not configured, meaning use default 3000)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_dev_server_port(project_path: String) -> Result<Option<u16>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.dev_server_port)
}

/// Sets the dev server port for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_dev_server_port(project_path: String, port: u16) -> Result<(), CommandError> {
    if port == 0 {
        return Err(("Port must be between 1 and 65535".to_string()).into());
    }

    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.dev_server_port = Some(port);

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Clears project cache directories (.next, node_modules/.cache, etc.)
/// Used when restarting the dev server to ensure a fresh build.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn clear_project_cache(project_path: String) -> Result<(), CommandError> {
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
