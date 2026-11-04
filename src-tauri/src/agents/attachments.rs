//! Files the user attaches to a message.
//!
//! Each one is copied into the agent's home at `attachments/<message-id>/`, so
//! the agent reads its own copy (the original can move or disappear) and the
//! chat keeps showing it. Deleting the agent deletes them with its home.
//!
//! The prompt names the absolute paths and Claude Code's Read tool does the
//! rest: it reads images and PDFs natively, and text as text.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::errors::CommandError;

/// Per file. Claude Code's Read tool works well below this; anything bigger is
/// almost always a mistake (a video, a disk image) rather than context.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Per message.
pub const MAX_FILES: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    /// Relative to the agent's home, e.g. `attachments/<message-id>/photo.png`.
    pub path: String,
    pub mime: String,
    pub size: u64,
}

/// What the composer sends: a file on disk (picked or dropped) or bytes it
/// already holds (a pasted image), never both.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    /// Base64, for pasted images.
    #[serde(default)]
    pub data: Option<String>,
}

/// What the composer shows for a file before it is sent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

fn mb(bytes: u64) -> String {
    format!("{:.0} MB", (bytes as f64 / (1024.0 * 1024.0)).ceil())
}

fn too_big(name: &str, size: u64) -> CommandError {
    CommandError::expected(format!(
        "{name} is {}. Files can be up to {}.",
        mb(size),
        mb(MAX_FILE_BYTES)
    ))
}

fn too_many() -> CommandError {
    CommandError::expected(format!("You can attach up to {MAX_FILES} files at a time."))
}

/// A user-supplied file name as a single safe path segment.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || c == ':' { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let cleaned = if cleaned.is_empty() { "file" } else { cleaned };
    // Keep the extension when shortening: it's how the agent knows the type.
    if cleaned.chars().count() <= 120 {
        return cleaned.to_string();
    }
    let (stem, ext) = match cleaned.rfind('.') {
        Some(i) if cleaned.len() - i <= 10 => (&cleaned[..i], &cleaned[i..]),
        _ => (cleaned, ""),
    };
    let stem: String = stem.chars().take(120 - ext.chars().count()).collect();
    format!("{stem}{ext}")
}

pub fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        _ => "application/octet-stream",
    }
}

/// Sizes and types for the chips, refusing up front what `save` would refuse.
pub fn inspect(paths: &[String]) -> Result<Vec<FileInfo>, CommandError> {
    if paths.len() > MAX_FILES {
        return Err(too_many());
    }
    paths
        .iter()
        .map(|p| {
            let path = PathBuf::from(p);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            let meta = std::fs::metadata(&path)
                .map_err(|_| CommandError::expected(format!("Couldn't read {name}.")))?;
            if meta.is_dir() {
                return Err(CommandError::expected(format!(
                    "{name} is a folder. Attach the files inside it instead."
                )));
            }
            if meta.len() > MAX_FILE_BYTES {
                return Err(too_big(&name, meta.len()));
            }
            Ok(FileInfo {
                path: p.clone(),
                mime: mime_for(&name).to_string(),
                name,
                size: meta.len(),
            })
        })
        .collect()
}

/// A name not already taken in `dir` ("photo.png", "photo 2.png", …).
fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem} {n}{ext}"))
        .find(|candidate| !dir.join(candidate).exists())
        .unwrap_or_else(|| name.to_string())
}

/// Copy or write every attachment into `<home>/attachments/<message_id>/`.
/// All or nothing: if one fails, the folder is removed and nothing is sent.
pub fn save(
    home: &Path,
    message_id: &str,
    incoming: Vec<OutgoingAttachment>,
) -> Result<Vec<Attachment>, CommandError> {
    if incoming.is_empty() {
        return Ok(Vec::new());
    }
    if incoming.len() > MAX_FILES {
        return Err(too_many());
    }
    let rel_dir = format!("attachments/{message_id}");
    let dir = home.join(&rel_dir);
    std::fs::create_dir_all(&dir).map_err(super::err_io)?;
    let result = incoming
        .into_iter()
        .map(|item| save_one(&dir, &rel_dir, item))
        .collect::<Result<Vec<_>, _>>();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

fn save_one(
    dir: &Path,
    rel_dir: &str,
    item: OutgoingAttachment,
) -> Result<Attachment, CommandError> {
    let name = unique_name(dir, &sanitize_name(&item.name));
    let dest = dir.join(&name);
    let size = match (item.path, item.data) {
        (Some(source), None) => {
            let meta = std::fs::metadata(&source)
                .map_err(|_| CommandError::expected(format!("Couldn't read {}.", item.name)))?;
            if !meta.is_file() {
                return Err(CommandError::expected(format!(
                    "{} isn't a file.",
                    item.name
                )));
            }
            if meta.len() > MAX_FILE_BYTES {
                return Err(too_big(&item.name, meta.len()));
            }
            std::fs::copy(&source, &dest).map_err(super::err_io)?
        }
        (None, Some(data)) => {
            // Base64 is 4/3 of the bytes; refuse before decoding a huge string.
            if data.len() as u64 > MAX_FILE_BYTES / 3 * 4 + 4 {
                return Err(too_big(&item.name, data.len() as u64 / 4 * 3));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|_| super::err_invalid("attachments", "not valid base64"))?;
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return Err(too_big(&item.name, bytes.len() as u64));
            }
            std::fs::write(&dest, &bytes).map_err(super::err_io)?;
            bytes.len() as u64
        }
        _ => {
            return Err(super::err_invalid(
                "attachments",
                "each attachment needs a path or data",
            ))
        }
    };
    Ok(Attachment {
        mime: mime_for(&name).to_string(),
        path: format!("{rel_dir}/{name}"),
        name,
        size,
    })
}

/// The lines appended to the prompt so the agent knows what it was handed.
pub fn prompt_block(home: &Path, attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let lines = attachments
        .iter()
        .map(|a| {
            let kind = if a.mime.starts_with("image/") {
                " (image)"
            } else if a.mime == "application/pdf" {
                " (PDF)"
            } else {
                ""
            };
            format!("- {}{kind}", home.join(&a.path).display())
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("[Attached, read them with the Read tool:\n{lines}]")
}

/// An attachment's absolute path, only if it really is one: a relative path
/// under the home's `attachments/` folder that still exists. The path comes
/// back from the frontend, so nothing else in (or outside) the home opens.
pub fn resolve(home: &Path, rel: &str) -> Result<PathBuf, CommandError> {
    let invalid = || super::err_invalid("path", "not an attachment");
    let rel = Path::new(rel);
    let safe = rel.starts_with("attachments")
        && rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !safe {
        return Err(invalid());
    }
    let full = home.join(rel);
    if !full.is_file() {
        return Err(CommandError::expected("That file isn't there any more."));
    }
    Ok(full)
}

/// The chat shows attachments through the asset protocol. The static scope
/// can't cover the agents folder (it's dot-prefixed, and the projects root is
/// configurable), so grant it at runtime, once per root.
pub fn grant_asset_scope(app: &tauri::AppHandle) {
    use std::sync::Mutex;
    static GRANTED: Mutex<Option<PathBuf>> = Mutex::new(None);
    let Ok(root) = super::store::agents_root() else {
        return;
    };
    let mut granted = GRANTED.lock().unwrap_or_else(|e| e.into_inner());
    if granted.as_ref() == Some(&root) {
        return;
    }
    let _ = std::fs::create_dir_all(&root);
    crate::commands::external_projects::grant_asset_scope(app, &root);
    *granted = Some(root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_written_before_attachments_still_load() {
        let old = r#"{"id":"m","agentId":"a","ts":1,"kind":"user","text":"hi"}"#;
        let message: super::super::store::AgentMessage = serde_json::from_str(old).unwrap();
        assert!(message.attachments.is_empty());
        // And a message without any isn't written with an empty list.
        assert!(!serde_json::to_string(&message)
            .unwrap()
            .contains("attachments"));
    }

    #[test]
    fn names_become_one_safe_segment() {
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("C:\\Users\\me\\spec.pdf"), "spec.pdf");
        assert_eq!(sanitize_name(".env"), "env");
        assert_eq!(sanitize_name("  "), "file");
        let long = format!("{}.png", "a".repeat(300));
        let short = sanitize_name(&long);
        assert!(short.ends_with(".png"));
        assert_eq!(short.chars().count(), 120);
    }

    #[test]
    fn saves_files_and_pasted_bytes_and_names_them_in_the_prompt() {
        let home = tempfile::tempdir().unwrap();
        let src = home.path().join("source.pdf");
        std::fs::write(&src, b"%PDF-1.4").unwrap();
        let saved = save(
            home.path(),
            "m1",
            vec![
                OutgoingAttachment {
                    name: "spec.pdf".into(),
                    path: Some(src.display().to_string()),
                    data: None,
                },
                OutgoingAttachment {
                    name: "image.png".into(),
                    path: None,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(b"png")),
                },
                OutgoingAttachment {
                    name: "image.png".into(),
                    path: None,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(b"png2")),
                },
            ],
        )
        .unwrap();
        assert_eq!(saved[0].path, "attachments/m1/spec.pdf");
        assert_eq!(saved[0].size, 8);
        assert_eq!(saved[1].mime, "image/png");
        // Two pastes with the same name both survive.
        assert_eq!(saved[2].name, "image 2.png");
        let prompt = prompt_block(home.path(), &saved);
        assert!(prompt.contains(&format!(
            "- {} (image)",
            home.path().join("attachments/m1/image.png").display()
        )));
        assert!(prompt.contains("spec.pdf (PDF)"));
    }

    #[test]
    fn only_attachments_resolve() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("attachments/m")).unwrap();
        std::fs::write(home.path().join("attachments/m/a.png"), b"x").unwrap();
        std::fs::write(home.path().join("CLAUDE.md"), b"x").unwrap();
        assert!(resolve(home.path(), "attachments/m/a.png").is_ok());
        assert!(resolve(home.path(), "CLAUDE.md").is_err());
        assert!(resolve(home.path(), "attachments/../CLAUDE.md").is_err());
        assert!(resolve(home.path(), "/etc/hosts").is_err());
        assert!(resolve(home.path(), "attachments/m/gone.png").is_err());
    }

    #[test]
    fn refuses_folders_too_many_and_leaves_nothing_behind() {
        let home = tempfile::tempdir().unwrap();
        let folder = home.path().join("dir");
        std::fs::create_dir(&folder).unwrap();
        let err = save(
            home.path(),
            "m2",
            vec![OutgoingAttachment {
                name: "dir".into(),
                path: Some(folder.display().to_string()),
                data: None,
            }],
        )
        .unwrap_err();
        assert!(err.to_string().contains("isn't a file"));
        assert!(!home.path().join("attachments/m2").exists());
        let many: Vec<String> = (0..=MAX_FILES).map(|i| format!("/tmp/{i}")).collect();
        assert!(inspect(&many).is_err());
        assert!(inspect(&[folder.display().to_string()])
            .unwrap_err()
            .to_string()
            .contains("folder"));
    }
}
