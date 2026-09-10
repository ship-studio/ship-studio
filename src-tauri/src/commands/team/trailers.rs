//! What Harbr leaves behind in git history.
//!
//! Every commit the app makes goes through `git_stage_and_commit`, and every one
//! of them passes through here first. One trailer, machine-readable, out of the
//! subject line:
//!
//! ```text
//! Rebuild the pricing tiers as a CSS grid
//!
//! The flex row could not hold three columns at 1024px without the third
//! wrapping under the first two.
//!
//! Made-With: Claude Code in Harbr
//! ```
//!
//! `Made-With` is attribution — the same idea as Claude Code's `Co-Authored-By`,
//! and the same restraint: a trailer, never the subject, so `git log --oneline`
//! reads exactly as it did before. On by default, one setting to turn off.
//!
//! There was briefly a second one, `Ship-Studio-Update`, joining a commit to a
//! record file that explained it. Both halves of that are gone: the explanation
//! is the commit body now, so there is nothing left to join to.
//!
//! ## Why git formats these and not us
//!
//! Appending a trailer *looks* like string concatenation and is not. Trailers
//! must live in the message's last paragraph, with a blank line before the block
//! but no blank line inside it — so appending to `"Fix the nav"` needs a blank
//! line and appending to a message already ending in `Co-Authored-By:` must not
//! have one. Get that wrong and git stops recognising the whole block, which
//! silently breaks both the attribution and the join key.
//!
//! `git interpret-trailers` is git's own implementation of those rules,
//! including `--if-exists doNothing` for the re-commit case. It is local,
//! instant, and cannot disagree with the `%(trailers:…)` reader on the other
//! side of this feature. Reimplementing it to save a process spawn would be
//! trading correctness for nothing.

use crate::errors::CommandError;

/// Attribution. Mirrors what Claude Code does with `Co-Authored-By`.
pub const MADE_WITH_TRAILER: &str = "Made-With";

/// Whether commits carry the `Made-With` attribution trailer.
///
/// Defaults to on. It is a trailer rather than a subject-line suffix, so the
/// cost of leaving it on is one line at the bottom of a message nobody reads
/// twice — and the benefit is that a teammate reading the history can tell
/// which tool wrote what.
pub fn attribution_enabled() -> bool {
    crate::commands::setup::read_app_state()
        .commit_attribution_enabled
        .unwrap_or(true)
}

/// How an agent names itself in the trailer.
///
/// The display name of the project's configured agent — "Claude Code", "Codex",
/// "Cursor". `None` when Harbr committed on its own (a snapshot, a
/// conflict resolution, an initial commit), in which case the trailer says only
/// Harbr rather than crediting an agent that had nothing to do with it.
pub fn agent_label(agent: Option<&str>) -> String {
    match agent {
        Some(agent) if !agent.trim().is_empty() => {
            format!("{} in Harbr", agent.trim())
        }
        _ => "Harbr".to_string(),
    }
}

/// Add Harbr's trailers to a commit message.
///
/// Returns the message unchanged when the user has turned attribution off, or
/// when git cannot run `interpret-trailers` — a commit must never fail because
/// of its own footer.
pub fn with_trailers(repo: &std::path::Path, message: &str, agent: Option<&str>) -> String {
    if !attribution_enabled() {
        return message.to_string();
    }
    let trailers = [format!("{MADE_WITH_TRAILER}: {}", agent_label(agent))];

    match interpret_trailers(repo, message, &trailers) {
        Ok(out) => out,
        Err(error) => {
            // A missing git, a locked repo, a hook-mangled environment. The
            // commit is the thing that matters; the footer is not.
            tracing::warn!(%error, "could not add Harbr trailers; committing as-is");
            message.to_string()
        }
    }
}

/// The footer added to pull request descriptions Harbr opens.
///
/// A PR body is markdown on a web page, not a commit message, so the git
/// trailer rules do not apply and `interpret-trailers` is the wrong tool. What
/// carries over is the restraint: one line, at the bottom, under a rule, after
/// whatever the description actually says.
///
/// Deliberately says nothing the reader has to act on. A PR description is read
/// by people deciding whether to approve a change, and an advertisement above
/// the fold is a tax on every one of those readings.
pub fn pr_footer(agent: Option<&str>) -> Option<String> {
    attribution_enabled().then(|| match agent {
        Some(agent) if !agent.trim().is_empty() => format!(
            "---\n\n*Opened from [Harbr](https://github.com/kacigaya/harbr), described by {}.*",
            agent.trim()
        ),
        _ => "---\n\n*Opened from [Harbr](https://github.com/kacigaya/harbr).*".to_string(),
    })
}

/// A pull request description with the footer on it.
///
/// Never appended twice: reopening or editing a PR whose body already carries
/// the line must not stack them.
pub fn with_pr_footer(body: &str, agent: Option<&str>) -> String {
    let Some(footer) = pr_footer(agent) else {
        return body.to_string();
    };
    // Match on the stable half of the sentence, so a body carrying the
    // no-agent variant is not given the with-agent one on a later edit.
    if body.contains("[Harbr](https://github.com/kacigaya/harbr)") {
        return body.to_string();
    }
    let trimmed = body.trim_end();
    if trimmed.is_empty() {
        return footer;
    }
    format!("{trimmed}\n\n{footer}")
}

/// Hand the message to `git interpret-trailers` and read it back.
fn interpret_trailers(
    repo: &std::path::Path,
    message: &str,
    trailers: &[String],
) -> Result<String, CommandError> {
    let mut cmd = crate::utils::git_command_in(repo)?;
    cmd.arg("interpret-trailers");
    for trailer in trailers {
        // `doNothing` rather than `replace`: re-committing a message that
        // already carries these must not churn them, and a user who edited a
        // trailer by hand has said something we should not overrule.
        cmd.args(["--if-exists", "doNothing", "--trailer", trailer]);
    }
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(CommandError::from)?;
    {
        use std::io::Write;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| CommandError::from("git interpret-trailers took no stdin"))?;
        stdin
            .write_all(message.as_bytes())
            .map_err(CommandError::from)?;
        // Dropped here, closing the pipe. Without this the child waits for EOF
        // and `wait_with_output` waits for the child: a deadlock, not an error.
    }

    let output = child.wait_with_output().map_err(CommandError::from)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string().into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ss-trailers-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let out = std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(&dir)
            .output()
            .expect("git init");
        assert!(out.status.success());
        dir
    }

    fn run(dir: &std::path::Path, message: &str, trailers: &[&str]) -> String {
        let owned: Vec<String> = trailers.iter().map(|t| t.to_string()).collect();
        interpret_trailers(dir, message, &owned).expect("interpret-trailers runs")
    }

    #[test]
    fn names_the_agent_when_one_did_the_work_and_does_not_when_none_did() {
        assert_eq!(agent_label(Some("Claude Code")), "Claude Code in Harbr");
        assert_eq!(agent_label(Some("  Codex  ")), "Codex in Harbr");
        // A snapshot or a conflict resolution has no agent behind it, and
        // crediting one that was not there is the invention this rule forbids.
        assert_eq!(agent_label(None), "Harbr");
        assert_eq!(agent_label(Some("   ")), "Harbr");
    }

    #[test]
    fn a_one_line_message_gets_a_blank_line_before_the_trailer() {
        let dir = repo("oneline");
        let out = run(&dir, "Fix the nav\n", &["Made-With: Harbr"]);
        assert_eq!(out, "Fix the nav\n\nMade-With: Harbr\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_message_with_a_body_keeps_the_body_and_the_blank_line() {
        let dir = repo("body");
        let out = run(
            &dir,
            "Fix the nav\n\nIt collapsed under 768px.\n",
            &["Made-With: Harbr"],
        );
        assert_eq!(
            out,
            "Fix the nav\n\nIt collapsed under 768px.\n\nMade-With: Harbr\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn joins_an_existing_trailer_block_without_splitting_it() {
        // The case a hand-rolled implementation gets wrong. An extra blank line
        // here would end the trailer block, and git would stop reading *both*
        // trailers — silently breaking attribution and the join key at once.
        let dir = repo("existing");
        let out = run(
            &dir,
            "Fix the nav\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
            &["Made-With: Claude Code in Harbr"],
        );
        assert_eq!(
            out,
            "Fix the nav\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\
             Made-With: Claude Code in Harbr\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_adds_a_trailer_the_message_already_carries() {
        let dir = repo("dupe");
        let once = run(&dir, "Fix the nav\n", &["Made-With: Harbr"]);
        let twice = run(&dir, &once, &["Made-With: Harbr"]);
        assert_eq!(once, twice);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_trailers_land_in_one_block_and_git_reads_them_back() {
        // Harbr writes one trailer, but never into an empty footer: an
        // agent's commit usually already carries `Co-Authored-By`, and the
        // block rules are exactly where hand-rolled concatenation goes wrong.
        let dir = repo("roundtrip");
        let message = run(
            &dir,
            "Rebuild the pricing tiers\n\nCo-Authored-By: Someone <s@example.com>\n",
            &["Made-With: Claude Code in Harbr"],
        );

        // The half that matters: git's own reader, the one `derive.rs` uses,
        // finds what this wrote — and finds the trailer that was already there
        // too. A footer git cannot parse costs the attribution silently.
        let out = std::process::Command::new("git")
            .args(["interpret-trailers", "--parse"])
            .current_dir(&dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child
                    .stdin
                    .take()
                    .expect("stdin")
                    .write_all(message.as_bytes())?;
                child.wait_with_output()
            })
            .expect("parse runs");
        let parsed = String::from_utf8_lossy(&out.stdout);
        assert!(
            parsed.contains("Made-With: Claude Code in Harbr"),
            "{parsed}"
        );
        assert!(
            parsed.contains("Co-Authored-By: Someone <s@example.com>"),
            "{parsed}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The loop the whole feature closes: commit through the app's real funnel,
    /// then read the result back with the feed's own parser.
    ///
    /// Both halves are tested separately above and both can pass while the
    /// feature is broken — a trailer written in a shape `derive.rs` does not
    /// recognise is a join key that silently never joins, and nothing would say
    /// so. This is the only test that would notice.
    #[test]
    fn a_commit_made_by_ship_studio_is_read_back_by_the_feed() {
        let dir = repo("roundtrip-real");
        for args in [
            ["config", "user.name", "Maya Reed"],
            [
                "config",
                "user.email",
                "9+mayareed@users.noreply.github.com",
            ],
            ["config", "commit.gpgsign", "false"],
        ] {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git config");
            assert!(out.status.success());
        }
        std::fs::write(dir.join("a.txt"), "one\n").expect("write");

        let committed = crate::commands::git::git_stage_and_commit_authored(
            &dir,
            "Rebuild the pricing tiers as a CSS grid",
            Some("Claude Code"),
        )
        .expect("commits");
        assert!(committed);

        // Read it the way `derive::walk_commits` does — through git's own
        // `%(trailers:…)` reader, not by grepping the message.
        let out = std::process::Command::new("git")
            .args([
                "log",
                "-1",
                &format!("--format=%s|%(trailers:key={MADE_WITH_TRAILER},valueonly=true)"),
            ])
            .current_dir(&dir)
            .output()
            .expect("git log");
        let line = String::from_utf8_lossy(&out.stdout);
        let (subject, made_with) = line.trim().split_once('|').expect("both fields");

        assert_eq!(
            subject, "Rebuild the pricing tiers as a CSS grid",
            "`git log --oneline` must read exactly as it did before"
        );
        assert_eq!(made_with.trim(), "Claude Code in Harbr");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pr_footer_goes_under_the_description_never_over_it() {
        let body = with_pr_footer("## What changed\n\nThe pricing grid.", Some("Claude Code"));
        assert!(
            body.starts_with("## What changed"),
            "a reader deciding whether to approve this sees the change first"
        );
        assert!(body.ends_with("described by Claude Code.*"));
        assert!(body.contains("\n\n---\n\n"));
    }

    #[test]
    fn the_pr_footer_credits_nobody_when_the_description_fell_back() {
        // The submit flow drops to a branch-name title whenever the agent is
        // unavailable or fails. Naming one there is the same invention the
        // commit trailer refuses to make.
        let body = with_pr_footer("Bare description.", None);
        assert!(body.ends_with("*Opened from [Harbr](https://github.com/kacigaya/harbr).*"));
        assert!(!body.contains("described by"));
    }

    #[test]
    fn an_empty_description_gets_the_footer_alone_with_no_leading_blank() {
        let body = with_pr_footer("", None);
        assert!(body.starts_with("---"));
    }

    #[test]
    fn editing_a_pr_never_stacks_the_footer() {
        let once = with_pr_footer("The pricing grid.", Some("Claude Code"));
        let twice = with_pr_footer(&once, Some("Claude Code"));
        assert_eq!(once, twice);
        // Including across the two variants — a body carrying the no-agent
        // line must not later collect the with-agent one as well.
        let mixed = with_pr_footer(&with_pr_footer("x", None), Some("Codex"));
        assert_eq!(
            mixed
                .matches("Harbr](https://github.com/kacigaya/harbr)")
                .count(),
            1
        );
    }

    #[test]
    fn a_subject_is_never_touched() {
        let dir = repo("subject");
        for message in [
            "wip\n",
            "feat(nav): collapse under 768px\n",
            "Merge pull request #139 from acme/copy-tweaks\n",
        ] {
            let out = run(&dir, message, &["Made-With: Harbr"]);
            assert_eq!(
                out.lines().next().unwrap(),
                message.trim_end(),
                "the subject line must survive verbatim — `git log --oneline` \
                 has to read exactly as it did before"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
