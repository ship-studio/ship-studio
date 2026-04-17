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
            Err(CommandError::Io {
                message: io_err.to_string(),
            })
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
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
    async fn run_with_timeout_maps_missing_binary_to_io() {
        let cmd = Command::new("definitely-not-a-real-binary-shipstudio");
        let err = run_with_timeout(cmd, "ghost", 5).await.unwrap_err();
        match err {
            CommandError::Io { .. } => {}
            other => panic!("expected Io, got {other:?}"),
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
