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
            .map(|h| h.join("Library/Application Support/ShipStudio/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ShipStudio/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("C:/temp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ship-studio/app_state.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp/ship-studio-app-state.json"))
    }
}

/// Mark setup as complete (persists to disk)
#[tauri::command]
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
#[tauri::command]
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
/// Desktop, Documents) attributed to Ship Studio, and the pending dialog
/// freezes the scan mid-syscall, which reads as "the agent is stuck"
/// (found in fresh-VM testing).
#[tauri::command]
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
#[tauri::command]
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

/// The persisted default hosting provider, if one was chosen.
#[tauri::command]
#[tracing::instrument]
pub async fn get_default_host() -> Result<Option<String>, CommandError> {
    Ok(read_app_state().default_host)
}

/// Clear setup complete flag (for testing/reset)
#[tauri::command]
#[tracing::instrument]
pub async fn reset_setup_state() -> Result<(), CommandError> {
    // Read existing state to preserve other fields (e.g., compact_mode)
    update_app_state(|state| {
        state.setup_complete = false;
        state.setup_completed_at = None;
    })?;
    tracing::info!("Setup state reset");
    Ok(())
}

/// Get the default agent ID from persisted AppState.
/// Returns None if not set (frontend should fall back to Claude Code).
#[tauri::command]
#[tracing::instrument]
pub async fn get_default_agent_id() -> Option<String> {
    read_app_state().default_agent_id
}

/// Set the default agent ID. Persists to AppState and updates in-memory cache.
#[tauri::command]
#[tracing::instrument]
pub async fn set_default_agent_id(agent_id: String) -> Result<(), CommandError> {
    update_app_state(|state| state.default_agent_id = Some(agent_id.clone()))?;
    crate::agent::set_default_agent_cached(&agent_id);
    tracing::info!("Default agent set to: {}", agent_id);
    Ok(())
}
