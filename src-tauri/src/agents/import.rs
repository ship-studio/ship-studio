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

use super::{runner, schedule, store};
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
    /// Its routines and check-ins, each a plain-language time and what to do.
    #[serde(default)]
    pub routines: Vec<ImportedRoutine>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct ImportedRoutine {
    /// "every weekday at 9am", "every 2 hours", "friday at 14:30".
    #[serde(default)]
    pub when: String,
    /// What the agent does when it fires: becomes its check-in note.
    #[serde(default)]
    pub what: String,
}

/// One routine, set or refused, by agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RoutineOutcome {
    pub agent: String,
    pub when: String,
    pub what: String,
    /// Set: what it became ("every weekday at 09:00"). Refused: why, for the user.
    pub detail: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<(String, String)>,
    /// Routines that are now scheduled (including ones a re-import found already set).
    pub routines_set: Vec<RoutineOutcome>,
    /// Routines that weren't, with why. Never dropped silently.
    pub routines_refused: Vec<RoutineOutcome>,
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
        if !self.routines_set.is_empty() {
            let set: Vec<String> = self
                .routines_set
                .iter()
                .map(|r| format!("{}: {}", r.agent, r.detail))
                .collect();
            parts.push(format!("Routines set ({}).", set.join("; ")));
        }
        let mut next = String::from("NEXT: Tell the user their agents are in Ship Studio → Agents, each with its instructions and memory. They don't start working until the user messages them, except for their routines, which run only while Ship Studio is open on this Mac.");
        if !self.routines_refused.is_empty() {
            let refused: Vec<String> = self
                .routines_refused
                .iter()
                .map(|r| format!("{}: \"{}\" ({})", r.agent, r.when, r.detail))
                .collect();
            parts.push(format!("Routines NOT set: {}.", refused.join("; ")));
            next.push_str(" List every routine that was NOT set, word for word, and offer to resend it with a time Ship Studio understands (\"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\", \"friday at 14:30\"); importing again is safe.");
        }
        next.push_str(" Connections your platform had (email, calendar and so on) don't come across: in Ship Studio, agents use whatever this computer and Claude Code are connected to.");
        format!(
            "Imported from {source} into Ship Studio Agents. {}\n\n{next}",
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
    if super::memory::section_start(&content).is_none() {
        content.push_str(&format!("\n{}\n", super::memory::HEADING));
    }
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("\n### Imported from {source}\n\n{memory}\n"));
    std::fs::write(&path, content).map_err(super::err_io)
}

fn outcome(agent: &str, r: &ImportedRoutine, detail: String) -> RoutineOutcome {
    RoutineOutcome {
        agent: agent.to_string(),
        when: r.when.trim().to_string(),
        what: r.what.trim().to_string(),
        detail,
    }
}

/// Schedule each routine with the same parser and limits as `schedule_check_in`.
/// One already there (a re-import) counts as set, not as a second copy.
fn add_routines(agent: &store::Agent, routines: &[ImportedRoutine], summary: &mut ImportSummary) {
    let tz = chrono::Local;
    for r in routines {
        // A one-off's time is relative ("in 3 days"), so a re-import would
        // land on a new time: the same note, once, means it's already set.
        if let Ok((None, _)) = schedule::check(&tz, &r.when, &r.what, store::now_ms()) {
            let already = store::get(&agent.id).map(|a| {
                a.check_ins
                    .iter()
                    .any(|c| c.repeat.is_none() && c.note == r.what.trim())
            });
            if matches!(already, Ok(true)) {
                summary
                    .routines_set
                    .push(outcome(&agent.name, r, "already set".into()));
                continue;
            }
        }
        match schedule::create_in(&tz, &agent.id, &r.when, &r.what, store::now_ms()) {
            Ok(made) => summary.routines_set.push(outcome(
                &agent.name,
                r,
                schedule::describe_schedule(
                    &tz,
                    made.check_in.repeat.as_ref(),
                    made.check_in.next_at,
                ),
            )),
            Err(schedule::Refused::Duplicate) => {
                let detail = match schedule::check(&tz, &r.when, &r.what, store::now_ms()) {
                    Ok((Some(repeat), _)) => {
                        format!("{} (already set)", schedule::describe(&repeat))
                    }
                    _ => "already set".into(),
                };
                summary.routines_set.push(outcome(&agent.name, r, detail));
            }
            Err(refused) => summary
                .routines_refused
                .push(outcome(&agent.name, r, refused.plain())),
        }
    }
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
                for r in &incoming.routines {
                    summary.routines_refused.push(outcome(
                        &incoming.name,
                        r,
                        "the agent itself wasn't imported.".into(),
                    ));
                }
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
                    add_routines(&created, &incoming.routines, &mut summary);
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
        add_routines(&updated, &incoming.routines, &mut summary);
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
pub const IMPORT_PROMPT: &str = "Import my setup into Ship Studio. Use Ship Studio's import_agents tool: send every agent I have with you, each with its name, a one-line role, its full instructions, and everything you remember that it needs (one fact per line). Mark the agent that manages the others as the main one. Include each agent's routines and automations, with when each runs in plain words (\"every weekday at 9am\", \"every 2 hours\") and what it does then. Leave out passwords, API keys and card numbers.";

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
            routines: Vec::new(),
        }
    }

    fn routine(when: &str, what: &str) -> ImportedRoutine {
        ImportedRoutine {
            when: when.into(),
            what: what.into(),
        }
    }

    #[test]
    fn the_tool_accepts_routines_and_agents_without_them() {
        let agents: Vec<ImportedAgent> = serde_json::from_value(serde_json::json!([
            {"name": "Finance", "routines": [{"when": "every weekday at 9am", "what": "Brief me."}]},
            {"name": "Travel"}
        ]))
        .unwrap();
        assert_eq!(
            agents[0].routines,
            [routine("every weekday at 9am", "Brief me.")]
        );
        assert!(agents[1].routines.is_empty());
    }

    #[test]
    fn routines_become_check_ins_and_refused_phrases_are_reported_by_agent() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));

        let mut finance = incoming("Finance", false);
        finance.routines = vec![
            routine("Every weekday at 9am", "Send me yesterday's spending."),
            routine("every 2 hours", "Check for new invoices."),
            routine("in 3 days", "Chase the accountant."),
            routine("whenever rent is due", "Remind me to pay rent."),
            routine("every 5 minutes", "Poll the bank."),
            routine("every monday at 8am", "  "),
        ];
        let mut chief = incoming("Grok", true);
        chief.routines = vec![routine("daily at 7:30", "Morning brief.")];
        let mut bad = incoming("   ", false);
        bad.routines = vec![routine("every day at 9", "x")];

        let summary = import(vec![finance.clone(), chief, bad], "Grok Bot").unwrap();
        let set: Vec<(&str, &str)> = summary
            .routines_set
            .iter()
            .map(|r| (r.agent.as_str(), r.detail.as_str()))
            .collect();
        assert_eq!(set[0], ("Finance", "every weekday at 09:00"));
        assert_eq!(set[1], ("Finance", "every 2 hours"));
        assert!(set[2].1.starts_with("once, "), "{}", set[2].1);
        assert_eq!(set[3], ("Chief of Staff", "every day at 07:30"));
        assert_eq!(set.len(), 4);

        let refused: Vec<(&str, &str)> = summary
            .routines_refused
            .iter()
            .map(|r| (r.agent.as_str(), r.when.as_str()))
            .collect();
        assert_eq!(
            refused,
            [
                ("Finance", "whenever rent is due"),
                ("Finance", "every 5 minutes"),
                ("Finance", "every monday at 8am"),
                ("   ", "every day at 9"),
            ]
        );
        let why = &summary.routines_refused[1].detail;
        assert_eq!(why, "Routines can't run more often than every 30 minutes.");
        assert!(!summary.routines_refused[0].detail.contains("Examples:"));

        let told = summary.describe("Grok Bot");
        assert!(told.contains("Routines NOT set"), "{told}");
        assert!(told.contains("\"whenever rent is due\""), "{told}");

        let agent = store::find("Finance").unwrap().unwrap();
        assert_eq!(agent.check_ins.len(), 3);
        assert!(agent.check_ins[0].repeat.is_some());

        // Importing again doesn't double the routines; they're reported as set.
        let again = import(vec![finance], "Grok Bot").unwrap();
        assert_eq!(store::find("Finance").unwrap().unwrap().check_ins.len(), 3);
        assert_eq!(
            again.routines_set[0].detail,
            "every weekday at 09:00 (already set)"
        );
        assert_eq!(again.routines_refused.len(), 3);

        store::set_root_for_tests(None);
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
