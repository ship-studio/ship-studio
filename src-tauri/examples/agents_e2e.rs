//! End-to-end checks for Agents with REAL Claude Code turns (opt-in, costs money).
//!
//! Drives the real runner, store, agent bridge and MCP tools through the same
//! Tauri commands the UI calls, against the real `claude` CLI on `--model
//! haiku`. Everything lives under a throwaway HOME (projects root, app state,
//! bridge identity, Claude Code's own session files), so the owner's
//! ~/ShipStudio and ~/.claude are never touched. Claude Code still signs in
//! from the macOS keychain, which doesn't depend on HOME.
//!
//! ```text
//! scripts/agents-e2e.sh                 # every scenario
//! scripts/agents-e2e.sh memory approvals   # some of them
//! ```
//!
//! Scenarios: memory, restart, lost-session, delegation, stop, approvals,
//! cli-failures, corrupt-store, burst. (A project-bound agent needs
//! `Agent.project`, which this branch doesn't have.)

// A test driver: a failed unwrap is a failed run, and `pgrep`/re-exec are the point.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)]

use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ship_studio_lib::agents::{self, runner, store};
use ship_studio_lib::commands::agents as cmd;
use store::{AgentMessage, MessageKind};
use tauri::{AppHandle, Listener};

type Check = Result<(), String>;

fn ensure(cond: bool, what: impl Into<String>) -> Check {
    if cond {
        Ok(())
    } else {
        Err(what.into())
    }
}

/* ------------------------------------------------------------------ harness */

#[derive(Clone)]
struct H {
    app: AppHandle,
    home: PathBuf,
    /// Every draft seen: (agent id, text so far).
    drafts: Arc<Mutex<Vec<(String, String)>>>,
    /// Most agents seen "working" at the same moment.
    peak_working: Arc<Mutex<usize>>,
}

impl H {
    fn new(app: AppHandle, home: PathBuf) -> Self {
        let h = H {
            app: app.clone(),
            home,
            drafts: Default::default(),
            peak_working: Default::default(),
        };
        let drafts = h.drafts.clone();
        app.listen_any(runner::EVENT_DRAFT, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let id = v["agentId"].as_str().unwrap_or("").to_string();
                let text = v["text"].as_str().unwrap_or("").to_string();
                drafts.lock().unwrap().push((id, text));
            }
        });
        let working: Arc<Mutex<BTreeSet<String>>> = Default::default();
        let peak = h.peak_working.clone();
        app.listen_any(runner::EVENT_STATUS, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let id = v["agentId"].as_str().unwrap_or("").to_string();
                let mut set = working.lock().unwrap();
                if v["status"]["state"].as_str() == Some("idle") {
                    set.remove(&id);
                } else {
                    set.insert(id);
                }
                let mut p = peak.lock().unwrap();
                *p = (*p).max(set.len());
            }
        });
        h
    }

    /// A muted Haiku agent (muted: the suite must not post OS notifications).
    fn agent(&self, name: &str, role: &str, instructions: &str) -> store::Agent {
        let a = store::create(store::NewAgent {
            name: name.into(),
            role: role.into(),
            instructions: instructions.into(),
            shape: None,
            color: None,
            is_main: false,
        })
        .expect("create agent");
        store::update(&a.id, |a| {
            a.model = Some("haiku".into());
            a.muted = true;
        })
        .unwrap()
    }

    fn chief(&self) -> store::Agent {
        let chief = agents::ensure_main().expect("chief");
        store::update(&chief.id, |a| {
            a.model = Some("haiku".into());
            a.muted = true;
        })
        .unwrap()
    }

    async fn send(&self, id: &str, text: &str) -> Result<AgentMessage, String> {
        cmd::agents_send(self.app.clone(), id.into(), text.into(), None, None)
            .await
            .map_err(|e| format!("send failed: {e}"))
    }

    /// Until none of `ids` has a turn running or queued, steadily for `settle`.
    async fn idle(&self, ids: &[&str], settle: Duration, limit: Duration) -> Check {
        let start = Instant::now();
        let mut quiet_since: Option<Instant> = None;
        tokio::time::sleep(Duration::from_millis(300)).await;
        loop {
            let busy = ids.iter().any(|id| runner::in_turn(id));
            match (busy, quiet_since) {
                (true, _) => quiet_since = None,
                (false, None) => quiet_since = Some(Instant::now()),
                (false, Some(t)) if t.elapsed() >= settle => break,
                _ => {}
            }
            if start.elapsed() > limit {
                return Err(format!("still busy after {}s", limit.as_secs()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        for id in ids {
            let s = runner::status_of(id);
            ensure(s.state == "idle", format!("status stuck on {:?}", s.state))?;
        }
        Ok(())
    }

    async fn turn(&self, id: &str) -> Check {
        self.idle(&[id], Duration::from_secs(1), Duration::from_secs(180))
            .await
    }

    async fn until<F: Fn() -> bool>(&self, what: &str, limit: Duration, f: F) -> Check {
        let start = Instant::now();
        while !f() {
            if start.elapsed() > limit {
                return Err(format!("timed out waiting for {what}"));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Ok(())
    }

    fn drafting(&self, id: &str, min_chars: usize) -> bool {
        self.drafts
            .lock()
            .unwrap()
            .iter()
            .any(|(a, t)| a == id && t.len() >= min_chars)
    }
}

fn log(id: &str) -> Vec<AgentMessage> {
    store::messages(id, usize::MAX).unwrap_or_default()
}

fn of_kind(id: &str, kind: MessageKind) -> Vec<AgentMessage> {
    log(id).into_iter().filter(|m| m.kind == kind).collect()
}

fn last_reply(id: &str) -> String {
    of_kind(id, MessageKind::Agent)
        .last()
        .map(|m| m.text.clone())
        .unwrap_or_default()
}

fn no_errors(id: &str) -> Check {
    let errors: Vec<String> = of_kind(id, MessageKind::Error)
        .into_iter()
        .map(|m| m.text)
        .collect();
    ensure(errors.is_empty(), format!("error bubbles: {errors:?}"))
}

/// A failure the user can read: no internal codes, no raw OS errors, not empty.
fn human(text: &str) -> Check {
    let bad = [
        "error_during_execution",
        "os error",
        "exit status",
        "no stdout",
    ];
    ensure(
        !text.trim().is_empty() && !bad.iter().any(|b| text.contains(b)),
        format!("not a human error: {text:?}"),
    )
}

fn cost() -> f64 {
    store::list()
        .unwrap_or_default()
        .iter()
        .map(|a| a.usage.all_time.cost_usd)
        .sum()
}

fn session_files(home: &Path, session: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![home.join(".claude").join("projects")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().and_then(|n| n.to_str()) == Some(&format!("{session}.jsonl")) {
                found.push(p);
            }
        }
    }
    found
}

/* ---------------------------------------------------------------- scenarios */

/// (1) The first turn creates a session; the second resumes it and remembers.
async fn memory(h: &H) -> Check {
    let a = h.agent(
        "Memo",
        "Remembers things",
        "Answer in as few words as possible.",
    );
    h.send(&a.id, "My favourite number is 7913. Reply with just: noted")
        .await?;
    h.turn(&a.id).await?;
    let first = store::get(&a.id).unwrap().session_id;
    ensure(first.is_some(), "no session id after the first turn")?;
    h.send(
        &a.id,
        "What is my favourite number? Reply with just the number.",
    )
    .await?;
    h.turn(&a.id).await?;
    let second = store::get(&a.id).unwrap().session_id;
    ensure(
        first == second,
        format!("session changed: {first:?} → {second:?}"),
    )?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id).contains("7913"),
        format!("forgot: {:?}", last_reply(&a.id)),
    )
}

/// (2) The app quits mid-turn (SIGKILL of a second process using the same
/// data), then starts again: nothing is stuck and the next message works.
async fn restart(h: &H) -> Check {
    let exe = std::env::current_exe().unwrap();
    let mut child = std::process::Command::new(&exe)
        .args(["--phase", "restart-a"])
        .env("AGENTS_E2E_HOME", &h.home)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut agent_id = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(id) = line.strip_prefix("WORKING ") {
            agent_id = Some(id.to_string());
            break;
        }
    }
    let _ = child.kill(); // SIGKILL: no destructors, like a crash or force quit
    let _ = child.wait();
    let id = agent_id.ok_or("phase A never got a turn going")?;
    let session = store::get(&id).unwrap().session_id;

    let out = std::process::Command::new(&exe)
        .args(["--phase", "restart-b", &id])
        .env("AGENTS_E2E_HOME", &h.home)
        .output()
        .map_err(|e| e.to_string())?;
    let report = String::from_utf8_lossy(&out.stdout).to_string();
    // An orphaned turn from phase A writing the same session would race the next one.
    let orphan = session.as_deref().is_some_and(|s| {
        std::process::Command::new("pgrep")
            .args(["-f", s])
            .output()
            .is_ok_and(|o| !o.stdout.is_empty())
    });
    ensure(!orphan, "phase A's claude process outlived the app")?;
    ensure(out.status.success(), format!("phase B failed: {report}"))
}

async fn restart_phase_a(h: &H) {
    let a = h.agent("Keeper", "Writes stories", "");
    h.send(
        &a.id,
        "Write a 700-word story about a lighthouse keeper named Ada. No preamble.",
    )
    .await
    .unwrap();
    let _ = h
        .until("a draft", Duration::from_secs(90), || h.drafting(&a.id, 40))
        .await;
    println!("WORKING {}", a.id);
    tokio::time::sleep(Duration::from_secs(600)).await;
}

async fn restart_phase_b(h: &H, id: &str) -> Check {
    // What the app does at launch.
    agents::store::expire_stale_approvals();
    agents::runner::recover_after_restart(&h.app).await;
    let agent = store::get(id).map_err(|e| format!("registry unreadable: {e}"))?;
    ensure(runner::status_of(id).state == "idle", "status not idle")?;
    ensure(!runner::in_turn(id), "a turn is running at launch")?;
    ensure(agent.pending_approvals == 0, "phantom pending approvals")?;
    let notes = of_kind(id, MessageKind::Note);
    ensure(
        notes.iter().any(|n| n.text.contains("closed")),
        "the interrupted turn left no trace in the chat",
    )?;
    h.send(id, "Who was the story about? Reply with just the name.")
        .await?;
    h.turn(id).await?;
    no_errors(id)?;
    ensure(
        last_reply(id).contains("Ada"),
        format!("lost the thread: {:?}", last_reply(id)),
    )
}

/// (3) Claude's session file vanishes: the turn is retried fresh with a recap.
async fn lost_session(h: &H) -> Check {
    let a = h.agent(
        "Lost",
        "Remembers code words",
        "Answer in as few words as possible.",
    );
    h.send(&a.id, "The code word is PELICAN. Reply with just: ok")
        .await?;
    h.turn(&a.id).await?;
    let session = store::get(&a.id).unwrap().session_id.ok_or("no session")?;
    let files = session_files(&h.home, &session);
    ensure(!files.is_empty(), "couldn't find Claude's session file")?;
    for f in files {
        std::fs::remove_file(f).map_err(|e| e.to_string())?;
    }
    h.send(&a.id, "What is the code word? Reply with just the word.")
        .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let now = store::get(&a.id).unwrap().session_id;
    ensure(now.as_deref() != Some(&session), "kept the dead session id")?;
    ensure(
        last_reply(&a.id).to_uppercase().contains("PELICAN"),
        format!("recap missing: {:?}", last_reply(&a.id)),
    )
}

/// (4) Two agents at once; the Chief delegates and the answer comes back; the hop cap holds.
async fn delegation(h: &H) -> Check {
    let chief = h.chief();
    let scout = h.agent(
        "Scout",
        "Answers arithmetic questions",
        "When another agent asks you something, answer them with message_agent, in one short line.",
    );
    let echo = h.agent("Echo", "Repeats things", "");
    h.send(
        &chief.id,
        "Use message_agent to ask Scout: \"What is 6 times 7? Reply to Chief of Staff with message_agent.\" Then stop. When Scout answers, tell me the number in one line.",
    )
    .await?;
    h.send(&echo.id, "Reply with just: echo-ok").await?;
    h.idle(
        &[&chief.id, &scout.id, &echo.id],
        Duration::from_secs(5),
        Duration::from_secs(300),
    )
    .await?;
    ensure(
        *h.peak_working.lock().unwrap() >= 2,
        "agents never ran at the same time",
    )?;
    ensure(
        last_reply(&echo.id).contains("echo-ok"),
        "Echo didn't answer",
    )?;
    let sent = of_kind(&chief.id, MessageKind::SentToAgent);
    ensure(
        sent.iter()
            .any(|m| m.peer.as_ref().is_some_and(|p| p.id == scout.id)),
        "the Chief never messaged Scout",
    )?;
    let back = of_kind(&chief.id, MessageKind::FromAgent);
    ensure(
        back.iter()
            .any(|m| m.peer.as_ref().is_some_and(|p| p.id == scout.id)),
        "Scout's answer never reached the Chief",
    )?;
    ensure(
        last_reply(&chief.id).contains("42"),
        format!("the Chief didn't pass it on: {:?}", last_reply(&chief.id)),
    )?;
    for id in [&chief.id, &scout.id, &echo.id] {
        no_errors(id)?;
    }

    // A turn already at the cap can't start another hop.
    let before_scout = of_kind(&scout.id, MessageKind::SentToAgent).len();
    let before_chief = of_kind(&chief.id, MessageKind::FromAgent).len();
    runner::enqueue(
        &h.app,
        &scout.id,
        "Call message_agent now to send \"ping\" to Chief of Staff, then tell me what the tool said.".into(),
        runner::From::Agent {
            sender: store::AgentRef {
                id: chief.id.clone(),
                name: chief.name.clone(),
            },
            hop: runner::MAX_HOPS,
        },
    );
    h.idle(
        &[&scout.id, &chief.id],
        Duration::from_secs(3),
        Duration::from_secs(180),
    )
    .await?;
    ensure(
        of_kind(&scout.id, MessageKind::SentToAgent).len() == before_scout
            && of_kind(&chief.id, MessageKind::FromAgent).len() == before_chief,
        "a message past the hop cap was delivered",
    )
}

/// (5) Stop and interrupt mid-stream keep the partial reply; the next turn works.
async fn stop(h: &H) -> Check {
    let a = h.agent("Talker", "Writes long things", "");
    let story = "Write a 600-word story about a lighthouse. No preamble.";
    h.send(&a.id, story).await?;
    h.until("a draft", Duration::from_secs(90), || h.drafting(&a.id, 80))
        .await?;
    ensure(
        cmd::agents_stop(a.id.clone()).await.unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    let kept = of_kind(&a.id, MessageKind::Agent);
    ensure(
        kept.last().is_some_and(|m| m.stopped && m.text.len() >= 40),
        "the partial reply wasn't kept as stopped",
    )?;
    h.send(&a.id, "Reply with just: ready").await?;
    h.turn(&a.id).await?;
    ensure(last_reply(&a.id).contains("ready"), "no turn after Stop")?;

    h.drafts.lock().unwrap().clear();
    h.send(&a.id, story).await?;
    h.until("a draft", Duration::from_secs(90), || h.drafting(&a.id, 80))
        .await?;
    h.send(&a.id, "Forget the story. Reply with just: switched")
        .await?;
    ensure(
        cmd::agents_interrupt(a.id.clone()).await.unwrap_or(false),
        "interrupt refused",
    )?;
    h.turn(&a.id).await?;
    ensure(
        of_kind(&a.id, MessageKind::Note)
            .iter()
            .any(|n| n.text.starts_with("Interrupted")),
        "no interruption note",
    )?;
    ensure(
        of_kind(&a.id, MessageKind::Agent)
            .iter()
            .filter(|m| m.stopped)
            .count()
            == 2,
        "the interrupted partial wasn't kept",
    )?;
    no_errors(&a.id)?;
    ensure(
        last_reply(&a.id).contains("switched"),
        format!("didn't read the new message: {:?}", last_reply(&a.id)),
    )
}

async fn card(h: &H, id: &str, seen: usize) -> Result<store::Approval, String> {
    h.until("an approval card", Duration::from_secs(120), || {
        approvals(id).len() > seen
    })
    .await?;
    Ok(approvals(id).pop().unwrap())
}

fn approvals(id: &str) -> Vec<store::Approval> {
    log(id).into_iter().filter_map(|m| m.approval).collect()
}

/// (6) A shell command asks; Allow, a late Allow after the wait, and Always allow.
async fn approvals_scenario(h: &H) -> Check {
    let a = h.agent(
        "Runner",
        "Runs commands",
        "When asked to run a command, run it exactly as written with Bash and reply with only its output.",
    );
    // Allow, through the command the UI calls.
    h.send(&a.id, "Run: python3 -c 'print(6*7)'").await?;
    let c = card(h, &a.id, 0).await?;
    ensure(
        c.tool.as_deref() == Some("Bash"),
        format!("card for {:?}", c.tool),
    )?;
    ensure(
        runner::status_of(&a.id).state == "waiting",
        "row doesn't say waiting",
    )?;
    cmd::agents_answer_approval(h.app.clone(), a.id.clone(), c.request_id, true, None)
        .await
        .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id).contains("42"),
        format!("allowed run: {:?}", last_reply(&a.id)),
    )?;

    // The wait runs out (shortened); the card stays live; a late Allow finishes it.
    std::env::set_var("SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS", "5");
    h.send(&a.id, "Run: python3 -c 'print(6*9)'").await?;
    let c = card(h, &a.id, 1).await?;
    h.turn(&a.id).await?;
    std::env::remove_var("SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS");
    let still = approvals(&a.id).pop().unwrap();
    ensure(
        still.status == store::ApprovalStatus::Pending,
        format!("card not live after the wait: {:?}", still.status),
    )?;
    ensure(
        store::get(&a.id).unwrap().pending_approvals == 1,
        "pending count off",
    )?;
    cmd::agents_answer_approval(h.app.clone(), a.id.clone(), c.request_id, true, None)
        .await
        .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    ensure(approvals(&a.id).len() == 2, "the retry asked again")?;
    ensure(
        last_reply(&a.id).contains("54"),
        format!("late allow: {:?}", last_reply(&a.id)),
    )?;

    // Always allow ("git init" here; a command with brackets or quotes is
    // never offered it): a later `git init <other>` goes through with a note.
    h.send(&a.id, "Run: git init e2e-one").await?;
    let c = card(h, &a.id, 2).await?;
    ensure(
        c.always.is_some(),
        format!("card offers no Always allow: {:?}", c.detail),
    )?;
    cmd::agents_answer_approval(h.app.clone(), a.id.clone(), c.request_id, true, Some(true))
        .await
        .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    ensure(
        !store::get(&a.id).unwrap().permissions.is_empty(),
        "no rule stored",
    )?;
    h.send(&a.id, "Run: git init e2e-two").await?;
    h.turn(&a.id).await?;
    ensure(approvals(&a.id).len() == 3, "Always allow still asked")?;
    ensure(
        of_kind(&a.id, MessageKind::Note)
            .iter()
            .any(|n| n.text.starts_with("Allowed automatically")),
        "no 'Allowed automatically' line",
    )?;
    let home = store::agent_home(&a.id).unwrap();
    ensure(
        home.join("e2e-one/.git").exists() && home.join("e2e-two/.git").exists(),
        "the allowed commands didn't run",
    )?;
    ensure(
        store::get(&a.id).unwrap().pending_approvals == 0,
        "cards left pending",
    )?;
    no_errors(&a.id)
}

const FAKE_CLAUDE: &str = r#"#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi
case "$FAKE_CLAUDE_MODE" in
  instant)
    echo "Error: unknown option '--frobnicate'" >&2; exit 1 ;;
  garbage)
    cat > /dev/null
    echo 'not json at all'
    echo '{"type":"system","subtype":"init","session_id":"0f0f0f0f-0000-4000-8000-000000000000"}'
    printf '{"type":"assistant","message":{"content":[{"type":"te'
    exit 0 ;;
  crash)
    cat > /dev/null
    echo '{"type":"system","subtype":"init","session_id":"0f0f0f0f-0000-4000-8000-000000000001"}'
    echo '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Here is the first half of my answer"}}}'
    kill -SEGV $$ ;;
  error-result)
    cat > /dev/null
    echo '{"type":"result","subtype":"error_during_execution","is_error":true}'
    exit 1 ;;
esac
"#;

/// (8) Malformed output, a crash, a bare error code: a clean error, nothing stuck.
async fn cli_failures(h: &H) -> Check {
    let bin = h.home.join("fakebin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = bin.join("claude");
    std::fs::write(&script, FAKE_CLAUDE).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let real_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{real_path}", bin.display()));

    let a = h.agent(
        "Fragile",
        "Survives bad CLIs",
        "Answer in as few words as possible.",
    );
    let mut result = Ok(());
    for mode in ["instant", "garbage", "crash", "error-result"] {
        std::env::set_var("FAKE_CLAUDE_MODE", mode);
        let before = of_kind(&a.id, MessageKind::Error).len();
        let step = async {
            h.send(&a.id, &format!("({mode}) hello")).await?;
            h.turn(&a.id).await?;
            let errors = of_kind(&a.id, MessageKind::Error);
            ensure(
                errors.len() == before + 1,
                format!("{mode}: {} new errors", errors.len() - before),
            )?;
            human(&errors.last().unwrap().text).map_err(|e| format!("{mode}: {e}"))?;
            if mode == "crash" {
                ensure(
                    of_kind(&a.id, MessageKind::Agent)
                        .last()
                        .is_some_and(|m| m.stopped && m.text.contains("first half")),
                    "crash: the partial reply wasn't kept",
                )?;
            }
            Ok::<_, String>(())
        };
        if let Err(e) = step.await {
            result = Err(e);
            break;
        }
    }
    std::env::remove_var("FAKE_CLAUDE_MODE");
    std::env::set_var("PATH", real_path);
    result?;
    // The real CLI again: the bogus session ids the fakes reported must not stick.
    h.send(&a.id, "Reply with just: back").await?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id).contains("back"),
        format!(
            "no recovery: {:?} / {:?}",
            last_reply(&a.id),
            of_kind(&a.id, MessageKind::Error).last().map(|m| &m.text)
        ),
    )
}

/// (9) A torn log line, a corrupt registry, a log that can't be written.
async fn corrupt_store(h: &H) -> Check {
    let a = h.agent(
        "Sturdy",
        "Survives disk trouble",
        "Answer in as few words as possible.",
    );
    h.send(&a.id, "Reply with just: one").await?;
    h.turn(&a.id).await?;
    let path = store::agent_home(&a.id).unwrap().join("messages.jsonl");
    let lines = log(&a.id).len();

    // A crash mid-append leaves a torn line with no newline; the next append must not merge into it.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(br#"{"id":"torn","agentId":"x","ts":1,"kind":"us"#)
            .unwrap();
    }
    h.send(&a.id, "Reply with just: two").await?;
    h.turn(&a.id).await?;
    ensure(
        log(&a.id).len() == lines + 2,
        format!(
            "torn line swallowed messages: {} → {}",
            lines,
            log(&a.id).len()
        ),
    )?;

    // A truncated registry still loads every agent it can.
    let registry = store::agents_root().unwrap().join("agents.json");
    let count = store::list().unwrap().len();
    let raw = std::fs::read(&registry).unwrap();
    std::fs::write(&registry, &raw[..raw.len() / 2]).unwrap();
    let after = store::list();
    std::fs::write(&registry, &raw).unwrap_or(());
    let after = after.map_err(|e| format!("registry lost entirely: {e}"))?;
    ensure(
        after.len() == count,
        format!("registry recovered {} of {count}", after.len()),
    )?;
    let kept = std::fs::read_dir(store::agents_root().unwrap())
        .unwrap()
        .flatten()
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("agents.json.corrupt")
        });
    ensure(kept, "the corrupt registry wasn't kept aside")?;

    // A log that can't be written: the reply still reaches the UI, the history survives.
    let seen: Arc<Mutex<Vec<String>>> = Default::default();
    let s = seen.clone();
    let id = a.id.clone();
    let listener = h.app.listen_any(runner::EVENT_MESSAGE, move |e| {
        if let Ok(m) = serde_json::from_str::<AgentMessage>(e.payload()) {
            if m.agent_id == id {
                s.lock().unwrap().push(format!("{:?}:{}", m.kind, m.text));
            }
        }
    });
    let before = log(&a.id);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let sent = h.send(&a.id, "Reply with just: three").await;
    let queued = sent.is_err();
    if queued {
        // The user's own message couldn't be saved: they're told, nothing runs.
        // Exercise the turn itself with a message from another agent instead.
        runner::enqueue(
            &h.app,
            &a.id,
            "Reply with just: three".into(),
            runner::From::User,
        );
    }
    h.turn(&a.id).await?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    h.app.unlisten(listener);
    ensure(log(&a.id) == before, "history changed while unwritable")?;
    let seen = seen.lock().unwrap().clone();
    ensure(
        seen.iter()
            .any(|s| s.starts_with("Agent:") && s.contains("three")),
        format!("the unsaved reply never reached the UI: {seen:?}"),
    )?;
    ensure(
        seen.iter()
            .any(|s| s.starts_with("Error:") && s.contains("save")),
        format!("the user wasn't told it couldn't be saved: {seen:?}"),
    )?;
    h.send(&a.id, "Reply with just: four").await?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id).contains("four"),
        "no turn after the disk came back",
    )
}

/// (10) Twenty quick messages: batched into a few turns, none lost or doubled.
async fn burst(h: &H) -> Check {
    let a = h.agent(
        "Counter",
        "Collects numbers",
        "Messages say n=<number>. Reply with only the n values in the messages you just received (not earlier ones), comma-separated.",
    );
    let turns_before = store::get(&a.id).unwrap().usage.all_time.turns;
    for n in 1..=20 {
        h.send(&a.id, &format!("n={n}")).await?;
    }
    h.idle(&[&a.id], Duration::from_secs(3), Duration::from_secs(240))
        .await?;
    let users: Vec<String> = of_kind(&a.id, MessageKind::User)
        .into_iter()
        .map(|m| m.text)
        .collect();
    let unique: BTreeSet<&String> = users.iter().collect();
    ensure(
        users.len() == 20 && unique.len() == 20,
        format!("{} user lines, {} distinct", users.len(), unique.len()),
    )?;
    let turns = store::get(&a.id).unwrap().usage.all_time.turns - turns_before;
    ensure(
        (1..=4).contains(&turns),
        format!("{turns} turns for 20 messages"),
    )?;
    let mut said: Vec<u32> = Vec::new();
    for r in of_kind(&a.id, MessageKind::Agent) {
        said.extend(
            r.text
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|s| s.parse::<u32>().ok()),
        );
    }
    let got: BTreeSet<u32> = said.iter().copied().collect();
    let missing: Vec<u32> = (1..=20).filter(|n| !got.contains(n)).collect();
    no_errors(&a.id)?;
    ensure(
        missing.is_empty(),
        format!("never acknowledged: {missing:?} (turns: {turns})"),
    )
}

/* --------------------------------------------------------------------- main */

const ALL: [&str; 9] = [
    "memory",
    "restart",
    "lost-session",
    "delegation",
    "stop",
    "approvals",
    "cli-failures",
    "corrupt-store",
    "burst",
];

/// Claude Code reads its sign-in from the login keychain under HOME and the
/// account from ~/.claude.json. Link the one, copy the account out of the
/// other (read only), and nothing else of the owner's comes along.
fn sign_in_from(real: &Path, temp: &Path) {
    let keychains = temp.join("Library").join("Keychains");
    if !keychains.exists() {
        std::fs::create_dir_all(temp.join("Library")).unwrap();
        std::os::unix::fs::symlink(real.join("Library").join("Keychains"), &keychains).unwrap();
    }
    let config = temp.join(".claude.json");
    if !config.exists() {
        let theirs: Value = std::fs::read_to_string(real.join(".claude.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let ours = serde_json::json!({
            "oauthAccount": theirs.get("oauthAccount"),
            "hasCompletedOnboarding": true,
        });
        std::fs::write(config, ours.to_string()).unwrap();
    }
}

fn main() {
    // Before anything reads HOME: every path the app derives from it is now disposable.
    let home = match std::env::var("AGENTS_E2E_HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => {
            let dir = std::env::temp_dir().join(format!("agents-e2e-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }
    };
    let home = home.canonicalize().unwrap();
    let real_home = dirs::home_dir().expect("home");
    sign_in_from(&real_home, &home);
    std::env::set_var("HOME", &home);
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy().to_string();
        if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
            std::env::remove_var(key);
        }
    }
    std::fs::create_dir_all(home.join("ShipStudio")).unwrap();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .build(tauri::generate_context!())
        .expect("build tauri app");
    let h = H::new(app.handle().clone(), home.clone());

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--phase") {
        tauri::async_runtime::block_on(async {
            match args[1].as_str() {
                "restart-a" => restart_phase_a(&h).await,
                "restart-b" => match restart_phase_b(&h, &args[2]).await {
                    Ok(()) => println!("OK"),
                    Err(e) => {
                        println!("{e}");
                        std::process::exit(1);
                    }
                },
                other => panic!("unknown phase {other}"),
            }
        });
        return;
    }

    let wanted: Vec<&str> = if args.is_empty() {
        ALL.to_vec()
    } else {
        args.iter().map(String::as_str).collect()
    };
    println!("HOME for this run: {}", home.display());
    let started = Instant::now();
    let mut failed = 0;
    tauri::async_runtime::block_on(async {
        for name in wanted {
            let (t, c) = (Instant::now(), cost());
            let result = match name {
                "memory" => memory(&h).await,
                "restart" => restart(&h).await,
                "lost-session" => lost_session(&h).await,
                "delegation" => delegation(&h).await,
                "stop" => stop(&h).await,
                "approvals" => approvals_scenario(&h).await,
                "cli-failures" => cli_failures(&h).await,
                "corrupt-store" => corrupt_store(&h).await,
                "burst" => burst(&h).await,
                other => Err(format!("unknown scenario {other}")),
            };
            let took = t.elapsed().as_secs();
            let spent = cost() - c;
            match result {
                Ok(()) => println!("PASS  {name:<14} {took:>4}s  ${spent:.3}"),
                Err(e) => {
                    failed += 1;
                    println!("FAIL  {name:<14} {took:>4}s  ${spent:.3}  {e}");
                }
            }
        }
    });
    println!(
        "{} failed · {}s · ${:.3} reported by Claude Code",
        failed,
        started.elapsed().as_secs(),
        cost()
    );
    if std::env::var("AGENTS_E2E_KEEP").is_err() {
        let _ = std::fs::remove_dir_all(&home);
    }
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
