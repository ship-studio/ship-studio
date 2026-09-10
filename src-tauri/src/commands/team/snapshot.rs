//! `get_team_snapshot` — the one read the whole feature hangs off.
//!
//! Builds the feed out of what the repository already holds: commits and pull
//! requests from [`super::derive`], comment threads from [`super::records`].
//!
//! ## Where a row's prose comes from
//!
//! | Field | From |
//! |-------|------|
//! | `headline` | the commit **subject**, verbatim |
//! | `why` | the commit **body**, verbatim |
//! | everything else | git — commits, files, branch, PR, status, URL |
//!
//! Nothing is rewritten. A subject reading "wip" produces a row reading "wip",
//! which is an honest report of a bad commit message; paraphrasing it with a
//! model would invent the only thing the row cannot know. A commit with no body
//! produces a row with a headline and nothing under it, drawn as the lesser
//! thing it is.
//!
//! That is also what makes this safe. Every *fact* — the files, the line counts,
//! the PR number, the status — is recomputed from git on every read, so no
//! amount of creative prose in a commit message can make a row claim something
//! the repository does not support.

use std::collections::HashMap;

use crate::commands::github::parse_github_repo;
use crate::errors::CommandError;
use crate::utils::validate_project_path;

use super::derive::{self, People, PrSummary, Stint};
use super::records;
use super::{
    TeamActor, TeamMember, TeamSnapshot, TeamSyncStatus, TeamUpdate, TeamUpdateAuthor,
    TeamUpdateStatus,
};

/// How many rows the feed carries. Well past what anyone scrolls; the cap
/// exists so a busy monorepo cannot hand the frontend ten thousand objects.
const MAX_UPDATES: usize = 120;

/// Everything the Team surfaces read, for one project.
///
/// Never fails. No remote, no `gh`, not signed in, no commits, not a git
/// repository at all — every one of them is a state the UI renders honestly, so
/// they come back as a thin snapshot rather than an error dialog.
///
/// A directory that is not a repository is the interesting one, because it is
/// not an error and not a degraded mode: comments are files, so they work there
/// in full. What is missing is only the half derived from history, and the
/// empty states say which half and why. Someone using Harbr alone on a
/// folder is a first-class user of this feature, not a misconfiguration of it.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn get_team_snapshot(project_path: String) -> Result<TeamSnapshot, CommandError> {
    let project = validate_project_path(&project_path)?;
    if !derive::is_repo(&project).await {
        return Ok(threads_only_snapshot(&project, &project_path));
    }

    let project_name = project
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| project_path.clone());
    let project_path_str = project.to_string_lossy().into_owned();

    let repo = repo_slug(&project).await;
    let base = derive::default_base_branch(&project).await;

    // Local first, so a repo with records renders even when the network half
    // times out. Reading files cannot fail in a way worth reporting.
    let stored = records::read_records(&project);

    // Three independent lookups, so they run as three. Sequentially this was
    // a local history walk *plus* a `gh pr list` *plus* three GitHub API calls,
    // one after another, and the workspace header showed nothing at all until
    // the last of them returned.
    let (commits, prs, people) = tokio::join!(
        derive::walk_commits(&project, base.as_deref()),
        derive::pull_requests(&project),
        resolve_people(&project, repo.as_deref()),
    );
    let stints = derive::group_into_stints(commits);

    let mut updates: Vec<TeamUpdate> = Vec::new();
    // What each person is up to, captured here rather than recovered later:
    // this is the one place a row and the git identity behind it are both in
    // hand. Matching them up afterwards means matching on a display name, and
    // display names are not identities.
    let mut doing: HashMap<String, String> = HashMap::new();

    for stint in &stints {
        let update = build_update(
            &project,
            stint,
            prs.get(&stint.branch),
            repo.as_deref(),
            base.as_deref(),
            &people,
            &project_name,
            &project_path_str,
        )
        .await;

        // Only a row that says something. A thin GitHub-only row would repeat
        // the commit subject already shown beside it, which is noise where a
        // sentence should be.
        if update.written_by != TeamUpdateAuthor::App {
            doing
                .entry(member_key(&update.actor, &stint.author_email))
                .or_insert_with(|| update.headline.clone());
        }
        updates.push(update);
    }

    updates.sort_by(|a, b| b.at.cmp(&a.at));
    updates.truncate(MAX_UPDATES);

    let members = build_members(
        &stints,
        &doing,
        &prs,
        &people,
        &project_name,
        base.as_deref(),
    );

    Ok(TeamSnapshot {
        // Comment authors get the same picture their commits do: GitHub's, when
        // GitHub knows them, and their initials on a colour when it does not.
        threads: records::fold_threads(&stored, &project_name, &project_path_str, &|login| {
            people
                .collaborators
                .get(&login.to_lowercase())
                .and_then(|(avatar, _)| avatar.clone())
        }),
        updates,
        members,
        sync: TeamSyncStatus {
            repo,
            last_synced_at: None,
            // Counted from the repository rather than tracked, so a record an
            // agent wrote behind our back is included the moment it exists.
            pending_count: super::transport::pending_count(&project).await,
            error: None,
            syncing: false,
        },
        seen_ids: Vec::new(),
        commit_guidance_installed: super::instructions::is_installed(&project),
    })
}

/// What a folder that is not a repository has: its comments, and nothing
/// invented.
///
/// `repo: None` already means "single-player" everywhere downstream, so this
/// needs no new state — the People and What's new tabs read it and explain
/// themselves rather than spinning on a history that does not exist.
fn threads_only_snapshot(project: &std::path::Path, project_path: &str) -> TeamSnapshot {
    let project_name = project
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| project_path.to_string());
    let stored = records::read_records(project);

    TeamSnapshot {
        // Nobody to ask about avatars without a repository, so initials it is.
        threads: records::fold_threads(&stored, &project_name, project_path, &records::no_avatars),
        updates: Vec::new(),
        members: Vec::new(),
        sync: TeamSyncStatus {
            repo: None,
            last_synced_at: None,
            pending_count: 0,
            error: None,
            syncing: false,
        },
        seen_ids: Vec::new(),
        commit_guidance_installed: super::instructions::is_installed(project),
    }
}

/// Whether the project has an `origin` at all.
///
/// Separate from [`repo_slug`] on purpose: comments sync over any git remote,
/// including one that is not GitHub, so requiring an `owner/repo` here would
/// refuse to carry comments for a self-hosted repository that works fine.
pub async fn has_origin(project: &std::path::Path) -> bool {
    let Ok(mut cmd) = crate::utils::git_command_in(project) else {
        return false;
    };
    cmd.args(["remote", "get-url", "origin"]);
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git remote get-url".to_string(),
        10,
    )
    .await
    .is_ok_and(|out| out.status.success())
}

/// `owner/repo` for the project's origin, or `None`.
async fn repo_slug(project: &std::path::Path) -> Option<String> {
    let mut cmd = crate::utils::git_command_in(project).ok()?;
    cmd.args(["remote", "get-url", "origin"]);
    let output = crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git remote get-url".to_string(),
        10,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_github_repo(String::from_utf8_lossy(&output.stdout).trim())
}

/// Everything GitHub can tell us about who is who on this repo.
///
/// All three lookups degrade to nothing rather than failing: no `gh`, no auth,
/// a repo you can only read. What you lose then is avatars, roles, and the
/// merging of one person's several git emails — never a row, and never a wrong
/// attribution.
async fn resolve_people(project: &std::path::Path, repo: Option<&str>) -> People {
    let me =
        crate::commands::github::get_github_username(Some(project.to_string_lossy().into_owned()))
            .await
            .ok()
            .map(|login| login.to_lowercase());

    let (collaborators, mut identities) = match repo {
        Some(repo) => tokio::join!(
            derive::collaborators(project, repo),
            derive::identity_map(project, repo)
        ),
        None => Default::default(),
    };

    // Your own email → your own login. Needs no network, no `gh` and no repo
    // permissions, which is why it happens whether or not there is a remote:
    // on a local-only repo it is the *only* identity anything can resolve, and
    // without it you are an unlinked name in your own team list. It also
    // survives a public repo whose recent commits GitHub could not place.
    if let (Some(me), Some(email)) = (me.as_deref(), derive::own_git_email(project).await) {
        identities.entry(email).or_insert_with(|| me.to_string());
    }

    People {
        collaborators,
        identities,
        me,
    }
}

/// One row, from a stint of commits and the record explaining it, if any.
#[allow(clippy::too_many_arguments)]
async fn build_update(
    project: &std::path::Path,
    stint: &Stint,
    pr: Option<&PrSummary>,
    repo: Option<&str>,
    base: Option<&str>,
    people: &People,
    project_name: &str,
    project_path: &str,
) -> TeamUpdate {
    let tip = stint.tip();

    let actor = derive::actor_for(&stint.author_name, &stint.author_email, people);

    TeamUpdate {
        // The tip commit is the row's identity: stable across re-reads, unique
        // without coordination, and the same on every machine — which is what
        // makes "new since you last looked" survive a refetch.
        id: format!("commit:{}", tip.sha),
        at: stint.at,
        actor,
        // A row is "written" when somebody wrote a commit body. That is the
        // only signal, and it is the right one: an explanation exists or it
        // does not, and where it came from is the trailer's business.
        written_by: if tip.body.is_some() {
            match stint.made_with {
                Some(_) => TeamUpdateAuthor::Agent,
                None => TeamUpdateAuthor::Person,
            }
        } else {
            TeamUpdateAuthor::App
        },
        agent_name: stint.made_with.clone(),

        // Prose comes from the commit, verbatim. A bad subject stands as
        // written — that is an honest report of a bad commit message, and
        // rewriting it would invent the only thing this row cannot know.
        headline: headline_from_commit(tip),
        why: tip.body.clone(),
        changes: Vec::new(),
        asks: None,

        branch: stint.branch.clone(),
        status: status_for(stint, pr, base),
        project_name: project_name.to_string(),
        project_path: project_path.to_string(),

        commits: stint.evidence(),
        files: derive::files_for(project, stint).await,
        pr_number: pr.map(|pr| pr.number),
        // Deployment truth is per-commit and belongs to the hosting module,
        // which asks a provider. Never inferred here from a red-looking commit.
        build_error: None,
        github_url: derive::github_url_for(repo, pr, &tip.sha),
    }
}

/// A commit subject as a headline.
///
/// Merge subjects are the one rewrite, because "Merge pull request #139 from
/// acme/fix-plan-type" describes the merge rather than the change, and the part
/// after `from` is a branch name the reader has never seen. The PR number is
/// kept — it is the only part that goes anywhere useful.
fn headline_from_commit(commit: &derive::RawCommit) -> String {
    if commit.is_merge {
        if let Some(rest) = commit.subject.strip_prefix("Merge pull request #") {
            let number: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !number.is_empty() {
                return format!("Merged pull request #{number}");
            }
        }
    }
    commit.subject.clone()
}

/// Where a stint's work has got to.
///
/// Order matters: a PR's own state is the strongest evidence available, so it
/// is consulted first. Without one, landing on the base branch means merged and
/// anything else means in progress.
fn status_for(stint: &Stint, pr: Option<&PrSummary>, base: Option<&str>) -> TeamUpdateStatus {
    if let Some(pr) = pr {
        return pr.status();
    }
    if base.is_some_and(|base| base == stint.branch) {
        return TeamUpdateStatus::Merged;
    }
    TeamUpdateStatus::Working
}

/// How one person is identified across the snapshot.
///
/// A GitHub login where one is known, the commit email otherwise. Two git
/// identities that resolve to the same login are one person; two that do not
/// are two people. Never the display name — merging on a name is how a
/// namesake's work ends up under your face, and it is not reversible once the
/// feed has shown it.
fn member_key(actor: &TeamActor, email: &str) -> String {
    actor
        .login
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_else(|| email.to_lowercase())
}

/// Who is on this project, and what they are demonstrably doing.
#[allow(clippy::too_many_arguments)]
fn build_members(
    stints: &[Stint],
    doing: &HashMap<String, String>,
    prs: &HashMap<String, PrSummary>,
    people: &People,
    project_name: &str,
    base: Option<&str>,
) -> Vec<TeamMember> {
    let mut order: Vec<String> = Vec::new();
    let mut members: HashMap<String, TeamMember> = HashMap::new();

    for stint in stints {
        let actor = derive::actor_for(&stint.author_name, &stint.author_email, people);
        let key = member_key(&actor, &stint.author_email);

        let entry = members.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            let login = actor.login.as_deref().map(str::to_lowercase);
            TeamMember {
                role: login
                    .as_ref()
                    .and_then(|login| people.collaborators.get(login))
                    .and_then(|(_, role)| *role),
                // Filled in below, once every commit of theirs has been seen.
                explains_work: false,
                is_self: match (login.as_deref(), people.me.as_deref()) {
                    (Some(login), Some(me)) => login == me,
                    _ => false,
                },
                doing: doing.get(&key).cloned(),
                actor,
                branch: None,
                project_name: Some(project_name.to_string()),
                last_pushed_at: None,
                commits_ahead: 0,
                pr_number: None,
            }
        });

        // One commit that explains itself is enough to say this person writes
        // them. The note this feeds is a nudge, not an audit, and holding
        // somebody to *every* commit having a body would flag everyone forever.
        if stint.commits.iter().any(|commit| commit.body.is_some()) {
            entry.explains_work = true;
        }

        // Stints arrive newest-first, so the first one seen for a person is
        // their most recent — that is the branch and time worth showing.
        if entry.last_pushed_at.is_none() {
            entry.last_pushed_at = Some(stint.at);
            entry.branch = Some(stint.branch.clone());
            entry.pr_number = prs.get(&stint.branch).map(|pr| pr.number);
        }
        // "Ahead" is work not yet on the base branch. Commits already on it are
        // not ahead of anything, so they do not count.
        if base.is_some_and(|base| base != stint.branch) {
            entry.commits_ahead += stint.commits.len() as u32;
        }
    }

    let mut list: Vec<TeamMember> = order
        .into_iter()
        .filter_map(|key| members.remove(&key))
        .collect();
    list.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then(b.last_pushed_at.cmp(&a.last_pushed_at))
    });
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::team::derive::RawCommit;

    fn commit(subject: &str, merge: bool) -> RawCommit {
        RawCommit {
            sha: "abcdef1234".to_string(),
            short_sha: "abcdef1".to_string(),
            subject: subject.to_string(),
            body: None,
            at: 1_000_000,
            author_name: "Theo Vance".to_string(),
            author_email: "theo@x.com".to_string(),
            branch: "main".to_string(),
            made_with: None,
            is_merge: merge,
            files: Vec::new(),
        }
    }

    fn stint(branch: &str, commits: Vec<RawCommit>) -> Stint {
        Stint {
            at: commits[0].at,
            author_name: commits[0].author_name.clone(),
            author_email: commits[0].author_email.clone(),
            made_with: commits.iter().find_map(|c| c.made_with.clone()),
            branch: branch.to_string(),
            commits,
        }
    }

    fn open_pr(number: i64) -> PrSummary {
        PrSummary {
            number,
            state: "OPEN".to_string(),
            url: String::new(),
            review_requested: false,
            has_reviews: false,
        }
    }

    #[test]
    fn keeps_an_ordinary_commit_subject_exactly_as_written() {
        assert_eq!(headline_from_commit(&commit("wip", false)), "wip");
    }

    #[test]
    fn rewrites_only_the_merge_subject_and_keeps_the_pr_number() {
        assert_eq!(
            headline_from_commit(&commit(
                "Merge pull request #139 from acme/fix-plan-type",
                true
            )),
            "Merged pull request #139"
        );
    }

    #[test]
    fn leaves_a_hand_written_merge_subject_alone() {
        assert_eq!(
            headline_from_commit(&commit("Merge Martin's breadcrumb work", true)),
            "Merge Martin's breadcrumb work"
        );
    }

    #[test]
    fn work_on_the_base_branch_reads_as_merged() {
        let s = stint("main", vec![commit("x", false)]);
        assert_eq!(status_for(&s, None, Some("main")), TeamUpdateStatus::Merged);
    }

    #[test]
    fn work_on_a_topic_branch_with_no_pr_is_in_progress() {
        let s = stint("feat/pricing", vec![commit("x", false)]);
        assert_eq!(
            status_for(&s, None, Some("main")),
            TeamUpdateStatus::Working
        );
    }

    #[test]
    fn a_pr_outranks_the_branch_it_is_on() {
        let s = stint("main", vec![commit("x", false)]);
        assert_eq!(
            status_for(&s, Some(&open_pr(7)), Some("main")),
            TeamUpdateStatus::NeedsReview
        );
    }

    /// `build_members` with everything GitHub would have supplied left empty —
    /// the shape of a repo with no remote, or no `gh`, or no auth.
    fn members_of(stints: &[Stint], doing: &HashMap<String, String>) -> Vec<TeamMember> {
        build_members(
            stints,
            doing,
            &HashMap::new(),
            &People::default(),
            "site",
            Some("main"),
        )
    }

    #[test]
    fn counts_ahead_only_for_work_that_has_not_landed() {
        let stints = vec![
            stint("feat/pricing", vec![commit("a", false), commit("b", false)]),
            stint("main", vec![commit("c", false)]),
        ];
        let members = members_of(&stints, &HashMap::new());
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].commits_ahead, 2);
        // Their newest stint is the one shown.
        assert_eq!(members[0].branch.as_deref(), Some("feat/pricing"));
    }

    #[test]
    fn a_member_with_no_github_login_gets_no_role_rather_than_a_plausible_one() {
        let stints = vec![stint("feat/x", vec![commit("a", false)])];
        let members = members_of(&stints, &HashMap::new());
        assert_eq!(members[0].role, None);
        assert!(!members[0].explains_work);
    }

    #[test]
    fn identifies_a_person_by_login_or_email_but_never_by_display_name() {
        let known = TeamActor {
            login: Some("MayaReed".to_string()),
            name: "Maya Reed".to_string(),
            avatar_url: None,
        };
        assert_eq!(member_key(&known, "maya@x.com"), "mayareed");

        let anonymous = TeamActor {
            login: None,
            name: "Maya Reed".to_string(),
            avatar_url: None,
        };
        assert_eq!(member_key(&anonymous, "Maya@X.com"), "maya@x.com");
    }

    #[test]
    fn explains_work_follows_the_commits_rather_than_which_tool_was_used() {
        // The correction this replaced: the flag used to mean "has written a
        // Harbr record", which called a teammate on plain git uncovered
        // for using a different editor. What the feed needs to know is whether
        // their commits say why — and that is in the commits.
        let mut explained = commit("a", false);
        explained.author_email = "9+theo@users.noreply.github.com".to_string();
        explained.body = Some("The flex row could not hold three columns.".to_string());

        let people = People {
            me: Some("theo".to_string()),
            ..Default::default()
        };
        let members = build_members(
            &vec![stint("feat/x", vec![explained])],
            &HashMap::new(),
            &HashMap::new(),
            &people,
            "site",
            Some("main"),
        );
        assert!(members[0].explains_work);
        assert!(members[0].is_self);
    }

    #[test]
    fn a_person_whose_commits_have_no_body_is_the_one_the_note_is_about() {
        let members = build_members(
            &vec![stint("feat/x", vec![commit("wip", false)])],
            &HashMap::new(),
            &HashMap::new(),
            &People::default(),
            "site",
            Some("main"),
        );
        assert!(!members[0].explains_work);
    }

    #[test]
    fn one_explained_commit_is_enough_to_stop_nagging_someone() {
        // A nudge, not an audit. Holding somebody to *every* commit having a
        // body would flag the whole team forever.
        let mut explained = commit("a", false);
        explained.body = Some("because the tiers wrapped".to_string());
        let members = build_members(
            &vec![
                stint("feat/x", vec![commit("wip", false)]),
                stint("feat/x", vec![explained]),
            ],
            &HashMap::new(),
            &HashMap::new(),
            &People::default(),
            "site",
            Some("main"),
        );
        assert!(members[0].explains_work);
    }

    #[test]
    fn doing_reaches_the_member_it_belongs_to() {
        let stints = vec![stint("feat/x", vec![commit("a", false)])];
        // Keyed the way the caller keys it: no login on this commit, so the
        // email is the identity.
        let doing = HashMap::from([(
            "theo@x.com".to_string(),
            "Rebuilt the pricing tiers as a grid".to_string(),
        )]);
        let members = members_of(&stints, &doing);
        assert_eq!(
            members[0].doing.as_deref(),
            Some("Rebuilt the pricing tiers as a grid")
        );
    }

    #[test]
    fn a_person_with_only_bare_commits_is_doing_nothing_we_can_name() {
        let stints = vec![stint("feat/x", vec![commit("wip", false)])];
        assert_eq!(members_of(&stints, &HashMap::new())[0].doing, None);
    }
}
