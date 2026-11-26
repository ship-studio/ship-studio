//! Saved external URLs shown alongside the local project preview.
//!
//! This deliberately lives beside, rather than inside, `project.json`: several
//! windows can update project settings at once, and a read-modify-write of the
//! shared metadata document could otherwise discard another setting's update.

use crate::errors::CommandError;
use crate::utils::{classify_fs_error, validate_project_path};
use serde_json::Value;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use url::Url;

static PREVIEW_URLS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn normalize_preview_url(input: &str) -> Result<String, CommandError> {
    let trimmed = input.trim();
    let url = Url::parse(trimmed).map_err(|_| CommandError::Validation {
        field: "url".to_string(),
        reason: "Enter an absolute HTTP or HTTPS URL".to_string(),
    })?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(CommandError::Validation {
            field: "url".to_string(),
            reason: "Only HTTP and HTTPS URLs can be saved".to_string(),
        });
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CommandError::Validation {
            field: "url".to_string(),
            reason: "URLs containing a username or password cannot be saved".to_string(),
        });
    }
    if url.host_str().is_none() {
        return Err(CommandError::Validation {
            field: "url".to_string(),
            reason: "Enter a URL with a hostname".to_string(),
        });
    }

    // Url serialization canonicalizes host casing, IDNs, escaping, and default
    // ports, giving save/remove a stable equality representation.
    Ok(url.to_string())
}

fn preview_urls_path(project: &Path) -> PathBuf {
    project.join(".shipstudio").join("preview-urls.json")
}

fn ensure_storage_directory(directory: &Path, create: bool) -> Result<bool, CommandError> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CommandError::expected(
            "Security error: refusing to use a symlinked .shipstudio directory.",
        )),
        Ok(metadata) if !metadata.is_dir() => Err(CommandError::expected(
            "Cannot save preview URLs because .shipstudio is not a directory.",
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound && !create => Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match std::fs::create_dir(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(classify_fs_error(
                        "create this project's .shipstudio folder",
                        directory,
                        &error,
                    ));
                }
            }
            // Reinspect after creation so a competing filesystem change cannot
            // turn the just-created path into an unchecked symlink.
            ensure_storage_directory(directory, false)
        }
        Err(error) => Err(classify_fs_error(
            "inspect this project's .shipstudio folder",
            directory,
            &error,
        )),
    }
}

fn ensure_preview_file_is_safe(path: &Path) -> Result<bool, CommandError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CommandError::expected(
            "Security error: refusing to follow a symlinked preview URL file.",
        )),
        Ok(metadata) if !metadata.is_file() => Err(CommandError::expected(
            "Cannot use saved preview URLs because the storage path is not a file.",
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(classify_fs_error(
            "inspect saved preview URLs",
            path,
            &error,
        )),
    }
}

fn read_preview_urls(path: &Path) -> Result<Vec<String>, CommandError> {
    let directory = path.parent().ok_or_else(|| {
        CommandError::expected("Could not determine the project metadata directory")
    })?;
    if !ensure_storage_directory(directory, false)? || !ensure_preview_file_is_safe(path)? {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| classify_fs_error("read saved preview URLs", path, &e))?;
    let stored: Vec<String> = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse saved preview URLs: {e}"))?;
    stored
        .iter()
        .map(|url| normalize_preview_url(url))
        .collect()
}

fn write_preview_urls(path: &Path, urls: &[String]) -> Result<(), CommandError> {
    let parent = path.parent().ok_or_else(|| {
        CommandError::expected("Could not determine the project metadata directory")
    })?;
    ensure_storage_directory(parent, true)?;
    ensure_preview_file_is_safe(path)?;

    let contents = serde_json::to_string_pretty(urls)
        .map_err(|e| format!("Failed to serialize saved preview URLs: {e}"))?;
    let temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| classify_fs_error("prepare saved preview URLs", path, &e))?;
    std::fs::write(temp.path(), contents)
        .map_err(|e| classify_fs_error("write saved preview URLs", path, &e))?;
    std::fs::rename(temp.path(), path).map_err(|e| classify_fs_error("save preview URLs", path, &e))
}

fn configured_port(project: &Path) -> Result<Option<u16>, CommandError> {
    let metadata_path = project.join(".shipstudio").join("project.json");
    match std::fs::symlink_metadata(&metadata_path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(classify_fs_error(
                "inspect project metadata",
                &metadata_path,
                &error,
            ))
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CommandError::expected(
                "Security error: refusing to follow symlinked project metadata.",
            ))
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(CommandError::expected(
                "Cannot read the Dev Server Port because project metadata is not a file.",
            ))
        }
        Ok(_) => {}
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| classify_fs_error("read project metadata", &metadata_path, &e))?;
    let metadata: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project metadata: {e}"))?;
    Ok(metadata
        .get("dev_server_port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0))
}

fn is_builtin_local_url(url: &str, port: Option<u16>) -> bool {
    let Some(port) = port else {
        return false;
    };
    Url::parse(url).is_ok_and(|parsed| {
        parsed.scheme() == "http"
            && parsed.host_str() == Some("localhost")
            && parsed.port_or_known_default() == Some(port)
            && parsed.path() == "/"
            && parsed.query().is_none()
            && parsed.fragment().is_none()
    })
}

/// Read the saved HTTP(S) preview URLs for a project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_preview_urls(project_path: String) -> Result<Vec<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let _guard = PREVIEW_URLS_LOCK.lock().map_err(|_| {
        CommandError::expected("Saved preview URL storage is temporarily unavailable")
    })?;
    read_preview_urls(&preview_urls_path(&project))
}

/// Save an absolute HTTP(S) preview URL and return the authoritative list.
#[tauri::command]
#[tracing::instrument(skip(url), fields(project = %project_path))]
pub async fn save_preview_url(
    project_path: String,
    url: String,
) -> Result<Vec<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let normalized = normalize_preview_url(&url)?;
    let _guard = PREVIEW_URLS_LOCK.lock().map_err(|_| {
        CommandError::expected("Saved preview URL storage is temporarily unavailable")
    })?;

    let path = preview_urls_path(&project);
    let mut urls = read_preview_urls(&path)?;
    // The local URL comes from the existing Dev Server Port setting, so it is
    // an option, never a second custom saved entry.
    if !is_builtin_local_url(&normalized, configured_port(&project)?)
        && !urls.iter().any(|saved| saved == &normalized)
    {
        urls.push(normalized);
        write_preview_urls(&path, &urls)?;
    }
    Ok(urls)
}

/// Remove a saved URL using normalized URL equality and return the full list.
#[tauri::command]
#[tracing::instrument(skip(url), fields(project = %project_path))]
pub async fn remove_preview_url(
    project_path: String,
    url: String,
) -> Result<Vec<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let normalized = normalize_preview_url(&url)?;
    let _guard = PREVIEW_URLS_LOCK.lock().map_err(|_| {
        CommandError::expected("Saved preview URL storage is temporarily unavailable")
    })?;

    let path = preview_urls_path(&project);
    let mut urls = read_preview_urls(&path)?;
    let original_len = urls.len();
    urls.retain(|saved| saved != &normalized);
    if urls.len() != original_len {
        write_preview_urls(&path, &urls)?;
    }
    Ok(urls)
}

/// Replace a saved URL in place, preserving the order of all destinations.
#[tauri::command]
#[tracing::instrument(skip(old_url, new_url), fields(project = %project_path))]
pub async fn replace_preview_url(
    project_path: String,
    old_url: String,
    new_url: String,
) -> Result<Vec<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let old_normalized = normalize_preview_url(&old_url)?;
    let new_normalized = normalize_preview_url(&new_url)?;
    let _guard = PREVIEW_URLS_LOCK.lock().map_err(|_| {
        CommandError::expected("Saved preview URL storage is temporarily unavailable")
    })?;

    let path = preview_urls_path(&project);
    let mut urls = read_preview_urls(&path)?;
    let Some(index) = urls.iter().position(|saved| saved == &old_normalized) else {
        return Err(CommandError::Validation {
            field: "oldUrl".to_string(),
            reason: "This saved preview URL no longer exists".to_string(),
        });
    };
    if new_normalized == old_normalized {
        return Ok(urls);
    }
    if urls
        .iter()
        .enumerate()
        .any(|(i, saved)| i != index && saved == &new_normalized)
    {
        return Err(CommandError::Validation {
            field: "newUrl".to_string(),
            reason: "That preview URL is already saved".to_string(),
        });
    }

    urls[index] = new_normalized;
    write_preview_urls(&path, &urls)?;
    Ok(urls)
}
