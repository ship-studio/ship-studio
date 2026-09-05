//! The bundled `shipstudio-workflows` agent skill.
//!
//! This is the discovery mechanism for the whole feature, and it is the reason
//! the workflow file format is plain markdown rather than an API.
//!
//! Nobody browses a new tab. But everyone using Ship Studio is already talking
//! to an agent all day, and they routinely say things like "check the bundle
//! size before every release" or "I keep forgetting to look at dependency
//! advisories". A skill turns those sentences into the moment the feature
//! introduces itself — in the tool they're already in, at the moment it's
//! relevant, in their own words. The agent then writes the workflow file itself.
//!
//! Ship Studio writes the skill into each installed agent's user-scope skills
//! directory (`~/.claude/skills/`, `~/.codex/skills/`) on startup. The write is
//! idempotent and version-stamped, so an app update refreshes it and an
//! unchanged version costs one string comparison.

use crate::agent::{CLAUDE_CODE, CODEX};
use crate::errors::CommandError;
use serde::Serialize;
use std::path::PathBuf;
use tracing::{debug, warn};

/// Bump when SKILL.md changes so installed copies are refreshed.
const SKILL_VERSION: &str = "1";

const SKILL_DIR_NAME: &str = "shipstudio-workflows";

/// The skill body.
///
/// Two jobs, in this order of importance:
///
/// 1. **Offer.** The `description` decides when the agent loads this at all,
///    so it names the phrasings people actually use ("every time", "before
///    each release", "keep an eye on") rather than the word "workflow", which
///    is the one word a user who hasn't discovered the feature will never say.
/// 2. **Author.** Once loaded, the format spec is complete enough that the
///    agent can write a valid file without asking Ship Studio anything.
fn skill_markdown() -> String {
    format!(
        r#"---
name: shipstudio-workflows
description: >-
  Create and manage Ship Studio workflows — saved instructions that run on a
  schedule or on demand in this project and file what they find to the user's
  Ship Studio inbox. Use this whenever the user says they want something
  checked regularly or repeatedly ("every time", "each week", "before every
  release", "keep an eye on", "remind me to check", "I keep forgetting to"),
  asks to automate a review or audit, or mentions workflows, scheduled checks,
  or the Ship Studio inbox.
metadata:
  shipstudio-skill-version: "{SKILL_VERSION}"
---

# Ship Studio workflows

A **workflow** is a saved instruction that Ship Studio runs against this project
with a headless agent CLI, on demand or on a schedule. Whatever it reports goes
to the user's Ship Studio inbox.

A workflow is one markdown file in `.shipstudio/workflows/<slug>.md` in the
project root. There is no API and no service: writing the file *is* creating
the workflow, and Ship Studio picks it up immediately.

## When to offer one

If the user describes wanting something checked more than once — on a cadence,
before a recurring event, or "every time X happens" — offer to save it as a
workflow. Keep the offer to one sentence, and only make it once per topic.

> That's a good candidate for a Ship Studio workflow — I can save it so it runs
> every morning and files anything it finds to your inbox. Want me to?

Do **not** offer a workflow for one-off work, for something the user is asking
you to do right now, or a second time after they have declined.

## The file format

```markdown
---
name: Dependency drift
icon: 📦
description: Daily advisory check plus a read on which majors are worth taking.
trigger: daily at 09:00
permission: read-only
severity-floor: warning
auto-run: true
---

Check the installed dependencies against known advisories. For anything with a
published fix, say what upgrading costs. Ignore dev-only packages.
```

### Frontmatter keys

| Key              | Values                                                                                                | Default     |
|------------------|-------------------------------------------------------------------------------------------------------|-------------|
| `name`           | Any short phrase. Shown in the workflows list.                                                           | filename    |
| `icon`           | A single emoji shown beside the name, Notion-style. One glyph only.                                     | none        |
| `description`    | One line, shown under the name.                                                                         | empty       |
| `agent`          | `claude-code` or `codex`. Omit to use whichever agent the user has set as their default.                | user default|
| `trigger`        | `manual`, `every 30m`, `every 2h`, `daily at 09:00`, `weekly on monday at 09:00`, `on push`, `on pr`    | `manual`    |
| `permission`     | `read-only` or `can-edit`                                                                               | `read-only` |
| `severity-floor` | `critical`, `warning`, `info` — findings below this are dropped                                         | `info`      |
| `auto-run`       | `true` / `false` — whether the trigger is armed                                                         | `true`      |

Intervals must be between 5 minutes and 7 days. An unrecognised trigger falls
back to `manual`, so the workflow still works — it just won't be scheduled.

### Say what a schedule actually promises

Scheduled workflows run **only while Ship Studio is open**. There is no server
and no background daemon: a `daily at 09:00` workflow runs at the first check
after 09:00 that the app is running for, and if the app was closed all morning
it simply runs late, once — never once per missed day. `on push` and `on pr`
fire when Ship Studio itself performs those actions.

Tell the user this when you set a schedule up. "It'll run every morning" is the
one sentence here that can turn out to be false, and they will find out on the
morning they were relying on it.

### The body is the instruction

Everything after the frontmatter is the prompt handed to the agent on each run.
Write it as a direct instruction. Ship Studio automatically prepends what
changed since the workflow last ran, the findings it has already filed, and the
reporting format — so do **not** write any of that into the body yourself.

## Writing a good workflow

- **Say what not to report.** The main way a workflow fails is by being noisy.
  "Ignore dev-only packages", "only flag things on the critical path".
- **Be specific about the evidence.** "Include the exact file and line" gets a
  finding the user can act on; "check for problems" gets an essay.
- **Prefer `read-only`.** It is enforced by the agent CLI (Claude Code runs in
  plan mode, Codex in a read-only sandbox), so a workflow genuinely cannot edit
  the tree while nobody is watching. Only use `can-edit` if the user explicitly
  asks for unattended changes.
- **Give it an `icon`.** One emoji that says what it watches (🔒 security, 📦
  dependencies, 🎨 design). It becomes the workflow's mark in the list.
- **Start on `manual`** unless the user named a cadence. They can arm it with
  one switch in the Workflows tab once they've seen what it produces.

## Doing it

1. Write the file to `.shipstudio/workflows/<slug>.md` (kebab-case slug from the
   name). Create the directory if it doesn't exist.
2. Tell the user it's saved, and that it's in **Workflows** in Ship Studio's
   sidebar where they can press Run to try it immediately. Suggest they do —
   a workflow nobody has watched run once is a schedule nobody trusts.

To change a workflow, edit its file. To delete one, delete its file. To see what
already exists, list `.shipstudio/workflows/`.
"#
    )
}

/// Where each agent keeps user-scope skills. `None` for agents without skills.
fn skill_dirs() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [CLAUDE_CODE, CODEX]
        .into_iter()
        .filter_map(|agent| {
            let dir_name = agent.skills_dir_name?;
            Some((
                agent.id,
                home.join(agent.auth_config_dir)
                    .join(dir_name)
                    .join(SKILL_DIR_NAME),
            ))
        })
        .collect()
}

/// Whether the skill is installed for each agent that supports skills.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsSkillStatus {
    pub agent_id: String,
    pub installed: bool,
    pub path: String,
}

/// Write the skill for every agent that supports one.
///
/// Only writes when the content actually differs, so this is cheap to call on
/// every launch and never churns the user's file mtimes.
///
/// Deliberately does **not** create the agent's config directory tree from
/// nothing: if `~/.claude` doesn't exist the agent isn't installed, and
/// scattering directories into someone's home for tools they don't use is not
/// ours to do. It writes the `skills/` subdirectory only.
pub fn install_workflows_skill() -> Vec<WorkflowsSkillStatus> {
    let body = skill_markdown();
    skill_dirs()
        .into_iter()
        .map(|(agent_id, dir)| {
            let installed = write_skill_if_agent_present(&dir, &body).unwrap_or_else(|err| {
                warn!(agent = agent_id, error = %err, "could not install the workflows skill");
                false
            });
            WorkflowsSkillStatus {
                agent_id: agent_id.to_string(),
                installed,
                path: dir.join("SKILL.md").to_string_lossy().to_string(),
            }
        })
        .collect()
}

fn write_skill_if_agent_present(dir: &std::path::Path, body: &str) -> std::io::Result<bool> {
    // dir is <home>/<config>/skills/shipstudio-workflows — the agent's own
    // config dir is two levels up and must already exist.
    let agent_config_dir = dir.parent().and_then(|p| p.parent());
    match agent_config_dir {
        Some(root) if root.exists() => {}
        _ => {
            debug!(?dir, "agent config dir absent — skipping skill install");
            return Ok(false);
        }
    }

    let file = dir.join("SKILL.md");
    if std::fs::read_to_string(&file).is_ok_and(|existing| existing == body) {
        return Ok(true);
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(&file, body)?;
    debug!(?file, "installed the workflows skill");
    Ok(true)
}

/// Install (or refresh) the skill and report where it landed.
#[tauri::command]
#[tracing::instrument]
pub async fn ensure_workflows_skill() -> Result<Vec<WorkflowsSkillStatus>, CommandError> {
    Ok(install_workflows_skill())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skill_tells_the_agent_a_schedule_only_runs_while_the_app_is_open() {
        // The agent is the discovery path, so it is also the place a false
        // promise would be made. Every other surface says this plainly.
        let body = skill_markdown();
        assert!(
            body.contains("only while Ship Studio is open"),
            "the skill must not let an agent promise a clock the app cannot keep"
        );
        assert!(body.contains("runs late, once"));
    }

    #[test]
    fn the_description_names_phrasings_a_user_actually_says() {
        let md = skill_markdown();
        // The description is the whole trigger surface. A user who hasn't
        // discovered the feature will never type "workflow", so if these go
        // missing the skill silently stops being discovery and becomes docs.
        for phrase in [
            "every time",
            "each week",
            "before every",
            "keep an eye on",
            "I keep forgetting to",
        ] {
            assert!(
                md.contains(phrase),
                "the skill description must still match \"{phrase}\""
            );
        }
    }

    #[test]
    fn the_skill_documents_every_frontmatter_key_the_parser_reads() {
        let md = skill_markdown();
        for key in [
            "name",
            "icon",
            "description",
            "agent",
            "trigger",
            "permission",
            "severity-floor",
            "auto-run",
        ] {
            assert!(md.contains(&format!("`{key}`")), "undocumented key: {key}");
        }
    }

    #[test]
    fn every_documented_trigger_phrase_actually_parses() {
        // The skill is the agent's only spec. A phrase documented here that the
        // parser rejects would produce silently-manual workflows.
        for phrase in [
            "manual",
            "every 30m",
            "every 2h",
            "daily at 09:00",
            "weekly on monday at 09:00",
            "on push",
            "on pr",
        ] {
            assert!(
                super::super::WorkflowTrigger::parse(phrase).is_some(),
                "the skill documents \"{phrase}\" but the parser rejects it"
            );
        }
    }

    #[test]
    fn the_example_file_in_the_skill_parses_into_what_it_claims() {
        let example = "---\nname: Dependency drift\nicon: 📦\ndescription: Daily advisory check plus a read on which majors are worth taking.\ntrigger: daily at 09:00\npermission: read-only\nseverity-floor: warning\nauto-run: true\n---\n\nCheck the installed dependencies.\n";
        let workflow = super::super::files::parse_workflow(
            std::path::Path::new("/tmp/p"),
            std::path::Path::new("/tmp/p/.shipstudio/workflows/dependency-drift.md"),
            example,
        );
        assert_eq!(workflow.name, "Dependency drift");
        assert_eq!(workflow.icon.as_deref(), Some("📦"));
        assert_eq!(
            workflow.trigger,
            super::super::WorkflowTrigger::Daily {
                at_hour: 9,
                at_minute: 0
            }
        );
        assert_eq!(
            workflow.permission,
            super::super::WorkflowPermission::ReadOnly
        );
        assert_eq!(workflow.severity_floor, super::super::Severity::Warning);
        assert!(workflow.auto_run);
    }

    #[test]
    fn skill_dirs_target_the_agents_own_config_locations() {
        let dirs = skill_dirs();
        assert_eq!(dirs.len(), 2, "Claude Code and Codex support skills");

        // Compared as path components, not as a substring with a separator in
        // it: `join` writes a backslash on Windows, so `.claude/skills` matched
        // nothing there and this failed on a platform where the code is fine.
        let ends_with = |agent: &str, config_dir: &str| {
            let tail = std::path::Path::new(config_dir)
                .join("skills")
                .join(SKILL_DIR_NAME);
            dirs.iter()
                .any(|(id, path)| *id == agent && path.ends_with(&tail))
        };
        assert!(ends_with("claude-code", ".claude"));
        assert!(ends_with("codex", ".codex"));
    }
}
