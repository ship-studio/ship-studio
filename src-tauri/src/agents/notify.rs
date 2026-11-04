//! Telling the user when an agent wants them: macOS notifications and the
//! Dock badge.
//!
//! The backend decides, because it is the one that knows when a message is
//! recorded and when a turn ends. The frontend only reports which agent each
//! window is showing (`agents_focus`); whether that window has focus is asked
//! of the window itself at the moment it matters, so a webview throttled in
//! the background can't leave a stale answer behind.
//!
//! - A message is **on screen** when a focused window shows that agent. Only
//!   messages that aren't count as unread, and only those notify.
//! - Replies and errors during a turn are held and posted once when it ends,
//!   with the latest text: one notification per agent per turn.
//! - An approval posts immediately (the agent is blocked on it), with a sound.
//! - A burst across agents is capped ([`Limiter`]): past a few posts in a
//!   short window the rest stay silent; the badge still counts them.
//! - Clicking a notification focuses a window and emits [`EVENT_OPEN`]; the
//!   frontend switches to Agents mode and opens that agent.
//! - The Dock badge is unread plus pending approvals across the sidebar's agents.
//!
//! Full design: docs/agents.md, "Notifications".

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use super::store::{self, Agent, AgentMessage, MessageKind};

/// Payload: the agent id. The frontend opens that agent's chat.
pub const EVENT_OPEN: &str = "agents://open";

/// macOS system sound for approvals only; replies stay silent.
const APPROVAL_SOUND: &str = "Tink";

#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub agent_id: String,
    pub title: String,
    pub body: String,
    pub sound: bool,
}

/// Which agent each window (by label) has open in Agents mode.
static SHOWING: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING: LazyLock<Mutex<Coalescer>> = LazyLock::new(|| Mutex::new(Coalescer::default()));
static LIMITER: LazyLock<Mutex<Limiter>> = LazyLock::new(|| Mutex::new(Limiter::default()));

/// At most this many notifications per [`BURST_WINDOW`], across all agents.
const BURST_MAX: usize = 3;
const BURST_WINDOW: Duration = Duration::from_secs(20);

/// Caps bursts: five agents finishing at once is one glance, not five banners.
#[derive(Default)]
pub struct Limiter {
    sent: Vec<Instant>,
}

impl Limiter {
    pub fn allow(&mut self, now: Instant) -> bool {
        self.sent
            .retain(|t| now.saturating_duration_since(*t) < BURST_WINDOW);
        if self.sent.len() >= BURST_MAX {
            return false;
        }
        self.sent.push(now);
        true
    }
}

/// What a message would say as a notification, if it should be one at all.
pub fn alert_for(agent: &Agent, message: &AgentMessage) -> Option<Alert> {
    if !message.kind.wants_user() || agent.muted {
        return None;
    }
    Some(Alert {
        agent_id: agent.id.clone(),
        title: agent.name.clone(),
        body: super::runner::preview_for(message)?,
        sound: message.kind == MessageKind::Approval,
    })
}

/// One notification per agent per turn, carrying the latest text.
#[derive(Default)]
pub struct Coalescer {
    held: HashMap<String, Alert>,
}

impl Coalescer {
    /// Returns the alert to post now, if any. Replies and errors inside a turn
    /// are held for [`Self::turn_ended`]; an approval (the agent is blocked on
    /// it) or anything outside a turn goes out at once and replaces what was held.
    pub fn record(&mut self, alert: Alert, kind: MessageKind, in_turn: bool) -> Option<Alert> {
        if kind == MessageKind::Approval || !in_turn {
            self.held.remove(&alert.agent_id);
            return Some(alert);
        }
        self.held.insert(alert.agent_id.clone(), alert);
        None
    }

    pub fn turn_ended(&mut self, agent_id: &str) -> Option<Alert> {
        self.held.remove(agent_id)
    }

    /// The user looked: nothing held for this agent is news any more.
    pub fn seen(&mut self, agent_id: &str) {
        self.held.remove(agent_id);
    }
}

fn pending() -> std::sync::MutexGuard<'static, Coalescer> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// A window reports the agent it shows (`None`: not in Agents mode).
pub fn set_showing(window: &str, agent_id: Option<String>) {
    if let Some(id) = &agent_id {
        pending().seen(id);
    }
    let mut showing = SHOWING.lock().unwrap_or_else(|e| e.into_inner());
    match agent_id {
        Some(id) => showing.insert(window.to_string(), id),
        None => showing.remove(window),
    };
}

pub fn forget_window(window: &str) {
    SHOWING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(window);
}

fn showing_in(window: &str) -> Option<String> {
    SHOWING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(window)
        .cloned()
}

/// The chat the user is in: the agent a focused window shows, else the one
/// any window shows (the app may be in the background while they read it).
pub fn chat_in_view(app: &AppHandle) -> Option<String> {
    let showing: Vec<(String, String)> = SHOWING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(w, a)| (w.clone(), a.clone()))
        .collect();
    let focused = showing.iter().find(|(label, _)| {
        app.get_webview_window(label)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    });
    focused.or(showing.first()).map(|(_, id)| id.clone())
}

/// Whether a focused window shows this agent right now.
pub fn on_screen(app: &AppHandle, agent_id: &str) -> bool {
    let windows: Vec<String> = SHOWING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, id)| id.as_str() == agent_id)
        .map(|(label, _)| label.clone())
        .collect();
    windows.iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    })
}

/// Called by `runner::record` for a message that counted as unread.
pub fn message_recorded(app: &AppHandle, agent: &Agent, message: &AgentMessage, in_turn: bool) {
    let Some(alert) = alert_for(agent, message) else {
        return;
    };
    let now = pending().record(alert, message.kind, in_turn);
    if let Some(alert) = now {
        post(app, &alert);
    }
}

/// Called when a turn finishes: post what it held, unless the user is now
/// looking or has muted the agent since.
pub fn turn_ended(app: &AppHandle, agent_id: &str) {
    let Some(alert) = pending().turn_ended(agent_id) else {
        return;
    };
    let muted = store::get(agent_id).map(|a| a.muted).unwrap_or(true);
    if muted || on_screen(app, agent_id) {
        return;
    }
    post(app, &alert);
}

fn post(app: &AppHandle, alert: &Alert) {
    if !LIMITER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .allow(Instant::now())
    {
        tracing::debug!(
            "[Agents] notification for {} held back (burst)",
            alert.agent_id
        );
        return;
    }
    let mut builder = app
        .notification()
        .builder()
        .title(&alert.title)
        .body(&alert.body)
        .extra("agentId", &alert.agent_id);
    if alert.sound {
        builder = builder.sound(APPROVAL_SOUND);
    }
    if let Err(e) = builder.show() {
        tracing::warn!("[Agents] notification failed: {e}");
    }
}

/// Clicking a notification: bring a window forward and open that agent.
/// Registered once at startup; without a handler the plugin doesn't report clicks.
pub fn init(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        let Some(agent_id) = performed
            .notification()
            .and_then(|n| n.extra().get("agentId"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            return;
        };
        open_agent(&handle, &agent_id);
    });
}

/// Bring a window forward and open that agent's chat in it: a notification
/// click, a menu-bar row, quick entry's "Open chat".
pub fn open_agent(app: &AppHandle, agent_id: &str) {
    let windows = app.webview_windows();
    let Some(window) = windows.get("main").or_else(|| {
        windows
            .values()
            .find(|w| w.label() != super::quick_entry::LABEL)
    }) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = window.unminimize();
    let _ = window.show();
    crate::commands::window::forget_hidden_window(window.label());
    let _ = window.set_focus();
    let _ = app.emit_to(window.label(), EVENT_OPEN, agent_id);
}

/// A window came forward: the agent it shows has now been read.
pub fn window_focused(app: &AppHandle, window: &str) {
    let Some(agent_id) = showing_in(window) else {
        return;
    };
    pending().seen(&agent_id);
    if store::get(&agent_id).is_ok_and(|a| a.unread > 0)
        && store::update(&agent_id, |a| a.unread = 0).is_ok()
    {
        let _ = app.emit(super::runner::EVENT_REGISTRY, ());
        refresh_badge(app);
    }
}

/// The Dock badge: unread plus pending approvals across the agents the
/// sidebar lists (hidden ones don't count there either). macOS badges the app, not a window, so any
/// window will do.
pub fn refresh_badge(app: &AppHandle) {
    let total = store::list()
        .map(|agents| badge_count(&agents))
        .unwrap_or(0);
    if let Some(window) = app.webview_windows().values().next() {
        let _ = window.set_badge_count((total > 0).then_some(total));
    }
}

pub fn badge_count(agents: &[Agent]) -> i64 {
    agents
        .iter()
        .filter(|a| !a.hidden)
        .map(|a| i64::from(a.unread) + i64::from(a.pending_approvals))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::runner::new_message;

    fn agent(muted: bool) -> Agent {
        Agent {
            id: "fin".into(),
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
            muted,
            check_ins: Vec::new(),
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
            capabilities: None,
            secrets: Vec::new(),
            extra: Default::default(),
        }
    }

    fn approval_message() -> AgentMessage {
        let mut message = new_message("fin", MessageKind::Approval, "");
        message.approval = Some(store::Approval {
            request_id: "r1".into(),
            title: "Run a command".into(),
            detail: "rm -rf build".into(),
            status: store::ApprovalStatus::Pending,
            tool: None,
            input: None,
            always: None,
            always_allowed: false,
            note: None,
            prompt: None,
            choice: None,
            secret: None,
        });
        message
    }

    #[test]
    fn a_reply_says_its_first_line_under_the_agents_name() {
        let message = new_message(
            "fin",
            MessageKind::Agent,
            "\n  Two invoices are overdue.\nMore…",
        );
        let alert = alert_for(&agent(false), &message).unwrap();
        assert_eq!(alert.title, "Finance");
        assert_eq!(alert.body, "Two invoices are overdue.");
        assert!(!alert.sound);
    }

    #[test]
    fn an_approval_asks_for_the_ok_with_a_sound() {
        let alert = alert_for(&agent(false), &approval_message()).unwrap();
        assert_eq!(alert.body, "Needs your OK: Run a command");
        assert!(alert.sound);
    }

    #[test]
    fn a_fired_check_in_notifies() {
        let line = new_message("fin", MessageKind::CheckIn, "Brief me.");
        let alert = alert_for(&agent(false), &line).unwrap();
        assert_eq!(alert.body, "Scheduled check-in");
        assert!(!alert.sound);
    }

    #[test]
    fn muted_agents_and_chatter_dont_notify() {
        let reply = new_message("fin", MessageKind::Agent, "Done.");
        assert!(alert_for(&agent(true), &reply).is_none());
        for kind in [
            MessageKind::User,
            MessageKind::SentToAgent,
            MessageKind::FromAgent,
        ] {
            assert!(alert_for(&agent(false), &new_message("fin", kind, "hi")).is_none());
        }
    }

    #[test]
    fn a_turn_posts_once_with_its_latest_text() {
        let mut c = Coalescer::default();
        let reply = |body: &str| Alert {
            agent_id: "fin".into(),
            title: "Finance".into(),
            body: body.into(),
            sound: false,
        };
        assert!(c
            .record(reply("Looking now."), MessageKind::Agent, true)
            .is_none());
        assert!(c
            .record(reply("Found two."), MessageKind::Agent, true)
            .is_none());
        assert_eq!(c.turn_ended("fin").unwrap().body, "Found two.");
        assert!(c.turn_ended("fin").is_none());
    }

    #[test]
    fn approvals_and_out_of_turn_messages_go_out_at_once() {
        let mut c = Coalescer::default();
        let alert = |body: &str| Alert {
            agent_id: "fin".into(),
            title: "Finance".into(),
            body: body.into(),
            sound: false,
        };
        c.record(alert("Checking."), MessageKind::Agent, true);
        let now = c.record(
            alert("Needs your OK: Run a command"),
            MessageKind::Approval,
            true,
        );
        assert_eq!(now.unwrap().body, "Needs your OK: Run a command");
        // The approval superseded the held reply.
        assert!(c.turn_ended("fin").is_none());
        assert!(c
            .record(alert("Failed."), MessageKind::Error, false)
            .is_some());
    }

    #[test]
    fn looking_at_the_agent_drops_what_was_held() {
        let mut c = Coalescer::default();
        c.record(
            Alert {
                agent_id: "fin".into(),
                title: "Finance".into(),
                body: "Done.".into(),
                sound: false,
            },
            MessageKind::Agent,
            true,
        );
        c.seen("fin");
        assert!(c.turn_ended("fin").is_none());
    }

    #[test]
    fn the_badge_counts_unread_and_approvals_in_the_sidebar_only() {
        let mut a = agent(false);
        a.unread = 2;
        a.pending_approvals = 1;
        let mut b = agent(true);
        b.unread = 1;
        let mut hidden = agent(false);
        hidden.unread = 5;
        hidden.hidden = true;
        assert_eq!(badge_count(&[a, b, hidden]), 4);
    }

    #[test]
    fn a_burst_is_capped_then_recovers() {
        let mut l = Limiter::default();
        let t0 = Instant::now();
        assert!((0..BURST_MAX).all(|_| l.allow(t0)));
        assert!(!l.allow(t0 + Duration::from_secs(1)));
        assert!(l.allow(t0 + BURST_WINDOW));
    }
}
