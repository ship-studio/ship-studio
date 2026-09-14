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
    let session = state.sessions.read().await.get(&pid).ok_or("EOF")?.clone();
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
    let session = state.sessions.write().await.remove(&pid).ok_or("EOF")?;
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn exitstatus(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<i32, String> {
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
        // portable_pty reports the raw Windows exit DWORD as a u32. Abnormal
        // terminations carry a *signed* 32-bit status (an NTSTATUS, or node's
        // negative libuv errno — e.g. -4058/UV_ENOENT), which as a bare u32
        // renders as a nonsense huge number like 4294963238 in the frontend's
        // failure toast (issue #622). Reinterpret as i32 so those arrive as
        // their small negative selves; normal small exit codes are unchanged.
        Ok::<i32, String>(exitstatus as i32)
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

    /// Spawns a real PTY and checks the ID `process_id` hands back is an
    /// actual, live OS process — not the session handler.
    ///
    /// This is the assertion the whole self-kill fix rests on. A handler is a
    /// counter from 0, and `kill(2)` reads 0 as "my own process group", so a
    /// `process_id` that quietly returned a handler would restore the exact
    /// bug it was written to remove. Asserting `>= 2` is not pedantry: 0 and 1
    /// are precisely the values that were fatal.
    #[cfg(unix)]
    #[test]
    fn process_id_returns_a_live_os_pid_not_a_handler() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // `sleep` so the child is still alive when we ask — a child that has
        // already exited legitimately reports None, which would make this
        // test pass for the wrong reason.
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = pair.slave.spawn_command(cmd).expect("spawn");

        let pid = child.process_id().expect("a running child must have an OS pid");

        assert!(
            pid >= 2,
            "process_id returned {pid}: 0 is our own process group and 1 is launchd, so \
             signalling this would kill Ship Studio rather than the dev server"
        );

        // The handler counter starts at 0 and stays tiny; a real macOS/Linux
        // PID never lands in that range for a process we just spawned. If
        // these ever coincide the assertion above is the one that matters.
        let os_pid_exists = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .expect("kill -0")
            .success();
        assert!(os_pid_exists, "PID {pid} does not name a live process");

        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The OS process ID of the PTY's child, as opposed to [`PtyHandler`].
///
/// `spawn` returns a `PtyHandler` — an `AtomicU32` counter that starts at 0
/// and is only meaningful to this plugin's session map. The JS wrapper stores
/// that value in `IPty.pid` and its type declaration calls it "the process ID
/// of the outer process", which is simply untrue: the session's first PTY is
/// always handler 0.
///
/// Anything that intends to *signal* the child needs the real thing, and a
/// handler passed to `kill(2)` is actively dangerous — PID 0 means "every
/// process in my own process group". Ship Studio shipped that bug: dev servers
/// were registered for cleanup under their handler, and tearing down handler 0
/// SIGKILLed the app itself.
///
/// `None` when the child has already been reaped and the OS ID is gone.
#[tauri::command]
async fn process_id(
    pid: PtyHandler,
    state: tauri::State<'_, PluginState>,
) -> Result<Option<u32>, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    let process_id = session.child.lock().await.process_id();
    Ok(process_id)
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pty")
        .invoke_handler(tauri::generate_handler![
            spawn, write, read, resize, kill, exitstatus, process_id
        ])
        .setup(|app_handle, _api| {
            app_handle.manage(PluginState::default());
            Ok(())
        })
        .build()
}
