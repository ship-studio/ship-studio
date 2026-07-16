use std::{
    collections::BTreeMap,
    ffi::OsString,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::{
    async_runtime::{Mutex, RwLock},
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Default)]
struct PluginState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    reader: Mutex<Box<dyn std::io::Read + Send>>,
}

type PtyHandler = u32;

/// Minimum PTY dimension. Windows ConPTY wedges (produces no output, or
/// hangs the client) when created or resized at 0 rows/cols — which a
/// caller can request when it spawns before its terminal widget has been
/// measured. Clamp to a small sane floor; the real size follows via resize.
const MIN_PTY_DIMENSION: u16 = 2;

/// Clamp a requested PTY size to the minimum ConPTY tolerates.
fn clamp_pty_size(rows: u16, cols: u16) -> (u16, u16) {
    (rows.max(MIN_PTY_DIMENSION), cols.max(MIN_PTY_DIMENSION))
}

#[tauri::command]
async fn spawn<R: Runtime>(
    file: String,
    args: Vec<String>,
    term_name: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    encoding: Option<String>,
    handle_flow_control: Option<bool>,
    flow_control_pause: Option<String>,
    flow_control_resume: Option<String>,

    state: tauri::State<'_, PluginState>,
    _app_handle: AppHandle<R>,
) -> Result<PtyHandler, String> {
    let _ = term_name;
    let _ = encoding;
    let _ = handle_flow_control;
    let _ = flow_control_pause;
    let _ = flow_control_resume;

    let (rows, cols) = clamp_pty_size(rows, cols);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    // Name the binary in the error — this string is what the frontend shows
    // when a spawn fails (e.g. binary missing from the PTY's PATH).
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to start `{file}`: {e}"))?;
    let child_killer = child.clone_killer();
    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    let pair = Arc::new(Session {
        pair: Mutex::new(pair),
        child: Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer: Mutex::new(writer),
        reader: Mutex::new(reader),
    });
    state.sessions.write().await.insert(handler, pair);
    Ok(handler)
}

#[tauri::command]
async fn write(
    pid: PtyHandler,
    data: String,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn read(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<Vec<u8>, String> {
    // Session gone → the frontend's read loop checks for "EOF" to exit
    // cleanly. Returning any other error here would log a rejected
    // promise on every iteration during teardown, flooding the Tauri
    // IPC bridge and (on macOS WebKit) eventually crashing the network
    // process.
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("EOF")?
        .clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; 4096];
        let mut reader = session.reader.blocking_lock();
        let n = loop {
            match reader.read(&mut buf) {
                Ok(n) => break n,
                // A signal delivered to the process (e.g. SIGCHLD from any
                // other exiting subprocess) can interrupt the blocking read.
                // The frontend's read loop treats ANY error as fatal and
                // stops reading forever, so a transient EINTR must be
                // retried here — otherwise one stray signal permanently
                // freezes the terminal mid-session.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.to_string()),
            }
        };
        if n == 0 {
            // n == 0 on a blocking read means the PTY master side saw
            // the slave close (child process exited). Signal EOF so the
            // frontend loop terminates instead of spinning on empty
            // buffers forever.
            return Err("EOF".to_string());
        }
        buf.truncate(n);
        Ok::<Vec<u8>, String>(buf)
    })
    .await
    .map_err(|e: tokio::task::JoinError| e.to_string())?
}

#[tauri::command]
async fn resize(
    pid: PtyHandler,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let (rows, cols) = clamp_pty_size(rows, cols);
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    session
        .pair
        .lock()
        .await
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn kill(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    // Remove the session from the map so any in-flight `read` call that
    // races with us either returns EOF on its next iteration or, if the
    // next iteration fires after this removal, hits the "EOF" path at
    // the top of `read`. Without the removal, the frontend's read loop
    // keeps polling an Arc<Session> whose child is dead, generating a
    // cascade of rejected invoke() calls during project switches.
    let session = state
        .sessions
        .write()
        .await
        .remove(&pid)
        .ok_or("EOF")?;
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn exitstatus(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    // Use spawn_blocking to avoid blocking a tokio worker thread.
    // The wait() call blocks until the child process exits.
    tokio::task::spawn_blocking(move || {
        let exitstatus = session
            .child
            .blocking_lock()
            .wait()
            .map_err(|e| e.to_string())?
            .exit_code();
        Ok::<u32, String>(exitstatus)
    })
    .await
    .map_err(|e: tokio::task::JoinError| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::clamp_pty_size;

    #[test]
    fn clamp_pty_size_floors_zero_and_one() {
        assert_eq!(clamp_pty_size(0, 0), (2, 2));
        assert_eq!(clamp_pty_size(1, 0), (2, 2));
        assert_eq!(clamp_pty_size(0, 120), (2, 120));
        assert_eq!(clamp_pty_size(24, 1), (24, 2));
        assert_eq!(clamp_pty_size(24, 80), (24, 80));
        assert_eq!(clamp_pty_size(u16::MAX, u16::MAX), (u16::MAX, u16::MAX));
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pty")
        .invoke_handler(tauri::generate_handler![
            spawn, write, read, resize, kill, exitstatus
        ])
        .setup(|app_handle, _api| {
            app_handle.manage(PluginState::default());
            Ok(())
        })
        .build()
}
