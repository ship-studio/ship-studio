//! # Native Mobile Preview (iOS Simulator)
//!
//! Mirrors a booted iOS Simulator into Ship Studio's preview pane by managing
//! a `serve-sim` daemon (Evan Bacon / Expo, Apache-2.0). serve-sim exposes an
//! MJPEG stream + a WebSocket control channel for the booted simulator; the
//! frontend embeds the stream and drives input over the WebSocket directly.
//!
//! See `docs/mobile-app-preview-plan.md` (§10c) for the evaluation that led to
//! this approach instead of a custom ScreenCaptureKit/Indigo-HID sidecar.
//!
//! Requirements: macOS + Xcode command line tools (`xcrun simctl`) + Node 18+
//! (`npx`). All three are already verified by onboarding.

use crate::errors::CommandError;
use crate::external_command::run_to_stdout;
use crate::utils::{create_command, find_executable, get_extended_path};
use serde::{Deserialize, Serialize};
use std::process::Command;

const SIMCTL_TIMEOUT_SECS: u64 = 15;
/// serve-sim in `--detach` mode spawns a helper and returns promptly, but the
/// first run may resolve the package via npx, so allow generous headroom.
const SERVE_SIM_TIMEOUT_SECS: u64 = 90;
/// Booting a cold simulator can take a while; `bootstatus -b` blocks until the
/// device is fully ready, so give it room.
const BOOT_WAIT_TIMEOUT_SECS: u64 = 150;

/// A booted iOS simulator that can be mirrored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MobileSimulator {
    pub udid: String,
    pub name: String,
    pub state: String,
    /// Human-ish runtime label (e.g. "iOS 26.1"), best-effort.
    pub runtime: Option<String>,
}

/// Result of ensuring a simulator is booted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BootResult {
    pub simulator: MobileSimulator,
    /// True only if WE booted it (vs. attaching to one the user already had
    /// running). Drives whether it's shut down when the project closes.
    pub booted_by_us: bool,
}

/// Connection details for an active serve-sim mirror.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MirrorInfo {
    pub udid: String,
    /// MJPEG stream, e.g. `http://127.0.0.1:3100/stream.mjpeg`.
    pub stream_url: String,
    /// WebSocket control channel, e.g. `ws://127.0.0.1:3100/ws`.
    pub ws_url: String,
    pub port: u16,
    /// Friendly device name (e.g. "iPhone 17") for the preview toolbar, so the
    /// frontend doesn't have to make a second `list_booted_simulators` call.
    /// Empty on the raw serve-sim parse; filled in once the session is built.
    pub device_name: String,
    /// Friendly runtime label (e.g. "iOS 26.1"), best-effort.
    pub device_runtime: Option<String>,
}

/// Build an `xcrun` command with the extended PATH (Finder-launched apps don't
/// inherit the shell PATH).
fn xcrun_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("xcrun") {
        create_command(path)
    } else {
        create_command("xcrun")
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

/// Build an `npx` command with the extended PATH.
fn npx_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("npx") {
        create_command(path)
    } else {
        create_command("npx")
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

/// Turn a CoreSimulator runtime identifier into a friendly label.
/// `com.apple.CoreSimulator.SimRuntime.iOS-26-1` -> `iOS 26.1`.
fn friendly_runtime(runtime_key: &str) -> Option<String> {
    let tail = runtime_key.rsplit('.').next()?; // "iOS-26-1"
    let (os, version) = tail.split_once('-')?; // ("iOS", "26-1")
    Some(format!("{} {}", os, version.replace('-', ".")))
}

/// Parse `xcrun simctl list devices booted --json` output into booted sims.
/// Pure for testability.
fn parse_booted_simulators(json: &str) -> Result<Vec<MobileSimulator>, CommandError> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Failed to parse simctl JSON: {e}"))?;
    let devices = root
        .get("devices")
        .and_then(|d| d.as_object())
        .ok_or("simctl JSON missing 'devices' object")?;

    let mut sims = Vec::new();
    for (runtime_key, list) in devices {
        let Some(arr) = list.as_array() else { continue };
        for dev in arr {
            // `booted` filter already narrows this, but double-check defensively.
            let state = dev.get("state").and_then(|s| s.as_str()).unwrap_or("");
            if state != "Booted" {
                continue;
            }
            let (Some(udid), Some(name)) = (
                dev.get("udid").and_then(|u| u.as_str()),
                dev.get("name").and_then(|n| n.as_str()),
            ) else {
                continue;
            };
            sims.push(MobileSimulator {
                udid: udid.to_string(),
                name: name.to_string(),
                state: state.to_string(),
                runtime: friendly_runtime(runtime_key),
            });
        }
    }
    Ok(sims)
}

/// Parse serve-sim's `--quiet`/`--detach` JSON line into a [`MirrorInfo`].
fn parse_mirror_info(json: &str) -> Result<MirrorInfo, CommandError> {
    // serve-sim may print other lines; take the last JSON object line.
    let line = json
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{') && l.ends_with('}'))
        .ok_or("serve-sim produced no JSON output")?;
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("Failed to parse serve-sim JSON: {e}"))?;

    let stream_url = v
        .get("streamUrl")
        .and_then(|s| s.as_str())
        .ok_or("serve-sim JSON missing streamUrl")?
        .to_string();
    let ws_url = v
        .get("wsUrl")
        .and_then(|s| s.as_str())
        .ok_or("serve-sim JSON missing wsUrl")?
        .to_string();
    let port = v.get("port").and_then(|p| p.as_u64()).unwrap_or(3100) as u16;
    let udid = v
        .get("device")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string();

    Ok(MirrorInfo {
        udid,
        stream_url,
        ws_url,
        port,
        // Filled in by `establish_mirror` once we know the device; serve-sim's
        // JSON only carries the udid.
        device_name: String::new(),
        device_runtime: None,
    })
}

/// Parse a CoreSimulator runtime identifier into a sortable (major, minor)
/// version. `…SimRuntime.iOS-26-1` -> `(26, 1)`; unknown -> `(0, 0)`.
fn runtime_version(runtime_key: &str) -> (i64, i64) {
    let tail = runtime_key.rsplit('.').next().unwrap_or("");
    let mut parts = tail.split('-');
    let _os = parts.next();
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor)
}

/// Choose a sensible simulator to auto-boot from `simctl list devices available
/// --json`. Preference order: already-booted > iPhone > newest iOS runtime.
/// Pure for testability. Returns `None` when no available device exists.
fn choose_default_simulator(json: &str) -> Option<MobileSimulator> {
    let root: serde_json::Value = serde_json::from_str(json).ok()?;
    let devices = root.get("devices")?.as_object()?;

    // Ranking key: (already-booted, is-iphone, (runtime major, minor)). Higher
    // tuple wins via lexicographic Ord.
    type RankKey = (bool, bool, (i64, i64));
    let mut best: Option<(RankKey, MobileSimulator)> = None;
    for (runtime_key, list) in devices {
        // serve-sim only mirrors iOS simulators; never auto-boot a watchOS/
        // tvOS/visionOS device just because it's the "newest" available.
        if !runtime_key.contains("iOS") {
            continue;
        }
        let Some(arr) = list.as_array() else { continue };
        for dev in arr {
            // `--available` already filters, but guard defensively.
            if dev.get("isAvailable").and_then(|a| a.as_bool()) == Some(false) {
                continue;
            }
            let (Some(udid), Some(name)) = (
                dev.get("udid").and_then(|u| u.as_str()),
                dev.get("name").and_then(|n| n.as_str()),
            ) else {
                continue;
            };
            let state = dev
                .get("state")
                .and_then(|s| s.as_str())
                .unwrap_or("Shutdown");
            let key = (
                state == "Booted",
                name.contains("iPhone"),
                runtime_version(runtime_key),
            );
            let sim = MobileSimulator {
                udid: udid.to_string(),
                name: name.to_string(),
                state: state.to_string(),
                runtime: friendly_runtime(runtime_key),
            };
            if best.as_ref().is_none_or(|(bk, _)| key > *bk) {
                best = Some((key, sim));
            }
        }
    }
    best.map(|(_, sim)| sim)
}

/// Run `xcrun simctl <args>` and return stdout, mapping non-zero exits to a
/// `CommandError::Process`.
async fn simctl_stdout(
    args: &[&str],
    label: &str,
    timeout_secs: u64,
) -> Result<String, CommandError> {
    let mut cmd = xcrun_command();
    cmd.arg("simctl");
    cmd.args(args);
    run_to_stdout(
        tokio::process::Command::from(cmd),
        label.to_string(),
        timeout_secs,
    )
    .await
}

/// List currently-booted iOS simulators.
///
/// Errors if `xcrun` is unavailable (Xcode not installed). Returns an empty
/// vec when Xcode is present but no simulator is booted.
#[tauri::command]
#[tracing::instrument]
pub async fn list_booted_simulators() -> Result<Vec<MobileSimulator>, CommandError> {
    tracing::info!("list_booted_simulators: invoked");
    let stdout = simctl_stdout(
        &["list", "devices", "booted", "--json"],
        "xcrun simctl list booted",
        SIMCTL_TIMEOUT_SECS,
    )
    .await?;
    let sims = parse_booted_simulators(&stdout)?;
    tracing::info!("list_booted_simulators: {} booted", sims.len());
    Ok(sims)
}

/// Determine the command that launches the project's app onto a booted
/// simulator, based on the project type. Reads project files (not pure) and is
/// unit-tested via `build_launch_command`; the frontend runs the returned
/// command in the embedded `BuildTerminal` (a backend `pty_session`).
fn build_launch_command(project_path: &std::path::Path, udid: &str) -> Option<String> {
    use crate::commands::projects::{detect_project_type, is_expo_project};
    match detect_project_type(project_path) {
        crate::types::ProjectType::Flutter => Some(format!("flutter run -d {udid}")),
        crate::types::ProjectType::Reactnative => {
            // Expo apps build/launch via `expo run:ios`; bare RN via the RN CLI.
            // Both target the specific booted device by udid. `--yes` stops npx
            // from prompting "Ok to proceed?" (which would hang the read-only
            // build log) when a package isn't present locally.
            if is_expo_project(project_path) {
                Some(format!("npx --yes expo run:ios --device {udid}"))
            } else {
                Some(format!("npx --yes react-native run-ios --udid {udid}"))
            }
        }
        _ => None,
    }
}

/// Get the launch command for a project's app on a given simulator, or an error
/// if the project type isn't a supported native mobile app.
#[tauri::command]
#[tracing::instrument]
pub async fn get_simulator_launch_command(
    project_path: String,
    udid: String,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let workspace = crate::utils::resolve_workspace_path(&project);
    build_launch_command(&workspace, &udid)
        .ok_or_else(|| "This project type can't be launched on a simulator yet.".into())
}

/// Kill the serve-sim daemon for one device (best-effort; ignores non-zero exit).
async fn kill_serve_sim(udid: &str) {
    let mut cmd = npx_command();
    cmd.args(["-y", "serve-sim", "--kill", udid]);
    let _ = run_to_stdout(
        tokio::process::Command::from(cmd),
        "serve-sim --kill",
        SIMCTL_TIMEOUT_SECS,
    )
    .await;
}

/// Cheap liveness probe: is something still listening on the mirror's port? A
/// serve-sim daemon that crashed (or was killed out from under us) leaves a
/// registered session pointing at a dead port; this lets `start_mobile_preview`
/// detect that and rebuild instead of handing back a dead mirror. A plain TCP
/// connect is enough — far cheaper than an `npx serve-sim --list` cold start —
/// and the reserved-port system makes a foreign listener on our port unlikely.
async fn serve_sim_alive(port: u16) -> bool {
    use tokio::time::{timeout, Duration};
    matches!(
        timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Synchronously kill whatever process is listening on a TCP port (macOS `lsof`).
/// Used by the window-close handler instead of `npx serve-sim --kill`, which pays
/// a node/npx cold start (hundreds of ms) that would jank window close. Mirrors
/// the `kill_port` command's `lsof -nPti` approach.
///
/// `lsof` runs on a worker thread bounded by a timeout: it can wedge on a stuck
/// socket/filesystem, and this is the window-close path — a hang here freezes the
/// app's exit. If `lsof` doesn't answer in time we abandon it (the OS reaps the
/// thread) rather than block. Same reason `kill_port` wraps `lsof` in a timeout.
fn kill_process_on_port_sync(port: u16) {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = create_command("lsof")
            .args(["-nPti", &format!("tcp:{port}")])
            .env("PATH", get_extended_path())
            .output();
        let _ = tx.send(out);
    });

    let Ok(Ok(out)) = rx.recv_timeout(Duration::from_secs(2)) else {
        // lsof hung or failed — don't block window close on it.
        return;
    };
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        // lsof -ti emits bare PIDs; validate before handing to `kill`.
        if pid.parse::<i32>().is_ok() {
            let _ = create_command("kill")
                .args(["-9", pid])
                .env("PATH", get_extended_path())
                .output();
        }
    }
}

/// Tear down a project's mobile preview — the single authority. Kills the app
/// build's `pty_session` (which the `PTY_REGISTRY`/`kill_window_pty_sync` sweeps
/// do NOT reach, since it lives in a separate registry), stops the serve-sim
/// mirror, shuts the simulator down **only if we booted it**, releases the
/// reserved port if we reserved one, and prunes the boot lock. Best-effort and
/// idempotent: no registered session → nothing to do.
pub async fn teardown_mobile_preview(project_path: String) {
    let Some(session) = crate::state::take_mobile_session(&project_path) else {
        crate::state::drop_boot_lock(&project_path);
        return;
    };
    if let Some(build_id) = session.build_session_id {
        let _ = crate::commands::pty_session::pty_session_kill(build_id);
    }
    kill_serve_sim(&session.udid).await;
    if session.booted_by_us {
        tracing::info!(udid = %session.udid, "tearing down mobile preview: shutting down sim we booted");
        let _ = simctl_stdout(
            &["shutdown", &session.udid],
            "xcrun simctl shutdown",
            SIMCTL_TIMEOUT_SECS,
        )
        .await;
    }
    if session.port_was_reserved {
        crate::state::release_port_for_project(&session.window_label, &project_path);
    }
    crate::state::drop_boot_lock(&project_path);
}

/// Synchronous teardown of every mobile preview owned by a window, for the
/// window-Destroyed handler (which can't await). Runs for *every* closing window
/// (not gated on main), so a non-main project window's sim doesn't leak. Uses
/// blocking `.output()` — like the other sync close handlers — so the simulator
/// actually shuts down before the process can exit (vs. a detached `.spawn()`
/// that races teardown against exit). Reserved ports are released wholesale by
/// the window-Destroyed handler's `release_port_for_window`.
pub fn teardown_mobile_previews_for_window_sync(window_label: &str) {
    for (project_path, session) in crate::state::take_mobile_sessions_for_window(window_label) {
        if let Some(build_id) = session.build_session_id {
            let _ = crate::commands::pty_session::pty_session_kill(build_id);
        }
        // Kill the mirror by its port, not via `npx serve-sim --kill` — the npx
        // cold start would block window close for hundreds of ms.
        kill_process_on_port_sync(session.serve_sim_port);
        if session.booted_by_us {
            let _ = std::process::Command::new("xcrun")
                .args(["simctl", "shutdown", &session.udid])
                .env("PATH", get_extended_path())
                .output();
        }
        crate::state::drop_boot_lock(&project_path);
    }
}

// serve-sim's stream server defaults to 3100; we reserve from there so the
// mirror never collides with a dev server (3000-range) or another window.
const SERVE_SIM_BASE_PORT: u16 = 3100;

/// Stable `pty_session` id for a project's app build. Deterministic so the
/// frontend `BuildTerminal` and backend teardown agree on the id without having
/// to round-trip it, and so re-open across tab switches is idempotent. The
/// frontend mirrors this format in `src/lib/mobile.ts` (`buildSessionId`).
pub fn build_session_id_for(project_path: &str) -> String {
    format!("mobile-build:{project_path}")
}

/// Ensure a simulator is available with **correct preference**, without touching
/// any registry (the caller records the session). Unlike the legacy
/// `boot_default_simulator`, when `preferred` is set but not currently booted
/// this boots *that* device rather than silently attaching to another.
async fn ensure_simulator(preferred: Option<String>) -> Result<BootResult, CommandError> {
    let booted = list_booted_simulators().await?;

    if let Some(pref) = preferred.as_deref().filter(|p| !p.is_empty()) {
        // Reuse the requested device if it's already booted; else boot exactly it.
        if let Some(sim) = booted.iter().find(|s| s.udid == pref).cloned() {
            return Ok(BootResult {
                simulator: sim,
                booted_by_us: false,
            });
        }
        return boot_specific_simulator(pref).await;
    }

    // No preference: attach to any booted sim (respect the user's machine), else
    // boot the newest available iPhone.
    if let Some(sim) = booted.into_iter().next() {
        return Ok(BootResult {
            simulator: sim,
            booted_by_us: false,
        });
    }
    let available = simctl_stdout(
        &["list", "devices", "available", "--json"],
        "xcrun simctl list available",
        SIMCTL_TIMEOUT_SECS,
    )
    .await?;
    let target = choose_default_simulator(&available)
        .ok_or("No available iOS simulator to boot. Add one in Xcode › Settings › Components.")?;
    boot_specific_simulator(&target.udid).await
}

/// Boot a specific simulator by udid and wait until it's fully ready. Returns it
/// with `booted_by_us = true`. Treats "already booted" as success.
async fn boot_specific_simulator(udid: &str) -> Result<BootResult, CommandError> {
    let mut boot_cmd = xcrun_command();
    boot_cmd.args(["simctl", "boot", udid]);
    let out = crate::external_command::run_with_timeout(
        tokio::process::Command::from(boot_cmd),
        "xcrun simctl boot",
        SIMCTL_TIMEOUT_SECS,
    )
    .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.contains("current state: Booted") {
            return Err(CommandError::Process {
                cmd: "xcrun simctl boot".to_string(),
                exit_code: out.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }
    // Block until fully booted (deterministic, no sleeps).
    let _ = simctl_stdout(
        &["bootstatus", udid, "-b"],
        "xcrun simctl bootstatus",
        BOOT_WAIT_TIMEOUT_SECS,
    )
    .await?;
    let sim = list_booted_simulators()
        .await?
        .into_iter()
        .find(|s| s.udid == udid)
        .ok_or("Simulator was booted but isn't reporting as booted yet.")?;
    Ok(BootResult {
        simulator: sim,
        booted_by_us: true,
    })
}

/// Spawn a `serve-sim` mirror for a booted sim on the given starting port and
/// parse back the connection details (serve-sim may pick a higher port).
async fn spawn_serve_sim(udid: &str, start_port: u16) -> Result<MirrorInfo, CommandError> {
    let mut cmd = npx_command();
    cmd.args([
        "-y",
        "serve-sim",
        "--detach",
        "--quiet",
        "--port",
        &start_port.to_string(),
        udid,
    ]);
    let stdout = run_to_stdout(
        tokio::process::Command::from(cmd),
        "serve-sim --detach",
        SERVE_SIM_TIMEOUT_SECS,
    )
    .await?;
    parse_mirror_info(&stdout)
}

/// Connection info reconstructed from a live registered session, for the
/// idempotent-reuse path (no serve-sim round-trip needed).
fn reuse_mirror_info(s: &crate::state::MobileSession) -> MirrorInfo {
    MirrorInfo {
        udid: s.udid.clone(),
        stream_url: format!("http://127.0.0.1:{}/stream.mjpeg", s.serve_sim_port),
        ws_url: format!("ws://127.0.0.1:{}/ws", s.serve_sim_port),
        port: s.serve_sim_port,
        device_name: s.device_name.clone(),
        device_runtime: s.device_runtime.clone(),
    }
}

/// Reserve a port, spawn a `serve-sim` mirror against an already-booted sim,
/// reconcile the port serve-sim actually bound, and register the session. Shared
/// by the fresh-start and dead-mirror-heal paths so the reserve/spawn/reconcile
/// logic lives in one place. **Does not** boot or shut down the simulator — the
/// caller owns that (so a heal can respawn the mirror without re-booting). On
/// spawn failure it releases the port and returns the error, leaving the sim
/// untouched.
async fn establish_mirror(
    project_path: &str,
    window_label: &str,
    udid: &str,
    booted_by_us: bool,
    device_name: String,
    device_runtime: Option<String>,
) -> Result<MirrorInfo, CommandError> {
    let reserved = crate::commands::pty::find_and_reserve_port(
        window_label.to_string(),
        project_path.to_string(),
        SERVE_SIM_BASE_PORT,
    )?;

    let mut info = match spawn_serve_sim(udid, reserved).await {
        Ok(info) => info,
        Err(e) => {
            crate::state::release_port_for_project(window_label, project_path);
            return Err(e);
        }
    };

    // serve-sim may have stepped past our reserved port — re-key the reservation
    // to the port it actually bound so dev servers avoid it.
    let mut port_was_reserved = true;
    if info.port != reserved && !crate::state::reserve_port(window_label, project_path, info.port) {
        crate::state::release_port_for_project(window_label, project_path);
        port_was_reserved = false;
    }

    info.device_name = device_name.clone();
    info.device_runtime = device_runtime.clone();

    // The build session id is the deterministic one the frontend uses, so
    // teardown can kill the build pty_session even though it's spawned separately
    // (killing an id that never spawned is a no-op).
    crate::state::register_mobile_session(
        project_path.to_string(),
        crate::state::MobileSession {
            udid: udid.to_string(),
            booted_by_us,
            serve_sim_port: info.port,
            port_was_reserved,
            build_session_id: Some(build_session_id_for(project_path)),
            window_label: window_label.to_string(),
            device_name,
            device_runtime,
        },
    );

    Ok(info)
}

/// Start (or reuse) a complete native mobile preview for a project: ensure a
/// simulator is booted, reserve a port, start a `serve-sim` mirror, and register
/// the session so the backend — not the React component — owns its lifecycle.
///
/// Idempotent and serialized per project: concurrent calls for the same project
/// share one boot. A reused session is **liveness-checked** — if its serve-sim
/// mirror has died, we heal it (respawn the mirror against the same sim, keeping
/// the build running) rather than hand back a dead port; if the sim itself is
/// gone we tear down and start fresh. This is what makes the "Restart" button
/// actually recover a broken preview. `preferred` pins a specific device
/// (frontend passes `null` in v1). The returned [`MirrorInfo`] is what the
/// frontend embeds; the app build is launched separately as a `pty_session`.
#[tauri::command]
#[tracing::instrument]
pub async fn start_mobile_preview(
    project_path: String,
    window_label: String,
    preferred: Option<String>,
) -> Result<MirrorInfo, CommandError> {
    // Serialize per project so two concurrent starts can't both boot a sim.
    let lock = crate::state::boot_lock_for(&project_path);
    let _guard = lock.lock().await;

    // A session already exists. Reuse it if the mirror is still alive; otherwise
    // heal or rebuild rather than returning a dead port.
    if let Some(existing) = crate::state::get_mobile_session(&project_path) {
        if serve_sim_alive(existing.serve_sim_port).await {
            tracing::info!(udid = %existing.udid, "start_mobile_preview: reusing live session");
            return Ok(reuse_mirror_info(&existing));
        }

        tracing::warn!(
            udid = %existing.udid,
            port = existing.serve_sim_port,
            "start_mobile_preview: mirror is dead — attempting heal"
        );
        // Clear the dead mirror's port and any serve-sim zombie before respawning.
        kill_serve_sim(&existing.udid).await;
        if existing.port_was_reserved {
            crate::state::release_port_for_project(&existing.window_label, &project_path);
        }

        // Narrow heal: if the sim is still booted, just respawn the mirror —
        // don't re-boot, and leave the build pty_session running. This preserves
        // boot ownership and the in-flight build.
        let sim_still_booted = list_booted_simulators()
            .await
            .map(|sims| sims.iter().any(|s| s.udid == existing.udid))
            .unwrap_or(false);
        if sim_still_booted {
            if let Ok(info) = establish_mirror(
                &project_path,
                &window_label,
                &existing.udid,
                existing.booted_by_us,
                existing.device_name.clone(),
                existing.device_runtime.clone(),
            )
            .await
            {
                tracing::info!(udid = %existing.udid, "start_mobile_preview: healed dead mirror");
                return Ok(info);
            }
        }

        // Sim is gone (or the respawn failed) — fully tear down the stale session
        // and fall through to a fresh boot. The build can't survive a dead sim.
        crate::state::take_mobile_session(&project_path);
        if let Some(build_id) = &existing.build_session_id {
            let _ = crate::commands::pty_session::pty_session_kill(build_id.clone());
        }
        if existing.booted_by_us {
            let _ = simctl_stdout(
                &["shutdown", &existing.udid],
                "xcrun simctl shutdown",
                SIMCTL_TIMEOUT_SECS,
            )
            .await;
        }
    }

    // Fresh start: ensure a simulator (correct preference), then establish the
    // mirror. On mirror failure, don't strand a sim we just booted.
    let boot = ensure_simulator(preferred).await?;
    match establish_mirror(
        &project_path,
        &window_label,
        &boot.simulator.udid,
        boot.booted_by_us,
        boot.simulator.name.clone(),
        boot.simulator.runtime.clone(),
    )
    .await
    {
        Ok(info) => Ok(info),
        Err(e) => {
            if boot.booted_by_us {
                let _ = simctl_stdout(
                    &["shutdown", &boot.simulator.udid],
                    "xcrun simctl shutdown",
                    SIMCTL_TIMEOUT_SECS,
                )
                .await;
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_runtime_formats_ios_version() {
        assert_eq!(
            friendly_runtime("com.apple.CoreSimulator.SimRuntime.iOS-26-1").as_deref(),
            Some("iOS 26.1")
        );
        assert_eq!(
            friendly_runtime("com.apple.CoreSimulator.SimRuntime.iOS-17-5").as_deref(),
            Some("iOS 17.5")
        );
    }

    #[test]
    fn parse_booted_simulators_extracts_booted_devices() {
        let json = r#"{
          "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
              {"udid":"ABC","name":"iPhone 17","state":"Booted","isAvailable":true},
              {"udid":"DEF","name":"iPhone 16e","state":"Shutdown","isAvailable":true}
            ]
          }
        }"#;
        let sims = parse_booted_simulators(json).unwrap();
        assert_eq!(sims.len(), 1);
        assert_eq!(sims[0].udid, "ABC");
        assert_eq!(sims[0].name, "iPhone 17");
        assert_eq!(sims[0].runtime.as_deref(), Some("iOS 26.1"));
    }

    #[test]
    fn parse_booted_simulators_handles_empty() {
        let json = r#"{"devices":{}}"#;
        assert!(parse_booted_simulators(json).unwrap().is_empty());
    }

    #[test]
    fn parse_booted_simulators_rejects_garbage() {
        assert!(parse_booted_simulators("not json").is_err());
    }

    #[test]
    fn parse_mirror_info_reads_serve_sim_json() {
        let out = r#"{"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/stream.mjpeg","wsUrl":"ws://127.0.0.1:3100/ws","port":3100,"device":"ABC"}"#;
        let info = parse_mirror_info(out).unwrap();
        assert_eq!(info.stream_url, "http://127.0.0.1:3100/stream.mjpeg");
        assert_eq!(info.ws_url, "ws://127.0.0.1:3100/ws");
        assert_eq!(info.port, 3100);
        assert_eq!(info.udid, "ABC");
    }

    #[test]
    fn parse_mirror_info_picks_json_line_among_noise() {
        let out = "Some banner text\nstarting...\n{\"streamUrl\":\"http://127.0.0.1:3100/stream.mjpeg\",\"wsUrl\":\"ws://127.0.0.1:3100/ws\",\"port\":3100,\"device\":\"X\"}\n";
        let info = parse_mirror_info(out).unwrap();
        assert_eq!(info.port, 3100);
        assert_eq!(info.udid, "X");
    }

    #[test]
    fn parse_mirror_info_errors_without_json() {
        assert!(parse_mirror_info("no json here").is_err());
    }

    #[test]
    fn runtime_version_parses_and_defaults() {
        assert_eq!(
            runtime_version("com.apple.CoreSimulator.SimRuntime.iOS-26-1"),
            (26, 1)
        );
        assert_eq!(
            runtime_version("com.apple.CoreSimulator.SimRuntime.iOS-17-0"),
            (17, 0)
        );
        assert_eq!(runtime_version("garbage"), (0, 0));
    }

    #[test]
    fn choose_default_prefers_newest_iphone() {
        let json = r#"{
          "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
              {"udid":"OLD","name":"iPhone 15","state":"Shutdown","isAvailable":true}
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
              {"udid":"NEW","name":"iPhone 17","state":"Shutdown","isAvailable":true},
              {"udid":"WATCH","name":"Apple Watch","state":"Shutdown","isAvailable":true}
            ]
          }
        }"#;
        let chosen = choose_default_simulator(json).unwrap();
        assert_eq!(chosen.udid, "NEW"); // newest iOS + iPhone
    }

    #[test]
    fn choose_default_prefers_already_booted() {
        let json = r#"{
          "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
              {"udid":"NEW","name":"iPhone 17","state":"Shutdown","isAvailable":true}
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
              {"udid":"RUNNING","name":"iPhone 15","state":"Booted","isAvailable":true}
            ]
          }
        }"#;
        // Booted beats newer-but-shutdown.
        assert_eq!(choose_default_simulator(json).unwrap().udid, "RUNNING");
    }

    #[test]
    fn build_launch_command_for_expo_flutter_and_unsupported() {
        use std::fs;
        use tempfile::TempDir;

        // Expo
        let expo = TempDir::new().unwrap();
        fs::write(
            expo.path().join("package.json"),
            r#"{"dependencies":{"expo":"51"}}"#,
        )
        .unwrap();
        assert_eq!(
            build_launch_command(expo.path(), "UDID").as_deref(),
            Some("npx --yes expo run:ios --device UDID")
        );

        // Bare React Native (metro, no expo)
        let rn = TempDir::new().unwrap();
        fs::write(rn.path().join("metro.config.js"), "module.exports={}").unwrap();
        fs::write(
            rn.path().join("package.json"),
            r#"{"dependencies":{"react-native":"0.75"}}"#,
        )
        .unwrap();
        assert_eq!(
            build_launch_command(rn.path(), "UDID").as_deref(),
            Some("npx --yes react-native run-ios --udid UDID")
        );

        // Flutter
        let flutter = TempDir::new().unwrap();
        fs::write(
            flutter.path().join("pubspec.yaml"),
            "dependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .unwrap();
        assert_eq!(
            build_launch_command(flutter.path(), "X").as_deref(),
            Some("flutter run -d X")
        );

        // Unsupported (plain web)
        let web = TempDir::new().unwrap();
        fs::write(web.path().join("next.config.js"), "module.exports={}").unwrap();
        assert_eq!(build_launch_command(web.path(), "X"), None);
    }

    #[test]
    fn choose_default_skips_unavailable_and_handles_empty() {
        let json = r#"{
          "devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
              {"udid":"X","name":"iPhone 17","state":"Shutdown","isAvailable":false}
            ]
          }
        }"#;
        assert!(choose_default_simulator(json).is_none());
        assert!(choose_default_simulator(r#"{"devices":{}}"#).is_none());
    }
}
