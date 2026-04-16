/**
 * Plugin management commands for Ship Studio.
 *
 * Plugins are project-level: each project has its own plugins directory
 * at <project>/.shipstudio/plugins/.
 *
 * Provides commands for:
 * - Listing, installing, uninstalling, and updating plugins
 * - Reading plugin bundles (JS source) for frontend loading
 * - Executing shell commands in plugin context with sandboxing
 * - Plugin-scoped storage
 *
 * Plugin storage locations:
 * - Registry: {project}/.shipstudio/plugins/registry.json
 * - Plugin files: {project}/.shipstudio/plugins/{plugin-id}/ (plugin.json, dist/, icon.svg)
 * - Plugin data: {project}/.shipstudio/plugins/{plugin-id}/storage.json
 */
mod plugin_lifecycle;
mod plugin_storage;

pub use plugin_lifecycle::*;
pub use plugin_storage::*;

use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::AppHandle;

/// Per-plugin storage locks to prevent concurrent read-modify-write races.
/// Key: "project_path:plugin_id"
static STORAGE_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Acquire a lock for a specific plugin's storage file.
pub(crate) fn get_storage_lock(plugin_id: &str, project_path: &str) -> Arc<Mutex<()>> {
    let key = format!("{project_path}:{plugin_id}");
    let mut locks = STORAGE_LOCKS.lock().expect("STORAGE_LOCKS mutex poisoned");
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Tauri commands that plugins are allowed to invoke via the invoke proxy.
/// Commands not in this list are rejected at runtime (PluginSlot.tsx)
/// and at install time (validate_required_commands).
const PLUGIN_INVOKABLE_COMMANDS: &[&str] = &[
    // Git read operations
    "check_git_has_changes",
    "get_changed_files",
    "get_file_diff",
    "get_branch_status",
    "list_branches",
    "get_current_branch",
    "get_stash_info",
    // Project read operations
    "list_projects",
    "list_pages",
    "read_project_metadata",
    "get_branch_prefix_preference",
    "get_auto_accept_mode",
    // Git write operations
    "commit_changes",
    "create_branch",
    "switch_branch",
    "fetch_all_branches",
    "git_pull",
    // IDE
    "check_ide_availability",
    "open_in_ide",
    "open_url_in_browser",
    // Preview webview
    "create_preview_webview",
    "resize_preview_webview",
    "destroy_preview_webview",
    "navigate_preview_webview",
    // Plugin self-management
    "read_plugin_storage",
    "write_plugin_storage",
    "read_plugin_manifest",
];

/// Warn if a plugin declares setup items (reserved, not yet implemented).
pub(crate) fn warn_on_setup_items(manifest: &PluginManifest) {
    if !manifest.setup.is_empty() {
        tracing::warn!(
            "Plugin '{}' declares {} setup item(s), but plugin setup is not yet implemented. \
             The 'setup' field is reserved for future use.",
            manifest.id,
            manifest.setup.len()
        );
    }
}

/// Validate that all required_commands in the manifest are in the allowed list.
pub(crate) fn validate_required_commands(manifest: &PluginManifest) -> Result<(), String> {
    let allowed: std::collections::HashSet<&str> =
        PLUGIN_INVOKABLE_COMMANDS.iter().copied().collect();
    let invalid: Vec<&str> = manifest
        .required_commands
        .iter()
        .map(|s| s.as_str())
        .filter(|cmd| !allowed.contains(cmd))
        .collect();

    if !invalid.is_empty() {
        return Err(format!(
            "Plugin '{}' requests commands that are not available to plugins: {}",
            manifest.id,
            invalid.join(", ")
        ));
    }
    Ok(())
}

/// Check that a plugin's min_app_version is satisfied by the current app version.
/// Returns Ok(()) if compatible, Err with a message if not.
pub(crate) fn check_min_app_version(
    manifest: &PluginManifest,
    app: &AppHandle,
) -> Result<(), String> {
    let min_ver_str = manifest.min_app_version.trim();
    if min_ver_str.is_empty() {
        return Ok(());
    }

    let min_ver = semver::Version::parse(min_ver_str)
        .map_err(|e| format!("Invalid min_app_version '{min_ver_str}' in plugin manifest: {e}"))?;

    let app_ver_str = app.package_info().version.to_string();
    let app_ver = semver::Version::parse(&app_ver_str)
        .map_err(|e| format!("Failed to parse app version '{app_ver_str}': {e}"))?;

    if app_ver < min_ver {
        return Err(format!(
            "Plugin '{}' requires Ship Studio v{} or later (current: v{}). Please update Ship Studio.",
            manifest.name, min_ver, app_ver
        ));
    }

    Ok(())
}

// ── Data types ──────────────────────────────────────────────────────────────

/// Plugin manifest from plugin.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginManifest {
    /// Unique plugin identifier (e.g., "hello-world")
    pub id: String,
    /// Display name
    pub name: String,
    /// Plugin version (semver)
    pub version: String,
    /// Short description
    pub description: String,
    /// UI slots this plugin renders into
    #[serde(default)]
    pub slots: Vec<String>,
    /// Plugin author
    #[serde(default)]
    pub author: String,
    /// Source repository URL
    #[serde(default)]
    pub repository: String,
    /// Setup items this plugin contributes to onboarding
    #[serde(default)]
    pub setup: Vec<PluginSetupItem>,
    /// Minimum Ship Studio version required
    #[serde(default)]
    pub min_app_version: String,
    /// Icon filename (relative to plugin dir)
    #[serde(default)]
    pub icon: String,
    /// Tauri commands this plugin is allowed to invoke
    #[serde(default)]
    pub required_commands: Vec<String>,
    /// Plugin API version. 0 = legacy/unversioned, 1 = first stable version.
    #[serde(default)]
    pub api_version: u32,
}

/// A setup item contributed by a plugin
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginSetupItem {
    /// Item identifier (will be prefixed with plugin id)
    pub id: String,
    /// Display label
    pub label: String,
    /// IDs of items this depends on
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Shell command to check if ready
    #[serde(default)]
    pub check_command: String,
    /// Shell command to install
    #[serde(default)]
    pub install_command: String,
}

/// Plugin info returned to frontend (manifest + registry state)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginInfo {
    /// Plugin manifest data
    pub manifest: PluginManifest,
    /// Whether the plugin is enabled
    pub enabled: bool,
    /// When the plugin was installed (Unix ms)
    pub installed_at: u64,
    /// Source repository URL used for install
    pub source_url: String,
    /// Whether this is a dev-linked plugin
    #[serde(default)]
    pub is_dev: bool,
    /// Local filesystem path for dev plugins
    #[serde(default)]
    pub local_path: String,
}

/// Registry entry stored in registry.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct RegistryEntry {
    pub(crate) plugin_id: String,
    pub(crate) enabled: bool,
    pub(crate) installed_at: u64,
    pub(crate) source_url: String,
    /// Git commit hash at time of install/update (for update checking)
    #[serde(default)]
    pub(crate) installed_commit: String,
    /// Whether this is a dev-linked plugin
    #[serde(default)]
    pub(crate) is_dev: bool,
    /// Local filesystem path for dev plugins
    #[serde(default)]
    pub(crate) local_path: String,
}

/// Result of checking for a plugin update
#[derive(Debug, Serialize, Clone)]
pub struct PluginUpdateCheck {
    pub has_update: bool,
    pub installed_version: String,
    pub installed_commit: String,
    pub remote_commit: String,
}

/// The registry file format
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct Registry {
    pub(crate) plugins: Vec<RegistryEntry>,
}

/// Result of a shell command execution
#[derive(Debug, Serialize, Clone)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/// Get the plugins directory for a project: <project>/.shipstudio/plugins/
pub(crate) fn get_plugins_dir(project_path: &str) -> Result<PathBuf, String> {
    let validated = validate_project_path(project_path)?;
    Ok(validated.join(".shipstudio").join("plugins"))
}

/// Read the plugin registry for a project
pub(crate) fn read_registry(project_path: &str) -> Result<Registry, String> {
    let plugins_dir = get_plugins_dir(project_path)?;
    let registry_path = plugins_dir.join("registry.json");

    if !registry_path.exists() {
        return Ok(Registry::default());
    }

    let content =
        fs::read_to_string(&registry_path).map_err(|e| format!("Failed to read registry: {e}"))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse registry: {e}"))
}

/// Write the plugin registry for a project
pub(crate) fn write_registry(project_path: &str, registry: &Registry) -> Result<(), String> {
    let plugins_dir = get_plugins_dir(project_path)?;
    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create plugins dir: {e}"))?;

    let registry_path = plugins_dir.join("registry.json");
    let content = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize registry: {e}"))?;

    fs::write(&registry_path, content).map_err(|e| format!("Failed to write registry: {e}"))
}

/// Read a plugin's manifest from its directory
pub(crate) fn read_manifest(plugin_dir: &std::path::Path) -> Result<PluginManifest, String> {
    let manifest_path = plugin_dir.join("plugin.json");
    if !manifest_path.exists() {
        return Err(format!("No plugin.json found in {}", plugin_dir.display()));
    }

    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read plugin.json: {e}"))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse plugin.json: {e}"))
}

/// Read the HEAD commit hash from a git repo directory
pub(crate) fn read_git_head(repo_dir: &PathBuf) -> String {
    let output = create_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_dir)
        .env("PATH", get_extended_path())
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Get current timestamp in milliseconds
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Get the storage file path for a plugin
pub(crate) fn get_storage_path(plugin_id: &str, project_path: &str) -> Result<PathBuf, String> {
    // Validate plugin_id is safe
    if plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
        || plugin_id.starts_with('.')
    {
        return Err("Invalid plugin ID".to_string());
    }

    let plugins_dir = get_plugins_dir(project_path)?;
    Ok(plugins_dir.join(plugin_id).join("storage.json"))
}

/// Read the JavaScript bundle for a plugin (dist/index.js)
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn read_plugin_bundle(project_path: String, plugin_id: String) -> Result<String, CommandError> {
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);

    let bundle_path = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path)
                .join("dist")
                .join("index.js")
        } else {
            get_plugins_dir(&project_path)?
                .join(&plugin_id)
                .join("dist")
                .join("index.js")
        }
    } else {
        get_plugins_dir(&project_path)?
            .join(&plugin_id)
            .join("dist")
            .join("index.js")
    };

    if !bundle_path.exists() {
        return Err((format!("Plugin bundle not found: {}", bundle_path.display())).into());
    }

    fs::read_to_string(&bundle_path).map_err(|e| CommandError::Io {
        message: format!("Failed to read plugin bundle: {e}"),
    })
}

/// Read a plugin's manifest
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn read_plugin_manifest(
    project_path: String,
    plugin_id: String,
) -> Result<PluginManifest, CommandError> {
    let registry = read_registry(&project_path)?;
    let entry = registry.plugins.iter().find(|e| e.plugin_id == plugin_id);

    let plugin_dir = if let Some(entry) = entry {
        if entry.is_dev {
            PathBuf::from(&entry.local_path)
        } else {
            get_plugins_dir(&project_path)?.join(&plugin_id)
        }
    } else {
        get_plugins_dir(&project_path)?.join(&plugin_id)
    };

    read_manifest(&plugin_dir).map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_registry() {
        let registry = Registry::default();
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_parse_manifest() {
        let json = r#"{
            "id": "hello-world",
            "name": "Hello World",
            "version": "1.0.0",
            "description": "A test plugin",
            "slots": ["toolbar"]
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.id, "hello-world");
        assert_eq!(manifest.name, "Hello World");
        assert_eq!(manifest.slots, vec!["toolbar"]);
        assert!(manifest.author.is_empty());
    }

    #[test]
    fn test_parse_manifest_minimal() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "0.1.0",
            "description": "Minimal"
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.id, "test");
        assert!(manifest.slots.is_empty());
        assert!(manifest.setup.is_empty());
    }

    #[test]
    fn test_storage_path_invalid_plugin_id() {
        let result = get_storage_path("../evil", "/tmp/test");
        assert!(result.is_err());

        let result = get_storage_path(".hidden", "/tmp/test");
        assert!(result.is_err());
    }
}
