//! PTY spawning and external registration commands.

use super::{PtyInfo, PTY_ID_COUNTER, PTY_REGISTRY};
use crate::errors::CommandError;
use crate::external_command::{spawn_helper_thread, thread_spawn_error};
use crate::types::SpawnPtyOptions;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use tauri::Emitter;

/// After the child exits, how long its output readers get to flush trailing
/// output before `pty-exit` is emitted without them. Readers normally hit EOF
/// within milliseconds; one that doesn't is blocked on a pipe that a
/// surviving descendant still holds open.
const READER_DRAIN_GRACE: Duration = Duration::from_secs(2);

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

    // A named, small-stack thread from a fallible spawn: when the OS can't
    // create another thread (Windows os error 1450 after a long session),
    // std::thread::spawn panics — this returns a classified error instead.
    spawn_helper_thread(format!("pty-{id}"), move || {
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

            // Windows: tie the whole process tree to a kill-on-close job.
            // `cmd /C npm run dev` is a chain of processes, and any descendant
            // that outlives `cmd.exe` (orphaned, so `taskkill /T` can't find it
            // by parent PID) inherits our stdout/stderr pipes. Those pipes then
            // never reach EOF, and the reader threads below — previously joined
            // before `wait()` — stayed blocked forever: three leaked threads per
            // dev-server start/stop, which over a long session exhausts the
            // system's thread resources (os error 1450). Closing the job after
            // the child exits takes the stragglers down with it.
            #[cfg(windows)]
            let job = match super::job::KillOnCloseJob::assign(&child) {
                Ok(job) => Some(job),
                Err(e) => {
                    tracing::warn!(pty_id = id, error = %e, "couldn't assign PTY child to a job object");
                    None
                }
            };

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

            // Each reader holds a sender; the channel disconnecting is "every
            // reader reached EOF".
            let (readers_done_tx, readers_done_rx) = mpsc::channel::<()>();

            // Read stdout in a thread - emit to specific window only
            let app_for_stdout = app_handle.clone();
            let label_for_stdout = label.clone();
            let stdout_done = readers_done_tx.clone();
            let stdout_handle = stdout.map(|stdout| {
                spawn_helper_thread(format!("pty-{id}-stdout"), move || {
                    let _done = stdout_done;
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
            let stderr_done = readers_done_tx.clone();
            let stderr_handle = stderr.map(|stderr| {
                spawn_helper_thread(format!("pty-{id}-stderr"), move || {
                    let _done = stderr_done;
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

            drop(readers_done_tx);
            for handle in [stdout_handle, stderr_handle].into_iter().flatten() {
                if let Err(e) = handle {
                    // Out of threads: don't leave a child nobody reads from.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("couldn't start an output reader thread: {e}"));
                }
            }

            #[cfg(windows)]
            let after_exit = move || drop(job);
            #[cfg(not(windows))]
            let after_exit = || {};
            let status = wait_and_drain(
                &mut child,
                &readers_done_rx,
                READER_DRAIN_GRACE,
                after_exit,
            )
            .map_err(|e| e.to_string())?;
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
    })
    .map_err(|e| thread_spawn_error("spawn_pty", &e))?;

    Ok(id)
}

/// Wait for `child` to exit, run `after_exit`, then give its output readers
/// up to `grace` to reach EOF (all senders of `readers_done` dropped).
///
/// Waiting on the child — not the readers — is what bounds this thread's
/// life: a reader can stay blocked for as long as any descendant holds the
/// pipe, which is unbounded. The readers keep their own (bounded-by-the-pipe)
/// lifetime; this thread, its registry entry and the `pty-exit` event no
/// longer depend on them.
fn wait_and_drain(
    child: &mut std::process::Child,
    readers_done: &mpsc::Receiver<()>,
    grace: Duration,
    after_exit: impl FnOnce(),
) -> std::io::Result<std::process::ExitStatus> {
    let status = child.wait()?;
    after_exit();
    if let Err(mpsc::RecvTimeoutError::Timeout) = readers_done.recv_timeout(grace) {
        tracing::warn!(
            pid = child.id(),
            "process exited but its output pipe is still held open (likely a surviving \
             child process); not waiting for the readers"
        );
    }
    Ok(status)
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
    format!(
        "Process was terminated by {}",
        crate::external_command::describe_signal(sig)
    )
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
    // Reject a PID we could never legitimately signal before it reaches the
    // registry. PID 0 means "my own process group" to `kill(2)`, so storing it
    // here is how Ship Studio used to kill itself on the next teardown: the
    // frontend passed tauri-pty's session handler (a counter from 0) instead
    // of an OS PID, and the session's first dev server always handed us 0.
    // `kill_process` refuses it too; rejecting here means the registry never
    // holds a lie in the first place, and the caller hears about it.
    if !super::is_signalable_pid(pid) {
        tracing::error!(
            pty_id,
            pid,
            %window_label,
            "Refusing to register PTY with PID {pid} — not an OS process ID"
        );
        return Err(CommandError::Validation {
            field: "pid".to_string(),
            reason: format!(
                "{pid} is not a real process ID (0 means this app's own process group, \
                 1 means launchd), so PTY {pty_id} cannot be tracked for cleanup"
            ),
        });
    }

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
    use super::*;

    /// The registry must never hold a PID that would signal us. This is the
    /// exact shape the frontend used to send: tauri-pty's session handler,
    /// which is 0 for the first dev server of every app launch.
    #[test]
    fn register_external_pty_rejects_pid_zero() {
        let err = register_external_pty(
            "main".to_string(),
            0,
            123_456,
            "Dev server on port 3814".to_string(),
            Some("/tmp/project".to_string()),
        )
        .expect_err("PID 0 must be rejected — it is our own process group");

        assert!(matches!(err, CommandError::Validation { .. }));
        assert!(
            !PTY_REGISTRY.lock().unwrap().contains_key(&123_456),
            "a rejected PID must not reach the registry"
        );
    }

    #[test]
    fn register_external_pty_rejects_pid_one() {
        let err = register_external_pty(
            "main".to_string(),
            1,
            123_457,
            "Dev server".to_string(),
            None,
        )
        .expect_err("PID 1 is launchd");
        assert!(matches!(err, CommandError::Validation { .. }));
        assert!(!PTY_REGISTRY.lock().unwrap().contains_key(&123_457));
    }

    #[test]
    fn register_external_pty_accepts_a_real_pid() {
        register_external_pty(
            "main".to_string(),
            48_231,
            123_458,
            "Dev server on port 3000".to_string(),
            Some("/tmp/project".to_string()),
        )
        .expect("a real PID must still register");

        let registry = PTY_REGISTRY.lock().unwrap();
        assert_eq!(registry.get(&123_458).map(|info| info.pid), Some(48_231));
    }

    use super::describe_signal_termination;

    /// The 1450 leak: a descendant that outlives the child keeps the output
    /// pipe open, so a reader never sees EOF. The spawn thread used to join
    /// the readers before waiting on the child and stayed blocked with them;
    /// it must now return once the child exits plus the drain grace.
    #[cfg(unix)]
    #[test]
    fn wait_and_drain_returns_when_a_descendant_holds_the_pipe() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & echo $!"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let stdout = child.stdout.take().unwrap();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let (pid_tx, pid_rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let _done = done_tx;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = pid_tx.send(line);
            }
        });

        let started = std::time::Instant::now();
        let mut after_exit_ran = false;
        let status = wait_and_drain(&mut child, &done_rx, Duration::from_millis(300), || {
            after_exit_ran = true;
        })
        .expect("wait");

        assert!(status.success());
        assert!(after_exit_ran);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "waited {:?} on a pipe a surviving descendant holds open",
            started.elapsed()
        );

        let sleeper = pid_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("background pid");
        let _ = std::process::Command::new("kill").arg(&sleeper).status();
    }

    /// Normal case: readers that reach EOF promptly are fully drained before
    /// wait_and_drain returns, so pty-exit still follows the last output.
    #[cfg(unix)]
    #[test]
    fn wait_and_drain_waits_for_readers_that_finish() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "echo one; echo two"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let stdout = child.stdout.take().unwrap();
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let sink = lines.clone();
        std::thread::spawn(move || {
            let _done = done_tx;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                std::thread::sleep(Duration::from_millis(50));
                sink.lock().unwrap().push(line);
            }
        });

        let status =
            wait_and_drain(&mut child, &done_rx, Duration::from_secs(5), || {}).expect("wait");
        assert!(status.success());
        assert_eq!(*lines.lock().unwrap(), vec!["one", "two"]);
    }

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
