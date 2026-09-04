//! Workflow files: `<project>/.shipstudio/workflows/<slug>.md`.
//!
//! The format is markdown with a small YAML-ish frontmatter block. It is
//! deliberately *not* real YAML: the parser accepts a flat list of
//! `key: value` lines and nothing else. That keeps the surface small enough
//! that an agent writing one of these by hand cannot get it subtly wrong (no
//! block scalars, no nesting, no quoting rules to trip over), and it keeps the
//! dependency list unchanged.
//!
//! Unknown keys are preserved on read and written back on save, so a future
//! Ship Studio version adding a key doesn't have its value silently dropped by
//! an older one round-tripping the file.

use super::{Severity, WorkflowPermission, WorkflowTrigger};
use crate::errors::CommandError;
use crate::utils::{classify_fs_error, validate_project_path};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A standing instruction, as the frontend sees it.
///
/// Mirrors `Workflow` in `src/lib/workflows.ts`. `runs` and `nextRunAt` are not
/// stored in the file — they come from the state store and the scheduler — so
/// they are filled in by [`super::state`] rather than here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    /// Stable identity: `<projectPath>::<slug>`. Unique across projects, which
    /// the home-level list needs since two projects may both have `security.md`.
    pub id: String,
    pub slug: String,
    pub name: String,
    /// A single emoji standing in for the workflow, Notion-style. None means the
    /// row falls back to a status dot.
    pub icon: Option<String>,
    pub description: String,
    pub agent_id: Option<String>,
    pub project_path: String,
    pub project_name: String,
    pub trigger: WorkflowTrigger,
    pub permission: WorkflowPermission,
    pub prompt: String,
    pub severity_floor: Severity,
    pub auto_run: bool,
    pub file_path: String,
    /// Keys the parser didn't recognise, kept so a round-trip is lossless.
    #[serde(skip)]
    pub extra: BTreeMap<String, String>,
}

/// Everything a caller may change about a workflow. Split from [`Workflow`] so
/// the identity fields (`id`, `slug`, `projectPath`) can't be edited by a save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDraft {
    pub name: String,
    pub icon: Option<String>,
    pub description: String,
    pub agent_id: Option<String>,
    pub trigger: WorkflowTrigger,
    pub permission: WorkflowPermission,
    pub prompt: String,
    pub severity_floor: Severity,
    pub auto_run: bool,
}

/// `Security sweep!` -> `security-sweep`.
pub fn slugify(raw: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // leading dashes are dropped
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "untitled-workflow".to_string()
    } else {
        // Long slugs make unwieldy filenames without adding identity.
        out.chars().take(64).collect()
    }
}

/// Keep only a short, single-glyph icon.
///
/// The value reaches the UI as a text node, so the risk isn't injection so much
/// as layout: an agent that writes `icon: a long sentence` would blow out every
/// row. One grapheme cluster's worth of chars is the contract, and anything
/// longer is dropped rather than truncated into a mystery fragment.
fn sanitize_icon(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A single emoji can be several chars (ZWJ sequences, skin tones, flags).
    // Eight is comfortably above the longest common cluster and well below
    // anything that would disturb the row.
    if trimmed.chars().count() > 8 || trimmed.chars().any(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(trimmed.to_string())
}

/// `<project>/.shipstudio/workflows`.
pub fn workflows_dir(project: &Path) -> PathBuf {
    project.join(".shipstudio").join("workflows")
}

fn project_name_of(project: &Path) -> String {
    project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| project.to_string_lossy().to_string())
}

/// Split `---\nkey: value\n---\nbody` into its frontmatter lines and body.
///
/// A file with no frontmatter is treated as all body: the workflow still works,
/// it just gets defaults. Being lenient here matters because the agent-authored
/// path (see [`super::skill`]) is the common one and a rejected file is a
/// silent dead end for the user.
fn split_frontmatter(contents: &str) -> (BTreeMap<String, String>, String) {
    let normalized = contents.replace("\r\n", "\n");
    let mut map = BTreeMap::new();
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return (map, normalized.trim().to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (map, normalized.trim().to_string());
    };
    let (front, body) = rest.split_at(end);
    for line in front.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value
                .trim()
                .trim_matches(['"', '\''].as_slice())
                .to_string();
            map.insert(key.trim().to_ascii_lowercase(), value);
        }
    }
    let body = body
        .trim_start_matches("\n---")
        .trim_start_matches('\n')
        .trim()
        .to_string();
    (map, body)
}

const KNOWN_KEYS: &[&str] = &[
    "name",
    "icon",
    "description",
    "agent",
    "trigger",
    "permission",
    "severity-floor",
    "auto-run",
];

fn parse_bool(raw: Option<&String>, default: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) => matches!(v.as_str(), "true" | "yes" | "on" | "1"),
        None => default,
    }
}

/// Parse one workflow file. Never fails on content — only the caller's I/O can.
pub fn parse_workflow(project: &Path, file_path: &Path, contents: &str) -> Workflow {
    let (front, body) = split_frontmatter(contents);
    let slug = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled-workflow".to_string());
    let project_path = project.to_string_lossy().to_string();

    let name = front
        .get("name")
        .filter(|n| !n.is_empty())
        .cloned()
        // A file with no `name:` is named by its filename rather than rejected.
        .unwrap_or_else(|| slug.replace('-', " "));

    let extra = front
        .iter()
        .filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    Workflow {
        id: format!("{project_path}::{slug}"),
        name,
        icon: front.get("icon").and_then(|raw| sanitize_icon(raw)),
        description: front.get("description").cloned().unwrap_or_default(),
        agent_id: front
            .get("agent")
            .filter(|a| !a.is_empty())
            .map(|a| a.to_ascii_lowercase()),
        trigger: front
            .get("trigger")
            .and_then(|t| WorkflowTrigger::parse(t))
            .unwrap_or(WorkflowTrigger::Manual),
        permission: front
            .get("permission")
            .and_then(|p| WorkflowPermission::parse(p))
            // Read-only is the default because an unattended agent that can
            // edit is a decision, never an accident of an omitted key.
            .unwrap_or(WorkflowPermission::ReadOnly),
        prompt: body,
        severity_floor: front
            .get("severity-floor")
            .and_then(|s| Severity::parse(s))
            .unwrap_or(Severity::Info),
        auto_run: parse_bool(front.get("auto-run"), true),
        project_name: project_name_of(project),
        project_path,
        file_path: file_path.to_string_lossy().to_string(),
        slug,
        extra,
    }
}

/// Render a workflow back to its file form.
pub fn serialize_workflow(workflow: &Workflow) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", workflow.name));
    if let Some(icon) = &workflow.icon {
        out.push_str(&format!("icon: {icon}\n"));
    }
    if !workflow.description.is_empty() {
        out.push_str(&format!("description: {}\n", workflow.description));
    }
    if let Some(agent) = &workflow.agent_id {
        out.push_str(&format!("agent: {agent}\n"));
    }
    out.push_str(&format!("trigger: {}\n", workflow.trigger.to_phrase()));
    out.push_str(&format!("permission: {}\n", workflow.permission.as_str()));
    out.push_str(&format!(
        "severity-floor: {}\n",
        workflow.severity_floor.as_str()
    ));
    if workflow.trigger.is_armable() {
        out.push_str(&format!("auto-run: {}\n", workflow.auto_run));
    }
    for (key, value) in &workflow.extra {
        out.push_str(&format!("{key}: {value}\n"));
    }
    out.push_str("---\n\n");
    out.push_str(workflow.prompt.trim());
    out.push('\n');
    out
}

/// Read every workflow defined in one project. Missing directory means none.
pub fn read_project_workflows(project: &Path) -> Vec<Workflow> {
    let dir = workflows_dir(project);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut workflows: Vec<Workflow> = entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .filter_map(|entry| {
            let path = entry.path();
            let contents = std::fs::read_to_string(&path).ok()?;
            Some(parse_workflow(project, &path, &contents))
        })
        .collect();
    workflows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    workflows
}

/// Every project Ship Studio knows about that has a workflows folder: the
/// projects root plus registered external folders.
///
/// Lives here rather than in the scheduler because both the scheduler and the
/// home-level list need exactly this set, and a workflow that the list shows but
/// the scheduler can't see (or vice versa) would be a bug nobody could explain.
pub fn projects_with_workflows() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(root) = crate::utils::projects_root() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && workflows_dir(&path).is_dir() {
                    paths.push(path);
                }
            }
        }
    }
    if let Ok(config) = crate::commands::external_projects::load_config() {
        for project in config.projects {
            let path = PathBuf::from(&project.path);
            if workflows_dir(&path).is_dir() {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// A workflow plus the scheduling and history state that doesn't live in its
/// file. This is what the Workflows list renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowView {
    #[serde(flatten)]
    pub workflow: Workflow,
    /// When the trigger next comes due. Null for manual and event workflows,
    /// and for an armed trigger whose auto-run is off.
    pub next_run_at: Option<i64>,
    pub is_running: bool,
    /// When the in-flight run started, so the row can show elapsed time
    /// instead of an unmoving spinner. Null when nothing is running.
    pub running_since: Option<i64>,
    pub runs: Vec<super::state::WorkflowRun>,
}

/// Every workflow in every known project, with its schedule and history.
#[tauri::command]
#[tracing::instrument]
pub async fn list_all_workflows() -> Result<Vec<WorkflowView>, CommandError> {
    let state = super::state::load_state();
    let running = super::runs::running_since_map();
    let now = super::state::now_ms();

    let mut views: Vec<WorkflowView> = Vec::new();
    for project in projects_with_workflows() {
        for workflow in read_project_workflows(&project) {
            let last_run_at = state.last_run_at.get(&workflow.id).copied();
            let next_run_at = if workflow.auto_run {
                super::runs::next_due_at(workflow.trigger, last_run_at, now)
            } else {
                None
            };
            let mut runs: Vec<_> = state
                .runs
                .iter()
                .filter(|run| run.workflow_id == workflow.id)
                .cloned()
                .collect();
            runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            views.push(WorkflowView {
                running_since: running.get(&workflow.id).copied(),
                is_running: running.contains_key(&workflow.id),
                next_run_at,
                runs,
                workflow,
            });
        }
    }
    views.sort_by(|a, b| {
        a.workflow
            .name
            .to_lowercase()
            .cmp(&b.workflow.name.to_lowercase())
    });
    Ok(views)
}

/// List the workflows defined in one project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_project_workflows(project_path: String) -> Result<Vec<Workflow>, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(read_project_workflows(&project))
}

/// Create or overwrite a workflow file.
///
/// `slug` is `None` for a create (one is derived from the name, de-duplicated
/// against what's already there) and `Some` for an edit. Renaming an existing
/// workflow deliberately does *not* rename its file: the filename is the
/// workflow's identity, and moving it would orphan its run history and every
/// finding already filed against it.
#[tauri::command]
#[tracing::instrument(skip(draft), fields(project = %project_path))]
pub async fn save_workflow_file(
    project_path: String,
    slug: Option<String>,
    draft: WorkflowDraft,
) -> Result<Workflow, CommandError> {
    let project = validate_project_path(&project_path)?;
    let dir = workflows_dir(&project);
    std::fs::create_dir_all(&dir)
        .map_err(|e| classify_fs_error("create the workflows folder", &dir, &e))?;

    let slug = match slug {
        Some(existing) => slugify(&existing),
        None => {
            let base = slugify(&draft.name);
            let mut candidate = base.clone();
            let mut n = 2;
            while dir.join(format!("{candidate}.md")).exists() {
                candidate = format!("{base}-{n}");
                n += 1;
            }
            candidate
        }
    };

    let file_path = dir.join(format!("{slug}.md"));
    // Preserve unknown frontmatter keys across an edit.
    let extra = std::fs::read_to_string(&file_path)
        .ok()
        .map(|c| parse_workflow(&project, &file_path, &c).extra)
        .unwrap_or_default();

    let workflow = Workflow {
        id: format!("{}::{slug}", project.to_string_lossy()),
        name: draft.name.trim().to_string(),
        icon: draft.icon.as_deref().and_then(sanitize_icon),
        description: draft.description.trim().to_string(),
        agent_id: draft.agent_id,
        trigger: draft.trigger,
        permission: draft.permission,
        prompt: draft.prompt.trim().to_string(),
        severity_floor: draft.severity_floor,
        auto_run: draft.auto_run,
        project_name: project_name_of(&project),
        project_path: project.to_string_lossy().to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        slug,
        extra,
    };

    std::fs::write(&file_path, serialize_workflow(&workflow))
        .map_err(|e| classify_fs_error("write the workflow file", &file_path, &e))?;
    Ok(workflow)
}

/// Delete a workflow file. Findings it already filed stay in the inbox — they
/// describe real problems that don't stop existing because the watcher did.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, slug = %slug))]
pub async fn delete_workflow_file(project_path: String, slug: String) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    // Re-slugify rather than trusting the argument: `slug` reaches the
    // filesystem, and `../../etc/passwd` must not survive the trip.
    let file_path = workflows_dir(&project).join(format!("{}.md", slugify(&slug)));
    match std::fs::remove_file(&file_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(classify_fs_error(
            "delete the workflow file",
            &file_path,
            &e,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::WorkflowEvent;
    use super::*;

    fn parse(contents: &str) -> Workflow {
        parse_workflow(
            Path::new("/tmp/demo"),
            Path::new("/tmp/demo/.shipstudio/workflows/security-sweep.md"),
            contents,
        )
    }

    #[test]
    fn parses_a_full_file() {
        let workflow = parse(
            "---\nname: Security sweep\ndescription: Looks for secrets.\nagent: claude-code\ntrigger: every 30m\npermission: read-only\nseverity-floor: warning\nnotify: true\nauto-run: false\n---\n\nReview the diff.\n",
        );
        assert_eq!(workflow.name, "Security sweep");
        assert_eq!(workflow.description, "Looks for secrets.");
        assert_eq!(workflow.agent_id.as_deref(), Some("claude-code"));
        assert_eq!(
            workflow.trigger,
            WorkflowTrigger::Interval { every_minutes: 30 }
        );
        assert_eq!(workflow.severity_floor, Severity::Warning);
        assert!(!workflow.auto_run);
        assert_eq!(workflow.prompt, "Review the diff.");
        assert_eq!(workflow.id, "/tmp/demo::security-sweep");
        assert_eq!(workflow.project_name, "demo");
    }

    #[test]
    fn a_bare_markdown_file_is_still_a_workflow() {
        let workflow = parse("Just tell me about broken links.\n");
        assert_eq!(workflow.prompt, "Just tell me about broken links.");
        assert_eq!(workflow.trigger, WorkflowTrigger::Manual);
        assert_eq!(workflow.permission, WorkflowPermission::ReadOnly);
        // Named from the filename rather than left blank.
        assert_eq!(workflow.name, "security sweep");
    }

    #[test]
    fn an_unparseable_trigger_costs_the_schedule_not_the_workflow() {
        let workflow = parse("---\nname: X\ntrigger: whenever i feel like it\n---\n\nBody.\n");
        assert_eq!(workflow.trigger, WorkflowTrigger::Manual);
        assert_eq!(workflow.prompt, "Body.");
    }

    #[test]
    fn permission_defaults_to_read_only_when_omitted() {
        let workflow = parse("---\nname: X\n---\n\nBody.\n");
        assert_eq!(workflow.permission, WorkflowPermission::ReadOnly);
    }

    #[test]
    fn round_trips_through_serialize() {
        let original = parse(
            "---\nname: Security sweep\ndescription: Looks for secrets.\ntrigger: daily at 09:00\npermission: can-edit\nseverity-floor: critical\nnotify: false\nauto-run: true\n---\n\nReview the diff.\n",
        );
        let reparsed = parse(&serialize_workflow(&original));
        assert_eq!(reparsed.name, original.name);
        assert_eq!(reparsed.description, original.description);
        assert_eq!(reparsed.trigger, original.trigger);
        assert_eq!(reparsed.permission, original.permission);
        assert_eq!(reparsed.severity_floor, original.severity_floor);
        assert_eq!(reparsed.auto_run, original.auto_run);
        assert_eq!(reparsed.prompt, original.prompt);
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let original = parse("---\nname: X\nfuture-key: keep me\n---\n\nBody.\n");
        assert_eq!(original.extra.get("future-key").unwrap(), "keep me");
        let text = serialize_workflow(&original);
        assert!(text.contains("future-key: keep me"));
    }

    #[test]
    fn crlf_files_parse() {
        let workflow = parse("---\r\nname: Windows\r\ntrigger: on push\r\n---\r\n\r\nBody.\r\n");
        assert_eq!(workflow.name, "Windows");
        assert_eq!(
            workflow.trigger,
            WorkflowTrigger::Event {
                event: WorkflowEvent::Push
            }
        );
        assert_eq!(workflow.prompt, "Body.");
    }

    #[test]
    fn an_icon_round_trips() {
        let workflow = parse("---\nname: X\nicon: 🔒\n---\n\nBody.\n");
        assert_eq!(workflow.icon.as_deref(), Some("🔒"));
        assert!(serialize_workflow(&workflow).contains("icon: 🔒"));
    }

    #[test]
    fn a_multi_codepoint_emoji_survives() {
        // Skin tones and ZWJ sequences are several chars but one glyph.
        for emoji in ["👨‍💻", "👋🏽", "🇬🇧", "⚠️"] {
            let workflow = parse(&format!("---\nname: X\nicon: {emoji}\n---\n\nBody.\n"));
            assert_eq!(workflow.icon.as_deref(), Some(emoji), "dropped {emoji}");
        }
    }

    #[test]
    fn a_sentence_in_the_icon_field_is_dropped_not_truncated() {
        // An agent writing prose here would otherwise blow out every row.
        let workflow = parse("---\nname: X\nicon: a security review workflow\n---\n\nBody.\n");
        assert_eq!(workflow.icon, None);
    }

    #[test]
    fn an_absent_icon_stays_absent_in_the_file() {
        let workflow = parse("---\nname: X\n---\n\nBody.\n");
        assert_eq!(workflow.icon, None);
        assert!(!serialize_workflow(&workflow).contains("icon:"));
    }

    #[test]
    fn slugify_is_filename_safe() {
        assert_eq!(slugify("Security sweep!"), "security-sweep");
        assert_eq!(slugify("  ../../etc/passwd  "), "etc-passwd");
        assert_eq!(slugify("///"), "untitled-workflow");
        assert_eq!(slugify(""), "untitled-workflow");
        assert!(!slugify(&"x".repeat(200)).contains('/'));
        assert_eq!(slugify(&"x".repeat(200)).len(), 64);
    }
}
