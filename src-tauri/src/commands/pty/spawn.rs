//! PTY spawning and external registration commands.

use super::{PtyInfo, PTY_ID_COUNTER, PTY_REGISTRY};
use crate::errors::CommandError;
use crate::types::SpawnPtyOptions;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use tauri::Emitter;

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
#[tracing::instrument(skip(app, options))]
pub async fn spawn_pty(
    app: tauri::AppHandle,
    options: SpawnPtyOptions,
    window_label: String,
    project_path: Option<String>,
) -> Result<u32, CommandError> {
    // Constrain the working directory to a ShipStudio/registered project so a
    // compromised webview can't spawn a process anywhere on disk. The frontend
    // always launches terminals in a project root, a workspace subpath, or the
    // ~/ShipStudio root itself — all of which validate.
    let validated_cwd = validate_project_path(&options.cwd)?;
    let mut options = options;
    options.cwd = validated_cwd.to_string_lossy().to_string();

    let id = PTY_ID_COUNTER.fetch_add(1, Ordering::SeqCst);
    let app_handle = app.clone();
    let label_for_thread = window_label.clone();
    let project_path_for_thread = project_path.clone();

    std::thread::spawn(move || {
        let label = label_for_thread;
        let project_path = project_path_for_thread;
        let result = (|| -> Result<i32, String> {
            // On Windows, commands like npm/npx are .cmd batch scripts,
            // so we must run them through cmd.exe to resolve them.
            #[cfg(windows)]
            let (cmd, cmd_args) = {
                let mut args = vec!["/C".to_string(), options.command.clone()];
                args.extend(options.args.iter().cloned());
                ("cmd".to_string(), args)
            };
            #[cfg(not(windows))]
            let (cmd, cmd_args) = (options.command.clone(), options.args.clone());

            let mut child = create_command(&cmd)
                .args(&cmd_args)
                .current_dir(&options.cwd)
                .env("PATH", get_extended_path())
                // Inject the *project's* workspace env (its Claude/GitHub/Codex
                // config dirs + credentials), falling back to the active
                // workspace when this PTY isn't tied to a project. This keeps a
                // terminal opened in a Beta-workspace project on Beta's logins
                // even if the globally-active workspace is Acme.
                .envs(match project_path.as_deref() {
                    Some(p) => {
                        crate::commands::accounts::get_env_vars_for_project(std::path::Path::new(p))
                    }
                    None => crate::commands::accounts::get_env_vars_for_active_account(),
                })
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
                        project_path: project_path.clone(),
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
            match status.code() {
                Some(code) => Ok(code),
                None => {
                    // Unix: code() is None when a signal terminated the
                    // process (OOM-killer SIGKILL, crash, kill …). This used
                    // to collapse to a silent -1 with zero context — emit the
                    // signal as pty-output first so runPtyToExit can attach
                    // it, same as the spawn-failure path below (issue #589).
                    #[cfg(unix)]
                    {
                        use std::os::unix::process::ExitStatusExt;
                        let detail = describe_signal_termination(status.signal());
                        let _ = app_handle.emit_to(
                            &label,
                            "pty-output",
                            serde_json::json!({
                                "id": id,
                                "data": format!("{detail}\r\n"),
                            }),
                        );
                    }
                    Ok(-1)
                }
            }
        })();

        // Remove from registry when process exits
        if let Ok(mut registry) = PTY_REGISTRY.lock() {
            registry.remove(&id);
        }

        // Emit exit event to specific window only. A spawn/wait failure used
        // to collapse into a bare exit code -1 with no output at all — the
        // real io::Error ("No such file or directory", EACCES…) was fully
        // known and silently discarded, leaving the user and telemetry with
        // an undiagnosable "Process exited with code -1" (issues #463/#464).
        // Emit the failure as pty-output first so runPtyToExit includes it.
        let exit_code = match result {
            Ok(code) => code,
            Err(e) => {
                let _ = app_handle.emit_to(
                    &label,
                    "pty-output",
                    serde_json::json!({
                        "id": id,
                        "data": format!("Failed to start process: {e}\r\n"),
                    }),
                );
                -1
            }
        };
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

/// Human-readable description of a signal-terminated child. `signal` is
/// `ExitStatus::signal()` — `Some(n)` for the terminating signal, `None` if
/// the platform couldn't report one. Names the common signals and hints at
/// the usual culprit (the OOM killer sends SIGKILL to e.g. a pnpm install
/// that exhausts memory — issue #589).
#[cfg_attr(not(unix), allow(dead_code))]
fn describe_signal_termination(signal: Option<i32>) -> String {
    let Some(sig) = signal else {
        return "Process was terminated abnormally (no exit code reported)".to_string();
    };
    let name = match sig {
        1 => " (SIGHUP)",
        2 => " (SIGINT)",
        6 => " (SIGABRT)",
        9 => " (SIGKILL)",
        11 => " (SIGSEGV)",
        13 => " (SIGPIPE)",
        15 => " (SIGTERM)",
        _ => "",
    };
    let hint = match sig {
        9 => " — likely killed by the operating system, e.g. because it ran out of memory",
        11 => " — the program crashed (segmentation fault)",
        _ => "",
    };
    format!("Process was terminated by signal {sig}{name}{hint}")
}

/// Register an externally-spawned PTY process (like dev servers from tauri-pty).
///
/// This allows the backend to track and kill PTY processes that weren't spawned
/// through the `spawn_pty` command. Essential for cleaning up dev servers when
/// windows are closed.
///
/// The `pty_id` should be unique (e.g., the PTY ID from tauri-pty or a timestamp).
#[tauri::command]
#[tracing::instrument]
pub fn register_external_pty(
    window_label: String,
    pid: u32,
    pty_id: u32,
    description: String,
    project_path: Option<String>,
) -> Result<(), CommandError> {
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.insert(
            pty_id,
            PtyInfo {
                pid,
                window_label: window_label.clone(),
                project_path: project_path.clone(),
            },
        );
        tracing::info!(
            "Registered external PTY for window {}: pty_id={}, pid={}, project={:?}, desc={}",
            window_label,
            pty_id,
            pid,
            project_path,
            description
        );
        Ok(())
    } else {
        Err(("Failed to lock PTY registry".to_string()).into())
    }
}

/// Unregister an externally-spawned PTY process.
///
/// Called when the PTY exits normally (before window close) to keep the registry clean.
#[tauri::command]
#[tracing::instrument]
pub fn unregister_external_pty(pty_id: u32) -> Result<(), CommandError> {
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
        Err(("Failed to lock PTY registry".to_string()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::describe_signal_termination;

    // The #589 shape: pnpm install OOM-killed mid-import surfaced only as
    // "Process exited with code -1". SIGKILL must name the likely OOM cause.
    #[test]
    fn sigkill_mentions_signal_name_and_oom_hint() {
        let msg = describe_signal_termination(Some(9));
        assert!(msg.contains("signal 9"), "got: {msg}");
        assert!(msg.contains("SIGKILL"), "got: {msg}");
        assert!(msg.contains("out of memory"), "got: {msg}");
    }

    #[test]
    fn sigsegv_mentions_crash() {
        let msg = describe_signal_termination(Some(11));
        assert!(msg.contains("SIGSEGV"), "got: {msg}");
        assert!(msg.contains("crashed"), "got: {msg}");
    }

    #[test]
    fn unknown_signal_still_reports_the_number() {
        let msg = describe_signal_termination(Some(31));
        assert!(msg.contains("terminated by signal 31"), "got: {msg}");
    }

    #[test]
    fn missing_signal_info_gets_a_generic_but_honest_message() {
        let msg = describe_signal_termination(None);
        assert!(msg.contains("terminated abnormally"), "got: {msg}");
    }
}
