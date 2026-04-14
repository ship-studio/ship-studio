//! Project metadata read/write commands.
//!
//! Generic read/write of `.shipstudio/project.json`, plus the `has_vercel_config`
//! check. Per-topic metadata accessors live in sibling modules (`ui_state`,
//! `dev_server`).

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION};
use crate::utils::validate_project_path;

/// Reads project metadata from .shipstudio/project.json with automatic schema migration
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn read_project_metadata(
    project_path: String,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read project metadata: {e}"))?;

    let mut metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        let updated_contents = serde_json::to_string_pretty(&metadata)
            .map_err(|e| format!("Failed to serialize migrated metadata: {e}"))?;
        std::fs::write(&metadata_path, updated_contents)
            .map_err(|e| format!("Failed to save migrated metadata: {e}"))?;
    }

    Ok(Some(metadata))
}

/// Writes project metadata to .shipstudio/project.json
/// Always ensures the schema_version is set to the current version.
#[tauri::command]
#[tracing::instrument(skip(metadata), fields(project = %project_path))]
pub async fn write_project_metadata(
    project_path: String,
    mut metadata: ProjectMetadata,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    // Ensure schema_version is current when writing
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;

    let metadata_path = shipstudio_dir.join("project.json");
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;

    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

/// Checks whether a project has a `.vercel/project.json` config file.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn has_vercel_config(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(project.join(".vercel").join("project.json").exists())
}
