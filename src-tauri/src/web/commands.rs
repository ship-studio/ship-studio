//! # Command transport
//!
//! `POST /api/cmd/<name>` with the argument object as the JSON body, mirroring
//! what `invoke('<name>', args)` sends over Tauri's IPC. The response envelope
//! is `{ok: true, data}` or `{ok: false, error}`, where `error` is a serialized
//! [`CommandError`] with its `type` tag intact — the frontend discriminates on
//! that tag and must not see it wrapped in anything else.
//!
//! There is one route, not 371: the table is built once from the same manifest
//! that generates the Tauri handler (see `crate::command_manifest`), so the two
//! transports cannot drift.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;

use super::{auth::error_response, AppState};
use crate::errors::CommandError;
use ship_studio_macros::ship_web_commands;

/// A command's HTTP-facing form: JSON arguments in, JSON value out.
pub type Handler =
    fn(
        serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, CommandError>> + Send>>;

/// One registered command.
pub struct Command {
    pub handler: Handler,
    /// True when the command needs an `AppHandle`/`Window`. It still has a
    /// route, but calling it returns a structured error rather than a 404 —
    /// the frontend can tell "not supported here" from "typo".
    pub desktop_only: bool,
}

/// Every command, keyed by the name the frontend invokes.
static COMMANDS: LazyLock<HashMap<&'static str, Command>> = LazyLock::new(|| {
    let entries: Vec<(&'static str, Handler, bool)> = crate::ship_commands!(ship_web_commands);

    let mut map = HashMap::with_capacity(entries.len());
    for (name, handler, desktop_only) in entries {
        if map
            .insert(
                name,
                Command {
                    handler,
                    desktop_only,
                },
            )
            .is_some()
        {
            // Tauri would silently let the later registration win; say so
            // loudly instead, since a shadowed command is a live bug.
            tracing::error!("Duplicate command registration for `{name}`");
        }
    }
    map
});

/// Number of registered commands. Used by tests and diagnostics.
pub fn count() -> usize {
    COMMANDS.len()
}

/// Look up a command by name.
pub fn get(name: &str) -> Option<&'static Command> {
    COMMANDS.get(name)
}

/// Names of every command that can't be served over HTTP yet.
pub fn desktop_only_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = COMMANDS
        .iter()
        .filter(|(_, cmd)| cmd.desktop_only)
        .map(|(name, _)| *name)
        .collect();
    names.sort_unstable();
    names
}

/// Success envelope. Kept separate from the error path so the two can never
/// accidentally take the same shape.
fn ok_response(data: serde_json::Value) -> Response {
    Json(serde_json::json!({ "ok": true, "data": data })).into_response()
}

/// `POST /api/cmd/{name}`
pub async fn dispatch(
    State(_state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    let Some(command) = get(&name) else {
        return error_response(
            StatusCode::NOT_FOUND,
            CommandError::Other {
                message: format!("unknown command `{name}`"),
            },
        );
    };

    let mut args = body.map(|Json(v)| v).unwrap_or(serde_json::Value::Null);
    let Some(label) = headers
        .get("x-ship-window")
        .and_then(|value| value.to_str().ok())
    else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            CommandError::NotAuthenticated {
                service: "browser session".into(),
            },
        );
    };
    if !_state
        .sessions
        .lock()
        .is_ok_and(|sessions| sessions.contains(label))
    {
        return error_response(
            StatusCode::UNAUTHORIZED,
            CommandError::NotAuthenticated {
                service: "browser session".into(),
            },
        );
    }
    if !args.is_object() {
        args = serde_json::json!({});
    }
    if let Some(object) = args.as_object_mut() {
        object.insert(
            "windowLabel".into(),
            serde_json::Value::String(label.to_string()),
        );
    }

    match (command.handler)(args).await {
        Ok(data) => ok_response(data),
        Err(error) => {
            // A command failing is ordinary — a git conflict, a missing binary,
            // an unauthenticated CLI. It is not an HTTP-level failure, and
            // returning 4xx/5xx here would make `fetch` callers treat expected
            // outcomes as transport errors. The envelope carries the verdict.
            tracing::debug!("Command `{name}` returned an error: {error}");
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": false, "error": error })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_command_is_registered() {
        // The manifest is the contract; 372 is what the Tauri handler carries.
        assert_eq!(
            count(),
            372,
            "command count changed — update this number deliberately, \
             and check the frontend still has what it expects"
        );
    }

    #[test]
    fn known_commands_resolve_and_unknown_ones_do_not() {
        assert!(get("list_projects").is_some());
        assert!(get("get_current_branch").is_some());
        assert!(get("spawn_pty").is_some());
        assert!(get("no_such_command").is_none());
        // Namespaced Tauri plugin calls are not ours to serve here.
        assert!(get("plugin:pty|spawn").is_none());
    }

    #[tokio::test]
    async fn a_no_argument_command_accepts_a_null_body() {
        // `get_log_path` takes no arguments and cannot fail — the cleanest
        // probe that the null-body path deserializes an empty struct.
        let command = get("get_log_path").expect("registered");
        let value = (command.handler)(serde_json::Value::Null)
            .await
            .expect("no-argument command succeeds");
        assert!(value.is_string(), "expected a path string, got {value}");
    }

    #[tokio::test]
    async fn multi_word_arguments_deserialize_from_camel_case_and_snake_case() {
        // `detect_project_type_command(project_path)` is the interesting shape:
        // a snake_case parameter that Tauri exposes to JS as `projectPath`.
        // Both spellings must reach it, and an unreadable path fails *inside*
        // the command rather than at deserialization — which is the proof the
        // argument arrived.
        let command = get("detect_project_type_command").expect("registered");

        for args in [
            serde_json::json!({ "projectPath": "/definitely/not/here" }),
            serde_json::json!({ "project_path": "/definitely/not/here" }),
        ] {
            let error = (command.handler)(args.clone())
                .await
                .expect_err("a nonexistent path fails path validation");
            assert!(
                !matches!(error, CommandError::Validation { ref field, .. } if field == "detect_project_type_command"),
                "args {args} failed to deserialize: {error}"
            );
        }
    }

    #[tokio::test]
    async fn a_result_value_is_serialized_into_the_envelope() {
        // `get_active_session_count` takes no arguments and returns a plain
        // number — the shortest path that proves a success value survives the
        // trip out through `serde_json::to_value`.
        let command = get("get_active_session_count").expect("registered");
        let value = (command.handler)(serde_json::Value::Null)
            .await
            .expect("succeeds");
        assert!(value.is_number(), "expected a count, got {value}");
    }

    #[tokio::test]
    async fn missing_arguments_are_a_validation_error_not_a_panic() {
        let command = get("project_path_exists").expect("registered");
        let error = (command.handler)(serde_json::json!({}))
            .await
            .expect_err("missing required argument must fail");

        match error {
            CommandError::Validation { field, .. } => assert_eq!(field, "project_path_exists"),
            other => panic!("expected a Validation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn wrong_argument_types_are_a_validation_error() {
        let command = get("project_path_exists").expect("registered");
        let error = (command.handler)(serde_json::json!({ "path": 42 }))
            .await
            .expect_err("a number where a string belongs must fail");
        assert!(matches!(error, CommandError::Validation { .. }));
    }

    #[tokio::test]
    async fn a_failing_command_preserves_its_tagged_error_shape() {
        // Path validation rejects anything outside the projects root, so this
        // exercises a real command error travelling through the transport.
        let command = get("read_project_file").expect("registered");
        let error = (command.handler)(serde_json::json!({
            "projectPath": "/etc",
            "filePath": "passwd",
        }))
        .await
        .expect_err("reading outside the projects root must fail");

        let json = serde_json::to_value(&error).expect("CommandError serializes");
        assert!(
            json.get("type").is_some(),
            "the `type` tag is the frontend's discriminator: {json}"
        );
    }

    #[test]
    fn desktop_only_commands_are_flagged_rather_than_missing() {
        let names = desktop_only_names();
        // Every one of these is work still owed: either a server-side
        // replacement or a capability flag. The count is asserted so that
        // number can only move deliberately — down as they are ported, up only
        // when someone knowingly adds another desktop dependency.
        // Was 25 before the native file pickers took an optional
        // `selected_path` from the web picker instead of an `AppHandle`.
        assert_eq!(
            names.len(),
            19,
            "desktop-only command count changed: {names:?}"
        );
        // Every one of them still has a route.
        for name in &names {
            assert!(get(name).is_some(), "`{name}` should still be registered");
        }
        assert!(
            names.contains(&"create_preview_webview"),
            "expected the native webview commands to be flagged: {names:?}"
        );
    }

    #[tokio::test]
    async fn a_desktop_only_command_explains_itself() {
        let command = get("create_preview_webview").expect("registered");
        assert!(command.desktop_only);

        let error = (command.handler)(serde_json::json!({}))
            .await
            .expect_err("must not pretend to succeed");
        let message = error.to_string();
        assert!(
            message.contains("desktop session"),
            "error should say why: {message}"
        );
    }
}
