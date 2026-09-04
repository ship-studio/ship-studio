//! Live activity from a running workflow.
//!
//! A workflow run is 30 seconds to a couple of minutes of nothing. A spinner
//! answers "is it running"; it does not answer "is it doing anything sensible",
//! which is the question people actually have the first few times they trust an
//! unattended agent with their repo.
//!
//! So each run streams a short human line per step — `Reading src/lib/auth.ts`,
//! `git diff --stat`, or the agent's own narration — kept in a small ring
//! buffer per workflow and pushed to open windows as it happens.
//!
//! Deliberately *not* the full transcript: the run history already has that.
//! This is the one-line "what's happening now" plus enough scrollback to see
//! how it got there.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Lines kept per workflow. Enough to see the shape of a run, small enough that
/// a long one can't grow without bound.
const MAX_LINES: usize = 120;

/// Emitted per activity line so open windows can follow along.
pub const WORKFLOW_PROGRESS_EVENT: &str = "workflows:progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressLine {
    pub workflow_id: String,
    pub at: i64,
    pub text: String,
}

static PROGRESS: Mutex<Option<HashMap<String, VecDeque<ProgressLine>>>> = Mutex::new(None);

/// Drop anything recorded for a workflow. Called as a run starts, so the panel
/// shows this run rather than a confusing mix with the last one.
pub fn reset(workflow_id: &str) {
    let mut guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(workflow_id.to_string(), VecDeque::new());
}

/// Record one activity line and push it to open windows.
pub fn push(app: Option<&AppHandle>, workflow_id: &str, text: impl Into<String>) {
    let text = text.into();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    let line = ProgressLine {
        workflow_id: workflow_id.to_string(),
        at: super::state::now_ms(),
        text: trimmed.to_string(),
    };
    {
        let mut guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        let buffer = map.entry(workflow_id.to_string()).or_default();
        buffer.push_back(line.clone());
        while buffer.len() > MAX_LINES {
            buffer.pop_front();
        }
    }
    if let Some(app) = app {
        let _ = app.emit(WORKFLOW_PROGRESS_EVENT, &line);
    }
}

/// What has been recorded for a workflow, oldest first.
///
/// A window opened mid-run has missed every event, so it asks for the buffer
/// once and follows events from there.
#[tauri::command]
#[tracing::instrument]
pub async fn workflow_progress(
    workflow_id: String,
) -> Result<Vec<ProgressLine>, crate::errors::CommandError> {
    let guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    Ok(guard
        .as_ref()
        .and_then(|map| map.get(&workflow_id))
        .map(|buffer| buffer.iter().cloned().collect())
        .unwrap_or_default())
}

/* ------------------------------------------------------ stream translation */

/// Turn one line of `claude --output-format stream-json` into something a
/// person would want to read, or `None` for the bookkeeping events.
///
/// The interesting events are tool uses (what it's touching) and the agent's
/// own text (what it thinks). Everything else — init, rate-limit info, tool
/// results, the final result envelope — is noise at this level.
pub fn describe_claude_event(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                let input = block.get("input");
                return Some(describe_tool(name, input));
            }
            Some("text") => {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let first = text.trim().lines().next().unwrap_or("").trim();
                if !first.is_empty() {
                    return Some(truncate(first, 160));
                }
            }
            _ => {}
        }
    }
    None
}

/// The one detail that says what a tool call is actually doing.
fn describe_tool(name: &str, input: Option<&serde_json::Value>) -> String {
    let field = |key: &str| {
        input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    match name {
        "Read" => field("file_path").map_or_else(
            || "Reading a file".to_string(),
            |path| format!("Reading {}", short_path(&path)),
        ),
        "Bash" => field("command").map_or_else(
            || "Running a command".to_string(),
            |cmd| format!("$ {}", truncate(cmd.trim(), 120)),
        ),
        "Grep" => field("pattern").map_or_else(
            || "Searching".to_string(),
            |pattern| format!("Searching for {}", truncate(&pattern, 80)),
        ),
        "Glob" => field("pattern").map_or_else(
            || "Listing files".to_string(),
            |pattern| format!("Listing {pattern}"),
        ),
        "WebFetch" | "WebSearch" => field("url").or_else(|| field("query")).map_or_else(
            || "Fetching from the web".to_string(),
            |q| format!("Fetching {}", truncate(&q, 100)),
        ),
        other => format!("{other}…"),
    }
}

/// Trim an absolute path down to the tail that identifies it.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.rsplit('/').take(3).collect();
    let tail = parts.into_iter().rev().collect::<Vec<_>>().join("/");
    if tail.len() < path.len() {
        format!("…/{tail}")
    } else {
        tail
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_read_by_its_file() {
        let raw = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/x/proj/src/api/checkout.js"}}]}}"#;
        assert_eq!(
            describe_claude_event(raw).as_deref(),
            Some("Reading …/src/api/checkout.js")
        );
    }

    #[test]
    fn describes_a_bash_call_by_its_command() {
        let raw = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git diff --stat"}}]}}"#;
        assert_eq!(
            describe_claude_event(raw).as_deref(),
            Some("$ git diff --stat")
        );
    }

    #[test]
    fn surfaces_the_agents_own_narration() {
        let raw = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll read the file.\nThen check auth."}]}}"#;
        assert_eq!(
            describe_claude_event(raw).as_deref(),
            Some("I'll read the file.")
        );
    }

    #[test]
    fn ignores_bookkeeping_events() {
        for raw in [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#,
            r#"{"type":"result","result":"done"}"#,
            "not json at all",
            "",
        ] {
            assert_eq!(describe_claude_event(raw), None, "should ignore: {raw}");
        }
    }

    #[test]
    fn long_commands_are_truncated_not_wrapped() {
        let long = "x".repeat(400);
        let raw = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        let described = describe_claude_event(&raw).unwrap();
        assert!(described.chars().count() < 130);
        assert!(described.ends_with('…'));
    }

    #[test]
    fn short_paths_are_left_alone() {
        assert_eq!(short_path("a.txt"), "a.txt");
        assert_eq!(short_path("src/a.txt"), "src/a.txt");
    }

    #[test]
    fn the_buffer_is_capped_and_resettable() {
        let id = "progress-test-workflow";
        reset(id);
        for i in 0..(MAX_LINES + 40) {
            push(None, id, format!("line {i}"));
        }
        let guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let buffer = guard.as_ref().unwrap().get(id).unwrap();
        assert_eq!(buffer.len(), MAX_LINES);
        // Oldest dropped, newest kept.
        assert_eq!(
            buffer.back().unwrap().text,
            format!("line {}", MAX_LINES + 39)
        );
        drop(guard);
        reset(id);
        let guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        assert!(guard.as_ref().unwrap().get(id).unwrap().is_empty());
    }

    #[test]
    fn blank_lines_are_not_recorded() {
        let id = "progress-blank-test";
        reset(id);
        push(None, id, "   ");
        push(None, id, "");
        let guard = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        assert!(guard.as_ref().unwrap().get(id).unwrap().is_empty());
    }
}
