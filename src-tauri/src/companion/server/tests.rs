//! The server end to end on loopback: pair over HTTP with a click to Allow,
//! then chat with the stub agent over a real WebSocket, resume by cursor,
//! and get refused the ways a phone can be.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::companion::testkit::{Stub, AGENT};
use crate::companion::wire::{BuildKind, DevicePlatform, PairDevice};
use crate::companion::{now_ms, Companion};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start(c: Arc<Companion>) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(super::serve(c, listener, rx));
    // Held for the life of the test process: dropping it would stop the server.
    std::mem::forget(tx);
    port
}

async fn connect(port: u16) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/v1/ws"))
        .await
        .unwrap();
    ws
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string())).await.unwrap();
}

/// The next JSON frame (skipping WebSocket control frames).
async fn next(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5 s");
        match msg {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(&t).unwrap(),
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return json!({ "t": "closed" }),
            _ => continue,
        }
    }
}

fn hello(token: &str, resume: Option<Value>) -> Value {
    let mut h = json!({
        "t": "hello",
        "protocol": { "min": 1, "max": 1 },
        "token": token,
        "app": { "version": "1.0.0", "runtimeVersion": "1" },
        "foreground": true
    });
    if let Some(r) = resume {
        h["resume"] = r;
    }
    h
}

/// Hello, then everything up to `sync.caughtUp`. Returns the welcome, the
/// catch-up events, and the cursor caught up to.
async fn open(port: u16, token: &str, resume: Option<Value>) -> (Ws, Value, Vec<Value>, Value) {
    let mut ws = connect(port).await;
    send(&mut ws, hello(token, resume)).await;
    let welcome = next(&mut ws).await;
    assert_eq!(welcome["t"], "welcome", "{welcome}");
    let mut events = Vec::new();
    loop {
        let f = next(&mut ws).await;
        assert_eq!(f["t"], "evt", "{f}");
        if f["event"]["type"] == "sync.caughtUp" {
            return (ws, welcome, events, f["event"]["cursor"].clone());
        }
        events.push(f);
    }
}

/// Send a request and collect the events that arrive before its response.
async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> (Vec<Value>, Value) {
    send(
        ws,
        json!({ "t": "req", "id": id, "method": method, "params": params }),
    )
    .await;
    let mut events = Vec::new();
    loop {
        let f = next(ws).await;
        match f["t"].as_str() {
            Some("res") if f["id"] == id => return (events, f),
            Some("evt") => events.push(f),
            Some("closed") => panic!("closed while waiting for {method}"),
            _ => {}
        }
    }
}

fn types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| e["event"]["type"].as_str().unwrap_or("").to_string())
        .collect()
}

fn phone() -> PairDevice {
    PairDevice {
        name: "Test Phone".into(),
        platform: DevicePlatform::Ios,
        model: Some("iPhone 16".into()),
        app_version: "1.0.0".into(),
        build: BuildKind::Official,
    }
}

fn pair_body(code: &str) -> Value {
    json!({
        "code": code,
        "device": { "name": "Test Phone", "platform": "ios", "model": "iPhone 16", "appVersion": "1.0.0", "build": "official" },
        "protocol": { "min": 1, "max": 1 },
        "publicKey": "pk"
    })
}

/// Answer the desk prompt as soon as it shows.
fn desk(c: &Arc<Companion>, allow: bool) {
    let c = c.clone();
    tokio::spawn(async move {
        for _ in 0..200 {
            if c.pairing.view(now_ms()).request.is_some() {
                c.pairing.decide(allow);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
}

async fn post_pair(port: u16, body: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/pair"))
        .json(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn pair_chat_resume_and_audit_end_to_end() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;

    // ---- Pair: the code, then Allow at the desk.
    let (code, _) = c.pairing.start(now_ms());
    let wrong = post_pair(port, &pair_body("AAAAAAAAAAAAAAAAAAAAAAAAAA")).await;
    assert_eq!(wrong.status(), 404, "a wrong code gets a bare 404");
    desk(&c, true);
    let paired: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(paired["ok"], true, "{paired}");
    assert_eq!(paired["serverId"], c.registry.server_id());
    let token = paired["token"].as_str().unwrap().to_string();
    let device_id = paired["deviceId"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let used: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(used["ok"], false, "single use: {used}");

    // ---- First connect: no cursor, so a snapshot.
    let (mut ws, welcome, catch_up, cursor0) = open(port, &token, None).await;
    assert_eq!(welcome["resume"], "snapshot");
    assert_eq!(welcome["deviceId"], device_id.as_str());
    assert_eq!(welcome["protocol"], 1);
    assert!(welcome["methods"]
        .as_array()
        .unwrap()
        .contains(&json!("agents.send")));
    assert_eq!(types(&catch_up), ["sync.snapshot"]);
    let snapshot = &catch_up[0]["event"];
    assert_eq!(snapshot["overview"]["agents"][0]["id"], AGENT);
    assert!(snapshot["overview"]["agents"][0].get("usage").is_none());
    assert_eq!(snapshot["status"]["name"], "Julian’s MacBook Pro");
    assert_eq!(cursor0["epoch"], "epoch-test");
    assert!(c.is_connected(&device_id));

    // ---- Send: the turn's events arrive before the response.
    let (events, res) = call(
        &mut ws,
        1,
        "agents.send",
        json!({ "agentId": AGENT, "text": "hi", "clientId": "c1" }),
    )
    .await;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["result"]["id"], "u1");
    assert_eq!(
        types(&events),
        [
            "agents.message",
            "agents.status",
            "agents.draft",
            "agents.message",
            "agents.status"
        ]
    );
    let seqs: Vec<u64> = events.iter().filter_map(|e| e["seq"].as_u64()).collect();
    assert_eq!(seqs.len(), 4, "drafts carry no seq");
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    assert_eq!(events[2]["event"]["from"], 0);
    assert_eq!(events[2]["event"]["text"], "Hel");

    // ---- The same clientId again: the original message, not a second send.
    let (events, res) = call(
        &mut ws,
        2,
        "agents.send",
        json!({ "agentId": AGENT, "text": "hi", "clientId": "c1" }),
    )
    .await;
    assert_eq!(res["result"]["id"], "u1");
    assert!(events.is_empty());
    assert_eq!(stub.sends.load(std::sync::atomic::Ordering::SeqCst), 1);

    // ---- Remote Access's text rules.
    let (_, res) = call(
        &mut ws,
        3,
        "agents.send",
        json!({ "agentId": AGENT, "text": "! rm -rf ~", "clientId": "c2" }),
    )
    .await;
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"]["type"], "Protocol");
    assert_eq!(res["error"]["code"], "refused");
    let (_, res) = call(
        &mut ws,
        4,
        "agents.send",
        json!({ "agentId": AGENT, "text": "/permissions", "clientId": "c3" }),
    )
    .await;
    assert_eq!(res["error"]["code"], "refused");

    // ---- Paging, with the read cursor.
    let (_, res) = call(
        &mut ws,
        5,
        "agents.messages",
        json!({ "agentId": AGENT, "limit": 5 }),
    )
    .await;
    let page = &res["result"];
    assert_eq!(page["messages"].as_array().unwrap().len(), 5);
    assert_eq!(page["more"], true);
    assert_eq!(page["asOf"]["seq"], 4);
    let oldest = page["messages"][0]["id"].clone();
    let (_, res) = call(
        &mut ws,
        6,
        "agents.messages",
        json!({ "agentId": AGENT, "limit": 2, "before": oldest }),
    )
    .await;
    assert_eq!(res["result"]["messages"].as_array().unwrap().len(), 2);

    // ---- Approval, focus, an unknown method, a malformed request.
    let (_, res) = call(
        &mut ws,
        7,
        "agents.answerApproval",
        json!({ "agentId": AGENT, "requestId": "q1", "allow": false, "note": "use pnpm" }),
    )
    .await;
    assert_eq!(
        res,
        json!({ "t": "res", "id": 7, "ok": true, "result": null })
    );
    assert_eq!(
        stub.answers.lock().unwrap()[0].note.as_deref(),
        Some("use pnpm")
    );
    let (_, res) = call(&mut ws, 8, "agents.focus", json!({ "agentId": AGENT })).await;
    assert_eq!(res["ok"], true);
    let label = stub.focus.lock().unwrap()[0].0.clone();
    assert!(label.starts_with(&format!("companion:{device_id}:")));
    assert!(c.label_on_screen(&label), "foreground and connected");
    let (_, res) = call(&mut ws, 9, "agents.delete", json!({ "agentId": AGENT })).await;
    assert_eq!(res["error"]["code"], "unknown_method");
    let (_, res) = call(&mut ws, 10, "agents.stop", json!({})).await;
    assert_eq!(res["error"]["code"], "bad_params");

    // ---- Presence: backgrounded, the chat no longer counts as on screen.
    send(&mut ws, json!({ "t": "presence", "foreground": false })).await;
    send(&mut ws, json!({ "t": "ping" })).await;
    assert_eq!(next(&mut ws).await, json!({ "t": "pong" }));
    assert!(!c.label_on_screen(&label));

    // ---- Disconnect clears this socket's focus.
    ws.close(None).await.unwrap();
    for _ in 0..100 {
        if stub
            .focus
            .lock()
            .unwrap()
            .last()
            .is_some_and(|f| f.1.is_none())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(stub.focus.lock().unwrap().last().unwrap(), &(label, None));

    // ---- Resume from before the turn: replay, latest status only, no drafts.
    let (_ws, welcome, replay, cursor) = open(port, &token, Some(cursor0.clone())).await;
    assert_eq!(welcome["resume"], "replay");
    assert_eq!(
        types(&replay),
        ["agents.message", "agents.message", "agents.status"]
    );
    assert_eq!(replay[2]["event"]["status"]["state"], "idle");
    assert_eq!(cursor["seq"], 4);

    // ---- A cursor from another run gets a snapshot.
    let (_ws2, welcome, _, _) = open(port, &token, Some(json!({ "epoch": "old", "seq": 2 }))).await;
    assert_eq!(welcome["resume"], "snapshot");

    // ---- Audit: actions and pairing named for the phone; reads left out.
    let audit = stub.audited();
    let tools: Vec<&str> = audit
        .iter()
        .filter(|a| a.0 == "Phone · Test Phone")
        .map(|a| a.1.as_str())
        .collect();
    for expected in [
        "pair_request",
        "paired",
        "connected",
        "agents.send",
        "agents.answerApproval",
        "agents.focus",
    ] {
        assert!(
            tools.contains(&expected),
            "{expected} missing from {tools:?}"
        );
    }
    assert!(!tools.contains(&"agents.messages"), "reads aren't audited");
    let sent: Vec<_> = audit.iter().filter(|a| a.1 == "agents.send").collect();
    assert_eq!(sent.len(), 4);
    assert!(sent[0].3 && sent[0].2 == "hi");
    let refused = sent.iter().find(|a| !a.3).unwrap();
    assert!(refused.2.contains("refused"), "{refused:?}");
    assert!(audit
        .iter()
        .any(|a| a.1 == "agents.answerApproval" && a.2 == "deny with note: use pnpm"));
    assert!(audit.iter().all(|a| !a.2.contains(&token)), "never a token");
}

#[tokio::test]
async fn a_revoked_phone_is_closed_at_once_and_told_so() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c.registry.add(&phone(), String::new(), 1).unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    c.revoke(&record.id).unwrap();
    let f = next(&mut ws).await;
    assert_eq!(f["t"], "refused");
    assert_eq!(f["reason"], "revoked");
    // And it stays out.
    let mut ws = connect(port).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "revoked");
    assert!(stub
        .audited()
        .iter()
        .any(|a| a.1 == "revoked" && a.0 == "Phone · Test Phone"));
}

#[tokio::test]
async fn unknown_tokens_and_old_versions_are_refused() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c.registry.add(&phone(), String::new(), 1).unwrap();

    let mut ws = connect(port).await;
    send(&mut ws, hello(&"0".repeat(64), None)).await;
    assert_eq!(next(&mut ws).await["reason"], "unauthorized");

    let mut ws = connect(port).await;
    let mut h = hello(&token, None);
    h["protocol"] = json!({ "min": 2, "max": 3 });
    send(&mut ws, h).await;
    let f = next(&mut ws).await;
    assert_eq!(f["reason"], "update_mac");
    assert_eq!(f["message"], "Update Ship Studio on Julian’s MacBook Pro.");

    let mut ws = connect(port).await;
    let mut h = hello(&token, None);
    h["protocol"] = json!({ "min": 0, "max": 0 });
    send(&mut ws, h).await;
    assert_eq!(next(&mut ws).await["reason"], "update_app");

    // Not a hello first: closed without a word.
    let mut ws = connect(port).await;
    send(&mut ws, json!({ "t": "ping" })).await;
    assert_eq!(next(&mut ws).await["t"], "closed");
}

#[tokio::test]
async fn a_denied_phone_gets_no_token() {
    let (c, stub) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    desk(&c, false);
    let res: Value = post_pair(port, &pair_body(&code))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        res,
        json!({ "ok": false, "reason": "denied", "message": "The Mac said no." })
    );
    assert!(c.registry.devices().is_empty());
    assert!(stub.audited().iter().any(|a| a.1 == "pair_denied" && !a.3));
}

#[tokio::test]
async fn an_old_app_is_told_to_update_before_its_code_is_spent() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (code, _) = c.pairing.start(now_ms());
    let mut body = pair_body(&code);
    body["protocol"] = json!({ "min": 0, "max": 0 });
    let res: Value = post_pair(port, &body).await.json().await.unwrap();
    assert_eq!(res["reason"], "update_app");
    assert!(c.pairing.view(now_ms()).active, "the code is still good");
}

#[tokio::test]
async fn unpairing_from_the_phone_answers_then_closes() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (record, token, _) = c.registry.add(&phone(), String::new(), 1).unwrap();
    let (mut ws, ..) = open(port, &token, None).await;
    send(
        &mut ws,
        json!({ "t": "req", "id": 1, "method": "devices.unpairSelf", "params": {} }),
    )
    .await;
    assert_eq!(
        next(&mut ws).await,
        json!({ "t": "res", "id": 1, "ok": true, "result": null })
    );
    assert_eq!(next(&mut ws).await["t"], "closed");
    assert!(c.registry.get(&record.id).is_none());
}

#[tokio::test]
async fn sockets_per_device_are_capped() {
    let (c, _) = Stub::companion();
    let port = start(c.clone()).await;
    let (_, token, _) = c.registry.add(&phone(), String::new(), 1).unwrap();
    let mut held = Vec::new();
    for _ in 0..crate::companion::MAX_SOCKETS_PER_DEVICE {
        held.push(open(port, &token, None).await.0);
    }
    let mut ws = connect(port).await;
    send(&mut ws, hello(&token, None)).await;
    assert_eq!(next(&mut ws).await["reason"], "too_many_connections");
}
