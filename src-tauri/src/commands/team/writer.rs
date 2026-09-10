//! Checking what an agent wrote, before it becomes permanent.
//!
//! This is the last thing between a model's sentence and a commit message, so
//! it is the only code here where being wrong is permanent. A commit message
//! is published history: unpublishing means rewriting history, there is no
//! server to scrub, and a leak that reaches one teammate's clone has reached
//! everyone's. The human is the last filter, not the first.
//!
//! ## The agent writes four fields and nothing else
//!
//! `headline`, `why`, `changes`, `asks`. Not a branch, not a file list, not a
//! timestamp, not a status. Those are read back out of git when the feed is
//! built ([`super::snapshot`]), so a summary physically cannot carry evidence
//! that disagrees with the repo, and a model that invents a fact produces a
//! row that shows the real one.
//!
//! ## What is enforced, and what is only asked for
//!
//! | Enforced here, in Rust | Asked for in the prompt |
//! | --- | --- |
//! | the field allowlist | "write about the code, not the session" |
//! | length caps | "don't quote the user" |
//! | shape (no fences, quotes, diffs) | "don't characterise a teammate's work" |
//! | absolute paths rewritten | |
//! | secret scan | |
//!
//! **Shape, length and known-dangerous strings can be enforced. Meaning
//! cannot.** There is no mechanical answer for "the agent repeated something
//! unkind the user said about a colleague", and pretending otherwise with a
//! detector nobody trusts is worse than stating the limit.
//!
//! ## Two decisions worth defending
//!
//! **Over-length is a rejection, not a truncation.** Truncating at 600
//! characters publishes the first 600 characters of a leak and calls it
//! handled.
//!
//! **A detected secret is a hard refusal that says rotate it.** Silently
//! redacting turns "your key is in a diff an agent just read" into a thing
//! nobody knew happened. The key is already compromised by the time we see it
//! here; the only useful output is telling someone.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::errors::CommandError;

/// The four fields an agent may write. Nothing else is accepted.
///
/// `deny_unknown_fields` is the load-bearing attribute: without it an agent
/// could add `"transcript": "..."` and serde would quietly ignore it while the
/// raw JSON went into the repo anyway.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TeamSummary {
    pub headline: String,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub asks: Option<String>,
}

/// Hard caps. Over-length is rejected, never trimmed.
const MAX_HEADLINE: usize = 120;
const MAX_WHY: usize = 600;
const MAX_CHANGES: usize = 8;
const MAX_CHANGE: usize = 200;
const MAX_ASKS: usize = 300;

/// Prefixes that are a leaked credential wherever they appear. Deliberately
/// short: a list that tries to be exhaustive gives false confidence, and the
/// project's own `.env` values are the half that actually matters.
const SECRET_PREFIXES: &[&str] = &[
    "sk-ant-",
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "AKIA",
    "ASIA",
    "AIza",
    "-----BEGIN ",
];

/// The shortest `.env` value worth treating as a secret. Below this the
/// false-positive rate makes the check useless: a `PORT=3000` would refuse
/// every record mentioning a three-digit number.
const MIN_ENV_SECRET_LEN: usize = 12;

fn reject(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.to_string(),
        reason: reason.into(),
    }
}

/// Shapes that mean "this is not a sentence about the code".
///
/// A mechanical proxy for the thing that cannot be checked directly. An agent
/// pasting its session, a diff, or a quoted conversation produces text with
/// these markers, and none of them belong in a one-line summary of a change.
fn check_shape(field: &str, text: &str) -> Result<(), CommandError> {
    if text.contains("```") {
        return Err(reject(
            field,
            "contains a code fence. Team updates are prose about the change, not code — the \
             code is already in the commit.",
        ));
    }
    if text.lines().any(|line| line.trim_start().starts_with('>')) {
        return Err(reject(
            field,
            "contains a quoted line. Team updates never quote the conversation that produced \
             the change.",
        ));
    }
    if text.lines().any(|line| {
        let t = line.trim_start();
        // `+++`/`---` and single +/- at line start are diff hunks. A sentence
        // may legitimately begin with a hyphen-minus followed by a space, so
        // only the tight forms count.
        t.starts_with("+++") || t.starts_with("@@") || (t.starts_with('+') && t.len() > 1)
    }) {
        return Err(reject(
            field,
            "looks like a diff. The diff is already in the commit; this field is for what it \
             means.",
        ));
    }
    // A paragraph or two is prose. Five is a transcript.
    if text.matches('\n').count() > 2 {
        return Err(reject(
            field,
            "has too many line breaks to be a summary. Team updates are a sentence or two.",
        ));
    }
    Ok(())
}

/// Rewrite absolute local paths to repo-relative ones.
///
/// A path is not secret, but `/Users/julian/Desktop/Projects/clientname/...`
/// discloses the machine, the human and often the client, permanently, to
/// everyone with repo access.
fn relativise(text: &str, project: &Path) -> String {
    let root = project.to_string_lossy();
    let stripped = if root.is_empty() {
        text.to_string()
    } else {
        text.replace(&format!("{root}/"), "")
            .replace(root.as_ref(), "")
    };
    // Anything still absolute belongs to some other tree; scrub the username
    // out of it with the same helper the crash reporter uses.
    crate::logging::scrub_string(&stripped)
}

/// Values from the project's `.env*` files that are long enough to be secrets.
fn env_secrets(project: &Path) -> Vec<String> {
    let mut values = Vec::new();
    let Ok(entries) = std::fs::read_dir(project) else {
        return values;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".env") {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let Some((_, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if value.len() >= MIN_ENV_SECRET_LEN {
                values.push(value.to_string());
            }
        }
    }
    values
}

/// Refuse, and say what to do about it.
fn check_secrets(field: &str, text: &str, secrets: &[String]) -> Result<(), CommandError> {
    for prefix in SECRET_PREFIXES {
        if let Some(at) = text.find(prefix) {
            // Never echo the key itself into an error that may be logged.
            let _ = at;
            return Err(reject(
                field,
                format!(
                    "looks like it contains a credential (starts with `{prefix}`). Nothing was \
                     written. Treat that key as compromised and rotate it — an agent had it in \
                     context, which is how it got here."
                ),
            ));
        }
    }
    for secret in secrets {
        if text.contains(secret.as_str()) {
            return Err(reject(
                field,
                "contains a value from this project's .env. Nothing was written. Treat that \
                 value as compromised and rotate it.",
            ));
        }
    }
    Ok(())
}

/// Put a summary through everything above.
///
/// Returns the cleaned summary, or the first reason it cannot be published.
/// Never partially publishes: a single bad field rejects the whole record,
/// because a record missing the field that explained it is worse than none.
pub fn gauntlet(project: &Path, summary: &TeamSummary) -> Result<TeamSummary, CommandError> {
    let secrets = env_secrets(project);

    let check = |field: &str, text: &str, max: usize| -> Result<String, CommandError> {
        let text = text.trim();
        if text.chars().count() > max {
            return Err(reject(
                field,
                format!(
                    "is {} characters; the limit is {max}. It is rejected rather than cut short, \
                     because half a sentence in permanent history is worse than none.",
                    text.chars().count()
                ),
            ));
        }
        check_shape(field, text)?;
        let text = relativise(text, project);
        check_secrets(field, &text, &secrets)?;
        Ok(text)
    };

    let headline = check("headline", &summary.headline, MAX_HEADLINE)?;
    if headline.is_empty() {
        return Err(reject(
            "headline",
            "is empty. A record with no sentence is a git log entry.",
        ));
    }

    let why = match summary
        .why
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(text) => Some(check("why", text, MAX_WHY)?),
        None => None,
    };

    if summary.changes.len() > MAX_CHANGES {
        return Err(reject(
            "changes",
            format!(
                "has {} entries; the limit is {MAX_CHANGES}. A list longer than that is the diff \
                 again, and the diff is already in the commit.",
                summary.changes.len()
            ),
        ));
    }
    let mut changes = Vec::with_capacity(summary.changes.len());
    for change in &summary.changes {
        let text = change.trim();
        if text.is_empty() {
            continue;
        }
        changes.push(check("changes", text, MAX_CHANGE)?);
    }

    let asks = match summary
        .asks
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(text) => Some(check("asks", text, MAX_ASKS)?),
        None => None,
    };

    Ok(TeamSummary {
        headline,
        why,
        changes,
        asks,
    })
}

/// A ULID: 48 bits of milliseconds then 80 bits of randomness, Crockford
/// base32. Chronologically sortable, unique with no coordination — which is
/// what lets two machines name files that will never collide and will always
/// sort into the order they were written.
pub fn ulid() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut out = [0u8; 26];
    let mut time = ms;
    for slot in out[..10].iter_mut().rev() {
        *slot = ALPHABET[(time % 32) as usize];
        time /= 32;
    }
    // Randomness from the OS via a throwaway HashMap seed is not available
    // here, so use the nanosecond tail plus the address of a stack local —
    // enough entropy that two records written in the same millisecond on the
    // same machine differ, which is the only collision that matters.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u128)
        .unwrap_or(0);
    let local = 0u8;
    let mut seed = nanos ^ (&local as *const u8 as u128) ^ (std::process::id() as u128) << 17;
    for slot in out[10..].iter_mut() {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *slot = ALPHABET[((seed >> 33) % 32) as usize];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Today as `YYYY-MM-DD`, the day directory every record is filed under.
///
/// Used by [`super::threads`], the only writer left: bucketing by day keeps a
/// long-lived project's comments off one enormous directory listing, and the
/// date is already the leading sort key, so it costs nothing to read back.
pub fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Days since the epoch to a calendar date, without pulling in chrono for
    // one line. Civil-from-days, Howard Hinnant's algorithm.
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The commit message a summary becomes.
///
/// The only place this prose is written. It survives without the app: someone
/// who has never installed Harbr still gets the explanation, from
/// `git log`, from the pull request, from GitHub's blame view — and so does
/// anyone reading the repository in ten years.
pub fn commit_message(summary: &TeamSummary) -> String {
    let mut message = summary.headline.clone();
    if let Some(why) = &summary.why {
        message.push_str("\n\n");
        message.push_str(why);
    }
    if !summary.changes.is_empty() {
        message.push('\n');
        for change in &summary.changes {
            message.push_str(&format!("\n- {change}"));
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(headline: &str) -> TeamSummary {
        TeamSummary {
            headline: headline.to_string(),
            ..Default::default()
        }
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ss-writer-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn an_agent_cannot_invent_a_field() {
        let err = serde_json::from_str::<TeamSummary>(
            r#"{"headline":"Fix the nav","transcript":"the user said..."}"#,
        )
        .expect_err("deny_unknown_fields rejects it");
        assert!(err.to_string().contains("transcript"), "{err}");
    }

    #[test]
    fn over_length_is_a_rejection_not_a_trim() {
        let dir = tmp("len");
        let long = "x".repeat(200);
        let err = gauntlet(&dir, &summary(&long)).expect_err("refuses");
        let message = err.to_string();
        assert!(message.contains("120"), "{message}");
        // The point of the rule, stated where someone will read it.
        assert!(message.contains("rather than cut short"), "{message}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_pasted_session() {
        let dir = tmp("shape");
        for bad in [
            "Fix the nav\n```\ncode\n```",
            "Fix the nav\n> you said the header was broken",
            "Fix the nav\n+++ b/src/nav.tsx",
            "Fix the nav\n+const x = 1",
            "one\ntwo\nthree\nfour",
        ] {
            assert!(
                gauntlet(&dir, &summary(bad)).is_err(),
                "should have refused: {bad:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sentence_that_merely_starts_with_a_hyphen_is_still_a_sentence() {
        let dir = tmp("hyphen");
        let ok = gauntlet(&dir, &summary("Fix the nav - it collapsed under 768px"));
        assert!(ok.is_ok(), "{ok:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_credential_and_says_to_rotate_it() {
        let dir = tmp("secret");
        let err = gauntlet(
            &dir,
            &summary("Rotated the key to sk-ant-api03-AAAABBBBCCCCDDDD"),
        )
        .expect_err("refuses");
        let message = err.to_string();
        assert!(message.contains("rotate"), "{message}");
        // Never echo the key back into a message that may be logged.
        assert!(!message.contains("AAAABBBBCCCC"), "{message}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_value_from_the_projects_own_env() {
        let dir = tmp("env");
        std::fs::write(
            dir.join(".env.local"),
            "PORT=3000\nSTRIPE_KEY=\"tot4lly-s3cret-value-here\"\n",
        )
        .expect("write");

        let err = gauntlet(&dir, &summary("Used tot4lly-s3cret-value-here for billing"))
            .expect_err("refuses");
        assert!(err.to_string().contains("rotate"), "{err}");

        // PORT=3000 is too short to be a secret, and treating it as one would
        // refuse every record that mentions a three-digit number.
        assert!(gauntlet(&dir, &summary("Moved the dev server to 3000")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrites_an_absolute_path_to_a_repo_relative_one() {
        let dir = tmp("paths");
        let text = format!("Fixed {}/src/nav.tsx", dir.display());
        let clean = gauntlet(&dir, &summary(&text)).expect("passes");
        assert_eq!(clean.headline, "Fixed src/nav.tsx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scrubs_a_username_out_of_a_path_belonging_to_another_tree() {
        let dir = tmp("otherpath");
        let clean =
            gauntlet(&dir, &summary("Compared with /Users/julian/other/app.tsx")).expect("passes");
        assert!(!clean.headline.contains("julian"), "{}", clean.headline);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_bad_field_rejects_the_whole_record() {
        let dir = tmp("whole");
        let bad = TeamSummary {
            headline: "Rebuild the pricing tiers".to_string(),
            why: Some("x".repeat(700)),
            ..Default::default()
        };
        assert!(gauntlet(&dir, &bad).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_the_number_of_changes() {
        let dir = tmp("changes");
        let many = TeamSummary {
            headline: "Rebuild the pricing tiers".to_string(),
            changes: (0..20).map(|i| format!("change {i}")).collect(),
            ..Default::default()
        };
        assert!(gauntlet(&dir, &many).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ulids_are_unique_and_sort_by_time() {
        let a = ulid();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = ulid();
        assert_eq!(a.len(), 26);
        assert_ne!(a, b);
        assert!(a < b, "{a} should sort before {b}");
        assert!(a
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    }

    #[test]
    fn the_commit_message_is_the_summary() {
        let message = commit_message(&TeamSummary {
            headline: "Rebuild the pricing tiers as a CSS grid".to_string(),
            why: Some("The flex row could not hold three columns at 1024px.".to_string()),
            changes: vec!["Replace the flex row with a 3-up grid".to_string()],
            asks: Some("Worth a look at the middle tier.".to_string()),
        });
        assert_eq!(
            message,
            "Rebuild the pricing tiers as a CSS grid\n\n\
             The flex row could not hold three columns at 1024px.\n\n\
             - Replace the flex row with a 3-up grid"
        );
        // `asks` is addressed to a reader of the feed, not to a reader of the
        // history. It is the one field that does not belong in a commit.
        assert!(!message.contains("Worth a look"));
    }
}
