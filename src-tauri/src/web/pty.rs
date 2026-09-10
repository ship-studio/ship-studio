use axum::{
    extract::{ws::Message, State, WebSocketUpgrade},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

use super::AppState;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum ClientFrame {
    Spawn {
        id: String,
        file: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        cols: u16,
        rows: u16,
    },
    Write {
        id: String,
        data: Vec<u8>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: String,
    },
}

pub async fn pty(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| run(socket, state))
        .into_response()
}

async fn run(socket: axum::extract::ws::WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.events.subscribe();
    let mut sessions = HashSet::new();

    loop {
        tokio::select! {
            message = receiver.next() => {
                let Some(Ok(Message::Text(text))) = message else { break };
                match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(frame) => {
                        if let Some(reply) = handle(frame, &mut sessions).await {
                            if sender.send(Message::Text(reply.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let reply = serde_json::json!({ "type": "error", "message": error.to_string() });
                        if sender.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                    }
                }
            }
            event = events.recv() => match event {
                Ok(frame) => {
                    if let Some(reply) = event_reply(&frame, &sessions) {
                        if reply["type"] == "exit" {
                            if let Some(id) = reply["id"].as_str() { sessions.remove(id); }
                        }
                        if sender.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    for id in sessions {
        let _ = crate::commands::pty_session::pty_session_kill(id);
    }
}

fn frame_id(frame: &ClientFrame) -> &str {
    match frame {
        ClientFrame::Spawn { id, .. }
        | ClientFrame::Write { id, .. }
        | ClientFrame::Resize { id, .. }
        | ClientFrame::Kill { id } => id,
    }
}

async fn handle(frame: ClientFrame, sessions: &mut HashSet<String>) -> Option<serde_json::Value> {
    let id = frame_id(&frame).to_string();
    let result = match frame {
        ClientFrame::Spawn {
            id,
            file,
            args,
            cwd,
            env,
            cols,
            rows,
        } => crate::commands::pty_session::pty_session_open(
            id.clone(),
            file,
            args,
            cwd,
            env,
            cols,
            rows,
            None,
        )
        .await
        .map(|opened| {
            sessions.insert(id.clone());
            serde_json::json!({ "type": "spawned", "id": id, "pid": opened.pid })
        }),
        ClientFrame::Write { id, data } => {
            crate::commands::pty_session::pty_session_write(id, data)
                .map(|_| serde_json::Value::Null)
        }
        ClientFrame::Resize { id, cols, rows } => {
            crate::commands::pty_session::pty_session_resize(id, cols, rows)
                .map(|_| serde_json::Value::Null)
        }
        ClientFrame::Kill { id } => {
            crate::commands::pty_session::pty_session_kill(id).map(|_| serde_json::Value::Null)
        }
    };

    match result {
        Ok(serde_json::Value::Null) => None,
        Ok(reply) => Some(reply),
        Err(error) => {
            Some(serde_json::json!({ "type": "error", "id": id, "message": error.to_string() }))
        }
    }
}

fn event_reply(
    frame: &crate::emit::Frame,
    sessions: &HashSet<String>,
) -> Option<serde_json::Value> {
    let id = frame.payload.get("sessionId")?.as_str()?;
    if !sessions.contains(id) {
        return None;
    }
    match frame.event.as_str() {
        "pty-session-data" => Some(serde_json::json!({
            "type": "data",
            "id": id,
            "data": frame.payload.get("data")?,
        })),
        "pty-session-exit" => Some(serde_json::json!({
            "type": "exit",
            "id": id,
            "exitCode": frame.payload.get("exitCode")?,
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_codec_round_trips() {
        let json = r#"{"op":"write","id":"one","data":[104,105]}"#;
        let frame: ClientFrame = serde_json::from_str(json).unwrap();
        assert_eq!(serde_json::to_string(&frame).unwrap(), json);
    }

    #[test]
    fn sessions_do_not_cross_talk() {
        let frame = crate::emit::Frame {
            target: None,
            event: "pty-session-data".into(),
            payload: serde_json::json!({ "sessionId": "one", "data": [104, 105] }),
        };
        assert!(event_reply(&frame, &HashSet::from(["one".into()])).is_some());
        assert!(event_reply(&frame, &HashSet::from(["two".into()])).is_none());
    }

    #[tokio::test]
    async fn spawn_write_kill_lifecycle() {
        let id = format!("web-pty-test-{}", std::process::id());
        let mut sessions = HashSet::new();
        let spawned = handle(
            ClientFrame::Spawn {
                id: id.clone(),
                file: "sh".into(),
                args: vec!["-c".into(), "cat".into()],
                cwd: None,
                env: BTreeMap::new(),
                cols: 80,
                rows: 24,
            },
            &mut sessions,
        )
        .await
        .unwrap();
        assert_eq!(spawned["type"], "spawned");
        assert!(handle(
            ClientFrame::Write {
                id: id.clone(),
                data: b"hello\n".to_vec()
            },
            &mut sessions
        )
        .await
        .is_none());
        assert!(handle(ClientFrame::Kill { id: id.clone() }, &mut sessions)
            .await
            .is_none());
        assert!(crate::commands::pty_session::pty_session_attach(id).is_err());
    }
}
