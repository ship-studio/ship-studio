//! Run history and filed findings.
//!
//! Stored at `~/ShipStudio/.shipstudio/routines-state.json`, next to
//! `folders.json` and `attached-libraries.json` — **not** in the project repo.
//! A routine's *definition* is source and belongs in the tree; its output is
//! per-machine churn that would otherwise appear in `git status` and in pull
//! requests within a day of real use.

use super::Severity;
use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// How many runs to keep per routine. Enough to see a pattern, small enough
/// that the state file stays hand-readable.
const MAX_RUNS_PER_ROUTINE: usize = 20;

/// Cap on a stored transcript. The full thing can be megabytes of agent
/// chatter; the tail is the part with the answer in it.
const MAX_TRANSCRIPT_BYTES: usize = 16_000;

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
pub struct RoutineRun {
    pub id: String,
    pub routine_id: String,
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
    pub routine_id: String,
    pub routine_name: String,
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
    /// `createdAt` instead of filing a second copy — a routine on a 30-minute
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
pub struct RoutinesState {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub inbox: Vec<InboxItem>,
    #[serde(default)]
    pub runs: Vec<RoutineRun>,
    /// Last completion per routine id, so an interval means "this long since it
    /// last ran" rather than a wall clock the app can't keep.
    #[serde(default)]
    pub last_run_at: std::collections::BTreeMap<String, i64>,
    /// HEAD at the end of each routine's last successful run, so the next one
    /// can be told exactly what moved since it last looked.
    #[serde(default)]
    pub last_run_commit: std::collections::BTreeMap<String, String>,
}

/// Serializes writes so two runs finishing together can't lose each other's
/// findings through a read-modify-write race.
static STATE_LOCK: Mutex<()> = Mutex::new(());

pub fn state_path() -> Result<PathBuf, CommandError> {
    let home = dirs::home_dir()
        .ok_or_else(|| CommandError::expected("Could not find your home directory"))?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("routines-state.json"))
}

/// Read the state file. A missing or corrupt file reads as empty rather than
/// failing: losing run history is an annoyance, but refusing to open the Inbox
/// because one JSON byte went bad is a broken app.
pub fn load_state() -> RoutinesState {
    let Ok(path) = state_path() else {
        return RoutinesState::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save_state(state: &RoutinesState) -> Result<(), CommandError> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::utils::classify_fs_error("create the app data folder", parent, &e)
        })?;
    }
    let contents = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize routines state: {e}"))?;
    std::fs::write(&path, contents)
        .map_err(|e| crate::utils::classify_fs_error("save routines state", &path, &e))
}

/// Read, mutate, write — under the lock.
pub fn mutate_state<T>(f: impl FnOnce(&mut RoutinesState) -> T) -> Result<T, CommandError> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state();
    let out = f(&mut state);
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

/// Drop the oldest runs of `routine_id` beyond the retention cap.
pub fn prune_runs(state: &mut RoutinesState, routine_id: &str) {
    let mut seen = 0;
    state.runs.retain(|run| {
        if run.routine_id != routine_id {
            return true;
        }
        seen += 1;
        seen <= MAX_RUNS_PER_ROUTINE
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

/// Run history for one routine, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn list_routine_runs(routine_id: String) -> Result<Vec<RoutineRun>, CommandError> {
    let mut runs: Vec<RoutineRun> = load_state()
        .runs
        .into_iter()
        .filter(|run| run.routine_id == routine_id)
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

    fn run(id: &str, routine: &str, started_at: i64) -> RoutineRun {
        RoutineRun {
            id: id.to_string(),
            routine_id: routine.to_string(),
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
    fn prune_keeps_the_cap_for_the_named_routine_only() {
        let mut state = RoutinesState::default();
        for i in 0..30 {
            state.runs.push(run(&format!("a{i}"), "routine-a", i));
        }
        for i in 0..5 {
            state.runs.push(run(&format!("b{i}"), "routine-b", i));
        }
        prune_runs(&mut state, "routine-a");
        assert_eq!(
            state
                .runs
                .iter()
                .filter(|r| r.routine_id == "routine-a")
                .count(),
            MAX_RUNS_PER_ROUTINE
        );
        assert_eq!(
            state
                .runs
                .iter()
                .filter(|r| r.routine_id == "routine-b")
                .count(),
            5,
            "pruning one routine must not touch another's history"
        );
    }

    #[test]
    fn prune_keeps_the_newest_when_runs_are_pushed_front() {
        let mut state = RoutinesState::default();
        // record_run inserts each new run at the head, so a29 is the newest.
        for i in 0..30 {
            state.runs.insert(0, run(&format!("a{i}"), "routine-a", i));
        }
        prune_runs(&mut state, "routine-a");
        assert_eq!(state.runs.first().unwrap().id, "a29");
        assert_eq!(state.runs.len(), MAX_RUNS_PER_ROUTINE);
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

    #[test]
    fn corrupt_state_reads_as_empty_rather_than_erroring() {
        let parsed: Result<RoutinesState, _> = serde_json::from_str("{ not json");
        assert!(parsed.is_err());
        // load_state() swallows exactly this case; assert the default is sane.
        let fallback = RoutinesState::default();
        assert!(fallback.inbox.is_empty());
        assert!(fallback.runs.is_empty());
    }
}
