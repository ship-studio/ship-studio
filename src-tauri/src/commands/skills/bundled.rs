//! Skills Ship Studio ships with, written into each installed agent's skills
//! directory on launch.
//!
//! ## Why this exists
//!
//! Ship Studio used to extend itself with plugins: separate repos, cloned
//! per-project, rendering their own UI through a parallel component library.
//! For anything whose real job is *constructing a prompt* that was the wrong
//! container — it meant a second design system, a per-project install, and a
//! version pinned at whatever commit the clone happened to catch. A skill is
//! the right container for that work: the agent is already open, the user is
//! already talking to it, and there is nothing to install or keep up to date.
//!
//! So: features with genuine UI and persistent state became native modules;
//! features that were a prompt with a form in front of it live here.
//!
//! ## Adding one
//!
//! Add a [`BundledSkill`] to [`BUNDLED_SKILLS`] and bump its `version`.
//! Installation is idempotent and only writes when the body differs, so this
//! is cheap on every launch and never churns file mtimes.
//!
//! Nothing is created from nothing: if `~/.claude` doesn't exist the agent
//! isn't installed, and scattering directories into someone's home for tools
//! they don't use is not ours to do.

use crate::agent::{CLAUDE_CODE, CODEX};
use serde::Serialize;
use std::path::PathBuf;
use tracing::{debug, warn};

/// One skill this app ships.
pub struct BundledSkill {
    /// Directory name under the agent's `skills/`.
    pub dir_name: &'static str,
    /// Bump when `body` changes so installed copies refresh.
    pub version: &'static str,
    /// Produces the full SKILL.md, front matter included.
    pub body: fn() -> String,
}

/// Every skill Ship Studio installs.
pub const BUNDLED_SKILLS: &[BundledSkill] = &[
    BundledSkill {
        dir_name: "shipstudio-workflows",
        version: "1",
        body: super::super::workflows::skill::skill_markdown,
    },
    BundledSkill {
        dir_name: "shipstudio-brand-guidelines",
        version: "1",
        body: brand_guidelines_skill,
    },
    BundledSkill {
        dir_name: "shipstudio-site-to-code",
        version: "1",
        body: site_to_code_skill,
    },
];

/// Extracting a design system from a site someone already built.
///
/// Replaces the `brand-guidelines` plugin, which paired a real extraction step
/// with a bespoke modal and its own file-sync engine — then handed the result
/// to `claude -p` anyway. The extraction is something an agent can do directly,
/// and the agent already knows where this project keeps its conventions.
fn brand_guidelines_skill() -> String {
    r#"---
name: shipstudio-brand-guidelines
description: >-
  Capture a project's visual language — colours, type, spacing, radii, shadows —
  and write it down where this project's agents will actually read it. Use when
  the user says a new page should "match the rest of the site", asks to write
  down or extract brand guidelines or a design system, mentions their brand
  colours or fonts, points at a site and says "make it look like this", or asks
  why the styling keeps drifting between pages.
---

# Capture a project's visual language

The goal is that the next thing built in this project looks like it belongs,
without anyone having to say so.

## Where it goes

Write the result into the project's own agent instructions — `CLAUDE.md`, or
`AGENTS.md` where that is what the project uses. A design system in a file
nobody loads changes nothing. Append a `## Visual language` section rather than
rewriting the file, and preserve everything already there.

If the project already has such a section, update it in place and say what
changed rather than duplicating it.

## What to capture

Read the actual source, not a screenshot. Look at the stylesheets, the token
files, the component library, and a couple of representative pages.

- **Colours.** The ones actually used, with the names the codebase uses for
  them. If they are CSS custom properties, record the property names — those
  are what future code should reference, not the hex values.
- **Type.** Families, the sizes that recur, and their weights. Note which is
  for UI and which for code, if they differ.
- **Spacing.** The rhythm the layout is on, and whether it comes from tokens.
- **Radii, borders, shadows.** Usually a small closed set. Record the set.
- **What is conspicuously absent.** "No gradients anywhere", "shadows only on
  overlays" — the rules a newcomer would break are as useful as the palette.

## The one rule

Record what you found, not what you would have chosen. If a project uses four
near-identical greys, say so; that is a fact about the codebase and possibly a
cleanup worth suggesting separately. Do not quietly tidy it into three on the
way past, and do not invent a value to fill a gap in the set.

If a category genuinely has no pattern, write that. An honest "spacing is
ad-hoc; no scale in use" tells the next agent far more than an invented scale
it will then apply wrongly.
"#
    .to_string()
}

/// Turning an existing site or an export into a migration plan.
///
/// Replaces the `url-to-code`, `webflow-to-code`, `weweb-to-code` and
/// `wordpress-to-code` plugins. Each was a local extraction pipeline that
/// terminated in a prompt on the clipboard; the differences between them were
/// the parser, not the workflow.
fn site_to_code_skill() -> String {
    r#"---
name: shipstudio-site-to-code
description: >-
  Turn an existing site — a live URL, or an export from Webflow, WeWeb, Framer
  or WordPress — into a migration plan and then into code in this project. Use
  when the user wants to rebuild, port, recreate or migrate a site, says "make
  this in Next.js/Astro", points at a URL and asks to copy its structure, or
  has a .zip export from a site builder.
---

# Rebuild an existing site in this project

Two phases, and the first one is not optional. Migrations fail by starting to
write components before anyone has established what the site actually contains.

## Phase 1 — survey, then agree a plan

Do not write application code in this phase.

**From a live URL**, fetch the pages themselves. Establish: how many distinct
page templates there really are (usually far fewer than there are pages), the
navigation structure, which sections repeat across templates, the breakpoints,
and where content is dynamic rather than authored once.

**From an export**, read the archive. Webflow and Framer exports carry their
pages as HTML with a stylesheet; WeWeb exports carry a JSON project; WordPress
backups carry SQL, sometimes with PHP-serialized fields inside it. In every
case what you want is the same: templates, components, content model.

Then write a plan to `MIGRATION.md` in the project root:

- A page inventory, grouped by template rather than listed one by one.
- The components each template needs, named as they will be named in code.
- The content model: what is authored, and where it will live.
- Anything that cannot come across — a builder interaction with no equivalent,
  a font that isn't licensed for self-hosting, a third-party embed.
- What you are unsure about.

Show the plan and get agreement before building. A migration is mostly
judgement calls about what to keep, and those are the user's to make.

## Phase 2 — build against the plan

Work template by template, not page by page. Build the shared components first,
then compose pages from them. Check each template in the preview before moving
on: the point of a migration is fidelity, and fidelity is a visual property.

Keep `MIGRATION.md` updated as you go — it is the record of what is done and
what is left, and it survives the conversation ending.

## What not to do

- **Do not copy the markup.** A builder's export is machine-generated: wrapper
  divs many levels deep, generated class names, absolute positioning where a
  layout should be. Rebuild it in this project's idiom.
- **Do not recreate the CSS wholesale.** Read it to learn the visual language,
  then express that in whatever this project already uses. If the project has a
  design system, use it — see the `shipstudio-brand-guidelines` skill for
  capturing one first.
- **Do not invent content.** Placeholder text is fine and should be visibly
  placeholder. Do not write plausible-looking copy that reads as real.
- **Do not silently drop a page.** If something cannot be migrated, it belongs
  in the plan's "cannot come across" list where the user can see it.
"#
    .to_string()
}

/// Where each agent keeps user-scope skills. `None` for agents without skills.
fn skill_dirs(dir_name: &str) -> Vec<(&'static str, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [CLAUDE_CODE, CODEX]
        .into_iter()
        .filter_map(|agent| {
            let skills_dir = agent.skills_dir_name?;
            Some((
                agent.id,
                home.join(agent.auth_config_dir)
                    .join(skills_dir)
                    .join(dir_name),
            ))
        })
        .collect()
}

/// Whether a bundled skill is installed for one agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillStatus {
    pub skill: String,
    pub agent_id: String,
    pub installed: bool,
    pub path: String,
}

/// Write every bundled skill for every agent that supports one.
pub fn install_bundled_skills() -> Vec<BundledSkillStatus> {
    let mut statuses = Vec::new();

    for skill in BUNDLED_SKILLS {
        let body = (skill.body)();
        for (agent_id, dir) in skill_dirs(skill.dir_name) {
            let installed = write_skill_if_agent_present(&dir, &body).unwrap_or_else(|err| {
                warn!(
                    agent = agent_id,
                    skill = skill.dir_name,
                    error = %err,
                    "could not install a bundled skill"
                );
                false
            });
            statuses.push(BundledSkillStatus {
                skill: skill.dir_name.to_string(),
                agent_id: agent_id.to_string(),
                installed,
                path: dir.join("SKILL.md").to_string_lossy().to_string(),
            });
        }
    }

    statuses
}

fn write_skill_if_agent_present(dir: &std::path::Path, body: &str) -> std::io::Result<bool> {
    // dir is <home>/<config>/skills/<name> — the agent's own config dir is two
    // levels up and must already exist.
    match dir.parent().and_then(|p| p.parent()) {
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
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_skill_has_the_front_matter_an_agent_needs() {
        // Without a name and a description the agent has no basis to decide
        // when to load it, and a skill that never loads is not a feature.
        for skill in BUNDLED_SKILLS {
            let body = (skill.body)();
            assert!(
                body.starts_with("---\n"),
                "{} has no front matter",
                skill.dir_name
            );
            assert!(
                body.contains("\nname:"),
                "{} declares no name",
                skill.dir_name
            );
            assert!(
                body.contains("\ndescription:"),
                "{} declares no description",
                skill.dir_name
            );
        }
    }

    #[test]
    fn descriptions_name_what_a_user_would_actually_say() {
        // A description written in the feature's own vocabulary never fires:
        // someone who has not found the feature will not use its name. These
        // have to match the sentences people say instead.
        for skill in BUNDLED_SKILLS {
            let body = (skill.body)();
            // Whitespace is collapsed first: front matter wraps these across
            // lines, so a phrase can be split mid-way and a naive contains()
            // reports a description that plainly does say when to load.
            let description = body
                .split("description:")
                .nth(1)
                .and_then(|d| d.split("\n---").next())
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();

            assert!(
                description.contains("use when") || description.contains("use this"),
                "{} never says when to load",
                skill.dir_name
            );
            assert!(
                description.len() > 120,
                "{}'s description is too thin to route on",
                skill.dir_name
            );
        }
    }

    #[test]
    fn skill_directory_names_are_namespaced() {
        // These land in a shared directory alongside skills the user installed
        // themselves; a generic name would collide with one of theirs.
        for skill in BUNDLED_SKILLS {
            assert!(
                skill.dir_name.starts_with("shipstudio-"),
                "{} would collide in a shared skills directory",
                skill.dir_name
            );
        }
    }

    #[test]
    fn no_two_bundled_skills_share_a_directory() {
        let mut seen = std::collections::HashSet::new();
        for skill in BUNDLED_SKILLS {
            assert!(
                seen.insert(skill.dir_name),
                "{} is declared twice and would overwrite itself",
                skill.dir_name
            );
        }
    }
}
