//! What a push writes, beyond the code.
//!
//! One agent call, one place the answer lands:
//!
//! ```text
//! summarise the working tree  ->  the commit message (subject + why)
//! ```
//!
//! That is the whole thing, and *why* it is the whole thing is the decision
//! this module exists to record. An earlier version wrote a second copy of the
//! same prose into a record file under `.shipstudio-team/`, joined to its commit by a
//! trailer: a format only Harbr could read, describing something git
//! already knew, giving every writer two chances to get one sentence recorded
//! and a silent empty row whenever they got the second one wrong.
//!
//! A commit body is where "why" belongs. `git log` shows it, GitHub shows it,
//! and a teammate who has never opened this app shows it. So the job here is to
//! make the commit *good*, not to invent somewhere else to put the explanation.
//!
//! ## Everything here is optional, and the push never waits on it
//!
//! No agent, no headless mode, a timeout, an unparseable reply, a summary the
//! gauntlet refuses: every one of them falls back to a plain commit and pushes.
//! A team feature that can stop you shipping is a team feature people turn off.

use super::writer;

/// What a push should commit, once the agent has had its say.
pub struct PushContent {
    /// The full commit message: subject, then the body carrying the *why*.
    pub message: String,
    /// The agent that wrote it, for the `Made-With` trailer.
    pub agent: Option<&'static str>,
}

/// Whether pushes ask an agent to write the commit message.
///
/// On by default: a feed of bare subject lines is the GitHub half forever,
/// which is the state this whole feature exists to improve on. It is disclosed
/// in Settings next to what it does, and turning it off costs one click.
pub fn sharing_enabled() -> bool {
    crate::commands::setup::read_app_state()
        .team_sharing_enabled
        .unwrap_or(true)
}

/// Prepare a push: ask the agent what this change was for, and build the
/// commit message from its answer.
///
/// `provided` is a message the user typed. It wins outright and no agent is
/// asked — a person who wrote their own commit message has said what they
/// wanted said, and paraphrasing it back at them is the opposite of helpful.
pub async fn prepare(
    project: &std::path::Path,
    branch: &str,
    provided: Option<String>,
) -> PushContent {
    if let Some(message) = provided
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        return PushContent {
            message,
            agent: None,
        };
    }

    let _ = branch;
    if !sharing_enabled() {
        return plain();
    }

    let Ok((summary, agent)) = super::summarise_working_tree(project).await else {
        tracing::debug!("no summary for this push; committing plainly");
        return plain();
    };

    // The gauntlet, before the prose reaches a commit.
    //
    // It reads the project's own `.env` files and refuses a summary that
    // repeats anything in them. That check used to guard the record file, and
    // moving the prose into the commit message left it behind — a commit
    // message is *more* exposed than a record was, not less: it is in
    // `git log`, in the pull request and on GitHub, and rewriting history to
    // remove one is not something this app can offer afterwards.
    match writer::gauntlet(project, &summary) {
        Ok(clean) => PushContent {
            message: writer::commit_message(&clean),
            agent: Some(agent),
        },
        Err(error) => {
            // Never partially published: the whole summary is dropped and the
            // push continues with a plain message. A push that cannot happen
            // is worse than one that explains itself poorly.
            tracing::warn!(%error, "summary rejected; committing without one");
            plain()
        }
    }
}

/// The fallback when there is no agent, or it had nothing to say.
fn plain() -> PushContent {
    PushContent {
        message: crate::commands::ai::DEFAULT_COMMIT_MESSAGE.to_string(),
        agent: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_message_the_user_typed_is_used_verbatim_and_asks_no_agent() {
        let dir = std::env::temp_dir().join(format!("ss-push-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        let content = prepare(&dir, "main", Some("  Fix the nav  ".to_string())).await;
        assert_eq!(content.message, "Fix the nav");
        // No attribution: a person wrote this, not an agent.
        assert_eq!(content.agent, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_summary_repeating_a_secret_never_reaches_the_commit_message() {
        // The regression this guards: moving the explanation out of a record
        // file and into the commit message left the redaction check behind, on
        // a surface that is *more* exposed — `git log`, the pull request,
        // GitHub — and one this app cannot retract afterwards.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "API_KEY=sk-live-abc123def456\n").unwrap();

        let leaked = writer::TeamSummary {
            headline: "Wire up the client".to_string(),
            why: Some("Used sk-live-abc123def456 for the call.".to_string()),
            changes: Vec::new(),
            asks: None,
        };
        assert!(
            writer::gauntlet(dir.path(), &leaked).is_err(),
            "a summary quoting .env must be refused before it is committed"
        );
    }

    #[tokio::test]
    async fn falls_back_rather_than_failing_when_there_is_nothing_to_summarise() {
        // Not a git repo, so every path through the summariser errors. A push
        // must still get a message.
        let dir = std::env::temp_dir().join(format!("ss-push-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        let content = prepare(&dir, "main", None).await;
        assert!(!content.message.is_empty());
        assert_eq!(content.agent, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
