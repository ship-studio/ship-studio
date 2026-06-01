//! # Pinned Projects Persistence
//!
//! Stores the list of projects pinned to the rail sidebar, plus per-pin
//! session metadata (last agent, last terminal session IDs) used to cold-start
//! a session on next launch.
//!
//! Storage location matches `app_state.json`:
//! - macOS: `~/Library/Application Support/ShipStudio/pins.json`
//! - Windows: `%LOCALAPPDATA%/ShipStudio/pins.json`
//! - Linux: `$XDG_DATA_HOME/ship-studio/pins.json`
//!
//! Read/write is serialized through `PINS_FILE_LOCK` to prevent races
//! between multiple windows mutating the file concurrently.

use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

/// Process-wide lock for serializing pins.json read-modify-write operations.
static PINS_FILE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Per-pin session metadata persisted across app restarts.
///
/// On launch, pinned projects start in a "suspended" state. When the user
/// clicks one, this metadata cold-starts the session — Claude resumes via
/// `--resume <tab_session_ids[N]>`, the saved tab layout is restored, etc.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    /// Per-tab Claude/Codex session IDs in tab order. Used with `--resume`.
    #[serde(default)]
    pub tab_session_ids: Vec<String>,
    /// Index of the last active tab.
    #[serde(default)]
    pub active_tab_index: usize,
    /// Last agent ID (e.g. "claude-code", "codex"). Optional — falls back to default.
    #[serde(default)]
    pub last_agent: Option<String>,
    /// Unix millis timestamp of when the session was last suspended/quit.
    #[serde(default)]
    pub suspended_at: Option<u64>,
}

/// On-disk shape of `pins.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinsFile {
    /// Pinned project paths in display order (left-to-right on the rail).
    #[serde(default)]
    pub pinned_paths: Vec<String>,
    /// Per-pin session metadata. Keys are project paths.
    #[serde(default)]
    pub last_sessions: HashMap<String, LastSession>,
}

/// Returns the absolute path to `pins.json` for the current OS.
pub(crate) fn get_pins_file_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/ShipStudio/pins.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-pins.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ShipStudio/pins.json"))
            .unwrap_or_else(|| PathBuf::from("C:/temp/ship-studio-pins.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ship-studio/pins.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-pins.json"))
    }
}

/// Read pins from disk. Returns an empty `PinsFile` if the file does not
/// exist or is malformed (legacy installs / corruption recovery).
pub fn read_pins() -> PinsFile {
    let path = get_pins_file_path();
    if !path.exists() {
        return PinsFile::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write pins to disk, creating the parent directory if needed.
pub fn write_pins(pins: &PinsFile) -> Result<(), String> {
    let path = get_pins_file_path();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create pins directory: {e}"))?;
    }

    let json =
        serde_json::to_string_pretty(pins).map_err(|e| format!("Failed to serialize pins: {e}"))?;

    std::fs::write(&path, json).map_err(|e| format!("Failed to write pins: {e}"))
}

/// Mutate pins under the file lock. The closure receives a mutable reference
/// to the current on-disk state and returns the value to give the caller.
fn with_pins_locked<F, T>(f: F) -> Result<T, CommandError>
where
    F: FnOnce(&mut PinsFile) -> T,
{
    let _guard = PINS_FILE_LOCK
        .lock()
        .map_err(|_| "pins file lock poisoned")?;
    let mut pins = read_pins();
    let result = f(&mut pins);
    write_pins(&pins)?;
    Ok(result)
}

// ============ Tauri Commands ============

/// Add a project to the pinned list. Idempotent — repeated calls are no-ops.
///
/// **Invariant guard:** this is the only path that grows `pinned_paths`.
/// It deduplicates by path so the same project can never appear twice.
#[tauri::command]
#[tracing::instrument]
pub async fn pin_project(project_path: String) -> Result<Vec<String>, CommandError> {
    with_pins_locked(|pins| {
        if !pins.pinned_paths.iter().any(|p| p == &project_path) {
            pins.pinned_paths.push(project_path.clone());
            tracing::info!("Pinned project: {}", project_path);
        } else {
            tracing::debug!("Pin already exists, no-op: {}", project_path);
        }
        pins.pinned_paths.clone()
    })
}

/// Remove a project from the pinned list. Also clears its `last_sessions` entry
/// so the next pin starts fresh. Idempotent.
#[tauri::command]
#[tracing::instrument]
pub async fn unpin_project(project_path: String) -> Result<Vec<String>, CommandError> {
    with_pins_locked(|pins| {
        let before = pins.pinned_paths.len();
        pins.pinned_paths.retain(|p| p != &project_path);
        pins.last_sessions.remove(&project_path);
        if pins.pinned_paths.len() < before {
            tracing::info!("Unpinned project: {}", project_path);
        }
        pins.pinned_paths.clone()
    })
}

/// Rekey a pinned project from `old_path` to `new_path` after a folder rename.
///
/// Preserves pin order and any `last_sessions` metadata (Claude/Codex resume
/// IDs, tab layout). No-op if `old_path` isn't pinned. Not a Tauri command —
/// called internally by `rename_project`.
pub fn rename_pinned_path(old_path: &str, new_path: &str) -> Result<(), CommandError> {
    with_pins_locked(|pins| {
        for p in &mut pins.pinned_paths {
            if p == old_path {
                *p = new_path.to_string();
            }
        }
        if let Some(session) = pins.last_sessions.remove(old_path) {
            pins.last_sessions.insert(new_path.to_string(), session);
        }
    })
}

/// Return the current ordered list of pinned project paths.
#[tauri::command]
#[tracing::instrument]
pub async fn list_pinned_projects() -> Result<Vec<String>, CommandError> {
    Ok(read_pins().pinned_paths)
}

/// Replace the pin order. Validates that the new order contains exactly the
/// same set of paths as the current pins — no adds, no removes, just reorder.
/// Returns `Validation` error if the sets differ.
#[tauri::command]
#[tracing::instrument]
pub async fn reorder_pins(ordered_paths: Vec<String>) -> Result<Vec<String>, CommandError> {
    with_pins_locked(|pins| -> Result<Vec<String>, CommandError> {
        use std::collections::HashSet;
        let current: HashSet<&String> = pins.pinned_paths.iter().collect();
        let proposed: HashSet<&String> = ordered_paths.iter().collect();

        if current != proposed {
            return Err(CommandError::Validation {
                field: "ordered_paths".into(),
                reason: "must contain exactly the currently pinned paths".into(),
            });
        }

        // Reject duplicates within the proposed order
        if proposed.len() != ordered_paths.len() {
            return Err(CommandError::Validation {
                field: "ordered_paths".into(),
                reason: "duplicate paths in reorder request".into(),
            });
        }

        pins.pinned_paths = ordered_paths.clone();
        tracing::info!("Reordered pins: {} entries", ordered_paths.len());
        Ok(ordered_paths)
    })?
}

/// Persist per-pin session metadata. Called when the user closes the app or
/// suspends a session — captures tab session IDs so we can `--resume` later.
#[tauri::command]
#[tracing::instrument]
pub async fn save_pin_session(
    project_path: String,
    session: LastSession,
) -> Result<(), CommandError> {
    with_pins_locked(|pins| {
        // Only save sessions for currently pinned projects — avoids leaking
        // stale data for unpinned projects.
        if pins.pinned_paths.iter().any(|p| p == &project_path) {
            pins.last_sessions.insert(project_path.clone(), session);
            tracing::debug!("Saved pin session for: {}", project_path);
        } else {
            tracing::debug!(
                "Skipped session save for unpinned project: {}",
                project_path
            );
        }
    })
}

/// Read per-pin session metadata, or `None` if not yet saved.
#[tauri::command]
#[tracing::instrument]
pub async fn get_pin_session(project_path: String) -> Result<Option<LastSession>, CommandError> {
    Ok(read_pins().last_sessions.get(&project_path).cloned())
}

// ============ Tests ============

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Tests share global filesystem state (~/Library/.../pins.json), so
    /// serialize them to avoid interference. We snapshot+restore the file.
    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    struct PinsSnapshot {
        original: Option<String>,
    }

    impl PinsSnapshot {
        fn capture() -> Self {
            let path = get_pins_file_path();
            let original = std::fs::read_to_string(&path).ok();
            // Start each test with a clean slate
            let _ = std::fs::remove_file(&path);
            Self { original }
        }
    }

    impl Drop for PinsSnapshot {
        fn drop(&mut self) {
            let path = get_pins_file_path();
            match &self.original {
                Some(content) => {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&path, content);
                }
                None => {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    #[tokio::test]
    async fn pin_project_is_idempotent() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let path = "/tmp/test-project-a".to_string();
        pin_project(path.clone()).await.unwrap();
        pin_project(path.clone()).await.unwrap();
        pin_project(path.clone()).await.unwrap();

        let pins = list_pinned_projects().await.unwrap();
        assert_eq!(pins.len(), 1, "duplicate pins must not accumulate");
        assert_eq!(pins[0], path);
    }

    #[tokio::test]
    async fn unpin_project_removes_path_and_session() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let path = "/tmp/test-project-b".to_string();
        pin_project(path.clone()).await.unwrap();
        save_pin_session(
            path.clone(),
            LastSession {
                tab_session_ids: vec!["sess-1".into()],
                active_tab_index: 0,
                last_agent: Some("claude-code".into()),
                suspended_at: Some(123),
            },
        )
        .await
        .unwrap();

        unpin_project(path.clone()).await.unwrap();

        assert!(list_pinned_projects().await.unwrap().is_empty());
        assert!(get_pin_session(path).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reorder_preserves_set_and_changes_order() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let a = "/tmp/test-project-c".to_string();
        let b = "/tmp/test-project-d".to_string();
        let c = "/tmp/test-project-e".to_string();

        pin_project(a.clone()).await.unwrap();
        pin_project(b.clone()).await.unwrap();
        pin_project(c.clone()).await.unwrap();

        let new_order = vec![c.clone(), a.clone(), b.clone()];
        let result = reorder_pins(new_order.clone()).await.unwrap();
        assert_eq!(result, new_order);

        let pins = list_pinned_projects().await.unwrap();
        assert_eq!(pins, new_order);
    }

    #[tokio::test]
    async fn reorder_rejects_added_path() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let a = "/tmp/test-project-f".to_string();
        let b = "/tmp/test-project-g".to_string();
        pin_project(a.clone()).await.unwrap();

        let result = reorder_pins(vec![a, b]).await;
        assert!(result.is_err(), "reorder must reject set changes");
    }

    #[tokio::test]
    async fn reorder_rejects_removed_path() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let a = "/tmp/test-project-h".to_string();
        let b = "/tmp/test-project-i".to_string();
        pin_project(a.clone()).await.unwrap();
        pin_project(b).await.unwrap();

        let result = reorder_pins(vec![a]).await;
        assert!(result.is_err(), "reorder must reject set changes");
    }

    #[tokio::test]
    async fn reorder_rejects_duplicates() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let a = "/tmp/test-project-j".to_string();
        pin_project(a.clone()).await.unwrap();

        let result = reorder_pins(vec![a.clone(), a]).await;
        assert!(result.is_err(), "reorder must reject duplicates");
    }

    #[tokio::test]
    async fn save_pin_session_skipped_when_unpinned() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let path = "/tmp/test-project-k".to_string();
        // Not pinned — save should silently skip
        save_pin_session(path.clone(), LastSession::default())
            .await
            .unwrap();

        assert!(get_pin_session(path).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn pins_round_trip_through_disk() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let path = "/tmp/test-project-l".to_string();
        pin_project(path.clone()).await.unwrap();
        save_pin_session(
            path.clone(),
            LastSession {
                tab_session_ids: vec!["sess-x".into(), "sess-y".into()],
                active_tab_index: 1,
                last_agent: Some("codex".into()),
                suspended_at: Some(999),
            },
        )
        .await
        .unwrap();

        // Read back from disk via a fresh `read_pins` (not cached)
        let on_disk = read_pins();
        assert_eq!(on_disk.pinned_paths, vec![path.clone()]);
        let session = on_disk.last_sessions.get(&path).unwrap();
        assert_eq!(session.tab_session_ids, vec!["sess-x", "sess-y"]);
        assert_eq!(session.active_tab_index, 1);
        assert_eq!(session.last_agent.as_deref(), Some("codex"));
        assert_eq!(session.suspended_at, Some(999));
    }

    #[tokio::test]
    async fn rename_pinned_path_rekeys_and_preserves_session() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let old = "/tmp/test-project-old".to_string();
        let new = "/tmp/test-project-new".to_string();
        pin_project(old.clone()).await.unwrap();
        save_pin_session(
            old.clone(),
            LastSession {
                tab_session_ids: vec!["s1".into()],
                active_tab_index: 0,
                last_agent: Some("claude-code".into()),
                suspended_at: Some(7),
            },
        )
        .await
        .unwrap();

        rename_pinned_path(&old, &new).unwrap();

        // Pin order entry moved to the new path...
        assert_eq!(list_pinned_projects().await.unwrap(), vec![new.clone()]);
        // ...old session key is gone, new key carries the same metadata.
        assert!(get_pin_session(old).await.unwrap().is_none());
        let session = get_pin_session(new).await.unwrap().unwrap();
        assert_eq!(session.tab_session_ids, vec!["s1"]);
        assert_eq!(session.last_agent.as_deref(), Some("claude-code"));
    }

    #[tokio::test]
    async fn rename_pinned_path_is_noop_for_unpinned() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        // Renaming a path that was never pinned must not create an entry.
        rename_pinned_path("/tmp/never-pinned", "/tmp/whatever").unwrap();
        assert!(list_pinned_projects().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn read_pins_returns_default_when_file_missing() {
        let _g = TEST_LOCK.lock().unwrap();
        let _snap = PinsSnapshot::capture();

        let pins = read_pins();
        assert!(pins.pinned_paths.is_empty());
        assert!(pins.last_sessions.is_empty());
    }
}
