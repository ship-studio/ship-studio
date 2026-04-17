//! Structured error type for Tauri commands.
//!
//! Replaces the historical `Result<T, String>` returns. Variants are tagged when
//! serialized so the frontend can discriminate (e.g. timeout vs auth vs IO) and
//! render appropriate UI without parsing free-form error strings.
//!
//! When adding a new variant, also update the TS mirror in `src/lib/errors.ts`.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize, Clone)]
#[serde(tag = "type")]
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

    #[error("{message}")]
    Other { message: String },
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
