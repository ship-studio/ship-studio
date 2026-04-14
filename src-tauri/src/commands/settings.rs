//! # Settings Commands
//!
//! Persisted UI preferences (calendar visibility, etc.).

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;

/// Get whether the GitHub contribution calendar is hidden on the dashboard.
#[tauri::command]
#[tracing::instrument]
pub fn get_calendar_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.calendar_hidden.unwrap_or(false))
}

/// Set whether the GitHub contribution calendar is hidden (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_calendar_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.calendar_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}

/// Get whether the Slack community CTA is hidden on the dashboard.
#[tauri::command]
#[tracing::instrument]
pub fn get_slack_cta_hidden() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.slack_cta_hidden.unwrap_or(false))
}

/// Set whether the Slack community CTA is hidden (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_slack_cta_hidden(hidden: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.slack_cta_hidden = Some(hidden);
    write_app_state(&state).map_err(CommandError::from)
}
