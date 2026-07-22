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
#[tauri::command]
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

/// Kill all PTY processes owned by a specific window.
///
/// This is the preferred method for cleanup when switching projects in a window.
/// It only kills PTYs belonging to the specified window, leaving other windows' PTYs intact.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_window_pty(window_label: String) -> Result<u32, CommandError> {
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

    Ok(count)
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

/// Kill all PTY processes associated with a specific project path.
///
/// Used by the background-sessions rail to suspend a pinned project's session
/// without affecting other pinned projects sharing the same window. Only kills
/// PTYs whose `project_path` matches; PTYs without a project_path are untouched.
///
/// Returns the number of PTYs killed.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_project_pty(project_path: String) -> Result<u32, CommandError> {
    Ok(kill_project_pty_internal(&project_path))
}

/// Return the PIDs of all PTYs associated with a project. Used for memory
/// queries and process-running checks. Returns an empty vec if no PTYs match.
#[tauri::command]
#[tracing::instrument]
pub async fn get_project_pty_pids(project_path: String) -> Result<Vec<u32>, CommandError> {
    Ok(get_project_pty_pids_internal(&project_path))
}

/// Kill all tracked PTY processes (all windows).
///
/// WARNING: This kills PTYs across ALL windows. Use `kill_window_pty` instead
/// for per-window cleanup. This should only be used during app shutdown.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_all_pty() -> Result<u32, CommandError> {
    let pids: Vec<(u32, u32)> = {
        let registry = PTY_REGISTRY.lock().map_err(|e| e.to_string())?;
        registry.iter().map(|(&id, info)| (id, info.pid)).collect()
    };

    let count = pids.len() as u32;
    tracing::debug!("Killing all {} PTY processes", count);

    for (_id, pid) in pids {
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

    // Clear the registry
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.clear();
    }

    Ok(count)
}

/// Clean up orphaned agent and dev server processes.
///
/// This kills any agent or next-server processes that have become orphaned
/// (parent PID is 1, meaning their parent process died).
#[tauri::command]
#[tracing::instrument]
pub async fn cleanup_orphaned_processes() -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        // Kill orphaned processes for ALL agents (not just the active one)
        for agent in crate::agent::ALL_AGENTS {
            let kill_script = format!(
                r#"
                    for pid in $(pgrep -x {} 2>/dev/null); do
                        ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                        if [ "$ppid" = "1" ]; then
                            kill $pid 2>/dev/null
                        fi
                    done
                "#,
                agent.process_name
            );
            let _ = create_command("sh").args(["-c", &kill_script]).output();
        }

        // Also kill orphaned node processes running next-server (from dev server)
        let _ = create_command("sh")
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

/// True when nothing is listening on `port` on either loopback stack.
/// Only `AddrInUse` counts as occupied — other bind errors (e.g. IPv6
/// loopback unavailable) say nothing about the port.
fn port_is_free(port: u16) -> bool {
    use std::io::ErrorKind;
    use std::net::TcpListener;
    for addr in [format!("127.0.0.1:{port}"), format!("[::1]:{port}")] {
        if let Err(e) = TcpListener::bind(&addr) {
            if e.kind() == ErrorKind::AddrInUse {
                return false;
            }
        }
    }
    true
}

/// Poll until `port` is free or `max_ms` elapses. Returns whether it freed.
async fn wait_port_free(port: u16, max_ms: u64) -> bool {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(max_ms);
    loop {
        let free = tokio::task::spawn_blocking(move || port_is_free(port))
            .await
            .unwrap_or(true);
        if free {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

/// PIDs currently LISTENING on `port`.
///
/// -n: skip DNS lookups, -P: skip port name lookups (both speed up macOS significantly).
/// -sTCP:LISTEN is critical: without it, `-i :PORT` also matches CLIENTS connected to
/// the port — and our own webview holds an established connection to the dev server's
/// port (the Preview pane). Killing those client PIDs takes down the WebKit process
/// and crashes the whole app on dev-server restart. Listeners only.
/// Wrapped in a timeout to prevent hanging when processes are in transitional states.
#[cfg(unix)]
async fn listener_pids(port: u32) -> Vec<i32> {
    let result = tokio::time::timeout(
        tokio::time::Duration::from_secs(3),
        tokio::task::spawn_blocking(move || {
            std::process::Command::new("lsof")
                .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
                .output()
        }),
    )
    .await;
    match result {
        Ok(Ok(Ok(output))) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<i32>().ok())
            .filter(|pid| *pid > 1)
            .collect(),
        _ => Vec::new(),
    }
}

/// Send `signal` to each PID and to its whole process group, so dev-server
/// workers (Turbopack, Vite child processes) die with their parent. PTY
/// children run in their own session, so a listener's group never includes
/// the app — but we still refuse to signal our own group as a hard guard.
#[cfg(unix)]
fn signal_pids(pids: &[i32], signal: &str) {
    let own_pgid = std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<i32>()
                .ok()
        });
    for pid in pids {
        let pgid = std::process::Command::new("ps")
            .args(["-o", "pgid=", "-p", &pid.to_string()])
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<i32>()
                    .ok()
            });
        if let Some(pgid) = pgid {
            if pgid > 1 && Some(pgid) != own_pgid {
                let _ = std::process::Command::new("kill")
                    .args([&format!("-{signal}"), "--", &format!("-{pgid}")])
                    .output();
            }
        }
        let _ = std::process::Command::new("kill")
            .args([&format!("-{signal}"), &pid.to_string()])
            .output();
    }
}

/// Kill any process listening on a specific port, and don't return until the
/// port is actually free (bounded).
///
/// SIGTERM first so dev servers can shut down cleanly, escalating to SIGKILL
/// only for holdouts. The old fire-SIGKILL-and-sleep(100ms) version raced the
/// replacement server: Next/Turbopack got killed mid-write (half-written .next
/// build state, workers surviving the parent) while the new `next dev` was
/// already starting against the same directory — which wedged it into serving
/// 404s for every route until manually restarted.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_port(port: u32) -> Result<(), CommandError> {
    let Ok(port16) = u16::try_from(port) else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        let pids = listener_pids(port).await;
        if pids.is_empty() {
            if !port_is_free(port16) {
                tracing::warn!(port, "kill_port: port occupied but no listener PID found");
            }
            return Ok(());
        }
        {
            let pids = pids.clone();
            let _ = tokio::task::spawn_blocking(move || signal_pids(&pids, "TERM")).await;
        }
        if wait_port_free(port16, 2000).await {
            return Ok(());
        }
        // Escalate — re-list in case the survivors are different processes
        // (e.g. a worker that outlived the parent we TERMed).
        let mut holdouts = listener_pids(port).await;
        if holdouts.is_empty() {
            holdouts = pids;
        }
        let _ = tokio::task::spawn_blocking(move || signal_pids(&holdouts, "KILL")).await;
        if !wait_port_free(port16, 1500).await {
            tracing::warn!(
                port,
                "kill_port: port still occupied after TERM+KILL escalation"
            );
        }
    }

    #[cfg(not(unix))]
    {
        // Windows: netstat + tree-kill (/T) so dev-server workers die with the parent.
        let _ = create_command("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{} ^| findstr LISTENING') do taskkill /F /T /PID %a", port)])
            .output();
        let _ = wait_port_free(port16, 2000).await;
    }

    Ok(())
}

#[cfg(test)]
mod kill_port_tests {
    use super::{port_is_free, wait_port_free};
    use std::net::TcpListener;

    #[test]
    fn port_is_free_detects_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(listener);
        // A parallel test can grab an ephemeral port the instant we drop it,
        // so sample several fresh ports instead of asserting on this one.
        let saw_free = (0..20).any(|_| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let p = l.local_addr().unwrap().port();
            drop(l);
            port_is_free(p)
        });
        assert!(saw_free);
    }

    #[tokio::test]
    async fn wait_port_free_resolves_when_listener_drops() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!wait_port_free(port, 0).await);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
            drop(listener);
        });
        assert!(wait_port_free(port, 3000).await);
        handle.await.unwrap();
    }
}
