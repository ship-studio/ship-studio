//! The bundled `shipstudio-team` agent skill.
//!
//! The answer to "if I just tell my agent to push, does Harbr know?"
//!
//! Half of it already worked without this: a terminal push produces commits,
//! and [`super::derive`] builds rows from git history, so the work shows up as
//! whatever the commit subject says. What did not work is everything the commit
//! cannot know — *why* the change was made, and which comment threads it
//! addressed. Only the agent that did the work has those, and only for as long
//! as the session lasts.
//!
//! So this teaches the agent to write the records itself. It is the same
//! artifact Harbr writes, in the same directory, read by the same fold —
//! there is no API in front of it, exactly as with the workflows skill. An
//! agent on a teammate's machine that has never opened Harbr still
//! produces rows the rest of the team can read.
//!
//! Registered in `commands::skills::bundled::BUNDLED_SKILLS`, which installs it
//! into each agent's user-scope skills directory on startup — idempotent and
//! version-stamped, so an app update refreshes it and an unchanged version
//! costs one string comparison.

/// Bump when SKILL.md changes so installed copies are refreshed.
const SKILL_VERSION: &str = "4";

/// The skill body.
///
/// Two jobs, and the second is the one that has to be exact: the agent is
/// writing files that everyone on the team reads, so a malformed record is a
/// row nobody can see rather than an error anyone can act on.
/// The skill body.
///
/// Two halves, and they are deliberately unequal. The first says "write a good
/// commit message", which is not a Harbr instruction at all — it is what
/// a good commit has always been, and the feed reads it because git already
/// stores it. The second describes the comment records, which is the only part
/// of this feature that genuinely needs a format of its own.
pub(crate) fn skill_markdown() -> String {
    format!(
        r#"---
name: shipstudio-team
description: >-
  Write commit messages and pull requests that explain themselves, and resolve
  review comments, in a Harbr project. Use this whenever you are about to
  commit or push in a project that has a `.shipstudio/` directory, when the user
  asks you to push, ship, commit or land work there, and whenever you have
  finished acting on comments the user handed you — anything mentioning a
  comment thread id, a pin number, or "the comments I sent you".
metadata:
  shipstudio-skill-version: "{SKILL_VERSION}"
---

# Harbr team

Harbr shows a team what everyone is doing, built from the git repository
rather than a server. It reads two things:

1. **Your commit messages and pull requests** — for what changed and why.
2. **Comment records** under `.shipstudio-team/threads/` — for feedback pinned
   to elements on the live preview.

The first needs no special format. The second does, and is described below.

## Which projects this applies to

Any project with a **`.shipstudio/`** directory in its root. If there is no
`.shipstudio/` directory, this is not a Harbr project: ignore all of this.

## 1. The commit body is the feed

Harbr's feed shows your commit subject as the headline and **your commit
body as the reason**. There is no separate record to write, nothing to file, and
no id to carry — writing a good commit message *is* how the team finds out what
you did.

```
Rebuild the pricing tiers as a CSS grid

The flex row could not hold three columns at 1024px without the third
wrapping under the first two, and the fix people kept reaching for was a
hardcoded width that broke again at every new tier.

Grid also lets the tier badges sit in the card flow instead of being
absolutely positioned, which is what made them drift on mobile.

Made-With: Claude Code
```

- **Subject**: what changed, in plain language a teammate can act on. Not
  `fix: pricing`.
- **Body**: *why*. The reason the change was needed and why you took this
  approach. This is the part a diff cannot show and the part that only exists
  in your session — if you do not write it now, it is gone.
- **`Made-With:`** names you, so the row shows which agent did the work.

Write the body for the person who will read the row next week and has not seen
this conversation. If you genuinely do not know why a change was needed, say
what you observed rather than inventing a motive.

## 2. Pull requests

When you open a PR, the description is read the same way. Same rules: what
changed, why, and anything a reviewer needs to know. Do not restate the diff.

## 3. Comment records

These are the part with no equivalent in git or GitHub. A comment is pinned to
an element on a page at a specific viewport — GitHub has no concept of that, so
Harbr keeps its own records for it.

**If you have `team_open_comments` and `team_resolve_comment` tools, use them.**
They are one call each, they validate what you give them, and they tell you when
something is wrong. You get them automatically inside Harbr's terminal.

Without them, write the files by hand:

```
.shipstudio-team/threads/<YYYY-MM-DD>/<ULID>-<github-login>.json
```

Resolving a thread you have actually finished:

```json
{{
  "v": 1,
  "kind": "resolve",
  "id": "<a new ULID>",
  "thread": "<the thread id from the prompt>",
  "at": 1757308800000,
  "actor": {{ "login": "mayareed", "name": "Maya Reed" }},
  "agent": "Claude Code",
  "resolved": true
}}
```

Replying without resolving, when you could not do what was asked:

```json
{{
  "v": 1,
  "kind": "reply",
  "id": "<a new ULID>",
  "thread": "<the thread id>",
  "at": 1757308800000,
  "actor": {{ "login": "mayareed", "name": "Maya Reed" }},
  "agent": "Claude Code",
  "body": "The heading comes from the CMS, so this needs a content change rather than a code one."
}}
```

Create the directory if it does not exist — it only appears once the first
record is written, so checking for it before writing means never writing one.

### Rules for records

**Resolve a thread only when the work is actually done.** An unresolved thread
with an explanation is useful. A resolved thread that was not fixed is worse
than no feature at all — it is the one failure that makes a team stop trusting
the list.

**Never edit or delete an existing record.** Every file is written once. Two
people writing at the same moment produce two different files, which git merges
with no conflict; editing one in place is a merge conflict in a JSON blob.
Changing your mind means writing another record — the newest one wins.

**One record per file, named by its own id.** `<ULID>-<login>.json`.

**A ULID** is 26 characters of Crockford base32: 10 encoding the timestamp, 16
random. They sort chronologically, which is what orders the feed.

**`at` is milliseconds**, not seconds.

**Do not commit `.shipstudio-team/threads/`.** Comment records travel on their
own git ref, which Harbr manages. They are excluded from your working tree
already — leave them out of your commits.
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_commit_body_is_offered_before_anything_of_ours() {
        // The correction this version exists for. An earlier skill taught a
        // record format that duplicated the commit body into a file only Ship
        // Studio could read — two chances to get one sentence recorded, and a
        // silently empty row whenever the second one was missed.
        let md = skill_markdown();
        let commit = md
            .find("## 1. The commit body is the feed")
            .expect("commit section");
        let records = md.find("## 3. Comment records").expect("records section");
        assert!(commit < records, "our own format is offered before git's");
        assert!(md.contains("no separate record to write"));
    }

    #[test]
    fn it_asks_for_the_why_rather_than_a_restatement_of_the_diff() {
        let md = skill_markdown();
        assert!(md.contains("only exists"));
        assert!(md.contains("Do not restate the diff"));
        assert!(
            md.contains("rather than inventing a motive"),
            "the skill must refuse to let an agent invent a reason"
        );
    }

    #[test]
    fn the_skill_refuses_to_let_an_agent_resolve_work_it_did_not_do() {
        // The one failure that ends the feature: a list of "resolved" threads
        // that were never fixed is worse than having no list.
        let body = skill_markdown();
        assert!(body.contains("Resolve a thread only when the work is actually done"));
        assert!(body.contains("worse"));
    }

    #[test]
    fn the_skill_states_the_append_only_rule_that_makes_merges_work() {
        let body = skill_markdown();
        assert!(body.contains("Never edit or delete an existing record"));
        assert!(body.contains("merge conflict in a JSON blob"));
    }

    #[test]
    fn the_description_names_the_moments_an_agent_would_actually_be_in() {
        // Compared with whitespace collapsed, because the description is a
        // folded YAML scalar: the line breaks are the file's, not the phrase's.
        let md = skill_markdown();
        let flat = md.split_whitespace().collect::<Vec<_>>().join(" ");
        for phrase in [
            "about to commit or push",
            "push, ship, commit or land",
            "the comments I sent you",
        ] {
            assert!(
                flat.contains(phrase),
                "the skill must still trigger on \"{phrase}\""
            );
        }
    }

    #[test]
    fn the_record_shape_matches_what_the_reader_parses() {
        // The skill is the only specification an agent without the tools gets,
        // so a field named wrong here produces files that fold into nothing and
        // a feed that silently stays empty.
        let md = skill_markdown();
        for field in [
            "\"kind\": \"resolve\"",
            "\"kind\": \"reply\"",
            "\"thread\"",
            "\"resolved\": true",
        ] {
            assert!(md.contains(field), "the skill must still document {field}");
        }
        assert!(md.contains("`at` is milliseconds"));
    }

    #[test]
    fn it_sends_an_agent_to_the_tools_before_the_hand_written_files() {
        let md = skill_markdown();
        let tools = md.find("use them.**").expect("the tools are offered");
        let files = md.find("write the files by hand").expect("the fallback");
        assert!(
            tools < files,
            "hand-written files are offered before the tools"
        );
        assert!(md.contains("team_open_comments"));
        assert!(md.contains("team_resolve_comment"));
    }

    #[test]
    fn the_feature_can_bootstrap_itself_in_a_project_that_has_no_records_yet() {
        // A bug this skill shipped with: it told the agent to check for
        // `.shipstudio-team/` and do nothing if it was missing. That directory
        // only exists once a record has been written, so a team whose pushes
        // all come from an agent could never write the first one.
        let md = skill_markdown();
        assert!(
            md.contains("Create the directory if it does not exist"),
            "the skill must tell the agent to create the records directory"
        );
        assert!(md.contains("checking for it before writing means never writing one"));
    }

    #[test]
    fn it_marks_a_ship_studio_project_by_the_directory_that_always_exists() {
        let md = skill_markdown();
        let flat = md.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(flat.contains("Any project with a **`.shipstudio/`** directory"));
        assert!(flat.contains("If there is no `.shipstudio/` directory"));
    }

    #[test]
    fn it_keeps_comment_records_out_of_the_users_commits() {
        let md = skill_markdown();
        assert!(md.contains("Do not commit `.shipstudio-team/threads/`"));
    }
}
