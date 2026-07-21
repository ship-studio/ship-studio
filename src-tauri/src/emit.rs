//! # Event emission
//!
//! One call for both transports. The desktop app pushes events through Tauri's
//! IPC; the self-hosted server pushes them down a WebSocket. Call sites say
//! *what* happened and *who* should hear it, and this module routes it.
//!
//! ## Targeting matters
//!
//! Events come in two flavors and the distinction is load-bearing:
//!
//! - [`all`] — every listener. Setup progress, rewind progress.
//! - [`to`] — one window only. Terminal output, agent-bridge requests.
//!
//! Collapsing the two would send one browser tab's terminal output to every
//! other tab. [`Frame::target`] carries the distinction to the far side, which
//! is responsible for honoring it.

use serde_json::Value;
use std::sync::OnceLock;

/// A single event on its way to the frontend.
#[derive(Debug, Clone)]
pub struct Frame {
    /// Window label this is for, or `None` to broadcast.
    pub target: Option<String>,
    /// Event name. Unchanged from the Tauri contract — the frontend listens
    /// for these exact strings.
    pub event: String,
    /// Event payload, exactly as the frontend expects it.
    pub payload: Value,
}

/// Where emitted events go. Set once at startup by whichever binary is running.
enum Sink {
    /// Desktop: hand off to Tauri's own event system.
    Tauri(tauri::AppHandle),
    /// Self-hosted: fan out to subscribed WebSocket clients.
    #[cfg(feature = "web")]
    Broadcast(tokio::sync::broadcast::Sender<Frame>),
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// Install the Tauri sink. Called once from the app's `setup` hook.
pub fn init_tauri(app: tauri::AppHandle) {
    if SINK.set(Sink::Tauri(app)).is_err() {
        tracing::warn!("Event sink already initialized; ignoring");
    }
}

/// Install the broadcast sink and return a receiver factory.
///
/// The returned sender is what WebSocket handlers subscribe to. Capacity is
/// generous because terminal output arrives in bursts and a slow browser tab
/// should drop old frames rather than stall the emitting task — `broadcast`
/// gives us exactly that, lagging the reader instead of blocking the writer.
#[cfg(feature = "web")]
pub fn init_broadcast() -> tokio::sync::broadcast::Sender<Frame> {
    let (tx, _) = tokio::sync::broadcast::channel(1024);
    if SINK.set(Sink::Broadcast(tx.clone())).is_err() {
        tracing::warn!("Event sink already initialized; ignoring");
    }
    tx
}

/// Desktop application handle for commands that still need to create or
/// focus a native window. Web callers get `None` and return browser URLs.
pub fn tauri_app() -> Option<tauri::AppHandle> {
    match SINK.get() {
        Some(Sink::Tauri(app)) => Some(app.clone()),
        #[cfg(feature = "web")]
        Some(Sink::Broadcast(_)) | None => None,
        #[cfg(not(feature = "web"))]
        None => None,
    }
}

/// An event that reached nobody.
///
/// Most callers ignore this — events are advisory and a closed window is
/// normal. It is returned rather than swallowed because a few callers do care:
/// the agent bridge aborts a pending tool call when its request can't reach the
/// preview window, instead of waiting out a timeout for a reply that is never
/// coming (see `agent_bridge::forward_tool_call`).
#[derive(Debug, thiserror::Error)]
#[error("no listener received `{event}`: {reason}")]
pub struct NotDelivered {
    pub event: String,
    pub reason: String,
}

/// Emit to every listener.
pub fn all(event: &str, payload: impl Into<Value>) -> Result<(), NotDelivered> {
    dispatch(Frame {
        target: None,
        event: event.to_string(),
        payload: payload.into(),
    })
}

/// Emit to one window only.
pub fn to(target: &str, event: &str, payload: impl Into<Value>) -> Result<(), NotDelivered> {
    dispatch(Frame {
        target: Some(target.to_string()),
        event: event.to_string(),
        payload: payload.into(),
    })
}

fn dispatch(frame: Frame) -> Result<(), NotDelivered> {
    let event = frame.event.clone();
    let fail = |reason: String| NotDelivered {
        event: event.clone(),
        reason,
    };

    let Some(sink) = SINK.get() else {
        // No sink yet: startup ordering, or a unit test exercising a command
        // directly. Events are advisory, so dropping one is fine — but say so,
        // because a *persistently* missing sink means the frontend is deaf.
        tracing::debug!("Dropping `{}` event: no sink installed", frame.event);
        return Err(fail("no event sink installed".into()));
    };

    match sink {
        Sink::Tauri(app) => {
            use tauri::Emitter;
            match &frame.target {
                Some(label) => app.emit_to(label, &frame.event, frame.payload.clone()),
                None => app.emit(&frame.event, frame.payload.clone()),
            }
            .map_err(|e| fail(e.to_string()))
        }
        #[cfg(feature = "web")]
        Sink::Broadcast(tx) => {
            // `send` fails only when nobody is subscribed — no browser tab is
            // open, which is the web equivalent of a closed window.
            tx.send(frame)
                .map(|_| ())
                .map_err(|_| fail("no connected clients".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_carry_their_target() {
        let broadcast = Frame {
            target: None,
            event: "setup-progress".into(),
            payload: serde_json::json!({ "itemId": "node" }),
        };
        assert!(broadcast.target.is_none());

        let targeted = Frame {
            target: Some("main".into()),
            event: "pty-output".into(),
            payload: serde_json::json!({ "id": 1, "data": "hi" }),
        };
        assert_eq!(targeted.target.as_deref(), Some("main"));
    }

    #[test]
    fn emitting_without_a_sink_reports_undelivered_but_does_not_panic() {
        // Unit tests run commands directly, with no app and no server. Several
        // commands emit on paths those tests exercise, so this must stay a
        // quiet error rather than a crash.
        assert!(all("setup-progress", serde_json::json!({ "itemId": "node" })).is_err());
        assert!(to("main", "pty-output", serde_json::json!({ "id": 1 })).is_err());
        assert!(all("rewind-progress", ()).is_err());
    }
}
