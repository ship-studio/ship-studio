//! # Analytics Commands
//!
//! Compatibility commands for former analytics call sites.
//! Harbr records these events only in local structured logs.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use std::sync::LazyLock;
use std::sync::Mutex;
use tracing::{debug, info, warn};

/// Cached analytics state to avoid reading disk on every event
struct AnalyticsCache {
    device_id: String,
    /// After identify_user is called, this holds the real user ID (e.g. GitHub username)
    /// so subsequent events use it instead of the anonymous device UUID.
    identified_user_id: Option<String>,
    enabled: bool,
}

static ANALYTICS: LazyLock<Mutex<Option<AnalyticsCache>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn suppressed_by_host() -> bool {
    #[cfg(feature = "web")]
    if crate::emit::is_web() {
        return true;
    }
    false
}

/// Initialize the analytics system. Called once at app startup from lib.rs.
/// Reads or generates a device_id and caches the enabled state.
pub fn init_analytics() {
    let mut app_state = read_app_state();

    // Generate device_id on first launch
    let device_id = match &app_state.device_id {
        Some(id) => id.clone(),
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            app_state.device_id = Some(id.clone());
            if let Err(e) = write_app_state(&app_state) {
                warn!("Failed to persist device_id: {}", e);
            }
            id
        }
    };

    let enabled = app_state.analytics_enabled.unwrap_or(true);

    if let Ok(mut cache) = ANALYTICS.lock() {
        *cache = Some(AnalyticsCache {
            device_id,
            identified_user_id: None,
            enabled,
        });
    }

    info!("Analytics initialized (enabled: {})", enabled);
}

/// Record an event in local structured logs.
fn send_event(event_name: &str, distinct_id: &str, properties: serde_json::Value) {
    let enabled = {
        let guard = match ANALYTICS.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_ref() {
            Some(cache) => cache.enabled,
            None => return,
        }
    };

    if !enabled {
        return;
    }

    debug!(event_name, distinct_id, properties = %properties, "Local product event");
}

/// Get the best distinct_id: identified user ID if available, otherwise device UUID.
fn get_distinct_id() -> String {
    ANALYTICS
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().map(|c| {
                c.identified_user_id
                    .clone()
                    .unwrap_or_else(|| c.device_id.clone())
            })
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// Get just the anonymous device ID (needed for $identify linking)
fn get_device_id() -> String {
    ANALYTICS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.device_id.clone()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Emit an event from the backend, without a frontend round trip.
///
/// Needed by anything that happens with no window involved — a scheduled
/// workflow run fires while the user is in another app entirely, and routing it
/// through the frontend would silently drop exactly the runs the feature exists
/// to perform. Fire-and-forget and opt-out-aware, like every other send.
pub(crate) fn track_backend_event(event_name: &str, properties: serde_json::Value) {
    send_event(event_name, &get_distinct_id(), properties);
}

// ============ Tauri Commands ============

/// Track an analytics event. Properties are optional key-value pairs.
/// The distinct_id defaults to the device_id if not provided.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn track_event(
    event_name: String,
    properties: Option<serde_json::Value>,
    distinct_id: Option<String>,
) -> Result<(), CommandError> {
    let id = distinct_id.unwrap_or_else(get_distinct_id);
    let props = properties.unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

    send_event(&event_name, &id, props);
    Ok(())
}

/// Identify a user by linking their distinct_id with person properties.
/// Call this when the user authenticates (e.g., GitHub login).
///
/// `properties` and `set_once` are retained for frontend API compatibility.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn identify_user(
    user_id: String,
    properties: Option<serde_json::Value>,
    set_once: Option<serde_json::Value>,
) -> Result<(), CommandError> {
    // Cache the identified user ID so all future events use it
    if let Ok(mut guard) = ANALYTICS.lock() {
        if let Some(cache) = guard.as_mut() {
            cache.identified_user_id = Some(user_id.clone());
        }
    }

    let device_id = get_device_id();

    let mut set_props = match properties {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };

    // Link the anonymous device_id to the identified user
    set_props.insert(
        "$device_id".to_string(),
        serde_json::Value::String(device_id.clone()),
    );

    let mut props = serde_json::Map::new();
    props.insert("$set".to_string(), serde_json::Value::Object(set_props));
    match set_once {
        Some(serde_json::Value::Object(once_map)) if !once_map.is_empty() => {
            props.insert("$set_once".to_string(), serde_json::Value::Object(once_map));
        }
        Some(serde_json::Value::Object(_)) | None => {
            // Empty or absent — nothing to merge.
        }
        Some(other) => {
            warn!(
                "identify_user: set_once must be a non-empty object, got {} — ignoring",
                match other {
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::Bool(_) => "bool",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Null => "null",
                    serde_json::Value::Object(_) => unreachable!(),
                }
            );
        }
    }
    props.insert(
        "$anon_distinct_id".to_string(),
        serde_json::Value::String(device_id),
    );

    send_event("$identify", &user_id, serde_json::Value::Object(props));
    Ok(())
}

/// Get whether analytics are currently enabled
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub fn get_analytics_enabled() -> Result<bool, CommandError> {
    let enabled = ANALYTICS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.enabled))
        .unwrap_or(true);
    Ok(enabled)
}

/// Set whether analytics are enabled (persisted to app state)
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub fn set_analytics_enabled(enabled: bool) -> Result<(), CommandError> {
    // Update the in-memory cache
    if let Ok(mut guard) = ANALYTICS.lock() {
        if let Some(cache) = guard.as_mut() {
            cache.enabled = enabled;
        }
    }

    // Persist to disk
    let mut app_state = read_app_state();
    app_state.analytics_enabled = Some(enabled);
    write_app_state(&app_state)?;

    // The frontend's SettingsModal fires `analytics_enabled` on the same
    // user toggle, so we don't fire a second event here.

    debug!("Analytics enabled set to: {}", enabled);
    Ok(())
}
