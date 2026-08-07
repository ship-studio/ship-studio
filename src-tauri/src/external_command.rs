//! Shared helper for invoking external CLIs (gh, vercel, git, claude, codex …).
//!
//! Centralizes:
//! - Timeout enforcement (so a hung CLI can't lock up a Tauri command forever)
//! - Structured error mapping into `CommandError`
//! - tracing instrumentation at debug/warn levels
//!
//! Per-module callers (e.g. `commands/github.rs`) construct a `tokio::process::Command`
//! with their PATH/env tweaks, then hand it to [`run_with_timeout`] for execution.
//!
//! Block 9 of the DX refactor will layer an `ExternalCommand` trait on top of this for
//! per-CLI typed wrappers; this helper is the foundation.

use crate::errors::CommandError;
use std::time::Duration;
use tokio::process::Command;
use tracing::{debug, warn};

/// Default timeout for any external CLI invocation. Individual callers can
/// override per call.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Run an external command with a timeout. Returns the captured `Output` on
/// success, or a `CommandError::Timeout` / `CommandError::Io` on failure.
///
/// Note: this returns the raw `Output` (including non-zero exit status). Caller
/// is responsible for inspecting `output.status` and mapping to
/// `CommandError::Process` if it represents a domain-level failure.
pub async fn run_with_timeout(
    mut cmd: Command,
    cmd_label: impl Into<String>,
    timeout_secs: u64,
) -> Result<std::process::Output, CommandError> {
    let label = cmd_label.into();
    debug!(cmd = %label, timeout_secs, "spawning external command");

    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;

    match result {
        Ok(Ok(output)) => {
            debug!(
                cmd = %label,
                status = ?output.status.code(),
                "external command finished"
            );
            Ok(output)
        }
        Ok(Err(io_err)) => {
            warn!(cmd = %label, error = %io_err, "external command spawn failed");
            // Name the command: Windows renders a PATH miss as the bare
            // "program not found", which is useless without knowing WHICH
            // program (issue #296) — Timeout/Process already carry the label.
            let message = format!("`{label}`: {io_err}");
            // A missing binary is an environment gap ("install X first"),
            // not an app malfunction — Expected keeps it out of telemetry.
            if io_err.kind() == std::io::ErrorKind::NotFound {
                Err(CommandError::expected(message))
            } else if let Some(oom) =
                crate::errors::windows_out_of_memory(&io_err, Some(label.as_str()))
            {
                // Pagefile exhaustion is likewise the environment, not us
                // (issue #356).
                Err(oom)
            } else {
                Err(CommandError::Io { message })
            }
        }
        Err(_) => {
            warn!(cmd = %label, timeout_secs, "external command timed out");
            Err(CommandError::Timeout {
                cmd: label,
                secs: timeout_secs,
            })
        }
    }
}

/// Like [`run_with_timeout`], but feeds `stdin_data` to the child's stdin.
///
/// Exists because passing a large payload (an AI prompt carrying a ~40KB diff)
/// as a single argv element can exceed the OS's combined argv+env exec limit —
/// `Argument list too long` / E2BIG (issue #595). Stdin has no such ceiling.
///
/// The write and the wait run concurrently (`tokio::join!`) so a child that
/// interleaves reading stdin with writing output can't deadlock on a full
/// pipe; once everything is written the stdin handle is shut down and dropped
/// so the child sees EOF. A child that exits without draining stdin (e.g. an
/// early CLI error) surfaces its own output — the resulting broken-pipe write
/// error is deliberately ignored.
pub async fn run_with_timeout_stdin(
    mut cmd: Command,
    stdin_data: &str,
    cmd_label: impl Into<String>,
    timeout_secs: u64,
) -> Result<std::process::Output, CommandError> {
    let label = cmd_label.into();
    debug!(cmd = %label, timeout_secs, stdin_bytes = stdin_data.len(), "spawning external command (stdin-fed)");

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let data = stdin_data.as_bytes().to_vec();
    let run = async move {
        let mut child = cmd.spawn()?;
        let mut stdin = child.stdin.take();
        let feed = async {
            if let Some(mut handle) = stdin.take() {
                use tokio::io::AsyncWriteExt;
                match handle.write_all(&data).await {
                    Ok(()) => {
                        let _ = handle.shutdown().await;
                    }
                    // The child closed stdin early (exited or stopped
                    // reading) — its exit status/stderr is the real story.
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
                    Err(e) => warn!(error = %e, "failed writing to child stdin"),
                }
                // Dropping the handle closes the pipe: the child must see EOF.
            }
        };
        let (output, ()) = tokio::join!(child.wait_with_output(), feed);
        output
    };

    match tokio::time::timeout(Duration::from_secs(timeout_secs), run).await {
        Ok(Ok(output)) => {
            debug!(
                cmd = %label,
                status = ?output.status.code(),
                "external command finished"
            );
            Ok(output)
        }
        // Same io-error mapping as run_with_timeout: missing binary and
        // Windows pagefile exhaustion are environment states, not
        // malfunctions (issues #296, #356).
        Ok(Err(io_err)) => {
            warn!(cmd = %label, error = %io_err, "external command spawn failed");
            let message = format!("`{label}`: {io_err}");
            if io_err.kind() == std::io::ErrorKind::NotFound {
                Err(CommandError::expected(message))
            } else if let Some(oom) =
                crate::errors::windows_out_of_memory(&io_err, Some(label.as_str()))
            {
                Err(oom)
            } else {
                Err(CommandError::Io { message })
            }
        }
        Err(_) => {
            warn!(cmd = %label, timeout_secs, "external command timed out");
            Err(CommandError::Timeout {
                cmd: label,
                secs: timeout_secs,
            })
        }
    }
}

/// Convenience: run a command and require a successful (zero) exit, returning
/// the captured stdout as a UTF-8 string. Maps non-zero exits to
/// `CommandError::Process`.
pub async fn run_to_stdout(
    cmd: Command,
    cmd_label: impl Into<String> + Clone,
    timeout_secs: u64,
) -> Result<String, CommandError> {
    let label_for_err = cmd_label.clone().into();
    let output = run_with_timeout(cmd, cmd_label, timeout_secs).await?;
    if !output.status.success() {
        return Err(CommandError::Process {
            cmd: label_for_err,
            exit_code: output.status.code().unwrap_or(-1),
            stderr: truncate_output(&String::from_utf8_lossy(&output.stderr)),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ===== Transient spawn resource pressure (EAGAIN) =====
//
// Under macOS process/thread-table pressure, `fork()`/`posix_spawn()` can
// transiently fail with EAGAIN ("Resource temporarily unavailable", os error
// 35 on macOS/BSD, 11 on Linux). This surfaced as bare, unlabeled OS error
// strings from many independent spawn sites (issues #555, #573, #585, #586,
// #587). The helpers below give every spawn site one shared treatment:
// a couple of short-backoff retries, and — if the pressure persists — a
// human-readable `Expected` error instead of telemetry noise.

/// True when a rendered error message is the transient EAGAIN spawn failure.
///
/// Message-based (rather than `raw_os_error`-based) so it works uniformly for
/// `std::io::Error` and for portable_pty's `anyhow`-shaped errors, which only
/// expose the underlying OS error through their `Display` text. The raw-code
/// fallbacks are Unix-gated: on Windows os error 35/11 mean unrelated things.
pub fn is_spawn_resource_pressure(message: &str) -> bool {
    message.contains("Resource temporarily unavailable")
        || (cfg!(unix) && (message.contains("(os error 35)") || message.contains("(os error 11)")))
}

/// The persistent-EAGAIN error: process-table/resource pressure is an
/// environment condition with a user-side fix, not an app malfunction —
/// `Expected` keeps it out of telemetry and swaps the raw OS string for
/// actionable guidance.
pub fn spawn_resource_pressure_error(label: &str) -> CommandError {
    CommandError::expected(format!(
        "Couldn't start `{label}` — your system is temporarily low on process resources. \
         Close some apps or terminal tabs and try again."
    ))
}

/// Run a spawn closure, retrying a couple of times with a short backoff when
/// it fails with EAGAIN (see module comment above). Any other failure — and
/// an EAGAIN that survives every retry — is returned unchanged so the
/// caller's existing error mapping still applies; pair with
/// [`is_spawn_resource_pressure`] / [`spawn_resource_pressure_error`] to
/// classify the persistent case.
///
/// Blocking (uses `std::thread::sleep`); total added wait is ≤ 300ms and only
/// on the rare EAGAIN path, matching `output_retrying_index_lock`'s tradeoff.
pub fn retry_spawn_on_pressure<T, E: std::fmt::Display>(
    label: &str,
    mut spawn: impl FnMut() -> Result<T, E>,
) -> Result<T, E> {
    const ATTEMPTS: u64 = 3;
    for attempt in 1..=ATTEMPTS {
        match spawn() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < ATTEMPTS && is_spawn_resource_pressure(&e.to_string()) => {
                warn!(
                    cmd = %label,
                    attempt,
                    error = %e,
                    "spawn hit transient resource pressure (EAGAIN); retrying"
                );
                std::thread::sleep(Duration::from_millis(100 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("loop returns on the final attempt")
}

/// Convenience for `std::process` spawn sites: run the spawn with the EAGAIN
/// retry, then map any failure into a labeled `CommandError` — persistent
/// EAGAIN becomes the human `Expected` message, a missing binary stays
/// `Expected` (mirroring [`run_with_timeout`], #296), Windows pagefile
/// exhaustion keeps its typed guidance (#356), and anything else is a
/// labeled `Io` so telemetry can attribute the call site.
pub fn spawn_with_pressure_retry<T>(
    label: &str,
    spawn: impl FnMut() -> std::io::Result<T>,
) -> Result<T, CommandError> {
    retry_spawn_on_pressure(label, spawn).map_err(|io_err| {
        if is_spawn_resource_pressure(&io_err.to_string()) {
            return spawn_resource_pressure_error(label);
        }
        let message = format!("`{label}`: {io_err}");
        if io_err.kind() == std::io::ErrorKind::NotFound {
            CommandError::expected(message)
        } else if let Some(oom) = crate::errors::windows_out_of_memory(&io_err, Some(label)) {
            oom
        } else {
            CommandError::Io { message }
        }
    })
}

/// Cap on CLI output forwarded into user-facing error messages (and thus into
/// telemetry). A crashing subprocess can dump arbitrarily much — a Go runtime
/// stack trace, a full agent session transcript — and nothing past the head is
/// useful in an error dialog (issues #578, #610).
pub const MAX_ERROR_OUTPUT_CHARS: usize = 2048;

/// Trim `text` and cap it at [`MAX_ERROR_OUTPUT_CHARS`], keeping the head (the
/// useful part — CLIs print the actual error first, then detail/backtrace) and
/// appending a truncation marker. Use this whenever raw stderr/stdout is
/// embedded into a `CommandError`.
pub fn truncate_output(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_ERROR_OUTPUT_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_ERROR_OUTPUT_CHARS).collect();
    format!("{}… (truncated)", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_with_timeout_returns_output_for_quick_command() {
        let mut cmd = Command::new("echo");
        cmd.arg("hello");
        let out = run_with_timeout(cmd, "echo hello", 5).await.unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
    }

    #[tokio::test]
    async fn run_with_timeout_maps_missing_binary_to_expected_with_label() {
        let cmd = Command::new("definitely-not-a-real-binary-shipstudio");
        let err = run_with_timeout(cmd, "ghost", 5).await.unwrap_err();
        // Missing binary = environment gap: labeled (#296) and typed
        // Expected so it never reaches telemetry.
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("`ghost`"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_with_timeout_maps_long_command_to_timeout() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let err = run_with_timeout(cmd, "sleep 5", 1).await.unwrap_err();
        match err {
            CommandError::Timeout { secs, .. } => assert_eq!(secs, 1),
            other => panic!("expected Timeout, got {other:?}"),
        }
    }

    /// Builds an io::Error whose Display matches the reported telemetry shapes
    /// deterministically on every platform (from_raw_os_error(35) renders
    /// differently on Windows CI).
    fn eagain() -> std::io::Error {
        std::io::Error::other("Resource temporarily unavailable (os error 35)")
    }

    // The #555/#573/#585/#586/#587 shapes: bare EAGAIN text from macOS spawns.
    #[test]
    fn spawn_pressure_matches_reported_eagain_shapes() {
        assert!(is_spawn_resource_pressure(
            "Resource temporarily unavailable (os error 35)"
        ));
        assert!(is_spawn_resource_pressure(
            "spawn_command: Resource temporarily unavailable (os error 35)"
        ));
        assert!(is_spawn_resource_pressure(
            "Failed to execute command: Resource temporarily unavailable (os error 35)"
        ));
        // Linux renders EAGAIN as os error 11.
        #[cfg(unix)]
        assert!(is_spawn_resource_pressure(
            "Resource temporarily unavailable (os error 11)"
        ));
    }

    #[test]
    fn spawn_pressure_rejects_other_errors() {
        assert!(!is_spawn_resource_pressure(
            "No such file or directory (os error 2)"
        ));
        assert!(!is_spawn_resource_pressure(
            "Operation not permitted (os error 1)"
        ));
        assert!(!is_spawn_resource_pressure(""));
        // Don't match a larger error code that merely contains "35"/"11".
        assert!(!is_spawn_resource_pressure("something (os error 110)"));
        assert!(!is_spawn_resource_pressure("something (os error 355)"));
    }

    #[test]
    fn retry_spawn_recovers_after_transient_eagain() {
        let mut calls = 0;
        let result: Result<i32, std::io::Error> = retry_spawn_on_pressure("git status", || {
            calls += 1;
            if calls < 3 {
                Err(eagain())
            } else {
                Ok(42)
            }
        });
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls, 3);
    }

    #[test]
    fn retry_spawn_does_not_retry_non_eagain_failures() {
        let mut calls = 0;
        let result: Result<(), std::io::Error> = retry_spawn_on_pressure("git status", || {
            calls += 1;
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No such file or directory (os error 2)",
            ))
        });
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn persistent_eagain_becomes_expected_with_human_message() {
        let mut calls = 0;
        let err = spawn_with_pressure_retry::<()>("open safari", || {
            calls += 1;
            Err(eagain())
        })
        .unwrap_err();
        assert_eq!(calls, 3, "must exhaust the retries first");
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains("`open safari`"), "got: {msg}");
        assert!(msg.contains("low on process resources"), "got: {msg}");
        // The raw OS string must not leak into the user-facing message.
        assert!(!msg.contains("os error 35"), "got: {msg}");
    }

    #[test]
    fn spawn_with_pressure_retry_keeps_not_found_expected_and_labeled() {
        let err = spawn_with_pressure_retry::<()>("gh api user", || {
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
        })
        .unwrap_err();
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("`gh api user`"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    /// `cat` only exits once stdin reaches EOF, so a passing test proves the
    /// prompt is fully written *and* the handle closed before we wait —
    /// exactly the plumbing issue #595 depends on.
    #[tokio::test]
    async fn run_with_timeout_stdin_writes_and_closes_stdin() {
        let cmd = Command::new("cat");
        let out = run_with_timeout_stdin(cmd, "hello stdin prompt", "cat", 5)
            .await
            .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello stdin prompt");
    }

    /// A payload far beyond any argv limit and larger than a pipe buffer:
    /// write/wait must interleave without deadlocking, and every byte must
    /// arrive.
    #[tokio::test]
    async fn run_with_timeout_stdin_handles_large_payloads() {
        let payload = "diff line with some content\n".repeat(10_000); // ~280KB
        let cmd = Command::new("cat");
        let out = run_with_timeout_stdin(cmd, &payload, "cat large", 10)
            .await
            .unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), payload.len());
    }

    /// A child that exits without reading stdin (early CLI error) must surface
    /// its own status/stderr, not a broken-pipe write failure.
    #[tokio::test]
    async fn run_with_timeout_stdin_tolerates_child_ignoring_stdin() {
        let big = "x".repeat(1_000_000);
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("echo boom 1>&2; exit 3");
        let out = run_with_timeout_stdin(cmd, &big, "sh early-exit", 10)
            .await
            .unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert!(String::from_utf8_lossy(&out.stderr).contains("boom"));
    }

    #[tokio::test]
    async fn run_with_timeout_stdin_maps_missing_binary_to_expected() {
        let cmd = Command::new("definitely-not-a-real-binary-shipstudio");
        let err = run_with_timeout_stdin(cmd, "prompt", "ghost-stdin", 5)
            .await
            .unwrap_err();
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("`ghost-stdin`"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn spawn_with_pressure_retry_labels_other_io_errors() {
        let err = spawn_with_pressure_retry::<()>("gh api user", || {
            Err(std::io::Error::other("boom"))
        })
        .unwrap_err();
        match err {
            CommandError::Io { message } => {
                assert!(message.contains("`gh api user`"), "got: {message}");
                assert!(message.contains("boom"), "got: {message}");
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn spawn_with_pressure_retry_passes_success_through_untouched() {
        let mut calls = 0;
        let out = spawn_with_pressure_retry("echo", || {
            calls += 1;
            Ok(7)
        })
        .unwrap();
        assert_eq!(out, 7);
        assert_eq!(calls, 1, "no gratuitous retries on success");
    }

    #[test]
    fn truncate_output_passes_short_text_through_trimmed() {
        assert_eq!(truncate_output("  short error  \n"), "short error");
        assert_eq!(truncate_output(""), "");
    }

    // The #610/#578 shape: a crash dump / session transcript on stderr must be
    // capped, keeping the head where the actual error line lives.
    #[test]
    fn truncate_output_caps_long_text_preserving_head() {
        let long = format!("fatal error: the real cause\n{}", "x".repeat(10_000));
        let capped = truncate_output(&long);
        assert!(capped.starts_with("fatal error: the real cause"));
        assert!(capped.ends_with("… (truncated)"), "got tail: {}", &capped[capped.len().saturating_sub(40)..]);
        assert!(capped.chars().count() <= MAX_ERROR_OUTPUT_CHARS + "… (truncated)".len());
    }

    #[tokio::test]
    async fn run_to_stdout_maps_nonzero_to_process_error() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("echo err 1>&2; exit 2");
        let err = run_to_stdout(cmd, "sh -c", 5).await.unwrap_err();
        match err {
            CommandError::Process {
                exit_code, stderr, ..
            } => {
                assert_eq!(exit_code, 2);
                assert!(stderr.contains("err"));
            }
            other => panic!("expected Process, got {other:?}"),
        }
    }
}
