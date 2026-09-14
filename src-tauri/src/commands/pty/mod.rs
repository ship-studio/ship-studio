//! # PTY Terminal Commands
//!
//! Commands for pseudo-terminal management and port operations.
//! Supports multi-window isolation by tracking PTY ownership per window.

mod spawn;
mod stream;

pub use spawn::*;
pub use stream::*;

use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path};
use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{LazyLock, Mutex};

/// Counter for generating unique PTY IDs
pub(super) static PTY_ID_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Information about a spawned PTY process
pub(super) struct PtyInfo {
    /// OS process ID
    pub(super) pid: u32,
    /// Window label that owns this PTY (for multi-window isolation)
    pub(super) window_label: String,
    /// Project path this PTY is associated with. `None` means the PTY is not
    /// scoped to a single project (rare — present mainly for back-compat with
    /// callers that haven't been updated yet). Required for the background-
    /// sessions rail to know which PTYs belong to which pinned project.
    pub(super) project_path: Option<String>,
}

/// Global registry of spawned PTY processes
/// Maps our internal PTY ID -> PtyInfo (PID + window label)
pub(super) static PTY_REGISTRY: LazyLock<Mutex<HashMap<u32, PtyInfo>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Lowest PID we will ever signal.
///
/// `kill(2)` gives PIDs below 2 a meaning that has nothing to do with "this
/// process": **0 is every process in the caller's own process group** — which
/// is Ship Studio — and 1 is init/launchd. A dev server is never either one,
/// so anything under this floor is a bug in the caller, not a process to kill.
///
/// This floor exists because of a real incident, not as defensive decoration:
/// the frontend registered `pty.pid` from tauri-pty, which is the plugin's
/// session *handler* (an `AtomicU32` counter starting at 0), not an OS PID.
/// The first dev server of every app session therefore registered as PID 0,
/// and tearing it down ran `kill -TERM 0` → `kill -9 0`, SIGKILLing Ship
/// Studio's own process group. The app vanished mid-frame with no crash
/// report, no `RunEvent::Exit` cleanup, and a log that simply stopped — five
/// times in one day before anyone traced it. The registration is fixed at the
/// source too, but the floor is what makes "the app kills itself" structurally
/// impossible rather than merely unlikely.
const LOWEST_SIGNALABLE_PID: u32 = 2;

/// True when `pid` is safe to pass to `kill`. See [`LOWEST_SIGNALABLE_PID`].
pub(super) fn is_signalable_pid(pid: u32) -> bool {
    pid >= LOWEST_SIGNALABLE_PID
}

/// Check if a process with the given PID is still running
#[cfg(unix)]
pub(super) fn is_process_running(pid: u32) -> bool {
    // `kill -0 0` succeeds for as long as WE are alive (it probes our own
    // process group), so without this guard a bogus 0 reads as "still
    // running" forever and pushes every caller down its force-kill path.
    if !is_signalable_pid(pid) {
        return false;
    }
    // kill -0 checks if process exists without actually sending a signal
    create_command("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Kill a process by PID with graceful shutdown
pub(super) fn kill_process(pid: u32) {
    if !is_signalable_pid(pid) {
        tracing::error!(
            pid,
            "Refusing to kill PID {pid}: signalling it would hit Ship Studio's own \
             process group (0) or launchd (1), not a child process"
        );
        return;
    }

    #[cfg(unix)]
    {
        // Send SIGTERM first for graceful shutdown
        let _ = create_command("kill")
            .args(["-TERM", &pid.to_string()])
            .output();

        // Wait up to 2 seconds for graceful termination, checking every 100ms
        let max_wait_ms = 2000;
        let check_interval_ms = 100;
        let mut waited_ms = 0;

        while waited_ms < max_wait_ms {
            std::thread::sleep(std::time::Duration::from_millis(check_interval_ms));
            waited_ms += check_interval_ms;

            if !is_process_running(pid) {
                // Process terminated gracefully
                return;
            }
        }

        // Force kill if still running after grace period
        if is_process_running(pid) {
            let _ = create_command("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }

    #[cfg(windows)]
    {
        // /T kills the entire process tree (cmd.exe + child node.exe, etc.)
        let _ = create_command("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
}

/// Get the reserved port for a `(window, project)` pair, if any.
/// Returns None if no port is reserved for this pair.
#[tauri::command]
#[tracing::instrument]
pub fn get_reserved_port_for_window(window_label: String, project_path: String) -> Option<u16> {
    tracing::info!(
        "get_reserved_port_for_window called: window='{}', project='{}'",
        window_label,
        project_path
    );
    let result = crate::state::get_reserved_port(&window_label, &project_path);
    tracing::info!(
        "get_reserved_port_for_window returning {:?} for ({}, {})",
        result,
        window_label,
        project_path
    );
    result
}

/// Find and reserve an available port for a `(window, project)` pair.
/// Atomically finds a port and reserves it. If the pair already holds one,
/// returns it (idempotent) — different projects in the same window each get
/// their own port independently.
#[tauri::command]
#[tracing::instrument]
pub fn find_and_reserve_port(
    window_label: String,
    project_path: String,
    preferred_port: u16,
) -> Result<u16, CommandError> {
    use std::net::TcpListener;

    tracing::info!(
        "find_and_reserve_port called: window='{}', project='{}', preferred_port={}",
        window_label,
        project_path,
        preferred_port
    );

    // Idempotent: if this pair already has a port, return it.
    if let Some(existing_port) = crate::state::get_reserved_port(&window_label, &project_path) {
        tracing::info!(
            "({}, {}) already has port {} reserved, returning existing",
            window_label,
            project_path,
            existing_port
        );
        return Ok(existing_port);
    }

    // Try ports starting from preferred, up to preferred + 100
    for port in preferred_port..preferred_port.saturating_add(100) {
        // Check if port is reserved by some other (window, project)
        if crate::state::is_port_reserved(port) {
            continue;
        }

        // Check if port is actually available on the machine
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            // Try to reserve this port atomically
            if crate::state::reserve_port(&window_label, &project_path, port) {
                tracing::info!(
                    "Reserved port {} for ({}, {})",
                    port,
                    window_label,
                    project_path
                );
                return Ok(port);
            }
            // If reservation failed (race condition), try next port
        }
    }

    Err((format!(
        "Could not find available port in range {}-{}",
        preferred_port,
        preferred_port.saturating_add(99)
    ))
    .into())
}

/// Release a reserved port for a `(window, project)` pair.
/// Called when a project's dev server is deliberately stopped or the project
/// is being torn down. For window-wide cleanup on close, the backend calls
/// `release_port_for_window` directly.
#[tauri::command]
#[tracing::instrument]
pub fn release_reserved_port(
    window_label: String,
    project_path: String,
) -> Result<(), CommandError> {
    tracing::info!(
        "release_reserved_port called: window='{}', project='{}'",
        window_label,
        project_path
    );
    crate::state::release_port_for_project(&window_label, &project_path);
    Ok(())
}

/// Get the extended PATH that includes nvm, Homebrew, and other common tool locations.
///
/// This is needed for the frontend PTY spawn since macOS apps don't inherit shell PATH.
#[tauri::command]
#[tracing::instrument]
pub fn get_shell_path() -> String {
    get_extended_path()
}

/// Get essential system environment variables needed for the dev server PTY.
///
/// On Windows, the PTY env replaces the parent environment, so we need to
/// forward critical system vars (SystemRoot, COMSPEC, PATHEXT, TEMP, etc.)
/// that Node.js and cmd.exe require to function.
/// On macOS/Linux, returns an empty map (the Unix env vars are hardcoded in the frontend).
#[tauri::command]
#[tracing::instrument]
pub fn get_system_env() -> std::collections::HashMap<String, String> {
    #[allow(unused_mut)]
    let mut env = std::collections::HashMap::new();

    #[cfg(windows)]
    {
        // These are required for Node.js, npm, and cmd.exe to work on Windows
        let keys = [
            "PATH",
            "SystemRoot",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "CommonProgramFiles",
            "windir",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "OS",
            "USERNAME",
        ];
        for key in keys {
            if let Ok(val) = std::env::var(key) {
                env.insert(key.to_string(), val);
            }
        }
    }

    env
}

#[cfg(test)]
mod pid_guard_tests {
    use super::*;

    /// The incident this guard exists for: tauri-pty hands out session
    /// handlers starting at 0, the frontend registered one as a PID, and
    /// `kill -TERM 0` signalled Ship Studio's own process group.
    #[test]
    fn pid_zero_is_never_signalable() {
        assert!(
            !is_signalable_pid(0),
            "PID 0 is the caller's own process group — signalling it kills Ship Studio"
        );
    }

    #[test]
    fn pid_one_is_never_signalable() {
        assert!(
            !is_signalable_pid(1),
            "PID 1 is launchd/init, never our child"
        );
    }

    #[test]
    fn real_pids_stay_signalable() {
        // The guard must not cost us the ability to kill actual dev servers.
        for pid in [2, 3, 42, 3814, 99_999] {
            assert!(
                is_signalable_pid(pid),
                "PID {pid} is a real process and must be killable"
            );
        }
    }

    /// `kill -0 0` succeeds while we are alive, so an unguarded liveness probe
    /// reports a bogus PID as "still running" forever — which pushed
    /// `kill_process` past its grace period and into `kill -9` every time.
    #[cfg(unix)]
    #[test]
    fn bogus_pids_never_read_as_running() {
        assert!(!is_process_running(0));
        assert!(!is_process_running(1));
    }

    /// Belt and braces: calling the killer with 0 must return without
    /// signalling anything. If this regresses, the test process (and the test
    /// runner's whole process group) is what gets killed — which is precisely
    /// the failure being guarded, so a regression is unmissable.
    #[cfg(unix)]
    #[test]
    fn killing_pid_zero_is_a_no_op() {
        kill_process(0);
        kill_process(1);
    }
}
