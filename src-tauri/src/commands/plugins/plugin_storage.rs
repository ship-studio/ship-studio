/**
 * Plugin storage, shell execution, and dev-link commands.
 *
 * - read/write_plugin_storage: per-plugin JSON key-value storage
 * - exec_plugin_shell: sandboxed shell command execution in plugin context
 * - link/unlink_dev_plugin: local development plugin management
 */
use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use super::{
    check_min_app_version, get_plugins_dir, get_storage_lock, get_storage_path, now_ms,
    read_manifest, read_registry, validate_required_commands, warn_on_setup_items, write_registry,
    PluginInfo, RegistryEntry, ShellResult,
};

/// Read plugin storage data
///
/// Storage is at {project}/.shipstudio/plugins/{plugin-id}/storage.json
/// Acquires a per-plugin lock to prevent races with concurrent writes.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn read_plugin_storage(
    plugin_id: String,
    project_path: String,
) -> Result<serde_json::Value, CommandError> {
    let lock = get_storage_lock(&plugin_id, &project_path);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Storage lock poisoned: {e}"))?;

    let storage_path = get_storage_path(&plugin_id, &project_path)?;

    if !storage_path.exists() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }

    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read plugin storage: {e}"))?;

    serde_json::from_str(&content).map_err(|e| CommandError::Other {
        message: format!("Failed to parse plugin storage: {e}"),
    })
}

/// Write plugin storage data
///
/// Acquires a per-plugin lock to prevent concurrent read-modify-write races.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn write_plugin_storage(
    plugin_id: String,
    project_path: String,
    data: serde_json::Value,
) -> Result<(), CommandError> {
    let lock = get_storage_lock(&plugin_id, &project_path);
    let _guard = lock
        .lock()
        .map_err(|e| format!("Storage lock poisoned: {e}"))?;

    let storage_path = get_storage_path(&plugin_id, &project_path)?;

    // Ensure parent directory exists
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create storage directory: {e}"))?;
    }

    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize storage data: {e}"))?;

    fs::write(&storage_path, content).map_err(|e| CommandError::Io {
        message: format!("Failed to write plugin storage: {e}"),
    })
}

/// Execute a shell command in a plugin's context
///
/// Security: validates project_path, uses extended PATH, enforces configurable timeout (default 120s).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn exec_plugin_shell(
    plugin_id: String,
    project_path: String,
    command: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, CommandError> {
    // Validate the project path for security
    let validated_path = validate_project_path(&project_path)?;

    // Validate plugin exists in this project
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    let plugin_exists = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path).exists()
        } else {
            get_plugins_dir(&project_path)?.join(&plugin_id).exists()
        }
    } else {
        false
    };
    if !plugin_exists {
        return Err((format!("Plugin '{plugin_id}' not found")).into());
    }

    // Build and execute command with timeout
    let timeout = timeout_secs.unwrap_or(120);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        tokio::task::spawn_blocking(move || {
            create_command(&command)
                .args(&args)
                .current_dir(&validated_path)
                .env("PATH", get_extended_path())
                .env(
                    "HOME",
                    dirs::home_dir()
                        .map(|h| h.to_string_lossy().to_string())
                        .unwrap_or_default(),
                )
                .output()
        }),
    )
    .await
    .map_err(|_| format!("Plugin shell command timed out ({timeout}s)"))?
    .map_err(|e| format!("Failed to spawn command: {e}"))?
    .map_err(|e| format!("Failed to execute command: {e}"))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Link a local dev plugin folder into a project.
///
/// Opens a native folder picker, validates the selected folder has plugin.json and dist/index.js,
/// then registers it in the project's plugin registry as a dev plugin.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn link_dev_plugin(
    app: AppHandle,
    project_path: String,
) -> Result<Option<PluginInfo>, CommandError> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select Plugin Folder")
        .blocking_pick_folder();

    let folder_path = match folder {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid folder path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    // Validate plugin.json exists
    let manifest = read_manifest(&folder_path)?;

    warn_on_setup_items(&manifest);

    // Validate dist/index.js exists
    let bundle_path = folder_path.join("dist").join("index.js");
    if !bundle_path.exists() {
        return Err((format!(
            "Plugin bundle not found at {}/dist/index.js. Did you run the build?",
            folder_path.display()
        ))
        .into());
    }

    // Validate manifest has required fields
    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err(("Plugin manifest must have 'id' and 'name' fields".to_string()).into());
    }

    // Validate plugin ID is safe for filesystem
    if manifest.id.contains('/')
        || manifest.id.contains('\\')
        || manifest.id.contains("..")
        || manifest.id.starts_with('.')
    {
        return Err(("Plugin ID contains invalid characters".to_string()).into());
    }

    // Check min_app_version compatibility
    check_min_app_version(&manifest, &app)?;

    // Validate required_commands are all in the allowed set
    validate_required_commands(&manifest)?;

    // Check for existing plugin with same ID
    let mut registry = read_registry(&project_path)?;
    if registry
        .plugins
        .iter()
        .any(|e| e.plugin_id == manifest.id && !e.is_dev)
    {
        return Err((format!(
            "A non-dev plugin '{}' is already installed. Uninstall it first.",
            manifest.id
        ))
        .into());
    }

    // Remove existing dev entry for this plugin if present (re-link)
    registry.plugins.retain(|e| e.plugin_id != manifest.id);

    let local_path = folder_path.to_string_lossy().to_string();
    let entry = RegistryEntry {
        plugin_id: manifest.id.clone(),
        enabled: true,
        installed_at: now_ms(),
        source_url: String::new(),
        installed_commit: String::new(),
        is_dev: true,
        local_path: local_path.clone(),
    };

    registry.plugins.push(entry);
    write_registry(&project_path, &registry)?;

    Ok(Some(PluginInfo {
        manifest,
        enabled: true,
        installed_at: now_ms(),
        source_url: String::new(),
        is_dev: true,
        local_path,
    }))
}

/// Unlink a dev plugin from a project.
///
/// Removes the plugin from the registry only. Does NOT delete local files.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn unlink_dev_plugin(project_path: String, plugin_id: String) -> Result<(), CommandError> {
    let mut registry = read_registry(&project_path)?;

    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);
    match entry {
        Some(e) if !e.is_dev => {
            return Err(("Plugin is not a dev plugin. Use uninstall instead.".to_string()).into());
        }
        None => {
            return Err((format!("Plugin '{plugin_id}' not found")).into());
        }
        _ => {}
    }

    // Remove from registry (does not touch local files)
    registry.plugins.retain(|e| e.plugin_id != plugin_id);
    write_registry(&project_path, &registry)?;

    // Clean up storage.json in project plugins dir if it exists
    let plugins_dir = get_plugins_dir(&project_path)?;
    let storage_path = plugins_dir.join(&plugin_id).join("storage.json");
    if storage_path.exists() {
        let _ = fs::remove_file(&storage_path);
    }
    // Remove the plugin_id directory in plugins dir if it's empty
    let plugin_data_dir = plugins_dir.join(&plugin_id);
    if plugin_data_dir.exists() {
        let _ = fs::remove_dir(&plugin_data_dir); // only removes if empty
    }

    Ok(())
}
