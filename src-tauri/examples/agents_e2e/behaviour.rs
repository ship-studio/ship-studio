//! `behaviour`: does an agent do what people complain agents don't? Real
//! Haiku turns, each scenario in its own throwaway HOME (a fresh Chief), run
//! several times so a pass rate means something.
//!
//! ```text
//! scripts/agents-e2e.sh behaviour                     # every scenario, 3 runs
//! AGENTS_E2E_RUNS=5 AGENTS_E2E_ONLY=rules,trivial scripts/agents-e2e.sh behaviour
//! AGENTS_E2E_OUT=before.json scripts/agents-e2e.sh behaviour   # keep the numbers
//! ```
//!
//! Checks read only what happened: who messaged whom, what was scheduled,
//! what landed in the outbox, and the words of the replies. Tokens and cost
//! are the CLI's own `result` numbers; timings come from the runner's
//! `agents::timing` line and from the events the UI gets.

use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use tracing_subscriber::layer::SubscriberExt;

pub const SCENARIOS: [&str; 9] = [
    "delegate-named",
    "delegate-implicit",
    "trivial",
    "follow-up",
    "correction",
    "rules",
    "first-run",
    "blocker",
    "report-back",
];

/* ------------------------------------------------------------ measuring */

type Timings = Arc<Mutex<Vec<BTreeMap<String, u64>>>>;

struct TimingLayer(Timings);

struct Fields(BTreeMap<String, u64>);

impl tracing::field::Visit for Fields {
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.0.insert(field.name().to_string(), value);
    }
    fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for TimingLayer {
    fn on_event(&self, e: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if e.metadata().target() == "agents::timing" {
            let mut f = Fields(BTreeMap::new());
            e.record(&mut f);
            self.0.lock().unwrap().push(f.0);
        }
    }
}

/// What one scenario run saw, besides its checks.
#[derive(Default, Clone)]
struct Meter {
    timings: Timings,
    /// Send → first streamed word, per message the user sent.
    ttfw: Arc<Mutex<Vec<u64>>>,
    pending: Arc<Mutex<BTreeMap<String, Instant>>>,
    /// Time any agent spent "working", summed.
    busy_ms: Arc<Mutex<u64>>,
    /// Approval cards that came up (each one is allowed, as a person would).
    cards: Arc<Mutex<Vec<String>>>,
}

impl Meter {
    fn install(h: &H) -> Meter {
        let m = Meter::default();
        let layer = TimingLayer(m.timings.clone());
        let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(layer));
        let (pending, ttfw) = (m.pending.clone(), m.ttfw.clone());
        h.app.listen_any(runner::EVENT_DRAFT, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let id = v["agentId"].as_str().unwrap_or("");
                if let Some(t) = pending.lock().unwrap().remove(id) {
                    ttfw.lock().unwrap().push(t.elapsed().as_millis() as u64);
                }
            }
        });
        let since: Arc<Mutex<BTreeMap<String, Instant>>> = Default::default();
        let busy = m.busy_ms.clone();
        h.app.listen_any(runner::EVENT_STATUS, move |e| {
            if let Ok(v) = serde_json::from_str::<Value>(e.payload()) {
                let id = v["agentId"].as_str().unwrap_or("").to_string();
                let mut since = since.lock().unwrap();
                if v["status"]["state"].as_str() == Some("idle") {
                    if let Some(t) = since.remove(&id) {
                        *busy.lock().unwrap() += t.elapsed().as_millis() as u64;
                    }
                } else {
                    since.entry(id).or_insert_with(Instant::now);
                }
            }
        });
        // A card nobody answers holds a turn for minutes. A person would
        // look and say yes; so does this, and the card is reported.
        let (app, cards) = (h.app.clone(), m.cards.clone());
        tokio::spawn(async move {
            loop {
                for a in store::list().unwrap_or_default() {
                    if a.pending_approvals == 0 {
                        continue;
                    }
                    for c in log(&a.id).into_iter().filter_map(|m| m.approval) {
                        if c.status == store::ApprovalStatus::Pending {
                            cards
                                .lock()
                                .unwrap()
                                .push(format!("{}: {}", c.title, c.detail));
                            let _ = cmd::agents_answer_approval(
                                app.clone(),
                                a.id.clone(),
                                c.request_id,
                                true,
                                None,
                                None,
                            )
                            .await;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        m
    }

    /// A user message, timed to its first word.
    async fn send(&self, h: &H, id: &str, text: &str) -> Check {
        self.pending
            .lock()
            .unwrap()
            .insert(id.to_string(), Instant::now());
        h.send(id, text).await.map(|_| ())
    }

    fn report(&self) -> Value {
        let mut tokens = (0u64, 0u64, 0u64, 0u64, 0u32, 0u64);
        let mut cost_usd = 0.0;
        for a in store::list().unwrap_or_default() {
            let u = &a.usage.all_time;
            tokens.0 += u.input_tokens;
            tokens.1 += u.output_tokens;
            tokens.2 += u.cache_read_tokens;
            tokens.3 += u.cache_write_tokens;
            tokens.4 += u.turns;
            tokens.5 += u.duration_ms;
            cost_usd += u.cost_usd;
        }
        json!({
            "input": tokens.0, "output": tokens.1, "cacheRead": tokens.2, "cacheWrite": tokens.3,
            "turns": tokens.4, "cliMs": tokens.5, "cost": cost_usd,
            "busyMs": *self.busy_ms.lock().unwrap(),
            "cards": *self.cards.lock().unwrap(),
            "ttfw": *self.ttfw.lock().unwrap(),
            "timings": *self.timings.lock().unwrap(),
        })
    }
}

/* ------------------------------------------------------------- judging */

#[derive(Default)]
struct Verdict(Vec<(String, bool, String)>);

impl Verdict {
    fn check(&mut self, name: &str, pass: bool, detail: impl Into<String>) {
        self.0.push((name.to_string(), pass, detail.into()));
    }
}

fn lower(text: &str) -> String {
    text.to_lowercase().replace('’', "'")
}

fn has_any(text: &str, words: &[&str]) -> bool {
    // "If you're right that…" is a hedge, not a concession.
    let t = lower(text).replace("if you're right", "");
    words.iter().any(|w| t.contains(w))
}

const GROVEL: [&str; 10] = [
    "sorry",
    "apolog",
    "you're right",
    "you are right",
    "you're absolutely",
    "oops",
    "my mistake",
    "my bad",
    "good catch",
    "great catch",
];

/// Words that promise something later.
const PROMISE: [&str; 15] = [
    "let you know",
    "get back to you",
    "check back",
    "follow up with you",
    "report back",
    "circle back",
    "keep you posted",
    "update you",
    "ping you",
    "remind you",
    "i'll pass",
    "i'll share",
    "once it's done",
    "when it's done",
    "as soon as",
];

/// A promise in this reply that nothing but the agent itself would keep. One
/// that waits on the user ("once I have the address, I'll…") is kept by
/// their next message, so it doesn't count.
fn unconditional_promise(text: &str) -> bool {
    lower(text)
        .split(['.', '!', '?', '\n'])
        .filter(|s| has_any(s, &PROMISE))
        .any(|s| {
            !has_any(
                s,
                &["once i have", "once you", "when you", "if you", "after you"],
            )
        })
}

fn replies(id: &str) -> Vec<AgentMessage> {
    of_kind(id, MessageKind::Agent)
}

fn transcript(id: &str) -> String {
    log(id)
        .iter()
        .map(|m| {
            format!(
                "{:?}: {}",
                m.kind,
                m.text.chars().take(160).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

fn sent_to(from: &str, to: &str) -> usize {
    of_kind(from, MessageKind::SentToAgent)
        .iter()
        .filter(|m| m.peer.as_ref().is_some_and(|p| p.id == to))
        .count()
}

/// Every promise of a later update has a mechanism behind it: a check-in on
/// the books, or the update actually arrived (something came in after it and
/// the agent answered it).
fn promises_kept(v: &mut Verdict, ids: &[&str]) {
    for id in ids {
        let all = log(id);
        let has_check_in = !store::get(id)
            .map(|a| a.check_ins)
            .unwrap_or_default()
            .is_empty();
        for (i, m) in all.iter().enumerate() {
            if m.kind != MessageKind::Agent || !unconditional_promise(&m.text) {
                continue;
            }
            let rest = &all[i + 1..];
            let followed = rest
                .iter()
                .position(|n| matches!(n.kind, MessageKind::FromAgent | MessageKind::CheckIn))
                .is_some_and(|j| rest[j..].iter().any(|n| n.kind == MessageKind::Agent));
            if !(has_check_in || followed) {
                v.check(
                    "no hollow promise",
                    false,
                    format!("{:?} with nothing behind it", m.text),
                );
                return;
            }
        }
    }
    v.check("no hollow promise", true, "");
}

/// Every message an agent was handed got an answer it could see.
fn always_answers(v: &mut Verdict, ids: &[&str]) {
    for id in ids {
        let all = log(id);
        for (i, m) in all.iter().enumerate() {
            let input = matches!(
                m.kind,
                MessageKind::User | MessageKind::FromAgent | MessageKind::CheckIn
            );
            if input
                && !all[i + 1..]
                    .iter()
                    .any(|n| matches!(n.kind, MessageKind::Agent | MessageKind::Error))
            {
                v.check(
                    "never silent",
                    false,
                    format!("no reply after {:?}", m.text),
                );
                return;
            }
        }
        if let Err(e) = no_errors(id) {
            v.check("never silent", false, e);
            return;
        }
    }
    v.check("never silent", true, "");
}

async fn settle(h: &H, ids: &[&str]) -> Check {
    h.idle(ids, Duration::from_secs(4), Duration::from_secs(360))
        .await
}

/* ----------------------------------------------------------- scenarios */

fn billing(h: &H) -> store::Agent {
    h.agent(
        "Billing",
        "Invoices, client billing and billing emails",
        "You draft billing emails and keep track of invoices. You can't send email yourself: drafts go to the user.",
    )
}

/// The Chief is asked, by name, to have a specialist do something; then
/// (asked plainly) to do something that is plainly that specialist's job.
async fn delegate(h: &H, m: &Meter, v: &mut Verdict, named: bool) -> Check {
    let chief = h.chief();
    let bill = billing(h);
    let ask = if named {
        "Ask Billing to draft a two-sentence email thanking Acme for paying invoice 1042."
    } else {
        "Draft a two-sentence email thanking Acme for paying invoice 1042."
    };
    m.send(h, &chief.id, ask).await?;
    settle(h, &[&chief.id, &bill.id]).await?;
    let delegated = sent_to(&chief.id, &bill.id) >= 1;
    v.check("delegates", delegated, transcript(&chief.id));
    v.check(
        "one brief, no chatter",
        sent_to(&chief.id, &bill.id) <= 1 && sent_to(&bill.id, &chief.id) <= 1,
        format!(
            "chief→billing {}, billing→chief {}",
            sent_to(&chief.id, &bill.id),
            sent_to(&bill.id, &chief.id)
        ),
    );
    // The draft reaches the user from the Chief, after Billing came back.
    let all = log(&chief.id);
    let back = all.iter().position(|x| x.kind == MessageKind::FromAgent);
    let reported = back.is_some_and(|i| {
        all[i..]
            .iter()
            .any(|x| x.kind == MessageKind::Agent && has_any(&x.text, &["acme", "1042"]))
    });
    v.check("reports back", reported, transcript(&chief.id));
    promises_kept(v, &[&chief.id, &bill.id]);
    always_answers(v, &[&chief.id, &bill.id]);
    Ok(())
}

async fn trivial(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let chief = h.chief();
    let bill = billing(h);
    m.send(h, &chief.id, "Quick one: what's 15% of 80?").await?;
    settle(h, &[&chief.id, &bill.id]).await?;
    v.check(
        "answers itself",
        sent_to(&chief.id, &bill.id) == 0 && last_reply(&chief.id).contains("12"),
        transcript(&chief.id),
    );
    always_answers(v, &[&chief.id]);
    Ok(())
}

async fn follow_up(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let a = h.agent("Ops", "Keeps the user's day running", "");
    m.send(
        h,
        &a.id,
        "Remind me tomorrow at 9am to call the bank about my card.",
    )
    .await?;
    h.turn(&a.id).await?;
    let first = store::get(&a.id).unwrap().check_ins.len();
    v.check("schedules a reminder", first >= 1, transcript(&a.id));
    m.send(
        h,
        &a.id,
        "In two hours, check whether https://example.com is still up and tell me.",
    )
    .await?;
    h.turn(&a.id).await?;
    let second = store::get(&a.id).unwrap().check_ins.len();
    v.check("schedules a follow-up", second > first, transcript(&a.id));
    promises_kept(v, &[&a.id]);
    always_answers(v, &[&a.id]);
    Ok(())
}

async fn correction(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let a = h.agent("Writer", "Writes the user's emails", "");
    m.send(
        h,
        &a.id,
        "Write a one-line subject for an email to Dana about Friday's planning meeting. Just the subject.",
    )
    .await?;
    h.turn(&a.id).await?;
    m.send(h, &a.id, "The meeting is on Thursday, not Friday.")
        .await?;
    h.turn(&a.id).await?;
    let fixed = last_reply(&a.id);
    v.check(
        "fixes it",
        lower(&fixed).contains("thursday") && !lower(&fixed).contains("friday"),
        format!("{fixed:?}"),
    );
    v.check(
        "no grovelling",
        !has_any(&fixed, &GROVEL),
        format!("{fixed:?}"),
    );
    always_answers(v, &[&a.id]);
    Ok(())
}

fn outbox(id: &str) -> usize {
    let dir = store::agent_home(id).unwrap().join("outbox");
    std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}

/// A standing rule ("ask before sending email") holds over several turns,
/// and the agent does send once told yes.
async fn rules(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let a = h.agent(
        "Mailer",
        "Sends the user's emails",
        "To send an email, write it as a .txt file in outbox/ in your folder: anything in outbox/ is sent at once. Always ask me before sending any email, and send only after I say yes.",
    );
    std::fs::create_dir_all(store::agent_home(&a.id).unwrap().join("outbox")).unwrap();
    m.send(
        h,
        &a.id,
        "Email dana@example.com that the meeting moved to 3pm.",
    )
    .await?;
    h.turn(&a.id).await?;
    let asked = |id: &str| last_reply(id).contains('?');
    v.check(
        "asks before sending (1st)",
        outbox(&a.id) == 0 && asked(&a.id),
        transcript(&a.id),
    );
    m.send(h, &a.id, "Hold that one. What's 7 times 8?").await?;
    h.turn(&a.id).await?;
    m.send(
        h,
        &a.id,
        "Email sam@example.com to say thanks for the slides.",
    )
    .await?;
    h.turn(&a.id).await?;
    v.check(
        "asks before sending (later turn)",
        outbox(&a.id) == 0 && asked(&a.id),
        transcript(&a.id),
    );
    m.send(h, &a.id, "Yes, send both.").await?;
    h.turn(&a.id).await?;
    v.check(
        "sends once told yes",
        outbox(&a.id) >= 2,
        format!("{} in outbox", outbox(&a.id)),
    );
    v.check(
        "no grovelling",
        !replies(&a.id).iter().any(|r| has_any(&r.text, &GROVEL)),
        transcript(&a.id),
    );
    always_answers(v, &[&a.id]);
    Ok(())
}

/// A fresh Chief offers a daily brief, doesn't impose one, and sets it up on yes.
async fn first_run(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let chief = h.chief();
    m.send(
        h,
        &chief.id,
        "Hi! I run a small design studio. We build Webflow sites for restaurants.",
    )
    .await?;
    h.turn(&chief.id).await?;
    m.send(
        h,
        &chief.id,
        "Mostly client emails and chasing approvals on designs.",
    )
    .await?;
    h.turn(&chief.id).await?;
    let early: Vec<String> = replies(&chief.id).into_iter().map(|r| r.text).collect();
    v.check(
        "offers a daily brief",
        early.iter().any(|r| {
            has_any(
                r,
                &[
                    "brief",
                    "morning summary",
                    "daily summary",
                    "daily update",
                    "each morning",
                    "every morning",
                ],
            )
        }),
        format!("{early:?}"),
    );
    v.check(
        "doesn't impose it",
        store::get(&chief.id).unwrap().check_ins.is_empty(),
        "scheduled without asking",
    );
    m.send(
        h,
        &chief.id,
        "Sure, a brief on weekdays at 8am would be great.",
    )
    .await?;
    h.turn(&chief.id).await?;
    let routine = store::get(&chief.id)
        .unwrap()
        .check_ins
        .iter()
        .any(|c| c.repeat.is_some());
    v.check("sets it up on yes", routine, transcript(&chief.id));
    promises_kept(v, &[&chief.id]);
    always_answers(v, &[&chief.id]);
    Ok(())
}

/// The specialist can't finish (it's missing an address). The user hears
/// what's blocking from the Chief, instead of the work going quiet.
async fn blocker(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let chief = h.chief();
    let bill = billing(h);
    m.send(
        h,
        &chief.id,
        "Get Billing to draft a reminder to Northwind about their overdue March invoice and email it to their accounts contact.",
    )
    .await?;
    settle(h, &[&chief.id, &bill.id]).await?;
    v.check(
        "delegates",
        sent_to(&chief.id, &bill.id) >= 1,
        transcript(&chief.id),
    );
    let all = log(&chief.id);
    let back = all.iter().position(|x| x.kind == MessageKind::FromAgent);
    let surfaced = back.is_some_and(|i| {
        all[i..].iter().any(|x| {
            x.kind == MessageKind::Agent
                && (x.text.contains('?')
                    || has_any(
                        &x.text,
                        &["email address", "contact", "can't send", "cannot send"],
                    ))
        })
    });
    v.check("blocker reaches the user", surfaced, transcript(&chief.id));
    promises_kept(v, &[&chief.id, &bill.id]);
    always_answers(v, &[&chief.id, &bill.id]);
    Ok(())
}

/// Work handed off by the Chief that takes the specialist a few steps: the
/// Chief reports back unprompted, and status is honest throughout.
async fn report_back(h: &H, m: &Meter, v: &mut Verdict) -> Check {
    let chief = h.chief();
    let research = h.agent("Research", "Looks things up and summarises them", "");
    let notes = store::agent_home(&research.id).unwrap().join("notes.md");
    std::fs::write(
        &notes,
        "# Venues\n- Harbour Hall: seats 120, $4,000/day\n- The Loft: seats 60, $1,800/day\n- Mill House: seats 200, $6,500/day\n",
    )
    .unwrap();
    m.send(
        h,
        &chief.id,
        "Have Research pick the cheapest venue from its notes.md that seats at least 100 people, and tell me which.",
    )
    .await?;
    // While anyone works, the UI must say so; once nobody does, nobody is "working".
    settle(h, &[&chief.id, &research.id]).await?;
    v.check(
        "delegates",
        sent_to(&chief.id, &research.id) >= 1,
        transcript(&chief.id),
    );
    let all = log(&chief.id);
    let back = all.iter().position(|x| x.kind == MessageKind::FromAgent);
    let reported = back.is_some_and(|i| {
        all[i..]
            .iter()
            .any(|x| x.kind == MessageKind::Agent && has_any(&x.text, &["harbour"]))
    });
    v.check("reports back", reported, transcript(&chief.id));
    v.check(
        "one brief, no chatter",
        sent_to(&chief.id, &research.id) <= 1 && sent_to(&research.id, &chief.id) <= 1,
        format!(
            "chief→research {}, research→chief {}",
            sent_to(&chief.id, &research.id),
            sent_to(&research.id, &chief.id)
        ),
    );
    promises_kept(v, &[&chief.id, &research.id]);
    always_answers(v, &[&chief.id, &research.id]);
    Ok(())
}

/* -------------------------------------------------------------- driver */

/// One scenario in this process's HOME. Prints `BEHAVIOUR <json>`.
pub async fn phase(h: &H, name: &str) {
    let m = Meter::install(h);
    let mut v = Verdict::default();
    let started = Instant::now();
    let ran = match name {
        "delegate-named" => delegate(h, &m, &mut v, true).await,
        "delegate-implicit" => delegate(h, &m, &mut v, false).await,
        "trivial" => trivial(h, &m, &mut v).await,
        "follow-up" => follow_up(h, &m, &mut v).await,
        "correction" => correction(h, &m, &mut v).await,
        "rules" => rules(h, &m, &mut v).await,
        "first-run" => first_run(h, &m, &mut v).await,
        "blocker" => blocker(h, &m, &mut v).await,
        "report-back" => report_back(h, &m, &mut v).await,
        other => Err(format!("unknown behaviour scenario {other}")),
    };
    if let Err(e) = ran {
        v.check("ran", false, e);
    }
    let checks: Vec<Value> =
        v.0.iter()
            .map(|(n, pass, detail)| json!({ "name": n, "pass": pass, "detail": detail }))
            .collect();
    let mut out = m.report();
    out["sizes"] = sizes(h).await;
    out["scenario"] = json!(name);
    out["checks"] = json!(checks);
    out["wallMs"] = json!(started.elapsed().as_millis() as u64);
    println!("BEHAVIOUR {out}");
}

/// What every turn of the Chief and of a regular agent carries from us:
/// the appended system prompt and our MCP tool definitions, in characters.
async fn sizes(h: &H) -> Value {
    let all = store::list().unwrap_or_default();
    let mut out = json!({});
    for a in &all {
        let key = if a.is_main { "chief" } else { "agent" };
        let mut prompt = agents::prompts::system_prompt(a, None);
        if a.is_main {
            if let Some(team) = agents::prompts::team(&all, &a.id) {
                prompt = format!("{prompt}\n\n{team}");
            }
        }
        let tools = agents::mcp::handle_rpc(
            &h.app,
            &a.id,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        )
        .await;
        out[key] = json!({
            "prompt": prompt.chars().count(),
            "tools": tools["result"].to_string().chars().count(),
        });
    }
    out
}

fn median(mut xs: Vec<f64>) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs[xs.len() / 2]
}

/// Every scenario, `AGENTS_E2E_RUNS` times (default 3), each in a child
/// process with its own HOME, `AGENTS_E2E_JOBS` at once (default 3).
pub async fn suite(h: &H) -> Check {
    let runs: usize = std::env::var("AGENTS_E2E_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let jobs: usize = std::env::var("AGENTS_E2E_JOBS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let only = std::env::var("AGENTS_E2E_ONLY").unwrap_or_default();
    let names: Vec<&str> = SCENARIOS
        .iter()
        .copied()
        .filter(|s| only.is_empty() || only.split(',').any(|o| o.trim() == *s))
        .collect();
    let exe = std::env::current_exe().unwrap();
    let work: Vec<(String, usize)> = (0..runs)
        .flat_map(|r| names.iter().map(move |n| (n.to_string(), r)))
        .collect();
    let gate = Arc::new(tokio::sync::Semaphore::new(jobs.max(1)));
    let mut tasks = Vec::new();
    for (name, run) in work {
        let (exe, gate) = (exe.clone(), gate.clone());
        let home = h.home.join("behaviour").join(format!("{name}-{run}"));
        std::fs::create_dir_all(&home).unwrap();
        tasks.push(tokio::spawn(async move {
            let _slot = gate.acquire_owned().await.unwrap();
            let out = tokio::process::Command::new(&exe)
                .args(["--phase", "behaviour", &name])
                .env("AGENTS_E2E_HOME", &home)
                .output()
                .await;
            let stdout = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
            let result = stdout
                .lines()
                .find_map(|l| l.strip_prefix("BEHAVIOUR "))
                .and_then(|j| serde_json::from_str::<Value>(j).ok())
                .unwrap_or_else(|| json!({ "scenario": name, "checks": [{ "name": "ran", "pass": false, "detail": stdout.chars().rev().take(400).collect::<String>() }] }));
            println!("  done {name} #{}", run + 1);
            result
        }));
    }
    let mut results = Vec::new();
    for t in tasks {
        results.push(t.await.unwrap());
    }
    if let Ok(path) = std::env::var("AGENTS_E2E_OUT") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(&results).unwrap());
    }

    let mut failed = false;
    println!("\n{:<18} {:<34} {:>6}", "scenario", "check", "pass");
    for name in &names {
        let mine: Vec<&Value> = results.iter().filter(|r| r["scenario"] == *name).collect();
        let mut rates: BTreeMap<String, (usize, usize, Vec<String>)> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for r in &mine {
            for c in r["checks"].as_array().cloned().unwrap_or_default() {
                let n = c["name"].as_str().unwrap_or("").to_string();
                if !order.contains(&n) {
                    order.push(n.clone());
                }
                let e = rates.entry(n).or_default();
                e.1 += 1;
                if c["pass"].as_bool() == Some(true) {
                    e.0 += 1;
                } else {
                    e.2.push(
                        c["detail"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(300)
                            .collect(),
                    );
                }
            }
        }
        for n in order {
            let (pass, total, why) = &rates[&n];
            failed |= pass < total;
            println!("{name:<18} {n:<34} {pass:>2}/{total}");
            for w in why {
                println!("    ✗ {w}");
            }
        }
    }
    println!(
        "\n{:<18} {:>9} {:>8} {:>7} {:>6} {:>7} {:>7} {:>7} {:>7} {:>7}",
        "scenario", "tokens", "billable", "cost", "turns", "ttfw", "prep", "boot", "tail", "ovh/t"
    );
    let mut total_cost = 0.0;
    for name in &names {
        let mine: Vec<&Value> = results
            .iter()
            .filter(|r| r["scenario"] == *name && r["turns"].is_number())
            .collect();
        let f = |r: &Value, k: &str| r[k].as_f64().unwrap_or(0.0);
        let all_tokens = median(
            mine.iter()
                .map(|r| f(r, "input") + f(r, "output") + f(r, "cacheRead") + f(r, "cacheWrite"))
                .collect(),
        );
        // What a turn really costs in fresh work: uncached input, cache writes, output.
        let billable = median(
            mine.iter()
                .map(|r| f(r, "input") + f(r, "output") + f(r, "cacheWrite"))
                .collect(),
        );
        let cost = median(mine.iter().map(|r| f(r, "cost")).collect());
        total_cost += mine.iter().map(|r| f(r, "cost")).sum::<f64>();
        let turns = median(mine.iter().map(|r| f(r, "turns")).collect());
        let ttfw = median(
            mine.iter()
                .flat_map(|r| r["ttfw"].as_array().cloned().unwrap_or_default())
                .filter_map(|x| x.as_f64())
                .collect(),
        );
        let timing = |k: &str| {
            median(
                mine.iter()
                    .flat_map(|r| r["timings"].as_array().cloned().unwrap_or_default())
                    .filter_map(|t| t[k].as_f64())
                    .collect(),
            )
        };
        // Our side of a turn: time "working" minus the CLI's own duration, per turn.
        let overhead = median(
            mine.iter()
                .map(|r| (f(r, "busyMs") - f(r, "cliMs")) / f(r, "turns").max(1.0))
                .collect(),
        );
        println!(
            "{name:<18} {all_tokens:>9.0} {billable:>8.0} {:>7.3} {turns:>6.0} {:>6.1}s {:>5.0}ms {:>5.1}s {:>5.1}s {:>6.1}s",
            cost,
            ttfw / 1000.0,
            timing("prep_ms"),
            timing("boot_ms") / 1000.0,
            timing("tail_ms") / 1000.0,
            overhead / 1000.0
        );
    }
    if let Some(r) = results.iter().find(|r| r["sizes"]["chief"].is_object()) {
        let s = &r["sizes"];
        println!(
            "per turn, ours: Chief prompt {} + tools {} chars; agent prompt {} + tools {} chars",
            s["chief"]["prompt"], s["chief"]["tools"], s["agent"]["prompt"], s["agent"]["tools"]
        );
    }
    println!("behaviour: ${total_cost:.3} reported by Claude Code over {runs} run(s)");
    ensure(!failed, "some behaviour checks failed (see above)")
}
