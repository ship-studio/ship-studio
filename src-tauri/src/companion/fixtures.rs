//! Rust ↔ TypeScript: what the Mac actually serializes, checked by `tsc`.
//!
//! This test serializes a representative value of every wire type (every
//! optional field set, every enum variant) and writes it to
//! `packages/companion-protocol/src/fixtures.gen.ts` as
//! `export const x = {…} satisfies T`, so `tsc -p packages/companion-protocol`
//! checks real serde output against the protocol, excess properties included.
//! Method results go through the real router.
//!
//! The test fails when the file on disk differs from what it would write.
//! `UPDATE_FIXTURES=1 cargo test --lib companion::fixtures` rewrites it.

use serde::Serialize;
use serde_json::{json, Value};

use super::router::{self, Caller};
use super::testkit::{self, Stub, AGENT};
use super::wire::{
    BuildKind, Cursor, DevicePlatform, Event, PairRefusal, PairResponse, PairingLink, ProtocolCode,
    RefusedReason, ResumeMode, Route, RouteKind, ServerFrame, ServerInfo, WireError,
};
use super::DeviceRecord;
use crate::errors::CommandError;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/companion-protocol/src/fixtures.gen.ts"
);

fn device(full: bool) -> DeviceRecord {
    DeviceRecord {
        id: "dev_0123456789abcdef".into(),
        name: "Julian’s iPhone".into(),
        platform: if full {
            DevicePlatform::Ios
        } else {
            DevicePlatform::Android
        },
        model: full.then(|| "iPhone 16 Pro".into()),
        app_version: "1.0.0".into(),
        build: if full {
            BuildKind::SelfBuilt
        } else {
            BuildKind::Official
        },
        paired_at: 1_762_200_000_000,
        last_seen_at: full.then_some(1_762_290_000_000),
        last_route: full.then_some(RouteKind::Tailscale),
        expires_at: full.then_some(1_762_800_000_000),
        token_hash: "never sent".into(),
        public_key: "never sent".into(),
        push: None,
    }
}

fn cursor(seq: u64) -> Cursor {
    Cursor {
        epoch: "epoch-test".into(),
        seq,
    }
}

fn status_value(state: &'static str) -> Value {
    serde_json::to_value(crate::agents::runner::Status {
        state,
        activity: (state != "idle").then(|| "Reading src/App.tsx".to_string()),
        since: (state != "idle").then_some(1_762_290_000_000),
    })
    .unwrap()
}

fn frames() -> Vec<ServerFrame> {
    let errors: Vec<WireError> = vec![
        CommandError::Timeout {
            cmd: "claude".into(),
            secs: 30,
        }
        .into(),
        CommandError::Process {
            cmd: "git".into(),
            exit_code: 1,
            stderr: "fatal".into(),
        }
        .into(),
        CommandError::Validation {
            field: "text".into(),
            reason: "Type a message first.".into(),
        }
        .into(),
        CommandError::NotAuthenticated {
            service: "GitHub".into(),
        }
        .into(),
        CommandError::Io {
            message: "disk full".into(),
        }
        .into(),
        CommandError::MergeConflict {
            pr_number: 12,
            stderr: "conflict".into(),
        }
        .into(),
        CommandError::Other {
            message: "Something broke.".into(),
        }
        .into(),
        CommandError::expected("That request was already answered.").into(),
    ];
    let protocol = [
        ProtocolCode::UnknownMethod,
        ProtocolCode::BadParams,
        ProtocolCode::RateLimited,
        ProtocolCode::TooLarge,
        ProtocolCode::Refused,
        ProtocolCode::NotConnected,
    ]
    .into_iter()
    .map(|code| WireError::protocol(code, "What happened, for the user."));
    let events = vec![
        (
            Some(1),
            Event::Message {
                message: serde_json::to_value(&testkit::messages()[4]).unwrap(),
            },
        ),
        (
            Some(2),
            Event::Status {
                agent_id: AGENT.into(),
                status: status_value("working"),
            },
        ),
        (
            Some(3),
            Event::Status {
                agent_id: AGENT.into(),
                status: status_value("idle"),
            },
        ),
        (
            Some(4),
            Event::Registry {
                overview: testkit::overview(),
            },
        ),
        (
            Some(5),
            Event::System {
                status: testkit::mac_status(),
            },
        ),
        (
            Some(6),
            Event::ProjectChanged {
                project: serde_json::to_value(&testkit::projects()[0]).unwrap(),
            },
        ),
        (
            Some(7),
            Event::ProjectRemoved {
                path: "/Users/julian/ShipStudio/old-site".into(),
            },
        ),
        (
            None,
            Event::Draft {
                agent_id: AGENT.into(),
                id: "r1".into(),
                from: 5,
                text: " world".into(),
            },
        ),
        (
            None,
            Event::Snapshot {
                cursor: cursor(5),
                overview: testkit::overview(),
                status: testkit::mac_status(),
                projects: testkit::projects()
                    .iter()
                    .map(|p| serde_json::to_value(p).unwrap())
                    .collect(),
            },
        ),
        (None, Event::CaughtUp { cursor: cursor(5) }),
    ];

    let mut out = vec![ServerFrame::Welcome {
        protocol: 1,
        server: ServerInfo {
            id: "srv_0123456789abcdef".into(),
            name: "Julian’s MacBook Pro".into(),
            app_version: "1.7.0".into(),
        },
        device_id: "dev_0123456789abcdef".into(),
        resume: ResumeMode::Replay,
        methods: router::METHODS.to_vec(),
    }];
    for (reason, message) in [
        (
            RefusedReason::Unauthorized,
            "This phone isn't paired with this Mac.",
        ),
        (RefusedReason::Revoked, "This Mac removed this phone."),
        (
            RefusedReason::UpdateApp,
            "Update this app to connect to this Mac.",
        ),
        (
            RefusedReason::UpdateMac,
            "Update Ship Studio on Julian’s MacBook Pro.",
        ),
        (
            RefusedReason::TooManyConnections,
            "Too many connections from this phone.",
        ),
    ] {
        out.push(ServerFrame::Refused {
            reason,
            message: message.into(),
        });
    }
    out.push(ServerFrame::response(1, Ok(Value::Null)));
    out.extend(
        errors
            .into_iter()
            .chain(protocol)
            .enumerate()
            .map(|(i, e)| ServerFrame::response(i as u64 + 2, Err(e))),
    );
    out.extend(
        events
            .into_iter()
            .map(|(seq, event)| ServerFrame::Evt { seq, event }),
    );
    out.push(ServerFrame::Pong);
    out
}

fn pair_responses() -> Vec<PairResponse> {
    let mut out = vec![PairResponse::Allowed {
        ok: true,
        device_id: "dev_0123456789abcdef".into(),
        token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        server_id: "srv_0123456789abcdef".into(),
        server_public_key: String::new(),
    }];
    for reason in [
        PairRefusal::Expired,
        PairRefusal::Used,
        PairRefusal::Denied,
        PairRefusal::Timeout,
        PairRefusal::UpdateApp,
        PairRefusal::UpdateMac,
    ] {
        out.push(PairResponse::refused(
            reason,
            "What happened, for the user.",
        ));
    }
    out
}

fn pairing_link() -> PairingLink {
    PairingLink {
        v: 1,
        code: "K7Q2MZX4A9PL3WRT8NBV6YHC5D".into(),
        server_id: "srv_0123456789abcdef".into(),
        name: "Julian’s MacBook Pro".into(),
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

fn entry(name: &str, ts_type: &str, value: impl Serialize) -> String {
    let json = serde_json::to_string_pretty(&value).unwrap();
    format!("export const {name} = {json} satisfies {ts_type};\n")
}

/// A blob id is random; the fixture keeps its shape, not its value.
fn normalize_blob(mut v: Value) -> Value {
    v["blobId"] = json!("blob_0123456789abcdef0123456789abcdef");
    v
}

async fn generate() -> String {
    let (c, stub) = Stub::companion();
    let caller = Caller {
        device_id: "dev_0123456789abcdef".into(),
        device_name: "Julian’s iPhone".into(),
        label: "companion:dev_0123456789abcdef:1".into(),
    };
    let call = |method: &'static str, params: Value| {
        let (c, caller) = (c.clone(), caller.clone());
        async move {
            router::dispatch(&c, &caller, method, params)
                .await
                .unwrap_or_else(|e| panic!("{method}: {}", e.summary()))
        }
    };
    let mut out = String::from(
        "// Generated by `cargo test --lib companion::fixtures` from what the Mac\n\
         // actually serializes. Do not edit: rewrite it with UPDATE_FIXTURES=1.\n\
         // `tsc -p packages/companion-protocol` checks every value against the protocol.\n\
         \n\
         import type { Device, PairingLink, PairResponse, Result, ServerFrame } from './index';\n\n",
    );
    out += &entry(
        "systemStatus",
        "Result<'system.status'>",
        call("system.status", json!({})).await,
    );
    out += &entry(
        "devicesSelf",
        "Result<'devices.self'>",
        device(true).view(true),
    );
    out += &entry("deviceMinimal", "Device", device(false).view(false));
    // This build has no relay (fixtures never reach the network).
    c.push.set_relay(None);
    c.registry.write(|s| s.devices.push(device(false))).unwrap();
    out += &entry(
        "devicesSetPush",
        "Result<'devices.setPush'>",
        call(
            "devices.setPush",
            json!({ "token": "a1".repeat(32), "environment": "production" }),
        )
        .await,
    );
    {
        use super::push::PushStatus::*;
        out += &entry(
            "pushStatuses",
            "Result<'devices.setPush'>['status'][]",
            [On, Pending, Off, Unavailable, SelfBuild],
        );
    }
    out += &entry(
        "agentsOverview",
        "Result<'agents.overview'>",
        call("agents.overview", json!({})).await,
    );
    out += &entry(
        "agentsMessages",
        "Result<'agents.messages'>",
        call("agents.messages", json!({ "agentId": AGENT, "limit": 100 })).await,
    );
    out += &entry(
        "agentsSend",
        "Result<'agents.send'>",
        &testkit::messages()[0],
    );
    out += &entry(
        "agentsStop",
        "Result<'agents.stop'>",
        call("agents.stop", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsAnswerApproval",
        "Result<'agents.answerApproval'>",
        call(
            "agents.answerApproval",
            json!({ "agentId": AGENT, "requestId": "q1", "allow": true, "always": true }),
        )
        .await,
    );
    out += &entry(
        "agentsFiles",
        "Result<'agents.files'>",
        call("agents.files", json!({ "agentId": AGENT })).await,
    );
    std::fs::write(stub.home.path().join("report.md"), "# Q3").unwrap();
    out += &entry(
        "agentsFetchPath",
        "Result<'agents.fetchPath'>",
        normalize_blob(
            call(
                "agents.fetchPath",
                json!({ "agentId": AGENT, "path": "report.md" }),
            )
            .await,
        ),
    );
    out += &entry(
        "agentsSearch",
        "Result<'agents.search'>",
        call("agents.search", json!({ "query": "file" })).await,
    );
    for (name, when) in [
        ("schedulePreviewOnce", "in 2 hours"),
        ("schedulePreviewDays", "every weekday at 9am"),
        ("schedulePreviewEvery", "every 30 minutes"),
    ] {
        out += &entry(
            name,
            "Result<'agents.schedule.preview'>",
            call("agents.schedule.preview", json!({ "when": when })).await,
        );
    }
    out += &entry(
        "scheduleCreate",
        "Result<'agents.schedule.create'>",
        call(
            "agents.schedule.create",
            json!({ "agentId": AGENT, "when": "every weekday at 9am", "note": "Check the invoices" }),
        )
        .await,
    );
    out += &entry(
        "scheduleUpdate",
        "Result<'agents.schedule.update'>",
        call(
            "agents.schedule.update",
            json!({ "agentId": AGENT, "id": "c1", "when": "every 30 minutes", "note": "Look again" }),
        )
        .await,
    );
    for method in [
        "agents.schedule.pause",
        "agents.schedule.cancel",
        "agents.schedule.runNow",
    ] {
        let value = call(
            method,
            json!({ "agentId": AGENT, "id": "c1", "paused": true }),
        )
        .await;
        assert_eq!(value, Value::Null, "{method}");
    }
    out += &entry(
        "projectsList",
        "Result<'projects.list'>",
        call("projects.list", json!({})).await,
    );
    out += &entry(
        "sessionsRead",
        "Result<'sessions.read'>",
        call("sessions.read", json!({ "sessionId": "pty-1" })).await,
    );
    out += &entry(
        "agentsUpdate",
        "Result<'agents.update'>",
        call(
            "agents.update",
            json!({ "agentId": AGENT, "input": { "muted": true } }),
        )
        .await,
    );
    out += &entry(
        "sessionsSend",
        "Result<'sessions.send'>",
        call(
            "sessions.send",
            json!({ "project": "/Users/julian/ShipStudio/site", "sessionId": "pty-1", "text": "Fix the header", "clientId": "s_1" }),
        )
        .await,
    );
    assert_eq!(
        call("sessions.key", json!({ "sessionId": "pty-2", "key": "1" })).await,
        Value::Null
    );
    out += &entry("frames", "ServerFrame[]", frames());
    out += &entry("pairResponses", "PairResponse[]", pair_responses());
    out += &entry("pairingLink", "PairingLink", pairing_link());
    out
}

#[tokio::test]
async fn fixtures_match_what_the_mac_serializes() {
    let generated = generate().await;
    if std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(PATH, &generated).unwrap();
        return;
    }
    let on_disk = std::fs::read_to_string(PATH).unwrap_or_default();
    assert!(
        on_disk == generated,
        "packages/companion-protocol/src/fixtures.gen.ts is out of date with what the Mac \
         serializes. Rerun with UPDATE_FIXTURES=1, then `pnpm typecheck` to check it against \
         the protocol."
    );
}
