//! # Studio Talk — cross-project agent exchanges
//!
//! Lets the agent in one Ship Studio project ask a question "to" another local
//! project. The answer comes from a headless one-shot agent run in the target
//! project's directory, so it's grounded in that repo's code and CLAUDE.md —
//! not the asker's guesses about it.
//!
//! Every exchange is recorded in an in-memory registry and every state change
//! is broadcast to all windows as a `studio-exchange-updated` event, so the UI
//! can show the conversation live (sidebar card, rail pulse) instead of the
//! whole thing happening as an invisible subprocess.
//!
//! The answering agent runs WITHOUT permission bypass flags: in headless mode
//! unapproved tools are denied, so it can read the target repo but not mutate
//! it or run arbitrary commands. Exchanges are transcript-visible by design.

use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// Hard cap on one exchange (spawn → final answer). Headless agent runs on a
/// real codebase routinely take a minute or two; five is the give-up point.
const ASK_TIMEOUT_SECS: u64 = 300;

/// Cap on recorded activity lines per exchange (a runaway session can't grow
/// the registry unbounded; the tail is what the UI shows anyway).
const MAX_ACTIVITY_LINES: usize = 200;

/// How many finished exchanges the registry keeps for the history UI.
const MAX_EXCHANGES: usize = 20;

/// Longest activity/answer snippet stored per stream event.
const MAX_SNIPPET_CHARS: usize = 200;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// Registry
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExchangeStatus {
    Running,
    Completed,
    Failed,
}

/// One recorded activity line ("read src/api/metrics.ts", a text snippet…).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeActivity {
    pub at_ms: u64,
    /// "status" | "tool" | "text"
    pub kind: &'static str,
    pub text: String,
}

/// A single cross-project question/answer, live or finished.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioExchange {
    pub id: u64,
    /// Canonical path of the asking project.
    pub from_project: String,
    /// Canonical path of the answering project.
    pub to_project: String,
    pub question: String,
    pub status: ExchangeStatus,
    pub activity: Vec<ExchangeActivity>,
    pub answer: Option<String>,
    pub error: Option<String>,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
}

static EXCHANGES: LazyLock<Mutex<VecDeque<StudioExchange>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

static NEXT_EXCHANGE_ID: AtomicU64 = AtomicU64::new(1);

/// Snapshot of all known exchanges, newest first. Used by the frontend list
/// command and by tests.
pub fn list_exchanges() -> Vec<StudioExchange> {
    EXCHANGES
        .lock()
        .map(|q| q.iter().rev().cloned().collect())
        .unwrap_or_default()
}

fn create_exchange(from_project: &str, to_project: &str, question: &str) -> StudioExchange {
    let exchange = StudioExchange {
        id: NEXT_EXCHANGE_ID.fetch_add(1, Ordering::Relaxed),
        from_project: from_project.to_string(),
        to_project: to_project.to_string(),
        question: question.to_string(),
        status: ExchangeStatus::Running,
        activity: Vec::new(),
        answer: None,
        error: None,
        started_at_ms: now_ms(),
        finished_at_ms: None,
    };
    if let Ok(mut q) = EXCHANGES.lock() {
        q.push_back(exchange.clone());
        while q.len() > MAX_EXCHANGES {
            q.pop_front();
        }
    }
    exchange
}

/// Mutate one exchange in place and return the updated copy for emitting.
fn update_exchange(id: u64, f: impl FnOnce(&mut StudioExchange)) -> Option<StudioExchange> {
    let mut q = EXCHANGES.lock().ok()?;
    let exchange = q.iter_mut().find(|e| e.id == id)?;
    f(exchange);
    Some(exchange.clone())
}

fn push_activity(id: u64, kind: &'static str, text: String) -> Option<StudioExchange> {
    update_exchange(id, |e| {
        if e.activity.len() < MAX_ACTIVITY_LINES {
            e.activity.push(ExchangeActivity {
                at_ms: now_ms(),
                kind,
                text,
            });
        }
    })
}

fn finish_exchange(id: u64, outcome: Result<String, String>) -> Option<StudioExchange> {
    update_exchange(id, |e| {
        e.finished_at_ms = Some(now_ms());
        match outcome {
            Ok(answer) => {
                e.status = ExchangeStatus::Completed;
                e.answer = Some(answer);
            }
            Err(message) => {
                e.status = ExchangeStatus::Failed;
                e.error = Some(message);
            }
        }
    })
}

/// Broadcast an exchange snapshot to every window. Best-effort: a failed emit
/// only loses a UI refresh, never exchange state.
fn emit_updated(app: &tauri::AppHandle, exchange: &StudioExchange) {
    if let Err(e) = app.emit("studio-exchange-updated", exchange) {
        tracing::warn!("[StudioTalk] Failed to emit exchange update: {}", e);
    }
}

// ============================================================================
// stream-json parsing
// ============================================================================

/// What one line of `claude --output-format stream-json` output means to us.
#[derive(Debug, PartialEq)]
pub enum StreamEvent {
    Activity { kind: &'static str, text: String },
    Completed { answer: String },
    Failed { message: String },
    Ignored,
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Summarize a tool_use block into one human-readable activity line. Picks the
/// most descriptive well-known argument; falls back to the bare tool name.
fn summarize_tool_use(name: &str, input: &Value) -> String {
    const DESCRIPTIVE_KEYS: &[&str] = &["file_path", "path", "pattern", "command", "query", "url"];
    let detail = DESCRIPTIVE_KEYS
        .iter()
        .find_map(|k| input.get(k).and_then(Value::as_str));
    match detail {
        Some(d) => format!("{name}: {}", truncate_chars(d, 120)),
        None => name.to_string(),
    }
}

/// Parse one stream-json line from the answering agent. Pure and total: any
/// unrecognized or malformed line is `Ignored`, never an error — the stream
/// format can grow fields without breaking us.
pub fn parse_stream_line(line: &str) -> StreamEvent {
    let line = line.trim();
    if line.is_empty() {
        return StreamEvent::Ignored;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return StreamEvent::Ignored;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("system") => match value.get("subtype").and_then(Value::as_str) {
            Some("init") => StreamEvent::Activity {
                kind: "status",
                text: "Agent session started".to_string(),
            },
            _ => StreamEvent::Ignored,
        },
        Some("assistant") => {
            let blocks = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            let Some(blocks) = blocks else {
                return StreamEvent::Ignored;
            };
            // One line per message: prefer the tool call (what it's *doing*);
            // fall back to a text snippet (what it's *saying*).
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    return StreamEvent::Activity {
                        kind: "tool",
                        text: summarize_tool_use(name, &input),
                    };
                }
            }
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.trim().is_empty() {
                        return StreamEvent::Activity {
                            kind: "text",
                            text: truncate_chars(text.trim(), MAX_SNIPPET_CHARS),
                        };
                    }
                }
            }
            StreamEvent::Ignored
        }
        Some("result") => {
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
            let result_text = value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !is_error && subtype == "success" && !result_text.is_empty() {
                StreamEvent::Completed {
                    answer: result_text,
                }
            } else {
                let message = if result_text.is_empty() {
                    format!("The answering agent ended without an answer ({subtype})")
                } else {
                    result_text
                };
                StreamEvent::Failed { message }
            }
        }
        _ => StreamEvent::Ignored,
    }
}

// ============================================================================
// Project resolution (shared by studio_projects and studio_ask)
// ============================================================================

/// One row of the `studio_projects` listing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProjectInfo {
    pub name: String,
    pub path: String,
    /// True when this is the project the asking agent belongs to.
    pub is_self: bool,
    /// True when the project is open in a Ship Studio window.
    pub open: bool,
    /// The local port Ship Studio reserved for this project's preview, when
    /// the project is open and a port is reserved. The dev server for an open
    /// project usually serves on this port — probe it before relying on it.
    pub preview_port: Option<u16>,
}

/// Enumerate every known Ship Studio project: the projects root plus the
/// registered external projects.
pub fn known_projects(asking_project: &str) -> Vec<StudioProjectInfo> {
    let mut out: Vec<StudioProjectInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut push = |path: PathBuf| {
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        let path_str = canonical.to_string_lossy().to_string();
        if !seen.insert(path_str.clone()) {
            return;
        }
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        let window = crate::state::get_window_for_project(&path_str);
        let preview_port = window
            .as_ref()
            .and_then(|label| crate::state::get_reserved_port(label, &path_str));
        out.push(StudioProjectInfo {
            name,
            is_self: path_str == asking_project,
            open: window.is_some(),
            preview_port,
            path: path_str,
        });
    };

    if let Ok(root) = crate::utils::projects_root() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if crate::commands::projects::is_valid_project(&path) {
                    push(path);
                }
            }
        }
    }
    if let Ok(config) = crate::commands::external_projects::load_config() {
        for project in config.projects {
            let path = PathBuf::from(&project.path);
            if path.is_dir() {
                push(path);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Resolve a `studio_ask` target: an absolute path or a project folder name
/// (case-insensitive). Errors are written for the calling agent to read.
pub fn resolve_target_project(reference: &str, asking_project: &str) -> Result<PathBuf, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("Provide the target project's name or absolute path.".to_string());
    }
    let projects = known_projects(asking_project);

    let resolved = if Path::new(reference).is_absolute() {
        let canonical = std::fs::canonicalize(reference)
            .map_err(|e| format!("Project path '{reference}' is not accessible: {e}"))?;
        let canonical_str = canonical.to_string_lossy().to_string();
        projects
            .into_iter()
            .find(|p| p.path == canonical_str)
            .ok_or_else(|| {
                format!("'{reference}' is not a known Ship Studio project. Use studio_projects to list them.")
            })?
    } else {
        let mut matches = projects
            .into_iter()
            .filter(|p| p.name.eq_ignore_ascii_case(reference));
        match (matches.next(), matches.next()) {
            (None, _) => {
                return Err(format!(
                    "No Ship Studio project named '{reference}'. Use studio_projects to list them."
                ))
            }
            (Some(only), None) => only,
            (Some(first), Some(second)) => {
                let mut paths = vec![first.path, second.path];
                paths.extend(matches.map(|p| p.path));
                return Err(format!(
                    "Several projects are named '{reference}' ({}). Pass the absolute path instead.",
                    paths.join(", ")
                ));
            }
        }
    };

    if resolved.path == asking_project {
        return Err(
            "That's the project you're already working in — answer from your own context instead of asking it."
                .to_string(),
        );
    }
    // Belt-and-braces: the enumeration above only yields known projects, but
    // the security boundary is validate_project_path, same as every command.
    crate::utils::validate_project_path(&resolved.path).map_err(|e| e.to_string())
}

// ============================================================================
// The ask runner
// ============================================================================

fn project_display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn build_ask_prompt(from_project: &str, to_name: &str, question: &str) -> String {
    let from_name = project_display_name(from_project);
    format!(
        r###"You are the agent for the local project "{to_name}". The agent working on another local project, "{from_name}", is asking you a question about THIS project ({to_name}). Answer it from this repository's actual code and configuration — read files as needed, and reference real paths and behavior. Be direct and concrete; if the premise of the question doesn't match this codebase, say so. Keep the answer under ~400 words.

Question from {from_name}:
{question}"###
    )
}

/// Run one cross-project ask end to end: record the exchange, spawn the
/// headless agent in the target project, stream its activity into the registry
/// (broadcasting each step), and return the final answer.
///
/// Claude Code streams structured activity; other agents with a headless mode
/// (Cursor, Codex) answer without a live activity feed.
pub async fn run_studio_ask(
    app: tauri::AppHandle,
    from_project: String,
    to_project: PathBuf,
    question: String,
) -> Result<String, String> {
    let to_project_str = to_project.to_string_lossy().to_string();
    let to_name = project_display_name(&to_project_str);
    let exchange = create_exchange(&from_project, &to_project_str, &question);
    let id = exchange.id;
    emit_updated(&app, &exchange);

    let prompt = build_ask_prompt(&from_project, &to_name, &question);
    let result = match crate::commands::claude::find_claude_binary() {
        Some(claude_path) => {
            run_claude_streaming(&app, id, &claude_path, &prompt, &to_project).await
        }
        None => run_fallback_headless(&app, id, &prompt, &to_project).await,
    };

    if let Some(updated) = finish_exchange(id, result.clone()) {
        emit_updated(&app, &updated);
    }
    result
}

/// Non-Claude fallback: the active agent's plain headless mode. One status
/// line while it thinks; the answer arrives in a single step.
async fn run_fallback_headless(
    app: &tauri::AppHandle,
    id: u64,
    prompt: &str,
    to_project: &Path,
) -> Result<String, String> {
    let agent = crate::agent::get_active_agent();
    if let Some(updated) = push_activity(
        id,
        "status",
        format!("Asking via {} (no live activity feed)", agent.display_name),
    ) {
        emit_updated(app, &updated);
    }
    let agent_path = crate::commands::claude::find_agent_binary().ok_or_else(|| {
        format!(
            "No agent CLI available to answer: install Claude Code (or {}) to use studio_ask.",
            agent.display_name
        )
    })?;
    let envs = crate::commands::accounts::get_env_vars_for_project(to_project);
    crate::commands::ai::run_agent_headless(
        agent,
        &agent_path,
        prompt,
        to_project,
        envs,
        ASK_TIMEOUT_SECS,
    )
    .await
    .map(|answer| answer.trim().to_string())
    .map_err(|e| e.to_string())
}

/// Claude Code path: stream-json events give the live activity feed.
async fn run_claude_streaming(
    app: &tauri::AppHandle,
    id: u64,
    claude_path: &Path,
    prompt: &str,
    to_project: &Path,
) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut cmd = crate::utils::create_command(claude_path);
    cmd.args([
        "--print",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
    ])
    .env("PATH", crate::utils::get_extended_path())
    .envs(crate::commands::accounts::get_env_vars_for_project(
        to_project,
    ))
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .current_dir(to_project);

    let mut child = tokio::process::Command::from(cmd)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start the answering agent: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture the answering agent's output".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let streamed = tokio::time::timeout(Duration::from_secs(ASK_TIMEOUT_SECS), async {
        let mut outcome: Option<Result<String, String>> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            match parse_stream_line(&line) {
                StreamEvent::Activity { kind, text } => {
                    if let Some(updated) = push_activity(id, kind, text) {
                        emit_updated(app, &updated);
                    }
                }
                StreamEvent::Completed { answer } => {
                    outcome = Some(Ok(answer));
                    break;
                }
                StreamEvent::Failed { message } => {
                    outcome = Some(Err(message));
                    break;
                }
                StreamEvent::Ignored => {}
            }
        }
        outcome
    })
    .await;

    match streamed {
        Err(_) => {
            let _ = child.kill().await;
            Err(format!(
                "The answering agent didn't finish within {} minutes.",
                ASK_TIMEOUT_SECS / 60
            ))
        }
        Ok(Some(outcome)) => {
            // Reap the child so it doesn't linger as a zombie.
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            outcome
        }
        Ok(None) => {
            // Stream ended with no result event — the process died. Surface
            // whatever stderr it left behind.
            let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
                .await
                .map_err(|_| "The answering agent hung after closing its output".to_string())
                .and_then(|r| r.map_err(|e| format!("The answering agent failed: {e}")))?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            let snippet: String = stderr.trim().chars().take(300).collect();
            Err(if snippet.is_empty() {
                format!(
                    "The answering agent exited (code {:?}) without an answer.",
                    output.status.code()
                )
            } else {
                format!("The answering agent failed: {snippet}")
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that flood the global registry must not run concurrently with
    /// tests that assert on a specific exchange's presence — eviction would
    /// race. Grab this in every test that creates many exchanges or reads
    /// back through `list_exchanges`.
    static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parse_ignores_garbage_and_blank_lines() {
        assert_eq!(parse_stream_line(""), StreamEvent::Ignored);
        assert_eq!(parse_stream_line("not json"), StreamEvent::Ignored);
        assert_eq!(
            parse_stream_line("{\"type\":\"user\"}"),
            StreamEvent::Ignored
        );
    }

    #[test]
    fn parse_init_becomes_status_activity() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc"}"#;
        assert_eq!(
            parse_stream_line(line),
            StreamEvent::Activity {
                kind: "status",
                text: "Agent session started".to_string()
            }
        );
    }

    #[test]
    fn parse_assistant_tool_use_summarizes_input() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/api.ts"}}]}}"#;
        assert_eq!(
            parse_stream_line(line),
            StreamEvent::Activity {
                kind: "tool",
                text: "Read: /repo/src/api.ts".to_string()
            }
        );
    }

    #[test]
    fn parse_assistant_prefers_tool_use_over_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","name":"Grep","input":{"pattern":"metrics"}}]}}"#;
        assert_eq!(
            parse_stream_line(line),
            StreamEvent::Activity {
                kind: "tool",
                text: "Grep: metrics".to_string()
            }
        );
    }

    #[test]
    fn parse_assistant_text_is_truncated() {
        let long = "x".repeat(500);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}}]}}}}"#
        );
        match parse_stream_line(&line) {
            StreamEvent::Activity { kind: "text", text } => {
                assert!(text.chars().count() <= MAX_SNIPPET_CHARS + 1); // +1 for the ellipsis
                assert!(text.ends_with('…'));
            }
            other => panic!("expected text activity, got {other:?}"),
        }
    }

    #[test]
    fn parse_success_result_completes_with_answer() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"The endpoint returns JSON."}"#;
        assert_eq!(
            parse_stream_line(line),
            StreamEvent::Completed {
                answer: "The endpoint returns JSON.".to_string()
            }
        );
    }

    #[test]
    fn parse_error_result_fails_with_message() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#;
        match parse_stream_line(line) {
            StreamEvent::Failed { message } => assert!(message.contains("error_max_turns")),
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn parse_empty_success_result_is_failure() {
        // A "success" with no text is not an answer the asker can use.
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"  "}"#;
        assert!(matches!(
            parse_stream_line(line),
            StreamEvent::Failed { .. }
        ));
    }

    #[test]
    fn registry_roundtrip_and_cap() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let ex = create_exchange("/tmp/from", "/tmp/to", "why?");
        assert_eq!(ex.status, ExchangeStatus::Running);
        push_activity(ex.id, "tool", "Read: a.ts".into());
        let done = finish_exchange(ex.id, Ok("because.".into())).expect("exists");
        assert_eq!(done.status, ExchangeStatus::Completed);
        assert_eq!(done.answer.as_deref(), Some("because."));
        assert_eq!(done.activity.len(), 1);
        assert!(done.finished_at_ms.is_some());

        let listed = list_exchanges();
        assert!(listed.iter().any(|e| e.id == ex.id));

        // Cap: flooding the registry keeps it bounded.
        for i in 0..(MAX_EXCHANGES + 5) {
            create_exchange("/tmp/from", "/tmp/to", &format!("q{i}"));
        }
        assert!(list_exchanges().len() <= MAX_EXCHANGES);
    }

    #[test]
    fn finish_failure_records_error() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let ex = create_exchange("/tmp/from", "/tmp/to", "q");
        let done = finish_exchange(ex.id, Err("boom".into())).expect("exists");
        assert_eq!(done.status, ExchangeStatus::Failed);
        assert_eq!(done.error.as_deref(), Some("boom"));
        assert!(done.answer.is_none());
    }

    #[test]
    fn activity_lines_are_capped() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let ex = create_exchange("/tmp/from", "/tmp/to", "q");
        for i in 0..(MAX_ACTIVITY_LINES + 50) {
            push_activity(ex.id, "tool", format!("step {i}"));
        }
        let listed = list_exchanges();
        let found = listed.iter().find(|e| e.id == ex.id).expect("exists");
        assert_eq!(found.activity.len(), MAX_ACTIVITY_LINES);
    }

    #[test]
    fn ask_prompt_names_both_projects() {
        let prompt = build_ask_prompt("/Users/x/ShipStudio/agent-app", "dashboard", "What port?");
        assert!(prompt.contains("agent-app"));
        assert!(prompt.contains("dashboard"));
        assert!(prompt.contains("What port?"));
    }

    #[test]
    fn resolve_rejects_empty_and_unknown() {
        assert!(resolve_target_project("", "/tmp/self").is_err());
        assert!(resolve_target_project("definitely-not-a-project-name", "/tmp/self").is_err());
    }

    #[test]
    fn summarize_tool_use_falls_back_to_name() {
        assert_eq!(
            summarize_tool_use("TodoWrite", &serde_json::json!({})),
            "TodoWrite"
        );
        assert_eq!(
            summarize_tool_use("Bash", &serde_json::json!({"command": "ls -la"})),
            "Bash: ls -la"
        );
    }
}
