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
/// A cold Android emulator boot (`-no-snapshot-save`, first run after creation)
/// routinely exceeds the iOS budget — give it more headroom before declaring
/// the boot failed.
const ANDROID_BOOT_WAIT_TIMEOUT_SECS: u64 = 240;
/// A one-shot AppleScript (e.g. hiding Simulator.app) should be near-instant;
/// cap it low so a wedged osascript can't stall the caller.
const OSASCRIPT_TIMEOUT_SECS: u64 = 5;
/// `adb` queries are local and fast; cap them so a wedged adb server can't stall.
const ADB_TIMEOUT_SECS: u64 = 20;

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
    /// The session's last reported build verdict ("building" / "launched" /
    /// "failed" / "exited"), present only on the reuse path. Lets a tab-return
    /// restore the verdict instantly instead of re-deriving it from a replayed
    /// (and possibly truncated) build log.
    pub launch_status: Option<String>,
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
        launch_status: None,
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

/// Whether a user-facing app is currently running on the booted simulator.
///
/// This is the ground-truth "did the app launch" signal, and crucially it is
/// independent of *which* process built it. Ship Studio's embedded BuildTerminal
/// only sees its own build; when the user hands a failed build to the agent, the
/// agent rebuilds in its OWN terminal, invisible to the build-log classifier. The
/// preview panel polls this so it can resolve from "failed" to "launched" after an
/// out-of-band rebuild instead of staying stuck on a stale failure.
///
/// A launched UIKit app appears in the simulator's launchd as
/// `UIKitApplication:<bundle-id>`; SpringBoard and system daemons do not.
///
/// When `bundle_id` is known (the frontend parses it from the build log) we match
/// it exactly — unambiguous even on a simulator the user pre-booted with other
/// apps. When it isn't, we fall back to "any non-Apple UIKit app", which is
/// reliable on a sim WE booted (the project's app is the only third-party app) but
/// can false-positive on a pre-booted sim that already has another third-party app
/// running. Either way Apple's own UIKit apps (Safari = `com.apple.mobilesafari`,
/// etc.) are excluded.
#[tauri::command]
#[tracing::instrument]
pub async fn simulator_app_running(
    udid: String,
    bundle_id: Option<String>,
) -> Result<bool, CommandError> {
    let stdout = simctl_stdout(
        &["spawn", udid.as_str(), "launchctl", "list"],
        "xcrun simctl spawn launchctl list",
        SIMCTL_TIMEOUT_SECS,
    )
    .await?;
    let running = match bundle_id.as_deref() {
        Some(id) => stdout.contains(&format!("UIKitApplication:{id}")),
        None => stdout
            .lines()
            .any(|l| l.contains("UIKitApplication:") && !l.contains("UIKitApplication:com.apple.")),
    };
    Ok(running)
}

/// Hide the iOS Simulator's GUI window.
///
/// We boot the simulator headlessly (`simctl boot`) and mirror it via serve-sim's
/// framebuffer capture, so Simulator.app's window is never needed — but the build
/// tool (`expo run:ios` / `react-native run-ios`) opens and foregrounds it, where it
/// lands on top of Ship Studio. Hiding the app (AppleScript, like Cmd+H) keeps the
/// simulator booted and the mirror live while getting the window out of the way.
///
/// Best-effort: if Simulator isn't running, or the user hasn't granted automation
/// permission, this is a no-op — the window simply stays, exactly as before.
#[tauri::command]
#[tracing::instrument]
pub async fn hide_simulator() -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = create_command("osascript");
        cmd.args([
            "-e",
            "tell application \"System Events\" to set visible of process \"Simulator\" to false",
        ]);
        // Ignore the result entirely — a missing process or denied automation
        // permission must not surface as a preview error.
        let _ = crate::external_command::run_with_timeout(
            tokio::process::Command::from(cmd),
            "osascript hide Simulator",
            OSASCRIPT_TIMEOUT_SECS,
        )
        .await;
    }
    Ok(())
}

/// Reap orphaned serve-sim mirror daemons left by a previous hard crash.
///
/// serve-sim runs with `--detach`, reparenting to launchd (ppid 1). On a clean exit
/// we kill it via the session registry, but a hard crash (SIGKILL / force-quit)
/// leaves the daemon running — pinning its port (base 3100) and forcing every later
/// start onto an ever-higher orphan port, one new orphan per crash. The in-memory
/// registry is empty after a restart, so the only way to find these is by process.
/// A freshly-started app owns no mirror, so any orphaned (ppid == 1) serve-sim is
/// safe to reap. Best-effort, synchronous, called once at startup.
#[cfg(target_os = "macos")]
pub fn reap_orphaned_serve_sim() {
    // Match `serve-sim … --detach` specifically — the exact shape WE spawn
    // (spawn_serve_sim always passes `--detach`) — so we don't kill a bare
    // `serve-sim` a user launched by hand. ppid == 1 means reparented to launchd,
    // i.e. a detached daemon whose owner died; it also spares this very `sh` (its
    // parent is us, not launchd) and any serve-sim a live process still manages.
    let script = r#"
        for pid in $(pgrep -f 'serve-sim.*--detach' 2>/dev/null); do
            ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
            if [ "$ppid" = "1" ]; then
                kill "$pid" 2>/dev/null
            fi
        done
    "#;
    let _ = create_command("sh").args(["-c", script]).output();
}

// ============ Android (emulator + adb) ============

/// Locate the Android SDK root: `$ANDROID_HOME`, then `$ANDROID_SDK_ROOT`, then the
/// macOS default (`~/Library/Android/sdk`). `None` means Android tooling isn't
/// installed — callers surface that as a clear "set up Android" error.
fn android_sdk_root() -> Option<std::path::PathBuf> {
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(p) = std::env::var(var) {
            let path = std::path::PathBuf::from(p);
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    let default = dirs::home_dir()?.join("Library/Android/sdk");
    default.is_dir().then_some(default)
}

/// Build a command for an Android SDK tool (`adb`, `emulator`), resolving it from
/// the SDK root when present, else from PATH. Extends PATH like the xcrun/npx
/// helpers so a Finder-launched app still finds brew- and SDK-managed tools.
fn android_tool_command(tool: &str, sdk_subdir: &str) -> Command {
    let mut cmd = match android_sdk_root().map(|r| r.join(sdk_subdir).join(tool)) {
        Some(bin) if bin.is_file() => create_command(bin.to_string_lossy().as_ref()),
        _ => match find_executable(tool) {
            Some(path) => create_command(path),
            None => create_command(tool),
        },
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

fn adb_command() -> Command {
    android_tool_command("adb", "platform-tools")
}

fn emulator_command() -> Command {
    android_tool_command("emulator", "emulator")
}

/// A connected Android device or running emulator that can be mirrored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AndroidDevice {
    /// adb serial, e.g. `emulator-5554` — the `-s` target and scrcpy device id.
    pub serial: String,
    /// Friendly name (the AVD name once booted; the serial until then).
    pub name: String,
    /// True for emulators (serial begins `emulator-`), false for physical devices.
    pub is_emulator: bool,
}

/// Parse `adb devices` output into the list of *ready* devices. Skips the header
/// line and any entry that isn't in the `device` state (offline / unauthorized /
/// no-permissions), so callers only ever see something they can actually drive.
fn parse_adb_devices(stdout: &str) -> Vec<AndroidDevice> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            // The header is "List of devices attached" → second token "of" ≠ "device".
            if parts.next()? != "device" {
                return None;
            }
            Some(AndroidDevice {
                serial: serial.to_string(),
                name: serial.to_string(),
                is_emulator: serial.starts_with("emulator-"),
            })
        })
        .collect()
}

/// List currently-connected, ready Android devices/emulators. Empty vec when none
/// are running (or adb is absent); errors only on an unexpected adb failure.
#[tauri::command]
#[tracing::instrument]
pub async fn list_android_devices() -> Result<Vec<AndroidDevice>, CommandError> {
    let mut cmd = adb_command();
    cmd.arg("devices");
    let stdout = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb devices",
        ADB_TIMEOUT_SECS,
    )
    .await
    .unwrap_or_default();
    Ok(parse_adb_devices(&stdout))
}

/// List installed AVDs via `emulator -list-avds`. Empty when none exist or the
/// emulator binary is missing.
async fn list_avds() -> Vec<String> {
    let mut cmd = emulator_command();
    cmd.arg("-list-avds");
    run_to_stdout(
        tokio::process::Command::from(cmd),
        "emulator -list-avds",
        ADB_TIMEOUT_SECS,
    )
    .await
    .map(|out| {
        out.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()
    })
    .unwrap_or_default()
}

/// Ensure an Android emulator is booted and ready; returns its device and whether
/// **we** booted it (so teardown only kills emulators we started). Reuses a running
/// device if one exists; otherwise boots `preferred` (or the first AVD) detached and
/// blocks until `sys.boot_completed` — the Android analog of `simctl bootstatus`.
async fn ensure_emulator(preferred: Option<String>) -> Result<(AndroidDevice, bool), CommandError> {
    // Distinguish "no SDK at all" from "SDK present but no AVD" — they need different
    // fixes, and the old message misdiagnosed a missing SDK as a missing AVD.
    if android_sdk_root().is_none() {
        return Err(
            "The Android SDK isn't installed, so there's no emulator to preview on.".into(),
        );
    }

    // Reuse a device that's already up (booted_by_us = false), preferring the
    // requested serial when it's among them. We never boot a SECOND emulator
    // while one is running — `expo run:android` / `react-native run-android`
    // target "the" device and would be ambiguous with two attached.
    let running = list_android_devices().await?;
    let already_up = preferred
        .as_deref()
        .and_then(|p| running.iter().find(|d| d.serial == p).cloned())
        .or_else(|| running.into_iter().next());
    if let Some(dev) = already_up {
        return Ok((dev, false));
    }

    let avds = list_avds().await;
    let avd = preferred
        .filter(|p| avds.contains(p))
        .or_else(|| avds.into_iter().next())
        .ok_or("No Android Virtual Device found. Create an emulator (AVD) to preview on.")?;

    // Boot detached — the emulator runs for the session; teardown uses `adb emu kill`.
    let mut emu = emulator_command();
    emu.args(["-avd", &avd, "-no-snapshot-save", "-no-boot-anim"]);
    emu.stdout(std::process::Stdio::null());
    emu.stderr(std::process::Stdio::null());
    emu.spawn()
        .map_err(|e| format!("Failed to launch the Android emulator: {e}"))?;

    // Poll until a freshly-booted emulator reports the OS as fully up.
    let mut waited = 0u64;
    loop {
        if let Some(dev) = list_android_devices()
            .await?
            .into_iter()
            .find(|d| d.is_emulator)
        {
            if emulator_boot_completed(&dev.serial).await {
                return Ok((AndroidDevice { name: avd, ..dev }, true));
            }
        }
        if waited >= ANDROID_BOOT_WAIT_TIMEOUT_SECS {
            return Err("The Android emulator did not finish booting in time.".into());
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        waited += 2;
    }
}

/// Whether the emulator's OS has finished booting (`getprop sys.boot_completed`).
async fn emulator_boot_completed(serial: &str) -> bool {
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "shell", "getprop", "sys.boot_completed"]);
    run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb getprop sys.boot_completed",
        ADB_TIMEOUT_SECS,
    )
    .await
    .map(|out| out.trim() == "1")
    .unwrap_or(false)
}

/// Whether the project's app is currently running on the emulator — the Android
/// analog of [`simulator_app_running`]. `pidof <app_id>` exits 0 with the pid iff
/// the process is alive. The app id (Gradle `applicationId`) comes from the build
/// log; without it we can't tell our app from others, so report not-running.
#[tauri::command]
#[tracing::instrument]
pub async fn android_app_running(
    serial: String,
    app_id: Option<String>,
) -> Result<bool, CommandError> {
    let Some(app_id) = app_id else {
        return Ok(false);
    };
    let mut cmd = adb_command();
    cmd.args(["-s", &serial, "shell", "pidof", &app_id]);
    // pidof exits 1 (→ run_to_stdout Err) when not found; treat that as not-running.
    let out = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb shell pidof",
        ADB_TIMEOUT_SECS,
    )
    .await
    .unwrap_or_default();
    Ok(!out.trim().is_empty())
}

/// Which platforms a project can build for — drives the UX platform picker so it
/// only offers what the project actually targets.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MobileTargets {
    pub ios: bool,
    pub android: bool,
}

/// Detect a project's mobile build targets from its layout. Bare RN / Flutter keep
/// `ios/` and `android/` native folders; managed Expo can `prebuild` either on
/// demand, so it offers both. Non-mobile projects target neither. Pure for testing.
fn detect_mobile_targets_for(project_path: &std::path::Path) -> MobileTargets {
    use crate::commands::projects::{detect_project_type, is_expo_project};
    match detect_project_type(project_path) {
        crate::types::ProjectType::Flutter | crate::types::ProjectType::Reactnative => {
            if is_expo_project(project_path) {
                return MobileTargets {
                    ios: true,
                    android: true,
                };
            }
            let ios = project_path.join("ios").is_dir();
            let android = project_path.join("android").is_dir();
            // A native project with neither folder yet (freshly cloned) — offer both
            // rather than nothing; the build will generate the missing platform.
            if !ios && !android {
                MobileTargets {
                    ios: true,
                    android: true,
                }
            } else {
                MobileTargets { ios, android }
            }
        }
        _ => MobileTargets::default(),
    }
}

/// Which platforms a project can build for (iOS / Android). Combined by the frontend
/// with [`mobile_platform_support`] (machine capability) so a platform is only
/// offered when the project targets it AND the toolchain exists.
#[tauri::command]
#[tracing::instrument]
pub async fn detect_mobile_targets(project_path: String) -> Result<MobileTargets, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let workspace = crate::utils::resolve_workspace_path(&project);
    Ok(detect_mobile_targets_for(&workspace))
}

/// Whether the machine can actually preview each platform — distinct from what a
/// project *targets*. iOS needs Xcode's command line tools; Android needs the SDK.
/// The frontend ANDs this with [`MobileTargets`] so it never offers a platform that
/// would dead-end, routing to agent-driven setup instead.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MobilePlatformSupport {
    pub ios: bool,
    pub android: bool,
}

/// Are Xcode's command line tools installed? `xcode-select -p` resolves the developer
/// dir only when they are (the bare `xcrun` stub exists even without them).
async fn xcode_clt_installed() -> bool {
    let mut cmd = create_command("xcode-select");
    cmd.arg("-p");
    cmd.env("PATH", get_extended_path());
    run_to_stdout(
        tokio::process::Command::from(cmd),
        "xcode-select -p",
        SIMCTL_TIMEOUT_SECS,
    )
    .await
    .map(|out| !out.trim().is_empty())
    .unwrap_or(false)
}

/// Whether there's an iOS simulator to preview on — one already booted, or one
/// available to boot. The CLT alone isn't enough (a full Xcode + a runtime are needed).
async fn ios_simulator_available() -> bool {
    if list_booted_simulators()
        .await
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    simctl_stdout(
        &["list", "devices", "available", "--json"],
        "xcrun simctl list available",
        SIMCTL_TIMEOUT_SECS,
    )
    .await
    .map(|json| choose_default_simulator(&json).is_some())
    .unwrap_or(false)
}

/// Whether this machine can actually preview iOS: the CLT AND a simulator to run on.
async fn ios_tooling_available() -> bool {
    xcode_clt_installed().await && ios_simulator_available().await
}

/// Whether this machine can actually preview Android: the SDK, a JDK for Gradle, AND
/// something to boot (an AVD, or a device already attached). A bare SDK directory
/// isn't enough — without an AVD/JDK the preview would dead-end at boot or build.
async fn android_tooling_available() -> bool {
    if android_sdk_root().is_none() || detect_jdk_home().is_none() {
        return false;
    }
    !list_avds().await.is_empty() || !list_android_devices().await.unwrap_or_default().is_empty()
}

/// Report which mobile platforms this machine can actually preview — not just which
/// toolchain is partially present, but which can boot/build something. The frontend
/// offers only these; the rest route to agent-driven setup.
#[tauri::command]
#[tracing::instrument]
pub async fn mobile_platform_support() -> Result<MobilePlatformSupport, CommandError> {
    Ok(MobilePlatformSupport {
        ios: ios_tooling_available().await,
        android: android_tooling_available().await,
    })
}

// ============ Android mirror bridge (H.264 → WebSocket) ============
//
// iOS uses serve-sim (MJPEG `<img>` + a WS touch channel). Android has no such
// daemon, so we bridge it ourselves. Both video sources below emit raw Annex-B
// H.264, which the frontend decodes with WebCodecs onto a `<canvas>`:
//
//   video (preferred): scrcpy-server in `raw_stream` mode — low-latency capture
//          (~50-100ms) over a forward-tunnelled socket, pure Annex-B with no headers
//          or dummy byte. We push the jar, forward a port, start the server, and
//          pump the socket to the WebSocket. scrcpy streams continuously (no cap).
//   video (fallback): `adb exec-out screenrecord --output-format=h264 -` when the
//          scrcpy jar isn't available. Always present but file-oriented (~1s
//          buffered) and capped at 180s, so we relaunch it in a loop (each relaunch
//          re-emits SPS/PPS+IDR, and the resolution is constant, so the decoder
//          config spans relaunches).
//   input: touches/keys arrive on the SAME WebSocket as JSON and become `adb shell
//          input` taps/swipes/keyevents — decoupled from the video transport, so it
//          works identically for both sources.
//
// Only the Rust capture source differs between scrcpy and screenrecord; the
// frontend, the input path, and the session machinery are untouched by the choice.

/// Bridge ports start above the serve-sim range (3100) so iOS and Android mirrors
/// for different projects never collide; the reserved-port system enforces the rest.
const ANDROID_BRIDGE_BASE_PORT: u16 = 3200;
/// `screenrecord`'s hard per-session cap. We relaunch on each expiry for a
/// continuous stream; the brief gap re-emits SPS/PPS+IDR so the decoder recovers.
const SCREENRECORD_TIME_LIMIT_SECS: u32 = 180;
/// scrcpy-server protocol version — MUST match the jar we push (bundled/located).
const SCRCPY_VERSION: &str = "4.0";
/// Where the scrcpy-server jar is pushed on the device.
const SCRCPY_REMOTE_JAR: &str = "/data/local/tmp/scrcpy-server.jar";
/// Cap on the mirror's long edge (px). Crisp on a 1080-wide phone while keeping the
/// stream light enough for low latency; scrcpy preserves aspect.
const SCRCPY_MAX_SIZE: u32 = 1600;

/// A running Android mirror bridge: the supervisor task (abort to stop the WS
/// server and the in-flight capture), the device serial (to clean up on-device
/// processes), and the scid of the live scrcpy server (if any) so teardown can
/// kill exactly OUR server — `pkill -f scrcpy` would also take down a scrcpy
/// session the user runs by hand, or another project's bridge on a shared device.
struct AndroidBridgeHandle {
    serial: String,
    task: tokio::task::JoinHandle<()>,
    /// The `scid=<id>` of the currently-running scrcpy server, set by the client
    /// handler for its connection's lifetime. `None` = screenrecord fallback (or
    /// no client connected).
    current_scid: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

/// Live bridges keyed by project path — the same key as [`MOBILE_SESSIONS`], so
/// teardown can find and stop the bridge for a project.
static ANDROID_BRIDGES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, AndroidBridgeHandle>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;
type WsSink = futures_util::stream::SplitSink<WsStream, tokio_tungstenite::tungstenite::Message>;
type WsSource = futures_util::stream::SplitStream<WsStream>;

/// A touch phase in a streamed gesture, mirroring the pointer events the
/// webview sees. Maps to Android `AMOTION_EVENT_ACTION_*` on the scrcpy path.
#[derive(Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TouchPhase {
    Down,
    Move,
    Up,
}

/// A control message from the webview, sent as JSON on the mirror WebSocket.
/// Coordinates are normalized 0..1 (origin top-left) so the frontend never needs
/// the device's pixel size.
///
/// `Touch` is the streamed-gesture path (scrcpy control socket): the frontend
/// sends every down/move/up, plus the decoded video dimensions (`vw`/`vh`) —
/// scrcpy's `PositionMapper` silently DROPS any event whose claimed screen size
/// doesn't match the encoder's video size, and the decoder is the one place that
/// size is reliably known. `Tap`/`Swipe` are the discrete fallback (screenrecord
/// mirror, or before the first frame): the bridge maps them with `wm size` onto
/// `adb shell input`.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ControlMsg {
    Touch {
        phase: TouchPhase,
        x: f64,
        y: f64,
        vw: u32,
        vh: u32,
    },
    Tap {
        x: f64,
        y: f64,
    },
    Swipe {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        #[serde(default)]
        ms: u32,
    },
    Key {
        key: String,
    },
    Text {
        text: String,
    },
}

/// Map a recognized key name to an `input keyevent` token. Whitelisted, not
/// pass-through, so the webview can't inject an arbitrary keyevent argument.
fn keycode_for(key: &str) -> Option<&'static str> {
    Some(match key {
        "BACK" => "KEYCODE_BACK",
        "HOME" => "KEYCODE_HOME",
        "APP_SWITCH" => "KEYCODE_APP_SWITCH",
        "ENTER" => "KEYCODE_ENTER",
        "DEL" => "KEYCODE_DEL",
        _ => return None,
    })
}

/// The same whitelist as [`keycode_for`], as numeric `AKEYCODE_*` values for the
/// scrcpy control socket.
fn android_keycode(key: &str) -> Option<i32> {
    Some(match key {
        "BACK" => 4,
        "HOME" => 3,
        "APP_SWITCH" => 187,
        "ENTER" => 66,
        "DEL" => 67,
        _ => return None,
    })
}

// ---- scrcpy control protocol (server v4.0) ----
//
// Verified against the scrcpy v4.0 server source (ControlMessageReader.java,
// ControlMessage.java, PositionMapper.java). All integers are big-endian.

/// `ControlMessage.TYPE_INJECT_KEYCODE`.
const SCRCPY_MSG_INJECT_KEYCODE: u8 = 0;
/// `ControlMessage.TYPE_INJECT_TEXT`.
const SCRCPY_MSG_INJECT_TEXT: u8 = 1;
/// `ControlMessage.TYPE_INJECT_TOUCH_EVENT`.
const SCRCPY_MSG_INJECT_TOUCH: u8 = 2;
/// scrcpy's `POINTER_ID_GENERIC_FINGER`: the server injects the event as a real
/// finger on the touchscreen source (buttons are zeroed server-side).
const SCRCPY_POINTER_GENERIC_FINGER: i64 = -2;
/// `AMOTION_EVENT_ACTION_*` values for the touch message's `action` byte.
const AMOTION_ACTION_DOWN: u8 = 0;
const AMOTION_ACTION_UP: u8 = 1;
const AMOTION_ACTION_MOVE: u8 = 2;
/// The server caps injected text at 300 bytes (`INJECT_TEXT_MAX_LENGTH`).
const SCRCPY_INJECT_TEXT_MAX: usize = 300;

/// Build a scrcpy inject-touch control message (32 bytes): type, action,
/// pointer id (i64), x/y (i32, in VIDEO pixels), video width/height (u16),
/// pressure (u16 fixed-point; 0xffff = 1.0, 0 on UP), action button, buttons.
/// `x`/`y` are normalized 0..1 and mapped onto the video size — scrcpy's
/// `PositionMapper` requires the claimed screen size to equal the encoder's
/// video size exactly, and maps the point back onto the device display itself
/// (so rotation/resize are handled server-side).
fn scrcpy_touch_msg(action: u8, x: f64, y: f64, vw: u16, vh: u16) -> [u8; 32] {
    let px = |n: f64, max: u16| (n.clamp(0.0, 1.0) * f64::from(max)).round() as i32;
    let pressure: u16 = if action == AMOTION_ACTION_UP {
        0
    } else {
        0xffff
    };
    let mut m = [0u8; 32];
    m[0] = SCRCPY_MSG_INJECT_TOUCH;
    m[1] = action;
    m[2..10].copy_from_slice(&SCRCPY_POINTER_GENERIC_FINGER.to_be_bytes());
    m[10..14].copy_from_slice(&px(x, vw).to_be_bytes());
    m[14..18].copy_from_slice(&px(y, vh).to_be_bytes());
    m[18..20].copy_from_slice(&vw.to_be_bytes());
    m[20..22].copy_from_slice(&vh.to_be_bytes());
    m[22..24].copy_from_slice(&pressure.to_be_bytes());
    // action_button (24..28) and buttons (28..32): zero — finger input.
    m
}

/// Build a scrcpy inject-keycode control message (14 bytes): type, action
/// (0 down / 1 up), keycode (i32), repeat (i32, 0), meta state (i32, 0).
fn scrcpy_keycode_msg(action: u8, keycode: i32) -> [u8; 14] {
    let mut m = [0u8; 14];
    m[0] = SCRCPY_MSG_INJECT_KEYCODE;
    m[1] = action;
    m[2..6].copy_from_slice(&keycode.to_be_bytes());
    m
}

/// Build a scrcpy inject-text control message: type, u32 byte length, UTF-8
/// bytes. `None` when empty or over the server's 300-byte cap — callers fall
/// back to the (sanitized) `adb shell input text` path.
fn scrcpy_text_msg(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > SCRCPY_INJECT_TEXT_MAX {
        return None;
    }
    let mut m = Vec::with_capacity(5 + bytes.len());
    m.push(SCRCPY_MSG_INJECT_TEXT);
    m.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    m.extend_from_slice(bytes);
    Some(m)
}

/// Translate a webview control message into scrcpy control-socket messages, in
/// write order. Empty = "not expressible here" — the caller falls back to the
/// `adb shell input` path (Tap/Swipe stay on adb: they carry no video size, and
/// the frontend only sends them in discrete mode anyway). Pure for testing.
fn control_to_scrcpy_msgs(msg: &ControlMsg) -> Vec<Vec<u8>> {
    match msg {
        ControlMsg::Touch {
            phase,
            x,
            y,
            vw,
            vh,
        } => {
            let (Ok(vw), Ok(vh)) = (u16::try_from(*vw), u16::try_from(*vh)) else {
                return Vec::new();
            };
            if vw == 0 || vh == 0 {
                return Vec::new();
            }
            let action = match phase {
                TouchPhase::Down => AMOTION_ACTION_DOWN,
                TouchPhase::Move => AMOTION_ACTION_MOVE,
                TouchPhase::Up => AMOTION_ACTION_UP,
            };
            vec![scrcpy_touch_msg(action, *x, *y, vw, vh).to_vec()]
        }
        ControlMsg::Key { key } => match android_keycode(key) {
            Some(code) => vec![
                scrcpy_keycode_msg(AMOTION_ACTION_DOWN, code).to_vec(),
                scrcpy_keycode_msg(AMOTION_ACTION_UP, code).to_vec(),
            ],
            None => Vec::new(),
        },
        ControlMsg::Text { text } => scrcpy_text_msg(text).map(|m| vec![m]).unwrap_or_default(),
        ControlMsg::Tap { .. } | ControlMsg::Swipe { .. } => Vec::new(),
    }
}

/// Sanitize text for `adb shell input text`, which runs through the device shell:
/// keep alphanumerics, encode spaces as `%s` (what `input text` expects), and DROP
/// everything else. Restrictive by design — a preview's text entry is a nice-to-have
/// and shell-metachar injection through an unsanitized arg is not worth it.
fn sanitize_input_text(text: &str) -> Option<String> {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if c == ' ' {
            out.push_str("%s");
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Translate a control message into `adb shell input` arguments, mapping normalized
/// coordinates onto the device's pixel size. `None` = nothing safe/known to send.
/// Pure, so the coordinate math and sanitization are unit-tested without a device.
fn control_to_adb_args(msg: &ControlMsg, dw: u32, dh: u32) -> Option<Vec<String>> {
    let px = |n: f64, max: u32| (n.clamp(0.0, 1.0) * max as f64).round() as i64;
    match msg {
        ControlMsg::Tap { x, y } => Some(vec![
            "tap".into(),
            px(*x, dw).to_string(),
            px(*y, dh).to_string(),
        ]),
        ControlMsg::Swipe { x1, y1, x2, y2, ms } => {
            let dur = if *ms == 0 { 200 } else { *ms };
            Some(vec![
                "swipe".into(),
                px(*x1, dw).to_string(),
                px(*y1, dh).to_string(),
                px(*x2, dw).to_string(),
                px(*y2, dh).to_string(),
                dur.to_string(),
            ])
        }
        ControlMsg::Key { key } => Some(vec!["keyevent".into(), keycode_for(key)?.to_string()]),
        ControlMsg::Text { text } => Some(vec!["text".into(), sanitize_input_text(text)?]),
        // Streamed touches need the scrcpy control socket; `adb shell input`
        // can't express a held-down pointer. The frontend only streams these in
        // scrcpy mode, so there's nothing to map here.
        ControlMsg::Touch { .. } => None,
    }
}

/// Parse `adb shell wm size` output into (width, height) px. Prefers an "Override
/// size" line (set when the display is resized) over "Physical size" by taking the
/// last `size:` line. Returns `None` if the format is unexpected.
fn parse_wm_size(stdout: &str) -> Option<(u32, u32)> {
    let line = stdout.lines().rev().find(|l| l.contains("size:"))?;
    let dims = line.rsplit(':').next()?.trim();
    let (w, h) = dims.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// The emulator/device display size in px, for mapping normalized touch coords.
/// Falls back to a 1080×1920 guess at the call site if this can't be read.
async fn device_size(serial: &str) -> Option<(u32, u32)> {
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "shell", "wm", "size"]);
    let out = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb shell wm size",
        ADB_TIMEOUT_SECS,
    )
    .await
    .ok()?;
    parse_wm_size(&out)
}

/// Everything needed to mirror via scrcpy: the live, already-probed video
/// socket (plus the first bytes the probe read), the control socket for input
/// injection, the on-device server child, and the forward guard that removes
/// the adb forward on every exit path.
struct ScrcpySession {
    server: tokio::process::Child,
    video: tokio::net::TcpStream,
    /// First video bytes (SPS/PPS + IDR) consumed by the connect probe.
    first: Vec<u8>,
    control: tokio::net::TcpStream,
    scid: String,
    /// Held for the session's lifetime; `Drop` removes the adb forward.
    _forward: ForwardGuard,
}

/// Monotonic scrcpy socket id source (`scrcpy_<scid>`), so concurrent bridges
/// (multiple projects/emulators) never collide on an abstract socket name.
fn next_scid() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed) & 0x7fff_ffff;
    format!("{n:08x}")
}

/// The bundled scrcpy-server jar path, resolved once at startup from the Tauri
/// resource (see `lib.rs` setup). A `OnceLock`, not a process-global env var, so we
/// don't mutate the environment as a side channel.
static BUNDLED_SCRCPY_JAR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Record the bundled scrcpy-server jar path (called once from app setup).
pub fn set_bundled_scrcpy_jar(path: std::path::PathBuf) {
    let _ = BUNDLED_SCRCPY_JAR.set(path);
}

/// Locate the scrcpy-server jar: the app-bundled resource first, then a
/// Homebrew/system install (dev / resilience).
fn scrcpy_server_jar() -> Option<std::path::PathBuf> {
    if let Some(bundled) = BUNDLED_SCRCPY_JAR.get() {
        if bundled.is_file() {
            return Some(bundled.clone());
        }
    }
    for p in [
        "/opt/homebrew/share/scrcpy/scrcpy-server",
        "/usr/local/share/scrcpy/scrcpy-server",
    ] {
        let path = std::path::PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Push the scrcpy-server jar to the device. Returns false (→ screenrecord fallback)
/// when no jar is found or the push fails. adb skips an identical file, so re-pushes
/// across reconnects are cheap.
async fn push_scrcpy_server(serial: &str) -> bool {
    let Some(jar) = scrcpy_server_jar() else {
        return false;
    };
    let mut cmd = adb_command();
    cmd.args([
        "-s",
        serial,
        "push",
        &jar.to_string_lossy(),
        SCRCPY_REMOTE_JAR,
    ]);
    run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb push scrcpy-server",
        ADB_TIMEOUT_SECS,
    )
    .await
    .is_ok()
}

/// Forward a local TCP port to scrcpy's abstract socket; `tcp:0` auto-assigns a free
/// port which adb prints back. Returns the chosen local port.
async fn setup_scrcpy_forward(serial: &str, scid: &str) -> Option<u16> {
    let mut cmd = adb_command();
    cmd.args([
        "-s",
        serial,
        "forward",
        "tcp:0",
        &format!("localabstract:scrcpy_{scid}"),
    ]);
    let out = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb forward scrcpy",
        ADB_TIMEOUT_SECS,
    )
    .await
    .ok()?;
    out.trim().parse::<u16>().ok()
}

/// Remove a scrcpy adb forward (best-effort cleanup).
async fn remove_scrcpy_forward(serial: &str, local_port: u16) {
    let mut cmd = adb_command();
    cmd.args([
        "-s",
        serial,
        "forward",
        "--remove",
        &format!("tcp:{local_port}"),
    ]);
    let _ = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb forward --remove",
        ADB_TIMEOUT_SECS,
    )
    .await;
}

/// Start scrcpy-server in raw-video + control mode (no audio). The on-device
/// process is a child of this adb shell, killed on drop. `raw_stream=true` makes
/// the VIDEO socket carry pure Annex-B H.264 — no device meta, codec header, or
/// dummy byte (it only strips metadata; control is unaffected, verified against
/// v4.0's `Options.java`). `control=true` opens the second (control) socket for
/// real streamed touch/key injection. `max_size` caps the long edge for a
/// crisp-but-light stream.
fn start_scrcpy_server(serial: &str, scid: &str) -> Option<tokio::process::Child> {
    let mut cmd = adb_command();
    cmd.args([
        "-s",
        serial,
        "shell",
        &format!("CLASSPATH={SCRCPY_REMOTE_JAR}"),
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        &format!("scid={scid}"),
        "tunnel_forward=true",
        "raw_stream=true",
        "video=true",
        "audio=false",
        "control=true",
        &format!("max_size={SCRCPY_MAX_SIZE}"),
        "log_level=error",
    ]);
    let mut tcmd = tokio::process::Command::from(cmd);
    tcmd.stdout(std::process::Stdio::null());
    tcmd.stderr(std::process::Stdio::null());
    tcmd.kill_on_drop(true);
    tcmd.spawn().ok()
}

/// Wait until the server's device-side abstract socket (`@scrcpy_<scid>`)
/// appears in `/proc/net/unix` — the deterministic "server is accepting"
/// signal. This matters because in adb forward mode a connect made BEFORE the
/// socket exists is accepted locally and then closed; and with `control=true`
/// the server doesn't start streaming until BOTH sockets are connected, so the
/// old probe-by-first-read approach (read video bytes before connecting
/// control) deadlocks against the server waiting for the control accept.
async fn wait_for_scrcpy_socket(serial: &str, scid: &str) -> bool {
    for _ in 0..40 {
        let mut cmd = adb_command();
        cmd.args([
            "-s",
            serial,
            "shell",
            &format!("grep -c scrcpy_{scid} /proc/net/unix"),
        ]);
        // grep exits non-zero on no match → Err → keep waiting.
        if run_to_stdout(
            tokio::process::Command::from(cmd),
            "adb grep scrcpy socket",
            ADB_TIMEOUT_SECS,
        )
        .await
        .map(|out| out.trim() != "0")
        .unwrap_or(false)
        {
            return true;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;
    }
    false
}

/// Connect to the forwarded scrcpy port with TCP_NODELAY, bounded.
async fn connect_forwarded(local_port: u16) -> Option<tokio::net::TcpStream> {
    use tokio::time::{timeout, Duration};
    match timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", local_port)),
    )
    .await
    {
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            Some(s)
        }
        _ => None,
    }
}

/// Removes its scrcpy adb forward when dropped — crucially including when the bridge
/// supervisor task is aborted mid-pump (teardown), where the explicit cleanup at the
/// end of `pump_video_scrcpy` would never run and the forward would leak. `Drop`
/// can't await, so it spawns the (fast, best-effort) removal.
struct ForwardGuard {
    serial: String,
    port: u16,
}

impl Drop for ForwardGuard {
    fn drop(&mut self) {
        let serial = std::mem::take(&mut self.serial);
        let port = self.port;
        tokio::spawn(async move { remove_scrcpy_forward(&serial, port).await });
    }
}

/// Establish a full scrcpy session: push the jar, forward a port, start the
/// server, wait for its device-side socket to exist, connect the VIDEO then the
/// CONTROL socket (the server accepts them in that order in `tunnel_forward`
/// mode), and read the first video bytes — the server only starts the encoder
/// once every enabled socket is connected. `None` on any failure — every path
/// cleans up after itself (the forward via the guard, the server via
/// `start_kill`), so the caller can simply fall back to screenrecord.
async fn establish_scrcpy(serial: &str) -> Option<ScrcpySession> {
    use tokio::io::AsyncReadExt;
    use tokio::time::{timeout, Duration};

    if !push_scrcpy_server(serial).await {
        return None;
    }
    let scid = next_scid();
    let local_port = setup_scrcpy_forward(serial, &scid).await?;
    // From here, any return (or abort) removes the forward via this guard.
    let forward = ForwardGuard {
        serial: serial.to_string(),
        port: local_port,
    };
    let mut server = match start_scrcpy_server(serial, &scid) {
        Some(s) => s,
        None => {
            tracing::warn!(%serial, "scrcpy: server spawn failed");
            return None;
        }
    };
    if !wait_for_scrcpy_socket(serial, &scid).await {
        tracing::warn!(%serial, "scrcpy: server socket never appeared");
        let _ = server.start_kill();
        return None;
    }
    let Some(mut video) = connect_forwarded(local_port).await else {
        tracing::warn!(%serial, "scrcpy: could not connect the video socket");
        let _ = server.start_kill();
        return None;
    };
    let Some(control) = connect_forwarded(local_port).await else {
        tracing::warn!(%serial, "scrcpy: could not connect the control socket");
        let _ = server.start_kill();
        return None;
    };
    // Both sockets are connected → the server starts the encoder; the first
    // bytes (SPS/PPS + IDR) follow within moments. Bound it so a wedged server
    // can't hang the bridge — on failure we fall back to screenrecord.
    let mut buf = vec![0u8; 64 * 1024];
    let first = match timeout(Duration::from_secs(10), video.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => {
            buf.truncate(n);
            buf
        }
        _ => {
            tracing::warn!(%serial, "scrcpy: no video bytes after connect");
            let _ = server.start_kill();
            return None;
        }
    };
    Some(ScrcpySession {
        server,
        video,
        first,
        control,
        scid,
        _forward: forward,
    })
}

/// Pump the scrcpy video socket's raw Annex-B H.264 to the WebSocket, starting
/// with the first chunk (SPS/PPS + IDR) the connect probe already read. Returns
/// when the server closes or the client disconnects. No relaunch loop — scrcpy
/// streams continuously (no 180s cap).
async fn pump_scrcpy_video(mut stream: tokio::net::TcpStream, first: Vec<u8>, mut sink: WsSink) {
    use futures_util::SinkExt;
    use tokio::io::AsyncReadExt;
    use tokio_tungstenite::tungstenite::Message;

    if sink.send(Message::Binary(first)).await.is_err() {
        return;
    }
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => break, // server closed
            Ok(n) => {
                if sink.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                    break; // client gone
                }
            }
            Err(_) => break,
        }
    }
}

/// Read and discard the scrcpy control socket's device→client messages
/// (clipboard updates etc.). We don't use them, but if nobody reads them the
/// server's writes eventually block and stall the Controller. Ends when the
/// socket closes (server died) — which ends the client session via the select.
async fn drain_scrcpy_control(mut read: tokio::io::ReadHalf<tokio::net::TcpStream>) {
    use tokio::io::AsyncReadExt;
    let mut buf = vec![0u8; 4096];
    while matches!(read.read(&mut buf).await, Ok(n) if n > 0) {}
}

/// How many consecutive zero-byte screenrecord runs we tolerate before giving
/// up: a healthy relaunch (the 180s cap) always produces bytes, so repeated
/// empty runs mean the device is gone or screenrecord is broken — without this
/// cap the loop would respawn adb as fast as it can, forever.
const SCREENRECORD_MAX_EMPTY_RUNS: u32 = 5;

/// screenrecord fallback mirror: raw H.264 to the WebSocket, relaunched on the 180s
/// cap for a continuous stream. The local `adb exec-out` child is killed on drop,
/// tearing down the on-device screenrecord with it. Used only when scrcpy isn't
/// available; higher latency but zero extra dependencies. Empty runs back off
/// exponentially and give up after [`SCREENRECORD_MAX_EMPTY_RUNS`] — a dead
/// device must not turn the relaunch loop into a hot spin.
async fn pump_video_screenrecord(serial: String, mut sink: WsSink) {
    use futures_util::SinkExt;
    use tokio::io::AsyncReadExt;
    use tokio_tungstenite::tungstenite::Message;
    let mut empty_runs = 0u32;
    loop {
        let mut cmd = adb_command();
        cmd.args([
            "-s",
            &serial,
            "exec-out",
            "screenrecord",
            "--output-format=h264",
            &format!("--time-limit={SCREENRECORD_TIME_LIMIT_SECS}"),
            "-",
        ]);
        let mut tcmd = tokio::process::Command::from(cmd);
        tcmd.stdout(std::process::Stdio::piped());
        tcmd.stderr(std::process::Stdio::null());
        tcmd.kill_on_drop(true);
        let mut child = match tcmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(%serial, error = %e, "screenrecord spawn failed");
                return;
            }
        };
        let Some(mut stdout) = child.stdout.take() else {
            return;
        };
        let mut got_bytes = false;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break, // screenrecord hit its time limit → respawn below
                Ok(n) => {
                    got_bytes = true;
                    if sink.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                        let _ = child.start_kill();
                        return; // client gone
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait().await; // reap before relaunching
        if got_bytes {
            empty_runs = 0;
            continue;
        }
        empty_runs += 1;
        if empty_runs >= SCREENRECORD_MAX_EMPTY_RUNS {
            tracing::warn!(%serial, "screenrecord produced no output repeatedly — giving up");
            return;
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(1 << empty_runs.min(3))).await;
    }
}

/// Run one control message's adb fallback (`adb shell input …`). Errors are
/// swallowed — a dropped tap shouldn't kill the input channel.
async fn run_adb_input(serial: &str, args: &[String]) {
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "shell", "input"]);
    cmd.args(args);
    let _ = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb shell input",
        ADB_TIMEOUT_SECS,
    )
    .await;
}

/// Read control JSON from the WebSocket and drive `adb shell input` — the
/// discrete fallback used with the screenrecord mirror. Returns when the socket
/// closes.
async fn control_loop_adb(serial: String, mut source: WsSource, dw: u32, dh: u32) {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    while let Some(Ok(msg)) = source.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(parsed) = serde_json::from_str::<ControlMsg>(&text) else {
            continue;
        };
        if let Some(args) = control_to_adb_args(&parsed, dw, dh) {
            run_adb_input(&serial, &args).await;
        }
    }
}

/// Read control JSON from the WebSocket and inject it over the scrcpy control
/// socket — streamed touches (real down/move/up, so drags and long-presses feel
/// live), keycodes, and full-fidelity text. Messages the socket can't express
/// (Tap/Swipe, oversize text) fall back to `adb shell input`. Returns when the
/// WebSocket closes, or when the control socket dies (server gone — the video
/// pump ends with it and the supervisor takes over).
async fn control_loop_scrcpy(
    serial: String,
    mut source: WsSource,
    mut ctrl: tokio::io::WriteHalf<tokio::net::TcpStream>,
    dw: u32,
    dh: u32,
) {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    use tokio_tungstenite::tungstenite::Message;
    while let Some(Ok(msg)) = source.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(parsed) = serde_json::from_str::<ControlMsg>(&text) else {
            continue;
        };
        let msgs = control_to_scrcpy_msgs(&parsed);
        if msgs.is_empty() {
            // Not expressible on the control socket — adb input fallback.
            if let Some(args) = control_to_adb_args(&parsed, dw, dh) {
                run_adb_input(&serial, &args).await;
            }
            continue;
        }
        for m in &msgs {
            if ctrl.write_all(m).await.is_err() {
                tracing::warn!(%serial, "scrcpy control socket write failed");
                return;
            }
        }
    }
}

/// The hello the bridge sends as the FIRST WebSocket message, telling the
/// frontend which input mode this connection supports: `scrcpy` = stream raw
/// down/move/up touches; `adb` = send discrete tap/swipe. JSON text so it can't
/// be confused with the binary H.264 frames.
fn bridge_hello(input: &str) -> String {
    format!(r#"{{"type":"mode","input":"{input}"}}"#)
}

/// Handle one webview connection: WebSocket handshake, announce the input mode,
/// then run video out and control in concurrently. Whichever side ends first
/// cancels the others (dropped futures kill their capture children), so a
/// disconnect tears everything down. Single-client by design — the supervisor
/// loops back to await reconnects.
async fn handle_bridge_client(
    serial: &str,
    current_scid: &std::sync::Arc<std::sync::Mutex<Option<String>>>,
    stream: tokio::net::TcpStream,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let _ = stream.set_nodelay(true);
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::warn!(%serial, error = %e, "android bridge ws handshake failed");
            return;
        }
    };
    let (mut sink, source) = ws.split();
    let (dw, dh) = device_size(serial).await.unwrap_or((1080, 1920));

    match establish_scrcpy(serial).await {
        Some(sess) => {
            let ScrcpySession {
                mut server,
                video,
                first,
                control,
                scid,
                _forward,
            } = sess;
            *current_scid.lock().unwrap_or_else(|e| e.into_inner()) = Some(scid);
            if sink
                .send(Message::Text(bridge_hello("scrcpy")))
                .await
                .is_ok()
            {
                let (ctrl_read, ctrl_write) = tokio::io::split(control);
                tokio::select! {
                    _ = pump_scrcpy_video(video, first, sink) => {}
                    _ = control_loop_scrcpy(serial.to_string(), source, ctrl_write, dw, dh) => {}
                    _ = drain_scrcpy_control(ctrl_read) => {}
                }
            }
            let _ = server.start_kill();
            let _ = server.wait().await;
            *current_scid.lock().unwrap_or_else(|e| e.into_inner()) = None;
            // `_forward` drops here, removing the adb forward.
        }
        None => {
            tracing::info!(%serial, "scrcpy unavailable — using screenrecord mirror");
            if sink.send(Message::Text(bridge_hello("adb"))).await.is_err() {
                return;
            }
            tokio::select! {
                _ = pump_video_screenrecord(serial.to_string(), sink) => {}
                _ = control_loop_adb(serial.to_string(), source, dw, dh) => {}
            }
        }
    }
}

/// Accept loop: serve one client at a time, looping back on disconnect so a tab
/// re-open or heal reconnects to the same bridge. Ends only when the listener dies.
async fn android_bridge_supervisor(
    serial: String,
    current_scid: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    listener: tokio::net::TcpListener,
) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => handle_bridge_client(&serial, &current_scid, stream).await,
            Err(e) => {
                tracing::warn!(%serial, error = %e, "android bridge accept failed; stopping");
                break;
            }
        }
    }
}

/// Bind the mirror WebSocket on `ws_port` and start its supervisor, registered by
/// project path so teardown can stop it. Fails if the port can't be bound (the
/// caller reserved it, so this is rare) — leaving no half-started bridge.
async fn start_android_bridge(
    serial: &str,
    project_path: &str,
    ws_port: u16,
) -> Result<(), CommandError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", ws_port))
        .await
        .map_err(|e| format!("Failed to bind the Android mirror bridge on port {ws_port}: {e}"))?;
    let serial = serial.to_string();
    let current_scid = std::sync::Arc::new(std::sync::Mutex::new(None));
    let task = tokio::spawn(android_bridge_supervisor(
        serial.clone(),
        current_scid.clone(),
        listener,
    ));
    ANDROID_BRIDGES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            project_path.to_string(),
            AndroidBridgeHandle {
                serial,
                task,
                current_scid,
            },
        );
    Ok(())
}

/// On-device kill command for a bridge's lingering capture process. When the
/// bridge ran scrcpy we match by OUR `scid=<id>` — a bare `pkill -f scrcpy`
/// would also take down a scrcpy session the user runs by hand, or another
/// project's bridge sharing the device. Without a scid (screenrecord fallback,
/// or no client connected) only the screenrecord fallback could be lingering.
/// The scid is our own 8-hex-digit token, so interpolation is shell-safe.
fn capture_kill_command(scid: Option<String>) -> String {
    match scid {
        Some(id) => format!("pkill -f scid={id} 2>/dev/null"),
        None => "pkill -f screenrecord 2>/dev/null".to_string(),
    }
}

/// Stop a project's bridge (abort the supervisor → drops the listener and the
/// in-flight capture child) and best-effort kill any lingering on-device capture
/// process (our scrcpy server, matched by scid, or the screenrecord fallback).
/// Idempotent: no bridge → nothing to do.
async fn stop_android_bridge(project_path: &str) {
    let handle = ANDROID_BRIDGES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(project_path);
    if let Some(h) = handle {
        h.task.abort();
        let scid = h
            .current_scid
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let mut cmd = adb_command();
        cmd.args(["-s", &h.serial, "shell", &capture_kill_command(scid)]);
        let _ = run_to_stdout(
            tokio::process::Command::from(cmd),
            "adb shell pkill capture",
            ADB_TIMEOUT_SECS,
        )
        .await;
    }
}

/// Synchronous bridge stop for the window-Destroyed handler (which can't await):
/// abort the supervisor and blocking-kill the on-device capture process. Mirrors the
/// iOS sync teardown's use of blocking `.output()`.
fn stop_android_bridge_sync(project_path: &str, serial: &str) {
    let scid = ANDROID_BRIDGES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(project_path)
        .map(|h| {
            h.task.abort();
            h.current_scid
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
        })
        .unwrap_or(None);
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "shell", &capture_kill_command(scid)]);
    let _ = cmd.output();
}

/// Determine the command that launches the project's app onto a booted
/// simulator, based on the project type. Reads project files (not pure) and is
/// unit-tested via `build_launch_command`; the frontend runs the returned
/// command in the embedded `BuildTerminal` (a backend `pty_session`).
fn build_launch_command(
    project_path: &std::path::Path,
    platform: crate::state::Platform,
    device_id: &str,
) -> Option<String> {
    use crate::commands::projects::{detect_project_type, is_expo_project};
    use crate::state::Platform;
    match detect_project_type(project_path) {
        // `flutter run -d <id>` targets by device id on both platforms (UDID / serial).
        crate::types::ProjectType::Flutter => Some(format!("flutter run -d {device_id}")),
        crate::types::ProjectType::Reactnative => {
            // Expo builds via `run:ios`/`run:android`; bare RN via the RN CLI. iOS
            // targets the specific device by id; Android `run:android`/`run-android`
            // target the single booted emulator (we boot exactly one, like iOS).
            // `--yes` stops npx prompting "Ok to proceed?" (which would hang the
            // read-only build log) when a package isn't present locally.
            let expo = is_expo_project(project_path);
            Some(match (platform, expo) {
                (Platform::Ios, true) => format!("npx --yes expo run:ios --device {device_id}"),
                (Platform::Ios, false) => {
                    format!("npx --yes react-native run-ios --udid {device_id}")
                }
                (Platform::Android, true) => "npx --yes expo run:android".to_string(),
                (Platform::Android, false) => "npx --yes react-native run-android".to_string(),
            })
        }
        _ => None,
    }
}

/// Locate a usable JDK for Gradle (the Android build needs `JAVA_HOME`). The build
/// runs in a login shell, so it inherits the user's profile — but `JAVA_HOME` is
/// often unset there even when a JDK exists. We probe the common install locations
/// (filesystem only, no shelling) and return the first with a real `bin/java`.
fn detect_jdk_home() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        candidates.push(std::path::PathBuf::from(jh));
    }
    // Android Studio's bundled JBR — the canonical JDK for Android builds.
    candidates.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home".into());
    // Homebrew openjdk.
    candidates.push("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home".into());
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("android-jdk/Contents/Home"));
    }
    // System- and user-installed JDKs (e.g. Temurin) live under JavaVirtualMachines.
    let vm_dirs = [
        std::path::PathBuf::from("/Library/Java/JavaVirtualMachines"),
        dirs::home_dir()
            .map(|h| h.join("Library/Java/JavaVirtualMachines"))
            .unwrap_or_default(),
    ];
    for base in vm_dirs {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                candidates.push(e.path().join("Contents/Home"));
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.join("bin/java").is_file())
}

/// Build the env-export prefix for an Android build command from the detected
/// JDK and SDK locations. Pure for testing. `${VAR:-…}` keeps a user's own
/// login-shell `JAVA_HOME`/`ANDROID_HOME` winning over the detected paths.
fn android_build_env_prefix(
    jdk: Option<&std::path::Path>,
    sdk: Option<&std::path::Path>,
) -> String {
    let mut prefix = String::new();
    if let Some(jdk) = jdk {
        prefix.push_str(&format!(
            "export JAVA_HOME=\"${{JAVA_HOME:-{}}}\"; export PATH=\"$JAVA_HOME/bin:$PATH\"; ",
            jdk.display()
        ));
    }
    if let Some(sdk) = sdk {
        prefix.push_str(&format!(
            "export ANDROID_HOME=\"${{ANDROID_HOME:-{}}}\"; ",
            sdk.display()
        ));
    }
    prefix
}

/// Wrap an Android build command so Gradle can find its toolchain: export
/// `JAVA_HOME` (+ its `bin` on PATH) and `ANDROID_HOME`. The SDK export matters
/// because the build runs in a login shell where `ANDROID_HOME` is usually
/// UNSET — we resolve adb/emulator from the default SDK path ourselves, but
/// Gradle's "SDK location not found" check can't, so any project without an
/// `android/local.properties` fails at `./gradlew app:installDebug`. iOS
/// commands pass through untouched. Nothing detected → return the command
/// unchanged so Gradle's own error surfaces rather than a wrapper failure.
fn with_android_build_env(platform: crate::state::Platform, cmd: String) -> String {
    if platform != crate::state::Platform::Android {
        return cmd;
    }
    let prefix =
        android_build_env_prefix(detect_jdk_home().as_deref(), android_sdk_root().as_deref());
    format!("{prefix}{cmd}")
}

/// Get the launch command for a project's app on a given simulator, or an error
/// if the project type isn't a supported native mobile app. Android commands are
/// wrapped to provide `JAVA_HOME`/`ANDROID_HOME` for Gradle (see
/// [`with_android_build_env`]).
#[tauri::command]
#[tracing::instrument]
pub async fn get_simulator_launch_command(
    project_path: String,
    platform: crate::state::Platform,
    udid: String,
) -> Result<String, CommandError> {
    let project = crate::utils::validate_project_path(&project_path)?;
    let workspace = crate::utils::resolve_workspace_path(&project);
    let cmd =
        build_launch_command(&workspace, platform, &udid).ok_or_else(|| -> CommandError {
            "This project type can't be launched on this device yet.".into()
        })?;
    Ok(with_android_build_env(platform, cmd))
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

/// Synchronously kill whatever process is LISTENING on a TCP port (macOS `lsof`).
/// Used by the window-close handler instead of `npx serve-sim --kill`, which pays
/// a node/npx cold start (hundreds of ms) that would jank window close. Mirrors
/// the `kill_port` command's `lsof -sTCP:LISTEN` approach.
///
/// `-sTCP:LISTEN` is critical: a bare `-i tcp:PORT` also matches CLIENTS connected
/// to the port — including our own webview's established socket to the mirror — and
/// `kill -9`ing those takes down WebKit and crashes the app. Listeners only.
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
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
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
    teardown_session(&project_path, &session).await;
    crate::state::drop_boot_lock(&project_path);
}

/// Tear down an iOS session's processes (build pty, serve-sim mirror, sim if we
/// booted it) and release its port. Does **not** touch the registry — the caller
/// `take`s the entry first — so it's reusable by teardown and the platform-switch
/// path. The iOS analog of [`teardown_android_session`].
async fn teardown_ios_session(project_path: &str, session: &crate::state::MobileSession) {
    if let Some(build_id) = &session.build_session_id {
        let _ = crate::commands::pty_session::pty_session_kill(build_id.clone());
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
        crate::state::release_port_for_project(&session.window_label, project_path);
    }
}

/// Dispatch teardown to the right platform. Lets a caller holding a `take`n session
/// clean it up without caring whether it's iOS or Android — the key to switching
/// platforms within one project without leaking the previous platform's processes.
async fn teardown_session(project_path: &str, session: &crate::state::MobileSession) {
    match session.platform {
        crate::state::Platform::Android => teardown_android_session(project_path, session).await,
        crate::state::Platform::Ios => teardown_ios_session(project_path, session).await,
    }
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
        if let Some(build_id) = &session.build_session_id {
            let _ = crate::commands::pty_session::pty_session_kill(build_id.clone());
        }
        if session.platform == crate::state::Platform::Android {
            // Abort the in-process bridge (our own WS listener; lsof-by-port would
            // miss it) and blocking-kill the emulator we booted.
            stop_android_bridge_sync(&project_path, &session.udid);
            if session.booted_by_us {
                let mut cmd = adb_command();
                cmd.args(["-s", &session.udid, "emu", "kill"]);
                let _ = cmd.output();
            }
            crate::state::drop_boot_lock(&project_path);
            continue;
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
        launch_status: s.launch_status.clone(),
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

    // serve-sim may have stepped past our reserved port (ours got grabbed by a
    // non-Ship-Studio process between reserve and bind). serve-sim physically owns
    // the port it bound, so re-key our reservation to it — never leave a live mirror
    // on an unreserved port a dev server could be handed. `port_was_reserved` must
    // reflect whether the claim actually succeeded (it can fail on a poisoned lock).
    let port_was_reserved = if info.port != reserved {
        crate::state::release_port_for_project(window_label, project_path);
        crate::state::reserve_port_force(window_label, project_path, info.port)
    } else {
        true
    };

    info.device_name = device_name.clone();
    info.device_runtime = device_runtime.clone();

    // The build session id is the deterministic one the frontend uses, so
    // teardown can kill the build pty_session even though it's spawned separately
    // (killing an id that never spawned is a no-op).
    crate::state::register_mobile_session(
        project_path.to_string(),
        crate::state::MobileSession {
            platform: crate::state::Platform::Ios,
            udid: udid.to_string(),
            booted_by_us,
            serve_sim_port: info.port,
            port_was_reserved,
            build_session_id: Some(build_session_id_for(project_path)),
            window_label: window_label.to_string(),
            device_name,
            device_runtime,
            launch_status: None,
        },
    );

    Ok(info)
}

/// The build verdicts the frontend may report. A closed set so the registry
/// can't accumulate arbitrary strings from the webview.
const LAUNCH_STATUSES: [&str; 4] = ["building", "launched", "failed", "exited"];

/// Record the frontend's settled build verdict on the project's live session,
/// so a later reuse (tab-return) restores it instantly — the pty ring buffer
/// can have dropped the log marker the verdict came from. No-op when no session
/// is registered (the report raced a teardown).
#[tauri::command]
#[tracing::instrument]
pub async fn set_mobile_launch_status(
    project_path: String,
    status: String,
) -> Result<(), CommandError> {
    crate::utils::validate_project_path(&project_path)?;
    if !LAUNCH_STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown launch status: {status}").into());
    }
    crate::state::set_mobile_session_launch_status(&project_path, status);
    Ok(())
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
    platform: crate::state::Platform,
    preferred: Option<String>,
) -> Result<MirrorInfo, CommandError> {
    // macOS-only for now: the iOS path needs Xcode/simctl, and the Android path
    // (adb/emulator/scrcpy) hasn't been validated on Windows. The frontend already
    // hides the mobile preview off macOS; this is the backend backstop.
    if !cfg!(target_os = "macos") {
        return Err("Mobile preview is currently available on macOS only.".into());
    }

    // Android has its own boot + mirror transport (emulator + screenrecord→WS
    // bridge); route to it. iOS continues below with serve-sim.
    if platform == crate::state::Platform::Android {
        return start_android_preview(project_path, window_label, preferred).await;
    }

    // Serialize per project so two concurrent starts can't both boot a sim.
    let lock = crate::state::boot_lock_for(&project_path);
    let _guard = lock.lock().await;

    // A session already exists. Reuse it if the mirror is still alive; otherwise
    // heal or rebuild rather than returning a dead port.
    if let Some(existing) = crate::state::get_mobile_session(&project_path) {
        if existing.platform != crate::state::Platform::Ios {
            // Switching platforms (Android → iOS) in this project: tear the other
            // platform's session down, then fall through to a fresh iOS boot.
            crate::state::take_mobile_session(&project_path);
            teardown_session(&project_path, &existing).await;
        } else if serve_sim_alive(existing.serve_sim_port).await {
            tracing::info!(udid = %existing.udid, "start_mobile_preview: reusing live session");
            return Ok(reuse_mirror_info(&existing));
        } else {
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
            // Kill the underlying processes BEFORE dropping the registry entry, so an
            // interruption here can't orphan them with no record left to find them by.
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
            crate::state::take_mobile_session(&project_path);
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

/// Best-effort friendly Android version (e.g. "Android 15") for the preview
/// toolbar — the Android analog of iOS's `friendly_runtime`.
async fn android_device_runtime(serial: &str) -> Option<String> {
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "shell", "getprop", "ro.build.version.release"]);
    let out = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb getprop ro.build.version.release",
        ADB_TIMEOUT_SECS,
    )
    .await
    .ok()?;
    let v = out.trim();
    (!v.is_empty()).then(|| format!("Android {v}"))
}

/// Whether a device/emulator with this serial is still attached and ready. Used to
/// confirm a reused session's emulator didn't die out from under the live bridge.
async fn android_device_present(serial: &str) -> bool {
    list_android_devices()
        .await
        .map(|devs| devs.iter().any(|d| d.serial == serial))
        .unwrap_or(false)
}

/// Shut down an emulator we booted (`adb emu kill`). Best-effort; no-op for a
/// physical device that ignores it.
async fn android_emu_kill(serial: &str) {
    let mut cmd = adb_command();
    cmd.args(["-s", serial, "emu", "kill"]);
    let _ = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb emu kill",
        ADB_TIMEOUT_SECS,
    )
    .await;
}

/// Reconstruct the canvas-mirror connection info for a live Android session — the
/// Android analog of [`reuse_mirror_info`]. There's no MJPEG URL: the frontend
/// decodes the WebSocket's H.264 onto a `<canvas>`, so `stream_url` is empty.
fn android_mirror_info(s: &crate::state::MobileSession) -> MirrorInfo {
    MirrorInfo {
        udid: s.udid.clone(),
        stream_url: String::new(),
        ws_url: format!("ws://127.0.0.1:{}", s.serve_sim_port),
        port: s.serve_sim_port,
        device_name: s.device_name.clone(),
        device_runtime: s.device_runtime.clone(),
        launch_status: s.launch_status.clone(),
    }
}

/// Tear down an Android session's processes (build pty, mirror bridge, emulator if
/// we booted it) and release its port. Does **not** touch the registry — the caller
/// `take`s the entry first — so it's reusable by both teardown and the rebuild path.
async fn teardown_android_session(project_path: &str, session: &crate::state::MobileSession) {
    if let Some(build_id) = &session.build_session_id {
        let _ = crate::commands::pty_session::pty_session_kill(build_id.clone());
    }
    stop_android_bridge(project_path).await;
    if session.booted_by_us {
        tracing::info!(serial = %session.udid, "tearing down android preview: killing emulator we booted");
        android_emu_kill(&session.udid).await;
    }
    if session.port_was_reserved {
        crate::state::release_port_for_project(&session.window_label, project_path);
    }
}

/// Start (or reuse) an Android mirror preview: ensure an emulator is booted, reserve
/// a port, start the screenrecord→WebSocket bridge, and register the session so the
/// backend owns its lifecycle. The Android analog of the iOS path in
/// [`start_mobile_preview`]; serialized per project by the shared boot lock. A live
/// session is reused; a dead one is torn down and rebuilt (the bridge supervisor
/// already survives client churn, so the usual death mode is the emulator itself).
async fn start_android_preview(
    project_path: String,
    window_label: String,
    preferred: Option<String>,
) -> Result<MirrorInfo, CommandError> {
    let lock = crate::state::boot_lock_for(&project_path);
    let _guard = lock.lock().await;

    if let Some(existing) = crate::state::get_mobile_session(&project_path) {
        // Reuse only if BOTH the bridge port is listening AND the emulator is still
        // attached — the supervisor can outlive a dead emulator, and reusing that
        // hands back a frozen mirror with no recovery. `serve_sim_alive` is a generic
        // TCP-connect probe; here it checks the bridge's listener.
        if existing.platform == crate::state::Platform::Android
            && android_device_present(&existing.udid).await
            && serve_sim_alive(existing.serve_sim_port).await
        {
            tracing::info!(serial = %existing.udid, "start_android_preview: reusing live bridge");
            return Ok(android_mirror_info(&existing));
        }
        // Stale or wrong-platform session (e.g. an iOS preview was up) — drop it and
        // tear it down via the platform dispatcher before rebuilding for Android.
        crate::state::take_mobile_session(&project_path);
        teardown_session(&project_path, &existing).await;
    }

    let (device, booted_by_us) = ensure_emulator(preferred).await?;
    let reserved = crate::commands::pty::find_and_reserve_port(
        window_label.clone(),
        project_path.clone(),
        ANDROID_BRIDGE_BASE_PORT,
    )?;
    if let Err(e) = start_android_bridge(&device.serial, &project_path, reserved).await {
        crate::state::release_port_for_project(&window_label, &project_path);
        if booted_by_us {
            android_emu_kill(&device.serial).await;
        }
        return Err(e);
    }

    let device_runtime = android_device_runtime(&device.serial).await;
    crate::state::register_mobile_session(
        project_path.clone(),
        crate::state::MobileSession {
            platform: crate::state::Platform::Android,
            udid: device.serial.clone(),
            booted_by_us,
            serve_sim_port: reserved,
            port_was_reserved: true,
            build_session_id: Some(build_session_id_for(&project_path)),
            window_label,
            device_name: device.name.clone(),
            device_runtime: device_runtime.clone(),
            launch_status: None,
        },
    );

    Ok(MirrorInfo {
        udid: device.serial,
        stream_url: String::new(),
        ws_url: format!("ws://127.0.0.1:{reserved}"),
        port: reserved,
        device_name: device.name,
        device_runtime,
        launch_status: None,
    })
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
    fn detect_mobile_targets_by_layout_and_framework() {
        use std::fs;
        use tempfile::TempDir;

        // Expo (managed) → both, regardless of native folders.
        let expo = TempDir::new().unwrap();
        fs::write(
            expo.path().join("package.json"),
            r#"{"dependencies":{"expo":"51"}}"#,
        )
        .unwrap();
        assert_eq!(
            detect_mobile_targets_for(expo.path()),
            MobileTargets {
                ios: true,
                android: true
            }
        );

        // Bare RN with only an android/ folder → Android only.
        let rn = TempDir::new().unwrap();
        fs::write(
            rn.path().join("package.json"),
            r#"{"dependencies":{"react-native":"0.75"}}"#,
        )
        .unwrap();
        fs::create_dir(rn.path().join("android")).unwrap();
        assert_eq!(
            detect_mobile_targets_for(rn.path()),
            MobileTargets {
                ios: false,
                android: true
            }
        );

        // Plain web → neither.
        let web = TempDir::new().unwrap();
        fs::write(web.path().join("next.config.js"), "module.exports={}").unwrap();
        assert_eq!(
            detect_mobile_targets_for(web.path()),
            MobileTargets::default()
        );
    }

    #[test]
    fn parse_adb_devices_keeps_only_ready_devices() {
        let out = "List of devices attached\n\
                   emulator-5554\tdevice\n\
                   emulator-5556\toffline\n\
                   ZY223abc\tunauthorized\n\
                   192.168.1.5:5555\tdevice\n\
                   \n";
        let devices = parse_adb_devices(out);
        assert_eq!(
            devices.len(),
            2,
            "offline/unauthorized/header/blank dropped"
        );
        assert_eq!(devices[0].serial, "emulator-5554");
        assert!(devices[0].is_emulator);
        // A networked physical device is ready but not an emulator.
        assert_eq!(devices[1].serial, "192.168.1.5:5555");
        assert!(!devices[1].is_emulator);
    }

    #[test]
    fn parse_adb_devices_empty_when_none_attached() {
        assert!(parse_adb_devices("List of devices attached\n\n").is_empty());
        assert!(parse_adb_devices("").is_empty());
    }

    #[test]
    fn build_launch_command_for_expo_flutter_and_unsupported() {
        use crate::state::Platform::{Android, Ios};
        use std::fs;
        use tempfile::TempDir;

        // Expo — iOS targets by device, Android runs on the single booted emulator.
        let expo = TempDir::new().unwrap();
        fs::write(
            expo.path().join("package.json"),
            r#"{"dependencies":{"expo":"51"}}"#,
        )
        .unwrap();
        assert_eq!(
            build_launch_command(expo.path(), Ios, "UDID").as_deref(),
            Some("npx --yes expo run:ios --device UDID")
        );
        assert_eq!(
            build_launch_command(expo.path(), Android, "EMU").as_deref(),
            Some("npx --yes expo run:android")
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
            build_launch_command(rn.path(), Ios, "UDID").as_deref(),
            Some("npx --yes react-native run-ios --udid UDID")
        );
        assert_eq!(
            build_launch_command(rn.path(), Android, "EMU").as_deref(),
            Some("npx --yes react-native run-android")
        );

        // Flutter — `-d <id>` works for both platforms (UDID / emulator serial).
        let flutter = TempDir::new().unwrap();
        fs::write(
            flutter.path().join("pubspec.yaml"),
            "dependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .unwrap();
        assert_eq!(
            build_launch_command(flutter.path(), Ios, "X").as_deref(),
            Some("flutter run -d X")
        );
        assert_eq!(
            build_launch_command(flutter.path(), Android, "emulator-5554").as_deref(),
            Some("flutter run -d emulator-5554")
        );

        // Unsupported (plain web) — neither platform.
        let web = TempDir::new().unwrap();
        fs::write(web.path().join("next.config.js"), "module.exports={}").unwrap();
        assert_eq!(build_launch_command(web.path(), Ios, "X"), None);
        assert_eq!(build_launch_command(web.path(), Android, "X"), None);
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

    #[test]
    fn parse_wm_size_prefers_override_and_handles_physical() {
        assert_eq!(parse_wm_size("Physical size: 320x640"), Some((320, 640)));
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\n"),
            Some((1080, 2400))
        );
        // Override wins (it's the last `size:` line when the display is resized).
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\nOverride size: 720x1280"),
            Some((720, 1280))
        );
        assert_eq!(parse_wm_size("garbage"), None);
        assert_eq!(parse_wm_size("Physical size: notxdims"), None);
    }

    #[test]
    fn control_to_adb_args_maps_and_clamps() {
        // Tap: normalized → device px, rounded, clamped into range.
        assert_eq!(
            control_to_adb_args(&ControlMsg::Tap { x: 0.5, y: 0.25 }, 320, 640),
            Some(vec!["tap".into(), "160".into(), "160".into()])
        );
        assert_eq!(
            control_to_adb_args(&ControlMsg::Tap { x: 2.0, y: -1.0 }, 320, 640),
            Some(vec!["tap".into(), "320".into(), "0".into()])
        );
        // Swipe: zero ms falls back to a sane default duration.
        assert_eq!(
            control_to_adb_args(
                &ControlMsg::Swipe {
                    x1: 0.0,
                    y1: 1.0,
                    x2: 1.0,
                    y2: 0.0,
                    ms: 0
                },
                100,
                200
            ),
            Some(vec![
                "swipe".into(),
                "0".into(),
                "200".into(),
                "100".into(),
                "0".into(),
                "200".into()
            ])
        );
        // Key: whitelisted only.
        assert_eq!(
            control_to_adb_args(&ControlMsg::Key { key: "BACK".into() }, 1, 1),
            Some(vec!["keyevent".into(), "KEYCODE_BACK".into()])
        );
        assert_eq!(
            control_to_adb_args(
                &ControlMsg::Key {
                    key: "REBOOT".into()
                },
                1,
                1
            ),
            None
        );
    }

    #[test]
    fn sanitize_input_text_drops_metachars_and_encodes_spaces() {
        assert_eq!(
            sanitize_input_text("hello world").as_deref(),
            Some("hello%sworld")
        );
        // Shell metacharacters are dropped, not escaped.
        assert_eq!(
            sanitize_input_text("a; rm -rf /").as_deref(),
            Some("a%srm%srf%s")
        );
        assert_eq!(sanitize_input_text("$(whoami)").as_deref(), Some("whoami"));
        assert_eq!(sanitize_input_text("!@#"), None);
    }

    #[test]
    fn control_msg_deserializes_from_webview_json() {
        assert_eq!(
            serde_json::from_str::<ControlMsg>(r#"{"type":"tap","x":0.1,"y":0.2}"#).unwrap(),
            ControlMsg::Tap { x: 0.1, y: 0.2 }
        );
        // ms is optional (defaults to 0 → swipe applies its own default).
        assert_eq!(
            serde_json::from_str::<ControlMsg>(
                r#"{"type":"swipe","x1":0.0,"y1":0.0,"x2":0.5,"y2":0.5}"#
            )
            .unwrap(),
            ControlMsg::Swipe {
                x1: 0.0,
                y1: 0.0,
                x2: 0.5,
                y2: 0.5,
                ms: 0
            }
        );
        // Streamed touch with the decoded video size.
        assert_eq!(
            serde_json::from_str::<ControlMsg>(
                r#"{"type":"touch","phase":"move","x":0.5,"y":0.25,"vw":720,"vh":1600}"#
            )
            .unwrap(),
            ControlMsg::Touch {
                phase: TouchPhase::Move,
                x: 0.5,
                y: 0.25,
                vw: 720,
                vh: 1600
            }
        );
    }

    #[test]
    fn scrcpy_touch_msg_matches_v4_wire_format() {
        // DOWN at (0.5, 0.25) on a 720x1600 video → x=360, y=400, pressure 0xffff.
        let m = scrcpy_touch_msg(AMOTION_ACTION_DOWN, 0.5, 0.25, 720, 1600);
        assert_eq!(m.len(), 32);
        assert_eq!(m[0], 2, "TYPE_INJECT_TOUCH_EVENT");
        assert_eq!(m[1], 0, "AMOTION_EVENT_ACTION_DOWN");
        assert_eq!(&m[2..10], &(-2i64).to_be_bytes(), "generic finger pointer");
        assert_eq!(&m[10..14], &360i32.to_be_bytes());
        assert_eq!(&m[14..18], &400i32.to_be_bytes());
        assert_eq!(&m[18..20], &720u16.to_be_bytes());
        assert_eq!(&m[20..22], &1600u16.to_be_bytes());
        assert_eq!(&m[22..24], &[0xff, 0xff], "full pressure while down");
        assert_eq!(&m[24..32], &[0u8; 8], "no buttons for finger input");

        // UP zeroes the pressure; out-of-range coords clamp into the video.
        let up = scrcpy_touch_msg(AMOTION_ACTION_UP, 2.0, -1.0, 720, 1600);
        assert_eq!(&up[10..14], &720i32.to_be_bytes(), "x clamped to width");
        assert_eq!(&up[14..18], &0i32.to_be_bytes(), "y clamped to 0");
        assert_eq!(&up[22..24], &[0, 0], "no pressure on up");
    }

    #[test]
    fn scrcpy_keycode_and_text_msgs() {
        let down = scrcpy_keycode_msg(AMOTION_ACTION_DOWN, 4); // AKEYCODE_BACK
        assert_eq!(down.len(), 14);
        assert_eq!(down[0], 0, "TYPE_INJECT_KEYCODE");
        assert_eq!(down[1], 0, "action down");
        assert_eq!(&down[2..6], &4i32.to_be_bytes());
        assert_eq!(&down[6..14], &[0u8; 8], "repeat + meta zero");

        let txt = scrcpy_text_msg("hi 👋").unwrap();
        let bytes = "hi 👋".as_bytes();
        assert_eq!(txt[0], 1, "TYPE_INJECT_TEXT");
        assert_eq!(&txt[1..5], &(bytes.len() as u32).to_be_bytes());
        assert_eq!(&txt[5..], bytes);
        // Empty and oversize fall back to the adb path.
        assert!(scrcpy_text_msg("").is_none());
        assert!(scrcpy_text_msg(&"x".repeat(301)).is_none());
    }

    #[test]
    fn control_to_scrcpy_msgs_dispatch() {
        // Touch → one 32-byte message.
        let touch = ControlMsg::Touch {
            phase: TouchPhase::Down,
            x: 0.5,
            y: 0.5,
            vw: 720,
            vh: 1600,
        };
        assert_eq!(control_to_scrcpy_msgs(&touch).len(), 1);
        // Zero/oversize video dims → not expressible (adb fallback).
        let bad = ControlMsg::Touch {
            phase: TouchPhase::Down,
            x: 0.5,
            y: 0.5,
            vw: 0,
            vh: 1600,
        };
        assert!(control_to_scrcpy_msgs(&bad).is_empty());
        let huge = ControlMsg::Touch {
            phase: TouchPhase::Down,
            x: 0.5,
            y: 0.5,
            vw: 70000,
            vh: 1600,
        };
        assert!(control_to_scrcpy_msgs(&huge).is_empty());
        // Key → down + up pair; unknown key → nothing.
        assert_eq!(
            control_to_scrcpy_msgs(&ControlMsg::Key { key: "BACK".into() }).len(),
            2
        );
        assert!(control_to_scrcpy_msgs(&ControlMsg::Key {
            key: "REBOOT".into()
        })
        .is_empty());
        // Text → one message; Tap/Swipe stay on the adb path.
        assert_eq!(
            control_to_scrcpy_msgs(&ControlMsg::Text { text: "ok".into() }).len(),
            1
        );
        assert!(control_to_scrcpy_msgs(&ControlMsg::Tap { x: 0.1, y: 0.1 }).is_empty());
    }

    #[test]
    fn android_build_env_prefix_exports_jdk_and_sdk() {
        use std::path::Path;
        let jdk = Path::new("/opt/jdk");
        let sdk = Path::new("/Users/x/Library/Android/sdk");
        // Both detected → both exported, login-shell values winning via ${VAR:-}.
        let p = android_build_env_prefix(Some(jdk), Some(sdk));
        assert_eq!(
            p,
            "export JAVA_HOME=\"${JAVA_HOME:-/opt/jdk}\"; \
             export PATH=\"$JAVA_HOME/bin:$PATH\"; \
             export ANDROID_HOME=\"${ANDROID_HOME:-/Users/x/Library/Android/sdk}\"; "
        );
        // SDK alone still exports — a missing ANDROID_HOME is what breaks
        // Gradle's "SDK location not found" check on projects without a
        // local.properties.
        assert_eq!(
            android_build_env_prefix(None, Some(sdk)),
            "export ANDROID_HOME=\"${ANDROID_HOME:-/Users/x/Library/Android/sdk}\"; "
        );
        // Nothing detected → empty prefix (command runs unchanged).
        assert_eq!(android_build_env_prefix(None, None), "");
    }

    #[test]
    fn capture_kill_command_scopes_to_our_scid() {
        assert_eq!(
            capture_kill_command(Some("0000002a".into())),
            "pkill -f scid=0000002a 2>/dev/null"
        );
        assert_eq!(
            capture_kill_command(None),
            "pkill -f screenrecord 2>/dev/null"
        );
    }

    /// Live, non-hermetic proof that the bridge streams decodable H.264 from a real
    /// emulator AND that the scrcpy control socket accepts our injected input.
    /// Gated behind `SHIPSTUDIO_LIVE_ANDROID=1` (serial via
    /// `SHIPSTUDIO_ANDROID_SERIAL`, default `emulator-5554`) so `cargo test` skips it
    /// in CI. Run manually:
    ///   SHIPSTUDIO_LIVE_ANDROID=1 cargo test android_bridge_streams_h264 -- --nocapture
    #[tokio::test]
    async fn android_bridge_streams_h264() {
        if std::env::var("SHIPSTUDIO_LIVE_ANDROID").as_deref() != Ok("1") {
            eprintln!("skipping: set SHIPSTUDIO_LIVE_ANDROID=1 to run against a live emulator");
            return;
        }
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let serial =
            std::env::var("SHIPSTUDIO_ANDROID_SERIAL").unwrap_or_else(|_| "emulator-5554".into());
        let project = "/tmp/ship-android-bridge-test";
        let port = 3299;

        // Register the repo's bundled jar like the app's setup does (the OnceLock
        // is only populated via lib.rs in a real run) — the test must exercise
        // the scrcpy path, not silently pass on the screenrecord fallback.
        set_bundled_scrcpy_jar(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/scrcpy-server.jar"),
        );

        start_android_bridge(&serial, project, port)
            .await
            .expect("bridge should bind");

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .expect("client should connect");

        // First message is the mode hello (scrcpy expected when the jar is bundled).
        let hello = tokio::time::timeout(std::time::Duration::from_secs(20), ws.next())
            .await
            .expect("hello in time")
            .expect("ws open")
            .expect("ws ok");
        let Message::Text(hello) = hello else {
            panic!("expected text hello first, got {hello:?}");
        };
        eprintln!("bridge hello: {hello}");
        assert!(
            hello.contains(r#""input":"scrcpy""#),
            "expected the scrcpy input mode, got: {hello}"
        );

        // Collect a bit of stream; assert it's Annex-B H.264 (starts 00 00 00 01).
        let mut acc: Vec<u8> = Vec::new();
        for _ in 0..200 {
            if acc.len() > 4096 {
                break;
            }
            match tokio::time::timeout(std::time::Duration::from_secs(15), ws.next()).await {
                Ok(Some(Ok(Message::Binary(b)))) => acc.extend(b),
                other => panic!("expected binary frame, got {other:?}"),
            }
        }
        assert!(acc.len() >= 4, "stream too short");
        assert_eq!(&acc[..4], &[0, 0, 0, 1], "not Annex-B H.264");

        // Inject a streamed touch gesture and a BACK key over the control socket.
        // A malformed message would make the server's ControlMessageReader throw
        // and tear the session down — so the stream STAYING ALIVE afterwards is
        // the protocol-level proof the server parsed our bytes.
        for msg in [
            r#"{"type":"touch","phase":"down","x":0.5,"y":0.5,"vw":720,"vh":1600}"#,
            r#"{"type":"touch","phase":"move","x":0.6,"y":0.5,"vw":720,"vh":1600}"#,
            r#"{"type":"touch","phase":"up","x":0.6,"y":0.5,"vw":720,"vh":1600}"#,
            r#"{"type":"key","key":"BACK"}"#,
            r#"{"type":"text","text":"hello @scrcpy!"}"#,
        ] {
            ws.send(Message::Text(msg.into())).await.expect("send ctrl");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let mut alive = 0usize;
        while alive < 2048 {
            match tokio::time::timeout(std::time::Duration::from_secs(10), ws.next()).await {
                Ok(Some(Ok(Message::Binary(b)))) => alive += b.len(),
                other => panic!("stream died after control injection: {other:?}"),
            }
        }

        // End-to-end coordinate proof: a streamed DOWN at normalized (0.25, 0.75)
        // must dispatch at exactly (0.25·dw, 0.75·dh) — scrcpy maps video→display
        // linearly, so the normalized point passes through unchanged. dumpsys
        // input logs every dispatched MotionEvent with its coordinates.
        //
        // NOTE: the claimed 720x1600 video size must equal the encoder's actual
        // video size or scrcpy silently drops the event — true for a standard
        // 1080x2400 emulator (Pixel-class AVD) under max_size=1600.
        let (dw, dh) = device_size(&serial).await.expect("wm size readable");
        let expected = format!(
            "pointers=[0: ({:.1}, {:.1})]",
            0.25 * f64::from(dw),
            0.75 * f64::from(dh)
        );
        for msg in [
            r#"{"type":"touch","phase":"down","x":0.25,"y":0.75,"vw":720,"vh":1600}"#,
            r#"{"type":"touch","phase":"up","x":0.25,"y":0.75,"vw":720,"vh":1600}"#,
        ] {
            ws.send(Message::Text(msg.into())).await.expect("send ctrl");
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let mut cmd = adb_command();
        cmd.args(["-s", &serial, "shell", "dumpsys", "input"]);
        let dump = run_to_stdout(
            tokio::process::Command::from(cmd),
            "adb dumpsys input",
            ADB_TIMEOUT_SECS,
        )
        .await
        .expect("dumpsys input");
        let landed = dump
            .lines()
            .any(|l| l.contains("action=DOWN") && l.contains(&expected));
        assert!(
            landed,
            "no dispatched DOWN at {expected} — touch did not land where claimed"
        );
        eprintln!("touch landed at {expected} ✓");

        stop_android_bridge(project).await;
    }
}
