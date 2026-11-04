//! Importing an existing agent setup from another assistant (Grok Bot, or
//! anything else connected to Ship Studio's remote access MCP server).
//!
//! The other assistant is the only thing that knows its own setup, so it does
//! the harvesting: it calls `import_agents` with each agent's name, role,
//! instructions and what it remembers, and this turns that into Ship Studio
//! agents. Re-importing is safe: an agent with the same name is updated, not
//! duplicated, and the main agent is merged into the Chief of Staff.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::{runner, store};
use crate::errors::CommandError;

#[derive(Debug, Clone, Deserialize)]
pub struct ImportedAgent {
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instructions: String,
    /// What it remembers: one fact per line is ideal, but any text is kept.
    #[serde(default)]
    pub memory: String,
    /// The source's main/orchestrating agent: merged into the Chief of Staff.
    #[serde(default)]
    pub is_main: bool,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ImportSummary {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

impl ImportSummary {
    pub fn describe(&self, source: &str) -> String {
        let mut parts = Vec::new();
        if !self.created.is_empty() {
            parts.push(format!("Created {}.", self.created.join(", ")));
        }
        if !self.updated.is_empty() {
            parts.push(format!(
                "Updated {} (same name already existed).",
                self.updated.join(", ")
            ));
        }
        for (name, why) in &self.skipped {
            parts.push(format!("Skipped {name}: {why}"));
        }
        if parts.is_empty() {
            return "Nothing was imported: the list was empty.".into();
        }
        format!(
            "Imported from {source} into Ship Studio Agents. {}\n\nNEXT: Tell the user their agents are in Ship Studio → Agents, each with its instructions and memory. They don't start working until the user messages them. Connections your platform had (email, calendar and so on) don't come across: in Ship Studio, agents use whatever this computer and Claude Code are connected to.",
            parts.join(" ")
        )
    }
}

/// Append imported memory under the agent's `## Memory` section.
fn add_memory(id: &str, memory: &str, source: &str) -> Result<(), CommandError> {
    let memory = memory.trim();
    if memory.is_empty() {
        return Ok(());
    }
    let path = store::agent_home(id)?.join("CLAUDE.md");
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    if !content.contains("## Memory") {
        content.push_str("\n## Memory\n");
    }
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("\n### Imported from {source}\n\n{memory}\n"));
    std::fs::write(&path, content).map_err(super::err_io)
}

pub fn import(agents: Vec<ImportedAgent>, source: &str) -> Result<ImportSummary, CommandError> {
    let source = if source.trim().is_empty() {
        "another assistant"
    } else {
        source.trim()
    };
    let mut summary = ImportSummary::default();
    for incoming in agents.into_iter().take(50) {
        let name = match store::validate_name(&incoming.name) {
            Ok(n) => n,
            Err(e) => {
                summary.skipped.push((incoming.name.clone(), e.to_string()));
                continue;
            }
        };
        let existing = if incoming.is_main {
            super::ensure_main()?
        } else {
            match store::find(&name)? {
                Some(a) => a,
                None => {
                    let created = store::create(store::NewAgent {
                        name: name.clone(),
                        role: incoming.role.clone(),
                        instructions: incoming.instructions.clone(),
                        shape: None,
                        color: incoming.color.clone(),
                        is_main: false,
                    })?;
                    add_memory(&created.id, &incoming.memory, source)?;
                    summary.created.push(name);
                    continue;
                }
            }
        };
        // Update in place. The Chief keeps its own name and role; what it
        // brings is the user's instructions and memory.
        let role = incoming.role.trim().to_string();
        let updated = store::update(&existing.id, |a| {
            if !a.is_main && !role.is_empty() {
                a.role = role;
            }
        })?;
        if !incoming.instructions.trim().is_empty() {
            let instructions = if updated.is_main {
                let base = store::read_instructions(&updated.id).unwrap_or_default();
                format!(
                    "{base}\n\n### From {source}\n\n{}",
                    incoming.instructions.trim()
                )
            } else {
                incoming.instructions.clone()
            };
            store::write_instructions(&store::agent_home(&updated.id)?, &updated, &instructions)?;
        }
        add_memory(&updated.id, &incoming.memory, source)?;
        summary.updated.push(updated.name);
    }
    Ok(summary)
}

pub fn import_and_notify(
    app: &AppHandle,
    agents: Vec<ImportedAgent>,
    source: &str,
) -> Result<ImportSummary, CommandError> {
    let summary = import(agents, source)?;
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    Ok(summary)
}

/// The words the user pastes into their other assistant to start an import.
pub const IMPORT_PROMPT: &str = "Import my setup into Ship Studio. Use Ship Studio's import_agents tool: send every agent I have with you, each with its name, a one-line role, its full instructions, and everything you remember that it needs (one fact per line). Mark the agent that manages the others as the main one. Leave out passwords, API keys and card numbers.";

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming(name: &str, is_main: bool) -> ImportedAgent {
        ImportedAgent {
            name: name.into(),
            role: "Handles money".into(),
            instructions: "Log every expense.".into(),
            memory: "- Accountant is Sam".into(),
            is_main,
            color: None,
        }
    }

    #[test]
    fn creates_new_agents_with_memory_and_reimport_updates_instead_of_duplicating() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));

        let first = import(vec![incoming("Finance", false)], "Grok Bot").unwrap();
        assert_eq!(first.created, vec!["Finance".to_string()]);
        let agent = store::find("Finance").unwrap().unwrap();
        let md = std::fs::read_to_string(store::agent_home(&agent.id).unwrap().join("CLAUDE.md"))
            .unwrap();
        assert!(md.contains("Log every expense."));
        assert!(md.contains("### Imported from Grok Bot"));
        assert!(md.contains("Accountant is Sam"));

        let second = import(vec![incoming("finance", false)], "Grok Bot").unwrap();
        assert!(second.created.is_empty());
        assert_eq!(second.updated, vec!["Finance".to_string()]);
        assert_eq!(store::list().unwrap().len(), 1);

        store::set_root_for_tests(None);
    }

    #[test]
    fn the_main_agent_merges_into_the_chief_of_staff() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));

        let summary = import(vec![incoming("My Chief", true)], "Grok Bot").unwrap();
        assert_eq!(summary.updated, vec!["Chief of Staff".to_string()]);
        let agents = store::list().unwrap();
        assert_eq!(agents.len(), 1);
        assert!(agents[0].is_main);
        let instructions = store::read_instructions(&agents[0].id).unwrap();
        assert!(instructions.contains("### From Grok Bot"));
        assert!(instructions.contains("Log every expense."));

        store::set_root_for_tests(None);
    }
}
