//! # Backend-owned PTY session registry
//!
//! Owns PTYs for agent/terminal tabs. The frontend talks to this via
//! `pty_session_open` / `pty_session_attach` / `pty_session_write` /
//! `pty_session_resize` / `pty_session_kill` / `pty_session_list`. Data and
//! exit signals are pushed to the frontend as Tauri events
//! (`pty-session-data`, `pty-session-exit`), each carrying the owning
//! `session_id` so the attached `Terminal` React component can filter and
//! render them.
//!
//! Why the backend owns it: **the PTY is decoupled from the React
//! component's lifecycle.** A Terminal can unmount and remount (project
//! switch, HMR) without the PTY noticing. Kill happens only when the
//! user explicitly closes a tab / switches agent / closes a project.
//!
//! Each session keeps a ~128 KiB tail of its output so a newly-attached
//! frontend can replay recent history into xterm — a background
//! project's terminal would otherwise look empty when switched back in.

use crate::errors::CommandError;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

/// Max bytes retained per-session for attach-time replay. ~128 KiB is enough
/// for a few screenfuls of a modern TUI (Claude Code banner + recent prompt)
/// without becoming a memory burden across dozens of background sessions.
const RING_BUFFER_MAX: usize = 128 * 1024;

/// Minimum PTY dimension. Windows ConPTY wedges (produces no output, or
/// hangs the client) when created or resized at 0 rows/cols — which the
/// frontend can request when it spawns before xterm has measured its
/// container. Clamp to a small sane floor; the real size follows via resize.
const MIN_PTY_DIMENSION: u16 = 2;

/// Clamp a requested PTY size to the minimum ConPTY tolerates.
fn clamp_pty_size(rows: u16, cols: u16) -> (u16, u16) {
    (rows.max(MIN_PTY_DIMENSION), cols.max(MIN_PTY_DIMENSION))
}

/// Ring buffer + cumulative-offset accounting, guarded by ONE mutex so that
/// appending a chunk and advancing the offset are atomic with respect to an
/// attach snapshot.
///
/// `total_offset` counts every byte ever read from the PTY — ring trimming
/// does NOT decrease it. Each emitted `pty-session-data` event carries the
/// chunk's start offset, and `pty_session_attach` returns `total_offset` at
/// snapshot time as `end_offset`. Because append + offset increment happen
/// under the same lock as the snapshot, an event chunk either lies entirely
/// before the snapshot (`offset + len <= end_offset`) or entirely at/after
/// it (`offset >= end_offset`) — it can never straddle the boundary. That's
/// what lets the frontend subscribe *before* attaching and drop exactly the
/// chunks the snapshot already covers.
struct SessionBuffer {
    ring: VecDeque<u8>,
    total_offset: u64,
}

impl SessionBuffer {
    fn new() -> Self {
        Self {
            ring: VecDeque::with_capacity(8192),
            total_offset: 0,
        }
    }

    /// Append a chunk, returning its start offset (the cumulative byte
    /// count before this chunk).
    fn append(&mut self, bytes: &[u8]) -> u64 {
        let start = self.total_offset;
        append_to_ring(&mut self.ring, bytes);
        self.total_offset = start.saturating_add(bytes.len() as u64);
        // No-straddle invariant: the offset advances by exactly the chunk
        // length in the same critical section as the ring append, so any
        // snapshot end_offset (also read under this mutex) coincides with a
        // chunk boundary — never the middle of a chunk. Also: we can never
        // retain more bytes than were ever produced.
        debug_assert_eq!(self.total_offset, start + bytes.len() as u64);
        debug_assert!(self.ring.len() as u64 <= self.total_offset);
        start
    }
}

struct Session {
    pid: u32,
    project_path: Option<String>,
    tab_session_id: Option<String>,
    alive: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    buffer: Mutex<SessionBuffer>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    created_at_ms: u64,
}

static REGISTRY: LazyLock<Mutex<HashMap<String, Arc<Session>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Windows system vars that cmd.exe / ConPTY / Node require. Mirrors the
/// critical subset of `get_system_env` in `commands/pty/mod.rs` — injected
/// server-side in `pty_session_open` so a frontend env map that lost them
/// (the PTY env replaces, not merges, the parent env) can't produce a
/// wedged, output-less session.
#[cfg_attr(not(windows), allow(dead_code))]
const CRITICAL_WINDOWS_ENV_VARS: [&str; 5] =
    ["SystemRoot", "COMSPEC", "PATHEXT", "windir", "SYSTEMDRIVE"];

/// Case-insensitive key lookup — Windows env var names are case-insensitive,
/// and the frontend may send e.g. `SYSTEMROOT` where we check `SystemRoot`.
#[cfg_attr(not(windows), allow(dead_code))]
fn env_has_key(env: &BTreeMap<String, String>, key: &str) -> bool {
    env.keys().any(|k| k.eq_ignore_ascii_case(key))
}

fn append_to_ring(ring: &mut VecDeque<u8>, bytes: &[u8]) {
    if bytes.len() >= RING_BUFFER_MAX {
        ring.clear();
        let start = bytes.len() - RING_BUFFER_MAX;
        ring.extend(bytes[start..].iter().copied());
        return;
    }
    let overflow = ring
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(RING_BUFFER_MAX);
    for _ in 0..overflow {
        ring.pop_front();
    }
    ring.extend(bytes.iter().copied());
}

#[derive(Serialize)]
pub struct OpenSessionResult {
    pub session_id: String,
    pub pid: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    /// Recent output bytes (the ring buffer tail) — xterm should write these
    /// immediately to restore the visible scrollback.
    pub buffer: Vec<u8>,
    pub pid: u32,
    pub alive: bool,
    pub exit_code: Option<i32>,
    /// Cumulative byte offset at snapshot time (total bytes ever read from
    /// the PTY, independent of ring trimming). Live `pty-session-data`
    /// events whose `offset` is `< end_offset` are already contained in
    /// `buffer` and must be dropped by the subscriber.
    pub end_offset: u64,
}

#[derive(Serialize)]
pub struct SessionListItem {
    pub session_id: String,
    pub pid: u32,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub project_path: Option<String>,
    pub tab_session_id: Option<String>,
    pub created_at_ms: u64,
}

/// Open a PTY for a tab. The caller provides a stable `session_id` (usually
/// a UUID from the frontend's tab model) so re-open attempts are idempotent
/// and so the same id routes through write/attach/kill later.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[tracing::instrument(skip_all, fields(session_id = %session_id, command = %command))]
pub async fn pty_session_open(
    app: AppHandle,
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    cols: u16,
    rows: u16,
    project_path: Option<String>,
    tab_session_id: Option<String>,
) -> Result<OpenSessionResult, CommandError> {
    // Idempotent: if a live session already exists for this id, return it.
    // If an exited session exists under this id (e.g. resume-failed retry
    // respawns the same tab), evict it so we can spawn fresh.
    {
        let mut map = REGISTRY
            .lock()
            .map_err(|e| format!("pty registry poisoned: {e}"))?;
        if let Some(existing) = map.get(&session_id) {
            if existing.alive.load(Ordering::Relaxed) {
                return Ok(OpenSessionResult {
                    session_id: session_id.clone(),
                    pid: existing.pid,
                });
            }
            map.remove(&session_id);
        }
    }

    let (rows, cols) = clamp_pty_size(rows, cols);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    if let Some(ref c) = cwd {
        cmd.cwd(std::ffi::OsString::from(c));
    }
    for (k, v) in env.iter() {
        cmd.env(std::ffi::OsString::from(k), std::ffi::OsString::from(v));
    }

    // Windows safety net: the provided env REPLACES the parent environment,
    // so if the frontend's map is missing critical system vars, cmd.exe /
    // ConPTY / Node fail in silent, confusing ways (a PTY that never
    // produces a byte). Backfill them from the app's own environment when
    // absent — the frontend-supplied values still win when present.
    #[cfg(windows)]
    for key in CRITICAL_WINDOWS_ENV_VARS {
        if !env_has_key(&env, key) {
            if let Ok(val) = std::env::var(key) {
                cmd.env(std::ffi::OsString::from(key), std::ffi::OsString::from(val));
            }
        }
    }

    // Inject the project's Workspace credentials/config dirs SERVER-SIDE, so
    // secret token values (Vercel/Figma/OpenAI/Anthropic-base-url) never have to
    // cross the IPC boundary into the webview's JS. The backend wins over any
    // frontend-supplied values for these keys. Falls back to the active
    // Workspace when the PTY isn't tied to a project.
    let account_env = match project_path.as_deref() {
        Some(p) => crate::commands::accounts::get_env_vars_for_project(std::path::Path::new(p)),
        None => crate::commands::accounts::get_env_vars_for_active_account(),
    };
    for (k, v) in account_env {
        cmd.env(std::ffi::OsString::from(&k), std::ffi::OsString::from(&v));
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command: {e}"))?;
    let pid = child.process_id().unwrap_or(0);
    let child_killer = child.clone_killer();

    let session = Arc::new(Session {
        pid,
        project_path: project_path.clone(),
        tab_session_id: tab_session_id.clone(),
        alive: AtomicBool::new(true),
        exit_code: Mutex::new(None),
        buffer: Mutex::new(SessionBuffer::new()),
        writer: Mutex::new(writer),
        child_killer: Mutex::new(child_killer),
        master: Mutex::new(pair.master),
        created_at_ms: now_ms(),
    });

    REGISTRY
        .lock()
        .map_err(|e| format!("pty registry poisoned: {e}"))?
        .insert(session_id.clone(), session.clone());

    // Reader thread: pushes data events + appends to the ring buffer.
    {
        let session_id_for_reader = session_id.clone();
        let session_for_reader = session.clone();
        let app_for_reader = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — child closed slave
                    Ok(n) => n,
                    Err(_) => break,
                };
                let chunk = &buf[..n];
                // Capture the chunk's start offset under the SAME lock that
                // appends it to the ring — this atomicity is what guarantees
                // an attach snapshot's end_offset always lands on a chunk
                // boundary (see `SessionBuffer`).
                let Ok(chunk_start_offset) = session_for_reader
                    .buffer
                    .lock()
                    .map(|mut b| b.append(chunk))
                else {
                    break; // poisoned — registry is unusable for this session
                };
                let _ = app_for_reader.emit(
                    "pty-session-data",
                    serde_json::json!({
                        "sessionId": session_id_for_reader,
                        "data": chunk,
                        "offset": chunk_start_offset,
                    }),
                );
            }
        });
    }

    // Waiter thread: blocks on child.wait(), records exit code, emits exit.
    {
        let session_id_for_waiter = session_id.clone();
        let session_for_waiter = session.clone();
        let app_for_waiter = app.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => {
                    if status.success() {
                        0
                    } else {
                        // portable_pty exposes exit_code as u32 (0-255).
                        status.exit_code() as i32
                    }
                }
                Err(_) => -1,
            };
            session_for_waiter.alive.store(false, Ordering::Relaxed);
            if let Ok(mut slot) = session_for_waiter.exit_code.lock() {
                *slot = Some(code);
            }
            let _ = app_for_waiter.emit(
                "pty-session-exit",
                serde_json::json!({
                    "sessionId": session_id_for_waiter,
                    "exitCode": code,
                }),
            );
        });
    }

    tracing::info!(
        "[pty_session] opened session {} (pid {}), project={:?}",
        session_id,
        pid,
        project_path
    );

    Ok(OpenSessionResult { session_id, pid })
}

#[tauri::command]
#[tracing::instrument(skip(data))]
pub fn pty_session_write(session_id: String, data: Vec<u8>) -> Result<(), CommandError> {
    let session = {
        let map = REGISTRY
            .lock()
            .map_err(|e| format!("pty registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown session".to_string().into());
    };
    let mut w = session
        .writer
        .lock()
        .map_err(|e| format!("writer lock poisoned: {e}"))?;
    w.write_all(&data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub fn pty_session_resize(session_id: String, cols: u16, rows: u16) -> Result<(), CommandError> {
    let session = {
        let map = REGISTRY
            .lock()
            .map_err(|e| format!("pty registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown session".to_string().into());
    };
    let (rows, cols) = clamp_pty_size(rows, cols);
    let master = session
        .master
        .lock()
        .map_err(|e| format!("master lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub fn pty_session_kill(session_id: String) -> Result<(), CommandError> {
    // Pop first so repeated kills are no-ops and the reader thread can exit
    // cleanly on its next read.
    let session = {
        let mut map = REGISTRY
            .lock()
            .map_err(|e| format!("pty registry poisoned: {e}"))?;
        map.remove(&session_id)
    };
    let Some(session) = session else {
        return Ok(());
    };
    {
        let mut killer = session
            .child_killer
            .lock()
            .map_err(|e| format!("killer lock poisoned: {e}"))?;
        let _ = killer.kill();
    }
    session.alive.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub fn pty_session_attach(session_id: String) -> Result<AttachResult, CommandError> {
    let session = {
        let map = REGISTRY
            .lock()
            .map_err(|e| format!("pty registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown session".to_string().into());
    };
    // Snapshot bytes AND end offset under one lock acquisition: the pair
    // must be consistent for the frontend's offset filter to be exact.
    let (buffer, end_offset): (Vec<u8>, u64) = {
        let b = session
            .buffer
            .lock()
            .map_err(|e| format!("buffer lock poisoned: {e}"))?;
        debug_assert!(b.ring.len() as u64 <= b.total_offset);
        (b.ring.iter().copied().collect(), b.total_offset)
    };
    let alive = session.alive.load(Ordering::Relaxed);
    let exit_code = *session
        .exit_code
        .lock()
        .map_err(|e| format!("exit lock poisoned: {e}"))?;
    Ok(AttachResult {
        buffer,
        pid: session.pid,
        alive,
        exit_code,
        end_offset,
    })
}

#[tauri::command]
#[tracing::instrument]
pub fn pty_session_list(
    project_path: Option<String>,
) -> Result<Vec<SessionListItem>, CommandError> {
    let map = REGISTRY
        .lock()
        .map_err(|e| format!("pty registry poisoned: {e}"))?;
    let mut items = Vec::new();
    for (session_id, session) in map.iter() {
        if let Some(ref wanted) = project_path {
            if session.project_path.as_deref() != Some(wanted.as_str()) {
                continue;
            }
        }
        let alive = session.alive.load(Ordering::Relaxed);
        let exit_code = *session
            .exit_code
            .lock()
            .map_err(|e| format!("exit lock poisoned: {e}"))?;
        items.push(SessionListItem {
            session_id: session_id.clone(),
            pid: session.pid,
            alive,
            exit_code,
            project_path: session.project_path.clone(),
            tab_session_id: session.tab_session_id.clone(),
            created_at_ms: session.created_at_ms,
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_append_within_limit() {
        let mut ring = VecDeque::new();
        append_to_ring(&mut ring, b"hello");
        append_to_ring(&mut ring, b" world");
        let out: Vec<u8> = ring.iter().copied().collect();
        assert_eq!(&out, b"hello world");
    }

    #[test]
    fn ring_buffer_drops_front_on_overflow() {
        let mut ring = VecDeque::new();
        let big = vec![b'a'; RING_BUFFER_MAX];
        append_to_ring(&mut ring, &big);
        append_to_ring(&mut ring, b"XYZ");
        assert_eq!(ring.len(), RING_BUFFER_MAX);
        let tail: Vec<u8> = ring.iter().rev().take(3).copied().collect();
        assert_eq!(tail, b"ZYX");
    }

    #[test]
    fn ring_buffer_trims_oversized_single_write() {
        let mut ring = VecDeque::new();
        let huge = vec![b'q'; RING_BUFFER_MAX + 5000];
        append_to_ring(&mut ring, &huge);
        assert_eq!(ring.len(), RING_BUFFER_MAX);
        assert!(ring.iter().all(|&b| b == b'q'));
    }

    #[test]
    fn offset_accounting_across_appends() {
        let mut buf = SessionBuffer::new();
        assert_eq!(buf.append(b"hello"), 0);
        assert_eq!(buf.append(b" world"), 5);
        assert_eq!(buf.append(b""), 11);
        assert_eq!(buf.append(b"!"), 11);
        assert_eq!(buf.total_offset, 12);
        let out: Vec<u8> = buf.ring.iter().copied().collect();
        assert_eq!(&out, b"hello world!");
    }

    #[test]
    fn offset_keeps_counting_past_ring_trim() {
        let mut buf = SessionBuffer::new();
        let big = vec![b'a'; RING_BUFFER_MAX];
        assert_eq!(buf.append(&big), 0);
        // This append trims the ring's front, but offsets are cumulative:
        // they count bytes ever produced, not bytes retained.
        assert_eq!(buf.append(b"XYZ"), RING_BUFFER_MAX as u64);
        assert_eq!(buf.total_offset, RING_BUFFER_MAX as u64 + 3);
        assert_eq!(buf.ring.len(), RING_BUFFER_MAX);

        // Oversized single write: ring keeps only the tail; offset counts it all.
        let huge = vec![b'q'; RING_BUFFER_MAX + 5000];
        let start = buf.append(&huge);
        assert_eq!(start, RING_BUFFER_MAX as u64 + 3);
        assert_eq!(buf.total_offset, start + huge.len() as u64);
        assert_eq!(buf.ring.len(), RING_BUFFER_MAX);
    }

    #[test]
    fn attach_end_offset_matches_snapshot_even_after_trim() {
        let mut buf = SessionBuffer::new();
        let big = vec![b'z'; RING_BUFFER_MAX + 100];
        buf.append(&big);
        buf.append(b"tail");
        // What pty_session_attach snapshots under the lock:
        let snapshot: Vec<u8> = buf.ring.iter().copied().collect();
        let end_offset = buf.total_offset;
        assert_eq!(end_offset, big.len() as u64 + 4);
        assert_eq!(snapshot.len(), RING_BUFFER_MAX);
        // The snapshot always covers exactly the bytes with offsets in
        // [end_offset - snapshot.len(), end_offset) — the math holds even
        // though the ring dropped older bytes.
        assert!(snapshot.len() as u64 <= end_offset);
        assert_eq!(&snapshot[snapshot.len() - 4..], b"tail");
    }

    #[test]
    fn snapshot_end_offset_never_straddles_a_chunk() {
        // Simulate the reader thread appending chunks while attaches take
        // snapshots at every possible interleaving point. Since append and
        // snapshot both run under the buffer mutex, the only observable
        // end_offsets are the total_offset values between appends — assert
        // none of them falls strictly inside any chunk's [start, start+len).
        let chunks: [&[u8]; 4] = [b"first", b"", b"second-chunk", b"x"];
        let mut buf = SessionBuffer::new();
        let mut chunk_ranges: Vec<(u64, u64)> = Vec::new();
        let mut snapshot_points = vec![buf.total_offset];
        for chunk in chunks {
            let start = buf.append(chunk);
            chunk_ranges.push((start, start + chunk.len() as u64));
            snapshot_points.push(buf.total_offset);
        }
        for &end_offset in &snapshot_points {
            for &(start, end) in &chunk_ranges {
                let straddles = end_offset > start && end_offset < end;
                assert!(
                    !straddles,
                    "end_offset {end_offset} straddles chunk [{start}, {end})"
                );
                // The frontend's filter is total: each chunk is either fully
                // covered by the snapshot or fully after it.
                assert!(end <= end_offset || start >= end_offset);
            }
        }
    }

    #[test]
    fn clamp_pty_size_floors_zero_and_one() {
        assert_eq!(clamp_pty_size(0, 0), (2, 2));
        assert_eq!(clamp_pty_size(1, 0), (2, 2));
        assert_eq!(clamp_pty_size(0, 120), (2, 120));
        assert_eq!(clamp_pty_size(24, 1), (24, 2));
        assert_eq!(clamp_pty_size(24, 80), (24, 80));
        assert_eq!(clamp_pty_size(u16::MAX, u16::MAX), (u16::MAX, u16::MAX));
    }

    #[test]
    fn env_has_key_is_case_insensitive() {
        let mut env = BTreeMap::new();
        env.insert("SYSTEMROOT".to_string(), "C:\\Windows".to_string());
        assert!(env_has_key(&env, "SystemRoot"));
        assert!(env_has_key(&env, "systemroot"));
        assert!(!env_has_key(&env, "COMSPEC"));
    }
}
