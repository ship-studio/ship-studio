//! # Agents
//!
//! Persistent, named AI agents the user chats with, a Grok Bot-style
//! experience running on the user's own Claude Code. One of them, the Chief of
//! Staff, manages the rest: it creates, briefs, delegates to and deletes them.
//!
//! - [`store`]: the registry and each agent's home (CLAUDE.md + chat log)
//! - [`runner`]: per-agent inbox; each turn is one `claude --print --resume`
//! - [`mcp`]: the tools agents get (team, projects, management, approvals)
//! - [`permissions`]: "Always allow" rules and how narrowly they match
//! - [`notify`]: macOS notifications and the Dock badge
//! - [`attachments`]: files sent with a message, copied into the agent's home
//! - [`import`]: bring an existing setup over from another assistant
//! - [`schedule`]: check-ins and routines that wake an agent on time
//! - [`prompts`]: voice and role
//! - [`search`]: find a message across every conversation
//! - [`stream`]: a reply while it is being written (drafts)
//! - [`usage`]: tokens and cost per agent, from each turn's `result` event
//!
//! Full design: docs/agents.md.

pub mod attachments;
pub mod import;
pub mod mcp;
pub mod notify;
pub mod permissions;
pub mod prompts;
pub mod runner;
pub mod schedule;
pub mod search;
pub mod store;
pub mod stream;
pub mod usage;

use crate::errors::CommandError;

pub(crate) fn err_other(message: impl std::fmt::Display) -> CommandError {
    CommandError::Other {
        message: message.to_string(),
    }
}

pub(crate) fn err_io(e: impl std::fmt::Display) -> CommandError {
    CommandError::Io {
        message: e.to_string(),
    }
}

pub(crate) fn err_invalid(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::Validation {
        field: field.to_string(),
        reason: reason.into(),
    }
}

/// The Chief of Staff exists from the first time anyone looks.
pub fn ensure_main() -> Result<store::Agent, CommandError> {
    if let Some(main) = store::list()?.into_iter().find(|a| a.is_main) {
        return Ok(main);
    }
    let created = store::create(store::NewAgent {
        name: prompts::CHIEF_NAME.to_string(),
        role: prompts::CHIEF_ROLE.to_string(),
        instructions: prompts::CHIEF_INSTRUCTIONS.to_string(),
        shape: Some(5),
        color: Some("white".to_string()),
        is_main: true,
    });
    match created {
        Ok(agent) => Ok(agent),
        // Two callers raced; the other one made it.
        Err(_) => store::list()?
            .into_iter()
            .find(|a| a.is_main)
            .ok_or_else(|| err_other("Couldn't create the Chief of Staff.")),
    }
}
