//! # Analytics Commands
//!
//! PostHog analytics integration for Ship Studio.
//! Events are sent to PostHog via the HTTP capture API from the Rust backend,
//! keeping the API key out of the frontend webview.
//!
//! Users can opt out via the `set_analytics_enabled` command.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use std::sync::LazyLock;
use std::sync::Mutex;
use tracing::{debug, info, warn};

const POSTHOG_API_KEY: &str = "phc_i1C5azXcz9MsnM8mQBni7qq5shiNS8JVFkcyXBjuBkr";
const POSTHOG_HOST: &str = "https://us.i.posthog.com";

/// Cached analytics state to avoid reading disk on every event
struct AnalyticsCache {
    device_id: String,
    /// After identify_user is called, this holds the real user ID (e.g. GitHub username)
    /// so subsequent events use it instead of the anonymous device UUID.
    identified_user_id: Option<String>,
    enabled: bool,
    http_client: reqwest::Client,
}

static ANALYTICS: LazyLock<Mutex<Option<AnalyticsCache>>> = LazyLock::new(|| Mutex::new(None));

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

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    if let Ok(mut cache) = ANALYTICS.lock() {
        *cache = Some(AnalyticsCache {
            device_id,
            identified_user_id: None,
            enabled,
            http_client,
        });
    }

    info!("Analytics initialized (enabled: {})", enabled);
}

/// Send an event to PostHog (non-blocking, fire-and-forget).
/// Returns immediately; the HTTP request runs in the background.
fn send_event(event_name: &str, distinct_id: &str, properties: serde_json::Value) {
    let (client, enabled) = {
        let guard = match ANALYTICS.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_ref() {
            Some(cache) => (cache.http_client.clone(), cache.enabled),
            None => return,
        }
    };

    if !enabled {
        return;
    }

    let mut props = match properties {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    // Add standard properties (don't overwrite if frontend already set them)
    if !props.contains_key("$screen_name") {
        props.insert(
            "$screen_name".to_string(),
            serde_json::Value::String("Ship Studio".to_string()),
        );
    }
    props.insert(
        "app_version".to_string(),
        serde_json::Value::String(env!("CARGO_PKG_VERSION").to_string()),
    );
    props.insert(
        "$lib".to_string(),
        serde_json::Value::String("Ship Studio App".to_string()),
    );

    #[cfg(target_os = "macos")]
    props.insert(
        "$os".to_string(),
        serde_json::Value::String("macOS".to_string()),
    );
    #[cfg(target_os = "windows")]
    props.insert(
        "$os".to_string(),
        serde_json::Value::String("Windows".to_string()),
    );
    #[cfg(target_os = "linux")]
    props.insert(
        "$os".to_string(),
        serde_json::Value::String("Linux".to_string()),
    );

    let body = serde_json::json!({
        "api_key": POSTHOG_API_KEY,
        "event": event_name,
        "distinct_id": distinct_id,
        "properties": serde_json::Value::Object(props),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let url = format!("{POSTHOG_HOST}/capture/");
    let event_name_owned = event_name.to_string();
    let distinct_id_owned = distinct_id.to_string();

    // Fire and forget - don't block the caller.
    // Use try_current() to gracefully handle calls outside an async context (e.g. during shutdown).
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        warn!(
            "PostHog event '{}' skipped (no Tokio runtime)",
            event_name_owned
        );
        return;
    };
    handle.spawn(async move {
        match client.post(&url).json(&body).send().await {
            Ok(resp) => {
                info!(
                    "PostHog '{}' → {} (distinct_id: {})",
                    event_name_owned,
                    resp.status(),
                    distinct_id_owned
                );
            }
            Err(e) => {
                warn!(
                    "PostHog '{}' failed: {} (distinct_id: {})",
                    event_name_owned, e, distinct_id_owned
                );
            }
        }
    });
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

// ============ Tauri Commands ============

/// Track an analytics event. Properties are optional key-value pairs.
/// The distinct_id defaults to the device_id if not provided.
#[tauri::command]
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
/// `properties` becomes PostHog `$set` (always overwrites person props on
/// every identify). `set_once` becomes `$set_once` (only written if the
/// property doesn't already exist on the person — useful for first_seen_*
/// fields that should never change after the first call).
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

/// Get the anonymous device ID (useful for frontend to know the distinct_id)
#[tauri::command]
#[tracing::instrument]
pub fn get_device_id_command() -> Result<String, CommandError> {
    Ok(get_device_id())
}
