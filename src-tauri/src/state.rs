//! # Application State Management
//!
//! Global state for tracking open windows and their associated projects.
//! Used to prevent opening duplicate windows for the same project.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maps project_path -> window_label for all open project windows.
/// This allows us to focus an existing window if the user tries to open
/// a project that's already open in another window.
pub static OPEN_PROJECT_WINDOWS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maps window_label -> reserved port for dev server.
/// This prevents race conditions where multiple windows try to claim the same port
/// before any dev server has actually bound to it.
pub static RESERVED_PORTS: LazyLock<Mutex<HashMap<String, u16>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Set of all currently reserved ports for quick lookup.
pub static RESERVED_PORT_SET: LazyLock<Mutex<HashSet<u16>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Register a project window in the global state.
/// Called when a new project window is created.
pub fn register_project_window(project_path: String, window_label: String) {
    if let Ok(mut map) = OPEN_PROJECT_WINDOWS.lock() {
        tracing::debug!(
            "Registering project window: {} -> {}",
            project_path,
            window_label
        );
        map.insert(project_path, window_label);
    }
}

/// Unregister a project window from the global state.
/// Called when a project window is closed.
pub fn unregister_project_window(project_path: &str) {
    if let Ok(mut map) = OPEN_PROJECT_WINDOWS.lock() {
        if map.remove(project_path).is_some() {
            tracing::debug!("Unregistered project window for: {}", project_path);
        }
    }
}

/// Get the window label for a project if it's already open.
/// Returns None if the project doesn't have an open window.
pub fn get_window_for_project(project_path: &str) -> Option<String> {
    if let Ok(map) = OPEN_PROJECT_WINDOWS.lock() {
        let all_entries: Vec<_> = map
            .iter()
            .map(|(path, label)| format!("{path}:{label}"))
            .collect();
        let result = map.get(project_path).cloned();
        tracing::info!(
            "get_window_for_project: project_path={}, current_state={:?}, result={:?}",
            project_path,
            all_entries,
            result
        );
        result
    } else {
        tracing::error!("get_window_for_project: failed to acquire lock");
        None
    }
}

/// Remove a window from the registry by its label.
/// Used during window close cleanup when we only know the window label.
/// Also releases any reserved port for this window.
pub fn unregister_window_by_label(window_label: &str) {
    tracing::info!("unregister_window_by_label called for '{}'", window_label);
    // Clean up project window registry
    if let Ok(mut map) = OPEN_PROJECT_WINDOWS.lock() {
        let project_to_remove: Option<String> = map
            .iter()
            .find(|(_, label)| *label == window_label)
            .map(|(path, _)| path.clone());

        if let Some(path) = project_to_remove {
            map.remove(&path);
            tracing::info!("Unregistered window {} (project: {})", window_label, path);
        } else {
            tracing::info!(
                "unregister_window_by_label '{}': no project found",
                window_label
            );
        }
    }

    // Release any reserved port for this window
    release_port_for_window(window_label);
}

/// Reserve a port for a specific window.
/// Returns true if the port was successfully reserved or if this window already has this port.
/// Returns false if the port is already taken by another window.
///
/// NOTE: Lock ordering is RESERVED_PORTS then RESERVED_PORT_SET to prevent deadlocks.
pub fn reserve_port(window_label: &str, port: u16) -> bool {
    tracing::info!(
        "reserve_port called: window='{}', port={}",
        window_label,
        port
    );
    // IMPORTANT: Lock order must be RESERVED_PORTS then RESERVED_PORT_SET (same as release_port_for_window)
    let ports_result = RESERVED_PORTS.lock();
    let port_set_result = RESERVED_PORT_SET.lock();

    if let (Ok(mut ports), Ok(mut port_set)) = (ports_result, port_set_result) {
        let all_ports_before: Vec<_> = ports.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        tracing::info!("reserve_port: state before: {:?}", all_ports_before);

        // Check if this window already has this port (idempotent)
        if let Some(&existing_port) = ports.get(window_label) {
            if existing_port == port {
                tracing::info!(
                    "Port {} already reserved by this window {}, returning success",
                    port,
                    window_label
                );
                return true;
            }
            // Window has a different port - release it first
            port_set.remove(&existing_port);
            tracing::info!(
                "Releasing previous port {} for window {} before reserving {}",
                existing_port,
                window_label,
                port
            );
        }

        // Check if port is taken by another window
        if port_set.contains(&port) {
            tracing::info!("Port {} already reserved by another window", port);
            return false;
        }

        port_set.insert(port);
        ports.insert(window_label.to_string(), port);
        tracing::info!("Reserved port {} for window {}", port, window_label);
        true
    } else {
        tracing::error!("reserve_port: failed to acquire locks");
        false
    }
}

/// Check if a port is already reserved by any window.
pub fn is_port_reserved(port: u16) -> bool {
    RESERVED_PORT_SET
        .lock()
        .map(|set| set.contains(&port))
        .unwrap_or(false)
}

/// Release the port reserved by a specific window.
pub fn release_port_for_window(window_label: &str) {
    tracing::info!("release_port_for_window called for '{}'", window_label);
    let ports_result = RESERVED_PORTS.lock();
    let port_set_result = RESERVED_PORT_SET.lock();

    if let (Ok(mut ports), Ok(mut port_set)) = (ports_result, port_set_result) {
        let all_ports_before: Vec<_> = ports.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        tracing::info!(
            "release_port_for_window '{}': state before release: {:?}",
            window_label,
            all_ports_before
        );
        if let Some(port) = ports.remove(window_label) {
            port_set.remove(&port);
            tracing::info!("Released port {} from window {}", port, window_label);
        } else {
            tracing::info!(
                "release_port_for_window '{}': no port found to release",
                window_label
            );
        }
    }
}

// ============ Background Sessions Registry ============

/// Lifecycle status of a project session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// Session is live — PTYs running, dev server up.
    Active,
    /// Session is paused — PTYs killed, dev server stopped, but the pin remains.
    /// Frontend can resume by cold-starting (no in-memory PTY refs to reattach).
    Suspended,
}

/// Live session for a pinned project. Kept in-memory only; never persisted.
/// On app restart the registry is empty and pinned projects start in "suspended"
/// state from the user's perspective until they click to resume.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionBackend {
    /// The window label currently hosting this session's UI.
    /// In single-window-multi-project mode (Phase 4+) this is always "main".
    /// Tracking it explicitly gives us a kill switch if a window dies unexpectedly.
    pub owning_window_label: String,
    /// Active vs Suspended.
    pub status: SessionStatus,
    /// Unix millis when the session was first created in this app run.
    pub activated_at: u64,
    /// Unix millis bumped on user interaction (keystrokes, focus, etc.).
    /// Used by the soft cap eviction to pick the LRU session for suspend.
    pub last_activity_at: u64,
}

/// Registry of all live project sessions, keyed by canonical project path.
///
/// **Invariant:** at most one entry per project path. `register_session` is the
/// only function that grows this map and rejects duplicates; this enforces the
/// "one project path → at most one live session, ever" rule from the plan.
pub static PROJECT_SESSIONS: LazyLock<Mutex<HashMap<String, ProjectSessionBackend>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Register a new active session for a project. Returns `Err` if a session
/// already exists for this project path under a different window — this is
/// the invariant guard.
///
/// If the same `(project_path, window_label)` is already registered, this is
/// idempotent and bumps `last_activity_at`.
pub fn register_session(project_path: &str, window_label: &str) -> Result<(), String> {
    let mut sessions = PROJECT_SESSIONS
        .lock()
        .map_err(|_| "PROJECT_SESSIONS lock poisoned")?;

    if let Some(existing) = sessions.get_mut(project_path) {
        if existing.owning_window_label == window_label {
            existing.last_activity_at = now_millis();
            existing.status = SessionStatus::Active;
            return Ok(());
        }
        return Err(format!(
            "session for {project_path} already owned by window {}",
            existing.owning_window_label
        ));
    }

    let now = now_millis();
    sessions.insert(
        project_path.to_string(),
        ProjectSessionBackend {
            owning_window_label: window_label.to_string(),
            status: SessionStatus::Active,
            activated_at: now,
            last_activity_at: now,
        },
    );
    tracing::info!(
        "Registered session: project={}, window={}",
        project_path,
        window_label
    );
    Ok(())
}

/// Mark a session as suspended (PTYs killed, dev server stopped).
/// The entry stays in the map so the rail can still display it.
pub fn mark_session_suspended(project_path: &str) {
    if let Ok(mut sessions) = PROJECT_SESSIONS.lock() {
        if let Some(session) = sessions.get_mut(project_path) {
            session.status = SessionStatus::Suspended;
            session.last_activity_at = now_millis();
            tracing::info!("Marked session suspended: project={}", project_path);
        }
    }
}

/// Bump `last_activity_at` for a session. Called on terminal input, focus, etc.
/// Cheap and safe to call frequently.
pub fn touch_session(project_path: &str) {
    if let Ok(mut sessions) = PROJECT_SESSIONS.lock() {
        if let Some(session) = sessions.get_mut(project_path) {
            session.last_activity_at = now_millis();
        }
    }
}

/// Remove a session from the registry. Idempotent.
pub fn unregister_session(project_path: &str) {
    if let Ok(mut sessions) = PROJECT_SESSIONS.lock() {
        if sessions.remove(project_path).is_some() {
            tracing::info!("Unregistered session: project={}", project_path);
        }
    }
}

/// Snapshot of all current sessions. Used by the rail UI and debugging.
pub fn list_sessions() -> Vec<(String, ProjectSessionBackend)> {
    PROJECT_SESSIONS
        .lock()
        .map(|sessions| {
            sessions
                .iter()
                .map(|(path, info)| (path.clone(), info.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Look up a session by project path.
pub fn get_session(project_path: &str) -> Option<ProjectSessionBackend> {
    PROJECT_SESSIONS
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(project_path).cloned())
}

/// Count of currently *active* sessions (excludes suspended).
/// Used for soft-cap enforcement in Phase 5.
pub fn count_active_sessions() -> usize {
    PROJECT_SESSIONS
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|s| s.status == SessionStatus::Active)
                .count()
        })
        .unwrap_or(0)
}

/// Get the reserved port for a window, if any.
pub fn get_reserved_port(window_label: &str) -> Option<u16> {
    let result = RESERVED_PORTS.lock().ok().and_then(|ports| {
        let all_ports: Vec<_> = ports.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        tracing::info!(
            "get_reserved_port called for '{}', current state: {:?}",
            window_label,
            all_ports
        );
        ports.get(window_label).copied()
    });
    tracing::info!(
        "get_reserved_port for '{}' returning: {:?}",
        window_label,
        result
    );
    result
}
