//! # Team (multiplayer)
//!
//! Multiplayer with no server, no database and no accounts. A team's shared
//! state is files in their own git repository, and the network is `git fetch` /
//! `git push`. `docs/team-multiplayer.md` is the design; this module is the
//! half of it that runs.
//!
//! ## Two halves, and they need different things
//!
//! | Half | Source | Needs |
//! |------|--------|-------|
//! | **What people did** ([`derive`]) | `git log`, `gh pr list` | a good commit message |
//! | **Comments** ([`records`], [`threads`]) | `.shipstudio-team/threads/**` | Harbr |
//!
//! The first half reads git's own fields. A commit subject is the headline and
//! **the commit body is the why** — which is where "why" has always belonged,
//! and which `git log`, GitHub and code review already display. An earlier
//! version of this module wrote a second copy of that prose into a record file
//! joined back to its commit by a trailer: a format only this app could read,
//! describing something git already knew, and giving every writer two chances
//! to get one sentence recorded. What survived was the worst case — a silently
//! empty row whenever the second chance was missed.
//!
//! So the job is not to collect explanations somewhere else. It is to make
//! writing a legible commit the default: [`push`] asks the agent for one and
//! puts it in the message, [`skill`] and [`instructions`] teach an agent to
//! write one unprompted, and the feed makes the difference visible. Everything
//! that produces is a better `git log` for people who have never opened this
//! app, which is the test of whether it was worth doing.
//!
//! **A commit with no body is never dressed up.** It produces a row saying only
//! what git can prove, drawn as the lesser thing it is. Guessing a `why` back
//! out of a diff would invent the one thing the row cannot know.
//!
//! ## Comments are the part that needs a format
//!
//! A note pinned to an element, on a page, at a viewport has no equivalent in
//! git or GitHub, so that structure is ours: one write-once record per file,
//! folded at read time, carried on a ref of its own by [`transport`].
//!
//! ## Reading is lenient, writing is strict
//!
//! These files arrive over git from other people's machines running other
//! people's versions. So on the way **in**, an unknown field is ignored and an
//! unknown record kind is skipped — one teammate upgrading must never blank the
//! feed for everyone who hasn't. On the way **out** the same shape is checked
//! with hard caps, because that is the moment an agent could put something in
//! the repository permanently.

pub(crate) mod bridge;
mod derive;
pub(crate) mod instructions;
mod push;
pub(crate) mod records;
pub(crate) mod skill;
mod snapshot;
mod summarise;
pub(crate) mod threads;
mod trailers;
pub(crate) mod transport;
#[cfg(test)]
mod transport_tests;
pub(crate) mod writer;

pub use push::{prepare as prepare_push, sharing_enabled, PushContent};
pub use snapshot::*;
pub use summarise::summarise_working_tree;
pub use trailers::*;
pub use writer::TeamSummary;

use serde::{Deserialize, Serialize};

/// Where this project's team data lives.
///
/// Not under `.shipstudio/` — `ensure_gitignore_has_shipstudio` gitignores that
/// whole directory, so anything written there would never be committed and no
/// teammate would ever see it.
pub const TEAM_DIR: &str = ".shipstudio-team";

/// Who did the thing. Resolved from git and GitHub — never typed by a user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamActor {
    /// GitHub login. The only globally unique handle available without a
    /// server, and the join key against repo collaborators.
    pub login: Option<String>,
    pub name: String,
    /// From the GitHub API only. `None` renders initials, never a guessed
    /// gravatar URL.
    pub avatar_url: Option<String>,
}

/// Which of the three writers produced a row. Drives how much it may claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TeamUpdateAuthor {
    /// The agent that did the work, through a schema-checked tool.
    Agent,
    /// Someone typed it.
    Person,
    /// Harbr saw a commit with no record attached and said only that.
    App,
}

/// Where a piece of work has got to.
///
/// Every variant is *observable*: a branch exists, a PR is open, a deployment
/// matched the SHA. Nothing here is self-declared progress, which is why an
/// agent is not allowed to write this field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TeamUpdateStatus {
    Working,
    NeedsReview,
    InReview,
    Merged,
    Deployed,
    Broken,
}

/// A file the update touched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamFileTouch {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

/// A commit backing an update. Evidence, not content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamCommit {
    pub sha: String,
    pub message: String,
}

/// One thing someone did — the unit the whole feature is built on.
///
/// Mirrors `TeamUpdate` in `src/lib/team.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamUpdate {
    /// The record's ULID, or `commit:<sha>` for a derived row.
    pub id: String,
    /// Unix **milliseconds**, from the author's clock. There is no server clock
    /// to correct against; the UI shows relative times grouped by day, which
    /// keeps clock skew below the resolution anyone reads.
    pub at: i64,
    pub actor: TeamActor,
    pub written_by: TeamUpdateAuthor,
    pub agent_name: Option<String>,

    pub headline: String,
    pub why: Option<String>,
    pub changes: Vec<String>,
    pub asks: Option<String>,

    pub branch: String,
    pub status: TeamUpdateStatus,
    pub project_name: String,
    pub project_path: String,

    pub commits: Vec<TeamCommit>,
    pub files: Vec<TeamFileTouch>,
    pub pr_number: Option<i64>,
    pub build_error: Option<String>,
    pub github_url: Option<String>,
}

/// Repo role, from the GitHub collaborators API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamRole {
    Admin,
    Maintainer,
    Write,
    Read,
}

/// A teammate and what they are demonstrably working on.
///
/// Deliberately not presence. Nobody is "online" — there is no server to say
/// so. What a remote genuinely knows is that this person has a branch, it moved
/// at this time, and it is this far ahead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub actor: TeamActor,
    /// `None` when the collaborators API is unavailable — the common case with
    /// read-only access. The UI omits the label rather than inventing a
    /// plausible role.
    pub role: Option<TeamRole>,
    pub branch: Option<String>,
    pub project_name: Option<String>,
    pub last_pushed_at: Option<i64>,
    pub commits_ahead: u32,
    pub pr_number: Option<i64>,
    /// One line on what they are up to, from their most recent update.
    pub doing: Option<String>,
    /// Whether their recent commits carry a body — the "why" a row shows.
    ///
    /// Derived from the commits themselves, never from which tool they use. A
    /// teammate on plain `git` who writes a real commit message produces a row
    /// exactly as good as one written here. The earlier version of this field
    /// asked "has this person written a Harbr record", which called them
    /// uncovered for using a different editor — a question about our adoption
    /// wearing the costume of a question about their work.
    pub explains_work: bool,
    pub is_self: bool,
}

/// A comment thread, folded from its comment records.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamThread {
    pub id: String,
    pub project_name: String,
    pub project_path: String,
    pub branch: String,
    pub route: String,
    pub target: String,
    pub pin: u32,
    /// What the preview needs to draw the pin on the element again. `None` on a
    /// thread written before anchors existed, or by a build that has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<threads::ThreadAnchor>,
    pub resolved: bool,
    pub resolved_by: Option<TeamActor>,
    pub messages: Vec<TeamMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub id: String,
    pub actor: TeamActor,
    pub at: i64,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
}

/// How this project's team data is reaching everyone else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncStatus {
    /// `owner/repo`, or `None` when the project has no GitHub remote. Not an
    /// error state — a project with no remote is simply single-player.
    pub repo: Option<String>,
    pub last_synced_at: Option<i64>,
    pub pending_count: u32,
    /// Last sync failure, verbatim. Shown, never swallowed.
    pub error: Option<String>,
    pub syncing: bool,
}

/// Everything the Team surfaces read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSnapshot {
    pub updates: Vec<TeamUpdate>,
    pub members: Vec<TeamMember>,
    pub threads: Vec<TeamThread>,
    pub sync: TeamSyncStatus,
    pub seen_ids: Vec<String>,
    /// Whether this project's `CLAUDE.md`/`AGENTS.md` already carries the
    /// commit-message block ([`instructions`]).
    ///
    /// On the snapshot rather than behind a command of its own because the one
    /// surface that asks is already rendering from it, and a second round trip
    /// to read one file the same tick would be a second chance to disagree
    /// with itself.
    pub commit_guidance_installed: bool,
}
