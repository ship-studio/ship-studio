//! # Attached Libraries Commands
//!
//! Attached libraries are local directories the user registers once and Ship
//! Studio rides along into every agent session via the agent's additional-
//! directory flag (e.g. Claude Code's `--add-dir`). The directory's skills load
//! and its files become readable, but its `CLAUDE.md` is deliberately NOT
//! loaded, so a library can't hijack the project's own instructions.
//!
//! The registry mirrors [`super::external_projects`]: a small JSON file under
//! `~/ShipStudio/.shipstudio`, populated only through a native folder picker so
//! a compromised webview can't silently attach a sensitive directory. The
//! selected path rides into the agent as a plain CLI argument (not a validated
//! cwd), so no path-root validation is needed here — the picker is the trust
//! boundary.

use crate::errors::CommandError;
use crate::types::{
    AttachedLibrariesConfig, AttachedLibrary, ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
};
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

/// Read a config from an explicit path — an empty config when the file is
/// absent. Split out from [`load_config`] so it can be unit-tested against a
/// temp file without touching the user's real home directory.
fn load_config_from(config_path: &Path) -> Result<AttachedLibrariesConfig, String> {
    if !config_path.exists() {
        return Ok(AttachedLibrariesConfig {
            schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
            libraries: Vec::new(),
        });
    }

    let contents = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read attached libraries config: {e}"))?;

    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse attached libraries config: {e}"))
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

/// Whether `canonical` is already registered as an attached library.
fn is_registered(config: &AttachedLibrariesConfig, canonical: &Path) -> bool {
    config.libraries.iter().any(|l| {
        dunce::canonicalize(Path::new(&l.path))
            .map(|c| c == canonical)
            .unwrap_or_else(|_| Path::new(&l.path) == canonical)
    })
}

// ============ Tauri Commands ============

/// List every registered attached library (for the management UI). Entries are
/// returned exactly as stored — a directory may no longer exist on disk, which
/// the UI can surface.
#[tauri::command]
#[tracing::instrument]
pub async fn list_attached_libraries() -> Result<Vec<AttachedLibrary>, CommandError> {
    Ok(load_config()?.libraries)
}

/// Canonical paths of attached libraries that currently exist as directories.
///
/// Used at agent-launch to build the additional-directory flags. Missing or
/// non-directory entries are skipped so a moved or deleted library never breaks
/// an agent spawn.
#[tauri::command]
#[tracing::instrument]
pub async fn attached_library_dirs() -> Result<Vec<String>, CommandError> {
    let config = load_config()?;
    let mut dirs = Vec::new();
    for lib in &config.libraries {
        if let Ok(canonical) = dunce::canonicalize(Path::new(&lib.path)) {
            if canonical.is_dir() {
                dirs.push(canonical.to_string_lossy().to_string());
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
    if is_registered(&config, &canonical) {
        return Err("This folder is already an attached library."
            .to_string()
            .into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    config.libraries.push(AttachedLibrary {
        path: canonical_str.clone(),
        added_at: now,
    });
    save_config(&config)?;

    Ok(Some(canonical_str))
}

/// Remove an attached library from the registry. Does not delete the folder on
/// disk.
#[tauri::command]
#[tracing::instrument]
pub async fn remove_attached_library(path: String) -> Result<(), CommandError> {
    let mut config = load_config()?;
    let canonical = dunce::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));

    let initial_len = config.libraries.len();
    config.libraries.retain(|l| {
        let lib_canonical =
            dunce::canonicalize(Path::new(&l.path)).unwrap_or_else(|_| PathBuf::from(&l.path));
        lib_canonical != canonical
    });

    if config.libraries.len() == initial_len {
        return Err("Attached library not found.".to_string().into());
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
        assert!(cfg.libraries.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join("ss-attached-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        // Nested path also exercises parent-dir creation.
        let path = dir.join("nested").join("attached-libraries.json");

        let cfg = AttachedLibrariesConfig {
            schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
            libraries: vec![AttachedLibrary {
                path: "/tmp/vault".to_string(),
                added_at: 42,
            }],
        };
        save_config_to(&path, &cfg).expect("save");

        let loaded = load_config_from(&path).expect("load");
        assert_eq!(loaded.libraries.len(), 1);
        assert_eq!(loaded.libraries[0].path, "/tmp/vault");
        assert_eq!(loaded.libraries[0].added_at, 42);

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

        let cfg = AttachedLibrariesConfig {
            schema_version: ATTACHED_LIBRARIES_CONFIG_SCHEMA_VERSION,
            libraries: vec![AttachedLibrary {
                path: canonical.to_string_lossy().to_string(),
                added_at: 1,
            }],
        };

        assert!(is_registered(&cfg, &canonical));
        assert!(!is_registered(
            &cfg,
            Path::new("/definitely/not/registered")
        ));

        let _ = std::fs::remove_dir_all(&base);
    }
}
