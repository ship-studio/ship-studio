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

// ============ Client Agent Settings ============

/// Get the stored OpenRouter API key.
#[tauri::command]
pub fn get_openrouter_api_key() -> Result<Option<String>, String> {
    let state = read_app_state();
    Ok(state.openrouter_api_key)
}

/// Set the OpenRouter API key (persisted to app state).
#[tauri::command]
pub fn set_openrouter_api_key(api_key: Option<String>) -> Result<(), String> {
    let mut state = read_app_state();
    state.openrouter_api_key = api_key;
    write_app_state(&state)
}

/// Get the monthly spending limit for Client agent usage.
#[tauri::command]
pub fn get_client_agent_spending_limit() -> Result<Option<f64>, String> {
    let state = read_app_state();
    Ok(state.client_agent_spending_limit)
}

/// Set the monthly spending limit for Client agent usage (persisted to app state).
#[tauri::command]
pub fn set_client_agent_spending_limit(limit: Option<f64>) -> Result<(), String> {
    let mut state = read_app_state();
    state.client_agent_spending_limit = limit;
    write_app_state(&state)
}

/// Get whether human-in-the-loop is enabled for the Client agent.
#[tauri::command]
pub fn get_client_agent_hitl_enabled() -> Result<bool, String> {
    let state = read_app_state();
    Ok(state.client_agent_hitl_enabled.unwrap_or(false))
}

/// Set whether human-in-the-loop is enabled (persisted to app state).
#[tauri::command]
pub fn set_client_agent_hitl_enabled(enabled: bool) -> Result<(), String> {
    let mut state = read_app_state();
    state.client_agent_hitl_enabled = Some(enabled);
    write_app_state(&state)
}

/// Get the preferred model for the Client agent (OpenRouter model ID).
#[tauri::command]
pub fn get_client_agent_model() -> Result<Option<String>, String> {
    let state = read_app_state();
    Ok(state.client_agent_model)
}

/// Set the preferred model for the Client agent (persisted to app state).
#[tauri::command]
pub fn set_client_agent_model(model: Option<String>) -> Result<(), String> {
    let mut state = read_app_state();
    state.client_agent_model = model;
    write_app_state(&state)
}
