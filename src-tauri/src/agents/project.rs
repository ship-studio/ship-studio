//! An agent bound to one Ship Studio project.
//!
//! A bound agent's turns run with the project as the working directory, so
//! Claude Code loads the project's own CLAUDE.md, `.claude/` settings and
//! `.mcp.json`. Its home stays where its identity lives: `--add-dir` lets it
//! edit its own CLAUDE.md, and the file's contents ride in the appended system
//! prompt. (Verified against Claude Code 2.1.318: a CLAUDE.md in an
//! `--add-dir` folder is *not* loaded unless
//! `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set, and that loads the
//! CLAUDE.md of *every* added folder, which would hand a bound agent every
//! other project's rules. `--resume` works across a cwd change, so binding an
//! existing agent keeps its conversation.)
//!
//! After a turn, what changed in the project is read from git alone: the
//! working tree is snapshotted as a tree object before and after (through a
//! throwaway index, so the user's own index is never touched) and the two are
//! diffed. Edits that were already there when the turn began are not counted.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::store::Agent;
use crate::errors::CommandError;

/// Where a turn runs and which other folders it may work in without asking.
#[derive(Debug, PartialEq)]
pub struct Layout {
    pub cwd: PathBuf,
    pub add_dirs: Vec<String>,
    /// Set for a bound agent: its project, the turn's working directory.
    pub project: Option<PathBuf>,
}

/// An unbound agent runs in its home with every project added, exactly as
/// before binding existed. A bound one runs in its project, with its home
/// added first (so it can keep its memory) and the other folders after.
pub fn layout(agent: &Agent, home: &Path, work_dirs: Vec<String>) -> Layout {
    match &agent.project {
        None => Layout {
            cwd: home.to_path_buf(),
            add_dirs: work_dirs,
            project: None,
        },
        Some(project) => {
            let mut add_dirs = vec![home.to_string_lossy().to_string()];
            add_dirs.extend(work_dirs.into_iter().filter(|d| d != project));
            Layout {
                cwd: PathBuf::from(project),
                add_dirs,
                project: Some(PathBuf::from(project)),
            }
        }
    }
}

/// A project as `list_projects` names it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRef {
    pub name: String,
    pub path: String,
}

/// The project a name or path refers to: an exact path first, then a name
/// ignoring case. Never a guess: no match is `None`.
pub fn pick(projects: &[ProjectRef], query: &str) -> Option<ProjectRef> {
    let query = query.trim().trim_end_matches('/');
    projects
        .iter()
        .find(|p| p.path.trim_end_matches('/') == query)
        .or_else(|| projects.iter().find(|p| p.name.eq_ignore_ascii_case(query)))
        .cloned()
}

/// Resolve what the Chief or the editor asked for. Empty or "none" clears
/// the binding (`Ok(None)`); anything else must be one of the user's projects.
pub async fn resolve(query: &str) -> Result<Option<ProjectRef>, CommandError> {
    let query = query.trim();
    if query.is_empty() || query.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    let projects: Vec<ProjectRef> = crate::commands::projects::list_projects()
        .await?
        .into_iter()
        .map(|p| ProjectRef {
            name: p.name,
            path: p.path,
        })
        .collect();
    pick(&projects, query).map(Some).ok_or_else(|| {
        super::err_invalid(
            "project",
            format!("There's no Ship Studio project called {query}. project_list shows them."),
        )
    })
}

/// The last folder of a path, for lines that name a project by its path.
pub fn folder_name(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/* ------------------------------------------------------------- changes */

/// The card recorded after a turn that changed files in the project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub project: String,
    /// The branch checked out when the turn ended; absent when detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Tree snapshots before and after: what "View diff" diffs.
    pub from: String,
    pub to: String,
    /// At most [`MAX_FILES`], in git's order.
    pub files: Vec<ChangedFile>,
    /// Every file that changed, including any not listed.
    pub file_count: u32,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `added`, `modified` or `deleted` (the diff UI's own words).
    pub status: String,
    /// Line counts; absent for a binary file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

pub const MAX_FILES: usize = 50;

fn git(dir: &Path) -> Option<Command> {
    let mut cmd = crate::utils::git_command_in(dir).ok()?;
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    Some(cmd)
}

/// Local git only, but `add -A` on a big tree can take a while; never forever.
const GIT_TIMEOUT_SECS: u64 = 60;

async fn output(cmd: Command) -> Result<std::process::Output, CommandError> {
    crate::external_command::run_with_timeout(
        tokio::process::Command::from(cmd),
        "git (agent changes)",
        GIT_TIMEOUT_SECS,
    )
    .await
}

async fn run(cmd: Command) -> Option<String> {
    let out = output(cmd).await.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// The whole working tree (tracked and untracked, minus ignored files) as a
/// tree object id. `None` when the project isn't a git repository.
pub async fn snapshot(project: &Path) -> Option<String> {
    let index = run({
        let mut c = git(project)?;
        c.args(["rev-parse", "--git-path", "index"]);
        c
    })
    .await?;
    let index = project.join(index.trim());
    let scratch =
        std::env::temp_dir().join(format!("shipstudio-agent-index-{}", super::store::new_id()));
    // Starting from a copy of the real index keeps `add -A` fast (git trusts
    // its stat cache) without touching what the user has staged.
    if index.exists() {
        std::fs::copy(&index, &scratch).ok()?;
    }
    let with_index = |args: &[&str]| {
        let c = git(project).map(|mut c| {
            c.env("GIT_INDEX_FILE", &scratch).args(args);
            c
        });
        async move { run(c?).await }
    };
    let tree = match with_index(&["add", "-A", "."]).await {
        Some(_) => with_index(&["write-tree"]).await,
        None => None,
    };
    let _ = std::fs::remove_file(&scratch);
    tree.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// What changed between the snapshot taken when the turn began and now.
/// `None` when nothing did, or git couldn't say.
pub async fn summary(project: &Path, from: &str) -> Option<ChangeSummary> {
    let to = snapshot(project).await?;
    if to == from {
        return None;
    }
    let diff = |stat: &str| {
        let c = git(project).map(|mut c| {
            c.args([
                "diff",
                "--no-renames",
                "--relative",
                "-z",
                stat,
                from,
                to.as_str(),
            ]);
            c
        });
        async move { run(c?).await }
    };
    let files = parse(&diff("--numstat").await?, &diff("--name-status").await?);
    if files.is_empty() {
        return None;
    }
    let branch = run({
        let mut c = git(project)?;
        c.args(["symbolic-ref", "--short", "-q", "HEAD"]);
        c
    })
    .await
    .map(|b| b.trim().to_string())
    .filter(|b| !b.is_empty());
    let added = files.iter().filter_map(|f| f.added).sum();
    let removed = files.iter().filter_map(|f| f.removed).sum();
    let file_count = files.len() as u32;
    Some(ChangeSummary {
        project: project.to_string_lossy().to_string(),
        branch,
        from: from.to_string(),
        to,
        files: files.into_iter().take(MAX_FILES).collect(),
        file_count,
        added,
        removed,
    })
}

/// `git diff -z --numstat` and `--name-status` output, joined by path.
pub fn parse(numstat: &str, name_status: &str) -> Vec<ChangedFile> {
    let mut statuses = std::collections::HashMap::new();
    let mut fields = name_status.split('\0').filter(|f| !f.is_empty());
    while let (Some(code), Some(path)) = (fields.next(), fields.next()) {
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            _ => "modified",
        };
        statuses.insert(path.to_string(), status);
    }
    numstat
        .split('\0')
        .filter_map(|record| {
            let mut parts = record.splitn(3, '\t');
            let (added, removed, path) = (parts.next()?, parts.next()?, parts.next()?);
            let path = path.trim_start_matches('\n');
            if path.is_empty() {
                return None;
            }
            Some(ChangedFile {
                path: path.to_string(),
                status: statuses
                    .get(path)
                    .copied()
                    .unwrap_or("modified")
                    .to_string(),
                added: added.trim().parse().ok(),
                removed: removed.trim().parse().ok(),
            })
        })
        .collect()
}

/// One file's diff between two snapshots, in the shape the app's diff modal reads.
pub async fn file_diff(
    project: &Path,
    from: &str,
    to: &str,
    path: &str,
) -> Result<crate::types::FileDiff, CommandError> {
    let mut cmd = git(project).ok_or_else(|| super::err_other("git isn't available"))?;
    cmd.args(["diff", "--no-renames", "--relative", from, to, "--", path]);
    let out = output(cmd).await?;
    if !out.status.success() {
        return Err(CommandError::expected(
            "That change can't be shown any more: git has cleaned up the snapshot it was taken from.",
        ));
    }
    let content = String::from_utf8_lossy(&out.stdout).to_string();
    let count = |sign: char, header: &str| {
        content
            .lines()
            .filter(|l| l.starts_with(sign) && !l.starts_with(header))
            .count() as u32
    };
    Ok(crate::types::FileDiff {
        file_path: path.to_string(),
        is_new_file: false,
        is_deleted: content.contains("deleted file mode"),
        is_binary: content.contains("Binary files"),
        additions: count('+', "+++"),
        deletions: count('-', "---"),
        content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(project: Option<&str>) -> Agent {
        let mut agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Acme Site", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        agent.project = project.map(str::to_string);
        agent
    }

    #[test]
    fn an_unbound_agent_runs_in_its_home_as_before() {
        let dirs = vec!["/u/ShipStudio".to_string(), "/ext/site".to_string()];
        let home = Path::new("/u/ShipStudio/.shipstudio/agents/a");
        assert_eq!(
            layout(&agent(None), home, dirs.clone()),
            Layout {
                cwd: home.to_path_buf(),
                add_dirs: dirs,
                project: None
            }
        );
    }

    #[test]
    fn a_bound_agent_runs_in_its_project_with_its_home_added() {
        let dirs = vec!["/u/ShipStudio".to_string(), "/ext/site".to_string()];
        let home = Path::new("/u/ShipStudio/.shipstudio/agents/a");
        let bound = layout(&agent(Some("/ext/site")), home, dirs);
        assert_eq!(bound.cwd, PathBuf::from("/ext/site"));
        assert_eq!(bound.project, Some(PathBuf::from("/ext/site")));
        // Home first, the project itself not repeated.
        assert_eq!(
            bound.add_dirs,
            vec![home.to_string_lossy().to_string(), "/u/ShipStudio".into()]
        );
    }

    #[test]
    fn projects_are_picked_by_path_or_name_never_guessed() {
        let projects = vec![
            ProjectRef {
                name: "acme".into(),
                path: "/u/ShipStudio/acme".into(),
            },
            ProjectRef {
                name: "blog".into(),
                path: "/ext/blog".into(),
            },
        ];
        assert_eq!(pick(&projects, "/ext/blog/").unwrap().name, "blog");
        assert_eq!(pick(&projects, "ACME").unwrap().path, "/u/ShipStudio/acme");
        assert!(pick(&projects, "acm").is_none());
        assert!(pick(&projects, "/ext").is_none());
        assert_eq!(folder_name("/u/ShipStudio/acme/"), "acme");
    }

    #[test]
    fn parses_numstat_and_status_by_path() {
        let numstat = "3\t1\tsrc/a b.ts\0-\t-\tlogo.png\0010\t0\tnew.md\0";
        let names = "M\0src/a b.ts\0A\0logo.png\0A\0new.md\0";
        let files = parse(numstat, names);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/a b.ts");
        assert_eq!((files[0].added, files[0].removed), (Some(3), Some(1)));
        assert_eq!(files[1].status, "added");
        assert_eq!((files[1].added, files[1].removed), (None, None));
        assert_eq!(files[2].added, Some(10));
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[tokio::test]
    async fn summarises_only_what_changed_during_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        sh(repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("keep.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "x\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        sh(repo, &["add", "-A"]);
        sh(repo, &["commit", "-qm", "init"]);
        // Already dirty before the turn: not the agent's doing.
        std::fs::write(repo.join("mine.txt"), "the user's\n").unwrap();
        sh(repo, &["add", "mine.txt"]);
        let staged_before = std::fs::read(repo.join(".git/index")).unwrap();

        let start = snapshot(repo).await.unwrap();
        assert!(summary(repo, &start).await.is_none(), "nothing changed yet");

        // The turn: an edit, a new file, a deletion, an ignored file, a commit.
        std::fs::write(repo.join("keep.txt"), "a\nB\nc\nd\n").unwrap();
        std::fs::write(repo.join("new.ts"), "one\ntwo\n").unwrap();
        std::fs::remove_file(repo.join("gone.txt")).unwrap();
        std::fs::create_dir(repo.join("node_modules")).unwrap();
        std::fs::write(repo.join("node_modules/x.js"), "x\n").unwrap();
        // The user's index is exactly as they left it.
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            staged_before
        );

        let s = summary(repo, &start).await.unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        let by = |p: &str| s.files.iter().find(|f| f.path == p).cloned();
        assert_eq!(s.file_count, 3);
        assert!(by("mine.txt").is_none() && by("node_modules/x.js").is_none());
        let keep = by("keep.txt").unwrap();
        assert_eq!(
            (keep.status.as_str(), keep.added, keep.removed),
            ("modified", Some(2), Some(1))
        );
        assert_eq!(by("new.ts").unwrap().status, "added");
        assert_eq!(by("gone.txt").unwrap().status, "deleted");
        assert_eq!((s.added, s.removed), (4, 2));

        // Committing mid-turn doesn't hide the work: snapshots, not HEAD.
        sh(repo, &["add", "-A"]);
        sh(repo, &["commit", "-qm", "agent"]);
        assert_eq!(summary(repo, &start).await.unwrap().file_count, 3);

        let diff = file_diff(repo, &s.from, &s.to, "keep.txt").await.unwrap();
        assert_eq!((diff.additions, diff.deletions), (2, 1));
        assert!(diff.content.contains("+B"));
    }

    #[tokio::test]
    async fn a_folder_without_git_has_no_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        assert!(snapshot(dir.path()).await.is_none());
    }
}
