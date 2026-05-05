//! # Snapshot / Undo / Redo
//!
//! Per-turn working-tree snapshots so users can undo agent edits even when the
//! agent didn't commit. The mechanism is independent of the agent and the
//! branch:
//!
//! - A `notify` watcher subscribes to the project directory.
//! - File-change bursts are debounced (`DEBOUNCE_MS`).
//! - When the burst settles, we shell out to `git stash create` (plumbing —
//!   builds a commit object representing the working tree + index without
//!   touching HEAD, the working tree, or the stash list).
//! - The returned SHA is appended to an in-memory linked list per project.
//!   `undo` walks the cursor back; `redo` walks it forward; both apply the
//!   tree to the working directory via `git read-tree` + `git checkout-index`.
//!
//! Notes:
//! - The list is in-memory only; it resets when the watcher stops (e.g. window
//!   close or project switch). The underlying `stash create` commit objects
//!   are still in `.git/objects` and `git gc` will eventually prune them, so
//!   we don't grow the on-disk repo unboundedly.
//! - We CAP the list at `MAX_HISTORY` entries — older snapshots fall off the
//!   front.
//! - During undo/redo we pause the watcher (via a flag) so the act of
//!   restoring files doesn't itself create a new snapshot.

use crate::errors::CommandError;
use crate::utils::{create_command, validate_project_path};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tracing::{debug, info, instrument, warn};

const DEBOUNCE_MS: u64 = 1500;
const MAX_HISTORY: usize = 50;
const IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".shipstudio",
    ".next",
    ".turbo",
    "dist",
    "build",
    ".vercel",
    ".cache",
    ".DS_Store",
];

/// One entry in the per-project history.
struct Snapshot {
    /// SHA returned by `git stash create`. Empty string means "empty working tree"
    /// (stash create returns nothing when there's nothing to snapshot).
    sha: String,
}

/// Per-project history + watcher handle.
struct ProjectHistory {
    /// Most recent at the back; cursor is the index of the snapshot currently
    /// applied to the working tree. New snapshots truncate everything after the
    /// cursor (standard linear undo semantics).
    snapshots: VecDeque<Snapshot>,
    cursor: usize,
    /// True while we're applying an undo/redo so the watcher's debounced
    /// `record_snapshot` skips the resulting file events.
    suppress_record: Arc<AtomicBool>,
    watcher_shutdown: Option<oneshot::Sender<()>>,
}

impl ProjectHistory {
    fn new() -> Self {
        Self {
            snapshots: VecDeque::new(),
            cursor: 0,
            suppress_record: Arc::new(AtomicBool::new(false)),
            watcher_shutdown: None,
        }
    }

    fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    fn can_redo(&self) -> bool {
        !self.snapshots.is_empty() && self.cursor + 1 < self.snapshots.len()
    }
}

static HISTORIES: LazyLock<Mutex<HashMap<PathBuf, ProjectHistory>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Clone, Default)]
pub struct SnapshotStatus {
    pub watching: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub history_size: usize,
    pub cursor: usize,
    /// Files that changed between the prior cursor and the new one. Always
    /// empty for `snapshot_status`; populated by `snapshot_undo` /
    /// `snapshot_redo` so the UI can toast a meaningful summary.
    #[serde(default)]
    pub files_changed: Vec<String>,
}

/// Decide whether a path that triggered the watcher should count toward
/// snapshot creation. Excludes well-known generated dirs and the `.git`
/// internals (which would otherwise spam events on every git operation).
fn is_relevant_path(p: &Path, project_root: &Path) -> bool {
    let Ok(rel) = p.strip_prefix(project_root) else {
        return false;
    };
    for component in rel.components() {
        let s = component.as_os_str().to_string_lossy();
        if IGNORE_DIRS.iter().any(|&ignored| ignored == s) {
            return false;
        }
    }
    true
}

/// Capture the current working tree as a stash commit. Returns the SHA, or
/// empty string if the tree is clean (nothing to snapshot).
fn capture_snapshot(project_path: &Path) -> Result<String, CommandError> {
    let output = create_command("git")
        .args(["stash", "create"])
        .current_dir(project_path)
        .output()
        .map_err(|e| CommandError::Io {
            message: format!("git stash create: {e}"),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(CommandError::Process {
            cmd: "git stash create".into(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr,
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// List files that differ between two snapshot tree-ish refs. Empty SHA is
/// treated as HEAD (the clean baseline). Returns relative paths; never errors
/// upward — diff failures are non-fatal for undo/redo, just produce an empty
/// list.
fn diff_files(project_path: &Path, from_sha: &str, to_sha: &str) -> Vec<String> {
    let from_ref = if from_sha.is_empty() {
        "HEAD"
    } else {
        from_sha
    };
    let to_ref = if to_sha.is_empty() { "HEAD" } else { to_sha };
    if from_ref == to_ref {
        return Vec::new();
    }
    let output = match create_command("git")
        .args(["diff", "--name-only", from_ref, to_ref])
        .current_dir(project_path)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Apply a captured snapshot's tree to the working directory + index.
/// Empty SHA means "make the working tree match a clean HEAD" — which we do
/// by resetting tracked files to HEAD and removing files that the snapshot
/// didn't have. We're careful not to touch HEAD or the branch itself.
fn apply_snapshot(project_path: &Path, sha: &str) -> Result<(), CommandError> {
    if sha.is_empty() {
        // Clean working tree: reset tracked files to HEAD.
        let out = create_command("git")
            .args(["checkout-index", "-a", "-f"])
            .current_dir(project_path)
            .output()
            .map_err(|e| CommandError::Io {
                message: format!("git checkout-index: {e}"),
            })?;
        if !out.status.success() {
            return Err(CommandError::Process {
                cmd: "git checkout-index".into(),
                exit_code: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        return Ok(());
    }

    // `stash create` produces a merge commit whose first parent is HEAD and
    // whose tree is the working tree. Apply that tree to both the index and
    // the working directory.
    let read_tree = create_command("git")
        .args(["read-tree", "-u", "--reset", sha])
        .current_dir(project_path)
        .output()
        .map_err(|e| CommandError::Io {
            message: format!("git read-tree: {e}"),
        })?;
    if !read_tree.status.success() {
        return Err(CommandError::Process {
            cmd: "git read-tree".into(),
            exit_code: read_tree.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&read_tree.stderr).to_string(),
        });
    }
    Ok(())
}

/// Append a new snapshot to the history. Called from the debounced watcher
/// task. No-op if the resulting SHA equals the snapshot at the current cursor
/// (= no semantic change).
fn record_snapshot(project_path: &Path) {
    // Don't record while undo/redo is rewriting files.
    let suppress = {
        let map = match HISTORIES.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match map.get(project_path) {
            Some(h) => h.suppress_record.clone(),
            None => return,
        }
    };
    if suppress.load(Ordering::Relaxed) {
        debug!("snapshot suppressed (undo/redo in progress)");
        return;
    }

    let sha = match capture_snapshot(project_path) {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "failed to capture snapshot");
            return;
        }
    };

    let mut map = match HISTORIES.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(history) = map.get_mut(project_path) else {
        return;
    };

    // Skip if identical to the current cursor entry (true no-op edit, e.g. a
    // file save with no content change).
    if let Some(current) = history.snapshots.get(history.cursor) {
        if current.sha == sha {
            return;
        }
    }

    // Truncate the redo tail: a new edit branches history.
    if !history.snapshots.is_empty() && history.cursor + 1 < history.snapshots.len() {
        history.snapshots.drain((history.cursor + 1)..);
    }

    history.snapshots.push_back(Snapshot { sha });
    // Cap history.
    while history.snapshots.len() > MAX_HISTORY {
        history.snapshots.pop_front();
    }
    history.cursor = history.snapshots.len().saturating_sub(1);
    debug!(
        cursor = history.cursor,
        total = history.snapshots.len(),
        "snapshot recorded"
    );
}

/// Spawn the watcher for a project. Returns the shutdown sender so the caller
/// can stop it on `snapshot_stop_watching`.
fn spawn_watcher(project_path: PathBuf) -> oneshot::Sender<()> {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<()>(64);

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop_flag.clone();
    let watch_path = project_path.clone();

    // notify uses a sync callback, so spin up a dedicated std thread to host
    // the watcher and bridge into our async world via the mpsc channel.
    std::thread::spawn(move || {
        let watch_root = watch_path.clone();
        let mut watcher =
            match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                let Ok(event) = res else { return };
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        let relevant = event.paths.iter().any(|p| is_relevant_path(p, &watch_root));
                        if relevant {
                            let _ = event_tx.try_send(());
                        }
                    }
                    _ => {}
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    warn!("[snapshots] failed to create watcher: {e}");
                    return;
                }
            };

        if let Err(e) = watcher.watch(&watch_path, RecursiveMode::Recursive) {
            warn!("[snapshots] failed to watch path: {e}");
            return;
        }
        info!("[snapshots] watching {}", watch_path.display());

        loop {
            std::thread::park_timeout(Duration::from_secs(1));
            if stop_for_thread.load(Ordering::Relaxed) {
                info!(
                    "[snapshots] watcher thread exiting for {}",
                    watch_path.display()
                );
                break;
            }
        }
        // watcher dropped here.
    });

    // Debounce loop on tokio.
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(()) = event_rx.recv() => {
                    // Wait for the burst to settle. If new events arrive, restart the timer.
                    loop {
                        let sleep = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS));
                        tokio::pin!(sleep);
                        tokio::select! {
                            _ = &mut sleep => break,
                            Some(()) = event_rx.recv() => continue,
                        }
                    }
                    // Drain any extras that arrived during the final tick.
                    while event_rx.try_recv().is_ok() {}
                    let path = project_path.clone();
                    tokio::task::spawn_blocking(move || record_snapshot(&path)).await.ok();
                }
                _ = &mut shutdown_rx => {
                    stop_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    });

    shutdown_tx
}

// ============ Tauri Commands ============

/// Begin watching a project for filesystem changes and recording per-turn
/// snapshots. Idempotent — calling it twice for the same project is a no-op.
/// Also seeds the history with an initial snapshot of the current state so
/// the first undo has somewhere to go back to.
#[tauri::command]
#[instrument(name = "snapshot_start_watching", skip(project_path), fields(project = %project_path))]
pub async fn snapshot_start_watching(project_path: String) -> Result<(), CommandError> {
    let validated = validate_project_path(&project_path)?;
    let key = validated.clone();

    // Seed initial snapshot before locking — capture_snapshot shells out.
    let initial_sha = capture_snapshot(&validated).unwrap_or_default();

    let already_watching = {
        let map = HISTORIES.lock().map_err(|_| CommandError::Other {
            message: "history lock poisoned".into(),
        })?;
        map.get(&key)
            .and_then(|h| h.watcher_shutdown.as_ref())
            .is_some()
    };
    if already_watching {
        return Ok(());
    }

    let shutdown = spawn_watcher(validated.clone());

    let mut map = HISTORIES.lock().map_err(|_| CommandError::Other {
        message: "history lock poisoned".into(),
    })?;
    let history = map.entry(key).or_insert_with(ProjectHistory::new);
    if history.snapshots.is_empty() {
        history.snapshots.push_back(Snapshot { sha: initial_sha });
        history.cursor = 0;
    }
    history.watcher_shutdown = Some(shutdown);
    Ok(())
}

/// Stop watching and clear the in-memory history for a project.
#[tauri::command]
#[instrument(name = "snapshot_stop_watching", skip(project_path), fields(project = %project_path))]
pub async fn snapshot_stop_watching(project_path: String) -> Result<(), CommandError> {
    let validated = validate_project_path(&project_path)?;
    let mut map = HISTORIES.lock().map_err(|_| CommandError::Other {
        message: "history lock poisoned".into(),
    })?;
    if let Some(mut history) = map.remove(&validated) {
        if let Some(tx) = history.watcher_shutdown.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// Returns whether undo/redo are currently available.
#[tauri::command]
#[instrument(name = "snapshot_status", skip(project_path), fields(project = %project_path))]
pub async fn snapshot_status(project_path: String) -> Result<SnapshotStatus, CommandError> {
    let validated = validate_project_path(&project_path)?;
    let map = HISTORIES.lock().map_err(|_| CommandError::Other {
        message: "history lock poisoned".into(),
    })?;
    Ok(match map.get(&validated) {
        Some(h) => SnapshotStatus {
            watching: h.watcher_shutdown.is_some(),
            can_undo: h.can_undo(),
            can_redo: h.can_redo(),
            history_size: h.snapshots.len(),
            cursor: h.cursor,
            files_changed: Vec::new(),
        },
        None => SnapshotStatus::default(),
    })
}

/// Step the cursor back one entry and apply that snapshot to the working tree.
#[tauri::command]
#[instrument(name = "snapshot_undo", skip(project_path), fields(project = %project_path))]
pub async fn snapshot_undo(project_path: String) -> Result<SnapshotStatus, CommandError> {
    let validated = validate_project_path(&project_path)?;
    step(&validated, -1)
}

/// Step the cursor forward one entry and apply that snapshot.
#[tauri::command]
#[instrument(name = "snapshot_redo", skip(project_path), fields(project = %project_path))]
pub async fn snapshot_redo(project_path: String) -> Result<SnapshotStatus, CommandError> {
    let validated = validate_project_path(&project_path)?;
    step(&validated, 1)
}

fn step(project_path: &Path, delta: i32) -> Result<SnapshotStatus, CommandError> {
    // Phase 1: pick the target SHA + the previous SHA (for diffing) +
    // suppress flag while holding the lock.
    let (from_sha, target_sha, suppress) = {
        let mut map = HISTORIES.lock().map_err(|_| CommandError::Other {
            message: "history lock poisoned".into(),
        })?;
        let history = map
            .get_mut(project_path)
            .ok_or_else(|| CommandError::Other {
                message: "no snapshot history (watcher not started)".into(),
            })?;

        let new_cursor = match delta {
            -1 if history.can_undo() => history.cursor - 1,
            1 if history.can_redo() => history.cursor + 1,
            _ => {
                return Ok(SnapshotStatus {
                    watching: history.watcher_shutdown.is_some(),
                    can_undo: history.can_undo(),
                    can_redo: history.can_redo(),
                    history_size: history.snapshots.len(),
                    cursor: history.cursor,
                    files_changed: Vec::new(),
                });
            }
        };
        let from = history
            .snapshots
            .get(history.cursor)
            .map(|s| s.sha.clone())
            .unwrap_or_default();
        let to = history
            .snapshots
            .get(new_cursor)
            .map(|s| s.sha.clone())
            .unwrap_or_default();
        history.cursor = new_cursor;
        (from, to, history.suppress_record.clone())
    };

    // Compute the diff BEFORE applying — both refs still resolve cleanly and
    // we don't have to worry about intermediate index state.
    let files_changed = diff_files(project_path, &from_sha, &target_sha);

    // Phase 2: apply the snapshot WITHOUT holding the lock — the watcher will
    // fire from the file changes, and `record_snapshot` needs the lock too.
    suppress.store(true, Ordering::Relaxed);
    let apply_result = apply_snapshot(project_path, &target_sha);
    // Hold the suppress flag a beat longer than DEBOUNCE_MS so the trailing
    // watcher events get dropped instead of recording a no-op snapshot.
    let suppress_clone = suppress.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS + 500)).await;
        suppress_clone.store(false, Ordering::Relaxed);
    });

    apply_result?;

    // Phase 3: re-read state for the response.
    let map = HISTORIES.lock().map_err(|_| CommandError::Other {
        message: "history lock poisoned".into(),
    })?;
    let history = map.get(project_path).ok_or_else(|| CommandError::Other {
        message: "history disappeared mid-step".into(),
    })?;
    Ok(SnapshotStatus {
        watching: history.watcher_shutdown.is_some(),
        can_undo: history.can_undo(),
        can_redo: history.can_redo(),
        history_size: history.snapshots.len(),
        cursor: history.cursor,
        files_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo(dir: &Path) {
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir)
            .status()
            .unwrap();
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com")] {
            Command::new("git")
                .args(["config", k, v])
                .current_dir(dir)
                .status()
                .unwrap();
        }
        fs::write(dir.join("a.txt"), "v1").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(dir)
            .status()
            .unwrap();
    }

    #[test]
    fn capture_returns_empty_for_clean_tree() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let sha = capture_snapshot(tmp.path()).unwrap();
        assert!(
            sha.is_empty(),
            "clean tree should give empty sha, got {sha:?}"
        );
    }

    #[test]
    fn capture_returns_sha_for_dirty_tree() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("a.txt"), "v2-modified").unwrap();
        let sha = capture_snapshot(tmp.path()).unwrap();
        assert!(!sha.is_empty(), "dirty tree must produce sha");
        assert_eq!(sha.len(), 40, "expected full sha, got {sha:?}");
    }

    #[test]
    fn apply_snapshot_restores_tree() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        // Snapshot A (modified)
        fs::write(tmp.path().join("a.txt"), "version-A").unwrap();
        let sha_a = capture_snapshot(tmp.path()).unwrap();
        // Move on to B
        fs::write(tmp.path().join("a.txt"), "version-B").unwrap();
        // Apply A
        apply_snapshot(tmp.path(), &sha_a).unwrap();
        let restored = fs::read_to_string(tmp.path().join("a.txt")).unwrap();
        assert_eq!(restored, "version-A");
    }

    #[test]
    fn is_relevant_path_excludes_node_modules_and_git() {
        let root = Path::new("/tmp/proj");
        assert!(!is_relevant_path(&root.join(".git/HEAD"), root));
        assert!(!is_relevant_path(&root.join("node_modules/foo/x.js"), root));
        assert!(!is_relevant_path(
            &root.join(".shipstudio/project.json"),
            root
        ));
        assert!(is_relevant_path(&root.join("src/App.tsx"), root));
    }
}
