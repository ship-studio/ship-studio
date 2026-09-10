//! Skills Harbr ships with, written into each installed agent's skills
//! directory on launch.
//!
//! ## Why this exists
//!
//! Harbr used to extend itself with plugins: separate repos, cloned
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

/// Every skill Harbr installs.
pub const BUNDLED_SKILLS: &[BundledSkill] = &[
    BundledSkill {
        dir_name: "shipstudio-workflows",
        version: "1",
        body: super::super::workflows::skill::skill_markdown,
    },
    BundledSkill {
        dir_name: "shipstudio-team",
        version: "4",
        body: super::super::team::skill::skill_markdown,
    },
    BundledSkill {
        dir_name: "shipstudio-brand-guidelines",
        version: "1",
        body: brand_guidelines_skill,
    },
    BundledSkill {
        dir_name: "shipstudio-site-to-code",
        version: "2",
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
/// Rebuilding a live site in this project, starting from nothing but its URL.
///
/// Replaces a skill that offered four ingest paths and a two-phase plan, and
/// was therefore vague about all of them. One input makes the methodology
/// concrete enough to be prescriptive — and prescriptive is the point, because
/// the failure this addresses is not an agent that cannot rebuild a page, it
/// is an agent that rebuilds twelve pages against a design system it never
/// established, declares victory, and hands over something nobody checked.
///
/// The ordering here is not arbitrary and the skill says so twice: tokens
/// before pages is what makes the work converge instead of drift, and one
/// verified page before the rest is what stops a bad decision being made
/// twelve times.
fn site_to_code_skill() -> String {
    r#"---
name: shipstudio-site-to-code
description: >-
  Rebuild a live website in this project from nothing but its URL — survey it,
  extract its design system, then rebuild it template by template and verify
  each one against the original before moving on. Use when the user points at a
  URL and wants it rebuilt, ported, migrated, cloned or "made in Next.js/Astro",
  says they are moving off Webflow, Framer, Squarespace, WordPress or Wix, asks
  to get their site "into code", or drops a link and asks you to recreate it.
---

# Rebuild a live site from its URL

You are given a URL. You will not be given anything else — no export, no design
file, no content dump, no style guide. Everything you need is on that site.
Go and get it.

## How you are expected to behave

This is the part that matters most, so it comes first.

1. **You lead.** Do not ask the user what to do next. You know the order — it
   is written below. Propose, then proceed. Ask only about things that are
   genuinely theirs to decide — and when you do, ask early, ask once, and bring
   the answer you would choose. A migration that stops for a question every
   twenty minutes is not being careful, it is refusing to lead.
2. **Nothing is done until it is verified**, and verified means *measured*, not
   glanced at. A page you have not compared against the original is not
   finished, however good it looks to you.
3. **Never say "done" when you mean "I stopped".** If a page is at 94% and you
   cannot get it further, that is a page at 94% that needs help — say that.
   Reporting it as complete is the single worst thing you can do here, because
   it transfers your uncertainty to someone who has no way to see it.
4. **Report in four parts, every time**: what is done, what you are doing, what
   is not done, and what needs them. Never make the user ask what state things
   are in.
5. **Ask rather than substitute.** A font you cannot license, an interaction
   with no equivalent, an ambiguous layout — these are decisions, not
   obstacles. Bring them to the user with a recommendation.
6. **Never invent content.** Placeholder text must look like placeholder text.

## The order

Do not reorder these. Each one exists to stop a specific failure in the next.

```
0. Survey            — what is actually here?
1. Design system     — tokens first, or everything after this drifts
2. Homepage          — one page, verified, agreed
3. Everything else   — template by template, same loop
4. The remainder     — what cannot come across, named
```

---

## Phase 0 — Survey

**Write no application code in this phase.**

Fetch the URL, then follow its internal links far enough to see the shape of
the site. What you are establishing:

- **Templates, not pages.** Forty URLs are usually five templates. Group them.
  A migration is priced and executed in templates.
- **The real breakpoints.** Read them out of the site's own media queries.
  Do not assume a framework's defaults — you will verify against the site's
  widths later, and guessing here poisons every comparison downstream.
- **Navigation and shared regions** — header, footer, anything repeated.
- **Where content is dynamic** rather than authored once: listings, detail
  pages, anything that looks like a collection.
- **Fonts** — which are webfonts, which are licensed, which you can self-host.
- **Everything you cannot rebuild**: third-party embeds, forms with a backend
  you cannot see, anything behind a login, video you do not have the source of.

Write this to `MIGRATION.md` in the project root, grouped by template, with an
explicit "cannot come across" section. Show it to the user. This is also the
moment to confirm the target stack if the project does not already have one.

**Then prove you can measure, before you build anything.** Make sure the
rebuild is actually being served — start the dev server yourself if nothing is
running — and take one comparison of the untouched starter against the
original. The score will be terrible and that is fine; it is not the point. The
point is that the loop you are about to depend on works, at a moment when
nothing is invested in it. Finding out at the end of the homepage that you
cannot measure is how a migration turns into a rewrite nobody checked.

### Then settle the decisions, in one go

The survey is the first moment you know enough to ask well, and the last moment
asking is cheap. Every one of these shapes code you are about to write, and
discovering one halfway through the third template means unpicking the first
two.

Ask them **together, once**, each with a recommendation and what it would mean.
The survey tells you which are even relevant — a brochure site with no
collections does not need a content model, and asking anyway is noise:

- **Content.** Where should it live? Files in the repo (Markdown or MDX), a
  CMS, or the one the site already uses. If the source has collections, say how
  many and how big, because that changes the answer. If it is already on a CMS,
  connecting to the same data and rebuilding only the front end is usually
  right, and is worth saying so.
- **Forms.** Where should submissions go? You cannot see the current backend
  from outside, so this is always a question when a form exists.
- **Fonts.** Name any face that cannot be self-hosted, and what you would use
  instead. This one changes every page, so it is worth settling first.
- **Anything the survey found that has no obvious home** — search, accounts,
  checkout, a third-party embed, a locale switcher.
- **Anything you would otherwise have to guess.**

Write them into `migration.json` under `needsYou`, each with your
recommendation, so they are visible rather than buried in a message.

You are leading, not interrogating. Every question carries the answer you would
choose, and if the user says "you pick" you proceed on your own recommendations
without asking again. What you must not do is guess silently, or ask these one
at a time as you trip over them — a decision arriving in the middle of the
third template is a decision that arrives too late to be cheap.

`MIGRATION.md` is not a document you write once. It is the state of the work,
and you keep it current — it is what survives the conversation ending.

**Say you are starting before you start.** Mark the phase you are entering as
active and write one line about what you are doing, *then* do it — and close
the phase behind you as you go, so exactly one is ever active. Two at once
leaves the reader unable to say where the work is, which is the one question
the file exists to answer.

The same applies when you stop: clear `doing` and put whatever is genuinely
outstanding in `notDone`. A migration reporting every phase done while still
describing something in flight is telling the reader two different things, and
they will believe the more optimistic one. A survey runs
for several minutes; a status that still reads "not started" throughout is
indistinguishable, from the outside, from an agent that never began — and the
user's only view of you is that file. This is the difference between a long job
and an apparently dead one.

---

## Phase 1 — The design system, before any page

This is the step people skip, and skipping it is why migrations drift. Every
page you build before you have tokens is a page that invented its own values,
and you will pay for each one twice.

**Read computed values, not appearances.** Open the site and read what the
browser actually resolved — `getComputedStyle` on real elements, the CSS
custom properties on `:root`, the stylesheet itself. Do not sample colours off
a screenshot and do not estimate spacing by eye. The values are *right there*
and they are exact.

Collect:

- **Colour**, grouped by role rather than by hex. Two greys used for different
  jobs are two tokens; the same grey used twice is one.
- **Type**: family, size, weight, line-height and letter-spacing for every
  level that actually appears, plus how each changes per breakpoint.
- **Spacing**: the rhythm the site actually uses. Most sites have one, even
  when the people who built it could not have told you what it was.
- **Radii, borders, shadows, and motion** — durations and easings.
- **Breakpoints**, from the media queries.

Then:

1. Write them into whatever this project uses for tokens — CSS custom
   properties, a Tailwind theme, whatever is already here. Match the project's
   idiom, not the source site's.
2. Build a `/style-guide` route that renders every token: the palette, the type
   scale, spacing, the components you know are coming. This is how you and the
   user can both see the system before anything depends on it, and it is where
   you will catch a wrong value while it is still cheap.
3. Record the system where this project's agents will read it — its `CLAUDE.md`
   or `AGENTS.md`. The `shipstudio-brand-guidelines` skill covers this properly;
   use it. Tokens that live only in your context window drift the moment the
   conversation resets.

Show the user the style guide and the token list before moving on.

---

## Phase 2 — The homepage, and only the homepage

Build it out of the tokens and components from Phase 1. Then run the loop until
it passes. Then stop and get the user's agreement.

The reason this page stands alone: every structural decision you make here —
how sections are composed, how the grid works, how images are handled, how the
nav behaves — is a decision you are about to repeat on every other template.
Making it twelve times and then being told it was wrong is the expensive
outcome this ordering exists to prevent.

### The loop

```
build → capture both sides → score → diagnose → fix one thing → re-measure
```

1. **Capture** the original and your rebuild at *every* breakpoint from Phase 0.
2. **Score** the match at each. The score for the page is the **worst**
   breakpoint, never the average — an average is exactly the number that hides
   a broken phone layout behind a good desktop one.
3. **Diagnose from structure, not from the picture.** The score says how far
   off you are; it cannot say what is off, because one wrong container width
   shifts every image on the page and lights up a third of it. Read the two
   pages' computed styles instead and compare the design itself — the widths
   content is constrained to, the type sizes and line-heights in use, the
   colours actually painted, the section padding. The finding you want is "the
   container is 1140px and should be 1200px", not "there is a lot of red here".

   Where this project provides a tool for that, use it rather than writing your
   own. Aggregate comparisons are what you want: two pages written by different
   people cannot be aligned element by element, but "the widest content box is
   1140 here and 1200 there" is true regardless of how either is structured.
4. **Fix one named thing per pass**, so the next measurement attributes the
   change to it.
5. **Re-measure.**

**Iterate at one width, confirm at all of them.** A comparison costs about a
minute per breakpoint. Fix against a single width while you are working, and
run the full set only when you think the page is finished — that is also the
run that catches a desktop fix which did nothing for mobile.

### The score only goes up

Write down the score before each pass, and compare it after. Then:

- **Better** — keep the change, and continue.
- **Worse — undo the change.** Not "note it and move on", not "keep it and try
  something else on top". Revert it, then look at what happened before choosing
  the next thing. A pass that lowers the score has told you something specific
  and useful, and its value is entirely lost if you build on top of it.
- **Unchanged** — the thing you fixed was not what was wrong. Undo it anyway
  unless it is right on its own merits, and go and find out what is, rather
  than guessing again at the same page.

The best score you have seen is a floor. If the current state is below it, get
back to it before doing anything else. Without this rule the loop is a random
walk that happens to be measured — a real run went 88.7 → 88.7 → 79.2 → 76.3
across four passes, each one building on the damage of the last, because
nothing said to go back.

**When a pass makes it worse, that is when the structural comparison is worth
running** — it will name what moved, which is usually a single value applied in
one more place than intended.

**Before marking a phase done, re-read the reports — do not rely on
remembering.** A run finished a full six-width verification in which one page
came back at 38.62% at a single width, and still recorded nothing outstanding.
It had the number; it had stopped looking at it. Open the last report for every
page in the phase and check its worst breakpoint against the bar.

**A single width wildly out of line with its neighbours, at identical page
height, is a capture artefact — not a defect.** A real layout fault changes how
tall the page is. When the heights match and one width alone is far off, an
image did not render for that shot: re-measure it before chasing it. That is
also the only case where re-running the same command is the right move.

**Stop conditions.** Three passes with no improvement over the best score: stop
looping, say what you tried and what you think is in the way, and ask. Grinding
silently is worse than asking, and so is grinding loudly.

**If the tool errors or times out, that is not a score.** Say so, say which
page and width, and move on or ask — never record a failed measurement as a
result, and never keep re-running the same failing command hoping it settles.
A tool that cannot load one side reports that; a number that appeared anyway
was measured against something you did not intend, most likely the browser's
own error page.

### What "done" means

Operationally: the page matches at every breakpoint, to the limit of what the
measurement can resolve. Small residual differences from font rasterisation and
image re-encoding are expected and are not defects.

What is *not* covered by a score, and must be checked separately because a
screenshot cannot see it:

- The page works at sizes between the breakpoints, not only at them.
- Interactive states — hover, focus, open menus, form validation.
- Keyboard navigation and heading order.
- It still behaves with real content of a different length.

And what can never match, which you declare rather than quietly absorb:
licensed fonts you cannot self-host, third-party embeds, anything you had to
substitute. These belong in `MIGRATION.md`, not hidden inside a percentage.

---

## Phase 3 — Every other template

Same loop, one template at a time, hardest first if you have a choice. Update
`MIGRATION.md` as each one lands, with its score.

Build shared components once and compose pages from them — that is what makes
the second template faster than the first, and the tenth faster than the
second.

**When a template lands, re-measure one earlier page that shares components
with it.** One width is enough. Not "if you think you changed something
shared": every page after the first is built out of parts the earlier ones are
also using, and the whole point of a shared component is that a change reaches
places you are not looking at. An agent that only re-checks when it remembers
editing a file will miss exactly the regressions worth catching, because the
ones that matter are the ones it did not realise it caused.

The cost is about a minute against a cached reference. The alternative is
finding out at the end that page three broke page one, with eight more built on
top of the same mistake — and a signed-off page that quietly regressed is worse
than one that was never finished, because it has already been believed.

---

## Phase 4 — Name the remainder

Finish by making the gap explicit: everything that did not come across, why,
and what you would need to close it. A migration is never total, and the
difference between a good one and a bad one is largely whether the user knows
precisely where the edges are.

---

## Things not to do

- **Do not copy the markup.** A site builder's output is machine-generated:
  wrapper divs many levels deep, generated class names, absolute positioning
  where a layout belongs. You are rebuilding, not transcribing.
- **Do not port the stylesheet.** Read it to learn the system, express the
  system in this project's idiom.
- **Do not "improve" things while you are here.** If the original's spacing is
  inconsistent, match it and mention it. Silently correcting the design is a
  decision you took on someone else's behalf, and it will read as a bug.
- **Do not skip a page quietly.** Anything you cannot do goes in
  `MIGRATION.md` where the user can see it.
- **Do not claim a number you did not measure.**
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
            let installed = write_skill_if_agent_present(&dir, &body, skill.version)
                .unwrap_or_else(|err| {
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

/// Records which build's copy of a skill is on disk.
///
/// A sidecar rather than a key in the skill's own front matter: an unknown
/// field there is read by someone else's parser, and a bundled skill that
/// fails to load because of a version stamp would be a worse bug than the one
/// this fixes.
const VERSION_STAMP: &str = ".shipstudio-version";

/// Whether this build should write its copy of a skill over what is there.
///
/// Every running copy of the app installs these on launch, so two builds of
/// different vintage overwrite each other's skills all day — a real session
/// lost the rewritten `site-to-code` skill twice to an older build starting up
/// beside it, silently, and the agent then ran against instructions nobody
/// thought were installed.
///
/// The stamp makes that decidable. An older build leaves a newer one alone; a
/// newer build upgrades; and a build whose own version is already stamped
/// restores its content, which is what undoes an older build's clobber on the
/// next launch.
fn should_write(dir: &std::path::Path, body: &str, version: &str) -> bool {
    let Ok(existing) = std::fs::read_to_string(dir.join("SKILL.md")) else {
        return true; // nothing there
    };
    if existing == body {
        return false; // already exactly ours
    }

    let stamped = std::fs::read_to_string(dir.join(VERSION_STAMP))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let ours = version.parse::<u32>().unwrap_or(0);

    match stamped {
        // A newer build owns this file. Leave it be.
        Some(installed) if installed > ours => false,
        // Ours, or older. Either way this build's copy is the right one — and
        // when the stamp already reads our version, the difference means
        // something overwrote us after we wrote it.
        Some(_) => true,
        // Never stamped: written by a build that predates this scheme.
        None => true,
    }
}

fn write_skill_if_agent_present(
    dir: &std::path::Path,
    body: &str,
    version: &str,
) -> std::io::Result<bool> {
    // dir is <home>/<config>/skills/<name> — the agent's own config dir is two
    // levels up and must already exist.
    match dir.parent().and_then(|p| p.parent()) {
        Some(root) if root.exists() => {}
        _ => {
            debug!(?dir, "agent config dir absent — skipping skill install");
            return Ok(false);
        }
    }

    if !should_write(dir, body, version) {
        return Ok(true);
    }

    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("SKILL.md"), body)?;
    // Stamped after the write, so a failed write never claims a version it did
    // not install.
    std::fs::write(dir.join(VERSION_STAMP), format!("{version}\n"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_build_does_not_clobber_a_newer_skill() {
        // Two copies of the app install these on launch. Without this, whichever
        // started last won — and a rewritten skill was silently replaced by an
        // older build's copy while its own session was still running.
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("agent/skills/shipstudio-test");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "new body").unwrap();
        std::fs::write(skill.join(VERSION_STAMP), "3\n").unwrap();

        assert!(
            !should_write(&skill, "old body", "2"),
            "version 2 must leave version 3 alone"
        );
        assert!(
            should_write(&skill, "newer body", "4"),
            "version 4 must upgrade version 3"
        );
    }

    #[test]
    fn a_build_restores_its_own_version_after_something_overwrote_it() {
        // The other half of the same problem: once an older build has clobbered
        // the file, the newer one has to put it back on next launch rather than
        // seeing a matching stamp and leaving the wrong content in place.
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("agent/skills/shipstudio-test");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "clobbered by an older build").unwrap();
        std::fs::write(skill.join(VERSION_STAMP), "2\n").unwrap();

        assert!(should_write(&skill, "our body", "2"));
    }

    #[test]
    fn an_unchanged_skill_is_not_rewritten() {
        // Installation runs on every launch, so the common case must not churn
        // file mtimes.
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("agent/skills/shipstudio-test");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "same body").unwrap();
        std::fs::write(skill.join(VERSION_STAMP), "2\n").unwrap();

        assert!(!should_write(&skill, "same body", "2"));
    }

    #[test]
    fn an_unstamped_skill_is_adopted() {
        // Written by a build that predates the stamp. Taking ownership is what
        // lets the scheme start working at all.
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("agent/skills/shipstudio-test");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "an older copy").unwrap();

        assert!(should_write(&skill, "our body", "2"));
    }

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
