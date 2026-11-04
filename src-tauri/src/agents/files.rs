//! Files the other way round: an agent handing the user something it made
//! (`share_file`), the conversation's Files list, and local paths an agent
//! mentions in its prose.
//!
//! A shared file is *copied* into `<home>/attachments/<message-id>/`, exactly
//! like a file the user attaches, so the card keeps working after the agent
//! edits, moves or deletes the original, and everything in a conversation's
//! Files list lives in one place.

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::attachments::{self, Attachment, OutgoingAttachment};
use super::store::{self, MessageKind};
use crate::errors::CommandError;

/// `~/x`, `file:///x`, an absolute path, or one relative to the agent's home
/// (its working directory, so that's what a bare `report.md` means to it).
pub fn expand(raw: &str, home: &Path) -> PathBuf {
    let raw = raw.trim();
    let raw = raw.strip_prefix("file://").unwrap_or(raw);
    if raw == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    home.join(raw)
}

/// The real file an agent asked to share, only if it is one and it lives
/// inside one of `roots` (its home, the user's projects). Both sides are
/// canonicalised, so `..` segments and symlinks are judged by where they
/// actually lead, not by how the path is spelled.
pub fn shareable(raw: &str, home: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("`path` is required.".into());
    }
    let path = expand(raw, home);
    let real = path
        .canonicalize()
        .map_err(|_| format!("There's no file at {}.", path.display()))?;
    if !real.is_file() {
        return Err(format!(
            "{} is a folder. Zip it first if the user needs all of it.",
            path.display()
        ));
    }
    let inside = roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|root| real.starts_with(&root));
    if !inside {
        return Err(
            "You can only share files in your own folder or one of the user's projects. Copy it into your folder first."
                .into(),
        );
    }
    Ok(real)
}

/// Copy a shareable file into the agent's attachments for `message_id`.
pub fn share(home: &Path, message_id: &str, source: &Path) -> Result<Attachment, CommandError> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mut saved = attachments::save(
        home,
        message_id,
        vec![OutgoingAttachment {
            name,
            path: Some(source.display().to_string()),
            data: None,
        }],
    )?;
    saved
        .pop()
        .ok_or_else(|| super::err_other("Nothing was shared."))
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Sender {
    User,
    Agent,
}

/// One row of a conversation's Files list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub message_id: String,
    pub ts: i64,
    pub from: Sender,
    #[serde(flatten)]
    pub attachment: Attachment,
}

/// Everything shared in a conversation, both ways, newest first.
pub fn list(agent_id: &str) -> Result<Vec<SharedFile>, CommandError> {
    let mut files: Vec<SharedFile> = store::messages(agent_id, usize::MAX)?
        .into_iter()
        .filter(|m| matches!(m.kind, MessageKind::User | MessageKind::Agent))
        .flat_map(|m| {
            let from = if m.kind == MessageKind::User {
                Sender::User
            } else {
                Sender::Agent
            };
            let (id, ts) = (m.id, m.ts);
            m.attachments.into_iter().map(move |attachment| SharedFile {
                message_id: id.clone(),
                ts,
                from,
                attachment,
            })
        })
        .collect();
    files.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(files)
}

/// What clicking a path does.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PathAction {
    /// A document: open it in its default app.
    Open,
    /// Folders, apps, scripts and anything executable: show it in Finder,
    /// never run it. A link in an agent's reply is not consent to launch.
    Reveal,
}

/// Extensions whose default "open" runs something rather than shows it.
const LAUNCHES: &[&str] = &[
    "app",
    "command",
    "tool",
    "sh",
    "bash",
    "zsh",
    "csh",
    "fish",
    "terminal",
    "scpt",
    "scptd",
    "applescript",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "dmg",
    "jar",
    "py",
    "rb",
    "pl",
    "php",
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "prefpane",
    "kext",
    "plugin",
    "osax",
    "shortcut",
];

fn launches(path: &Path, meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return true;
        }
    }
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|e| LAUNCHES.contains(&e.as_str()))
}

/// A path from an agent's prose, resolved to something that exists, and
/// what clicking it may do. `reveal` asks for Finder whatever it is.
pub fn local_path(
    raw: &str,
    home: &Path,
    reveal: bool,
) -> Result<(PathBuf, PathAction), CommandError> {
    let path = expand(raw, home);
    let real = path
        .canonicalize()
        .map_err(|_| CommandError::expected(format!("{} isn't there.", path.display())))?;
    let meta = std::fs::metadata(&real).map_err(super::err_io)?;
    let action = if reveal || meta.is_dir() || launches(&real, &meta) {
        PathAction::Reveal
    } else {
        PathAction::Open
    };
    Ok((real, action))
}

pub fn perform(path: &Path, action: PathAction) -> Result<(), CommandError> {
    match action {
        PathAction::Open => tauri_plugin_opener::open_path(path, None::<&str>),
        PathAction::Reveal => tauri_plugin_opener::reveal_item_in_dir(path),
    }
    .map_err(super::err_other)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("agents/a1");
        let project = dir.path().join("acme");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(home.join("report.md"), b"# Report").unwrap();
        std::fs::write(project.join("data.csv"), b"a,b").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"no").unwrap();
        (dir, home, project)
    }

    #[test]
    fn shares_files_in_the_home_or_a_project() {
        let (_dir, home, project) = setup();
        let roots = [home.clone(), project.clone()];
        assert!(shareable("report.md", &home, &roots).is_ok());
        let abs = project.join("data.csv").display().to_string();
        assert!(shareable(&abs, &home, &roots).is_ok());
        assert!(shareable(&format!("file://{abs}"), &home, &roots).is_ok());
    }

    #[test]
    fn refuses_traversal_folders_and_missing_files() {
        let (_dir, home, project) = setup();
        let roots = [home.clone(), project.clone()];
        let err = shareable("../../secret.txt", &home, &roots).unwrap_err();
        assert!(err.contains("own folder"));
        // Spelled as if inside the project, resolving outside it.
        let sneaky = format!("{}/../secret.txt", project.display());
        assert!(shareable(&sneaky, &home, &roots).is_err());
        assert!(shareable("/etc/hosts", &home, &roots).is_err());
        assert!(shareable(".", &home, &roots)
            .unwrap_err()
            .contains("folder"));
        assert!(shareable("gone.pdf", &home, &roots).is_err());
        assert!(shareable("  ", &home, &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_lead_outside() {
        let (dir, home, project) = setup();
        let roots = [home.clone(), project.clone()];
        let outside = dir.path().join("secret.txt");
        std::os::unix::fs::symlink(&outside, home.join("link.txt")).unwrap();
        assert!(shareable("link.txt", &home, &roots).is_err());
        // A symlinked folder inside the home pointing out is no way round it.
        std::os::unix::fs::symlink(dir.path(), home.join("escape")).unwrap();
        assert!(shareable("escape/secret.txt", &home, &roots).is_err());
        // A symlink that stays inside is fine.
        std::os::unix::fs::symlink(project.join("data.csv"), home.join("data.csv")).unwrap();
        assert!(shareable("data.csv", &home, &roots).is_ok());
    }

    #[test]
    fn a_share_is_copied_into_the_message_folder() {
        let (_dir, home, _project) = setup();
        let source = shareable("report.md", &home, std::slice::from_ref(&home)).unwrap();
        let saved = share(&home, "m9", &source).unwrap();
        assert_eq!(saved.path, "attachments/m9/report.md");
        assert_eq!(saved.mime, "text/markdown");
        assert!(home.join("attachments/m9/report.md").is_file());
        // The original stays where it was.
        assert!(home.join("report.md").is_file());
    }

    #[test]
    fn prose_paths_open_documents_and_only_reveal_the_rest() {
        let (dir, home, _project) = setup();
        let (_, action) = local_path("report.md", &home, false).unwrap();
        assert_eq!(action, PathAction::Open);
        assert_eq!(
            local_path("report.md", &home, true).unwrap().1,
            PathAction::Reveal
        );
        let folder = dir.path().display().to_string();
        assert_eq!(
            local_path(&folder, &home, false).unwrap().1,
            PathAction::Reveal
        );
        std::fs::write(home.join("run.command"), b"rm -rf ~").unwrap();
        assert_eq!(
            local_path("run.command", &home, false).unwrap().1,
            PathAction::Reveal
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = home.join("notes");
            std::fs::write(&script, b"#!/bin/sh").unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                local_path("notes", &home, false).unwrap().1,
                PathAction::Reveal
            );
        }
        assert!(local_path("nope.md", &home, false).is_err());
    }

    #[test]
    fn the_files_list_is_both_directions_newest_first() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let file = |name: &str| Attachment {
            name: name.into(),
            path: format!("attachments/x/{name}"),
            mime: attachments::mime_for(name).into(),
            size: 3,
        };
        let mut sent = super::super::runner::new_message(&agent.id, MessageKind::User, "");
        sent.ts = 1;
        sent.attachments = vec![file("brief.pdf")];
        let mut shared = super::super::runner::new_message(&agent.id, MessageKind::Agent, "Done");
        shared.ts = 2;
        shared.attachments = vec![file("report.csv")];
        let plain = super::super::runner::new_message(&agent.id, MessageKind::Agent, "Hi");
        for m in [&sent, &shared, &plain] {
            store::append_message(m).unwrap();
        }
        let files = list(&agent.id).unwrap();
        store::set_root_for_tests(None);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].attachment.name, "report.csv");
        assert_eq!(files[0].from, Sender::Agent);
        assert_eq!(files[1].from, Sender::User);
    }
}
