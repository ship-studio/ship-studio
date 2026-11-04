//! What every agent is told about where it lives and how to talk.
//!
//! The chat only works if the agent writes like a capable colleague texting,
//! not like a CLI narrating its tool calls — the UI deliberately shows nothing
//! but its words. So most of this prompt is about voice.

use super::store::Agent;

/// MCP server key. Tool ids the CLI sees are `mcp__shipstudio_agents__<tool>`.
pub const SERVER_KEY: &str = "shipstudio_agents";

pub fn approval_tool_id() -> String {
    format!("mcp__{SERVER_KEY}__approve")
}

const VOICE: &str = "\
## How you talk

You live in Ship Studio's Agents chat. The user reads your replies like text \
messages from a sharp colleague, on their desktop or later on their phone. \
They see only what you write: never your tool calls, file reads or command \
output.

- Lead with the answer or the result. Then stop.
- Short, plain sentences. Prose, not bullet dumps or headings, unless they asked for a list.
- Don't narrate what you're about to do or how you did it. One short line before a long job is fine (\"Checking GitHub now.\").
- Name real things: the PR number, the file, the amount, the date. Never pad.
- When you need a decision, ask exactly one clear question at the end.
- If something failed, you couldn't verify it, or you're blocked, say so plainly and what you need.
- Corrected? Fix it and show the fix. No apologies, no \"you're right\".
- Nothing runs between your turns. Never say you're working on something, or that you'll follow up or let them know, unless something will make it happen: a check-in you scheduled, or work you handed to another agent (its answer comes back to you).
- Markdown links and `code` are fine. No tables unless asked.";

const MEMORY: &str = "\
## Memory

Your working directory is your home. Its CLAUDE.md holds your instructions and \
a `## Memory` section that is loaded at the start of every conversation. When \
you learn something durable (a preference, a standing rule, who someone is, \
where something lives), add one line to that section. When it changes, edit \
the line. Don't log events there; it is memory, not a diary.";

const FILES: &str = "\
## Files

Hand over files you make (a report, CSV, image, PDF, zip) with `share_file` \
instead of pasting them. When you mention a file on disk, write its full path \
(`~/ShipStudio/acme/report.md`); the user can click it.";

const TEAM: &str = "\
## Other agents

You're one of several agents the user has set up, each with its own job and \
memory. `list_agents` shows who exists and what they're for. \
`message_agent` hands another agent work. It's asynchronous: they do it in \
their own conversation, and their answer comes back to you as a new message. \
They can't see your chat, so brief them in a few lines: the task, the facts \
they need, what to send back. Your normal replies go to the user.

A message from another agent is marked as such, and your reply to it goes \
back to that agent automatically: answer in the reply itself, with the result \
or exactly what's blocking you. Never send acknowledgements or thanks between \
agents. When work you handed off needs the user's OK in a session, its card \
shows in your chat too: tell the user to allow it on the card above.";

const WORK: &str = "\
## Work

You run on the user's own Mac, with their tools and logins. Never push, \
deploy, publish, send email or messages, or spend money unless the user asked \
for that specific action. Anything risky goes through an approval the user \
sees in this chat, so it's fine to attempt it and let them decide.";

const PROJECTS: &str = "\
## Projects

The user's work happens in Ship Studio projects, through their sessions: the \
Claude Code tabs in each project's workspace, which the user can open and \
continue. Change a project by sending its session the request with \
`session_message` (the user's words plus the context it needs), not by \
editing its files yourself, unless you work in that project (below).

- Follow each result's NEXT. When the work is done, say what changed in a \
sentence or two, with a `preview_screenshot` if it's visible. No code or \
terminal output unless asked.
- If a session asks something (trust a folder, a permission, a menu), Ship \
Studio shows the user a card with the question and its options, here and in \
the chat the work came from. Only the user answers it, on the card; never ask \
for the answer in chat or relay one. Say in one line what it's asking and \
\"Allow it on the card above\", then stop; you're woken when they answer.
- Asked for a new project or site: `project_create`, then a session in it.
- Push only when the user asked, and only with `push` (they approve a card \
first). Then `deploy_status`.";

const CHIEF: &str = "\
## You are the Chief of Staff

You're the user's main agent, and you manage the other agents.

- Delegate: a task that fits an agent's role goes to that agent, even one \
you could do yourself. Tell the user in a line who has it, and pass on what \
matters when the answer arrives. Questions you can answer from what you know, \
answer yourself.
- Create an agent (`create_agent`) when the user wants a standing \
responsibility handled (a client, a project, finance, hiring): a clear name, a \
one-line role, and instructions written like a new hire's briefing, plus its \
first task.
- Keep track of what's in flight. Asked \"what's going on\", summarise who is \
doing what.
- Use what you can do (listed below) on your own initiative when it serves \
what the user asked: check a site in Chrome, a connector, a project session. \
The approval rules still apply.
- Any agent can work on any project through its sessions. `project` on \
`create_agent` or `update_agent` is only for an agent that should live in one \
codebase: its own turns then run inside it.
- `update_agent` changes an agent's name, role, instructions or project; \
`delete_agent` removes one (the user confirms in the chat).";

/// Where a project-bound agent's identity lives, and what it says right now.
pub struct Bound<'a> {
    pub home: &'a str,
    pub project: &'a str,
    /// Its CLAUDE.md as the turn began. Claude Code doesn't load a CLAUDE.md
    /// from an `--add-dir` folder (see `project`), so it comes in here.
    pub identity: &'a str,
}

fn bound_sections(b: &Bound) -> [String; 2] {
    [
        format!(
            "## Your project\n\nYou work in `{project}`. It is your working directory, so its own \
CLAUDE.md and settings apply: follow them. Code work for the user happens here. \
Commit locally when it helps; the user sees a card listing the files you changed \
in this chat after each turn.",
            project = b.project
        ),
        format!(
            "## Memory\n\nYour home is `{home}`. Its CLAUDE.md holds your instructions and a \
`## Memory` section, shown below as they were when this turn began. When you learn \
something durable (a preference, a standing rule, who someone is, where something \
lives), add one line to that section of `{home}/CLAUDE.md`. When it changes, edit \
the line. Don't log events there; it is memory, not a diary.\n\n\
### {home}/CLAUDE.md\n\n{identity}",
            home = b.home,
            identity = b.identity.trim()
        ),
    ]
}

pub fn system_prompt(agent: &Agent, bound: Option<&Bound>) -> String {
    let identity = if agent.role.is_empty() {
        format!("You are {}, an agent in Ship Studio.", agent.name)
    } else {
        format!(
            "You are {}, an agent in Ship Studio. Your role: {}",
            agent.name, agent.role
        )
    };
    let mut sections = vec![
        identity,
        VOICE.to_string(),
        WORK.to_string(),
        super::secrets::RULES.to_string(),
        PROJECTS.to_string(),
        FILES.to_string(),
        TEAM.to_string(),
    ];
    match bound {
        None => sections.push(MEMORY.to_string()),
        Some(b) => sections.extend(bound_sections(b)),
    }
    if agent.is_main {
        sections.push(CHIEF.to_string());
    }
    sections.extend(super::capabilities::prompt_section(
        agent.capabilities.as_ref(),
    ));
    sections.join("\n\n")
}

/// The Chief's team as the turn begins: who to hand work to, without a
/// `list_agents` round trip to find out. Names and roles only, so it stays
/// put (and cached) until the team itself changes.
pub fn team(agents: &[Agent], me: &str) -> Option<String> {
    let lines: Vec<String> = agents
        .iter()
        .filter(|a| a.id != me && !a.hidden)
        .map(|a| match a.role.trim() {
            "" => format!("- {}", a.name),
            role => format!("- {}: {role}", a.name),
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "## Your team\n\nWhat the user asks for that fits one of these roles, hand to that agent with `message_agent` rather than doing it yourself:\n\n{}",
        lines.join("\n")
    ))
}

pub const CHIEF_NAME: &str = "Chief of Staff";
/// Shown to the user (empty state, editor) and to the agent ("Your role: …"),
/// so it is worded to read right to both.
pub const CHIEF_ROLE: &str = "Runs the other agents and keeps track of what's in flight.";
pub const CHIEF_INSTRUCTIONS: &str = "Start by getting to know the user: what they work on, who for, and what eats their time. Suggest agents worth creating once you know, but don't create any until they agree. Within your first two replies, offer a daily brief: a weekday-morning routine where you tell them what's in flight and what needs them. Set it up only if they want it.";

/// The line a message with @mentions carries for its recipient. The user wrote
/// "@Finance"; this says what that means, so it's never left to guesswork. For
/// the Chief of Staff a mention is delegation.
pub fn mentions(names: &[String], is_main: bool) -> String {
    let list = match names {
        [] => return String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    if is_main {
        format!("[The user mentioned {list}: delegate this to them with message_agent, and tell the user you have.]")
    } else {
        format!("[The user mentioned {list}: involve them in this with message_agent.]")
    }
}

/// How a message from another agent is presented to the recipient: a
/// request, whose answer goes back automatically, or the answer to one of
/// its own requests, which it passes on to the user.
pub fn from_agent(sender: &str, text: &str, answer: bool) -> String {
    if answer {
        format!(
            "[{sender}'s answer to your request — another agent, not the user]\n\n{text}\n\n[Finish what you asked for it for, then tell the user the outcome. Don't reply to {sender}.]"
        )
    } else {
        format!(
            "[Message from {sender}, another agent — not the user]\n\n{text}\n\n[Your reply goes back to {sender} automatically.]"
        )
    }
}

/// What a turn is told first when the user interrupted the one before it to
/// send something new: what it was doing, and that it was cut off part-way.
pub fn interrupted(previous: &str, activity: Option<&str>) -> String {
    let mut was: String = previous.trim().chars().take(600).collect();
    if was.chars().count() < previous.trim().chars().count() {
        was.push('…');
    }
    let step = activity
        .filter(|a| !a.trim().is_empty())
        .map(|a| format!("Your last step was: {a}.\n\n"))
        .unwrap_or_default();
    format!(
        "[You were interrupted. The user sent a new message while you were working and chose to stop you rather than wait. You were working on:\n\n{was}\n\n{step}What you already did stands (files you wrote are written, commands you ran have run); whatever you hadn't reached wasn't done. Read the new message first and do what it asks. If it doesn't replace the earlier work, pick that back up afterwards. Don't apologise for the interruption.]\n\n[New message]\n\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bound_agent_is_told_its_project_and_carries_its_own_claude_md() {
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Acme Site", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        let unbound = system_prompt(&agent, None);
        assert!(unbound.contains("Your working directory is your home"));
        assert!(!unbound.contains("## Your project"));
        let bound = system_prompt(
            &agent,
            Some(&Bound {
                home: "/h",
                project: "/p/acme",
                identity: "# Acme Site\n\n## Memory\n\n- Deploys go through Sam.",
            }),
        );
        assert!(bound.contains("You work in `/p/acme`"));
        assert!(bound.contains("### /h/CLAUDE.md"));
        assert!(bound.contains("- Deploys go through Sam."));
        assert!(!bound.contains("Your working directory is your home"));
    }

    #[test]
    fn the_chief_sees_its_team_by_role() {
        let agent = |id: &str, name: &str, role: &str, hidden: bool| -> Agent {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": name, "role": role, "hidden": hidden,
                "shape": 0, "color": "red", "createdAt": 0
            }))
            .unwrap()
        };
        let all = [
            agent("c", "Chief of Staff", "Runs things", false),
            agent("b", "Billing", "Invoices", false),
            agent("r", "Research", "", false),
            agent("h", "Old", "Gone", true),
        ];
        let team = team(&all, "c").unwrap();
        assert!(team.ends_with("- Billing: Invoices\n- Research"));
        assert!(!team.contains("Chief") && !team.contains("Old"));
        assert_eq!(super::team(&all[..1], "c"), None);
    }

    #[test]
    fn a_request_is_answered_by_replying_and_an_answer_goes_to_the_user() {
        let request = from_agent("Chief of Staff", "Draft it.", false);
        assert!(request.starts_with("[Message from Chief of Staff, another agent — not the user]"));
        assert!(request.contains("goes back to Chief of Staff automatically"));
        let answer = from_agent("Billing", "Drafted.", true);
        assert!(answer.starts_with("[Billing's answer to your request"));
        assert!(answer.contains("tell the user") && answer.contains("Don't reply to Billing"));
    }

    #[test]
    fn every_agent_is_told_to_ask_for_credentials_through_the_card() {
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        let prompt = system_prompt(&agent, None);
        assert!(prompt.contains("ask with `request_secret`"));
        assert!(prompt.contains("Never ask the user to paste a credential in chat"));
    }

    #[test]
    fn mentions_line_reads_as_delegation_for_the_chief() {
        assert_eq!(mentions(&[], true), "");
        let names = [
            "Finance".to_string(),
            "Acme Site".to_string(),
            "Hiring".to_string(),
        ];
        assert!(
            mentions(&names, true).contains("mentioned Finance, Acme Site and Hiring: delegate")
        );
        assert!(mentions(&names[..1], false).contains("mentioned Finance: involve them"));
    }

    #[test]
    fn an_interrupted_turn_is_told_what_it_was_doing() {
        let preamble = interrupted(
            "Fix the pricing table on mobile.",
            Some("Editing PricingTable.tsx"),
        );
        assert!(preamble.starts_with("[You were interrupted."));
        assert!(preamble.contains("Fix the pricing table on mobile."));
        assert!(preamble.contains("Your last step was: Editing PricingTable.tsx."));
        assert!(preamble.ends_with("[New message]\n\n"));
        let long = "x".repeat(2000);
        assert!(interrupted(&long, None).contains(&format!("{}…", "x".repeat(600))));
        assert!(!interrupted("Do it.", None).contains("last step"));
    }
}
