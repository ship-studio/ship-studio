use super::AppState;
use crate::errors::CommandError;
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub struct PathQuery {
    path: Option<String>,
    #[serde(default)]
    download: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseEntry {
    name: String,
    path: String,
    is_directory: bool,
}

fn envelope(data: impl Serialize) -> Response {
    Json(serde_json::json!({ "ok": true, "data": data })).into_response()
}

fn bad_request(message: impl Into<String>) -> Response {
    super::auth::error_response(
        StatusCode::BAD_REQUEST,
        CommandError::Validation {
            field: "path".into(),
            reason: message.into(),
        },
    )
}

/// Authenticated server-side directory browser used by the web picker.
pub async fn browse(Query(query): Query<PathQuery>) -> Response {
    let requested = query
        .path
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let path = match dunce::canonicalize(&requested) {
        Ok(path) if path.is_dir() => path,
        Ok(_) => return bad_request("not a directory"),
        Err(error) => return bad_request(error.to_string()),
    };

    let mut entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries
            .flatten()
            .take(1_000)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                Some(BrowseEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                    is_directory: file_type.is_dir(),
                })
            })
            .collect::<Vec<_>>(),
        Err(error) => return bad_request(error.to_string()),
    };
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    envelope(serde_json::json!({
        "path": path,
        "parent": path.parent(),
        "entries": entries,
    }))
}

/// Small filesystem probe used by the existing onboarding PATH discovery.
pub async fn exists(Query(query): Query<PathQuery>) -> Response {
    envelope(query.path.is_some_and(|path| Path::new(&path).exists()))
}

/// Serve a project file after applying the same project-root trust boundary as commands.
pub async fn file(Query(query): Query<PathQuery>) -> Response {
    let Some(requested) = query.path else {
        return bad_request("missing path");
    };
    let path = match dunce::canonicalize(&requested) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return bad_request("not a file"),
        Err(error) => return bad_request(error.to_string()),
    };
    let Some(parent) = path.parent() else {
        return bad_request("file has no parent directory");
    };
    if let Err(error) = crate::utils::validate_project_path(&parent.to_string_lossy()) {
        return bad_request(error);
    }

    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) => return bad_request(error.to_string()),
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            crate::static_server::get_mime_type(extension),
        )
        .header(header::CACHE_CONTROL, "private, no-store");
    if query.download {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download");
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                name.replace(['"', '\r', '\n'], "_")
            ),
        );
    }
    response.body(Body::from(bytes)).unwrap_or_else(|error| {
        super::auth::error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            CommandError::Other {
                message: error.to_string(),
            },
        )
    })
}

pub async fn capabilities(State(state): State<AppState>) -> Response {
    let preview_host = state
        .config
        .public_origin
        .as_deref()
        .and_then(|origin| url::Url::parse(origin).ok())
        .and_then(|origin| origin.host_str().map(str::to_owned))
        .unwrap_or_else(|| "localhost".into());
    envelope(serde_json::json!({
        "terminal": true,
        "filePicker": true,
        "preview": true,
        "screenshots": false,
        "clipboardImage": false,
        "updater": false,
        "deepLinks": false,
        "processControl": false,
        "windowControls": false,
        "mobilePreview": false,
        "revealInFileManager": false,
        "analytics": !crate::commands::analytics::suppressed_by_host(),
        "homeDir": dirs::home_dir(),
        "previewHost": preview_host,
        "previewUrlTemplate": state.config.preview_url_template,
    }))
}
