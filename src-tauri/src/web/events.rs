use axum::{
    extract::{ws::Message, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use super::AppState;
use crate::errors::CommandError;

#[derive(Deserialize)]
pub struct EventQuery {
    window_label: String,
}

pub async fn events(
    State(state): State<AppState>,
    Query(query): Query<EventQuery>,
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
        let mut receiver = state.events.subscribe();
        while let Some(frame) = next_visible(&mut receiver, &query.window_label).await {
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
