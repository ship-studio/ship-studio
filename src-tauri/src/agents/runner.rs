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
//! the model writes streams in as a draft (see [`super::stream`]) and becomes
//! a chat message under the same id when it completes; tool calls only ever
//! update the "working" line under the agent's name.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

use super::notify;
use super::prompts;
use super::store::{self, AgentMessage, AgentRef, MessageKind};
use super::stream::{self, Drafts};
use crate::errors::CommandError;

pub const EVENT_MESSAGE: &str = "agents://message";
pub const EVENT_STATUS: &str = "agents://status";
pub const EVENT_REGISTRY: &str = "agents://registry";
/// A reply being written: `{agentId, id, text}`, the text so far. The message
/// that completes it arrives on [`EVENT_MESSAGE`] with the same id.
pub const EVENT_DRAFT: &str = "agents://draft";

/// How often a growing draft is sent to the UI: smooth to the eye, and a
/// burst of tiny deltas costs one event rather than dozens.
const DRAFT_EVERY: std::time::Duration = std::time::Duration::from_millis(40);

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
    /// What the turn in progress was asked, for the note an interruption leaves.
    prompt: Option<String>,
    /// The user asked to interrupt the turn in progress (see [`interrupt`]).
    interrupt: bool,
    /// Set when a turn was interrupted: what the next turn is told first.
    interrupted: Option<String>,
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
        MessageKind::User | MessageKind::Agent if message.text.trim().is_empty() => {
            let verb = if message.kind == MessageKind::User {
                "Sent"
            } else {
                "Shared"
            };
            match message.attachments.len() {
                0 => None,
                1 => Some(format!("{verb} {}", message.attachments[0].name)),
                n => Some(format!("{verb} {n} files")),
            }
        }
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
        MessageKind::Note | MessageKind::Changes => None,
    }
}

fn emit_draft(app: &AppHandle, agent_id: &str, id: &str, text: &str) {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        agent_id: &'a str,
        id: &'a str,
        text: &'a str,
    }
    let _ = app.emit(EVENT_DRAFT, Payload { agent_id, id, text });
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
        stopped: false,
        mentions: Vec::new(),
        changes: None,
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
    runtime.interrupt = false;
    match &runtime.cancel {
        Some(cancel) => {
            cancel.notify_one();
            true
        }
        None => false,
    }
}

/// Stop the turn in progress so what's queued runs now, as the next turn.
/// That turn is told what it was doing when it was cut off. Nothing queued,
/// nothing to interrupt for: false.
pub fn interrupt(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    if !runtime.running || runtime.queue.is_empty() {
        return false;
    }
    let Some(cancel) = runtime.cancel.clone() else {
        return false;
    };
    runtime.interrupt = true;
    cancel.notify_one();
    true
}

/// Called when a turn's cancel fired: whether it was an interruption, and if
/// so, leave the next turn its preamble.
fn take_interrupt(agent_id: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(runtime) = runtimes.get_mut(agent_id) else {
        return false;
    };
    if !std::mem::take(&mut runtime.interrupt) {
        return false;
    }
    let activity = runtime.status.as_ref().and_then(|s| s.activity.clone());
    runtime.interrupted = Some(prompts::interrupted(
        runtime.prompt.as_deref().unwrap_or(""),
        activity.as_deref(),
    ));
    true
}

async fn drain(app: AppHandle, agent_id: String) {
    loop {
        let prompt: String = {
            let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            let runtime = runtimes.entry(agent_id.clone()).or_default();
            if runtime.queue.is_empty() {
                runtime.running = false;
                runtime.cancel = None;
                runtime.hop = 0;
                runtime.prompt = None;
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
            runtime.interrupt = false;
            let prompt = compose(&batch);
            runtime.prompt = Some(prompt.clone());
            match runtime.interrupted.take() {
                Some(preamble) => format!("{preamble}{prompt}"),
                None => prompt,
            }
        };
        // A bound agent's project, as it stood before the turn touched it.
        let start = turn_start(&agent_id).await;
        if let Err(err) = run_turn(&app, &agent_id, &prompt, true).await {
            let _ = record(
                &app,
                new_message(&agent_id, MessageKind::Error, err.to_string()),
            );
        }
        if let Some((project, from)) = start {
            record_changes(&app, &agent_id, project, from).await;
        }
        notify::turn_ended(&app, &agent_id);
    }
}

/// For a bound agent whose project is a git repository: the project and a
/// snapshot of its working tree, taken before the turn starts.
async fn turn_start(agent_id: &str) -> Option<(std::path::PathBuf, String)> {
    let project = std::path::PathBuf::from(store::get(agent_id).ok()?.project?);
    let tree = super::project::snapshot(&project).await?;
    Some((project, tree))
}

/// After the turn: if it changed files in the project, one card saying which.
/// Runs however the turn ended; edits made before a Stop are still made.
async fn record_changes(
    app: &AppHandle,
    agent_id: &str,
    project: std::path::PathBuf,
    from: String,
) {
    let Some(summary) = super::project::summary(&project, &from).await else {
        return;
    };
    let files = match summary.file_count {
        1 => "1 file".to_string(),
        n => format!("{n} files"),
    };
    let text = format!(
        "Changed {files} in {}",
        super::project::folder_name(&summary.project)
    );
    let mut message = new_message(agent_id, MessageKind::Changes, text);
    message.changes = Some(summary);
    let _ = record(app, message);
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

/// The system prompt for a turn. A bound agent's own CLAUDE.md is carried
/// in it, because its working directory is the project, not its home.
fn system_prompt_for(
    agent: &store::Agent,
    home: &std::path::Path,
    layout: &super::project::Layout,
) -> String {
    let Some(project) = &layout.project else {
        return prompts::system_prompt(agent, None);
    };
    let identity: String = std::fs::read_to_string(home.join("CLAUDE.md"))
        .unwrap_or_default()
        .chars()
        .take(40_000)
        .collect();
    prompts::system_prompt(
        agent,
        Some(&prompts::Bound {
            home: &home.to_string_lossy(),
            project: &project.to_string_lossy(),
            identity: &identity,
        }),
    )
}

/// Every argument a turn's `claude` process gets. The prompt goes on stdin.
fn turn_args(
    agent: &store::Agent,
    session_id: &str,
    resuming: bool,
    url: &str,
    system_prompt: &str,
    add_dirs: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    .map(String::from)
    .to_vec();
    let session_flag = if resuming { "--resume" } else { "--session-id" };
    args.extend([session_flag.to_string(), session_id.to_string()]);
    args.extend([
        "--permission-mode".into(),
        "acceptEdits".into(),
        "--permission-prompt-tool".into(),
        prompts::approval_tool_id(),
        "--mcp-config".into(),
        mcp_config(url),
        "--allowedTools".into(),
        format!("mcp__{}", prompts::SERVER_KEY),
        "--append-system-prompt".into(),
        system_prompt.to_string(),
    ]);
    for dir in add_dirs {
        args.extend(["--add-dir".to_string(), dir.clone()]);
    }
    if let Some(model) = &agent.model {
        args.extend(["--model".to_string(), model.clone()]);
    }
    args
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

    let layout = super::project::layout(&agent, &home, work_dirs());
    if let Some(project) = &layout.project {
        if !project.is_dir() {
            return Err(CommandError::expected(format!(
                "{} works in {}, which isn't there any more. Pick another project in Edit agent, or clear it.",
                agent.name,
                project.display()
            )));
        }
    }
    let system_prompt = system_prompt_for(&agent, &home, &layout);
    let mut cmd = crate::utils::create_command(&binary);
    cmd.args(turn_args(
        &agent,
        &session_id,
        resuming,
        &url,
        &system_prompt,
        &layout.add_dirs,
    ));
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
        .current_dir(&layout.cwd);

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
    // None: ran to the end. Some(None): the user pressed Stop. Some(Some(note)): we stopped it.
    let mut stopped: Option<Option<&'static str>> = None;
    let mut drafts = Drafts::default();
    let mut draft_tick = tokio::time::interval(DRAFT_EVERY);
    draft_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
                    Some("stream_event") => drafts.on_stream_event(&value, store::new_id),
                    Some("assistant") => {
                        // Sub-agent (Task) chatter is internal; only top-level text is a reply.
                        let top_level = stream::top_level(&value);
                        if let Some(blocks) = value.pointer("/message/content").and_then(|c| c.as_array()) {
                            for block in blocks {
                                if top_level && block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                                    // Recorded under the draft's id, so it takes the draft's place.
                                    let draft_id = drafts.finish(text);
                                    if !text.is_empty() {
                                        said_anything = true;
                                        let mut message = new_message(agent_id, MessageKind::Agent, text);
                                        if let Some(id) = draft_id {
                                            message.id = id;
                                        }
                                        let _ = record(app, message);
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
                        if let Some(turn) = super::usage::from_result(&value) {
                            let today = super::usage::today();
                            let _ = store::update(agent_id, |a| a.usage.record(&turn, today));
                        }
                        let is_error = value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                        if is_error {
                            result_error = Some(result_error_text(&value));
                        }
                    }
                    _ => {}
                }
            }
            _ = draft_tick.tick(), if drafts.dirty() => {
                if let Some((id, text)) = drafts.flush() {
                    emit_draft(app, agent_id, id, text);
                }
            }
            _ = cancel.notified() => { stopped = Some(None); break; }
            _ = &mut deadline => { stopped = Some(Some("Stopped after 3 hours. Send a message to pick it back up.")); break; }
        }
    }

    if stopped.is_some() {
        let _ = child.kill().await;
    }
    let status = child.wait().await.map_err(super::err_io)?;
    let stderr_text = stderr_task.await.unwrap_or_default();

    // A reply cut off mid-sentence keeps what it had said, marked as stopped.
    let cut_off = drafts.take().map(|(id, text)| {
        let mut message = new_message(agent_id, MessageKind::Agent, text);
        message.id = id;
        message.stopped = true;
        said_anything = true;
        let _ = record(app, message);
    });

    if let Some(note) = stopped {
        if note.is_none() && take_interrupt(agent_id) {
            let line = "Interrupted to read your new message";
            let _ = record(app, new_message(agent_id, MessageKind::Note, line));
            return Ok(());
        }
        // Stopped by the user: the cut-off reply already says so.
        let note = note.or(cut_off.is_none().then_some("Stopped."));
        if let Some(note) = note {
            let _ = record(app, new_message(agent_id, MessageKind::Error, note));
        }
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

    fn test_agent(model: Option<&str>) -> store::Agent {
        let mut agent: store::Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0
        }))
        .unwrap();
        agent.model = model.map(str::to_string);
        agent
    }

    #[test]
    fn an_unbound_agents_command_line_is_unchanged() {
        let agent = test_agent(Some("opus"));
        let dirs = vec!["/u/ShipStudio".to_string(), "/ext/site".to_string()];
        let layout =
            super::super::project::layout(&agent, std::path::Path::new("/h"), dirs.clone());
        assert_eq!(layout.cwd, std::path::PathBuf::from("/h"));
        let prompt = system_prompt_for(&agent, std::path::Path::new("/h"), &layout);
        assert_eq!(prompt, prompts::system_prompt(&agent, None));
        let args = turn_args(&agent, "sid", true, "http://x", &prompt, &layout.add_dirs);
        let expected: Vec<String> = [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--resume",
            "sid",
            "--permission-mode",
            "acceptEdits",
            "--permission-prompt-tool",
            "mcp__shipstudio_agents__approve",
            "--mcp-config",
            r#"{"mcpServers":{"shipstudio_agents":{"type":"http","url":"http://x"}}}"#,
            "--allowedTools",
            "mcp__shipstudio_agents",
            "--append-system-prompt",
            &prompt,
            "--add-dir",
            "/u/ShipStudio",
            "--add-dir",
            "/ext/site",
            "--model",
            "opus",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(args, expected);
    }

    #[test]
    fn a_bound_agent_runs_in_its_project_and_carries_its_identity() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("CLAUDE.md"),
            "# Finance\n\n## Memory\n\n- Sam pays.",
        )
        .unwrap();
        let mut agent = test_agent(None);
        agent.project = Some("/ext/site".into());
        let layout = super::super::project::layout(
            &agent,
            home.path(),
            vec!["/u/ShipStudio".into(), "/ext/site".into()],
        );
        assert_eq!(layout.cwd, std::path::PathBuf::from("/ext/site"));
        let prompt = system_prompt_for(&agent, home.path(), &layout);
        assert!(prompt.contains("- Sam pays."));
        assert!(prompt.contains("You work in `/ext/site`"));
        let args = turn_args(&agent, "sid", false, "http://x", &prompt, &layout.add_dirs);
        let dirs: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "--add-dir")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(dirs, vec![home.path().to_str().unwrap(), "/u/ShipStudio"]);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--session-id" && w[1] == "sid"));
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn recognises_a_vanished_session() {
        assert!(is_missing_session(
            "Error: No conversation found with session ID: abc"
        ));
        assert!(!is_missing_session("rate limited"));
    }
}
