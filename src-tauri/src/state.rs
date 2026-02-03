//! # Application State Management
//!
//! Global state for tracking open windows and their associated projects.
//! Used to prevent opening duplicate windows for the same project.

use lazy_static::lazy_static;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

lazy_static! {
    /// Maps project_path -> window_label for all open project windows.
    /// This allows us to focus an existing window if the user tries to open
    /// a project that's already open in another window.
    pub static ref OPEN_PROJECT_WINDOWS: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

    /// Maps window_label -> reserved port for dev server.
    /// This prevents race conditions where multiple windows try to claim the same port
    /// before any dev server has actually bound to it.
    pub static ref RESERVED_PORTS: Mutex<HashMap<String, u16>> = Mutex::new(HashMap::new());

    /// Set of all currently reserved ports for quick lookup.
    pub static ref RESERVED_PORT_SET: Mutex<HashSet<u16>> = Mutex::new(HashSet::new());
}

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
