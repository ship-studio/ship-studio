//! `method` → command function.
//!
//! The router owns what is the phone's alone: parameter parsing, Remote
//! Access's text refusals, the idempotent send, the rate limit and the audit
//! line. Everything else is the [`Backend`], whose desktop implementation
//! calls the same command functions the Agents view does, so the phone gets
//! the desk's emits, badge refresh and "Always allow" covering pass for free.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::wire::{MacStatus, ProtocolCode, WireError};
use super::{actor_for, now_ms, Companion};
use crate::errors::CommandError;

/// What this Mac serves. `welcome.methods` lists exactly these, so the app
/// hides everything else.
pub const METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "devices.unpairSelf",
    "devices.setPush",
    "agents.overview",
    "agents.messages",
    "agents.send",
    "agents.stop",
    "agents.interrupt",
    "agents.answerApproval",
    "agents.saveSecret",
    "agents.focus",
    "agents.markUnread",
    "agents.update",
    "agents.revokePermission",
    "agents.instructions",
    "agents.memory",
    "agents.memoryChange",
    "agents.memorySuggest",
    "agents.usage",
    "agents.changeDiff",
    "agents.files",
    "agents.fetchPath",
    "agents.search",
    "agents.schedule.preview",
    "agents.schedule.create",
    "agents.schedule.update",
    "agents.schedule.pause",
    "agents.schedule.cancel",
    "agents.schedule.runNow",
    "projects.list",
    "sessions.read",
    "sessions.send",
    "sessions.key",
    "sessions.start",
    "preview.screenshot",
];

/// `READ_ONLY_METHODS` in methods.ts (the served subset): not audited.
pub const READ_ONLY_METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "agents.overview",
    "agents.messages",
    "agents.instructions",
    "agents.memory",
    "agents.memorySuggest",
    "agents.usage",
    "agents.changeDiff",
    "agents.files",
    "agents.search",
    "agents.schedule.preview",
    "projects.list",
    "sessions.read",
];

/// How long a `clientId` is remembered.
const SEND_MEMORY_MS: u64 = 24 * 60 * 60 * 1000;
const SEND_MEMORY_MAX: usize = 10_000;
const MESSAGES_DEFAULT: usize = 400;
const MESSAGES_MAX: usize = 1_000;

/// A staged upload handed to `agents_send` as a file on disk, so the desk's
/// own `attachments::save` copies it in.
#[derive(Debug, Clone, PartialEq)]
pub struct Staged {
    pub name: String,
    pub path: std::path::PathBuf,
}

/// What `agents.send` carries besides the text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SendExtras {
    pub mentions: Vec<String>,
    pub attachments: Vec<Staged>,
    pub client_id: Option<String>,
}

/// The schedule commands, one variant each.
#[derive(Debug, Clone, PartialEq)]
pub enum ScheduleOp {
    Preview {
        when: String,
    },
    Create {
        agent_id: String,
        when: String,
        note: String,
    },
    Update {
        agent_id: String,
        id: String,
        when: String,
        note: String,
    },
    Pause {
        agent_id: String,
        id: String,
        paused: bool,
    },
    Cancel {
        agent_id: String,
        id: String,
    },
    RunNow {
        agent_id: String,
        id: String,
    },
}

/// What the phone may change about an agent: the row's own toggles, and
/// its instructions (the agent sheet shows them, so it can correct them).
/// Its name, role, model and project stay the desk's.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentToggles {
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    pub instructions: Option<String>,
}

/// Instructions are a brief, not a document: the phone's editor stops here.
const MAX_INSTRUCTIONS: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalAnswer {
    pub agent_id: String,
    pub request_id: String,
    pub allow: bool,
    pub always: Option<bool>,
    pub note: Option<String>,
    /// On a session's question: the option picked, by index.
    pub choice: Option<usize>,
}

/// A memory entry is a line worth keeping, not a document.
const MAX_MEMORY_CHARS: usize = 2_000;
/// "Remember this" summarises one message; longer is cut, as on the desk.
const MAX_SUGGEST_CHARS: usize = 20_000;
/// A secret's parts: a username and password is the most a card asks for.
const MAX_SECRET_FIELDS: usize = 8;
const MAX_SECRET_CHARS: usize = 8_192;

/// Everything outside the companion it needs: the agents, the Mac, the
/// audit log and the Phone panel. The desktop implementation is in
/// `desktop.rs`; tests use a stub agent.
#[async_trait]
pub trait Backend: Send + Sync + 'static {
    async fn overview(&self) -> Result<Value, CommandError>;
    /// A page of messages, oldest first, ending just before `before` (or at
    /// the newest). The flag: older ones exist.
    async fn messages(
        &self,
        agent_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError>;
    async fn send(
        &self,
        agent_id: &str,
        text: String,
        extras: SendExtras,
    ) -> Result<Value, CommandError>;
    async fn stop(&self, agent_id: &str) -> Result<bool, CommandError>;
    async fn interrupt(&self, agent_id: &str) -> Result<bool, CommandError>;
    async fn answer_approval(&self, answer: ApprovalAnswer) -> Result<(), CommandError>;
    /// `agents_focus` for a socket instead of a window.
    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError>;
    async fn mark_unread(&self, agent_id: &str) -> Result<(), CommandError>;
    /// `agents_update` with only the toggles set; returns the stored agent.
    async fn update_agent(
        &self,
        agent_id: &str,
        toggles: AgentToggles,
    ) -> Result<Value, CommandError>;
    /// `agents_save_secret`: a secure input card's values into the Keychain.
    /// Returns the saved `AgentSecret` (never a value).
    async fn save_secret(
        &self,
        agent_id: &str,
        request_id: &str,
        values: Vec<String>,
    ) -> Result<Value, CommandError>;
    /// `agents_memory`: the agent's memory entries.
    async fn memory(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_memory_change`: add, edit or delete one entry.
    async fn memory_change(&self, agent_id: &str, change: Value) -> Result<Value, CommandError>;
    /// `agents_memory_suggest`: a message as one line worth keeping.
    async fn memory_suggest(&self, text: String) -> Result<String, CommandError>;
    /// `agents_instructions`: the agent's brief, as the Edit agent sheet shows it.
    async fn instructions(&self, agent_id: &str) -> Result<String, CommandError>;
    /// `agents_usage`: this week and all time.
    async fn usage(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// `agents_revoke_permission`: an "Always allow" rule taken back.
    async fn revoke_permission(&self, agent_id: &str, rule_id: &str) -> Result<(), CommandError>;
    /// `agents_change_diff`: one file of a change card.
    async fn change_diff(
        &self,
        agent_id: &str,
        message_id: &str,
        path: &str,
    ) -> Result<Value, CommandError>;
    /// `agents_files`: everything shared in one conversation, newest first.
    async fn files(&self, agent_id: &str) -> Result<Value, CommandError>;
    /// A path from an agent's reply, resolved as `share_file` resolves it
    /// (its home and the user's projects; folders refused).
    async fn shareable_path(
        &self,
        agent_id: &str,
        path: &str,
    ) -> Result<std::path::PathBuf, CommandError>;
    async fn search(&self, query: String) -> Result<Value, CommandError>;
    async fn schedule(&self, op: ScheduleOp) -> Result<Value, CommandError>;
    /// Every project as `ProjectSummary[]`.
    async fn projects(&self) -> Result<Value, CommandError>;
    /// One agent tab's screen as a `SessionScreen`.
    async fn session_screen(&self, session_id: &str) -> Result<Value, CommandError>;
    /// Type cleaned `text` into an agent tab of `project` (the given one, or
    /// the live one that printed last) and press Enter, with Remote
    /// Access's refusals. Returns the tab's session id.
    async fn session_send(
        &self,
        project: &str,
        session_id: Option<&str>,
        text: &str,
    ) -> Result<String, CommandError>;
    /// Press `key` (already one `key_bytes` knows) in an agent tab.
    async fn session_key(&self, session_id: &str, key: &str) -> Result<(), CommandError>;
    /// Open a new agent tab in `project` that starts on cleaned `prompt`
    /// (Remote Access's `start_agent`). Returns its session id once the tab exists.
    async fn session_start(&self, project: &str, prompt: &str) -> Result<String, CommandError>;
    /// The project's live preview as a JPEG, captured for the phone alone.
    async fn preview_screenshot(&self, project: &str, phone: bool)
        -> Result<Vec<u8>, CommandError>;
    /// An attachment's file: `attachments::resolve` under the agent's home.
    fn attachment_file(
        &self,
        agent_id: &str,
        rel: &str,
    ) -> Result<std::path::PathBuf, CommandError>;
    async fn mac_status(&self) -> MacStatus;
    fn server_name(&self) -> String;
    fn app_version(&self) -> String;
    fn audit(&self, actor: &str, tool: &str, detail: String, ok: bool);
    /// Something the Phone panel shows changed (a pair request, a connect).
    fn changed(&self);
}

/// `clientId` → the message that send produced, for 24 hours. Concurrent
/// retries wait on the first; a failed send isn't remembered, so it can be
/// tried again.
#[derive(Default)]
pub struct SendCache {
    map: Mutex<HashMap<String, Sent>>,
}

/// When a `clientId` was first seen, and its send's result once it has one.
type Sent = (u64, Arc<tokio::sync::OnceCell<Value>>);

impl SendCache {
    pub async fn once<F, Fut>(&self, key: String, now: u64, send: F) -> Result<Value, WireError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value, WireError>>,
    {
        let cell = {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|_, (at, _)| now.saturating_sub(*at) < SEND_MEMORY_MS);
            if map.len() >= SEND_MEMORY_MAX {
                if let Some(oldest) = map
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone())
                {
                    map.remove(&oldest);
                }
            }
            map.entry(key)
                .or_insert_with(|| (now, Arc::new(tokio::sync::OnceCell::new())))
                .1
                .clone()
        };
        cell.get_or_try_init(send).await.cloned()
    }
}

/// Who is calling: one socket of one paired device.
#[derive(Debug, Clone)]
pub struct Caller {
    pub device_id: String,
    pub device_name: String,
    /// `notify::set_showing`'s key for this socket.
    pub label: String,
    /// How this socket reached the Mac. Secrets go over Tailscale only.
    pub route: super::wire::RouteKind,
}

fn bad_params(e: impl std::fmt::Display) -> WireError {
    WireError::protocol(ProtocolCode::BadParams, e.to_string())
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, WireError> {
    // `{}` and an absent params object are the same thing.
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(bad_params)
}

/// `devices.setPush`: a token, or `null` to stop.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPushParams {
    token: Option<String>,
    #[serde(default)]
    environment: Option<super::push::PushEnvironment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentParam {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesParams {
    agent_id: String,
    limit: Option<usize>,
    before: Option<String>,
}

#[derive(Deserialize)]
struct BlobParam {
    #[serde(rename = "blobId")]
    blob_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathParams {
    agent_id: String,
    path: String,
}

#[derive(Deserialize)]
struct QueryParams {
    query: String,
}

#[derive(Deserialize)]
struct WhenParams {
    when: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleParams {
    agent_id: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    when: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    agent_id: String,
    input: AgentToggles,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSendParams {
    project: String,
    session_id: Option<String>,
    text: String,
    client_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleParams {
    agent_id: String,
    rule_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffParams {
    agent_id: String,
    message_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStartParams {
    project: String,
    prompt: String,
    client_id: String,
}

#[derive(Deserialize)]
struct ScreenshotParams {
    project: String,
    device: ScreenshotDevice,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScreenshotDevice {
    Desktop,
    Phone,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionKeyParams {
    session_id: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    agent_id: String,
    text: String,
    client_id: String,
    #[serde(default)]
    attachments: Vec<BlobParam>,
    #[serde(default)]
    mentions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalParams {
    agent_id: String,
    request_id: String,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
    choice: Option<usize>,
}

/// Never echoed: a parse error could quote a value, so a malformed request
/// gets a fixed sentence instead (see `"agents.saveSecret"`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretParams {
    agent_id: String,
    request_id: String,
    values: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryChangeParams {
    agent_id: String,
    change: Value,
}

#[derive(Deserialize)]
struct TextParam {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusParams {
    agent_id: Option<String>,
}

/// What the audit log records about a call: a preview of anything typed.
pub fn audit_detail(method: &str, params: &Value) -> String {
    let field = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("");
    let preview = crate::remote_access::preview;
    match method {
        "agents.send" | "sessions.send" => preview(field("text")),
        "sessions.key" => format!("pressed {}", field("key")),
        "agents.update" => {
            let input = params.get("input").cloned().unwrap_or(Value::Null);
            let flag = |k: &str, on: &str, off: &str| match input.get(k).and_then(Value::as_bool) {
                Some(true) => Some(on.to_string()),
                Some(false) => Some(off.to_string()),
                None => None,
            };
            [
                flag("pinned", "pin", "unpin"),
                flag("muted", "mute", "unmute"),
                flag("hidden", "hide", "unhide"),
                input
                    .get("instructions")
                    .and_then(Value::as_str)
                    .map(|i| format!("edit instructions ({} chars)", i.chars().count())),
            ]
            .into_iter()
            .flatten()
            .chain(std::iter::once(field("agentId").to_string()))
            .collect::<Vec<_>>()
            .join(" ")
        }
        "agents.answerApproval" => {
            let allow = params
                .get("allow")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let always = params
                .get("always")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let note = field("note").trim();
            if let Some(choice) = params.get("choice").and_then(Value::as_u64) {
                return format!("picked option {}", choice + 1);
            }
            match (allow, always, note.is_empty()) {
                (true, true, _) => "always allow".into(),
                (true, false, _) => "allow".into(),
                (false, _, true) => "deny".into(),
                (false, _, false) => preview(&format!("deny with note: {note}")),
            }
        }
        // Names the card, never a value: `values` is not read here.
        "agents.saveSecret" => format!("saved a secret for {}", field("agentId")),
        "agents.memoryChange" => {
            let change = params.get("change").cloned().unwrap_or(Value::Null);
            let text = change.get("text").and_then(Value::as_str).unwrap_or("");
            match change.get("op").and_then(Value::as_str).unwrap_or("") {
                "add" => preview(&format!("remember: {text}")),
                "edit" => preview(&format!("edit memory: {text}")),
                "delete" => format!(
                    "forget memory entry {}",
                    change
                        .get("index")
                        .map(Value::to_string)
                        .unwrap_or_default()
                ),
                other => format!("memory {other}"),
            }
        }
        "devices.unpairSelf" => "forgot this Mac".into(),
        "devices.setPush" => match params.get("token").and_then(Value::as_str) {
            Some(_) => "push token set".into(),
            None => "push token cleared".into(),
        },
        "agents.fetchPath" => preview(field("path")),
        "agents.revokePermission" => format!("revoke {} {}", field("ruleId"), field("agentId")),
        "sessions.start" => preview(&format!("{} — {}", field("project"), field("prompt"))),
        "preview.screenshot" => format!("{} {}", field("project"), field("device")),
        "agents.schedule.create" | "agents.schedule.update" => {
            preview(&format!("{} — {}", field("when"), field("note")))
        }
        "agents.schedule.pause" => {
            let paused = params.get("paused").and_then(Value::as_bool) == Some(true);
            format!(
                "{} {}",
                if paused { "pause" } else { "resume" },
                field("id")
            )
        }
        "agents.schedule.cancel" | "agents.schedule.runNow" => field("id").to_string(),
        _ => field("agentId").to_string(),
    }
}

/// Run one request, with the rate limit and the audit line around it.
pub async fn dispatch(
    c: &Companion,
    caller: &Caller,
    method: &str,
    params: Value,
) -> Result<Value, WireError> {
    if !METHODS.contains(&method) {
        return Err(WireError::protocol(
            ProtocolCode::UnknownMethod,
            format!("This Mac doesn't know {method}."),
        ));
    }
    if !c.allow_request(&caller.device_id, now_ms()) {
        return Err(WireError::protocol(
            ProtocolCode::RateLimited,
            "Too many requests. Try again in a minute.",
        ));
    }
    let detail = audit_detail(method, &params);
    let result = run(c, caller, method, params).await;
    if !READ_ONLY_METHODS.contains(&method) {
        let (detail, ok) = match &result {
            Ok(_) => (detail, true),
            Err(e) => (
                crate::remote_access::preview(&format!("{detail} — refused: {}", e.summary())),
                false,
            ),
        };
        c.backend
            .audit(&actor_for(&caller.device_name), method, detail, ok);
    }
    result
}

async fn run(
    c: &Companion,
    caller: &Caller,
    method: &str,
    params: Value,
) -> Result<Value, WireError> {
    let b = &c.backend;
    match method {
        "system.status" => Ok(to_value(&refresh_status(c).await)),
        "devices.self" => c
            .registry
            .get(&caller.device_id)
            .map(|d| to_value(&d.view(true)))
            .ok_or_else(|| CommandError::expected("This phone isn't paired any more.").into()),
        "devices.unpairSelf" => {
            let gone = c.registry.revoke(&caller.device_id)?;
            if let Some(d) = &gone {
                c.forget_push_later(d);
                b.changed();
            }
            Ok(Value::Null)
        }
        "devices.setPush" => {
            let p: SetPushParams = parse(params)?;
            let status = super::push::set_push(
                c,
                &caller.device_id,
                p.token,
                p.environment.unwrap_or_default(),
            )
            .await?;
            Ok(json!({ "status": status }))
        }
        "agents.overview" => Ok(b.overview().await?),
        "agents.messages" => {
            let p: MessagesParams = parse(params)?;
            // Read the cursor first: anything changed after it reaches the
            // phone as an event with a higher seq, which the merge keeps.
            let as_of = c.hub.cursor();
            let limit = p.limit.unwrap_or(MESSAGES_DEFAULT).clamp(1, MESSAGES_MAX);
            let (messages, more) = b.messages(&p.agent_id, limit, p.before.as_deref()).await?;
            Ok(json!({ "messages": messages, "asOf": as_of, "more": more }))
        }
        "agents.send" => {
            let p: SendParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:{client_id}", caller.device_id);
            let device = caller.device_id.clone();
            c.sends
                .once(key, now_ms(), || async move {
                    let blob_ids: Vec<String> =
                        p.attachments.into_iter().map(|a| a.blob_id).collect();
                    let attachments = staged(c, &device, &blob_ids)?;
                    // Files alone are a message, as on the desk; any text
                    // still gets Remote Access's refusals.
                    let text = if attachments.is_empty() || !p.text.trim().is_empty() {
                        crate::remote_access::tools::clean_agent_text(&p.text, "message")
                            .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?
                    } else {
                        String::new()
                    };
                    let extras = SendExtras {
                        mentions: p.mentions,
                        attachments,
                        client_id: Some(client_id),
                    };
                    let sent = b.send(&p.agent_id, text, extras).await?;
                    c.blobs.consume(&blob_ids);
                    Ok(sent)
                })
                .await
        }
        "agents.stop" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::Bool(b.stop(&p.agent_id).await?))
        }
        "agents.interrupt" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::Bool(b.interrupt(&p.agent_id).await?))
        }
        "agents.answerApproval" => {
            let p: ApprovalParams = parse(params)?;
            b.answer_approval(ApprovalAnswer {
                agent_id: p.agent_id,
                request_id: p.request_id,
                allow: p.allow,
                always: p.always,
                note: p.note,
                choice: p.choice,
            })
            .await?;
            Ok(Value::Null)
        }
        "agents.saveSecret" => {
            if caller.route != super::wire::RouteKind::Tailscale {
                return Err(WireError::protocol(
                    ProtocolCode::Refused,
                    "Secrets are only sent over Tailscale, which encrypts them all the way to this Mac.",
                ));
            }
            let p: SecretParams = parse(params).map_err(|_| {
                bad_params("A secret needs agentId, requestId and one value per field.")
            })?;
            if p.values.is_empty()
                || p.values.len() > MAX_SECRET_FIELDS
                || p.values
                    .iter()
                    .any(|v| v.chars().count() > MAX_SECRET_CHARS)
            {
                return Err(bad_params(
                    "That doesn't look like a secret this card asked for.",
                ));
            }
            Ok(b.save_secret(&p.agent_id, &p.request_id, p.values).await?)
        }
        "agents.memory" => {
            let p: AgentParam = parse(params)?;
            Ok(b.memory(&p.agent_id).await?)
        }
        "agents.memoryChange" => {
            let p: MemoryChangeParams = parse(params)?;
            let text = p.change.get("text").and_then(Value::as_str).unwrap_or("");
            if text.chars().count() > MAX_MEMORY_CHARS {
                return Err(bad_params(format!(
                    "A memory can be up to {MAX_MEMORY_CHARS} characters."
                )));
            }
            if text.chars().any(|c| c.is_control() && c != '\n') {
                return Err(WireError::protocol(
                    ProtocolCode::Refused,
                    "A memory can't contain control characters.",
                ));
            }
            Ok(b.memory_change(&p.agent_id, p.change).await?)
        }
        "agents.memorySuggest" => {
            let p: TextParam = parse(params)?;
            let text: String = p.text.chars().take(MAX_SUGGEST_CHARS).collect();
            Ok(Value::String(b.memory_suggest(text).await?))
        }
        "agents.focus" => {
            let p: FocusParams = parse(params)?;
            b.focus(&caller.label, p.agent_id).await?;
            Ok(Value::Null)
        }
        "agents.markUnread" => {
            let p: AgentParam = parse(params)?;
            b.mark_unread(&p.agent_id).await?;
            Ok(Value::Null)
        }
        "agents.update" => {
            let p: UpdateParams = parse(params).map_err(|_| {
                bad_params(
                    "Only pin, mute, hide and the instructions can be changed from the phone.",
                )
            })?;
            if p.input == AgentToggles::default() {
                return Err(bad_params("Nothing to change."));
            }
            if p.input
                .instructions
                .as_ref()
                .is_some_and(|i| i.chars().count() > MAX_INSTRUCTIONS)
            {
                return Err(bad_params(format!(
                    "Instructions can be up to {MAX_INSTRUCTIONS} characters."
                )));
            }
            // `StoredAgent` doesn't carry lifetime usage, as the overview doesn't.
            let mut stored = b.update_agent(&p.agent_id, p.input).await?;
            if let Some(fields) = stored.as_object_mut() {
                fields.remove("usage");
            }
            Ok(stored)
        }
        "agents.files" => {
            let p: AgentParam = parse(params)?;
            Ok(b.files(&p.agent_id).await?)
        }
        "agents.instructions" => {
            let p: AgentParam = parse(params)?;
            Ok(Value::String(b.instructions(&p.agent_id).await?))
        }
        "agents.usage" => {
            let p: AgentParam = parse(params)?;
            Ok(b.usage(&p.agent_id).await?)
        }
        "agents.revokePermission" => {
            let p: RuleParams = parse(params)?;
            b.revoke_permission(&p.agent_id, &p.rule_id).await?;
            Ok(Value::Null)
        }
        "agents.changeDiff" => {
            let p: DiffParams = parse(params)?;
            Ok(b.change_diff(&p.agent_id, &p.message_id, &p.path).await?)
        }
        "agents.fetchPath" => {
            let p: PathParams = parse(params)?;
            let source = b.shareable_path(&p.agent_id, &p.path).await?;
            let blob = c.blobs.produce(&caller.device_id, &source, now_ms())?;
            Ok(to_value(&blob.as_ref()))
        }
        "agents.search" => {
            let p: QueryParams = parse(params)?;
            Ok(b.search(p.query).await?)
        }
        "agents.schedule.preview" => {
            let p: WhenParams = parse(params)?;
            Ok(b.schedule(ScheduleOp::Preview { when: p.when }).await?)
        }
        "agents.schedule.create"
        | "agents.schedule.update"
        | "agents.schedule.pause"
        | "agents.schedule.cancel"
        | "agents.schedule.runNow" => {
            let p: ScheduleParams = parse(params)?;
            let needs_id = method != "agents.schedule.create";
            if needs_id && p.id.trim().is_empty() {
                return Err(bad_params("id is required."));
            }
            let op = match method {
                "agents.schedule.create" => ScheduleOp::Create {
                    agent_id: p.agent_id,
                    when: p.when,
                    note: p.note,
                },
                "agents.schedule.update" => ScheduleOp::Update {
                    agent_id: p.agent_id,
                    id: p.id,
                    when: p.when,
                    note: p.note,
                },
                "agents.schedule.pause" => ScheduleOp::Pause {
                    agent_id: p.agent_id,
                    id: p.id,
                    paused: p.paused,
                },
                "agents.schedule.cancel" => ScheduleOp::Cancel {
                    agent_id: p.agent_id,
                    id: p.id,
                },
                _ => ScheduleOp::RunNow {
                    agent_id: p.agent_id,
                    id: p.id,
                },
            };
            Ok(b.schedule(op).await?)
        }
        "projects.list" => Ok(b.projects().await?),
        "sessions.read" => {
            let p: SessionParams = parse(params)?;
            Ok(b.session_screen(&p.session_id).await?)
        }
        "sessions.send" => {
            let p: SessionSendParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:session:{client_id}", caller.device_id);
            c.sends
                .once(key, now_ms(), || async move {
                    let text = crate::remote_access::tools::clean_agent_text(&p.text, "message")
                        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
                    let session_id = b
                        .session_send(&p.project, p.session_id.as_deref(), &text)
                        .await?;
                    Ok(json!({ "sessionId": session_id }))
                })
                .await
        }
        "sessions.key" => {
            let p: SessionKeyParams = parse(params)?;
            if crate::remote_access::tools::key_bytes(&p.key).is_none() {
                return Err(WireError::protocol(
                    ProtocolCode::Refused,
                    format!("\"{}\" isn't a key the phone can press.", p.key),
                ));
            }
            b.session_key(&p.session_id, &p.key).await?;
            Ok(Value::Null)
        }
        "sessions.start" => {
            let p: SessionStartParams = parse(params)?;
            let client_id = p.client_id.trim().to_string();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let key = format!("{}:start:{client_id}", caller.device_id);
            c.sends
                .once(key, now_ms(), || async move {
                    let prompt = crate::remote_access::tools::clean_agent_text(&p.prompt, "prompt")
                        .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
                    let session_id = b.session_start(&p.project, &prompt).await?;
                    Ok(json!({ "sessionId": session_id }))
                })
                .await
        }
        "preview.screenshot" => {
            let p: ScreenshotParams = parse(params)?;
            let phone = matches!(p.device, ScreenshotDevice::Phone);
            let jpeg = b.preview_screenshot(&p.project, phone).await?;
            let name = format!(
                "{}-{}.jpg",
                crate::remote_access::tools::project_name(&p.project),
                if phone { "phone" } else { "desktop" }
            );
            let blob = c.blobs.put(
                &caller.device_id,
                &name,
                Some("image/jpeg"),
                &jpeg,
                now_ms(),
            )?;
            Ok(to_value(&blob.as_ref()))
        }
        _ => Err(WireError::protocol(
            ProtocolCode::UnknownMethod,
            format!("This Mac doesn't know {method}."),
        )),
    }
}

/// The staged uploads a send names, as files `attachments::save` can copy.
/// Every id must be this device's and still staged.
fn staged(c: &Companion, device_id: &str, ids: &[String]) -> Result<Vec<Staged>, WireError> {
    use crate::agents::attachments::MAX_FILES;
    if ids.len() > MAX_FILES {
        return Err(CommandError::expected(format!(
            "You can attach up to {MAX_FILES} files at a time."
        ))
        .into());
    }
    ids.iter()
        .map(|id| {
            c.blobs
                .get(device_id, id, now_ms())
                .map(|blob| Staged {
                    name: blob.name,
                    path: blob.path,
                })
                .ok_or_else(|| {
                    CommandError::expected(
                        "A file you attached didn't reach the Mac, or waited over an hour. Attach it again.",
                    )
                    .into()
                })
        })
        .collect()
}

/// The Mac's status now, journaled when it changed so phones that weren't
/// asking hear about it too.
pub async fn refresh_status(c: &Companion) -> MacStatus {
    let status = c.backend.mac_status().await;
    if c.remember_status(&status) {
        c.hub.publish(super::wire::Event::System {
            status: status.clone(),
        });
    }
    status
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_lines_preview_what_was_typed_and_name_the_answer() {
        assert_eq!(
            audit_detail("agents.send", &json!({ "text": "fix\n the   header" })),
            "fix the header"
        );
        let a = |p: Value| audit_detail("agents.answerApproval", &p);
        assert_eq!(a(json!({ "allow": true })), "allow");
        assert_eq!(a(json!({ "allow": true, "always": true })), "always allow");
        assert_eq!(a(json!({ "allow": false })), "deny");
        assert_eq!(
            a(json!({ "allow": false, "note": "use pnpm" })),
            "deny with note: use pnpm"
        );
        assert_eq!(
            audit_detail("agents.stop", &json!({ "agentId": "a1" })),
            "a1"
        );
    }

    fn caller(device: &str) -> Caller {
        Caller {
            device_id: device.into(),
            device_name: "Test Phone".into(),
            label: format!("companion:{device}:1"),
            route: crate::companion::wire::RouteKind::Tailscale,
        }
    }

    #[tokio::test]
    async fn a_secret_goes_only_over_tailscale_and_no_value_reaches_the_audit() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let save = |values: Value| json!({ "agentId": AGENT, "requestId": "q8", "values": values });
        let mut lan = caller("dev_a");
        lan.route = crate::companion::wire::RouteKind::Lan;
        let refused = dispatch(
            &c,
            &lan,
            "agents.saveSecret",
            save(json!(["julian", "hunter2"])),
        )
        .await
        .unwrap_err();
        assert!(refused.summary().contains("only sent over Tailscale"));

        let me = caller("dev_a");
        let saved = dispatch(
            &c,
            &me,
            "agents.saveSecret",
            save(json!(["julian", "hunter2"])),
        )
        .await
        .unwrap();
        assert_eq!(saved["name"], "Stripe key");
        assert_eq!(
            stub.secrets_saved.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        // A malformed request is refused without quoting what it carried.
        let bad = dispatch(&c, &me, "agents.saveSecret", save(json!("hunter2")))
            .await
            .unwrap_err();
        assert!(!bad.summary().contains("hunter2"));
        let extra = json!({ "agentId": AGENT, "requestId": "q8", "values": ["a"], "v": "hunter2" });
        assert!(!dispatch(&c, &me, "agents.saveSecret", extra)
            .await
            .unwrap_err()
            .summary()
            .contains("hunter2"));
        for (_, method, detail, _) in stub.audited() {
            assert_eq!(method, "agents.saveSecret");
            assert!(
                !detail.contains("hunter2") && !detail.contains("julian"),
                "{detail}"
            );
        }
        assert_eq!(stub.audited().len(), 4);
    }

    #[tokio::test]
    async fn a_session_question_is_answered_by_option() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let params = json!({ "agentId": AGENT, "requestId": "q6", "allow": true, "choice": 1 });
        dispatch(&c, &me, "agents.answerApproval", params)
            .await
            .unwrap();
        assert_eq!(stub.answers.lock().unwrap()[0].choice, Some(1));
        assert_eq!(stub.audited()[0].2, "picked option 2");
    }

    #[tokio::test]
    async fn memory_changes_are_audited_and_kept_short() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let add =
            |text: String| json!({ "agentId": AGENT, "change": { "op": "add", "text": text } });
        let view = dispatch(
            &c,
            &me,
            "agents.memoryChange",
            add("Ship on Fridays".into()),
        )
        .await
        .unwrap();
        assert_eq!(view["entries"].as_array().unwrap().len(), 4);
        assert_eq!(stub.audited()[0].2, "remember: Ship on Fridays");
        assert!(
            dispatch(&c, &me, "agents.memoryChange", add("x".repeat(2_001)))
                .await
                .is_err()
        );
        assert!(
            dispatch(&c, &me, "agents.memoryChange", add("a\u{1b}[2J".into()))
                .await
                .is_err()
        );
        // Reading isn't an action: not audited.
        dispatch(&c, &me, "agents.memory", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(stub.audited().len(), 3);
    }

    #[tokio::test]
    async fn a_send_echoes_its_client_id_and_a_retry_returns_the_same_message() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let (mut rx, _) = c.hub.resume(None);
        let me = caller("dev_a");
        let params = json!({ "agentId": AGENT, "text": "hello", "clientId": "c-42" });
        let first = dispatch(&c, &me, "agents.send", params.clone())
            .await
            .unwrap();
        assert_eq!(first["clientId"], "c-42");
        let again = dispatch(&c, &me, "agents.send", params).await.unwrap();
        assert_eq!(first, again);
        assert_eq!(stub.sends.load(std::sync::atomic::Ordering::SeqCst), 1);
        let mut journaled = None;
        while let Ok(item) = rx.try_recv() {
            if let super::super::hub::HubItem::Journaled {
                event: super::super::wire::Event::Message { message },
                ..
            } = item
            {
                if message["id"] == first["id"] {
                    journaled = Some(message);
                }
            }
        }
        assert_eq!(journaled.expect("journaled")["clientId"], "c-42");
    }

    #[tokio::test]
    async fn attachments_must_be_this_devices_staged_blobs_and_few_enough() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let send = |ids: Vec<String>, client: &str| {
            let attachments: Vec<Value> = ids.iter().map(|id| json!({ "blobId": id })).collect();
            json!({ "agentId": AGENT, "text": "", "clientId": client, "attachments": attachments })
        };
        let unknown = dispatch(&c, &me, "agents.send", send(vec!["blob_nope".into()], "c1")).await;
        assert!(unknown.unwrap_err().summary().contains("Attach it again"));

        let theirs = c.blobs.put("dev_b", "a.txt", None, b"x", now_ms()).unwrap();
        assert!(
            dispatch(&c, &me, "agents.send", send(vec![theirs.id], "c2"))
                .await
                .is_err()
        );

        let eleven: Vec<String> = (0..11)
            .map(|_| {
                c.blobs
                    .put("dev_a", "a.txt", None, b"x", now_ms())
                    .unwrap()
                    .id
            })
            .collect();
        let refused = dispatch(&c, &me, "agents.send", send(eleven, "c3")).await;
        assert!(refused.unwrap_err().summary().contains("up to 10 files"));

        // No files and no text is still refused.
        let empty = dispatch(&c, &me, "agents.send", send(Vec::new(), "c4")).await;
        assert!(empty.is_err());
    }

    #[tokio::test]
    async fn fetch_path_stages_a_file_for_this_device_and_refuses_folders() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        std::fs::write(stub.home.path().join("report.md"), "# Q3").unwrap();
        std::fs::create_dir(stub.home.path().join("folder")).unwrap();
        let me = caller("dev_a");
        let blob = dispatch(
            &c,
            &me,
            "agents.fetchPath",
            json!({ "agentId": AGENT, "path": "report.md" }),
        )
        .await
        .unwrap();
        assert_eq!(blob["name"], "report.md");
        assert_eq!(blob["mime"], "text/markdown");
        assert_eq!(blob["size"], 4);
        let id = blob["blobId"].as_str().unwrap();
        assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
        assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
        for refused in ["folder", "/etc/hosts", "../outside.txt"] {
            assert!(
                dispatch(
                    &c,
                    &me,
                    "agents.fetchPath",
                    json!({ "agentId": AGENT, "path": refused })
                )
                .await
                .is_err(),
                "{refused}"
            );
        }
    }

    #[tokio::test]
    async fn schedule_methods_need_an_id_except_create() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let missing = dispatch(
            &c,
            &me,
            "agents.schedule.cancel",
            json!({ "agentId": AGENT }),
        )
        .await;
        assert!(missing.is_err());
        let made = dispatch(
            &c,
            &me,
            "agents.schedule.create",
            json!({ "agentId": AGENT, "when": "every weekday at 9am", "note": "Check the invoices" }),
        )
        .await
        .unwrap();
        assert_eq!(made["note"], "Check the invoices");
        assert_eq!(made["repeat"]["kind"], "days");
    }

    #[tokio::test]
    async fn the_agent_sheet_reads_usage_and_instructions_and_revokes() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let brief = dispatch(&c, &me, "agents.instructions", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert!(brief.as_str().unwrap().contains("invoices"));
        let usage = dispatch(&c, &me, "agents.usage", json!({ "agentId": AGENT }))
            .await
            .unwrap();
        assert_eq!(usage["week"]["turns"], 3);
        dispatch(
            &c,
            &me,
            "agents.revokePermission",
            json!({ "agentId": AGENT, "ruleId": "r1" }),
        )
        .await
        .unwrap();
        assert_eq!(stub.revoked.lock().unwrap().as_slice(), ["r1"]);
        let diff = dispatch(
            &c,
            &me,
            "agents.changeDiff",
            json!({ "agentId": AGENT, "messageId": "m-change", "path": "src/a.ts" }),
        )
        .await
        .unwrap();
        assert_eq!(diff["filePath"], "src/a.ts");
        // Reads aren't audited; the revoke is.
        let audit = stub.audited();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].1, "agents.revokePermission");
    }

    #[tokio::test]
    async fn a_session_starts_once_per_client_id_with_remote_access_refusals() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let project = "/Users/julian/ShipStudio/site";
        let start = |prompt: &str, client: &str| json!({ "project": project, "prompt": prompt, "clientId": client });
        let first = dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
            .await
            .unwrap();
        assert_eq!(first["sessionId"], "pty-new");
        dispatch(&c, &me, "sessions.start", start("add a footer", "a1"))
            .await
            .unwrap();
        assert_eq!(stub.typed.lock().unwrap().len(), 1);
        assert!(
            dispatch(&c, &me, "sessions.start", start("!rm -rf /", "a3"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_preview_screenshot_is_a_private_blob() {
        use crate::companion::testkit::Stub;
        let (c, _) = Stub::companion();
        let me = caller("dev_a");
        let blob = dispatch(
            &c,
            &me,
            "preview.screenshot",
            json!({ "project": "/Users/julian/ShipStudio/site", "device": "phone" }),
        )
        .await
        .unwrap();
        assert_eq!(blob["name"], "site-phone.jpg");
        assert_eq!(blob["mime"], "image/jpeg");
        let id = blob["blobId"].as_str().unwrap();
        assert!(c.blobs.get("dev_a", id, now_ms()).is_some());
        assert!(c.blobs.get("dev_b", id, now_ms()).is_none());
        assert!(dispatch(
            &c,
            &me,
            "preview.screenshot",
            json!({ "project": "/x", "device": "watch" }),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn the_phone_may_only_pin_mute_and_hide() {
        use crate::companion::testkit::{Stub, AGENT};
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let done = dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "muted": true, "pinned": false } }),
        )
        .await
        .unwrap();
        assert_eq!(done["muted"], true);
        assert_eq!(done["pinned"], false);
        for refused in [
            json!({ "agentId": AGENT, "input": { "name": "Evil" } }),
            json!({ "agentId": AGENT, "input": { "model": "opus" } }),
            json!({ "agentId": AGENT, "input": { "instructions": "x".repeat(MAX_INSTRUCTIONS + 1) } }),
            json!({ "agentId": AGENT, "input": {} }),
        ] {
            assert!(dispatch(&c, &me, "agents.update", refused).await.is_err());
        }
        // The instructions can be corrected from the agent sheet, and the audit says so.
        dispatch(
            &c,
            &me,
            "agents.update",
            json!({ "agentId": AGENT, "input": { "instructions": "Check the invoices" } }),
        )
        .await
        .unwrap();
        assert_eq!(stub.toggles.lock().unwrap().len(), 2);
        let audit = stub.audited();
        assert_eq!(audit[0].2, format!("unpin mute {AGENT}"));
        assert_eq!(
            audit.last().unwrap().2,
            format!("edit instructions (18 chars) {AGENT}")
        );
    }

    #[tokio::test]
    async fn session_input_gets_remote_access_refusals_and_is_sent_once() {
        use crate::companion::testkit::Stub;
        let (c, stub) = Stub::companion();
        let me = caller("dev_a");
        let project = "/Users/julian/ShipStudio/site";
        let send = |text: &str, client: &str, tab: &str| json!({ "project": project, "sessionId": tab, "text": text, "clientId": client });
        // The working tab takes a message, once per clientId.
        let first = dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
            .await
            .unwrap();
        assert_eq!(first["sessionId"], "pty-1");
        dispatch(&c, &me, "sessions.send", send("fix it", "s1", "pty-1"))
            .await
            .unwrap();
        assert_eq!(stub.typed.lock().unwrap().len(), 1);
        // Shell escapes, control characters and unknown slash commands never reach a tab.
        for text in ["!rm -rf /", "\u{7}\u{8}", "/logout"] {
            let refused = dispatch(&c, &me, "sessions.send", send(text, text, "pty-1")).await;
            assert!(refused.is_err(), "{text}");
        }
        // A tab showing a question isn't typed into: Enter would answer it.
        let asking = dispatch(&c, &me, "sessions.send", send("hello", "s2", "pty-2")).await;
        assert!(asking
            .unwrap_err()
            .summary()
            .contains("waiting for your answer"));
        // Keys: only ones Remote Access can press, a digit only while asking.
        let key = |k: &str, tab: &str| json!({ "sessionId": tab, "key": k });
        dispatch(&c, &me, "sessions.key", key("1", "pty-2"))
            .await
            .unwrap();
        assert!(dispatch(&c, &me, "sessions.key", key("1", "pty-1"))
            .await
            .is_err());
        assert!(dispatch(&c, &me, "sessions.key", key("rm", "pty-2"))
            .await
            .is_err());
        assert_eq!(stub.typed.lock().unwrap().len(), 2);
    }

    #[test]
    fn every_read_only_method_is_served() {
        for m in READ_ONLY_METHODS {
            assert!(METHODS.contains(m), "{m}");
        }
    }

    #[tokio::test]
    async fn a_send_cache_runs_each_client_id_once() {
        let cache = SendCache::default();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let send = || async {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({ "id": "m1" }))
        };
        let a = cache.once("dev:c1".into(), 0, send).await.unwrap();
        let b = cache.once("dev:c1".into(), 1, send).await.unwrap();
        assert_eq!(a, b);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        cache.once("dev:c2".into(), 2, send).await.unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2);
        // A day later the id is forgotten.
        cache
            .once("dev:c1".into(), SEND_MEMORY_MS + 5, send)
            .await
            .unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_failed_send_can_be_retried() {
        let cache = SendCache::default();
        let failed = cache
            .once("k".into(), 0, || async {
                Err(WireError::Command(CommandError::expected("disk full")))
            })
            .await;
        assert!(failed.is_err());
        let ok = cache.once("k".into(), 1, || async { Ok(json!(1)) }).await;
        assert_eq!(ok.unwrap(), json!(1));
    }
}
