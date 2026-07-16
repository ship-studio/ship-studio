//! # Shared Libraries Commands ("attached libraries" internally)
//!
//! Shared libraries are local directories the user registers once per
//! workspace and Ship Studio rides along into every agent session in that
//! workspace via the agent's additional-directory flag (e.g. Claude Code's
//! `--add-dir`). The directory's skills load and its files become readable,
//! but its `CLAUDE.md` is deliberately NOT loaded, so a library can't hijack
//! the project's own instructions.
//!
//! Libraries are scoped per workspace (account): a per-client workspace
//! carries its own set. Every command operates on the active workspace,
//! resolved backend-side so the frontend can't act on a stale id.
//!
//! The registry mirrors [`super::external_projects`]: a small JSON file under
//! `~/ShipStudio/.shipstudio`, populated only through a native folder picker so
//! a compromised webview can't silently attach a sensitive directory. The
//! selected path rides into the agent as a plain CLI argument (not a validated
//! cwd), so no path-root validation is needed here — the picker is the trust
//! boundary.

use crate::commands::accounts::{get_active_account_id, DEFAULT_ACCOUNT_ID};
use crate::errors::CommandError;
use crate::types::{
    AttachedLibrariesConfig, AttachedLibrary, ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

// ============ Helper Functions ============

/// Path to the attached libraries config file.
fn get_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("attached-libraries.json"))
}

/// Load the attached libraries config from disk (empty config if absent).
fn load_config() -> Result<AttachedLibrariesConfig, String> {
    load_config_from(&get_config_path()?)
}

/// Save the attached libraries config to disk.
fn save_config(config: &AttachedLibrariesConfig) -> Result<(), String> {
    save_config_to(&get_config_path()?, config)
}

/// The active workspace (account) id, falling back to the default workspace —
/// libraries must never be unreachable just because account state is unreadable.
fn active_workspace_id() -> String {
    get_active_account_id().unwrap_or_else(|_| DEFAULT_ACCOUNT_ID.to_string())
}

/// Legacy v1 config: one flat, workspace-agnostic list.
#[derive(Deserialize)]
struct AttachedLibrariesConfigV1 {
    libraries: Vec<AttachedLibrary>,
}

/// Read a config from an explicit path — an empty config when the file is
/// absent. A v1 file (flat list, pre-workspace-scoping) is migrated in memory:
/// its libraries land in the default workspace, and the next save persists the
/// v2 shape. Split out from [`load_config`] so it can be unit-tested against a
/// temp file without touching the user's real home directory.
fn load_config_from(config_path: &Path) -> Result<AttachedLibrariesConfig, String> {
    if !config_path.exists() {
        return Ok(AttachedLibrariesConfig {
            schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
            workspaces: HashMap::new(),
        });
    }

    let contents = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read attached libraries config: {e}"))?;

    if let Ok(config) = serde_json::from_str::<AttachedLibrariesConfig>(&contents) {
        if config.schema_version >= 2 {
            return Ok(config);
        }
    }

    let v1: AttachedLibrariesConfigV1 = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse attached libraries config: {e}"))?;
    let mut workspaces = HashMap::new();
    if !v1.libraries.is_empty() {
        workspaces.insert(DEFAULT_ACCOUNT_ID.to_string(), v1.libraries);
    }
    Ok(AttachedLibrariesConfig {
        schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
        workspaces,
    })
}

/// Write a config to an explicit path, creating the parent directory as needed.
/// Split out from [`save_config`] for hermetic unit tests.
fn save_config_to(config_path: &Path, config: &AttachedLibrariesConfig) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {e}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize attached libraries config: {e}"))?;

    std::fs::write(config_path, contents)
        .map_err(|e| format!("Failed to write attached libraries config: {e}"))?;

    Ok(())
}

/// Whether `canonical` is already registered among `libraries`.
fn is_registered(libraries: &[AttachedLibrary], canonical: &Path) -> bool {
    libraries.iter().any(|l| {
        dunce::canonicalize(Path::new(&l.path))
            .map(|c| c == canonical)
            .unwrap_or_else(|_| Path::new(&l.path) == canonical)
    })
}

// ============ Tauri Commands ============

/// List the active workspace's shared libraries (for the management UI).
/// Entries are returned exactly as stored — a directory may no longer exist on
/// disk, which the UI can surface.
#[tauri::command]
#[tracing::instrument]
pub async fn list_attached_libraries() -> Result<Vec<AttachedLibrary>, CommandError> {
    let config = load_config()?;
    Ok(config
        .workspaces
        .get(&active_workspace_id())
        .cloned()
        .unwrap_or_default())
}

/// Canonical paths of the active workspace's shared libraries that currently
/// exist as directories.
///
/// Used at agent-launch to build the additional-directory flags. Missing or
/// non-directory entries are skipped so a moved or deleted library never breaks
/// an agent spawn.
#[tauri::command]
#[tracing::instrument]
pub async fn attached_library_dirs() -> Result<Vec<String>, CommandError> {
    let config = load_config()?;
    let mut dirs = Vec::new();
    if let Some(libraries) = config.workspaces.get(&active_workspace_id()) {
        for lib in libraries {
            if let Ok(canonical) = dunce::canonicalize(Path::new(&lib.path)) {
                if canonical.is_dir() {
                    dirs.push(canonical.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(dirs)
}

/// Open a native folder picker and register the chosen directory as an attached
/// library. Returns the registered path, or `None` if the user cancelled.
///
/// The picker is the trust boundary: a directory can only enter the registry
/// through explicit user selection, never a path supplied by the webview.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn add_attached_library(app: AppHandle) -> Result<Option<String>, CommandError> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select a library folder")
        .blocking_pick_folder();

    let folder_path = match folder {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid folder path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    let canonical = dunce::canonicalize(&folder_path).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical.is_dir() {
        return Err("Selected path is not a folder.".to_string().into());
    }
    let canonical_str = canonical.to_string_lossy().to_string();

    let mut config = load_config()?;
    let libraries = config.workspaces.entry(active_workspace_id()).or_default();
    if is_registered(libraries, &canonical) {
        return Err("This folder is already a shared library in this workspace."
            .to_string()
            .into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    libraries.push(AttachedLibrary {
        path: canonical_str.clone(),
        added_at: now,
    });
    save_config(&config)?;

    Ok(Some(canonical_str))
}

/// Remove a shared library from the active workspace's registry. Does not
/// delete the folder on disk.
#[tauri::command]
#[tracing::instrument]
pub async fn remove_attached_library(path: String) -> Result<(), CommandError> {
    let mut config = load_config()?;
    let canonical = dunce::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));

    let Some(libraries) = config.workspaces.get_mut(&active_workspace_id()) else {
        return Err("Shared library not found.".to_string().into());
    };
    let initial_len = libraries.len();
    libraries.retain(|l| {
        let lib_canonical =
            dunce::canonicalize(Path::new(&l.path)).unwrap_or_else(|_| PathBuf::from(&l.path));
        lib_canonical != canonical
    });

    if libraries.len() == initial_len {
        return Err("Shared library not found.".to_string().into());
    }

    save_config(&config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_defaults_to_empty() {
        let dir = std::env::temp_dir().join("ss-attached-missing");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("attached-libraries.json");

        let cfg = load_config_from(&path).expect("load missing");
        assert_eq!(cfg.schema_version, ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION);
        assert!(cfg.workspaces.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join("ss-attached-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        // Nested path also exercises parent-dir creation.
        let path = dir.join("nested").join("attached-libraries.json");

        let cfg = AttachedLibrariesConfig {
            schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
            workspaces: HashMap::from([(
                "client-a".to_string(),
                vec![AttachedLibrary {
                    path: "/tmp/vault".to_string(),
                    added_at: 42,
                }],
            )]),
        };
        save_config_to(&path, &cfg).expect("save");

        let loaded = load_config_from(&path).expect("load");
        let libs = loaded.workspaces.get("client-a").expect("workspace kept");
        assert_eq!(libs.len(), 1);
        assert_eq!(libs[0].path, "/tmp/vault");
        assert_eq!(libs[0].added_at, 42);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_flat_config_migrates_to_default_workspace() {
        let dir = std::env::temp_dir().join("ss-attached-migrate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("attached-libraries.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"libraries":[{"path":"/tmp/vault","added_at":7}]}"#,
        )
        .expect("write v1");

        let loaded = load_config_from(&path).expect("load v1");
        assert_eq!(
            loaded.schema_version,
            ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION
        );
        let libs = loaded
            .workspaces
            .get(DEFAULT_ACCOUNT_ID)
            .expect("migrated to default workspace");
        assert_eq!(libs.len(), 1);
        assert_eq!(libs[0].path, "/tmp/vault");
        assert_eq!(libs[0].added_at, 7);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_registered_matches_existing_directory() {
        // A real, canonicalizable directory registered in the config should be
        // detected as a duplicate regardless of a trailing-slash variant.
        let base = std::env::temp_dir().join("ss-attached-dup");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("mkdir");
        let canonical = dunce::canonicalize(&base).expect("canonicalize");

        let libraries = vec![AttachedLibrary {
            path: canonical.to_string_lossy().to_string(),
            added_at: 1,
        }];

        assert!(is_registered(&libraries, &canonical));
        assert!(!is_registered(
            &libraries,
            Path::new("/definitely/not/registered")
        ));

        let _ = std::fs::remove_dir_all(&base);
    }
}
