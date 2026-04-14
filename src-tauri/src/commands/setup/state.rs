//! # App State Persistence
//!
//! Functions for reading/writing the persisted AppState (setup_complete, default_agent, etc.)

use super::{
    is_force_onboarding_mode, is_mock_mode, read_app_state, write_app_state,
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
    let mut state = read_app_state();
    state.setup_complete = true;
    state.setup_completed_at = Some(timestamp);

    write_app_state(&state)?;
    tracing::info!("Setup marked as complete");
    Ok(())
}

/// Clear setup complete flag (for testing/reset)
#[tauri::command]
#[tracing::instrument]
pub async fn reset_setup_state() -> Result<(), CommandError> {
    // Read existing state to preserve other fields (e.g., compact_mode)
    let mut state = read_app_state();
    state.setup_complete = false;
    state.setup_completed_at = None;

    write_app_state(&state)?;
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
    let mut state = read_app_state();
    state.default_agent_id = Some(agent_id.clone());
    write_app_state(&state)?;
    crate::agent::set_default_agent_cached(&agent_id);
    tracing::info!("Default agent set to: {}", agent_id);
    Ok(())
}
