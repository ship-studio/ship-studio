//! PTY lifecycle and port-killing commands — reading the registry and terminating
//! tracked processes, plus cleanup of orphaned agent/dev-server processes.

use super::{kill_process, PTY_REGISTRY};
use crate::errors::CommandError;
use crate::utils::create_command;

/// Kill a PTY process by its ID.
///
/// This terminates a process spawned by `spawn_pty`. Returns Ok(true) if the process
/// was found and killed, Ok(false) if no process with that ID was found.
///
/// Uses SIGTERM first to allow graceful shutdown, then SIGKILL after a timeout.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn kill_pty(id: u32) -> Result<bool, CommandError> {
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
            let _ = create_command("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = create_command("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }

        // Remove from registry
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(id);
        }
    }

    count
}

/// Kill all PTY processes associated with a specific project path (sync).
///
/// Internal helper shared by the Tauri command and the sessions module.
/// Returns the number of PTYs killed.
pub fn kill_project_pty_internal(project_path: &str) -> u32 {
    let pids_to_kill: Vec<(u32, u32)> = {
        let Ok(registry) = PTY_REGISTRY.lock() else {
            return 0;
        };
        registry
            .iter()
            .filter(|(_, info)| info.project_path.as_deref() == Some(project_path))
            .map(|(&id, info)| (id, info.pid))
            .collect()
    };

    let count = pids_to_kill.len() as u32;
    tracing::info!(
        "Killing {} PTY processes for project {}",
        count,
        project_path
    );

    for (id, pid) in &pids_to_kill {
        #[cfg(unix)]
        {
            let _ = create_command("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = create_command("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }

        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(id);
        }
    }

    count
}

/// Return PIDs of all PTYs associated with a project (sync internal).
pub fn get_project_pty_pids_internal(project_path: &str) -> Vec<u32> {
    let Ok(registry) = PTY_REGISTRY.lock() else {
        return Vec::new();
    };
    registry
        .iter()
        .filter(|(_, info)| info.project_path.as_deref() == Some(project_path))
        .map(|(_, info)| info.pid)
        .collect()
}

/// Kill all tracked PTY processes (sync version, all windows).
///
/// App-exit-only: the `RunEvent::Exit` hook can't await, and the quit path
/// (`exit(0)` after a prevented close request) never fires the per-window
/// `Destroyed` cleanup — without this sweep dev servers survive the app and
/// keep their ports (issue #229).
pub fn kill_all_pty_sync() -> u32 {
    let pids: Vec<(u32, u32)> = {
        let Ok(registry) = PTY_REGISTRY.lock() else {
            return 0;
        };
        registry.iter().map(|(&id, info)| (id, info.pid)).collect()
    };

    for (_id, pid) in &pids {
        #[cfg(unix)]
        {
            let _ = create_command("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = create_command("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
    }

    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.clear();
    }

    pids.len() as u32
}

/// Kill any process listening on a specific port
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn kill_port(port: u32) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        // Use lsof to find the PID LISTENING on the port, then kill it.
        // -n: skip DNS lookups, -P: skip port name lookups (both speed up macOS significantly).
        // -sTCP:LISTEN is critical: without it, `-i :PORT` also matches CLIENTS connected to
        // the port — and our own webview holds an established connection to the dev server's
        // port (the Preview pane). Killing those client PIDs with `kill -9` takes down the
        // WebKit process and crashes the whole app on dev-server restart. Listeners only.
        // Wrap in a timeout to prevent hanging when processes are in transitional states.
        let lsof_result = tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("lsof")
                    .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
                    .output()
            }),
        )
        .await;

        if let Ok(Ok(Ok(output))) = lsof_result {
            if output.status.success() {
                let pids = String::from_utf8_lossy(&output.stdout);
                for pid in pids.lines() {
                    if let Ok(pid_num) = pid.trim().parse::<i32>() {
                        kill_listener_and_group(pid_num);
                    }
                }
            }
        }
        // If lsof timed out or failed, proceed anyway — port may already be free
    }

    #[cfg(not(unix))]
    {
        // Windows: use netstat and taskkill. /T kills the listener's whole
        // process tree — dev servers fork workers that would otherwise survive
        // and hold state (issues #229, #243).
        let _ = create_command("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{} ^| findstr LISTENING') do taskkill /F /T /PID %a", port)])
            .output();
    }

    // Wait until the port is actually free (bounded) instead of hoping 100ms
    // is enough. A dev server's worker tree can take longer to tear down, and
    // respawning against a half-dead predecessor corrupts its on-disk state —
    // the "every route 404s until manual restart" failure (issue #243).
    for _ in 0..20 {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        if !port_is_listening(port) {
            break;
        }
    }

    Ok(())
}

/// True while something still accepts TCP connections on `port`. Resolves
/// `localhost` (not a hardcoded 127.0.0.1) so dev servers bound to either
/// stack are seen — same lesson as the preview proxy's upstream connect.
fn port_is_listening(port: u32) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let Ok(addrs) = format!("localhost:{port}").to_socket_addrs() else {
        return false;
    };
    addrs.into_iter().any(|addr| {
        TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok()
    })
}

/// Kill the process listening on a port — and its whole process group.
///
/// `kill -9 <pid>` alone leaves the dev server's forked workers (Turbopack
/// compilers, npm→node wrappers) alive; a survivor can hold or re-bind the
/// port and serve a stale route table where every request 404s (issue #243).
/// Escalates TERM→KILL on the group, guarded so we can never signal our own
/// process group or the init group. Falls back to the old single-PID SIGKILL
/// when the group can't be resolved or is shared with us.
#[cfg(unix)]
fn kill_listener_and_group(pid: i32) {
    let pgid_of = |p: i32| -> Option<i32> {
        let out = create_command("ps")
            .args(["-o", "pgid=", "-p", &p.to_string()])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    };

    let own_pgid = pgid_of(std::process::id() as i32);
    match pgid_of(pid) {
        Some(pgid) if pgid > 1 && own_pgid.is_some_and(|own| own != pgid) => {
            let group = format!("-{pgid}");
            let _ = create_command("kill").args(["-TERM", &group]).output();
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = create_command("kill").args(["-9", &group]).output();
        }
        _ => {
            let _ = create_command("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }
}
