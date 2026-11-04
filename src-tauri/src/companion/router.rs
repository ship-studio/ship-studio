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

/// What P1 serves. `welcome.methods` lists exactly these, so the app hides
/// everything else.
pub const METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "devices.unpairSelf",
    "agents.overview",
    "agents.messages",
    "agents.send",
    "agents.stop",
    "agents.interrupt",
    "agents.answerApproval",
    "agents.focus",
    "agents.markUnread",
];

/// `READ_ONLY_METHODS` in methods.ts (the P1 subset): not audited.
pub const READ_ONLY_METHODS: &[&str] = &[
    "system.status",
    "devices.self",
    "agents.overview",
    "agents.messages",
];

/// How long a `clientId` is remembered.
const SEND_MEMORY_MS: u64 = 24 * 60 * 60 * 1000;
const SEND_MEMORY_MAX: usize = 10_000;
const MESSAGES_DEFAULT: usize = 400;
const MESSAGES_MAX: usize = 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalAnswer {
    pub agent_id: String,
    pub request_id: String,
    pub allow: bool,
    pub always: Option<bool>,
    pub note: Option<String>,
}

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
        mentions: Vec<String>,
    ) -> Result<Value, CommandError>;
    async fn stop(&self, agent_id: &str) -> Result<bool, CommandError>;
    async fn interrupt(&self, agent_id: &str) -> Result<bool, CommandError>;
    async fn answer_approval(&self, answer: ApprovalAnswer) -> Result<(), CommandError>;
    /// `agents_focus` for a socket instead of a window.
    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError>;
    async fn mark_unread(&self, agent_id: &str) -> Result<(), CommandError>;
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
}

fn bad_params(e: impl std::fmt::Display) -> WireError {
    WireError::protocol(ProtocolCode::BadParams, e.to_string())
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, WireError> {
    // `{}` and an absent params object are the same thing.
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(bad_params)
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
    _blob_id: String,
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
        "agents.send" => preview(field("text")),
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
            match (allow, always, note.is_empty()) {
                (true, true, _) => "always allow".into(),
                (true, false, _) => "allow".into(),
                (false, _, true) => "deny".into(),
                (false, _, false) => preview(&format!("deny with note: {note}")),
            }
        }
        "devices.unpairSelf" => "forgot this Mac".into(),
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
            if gone.is_some() {
                b.changed();
            }
            Ok(Value::Null)
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
            if !p.attachments.is_empty() {
                return Err(bad_params(
                    "This Mac can't take files from the phone yet. Update Ship Studio on the Mac.",
                ));
            }
            let client_id = p.client_id.trim();
            if client_id.is_empty() || client_id.len() > 128 {
                return Err(bad_params("clientId is required (at most 128 characters)."));
            }
            let text = crate::remote_access::tools::clean_agent_text(&p.text, "message")
                .map_err(|reason| WireError::protocol(ProtocolCode::Refused, reason))?;
            let key = format!("{}:{client_id}", caller.device_id);
            let (agent_id, mentions) = (p.agent_id, p.mentions);
            c.sends
                .once(key, now_ms(), || async move {
                    Ok(b.send(&agent_id, text, mentions).await?)
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
            })
            .await?;
            Ok(Value::Null)
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
        _ => Err(WireError::protocol(
            ProtocolCode::UnknownMethod,
            format!("This Mac doesn't know {method}."),
        )),
    }
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
