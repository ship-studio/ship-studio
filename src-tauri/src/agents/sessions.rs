//! Agents work on projects the way Remote Access does: in the project's own
//! agent tabs.
//!
//! These are Remote Access's project tools (`remote_access/tools.rs`), served
//! to every agent under names that can't be mistaken for agent-to-agent
//! `message_agent`, and run by the very same handlers. A session an agent
//! starts is a real workspace tab (a backend PTY session), so the user can
//! open the project and carry on the same conversation whenever they like.
//!
//! What this file adds is only what differs for an agent:
//!
//! - **Which projects:** every Ship Studio project, not the remote's opt-in
//!   list (agents already run as the user, with every project an `--add-dir`).
//! - **The chat:** a call runs inside `AGENTS_CALL`, which collects what it
//!   started, the replies it saw and its screenshots; those become compact
//!   `session` lines in the agent's chat. Screenshots go into the chat, never
//!   behind the remote's public image links.
//! - **Pushing:** no PIN. The user is asked with a card in the agent's chat
//!   showing the branch, the commits and the remote. It has no tool call
//!   behind it, so "Always allow" is never offered and no rule can skip it.
//! - **Audit:** the remote's log, with the agent's name as the actor.
//!
//! Everything about safety in the shared handlers holds unchanged: text goes
//! only to agent tabs, never shells; a leading `!`, a `/` command outside the
//! allowlist and control characters are refused; an opening prompt can't
//! start with `-`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::mcp::{self, Answer};
use super::runner;
use super::store::{self, MessageKind};
use crate::remote_access::server::{audit_detail, READ_ONLY_TOOLS};
use crate::remote_access::tools::{self as shared, AgentsCall, Outcome, AGENTS_CALL};

/// One project tool: its name for agents, the shared handler it runs, and
/// how it's described to an agent.
pub struct Tool {
    pub name: &'static str,
    remote: &'static str,
    description: &'static str,
    /// It may switch the window to the project (see `agents-session-*`).
    shows_project: bool,
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "project_list",
        remote: "list_projects",
        description: "The user's Ship Studio projects: name, path, git branch, uncommitted changes, and each project's sessions (agent tabs) with whether they're working, finished or waiting on the user. Anything waiting on the user is at the top.",
        shows_project: false,
    },
    Tool {
        name: "project_create",
        remote: "create_project",
        description: "Create a new Ship Studio project from a starter, when the user asks for a new project or site. It appears in their Projects straight away. Takes a minute or two (download, then install). Then start a session in it to build what they asked for.",
        shows_project: false,
    },
    Tool {
        name: "project_open",
        remote: "open_project",
        description: "Show a project in Ship Studio and start its preview. Session and screenshot tools already do this when they need to; call it only when the user asks to see a project.",
        shows_project: true,
    },
    Tool {
        name: "session_message",
        remote: "message_agent",
        description: "THE way to change a project. Sends a message to the project's session (its Claude Code tab, the one the user works in; the most recently active one unless you name a tab), as if the user typed it, then WAITS and returns STATUS, the session's reply, which files changed and, when it's done, a screenshot. Starts a session only if none is running. Every result ends with NEXT: do what it says.",
        shows_project: true,
    },
    Tool {
        name: "session_start",
        remote: "start_agent",
        description: "Start a separate, additional session in a project with a first prompt. Only when you want parallel work in the same project; to continue work use session_message, even when the session is busy. Waits for its first reply like session_message.",
        shows_project: true,
    },
    Tool {
        name: "session_wait",
        remote: "wait_for_agent",
        description: "Keep watching a session that is still working, until it finishes or asks something. Call it whenever a result says STATUS: working, repeatedly, until it doesn't.",
        shows_project: false,
    },
    Tool {
        name: "session_read",
        remote: "read_agent",
        description: "The exact text a session's terminal is showing, with its STATUS. For following work, session_wait is better.",
        shows_project: false,
    },
    Tool {
        name: "session_key",
        remote: "press_key",
        description: "Press one key in a session to answer what it is asking (STATUS: needs_decision lists the options). Only with the user's answer: ask them first, in this chat.",
        shows_project: false,
    },
    Tool {
        name: "session_close",
        remote: "close_agent",
        description: "Close a session's tab, ending it. Only when the user asks. A project's last tab can't be closed.",
        shows_project: false,
    },
    Tool {
        name: "session_progress",
        remote: "show_progress",
        description: "Where a project is at: waits for its session's current step, then returns its STATUS and reply, which files changed, preview errors, and a screenshot.",
        shows_project: true,
    },
    Tool {
        name: "preview_screenshot",
        remote: "preview_screenshot",
        description: "A sharp screenshot of the project's live preview (desktop, phone or both; any page). It appears in this chat for the user too.",
        shows_project: true,
    },
    Tool {
        name: "git_status",
        remote: "git_status",
        description: "The project's branch, uncommitted files and recent commits.",
        shows_project: false,
    },
    Tool {
        name: "push",
        remote: "push",
        description: "Push the project's current branch to GitHub (origin), committing uncommitted changes first. The user is asked in this chat with a card showing the branch, the commits and the remote; nothing is pushed unless they allow it. Only when the user asked for a push.",
        shows_project: false,
    },
    Tool {
        name: "deploy_status",
        remote: "deploy_status",
        description: "Whether the commit last pushed from this project went live on its host (Vercel, Cloudflare Pages or Netlify), as the host reports it. Call it after a push.",
        shows_project: false,
    },
];

pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

/// The remote's tool names, as an agent knows them. The shared handlers'
/// answers name their follow-up tools ("NEXT: call wait_for_agent"); an agent
/// must read the names it actually has.
const RENAMES: &[(&str, &str)] = &[
    ("list_projects", "project_list"),
    ("create_project", "project_create"),
    ("open_project", "project_open"),
    ("message_agent", "session_message"),
    ("start_agent", "session_start"),
    ("wait_for_agent", "session_wait"),
    ("read_agent", "session_read"),
    ("press_key", "session_key"),
    ("close_agent", "session_close"),
    ("show_progress", "session_progress"),
    ("prepare_push", "push"),
    ("confirm_push", "push"),
];

/// Rename whole identifiers only, so `remote-start-agent` or a word that
/// merely contains a tool name is left alone.
pub fn rename(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        let mapped = RENAMES
            .iter()
            .find(|(from, _)| *from == word.as_str())
            .map(|(_, to)| *to);
        out.push_str(mapped.unwrap_or(word));
        word.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn rename_result(mut result: Value) -> Value {
    if let Some(blocks) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            if let Some(Value::String(t)) = block.get_mut("text") {
                *t = rename(t);
            }
        }
    }
    result
}

fn push_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project": { "type": "string", "description": "Project name or path from project_list." }
        },
        "required": ["project"]
    })
}

pub fn definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| {
            let schema = match t.name {
                "push" => push_schema(),
                _ => shared::schema_of(t.remote).unwrap_or_else(|| json!({ "type": "object" })),
            };
            // Property descriptions name the remote's tools too.
            let schema = serde_json::from_str(&rename(&schema.to_string())).unwrap_or(schema);
            json!({ "name": t.name, "description": t.description, "inputSchema": schema })
        })
        .collect()
}

// ============================================================================
// The chat: what a session call leaves in the agent's conversation
// ============================================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionEvent {
    Started,
    Sent,
    Reply,
    Screenshot,
}

/// A `session` line: which project, which session, and what happened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMark {
    pub project: String,
    pub event: SessionEvent,
    /// The tab's PTY session id, so "Open session" can focus that tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Its number among the project's tabs when this happened ("Claude Code 1").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<usize>,
    /// The tab's agent CLI (`claude`, `codex`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
}

/// The last reply recorded per session, so watching a finished session twice
/// doesn't post its reply twice.
static LAST_REPLY: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const REPLY_LINES: usize = 12;

/// What a call's outcomes say in the chat, in order: (event, outcome, text).
/// Pure, apart from the reply de-duplication.
fn plan<'a>(
    tool: &str,
    args: &Value,
    outcomes: &'a [Outcome],
    started: &[String],
) -> Vec<(SessionEvent, &'a Outcome, String)> {
    let said = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let mut out = Vec::new();
    for o in outcomes {
        if started.contains(&o.session_id) {
            let first = if tool == "session_start" {
                said("prompt")
            } else {
                said("message")
            };
            out.push((SessionEvent::Started, o, first));
        } else if tool == "session_message" {
            out.push((SessionEvent::Sent, o, said("message")));
        }
        if o.state == "finished" && !o.reply.is_empty() {
            let shown = &o.reply[o.reply.len().saturating_sub(REPLY_LINES)..];
            let text = shown.join("\n").trim().to_string();
            let mut last = LAST_REPLY.lock().unwrap_or_else(|e| e.into_inner());
            if !text.is_empty() && last.get(&o.session_id) != Some(&text) {
                last.insert(o.session_id.clone(), text.clone());
                out.push((SessionEvent::Reply, o, text));
            }
        }
    }
    out
}

fn mark(project: &str, event: SessionEvent, o: Option<&Outcome>) -> SessionMark {
    SessionMark {
        project: project.to_string(),
        event,
        session_id: o.map(|o| o.session_id.clone()),
        tab: o.map(|o| o.tab),
        cli: o.map(|o| o.cli.clone()).filter(|c| !c.is_empty()),
    }
}

fn record_lines(
    app: &AppHandle,
    caller: &store::Agent,
    tool: &str,
    project: &str,
    args: &Value,
    seen: &Seen,
) {
    for (event, outcome, text) in plan(tool, args, &seen.outcomes, &seen.started) {
        let mut line = runner::new_message(&caller.id, MessageKind::Session, text);
        line.session = Some(mark(project, event, Some(outcome)));
        let _ = runner::record(app, line);
    }
    let Ok(home) = store::agent_home(&caller.id) else {
        return;
    };
    for (device, jpeg) in &seen.shots {
        use base64::Engine;
        let mut line = runner::new_message(&caller.id, MessageKind::Session, *device);
        let saved = super::attachments::save(
            &home,
            &line.id,
            vec![super::attachments::OutgoingAttachment {
                name: format!("{}-{device}.jpg", shared::project_name(project)),
                path: None,
                data: Some(base64::engine::general_purpose::STANDARD.encode(jpeg)),
            }],
        );
        let Ok(attachments) = saved else { continue };
        line.attachments = attachments;
        line.session = Some(mark(project, SessionEvent::Screenshot, None));
        let _ = runner::record(app, line);
    }
}

// ============================================================================
// Calls
// ============================================================================

/// What a call collected for the chat.
#[derive(Default)]
struct Seen {
    shots: Vec<(&'static str, Vec<u8>)>,
    outcomes: Vec<Outcome>,
    started: Vec<String>,
}

async fn all_projects() -> Vec<String> {
    crate::commands::projects::list_projects()
        .await
        .map(|list| list.into_iter().map(|p| p.path).collect())
        .unwrap_or_default()
}

/// Tell the project's window an agent is about to use it, and when it's done,
/// so a window the user was reading Agents in goes back to Agents afterwards
/// (`useAgentsReturn`).
fn announce(app: &AppHandle, project: &str, event: &str) {
    let _ = app.emit_to(
        shared::window_for(project),
        event,
        json!({ "projectPath": project }),
    );
}

pub async fn call(app: &AppHandle, caller: &store::Agent, tool: &Tool, args: &Value) -> Value {
    let projects = all_projects().await;
    let wanted = args.get("project").and_then(Value::as_str);
    let project = shared::resolve_project(&projects, wanted).ok();
    let result = if tool.name == "push" {
        match &project {
            Some(p) => push(app, caller, p).await,
            None => mcp_error(
                shared::resolve_project(&projects, wanted)
                    .err()
                    .unwrap_or_default(),
            ),
        }
    } else {
        let announced = project.as_deref().filter(|_| tool.shows_project);
        if let Some(p) = announced {
            announce(app, p, "agents-session-begin");
        }
        let (result, seen) = AGENTS_CALL
            .scope(AgentsCall::default(), async {
                let result = shared::call_in(app, &projects, tool.remote, args.clone()).await;
                let seen = AGENTS_CALL.with(|c| Seen {
                    shots: c.shots.take(),
                    outcomes: c.outcomes.take(),
                    started: c.started.take(),
                });
                (result, seen)
            })
            .await;
        if let Some(p) = announced {
            announce(app, p, "agents-session-end");
        }
        if let Some(p) = &project {
            record_lines(app, caller, tool.name, p, args, &seen);
        }
        rename_result(result)
    };
    audit(caller, tool, project.as_deref(), args, &result);
    result
}

/// The same log, rules and wording as remote access, naming the agent.
fn audit(caller: &store::Agent, tool: &Tool, project: Option<&str>, args: &Value, result: &Value) {
    if READ_ONLY_TOOLS.contains(&tool.remote) {
        return;
    }
    let ok = result.get("isError").and_then(Value::as_bool) != Some(true);
    let detail = audit_detail(tool.remote, args);
    let detail = if ok {
        detail
    } else {
        let reason = result
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("");
        crate::remote_access::preview(&format!("{detail} — refused: {reason}"))
    };
    crate::remote_access::audit_as(Some(&caller.name), tool.name, project, detail, ok);
}

fn mcp_error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

fn mcp_text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

// ============================================================================
// Pushing: a card in the chat instead of a PIN
// ============================================================================

/// `https://user:token@github.com/a/b.git` → `https://github.com/a/b.git`.
/// The card shows where it goes, never a credential.
pub fn display_remote(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    match authority.rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

/// The card's detail: where it goes, then what goes.
pub fn push_card_detail(remote: &str, branch: &str, commits: &str, uncommitted: &str) -> String {
    let mut detail = format!("Branch {branch} → origin ({remote})\n\nCommits:\n{commits}");
    if !uncommitted.trim().is_empty() {
        detail.push_str(&format!("\n\nCommitted first:\n{uncommitted}"));
    }
    detail
}

const PUSH_COMMIT_MESSAGE: &str = "Update from Ship Studio Agents";

async fn push(app: &AppHandle, caller: &store::Agent, project: &str) -> Value {
    let name = shared::project_name(project).to_string();
    let branch = match shared::git(project, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok(b) => b.trim().to_string(),
        Err(e) => return mcp_error(format!("git failed: {e}")),
    };
    if branch == "HEAD" {
        return mcp_error("The project isn't on a branch (detached HEAD), so there's nothing to push. Tell the user.");
    }
    let remote = match shared::git(project, &["remote", "get-url", "origin"]).await {
        Ok(url) if !url.trim().is_empty() => display_remote(&url),
        _ => return mcp_error(format!("{name} has no GitHub remote (origin) yet, so it can't be pushed. The user connects one from the project's Push button.")),
    };
    let (head, tree) = match shared::frozen_tree(project).await {
        Ok(s) => s,
        Err(e) => return mcp_error(format!("git failed: {e}")),
    };
    let commits = match shared::git(project, &["log", "--oneline", "@{u}..HEAD"]).await {
        Ok(log) => shared::cap_lines(log.trim(), 20),
        // No upstream yet: the branch is created on origin.
        Err(_) => shared::cap_lines(
            shared::git(project, &["log", "--oneline", "-5"])
                .await
                .unwrap_or_default()
                .trim(),
            5,
        ),
    };
    let status = shared::git(project, &["status", "--short"])
        .await
        .unwrap_or_default();
    if status.trim().is_empty() && commits.is_empty() {
        return mcp_text(format!(
            "Nothing to push: {branch} is already up to date on origin."
        ));
    }
    let commits = if commits.is_empty() {
        "(none yet)".to_string()
    } else {
        commits
    };
    let detail = push_card_detail(&remote, &branch, &commits, &shared::cap_lines(&status, 20));
    let answer = mcp::ask_user(app, caller, format!("Push {name}"), detail, None).await;
    match answer {
        Answer::Allowed => {}
        Answer::Denied(None) => return mcp_error("The user said no. Don't push."),
        Answer::Denied(Some(note)) => {
            return mcp_error(format!("The user said no, and told you: \"{note}\". Don't push."))
        }
        Answer::NotYet => {
            return mcp_error("The user didn't answer the push card in time; nothing was pushed. Tell them in one line, and call push again when they say so.")
        }
    }
    // Pushed is exactly what the card showed, or nothing.
    match shared::frozen_tree(project).await {
        Ok(now) if now == (head.clone(), tree.clone()) => {}
        Ok(_) => return mcp_error("The project changed after the user saw the card, so nothing was pushed. Call push again to show them the new one."),
        Err(e) => return mcp_error(format!("git failed: {e}")),
    }
    match shared::push_frozen(project, &branch, &head, &tree, PUSH_COMMIT_MESSAGE).await {
        Ok(sha) => mcp_text(format!(
            "Pushed {name} to origin/{branch} (commit {}), exactly what the card showed.\n\nNEXT: Tell the user it's pushed, then call deploy_status and report whether it went live.",
            &sha[..sha.len().min(8)]
        )),
        Err(e) => mcp_error(format!("The push failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(id: &str, state: &'static str, reply: &[&str]) -> Outcome {
        Outcome {
            session_id: id.into(),
            tab: 2,
            cli: "claude".into(),
            state,
            reply: reply.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn every_tool_runs_a_remote_handler_and_never_collides_with_agent_tools() {
        for tool in TOOLS {
            if tool.name != "push" {
                assert!(
                    crate::remote_access::tools::exists(tool.remote),
                    "{} has no shared handler",
                    tool.name
                );
            }
            assert!(
                ![
                    "message_agent",
                    "list_agents",
                    "create_agent",
                    "list_projects"
                ]
                .contains(&tool.name),
                "{} collides",
                tool.name
            );
        }
        let defs = definitions();
        assert_eq!(defs.len(), TOOLS.len());
        for d in &defs {
            assert_eq!(d["inputSchema"]["type"], "object", "{}", d["name"]);
            // Schemas that pointed at the remote's names point at ours.
            assert!(!d.to_string().contains("list_projects"), "{}", d["name"]);
        }
        // Remote-only powers stay remote-only.
        for remote_only in [
            "computer_status",
            "import_agents",
            "prepare_push",
            "confirm_push",
        ] {
            assert!(TOOLS.iter().all(|t| t.remote != remote_only));
        }
    }

    #[test]
    fn answers_name_the_tools_an_agent_has() {
        assert_eq!(
            rename("NEXT: Call wait_for_agent now. If not, message_agent starts one."),
            "NEXT: Call session_wait now. If not, session_message starts one."
        );
        // Whole identifiers only.
        assert_eq!(
            rename("remote-start-agent my_message_agent_x"),
            "remote-start-agent my_message_agent_x"
        );
        assert_eq!(rename("prepare_push starts a push"), "push starts a push");
    }

    #[test]
    fn the_shared_refusals_hold_for_agents() {
        use crate::remote_access::tools::{check_message_kind, not_a_flag, sanitize_message};
        assert!(check_message_kind("!rm -rf ~").is_err());
        assert!(check_message_kind("  !ls").is_err());
        assert!(check_message_kind("/permissions add Bash").is_err());
        assert!(check_message_kind("/add-dir /").is_err());
        assert!(check_message_kind("/compact").is_ok());
        assert!(check_message_kind("Make the hero bigger").is_ok());
        assert_eq!(sanitize_message("hi\x1b[201~\x03there\n"), "hi[201~there\n");
        assert_eq!(
            not_a_flag("--dangerously-skip-permissions"),
            " --dangerously-skip-permissions"
        );
    }

    #[test]
    fn session_lines_say_started_sent_and_reply_once() {
        let started = vec!["new".to_string()];
        let outcomes = vec![outcome("new", "finished", &["Done: the hero is bigger."])];
        let lines = plan(
            "session_start",
            &json!({ "prompt": "Make the hero bigger" }),
            &outcomes,
            &started,
        );
        let events: Vec<_> = lines.iter().map(|(e, _, t)| (*e, t.as_str())).collect();
        assert_eq!(
            events,
            vec![
                (SessionEvent::Started, "Make the hero bigger"),
                (SessionEvent::Reply, "Done: the hero is bigger.")
            ]
        );
        // Watching the same finished session again doesn't repeat the reply.
        assert!(plan("session_wait", &json!({}), &outcomes, &[]).is_empty());

        let busy = vec![outcome("s2", "working", &["Editing…"])];
        let lines = plan(
            "session_message",
            &json!({ "message": "Also the footer" }),
            &busy,
            &[],
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].0, SessionEvent::Sent);
        assert_eq!(lines[0].1.tab, 2);
        // A key press is no news until there's a reply.
        assert!(plan("session_key", &json!({ "key": "1" }), &busy, &[]).is_empty());
    }

    #[test]
    fn the_push_card_shows_branch_commits_and_remote_without_credentials() {
        assert_eq!(
            display_remote("https://x-access-token:ghs_secret@github.com/acme/site.git\n"),
            "https://github.com/acme/site.git"
        );
        assert_eq!(
            display_remote("git@github.com:acme/site.git"),
            "git@github.com:acme/site.git"
        );
        let detail = push_card_detail(
            "https://github.com/acme/site.git",
            "main",
            "a1b2c3 Bigger hero",
            " M src/app/page.tsx",
        );
        assert!(detail.starts_with("Branch main → origin (https://github.com/acme/site.git)"));
        assert!(detail.contains("Commits:\na1b2c3 Bigger hero"));
        assert!(detail.contains("Committed first:\n M src/app/page.tsx"));
        assert!(!push_card_detail("r", "main", "c", "  ").contains("Committed first"));
    }

    #[test]
    fn a_push_card_can_never_be_always_allowed() {
        // ask_user with no tool call behind it: no scope, so no rule.
        let card = mcp::new_card(
            "r".into(),
            "Push site".into(),
            "Branch main → origin".into(),
            None,
        );
        assert!(card.always.is_none());
    }
}
