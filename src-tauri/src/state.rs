//! # Application State Management
//!
//! Global state for tracking open windows and their associated projects.
//! Used to prevent opening duplicate windows for the same project.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maps project_path -> window_label for all open project windows.
/// This allows us to focus an existing window if the user tries to open
/// a project that's already open in another window.
pub static OPEN_PROJECT_WINDOWS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maps `(window_label, project_path) -> reserved port`. Keyed by both so a
/// single window can hold distinct ports for multiple projects simultaneously
/// — the prerequisite for running more than one project side-by-side.
pub static RESERVED_PORTS: LazyLock<Mutex<HashMap<(String, String), u16>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Set of all currently reserved ports for quick lookup.
pub static RESERVED_PORT_SET: LazyLock<Mutex<HashSet<u16>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

// ============ Mobile Preview Sessions ============

/// A live native mobile preview: the booted simulator, its `serve-sim` mirror,
/// and the optional app-build PTY session. Owned by the backend (not the React
/// component) so it survives tab switches and is torn down deterministically on
/// suspend / project-close / window-close.
#[derive(Clone, Debug, PartialEq)]
pub struct MobileSession {
    /// The booted simulator's UDID — also what `serve-sim --kill <udid>` takes.
    pub udid: String,
    /// True only if WE booted the sim — drives whether it's shut down on close.
    pub booted_by_us: bool,
    /// The live `serve-sim` mirror port (parsed back from serve-sim's output).
    pub serve_sim_port: u16,
    /// True only if we reserved `serve_sim_port` via `find_and_reserve_port`;
    /// teardown releases the port iff this is true.
    pub port_was_reserved: bool,
    /// The `pty_session` id running the app build (e.g. `mobile-build:<path>`),
    /// if a build was launched. Killed on teardown (it lives in pty_session's
    /// registry, which the PTY_REGISTRY sweeps do NOT reach).
    pub build_session_id: Option<String>,
    /// Owning window label — lets window-close teardown find sessions by window.
    pub window_label: String,
    /// Friendly device name (e.g. "iPhone 17") for the preview toolbar. Stored so
    /// reuse/heal can return it without a second `simctl list` round-trip.
    pub device_name: String,
    /// Friendly runtime label (e.g. "iOS 26.1"), best-effort.
    pub device_runtime: Option<String>,
}

/// Maps `project_path -> MobileSession` for active mobile previews.
pub static MOBILE_SESSIONS: LazyLock<Mutex<HashMap<String, MobileSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record (or replace) the mobile preview session for a project.
pub fn register_mobile_session(project_path: String, session: MobileSession) {
    if let Ok(mut map) = MOBILE_SESSIONS.lock() {
        map.insert(project_path, session);
    }
}

/// Clone the mobile session for a project without removing it (for idempotent
/// reuse in `start_mobile_preview`).
pub fn get_mobile_session(project_path: &str) -> Option<MobileSession> {
    MOBILE_SESSIONS.lock().ok()?.get(project_path).cloned()
}

/// Remove and return the mobile session for a project (the teardown entry point).
pub fn take_mobile_session(project_path: &str) -> Option<MobileSession> {
    MOBILE_SESSIONS.lock().ok()?.remove(project_path)
}

/// Remove and return every mobile session owned by a window (window-close
/// teardown), paired with its project path. Mirrors `release_port_for_window`'s
/// filter-by-label pattern.
pub fn take_mobile_sessions_for_window(window_label: &str) -> Vec<(String, MobileSession)> {
    let Ok(mut map) = MOBILE_SESSIONS.lock() else {
        return Vec::new();
    };
    let keys: Vec<String> = map
        .iter()
        .filter(|(_, s)| s.window_label == window_label)
        .map(|(path, _)| path.clone())
        .collect();
    keys.into_iter()
        .filter_map(|k| map.remove(&k).map(|s| (k, s)))
        .collect()
}

/// Per-project async locks serializing the slow `simctl boot` so two concurrent
/// `start_mobile_preview` calls for the same project can't both boot. The std
/// `Mutex` here guards only instant map ops; the inner `tokio::sync::Mutex` is
/// what callers hold across the boot `.await`.
static MOBILE_BOOT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Get (or create) the boot lock for a project.
pub fn boot_lock_for(project_path: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = MOBILE_BOOT_LOCKS
        .lock()
        .expect("MOBILE_BOOT_LOCKS poisoned");
    map.entry(project_path.to_string()).or_default().clone()
}

/// Drop a project's boot lock so the map can't grow unbounded. Called from
/// teardown once the preview is gone.
pub fn drop_boot_lock(project_path: &str) {
    if let Ok(mut map) = MOBILE_BOOT_LOCKS.lock() {
        map.remove(project_path);
    }
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

/// Reserve a port for a specific `(window, project)` pair.
/// Returns true on success or if that same pair already holds this port (idempotent).
/// Returns false if the port is already taken by *any* other `(window, project)` pair.
///
/// NOTE: Lock ordering is RESERVED_PORTS then RESERVED_PORT_SET to prevent deadlocks.
pub fn reserve_port(window_label: &str, project_path: &str, port: u16) -> bool {
    tracing::info!(
        "reserve_port called: window='{}', project='{}', port={}",
        window_label,
        project_path,
        port
    );
    // IMPORTANT: Lock order must be RESERVED_PORTS then RESERVED_PORT_SET (same as release_port_for_window)
    let ports_result = RESERVED_PORTS.lock();
    let port_set_result = RESERVED_PORT_SET.lock();

    if let (Ok(mut ports), Ok(mut port_set)) = (ports_result, port_set_result) {
        let all_ports_before: Vec<_> = ports
            .iter()
            .map(|((w, p), v)| format!("{w}|{p}:{v}"))
            .collect();
        tracing::info!("reserve_port: state before: {:?}", all_ports_before);

        let key = (window_label.to_string(), project_path.to_string());

        // Check if this (window, project) already has this port (idempotent)
        if let Some(&existing_port) = ports.get(&key) {
            if existing_port == port {
                tracing::info!(
                    "Port {} already reserved by ({}, {}), returning success",
                    port,
                    window_label,
                    project_path
                );
                return true;
            }
            // Pair has a different port - release it first
            port_set.remove(&existing_port);
            tracing::info!(
                "Releasing previous port {} for ({}, {}) before reserving {}",
                existing_port,
                window_label,
                project_path,
                port
            );
        }

        // Check if port is taken by any other (window, project)
        if port_set.contains(&port) {
            tracing::info!(
                "Port {} already reserved by another (window, project)",
                port
            );
            return false;
        }

        port_set.insert(port);
        ports.insert(key, port);
        tracing::info!(
            "Reserved port {} for ({}, {})",
            port,
            window_label,
            project_path
        );
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

/// Release *every* port reserved by a window (across all its projects).
/// Called on window close — we tear down everything that window was holding.
pub fn release_port_for_window(window_label: &str) {
    tracing::info!("release_port_for_window called for '{}'", window_label);
    let ports_result = RESERVED_PORTS.lock();
    let port_set_result = RESERVED_PORT_SET.lock();

    if let (Ok(mut ports), Ok(mut port_set)) = (ports_result, port_set_result) {
        let all_ports_before: Vec<_> = ports
            .iter()
            .map(|((w, p), v)| format!("{w}|{p}:{v}"))
            .collect();
        tracing::info!(
            "release_port_for_window '{}': state before release: {:?}",
            window_label,
            all_ports_before
        );

        let keys_to_remove: Vec<(String, String)> = ports
            .keys()
            .filter(|(w, _)| w == window_label)
            .cloned()
            .collect();

        if keys_to_remove.is_empty() {
            tracing::info!(
                "release_port_for_window '{}': no ports found to release",
                window_label
            );
        }

        for key in keys_to_remove {
            if let Some(port) = ports.remove(&key) {
                port_set.remove(&port);
                tracing::info!("Released port {} from ({}, {})", port, key.0, key.1);
            }
        }
    }
}

/// Release the port reserved by a single `(window, project)` pair.
/// Used when a project is unpinned or its dev server is deliberately stopped.
pub fn release_port_for_project(window_label: &str, project_path: &str) {
    tracing::info!(
        "release_port_for_project called: window='{}', project='{}'",
        window_label,
        project_path
    );
    let ports_result = RESERVED_PORTS.lock();
    let port_set_result = RESERVED_PORT_SET.lock();

    if let (Ok(mut ports), Ok(mut port_set)) = (ports_result, port_set_result) {
        let key = (window_label.to_string(), project_path.to_string());
        if let Some(port) = ports.remove(&key) {
            port_set.remove(&port);
            tracing::info!(
                "Released port {} from ({}, {})",
                port,
                window_label,
                project_path
            );
        } else {
            tracing::info!(
                "release_port_for_project: no port found for ({}, {})",
                window_label,
                project_path
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

/// Rekey an in-memory session from `old_path` to `new_path` after a folder
/// rename. Idempotent and safe when no session exists for `old_path`. Active
/// sessions are blocked from renaming upstream, so in practice this migrates
/// suspended entries that still display on the rail.
pub fn rename_session_path(old_path: &str, new_path: &str) {
    if let Ok(mut sessions) = PROJECT_SESSIONS.lock() {
        if let Some(session) = sessions.remove(old_path) {
            sessions.insert(new_path.to_string(), session);
            tracing::info!(
                "Rekeyed session: {} -> {} (project rename)",
                old_path,
                new_path
            );
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

/// Get the reserved port for a `(window, project)` pair, if any.
pub fn get_reserved_port(window_label: &str, project_path: &str) -> Option<u16> {
    let result = RESERVED_PORTS.lock().ok().and_then(|ports| {
        let all_ports: Vec<_> = ports
            .iter()
            .map(|((w, p), v)| format!("{w}|{p}:{v}"))
            .collect();
        tracing::info!(
            "get_reserved_port called for ({}, {}), current state: {:?}",
            window_label,
            project_path,
            all_ports
        );
        ports
            .get(&(window_label.to_string(), project_path.to_string()))
            .copied()
    });
    tracing::info!(
        "get_reserved_port for ({}, {}) returning: {:?}",
        window_label,
        project_path,
        result
    );
    result
}

#[cfg(test)]
mod mobile_session_tests {
    use super::*;

    fn sample(window_label: &str) -> MobileSession {
        MobileSession {
            udid: "UDID-1".into(),
            booted_by_us: true,
            serve_sim_port: 3100,
            port_was_reserved: false,
            build_session_id: Some("mobile-build:/p".into()),
            window_label: window_label.into(),
            device_name: "iPhone 17".into(),
            device_runtime: Some("iOS 26.1".into()),
        }
    }

    #[test]
    fn register_then_take_round_trips() {
        // Unique key so parallel tests don't collide on global state.
        let path = "/tmp/ms-roundtrip";
        register_mobile_session(path.into(), sample("main"));
        assert_eq!(get_mobile_session(path).unwrap().udid, "UDID-1");
        let taken = take_mobile_session(path).expect("session present");
        assert!(taken.booted_by_us);
        // Taking removes it.
        assert!(get_mobile_session(path).is_none());
        assert!(take_mobile_session(path).is_none());
    }

    #[test]
    fn take_for_window_drains_only_matching_label() {
        register_mobile_session("/tmp/ms-w-a".into(), sample("win-X"));
        register_mobile_session("/tmp/ms-w-b".into(), sample("win-X"));
        register_mobile_session("/tmp/ms-w-c".into(), sample("win-Y"));

        let drained = take_mobile_sessions_for_window("win-X");
        assert_eq!(drained.len(), 2, "only win-X sessions drained");
        assert!(drained.iter().all(|(_, s)| s.window_label == "win-X"));
        assert!(get_mobile_session("/tmp/ms-w-a").is_none());
        assert!(get_mobile_session("/tmp/ms-w-b").is_none());
        // win-Y untouched.
        assert!(get_mobile_session("/tmp/ms-w-c").is_some());
        take_mobile_session("/tmp/ms-w-c"); // cleanup
    }

    #[test]
    fn boot_lock_is_stable_per_project_and_droppable() {
        let path = "/tmp/ms-bootlock";
        let a = boot_lock_for(path);
        let b = boot_lock_for(path);
        // Same project → same underlying lock instance.
        assert!(Arc::ptr_eq(&a, &b));
        drop_boot_lock(path);
        let c = boot_lock_for(path);
        // After drop, a fresh lock is minted.
        assert!(!Arc::ptr_eq(&a, &c));
        drop_boot_lock(path); // cleanup
    }
}
