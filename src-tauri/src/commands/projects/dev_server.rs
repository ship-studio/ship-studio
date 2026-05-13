//! Dev server lifecycle commands.
//!
//! Per-project dev server configuration (custom command, port) stored in
//! `.shipstudio/project.json`, plus cache-clearing used when restarting the
//! dev server to force a fresh build.

use crate::errors::CommandError;
use crate::types::ProjectMetadata;
use crate::utils::{resolve_workspace_path, validate_project_path};
use serde::Serialize;

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

/// Gets the active workspace subpath for a monorepo project, or None if the
/// project is single-package. Returned path uses POSIX separators relative to
/// the project root (e.g. `apps/admin`).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_workspace_subpath(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.workspace_subpath)
}

/// Sets the active workspace subpath. Set to None to unlock (treat as single-package).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_workspace_subpath(
    project_path: String,
    subpath: Option<String>,
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

    metadata.workspace_subpath = subpath;

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

/// Result of checking whether a project's npm/pnpm/yarn dependencies are installed.
#[derive(Debug, Serialize)]
pub struct DependencyStatus {
    /// True when the project either has no `package.json` (nothing to install)
    /// or `node_modules` already exists at the relevant location. False means
    /// the user should be prompted to run an install before the dev server boots.
    pub installed: bool,
    /// True when the project has a `package.json` declaring deps at all.
    /// Lets the frontend tell "no install needed" (generic / static project)
    /// from "install needed, run pnpm install".
    pub has_package_json: bool,
}

/// Check whether a project's dependencies are installed.
///
/// For monorepo projects (workspace_subpath set), we look at the repo root —
/// pnpm/npm/yarn workspaces always install from the root and `node_modules`
/// lives there (or per-workspace under pnpm, but the root presence is the
/// reliable signal). Returns `installed: true` for projects without a
/// `package.json` so we don't gate static-html / generic projects.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn check_dependencies_installed(
    project_path: String,
) -> Result<DependencyStatus, CommandError> {
    let repo_root = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&repo_root);

    // Workspaces install at the repo root; single-package projects install in
    // place. Either location is enough to consider deps present.
    let has_package_json =
        repo_root.join("package.json").exists() || workspace.join("package.json").exists();
    if !has_package_json {
        return Ok(DependencyStatus {
            installed: true,
            has_package_json: false,
        });
    }

    let installed =
        repo_root.join("node_modules").exists() || workspace.join("node_modules").exists();
    Ok(DependencyStatus {
        installed,
        has_package_json: true,
    })
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
