//! # App State Persistence
//!
//! Functions for reading/writing the persisted AppState (setup_complete, default_agent, etc.)

use super::{
    is_force_onboarding_mode, is_mock_mode, read_app_state, update_app_state,
    FORCE_ONBOARDING_COMPLETED,
};
use crate::errors::CommandError;
use std::time::{SystemTime, UNIX_EPOCH};

/// Get the app state file path
pub(crate) fn get_app_state_path() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/Harbr/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp/harbr-app-state.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("Harbr/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("C:/temp/harbr-app-state.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("harbr/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp/harbr-app-state.json"))
    }
}

fn get_legacy_app_state_path() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    return dirs::home_dir()
        .map(|h| h.join("Library/Application Support/ShipStudio/app_state.json"))
        .unwrap_or_else(|| "/tmp/ship-studio-app-state.json".into());
    #[cfg(target_os = "windows")]
    return dirs::data_local_dir()
        .map(|d| d.join("ShipStudio/app_state.json"))
        .unwrap_or_else(|| "C:/temp/ship-studio-app-state.json".into());
    #[cfg(target_os = "linux")]
    return dirs::data_local_dir()
        .map(|d| d.join("ship-studio/app_state.json"))
        .unwrap_or_else(|| "/tmp/ship-studio-app-state.json".into());
}

pub(crate) fn migrate_legacy_app_state() -> Result<crate::types::AppState, std::io::Error> {
    let legacy_root = dirs::home_dir().map(|h| h.join("ShipStudio"));
    migrate_legacy_state_at(
        &get_app_state_path(),
        &get_legacy_app_state_path(),
        legacy_root.as_deref(),
    )
}

fn migrate_legacy_state_at(
    destination: &std::path::Path,
    legacy: &std::path::Path,
    legacy_projects_root: Option<&std::path::Path>,
) -> Result<crate::types::AppState, std::io::Error> {
    if destination.exists() {
        let raw = std::fs::read_to_string(destination)?;
        return serde_json::from_str(&raw).map_err(std::io::Error::other);
    }

    let mut state = match std::fs::read_to_string(legacy) {
        Ok(raw) => match serde_json::from_str::<crate::types::AppState>(&raw) {
            Ok(mut state) => {
                if state.projects_root.is_none() {
                    state.projects_root =
                        legacy_projects_root.map(|p| p.to_string_lossy().into_owned());
                }
                state
            }
            Err(error) => {
                tracing::warn!(%error, "Legacy Ship Studio state is malformed; starting Harbr with defaults");
                crate::types::AppState::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::types::AppState::default()
        }
        Err(error) => return Err(error),
    };
    state.legacy_state_migration_complete = true;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(&state).map_err(std::io::Error::other)?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(&json)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let raw = std::fs::read_to_string(destination)?;
            return serde_json::from_str(&raw).map_err(std::io::Error::other);
        }
        Err(error) => return Err(error),
    }
    Ok(state)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migrates_once_and_retains_legacy_project_root() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("legacy.json");
        let destination = dir.path().join("harbr/app_state.json");
        std::fs::write(&legacy, r#"{"setupComplete":true}"#).unwrap();
        let legacy_root = dir.path().join("ShipStudio");
        let first = migrate_legacy_state_at(&destination, &legacy, Some(&legacy_root)).unwrap();
        assert!(first.setup_complete && first.legacy_state_migration_complete);
        assert_eq!(first.projects_root.as_deref(), legacy_root.to_str());
        std::fs::write(&legacy, r#"{"setupComplete":false}"#).unwrap();
        let second = migrate_legacy_state_at(&destination, &legacy, Some(&legacy_root)).unwrap();
        assert!(second.setup_complete, "destination must take precedence");
    }

    #[test]
    fn malformed_legacy_state_is_not_copied() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("legacy.json");
        let destination = dir.path().join("harbr/app_state.json");
        std::fs::write(&legacy, "not json").unwrap();
        let state = migrate_legacy_state_at(&destination, &legacy, None).unwrap();
        assert!(!state.setup_complete);
        assert!(state.legacy_state_migration_complete);
        assert_eq!(std::fs::read_to_string(&legacy).unwrap(), "not json");
    }

    #[test]
    fn new_install_records_completed_migration_with_defaults() {
        let dir = tempdir().unwrap();
        let state = migrate_legacy_state_at(
            &dir.path().join("harbr/app_state.json"),
            &dir.path().join("missing.json"),
            None,
        )
        .unwrap();
        assert!(state.legacy_state_migration_complete);
        assert!(state.projects_root.is_none());
    }
}

/// Mark setup as complete (persists to disk)
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn mark_setup_complete() -> Result<(), CommandError> {
    // Force onboarding / mock mode: don't persist to disk
    if is_force_onboarding_mode() {
        if let Ok(mut completed) = FORCE_ONBOARDING_COMPLETED.lock() {
            *completed = true;
        }
        tracing::info!("Force onboarding mode: skipping setup complete persistence");
        return Ok(());
    }
    if is_mock_mode() {
        tracing::info!("Mock mode: skipping setup complete persistence");
        return Ok(());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Read existing state to preserve other fields (e.g., compact_mode)
    update_app_state(|state| {
        state.setup_complete = true;
        state.setup_completed_at = Some(timestamp);
    })?;
    tracing::info!("Setup marked as complete");
    Ok(())
}

/// Persist that the user brings their own agent ("Other" in the agent-led
/// onboarding). Setup checks then treat the agent requirement as satisfied,
/// so the user isn't redirected back to onboarding on every launch.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn set_external_agent_opt_in(enabled: bool) -> Result<(), CommandError> {
    // Test modes: don't persist to disk (mirrors mark_setup_complete).
    if is_force_onboarding_mode() || is_mock_mode() {
        tracing::info!("Test mode: skipping external agent opt-in persistence");
        return Ok(());
    }
    update_app_state(|state| state.external_agent = Some(enabled))?;
    tracing::info!(enabled, "External agent opt-in persisted");
    Ok(())
}

/// Directory the guided onboarding agent runs in: the projects root
/// (~/ShipStudio by default), created if missing — NOT the user's home.
/// An agent scanning $HOME trips macOS TCC permission prompts (Photos,
/// Desktop, Documents) attributed to Harbr, and the pending dialog
/// freezes the scan mid-syscall, which reads as "the agent is stuck"
/// (found in fresh-VM testing).
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn ensure_agent_workdir() -> Result<String, CommandError> {
    match crate::utils::projects_root() {
        Ok(root) => match std::fs::create_dir_all(&root) {
            Ok(()) => return Ok(root.to_string_lossy().to_string()),
            Err(e) => tracing::warn!("Failed to create {}: {e}", root.display()),
        },
        Err(e) => tracing::warn!("Failed to resolve projects root: {e}"),
    }
    // Never fall through to $HOME: the agent scanning the home folder trips
    // macOS TCC permission prompts (Photos/Desktop/Documents) that freeze the
    // scanning syscall. The OS temp dir is outside every protected folder.
    Ok(std::env::temp_dir().to_string_lossy().to_string())
}

/// Valid default-host choices. Kept in sync with the onboarding hosting step.
const VALID_HOSTS: &[&str] = &["vercel", "cloudflare"];

/// Persist the workspace-wide default hosting provider chosen during
/// onboarding. New projects default to this host.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn set_default_host(host: String) -> Result<(), CommandError> {
    if !VALID_HOSTS.contains(&host.as_str()) {
        return Err(CommandError::Validation {
            field: "host".to_string(),
            reason: format!(
                "unknown host `{host}` — expected one of: {}",
                VALID_HOSTS.join(", ")
            ),
        });
    }
    // Test modes: don't persist to disk (mirrors mark_setup_complete).
    if is_force_onboarding_mode() || is_mock_mode() {
        tracing::info!(host, "Test mode: skipping default host persistence");
        return Ok(());
    }
    update_app_state(|state| state.default_host = Some(host.clone()))?;
    tracing::info!(host, "Default host persisted");
    Ok(())
}

/// Get the default agent ID from persisted AppState.
/// Returns None if not set (frontend should fall back to Claude Code).
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn get_default_agent_id() -> Option<String> {
    read_app_state().default_agent_id
}

/// Set the default agent ID. Persists to AppState and updates in-memory cache.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn set_default_agent_id(agent_id: String) -> Result<(), CommandError> {
    update_app_state(|state| state.default_agent_id = Some(agent_id.clone()))?;
    crate::agent::set_default_agent_cached(&agent_id);
    tracing::info!("Default agent set to: {}", agent_id);
    Ok(())
}
