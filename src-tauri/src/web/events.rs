use super::AppState;
use crate::errors::CommandError;
use axum::{
    extract::{ws::Message, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

pub async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if headers.get(axum::http::header::ORIGIN).is_none()
        || !super::auth::origin_allowed(&headers, state.config.public_origin.as_deref())
    {
        return super::auth::error_response(
            StatusCode::FORBIDDEN,
            CommandError::Validation {
                field: "Origin".into(),
                reason: "WebSocket origin is not allowed".into(),
            },
        );
    }

    ws.on_upgrade(move |mut socket| async move {
        let window_label = format!("web-{}", uuid::Uuid::new_v4());
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.insert(window_label.clone());
        }
        let ready = serde_json::json!({
            "event": "ship-window-ready",
            "payload": { "windowLabel": window_label },
        });
        if socket
            .send(Message::Text(ready.to_string().into()))
            .await
            .is_err()
        {
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&window_label);
            }
            return;
        }
        let mut receiver = state.events.subscribe();
        loop {
            tokio::select! {
                incoming = socket.recv() => {
                    if incoming.is_none() || incoming.is_some_and(|message| {
                        matches!(message, Ok(Message::Close(_)) | Err(_))
                    }) {
                        break;
                    }
                }
                frame = next_visible(&mut receiver, &window_label) => {
                    let Some(frame) = frame else { break };
                    let body = serde_json::json!({
                        "event": frame.event,
                        "payload": frame.payload,
                    });
                    if socket
                        .send(Message::Text(body.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }

        crate::proxy::stop_preview_proxy(&window_label);
        crate::static_server::stop_static_server(&window_label);
        crate::commands::pty::kill_window_pty_sync(&window_label);
        crate::state::unregister_window_by_label(&window_label);
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&window_label);
        }
    })
    .into_response()
}

fn visible_to(frame: &crate::emit::Frame, window_label: &str) -> bool {
    frame
        .target
        .as_deref()
        .is_none_or(|target| target == window_label)
}

async fn next_visible(
    receiver: &mut tokio::sync::broadcast::Receiver<crate::emit::Frame>,
    window_label: &str,
) -> Option<crate::emit::Frame> {
    loop {
        match receiver.recv().await {
            Ok(frame) if visible_to(&frame, window_label) => return Some(frame),
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn targeted_and_broadcast_frames_are_filtered_by_window() {
        let (sender, _) = tokio::sync::broadcast::channel(4);
        let mut one = sender.subscribe();
        let mut two = sender.subscribe();
        let targeted = crate::emit::Frame {
            target: Some("one".into()),
            event: "pty-output".into(),
            payload: serde_json::Value::Null,
        };
        let broadcast = crate::emit::Frame {
            target: None,
            event: "setup-progress".into(),
            payload: serde_json::Value::Null,
        };

        sender.send(targeted).unwrap();
        sender.send(broadcast).unwrap();

        assert_eq!(
            next_visible(&mut one, "one").await.unwrap().event,
            "pty-output"
        );
        assert_eq!(
            next_visible(&mut two, "two").await.unwrap().event,
            "setup-progress"
        );
        assert_eq!(
            next_visible(&mut one, "one").await.unwrap().event,
            "setup-progress"
        );
    }
}
