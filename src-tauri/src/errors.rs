//! Structured error type for Tauri commands.
//!
//! Replaces the historical `Result<T, String>` returns. Variants are tagged when
//! serialized so the frontend can discriminate (e.g. timeout vs auth vs IO) and
//! render appropriate UI without parsing free-form error strings.
//!
//! When adding a new variant, also update the TS mirror in `src/lib/errors.ts`.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error, Clone)]
pub enum CommandError {
    #[error("`{cmd}` timed out after {secs}s")]
    Timeout { cmd: String, secs: u64 },

    #[error("`{cmd}` exited with status {exit_code}: {stderr}")]
    Process {
        cmd: String,
        exit_code: i32,
        stderr: String,
    },

    #[error("Validation failed for `{field}`: {reason}")]
    Validation { field: String, reason: String },

    #[error("Not authenticated with {service}")]
    NotAuthenticated { service: String },

    #[error("I/O error: {message}")]
    Io { message: String },

    #[error("Pull request {pr_number} cannot be merged cleanly: {stderr}")]
    MergeConflict { pr_number: i32, stderr: String },

    #[error("{message}")]
    Other { message: String },
}

/// Serialization happens exactly once per command failure — when Tauri sends
/// the rejection across the IPC boundary to the frontend. That makes it the
/// one choke point that sees every backend failure a user experiences, so it
/// doubles as the admin-agent report hook (docs/error-reporting.md). The
/// mirror enum reproduces the old `#[serde(tag = "type")]` derive exactly
/// (locked by the tests below); the exhaustive match forces this impl to be
/// updated when a variant is added.
impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        crate::error_reporting::report_command_error(self);

        #[derive(Serialize)]
        #[serde(tag = "type")]
        enum Mirror<'a> {
            Timeout {
                cmd: &'a str,
                secs: &'a u64,
            },
            Process {
                cmd: &'a str,
                exit_code: &'a i32,
                stderr: &'a str,
            },
            Validation {
                field: &'a str,
                reason: &'a str,
            },
            NotAuthenticated {
                service: &'a str,
            },
            Io {
                message: &'a str,
            },
            MergeConflict {
                pr_number: &'a i32,
                stderr: &'a str,
            },
            Other {
                message: &'a str,
            },
        }

        let mirror = match self {
            CommandError::Timeout { cmd, secs } => Mirror::Timeout { cmd, secs },
            CommandError::Process {
                cmd,
                exit_code,
                stderr,
            } => Mirror::Process {
                cmd,
                exit_code,
                stderr,
            },
            CommandError::Validation { field, reason } => Mirror::Validation { field, reason },
            CommandError::NotAuthenticated { service } => Mirror::NotAuthenticated { service },
            CommandError::Io { message } => Mirror::Io { message },
            CommandError::MergeConflict { pr_number, stderr } => {
                Mirror::MergeConflict { pr_number, stderr }
            }
            CommandError::Other { message } => Mirror::Other { message },
        };
        mirror.serialize(serializer)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(err: std::io::Error) -> Self {
        CommandError::Io {
            message: err.to_string(),
        }
    }
}

impl From<String> for CommandError {
    fn from(s: String) -> Self {
        CommandError::Other { message: s }
    }
}

impl From<&str> for CommandError {
    fn from(s: &str) -> Self {
        CommandError::Other {
            message: s.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_tagged_variant() {
        let err = CommandError::Timeout {
            cmd: "git fetch".into(),
            secs: 30,
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"type\":\"Timeout\""));
        assert!(json.contains("\"cmd\":\"git fetch\""));
        assert!(json.contains("\"secs\":30"));
    }

    #[test]
    fn process_variant_includes_exit_code_and_stderr() {
        let err = CommandError::Process {
            cmd: "vercel".into(),
            exit_code: 1,
            stderr: "no project linked".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"exit_code\":1"));
        assert!(json.contains("no project linked"));
    }

    #[test]
    fn validation_variant_carries_field_and_reason() {
        let err = CommandError::Validation {
            field: "path".into(),
            reason: "outside ShipStudio root".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"field\":\"path\""));
    }

    #[test]
    fn from_string_maps_to_other() {
        let err: CommandError = "boom".to_string().into();
        match err {
            CommandError::Other { message } => assert_eq!(message, "boom"),
            _ => panic!("expected Other variant"),
        }
    }

    #[test]
    fn from_io_error_maps_to_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let err: CommandError = io_err.into();
        match err {
            CommandError::Io { message } => assert!(message.contains("missing")),
            _ => panic!("expected Io variant"),
        }
    }
}
