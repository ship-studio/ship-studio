//! The companion's HTTP server: `POST /v1/pair`, the WebSocket at `/v1/ws`,
//! and files (`PUT /v1/blobs`, `GET /v1/blobs/:id`,
//! `GET /v1/agents/:id/attachments/*`), which stay off the socket so a 25 MB
//! upload never holds up a message.
//!
//! It binds loopback only. In P1 the one way in from the phone is
//! `tailscale serve`, which terminates TLS with the tailnet's own
//! certificate and proxies here; nothing listens on a public interface.
//!
//! The device token arrives in the socket's first frame (`hello.token`),
//! never in a URL, and is re-checked on every frame after it, so revoking a
//! phone on the Mac closes its sockets at once.

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::hub::{Drafts, HubItem, Resume};
use super::pairing::{self, Claim};
use super::router::{self, Caller};
use super::wire::{
    self, ClientFrame, Event, Negotiation, PairRefusal, PairRequest, PairResponse, RefusedReason,
    ResumeMode, RouteKind, ServerFrame, ServerInfo,
};
use super::{actor_for, now_ms, Auth, Companion};

pub(crate) type Body = BoxBody<Bytes, hyper::Error>;

/// The largest frame either way, and the largest pair request.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PAIR_BODY: usize = 16 * 1024;
/// The phone must say hello this quickly after the upgrade.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// The Mac's heartbeat (`HEARTBEAT_MS` in frames.ts).
pub const HEARTBEAT: Duration = Duration::from_secs(15);
const DRAFT_TICK: Duration = Duration::from_millis(50);

/// Serve until `shutdown` fires. Every connection gets a 10 s header timeout.
pub async fn serve(c: Arc<Companion>, listener: TcpListener, mut shutdown: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let c = c.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let c = c.clone();
                        async move { Ok::<_, hyper::Error>(handle(c, req).await) }
                    });
                    if let Err(e) = http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(10))
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await
                    {
                        tracing::debug!("[Companion] connection error: {}", e);
                    }
                });
            }
            _ = &mut shutdown => break,
        }
    }
}

pub(crate) fn body(data: impl Into<Bytes>) -> Body {
    Full::new(data.into())
        .map_err(|never| match never {})
        .boxed()
}

pub(crate) fn status_only(status: StatusCode) -> Response<Body> {
    let mut res = Response::new(body(Bytes::new()));
    *res.status_mut() = status;
    res
}

pub(crate) fn json_response(value: &impl serde::Serialize) -> Response<Body> {
    let mut res = Response::new(body(serde_json::to_vec(value).unwrap_or_default()));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

async fn handle(c: Arc<Companion>, req: Request<Incoming>) -> Response<Body> {
    let path = req.uri().path().to_string();
    match (req.method(), path.as_str()) {
        (&Method::POST, "/v1/pair") => pair(c, req).await,
        (&Method::GET, "/v1/ws") => upgrade(c, req),
        (&Method::PUT, "/v1/blobs") => super::files::upload(c, req).await,
        (&Method::GET | &Method::HEAD, p)
            if p.starts_with("/v1/blobs/") || p.starts_with("/v1/agents/") =>
        {
            super::files::download(c, req).await
        }
        // Anything else, including a wrong path: a bare 404 says nothing.
        _ => status_only(StatusCode::NOT_FOUND),
    }
}

// ============================================================================
// Pairing
// ============================================================================

async fn pair(c: Arc<Companion>, req: Request<Incoming>) -> Response<Body> {
    let Ok(collected) = Limited::new(req.into_body(), MAX_PAIR_BODY).collect().await else {
        return status_only(StatusCode::PAYLOAD_TOO_LARGE);
    };
    let Ok(request) = serde_json::from_slice::<PairRequest>(&collected.to_bytes()) else {
        return status_only(StatusCode::BAD_REQUEST);
    };
    // Versions first: an out-of-date app learns that, and the code survives
    // to be used once it has updated.
    match wire::negotiate(request.protocol, wire::SUPPORTED) {
        Negotiation::Ok(_) => {}
        Negotiation::UpdateApp => {
            return json_response(&PairResponse::refused(
                PairRefusal::UpdateApp,
                "Update this app to pair with this Mac.",
            ))
        }
        Negotiation::UpdateMac => {
            return json_response(&PairResponse::refused(
                PairRefusal::UpdateMac,
                format!("Update Ship Studio on {} to pair.", c.backend.server_name()),
            ))
        }
    }
    let device = request.device.clone();
    let actor = actor_for(&device.name);
    let rx = match c.pairing.claim(
        &request.code,
        device.clone(),
        request.public_key.clone(),
        now_ms(),
    ) {
        Claim::NoMatch => {
            tokio::time::sleep(pairing::WRONG_CODE_DELAY).await;
            return status_only(StatusCode::NOT_FOUND);
        }
        Claim::Expired => {
            return json_response(&PairResponse::refused(
                PairRefusal::Expired,
                "That code expired. Show a new one on the Mac.",
            ))
        }
        Claim::Used => {
            return json_response(&PairResponse::refused(
                PairRefusal::Used,
                "That code was already used. Show a new one on the Mac.",
            ))
        }
        Claim::Waiting(rx) => rx,
    };
    c.backend
        .audit(&actor, "pair_request", device_line(&device), true);
    c.backend.changed();

    let decision = tokio::time::timeout(pairing::DECISION_TIMEOUT, rx).await;
    let response = match decision {
        Ok(Ok(true)) => match c.registry.add(&device, request.public_key, now_ms() as i64) {
            Ok((record, token, replaced)) => {
                for id in replaced {
                    c.hub.signal(HubItem::Revoked { device_id: id });
                }
                c.backend
                    .audit(&actor, "paired", device_line(&device), true);
                PairResponse::Allowed {
                    ok: true,
                    device_id: record.id,
                    token,
                    server_id: c.registry.server_id(),
                    server_public_key: String::new(),
                }
            }
            Err(e) => {
                tracing::error!("[Companion] Could not save a paired device: {}", e);
                PairResponse::refused(
                    PairRefusal::Denied,
                    "The Mac couldn't save this phone. Try again.",
                )
            }
        },
        Ok(_) => {
            c.backend
                .audit(&actor, "pair_denied", device_line(&device), false);
            PairResponse::refused(PairRefusal::Denied, "The Mac said no.")
        }
        Err(_) => {
            c.pairing.abandon();
            c.backend
                .audit(&actor, "pair_timeout", device_line(&device), false);
            PairResponse::refused(
                PairRefusal::Timeout,
                "Nobody answered on the Mac. Try again from the Mac.",
            )
        }
    };
    c.pairing.abandon();
    c.backend.changed();
    json_response(&response)
}

fn device_line(d: &wire::PairDevice) -> String {
    let model = d.model.as_deref().unwrap_or("unknown model");
    format!("{model}, app {}", d.app_version)
}

// ============================================================================
// The WebSocket
// ============================================================================

fn upgrade(c: Arc<Companion>, mut req: Request<Incoming>) -> Response<Body> {
    let headers = req.headers();
    let is_ws = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).cloned() else {
        return status_only(StatusCode::BAD_REQUEST);
    };
    if !is_ws {
        return status_only(StatusCode::BAD_REQUEST);
    }
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let config = WebSocketConfig {
                    max_message_size: Some(MAX_FRAME_BYTES),
                    max_frame_size: Some(MAX_FRAME_BYTES),
                    ..Default::default()
                };
                let ws = WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded),
                    Role::Server,
                    Some(config),
                )
                .await;
                run_socket(c, ws).await;
            }
            Err(e) => tracing::debug!("[Companion] upgrade failed: {}", e),
        }
    });
    let mut res = status_only(StatusCode::SWITCHING_PROTOCOLS);
    let h = res.headers_mut();
    h.insert(
        header::UPGRADE,
        header::HeaderValue::from_static("websocket"),
    );
    h.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("Upgrade"),
    );
    if let Ok(v) = header::HeaderValue::from_str(&accept) {
        h.insert(header::SEC_WEBSOCKET_ACCEPT, v);
    }
    res
}

type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;

async fn send<S>(ws: &mut S, frame: &ServerFrame) -> bool
where
    S: SinkExt<Message> + Unpin,
{
    match serde_json::to_string(frame) {
        Ok(text) => ws.send(Message::Text(text)).await.is_ok(),
        Err(_) => false,
    }
}

async fn refuse<S>(ws: &mut S, reason: RefusedReason, message: impl Into<String>)
where
    S: SinkExt<Message> + Unpin,
{
    let _ = send(
        ws,
        &ServerFrame::Refused {
            reason,
            message: message.into(),
        },
    )
    .await;
    let _ = ws.send(Message::Close(None)).await;
}

/// Read the hello, or `None` if the phone didn't send one in time.
async fn read_hello<S>(ws: &mut S) -> Option<wire::HelloFrame>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let first = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match ws.next().await? {
                Ok(Message::Text(text)) => return Some(text),
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()??;
    match serde_json::from_str::<ClientFrame>(&first).ok()? {
        ClientFrame::Hello(hello) => Some(hello),
        _ => None,
    }
}

async fn run_socket(c: Arc<Companion>, ws: Socket) {
    serve_socket(c, ws).await
}

/// One phone connection, from hello to close. Generic over the stream so the
/// tests can drive it without TLS or a proxy in between.
pub async fn serve_socket<S>(c: Arc<Companion>, mut ws: S)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    let Some(hello) = read_hello(&mut ws).await else {
        let _ = ws.send(Message::Close(None)).await;
        return;
    };
    let record = match c.registry.authenticate(&hello.token) {
        Auth::Device(d) => d,
        Auth::Revoked => {
            c.backend.audit(
                "Phone",
                "refused",
                "a removed phone tried to connect".into(),
                false,
            );
            return refuse(
                &mut ws,
                RefusedReason::Revoked,
                "This Mac removed this phone.",
            )
            .await;
        }
        Auth::Unknown => {
            c.backend.audit(
                "Phone",
                "refused",
                "an unknown device tried to connect".into(),
                false,
            );
            return refuse(
                &mut ws,
                RefusedReason::Unauthorized,
                "This phone isn't paired with this Mac.",
            )
            .await;
        }
    };
    let actor = actor_for(&record.name);
    let protocol = match wire::negotiate(hello.protocol, wire::SUPPORTED) {
        Negotiation::Ok(v) => v,
        Negotiation::UpdateApp => {
            return refuse(
                &mut ws,
                RefusedReason::UpdateApp,
                "Update this app to connect to this Mac.",
            )
            .await
        }
        Negotiation::UpdateMac => {
            let name = c.backend.server_name();
            return refuse(
                &mut ws,
                RefusedReason::UpdateMac,
                format!("Update Ship Studio on {name}."),
            )
            .await;
        }
    };
    let Some(conn) = c.open_conn(&record.id, hello.foreground) else {
        return refuse(
            &mut ws,
            RefusedReason::TooManyConnections,
            "Too many connections from this phone. Close the app and try again.",
        )
        .await;
    };
    let caller = Caller {
        device_id: record.id.clone(),
        device_name: record.name.clone(),
        label: Companion::label(&record.id, conn),
        // The listener is loopback-only and published solely by `tailscale
        // serve` (TLS at the tailnet edge): the only way in. A LAN listener
        // would set its own kind here.
        route: RouteKind::Tailscale,
    };
    c.registry
        .touch(&record.id, now_ms() as i64, RouteKind::Tailscale, true);
    c.backend.audit(
        &actor,
        "connected",
        format!("app {}", crate::remote_access::preview(&hello.app.version)),
        true,
    );
    c.backend.changed();

    let ended = connected(&c, &mut ws, &caller, protocol, hello.resume.as_ref()).await;
    tracing::debug!(device = %record.id, ?ended, "[Companion] socket closed");

    c.close_conn(conn);
    let _ = c.backend.focus(&caller.label, None).await;
    c.registry
        .touch(&record.id, now_ms() as i64, RouteKind::Tailscale, true);
    c.backend.changed();
}

#[derive(Debug)]
enum Ended {
    Closed,
    Revoked,
    Unpaired,
    Lagged,
    Shutdown,
    SendFailed,
}

async fn connected<S>(
    c: &Arc<Companion>,
    ws: &mut S,
    caller: &Caller,
    protocol: u32,
    resume: Option<&wire::Cursor>,
) -> Ended
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    let (mut rx, plan) = c.hub.resume(resume);
    let welcome = ServerFrame::Welcome {
        protocol,
        server: ServerInfo {
            id: c.registry.server_id(),
            name: c.backend.server_name(),
            app_version: c.backend.app_version(),
        },
        device_id: caller.device_id.clone(),
        resume: match plan {
            Resume::Replay { .. } => ResumeMode::Replay,
            Resume::Snapshot { .. } => ResumeMode::Snapshot,
        },
        methods: router::METHODS.to_vec(),
    };
    if !send(ws, &welcome).await {
        return Ended::SendFailed;
    }
    let caught_up = match plan {
        Resume::Replay { events, cursor } => {
            for (seq, event) in events {
                if !send(
                    ws,
                    &ServerFrame::Evt {
                        seq: Some(seq),
                        event,
                    },
                )
                .await
                {
                    return Ended::SendFailed;
                }
            }
            cursor
        }
        Resume::Snapshot { cursor } => {
            let overview = c.backend.overview().await.unwrap_or(Value::Null);
            let status = c.backend.mac_status().await;
            c.remember_status(&status);
            let projects = match c.backend.projects().await {
                Ok(Value::Array(list)) => list,
                _ => Vec::new(),
            };
            let snapshot = Event::Snapshot {
                cursor: cursor.clone(),
                overview,
                status,
                projects,
            };
            if !send(
                ws,
                &ServerFrame::Evt {
                    seq: None,
                    event: snapshot,
                },
            )
            .await
            {
                return Ended::SendFailed;
            }
            cursor
        }
    };
    if !send(
        ws,
        &event_frame(None, Event::CaughtUp { cursor: caught_up }),
    )
    .await
    {
        return Ended::SendFailed;
    }

    let mut drafts = Drafts::default();
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<(u64, Result<Value, wire::WireError>)>();
    let mut heartbeat =
        tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut draft_tick = tokio::time::interval(DRAFT_TICK);
    draft_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ended::Closed,
                };
                // The token is re-checked on every frame.
                if c.registry.get(&caller.device_id).is_none() {
                    refuse(ws, RefusedReason::Revoked, "This Mac removed this phone.").await;
                    return Ended::Revoked;
                }
                c.registry.touch(&caller.device_id, now_ms() as i64, RouteKind::Tailscale, false);
                let frame = match serde_json::from_str::<ClientFrame>(&text) {
                    Ok(f) => f,
                    Err(e) => {
                        // A request we can't read still gets an answer, by id.
                        if let Some(id) = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("id")?.as_u64()) {
                            let err = wire::WireError::protocol(wire::ProtocolCode::BadParams, e.to_string());
                            if !send(ws, &ServerFrame::response(id, Err(err))).await {
                                return Ended::SendFailed;
                            }
                        }
                        continue;
                    }
                };
                match frame {
                    ClientFrame::Req { id, method, params } if method == "devices.unpairSelf" => {
                        // Answered before the socket closes, so the phone
                        // hears "done" rather than "removed".
                        let result = router::dispatch(c, caller, &method, params).await;
                        let _ = send(ws, &ServerFrame::response(id, result)).await;
                        let _ = ws.send(Message::Close(None)).await;
                        c.hub.signal(HubItem::Revoked { device_id: caller.device_id.clone() });
                        return Ended::Unpaired;
                    }
                    ClientFrame::Req { id, method, params } => {
                        let (c, caller, done) = (c.clone(), caller.clone(), done_tx.clone());
                        tokio::spawn(async move {
                            let result = router::dispatch(&c, &caller, &method, params).await;
                            let _ = done.send((id, result));
                        });
                    }
                    ClientFrame::Presence { foreground } => {
                        c.set_foreground(conn_of(&caller.label), foreground);
                    }
                    ClientFrame::Ping => {
                        if !send(ws, &ServerFrame::Pong).await {
                            return Ended::SendFailed;
                        }
                    }
                    ClientFrame::Hello(_) => {}
                }
            }
            item = rx.recv() => {
                match item {
                    Ok(item) => {
                        if let Some(ended) = forward(ws, &mut drafts, caller, item).await {
                            return ended;
                        }
                    }
                    // Fell behind the channel: close, and the phone resumes
                    // by cursor from the journal with nothing lost.
                    Err(broadcast::error::RecvError::Lagged(_)) => return Ended::Lagged,
                    Err(broadcast::error::RecvError::Closed) => return Ended::Shutdown,
                }
            }
            Some((id, result)) = done_rx.recv() => {
                // Events the request caused go out before its response.
                while let Ok(item) = rx.try_recv() {
                    if let Some(ended) = forward(ws, &mut drafts, caller, item).await {
                        return ended;
                    }
                }
                if !send(ws, &ServerFrame::response(id, result)).await {
                    return Ended::SendFailed;
                }
            }
            _ = draft_tick.tick() => {
                for event in drafts.flush(Instant::now()) {
                    if !send(ws, &event_frame(None, event)).await {
                        return Ended::SendFailed;
                    }
                }
            }
            _ = heartbeat.tick() => {
                // A WebSocket ping keeps proxies and NATs from idling the
                // link out; the unprompted `pong` frame is what the phone's
                // JS can see, so it knows the Mac is still there.
                if ws.send(Message::Ping(Vec::new())).await.is_err() || !send(ws, &ServerFrame::Pong).await {
                    return Ended::SendFailed;
                }
            }
        }
    }
}

fn conn_of(label: &str) -> u64 {
    label
        .rsplit(':')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn event_frame(seq: Option<u64>, event: Event) -> ServerFrame {
    ServerFrame::Evt { seq, event }
}

/// Send one hub item to this socket. `Some` ends the connection.
async fn forward<S>(
    ws: &mut S,
    drafts: &mut Drafts,
    caller: &Caller,
    item: HubItem,
) -> Option<Ended>
where
    S: SinkExt<Message> + Unpin,
{
    let frame = match item {
        HubItem::Journaled { seq, event } => {
            if let Event::Message { message } = &event {
                if let Some(id) = message.get("id").and_then(Value::as_str) {
                    drafts.finished(id);
                }
            }
            event_frame(Some(seq), event)
        }
        HubItem::Draft { agent_id, id, text } => {
            let event = drafts.offer(agent_id, id, text, Instant::now())?;
            event_frame(None, event)
        }
        HubItem::Revoked { device_id } if device_id == caller.device_id => {
            refuse(ws, RefusedReason::Revoked, "This Mac removed this phone.").await;
            return Some(Ended::Revoked);
        }
        HubItem::Revoked { .. } => return None,
        HubItem::Shutdown => {
            let _ = ws.send(Message::Close(None)).await;
            return Some(Ended::Shutdown);
        }
    };
    (!send(ws, &frame).await).then_some(Ended::SendFailed)
}

#[cfg(test)]
pub(crate) mod tests;
