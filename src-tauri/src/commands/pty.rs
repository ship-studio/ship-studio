//! # PTY Terminal Commands
//!
//! Commands for pseudo-terminal management and port operations.

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

lazy_static::lazy_static! {
    /// Global registry of spawned PTY process PIDs for cleanup
    /// Maps our internal PTY ID -> OS process ID (PID)
    static ref PTY_PIDS: Mutex<HashMap<u32, u32>> = Mutex::new(HashMap::new());
}

/// Spawns a command in a pseudo-terminal (PTY) and streams output to the frontend.
///
/// This is used to run Claude Code CLI in an interactive terminal environment.
/// The function:
/// 1. Generates a unique PTY ID for tracking
/// 2. Spawns the command in a separate thread to avoid blocking
/// 3. Streams stdout/stderr to the frontend via `pty-output` events
/// 4. Emits `pty-exit` event when the process terminates
///
/// Events emitted:
/// - `pty-output`: `{ id: u32, data: string }` - output chunks from the process
/// - `pty-exit`: `{ id: u32, code: i32 }` - process exit code
#[tauri::command]
pub async fn spawn_pty(app: tauri::AppHandle, options: SpawnPtyOptions) -> Result<u32, String> {
    let id = PTY_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let result = (|| -> Result<i32, String> {
            let mut child = Command::new(&options.command)
                .args(&options.args)
                .current_dir(&options.cwd)
                .env("PATH", get_extended_path())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            // Store the process PID for potential cleanup
            let pid = child.id();
            if let Ok(mut pids) = PTY_PIDS.lock() {
                pids.insert(id, pid);
            }

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Read stdout in a thread
            let app_for_stdout = app_handle.clone();
            let stdout_handle = stdout.map(|stdout| {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines().map_while(Result::ok) {
                        let _ = app_for_stdout.emit(
                            "pty-output",
                            serde_json::json!({
                                "id": id,
                                "data": format!("{}\r\n", line)
                            }),
                        );
                    }
                })
            });

            // Read stderr in a thread
            let app_for_stderr = app_handle.clone();
            let stderr_handle = stderr.map(|stderr| {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        let _ = app_for_stderr.emit(
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

        // Remove PID from registry when process exits
        if let Ok(mut pids) = PTY_PIDS.lock() {
            pids.remove(&id);
        }

        // Emit exit event
        let exit_code = result.unwrap_or(-1);
        let _ = app_handle.emit(
            "pty-exit",
            serde_json::json!({
                "id": id,
                "code": exit_code
            }),
        );
    });

    Ok(id)
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

/// Kill a PTY process by its ID.
///
/// This terminates a process spawned by `spawn_pty`. Returns Ok(true) if the process
/// was found and killed, Ok(false) if no process with that ID was found.
///
/// Uses SIGTERM first to allow graceful shutdown, then SIGKILL after a timeout.
#[tauri::command]
pub async fn kill_pty(id: u32) -> Result<bool, String> {
    let pid = {
        let pids = PTY_PIDS.lock().map_err(|e| e.to_string())?;
        pids.get(&id).copied()
    };

    if let Some(pid) = pid {
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
                    break;
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

        // Remove from registry
        if let Ok(mut pids) = PTY_PIDS.lock() {
            pids.remove(&id);
        }

        Ok(true)
    } else {
        Ok(false)
    }
}

/// Kill all tracked PTY processes.
///
/// This is useful for cleanup when switching projects or closing the app.
#[tauri::command]
pub async fn kill_all_pty() -> Result<u32, String> {
    let pids: Vec<(u32, u32)> = {
        let pids = PTY_PIDS.lock().map_err(|e| e.to_string())?;
        pids.iter().map(|(&id, &pid)| (id, pid)).collect()
    };

    let count = pids.len() as u32;

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
    if let Ok(mut pids) = PTY_PIDS.lock() {
        pids.clear();
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
            .args(["-ti", &format!(":{}", port)])
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

/// Find an available port starting from the preferred port.
///
/// Tries the preferred port first, then increments until finding an available one.
/// Returns the first available port found.
#[tauri::command]
pub fn find_available_port(preferred_port: u16) -> Result<u16, String> {
    use std::net::TcpListener;

    // Try ports starting from preferred, up to preferred + 100
    for port in preferred_port..preferred_port.saturating_add(100) {
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

/// Get the extended PATH that includes nvm, Homebrew, and other common tool locations.
///
/// This is needed for the frontend PTY spawn since macOS apps don't inherit shell PATH.
#[tauri::command]
pub fn get_shell_path() -> String {
    get_extended_path()
}
