//! Running agents: one Claude Code turn at a time per agent, many agents at once.
//!
//! Each agent has an inbox. Sending (from the user or another agent) appends
//! to it; if the agent is idle a worker starts and drains it — everything that
//! queued up while a turn ran becomes the next turn, so a burst of messages is
//! one coherent reply instead of five. A turn is a single
//! `claude --print --resume <session>` process: no long-lived process per
//! agent, so twenty idle agents cost nothing.
//!
//! What the user sees is built from the stream as it happens: each text block
//! the model writes becomes a chat message the moment it arrives; tool calls
//! only ever update the "working" line under the agent's name.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

use super::notify;
use super::prompts;
use super::store::{self, AgentMessage, AgentRef, MessageKind};
use crate::errors::CommandError;

pub const EVENT_MESSAGE: &str = "agents://message";
pub const EVENT_STATUS: &str = "agents://status";
pub const EVENT_REGISTRY: &str = "agents://registry";

/// Agents messaging agents can ping-pong forever. A chain started by the user
/// may run this many agent-to-agent hops before `message_agent` refuses.
pub const MAX_HOPS: u8 = 6;

/// A turn that runs this long is stopped. Long enough to babysit a CI run.
const TURN_TIMEOUT_SECS: u64 = 3 * 60 * 60;

#[derive(Debug, Clone)]
pub enum From {
    User,
    Agent { sender: AgentRef, hop: u8 },
}

#[derive(Debug, Clone)]
struct Inbound {
    text: String,
    from: From,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `idle`, `working`, or `waiting` (on the user's approval).
    pub state: &'static str,
    /// What it's doing right now, in a few words ("Reading …/src/App.tsx").
    pub activity: Option<String>,
    pub since: Option<i64>,
}

impl Status {
    fn idle() -> Self {
        Status {
            state: "idle",
            activity: None,
            since: None,
        }
    }
}

#[derive(Default)]
struct Runtime {
    queue: VecDeque<Inbound>,
    running: bool,
    status: Option<Status>,
    cancel: Option<Arc<Notify>>,
    /// Hop count of the turn in progress (0 when the user started it).
    hop: u8,
}

static RUNTIMES: LazyLock<Mutex<HashMap<String, Runtime>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn status_of(agent_id: &str) -> Status {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.status.clone())
        .unwrap_or_else(Status::idle)
}

pub fn current_hop(agent_id: &str) -> u8 {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|r| r.hop)
        .unwrap_or(0)
}

/// Whether a worker is draining this agent's inbox (a turn is running or about to).
fn in_turn(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running)
}

pub fn set_status(app: &AppHandle, agent_id: &str, status: Status) {
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        runtimes.entry(agent_id.to_string()).or_default().status = Some(status.clone());
    }
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        agent_id: &'a str,
        status: &'a Status,
    }
    let _ = app.emit(
        EVENT_STATUS,
        Payload {
            agent_id,
            status: &status,
        },
    );
}

/// Persist a message, update the agent's sidebar row, and tell the UI.
pub fn record(app: &AppHandle, message: AgentMessage) -> Result<AgentMessage, CommandError> {
    store::append_message(&message)?;
    // Anything the agent says (or a check-in firing) while it isn't on screen
    // notifies. Approvals aren't unread: they're counted as pending until answered.
    let wants_user = message.kind.wants_user() && !notify::on_screen(app, &message.agent_id);
    let counts_as_unread = wants_user && message.kind != MessageKind::Approval;
    let preview = preview_for(&message);
    let ts = message.ts;
    let updated = store::update(&message.agent_id, |agent| {
        agent.last_activity_at = ts;
        if let Some(p) = preview {
            agent.preview = Some(p);
        }
        if counts_as_unread {
            agent.unread = agent.unread.saturating_add(1);
        }
    });
    let _ = app.emit(EVENT_MESSAGE, &message);
    let _ = app.emit(EVENT_REGISTRY, ());
    if wants_user {
        if let Ok(agent) = &updated {
            notify::message_recorded(app, agent, &message, in_turn(&message.agent_id));
        }
        notify::refresh_badge(app);
    }
    Ok(message)
}

pub(crate) fn preview_for(message: &AgentMessage) -> Option<String> {
    let line = |s: &str| {
        s.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.chars().take(140).collect())
    };
    match message.kind {
        MessageKind::User if message.text.trim().is_empty() => match message.attachments.len() {
            0 => None,
            1 => Some(format!("Sent {}", message.attachments[0].name)),
            n => Some(format!("Sent {n} files")),
        },
        MessageKind::User | MessageKind::Agent | MessageKind::Error => line(&message.text),
        MessageKind::SentToAgent => message
            .peer
            .as_ref()
            .map(|p| format!("Messaged {}", p.name)),
        MessageKind::FromAgent => message
            .peer
            .as_ref()
            .map(|p| format!("Message from {}", p.name)),
        MessageKind::Approval => message
            .approval
            .as_ref()
            .map(|a| format!("Needs your OK: {}", a.title)),
        MessageKind::CheckIn => Some("Scheduled check-in".to_string()),
    }
}

pub fn new_message(agent_id: &str, kind: MessageKind, text: impl Into<String>) -> AgentMessage {
    AgentMessage {
        id: store::new_id(),
        agent_id: agent_id.to_string(),
        ts: store::now_ms(),
        kind,
        text: text.into(),
        peer: None,
        approval: None,
        attachments: Vec::new(),
        check_in: None,
    }
}

/// Queue a message for an agent and make sure a worker is draining its inbox.
pub fn enqueue(app: &AppHandle, agent_id: &str, text: String, from: From) {
    let start = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = runtimes.entry(agent_id.to_string()).or_default();
        runtime.queue.push_back(Inbound { text, from });
        if runtime.running {
            false
        } else {
            runtime.running = true;
            true
        }
    };
    if start {
        let app = app.clone();
        let agent_id = agent_id.to_string();
        tauri::async_runtime::spawn(async move { drain(app, agent_id).await });
    }
}

/// Stop the turn in progress and drop anything queued behind it.
pub fn stop(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    runtime.queue.clear();
    match &runtime.cancel {
        Some(cancel) => {
            cancel.notify_one();
            true
        }
        None => false,
    }
}

async fn drain(app: AppHandle, agent_id: String) {
    loop {
        let batch: Vec<Inbound> = {
            let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            let runtime = runtimes.entry(agent_id.clone()).or_default();
            if runtime.queue.is_empty() {
                runtime.running = false;
                runtime.cancel = None;
                runtime.hop = 0;
                drop(runtimes);
                set_status(&app, &agent_id, Status::idle());
                return;
            }
            let batch: Vec<Inbound> = runtime.queue.drain(..).collect();
            // The turn inherits the deepest hop it is answering; a user message
            // in the batch resets the chain.
            runtime.hop = if batch.iter().any(|m| matches!(m.from, From::User)) {
                0
            } else {
                batch
                    .iter()
                    .filter_map(|m| match &m.from {
                        From::Agent { hop, .. } => Some(*hop),
                        From::User => None,
                    })
                    .max()
                    .unwrap_or(0)
            };
            runtime.cancel = Some(Arc::new(Notify::new()));
            batch
        };
        let prompt = compose(&batch);
        if let Err(err) = run_turn(&app, &agent_id, &prompt, true).await {
            let _ = record(
                &app,
                new_message(&agent_id, MessageKind::Error, err.to_string()),
            );
        }
        notify::turn_ended(&app, &agent_id);
    }
}

fn compose(batch: &[Inbound]) -> String {
    batch
        .iter()
        .map(|m| match &m.from {
            From::User => m.text.clone(),
            From::Agent { sender, .. } => prompts::from_agent(&sender.name, &m.text),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What a failed `result` event means, in words. The CLI puts the reason in
/// `errors` (e.g. "No conversation found with session ID: …") and only a code
/// in `subtype` ("error_during_execution"), which must never reach the chat.
fn result_error_text(value: &serde_json::Value) -> String {
    if let Some(text) = value
        .get("result")
        .and_then(|r| r.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        return text.to_string();
    }
    let errors: Vec<String> = value
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|e| e.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !errors.is_empty() {
        return errors.join(" ");
    }
    match value.get("subtype").and_then(|s| s.as_str()) {
        Some("error_max_turns") => "It ran out of steps before finishing. Send a message to let it continue.".into(),
        _ => "Something went wrong running this agent. Send your message again; if it keeps happening, check that Claude Code works in a terminal.".into(),
    }
}

/// A prompt for a fresh session, prefixed with the visible conversation.
fn with_recap(agent_id: &str, prompt: &str) -> String {
    let Ok(log) = store::messages(agent_id, 40) else {
        return prompt.to_string();
    };
    let lines: Vec<String> = log
        .iter()
        .filter_map(|m| {
            let who = match m.kind {
                MessageKind::User => "User".to_string(),
                MessageKind::Agent => "You".to_string(),
                MessageKind::SentToAgent => format!("You → {}", m.peer.as_ref()?.name),
                MessageKind::FromAgent => format!("{} → you", m.peer.as_ref()?.name),
                MessageKind::CheckIn => "Your scheduled check-in".to_string(),
                _ => return None,
            };
            let text: String = m.text.chars().take(600).collect();
            Some(format!("{who}: {text}"))
        })
        .collect();
    if lines.is_empty() {
        return prompt.to_string();
    }
    format!(
        "[Your previous working session was lost, so here is the recent conversation for context. Don't mention this unless asked.]\n\n{}\n\n[New message]\n\n{prompt}",
        lines.join("\n")
    )
}

/// Claude Code's `--resume` refuses a session id it has no file for (the
/// user cleared ~/.claude, or the first turn died before writing one).
fn is_missing_session(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    lower.contains("no conversation found") || lower.contains("session not found")
}

fn mcp_config(url: &str) -> String {
    serde_json::json!({
        "mcpServers": { prompts::SERVER_KEY: { "type": "http", "url": url } }
    })
    .to_string()
}

/// Folders an agent may work in without asking: every Ship Studio project.
fn work_dirs() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Ok(root) = crate::utils::projects_root() {
        dirs.push(root.to_string_lossy().to_string());
    }
    if let Ok(config) = crate::commands::external_projects::load_config() {
        dirs.extend(config.projects.into_iter().map(|p| p.path));
    }
    dirs
}

/// Plain-language label for what a tool call is doing.
pub fn describe_activity(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    let tool = content
        .iter()
        .rev()
        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))?;
    let name = tool.get("name")?.as_str()?;
    let input = tool.get("input");
    let field = |k: &str| {
        input
            .and_then(|i| i.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let ours = format!("mcp__{}__", prompts::SERVER_KEY);
    Some(match name.strip_prefix(&ours) {
        Some("message_agent") => format!("Messaging {}", field("agent")),
        Some("create_agent") => format!("Creating {}", field("name")),
        Some("list_agents") => "Checking on the team".to_string(),
        Some("list_projects") => "Looking at your projects".to_string(),
        Some(other) => other.replace('_', " "),
        None => match name {
            "Edit" | "Write" | "MultiEdit" => {
                let path = field("file_path");
                let file = path.rsplit('/').next().unwrap_or("");
                if file.is_empty() {
                    "Editing files".into()
                } else {
                    format!("Editing {file}")
                }
            }
            "Task" | "Agent" => "Working on a sub-task".to_string(),
            "TodoWrite" => "Planning".to_string(),
            _ => crate::commands::workflows::progress::describe_claude_event(line)?,
        },
    })
}

/// Run one turn. `retry_fresh` lets a vanished session be replaced once.
async fn run_turn(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    retry_fresh: bool,
) -> Result<(), CommandError> {
    let agent = store::get(agent_id)?;
    let home = store::agent_home(agent_id)?;
    std::fs::create_dir_all(&home).map_err(super::err_io)?;
    let binary = crate::commands::claude::find_validated_binary("claude", "--version").ok_or_else(|| {
        CommandError::expected("Claude Code isn't installed, or Ship Studio can't find it. Install it from Settings → Agents, then send this again.")
    })?;
    let (port, token) = crate::agent_bridge::start_global_agent_bridge(app.clone())
        .await
        .map_err(super::err_other)?;
    let url = format!("http://127.0.0.1:{port}/mcp/{token}/agents/{agent_id}");

    let (session_id, resuming) = match &agent.session_id {
        Some(id) => (id.clone(), true),
        None => (uuid::Uuid::new_v4().to_string(), false),
    };

    let mut cmd = crate::utils::create_command(&binary);
    cmd.args(["--print", "--output-format", "stream-json", "--verbose"]);
    if resuming {
        cmd.args(["--resume", &session_id]);
    } else {
        cmd.args(["--session-id", &session_id]);
    }
    cmd.args(["--permission-mode", "acceptEdits"])
        .args(["--permission-prompt-tool", &prompts::approval_tool_id()])
        .args(["--mcp-config", &mcp_config(&url)])
        .args(["--allowedTools", &format!("mcp__{}", prompts::SERVER_KEY)])
        .args(["--append-system-prompt", &prompts::system_prompt(&agent)]);
    for dir in work_dirs() {
        cmd.args(["--add-dir", &dir]);
    }
    if let Some(model) = &agent.model {
        cmd.args(["--model", model]);
    }
    // A Ship Studio launched from inside a Claude Code session (a terminal
    // running `claude`, or a dev build started by one) inherits that
    // session's variables. With them, each agent runs as a nested child
    // session that is never written to disk, so the next `--resume` finds
    // nothing. Observed: every agent lost its memory between turns.
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "CLAUDECODE"
            || key == "CLAUDE_PID"
            || key == "CLAUDE_EFFORT"
            || key.starts_with("CLAUDE_CODE_")
        {
            cmd.env_remove(key.as_ref());
        }
    }
    cmd.env("PATH", crate::utils::get_extended_path())
        // Claude Code gives an MCP tool call ~60s by default, and the approval
        // tool waits for a person. Verified: with the default, a card left for
        // two minutes came back as a timeout the agent read as "Bash is
        // hanging". Raised past our own approval wait so we always answer
        // first. (Claude Code still caps a permission prompt at 300s; see
        // mcp::APPROVAL_WAIT_SECS.)
        .env(
            "MCP_TOOL_TIMEOUT",
            ((super::mcp::APPROVAL_WAIT_SECS + 60) * 1000).to_string(),
        )
        .current_dir(&home);

    let mut cmd = tokio::process::Command::from(cmd);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| CommandError::expected(format!("Couldn't start Claude Code: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(super::err_io)?;
        drop(stdin);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| super::err_other("no stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| super::err_other("no stderr"))?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let cancel = RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.cancel.clone())
        .unwrap_or_else(|| Arc::new(Notify::new()));

    let started = store::now_ms();
    set_status(
        app,
        agent_id,
        Status {
            state: "working",
            activity: None,
            since: Some(started),
        },
    );

    let mut lines = BufReader::new(stdout).lines();
    let mut saw_result = false;
    let mut said_anything = false;
    let mut result_error: Option<String> = None;
    let mut session_confirmed = false;
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(TURN_TIMEOUT_SECS));
    tokio::pin!(deadline);
    let mut stopped: Option<&'static str> = None;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match value.get("type").and_then(|t| t.as_str()) {
                    Some("system") => {
                        if !session_confirmed {
                            if let Some(sid) = value.get("session_id").and_then(|s| s.as_str()) {
                                session_confirmed = true;
                                let sid = sid.to_string();
                                let _ = store::update(agent_id, |a| a.session_id = Some(sid));
                            }
                        }
                    }
                    Some("assistant") => {
                        // Sub-agent (Task) chatter is internal; only top-level text is a reply.
                        let top_level = value.get("parent_tool_use_id").is_none_or(|p| p.is_null());
                        if let Some(blocks) = value.pointer("/message/content").and_then(|c| c.as_array()) {
                            for block in blocks {
                                if top_level && block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                                    if !text.is_empty() {
                                        said_anything = true;
                                        let _ = record(app, new_message(agent_id, MessageKind::Agent, text));
                                    }
                                }
                            }
                        }
                        if let Some(activity) = describe_activity(&line) {
                            let current = status_of(agent_id);
                            if current.state != "waiting" {
                                set_status(app, agent_id, Status { state: "working", activity: Some(activity), since: Some(started) });
                            }
                        }
                    }
                    Some("result") => {
                        saw_result = true;
                        let is_error = value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                        if is_error {
                            result_error = Some(result_error_text(&value));
                        }
                    }
                    _ => {}
                }
            }
            _ = cancel.notified() => { stopped = Some("Stopped."); break; }
            _ = &mut deadline => { stopped = Some("Stopped after 3 hours. Send a message to pick it back up."); break; }
        }
    }

    if stopped.is_some() {
        let _ = child.kill().await;
    }
    let status = child.wait().await.map_err(super::err_io)?;
    let stderr_text = stderr_task.await.unwrap_or_default();

    if let Some(note) = stopped {
        let _ = record(app, new_message(agent_id, MessageKind::Error, note));
        return Ok(());
    }

    let missing_session =
        is_missing_session(&stderr_text) || result_error.as_deref().is_some_and(is_missing_session);
    if retry_fresh && resuming && missing_session {
        tracing::warn!("[Agents] Session {session_id} for {agent_id} is gone; starting a new one");
        let _ = store::update(agent_id, |a| a.session_id = None);
        // The new session starts blank. Hand it the conversation the user
        // can see, so the agent doesn't greet them like a stranger.
        let prompt = with_recap(agent_id, prompt);
        return Box::pin(run_turn(app, agent_id, &prompt, false)).await;
    }

    if let Some(err) = result_error {
        return Err(CommandError::expected(err));
    }
    if !status.success() && !saw_result {
        let detail = if stderr_text.trim().is_empty() {
            format!("Claude Code exited with {status}")
        } else {
            stderr_text
        };
        if let Some(err) = crate::commands::ai::classify_agent_cli_failure("Claude Code", &detail) {
            return Err(err);
        }
        return Err(CommandError::expected(
            crate::external_command::truncate_output(detail.trim()),
        ));
    }
    if !said_anything {
        tracing::debug!("[Agents] {agent_id} finished a turn without a reply");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_our_own_tools_in_plain_words() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__shipstudio_agents__message_agent","input":{"agent":"Finance","message":"hi"}}]}}"#;
        assert_eq!(
            describe_activity(line).as_deref(),
            Some("Messaging Finance")
        );
    }

    #[test]
    fn labels_edits_by_file_name() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b/src/App.tsx"}}]}}"#;
        assert_eq!(describe_activity(line).as_deref(), Some("Editing App.tsx"));
    }

    #[test]
    fn plain_text_is_not_an_activity() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(describe_activity(line), None);
    }

    #[test]
    fn agent_messages_are_framed_as_not_from_the_user() {
        let batch = vec![
            Inbound {
                text: "Do X".into(),
                from: From::User,
            },
            Inbound {
                text: "Done Y".into(),
                from: From::Agent {
                    sender: AgentRef {
                        id: "a".into(),
                        name: "Finance".into(),
                    },
                    hop: 1,
                },
            },
        ];
        let prompt = compose(&batch);
        assert!(prompt.starts_with("Do X"));
        assert!(prompt.contains("[Message from Finance, another agent — not the user]"));
    }

    #[test]
    fn result_errors_are_never_shown_as_raw_codes() {
        let missing = serde_json::json!({"type":"result","is_error":true,"subtype":"error_during_execution","result":null,"errors":["No conversation found with session ID: x"]});
        let text = result_error_text(&missing);
        assert!(is_missing_session(&text));
        let bare =
            serde_json::json!({"type":"result","is_error":true,"subtype":"error_during_execution"});
        assert!(!result_error_text(&bare).contains("error_during_execution"));
    }

    #[test]
    fn recognises_a_vanished_session() {
        assert!(is_missing_session(
            "Error: No conversation found with session ID: abc"
        ));
        assert!(!is_missing_session("rate limited"));
    }
}
