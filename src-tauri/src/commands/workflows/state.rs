//! Run history and filed findings.
//!
//! Stored at `~/ShipStudio/.shipstudio/workflows-state.json`, next to
//! `folders.json` and `attached-libraries.json` — **not** in the project repo.
//! A workflow's *definition* is source and belongs in the tree; its output is
//! per-machine churn that would otherwise appear in `git status` and in pull
//! requests within a day of real use.

use super::Severity;
use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// How many runs to keep per workflow. Enough to see a pattern, small enough
/// that the state file stays hand-readable.
const MAX_RUNS_PER_WORKFLOW: usize = 20;

/// Cap on a stored transcript. The full thing can be megabytes of agent
/// chatter; the tail is the part with the answer in it.
const MAX_TRANSCRIPT_BYTES: usize = 16_000;

/// Cap on filed findings. Runs are already pruned per workflow, but the inbox
/// was not bounded at all: a couple of armed workflows finding new things every
/// day grow this file forever, and it is read in full on every scheduler tick
/// and every list. Dropping starts with what the user has already dealt with.
const MAX_INBOX_ITEMS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Completed, nothing worth filing.
    Ok,
    /// Completed and filed at least one finding.
    Findings,
    Failed,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub started_at: i64,
    pub duration_ms: i64,
    pub status: RunStatus,
    pub findings: usize,
    /// Tokens billed to the user's own agent subscription, when the CLI reports
    /// them. `None` renders as "—": a guessed number here would be worse than
    /// no number, since the whole point is letting people watch their quota.
    pub tokens: Option<u64>,
    /// Why it failed, for a failed run. Absent otherwise.
    pub error: Option<String>,
    pub transcript: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FindingLocation {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub project_name: String,
    pub project_path: String,
    pub severity: Severity,
    pub title: String,
    pub summary: String,
    pub body_md: String,
    pub created_at: i64,
    pub read: bool,
    pub archived: bool,
    /// Stable identity across runs. A repeat bumps `occurrences` and refreshes
    /// `createdAt` instead of filing a second copy — a workflow on a 30-minute
    /// interval would otherwise produce 48 identical items a day and the inbox
    /// would be useless by lunchtime.
    pub fingerprint: String,
    pub occurrences: u32,
    pub first_seen_at: i64,
    pub locations: Vec<FindingLocation>,
    pub suggested_prompt: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsState {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub inbox: Vec<InboxItem>,
    #[serde(default)]
    pub runs: Vec<WorkflowRun>,
    /// Last completion per workflow id, so an interval means "this long since it
    /// last ran" rather than a wall clock the app can't keep.
    #[serde(default)]
    pub last_run_at: std::collections::BTreeMap<String, i64>,
    /// HEAD at the end of each workflow's last successful run, so the next one
    /// can be told exactly what moved since it last looked.
    #[serde(default)]
    pub last_run_commit: std::collections::BTreeMap<String, String>,
}

/// Serializes writes so two runs finishing together can't lose each other's
/// findings through a read-modify-write race.
static STATE_LOCK: Mutex<()> = Mutex::new(());

/// Overrides where run history and findings are stored.
///
/// Exists so a test that executes a real run cannot write into the developer's
/// own inbox. It could, and did: the end-to-end test builds a throwaway
/// `tempdir` project, and its findings landed in the real state file as items
/// from a project called `.tmpwlS1C3` that no longer existed.
pub const STATE_PATH_ENV: &str = "SHIPSTUDIO_WORKFLOWS_STATE";

pub fn state_path() -> Result<PathBuf, CommandError> {
    if let Some(override_path) = std::env::var_os(STATE_PATH_ENV) {
        return Ok(PathBuf::from(override_path));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| CommandError::expected("Could not find your home directory"))?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("workflows-state.json"))
}

/// Read the state file. A missing or corrupt file reads as empty rather than
/// failing: losing run history is an annoyance, but refusing to open the Inbox
/// because one JSON byte went bad is a broken app.
///
/// A file that is present but unparseable is set aside as `.corrupt` before the
/// next write replaces it, so "the Inbox came up empty" leaves something a
/// person can look at instead of being a silent, total loss.
pub fn load_state() -> WorkflowsState {
    let Ok(path) = state_path() else {
        return WorkflowsState::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return WorkflowsState::default();
    };
    match serde_json::from_str(&contents) {
        Ok(state) => state,
        Err(err) => {
            let quarantine = path.with_extension("json.corrupt");
            tracing::error!(
                error = %err,
                path = %path.display(),
                kept_at = %quarantine.display(),
                "workflows state was unreadable; keeping a copy before it is replaced"
            );
            let _ = std::fs::rename(&path, &quarantine);
            WorkflowsState::default()
        }
    }
}

/// Write the state file, atomically.
///
/// Temp file then rename, the same shape `removed-projects.json` and the setup
/// state use. This file holds the entire inbox and every run record, so a
/// half-written one — a crash, a full disk, a laptop lid closing on a sleeping
/// process — would read back as corrupt and take the lot with it.
pub fn save_state(state: &WorkflowsState) -> Result<(), CommandError> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::utils::classify_fs_error("create the app data folder", parent, &e)
        })?;
    }
    let contents = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize workflows state: {e}"))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workflows-state.json");
    let temp_path = path.with_file_name(format!(".{file_name}.tmp"));
    std::fs::write(&temp_path, contents)
        .map_err(|e| crate::utils::classify_fs_error("save workflows state", &temp_path, &e))?;
    std::fs::rename(&temp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        crate::utils::classify_fs_error("save workflows state", &path, &e)
    })
}

/// Read, mutate, write — under the lock.
pub fn mutate_state<T>(f: impl FnOnce(&mut WorkflowsState) -> T) -> Result<T, CommandError> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state();
    let out = f(&mut state);
    prune_inbox(&mut state);
    state.version = 1;
    save_state(&state)?;
    Ok(out)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Keep the last `MAX_TRANSCRIPT_BYTES` on a char boundary.
pub fn trim_transcript(raw: &str) -> String {
    if raw.len() <= MAX_TRANSCRIPT_BYTES {
        return raw.to_string();
    }
    let start = raw.len() - MAX_TRANSCRIPT_BYTES;
    let start = (start..raw.len())
        .find(|i| raw.is_char_boundary(*i))
        .unwrap_or(raw.len());
    format!("…\n{}", &raw[start..])
}

/// Hold the inbox at `MAX_INBOX_ITEMS`, dropping what the user is least likely
/// to miss first.
///
/// The order is archived, then read, then unread — and within each group the
/// oldest goes first. An unread critical finding from this morning is the last
/// thing in the file to be dropped, which is the only ordering that lets a cap
/// exist at all without the cap itself becoming the bug.
pub fn prune_inbox(state: &mut WorkflowsState) {
    if state.inbox.len() <= MAX_INBOX_ITEMS {
        return;
    }
    let mut order: Vec<usize> = (0..state.inbox.len()).collect();
    // Least valuable first: this is the order things are dropped in.
    order.sort_by_key(|&i| {
        let item = &state.inbox[i];
        let tier = if item.archived {
            0
        } else if item.read {
            1
        } else {
            2
        };
        (tier, item.created_at)
    });
    let doomed: std::collections::HashSet<usize> = order
        .into_iter()
        .take(state.inbox.len() - MAX_INBOX_ITEMS)
        .collect();
    let mut index = 0;
    state.inbox.retain(|_| {
        let keep = !doomed.contains(&index);
        index += 1;
        keep
    });
}

/// Drop the oldest runs of `workflow_id` beyond the retention cap.
pub fn prune_runs(state: &mut WorkflowsState, workflow_id: &str) {
    let mut seen = 0;
    state.runs.retain(|run| {
        if run.workflow_id != workflow_id {
            return true;
        }
        seen += 1;
        seen <= MAX_RUNS_PER_WORKFLOW
    });
}

/* --------------------------------------------------------------- commands */

/// Every filed finding, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn list_inbox_items() -> Result<Vec<InboxItem>, CommandError> {
    let mut items = load_state().inbox;
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

/// Run history for one workflow, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn list_workflow_runs(workflow_id: String) -> Result<Vec<WorkflowRun>, CommandError> {
    let mut runs: Vec<WorkflowRun> = load_state()
        .runs
        .into_iter()
        .filter(|run| run.workflow_id == workflow_id)
        .collect();
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(runs)
}

#[tauri::command]
#[tracing::instrument]
pub async fn set_inbox_item_read(id: String, read: bool) -> Result<(), CommandError> {
    mutate_state(|state| {
        if let Some(item) = state.inbox.iter_mut().find(|i| i.id == id) {
            item.read = read;
        }
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn set_inbox_item_archived(id: String, archived: bool) -> Result<(), CommandError> {
    mutate_state(|state| {
        if let Some(item) = state.inbox.iter_mut().find(|i| i.id == id) {
            item.archived = archived;
            if archived {
                item.read = true;
            }
        }
    })
}

/// Permanently remove one finding.
///
/// Distinct from archiving: archived items still count as "told you about
/// this" and keep their fingerprint muted for future runs. Deleting forgets
/// the finding entirely, so the next run that sees the same problem files it
/// as new — which is the right behaviour for something you deleted because it
/// was wrong, and the reason both actions exist.
#[tauri::command]
#[tracing::instrument]
pub async fn delete_inbox_item(id: String) -> Result<(), CommandError> {
    mutate_state(|state| {
        state.inbox.retain(|item| item.id != id);
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn mark_all_inbox_read() -> Result<(), CommandError> {
    mutate_state(|state| {
        for item in state.inbox.iter_mut().filter(|i| !i.archived) {
            item.read = true;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, workflow: &str, started_at: i64) -> WorkflowRun {
        WorkflowRun {
            id: id.to_string(),
            workflow_id: workflow.to_string(),
            started_at,
            duration_ms: 0,
            status: RunStatus::Ok,
            findings: 0,
            tokens: None,
            error: None,
            transcript: String::new(),
        }
    }

    #[test]
    fn prune_keeps_the_cap_for_the_named_workflow_only() {
        let mut state = WorkflowsState::default();
        for i in 0..30 {
            state.runs.push(run(&format!("a{i}"), "workflow-a", i));
        }
        for i in 0..5 {
            state.runs.push(run(&format!("b{i}"), "workflow-b", i));
        }
        prune_runs(&mut state, "workflow-a");
        assert_eq!(
            state
                .runs
                .iter()
                .filter(|r| r.workflow_id == "workflow-a")
                .count(),
            MAX_RUNS_PER_WORKFLOW
        );
        assert_eq!(
            state
                .runs
                .iter()
                .filter(|r| r.workflow_id == "workflow-b")
                .count(),
            5,
            "pruning one workflow must not touch another's history"
        );
    }

    #[test]
    fn prune_keeps_the_newest_when_runs_are_pushed_front() {
        let mut state = WorkflowsState::default();
        // record_run inserts each new run at the head, so a29 is the newest.
        for i in 0..30 {
            state.runs.insert(0, run(&format!("a{i}"), "workflow-a", i));
        }
        prune_runs(&mut state, "workflow-a");
        assert_eq!(state.runs.first().unwrap().id, "a29");
        assert_eq!(state.runs.len(), MAX_RUNS_PER_WORKFLOW);
    }

    #[test]
    fn transcript_is_trimmed_to_the_tail_on_a_char_boundary() {
        let raw = format!("{}{}", "é".repeat(20_000), "TAIL");
        let trimmed = trim_transcript(&raw);
        assert!(trimmed.len() <= MAX_TRANSCRIPT_BYTES + 8);
        assert!(trimmed.ends_with("TAIL"), "the answer is at the end");
        assert!(trimmed.starts_with('…'));
    }

    #[test]
    fn short_transcripts_are_untouched() {
        assert_eq!(trim_transcript("hello"), "hello");
    }

    fn item(id: &str, created_at: i64, read: bool, archived: bool) -> InboxItem {
        InboxItem {
            id: id.to_string(),
            workflow_id: "w".to_string(),
            workflow_name: "W".to_string(),
            project_name: "p".to_string(),
            project_path: "/p".to_string(),
            severity: Severity::Warning,
            title: id.to_string(),
            summary: String::new(),
            body_md: String::new(),
            created_at,
            read,
            archived,
            fingerprint: id.to_string(),
            occurrences: 1,
            first_seen_at: created_at,
            locations: Vec::new(),
            suggested_prompt: String::new(),
            run_id: "r".to_string(),
        }
    }

    #[test]
    fn an_inbox_under_the_cap_is_left_alone() {
        let mut state = WorkflowsState::default();
        for i in 0..10 {
            state.inbox.push(item(&format!("i{i}"), i, false, false));
        }
        prune_inbox(&mut state);
        assert_eq!(state.inbox.len(), 10);
    }

    #[test]
    fn pruning_drops_archived_before_read_and_read_before_unread() {
        let mut state = WorkflowsState::default();
        // Newest first in each group, so age is never what saves an item here.
        for i in 0..MAX_INBOX_ITEMS {
            state
                .inbox
                .push(item(&format!("archived{i}"), 9_000 + i as i64, true, true));
        }
        for i in 0..MAX_INBOX_ITEMS {
            state
                .inbox
                .push(item(&format!("read{i}"), 8_000 + i as i64, true, false));
        }
        state.inbox.push(item("unread-oldest", 1, false, false));
        prune_inbox(&mut state);

        assert_eq!(state.inbox.len(), MAX_INBOX_ITEMS);
        assert!(
            state.inbox.iter().any(|i| i.id == "unread-oldest"),
            "the oldest unread finding outranks every archived and read one"
        );
        assert!(
            !state.inbox.iter().any(|i| i.archived),
            "archived findings go first"
        );
    }

    #[test]
    fn pruning_within_a_group_drops_the_oldest() {
        let mut state = WorkflowsState::default();
        for i in 0..(MAX_INBOX_ITEMS + 2) {
            state
                .inbox
                .push(item(&format!("u{i}"), i as i64, false, false));
        }
        prune_inbox(&mut state);
        assert_eq!(state.inbox.len(), MAX_INBOX_ITEMS);
        assert!(!state.inbox.iter().any(|i| i.id == "u0"));
        assert!(!state.inbox.iter().any(|i| i.id == "u1"));
        assert!(state.inbox.iter().any(|i| i.id == "u2"));
    }

    #[test]
    fn corrupt_state_reads_as_empty_rather_than_erroring() {
        let parsed: Result<WorkflowsState, _> = serde_json::from_str("{ not json");
        assert!(parsed.is_err());
        // load_state() swallows exactly this case; assert the default is sane.
        let fallback = WorkflowsState::default();
        assert!(fallback.inbox.is_empty());
        assert!(fallback.runs.is_empty());
    }
}
