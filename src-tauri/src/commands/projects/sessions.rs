//! # Project Session Lifecycle Commands
//!
//! Backend authority over **which projects have a live (active or suspended)
//! session and where**. The frontend `SessionRegistry` (Phase 2) talks to this
//! via Tauri commands.
//!
//! This module is the enforcement point for the core invariant:
//!
//! > One project path → at most one live session, ever.
//!
//! `register_project_session` rejects a registration that would attach the
//! same project to a second window. Repeated registration from the same
//! window is idempotent and bumps `last_activity_at`.
//!
//! Suspending a session kills its PTYs (via `kill_project_pty`) and marks
//! the registry entry `Suspended`. The pin and last-session metadata stay
//! in `pins.json` so the user can resume cold-start later.

use crate::commands::pty::{get_project_pty_pids_internal, kill_project_pty_internal};
use crate::errors::CommandError;
use crate::state::{
    count_active_sessions, get_session, list_sessions, mark_session_suspended,
    register_session as state_register_session, touch_session,
    unregister_session as state_unregister_session, ProjectSessionBackend,
};
use serde::Serialize;

/// Frontend-facing view of a project session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionInfo {
    pub project_path: String,
    pub owning_window_label: String,
    pub status: crate::state::SessionStatus,
    pub activated_at: u64,
    pub last_activity_at: u64,
    /// Number of PTY processes currently registered for this project.
    pub pty_count: usize,
}

impl ProjectSessionInfo {
    fn from_backend(
        project_path: String,
        backend: ProjectSessionBackend,
        pty_count: usize,
    ) -> Self {
        Self {
            project_path,
            owning_window_label: backend.owning_window_label,
            status: backend.status,
            activated_at: backend.activated_at,
            last_activity_at: backend.last_activity_at,
            pty_count,
        }
    }
}

/// Memory usage breakdown for a project session, in bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemoryReport {
    pub project_path: String,
    /// Sum of RSS across all PTY processes associated with the project.
    pub total_bytes: u64,
    /// Per-PID RSS in bytes (length matches the number of associated PTYs).
    pub per_pid: Vec<PidMemory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PidMemory {
    pub pid: u32,
    pub bytes: u64,
}

// ============ Tauri Commands ============

/// Register a new project session as active for the given window.
///
/// **Invariant guard:** if the project already has a session under a different
/// window, this returns a Validation error. Same window → idempotent (just
/// touches `last_activity_at`).
#[tauri::command]
#[tracing::instrument]
pub async fn register_project_session(
    project_path: String,
    window_label: String,
) -> Result<(), CommandError> {
    state_register_session(&project_path, &window_label).map_err(|reason| {
        CommandError::Validation {
            field: "project_path".into(),
            reason,
        }
    })
}

/// Suspend a project session: kill its PTY processes and mark the entry
/// `Suspended` in the registry. The pin remains in `pins.json` so the user
/// can later resume by cold-starting.
///
/// Returns the number of PTYs killed. Idempotent — calling on an already-
/// suspended session is a no-op (still returns 0 unless lingering PTYs are found).
#[tauri::command]
#[tracing::instrument]
pub async fn suspend_project_session(project_path: String) -> Result<u32, CommandError> {
    Ok(suspend_session_internal(&project_path).await)
}

/// Shared suspension teardown: kill the project's PTYs, tear down its mobile
/// preview, and mark the registry entry `Suspended`. Used by the
/// `suspend_project_session` command and by `rename_project`, which suspends
/// a hot background session before moving the folder out from under it.
/// Returns the number of PTYs killed.
pub async fn suspend_session_internal(project_path: &str) -> u32 {
    let killed = kill_project_pty_internal(project_path);
    // Suspending frees the project's resources — the mobile preview (serve-sim
    // daemon + app-build pty_session) lives in registries the PTY sweep above
    // doesn't reach, so tear it down explicitly here too.
    crate::commands::mobile::teardown_mobile_preview(project_path.to_string()).await;
    mark_session_suspended(project_path);
    tracing::info!(
        "Suspended session: project={}, killed_ptys={}",
        project_path,
        killed
    );
    killed
}

/// Fully remove a project session from the registry.
///
/// Does NOT kill PTYs — the frontend's existing cleanup flow
/// (`stopServer` → `kill_window_pty` → `kill_port`) already handles
/// PTY teardown with proper ordering and nav-version guards. Killing
/// PTYs here raced with that flow and, in dev mode, could `kill -9`
/// processes in the Tauri dev server's process tree.
///
/// Note: this does NOT unpin the project — that's a separate `unpin_project`
/// call. A user might want to close a session while leaving the pin in place
/// so it can be reactivated later.
#[tauri::command]
#[tracing::instrument]
pub async fn unregister_project_session(project_path: String) -> Result<(), CommandError> {
    state_unregister_session(&project_path);
    // Closing the project tears down its mobile preview (backend-owned session).
    crate::commands::mobile::teardown_mobile_preview(project_path.clone()).await;
    tracing::info!("Unregistered session: project={}", project_path,);
    Ok(())
}

/// Bump the session's last-activity timestamp. Cheap, safe to call frequently
/// (terminal input, focus events, etc.). LRU eviction in Phase 5 uses this.
#[tauri::command]
#[tracing::instrument]
pub async fn touch_project_session(project_path: String) -> Result<(), CommandError> {
    touch_session(&project_path);
    Ok(())
}

/// List all currently registered sessions (active + suspended).
#[tauri::command]
#[tracing::instrument]
pub async fn list_project_sessions() -> Result<Vec<ProjectSessionInfo>, CommandError> {
    let sessions = list_sessions();
    Ok(sessions
        .into_iter()
        .map(|(path, backend)| {
            let pty_count = get_project_pty_pids_internal(&path).len();
            ProjectSessionInfo::from_backend(path, backend, pty_count)
        })
        .collect())
}

/// Look up a single session by project path. Returns `None` if no session.
#[tauri::command]
#[tracing::instrument]
pub async fn get_project_session_info(
    project_path: String,
) -> Result<Option<ProjectSessionInfo>, CommandError> {
    Ok(get_session(&project_path).map(|backend| {
        let pty_count = get_project_pty_pids_internal(&project_path).len();
        ProjectSessionInfo::from_backend(project_path, backend, pty_count)
    }))
}

/// Count of currently active sessions. Used by the rail UI to enforce the
/// soft cap (default 5) before allowing a new session to spawn.
#[tauri::command]
#[tracing::instrument]
pub async fn get_active_session_count() -> Result<usize, CommandError> {
    Ok(count_active_sessions())
}

/// Query memory usage for a project session by summing RSS across its PIDs.
///
/// Uses platform-native tools: `ps -o rss=` on Unix (returns KB → multiplied
/// to bytes), `tasklist /FI` on Windows. Returns zeroes if no PIDs match.
#[tauri::command]
#[tracing::instrument]
pub async fn get_session_memory(project_path: String) -> Result<SessionMemoryReport, CommandError> {
    let pids = get_project_pty_pids_internal(&project_path);

    let mut per_pid = Vec::with_capacity(pids.len());
    let mut total = 0u64;

    for pid in pids {
        let bytes = read_process_rss(pid).unwrap_or(0);
        per_pid.push(PidMemory { pid, bytes });
        total = total.saturating_add(bytes);
    }

    Ok(SessionMemoryReport {
        project_path,
        total_bytes: total,
        per_pid,
    })
}

// ============ Internals ============

/// Read RSS (Resident Set Size) of a process in bytes.
/// Returns `None` if the process can't be queried (gone, perms, etc.).
#[cfg(unix)]
fn read_process_rss(pid: u32) -> Option<u64> {
    let output = crate::utils::create_command("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let kb: u64 = stdout.trim().parse().ok()?;
    // ps reports RSS in kilobytes on macOS/Linux
    Some(kb.saturating_mul(1024))
}

#[cfg(windows)]
fn read_process_rss(pid: u32) -> Option<u64> {
    let output = crate::utils::create_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    // CSV format: "ImageName","PID","SessionName","Session#","MemUsage"
    // MemUsage is e.g. "12,345 K"
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?;
    let last_field = line.rsplit(',').next()?.trim_matches('"').trim();
    let kb_str: String = last_field.chars().filter(|c| c.is_ascii_digit()).collect();
    let kb: u64 = kb_str.parse().ok()?;
    Some(kb.saturating_mul(1024))
}

// ============ Tests ============

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::OnceLock;

    /// Tests share global PROJECT_SESSIONS state, so serialize them.
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    /// Wipe the registry so each test starts clean.
    fn reset_registry() {
        let sessions = list_sessions();
        for (path, _) in sessions {
            state_unregister_session(&path);
        }
    }

    #[tokio::test]
    async fn register_then_lookup_returns_session() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-a".into(), "main".into())
            .await
            .unwrap();

        let info = get_project_session_info("/tmp/proj-a".into())
            .await
            .unwrap()
            .expect("session should exist");
        assert_eq!(info.project_path, "/tmp/proj-a");
        assert_eq!(info.owning_window_label, "main");
        assert_eq!(info.status, crate::state::SessionStatus::Active);
    }

    #[tokio::test]
    async fn register_same_project_same_window_is_idempotent() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-b".into(), "main".into())
            .await
            .unwrap();
        register_project_session("/tmp/proj-b".into(), "main".into())
            .await
            .unwrap();
        register_project_session("/tmp/proj-b".into(), "main".into())
            .await
            .unwrap();

        let count = list_project_sessions().await.unwrap().len();
        assert_eq!(count, 1, "duplicate registrations must not stack");
    }

    #[tokio::test]
    async fn register_same_project_different_window_rejects() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-c".into(), "main".into())
            .await
            .unwrap();
        let result = register_project_session("/tmp/proj-c".into(), "second-window".into()).await;

        assert!(
            matches!(result, Err(CommandError::Validation { .. })),
            "second-window registration must fail with Validation: {result:?}"
        );
    }

    #[tokio::test]
    async fn register_after_unregister_succeeds_for_new_window() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-d".into(), "main".into())
            .await
            .unwrap();
        unregister_project_session("/tmp/proj-d".into())
            .await
            .unwrap();
        register_project_session("/tmp/proj-d".into(), "second-window".into())
            .await
            .unwrap();

        let info = get_project_session_info("/tmp/proj-d".into())
            .await
            .unwrap()
            .expect("session should exist after re-register");
        assert_eq!(info.owning_window_label, "second-window");
    }

    #[tokio::test]
    async fn suspend_marks_session_suspended_without_removing() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-e".into(), "main".into())
            .await
            .unwrap();
        suspend_project_session("/tmp/proj-e".into()).await.unwrap();

        let info = get_project_session_info("/tmp/proj-e".into())
            .await
            .unwrap()
            .expect("suspended session should still exist");
        assert_eq!(info.status, crate::state::SessionStatus::Suspended);
    }

    #[tokio::test]
    async fn unregister_removes_session() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-f".into(), "main".into())
            .await
            .unwrap();
        unregister_project_session("/tmp/proj-f".into())
            .await
            .unwrap();

        assert!(get_project_session_info("/tmp/proj-f".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn active_count_excludes_suspended() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-g".into(), "main".into())
            .await
            .unwrap();
        register_project_session("/tmp/proj-h".into(), "main".into())
            .await
            .unwrap();
        register_project_session("/tmp/proj-i".into(), "main".into())
            .await
            .unwrap();
        suspend_project_session("/tmp/proj-h".into()).await.unwrap();

        let active = get_active_session_count().await.unwrap();
        assert_eq!(active, 2, "suspended sessions must not count as active");

        // Cleanup
        for p in ["/tmp/proj-g", "/tmp/proj-h", "/tmp/proj-i"] {
            unregister_project_session(p.into()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn touch_updates_last_activity() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-j".into(), "main".into())
            .await
            .unwrap();
        let before = get_project_session_info("/tmp/proj-j".into())
            .await
            .unwrap()
            .unwrap()
            .last_activity_at;

        // Sleep long enough that millis tick over
        tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
        touch_project_session("/tmp/proj-j".into()).await.unwrap();

        let after = get_project_session_info("/tmp/proj-j".into())
            .await
            .unwrap()
            .unwrap()
            .last_activity_at;

        assert!(after > before, "touch must advance last_activity_at");
    }

    #[tokio::test]
    async fn memory_report_returns_zero_for_no_ptys() {
        let _g = lock();
        reset_registry();

        register_project_session("/tmp/proj-k".into(), "main".into())
            .await
            .unwrap();
        let report = get_session_memory("/tmp/proj-k".into()).await.unwrap();

        assert_eq!(report.project_path, "/tmp/proj-k");
        assert_eq!(report.total_bytes, 0);
        assert!(report.per_pid.is_empty());
    }
}
