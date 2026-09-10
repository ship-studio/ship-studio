//! Making a legible commit the default, in the one place an agent always reads.
//!
//! A skill has to *trigger*. Its description competes for attention against
//! everything else in a session, and "push" is a one-word prompt that carries
//! almost no signal — so a skill fires often enough to be useful and not often
//! enough to be relied on. That is the whole reason the feed kept coming back
//! with rows that said nothing.
//!
//! A project's agent instructions do not have that problem. `CLAUDE.md` and
//! `AGENTS.md` are read at the start of every session in that project, by every
//! agent, whether or not anything triggers. Four lines there are worth more than
//! any amount of skill copy.
//!
//! ## What this writes, and what it will not do
//!
//! One clearly-marked block, appended once, saying what a good commit message
//! looks like. It is:
//!
//! - **The user's file.** Existing content is never rewritten or reordered, and
//!   the block goes at the end.
//! - **Marked**, so a person can find it and delete it, and so this can tell
//!   whether it is already there without matching on prose.
//! - **Written once.** If someone removes it, it stays removed — re-adding it
//!   on the next launch would be arguing with them through a file.
//! - **Committed by them, or not.** These files are usually tracked, so this is
//!   a change to their repository. It happens on an explicit action, never on
//!   startup behind their back.

use std::path::{Path, PathBuf};

use crate::errors::CommandError;

/// The files agents read at the start of a session, in preference order.
const INSTRUCTION_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

/// Marks the block as ours, so it can be found without matching on prose.
const BEGIN: &str = "<!-- ship-studio:commit-messages -->";
const END: &str = "<!-- /ship-studio:commit-messages -->";

/// What gets appended.
///
/// Deliberately about commit messages rather than about Harbr. Everything
/// here is good practice on its own — it helps `git log`, GitHub, and code
/// review — and it happens to be exactly what the Team feed reads. An
/// instruction that only pays off inside one app is one a team will delete.
fn block() -> String {
    format!(
        "{BEGIN}\n\
         ## Commit messages\n\
         \n\
         Write the body, not just the subject. The subject says *what* changed; \
         the body says *why*, and that is the part a diff can never show and the \
         part that only exists while you are still in the session that made the \
         change.\n\
         \n\
         ```\n\
         Rebuild the pricing tiers as a CSS grid\n\
         \n\
         The flex row could not hold three columns at 1024px without the third\n\
         wrapping, and the fix people kept reaching for was a hardcoded width\n\
         that broke again at every new tier.\n\
         ```\n\
         \n\
         - One line of subject, in plain language a teammate can act on.\n\
         - A short paragraph of reasoning. Skip it only when there genuinely is \
         none — a typo fix does not need one.\n\
         - Do not restate the diff. Say what it was for.\n\
         - If you do not know why a change was needed, say what you observed \
         rather than inventing a motive.\n\
         \n\
         The same applies to pull request descriptions.\n\
         {END}\n"
    )
}

/// Whether this project already carries the block.
pub fn is_installed(project: &Path) -> bool {
    instruction_path(project)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|text| text.contains(BEGIN))
}

/// The instruction file to write to: whichever exists, else `CLAUDE.md`.
fn instruction_path(project: &Path) -> Option<PathBuf> {
    INSTRUCTION_FILES
        .iter()
        .map(|name| project.join(name))
        .find(|path| path.exists())
        .or_else(|| Some(project.join(INSTRUCTION_FILES[0])))
}

/// Append the block. Returns the file it went into.
///
/// Idempotent: a project that already has it is left exactly as it is, so this
/// can be offered more than once without stacking up copies.
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn install_commit_guidance(project_path: String) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let Some(path) = instruction_path(&project) else {
        return Err(CommandError::expected(
            "Couldn't work out where this project keeps its agent instructions.",
        ));
    };

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(BEGIN) {
        return Ok(path.to_string_lossy().into_owned());
    }

    // Appended, with one blank line, so an existing file keeps its shape.
    let separator = if existing.is_empty() {
        String::new()
    } else if existing.ends_with("\n\n") {
        String::new()
    } else if existing.ends_with('\n') {
        "\n".to_string()
    } else {
        "\n\n".to_string()
    };

    std::fs::write(&path, format!("{existing}{separator}{}", block()))
        .map_err(CommandError::from)?;
    tracing::info!(path = %path.display(), "wrote commit guidance");
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_is_about_commit_messages_rather_than_about_this_app() {
        // An instruction that only pays off inside one app is one a team
        // deletes. Everything here helps `git log` and code review too.
        let text = block();
        assert!(!text.contains("Harbr"), "the block sells the app");
        assert!(text.contains("the body says *why*"));
        assert!(text.contains("Do not restate the diff"));
        assert!(text.contains("rather than inventing a motive"));
    }

    #[test]
    fn it_appends_without_disturbing_what_was_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("CLAUDE.md");
        std::fs::write(&path, "# Our rules\n\nUse tabs.\n").unwrap();

        let existing = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{existing}\n{}", block())).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("# Our rules\n\nUse tabs.\n"));
        assert!(after.contains(BEGIN) && after.contains(END));
    }

    #[test]
    fn a_project_that_has_the_block_is_recognised() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installed(dir.path()));

        std::fs::write(dir.path().join("CLAUDE.md"), block()).unwrap();
        assert!(is_installed(dir.path()));
    }

    #[test]
    fn agents_md_is_used_when_that_is_what_the_project_has() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "# Rules\n").unwrap();

        let chosen = instruction_path(dir.path()).unwrap();
        assert!(chosen.ends_with("AGENTS.md"), "wrote to the wrong file");
    }

    #[test]
    fn claude_md_wins_when_a_project_has_both() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# C\n").unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "# A\n").unwrap();

        assert!(instruction_path(dir.path()).unwrap().ends_with("CLAUDE.md"));
    }

    #[test]
    fn a_project_with_neither_file_gets_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        assert!(instruction_path(dir.path()).unwrap().ends_with("CLAUDE.md"));
    }
}
