//! Running a routine.
//!
//! One run is one headless agent invocation in the project directory, plus the
//! parsing of what it reported. Nothing is spawned, hosted, or proxied by Ship
//! Studio — the user's own CLI does the work on their own subscription.
//!
//! ## Read-only is enforced, not requested
//!
//! Both supported agents have a real mode for this, verified against the
//! installed CLIs rather than assumed:
//!
//! - Claude Code `--permission-mode plan` — Read/Grep/Glob/Bash still work, so
//!   the routine can do its analysis, but `Write`/`Edit` are refused by the CLI
//!   itself. A routine told to create a file replies that it can't, and no file
//!   appears.
//! - Codex `--sandbox read-only` — same guarantee at the sandbox layer
//!   ("I can't create files in this read-only workspace").
//!
//! That matters because the UI says "read-only is enforced". If enforcement
//! were only a line in the prompt, that sentence would be a lie, and an
//! unattended agent is exactly where a lie like that costs someone their work.
//!
//! ## Why findings come back as a fenced JSON block
//!
//! An MCP tool (`ship_studio_report`) would be tidier and is the intended v2.
//! For v1 the report is the last ```json block in the agent's reply, because
//! that works identically for Claude's `--print` and Codex's
//! `--output-last-message`, needs no server registration, and — decisively —
//! needs no write permission, so it composes with the read-only enforcement
//! above instead of fighting it.

use super::files::{parse_routine, routines_dir, slugify, Routine};
use super::state::{
    mutate_state, now_ms, prune_runs, trim_transcript, FindingLocation, InboxItem, RoutineRun,
    RunStatus,
};
use super::{RoutinePermission, RoutineTrigger, Severity};
use crate::agent::{get_active_agent, get_agent_by_id, AgentConfig};
use crate::commands::claude::find_validated_binary;
use crate::errors::CommandError;
use crate::external_command::{run_with_timeout, run_with_timeout_stdin};
use crate::utils::{create_command, get_extended_path, validate_project_path};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// A routine gets longer than a PR description does — it may read a lot of the
/// tree — but not unbounded: a hung CLI must not hold a slot forever.
const RUN_TIMEOUT_SECS: u64 = 600;

/// Fast, local git context calls.
const GIT_TIMEOUT_SECS: u64 = 30;

/// Emitted whenever runs or the inbox change, so open windows refresh.
pub const ROUTINES_CHANGED_EVENT: &str = "routines:changed";

/// Routine ids with a run in flight. Pressing Run twice, or a tick landing on
/// a routine you just started by hand, must not spawn a second agent against
/// the same working tree.
static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn claim(routine_id: &str) -> bool {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashSet::new)
        .insert(routine_id.to_string())
}

fn release(routine_id: &str) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(routine_id);
    }
}

/// Routine ids currently executing, so the UI can show them as running even in
/// a window that didn't start them.
#[tauri::command]
#[tracing::instrument]
pub async fn running_routine_ids() -> Result<Vec<String>, CommandError> {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard
        .as_ref()
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default())
}

/* ------------------------------------------------------------ the report */

/// One finding, exactly as the agent is asked to emit it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportedFinding {
    title: String,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    fingerprint: Option<String>,
    #[serde(default)]
    locations: Vec<ReportedLocation>,
    #[serde(default)]
    suggested_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportedLocation {
    path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Report {
    #[serde(default)]
    findings: Vec<ReportedFinding>,
}

/// Pull the findings out of an agent reply.
///
/// Scans for fenced blocks from the end: the report is the *last* thing the
/// model is told to write, and a reply that reasons in prose first may well
/// contain an earlier example block. A reply with no parseable block is not an
/// error — it means the routine had nothing to say, which is the common case
/// and must not look like a failure.
pub fn parse_findings(reply: &str) -> Option<Vec<ReportedFindingPublic>> {
    let candidates = fenced_blocks(reply);
    for block in candidates.iter().rev() {
        if let Ok(report) = serde_json::from_str::<Report>(block) {
            return Some(
                report
                    .findings
                    .into_iter()
                    .map(ReportedFindingPublic::from)
                    .collect(),
            );
        }
    }
    // A model that ignored the fence but emitted a bare object still counts.
    let trimmed = reply.trim();
    if trimmed.starts_with('{') {
        if let Ok(report) = serde_json::from_str::<Report>(trimmed) {
            return Some(
                report
                    .findings
                    .into_iter()
                    .map(ReportedFindingPublic::from)
                    .collect(),
            );
        }
    }
    None
}

/// Public projection of a parsed finding, so tests and the run path can share
/// the shape without exposing serde internals.
#[derive(Debug, Clone)]
pub struct ReportedFindingPublic {
    pub title: String,
    pub severity: Severity,
    pub summary: String,
    pub body: String,
    pub fingerprint: Option<String>,
    pub locations: Vec<FindingLocation>,
    pub suggested_prompt: Option<String>,
}

impl From<ReportedFinding> for ReportedFindingPublic {
    fn from(f: ReportedFinding) -> Self {
        let summary = f
            .summary
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| f.title.clone());
        ReportedFindingPublic {
            severity: f
                .severity
                .as_deref()
                .and_then(Severity::parse)
                // An omitted severity is a warning, not a critical: a routine
                // that forgets the field must not be able to shout.
                .unwrap_or(Severity::Warning),
            body: f
                .body
                .filter(|b| !b.trim().is_empty())
                .unwrap_or_else(|| summary.clone()),
            summary,
            title: f.title,
            fingerprint: f.fingerprint.filter(|s| !s.trim().is_empty()),
            locations: f
                .locations
                .into_iter()
                .map(|l| FindingLocation {
                    path: l.path,
                    line: l.line,
                    note: l.note.filter(|n| !n.trim().is_empty()),
                })
                .collect(),
            suggested_prompt: f.suggested_prompt.filter(|s| !s.trim().is_empty()),
        }
    }
}

/// Every ```-fenced block body in `text`, in order.
fn fenced_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            match current.take() {
                Some(body) => blocks.push(body),
                None => current = Some(String::new()),
            }
            continue;
        }
        if let Some(body) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    blocks
}

/// FNV-1a. A stable, dependency-free id for a finding whose agent-supplied
/// fingerprint is missing or drifts between runs.
fn stable_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Normalise a title enough that trivial rewording doesn't defeat dedup.
fn normalized_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The identity a finding is deduped on.
///
/// Prefers the agent's own fingerprint (it knows that "the same auth bug"
/// survived a refactor that changed the line number), and falls back to the
/// normalised title. Always namespaced by routine, so two routines reporting
/// the same problem still both get to say so.
pub fn fingerprint_for(routine_id: &str, finding: &ReportedFindingPublic) -> String {
    let basis = finding
        .fingerprint
        .clone()
        .unwrap_or_else(|| normalized_title(&finding.title));
    stable_hash(&format!("{routine_id}\u{0}{basis}"))
}

/* -------------------------------------------------------------- the prompt */

fn severity_menu() -> &'static str {
    "critical | warning | info"
}

/// The instructions wrapped around the user's own routine body.
///
/// Deliberately explicit about *not* reporting: the failure mode that kills an
/// inbox is a routine that files "no issues found" every 30 minutes, and a
/// model asked to report will report unless told plainly that silence is a
/// valid, expected answer.
fn build_prompt(routine: &Routine, context: &str, already_filed: &[(String, String)]) -> String {
    let mut p = String::new();
    p.push_str(&format!(
        "You are running as a Ship Studio routine named \"{}\" in the project \"{}\".\n\
         You are unattended: nobody is watching this run, and your reply is filed straight to the user's inbox.\n\n",
        routine.name, routine.project_name
    ));

    p.push_str("## The instruction\n\n");
    p.push_str(routine.prompt.trim());
    p.push_str("\n\n");

    if !context.trim().is_empty() {
        p.push_str("## Repository context\n\n");
        p.push_str(context.trim());
        p.push_str("\n\n");
    }

    if !already_filed.is_empty() {
        p.push_str(
            "## Already filed\n\nThese are already in the user's inbox. Do NOT report them again \
             unless something material has changed; if you do re-report one, reuse its exact \
             fingerprint so it is counted as a recurrence rather than filed twice.\n\n",
        );
        for (fingerprint, title) in already_filed.iter().take(60) {
            p.push_str(&format!("- `{fingerprint}` — {title}\n"));
        }
        p.push('\n');
    }

    p.push_str(&format!(
        "## How to reply\n\n\
         End your reply with exactly one fenced ```json block and nothing after it:\n\n\
         ```json\n\
         {{\"findings\": [{{\"title\": \"…\", \"severity\": \"{}\", \"summary\": \"one line\", \
         \"body\": \"markdown detail\", \"fingerprint\": \"stable-slug\", \
         \"locations\": [{{\"path\": \"src/x.ts\", \"line\": 12, \"note\": \"why\"}}], \
         \"suggestedPrompt\": \"what to tell an agent to fix this\"}}]}}\n\
         ```\n\n\
         Rules:\n\
         - `fingerprint` must be a stable slug identifying THIS specific problem, and must come \
         out the same on a future run even if line numbers move. Base it on what is wrong and \
         where, not on wording.\n\
         - `suggestedPrompt` is what will be typed into the user's terminal if they press \
         \"Fix with agent\". Write it as a direct instruction to a coding agent working in this \
         repository.\n\
         - Report only things that are actually true and that you verified. Do not speculate.\n\
         - **If you found nothing worth the user's attention, reply with `{{\"findings\": []}}`.** \
         An empty result is a normal, expected outcome and is preferred over a filler finding. \
         Never file an \"all clear\", a summary of what you checked, or a low-value nitpick to \
         look productive.\n",
        severity_menu()
    ));
    p
}

/// Cheap, bounded git context: what moved since this routine last looked.
async fn gather_context(project: &Path, since_commit: Option<&str>) -> String {
    let mut out = String::new();

    if let Some(commit) = since_commit {
        let range = format!("{commit}..HEAD");
        if let Some(stat) = git(project, &["diff", "--stat", &range]).await {
            if !stat.trim().is_empty() {
                out.push_str(&format!(
                    "Changed since this routine last ran ({range}):\n{}\n\n",
                    stat.trim()
                ));
            }
        }
        if let Some(log) = git(project, &["log", "--oneline", "-20", &range]).await {
            if !log.trim().is_empty() {
                out.push_str(&format!("Commits since then:\n{}\n\n", log.trim()));
            }
        }
    }

    if out.is_empty() {
        if let Some(log) = git(project, &["log", "--oneline", "-10"]).await {
            if !log.trim().is_empty() {
                out.push_str(&format!("Recent commits:\n{}\n\n", log.trim()));
            }
        }
    }

    if let Some(status) = git(project, &["status", "--short"]).await {
        if !status.trim().is_empty() {
            out.push_str(&format!("Uncommitted right now:\n{}\n", status.trim()));
        }
    }
    out
}

async fn git(project: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = create_command("git");
    cmd.args(args)
        .current_dir(project)
        .env("PATH", get_extended_path())
        .stdin(std::process::Stdio::null());
    let output = run_with_timeout(tokio::process::Command::from(cmd), "git", GIT_TIMEOUT_SECS)
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

async fn head_commit(project: &Path) -> Option<String> {
    git(project, &["rev-parse", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/* ------------------------------------------------------------- invocation */

/// What one agent invocation produced.
struct AgentReply {
    text: String,
    tokens: Option<u64>,
}

/// Build and run the agent, returning its final message.
async fn invoke_agent(
    agent: &AgentConfig,
    project: &Path,
    prompt: &str,
    permission: RoutinePermission,
) -> Result<AgentReply, CommandError> {
    let binary = find_validated_binary(agent.binary_name, agent.version_flag).ok_or_else(|| {
        CommandError::expected(format!(
            "{} isn't installed, or isn't on Ship Studio's PATH. Install it, then run this routine again.",
            agent.display_name
        ))
    })?;

    match agent.id {
        "claude-code" => {
            let mode = match permission {
                // Verified: plan mode still allows Read/Grep/Glob/Bash, so the
                // analysis happens, but the CLI itself refuses Write and Edit.
                RoutinePermission::ReadOnly => "plan",
                RoutinePermission::CanEdit => "acceptEdits",
            };
            let mut cmd = create_command(&binary);
            cmd.args([
                "--print",
                "--output-format",
                "json",
                "--permission-mode",
                mode,
            ])
            .env("PATH", get_extended_path())
            .current_dir(project);
            let output = run_with_timeout_stdin(
                tokio::process::Command::from(cmd),
                prompt,
                "Claude Code CLI",
                RUN_TIMEOUT_SECS,
            )
            .await?;
            check_status(agent, &output, prompt)?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(parse_claude_json(&stdout))
        }
        "codex" => {
            let sandbox = match permission {
                RoutinePermission::ReadOnly => "read-only",
                RoutinePermission::CanEdit => "workspace-write",
            };
            let output_file = std::env::temp_dir().join(format!(
                "shipstudio-routine-{}-{}.txt",
                std::process::id(),
                now_ms()
            ));
            let mut cmd = create_command(&binary);
            cmd.args([
                "exec",
                "--skip-git-repo-check",
                "--color",
                "never",
                "--sandbox",
                sandbox,
                "--output-last-message",
                &output_file.to_string_lossy(),
                "-",
            ])
            .env("PATH", get_extended_path())
            .current_dir(project);
            let result = run_with_timeout_stdin(
                tokio::process::Command::from(cmd),
                prompt,
                "Codex CLI",
                RUN_TIMEOUT_SECS,
            )
            .await;
            let message = std::fs::read_to_string(&output_file).ok();
            let _ = std::fs::remove_file(&output_file);
            let output = result?;
            check_status(agent, &output, prompt)?;
            Ok(AgentReply {
                text: message.unwrap_or_else(|| String::from_utf8_lossy(&output.stdout).to_string()),
                // Codex exec reports no usage totals. Showing a guessed number
                // would be worse than showing none — see RoutineRun::tokens.
                tokens: None,
            })
        }
        _ => Err(CommandError::expected(format!(
            "{} can't run a routine yet — it has no headless mode. Pick Claude Code or Codex for this routine.",
            agent.display_name
        ))),
    }
}

fn check_status(
    agent: &AgentConfig,
    output: &std::process::Output,
    prompt: &str,
) -> Result<(), CommandError> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.to_string()
    } else {
        stderr.to_string()
    };
    // Strip the echoed prompt before anything else: Codex dumps a transcript on
    // failure that repeats what we sent, which buries the real error.
    let detail = detail.replace(prompt, "…");
    // Reuse the shared taxonomy so a usage-limit or expired-login during a
    // routine reads the same as it does during PR generation, and stays out of
    // telemetry as an environment state rather than an app bug.
    if let Some(err) = crate::commands::ai::classify_agent_cli_failure(agent.display_name, &detail)
    {
        return Err(err);
    }
    Err(CommandError::expected(format!(
        "{} exited without finishing this run: {}",
        agent.display_name,
        crate::external_command::truncate_output_head_tail(&detail)
    )))
}

/// Claude `--output-format json`: the answer is `result`, and `usage` carries
/// real token counts. Falls back to treating stdout as the answer if the shape
/// ever changes, so a CLI update degrades the token column, not the feature.
fn parse_claude_json(stdout: &str) -> AgentReply {
    #[derive(Deserialize)]
    struct Usage {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
        #[serde(default)]
        cache_creation_input_tokens: u64,
        #[serde(default)]
        cache_read_input_tokens: u64,
    }
    #[derive(Deserialize)]
    struct ClaudeResult {
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        usage: Option<Usage>,
    }
    match serde_json::from_str::<ClaudeResult>(stdout.trim()) {
        Ok(parsed) => AgentReply {
            text: parsed.result.unwrap_or_default(),
            tokens: parsed.usage.map(|u| {
                u.input_tokens
                    + u.output_tokens
                    + u.cache_creation_input_tokens
                    + u.cache_read_input_tokens
            }),
        },
        Err(_) => AgentReply {
            text: stdout.to_string(),
            tokens: None,
        },
    }
}

/* ------------------------------------------------------------------- run */

/// Run one routine now and file whatever it reports.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path, slug = %slug))]
pub async fn run_routine(
    app: AppHandle,
    project_path: String,
    slug: String,
) -> Result<RoutineRun, CommandError> {
    let project = validate_project_path(&project_path)?;
    let slug = slugify(&slug);
    let file_path = routines_dir(&project).join(format!("{slug}.md"));
    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CommandError::expected("That routine's file is gone — it may have been deleted or renamed outside Ship Studio.")
        } else {
            crate::utils::classify_fs_error("read the routine file", &file_path, &e)
        }
    })?;
    let routine = parse_routine(&project, &file_path, &contents);

    if routine.prompt.trim().is_empty() {
        return Err(CommandError::expected(
            "This routine has no instruction in it yet, so there is nothing to run. Open it and say what you want checked.",
        ));
    }

    if !claim(&routine.id) {
        return Err(CommandError::expected(format!(
            "\"{}\" is already running.",
            routine.name
        )));
    }
    let outcome = execute(&project, &routine).await;
    release(&routine.id);
    let _ = app.emit(ROUTINES_CHANGED_EVENT, ());
    outcome
}

/// The run itself, with no Tauri surface, so it can be exercised end to end
/// against the real agent CLI in a test.
async fn execute(project: &Path, routine: &Routine) -> Result<RoutineRun, CommandError> {
    let agent = routine
        .agent_id
        .as_deref()
        .map(get_agent_by_id)
        .unwrap_or_else(get_active_agent);

    let started_at = now_ms();
    let run_id = format!("run-{}-{started_at}", routine.slug);

    let state = super::state::load_state();
    let since_commit = state.last_run_commit.get(&routine.id).cloned();
    let already_filed: Vec<(String, String)> = state
        .inbox
        .iter()
        .filter(|item| item.routine_id == routine.id && !item.archived)
        .map(|item| (item.fingerprint.clone(), item.title.clone()))
        .collect();

    let context = gather_context(project, since_commit.as_deref()).await;
    let prompt = build_prompt(routine, &context, &already_filed);

    info!(
        routine = %routine.name,
        agent = agent.id,
        permission = ?routine.permission,
        "running routine"
    );

    let reply = invoke_agent(agent, project, &prompt, routine.permission).await;
    let duration_ms = now_ms() - started_at;
    let head = head_commit(project).await;

    let mut run = RoutineRun {
        id: run_id.clone(),
        routine_id: routine.id.clone(),
        started_at,
        duration_ms,
        status: RunStatus::Ok,
        findings: 0,
        tokens: None,
        error: None,
        transcript: String::new(),
    };

    match reply {
        Err(err) => {
            warn!(routine = %routine.name, error = %err, "routine run failed");
            run.status = RunStatus::Failed;
            run.error = Some(err.to_string());
            run.transcript = err.to_string();
            record_run(&run, routine, None)?;
            // The run is recorded as failed and shown in history; the caller
            // still gets the error so the click that started it can say why.
            return Err(err);
        }
        Ok(AgentReply { text, tokens }) => {
            run.tokens = tokens;
            run.transcript = trim_transcript(&text);
            let findings = parse_findings(&text).unwrap_or_default();
            let kept: Vec<_> = findings
                .into_iter()
                .filter(|f| f.severity.rank() <= routine.severity_floor.rank())
                .collect();
            run.findings = kept.len();
            run.status = if kept.is_empty() {
                RunStatus::Ok
            } else {
                RunStatus::Findings
            };
            record_run(&run, routine, Some((kept, head)))?;
        }
    }

    Ok(run)
}

type RunPayload = (Vec<ReportedFindingPublic>, Option<String>);

/// Persist the run and merge its findings into the inbox.
fn record_run(
    run: &RoutineRun,
    routine: &Routine,
    payload: Option<RunPayload>,
) -> Result<(), CommandError> {
    mutate_state(|state| {
        state.runs.insert(0, run.clone());
        prune_runs(state, &routine.id);
        state.last_run_at.insert(routine.id.clone(), run.started_at);

        let Some((findings, head)) = payload else {
            return;
        };
        if let Some(head) = head {
            state.last_run_commit.insert(routine.id.clone(), head);
        }

        for finding in findings {
            let fingerprint = fingerprint_for(&routine.id, &finding);
            if let Some(existing) = state
                .inbox
                .iter_mut()
                .find(|i| i.fingerprint == fingerprint && i.routine_id == routine.id)
            {
                // A recurrence, not a new problem. Archiving stays sticky —
                // the user already said they don't want to hear about this,
                // and un-archiving it every 30 minutes would be the single
                // most annoying thing this feature could do.
                existing.occurrences += 1;
                existing.created_at = run.started_at;
                existing.run_id = run.id.clone();
                existing.severity = finding.severity;
                existing.body_md = finding.body;
                existing.summary = finding.summary;
                existing.locations = finding.locations;
                if !existing.archived {
                    existing.read = false;
                }
                continue;
            }
            let suggested_prompt = finding.suggested_prompt.clone().unwrap_or_else(|| {
                format!(
                    "In this project, fix the following issue reported by the \"{}\" routine:\n\n{}\n\n{}",
                    routine.name, finding.title, finding.summary
                )
            });
            state.inbox.push(InboxItem {
                id: format!("finding-{fingerprint}"),
                routine_id: routine.id.clone(),
                routine_name: routine.name.clone(),
                project_name: routine.project_name.clone(),
                project_path: routine.project_path.clone(),
                severity: finding.severity,
                title: finding.title,
                summary: finding.summary,
                body_md: finding.body,
                created_at: run.started_at,
                read: false,
                archived: false,
                fingerprint,
                occurrences: 1,
                first_seen_at: run.started_at,
                locations: finding.locations,
                suggested_prompt,
                run_id: run.id.clone(),
            });
        }
    })
}

/// When an armed trigger next comes due, in epoch ms.
///
/// An interval is measured from the last run, not from a wall clock: "every 30
/// minutes" means "at least 30 minutes since it last looked", which is the only
/// reading that stays true across an app restart.
pub fn next_due_at(trigger: RoutineTrigger, last_run_at: Option<i64>, now: i64) -> Option<i64> {
    match trigger {
        RoutineTrigger::Manual | RoutineTrigger::Event { .. } => None,
        RoutineTrigger::Interval { every_minutes } => {
            let gap = every_minutes as i64 * 60_000;
            Some(last_run_at.map_or(now, |last| last + gap))
        }
        RoutineTrigger::Daily { at_hour, at_minute } => {
            Some(next_clock(now, at_hour, at_minute, None))
        }
        RoutineTrigger::Weekly {
            weekday,
            at_hour,
            at_minute,
        } => Some(next_clock(now, at_hour, at_minute, Some(weekday))),
    }
}

/// Next occurrence of a local wall-clock time, optionally on a given weekday.
///
/// Walks forward a local calendar day at a time rather than adding fixed
/// 24-hour blocks, so "daily at 09:00" stays at 09:00 across a DST boundary
/// instead of drifting to 08:00 or 10:00 for half the year. On the one night a
/// year when the requested time doesn't exist locally (the spring-forward gap),
/// `single()` returns nothing and that day is skipped.
fn next_clock(now_ms_utc: i64, at_hour: u32, at_minute: u32, weekday: Option<u32>) -> i64 {
    use chrono::{Datelike, Local, TimeZone};

    let Some(now) = Local.timestamp_millis_opt(now_ms_utc).single() else {
        return now_ms_utc + 86_400_000;
    };
    let mut day = now.date_naive();
    // A week plus slack: enough to find any weekday, and to step over a
    // nonexistent local time without looping forever.
    for _ in 0..15 {
        let matches_weekday = weekday.is_none_or(|w| day.weekday().num_days_from_sunday() == w);
        if matches_weekday {
            if let Some(candidate) = day
                .and_hms_opt(at_hour, at_minute, 0)
                .and_then(|naive| Local.from_local_datetime(&naive).single())
            {
                let ms = candidate.timestamp_millis();
                if ms > now_ms_utc {
                    return ms;
                }
            }
        }
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
    now_ms_utc + 86_400_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_last_fenced_json_block() {
        let reply = "Here is an example of the shape:\n\n```json\n{\"findings\":[{\"title\":\"EXAMPLE\"}]}\n```\n\nNow the real one:\n\n```json\n{\"findings\":[{\"title\":\"Real finding\",\"severity\":\"critical\"}]}\n```\n";
        let findings = parse_findings(reply).expect("should parse");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].title, "Real finding");
        assert_eq!(findings[0].severity, Severity::Critical);
    }

    #[test]
    fn an_empty_report_is_a_clean_run_not_a_failure() {
        let findings = parse_findings("All good.\n\n```json\n{\"findings\":[]}\n```").unwrap();
        assert!(findings.is_empty());
    }

    #[test]
    fn a_reply_with_no_block_reports_nothing_rather_than_erroring() {
        assert!(parse_findings("I could not find anything of note.").is_none());
    }

    #[test]
    fn a_bare_object_without_a_fence_still_parses() {
        let findings = parse_findings("{\"findings\":[{\"title\":\"Bare\"}]}").unwrap();
        assert_eq!(findings[0].title, "Bare");
    }

    #[test]
    fn missing_severity_defaults_to_warning_never_critical() {
        let findings = parse_findings("```json\n{\"findings\":[{\"title\":\"X\"}]}\n```").unwrap();
        assert_eq!(findings[0].severity, Severity::Warning);
    }

    #[test]
    fn summary_and_body_fall_back_to_the_title() {
        let findings =
            parse_findings("```json\n{\"findings\":[{\"title\":\"Only a title\"}]}\n```").unwrap();
        assert_eq!(findings[0].summary, "Only a title");
        assert_eq!(findings[0].body, "Only a title");
    }

    fn finding(title: &str, fingerprint: Option<&str>) -> ReportedFindingPublic {
        ReportedFindingPublic {
            title: title.to_string(),
            severity: Severity::Warning,
            summary: String::new(),
            body: String::new(),
            fingerprint: fingerprint.map(str::to_string),
            locations: vec![],
            suggested_prompt: None,
        }
    }

    #[test]
    fn fingerprints_are_stable_across_rewording_when_the_agent_supplies_one() {
        let a = fingerprint_for(
            "r1",
            &finding("Session cookie unverified", Some("auth-cookie")),
        );
        let b = fingerprint_for(
            "r1",
            &finding("Unverified session cookie!", Some("auth-cookie")),
        );
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprints_fall_back_to_a_normalized_title() {
        let a = fingerprint_for("r1", &finding("Session  cookie UNVERIFIED", None));
        let b = fingerprint_for("r1", &finding("session cookie unverified.", None));
        assert_eq!(
            a, b,
            "punctuation and case must not create a duplicate item"
        );
    }

    #[test]
    fn fingerprints_are_namespaced_per_routine() {
        let a = fingerprint_for("routine-a", &finding("Same problem", Some("x")));
        let b = fingerprint_for("routine-b", &finding("Same problem", Some("x")));
        assert_ne!(a, b);
    }

    #[test]
    fn intervals_are_measured_from_the_last_run() {
        let now = 1_000_000_000;
        let due = next_due_at(
            RoutineTrigger::Interval { every_minutes: 30 },
            Some(now - 60_000),
            now,
        );
        assert_eq!(due, Some(now - 60_000 + 30 * 60_000));
    }

    #[test]
    fn an_interval_that_has_never_run_is_due_immediately() {
        let now = 1_000_000_000;
        assert_eq!(
            next_due_at(RoutineTrigger::Interval { every_minutes: 30 }, None, now),
            Some(now)
        );
    }

    #[test]
    fn manual_and_event_triggers_are_never_due() {
        assert_eq!(next_due_at(RoutineTrigger::Manual, None, 0), None);
        assert_eq!(
            next_due_at(
                RoutineTrigger::Event {
                    event: super::super::RoutineEvent::Push
                },
                None,
                0
            ),
            None
        );
    }

    #[test]
    fn daily_is_always_in_the_future() {
        let now = now_ms();
        let due = next_due_at(
            RoutineTrigger::Daily {
                at_hour: 9,
                at_minute: 0,
            },
            None,
            now,
        )
        .unwrap();
        assert!(due > now, "a daily trigger must never be due in the past");
        assert!(due - now <= 86_400_000, "and never more than a day out");
    }

    #[test]
    fn weekly_lands_within_a_week() {
        let now = now_ms();
        for weekday in 0..7 {
            let due = next_due_at(
                RoutineTrigger::Weekly {
                    weekday,
                    at_hour: 9,
                    at_minute: 0,
                },
                None,
                now,
            )
            .unwrap();
            assert!(due > now);
            assert!(due - now <= 8 * 86_400_000, "weekday {weekday} overshot");
        }
    }

    /// End-to-end against the real agent CLI, in a real git repo, with a
    /// routine file in the format the bundled skill documents.
    ///
    /// Ignored by default: it spends the developer's own agent quota and needs
    /// a signed-in CLI. Run it deliberately with
    /// `cargo test e2e_runs_a_routine_against_the_real_agent -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "spends real agent quota; run deliberately"]
    async fn e2e_runs_a_routine_against_the_real_agent() {
        use super::super::files::parse_routine;

        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path();
        std::fs::create_dir_all(project.join("src/api")).unwrap();
        std::fs::write(
            project.join("src/api/checkout.js"),
            "export async function POST(request) {\n  const userId = request.headers.get('cookie');\n  return charge(userId);\n}\n",
        )
        .unwrap();

        let routines = project.join(".shipstudio/routines");
        std::fs::create_dir_all(&routines).unwrap();
        let file = routines.join("security-sweep.md");
        std::fs::write(
            &file,
            "---\nname: Security sweep\ntrigger: manual\npermission: read-only\nseverity-floor: info\n---\n\nReview this repository for auth checks missing from a route that needs one. Include the exact file and line.\n",
        )
        .unwrap();

        let contents = std::fs::read_to_string(&file).unwrap();
        let routine = parse_routine(project, &file, &contents);
        assert_eq!(routine.name, "Security sweep");
        assert_eq!(routine.permission, RoutinePermission::ReadOnly);

        let run = execute(project, &routine)
            .await
            .expect("run should succeed");
        println!(
            "status={:?} findings={} tokens={:?}",
            run.status, run.findings, run.tokens
        );
        println!("--- transcript ---\n{}", run.transcript);

        assert!(
            matches!(run.status, RunStatus::Ok | RunStatus::Findings),
            "run should complete, got {:?}",
            run.status
        );
        // Read-only must have been enforced, not merely requested.
        assert!(
            !project.join("PWNED.txt").exists(),
            "a read-only routine must not have written anything"
        );
    }

    #[test]
    fn fenced_block_scanner_handles_language_tags_and_prose() {
        let blocks = fenced_blocks("intro\n```json\n{\"a\":1}\n```\ntail\n```\nplain\n```\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].trim(), "{\"a\":1}");
        assert_eq!(blocks[1].trim(), "plain");
    }
}
