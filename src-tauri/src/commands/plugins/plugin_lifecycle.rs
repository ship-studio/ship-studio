/**
 * Plugin lifecycle commands: listing, installing, uninstalling, updating, and toggling plugins.
 */
use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use super::{
    check_min_app_version, get_plugins_dir, now_ms, read_git_head, read_manifest, read_registry,
    validate_required_commands, warn_on_setup_items, write_registry, PluginInfo, PluginUpdateCheck,
    RegistryEntry,
};

/// List all installed plugins for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_plugins(project_path: String) -> Result<Vec<PluginInfo>, CommandError> {
    let registry = read_registry(&project_path)?;
    let plugins_dir = get_plugins_dir(&project_path)?;
    let mut results = Vec::new();

    for entry in &registry.plugins {
        let plugin_dir = if entry.is_dev {
            PathBuf::from(&entry.local_path)
        } else {
            plugins_dir.join(&entry.plugin_id)
        };
        match read_manifest(&plugin_dir) {
            Ok(manifest) => {
                results.push(PluginInfo {
                    manifest,
                    enabled: entry.enabled,
                    installed_at: entry.installed_at,
                    source_url: entry.source_url.clone(),
                    is_dev: entry.is_dev,
                    local_path: entry.local_path.clone(),
                });
            }
            Err(e) => {
                tracing::warn!("Skipping plugin {}: {}", entry.plugin_id, e);
            }
        }
    }

    Ok(results)
}

/// Install a plugin from a GitHub repository URL into a project
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn install_plugin(
    app: AppHandle,
    project_path: String,
    repo_url: String,
) -> Result<PluginInfo, CommandError> {
    let plugins_dir = get_plugins_dir(&project_path)?;
    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create plugins dir: {e}"))?;

    // Clone into a temp directory first, then move
    let temp_dir = plugins_dir.join(".tmp-install");
    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }

    let output = create_command("git")
        .args([
            "clone",
            "--depth",
            "1",
            &repo_url,
            &temp_dir.to_string_lossy(),
        ])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_dir_all(&temp_dir);
        return Err((format!("Git clone failed: {stderr}")).into());
    }

    // Read manifest to get plugin ID
    let manifest = match read_manifest(&temp_dir) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err((format!("Invalid plugin: {e}")).into());
        }
    };

    warn_on_setup_items(&manifest);

    // Validate manifest has required fields
    if manifest.id.is_empty() || manifest.name.is_empty() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(("Plugin manifest must have 'id' and 'name' fields".to_string()).into());
    }

    // Validate plugin ID is safe for filesystem
    if manifest.id.contains('/')
        || manifest.id.contains('\\')
        || manifest.id.contains("..")
        || manifest.id.starts_with('.')
    {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(("Plugin ID contains invalid characters".to_string()).into());
    }

    // Check min_app_version compatibility
    if let Err(e) = check_min_app_version(&manifest, &app) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e.into());
    }

    // Validate required_commands are all in the allowed set
    if let Err(e) = validate_required_commands(&manifest) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(e.into());
    }

    let plugin_dir = plugins_dir.join(&manifest.id);

    // Remove existing version if present
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove existing plugin: {e}"))?;
    }

    // Move temp to final location
    fs::rename(&temp_dir, &plugin_dir).map_err(|e| {
        let _ = fs::remove_dir_all(&temp_dir);
        format!("Failed to move plugin to final location: {e}")
    })?;

    // Read commit hash before removing .git
    let commit_hash = read_git_head(&plugin_dir);

    // Remove .git directory (no need to keep it)
    let git_dir = plugin_dir.join(".git");
    if git_dir.exists() {
        let _ = fs::remove_dir_all(&git_dir);
    }

    // Update registry
    let mut registry = read_registry(&project_path)?;

    // Remove old entry if exists
    registry.plugins.retain(|e| e.plugin_id != manifest.id);

    let entry = RegistryEntry {
        plugin_id: manifest.id.clone(),
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url.clone(),
        installed_commit: commit_hash,
        is_dev: false,
        local_path: String::new(),
    };

    registry.plugins.push(entry);
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Uninstall a plugin by its ID from a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn uninstall_plugin(project_path: String, plugin_id: String) -> Result<(), CommandError> {
    // Guard: dev plugins should use unlink instead
    let registry = read_registry(&project_path)?;
    if let Some(entry) = registry.plugins.iter().find(|e| e.plugin_id == plugin_id) {
        if entry.is_dev {
            return Err(
                ("Dev plugins cannot be uninstalled. Use Unlink instead.".to_string()).into(),
            );
        }
    }

    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    // Remove plugin directory
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove plugin directory: {e}"))?;
    }

    // Update registry
    let mut registry = read_registry(&project_path)?;
    registry.plugins.retain(|e| e.plugin_id != plugin_id);
    write_registry(&project_path, &registry)?;

    Ok(())
}

/// Update a plugin by pulling latest from its source repository
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn update_plugin(
    app: AppHandle,
    project_path: String,
    plugin_id: String,
) -> Result<PluginInfo, CommandError> {
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' not found in registry"))?;

    let source_url = entry.source_url.clone();
    let was_enabled = entry.enabled;

    // Re-install from source (clean install)
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir).map_err(|e| format!("Failed to remove old plugin: {e}"))?;
    }

    // Clone fresh
    let output = create_command("git")
        .args([
            "clone",
            "--depth",
            "1",
            &source_url,
            &plugin_dir.to_string_lossy(),
        ])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Git clone failed: {stderr}")).into());
    }

    // Read commit hash before removing .git
    let commit_hash = read_git_head(&plugin_dir);

    // Remove .git directory
    let git_dir = plugin_dir.join(".git");
    if git_dir.exists() {
        let _ = fs::remove_dir_all(&git_dir);
    }

    let manifest = read_manifest(&plugin_dir)?;

    warn_on_setup_items(&manifest);

    // Check min_app_version compatibility
    check_min_app_version(&manifest, &app)?;

    // Validate required_commands are all in the allowed set
    validate_required_commands(&manifest)?;

    // Update registry entry (preserve enabled state, update commit hash)
    let mut registry = read_registry(&project_path)?;
    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = was_enabled;
        entry.installed_commit = commit_hash;
    }
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: was_enabled,
        installed_at: now_ms(),
        source_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Check if a plugin has an update available by comparing commit hashes
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn check_plugin_update(
    project_path: String,
    plugin_id: String,
) -> Result<PluginUpdateCheck, CommandError> {
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' not found in registry"))?;

    if entry.is_dev {
        return Err(
            "Dev plugins do not support remote update checks. Use Reload instead."
                .to_string()
                .into(),
        );
    }

    let source_url = entry.source_url.clone();
    let installed_commit = entry.installed_commit.clone();

    // Get installed version from manifest
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);
    let manifest = read_manifest(&plugin_dir)?;
    let installed_version = manifest.version.clone();

    // Get remote HEAD commit via git ls-remote
    let output = create_command("git")
        .args(["ls-remote", &source_url, "HEAD"])
        .env("PATH", get_extended_path())
        .output()
        .map_err(|e| format!("Failed to run git ls-remote: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Failed to check remote: {stderr}")).into());
    }

    let remote_output = String::from_utf8_lossy(&output.stdout);
    let remote_commit = remote_output
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    // If we don't have an installed commit hash (legacy install), assume update available
    let has_update = if installed_commit.is_empty() {
        true
    } else {
        !remote_commit.is_empty() && remote_commit != installed_commit
    };

    Ok(PluginUpdateCheck {
        has_update,
        installed_version,
        installed_commit,
        remote_commit,
    })
}

/// Toggle a plugin's enabled state
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn toggle_plugin(
    project_path: String,
    plugin_id: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let mut registry = read_registry(&project_path)?;

    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = enabled;
        write_registry(&project_path, &registry)?;
        Ok(())
    } else {
        Err((format!("Plugin '{plugin_id}' not found")).into())
    }
}
