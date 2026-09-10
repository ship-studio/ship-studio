//! Writing `.shipstudio-team/threads/` — comments, replies and resolutions.
//!
//! Everything here is a file write and nothing here touches git. That is the
//! whole design: a project that was never `git init`ed still gets comments,
//! because a comment is a note about a page, and needing a remote to write one
//! would be an arbitrary tax on the person using Harbr alone.
//!
//! Git is a *transport* layered on top by [`super::transport`], and each layer
//! degrades on its own:
//!
//! ```text
//! write the file        always      comments work with no git at all
//! + a repository        commit to refs/heads/shipstudio-team
//! + a remote            push and fetch it, so teammates see them
//! ```
//!
//! ## Append-only, like the update records
//!
//! A reply is a new file. A resolution is a new file. Nothing is ever edited in
//! place, because in-place edits are what turn two people acting at once into a
//! merge conflict in a JSON blob. The current state of a thread is a fold over
//! its records, computed at read time in [`super::records`] — both files land,
//! the fold takes the later one, and nobody's decision is lost.
//!
//! ## The anchor is what makes a pin a pin
//!
//! A thread carries a display label (`h1 · Simple pricing`), and that is all the
//! feed needs. Drawing the pin on the element itself needs the selector, the
//! ancestor chain, the rect and the viewport it was measured at. Those live in
//! `anchor`, which is additive: a build that has never heard of it reads the
//! thread and lists it without a pin rather than failing.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::errors::CommandError;

use super::writer::ulid;

/// Where on the page a comment was left.
///
/// Mirrors the frontend's `CommentTarget`, which is what the preview captures
/// when you click an element. Every field is what was *measured*, never what
/// was guessed: a pin that cannot be placed is not drawn.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAnchor {
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub tag: String,
    /// Outermost first, so a build can walk up when the exact node is gone.
    #[serde(default)]
    pub ancestors: Vec<String>,
    #[serde(default)]
    pub classes: String,
    /// The heading or copy the element carried, for naming it in prose.
    #[serde(default)]
    pub heading: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub viewport: Option<ThreadRect>,
    #[serde(default)]
    pub rect: Option<ThreadRect>,
    /// The source file the element came from, when the preview could tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct ThreadRect {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

/// Who wrote a record.
///
/// `login` is absent on a machine with no GitHub sign-in, which is a normal
/// state and not an error — the name still identifies the person to their own
/// team, and a login that appears later does not invalidate what was written.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadAuthor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub name: String,
}

/// A comment record as written to disk.
#[derive(Debug, Serialize)]
struct ThreadRecord<'a> {
    v: u32,
    kind: &'a str,
    id: &'a str,
    at: i64,
    actor: &'a ThreadAuthor,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'a str>,
    /// The thread this belongs to. A `comment` starts one, so it is its own id.
    #[serde(skip_serializing_if = "Option::is_none")]
    thread: Option<&'a str>,
    /// Which message an `edit` or `retract` acts on.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    route: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pin: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<&'a ThreadAnchor>,
}

/// The most a comment body may carry.
///
/// Generous for a note about a page, and short enough that a runaway paste
/// cannot put a megabyte into a directory everyone on the team fetches.
const MAX_BODY: usize = 8_000;

/// A body worth writing, or the reason it is not.
fn clean_body(body: &str) -> Result<String, CommandError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(CommandError::expected("A comment needs something in it."));
    }
    // Characters, not bytes. The composer's own limit is a `maxLength` on a
    // textarea, which counts characters, so counting bytes here rejected text
    // the UI had just accepted — and told the person a character count that did
    // not match what they could see.
    let length = trimmed.chars().count();
    if length > MAX_BODY {
        return Err(CommandError::expected(format!(
            "That comment is {length} characters. Comments are capped at {MAX_BODY} so a \
             repository everyone fetches stays small — try trimming it, or leave the detail in \
             the code."
        )));
    }
    Ok(trimmed.to_string())
}

/// Start a thread. Returns its id, which every later record on it carries.
#[allow(clippy::too_many_arguments)]
pub fn write_comment(
    project: &Path,
    actor: &ThreadAuthor,
    branch: Option<&str>,
    route: &str,
    target: &str,
    pin: u32,
    body: &str,
    anchor: Option<&ThreadAnchor>,
) -> Result<String, CommandError> {
    let body = clean_body(body)?;
    let id = ulid();
    write_record(
        project,
        actor,
        &id,
        ThreadRecord {
            v: 1,
            kind: "comment",
            id: &id,
            at: now_ms(),
            actor,
            agent: None,
            thread: None,
            message: None,
            branch,
            route: Some(route),
            target: Some(target),
            pin: Some(pin),
            body: Some(&body),
            resolved: None,
            anchor,
        },
    )?;
    Ok(id)
}

/// Add a message to an existing thread.
pub fn write_reply(
    project: &Path,
    actor: &ThreadAuthor,
    thread: &str,
    body: &str,
    agent: Option<&str>,
) -> Result<String, CommandError> {
    let body = clean_body(body)?;
    let id = ulid();
    write_record(
        project,
        actor,
        &id,
        ThreadRecord {
            v: 1,
            kind: "reply",
            id: &id,
            at: now_ms(),
            actor,
            agent,
            thread: Some(thread),
            message: None,
            branch: None,
            route: None,
            target: None,
            pin: None,
            body: Some(&body),
            resolved: None,
            anchor: None,
        },
    )?;
    Ok(id)
}

/// Resolve or reopen a thread.
///
/// An append, never a field flip on the original comment. Two people resolving
/// the same thread at once write two files, both land, and the fold takes the
/// later one — where editing the comment in place would have been a conflict in
/// a file one of them then has to hand-merge.
pub fn write_resolve(
    project: &Path,
    actor: &ThreadAuthor,
    thread: &str,
    resolved: bool,
    agent: Option<&str>,
) -> Result<String, CommandError> {
    let id = ulid();
    write_record(
        project,
        actor,
        &id,
        ThreadRecord {
            v: 1,
            kind: "resolve",
            id: &id,
            at: now_ms(),
            actor,
            agent,
            thread: Some(thread),
            message: None,
            branch: None,
            route: None,
            target: None,
            pin: None,
            body: None,
            resolved: Some(resolved),
            anchor: None,
        },
    )?;
    Ok(id)
}

/// Rewrite a message you wrote.
///
/// The fold enforces that "you wrote it" at read time, so a record claiming to
/// edit somebody else's message is written but never rendered — by anyone,
/// including the person who wrote it.
pub fn write_edit(
    project: &Path,
    actor: &ThreadAuthor,
    thread: &str,
    message: &str,
    body: &str,
) -> Result<String, CommandError> {
    let body = clean_body(body)?;
    let id = ulid();
    write_record(
        project,
        actor,
        &id,
        ThreadRecord {
            v: 1,
            kind: "edit",
            id: &id,
            at: now_ms(),
            actor,
            agent: None,
            thread: Some(thread),
            message: Some(message),
            branch: None,
            route: None,
            target: None,
            pin: None,
            body: Some(&body),
            resolved: None,
            anchor: None,
        },
    )?;
    Ok(id)
}

/// Withdraw a message you wrote.
///
/// Deliberately not called delete. The original record is still on disk and in
/// every clone that fetched it; what this changes is what the feed shows. The
/// UI must not promise more than that.
pub fn write_retract(
    project: &Path,
    actor: &ThreadAuthor,
    thread: &str,
    message: &str,
) -> Result<String, CommandError> {
    let id = ulid();
    write_record(
        project,
        actor,
        &id,
        ThreadRecord {
            v: 1,
            kind: "retract",
            id: &id,
            at: now_ms(),
            actor,
            agent: None,
            thread: Some(thread),
            message: Some(message),
            branch: None,
            route: None,
            target: None,
            pin: None,
            body: None,
            resolved: None,
            anchor: None,
        },
    )?;
    Ok(id)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write one record file under `threads/<date>/<ulid>-<login>.json`.
///
/// Written to a temporary file and renamed, because the reader is a directory
/// scan that can run at any moment — including while this is writing. A rename
/// is atomic, so a reader sees the whole file or no file, never half of one.
fn write_record(
    project: &Path,
    actor: &ThreadAuthor,
    id: &str,
    record: ThreadRecord<'_>,
) -> Result<(), CommandError> {
    let login = actor
        .login
        .as_deref()
        .filter(|login| !login.is_empty())
        .unwrap_or("local");
    let path = thread_path(project, id, login);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(CommandError::from)?;
    }
    let json = serde_json::to_string_pretty(&record).map_err(|e| CommandError::Other {
        message: format!("could not serialise team record: {e}"),
    })?;

    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, format!("{json}\n")).map_err(CommandError::from)?;
    std::fs::rename(&temp, &path).map_err(CommandError::from)?;

    tracing::info!(id = %id, kind = %record.kind, path = %path.display(), "wrote thread record");
    Ok(())
}

/// Where a thread record for today goes.
fn thread_path(project: &Path, id: &str, login: &str) -> std::path::PathBuf {
    project
        .join(super::TEAM_DIR)
        .join("threads")
        .join(super::writer::today())
        .join(format!("{id}-{login}.json"))
}

// ---------------------------------------------------------------- commands

/// Who is writing, from the two sources that can be believed.
///
/// The GitHub login when signed in, and the name git is already configured to
/// commit under. Neither is invented: with no login the record simply has none,
/// and a teammate's build will show the name rather than an account it cannot
/// confirm. Both lookups are cheap and local — no network on the path between
/// pressing save and the file existing.
async fn me(project: &Path) -> ThreadAuthor {
    let login =
        crate::commands::github::get_github_username(Some(project.to_string_lossy().into_owned()))
            .await
            .ok()
            .map(|login| login.to_lowercase())
            .filter(|login| !login.is_empty());

    let name = super::derive::own_git_name(project)
        .await
        .or_else(|| login.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    ThreadAuthor { login, name }
}

/// Leave a comment. Returns the new thread's id.
#[allow(clippy::too_many_arguments)]
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path, body, anchor), fields(project = %project_path))]
pub async fn add_team_comment(
    project_path: String,
    branch: Option<String>,
    route: String,
    target: String,
    pin: u32,
    body: String,
    anchor: Option<ThreadAnchor>,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let actor = me(&project).await;
    write_comment(
        &project,
        &actor,
        branch.as_deref(),
        &route,
        &target,
        pin,
        &body,
        anchor.as_ref(),
    )
}

/// Reply on a thread. Returns the new record's id.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path, body), fields(project = %project_path))]
pub async fn reply_to_team_thread(
    project_path: String,
    thread_id: String,
    body: String,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let actor = me(&project).await;
    write_reply(&project, &actor, &thread_id, &body, None)
}

/// Resolve or reopen a thread. Returns the new record's id.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn set_team_thread_resolved(
    project_path: String,
    thread_id: String,
    resolved: bool,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let actor = me(&project).await;
    write_resolve(&project, &actor, &thread_id, resolved, None)
}

/// Fetch other people's comments, then publish yours.
///
/// The one place in the feature that touches the network, and it is always an
/// explicit call — the schedule lives in the frontend where the user can see
/// it. Returns what happened rather than throwing: a push that failed still
/// leaves the comment on disk, and the panel says so instead of the write
/// looking like it was lost.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn sync_team_threads(
    project_path: String,
) -> Result<super::transport::SyncOutcome, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    if !super::derive::is_repo(&project).await {
        // A folder with no repository has comments and nothing to sync them
        // with. Not an error: they are saved, and they are only ever yours.
        return Ok(super::transport::SyncOutcome {
            pending: 0,
            has_remote: false,
            ..Default::default()
        });
    }

    let has_remote = super::snapshot::has_origin(&project).await;
    let actor = me(&project).await;
    Ok(super::transport::sync(&project, &actor.name, has_remote).await)
}

/// Rewrite a message. Returns the new record's id.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path, body), fields(project = %project_path))]
pub async fn edit_team_message(
    project_path: String,
    thread_id: String,
    message_id: String,
    body: String,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let actor = me(&project).await;
    write_edit(&project, &actor, &thread_id, &message_id, &body)
}

/// Withdraw a message. Returns the new record's id.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn retract_team_message(
    project_path: String,
    thread_id: String,
    message_id: String,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let actor = me(&project).await;
    write_retract(&project, &actor, &thread_id, &message_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn author() -> ThreadAuthor {
        ThreadAuthor {
            login: Some("mayareed".to_string()),
            name: "Maya Reed".to_string(),
        }
    }

    fn read_all(dir: &Path) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let threads = dir.join(super::super::TEAM_DIR).join("threads");
        for day in std::fs::read_dir(&threads).into_iter().flatten().flatten() {
            for file in std::fs::read_dir(day.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                let raw = std::fs::read_to_string(file.path()).unwrap();
                out.push(serde_json::from_str(&raw).unwrap());
            }
        }
        out
    }

    #[test]
    fn writes_a_comment_with_no_git_repository_anywhere() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately not a repo: no `git init`, no `.git`, nothing.
        let id = write_comment(
            dir.path(),
            &author(),
            None,
            "/pricing",
            "h1 · Simple pricing",
            1,
            "Should this say seats?",
            None,
        )
        .unwrap();

        let records = read_all(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["kind"], "comment");
        assert_eq!(records[0]["id"], id);
        assert_eq!(records[0]["pin"], 1);
        assert_eq!(records[0]["body"], "Should this say seats?");
    }

    #[test]
    fn a_resolution_is_a_new_file_and_never_an_edit_of_the_comment() {
        let dir = tempfile::tempdir().unwrap();
        let thread = write_comment(
            dir.path(),
            &author(),
            Some("main"),
            "/",
            "button · Buy",
            1,
            "Wrong label",
            None,
        )
        .unwrap();
        write_resolve(dir.path(), &author(), &thread, true, Some("Claude Code")).unwrap();

        let records = read_all(dir.path());
        assert_eq!(records.len(), 2, "the comment file must still be there");
        let comment = records.iter().find(|r| r["kind"] == "comment").unwrap();
        assert!(
            comment.get("resolved").is_none(),
            "resolving must not write back into the comment record"
        );
        let resolve = records.iter().find(|r| r["kind"] == "resolve").unwrap();
        assert_eq!(resolve["resolved"], true);
        assert_eq!(resolve["thread"], thread);
        assert_eq!(resolve["agent"], "Claude Code");
    }

    #[test]
    fn an_empty_body_is_refused_rather_than_written_as_a_blank_row() {
        let dir = tempfile::tempdir().unwrap();
        let result = write_comment(dir.path(), &author(), None, "/", "p", 1, "   ", None);
        assert!(result.is_err());
        assert!(!dir.path().join(super::super::TEAM_DIR).exists());
    }

    #[test]
    fn a_signed_out_author_writes_a_file_named_local_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        let anon = ThreadAuthor {
            login: None,
            name: "Julian".to_string(),
        };
        write_comment(dir.path(), &anon, None, "/", "h1", 1, "note", None).unwrap();

        let threads = dir.path().join(super::super::TEAM_DIR).join("threads");
        let day = std::fs::read_dir(&threads)
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        let file = std::fs::read_dir(day.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert!(file.file_name().to_string_lossy().ends_with("-local.json"));
    }

    #[test]
    fn the_anchor_round_trips_so_a_pin_can_be_placed_again() {
        let dir = tempfile::tempdir().unwrap();
        let anchor = ThreadAnchor {
            selector: "main > section:nth-of-type(2) h1".to_string(),
            tag: "h1".to_string(),
            ancestors: vec!["main".to_string(), "section".to_string()],
            heading: "Simple pricing".to_string(),
            viewport: Some(ThreadRect {
                width: 1440.0,
                height: 900.0,
                ..Default::default()
            }),
            rect: Some(ThreadRect {
                x: 120.0,
                y: 340.0,
                width: 400.0,
                height: 48.0,
            }),
            ..Default::default()
        };
        write_comment(
            dir.path(),
            &author(),
            None,
            "/pricing",
            "h1 · Simple pricing",
            1,
            "note",
            Some(&anchor),
        )
        .unwrap();

        let records = read_all(dir.path());
        let stored = &records[0]["anchor"];
        assert_eq!(stored["selector"], "main > section:nth-of-type(2) h1");
        assert_eq!(stored["rect"]["y"], 340.0);
        assert_eq!(stored["viewport"]["width"], 1440.0);
    }

    #[test]
    fn a_runaway_paste_is_refused_so_the_shared_ref_stays_small() {
        let dir = tempfile::tempdir().unwrap();
        let huge = "x".repeat(MAX_BODY + 1);
        let result = write_comment(dir.path(), &author(), None, "/", "p", 1, &huge, None);
        assert!(result.is_err());
    }

    #[test]
    fn the_cap_counts_characters_so_it_matches_what_the_composer_allowed() {
        let dir = tempfile::tempdir().unwrap();
        // Four bytes each. Byte-counting rejected this at a quarter of the
        // length the textarea had just accepted.
        let emoji = "🌍".repeat(MAX_BODY);
        assert!(
            emoji.len() > MAX_BODY,
            "the fixture has to exceed the byte cap"
        );
        assert!(write_comment(dir.path(), &author(), None, "/", "p", 1, &emoji, None).is_ok());

        let over = "🌍".repeat(MAX_BODY + 1);
        assert!(write_comment(dir.path(), &author(), None, "/", "p", 2, &over, None).is_err());
    }
}
