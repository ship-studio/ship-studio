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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::notify;
use super::procs;
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

/// After `claude` closes its output, how long it gets to exit (and its
/// stderr to close) before it is stopped: a CLI that hangs on the way out
/// must not wedge the agent, with every later message queued behind it.
const EXIT_BOUND: Duration = Duration::from_secs(10);

/// Turns that may run at once. A Chief fanning work out to ten agents would
/// otherwise start ten `claude` processes together, burn the usage limit and
/// come back as ten failures; the rest wait their turn, and say so.
const MAX_TURNS: usize = 3;

fn max_turns() -> usize {
    std::env::var("SHIPSTUDIO_AGENTS_MAX_TURNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(MAX_TURNS)
}

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(max_turns())));

/// Set when the app is exiting: turns being torn down must not record their
/// end, so the marks they leave say "Ship Studio closed" at the next launch.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The app is exiting (`RunEvent::Exit`): stop every running turn's whole
/// process tree, so no `claude` keeps editing a project after Ship Studio is
/// gone. Their `turn.json` marks stay, and the next launch records each one
/// as interrupted (see [`recover_after_restart`]); queued messages are
/// already on disk. Returns how many turns were stopped.
pub fn shutdown_sync() -> usize {
    QUITTING.store(true, Ordering::SeqCst);
    procs::kill_all_sync()
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub enum From {
    User,
    Agent { sender: AgentRef, hop: u8 },
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct Inbound {
    text: String,
    from: From,
    /// An agent's answer to a request this agent sent it: answered by
    /// telling the user, never by replying (see [`settle`]).
    #[serde(default)]
    reply: bool,
    /// One of the agent's routines firing (see [`store::Agent::routine_model`]).
    #[serde(default)]
    routine: bool,
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
    /// The agent whose message started the turn in progress; `None` when the
    /// user's own message is among what it answers.
    origin: Option<String>,
    /// What the turn in progress was asked, for the note an interruption leaves.
    prompt: Option<String>,
    /// The user asked to interrupt the turn in progress (see [`interrupt`]).
    interrupt: bool,
    /// Set when a turn was interrupted: what the next turn is told first.
    interrupted: Option<String>,
    /// Agents whose requests the turn in progress is answering. Whatever the
    /// turn ends up saying goes back to each of them (see [`return_results`]),
    /// unless it already answered one with `message_agent`.
    owed: Vec<AgentRef>,
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

/// Who handed this agent the turn it is running: another agent's id, or
/// `None` when the user asked (or nothing is running).
pub fn turn_origin(agent_id: &str) -> Option<String> {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .and_then(|r| r.origin.clone())
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
pub fn in_turn(agent_id: &str) -> bool {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .is_some_and(|r| r.running)
}

/// How many agents have a turn running or waiting for a slot. The updater
/// asks before it restarts the app.
pub fn busy_count() -> usize {
    RUNTIMES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter(|r| r.running)
        .count()
}

/// A turn in flight, on disk (`<home>/turn.json`) from spawn until the turn
/// ends. Still there at launch means Ship Studio quit or crashed mid-turn.
#[derive(Serialize, serde::Deserialize, Default)]
struct TurnMark {
    /// Claude Code's process, once spawned.
    pid: Option<u32>,
    #[serde(default)]
    session: String,
    /// A bound agent's project and its snapshot from before the turn, for
    /// the change card if the turn never gets to record one.
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    tree: Option<String>,
}

fn read_mark(agent_id: &str) -> Option<TurnMark> {
    let raw = std::fs::read_to_string(mark_path(agent_id)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_mark(agent_id: &str, mark: TurnMark) {
    if let (Some(path), Ok(json)) = (mark_path(agent_id), serde_json::to_vec(&mark)) {
        let _ = std::fs::write(path, json);
    }
}

fn mark_path(agent_id: &str) -> Option<std::path::PathBuf> {
    store::agent_home(agent_id)
        .ok()
        .map(|h| h.join("turn.json"))
}

fn clear_mark(agent_id: &str) {
    if let Some(path) = mark_path(agent_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// What is queued behind the turn in progress, on disk (`<home>/inbox.json`)
/// so a quit, crash or update doesn't lose it. Written whenever the queue
/// changes, under the runtimes lock, so writes land in order.
fn save_inbox(agent_id: &str, queue: &VecDeque<Inbound>) {
    let Ok(home) = store::agent_home(agent_id) else {
        return;
    };
    let path = home.join("inbox.json");
    if queue.is_empty() {
        let _ = std::fs::remove_file(path);
    } else if let Ok(json) = serde_json::to_value(queue).and_then(|mut v| {
        super::secrets::redact_value(&mut v);
        serde_json::to_vec(&v)
    }) {
        if let Err(e) = std::fs::write(&path, json) {
            tracing::warn!("[Agents] couldn't save {agent_id}'s queue: {e}");
        }
    }
}

fn take_inbox(agent_id: &str) -> Vec<Inbound> {
    let Ok(path) = store::agent_home(agent_id).map(|h| h.join("inbox.json")) else {
        return Vec::new();
    };
    let queued = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let _ = std::fs::remove_file(path);
    queued
}

/// The note saying which waiting messages were sent again after a restart.
fn resent_note(queued: &[Inbound]) -> String {
    let quoted: Vec<String> = queued
        .iter()
        .map(|m| {
            let first = m.text.lines().map(str::trim).find(|l| !l.is_empty());
            let mut line: String = first.unwrap_or("").chars().take(60).collect();
            if first.is_some_and(|l| l.chars().count() > 60) {
                line.push('…');
            }
            match &m.from {
                From::User => format!("“{line}”"),
                From::Agent { sender, .. } => format!("{}'s “{line}”", sender.name),
            }
        })
        .collect();
    let what = match queued.len() {
        1 => "the message".to_string(),
        n => format!("{n} messages"),
    };
    format!(
        "Sent {what} still waiting when Ship Studio closed: {}",
        quoted.join(", ")
    )
}

/// At launch: a turn the last run left mid-flight is over. Its Claude Code
/// process can outlive the app (a quit doesn't run our cleanup), and would
/// keep writing the same session as the next turn, so it is stopped; and the
/// chat says the turn ended, instead of a message sitting there unanswered.
pub async fn recover_after_restart(app: &AppHandle) {
    let Ok(agents) = store::list() else { return };
    for agent in agents {
        if let Some(path) = mark_path(&agent.id).filter(|p| p.exists()) {
            let mark = read_mark(&agent.id).unwrap_or_default();
            if let Some(pid) = mark.pid {
                if !mark.session.is_empty() {
                    stop_orphan(pid, &mark.session).await;
                }
            }
            let _ = std::fs::remove_file(&path);
            // Same order as a turn that ends: its changes, then its error line,
            // which tags the agent as needing you (Retry re-sends).
            if let (Some(project), Some(tree)) = (mark.project, mark.tree) {
                record_changes(app, &agent.id, project.into(), tree).await;
            }
            let text = "Ship Studio closed while this agent was working, so that turn didn't finish. Retry to send it again.";
            let mut line = new_message(&agent.id, MessageKind::Error, text);
            line.failure = Some(super::failure::Failure::OTHER);
            let _ = record(app, line);
        }
        // What was queued behind it was never started: it runs now, once,
        // and the chat says which messages were sent again. (The interrupted
        // turn itself is not re-run: it may have done half its work.)
        let queued = take_inbox(&agent.id);
        if queued.is_empty() {
            continue;
        }
        let _ = record(
            app,
            new_message(&agent.id, MessageKind::Note, resent_note(&queued)),
        );
        for message in queued {
            push(app, &agent.id, message);
        }
    }
}

/// Stop `pid` only if it is still that turn's process: pids get reused, and
/// the session id on its command line is what identifies it.
async fn stop_orphan(pid: u32, session: &str) {
    if cfg!(windows) {
        return;
    }
    let mut ps = tokio::process::Command::new("ps");
    ps.args(["-o", "command=", "-p", &pid.to_string()]);
    let ours = crate::external_command::run_with_timeout(ps, "ps", 5)
        .await
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(session));
    if ours {
        tracing::warn!("[Agents] stopping turn {pid} left over from the last run");
        let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
    }
}

pub fn set_status(app: &AppHandle, agent_id: &str, mut status: Status) {
    if let Some(activity) = status.activity.as_mut() {
        *activity = super::secrets::redact(activity).into_owned();
    }
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
    record_as(app, message, true)
}

/// `record` without the OS notification: the same card shown in a second
/// chat, which was already announced once.
pub fn record_quietly(
    app: &AppHandle,
    message: AgentMessage,
) -> Result<AgentMessage, CommandError> {
    record_as(app, message, false)
}

fn record_as(
    app: &AppHandle,
    message: AgentMessage,
    alert: bool,
) -> Result<AgentMessage, CommandError> {
    let message = super::secrets::redact_message(message);
    if let Err(e) = store::append_message(&message) {
        unsaved(app, &message, &e);
        return Err(e);
    }
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
        match message.kind {
            MessageKind::Error => {
                agent.failure = Some(
                    message
                        .failure
                        .clone()
                        .unwrap_or(super::failure::Failure::OTHER),
                )
            }
            // A note, a change card or a session line says nothing after the failure.
            MessageKind::Note | MessageKind::Changes | MessageKind::Session => {}
            _ => agent.failure = None,
        }
    });
    let _ = app.emit(EVENT_MESSAGE, &message);
    let _ = app.emit(EVENT_REGISTRY, ());
    if wants_user {
        if let (Ok(agent), true) = (&updated, alert) {
            notify::message_recorded(app, agent, &message, in_turn(&message.agent_id));
        }
        notify::refresh_badge(app);
    }
    Ok(message)
}

/// The log couldn't be written (disk full, permissions). The user's own
/// message fails its send and they see why. Anything else (a reply mid-turn)
/// is still shown, since losing it on restart beats never seeing it, and the
/// chat says so, at most once a minute per agent.
fn unsaved(app: &AppHandle, message: &AgentMessage, error: &CommandError) {
    static WARNED: LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    tracing::error!(
        "[Agents] couldn't save a message for {}: {error}",
        message.agent_id
    );
    if message.kind == MessageKind::User {
        return;
    }
    let _ = app.emit(EVENT_MESSAGE, message);
    let now = std::time::Instant::now();
    let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
    if warned
        .get(&message.agent_id)
        .is_some_and(|t| now.duration_since(*t).as_secs() < 60)
    {
        return;
    }
    warned.insert(message.agent_id.clone(), now);
    let warning = new_message(
        &message.agent_id,
        MessageKind::Error,
        "Couldn't save this conversation to disk, so what's shown here will be gone after Ship Studio restarts. Check that the disk isn't full.",
    );
    let _ = app.emit(EVENT_MESSAGE, &warning);
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
        MessageKind::Note | MessageKind::Changes | MessageKind::Session => None,
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
    let text = &super::secrets::redact(text);
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
        failure: None,
        changes: None,
        session: None,
    }
}

/// Queue a message for an agent and make sure a worker is draining its inbox.
/// From another agent, it is a request: the turn that handles it answers it.
pub fn enqueue(app: &AppHandle, agent_id: &str, text: String, from: From) {
    push(
        app,
        agent_id,
        Inbound {
            text,
            from,
            reply: false,
            routine: false,
        },
    );
}

/// Queue the turn one of the agent's routines wakes it for.
pub fn enqueue_routine(app: &AppHandle, agent_id: &str, text: String) {
    push(
        app,
        agent_id,
        Inbound {
            text,
            from: From::User,
            reply: false,
            routine: true,
        },
    );
}

/// Queue an agent's answer to a request `agent_id` sent it.
pub fn enqueue_reply(app: &AppHandle, agent_id: &str, text: String, sender: AgentRef, hop: u8) {
    push(
        app,
        agent_id,
        Inbound {
            text,
            from: From::Agent { sender, hop },
            reply: true,
            routine: false,
        },
    );
}

/// `from` is messaging `to`. If `from`'s turn is answering a request `to`
/// sent, this message is that answer: it settles the debt, so the turn's
/// final words aren't sent back as well. Returns whether it was an answer.
pub fn settle(from: &str, to: &str) -> bool {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(owed) = runtimes.get_mut(from).map(|r| &mut r.owed) else {
        return false;
    };
    let before = owed.len();
    owed.retain(|a| a.id != to);
    owed.len() < before
}

fn push(app: &AppHandle, agent_id: &str, inbound: Inbound) {
    let start = {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        let runtime = runtimes.entry(agent_id.to_string()).or_default();
        runtime.queue.push_back(inbound);
        save_inbox(agent_id, &runtime.queue);
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
    save_inbox(agent_id, &runtime.queue);
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

/// A free turn slot, waiting (and saying so) while every slot is taken.
/// `None` when the wait ended because the queue was stopped and emptied.
async fn wait_for_slot(app: &AppHandle, agent_id: &str) -> Option<OwnedSemaphorePermit> {
    if let Ok(permit) = SLOTS.clone().try_acquire_owned() {
        return Some(permit);
    }
    // Stop wakes this; a fresh one per wait, so nothing stale reaches the turn.
    let wake = Arc::new(Notify::new());
    {
        let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
        runtimes.entry(agent_id.to_string()).or_default().cancel = Some(wake.clone());
    }
    let busy = max_turns();
    set_status(
        app,
        agent_id,
        Status {
            state: "working",
            activity: Some(format!(
                "Waiting for a free slot ({busy} agents already working)"
            )),
            since: None,
        },
    );
    loop {
        tokio::select! {
            permit = SLOTS.clone().acquire_owned() => return permit.ok(),
            _ = wake.notified() => {
                let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
                let runtime = runtimes.entry(agent_id.to_string()).or_default();
                // Interrupting a turn that hasn't started means nothing.
                runtime.interrupt = false;
                if runtime.queue.is_empty() {
                    return None;
                }
            }
        }
    }
}

async fn drain(app: AppHandle, agent_id: String) {
    loop {
        let has_work = {
            let runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            runtimes.get(&agent_id).is_some_and(|r| !r.queue.is_empty())
        };
        let _permit = if has_work {
            wait_for_slot(&app, &agent_id).await
        } else {
            None
        };
        let routine: bool;
        let prompt: String = {
            let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
            let runtime = runtimes.entry(agent_id.clone()).or_default();
            if runtime.queue.is_empty() {
                runtime.running = false;
                runtime.cancel = None;
                runtime.hop = 0;
                runtime.origin = None;
                runtime.prompt = None;
                drop(runtimes);
                set_status(&app, &agent_id, Status::idle());
                return;
            }
            let batch: Vec<Inbound> = runtime.queue.drain(..).collect();
            save_inbox(&agent_id, &runtime.queue);
            routine = batch.iter().all(|m| m.routine);
            // The turn inherits the deepest hop it is answering; a user message
            // in the batch resets the chain.
            runtime.origin = if batch.iter().any(|m| matches!(m.from, From::User)) {
                None
            } else {
                batch.iter().rev().find_map(|m| match &m.from {
                    From::Agent { sender, .. } => Some(sender.id.clone()),
                    From::User => None,
                })
            };
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
            // An interrupted turn's debts carry over to the turn that replaces it.
            for m in &batch {
                if let (From::Agent { sender, .. }, false) = (&m.from, m.reply) {
                    if !runtime.owed.iter().any(|a| a.id == sender.id) {
                        runtime.owed.push(sender.clone());
                    }
                }
            }
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
        // On disk too, so a turn cut short by a quit still gets its card.
        let start = turn_start(&agent_id).await;
        write_mark(
            &agent_id,
            TurnMark {
                pid: None,
                session: String::new(),
                project: start
                    .as_ref()
                    .map(|(p, _)| p.to_string_lossy().into_owned()),
                tree: start.as_ref().map(|(_, t)| t.clone()),
            },
        );
        let since = store::now_ms();
        let result = run_turn(&app, &agent_id, &prompt, routine, true).await;
        if QUITTING.load(Ordering::SeqCst) {
            // The app is going: the mark stays, for the next launch to report.
            return;
        }
        clear_mark(&agent_id);
        // What the turn changed goes before its failure, so a failed turn still
        // ends on its error line (Retry and the sidebar's failure read the newest line).
        if let Some((project, from)) = start {
            record_changes(&app, &agent_id, project, from).await;
        }
        let failed = match result {
            Ok(Ended::Interrupted) => {
                notify::turn_ended(&app, &agent_id);
                continue;
            }
            Ok(Ended::Stopped) => {
                take_owed(&agent_id);
                None
            }
            Ok(Ended::Finished) => Some(None),
            Err(err) => {
                let (text, failure) = super::failure::describe_now(&err.to_string());
                let mut line = new_message(&agent_id, MessageKind::Error, text.clone());
                line.failure = Some(failure);
                let _ = record(&app, line);
                Some(Some(text))
            }
        };
        if let Some(error) = failed {
            return_results(&app, &agent_id, since, error);
        }
        notify::turn_ended(&app, &agent_id);
    }
}

fn take_owed(agent_id: &str) -> Vec<AgentRef> {
    let mut runtimes = RUNTIMES.lock().unwrap_or_else(|e| e.into_inner());
    runtimes
        .get_mut(agent_id)
        .map(|r| std::mem::take(&mut r.owed))
        .unwrap_or_default()
}

/// A turn that answered other agents' requests is over: what it said (or why
/// it couldn't finish) goes back to each of them, so delegated work always
/// reports back and the agent never has to spend a tool call on it.
fn return_results(app: &AppHandle, agent_id: &str, since: i64, error: Option<String>) {
    let owed = take_owed(agent_id);
    if owed.is_empty() {
        return;
    }
    let hop = current_hop(agent_id).saturating_add(1);
    let Ok(me) = store::get(agent_id) else { return };
    let said: Vec<String> = store::messages(agent_id, 40)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.kind == MessageKind::Agent && m.ts >= since && !m.text.trim().is_empty())
        .map(|m| m.text)
        .collect();
    let text = match (error, said.is_empty()) {
        (Some(e), _) => format!("{} couldn't finish: {e}", me.name),
        (None, true) => format!("{} finished without saying anything.", me.name),
        (None, false) => said.join(
            "

",
        ),
    };
    let sender = AgentRef {
        id: me.id.clone(),
        name: me.name.clone(),
    };
    for to in owed {
        if hop > MAX_HOPS || store::get(&to.id).is_err() {
            continue;
        }
        let mut line = new_message(&to.id, MessageKind::FromAgent, text.clone());
        line.peer = Some(sender.clone());
        let _ = record(app, line);
        enqueue_reply(app, &to.id, text.clone(), sender.clone(), hop);
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
            From::Agent { sender, .. } => prompts::from_agent(&sender.name, &m.text, m.reply),
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

/// Why a turn that never sent its `result` event failed. Every finished turn
/// ends with one; without it the process died or wrote something unreadable,
/// whatever its exit code says, so this is never a silent "done". The CLI's
/// own words win when it left any.
fn unfinished_turn(exited_cleanly: bool, stderr: String) -> String {
    if !stderr.trim().is_empty() {
        return stderr;
    }
    let what = if exited_cleanly {
        "Claude Code stopped before finishing its reply."
    } else {
        "Claude Code quit unexpectedly before finishing its reply."
    };
    format!("{what} Send your message again; if it keeps happening, check that Claude Code works in a terminal.")
}

/// A prompt for a fresh session, prefixed with the visible conversation.
fn with_recap(agent_id: &str, prompt: &str) -> String {
    // Enough to pick the thread back up, not the whole history: this is
    // paid for in full (nothing cached) on the turn that needs it.
    let Ok(log) = store::messages(agent_id, 24) else {
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
            let text: String = m.text.chars().take(400).collect();
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
        Some("project_list") => "Looking at your projects".to_string(),
        Some("project_create") => format!("Creating {}", field("name")),
        Some("session_message" | "session_start") => format!("Working in {}", field("project")),
        Some("session_wait" | "session_progress") => format!("Following {}", field("project")),
        Some("preview_screenshot") => format!("Looking at {}", field("project")),
        Some("push") => format!("Pushing {}", field("project")),
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
    let mut prompt = system_prompt_base(agent, home, layout);
    if agent.is_main {
        if let Some(team) = store::list()
            .ok()
            .and_then(|all| prompts::team(&all, &agent.id))
        {
            prompt.push_str("\n\n");
            prompt.push_str(&team);
        }
    }
    prompt
}

fn system_prompt_base(
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
    model: Option<&str>,
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
        // Claude in Chrome. Verified in --print on 2.1.318: its tools load and
        // answer when the extension is connected. Its calls aren't allowed in
        // advance, so they ask through `approve` like any other MCP tool.
        "--chrome",
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
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}

/// Wait for `claude` to exit, at most [`EXIT_BOUND`] (a moment, once its
/// result is in and only background work could be keeping it); then stop
/// its tree.
async fn finish(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
    done: bool,
) -> std::io::Result<std::process::ExitStatus> {
    let bound = if done {
        Duration::from_secs(2)
    } else {
        EXIT_BOUND
    };
    if let Ok(status) = tokio::time::timeout(bound, child.wait()).await {
        return status;
    }
    tracing::info!(
        "[Agents] Claude Code is still running after its turn; stopping it and what it started"
    );
    if let Some(pid) = pid {
        let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
    }
    let _ = child.start_kill();
    child.wait().await
}

/// [`record`] on a blocking thread: it writes the log and the registry.
async fn record_off(app: &AppHandle, message: AgentMessage) {
    let app = app.clone();
    let _ = tokio::task::spawn_blocking(move || record(&app, message)).await;
}

/// The `claude` binary found and validated (`claude --version`, which
/// spawns a process and costs ~100ms) once per PATH, not per turn. It is
/// looked for again if the file goes away or fails to start.
static CLAUDE: LazyLock<Mutex<Option<(String, std::path::PathBuf)>>> =
    LazyLock::new(|| Mutex::new(None));

async fn claude_binary() -> Option<std::path::PathBuf> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    if let Some((for_path, binary)) = &*CLAUDE.lock().unwrap_or_else(|e| e.into_inner()) {
        if *for_path == path_var && binary.exists() {
            return Some(binary.clone());
        }
    }
    let binary = tokio::task::spawn_blocking(|| {
        crate::commands::claude::find_validated_binary("claude", "--version")
    })
    .await
    .ok()
    .flatten()?;
    *CLAUDE.lock().unwrap_or_else(|e| e.into_inner()) = Some((path_var, binary.clone()));
    Some(binary)
}

/// Where a turn's time went, logged once per turn (target `agents::timing`):
/// our preparation before the spawn, Claude Code's start-up until its init
/// event, the first streamed word, its result, and the wait for it to exit.
/// `cli_ms` is the CLI's own `duration_ms`, so overhead can be told apart.
struct Timing {
    began: std::time::Instant,
    spawned: std::time::Instant,
    boot: Option<std::time::Instant>,
    first_word: Option<std::time::Instant>,
    result: Option<std::time::Instant>,
    cli_ms: u64,
}

impl Timing {
    fn spawned(began: std::time::Instant) -> Self {
        Timing {
            began,
            spawned: std::time::Instant::now(),
            boot: None,
            first_word: None,
            result: None,
            cli_ms: 0,
        }
    }
    fn mark_boot(&mut self) {
        self.boot.get_or_insert_with(std::time::Instant::now);
    }
    fn mark_first_word(&mut self) {
        self.first_word.get_or_insert_with(std::time::Instant::now);
    }
    fn mark_result(&mut self, value: &serde_json::Value) {
        self.result = Some(std::time::Instant::now());
        self.cli_ms = value
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
    }
    fn log(&self, agent_id: &str) {
        let since = |t: Option<std::time::Instant>| {
            t.map(|t| t.duration_since(self.spawned).as_millis() as u64)
        };
        let tail = self.result.map(|r| r.elapsed().as_millis() as u64);
        tracing::info!(
            target: "agents::timing",
            agent = agent_id,
            prep_ms = self.spawned.duration_since(self.began).as_millis() as u64,
            boot_ms = since(self.boot).unwrap_or(0),
            first_word_ms = since(self.first_word).unwrap_or(0),
            result_ms = since(self.result).unwrap_or(0),
            tail_ms = tail.unwrap_or(0),
            cli_ms = self.cli_ms,
            "turn timing"
        );
    }
}

/// How a turn that didn't fail ended.
#[derive(Debug, PartialEq)]
enum Ended {
    Finished,
    /// Stopped for a newer message, which the next turn reads.
    Interrupted,
    /// Stopped by the user (or the time limit).
    Stopped,
}

/// Run one turn. `retry_fresh` lets a vanished session be replaced once.
async fn run_turn(
    app: &AppHandle,
    agent_id: &str,
    prompt: &str,
    routine: bool,
    retry_fresh: bool,
) -> Result<Ended, CommandError> {
    let began = std::time::Instant::now();
    let agent = store::get(agent_id)?;
    let home = store::agent_home(agent_id)?;
    std::fs::create_dir_all(&home).map_err(super::err_io)?;
    let binary = claude_binary().await.ok_or_else(|| {
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
    // This agent's secrets, as variables of this process only (see `secrets`).
    let secret_env = super::secrets::env_for(&agent);
    let mut system_prompt = system_prompt_for(&agent, &home, &layout);
    let have = super::secrets::prompt_section(&agent, &secret_env);
    if !have.is_empty() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&have);
    }
    let mut cmd = crate::utils::create_command(&binary);
    let model = if routine {
        agent.routine_model()
    } else {
        agent.model.as_deref()
    };
    cmd.args(turn_args(
        model,
        &session_id,
        resuming,
        &url,
        &system_prompt,
        &layout.add_dirs,
    ));
    strip_session_env(&mut cmd);
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
        .envs(secret_env)
        .current_dir(&layout.cwd);

    let mut cmd = tokio::process::Command::from(cmd);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so Stop takes down what it started too.
    procs::own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        *CLAUDE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        CommandError::expected(format!("Couldn't start Claude Code: {e}"))
    })?;
    let pid = child.id();
    if let Some(pid) = pid {
        procs::register(agent_id, pid);
    }
    let mut timing = Timing::spawned(began);

    let mut mark = read_mark(agent_id).unwrap_or_default();
    mark.pid = pid;
    mark.session = session_id.clone();
    write_mark(agent_id, mark);

    // A CLI that dies on startup closes stdin before reading it. Its exit
    // status and stderr say why; a "Broken pipe" here would only hide that.
    if let Some(mut stdin) = child.stdin.take() {
        // A value pasted into a message reaches the agent as its reference.
        let prompt = super::secrets::redact(prompt);
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            tracing::warn!("[Agents] couldn't hand {agent_id} its prompt: {e}");
        }
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
    // `claude` exited. Its output normally closes with it, but a child that
    // inherited the pipe can hold it open: read what's left for a moment,
    // then stop waiting for an end that may never come. Likewise once the
    // `result` event is in: `claude --print` stays alive for as long as a
    // background task its Bash tool started keeps running (a dev server: for
    // ever), which would hold the agent "working" and its slot for hours.
    // Observed with Claude Code 2.1. The turn is over; what it left running
    // is stopped with it (see `finish`).
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let drain_rest = tokio::time::sleep(Duration::from_secs(TURN_TIMEOUT_SECS));
    tokio::pin!(drain_rest);

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let kind = value.get("type").and_then(|t| t.as_str());
                // A `result` can answer something queued ahead of the user's
                // message (resumed after a Stop, Claude Code first answers the
                // killed background task's notification, then the message):
                // the model still talking means the turn isn't over, and the
                // row that went idle at that `result` is working again.
                if saw_result && matches!(kind, Some("stream_event" | "assistant")) {
                    drain_rest.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(3));
                    if status_of(agent_id).state == "idle" {
                        set_status(app, agent_id, Status { state: "working", activity: None, since: Some(started) });
                    }
                }
                match kind {
                    Some("system") => {
                        timing.mark_boot();
                        if let Some(caps) = super::capabilities::from_init(&value, store::now_ms()) {
                            let _ = store::update(agent_id, |a| a.capabilities = Some(caps));
                        }
                        if !session_confirmed {
                            if let Some(sid) = value.get("session_id").and_then(|s| s.as_str()) {
                                session_confirmed = true;
                                let sid = sid.to_string();
                                let id = agent_id.to_string();
                                let _ = tokio::task::spawn_blocking(move || store::update(&id, |a| a.session_id = Some(sid))).await;
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
                                        record_off(app, message).await;
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
                        timing.mark_result(&value);
                        // Its reply is complete: no "working" while the CLI exits.
                        set_status(app, agent_id, Status::idle());
                        drain_rest.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(3));
                        if let Some(turn) = super::usage::from_result(&value) {
                            let today = super::usage::today();
                            let id = agent_id.to_string();
                            let _ = tokio::task::spawn_blocking(move || store::update(&id, |a| a.usage.record(&turn, today))).await;
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
                    timing.mark_first_word();
                    emit_draft(app, agent_id, id, text);
                }
            }
            status = child.wait(), if exited.is_none() => {
                exited = Some(status);
                drain_rest.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(2));
            }
            _ = &mut drain_rest, if exited.is_some() || saw_result => break,
            _ = cancel.notified() => { stopped = Some(None); break; }
            _ = &mut deadline => { stopped = Some(Some("Stopped after 3 hours. Send a message to pick it back up.")); break; }
        }
    }

    // Stop, interrupt and the timeout end the whole tree, not just `claude`:
    // a dev server or watcher its Bash tool started dies with it.
    if stopped.is_some() {
        if let Some(pid) = pid {
            let _ = tokio::task::spawn_blocking(move || procs::kill_tree_sync(pid)).await;
        }
    }
    let status = match exited {
        Some(status) => status,
        None => finish(&mut child, pid, saw_result).await,
    };
    procs::unregister(agent_id);
    timing.log(agent_id);
    let status = status.map_err(super::err_io)?;
    let stderr_text = tokio::time::timeout(EXIT_BOUND, stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();

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
            return Ok(Ended::Interrupted);
        }
        // Stopped by the user is their doing, not a failure: a quiet line,
        // unless the cut-off reply already says so. Our own stop is an error.
        match note {
            Some(note) => {
                let _ = record(app, new_message(agent_id, MessageKind::Error, note));
            }
            None if cut_off.is_none() => {
                let _ = record(app, new_message(agent_id, MessageKind::Note, "Stopped"));
            }
            None => {}
        }
        return Ok(Ended::Stopped);
    }

    let missing_session =
        is_missing_session(&stderr_text) || result_error.as_deref().is_some_and(is_missing_session);
    if retry_fresh && resuming && missing_session {
        tracing::warn!("[Agents] Session {session_id} for {agent_id} is gone; starting a new one");
        let _ = store::update(agent_id, |a| a.session_id = None);
        // The new session starts blank. Hand it the conversation the user
        // can see, so the agent doesn't greet them like a stranger.
        let prompt = with_recap(agent_id, prompt);
        return Box::pin(run_turn(app, agent_id, &prompt, routine, false)).await;
    }

    if let Some(err) = result_error {
        return Err(CommandError::expected(err));
    }
    if !saw_result {
        let detail = unfinished_turn(status.success(), stderr_text);
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
    Ok(Ended::Finished)
}

/// A Ship Studio launched from inside a Claude Code session (a terminal
/// running `claude`, or a dev build started by one) inherits that session's
/// variables. With them, each agent runs as a nested child session that is
/// never written to disk, so the next `--resume` finds nothing. Observed:
/// every agent lost its memory between turns. Every `claude` we run for
/// Agents goes through this.
pub fn strip_session_env(cmd: &mut std::process::Command) {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messaging_back_the_agent_that_asked_settles_its_request_once() {
        let asker = AgentRef {
            id: "settle-chief".into(),
            name: "Chief of Staff".into(),
        };
        RUNTIMES
            .lock()
            .unwrap()
            .entry("settle-billing".into())
            .or_default()
            .owed = vec![asker.clone()];
        // A message to someone else is a request, not the answer.
        assert!(!settle("settle-billing", "settle-other"));
        assert!(settle("settle-billing", &asker.id));
        // Answered: the turn's last words aren't sent back again.
        assert!(!settle("settle-billing", &asker.id));
        assert!(take_owed("settle-billing").is_empty());
        assert!(!settle("nobody", &asker.id));
    }

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
                reply: false,
                routine: false,
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
                reply: false,
                routine: false,
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
        let args = turn_args(
            agent.model.as_deref(),
            "sid",
            true,
            "http://x",
            &prompt,
            &layout.add_dirs,
        );
        let expected: Vec<String> = [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--chrome",
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
        let args = turn_args(
            agent.model.as_deref(),
            "sid",
            false,
            "http://x",
            &prompt,
            &layout.add_dirs,
        );
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
    fn a_turn_without_a_result_is_always_a_failure_in_words() {
        let clean = unfinished_turn(true, String::new());
        let crashed = unfinished_turn(false, " \n".into());
        for text in [&clean, &crashed] {
            assert!(text.starts_with("Claude Code"), "{text}");
            assert!(!text.contains("exit status") && !text.contains("signal"));
        }
        assert_ne!(clean, crashed);
        assert_eq!(
            unfinished_turn(false, "Error: bad flag".into()),
            "Error: bad flag"
        );
    }

    #[test]
    fn a_queue_survives_on_disk_and_is_taken_once() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let queue: VecDeque<Inbound> = [
            Inbound {
                text: "Also check the footer".into(),
                from: From::User,
                reply: false,
                routine: false,
            },
            Inbound {
                text: "Receipts filed.\nDetails follow".into(),
                from: From::Agent {
                    sender: AgentRef {
                        id: "f".into(),
                        name: "Finance".into(),
                    },
                    hop: 2,
                },
                reply: true,
                routine: false,
            },
        ]
        .into();
        std::fs::create_dir_all(store::agent_home("a1").unwrap()).unwrap();
        save_inbox("a1", &queue);
        let taken = take_inbox("a1");
        assert_eq!(taken.len(), 2);
        assert!(matches!(&taken[1].from, From::Agent { hop: 2, .. }));
        assert!(take_inbox("a1").is_empty(), "taken twice");
        assert_eq!(
            resent_note(&taken),
            "Sent 2 messages still waiting when Ship Studio closed: “Also check the footer”, Finance's “Receipts filed.”"
        );
        save_inbox("a1", &VecDeque::new());
        assert!(!store::agent_home("a1").unwrap().join("inbox.json").exists());
        store::set_root_for_tests(None);
    }

    #[test]
    fn recognises_a_vanished_session() {
        assert!(is_missing_session(
            "Error: No conversation found with session ID: abc"
        ));
        assert!(!is_missing_session("rate limited"));
    }
}
