//! Reading `.shipstudio-team/` — the comment threads.
//!
//! One record per file, written once, never modified:
//!
//! ```text
//! .shipstudio-team/threads/2026-09-07/01K4J8Q20001ABCDEFGHJKMNPQ-mayareed.json
//! ```
//!
//! There was briefly a second directory here, `updates/`, holding a written
//! explanation of a piece of work. It is gone: a commit body already is that,
//! every tool the team owns can read one, and a second copy joined back by a
//! trailer gave every writer two chances to record one sentence. What is left
//! is the half git has no field for — a comment anchored to a place on a page.
//!
//! Two people writing in the same second produce two different files, so git
//! merges them with no conflict — by construction rather than by luck. Put the
//! same data in one `activity.json` and every concurrent write is a merge
//! conflict in a JSON blob, which is the failure that ends the feature in week
//! one.
//!
//! Mutation is an append too. Resolving a comment writes a `resolve` record
//! rather than editing the `comment` record, and the current state of a thread
//! is a **fold** over its records computed here at read time. That is the only
//! form that survives two people acting at once: both files land, the fold
//! takes the later one, and nobody's work is lost to a merge.
//!
//! ## Forward compatibility is a hard requirement, not a nicety
//!
//! These files come off a git remote, written by teammates on versions of Ship
//! Studio that do not exist yet. A record this build does not understand is
//! **skipped**, never fatal: one person upgrading must not blank the feed for
//! everyone who has not. Hence `#[serde(default)]` throughout, an ignored
//! unknown field, and an `Unknown` catch-all kind.
//!
//! The strict schema lives on the write path, where an agent's output is
//! checked before anything is committed. Lenient in, strict out.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use super::{TeamActor, TeamMessage, TeamThread};

/// A record's author, as written into the file.
#[derive(Debug, Clone, Deserialize)]
pub struct RecordActor {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub name: String,
}

impl RecordActor {
    /// The stored half of an actor. Avatars are never stored — they are a
    /// GitHub URL that rotates, and a stale one in committed history renders a
    /// broken image forever.
    fn to_actor(&self) -> TeamActor {
        TeamActor {
            login: self.login.clone().filter(|s| !s.is_empty()),
            name: if self.name.is_empty() {
                self.login.clone().unwrap_or_else(|| "Unknown".to_string())
            } else {
                self.name.clone()
            },
            avatar_url: None,
        }
    }
}

/// What a record says happened.
///
/// `Unknown` is load-bearing: a future kind deserializes into it and is skipped
/// rather than failing the whole directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RecordKind {
    /// A new comment thread anchored to something in the preview.
    Comment,
    /// A message on an existing thread.
    Reply,
    /// A thread was resolved or reopened.
    Resolve,
    /// A message's text was rewritten by the person who wrote it.
    ///
    /// An append, like everything else: the original file stays, and the fold
    /// applies the newest edit. That keeps two people's concurrent writes from
    /// ever touching the same file, and it means an edit that arrives out of
    /// order still lands on the right message.
    Edit,
    /// A message was withdrawn by the person who wrote it.
    ///
    /// Not a delete. The record it withdraws is still on disk and still in
    /// everyone's clone — claiming otherwise would be a lie about a git
    /// repository. What this does is remove it from the feed, which is what
    /// the person actually wanted.
    Retract,
    #[serde(other)]
    #[default]
    Unknown,
}

/// One file under `.shipstudio-team/threads/`.
///
/// Every field past the envelope is optional because a record of one kind
/// carries none of another kind's fields, and because a field this build has
/// never heard of must not stop the file from being read.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamRecord {
    /// Schema version. Bumped only for a change that older builds cannot read
    /// past; the lenient parse means most additions do not need one.
    #[serde(default = "one")]
    pub v: u32,
    #[serde(default)]
    pub kind: RecordKind,
    #[serde(default)]
    pub id: String,
    /// Unix milliseconds, author's clock.
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub actor: Option<RecordActor>,

    /// The branch the thread was opened on, kept so the feed can say where a
    /// comment was left. Comments themselves are not branch-scoped — they ride
    /// a ref of their own ([`super::transport`]) so a note about the pricing
    /// page is not invisible until the pricing branch merges.
    #[serde(default)]
    pub branch: Option<String>,

    /// The thread this record belongs to. A `comment` starts one, so its
    /// thread id is its own id.
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    /// The number the author's own machine drew on this pin.
    ///
    /// Parsed and kept so a record round-trips, and deliberately not read: the
    /// fold numbers threads itself, in creation order, so that two people who
    /// both wrote a "1" still agree about which note is which. Removing the
    /// field would silently drop it from every record this build rewrites.
    #[allow(dead_code)]
    #[serde(default)]
    pub pin: Option<u32>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub resolved: Option<bool>,
    /// Which message an `edit` or `retract` applies to. A thread's opening
    /// comment is its own message, so this equals `thread` for that one.
    #[serde(default)]
    pub message: Option<String>,
    /// Where on the page the comment was left, when the writer measured it.
    /// Additive: a record without one lists fine and simply has no pin drawn.
    #[serde(default)]
    pub anchor: Option<super::threads::ThreadAnchor>,
}

fn one() -> u32 {
    1
}

/// The highest schema version this build understands.
const SUPPORTED_VERSION: u32 = 1;

impl TeamRecord {
    /// Whether this build can act on the record at all.
    ///
    /// A record from the future is shown as nothing rather than as a guess.
    /// It stays on disk and a later build will read it — nothing is lost, and
    /// nothing is invented in the meantime.
    pub fn is_readable(&self) -> bool {
        self.v <= SUPPORTED_VERSION && self.kind != RecordKind::Unknown && !self.id.is_empty()
    }

    pub fn actor(&self) -> TeamActor {
        self.actor
            .as_ref()
            .map(RecordActor::to_actor)
            .unwrap_or_else(|| TeamActor {
                login: None,
                name: "Unknown".to_string(),
                avatar_url: None,
            })
    }
}

/// The one record directory.
///
/// A comment has no work commit to ride, and a comment written on `feat/x`
/// that only becomes visible when `feat/x` merges is not a comment — it is a
/// note to yourself. So threads are carried by [`super::transport`] on a ref of
/// their own, independent of whatever branch anybody is on.
pub const RECORD_DIR: &str = "threads";

/// Read every record under `<project>/.shipstudio-team/`.
///
/// Returns them oldest-first, which is the order a fold needs: later records
/// win, and ULIDs sort chronologically, so lexical order over `<date>/<ulid>`
/// *is* chronological order without parsing a single timestamp.
///
/// A missing directory is the normal state for a repo nobody has used Ship
/// Studio on. It returns empty, not an error.
pub fn read_records(project: &Path) -> Vec<TeamRecord> {
    let root = project.join(super::TEAM_DIR);
    let mut keyed: Vec<(String, TeamRecord)> = Vec::new();
    read_dir_records(&root.join(RECORD_DIR), &mut keyed);
    // Sort by `<date>/<ulid>-<login>.json`. ULIDs sort chronologically, so this
    // is creation order across every machine that ever wrote here.
    keyed.sort_by(|(a, _), (b, _)| a.cmp(b));
    keyed.into_iter().map(|(_, record)| record).collect()
}

/// Read one record directory into `out`, keyed by `<date>/<filename>`.
fn read_dir_records(root: &Path, out: &mut Vec<(String, TeamRecord)>) {
    let Ok(days) = std::fs::read_dir(root) else {
        return;
    };

    let mut day_dirs: Vec<std::path::PathBuf> = days
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    day_dirs.sort();

    for day in day_dirs {
        let Ok(entries) = std::fs::read_dir(&day) else {
            continue;
        };
        let mut files: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();

        for file in files {
            let Ok(raw) = std::fs::read_to_string(&file) else {
                continue;
            };
            match serde_json::from_str::<TeamRecord>(&raw) {
                Ok(record) if record.is_readable() => {
                    out.push((sort_key(&day, &file), record));
                }
                Ok(_) => {
                    tracing::debug!(file = %file.display(), "team record skipped: unreadable version or kind");
                }
                Err(error) => {
                    // A corrupt or half-written file is one lost row, not a
                    // broken feed. It is logged rather than surfaced: the user
                    // did not write it and cannot fix it.
                    tracing::warn!(file = %file.display(), %error, "team record failed to parse");
                }
            }
        }
    }
}

/// `<date>/<filename>` — the part of the path that is identical in shape across
/// both record directories, so records from either sort into one timeline.
fn sort_key(day: &Path, file: &Path) -> String {
    let date = day
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{date}/{name}")
}

/// Every login that has ever written a record here.
///
/// This is what `usesShipStudio` is derived from. Nobody registers, nobody is
/// invited, and nobody's status is declared — you use Harbr if your
/// Fold the comment-family records into threads.
///
/// The fold is the whole point of append-only. A `comment` opens a thread, a
/// `reply` adds to it, a `resolve` flips a flag — and if two people resolve the
/// same thread from different machines, both records land and the later one
/// wins, deterministically, on every clone.
///
/// ## Why this is two passes
///
/// A one-pass fold drops a reply that is read before the comment it answers,
/// which sounds impossible — ULIDs sort chronologically, so a reply's file
/// always sorts after its comment's — right up until two machines disagree
/// about what time it is. The model already concedes clock skew (there is no
/// server clock to correct against), and skew is exactly what puts a reply in
/// an earlier day directory than the thread it belongs to.
///
/// Opening every thread first makes the result independent of read order, which
/// is what a fold over an append-only log is supposed to be. A reply whose
/// comment is genuinely absent — not yet fetched, or on a branch this clone
/// does not have — is still dropped rather than used to conjure a thread with
/// no anchor, no route and no target. It reappears when the file does.
/// Look up a person's avatar, when anything can confirm one.
///
/// A record never stores an avatar: it is a GitHub URL that rotates, and one
/// committed into history renders a broken image in every clone forever. So the
/// picture is resolved at read time from what GitHub says right now, and a
/// person with no GitHub account — or a machine that cannot ask — simply has
/// none, which the UI draws as their initials on a colour.
pub type AvatarLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// No avatars available: the local-only case, and the default for callers that
/// have not asked GitHub anything.
pub fn no_avatars(_login: &str) -> Option<String> {
    None
}

pub fn fold_threads(
    records: &[TeamRecord],
    project_name: &str,
    project_path: &str,
    avatar_for: AvatarLookup<'_>,
) -> Vec<TeamThread> {
    let mut threads: Vec<TeamThread> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for record in records.iter().filter(|r| r.kind == RecordKind::Comment) {
        if index.contains_key(&record.id) {
            continue;
        }
        index.insert(record.id.clone(), threads.len());
        threads.push(TeamThread {
            id: record.id.clone(),
            project_name: project_name.to_string(),
            project_path: project_path.to_string(),
            branch: record.branch.clone().unwrap_or_default(),
            route: record.route.clone().unwrap_or_default(),
            target: record.target.clone().unwrap_or_default(),
            // Numbered here, not by whoever placed it.
            //
            // A pin number exists so two people can say "look at 3" and mean
            // the same note. The author's own number cannot do that: everyone
            // counts from their own list, so two people working at once both
            // write a 1, and the number means nothing the moment it is spoken
            // aloud — which is the only time it is worth having.
            //
            // Records are read in ULID order, which is creation order, and
            // every machine folds the same records. So counting them here
            // gives everyone the same numbers without anyone coordinating.
            // The stored `pin` is kept in the record as what the author saw,
            // and deliberately not used.
            pin: 0,
            anchor: record.anchor.clone(),
            resolved: false,
            resolved_by: None,
            messages: vec![TeamMessage {
                id: record.id.clone(),
                actor: with_avatar(record.actor(), avatar_for),
                at: record.at,
                body: record.body.clone().unwrap_or_default(),
                pending: None,
            }],
        });
    }

    // Resolves are applied in timestamp order, not file order, so the newest
    // decision wins even when the clocks that produced them disagree about
    // which file sorts first.
    let mut resolves: Vec<&TeamRecord> = records
        .iter()
        .filter(|r| r.kind == RecordKind::Resolve)
        .collect();
    resolves.sort_by_key(|record| record.at);

    for record in records.iter().filter(|r| r.kind == RecordKind::Reply) {
        let Some(&position) = record.thread.as_deref().and_then(|id| index.get(id)) else {
            continue;
        };
        threads[position].messages.push(TeamMessage {
            id: record.id.clone(),
            actor: with_avatar(record.actor(), avatar_for),
            at: record.at,
            body: record.body.clone().unwrap_or_default(),
            pending: None,
        });
    }

    for record in resolves {
        let Some(&position) = record.thread.as_deref().and_then(|id| index.get(id)) else {
            continue;
        };
        let resolved = record.resolved.unwrap_or(true);
        threads[position].resolved = resolved;
        threads[position].resolved_by = resolved.then(|| with_avatar(record.actor(), avatar_for));
    }

    // Numbered in creation order, before anything is removed. Retracting note
    // 2 must not renumber 3 into a 2 — someone reading a screenshot, or an
    // agent halfway through a prompt that names it, would be pointed at a
    // different note than the one that was meant.
    for (position, thread) in threads.iter_mut().enumerate() {
        thread.pin = position as u32 + 1;
    }

    apply_edits(records, &mut threads, &index);
    apply_retractions(records, &mut threads, &index);

    for thread in &mut threads {
        thread.messages.sort_by_key(|message| message.at);
    }
    // A thread whose opening comment was withdrawn has nothing left to show.
    threads.retain(|thread| !thread.messages.is_empty());
    threads
}

/// An actor with their picture attached, if GitHub knows one.
fn with_avatar(actor: TeamActor, avatar_for: AvatarLookup<'_>) -> TeamActor {
    let avatar_url = actor.login.as_deref().and_then(avatar_for);
    TeamActor {
        avatar_url,
        ..actor
    }
}

/// Rewrite message bodies, newest edit last, author only.
///
/// The author check is the whole point of doing this at read time rather than
/// trusting the file: records arrive off a git remote, and anyone with push
/// access can write any JSON they like. A record that claims to edit somebody
/// else's message is ignored, so the worst a bad actor achieves is a file
/// nobody renders.
fn apply_edits(records: &[TeamRecord], threads: &mut [TeamThread], index: &HashMap<String, usize>) {
    let mut edits: Vec<&TeamRecord> = records
        .iter()
        .filter(|record| record.kind == RecordKind::Edit)
        .collect();
    edits.sort_by_key(|record| record.at);

    for record in edits {
        let Some(&position) = record.thread.as_deref().and_then(|id| index.get(id)) else {
            continue;
        };
        let (Some(target), Some(body)) = (record.message.as_deref(), record.body.as_deref()) else {
            continue;
        };
        let editor = record.actor();
        if let Some(message) = threads[position]
            .messages
            .iter_mut()
            .find(|message| message.id == target)
        {
            if same_person(&message.actor, &editor) {
                message.body = body.to_string();
            }
        }
    }
}

/// Drop withdrawn messages, author only.
fn apply_retractions(
    records: &[TeamRecord],
    threads: &mut [TeamThread],
    index: &HashMap<String, usize>,
) {
    for record in records
        .iter()
        .filter(|record| record.kind == RecordKind::Retract)
    {
        let Some(&position) = record.thread.as_deref().and_then(|id| index.get(id)) else {
            continue;
        };
        let Some(target) = record.message.as_deref() else {
            continue;
        };
        let author = record.actor();
        threads[position]
            .messages
            .retain(|message| message.id != target || !same_person(&message.actor, &author));
    }
}

/// Whether two actors are the same person.
///
/// By login when both have one, because that is an account and not a label.
/// Falling back to the name is deliberate and narrow: on a machine with no
/// GitHub sign-in the name is the only identity anything has, and without this
/// a solo user could not edit their own comment. It never *widens* access — a
/// record carrying a login is only ever matched against that same login.
fn same_person(a: &TeamActor, b: &TeamActor) -> bool {
    match (a.login.as_deref(), b.login.as_deref()) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        (None, None) => !a.name.is_empty() && a.name == b.name,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> TeamRecord {
        serde_json::from_str(json).expect("parses")
    }

    #[test]
    fn ignores_a_field_it_has_never_heard_of() {
        let record = parse(
            r#"{"v":1,"kind":"comment","id":"01A","at":1,"body":"Hi",
                "somethingFromTheFuture":{"nested":true}}"#,
        );
        assert!(record.is_readable());
        assert_eq!(record.body.as_deref(), Some("Hi"));
    }

    #[test]
    fn skips_a_kind_it_has_never_heard_of_without_failing() {
        let record = parse(r#"{"v":1,"kind":"reaction","id":"01A","at":1}"#);
        assert_eq!(record.kind, RecordKind::Unknown);
        assert!(!record.is_readable());
    }

    #[test]
    fn refuses_to_interpret_a_record_from_a_future_schema() {
        let record = parse(r#"{"v":99,"kind":"update","id":"01A","at":1,"headline":"Hi"}"#);
        assert!(!record.is_readable());
    }

    #[test]
    fn never_stores_an_avatar_url() {
        let record = parse(
            r#"{"v":1,"kind":"update","id":"01A","at":1,
                "actor":{"login":"mayareed","name":"Maya Reed","avatarUrl":"http://x/y.png"}}"#,
        );
        assert_eq!(record.actor().avatar_url, None);
        assert_eq!(record.actor().login.as_deref(), Some("mayareed"));
    }

    #[test]
    fn falls_back_to_the_login_when_a_record_carries_no_name() {
        let record =
            parse(r#"{"v":1,"kind":"comment","id":"01A","at":1,"actor":{"login":"mayareed"}}"#);
        assert_eq!(record.actor().name, "mayareed");
    }

    fn thread_records() -> Vec<TeamRecord> {
        vec![
            parse(
                r#"{"v":1,"kind":"comment","id":"t1","at":100,"route":"/pricing",
                    "target":"h1 · Simple pricing","pin":1,"branch":"feat/pricing",
                    "body":"Should this say per seat?","actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"reply","id":"r1","thread":"t1","at":200,"body":"Yes.",
                    "actor":{"login":"theo","name":"Theo Vance"}}"#,
            ),
        ]
    }

    #[test]
    fn a_duplicate_comment_file_makes_one_thread_rather_than_two() {
        // Two clones of the same record — a bad merge, or a file copied by
        // hand. The id is the identity, so the second one is not a new thread.
        let record = r#"{"v":1,"kind":"comment","id":"t1","at":100,"route":"/","target":"h1",
                         "body":"once","actor":{"login":"maya","name":"Maya Reed"}}"#;
        let threads = fold_threads(
            &[parse(record), parse(record)],
            "site",
            "/tmp/site",
            &no_avatars,
        );
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 1);
    }

    #[test]
    fn a_resolve_that_names_no_thread_is_skipped_rather_than_applied_to_the_first_one() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"resolve","id":"x1","at":300,"resolved":true,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert!(!threads[0].resolved);
    }

    #[test]
    fn pins_are_numbered_in_creation_order_so_everyone_sees_the_same_numbers() {
        // Both machines wrote a "1" for their own note, which is exactly the
        // collision the fold exists to resolve.
        let records = vec![
            parse(
                r#"{"v":1,"kind":"comment","id":"t1","at":100,"route":"/","target":"h1","pin":1,
                    "body":"mine","actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"comment","id":"t2","at":110,"route":"/","target":"h2","pin":1,
                    "body":"also mine","actor":{"login":"theo","name":"Theo Vance"}}"#,
            ),
        ];
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].pin, 1);
        assert_eq!(threads[1].pin, 2);
    }

    #[test]
    fn retracting_a_note_does_not_renumber_the_ones_after_it() {
        let records = vec![
            parse(
                r#"{"v":1,"kind":"comment","id":"t1","at":100,"route":"/","target":"h1",
                    "body":"first","actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"comment","id":"t2","at":110,"route":"/","target":"h2",
                    "body":"second","actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"comment","id":"t3","at":120,"route":"/","target":"h3",
                    "body":"third","actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"retract","id":"x1","thread":"t2","message":"t2","at":130,
                    "actor":{"login":"maya","name":"Maya Reed"}}"#,
            ),
        ];
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].pin, 1);
        // Still 3, not 2: a number that moves points a reader at the wrong note.
        assert_eq!(threads[1].pin, 3);
    }

    #[test]
    fn an_edit_by_the_author_rewrites_the_message_and_keeps_its_place() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"edit","id":"e1","thread":"t1","message":"t1","at":300,
                "body":"Should this say per seat? The data calls them seats.",
                "actor":{"login":"maya","name":"Maya Reed"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].messages.len(), 2, "an edit is not a new message");
        assert!(threads[0].messages[0]
            .body
            .contains("data calls them seats"));
    }

    #[test]
    fn the_newest_edit_wins_regardless_of_the_order_the_files_arrive_in() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"edit","id":"e2","thread":"t1","message":"t1","at":400,
                "body":"final","actor":{"login":"maya","name":"Maya Reed"}}"#,
        ));
        records.push(parse(
            r#"{"v":1,"kind":"edit","id":"e1","thread":"t1","message":"t1","at":300,
                "body":"earlier","actor":{"login":"maya","name":"Maya Reed"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].messages[0].body, "final");
    }

    #[test]
    fn an_edit_of_someone_elses_message_is_ignored() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"edit","id":"e1","thread":"t1","message":"t1","at":300,
                "body":"words Maya never wrote","actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].messages[0].body, "Should this say per seat?");
    }

    #[test]
    fn retracting_a_reply_removes_it_and_leaves_the_thread_standing() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"retract","id":"x1","thread":"t1","message":"r1","at":300,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 1);
    }

    #[test]
    fn retracting_the_opening_comment_takes_the_whole_thread_with_it() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"retract","id":"x1","thread":"t1","message":"t1","at":300,
                "actor":{"login":"maya","name":"Maya Reed"}}"#,
        ));
        records.push(parse(
            r#"{"v":1,"kind":"retract","id":"x2","thread":"t1","message":"r1","at":301,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        assert!(fold_threads(&records, "site", "/tmp/site", &no_avatars).is_empty());
    }

    #[test]
    fn retracting_someone_elses_message_is_ignored() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"retract","id":"x1","thread":"t1","message":"t1","at":300,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].messages.len(), 2);
    }

    #[test]
    fn a_signed_out_author_can_still_edit_their_own_message() {
        // The solo, no-GitHub case: name is the only identity there is, and
        // without it the person who wrote the note could not touch it.
        let records = vec![
            parse(
                r#"{"v":1,"kind":"comment","id":"t9","at":100,"route":"/","target":"h1",
                    "body":"first","actor":{"name":"Julian"}}"#,
            ),
            parse(
                r#"{"v":1,"kind":"edit","id":"e9","thread":"t9","message":"t9","at":200,
                    "body":"second","actor":{"name":"Julian"}}"#,
            ),
        ];
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads[0].messages[0].body, "second");
    }

    #[test]
    fn folds_a_comment_and_its_reply_into_one_thread() {
        let threads = fold_threads(&thread_records(), "site", "/tmp/site", &no_avatars);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 2);
        assert_eq!(threads[0].route, "/pricing");
        assert!(!threads[0].resolved);
    }

    #[test]
    fn a_later_resolve_record_wins_and_reopening_clears_the_resolver() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"resolve","id":"x1","thread":"t1","at":300,"resolved":true,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        records.push(parse(
            r#"{"v":1,"kind":"resolve","id":"x2","thread":"t1","at":400,"resolved":false,
                "actor":{"login":"maya","name":"Maya Reed"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert!(!threads[0].resolved);
        assert!(threads[0].resolved_by.is_none());
    }

    #[test]
    fn drops_a_reply_whose_thread_has_not_arrived_rather_than_inventing_one() {
        let orphan = vec![parse(
            r#"{"v":1,"kind":"reply","id":"r9","thread":"missing","at":5,"body":"?"}"#,
        )];
        assert!(fold_threads(&orphan, "site", "/tmp/site", &no_avatars).is_empty());
    }

    #[test]
    fn a_reply_read_before_its_comment_still_lands_on_the_thread() {
        // Clock skew between two machines can put a reply in an earlier day
        // directory than the comment it answers. The fold must not care.
        let mut records = thread_records();
        records.swap(0, 1);
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 2);
        // And they still read in the order they were written.
        assert_eq!(threads[0].messages[0].body, "Should this say per seat?");
        assert_eq!(threads[0].messages[1].body, "Yes.");
    }

    #[test]
    fn the_newest_resolve_wins_even_when_it_was_read_first() {
        let mut records = thread_records();
        records.push(parse(
            r#"{"v":1,"kind":"resolve","id":"x2","thread":"t1","at":400,"resolved":false}"#,
        ));
        records.push(parse(
            r#"{"v":1,"kind":"resolve","id":"x1","thread":"t1","at":300,"resolved":true,
                "actor":{"login":"theo","name":"Theo Vance"}}"#,
        ));
        let threads = fold_threads(&records, "site", "/tmp/site", &no_avatars);
        assert!(!threads[0].resolved);
    }

    #[test]
    fn a_missing_directory_reads_as_no_records_not_an_error() {
        let dir = std::env::temp_dir().join(format!("ss-team-none-{}", std::process::id()));
        assert!(read_records(&dir).is_empty());
    }

    #[test]
    fn reads_records_in_lexical_order_which_is_chronological_order() {
        let root = std::env::temp_dir().join(format!("ss-team-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let day = root
            .join(super::super::TEAM_DIR)
            .join(RECORD_DIR)
            .join("2026-09-07");
        std::fs::create_dir_all(&day).expect("mkdir");
        std::fs::write(
            day.join("01B-maya.json"),
            r#"{"v":1,"kind":"comment","id":"01B","at":200,"body":"second"}"#,
        )
        .expect("write");
        std::fs::write(
            day.join("01A-theo.json"),
            r#"{"v":1,"kind":"comment","id":"01A","at":100,"body":"first"}"#,
        )
        .expect("write");
        // Not JSON at all. One bad file must not take the directory with it.
        std::fs::write(day.join("01C-broken.json"), "{ not json").expect("write");

        let records = read_records(&root);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "01A");
        assert_eq!(records[1].id, "01B");
        let _ = std::fs::remove_dir_all(&root);
    }
}
