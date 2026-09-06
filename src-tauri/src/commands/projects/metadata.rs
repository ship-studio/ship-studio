//! Project metadata read/write commands.
//!
//! Generic read/write of `.shipstudio/project.json`, plus the `has_vercel_config`
//! check. Per-topic metadata accessors live in sibling modules (`ui_state`,
//! `dev_server`).

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION};
use crate::utils::validate_project_path;

/// Persist `metadata` to `<project>/.shipstudio/project.json`, creating the
/// `.shipstudio` directory as needed.
///
/// Shared by every project.json writer (metadata, ui_state, dev_server,
/// shopify, thumbnail) so filesystem failures classify identically through
/// `classify_fs_error`: macOS TCC EPERM, Windows access-denied, and read-only
/// volumes become actionable `Expected` errors instead of a bare "Operation
/// not permitted (os error 1)" reaching telemetry (issue #625).
pub(crate) fn save_project_metadata(
    project: &std::path::Path,
    metadata: &ProjectMetadata,
) -> Result<(), CommandError> {
    let shipstudio_dir = project.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| {
            crate::utils::classify_fs_error(
                "create this project's .shipstudio folder",
                &shipstudio_dir,
                &e,
            )
        })?;
    }

    let metadata_path = shipstudio_dir.join("project.json");
    let contents = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| crate::utils::classify_fs_error("write project metadata", &metadata_path, &e))
}

/// Read `.shipstudio/project.json`, migrating it in place if the schema moved.
///
/// The synchronous half of [`read_project_metadata`], so non-command callers
/// (hosting link resolution, for one) share the same parse-and-migrate path
/// rather than re-implementing it and drifting.
pub(crate) fn read_project_metadata_sync(
    project: &std::path::Path,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path).map_err(|e| {
        crate::utils::classify_fs_error("read project metadata", &metadata_path, &e)
    })?;

    let mut metadata: ProjectMetadata = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        save_project_metadata(project, &metadata)?;
    }

    Ok(Some(metadata))
}

/// Reads project metadata from .shipstudio/project.json with automatic schema migration
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn read_project_metadata(
    project_path: String,
) -> Result<Option<ProjectMetadata>, CommandError> {
    let project = validate_project_path(&project_path)?;
    read_project_metadata_sync(&project)
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

    // Ensure schema_version is current when writing
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;

    save_project_metadata(&project, &metadata)
}

/// Checks whether a project has a `.vercel/project.json` config file.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn has_vercel_config(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(project.join(".vercel").join("project.json").exists())
}

#[cfg(test)]
mod save_project_metadata_tests {
    use super::*;

    #[test]
    fn roundtrips_metadata_and_creates_shipstudio_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let metadata = ProjectMetadata {
            custom_dev_command: Some("bun dev".to_string()),
            ..Default::default()
        };
        save_project_metadata(tmp.path(), &metadata).unwrap();

        let written = tmp.path().join(".shipstudio").join("project.json");
        let parsed: ProjectMetadata =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        assert_eq!(parsed.custom_dev_command.as_deref(), Some("bun dev"));
    }

    // The #625 shape: a write failure must route through classify_fs_error
    // (labeled with action + path), never a bare OS string.
    #[test]
    #[cfg(unix)]
    fn write_failure_is_labeled() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        // Pre-create .shipstudio, then make it unwritable so fs::write fails.
        let dir = tmp.path().join(".shipstudio");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let err = save_project_metadata(tmp.path(), &ProjectMetadata::default()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("project metadata"), "got: {msg}");
        assert!(msg.contains("project.json"), "got: {msg}");

        // Restore so TempDir cleanup can delete it.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
