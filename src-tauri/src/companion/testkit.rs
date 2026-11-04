//! A stub agent behind the companion, for the server and fixture tests.
//!
//! It answers with the desktop's own Rust types (round-tripped from the
//! representative JSON below, so a field Rust doesn't know fails the test
//! instead of vanishing), and plays a scripted turn on `agents.send`:
//! the user's message, working, two drafts, the reply, idle.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use super::router::{ApprovalAnswer, Backend, ScheduleOp, SendExtras};
use super::wire::{ClaudeInfo, Event, Known, MacStatus, PowerInfo, Route, RouteKind};
use super::{Companion, Registry};
use crate::agents::store::{Agent, AgentMessage};
use crate::errors::CommandError;

pub const AGENT: &str = "a1";

/// Deserialize into the desktop's type and back, asserting nothing was lost
/// or added: the JSON here is exactly what Rust emits.
pub fn round_trip<T>(value: Value, strip: &[&str]) -> T
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let typed: T = serde_json::from_value(value.clone()).expect("fixture deserializes");
    let mut back = serde_json::to_value(&typed).unwrap();
    for key in strip {
        back.as_object_mut().unwrap().remove(*key);
    }
    assert_eq!(
        back, value,
        "the fixture must survive a round trip unchanged"
    );
    typed
}

/// Every optional field of an agent set, as stored (no live status).
pub fn stored_agent() -> Agent {
    round_trip(
        json!({
            "id": AGENT,
            "name": "Finance",
            "role": "Keeps the books",
            "shape": 2,
            "color": "green",
            "isMain": false,
            "pinned": true,
            "hidden": false,
            "sessionId": "8c1d7a52-0000-4000-8000-000000000001",
            "createdAt": 1_762_200_000_000_i64,
            "lastActivityAt": 1_762_290_000_000_i64,
            "preview": "Invoices are filed.",
            "unread": 2,
            "pendingApprovals": 1,
            "model": "opus",
            "muted": false,
            "checkIns": [
                { "id": "c1", "note": "Check the invoices", "repeat": { "kind": "days", "days": [1, 3], "hour": 9, "minute": 30 }, "nextAt": 1_762_300_000_000_i64, "createdAt": 1_762_200_000_000_i64, "paused": false },
                { "id": "c2", "note": "Look at the queue", "repeat": { "kind": "every", "minutes": 60 }, "nextAt": 1_762_300_000_000_i64, "createdAt": 1_762_200_000_000_i64, "paused": true },
                { "id": "c3", "note": "Remind me about the VAT return", "nextAt": 1_762_400_000_000_i64, "createdAt": 1_762_200_000_000_i64, "paused": false }
            ],
            "permissions": [
                { "id": "r1", "kind": "command_prefix", "value": "npm test", "label": "npm test", "createdAt": 1_762_200_000_000_i64 },
                { "id": "r2", "kind": "command", "value": "git status", "label": "git status", "createdAt": 1_762_200_000_000_i64 },
                { "id": "r3", "kind": "domain", "value": "example.com", "label": "example.com", "createdAt": 1_762_200_000_000_i64 },
                { "id": "r4", "kind": "tool", "value": "mcp__gmail__send", "label": "Send an email · Gmail", "createdAt": 1_762_200_000_000_i64 }
            ],
            "failure": { "kind": "usage_limit", "resetsAt": 1_762_310_000_000_i64 },
            "project": "/Users/julian/ShipStudio/site",
            "capabilities": { "seenAt": 1_762_290_000_000_i64, "lines": [{ "what": "Tools", "detail": "Bash, Read, Edit" }] }
        }),
        &["usage"],
    )
}

/// One message of every kind, covering every optional field and enum variant.
pub fn messages() -> Vec<AgentMessage> {
    let at = |n: i64| 1_762_290_000_000_i64 + n * 1_000;
    let peer = json!({ "id": "a2", "name": "Ops" });
    let list = vec![
        json!({ "id": "m01", "agentId": AGENT, "ts": at(1), "kind": "user", "text": "@Ops can you file these?",
                "attachments": [{ "name": "invoice.pdf", "path": "attachments/m01/invoice.pdf", "mime": "application/pdf", "size": 52_000 }],
                "mentions": [peer] }),
        json!({ "id": "m02", "agentId": AGENT, "ts": at(2), "kind": "agent", "text": "Filing them now", "stopped": true }),
        json!({ "id": "m03", "agentId": AGENT, "ts": at(3), "kind": "sent_to_agent", "text": "File these", "peer": peer }),
        json!({ "id": "m04", "agentId": AGENT, "ts": at(4), "kind": "from_agent", "text": "Done", "peer": peer }),
        json!({ "id": "m05", "agentId": AGENT, "ts": at(5), "kind": "approval", "text": "",
                "approval": { "requestId": "q1", "title": "Run a command", "detail": "npm test", "status": "pending", "tool": "Bash",
                              "input": { "command": "npm test" }, "always": { "kind": "command_prefix", "value": "npm test", "label": "npm test" } } }),
        json!({ "id": "m06", "agentId": AGENT, "ts": at(6), "kind": "approval", "text": "",
                "approval": { "requestId": "q2", "title": "Fetch a page", "detail": "https://example.com", "status": "allowed", "tool": "WebFetch",
                              "input": { "url": "https://example.com" }, "always": { "kind": "domain", "value": "example.com", "label": "example.com" }, "alwaysAllowed": true } }),
        json!({ "id": "m07", "agentId": AGENT, "ts": at(7), "kind": "approval", "text": "",
                "approval": { "requestId": "q3", "title": "Delete Ops", "detail": "Ops and its chat", "status": "denied", "note": "Keep Ops" } }),
        json!({ "id": "m08", "agentId": AGENT, "ts": at(8), "kind": "approval", "text": "",
                "approval": { "requestId": "q4", "title": "Send an email", "detail": "to accounts@", "status": "expired", "tool": "mcp__gmail__send",
                              "always": { "kind": "tool", "value": "mcp__gmail__send", "label": "Send an email · Gmail" } } }),
        json!({ "id": "m09", "agentId": AGENT, "ts": at(9), "kind": "error", "text": "Claude Code is signed out.", "failure": { "kind": "signed_out" } }),
        json!({ "id": "m10", "agentId": AGENT, "ts": at(10), "kind": "error", "text": "Something broke.", "failure": { "kind": "other" } }),
        json!({ "id": "m11", "agentId": AGENT, "ts": at(11), "kind": "check_in", "text": "Check the invoices",
                "checkIn": { "dueAt": at(0), "late": true, "repeats": true, "manual": true } }),
        json!({ "id": "m12", "agentId": AGENT, "ts": at(12), "kind": "note", "text": "Allowed automatically: git status · Always allowed",
                "approval": { "requestId": "q5", "title": "Run a command", "detail": "git status", "status": "allowed",
                              "always": { "kind": "command", "value": "git status", "label": "git status" }, "alwaysAllowed": true } }),
        json!({ "id": "m13", "agentId": AGENT, "ts": at(13), "kind": "changes", "text": "",
                "changes": { "project": "/Users/julian/ShipStudio/site", "branch": "main", "from": "abc123", "to": "def456",
                             "files": [
                                 { "path": "src/a.ts", "status": "added", "added": 10 },
                                 { "path": "src/b.ts", "status": "modified", "added": 2, "removed": 1 },
                                 { "path": "src/c.ts", "status": "deleted", "removed": 7 }
                             ],
                             "fileCount": 3, "added": 12, "removed": 8 } }),
        json!({ "id": "m14", "agentId": AGENT, "ts": at(14), "kind": "session", "text": "",
                "session": { "project": "/Users/julian/ShipStudio/site", "event": "started", "sessionId": "pty-1", "tab": 1, "cli": "claude" } }),
        json!({ "id": "m15", "agentId": AGENT, "ts": at(15), "kind": "session", "text": "Fix the header", "session": { "project": "/Users/julian/ShipStudio/site", "event": "sent" } }),
        json!({ "id": "m16", "agentId": AGENT, "ts": at(16), "kind": "session", "text": "Fixed", "session": { "project": "/Users/julian/ShipStudio/site", "event": "reply" } }),
        json!({ "id": "m17", "agentId": AGENT, "ts": at(17), "kind": "session", "text": "", "session": { "project": "/Users/julian/ShipStudio/site", "event": "screenshot" },
                "attachments": [{ "name": "Desktop.jpg", "path": "attachments/m17/Desktop.jpg", "mime": "image/jpeg", "size": 184_000 }] }),
        json!({ "id": "m18", "agentId": AGENT, "ts": at(18), "kind": "user", "text": "Here's the logo", "clientId": "c_8f2a1b",
                "attachments": [{ "name": "logo.png", "path": "attachments/m18/logo.png", "mime": "image/png", "size": 9_000 }] }),
    ];
    list.into_iter().map(|m| round_trip(m, &[])).collect()
}

/// A Mac status with every optional field set.
pub fn mac_status() -> MacStatus {
    MacStatus {
        name: "Julian’s MacBook Pro".into(),
        app_version: "1.7.0".into(),
        power: PowerInfo {
            keep_awake: true,
            lid_closed_mode: Known::No,
            on_battery: Known::Yes,
            battery_percent: Some(64),
        },
        claude: ClaudeInfo {
            installed: true,
            signed_in: Known::Unknown,
            version: Some("2.1.0".into()),
        },
        routes: vec![
            Route {
                kind: RouteKind::Tailscale,
                url: "https://julians-macbook-pro.tail1234.ts.net:47443".into(),
                pin: None,
            },
            Route {
                kind: RouteKind::Lan,
                url: "https://192.168.1.20:47444".into(),
                pin: Some("q2v0bQyR3m8b0f4Jc1lT8wq9s1nC3kq8H1cX0p9yQ2A".into()),
            },
        ],
    }
}

/// The overview the desktop would send, live status and all, as the phone gets it.
pub fn overview() -> Value {
    let status = crate::agents::runner::Status {
        state: "waiting",
        activity: Some("Running npm test".into()),
        since: Some(1_762_290_000_000),
    };
    let view = crate::commands::agents::AgentView {
        agent: stored_agent(),
        status,
        home: "/Users/julian/Library/Application Support/ShipStudio/agents/a1".into(),
    };
    super::wire::phone_overview(
        serde_json::to_value(crate::commands::agents::AgentsOverview {
            agents: vec![view],
            engine_ready: true,
        })
        .unwrap(),
    )
}

/// What `projects.list` answers with: one project, one tab waiting on the
/// user and one working.
pub fn projects() -> Vec<crate::remote_access::tools::ProjectView> {
    use crate::remote_access::tools::{option_views, ProjectView, QuestionView, SessionView};
    vec![ProjectView {
        path: "/Users/julian/ShipStudio/site".into(),
        name: "site".into(),
        branch: Some("main".into()),
        dirty_files: 3,
        sessions: vec![
            SessionView {
                session_id: "pty-2".into(),
                tab: 2,
                cli: Some("claude".into()),
                state: "needs_decision",
                activity: None,
                question: Some(QuestionView {
                    question: "Do you want to proceed?".into(),
                    action: Some("Bash(npm install)".into()),
                    options: option_views(&[
                        "1. Yes".into(),
                        "2. Yes, and don't ask again for npm install".into(),
                        "3. No".into(),
                    ]),
                }),
                last_output_at: 1_762_290_000_000,
            },
            SessionView {
                session_id: "pty-1".into(),
                tab: 1,
                cli: Some("codex".into()),
                state: "working",
                activity: Some("Editing Header.tsx".into()),
                question: None,
                last_output_at: 1_762_290_000_000,
            },
        ],
    }]
}

pub fn session_screen() -> crate::remote_access::tools::ScreenView {
    crate::remote_access::tools::ScreenView {
        session: projects()[0].sessions[1].clone(),
        screen: "> Fix the header\n\n⏺ Editing Header.tsx".into(),
        reply: Some("Fixed the header's spacing.".into()),
    }
}

pub struct Stub {
    companion: OnceLock<Weak<Companion>>,
    /// The stub agent's home, where sends save attachments.
    pub home: tempfile::TempDir,
    pub messages: Mutex<Vec<AgentMessage>>,
    pub sends: AtomicUsize,
    pub audit: Mutex<Vec<(String, String, String, bool)>>,
    pub focus: Mutex<Vec<(String, Option<String>)>>,
    pub answers: Mutex<Vec<ApprovalAnswer>>,
}

impl Stub {
    pub fn companion() -> (Arc<Companion>, Arc<Stub>) {
        Self::companion_with(Registry::in_memory(), "epoch-test")
    }

    pub fn companion_with(registry: Registry, epoch: &str) -> (Arc<Companion>, Arc<Stub>) {
        let stub = Arc::new(Stub {
            companion: OnceLock::new(),
            home: tempfile::tempdir().expect("a temp home"),
            messages: Mutex::new(messages()),
            sends: AtomicUsize::new(0),
            audit: Mutex::new(Vec::new()),
            focus: Mutex::new(Vec::new()),
            answers: Mutex::new(Vec::new()),
        });
        let c = Arc::new(Companion::with_epoch(registry, stub.clone(), epoch.into()));
        let _ = stub.companion.set(Arc::downgrade(&c));
        (c, stub)
    }

    fn hub(&self) -> Arc<Companion> {
        self.companion
            .get()
            .and_then(Weak::upgrade)
            .expect("companion alive")
    }

    pub fn audited(&self) -> Vec<(String, String, String, bool)> {
        self.audit.lock().unwrap().clone()
    }
}

fn status(state: &'static str) -> Value {
    serde_json::to_value(crate::agents::runner::Status {
        state,
        activity: (state == "working").then(|| "Thinking".to_string()),
        since: None,
    })
    .unwrap()
}

#[async_trait]
impl Backend for Stub {
    async fn overview(&self) -> Result<Value, CommandError> {
        Ok(overview())
    }

    async fn messages(
        &self,
        agent_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError> {
        if agent_id != AGENT {
            return Err(CommandError::expected("No such agent."));
        }
        let all = self.messages.lock().unwrap().clone();
        let end = before
            .and_then(|id| all.iter().position(|m| m.id == id))
            .unwrap_or(all.len());
        let start = end.saturating_sub(limit);
        let page = all[start..end]
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        Ok((page, start > 0))
    }

    async fn send(
        &self,
        agent_id: &str,
        text: String,
        extras: SendExtras,
    ) -> Result<Value, CommandError> {
        use crate::agents::store::MessageKind;
        let n = self.sends.fetch_add(1, Ordering::SeqCst) + 1;
        let c = self.hub();
        let mut mine = crate::agents::runner::new_message(agent_id, MessageKind::User, text);
        mine.id = format!("u{n}");
        mine.client_id = extras.client_id;
        // The desk's own save: limits, names and all.
        mine.attachments = crate::agents::attachments::save(
            self.home.path(),
            &mine.id,
            extras
                .attachments
                .into_iter()
                .map(|a| crate::agents::attachments::OutgoingAttachment {
                    name: a.name,
                    path: Some(a.path.display().to_string()),
                    data: None,
                })
                .collect(),
        )?;
        let mine_json = serde_json::to_value(&mine).unwrap();
        c.hub.publish(Event::Message {
            message: mine_json.clone(),
        });
        c.hub.publish(Event::Status {
            agent_id: agent_id.into(),
            status: status("working"),
        });
        c.hub.draft(agent_id.into(), format!("r{n}"), "Hel".into());
        let mut reply = crate::agents::runner::new_message(agent_id, MessageKind::Agent, "Hello");
        reply.id = format!("r{n}");
        c.hub.publish(Event::Message {
            message: serde_json::to_value(&reply).unwrap(),
        });
        c.hub.publish(Event::Status {
            agent_id: agent_id.into(),
            status: status("idle"),
        });
        self.messages.lock().unwrap().extend([mine, reply]);
        Ok(mine_json)
    }

    async fn stop(&self, _agent_id: &str) -> Result<bool, CommandError> {
        Ok(false)
    }

    async fn interrupt(&self, _agent_id: &str) -> Result<bool, CommandError> {
        Ok(false)
    }

    async fn answer_approval(&self, answer: ApprovalAnswer) -> Result<(), CommandError> {
        self.answers.lock().unwrap().push(answer);
        Ok(())
    }

    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError> {
        self.focus.lock().unwrap().push((label.into(), agent_id));
        Ok(())
    }

    async fn mark_unread(&self, _agent_id: &str) -> Result<(), CommandError> {
        Ok(())
    }

    async fn files(&self, agent_id: &str) -> Result<Value, CommandError> {
        use crate::agents::files::{Sender, SharedFile};
        use crate::agents::store::MessageKind;
        let mut files: Vec<SharedFile> = self
            .messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.agent_id == agent_id)
            .filter(|m| matches!(m.kind, MessageKind::User | MessageKind::Agent))
            .flat_map(|m| {
                let from = if m.kind == MessageKind::User {
                    Sender::User
                } else {
                    Sender::Agent
                };
                m.attachments.iter().map(move |a| SharedFile {
                    message_id: m.id.clone(),
                    ts: m.ts,
                    from,
                    attachment: a.clone(),
                })
            })
            .collect();
        files.sort_by(|a, b| b.ts.cmp(&a.ts));
        Ok(serde_json::to_value(files).unwrap())
    }

    async fn shareable_path(
        &self,
        _agent_id: &str,
        path: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        let home = self.home.path().to_path_buf();
        crate::agents::files::shareable(path, &home, std::slice::from_ref(&home))
            .map_err(CommandError::expected)
    }

    async fn search(&self, query: String) -> Result<Value, CommandError> {
        let q = query.to_lowercase();
        let hits: Vec<crate::agents::search::SearchHit> = self
            .messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| !q.trim().is_empty() && m.text.to_lowercase().contains(q.trim()))
            .rev()
            .map(|m| crate::agents::search::SearchHit {
                agent_id: m.agent_id.clone(),
                agent_name: "Finance".into(),
                agent_color: "green".into(),
                message_id: m.id.clone(),
                ts: m.ts,
                kind: m.kind,
                peer_name: m.peer.as_ref().map(|p| p.name.clone()),
                snippet: m.text.clone(),
            })
            .collect();
        Ok(serde_json::to_value(hits).unwrap())
    }

    async fn schedule(&self, op: ScheduleOp) -> Result<Value, CommandError> {
        use crate::agents::schedule;
        // A fixed clock, so what the fixtures record doesn't move.
        let now = 1_762_290_000_000_i64;
        let parse = |when: &str| {
            schedule::parse(when, &chrono::Utc, now)
                .map_err(|e| crate::agents::err_invalid("when", e))
        };
        let stored = stored_agent().check_ins;
        Ok(match op {
            ScheduleOp::Preview { when } => {
                let (repeat, next_at) = parse(&when)?;
                serde_json::to_value(crate::commands::agents::SchedulePreview { next_at, repeat })
                    .unwrap()
            }
            ScheduleOp::Create { when, note, .. } => {
                let (repeat, next_at) = parse(&when)?;
                serde_json::to_value(schedule::CheckIn {
                    id: "c9".into(),
                    note,
                    repeat,
                    next_at,
                    created_at: now,
                    paused: false,
                })
                .unwrap()
            }
            ScheduleOp::Update { id, when, note, .. } => {
                let (repeat, next_at) = parse(&when)?;
                let mut c = stored
                    .into_iter()
                    .find(|c| c.id == id)
                    .ok_or_else(|| CommandError::expected("That check-in is gone."))?;
                (c.note, c.repeat, c.next_at) = (note, repeat, next_at);
                serde_json::to_value(c).unwrap()
            }
            ScheduleOp::Pause { .. } | ScheduleOp::Cancel { .. } | ScheduleOp::RunNow { .. } => {
                Value::Null
            }
        })
    }

    async fn projects(&self) -> Result<Value, CommandError> {
        Ok(serde_json::to_value(projects()).unwrap())
    }

    async fn session_screen(&self, session_id: &str) -> Result<Value, CommandError> {
        let screen = session_screen();
        if screen.session.session_id != session_id {
            return Err(CommandError::expected(
                "That session isn't open in Ship Studio any more.",
            ));
        }
        Ok(serde_json::to_value(screen).unwrap())
    }

    fn attachment_file(
        &self,
        _agent_id: &str,
        rel: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        crate::agents::attachments::resolve(self.home.path(), rel)
    }

    async fn mac_status(&self) -> MacStatus {
        mac_status()
    }

    fn server_name(&self) -> String {
        "Julian’s MacBook Pro".into()
    }

    fn app_version(&self) -> String {
        "1.7.0".into()
    }

    fn audit(&self, actor: &str, tool: &str, detail: String, ok: bool) {
        self.audit
            .lock()
            .unwrap()
            .push((actor.into(), tool.into(), detail, ok));
    }

    fn changed(&self) {}
}
