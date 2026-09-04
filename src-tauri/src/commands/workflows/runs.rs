//! Running a workflow.
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
//!   the workflow can do its analysis, but `Write`/`Edit` are refused by the CLI
//!   itself. A workflow told to create a file replies that it can't, and no file
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

use super::files::{parse_workflow, slugify, workflows_dir, Workflow};
use super::state::{
    mutate_state, now_ms, prune_runs, trim_transcript, FindingLocation, InboxItem, RunStatus,
    WorkflowRun,
};
use super::{Severity, WorkflowPermission, WorkflowTrigger};
use crate::agent::{get_active_agent, get_agent_by_id, AgentConfig};
use crate::commands::claude::find_validated_binary;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// A workflow gets longer than a PR description does — it may read a lot of the
/// tree — but not unbounded: a hung CLI must not hold a slot forever.
const RUN_TIMEOUT_SECS: u64 = 600;

/// Fast, local git context calls.
const GIT_TIMEOUT_SECS: u64 = 30;

/// Emitted whenever runs or the inbox change, so open windows refresh.
pub const WORKFLOWS_CHANGED_EVENT: &str = "workflows:changed";

/// Workflow ids with a run in flight, and when each started. Pressing Run twice,
/// or a tick landing on a workflow you just started by hand, must not spawn a
/// second agent against the same working tree.
///
/// The start time lives here rather than in a pending run record so the list
/// can show elapsed time for a run *any* window started — a workflow that has
/// been working for two minutes should say so rather than spin silently.
static IN_FLIGHT: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);

fn claim(workflow_id: &str, started_at: i64) -> bool {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.contains_key(workflow_id) {
        return false;
    }
    map.insert(workflow_id.to_string(), started_at);
    true
}

fn release(workflow_id: &str) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(workflow_id);
    }
}

/// When each in-flight run started, by workflow id.
pub fn running_since_map() -> HashMap<String, i64> {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone().unwrap_or_default()
}

/// Workflow ids currently executing, so the UI can show them as running even in
/// a window that didn't start them.
#[tauri::command]
#[tracing::instrument]
pub async fn running_workflow_ids() -> Result<Vec<String>, CommandError> {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard
        .as_ref()
        .map(|m| m.keys().cloned().collect())
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
/// error — it means the workflow had nothing to say, which is the common case
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
                // An omitted severity is a warning, not a critical: a workflow
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
/// normalised title. Always namespaced by workflow, so two workflows reporting
/// the same problem still both get to say so.
pub fn fingerprint_for(workflow_id: &str, finding: &ReportedFindingPublic) -> String {
    let basis = finding
        .fingerprint
        .clone()
        .unwrap_or_else(|| normalized_title(&finding.title));
    stable_hash(&format!("{workflow_id}\u{0}{basis}"))
}

/* -------------------------------------------------------------- the prompt */

fn severity_menu() -> &'static str {
    "critical | warning | info"
}

/// The instructions wrapped around the user's own workflow body.
///
/// Deliberately explicit about *not* reporting: the failure mode that kills an
/// inbox is a workflow that files "no issues found" every 30 minutes, and a
/// model asked to report will report unless told plainly that silence is a
/// valid, expected answer.
fn build_prompt(workflow: &Workflow, context: &str, already_filed: &[(String, String)]) -> String {
    let mut p = String::new();
    p.push_str(&format!(
        "You are running as a Ship Studio workflow named \"{}\" in the project \"{}\".\n\
         You are unattended: nobody is watching this run, and your reply is filed straight to the user's inbox.\n\n",
        workflow.name, workflow.project_name
    ));

    p.push_str("## The instruction\n\n");
    p.push_str(workflow.prompt.trim());
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

/// Cheap, bounded git context: what moved since this workflow last looked.
async fn gather_context(project: &Path, since_commit: Option<&str>) -> String {
    let mut out = String::new();

    if let Some(commit) = since_commit {
        let range = format!("{commit}..HEAD");
        if let Some(stat) = git(project, &["diff", "--stat", &range]).await {
            if !stat.trim().is_empty() {
                out.push_str(&format!(
                    "Changed since this workflow last ran ({range}):\n{}\n\n",
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

/// Spawn a command, feed it a prompt, and hand each stdout line to `on_line`
/// as it arrives.
///
/// The shared `run_with_timeout_stdin` buffers everything until exit, which is
/// the right shape for a two-second `git` call and the wrong one for a
/// two-minute agent run that the user is watching. Same guarantees otherwise:
/// stdin is written and closed, the child is killed on timeout or drop.
async fn run_streaming(
    mut cmd: tokio::process::Command,
    stdin_data: &str,
    label: &str,
    timeout_secs: u64,
    mut on_line: impl FnMut(&str),
) -> Result<std::process::Output, CommandError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let data = stdin_data.as_bytes().to_vec();
    let run = async {
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let mut stdin = child.stdin.take();

        let feed = async {
            if let Some(mut handle) = stdin.take() {
                match handle.write_all(&data).await {
                    Ok(()) => {
                        let _ = handle.shutdown().await;
                    }
                    // The child stopped reading — its exit status is the story.
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
                    Err(e) => warn!(error = %e, "failed writing to workflow agent stdin"),
                }
            }
        };

        let collect_err = async {
            let mut buf = Vec::new();
            if let Some(handle) = stderr {
                let mut reader = BufReader::new(handle);
                let _ = tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut buf).await;
            }
            buf
        };

        let read_out = async {
            let mut all = String::new();
            if let Some(handle) = stdout {
                let mut lines = BufReader::new(handle).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    on_line(&line);
                    all.push_str(&line);
                    all.push('\n');
                }
            }
            all
        };

        let (stdout_text, stderr_bytes, ()) = tokio::join!(read_out, collect_err, feed);
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(std::process::Output {
            status,
            stdout: stdout_text.into_bytes(),
            stderr: stderr_bytes,
        })
    };

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), run).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("{label} failed to run: {e}").into()),
        Err(_) => Err(CommandError::Timeout {
            cmd: label.to_string(),
            secs: timeout_secs,
        }),
    }
}

/// Build and run the agent, returning its final message.
async fn invoke_agent(
    app: Option<&AppHandle>,
    workflow_id: &str,
    agent: &AgentConfig,
    project: &Path,
    prompt: &str,
    permission: WorkflowPermission,
) -> Result<AgentReply, CommandError> {
    let binary = find_validated_binary(agent.binary_name, agent.version_flag).ok_or_else(|| {
        CommandError::expected(format!(
            "{} isn't installed, or isn't on Ship Studio's PATH. Install it, then run this workflow again.",
            agent.display_name
        ))
    })?;

    match agent.id {
        "claude-code" => {
            let mode = match permission {
                // Verified: plan mode still allows Read/Grep/Glob/Bash, so the
                // analysis happens, but the CLI itself refuses Write and Edit.
                WorkflowPermission::ReadOnly => "plan",
                WorkflowPermission::CanEdit => "acceptEdits",
            };
            let mut cmd = create_command(&binary);
            // stream-json (not plain json) so each tool call is visible while
            // the run is happening. The closing `result` event carries the same
            // answer and usage the buffered form did.
            cmd.args([
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                mode,
            ])
            .env("PATH", get_extended_path())
            .current_dir(project);
            let output = run_streaming(
                tokio::process::Command::from(cmd),
                prompt,
                "Claude Code CLI",
                RUN_TIMEOUT_SECS,
                |line| {
                    if let Some(text) = super::progress::describe_claude_event(line) {
                        super::progress::push(app, workflow_id, text);
                    }
                },
            )
            .await?;
            check_status(agent, &output, prompt)?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(parse_claude_stream(&stdout))
        }
        "codex" => {
            let sandbox = match permission {
                WorkflowPermission::ReadOnly => "read-only",
                WorkflowPermission::CanEdit => "workspace-write",
            };
            let output_file = std::env::temp_dir().join(format!(
                "shipstudio-workflow-{}-{}.txt",
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
            let result = run_streaming(
                tokio::process::Command::from(cmd),
                prompt,
                "Codex CLI",
                RUN_TIMEOUT_SECS,
                |line| {
                    // Codex exec prints a plain transcript rather than a typed
                    // event stream, so the best available signal is its own
                    // non-empty output lines.
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('{') {
                        super::progress::push(app, workflow_id, truncate_line(trimmed));
                    }
                },
            )
            .await;
            let message = std::fs::read_to_string(&output_file).ok();
            let _ = std::fs::remove_file(&output_file);
            let output = result?;
            check_status(agent, &output, prompt)?;
            Ok(AgentReply {
                text: message.unwrap_or_else(|| String::from_utf8_lossy(&output.stdout).to_string()),
                // Codex exec reports no usage totals. Showing a guessed number
                // would be worse than showing none — see WorkflowRun::tokens.
                tokens: None,
            })
        }
        _ => Err(CommandError::expected(format!(
            "{} can't run a workflow yet — it has no headless mode. Pick Claude Code or Codex for this workflow.",
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
    // workflow reads the same as it does during PR generation, and stays out of
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
fn truncate_line(text: &str) -> String {
    if text.chars().count() <= 160 {
        return text.to_string();
    }
    format!("{}…", text.chars().take(160).collect::<String>().trim_end())
}

/// Pull the answer and usage out of a `stream-json` run.
///
/// Every line is one JSON event; the one with `type: "result"` closes the run.
/// Scanned from the end so a transcript that mentions the word never wins over
/// the real envelope. Falls back to the raw text if the shape ever changes, so
/// a CLI update costs the token column rather than the feature.
fn parse_claude_stream(stdout: &str) -> AgentReply {
    #[derive(Deserialize)]
    struct Usage {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
        #[serde(default)]
        cache_creation_input_tokens: u64,
    }
    #[derive(Deserialize)]
    struct ClaudeResult {
        #[serde(default, rename = "type")]
        event_type: Option<String>,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        usage: Option<Usage>,
    }
    for line in stdout.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeResult>(line) else {
            continue;
        };
        if parsed.event_type.as_deref() != Some("result") {
            continue;
        }
        return AgentReply {
            text: parsed.result.unwrap_or_default(),
            // Deliberately excludes `cache_read_input_tokens`. A long agentic
            // run re-reads the same cached context on every turn, so cache
            // reads dominate the raw total — a real security sweep came back
            // as 1.4M "tokens" — while being billed at a fraction of the rest.
            // Including them made the figure read as roughly ten times the
            // actual spend, which is worse than useless on a number whose
            // whole job is letting someone watch their quota.
            tokens: parsed
                .usage
                .map(|u| u.input_tokens + u.output_tokens + u.cache_creation_input_tokens),
        };
    }
    AgentReply {
        text: stdout.to_string(),
        tokens: None,
    }
}

/* ------------------------------------------------------------------- run */

/// What set a run going. Reported with the run, since "does anyone actually
/// arm these?" is the one question about this feature worth measuring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSource {
    /// Someone pressed Run.
    Manual,
    /// The tick found it due.
    Schedule,
    /// A push or a PR opening.
    Event,
}

impl RunSource {
    fn as_str(self) -> &'static str {
        match self {
            RunSource::Manual => "manual",
            RunSource::Schedule => "schedule",
            RunSource::Event => "event",
        }
    }
}

/// Run one workflow now and file whatever it reports.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path, slug = %slug))]
pub async fn run_workflow(
    app: AppHandle,
    project_path: String,
    slug: String,
) -> Result<WorkflowRun, CommandError> {
    run_workflow_from(app, project_path, slug, RunSource::Manual).await
}

/// The body of `run_workflow`, plus who asked.
pub async fn run_workflow_from(
    app: AppHandle,
    project_path: String,
    slug: String,
    source: RunSource,
) -> Result<WorkflowRun, CommandError> {
    let project = validate_project_path(&project_path)?;
    let slug = slugify(&slug);
    let file_path = workflows_dir(&project).join(format!("{slug}.md"));
    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CommandError::expected("That workflow's file is gone — it may have been deleted or renamed outside Ship Studio.")
        } else {
            crate::utils::classify_fs_error("read the workflow file", &file_path, &e)
        }
    })?;
    let workflow = parse_workflow(&project, &file_path, &contents);

    if workflow.prompt.trim().is_empty() {
        return Err(CommandError::expected(
            "This workflow has no instruction in it yet, so there is nothing to run. Open it and say what you want checked.",
        ));
    }

    if !claim(&workflow.id, now_ms()) {
        return Err(CommandError::expected(format!(
            "\"{}\" is already running.",
            workflow.name
        )));
    }
    let outcome = execute(Some(&app), &project, &workflow, source).await;
    release(&workflow.id);
    let _ = app.emit(WORKFLOWS_CHANGED_EVENT, ());
    outcome
}

/// The run itself, with no Tauri surface, so it can be exercised end to end
/// against the real agent CLI in a test.
async fn execute(
    app: Option<&AppHandle>,
    project: &Path,
    workflow: &Workflow,
    source: RunSource,
) -> Result<WorkflowRun, CommandError> {
    let agent = workflow
        .agent_id
        .as_deref()
        .map(get_agent_by_id)
        .unwrap_or_else(get_active_agent);

    let started_at = now_ms();
    let run_id = format!("run-{}-{started_at}", workflow.slug);

    let state = super::state::load_state();
    let since_commit = state.last_run_commit.get(&workflow.id).cloned();
    let already_filed: Vec<(String, String)> = state
        .inbox
        .iter()
        .filter(|item| item.workflow_id == workflow.id && !item.archived)
        .map(|item| (item.fingerprint.clone(), item.title.clone()))
        .collect();

    let context = gather_context(project, since_commit.as_deref()).await;
    let prompt = build_prompt(workflow, &context, &already_filed);

    info!(
        workflow = %workflow.name,
        agent = agent.id,
        permission = ?workflow.permission,
        "running workflow"
    );

    // Start this run's activity log clean so the panel shows this run rather
    // than a confusing mix with the last one.
    super::progress::reset(&workflow.id);
    super::progress::push(
        app,
        &workflow.id,
        format!("Starting {}", agent.display_name),
    );

    let reply = invoke_agent(
        app,
        &workflow.id,
        agent,
        project,
        &prompt,
        workflow.permission,
    )
    .await;
    let duration_ms = now_ms() - started_at;
    let head = head_commit(project).await;

    let mut run = WorkflowRun {
        id: run_id.clone(),
        workflow_id: workflow.id.clone(),
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
            warn!(workflow = %workflow.name, error = %err, "workflow run failed");
            run.status = RunStatus::Failed;
            run.error = Some(err.to_string());
            run.transcript = err.to_string();
            record_run(&run, workflow, None)?;
            report_run(&run, workflow, source);
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
                .filter(|f| f.severity.rank() <= workflow.severity_floor.rank())
                .collect();
            run.findings = kept.len();
            run.status = if kept.is_empty() {
                RunStatus::Ok
            } else {
                RunStatus::Findings
            };
            record_run(&run, workflow, Some((kept, head)))?;
            report_run(&run, workflow, source);
        }
    }

    Ok(run)
}

/// Tell analytics a run happened.
///
/// Deliberately carries no content: not the workflow's name, not the project,
/// not a finding title, not a line of the prompt. Shape only — what kind of
/// trigger, which agent, whether it found anything, what it cost. Everything
/// this feature touches is someone's private repository, and the questions
/// worth asking about it ("do people arm schedules?", "do runs fail?") are all
/// answerable from shape alone.
fn report_run(run: &WorkflowRun, workflow: &Workflow, source: RunSource) {
    crate::commands::analytics::track_backend_event(
        "workflow_run_finished",
        serde_json::json!({
            "source": source.as_str(),
            "trigger_kind": workflow.trigger.kind_name(),
            "permission": workflow.permission.as_str(),
            "agent": workflow.agent_id.as_deref().unwrap_or("default"),
            "auto_run": workflow.auto_run,
            "status": match run.status {
                RunStatus::Ok => "ok",
                RunStatus::Findings => "findings",
                RunStatus::Failed => "failed",
                RunStatus::Running => "running",
            },
            "findings": run.findings,
            "duration_ms": run.duration_ms,
            "tokens": run.tokens,
        }),
    );
}

type RunPayload = (Vec<ReportedFindingPublic>, Option<String>);

/// Persist the run and merge its findings into the inbox.
fn record_run(
    run: &WorkflowRun,
    workflow: &Workflow,
    payload: Option<RunPayload>,
) -> Result<(), CommandError> {
    mutate_state(|state| {
        state.runs.insert(0, run.clone());
        prune_runs(state, &workflow.id);
        state
            .last_run_at
            .insert(workflow.id.clone(), run.started_at);

        let Some((findings, head)) = payload else {
            return;
        };
        if let Some(head) = head {
            state.last_run_commit.insert(workflow.id.clone(), head);
        }

        for finding in findings {
            let fingerprint = fingerprint_for(&workflow.id, &finding);
            if let Some(existing) = state
                .inbox
                .iter_mut()
                .find(|i| i.fingerprint == fingerprint && i.workflow_id == workflow.id)
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
                    "In this project, fix the following issue reported by the \"{}\" workflow:\n\n{}\n\n{}",
                    workflow.name, finding.title, finding.summary
                )
            });
            state.inbox.push(InboxItem {
                id: format!("finding-{fingerprint}"),
                workflow_id: workflow.id.clone(),
                workflow_name: workflow.name.clone(),
                project_name: workflow.project_name.clone(),
                project_path: workflow.project_path.clone(),
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

/// When an armed trigger next comes due, in epoch ms. **Display only.**
///
/// This answers "when is the next one", which is what the row shows. It is
/// deliberately *not* what the scheduler asks — see `due_at`. An interval is
/// measured from the last run, not from a wall clock: "every 30 minutes" means
/// "at least 30 minutes since it last looked", which is the only reading that
/// stays true across an app restart.
pub fn next_due_at(
    trigger: WorkflowTrigger,
    last_run_at: Option<i64>,
    armed_at: Option<i64>,
    now: i64,
) -> Option<i64> {
    match trigger {
        WorkflowTrigger::Manual | WorkflowTrigger::Event { .. } => None,
        WorkflowTrigger::Interval { every_minutes } => {
            let anchor = last_run_at.or(armed_at).unwrap_or(now);
            Some(anchor + every_minutes as i64 * 60_000)
        }
        WorkflowTrigger::Daily { at_hour, at_minute } => {
            Some(next_clock(now, at_hour, at_minute, None))
        }
        WorkflowTrigger::Weekly {
            weekday,
            at_hour,
            at_minute,
        } => Some(next_clock(now, at_hour, at_minute, Some(weekday))),
    }
}

/// The moment an armed trigger *became* due, or `None` if it isn't due yet.
///
/// This is the scheduler's question, and it is not the same one `next_due_at`
/// answers. A daily trigger's next occurrence is always in the future by
/// definition, so a scheduler that asked "is the next occurrence in the past?"
/// would never fire a daily workflow at all — which is exactly what this
/// codebase did until it was caught: `daily` and `weekly` parsed, serialized,
/// rendered a countdown, and never ran once.
///
/// The right question is backwards-looking: has an occurrence passed that we
/// haven't run since?
///
/// `armed_at` is the workflow file's mtime, and it floors everything. Saving
/// "daily at 09:00" at two in the afternoon must not fire instantly just
/// because 09:00 already went by today.
pub fn due_at(
    trigger: WorkflowTrigger,
    last_run_at: Option<i64>,
    armed_at: Option<i64>,
    now: i64,
) -> Option<i64> {
    match trigger {
        WorkflowTrigger::Manual | WorkflowTrigger::Event { .. } => None,
        WorkflowTrigger::Interval { every_minutes } => {
            // Never run and never armed (only reachable for a file the
            // filesystem wouldn't stat) counts as due: an interval workflow
            // that can never start is worse than one that starts early.
            let anchor = last_run_at.or(armed_at)?;
            let due = anchor + every_minutes as i64 * 60_000;
            (due <= now).then_some(due)
        }
        WorkflowTrigger::Daily { at_hour, at_minute } => {
            due_clock(now, at_hour, at_minute, None, last_run_at, armed_at)
        }
        WorkflowTrigger::Weekly {
            weekday,
            at_hour,
            at_minute,
        } => due_clock(
            now,
            at_hour,
            at_minute,
            Some(weekday),
            last_run_at,
            armed_at,
        ),
    }
}

/// The most recent occurrence of a wall-clock trigger, if we owe a run for it.
///
/// Owed means the occurrence is later than both the last run and the moment the
/// workflow was armed. One occurrence is at most one run: reopening the app
/// after a week away runs a daily workflow once, not seven times, because only
/// the latest occurrence is ever considered.
fn due_clock(
    now: i64,
    at_hour: u32,
    at_minute: u32,
    weekday: Option<u32>,
    last_run_at: Option<i64>,
    armed_at: Option<i64>,
) -> Option<i64> {
    let occurrence = prev_clock(now, at_hour, at_minute, weekday)?;
    let floor = last_run_at.max(armed_at);
    match floor {
        Some(floor) if occurrence <= floor => None,
        _ => Some(occurrence),
    }
}

/// Previous occurrence of a local wall-clock time at or before `now`.
///
/// The mirror of `next_clock`, walking backwards a local calendar day at a
/// time for the same DST reason. `None` if nothing matched inside the window,
/// which for a weekly trigger can only mean the clock is unusable.
fn prev_clock(now_ms_utc: i64, at_hour: u32, at_minute: u32, weekday: Option<u32>) -> Option<i64> {
    use chrono::{Datelike, Local, TimeZone};

    let now = Local.timestamp_millis_opt(now_ms_utc).single()?;
    let mut day = now.date_naive();
    // A week plus slack: enough to find any weekday, and to step over a local
    // time that doesn't exist on a spring-forward night.
    for _ in 0..15 {
        let matches_weekday = weekday.is_none_or(|w| day.weekday().num_days_from_sunday() == w);
        if matches_weekday {
            if let Some(candidate) = day
                .and_hms_opt(at_hour, at_minute, 0)
                .and_then(|naive| Local.from_local_datetime(&naive).single())
            {
                let ms = candidate.timestamp_millis();
                if ms <= now_ms_utc {
                    return Some(ms);
                }
            }
        }
        day = day.pred_opt()?;
    }
    None
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
    fn fingerprints_are_namespaced_per_workflow() {
        let a = fingerprint_for("workflow-a", &finding("Same problem", Some("x")));
        let b = fingerprint_for("workflow-b", &finding("Same problem", Some("x")));
        assert_ne!(a, b);
    }

    #[test]
    fn intervals_are_measured_from_the_last_run() {
        let now = 1_000_000_000;
        let due = next_due_at(
            WorkflowTrigger::Interval { every_minutes: 30 },
            Some(now - 60_000),
            None,
            now,
        );
        assert_eq!(due, Some(now - 60_000 + 30 * 60_000));
    }

    #[test]
    fn manual_and_event_triggers_are_never_due() {
        assert_eq!(next_due_at(WorkflowTrigger::Manual, None, None, 0), None);
        assert_eq!(due_at(WorkflowTrigger::Manual, None, None, 0), None);
        let push = WorkflowTrigger::Event {
            event: super::super::WorkflowEvent::Push,
        };
        assert_eq!(next_due_at(push, None, None, 0), None);
        assert_eq!(due_at(push, None, None, 0), None);
    }

    #[test]
    fn the_next_daily_occurrence_is_always_in_the_future() {
        let now = now_ms();
        let due = next_due_at(
            WorkflowTrigger::Daily {
                at_hour: 9,
                at_minute: 0,
            },
            None,
            None,
            now,
        )
        .unwrap();
        assert!(due > now, "a countdown must never point at the past");
        assert!(due - now <= 86_400_000, "and never more than a day out");
    }

    #[test]
    fn weekly_lands_within_a_week() {
        let now = now_ms();
        for weekday in 0..7 {
            let due = next_due_at(
                WorkflowTrigger::Weekly {
                    weekday,
                    at_hour: 9,
                    at_minute: 0,
                },
                None,
                None,
                now,
            )
            .unwrap();
            assert!(due > now);
            assert!(due - now <= 8 * 86_400_000, "weekday {weekday} overshot");
        }
    }

    /* ------------------------------------------------ is it due right now? */

    /// A local wall-clock time today, in epoch ms. Built through `Local` so
    /// these tests mean the same thing in every timezone CI might run in.
    fn local_today_at(hour: u32, minute: u32) -> i64 {
        use chrono::{Local, TimeZone};
        let day = Local::now().date_naive();
        Local
            .from_local_datetime(&day.and_hms_opt(hour, minute, 0).unwrap())
            .single()
            // The one hour a year that doesn't exist locally: step off it.
            .unwrap_or_else(|| {
                Local
                    .from_local_datetime(
                        &day.and_hms_opt(hour.wrapping_add(1) % 24, minute, 0)
                            .unwrap(),
                    )
                    .single()
                    .expect("a usable local hour")
            })
            .timestamp_millis()
    }

    const DAILY_9AM: WorkflowTrigger = WorkflowTrigger::Daily {
        at_hour: 9,
        at_minute: 0,
    };

    #[test]
    fn a_daily_workflow_actually_becomes_due() {
        // The regression this whole function exists for: the scheduler used to
        // ask `next_due_at`, whose answer is in the future by construction, so
        // no daily workflow ever ran.
        let nine = local_today_at(9, 0);
        let armed_yesterday = nine - 86_400_000;

        assert_eq!(
            due_at(DAILY_9AM, None, Some(armed_yesterday), nine - 60_000),
            None,
            "not due a minute before nine"
        );
        assert_eq!(
            due_at(DAILY_9AM, None, Some(armed_yesterday), nine + 60_000),
            Some(nine),
            "due a minute after nine, dated to the occurrence"
        );
    }

    #[test]
    fn a_daily_workflow_does_not_re_fire_after_it_has_run() {
        let nine = local_today_at(9, 0);
        let armed_yesterday = nine - 86_400_000;
        let ran_at = nine + 30_000;
        assert_eq!(
            due_at(
                DAILY_9AM,
                Some(ran_at),
                Some(armed_yesterday),
                nine + 3_600_000
            ),
            None,
            "one occurrence is one run, not one run per tick for the rest of the day"
        );
    }

    #[test]
    fn a_week_away_costs_one_run_not_seven() {
        // Only the most recent occurrence is ever considered, so there is no
        // backlog to catch up on when the app reopens.
        let nine = local_today_at(9, 0);
        let ran_a_week_ago = nine - 7 * 86_400_000;
        let due = due_at(
            DAILY_9AM,
            Some(ran_a_week_ago),
            Some(ran_a_week_ago),
            nine + 60_000,
        );
        assert_eq!(
            due,
            Some(nine),
            "the run owed is today's, not last Tuesday's"
        );
    }

    #[test]
    fn saving_a_daily_workflow_after_its_hour_waits_for_tomorrow() {
        // Someone writing "daily at 09:00" at two in the afternoon has not
        // asked for a run right now, and firing one would spend their quota on
        // a schedule they were still typing.
        let armed_at_two = local_today_at(14, 0);
        assert_eq!(
            due_at(DAILY_9AM, None, Some(armed_at_two), armed_at_two + 60_000),
            None
        );
    }

    #[test]
    fn a_weekly_workflow_only_owes_a_run_on_its_own_weekday() {
        use chrono::{Datelike, Local};
        let today = Local::now().weekday().num_days_from_sunday();
        let nine = local_today_at(9, 0);
        let armed_yesterday = nine - 86_400_000;

        let due_today = due_at(
            WorkflowTrigger::Weekly {
                weekday: today,
                at_hour: 9,
                at_minute: 0,
            },
            None,
            Some(armed_yesterday),
            nine + 60_000,
        );
        assert_eq!(due_today, Some(nine), "its own weekday, after its hour");

        let tomorrow = (today + 1) % 7;
        let due_other = due_at(
            WorkflowTrigger::Weekly {
                weekday: tomorrow,
                at_hour: 9,
                at_minute: 0,
            },
            None,
            // Armed a fortnight ago, so the floor cannot be what stops it.
            Some(nine - 14 * 86_400_000),
            nine + 60_000,
        );
        assert_ne!(
            due_other,
            Some(nine),
            "a different weekday is not due today"
        );
    }

    #[test]
    fn an_interval_counts_from_when_it_was_armed_not_from_zero() {
        let now = 1_000_000_000;
        let every_30 = WorkflowTrigger::Interval { every_minutes: 30 };
        let armed_a_minute_ago = now - 60_000;
        assert_eq!(
            due_at(every_30, None, Some(armed_a_minute_ago), now),
            None,
            "arming a 30-minute workflow must not fire it instantly"
        );
        let armed_an_hour_ago = now - 3_600_000;
        assert_eq!(
            due_at(every_30, None, Some(armed_an_hour_ago), now),
            Some(armed_an_hour_ago + 30 * 60_000)
        );
    }

    #[test]
    fn an_interval_is_due_once_the_gap_has_passed_since_the_last_run() {
        let now = 1_000_000_000;
        let every_30 = WorkflowTrigger::Interval { every_minutes: 30 };
        assert_eq!(due_at(every_30, Some(now - 29 * 60_000), None, now), None);
        assert_eq!(
            due_at(every_30, Some(now - 31 * 60_000), None, now),
            Some(now - 31 * 60_000 + 30 * 60_000)
        );
    }

    /// End-to-end against the real agent CLI, in a real git repo, with a
    /// workflow file in the format the bundled skill documents.
    ///
    /// Ignored by default: it spends the developer's own agent quota and needs
    /// a signed-in CLI. Run it deliberately with
    /// `cargo test e2e_runs_a_workflow_against_the_real_agent -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "spends real agent quota; run deliberately"]
    async fn e2e_runs_a_workflow_against_the_real_agent() {
        use super::super::files::parse_workflow;

        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path();
        // Redirect the state file, or this test files its throwaway findings
        // into the developer's own inbox — where they show up as a project
        // that no longer exists.
        // SAFETY: single-threaded test, set before anything reads it.
        unsafe {
            std::env::set_var(
                super::super::state::STATE_PATH_ENV,
                dir.path().join("workflows-state.json"),
            );
        }
        std::fs::create_dir_all(project.join("src/api")).unwrap();
        std::fs::write(
            project.join("src/api/checkout.js"),
            "export async function POST(request) {\n  const userId = request.headers.get('cookie');\n  return charge(userId);\n}\n",
        )
        .unwrap();

        let workflows = project.join(".shipstudio/workflows");
        std::fs::create_dir_all(&workflows).unwrap();
        let file = workflows.join("security-sweep.md");
        std::fs::write(
            &file,
            "---\nname: Security sweep\ntrigger: manual\npermission: read-only\nseverity-floor: info\n---\n\nReview this repository for auth checks missing from a route that needs one. Include the exact file and line.\n",
        )
        .unwrap();

        let contents = std::fs::read_to_string(&file).unwrap();
        let workflow = parse_workflow(project, &file, &contents);
        assert_eq!(workflow.name, "Security sweep");
        assert_eq!(workflow.permission, WorkflowPermission::ReadOnly);

        let run = execute(None, project, &workflow, RunSource::Manual)
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
            "a read-only workflow must not have written anything"
        );

        // The run has to have landed in the state file, not just been returned:
        // the inbox is fed by `record_run`, and a run that completes without
        // filing anything looks identical to one that found nothing.
        let state = super::super::state::load_state();
        assert_eq!(state.runs.len(), 1, "the run should be in history");
        assert_eq!(state.runs[0].workflow_id, workflow.id);
        assert_eq!(
            state.inbox.len(),
            run.findings,
            "every kept finding should be filed exactly once"
        );
        assert!(
            state.last_run_at.contains_key(&workflow.id),
            "the next interval has to be measured from somewhere"
        );
        for filed in &state.inbox {
            assert!(
                !filed.suggested_prompt.trim().is_empty(),
                "a finding with no prompt has no primary action"
            );
            assert!(!filed.read && !filed.archived, "a fresh finding is unread");
            assert_eq!(filed.occurrences, 1);
        }

        // Nothing may be written into the project itself: definitions live in
        // the repo, results do not.
        assert!(
            !project.join(".shipstudio/workflows-state.json").exists(),
            "run output must never land in the user's repo"
        );
    }

    #[test]
    fn a_second_claim_on_the_same_workflow_is_refused() {
        // Two agents against one working tree is confusing at best, and a
        // corruption risk when either can edit.
        let id = "claim-test-workflow";
        assert!(claim(id, 1000));
        assert!(!claim(id, 2000), "a second claim must be refused");
        release(id);
        assert!(claim(id, 3000), "releasing frees the slot again");
        assert_eq!(running_since_map().get(id), Some(&3000));
        release(id);
        assert!(running_since_map().get(id).is_none());
    }

    #[test]
    fn claiming_one_workflow_does_not_block_another() {
        assert!(claim("workflow-x", 1));
        assert!(claim("workflow-y", 2));
        let map = running_since_map();
        assert_eq!(map.get("workflow-x"), Some(&1));
        assert_eq!(map.get("workflow-y"), Some(&2));
        release("workflow-x");
        release("workflow-y");
    }

    #[test]
    fn fenced_block_scanner_handles_language_tags_and_prose() {
        let blocks = fenced_blocks("intro\n```json\n{\"a\":1}\n```\ntail\n```\nplain\n```\n");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].trim(), "{\"a\":1}");
        assert_eq!(blocks[1].trim(), "plain");
    }
}
