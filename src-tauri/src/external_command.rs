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
