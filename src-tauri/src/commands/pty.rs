//! # PTY Terminal Commands
//!
//! Commands for pseudo-terminal management and port operations.
//! Supports multi-window isolation by tracking PTY ownership per window.

use crate::types::SpawnPtyOptions;
use crate::utils::get_extended_path;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

/// Counter for generating unique PTY IDs
static PTY_ID_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Information about a spawned PTY process
struct PtyInfo {
    /// OS process ID
    pid: u32,
    /// Window label that owns this PTY (for multi-window isolation)
    window_label: String,
}

lazy_static::lazy_static! {
    /// Global registry of spawned PTY processes
    /// Maps our internal PTY ID -> PtyInfo (PID + window label)
    static ref PTY_REGISTRY: Mutex<HashMap<u32, PtyInfo>> = Mutex::new(HashMap::new());
}

/// Spawns a command in a pseudo-terminal (PTY) and streams output to the frontend.
///
/// This is used to run Claude Code CLI in an interactive terminal environment.
/// The function:
/// 1. Generates a unique PTY ID for tracking
/// 2. Spawns the command in a separate thread to avoid blocking
/// 3. Streams stdout/stderr to the specific window via `pty-output` events
/// 4. Emits `pty-exit` event when the process terminates
///
/// Events emitted (to the specified window only):
/// - `pty-output`: `{ id: u32, data: string }` - output chunks from the process
/// - `pty-exit`: `{ id: u32, code: i32 }` - process exit code
///
/// The `window_label` parameter ensures events are only sent to the window that
/// spawned the PTY, enabling multi-window isolation.
#[tauri::command]
pub async fn spawn_pty(
    app: tauri::AppHandle,
    options: SpawnPtyOptions,
    window_label: String,
) -> Result<u32, String> {
    let id = PTY_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    let app_handle = app.clone();
    let label_for_thread = window_label.clone();

    std::thread::spawn(move || {
        let label = label_for_thread;
        let result = (|| -> Result<i32, String> {
            let mut child = Command::new(&options.command)
                .args(&options.args)
                .current_dir(&options.cwd)
                .env("PATH", get_extended_path())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            // Store the process info for potential cleanup
            let pid = child.id();
            if let Ok(mut registry) = PTY_REGISTRY.lock() {
                registry.insert(
                    id,
                    PtyInfo {
                        pid,
                        window_label: label.clone(),
                    },
                );
            }

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Read stdout in a thread - emit to specific window only
            let app_for_stdout = app_handle.clone();
            let label_for_stdout = label.clone();
            let stdout_handle = stdout.map(|stdout| {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines().map_while(Result::ok) {
                        let _ = app_for_stdout.emit_to(
                            &label_for_stdout,
                            "pty-output",
                            serde_json::json!({
                                "id": id,
                                "data": format!("{}\r\n", line)
                            }),
                        );
                    }
                })
            });

            // Read stderr in a thread - emit to specific window only
            let app_for_stderr = app_handle.clone();
            let label_for_stderr = label.clone();
            let stderr_handle = stderr.map(|stderr| {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        let _ = app_for_stderr.emit_to(
                            &label_for_stderr,
                            "pty-output",
                            serde_json::json!({
                                "id": id,
                                "data": format!("{}\r\n", line)
                            }),
                        );
                    }
                })
            });

            // Wait for output threads
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }

            // Wait for process to exit
            let status = child.wait().map_err(|e| e.to_string())?;
            Ok(status.code().unwrap_or(-1))
        })();

        // Remove from registry when process exits
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(&id);
        }

        // Emit exit event to specific window only
        let exit_code = result.unwrap_or(-1);
        let _ = app_handle.emit_to(
            &label,
            "pty-exit",
            serde_json::json!({
                "id": id,
                "code": exit_code
            }),
        );
    });

    Ok(id)
}

/// Register an externally-spawned PTY process (like dev servers from tauri-pty).
///
/// This allows the backend to track and kill PTY processes that weren't spawned
/// through the `spawn_pty` command. Essential for cleaning up dev servers when
/// windows are closed.
///
/// The `pty_id` should be unique (e.g., the PTY ID from tauri-pty or a timestamp).
#[tauri::command]
pub fn register_external_pty(
    window_label: String,
    pid: u32,
    pty_id: u32,
    description: String,
) -> Result<(), String> {
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.insert(
            pty_id,
            PtyInfo {
                pid,
                window_label: window_label.clone(),
            },
        );
        tracing::info!(
            "Registered external PTY for window {}: pty_id={}, pid={}, desc={}",
            window_label,
            pty_id,
            pid,
            description
        );
        Ok(())
    } else {
        Err("Failed to lock PTY registry".to_string())
    }
}

/// Unregister an externally-spawned PTY process.
///
/// Called when the PTY exits normally (before window close) to keep the registry clean.
#[tauri::command]
pub fn unregister_external_pty(pty_id: u32) -> Result<(), String> {
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        if let Some(info) = registry.remove(&pty_id) {
            tracing::info!(
                "Unregistered external PTY: pty_id={}, pid={}, window={}",
                pty_id,
                info.pid,
                info.window_label
            );
        }
        Ok(())
    } else {
        Err("Failed to lock PTY registry".to_string())
    }
}

/// Check if a process with the given PID is still running
#[cfg(unix)]
fn is_process_running(pid: u32) -> bool {
    // kill -0 checks if process exists without actually sending a signal
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Kill a process by PID with graceful shutdown
fn kill_process(pid: u32) {
    #[cfg(unix)]
    {
        // Send SIGTERM first for graceful shutdown
        let _ = Command::new("kill")
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
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        }
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}

/// Kill a PTY process by its ID.
///
/// This terminates a process spawned by `spawn_pty`. Returns Ok(true) if the process
/// was found and killed, Ok(false) if no process with that ID was found.
///
/// Uses SIGTERM first to allow graceful shutdown, then SIGKILL after a timeout.
#[tauri::command]
pub async fn kill_pty(id: u32) -> Result<bool, String> {
    let pid = {
        let registry = PTY_REGISTRY.lock().map_err(|e| e.to_string())?;
        registry.get(&id).map(|info| info.pid)
    };

    if let Some(pid) = pid {
        kill_process(pid);

        // Remove from registry
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(&id);
        }

        Ok(true)
    } else {
        Ok(false)
    }
}

/// Kill all PTY processes owned by a specific window (sync version).
///
/// Used during window close cleanup where async isn't available.
pub fn kill_window_pty_sync(window_label: &str) -> u32 {
    let pids_to_kill: Vec<(u32, u32)> = {
        let Ok(registry) = PTY_REGISTRY.lock() else {
            return 0;
        };
        registry
            .iter()
            .filter(|(_, info)| info.window_label == window_label)
            .map(|(&id, info)| (id, info.pid))
            .collect()
    };

    let count = pids_to_kill.len() as u32;
    tracing::info!(
        "Killing {} PTY processes for window {} (window close cleanup)",
        count,
        window_label
    );

    for (id, pid) in &pids_to_kill {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        }

        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }

        // Remove from registry
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(id);
        }
    }

    count
}

/// Kill all PTY processes owned by a specific window.
///
/// This is the preferred method for cleanup when switching projects in a window.
/// It only kills PTYs belonging to the specified window, leaving other windows' PTYs intact.
#[tauri::command]
pub async fn kill_window_pty(window_label: String) -> Result<u32, String> {
    let pids_to_kill: Vec<(u32, u32)> = {
        let registry = PTY_REGISTRY.lock().map_err(|e| e.to_string())?;
        registry
            .iter()
            .filter(|(_, info)| info.window_label == window_label)
            .map(|(&id, info)| (id, info.pid))
            .collect()
    };

    let count = pids_to_kill.len() as u32;
    tracing::debug!(
        "Killing {} PTY processes for window {}",
        count,
        window_label
    );

    for (id, pid) in &pids_to_kill {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        }

        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }

        // Remove from registry
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(id);
        }
    }

    Ok(count)
}

/// Kill all tracked PTY processes (all windows).
///
/// WARNING: This kills PTYs across ALL windows. Use `kill_window_pty` instead
/// for per-window cleanup. This should only be used during app shutdown.
#[tauri::command]
pub async fn kill_all_pty() -> Result<u32, String> {
    let pids: Vec<(u32, u32)> = {
        let registry = PTY_REGISTRY.lock().map_err(|e| e.to_string())?;
        registry.iter().map(|(&id, info)| (id, info.pid)).collect()
    };

    let count = pids.len() as u32;
    tracing::debug!("Killing all {} PTY processes", count);

    for (_id, pid) in pids {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        }

        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }
    }

    // Clear the registry
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.clear();
    }

    Ok(count)
}

/// Clean up orphaned Claude and dev server processes.
///
/// This kills any Claude or next-server processes that have become orphaned
/// (parent PID is 1, meaning their parent process died).
#[tauri::command]
pub async fn cleanup_orphaned_processes() -> Result<(), String> {
    #[cfg(unix)]
    {
        // Kill orphaned claude processes (parent is init/launchd - PID 1)
        let _ = Command::new("sh")
            .args([
                "-c",
                r#"
                for pid in $(pgrep -x claude 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#,
            ])
            .output();

        // Also kill orphaned node processes running next-server (from dev server)
        let _ = Command::new("sh")
            .args([
                "-c",
                r#"
                for pid in $(pgrep -f 'next-server' 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#,
            ])
            .output();
    }

    Ok(())
}

/// Kill any process listening on a specific port
#[tauri::command]
pub async fn kill_port(port: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Use lsof to find the PID listening on the port, then kill it
        let output = Command::new("lsof")
            .args(["-ti", &format!(":{port}")])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.lines() {
                if let Ok(pid_num) = pid.trim().parse::<i32>() {
                    // Kill the process and its children
                    let _ = Command::new("kill")
                        .args(["-9", &pid_num.to_string()])
                        .output();
                }
            }
        }
    }

    #[cfg(not(unix))]
    {
        // Windows: use netstat and taskkill
        let _ = Command::new("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{} ^| findstr LISTENING') do taskkill /F /PID %a", port)])
            .output();
    }

    // Give processes time to die
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    Ok(())
}

/// Get the reserved port for a specific window.
/// Returns None if no port is reserved for this window.
#[tauri::command]
pub fn get_reserved_port_for_window(window_label: String) -> Option<u16> {
    tracing::info!(
        "get_reserved_port_for_window command called with window_label='{}'",
        window_label
    );
    let result = crate::state::get_reserved_port(&window_label);
    tracing::info!(
        "get_reserved_port_for_window returning {:?} for '{}'",
        result,
        window_label
    );
    result
}

/// Find an available port starting from the preferred port.
///
/// Tries the preferred port first, then increments until finding an available one.
/// Also checks against reserved ports to avoid race conditions in multi-window scenarios.
/// Returns the first available port found.
#[tauri::command]
pub fn find_available_port(preferred_port: u16) -> Result<u16, String> {
    use std::net::TcpListener;

    // Try ports starting from preferred, up to preferred + 100
    for port in preferred_port..preferred_port.saturating_add(100) {
        // Check if port is reserved by another window (prevents race condition)
        if crate::state::is_port_reserved(port) {
            tracing::debug!("Port {} is reserved by another window, skipping", port);
            continue;
        }

        // Check if port is actually available (not bound by another process)
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }

    Err(format!(
        "Could not find available port in range {}-{}",
        preferred_port,
        preferred_port.saturating_add(99)
    ))
}

/// Find and reserve an available port for a specific window.
/// This atomically finds a port and reserves it to prevent race conditions.
/// If the window already has a port reserved, returns that port (idempotent).
/// Returns the reserved port.
#[tauri::command]
pub fn find_and_reserve_port(window_label: String, preferred_port: u16) -> Result<u16, String> {
    use std::net::TcpListener;

    tracing::info!(
        "find_and_reserve_port command called: window_label='{}', preferred_port={}",
        window_label,
        preferred_port
    );

    // First check if this window already has a port reserved (idempotent)
    if let Some(existing_port) = crate::state::get_reserved_port(&window_label) {
        tracing::info!(
            "Window {} already has port {} reserved, returning existing",
            window_label,
            existing_port
        );
        return Ok(existing_port);
    }

    // Try ports starting from preferred, up to preferred + 100
    for port in preferred_port..preferred_port.saturating_add(100) {
        // Check if port is reserved by another window
        if crate::state::is_port_reserved(port) {
            continue;
        }

        // Check if port is actually available
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            // Try to reserve this port atomically
            if crate::state::reserve_port(&window_label, port) {
                tracing::info!("Reserved port {} for window {}", port, window_label);
                return Ok(port);
            }
            // If reservation failed (race condition), try next port
        }
    }

    Err(format!(
        "Could not find available port in range {}-{}",
        preferred_port,
        preferred_port.saturating_add(99)
    ))
}

/// Release a reserved port for a window.
/// Called when a window is closing or when dev server stops.
#[tauri::command]
pub fn release_reserved_port(window_label: String) -> Result<(), String> {
    tracing::info!(
        "release_reserved_port command called for window_label='{}'",
        window_label
    );
    crate::state::release_port_for_window(&window_label);
    Ok(())
}

/// Get the extended PATH that includes nvm, Homebrew, and other common tool locations.
///
/// This is needed for the frontend PTY spawn since macOS apps don't inherit shell PATH.
#[tauri::command]
pub fn get_shell_path() -> String {
    get_extended_path()
}
