//! The tools every agent gets, served from the agent bridge's loopback server
//! at `/mcp/<token>/agents/<agent-id>`.
//!
//! The agent id in the path is who is calling — it's how `message_agent`
//! knows the sender and how management tools know whether the caller is the
//! Chief of Staff. The path is only known to the Claude Code process Ship
//! Studio spawned for that agent (it's passed inline via `--mcp-config` and
//! never written to disk), and the bridge's random token guards the prefix.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::files;
use super::permissions;
use super::runner::{self, From, Status};
use super::schedule;
use super::store::{self, AgentRef, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;

/// How long a call to `approve` holds Claude Code before answering.
///
/// Claude Code abandons a permission prompt at 300s no matter what
/// MCP_TOOL_TIMEOUT says (observed: two cards left unanswered were both given
/// up on at exactly 300s, and the agent reported the commands as timed out).
/// So we answer first, at 240s, with "paused for the user" — and the card stays
/// live. A late Allow grants exactly that call and wakes the agent.
pub const APPROVAL_WAIT_SECS: u64 = 240;
const APPROVAL_WAIT: Duration = Duration::from_secs(APPROVAL_WAIT_SECS);

/// One-time grants from late Allows: (agent id, tool, input). The next
/// matching `approve` call from that agent is allowed without a card.
static GRANTS: LazyLock<Mutex<Vec<(String, String, Value)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

pub fn grant_once(agent_id: &str, tool: &str, input: &Value) {
    GRANTS.lock().unwrap_or_else(|e| e.into_inner()).push((
        agent_id.to_string(),
        tool.to_string(),
        input.clone(),
    ));
}

fn take_grant(agent_id: &str, tool: &str, input: &Value) -> bool {
    let mut grants = GRANTS.lock().unwrap_or_else(|e| e.into_inner());
    match grants
        .iter()
        .position(|(a, t, i)| a == agent_id && t == tool && i == input)
    {
        Some(index) => {
            grants.remove(index);
            true
        }
        None => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Answer {
    Allowed,
    /// With what the user said, if they said why.
    Denied(Option<String>),
    /// The user hasn't answered within the wait. The card stays live.
    NotYet,
}

static PENDING_APPROVALS: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn answer_approval(request_id: &str, allow: bool) -> bool {
    let sender = PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(request_id);
    match sender {
        Some(tx) => tx.send(allow).is_ok(),
        None => false,
    }
}

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

struct Tool {
    name: &'static str,
    description: &'static str,
    main_only: bool,
    schema: fn() -> Value,
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "list_agents",
        description: "List every agent: name, role, whether it's busy right now. Use it to decide who should handle something.",
        main_only: false,
        schema: || json!({ "type": "object", "properties": {} }),
    },
    Tool {
        name: "message_agent",
        description: "Send a message to another agent. Asynchronous: it returns once delivered; the agent works in its own conversation and messages you back if it needs to. Write it as a complete brief: they don't see your conversation with the user.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "The agent's name (or id)." },
                "message": { "type": "string" }
            },
            "required": ["agent", "message"]
        }),
    },
    Tool {
        name: "create_agent",
        description: "Create a new agent with a standing responsibility. It appears in the user's sidebar immediately. Optionally hand it a first task.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Short, human: \"Finance\", \"Acme Site\", \"Hiring\"." },
                "role": { "type": "string", "description": "One line: what this agent is responsible for." },
                "instructions": { "type": "string", "description": "A briefing, as if for a new hire: context, standing rules, who's who, where things live." },
                "color": { "type": "string", "enum": store::COLORS },
                "project": { "type": "string", "description": "Optional: bind it to one Ship Studio project (name or path from project_list), so its own turns run inside that project. Usually unnecessary: any agent can work on any project through sessions." },
                "first_task": { "type": "string", "description": "Optional message to start it on right away." }
            },
            "required": ["name", "role", "instructions"]
        }),
    },
    Tool {
        name: "update_agent",
        description: "Change an agent's name, role, instructions or project. Instructions replace the old ones; its memory is kept. `project` takes a name or path from project_list, or \"none\" to unbind it.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string" },
                "name": { "type": "string" },
                "role": { "type": "string" },
                "instructions": { "type": "string" },
                "project": { "type": "string" }
            },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "delete_agent",
        description: "Delete an agent, its memory and its conversation. The user is asked to confirm in the chat first.",
        main_only: true,
        schema: || json!({
            "type": "object",
            "properties": { "agent": { "type": "string" } },
            "required": ["agent"]
        }),
    },
    Tool {
        name: "share_file",
        description: "Hand the user a file you made (a report, CSV, image, PDF, zip): it appears in this chat as a file card they can open, and images show inline. Use it instead of pasting a file's contents. The file must be in your own folder or one of the user's projects; folders aren't accepted, so zip one first. Up to 25 MB.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute, ~/…, or relative to your folder." },
                "caption": { "type": "string", "description": "Optional: one short line about what it is, shown with the file." }
            },
            "required": ["path"]
        }),
    },
    Tool {
        name: "schedule_check_in",
        description: "Have Ship Studio wake you later with a note to yourself: use it whenever you tell the user you'll check back, follow up or remind them, so that actually happens. Once (\"tomorrow at 9:00\", \"in 2 hours\", \"friday 14:30\") or as a routine (\"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\"), in the user's local time. It only fires while Ship Studio is open; the answer says exactly when and what happens if it's closed. Tell the user that time.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "when": { "type": "string", "description": "When, in plain words. See the description for shapes that work." },
                "note": { "type": "string", "description": "What to do when it fires, written to your future self: specific enough to act on with no other context." },
                "agent": { "type": "string", "description": "Chief of Staff only: schedule it for another agent (name or id). Omit to schedule for yourself." }
            },
            "required": ["when", "note"]
        }),
    },
    Tool {
        name: "list_check_ins",
        description: "Your scheduled check-ins and routines, with ids and next times.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "description": "Chief of Staff only: another agent's." }
            }
        }),
    },
    Tool {
        name: "cancel_check_in",
        description: "Cancel a scheduled check-in or routine by id (from list_check_ins).",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "agent": { "type": "string", "description": "Chief of Staff only: another agent's." }
            },
            "required": ["id"]
        }),
    },
    Tool {
        name: "approve",
        description: "Internal: Claude Code asks this before a tool call that needs the user's permission.",
        main_only: false,
        schema: || json!({
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        }),
    },
];

pub fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-03-26");
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "shipstudio-agents", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Ship Studio: the user's projects, which you work on through their sessions (project_* and session_* tools), other agents you can message, and (for the Chief of Staff) creating and managing agents."
    })
}

fn tools_list(caller: &store::Agent) -> Value {
    let mut tools: Vec<Value> = TOOLS
        .iter()
        .filter(|t| !t.main_only || caller.is_main)
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect();
    // Every agent works on projects the same way.
    tools.extend(super::sessions::definitions());
    json!({ "tools": tools })
}

pub async fn handle_rpc(app: &AppHandle, agent_id: &str, message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params");
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, msg: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } });

    let caller = match store::get(agent_id) {
        Ok(agent) => agent,
        Err(_) => return fail(-32001, "This agent no longer exists."),
    };
    match method {
        "initialize" => ok(initialize_result(params)),
        "ping" => ok(json!({})),
        "tools/list" => ok(tools_list(&caller)),
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Some(tool) = super::sessions::find(name) {
                return ok(super::sessions::call(app, &caller, tool, &args).await);
            }
            let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                return fail(-32602, &format!("Unknown tool: {name}"));
            };
            if tool.main_only && !caller.is_main {
                return ok(error(
                    "Only the Chief of Staff can do that. Ask it with message_agent.",
                ));
            }
            ok(call(app, &caller, name, &args).await)
        }
        _ => fail(-32601, &format!("Method not found: {method}")),
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

async fn call(app: &AppHandle, caller: &store::Agent, name: &str, args: &Value) -> Value {
    match name {
        "list_agents" => list_agents(caller),
        "message_agent" => message_agent(app, caller, args),
        "share_file" => share_file(app, caller, args).await,
        "create_agent" => create_agent(app, caller, args).await,
        "update_agent" => update_agent(app, caller, args).await,
        "delete_agent" => delete_agent(app, caller, args).await,
        "schedule_check_in" | "list_check_ins" | "cancel_check_in" => {
            check_ins(app, caller, name, args)
        }
        "approve" => approve(app, caller, args).await,
        _ => error("Unknown tool"),
    }
}

/// The schedule tools. An agent manages its own; the Chief of Staff may also
/// manage another agent's by naming it.
fn check_ins(app: &AppHandle, caller: &store::Agent, name: &str, args: &Value) -> Value {
    let target = match arg(args, "agent") {
        None => caller.clone(),
        Some(t) => match store::find(t) {
            Ok(Some(a)) if a.id == caller.id || caller.is_main => a,
            Ok(Some(_)) => {
                return error("You can only schedule your own check-ins. Ask the Chief of Staff.")
            }
            _ => return error(format!("There's no agent called {t}.")),
        },
    };
    let whose = |summary: String| {
        if target.id == caller.id {
            summary
        } else {
            format!("For {}: {summary}", target.name)
        }
    };
    let result = match name {
        "schedule_check_in" => schedule::create(
            &target.id,
            arg(args, "when").unwrap_or(""),
            arg(args, "note").unwrap_or(""),
        )
        .map(|c| whose(c.summary)),
        "cancel_check_in" => schedule::cancel(&target.id, arg(args, "id").unwrap_or(""))
            .map(|c| whose(format!("Cancelled: {}", c.note))),
        _ => return text(whose(schedule::list_text(&target))),
    };
    match result {
        Ok(summary) => {
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            text(summary)
        }
        Err(e) => error(e.to_string()),
    }
}

fn list_agents(caller: &store::Agent) -> Value {
    let Ok(agents) = store::list() else {
        return error("Couldn't read the agents list.");
    };
    let lines: Vec<String> = agents
        .iter()
        .map(|a| {
            let me = if a.id == caller.id { " (you)" } else { "" };
            let chief = if a.is_main { " [Chief of Staff]" } else { "" };
            let status = runner::status_of(&a.id);
            let project = a
                .project
                .as_deref()
                .map(|p| format!(" (works in {p})"))
                .unwrap_or_default();
            let busy = match status.state {
                "working" => " — busy",
                "waiting" => " — waiting on the user",
                _ => "",
            };
            format!(
                "- {}{me}{chief}{project}{busy}: {}",
                a.name,
                if a.role.is_empty() {
                    "(no role set)"
                } else {
                    &a.role
                }
            )
        })
        .collect();
    text(lines.join("\n"))
}

fn peer(agent: &store::Agent) -> AgentRef {
    AgentRef {
        id: agent.id.clone(),
        name: agent.name.clone(),
    }
}

fn message_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let (Some(target_name), Some(body)) = (arg(args, "agent"), arg(args, "message")) else {
        return error("Both `agent` and `message` are required.");
    };
    let target = match store::find(target_name) {
        Ok(Some(t)) => t,
        _ => {
            return error(format!(
                "There's no agent called {target_name}. list_agents shows who exists."
            ))
        }
    };
    if target.id == caller.id {
        return error("That's you.");
    }
    let hop = runner::current_hop(&caller.id).saturating_add(1);
    if hop > runner::MAX_HOPS {
        return error("Not sent: this chain of agent-to-agent messages is too long. Tell the user where things stand instead.");
    }
    let mut sent = runner::new_message(&caller.id, MessageKind::SentToAgent, body);
    sent.peer = Some(peer(&target));
    let _ = runner::record(app, sent);
    let mut received = runner::new_message(&target.id, MessageKind::FromAgent, body);
    received.peer = Some(peer(caller));
    let _ = runner::record(app, received);
    runner::enqueue(
        app,
        &target.id,
        body.to_string(),
        From::Agent {
            sender: peer(caller),
            hop,
        },
    );
    text(format!(
        "Delivered to {}. They'll message you back if they need to; don't wait on it.",
        target.name
    ))
}

/// Copy a file the agent made into its chat as a message from it. Only files
/// in its own home or one of the user's projects (see `files::shareable`).
async fn share_file(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Ok(home) = store::agent_home(&caller.id) else {
        return error("Couldn't find your folder.");
    };
    let mut roots = vec![home.clone()];
    if let Ok(projects) = crate::commands::projects::list_projects().await {
        roots.extend(
            projects
                .into_iter()
                .map(|p| std::path::PathBuf::from(p.path)),
        );
    }
    let source = match files::shareable(arg(args, "path").unwrap_or(""), &home, &roots) {
        Ok(source) => source,
        Err(e) => return error(e),
    };
    let mut message = runner::new_message(
        &caller.id,
        MessageKind::Agent,
        arg(args, "caption").unwrap_or(""),
    );
    let id = message.id.clone();
    let saved = tokio::task::spawn_blocking(move || files::share(&home, &id, &source)).await;
    match saved {
        Ok(Ok(attachment)) => {
            let name = attachment.name.clone();
            message.attachments = vec![attachment];
            if let Err(e) = runner::record(app, message) {
                return error(e.to_string());
            }
            text(format!(
                "Shared {name}. The user sees it in the chat as a file they can open; don't paste its contents as well."
            ))
        }
        Ok(Err(e)) => error(e.to_string()),
        Err(e) => error(e.to_string()),
    }
}

/// A quiet line in a chat about something the Chief did, naming `peer` so the
/// UI can turn its name into a link. Nothing it does to the team is invisible.
fn audit_note(agent_id: &str, text: String, peer: Option<AgentRef>) -> store::AgentMessage {
    let mut note = runner::new_message(agent_id, MessageKind::Note, text);
    note.peer = peer;
    note
}

/// The lines a create leaves: in the Chief's chat, and the new agent's first.
fn create_notes(caller: &store::Agent, agent: &store::Agent) -> Vec<store::AgentMessage> {
    vec![
        audit_note(
            &caller.id,
            created_line(&agent.name, &agent.role, agent.project.as_deref()),
            Some(peer(agent)),
        ),
        audit_note(
            &agent.id,
            format!("Created by {}", caller.name),
            Some(peer(caller)),
        ),
    ]
}

/// The lines an update leaves, in the Chief's chat and the target's. None
/// when nothing actually changed.
fn update_notes(
    caller: &store::Agent,
    before: &store::Agent,
    after: &store::Agent,
    fields: &[&str],
) -> Vec<store::AgentMessage> {
    if before.name == after.name && fields.is_empty() {
        return Vec::new();
    }
    let (chief, target) = updated_lines(&before.name, &after.name, fields, &caller.name);
    let mut notes = vec![audit_note(&caller.id, chief, Some(peer(after)))];
    if after.id != caller.id {
        notes.push(audit_note(&after.id, target, Some(peer(caller))));
    }
    notes
}

/// "Created Finance · Invoices and the books · works in acme".
pub(crate) fn created_line(name: &str, role: &str, project: Option<&str>) -> String {
    let mut line = format!("Created {name}");
    if !role.is_empty() {
        line.push_str(&format!(" · {role}"));
    }
    if let Some(p) = project {
        line.push_str(&format!(" · works in {}", super::project::folder_name(p)));
    }
    line
}

/// What an update changed, for the Chief's chat ("Updated Acme Site's role and
/// instructions") and the target's ("Role and instructions updated by Chief
/// of Staff"). A rename leads, since the old name is the one to recognise.
pub(crate) fn updated_lines(
    old_name: &str,
    new_name: &str,
    fields: &[&str],
    by: &str,
) -> (String, String) {
    let list = match fields {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let renamed = old_name != new_name;
    let chief = match (renamed, list.is_empty()) {
        (true, true) => format!("Renamed {old_name} to {new_name}"),
        (true, false) => format!("Renamed {old_name} to {new_name} and updated its {list}"),
        (false, _) => format!("Updated {new_name}'s {list}"),
    };
    let mut target = match (renamed, list.is_empty()) {
        (true, true) => format!("Renamed from {old_name} by {by}"),
        (true, false) => format!("Renamed from {old_name}, and {list} updated, by {by}"),
        (false, _) => format!("{list} updated by {by}"),
    };
    if let Some(first) = target.get(..1) {
        target = first.to_uppercase() + &target[1..];
    }
    (chief, target)
}

async fn create_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(name) = arg(args, "name") else {
        return error("`name` is required.");
    };
    let project = match arg(args, "project") {
        Some(q) => match super::project::resolve(q).await {
            Ok(p) => p,
            Err(e) => return error(e.to_string()),
        },
        None => None,
    };
    let created = store::create(store::NewAgent {
        name: name.to_string(),
        role: arg(args, "role").unwrap_or("").to_string(),
        instructions: arg(args, "instructions").unwrap_or("").to_string(),
        shape: None,
        color: arg(args, "color").map(str::to_string),
        is_main: false,
    });
    let created = created.and_then(|agent| match &project {
        Some(p) => store::update(&agent.id, |a| a.project = Some(p.path.clone())),
        None => Ok(agent),
    });
    match created {
        Ok(agent) => {
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            for note in create_notes(caller, &agent) {
                let _ = runner::record(app, note);
            }
            let mut started = String::new();
            if let Some(task) = arg(args, "first_task") {
                let mut sent = runner::new_message(&caller.id, MessageKind::SentToAgent, task);
                sent.peer = Some(peer(&agent));
                let _ = runner::record(app, sent);
                let mut received = runner::new_message(&agent.id, MessageKind::FromAgent, task);
                received.peer = Some(peer(caller));
                let _ = runner::record(app, received);
                runner::enqueue(
                    app,
                    &agent.id,
                    task.to_string(),
                    From::Agent {
                        sender: peer(caller),
                        hop: 1,
                    },
                );
                started = " and started it on its first task".to_string();
            }
            text(format!(
                "Created {}{started}. It's in the user's sidebar now.",
                agent.name
            ))
        }
        Err(e) => error(e.to_string()),
    }
}

async fn update_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(target) = arg(args, "agent") else {
        return error("`agent` is required.");
    };
    let agent = match store::find(target) {
        Ok(Some(a)) => a,
        _ => return error(format!("There's no agent called {target}.")),
    };
    let new_name = match arg(args, "name").map(store::validate_name) {
        Some(Ok(n)) => Some(n),
        Some(Err(e)) => return error(e.to_string()),
        None => None,
    };
    if let Some(n) = &new_name {
        if matches!(store::find(n), Ok(Some(other)) if other.id != agent.id) {
            return error(format!("There's already an agent called {n}."));
        }
    }
    let project = match arg(args, "project") {
        Some(q) => match super::project::resolve(q).await {
            Ok(p) => Some(p.map(|p| p.path)),
            Err(e) => return error(e.to_string()),
        },
        None => None,
    };
    let role = arg(args, "role").map(str::to_string);
    let mut fields = Vec::new();
    if role.as_deref().is_some_and(|r| r != agent.role) {
        fields.push("role");
    }
    if arg(args, "instructions").is_some() {
        fields.push("instructions");
    }
    if project.as_ref().is_some_and(|p| *p != agent.project) {
        fields.push("project");
    }
    let updated = store::update(&agent.id, |a| {
        if let Some(n) = new_name {
            a.name = n;
        }
        if let Some(r) = role {
            a.role = r;
        }
        if let Some(p) = project {
            a.project = p;
        }
    });
    let updated = match updated {
        Ok(a) => a,
        Err(e) => return error(e.to_string()),
    };
    let instructions = match arg(args, "instructions") {
        Some(i) => i.to_string(),
        None => store::read_instructions(&agent.id).unwrap_or_default(),
    };
    if let Ok(home) = store::agent_home(&agent.id) {
        if let Err(e) = store::write_instructions(&home, &updated, &instructions) {
            return error(e.to_string());
        }
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    for note in update_notes(caller, &agent, &updated, &fields) {
        let _ = runner::record(app, note);
    }
    text(format!("Updated {}.", updated.name))
}

async fn delete_agent(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let Some(target) = arg(args, "agent") else {
        return error("`agent` is required.");
    };
    let agent = match store::find(target) {
        Ok(Some(a)) => a,
        _ => return error(format!("There's no agent called {target}.")),
    };
    if agent.is_main {
        return error("The Chief of Staff can't be deleted.");
    }
    let answer = ask_user(
        app,
        caller,
        format!("Delete {}", agent.name),
        "Its memory and conversation are deleted too. This can't be undone.".to_string(),
        None,
    )
    .await;
    if answer != Answer::Allowed {
        return error("The user said no. Don't delete it.");
    }
    runner::stop(&agent.id);
    match store::delete(&agent.id) {
        Ok(_) => {
            let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
            // No link: there's nothing left to open.
            let line = audit_note(&caller.id, format!("Deleted {}", agent.name), None);
            let _ = runner::record(app, line);
            text(format!("Deleted {}.", agent.name))
        }
        Err(e) => error(e.to_string()),
    }
}

/// Put an Allow / Deny card in the caller's chat and wait for the answer.
///
/// `call` is the Claude Code tool call the card is about, if any. Those cards
/// outlive the wait (see APPROVAL_WAIT_SECS); cards without one expire with it.
pub(super) async fn ask_user(
    app: &AppHandle,
    caller: &store::Agent,
    title: String,
    detail: String,
    call: Option<(&str, &Value)>,
) -> Answer {
    let request_id = store::new_id();
    let (tx, rx) = oneshot::channel();
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);

    let mut card = runner::new_message(&caller.id, MessageKind::Approval, "");
    card.approval = Some(new_card(request_id.clone(), title, detail, call));
    let _ = runner::record(app, card);
    store::refresh_pending(&caller.id);
    super::notify::refresh_badge(app);
    let before = runner::status_of(&caller.id);
    runner::set_status(
        app,
        &caller.id,
        Status {
            state: "waiting",
            activity: Some("Waiting for your OK".into()),
            since: before.since,
        },
    );

    let answer = match tokio::time::timeout(APPROVAL_WAIT, rx).await {
        Ok(Ok(true)) => Answer::Allowed,
        // The command wrote the decision (and any note) before waking us.
        Ok(Ok(false)) => Answer::Denied(
            store::find_approval(&caller.id, &request_id)
                .ok()
                .flatten()
                .and_then(|a| a.note),
        ),
        _ => Answer::NotYet,
    };
    PENDING_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);

    // An answered card was already written by the command. An unanswered one
    // stays pending if a late answer can still act on it, else it expires.
    if answer == Answer::NotYet && call.is_none() {
        if let Ok(Some(updated)) =
            store::set_approval_status(&caller.id, &request_id, ApprovalStatus::Expired)
        {
            let _ = tauri::Emitter::emit(app, runner::EVENT_MESSAGE, &updated);
        }
    }
    let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
    // Back to work, unless the turn already ended under the card (Stop, or
    // the user interrupted it): then it isn't ours to change.
    if runner::status_of(&caller.id).state == "waiting" {
        runner::set_status(
            app,
            &caller.id,
            Status {
                state: "working",
                activity: None,
                since: before.since,
            },
        );
    }
    answer
}

/// The card for a request. Only a Claude Code tool call can be always
/// allowed: Ship Studio's own confirmations (delete an agent) never offer it.
pub(super) fn new_card(
    request_id: String,
    title: String,
    detail: String,
    call: Option<(&str, &Value)>,
) -> Approval {
    Approval {
        request_id,
        title,
        detail,
        status: ApprovalStatus::Pending,
        tool: call.map(|(tool, _)| tool.to_string()),
        input: call.map(|(_, input)| input.clone()),
        always: call.and_then(|(tool, input)| permissions::suggest(tool, input)),
        always_allowed: false,
        note: None,
    }
}

/// The user chose "Always allow" on a card: keep its scope as a rule, and
/// return it so the other cards it covers can be answered too.
pub fn always_allow(
    agent_id: &str,
    approval: &Approval,
) -> Result<permissions::Scope, CommandError> {
    let Some(scope) = approval.always.clone() else {
        return Err(CommandError::expected(
            "This one can't be always allowed. Allow it once instead.",
        ));
    };
    store::update(agent_id, |a| {
        if !a.permissions.iter().any(|r| r.scope == scope) {
            a.permissions.push(permissions::Rule {
                id: store::new_id(),
                scope: scope.clone(),
                created_at: store::now_ms(),
            });
        }
    })?;
    Ok(scope)
}

/// The other open cards a new rule covers: they'd go through without asking
/// now, so they shouldn't sit there asking.
pub fn covered_by(scope: &permissions::Scope, open: &[Approval], except: &str) -> Vec<String> {
    open.iter()
        .filter(|a| a.request_id != except && a.status == ApprovalStatus::Pending)
        .filter(|a| match (&a.tool, &a.input) {
            (Some(tool), Some(input)) => scope.matches(tool, input),
            _ => false,
        })
        .map(|a| a.request_id.clone())
        .collect()
}

/// What an automatically allowed call is, in one line: the command or the
/// address when there is one, else what the tool does.
fn one_line(tool: &str, input: &Value) -> String {
    let (title, detail) = describe_request(tool, input);
    let line = match tool {
        "Bash" | "WebFetch" | "WebSearch" => detail.lines().next().unwrap_or("").trim().to_string(),
        _ => String::new(),
    };
    let line = if line.is_empty() { title } else { line };
    if line.chars().count() > 120 {
        line.chars().take(120).collect::<String>() + "…"
    } else {
        line
    }
}

/// The user answered a card nobody is waiting on any more. Allow grants that
/// exact call once and wakes the agent to finish; Deny just records it.
pub fn answer_late(
    app: &AppHandle,
    agent_id: &str,
    approval: &Approval,
    allow: bool,
) -> Result<(), CommandError> {
    let (Some(tool), Some(input)) = (&approval.tool, &approval.input) else {
        return Err(CommandError::expected(
            "That request isn't waiting any more. Ask the agent to try again.",
        ));
    };
    if !allow {
        return Ok(());
    }
    grant_once(agent_id, tool, input);
    runner::enqueue(
        app,
        agent_id,
        format!(
            "[The user has now approved this, which you asked for earlier: {} — {}. It will go through without asking if you run it exactly as before. Carry on with what you were doing.]",
            approval.title, approval.detail
        ),
        runner::From::User,
    );
    Ok(())
}

/// Turn a pending tool call into words a person can approve.
pub fn describe_request(tool: &str, input: &Value) -> (String, String) {
    let field = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match tool {
        "Bash" => ("Run a command".into(), field("command")),
        "Write" => ("Create a file".into(), field("file_path")),
        "Edit" | "MultiEdit" => ("Edit a file".into(), field("file_path")),
        "Read" => ("Read a file outside its folders".into(), field("file_path")),
        "WebFetch" => ("Open a web page".into(), field("url")),
        "WebSearch" => ("Search the web".into(), field("query")),
        other => {
            let mut detail = serde_json::to_string_pretty(input).unwrap_or_default();
            if detail.chars().count() > 600 {
                detail = detail.chars().take(600).collect::<String>() + "…";
            }
            (mcp_title(other), detail)
        }
    }
}

/// `mcp__gmail__send_email` → "Send an email · Gmail": a verb phrase from the
/// tool's name, with the server it belongs to as context. Anything that isn't
/// an MCP tool name keeps its own name after "Use".
fn mcp_title(tool: &str) -> String {
    let Some((server, name)) = tool.strip_prefix("mcp__").and_then(|t| t.split_once("__")) else {
        return format!("Use {tool}");
    };
    let words = split_words(name);
    let Some((verb, object)) = words.split_first() else {
        return format!("Use {tool}");
    };
    let mut phrase = capitalize(verb);
    if !object.is_empty() {
        let last = object.last().map(String::as_str).unwrap_or("");
        // "Send an email", "Create a draft"; but "List messages", "Get status".
        let countable = !last.ends_with('s')
            && ![
                "content",
                "data",
                "info",
                "information",
                "metadata",
                "text",
                "code",
                "status",
            ]
            .contains(&last);
        if countable {
            let vowel = object[0].starts_with(['a', 'e', 'i', 'o', 'u']);
            phrase.push_str(if vowel { " an" } else { " a" });
        }
        phrase.push(' ');
        phrase.push_str(&object.join(" "));
    }
    // Claude.ai connectors arrive as `claude_ai_Gmail`.
    let server = server.strip_prefix("claude_ai_").unwrap_or(server);
    let server = match server.to_ascii_lowercase().as_str() {
        "github" => "GitHub".to_string(),
        _ => split_words(server)
            .iter()
            .map(|w| capitalize(w))
            .collect::<Vec<_>>()
            .join(" "),
    };
    format!("{phrase} · {server}")
}

/// `send_email`, `send-email` and `sendEmail` → ["send", "email"].
fn split_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for c in name.chars() {
        if c == '_' || c == '-' || c == ' ' || c == '.' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
        } else if c.is_uppercase() && current.chars().last().is_some_and(|p| p.is_lowercase()) {
            words.push(std::mem::take(&mut current));
            current.extend(c.to_lowercase());
        } else {
            current.extend(c.to_lowercase());
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

async fn approve(app: &AppHandle, caller: &store::Agent, args: &Value) -> Value {
    let tool = args
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool");
    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
    let allow = json!({ "behavior": "allow", "updatedInput": input });
    if take_grant(&caller.id, tool, &input) {
        return text(allow.to_string());
    }
    if permissions::matching(&caller.permissions, tool, &input).is_some() {
        // Nothing happens invisibly: each one leaves a quiet line in the chat.
        let line = format!(
            "Allowed automatically: {} · Always allowed",
            one_line(tool, &input)
        );
        let _ = runner::record(
            app,
            runner::new_message(&caller.id, MessageKind::Note, line),
        );
        return text(allow.to_string());
    }
    let (title, detail) = describe_request(tool, &input);
    let answer = match ask_user(app, caller, title, detail, Some((tool, &input))).await {
        Answer::Allowed => allow,
        Answer::Denied(None) => {
            json!({ "behavior": "deny", "message": "The user said no to this. Don't retry it; tell them what you were trying to do, or find another way." })
        }
        Answer::Denied(Some(note)) => {
            json!({ "behavior": "deny", "message": format!("The user said no to this, and told you: \"{note}\". Don't retry it; do what they said instead.") })
        }
        Answer::NotYet => {
            json!({ "behavior": "deny", "message": "The user hasn't answered yet; they may be away. Don't retry and don't work around it. Stop here and tell them in one short line what you need approved and why. The request stays in their chat: if they allow it later, you'll be woken up to finish, and that exact call will go through." })
        }
    };
    text(answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(id: &str, name: &str) -> store::Agent {
        serde_json::from_value(json!({
            "id": id, "name": name, "role": "Invoices and the books",
            "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap()
    }

    #[test]
    fn chief_actions_leave_linked_notes_in_both_chats() {
        let chief = named("chief", "Chief of Staff");
        let finance = named("fin", "Finance");
        let notes = create_notes(&chief, &finance);
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|n| n.kind == MessageKind::Note));
        assert_eq!(notes[0].agent_id, "chief");
        assert_eq!(notes[0].text, "Created Finance · Invoices and the books");
        assert_eq!(notes[0].peer.as_ref().unwrap().id, "fin");
        assert_eq!(notes[1].agent_id, "fin");
        assert_eq!(notes[1].text, "Created by Chief of Staff");
        assert_eq!(notes[1].peer.as_ref().unwrap().id, "chief");

        let notes = update_notes(&chief, &finance, &finance, &["instructions"]);
        assert_eq!(
            notes
                .iter()
                .map(|n| (n.agent_id.as_str(), n.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("chief", "Updated Finance's instructions"),
                ("fin", "Instructions updated by Chief of Staff")
            ]
        );
        // Nothing changed: nothing said. The Chief updating itself: one line.
        assert!(update_notes(&chief, &finance, &finance, &[]).is_empty());
        assert_eq!(update_notes(&chief, &chief, &chief, &["role"]).len(), 1);
    }

    #[test]
    fn audit_lines_say_what_the_chief_did() {
        assert_eq!(
            created_line("Finance", "Invoices and the books", None),
            "Created Finance · Invoices and the books"
        );
        assert_eq!(
            created_line("Acme Site", "", Some("/u/ShipStudio/acme/")),
            "Created Acme Site · works in acme"
        );
        let by = "Chief of Staff";
        assert_eq!(
            updated_lines("Acme Site", "Acme Site", &["instructions"], by),
            (
                "Updated Acme Site's instructions".into(),
                "Instructions updated by Chief of Staff".into()
            )
        );
        assert_eq!(
            updated_lines("Acme", "Acme", &["role", "instructions", "project"], by).0,
            "Updated Acme's role, instructions and project"
        );
        assert_eq!(
            updated_lines("Finance", "Books", &[], by),
            (
                "Renamed Finance to Books".into(),
                "Renamed from Finance by Chief of Staff".into()
            )
        );
        assert_eq!(
            updated_lines("Finance", "Books", &["role"], by).0,
            "Renamed Finance to Books and updated its role"
        );
    }

    #[test]
    fn a_late_allow_grants_exactly_one_identical_call() {
        let input = json!({ "command": "git commit -m x" });
        grant_once("agent-a", "Bash", &input);
        // Another agent, another tool or another input doesn't match.
        assert!(!take_grant("agent-b", "Bash", &input));
        assert!(!take_grant("agent-a", "Write", &input));
        assert!(!take_grant(
            "agent-a",
            "Bash",
            &json!({ "command": "git push" })
        ));
        assert!(take_grant("agent-a", "Bash", &input));
        // Once.
        assert!(!take_grant("agent-a", "Bash", &input));
    }

    #[test]
    fn a_new_rule_covers_other_open_cards_it_matches() {
        let card = |id: &str, cmd: &str| {
            new_card(
                id.into(),
                "Run a command".into(),
                cmd.into(),
                Some(("Bash", &json!({ "command": cmd }))),
            )
        };
        let open = vec![
            card("a", "npm test"),
            card("b", "npm test -- --watch"),
            card("c", "npm test && rm -rf build"),
            card("d", "git push"),
            new_card("e".into(), "Delete agent".into(), "Finance".into(), None),
        ];
        let scope = open[0].always.clone().unwrap();
        assert_eq!(covered_by(&scope, &open, "a"), vec!["b".to_string()]);
    }

    #[test]
    fn only_tool_calls_can_be_always_allowed() {
        let input = json!({ "command": "npm test" });
        let card = new_card("r".into(), "t".into(), "d".into(), Some(("Bash", &input)));
        assert_eq!(card.always.map(|s| s.value).as_deref(), Some("npm test"));
        // Ship Studio's own confirmation (delete an agent) has no call.
        let confirm = new_card("r".into(), "Delete Finance".into(), "d".into(), None);
        assert!(confirm.always.is_none());
        assert!(always_allow("agent-a", &confirm).is_err());
    }

    #[test]
    fn auto_allowed_lines_name_the_call() {
        assert_eq!(
            one_line("Bash", &json!({ "command": "npm test\nmore" })),
            "npm test"
        );
        assert_eq!(
            one_line("mcp__gmail__send_email", &json!({ "to": "x" })),
            "Send an email · Gmail"
        );
    }

    #[test]
    fn commands_are_described_by_the_command_itself() {
        let (title, detail) =
            describe_request("Bash", &json!({ "command": "git push origin main" }));
        assert_eq!(title, "Run a command");
        assert_eq!(detail, "git push origin main");
    }

    #[test]
    fn mcp_tools_get_a_readable_name() {
        let title = |tool: &str| describe_request(tool, &json!({ "to": "x" })).0;
        assert_eq!(title("mcp__gmail__send_email"), "Send an email · Gmail");
        assert_eq!(
            title("mcp__claude_ai_Gmail__create_draft"),
            "Create a draft · Gmail"
        );
        assert_eq!(
            title("mcp__github__list_pull_requests"),
            "List pull requests · GitHub"
        );
        assert_eq!(
            title("mcp__google-drive__getFileContent"),
            "Get file content · Google Drive"
        );
        assert_eq!(title("mcp__linear__search"), "Search · Linear");
        assert_eq!(title("SomethingElse"), "Use SomethingElse");
    }

    #[test]
    fn management_tools_are_hidden_from_regular_agents() {
        let agent = store::Agent {
            id: "a".into(),
            name: "Finance".into(),
            role: String::new(),
            shape: 0,
            color: "red".into(),
            is_main: false,
            pinned: false,
            hidden: false,
            session_id: None,
            created_at: 0,
            last_activity_at: 0,
            preview: None,
            unread: 0,
            pending_approvals: 0,
            model: None,
            muted: false,
            check_ins: Vec::new(),
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
            capabilities: None,
        };
        let names: Vec<String> = tools_list(&agent)["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"message_agent".to_string()));
        assert!(names.contains(&"share_file".to_string()));
        assert!(!names.contains(&"create_agent".to_string()));
        assert!(!names.contains(&"delete_agent".to_string()));
    }
}
