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

struct Session {
    pid: u32,
    project_path: Option<String>,
    tab_session_id: Option<String>,
    alive: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    buffer: Mutex<VecDeque<u8>>,
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
pub struct AttachResult {
    /// Recent output bytes (the ring buffer tail) — xterm should write these
    /// immediately to restore the visible scrollback before subscribing to
    /// the live data event stream.
    pub buffer: Vec<u8>,
    pub pid: u32,
    pub alive: bool,
    pub exit_code: Option<i32>,
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
        buffer: Mutex::new(VecDeque::with_capacity(8192)),
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
                if let Ok(mut ring) = session_for_reader.buffer.lock() {
                    append_to_ring(&mut ring, chunk);
                }
                let _ = app_for_reader.emit(
                    "pty-session-data",
                    serde_json::json!({
                        "sessionId": session_id_for_reader,
                        "data": chunk,
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
    let buffer: Vec<u8> = {
        let ring = session
            .buffer
            .lock()
            .map_err(|e| format!("buffer lock poisoned: {e}"))?;
        ring.iter().copied().collect()
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
}
