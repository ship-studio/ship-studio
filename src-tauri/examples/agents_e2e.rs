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
//! cli-failures, corrupt-store, burst, stop-tree, quit, slots, and on Codex
//! codex-memory, codex-stop, codex-delegation. Codex runs on the signed-in
//! account (copied into the throwaway CODEX_HOME) when there is one, else on
//! a scripted model (scripts/agents-e2e-codex-model.py), which proves the
//! plumbing (real `codex`, runner, bridge, resume) but not a model's
//! judgement. `AGENTS_E2E_CODEX=real|scripted|skip` forces one.

// A test driver: a failed unwrap is a failed run, and `pgrep`/re-exec are the point.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)]

use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ship_studio_lib::agents::engine::Engine;
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
    /// What the scenario's agents run on.
    engine: Arc<Mutex<Engine>>,
}

impl H {
    fn new(app: AppHandle, home: PathBuf) -> Self {
        let h = H {
            app: app.clone(),
            home,
            drafts: Default::default(),
            peak_working: Default::default(),
            engine: Default::default(),
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

    fn engine(&self) -> Engine {
        *self.engine.lock().unwrap()
    }

    /// The scenario's engine on its cheapest model: Haiku, or for Codex
    /// `AGENTS_E2E_CODEX_MODEL` (else Codex's default).
    fn set_engine(&self, a: &mut store::Agent) {
        a.engine = self.engine();
        a.model = match a.engine {
            Engine::Claude => Some("haiku".into()),
            Engine::Codex => std::env::var("AGENTS_E2E_CODEX_MODEL").ok(),
        };
    }

    /// A muted agent on the scenario's engine (muted: the suite must not post OS notifications).
    fn agent(&self, name: &str, role: &str, instructions: &str) -> store::Agent {
        // The same scenario on the other engine reuses its names: start clean.
        if let Ok(Some(old)) = store::find(name) {
            runner::stop(&old.id);
            let _ = store::delete(&old.id);
        }
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
            self.set_engine(a);
            a.muted = true;
        })
        .unwrap()
    }

    fn chief(&self) -> store::Agent {
        let chief = agents::ensure_main().expect("chief");
        store::update(&chief.id, |a| {
            if a.engine != self.engine() {
                a.session_id = None;
            }
            self.set_engine(a);
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

/// A git project under ~/ShipStudio with one commit and one edit already
/// pending, so a change card that lists that edit took the wrong baseline.
fn git_project(h: &H, name: &str) -> PathBuf {
    let dir = h.home.join("ShipStudio").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.name=e2e", "-c", "user.email=e2e@example.com"])
            .args(args)
            .current_dir(&dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(dir.join("README.md"), "# site\n").unwrap();
    std::fs::write(dir.join("package.json"), "{\"name\":\"site\"}\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "init"]);
    std::fs::write(dir.join("README.md"), "# site, edited before the turn\n").unwrap();
    dir
}

/// Puts the fake `claude` first on PATH; returns the PATH to restore.
fn fake_cli(h: &H) -> String {
    let bin = h.home.join("fakebin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = bin.join("claude");
    std::fs::write(&script, FAKE_CLAUDE).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let real_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{real_path}", bin.display()));
    real_path
}

async fn bound_agent(h: &H, name: &str, project: &str) -> Result<store::Agent, String> {
    let input: cmd::CreateAgentInput = serde_json::from_value(serde_json::json!({
        "name": name,
        "role": "Works on the site",
        "instructions": "Answer in as few words as possible.",
        "model": "haiku",
        "project": project,
    }))
    .unwrap();
    let a = cmd::agents_create(h.app.clone(), input)
        .await
        .map_err(|e| format!("create bound agent: {e}"))?;
    Ok(store::update(&a.id, |a| a.muted = true).unwrap())
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
    let dir = git_project(h, "harbour");
    let a = bound_agent(h, "Keeper", "harbour").await.unwrap();
    h.send(
        &a.id,
        "First create a file named ada.txt in the current directory containing exactly: Ada. Then, in your reply, write a 700-word story about a lighthouse keeper named Ada. No preamble.",
    )
    .await
    .unwrap();
    let _ = h
        .until("a draft after ada.txt", Duration::from_secs(120), || {
            dir.join("ada.txt").exists() && h.drafting(&a.id, 40)
        })
        .await;
    // Two more while it works: they queue, and must survive the crash.
    h.send(&a.id, "Queued one. Reply with the token Q1-OSPREY.")
        .await
        .unwrap();
    h.send(&a.id, "Queued two. Reply with the token Q2-HERON.")
        .await
        .unwrap();
    println!("WORKING {}", a.id);
    tokio::time::sleep(Duration::from_secs(600)).await;
}

async fn restart_phase_b(h: &H, id: &str) -> Check {
    // What the app does at launch.
    agents::store::expire_stale_approvals();
    agents::runner::recover_after_restart(&h.app).await;
    let agent = store::get(id).map_err(|e| format!("registry unreadable: {e}"))?;
    // The queued two were handed back to the runner; nothing else runs.
    ensure(
        runner::in_turn(id),
        "the queued messages weren't sent again",
    )?;
    ensure(agent.pending_approvals == 0, "phantom pending approvals")?;
    // The cut-short turn ends like any failed turn: its change card, then a
    // tagged error line (Retry re-sends it); then a note naming the queued
    // messages being sent again.
    let mut tail: Vec<AgentMessage> = log(id).into_iter().rev().take(3).collect();
    let note = tail.remove(0);
    ensure(
        note.kind == MessageKind::Note
            && note.text.starts_with("Sent 2 messages")
            && note.text.contains("Q1-OSPREY")
            && note.text.contains("Q2-HERON"),
        format!("no note naming the re-sent messages: {:?}", note.text),
    )?;
    ensure(
        tail.len() == 2
            && tail[0].kind == MessageKind::Error
            && tail[0].text.contains("closed")
            && tail[0].failure.is_some(),
        "the interrupted turn left no tagged error line",
    )?;
    ensure(
        tail[1].kind == MessageKind::Changes
            && tail[1]
                .changes
                .as_ref()
                .is_some_and(|c| c.files.iter().map(|f| f.path.as_str()).eq(["ada.txt"])),
        format!("no change card for ada.txt before it: {:?}", tail[1].text),
    )?;
    ensure(agent.failure.is_some(), "agent not marked as failed")?;
    // The queued two run once each, and then nothing is left queued on disk.
    h.turn(id).await?;
    let inbox = store::agent_home(id).unwrap().join("inbox.json");
    ensure(!inbox.exists(), "the queue was left on disk after it ran")?;
    let replies: String = of_kind(id, MessageKind::Agent)
        .iter()
        .map(|m| m.text.clone())
        .collect();
    for token in ["Q1-OSPREY", "Q2-HERON"] {
        ensure(
            replies.contains(token),
            format!("the queued {token} was never answered"),
        )?;
        let sent = of_kind(id, MessageKind::User)
            .iter()
            .filter(|m| m.text.contains(token))
            .count();
        ensure(sent == 1, format!("{token} is in the chat {sent} times"))?;
    }
    let turns = store::get(id).unwrap().usage.all_time.turns;
    let errors_before = of_kind(id, MessageKind::Error).len();
    h.send(id, "Who was the story about? Reply with just the name.")
        .await?;
    h.turn(id).await?;
    ensure(
        of_kind(id, MessageKind::Error).len() == errors_before,
        "the follow-up turn failed",
    )?;
    ensure(
        store::get(id).unwrap().failure.is_none(),
        "failure not cleared by the next reply",
    )?;
    ensure(
        store::get(id).unwrap().usage.all_time.turns == turns + 1,
        "the queued messages ran again",
    )?;
    ensure(
        last_reply(id).contains("Ada"),
        format!("lost the thread: {:?}", last_reply(id)),
    )
}

/* ------------------------------------------------- process trees and slots */

fn pids_matching(pattern: &str) -> Vec<String> {
    std::process::Command::new("pgrep")
        .args(["-f", pattern])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// An agent whose turn is running a long child of its own: a background
/// `sleep <tag>` (standing in for a dev server) and a foreground one, so the
/// turn is still going. Approvals for them are pre-granted, or answered.
async fn turn_with_children(h: &H, name: &str, tag: u32) -> Result<store::Agent, String> {
    let a = h.agent(
        name,
        "Runs commands",
        "When asked to run commands, run them exactly as written with Bash.",
    );
    // Not `sleep`: Claude Code refuses a bare foreground sleep.
    let background = format!("python3 -m http.server {tag}");
    let foreground = format!("python3 -m http.server {}", tag + 1);
    store::update(&a.id, |a| {
        for (i, command) in [&background, &foreground].into_iter().enumerate() {
            a.permissions.push(
                serde_json::from_value(serde_json::json!({
                    "id": format!("e2e-{i}"),
                    "kind": "command",
                    "value": command,
                    "label": command,
                    "createdAt": 0,
                }))
                .unwrap(),
            );
        }
    })
    .unwrap();
    h.send(
        &a.id,
        &format!(
            "First run `{background}` with Bash using run_in_background set to true. Then run `{foreground}` with Bash in the foreground. Then reply done."
        ),
    )
    .await?;
    let start = Instant::now();
    while pids_matching(&foreground).is_empty() {
        for card in approvals(&a.id)
            .into_iter()
            .filter(|c| c.status == store::ApprovalStatus::Pending)
        {
            let _ = cmd::agents_answer_approval(
                h.app.clone(),
                a.id.clone(),
                card.request_id,
                true,
                None,
                None,
            )
            .await;
        }
        if start.elapsed() > Duration::from_secs(150) {
            return Err(format!(
                "the turn never started its children: {:?}",
                last_reply(&a.id)
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    ensure(
        !pids_matching(&background).is_empty(),
        "the background child isn't running",
    )?;
    ensure(runner::in_turn(&a.id), "the turn ended early")?;
    Ok(a)
}

/// (11) Stop ends the whole tree: what the turn's Bash started dies with it.
async fn stop_tree(h: &H) -> Check {
    let a = turn_with_children(h, "Sleeper", 47471).await?;
    ensure(
        cmd::agents_stop(a.id.clone()).await.unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    for pattern in ["http.server 47471", "http.server 47472"] {
        ensure(
            pids_matching(pattern).is_empty(),
            format!("`{pattern}` outlived Stop"),
        )?;
    }
    h.send(&a.id, "Reply with just: awake").await?;
    h.turn(&a.id).await?;
    ensure(last_reply(&a.id).contains("awake"), "no turn after Stop")?;

    // A turn that finishes with something still running in the background
    // ends anyway (`claude --print` would wait on it for ever), and takes
    // the background child with it.
    let server = "python3 -m http.server 47491";
    store::update(&a.id, |a| {
        a.permissions.push(
            serde_json::from_value(serde_json::json!({
                "id": "e2e-bg", "kind": "command", "value": server, "label": server, "createdAt": 0,
            }))
            .unwrap(),
        );
    })
    .unwrap();
    h.send(
        &a.id,
        &format!("Run `{server}` with Bash using run_in_background set to true, then reply with just: started"),
    )
    .await?;
    h.until("the background server", Duration::from_secs(120), || {
        !pids_matching("http.server 47491").is_empty() || !runner::in_turn(&a.id)
    })
    .await?;
    h.idle(&[&a.id], Duration::from_secs(1), Duration::from_secs(60))
        .await
        .map_err(|e| format!("a finished turn stayed busy on its background child: {e}"))?;
    ensure(
        pids_matching("http.server 47491").is_empty(),
        "the background child outlived its finished turn",
    )?;
    no_errors(&a.id)
}

/// (12) Quitting (the app's Exit hook) stops every turn and its children at
/// once; the next launch says the turn didn't finish.
async fn quit(h: &H) -> Check {
    let exe = std::env::current_exe().unwrap();
    let mut child = std::process::Command::new(&exe)
        .args(["--phase", "quit"])
        .env("AGENTS_E2E_HOME", &h.home)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut report = Vec::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        report.push(line);
    }
    let _ = child.wait();
    let (id, stopped) = report
        .iter()
        .find_map(|l| l.strip_prefix("QUIT ")?.split_once(' '))
        .ok_or(format!("the quit phase never got going: {report:?}"))?;
    let id = id.to_string();
    ensure(
        stopped == "1",
        format!("the exit hook stopped {stopped} turns, not 1"),
    )?;
    for pattern in ["http.server 57571", "http.server 57572"] {
        ensure(
            pids_matching(pattern).is_empty(),
            format!("`{pattern}` outlived the app"),
        )?;
    }
    let session = store::get(&id).unwrap().session_id.unwrap_or_default();
    ensure(
        session.is_empty() || pids_matching(&session).is_empty(),
        "claude outlived the app",
    )?;
    // The next launch.
    runner::recover_after_restart(&h.app).await;
    ensure(
        log(&id)
            .last()
            .is_some_and(|m| m.kind == MessageKind::Error && m.text.contains("closed")),
        "the next launch didn't say the turn was cut off",
    )?;
    ensure(!runner::in_turn(&id), "a turn is running after recovery")
}

async fn quit_phase(h: &H) {
    let a = turn_with_children(h, "Quitter", 57571).await.unwrap();
    // What RunEvent::Exit does, then the process exits as the app would.
    let stopped = runner::shutdown_sync();
    println!("QUIT {} {stopped}", a.id);
    std::process::exit(0);
}

/// (13) More turns than slots: the extra one waits, says so, then runs.
async fn slots(h: &H) -> Check {
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new(&exe)
        .args(["--phase", "slots"])
        .env("AGENTS_E2E_HOME", &h.home)
        .env("SHIPSTUDIO_AGENTS_MAX_TURNS", "1")
        .output()
        .map_err(|e| e.to_string())?;
    let report = String::from_utf8_lossy(&out.stdout).to_string();
    ensure(out.status.success(), format!("slots phase: {report}"))
}

async fn slots_phase(h: &H) -> Check {
    let first = h.agent("First", "Counts", "Answer in as few words as possible.");
    let second = h.agent("Second", "Counts", "Answer in as few words as possible.");
    let waited: Arc<Mutex<bool>> = Default::default();
    let w = waited.clone();
    let id = second.id.clone();
    h.app.listen_any(runner::EVENT_STATUS, move |e| {
        if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
            if v["agentId"] == id.as_str()
                && v["status"]["activity"]
                    .as_str()
                    .is_some_and(|a| a.starts_with("Waiting for a free slot"))
            {
                *w.lock().unwrap() = true;
            }
        }
    });
    h.send(&first.id, "Write two sentences about the sea.")
        .await?;
    h.send(&second.id, "Reply with just: second").await?;
    h.idle(
        &[&first.id, &second.id],
        Duration::from_secs(2),
        Duration::from_secs(240),
    )
    .await?;
    ensure(
        *waited.lock().unwrap(),
        "the second turn never waited for a slot",
    )?;
    ensure(
        *h.peak_working.lock().unwrap() >= 2,
        "the waiting agent didn't show as busy",
    )?;
    ensure(
        last_reply(&second.id).contains("second"),
        "the waiting turn never ran",
    )?;
    no_errors(&first.id)?;
    no_errors(&second.id)
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
    // Codex sends a reply only once it's complete: there is no draft to keep,
    // so Stop is checked mid-turn instead, and leaves its quiet note.
    let codex = h.engine() == Engine::Codex;
    let mid_reply = || async {
        if codex {
            h.until("a turn underway", Duration::from_secs(90), || {
                runner::status_of(&a.id).state == "working"
            })
            .await?;
            tokio::time::sleep(Duration::from_secs(4)).await;
            Ok(())
        } else {
            h.until("a draft", Duration::from_secs(90), || h.drafting(&a.id, 80))
                .await
        }
    };
    h.send(&a.id, story).await?;
    mid_reply().await?;
    ensure(
        cmd::agents_stop(a.id.clone()).await.unwrap_or(false),
        "stop found nothing to stop",
    )?;
    h.turn(&a.id).await?;
    let kept = of_kind(&a.id, MessageKind::Agent);
    if codex {
        ensure(
            of_kind(&a.id, MessageKind::Note)
                .iter()
                .any(|n| n.text == "Stopped"),
            "no Stopped note",
        )?;
        ensure(kept.is_empty(), "a stopped Codex turn still replied")?;
    } else {
        ensure(
            kept.last().is_some_and(|m| m.stopped && m.text.len() >= 40),
            "the partial reply wasn't kept as stopped",
        )?;
    }
    h.send(&a.id, "Reply with just: ready").await?;
    h.turn(&a.id).await?;
    ensure(last_reply(&a.id).contains("ready"), "no turn after Stop")?;

    h.drafts.lock().unwrap().clear();
    h.send(&a.id, story).await?;
    mid_reply().await?;
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
        codex
            || of_kind(&a.id, MessageKind::Agent)
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
    cmd::agents_answer_approval(h.app.clone(), a.id.clone(), c.request_id, true, None, None)
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
    cmd::agents_answer_approval(h.app.clone(), a.id.clone(), c.request_id, true, None, None)
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
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        c.request_id,
        true,
        Some(true),
        None,
    )
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

    // Deny with a note: the command doesn't run and the agent reads the note.
    h.send(&a.id, "Run: python3 -c 'open(\"denied.txt\",\"w\")'")
        .await?;
    let c = card(h, &a.id, 3).await?;
    cmd::agents_answer_approval(
        h.app.clone(),
        a.id.clone(),
        c.request_id,
        false,
        None,
        Some("Don't run it. Reply with just the word: understood".into()),
    )
    .await
    .map_err(|e| e.to_string())?;
    h.turn(&a.id).await?;
    ensure(!home.join("denied.txt").exists(), "the denied command ran")?;
    ensure(
        last_reply(&a.id).to_lowercase().contains("understood"),
        format!("deny note not read: {:?}", last_reply(&a.id)),
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
  edit-then-fail)
    cat > /dev/null
    echo "half done" > half.txt
    echo '{"type":"system","subtype":"init","session_id":"0f0f0f0f-0000-4000-8000-000000000002"}'
    exit 1 ;;
  error-result)
    cat > /dev/null
    echo '{"type":"result","subtype":"error_during_execution","is_error":true}'
    exit 1 ;;
esac
"#;

/// (7) A bound agent runs in its project and leaves a change card listing
/// only what it changed; a turn that edits then fails still gets its card,
/// before the error line that tags the agent's failure.
async fn project_agent(h: &H) -> Check {
    let dir = git_project(h, "site");
    let a = bound_agent(h, "Builder", "site").await?;
    ensure(
        a.project.as_deref() == Some(dir.to_str().unwrap()),
        format!("bound to {:?}, not {}", a.project, dir.display()),
    )?;
    h.send(
        &a.id,
        "Create a file named hello.txt in the current directory containing exactly: hi. Then run pwd and reply with just its output.",
    )
    .await?;
    h.turn(&a.id).await?;
    no_errors(&a.id)?;
    let hello = std::fs::read_to_string(dir.join("hello.txt")).unwrap_or_default();
    ensure(
        hello.trim() == "hi",
        format!("hello.txt in the project: {hello:?}"),
    )?;
    ensure(
        last_reply(&a.id).contains(dir.to_str().unwrap()),
        format!("didn't run in the project: {:?}", last_reply(&a.id)),
    )?;
    let cards = of_kind(&a.id, MessageKind::Changes);
    let card = cards.last().ok_or("no change card")?;
    let summary = card.changes.as_ref().ok_or("card without a summary")?;
    let paths: Vec<&str> = summary.files.iter().map(|f| f.path.as_str()).collect();
    ensure(
        cards.len() == 1 && summary.file_count == 1 && paths == ["hello.txt"],
        format!("card lists {paths:?} ({} cards)", cards.len()),
    )?;
    ensure(
        summary.files[0].status == "added",
        format!("hello.txt is {:?}", summary.files[0].status),
    )?;
    ensure(
        card.text == "Changed 1 file in site",
        format!("card text {:?}", card.text),
    )?;

    // A turn that changes a file and then fails: card, then the error line.
    let real_path = fake_cli(h);
    std::env::set_var("FAKE_CLAUDE_MODE", "edit-then-fail");
    let failed = async {
        h.send(&a.id, "Do the other half.").await?;
        h.turn(&a.id).await
    }
    .await;
    std::env::remove_var("FAKE_CLAUDE_MODE");
    std::env::set_var("PATH", real_path);
    failed?;
    let tail: Vec<AgentMessage> = log(&a.id).into_iter().rev().take(2).collect();
    ensure(
        tail.len() == 2
            && tail[0].kind == MessageKind::Error
            && tail[1].kind == MessageKind::Changes
            && tail[1]
                .changes
                .as_ref()
                .is_some_and(|c| c.files.iter().map(|f| f.path.as_str()).eq(["half.txt"])),
        format!(
            "failed turn ended {:?}",
            tail.iter().map(|m| (&m.kind, &m.text)).collect::<Vec<_>>()
        ),
    )?;
    human(&tail[0].text)?;
    ensure(tail[0].failure.is_some(), "error line not tagged")?;
    ensure(
        store::get(&a.id).unwrap().failure.is_some(),
        "agent not marked as failed",
    )?;
    // The bogus session from the fake must not stick, and a good turn clears the failure.
    h.send(&a.id, "Reply with just: ok").await?;
    h.turn(&a.id).await?;
    ensure(
        last_reply(&a.id).to_lowercase().contains("ok"),
        format!("no recovery: {:?}", last_reply(&a.id)),
    )?;
    ensure(
        store::get(&a.id).unwrap().failure.is_none(),
        "failure not cleared by the next reply",
    )
}

/// (8) Malformed output, a crash, a bare error code: a clean error, nothing stuck.
async fn cli_failures(h: &H) -> Check {
    let real_path = fake_cli(h);

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

const ALL: [&str; 16] = [
    "memory",
    "restart",
    "lost-session",
    "project",
    "delegation",
    "stop",
    "approvals",
    "cli-failures",
    "corrupt-store",
    "burst",
    "stop-tree",
    "quit",
    "slots",
    "codex-memory",
    "codex-stop",
    "codex-delegation",
];

/// What the Codex scenarios run on: the signed-in account, a scripted model,
/// or nothing (they're skipped). Decided before HOME is swapped.
#[derive(Clone, Copy, PartialEq, Debug)]
enum CodexMode {
    Real,
    Scripted,
    Skip,
}

fn codex_mode(real_home: &Path) -> CodexMode {
    match std::env::var("AGENTS_E2E_CODEX").as_deref() {
        Ok("real") => return CodexMode::Real,
        Ok("scripted") => return CodexMode::Scripted,
        Ok("skip") => return CodexMode::Skip,
        _ => {}
    }
    let signed_in = std::process::Command::new("codex")
        .args(["login", "status"])
        .env("HOME", real_home)
        .output()
        .is_ok_and(|o| o.status.success());
    let python = std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    match (signed_in, python) {
        (true, _) => CodexMode::Real,
        (false, true) => CodexMode::Scripted,
        (false, false) => CodexMode::Skip,
    }
}

/// The rules the scripted model follows for the Codex scenarios.
const CODEX_RULES: &str = r#"[
 {"match": "My favourite number is", "steps": [{"text": "noted"}]},
 {"match": "What is my favourite number", "steps": [{"recall": "favourite number is (\\d+)"}]},
 {"match": "Forget the story", "steps": [{"text": "switched"}]},
 {"match": "Write a 600-word story", "steps": [{"sleep": 90}, {"text": "Once upon a time."}]},
 {"match": "Reply with just: ready", "steps": [{"text": "ready"}]},
 {"match": "Reply with just: echo-ok", "steps": [{"text": "echo-ok"}]},
 {"match": "Use message_agent to ask Scout", "steps": [{"call": "message_agent", "args": {"agent": "Scout", "message": "What is 6 times 7? Reply to Chief of Staff with message_agent."}}], "then": "Asked Scout."},
 {"match": "What is 6 times 7", "steps": [{"call": "message_agent", "args": {"agent": "Chief of Staff", "message": "42"}}], "then": "Sent."},
 {"match": "Message from Scout", "steps": [{"text": "Scout says 42."}]},
 {"match": "then tell me what the tool said", "steps": [{"call": "message_agent", "args": {"agent": "Chief of Staff", "message": "ping"}}], "then": "The tool refused it."}
]"#;

/// Codex's own folder for the run: the account copied in (real), or the
/// scripted model started and Codex pointed at it.
fn codex_setup(mode: CodexMode, real_home: &Path, home: &Path) -> Option<std::process::Child> {
    let theirs = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| real_home.join(".codex"));
    let codex_home = home.join(".codex");
    std::fs::create_dir_all(&codex_home).unwrap();
    std::env::set_var("CODEX_HOME", &codex_home);
    match mode {
        CodexMode::Real => {
            for file in ["auth.json", "models_cache.json"] {
                let _ = std::fs::copy(theirs.join(file), codex_home.join(file));
            }
            None
        }
        CodexMode::Scripted => {
            let port = 18_000 + (std::process::id() % 1000) as u16;
            let rules = home.join("codex-rules.json");
            std::fs::write(&rules, CODEX_RULES).unwrap();
            let script =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/agents-e2e-codex-model.py");
            let child = std::process::Command::new("python3")
                .arg("-I")
                .arg(script)
                .arg(port.to_string())
                .arg(&rules)
                .arg(home.join("codex-model.jsonl"))
                .spawn()
                .expect("start the scripted model");
            std::thread::sleep(Duration::from_millis(500));
            std::env::set_var(
                "SHIPSTUDIO_AGENTS_CODEX_CONFIG",
                format!(
                    "model_provider=\"scripted\"\nmodel=\"scripted\"\nmodel_providers.scripted={{name=\"scripted\",base_url=\"http://127.0.0.1:{port}/v1\",wire_api=\"responses\",supports_websockets=false,request_max_retries=0,stream_max_retries=0}}"
                ),
            );
            Some(child)
        }
        CodexMode::Skip => None,
    }
}

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
    let args: Vec<String> = std::env::args().skip(1).collect();
    let wants_codex = args.is_empty() || args.iter().any(|a| a.starts_with("codex-"));
    let codex = if wants_codex {
        codex_mode(&real_home)
    } else {
        CodexMode::Skip
    };
    let mut scripted_model = codex_setup(codex, &real_home, &home);
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

    if args.first().map(String::as_str) == Some("--phase") {
        tauri::async_runtime::block_on(async {
            match args[1].as_str() {
                "restart-a" => restart_phase_a(&h).await,
                "quit" => quit_phase(&h).await,
                "slots" => match slots_phase(&h).await {
                    Ok(()) => println!("OK"),
                    Err(e) => {
                        println!("{e}");
                        std::process::exit(1);
                    }
                },
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
    if wants_codex {
        println!("Codex scenarios: {codex:?}");
    }
    let started = Instant::now();
    let mut failed = 0;
    tauri::async_runtime::block_on(async {
        for name in wanted {
            let (t, c) = (Instant::now(), cost());
            let on_codex = name.strip_prefix("codex-");
            if on_codex.is_some() && codex == CodexMode::Skip {
                println!("SKIP  {name:<16} Codex isn't signed in and there's no python3 for the scripted model");
                continue;
            }
            *h.engine.lock().unwrap() = if on_codex.is_some() {
                Engine::Codex
            } else {
                Engine::Claude
            };
            let result = match on_codex.unwrap_or(name) {
                "memory" => memory(&h).await,
                "restart" => restart(&h).await,
                "lost-session" => lost_session(&h).await,
                "project" => project_agent(&h).await,
                "delegation" => delegation(&h).await,
                "stop" => stop(&h).await,
                "approvals" => approvals_scenario(&h).await,
                "cli-failures" => cli_failures(&h).await,
                "corrupt-store" => corrupt_store(&h).await,
                "burst" => burst(&h).await,
                "stop-tree" => stop_tree(&h).await,
                "quit" => quit(&h).await,
                "slots" => slots(&h).await,
                other => Err(format!("unknown scenario {other}")),
            };
            let took = t.elapsed().as_secs();
            let spent = cost() - c;
            match result {
                Ok(()) => println!("PASS  {name:<16} {took:>4}s  ${spent:.3}"),
                Err(e) => {
                    failed += 1;
                    println!("FAIL  {name:<16} {took:>4}s  ${spent:.3}  {e}");
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
    if let Some(model) = scripted_model.as_mut() {
        let _ = model.kill();
    }
    if std::env::var("AGENTS_E2E_KEEP").is_err() {
        let _ = std::fs::remove_dir_all(&home);
    }
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
