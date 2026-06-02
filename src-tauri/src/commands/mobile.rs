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

/// Ensure a simulator is booted and return it, booting a sensible default when
/// none is running. State-aware (never double-boots) and respectful (leaves
/// any already-running simulator alone). `preferred` lets the caller pin a
/// specific device; otherwise the newest available iPhone is chosen.
#[tauri::command]
#[tracing::instrument]
pub async fn boot_default_simulator(
    project_path: String,
    preferred: Option<String>,
) -> Result<BootResult, CommandError> {
    // 1. If something is already booted, attach to it (respect the user's
    //    machine — we did NOT boot it, so we must not shut it down on close).
    let booted = list_booted_simulators().await?;
    let reuse = preferred
        .as_deref()
        .filter(|p| !p.is_empty())
        .and_then(|p| booted.iter().find(|s| s.udid == p).cloned())
        .or_else(|| booted.into_iter().next());
    if let Some(sim) = reuse {
        crate::state::register_booted_sim(project_path, sim.udid.clone(), false);
        return Ok(BootResult {
            simulator: sim,
            booted_by_us: false,
        });
    }

    // 2. Pick a device to boot.
    let target_udid = match preferred.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => p.to_string(),
        None => {
            let available = simctl_stdout(
                &["list", "devices", "available", "--json"],
                "xcrun simctl list available",
                SIMCTL_TIMEOUT_SECS,
            )
            .await?;
            choose_default_simulator(&available)
                .ok_or(
                    "No available iOS simulator to boot. Add one in Xcode › Settings › Components.",
                )?
                .udid
        }
    };

    // 3. Boot it. simctl errors if it's somehow already booted — treat that as
    //    success rather than failing the whole flow.
    let mut boot_cmd = xcrun_command();
    boot_cmd.args(["simctl", "boot", &target_udid]);
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

    // 4. Wait until the device is fully booted (deterministic, no sleeps).
    let _ = simctl_stdout(
        &["bootstatus", &target_udid, "-b"],
        "xcrun simctl bootstatus",
        BOOT_WAIT_TIMEOUT_SECS,
    )
    .await?;

    // 5. Re-read so we return accurate, now-booted device info.
    let sim = list_booted_simulators()
        .await?
        .into_iter()
        .find(|s| s.udid == target_udid)
        .ok_or("Simulator was booted but isn't reporting as booted yet.")?;
    crate::state::register_booted_sim(project_path, sim.udid.clone(), true);
    Ok(BootResult {
        simulator: sim,
        booted_by_us: true,
    })
}

/// Determine the command that launches the project's app onto a booted
/// simulator, based on the project type. Pure (well, reads project files) and
/// unit-tested; the frontend runs the returned command via the dev-server PTY
/// so it's window-scoped and streamed.
fn build_launch_command(project_path: &std::path::Path, udid: &str) -> Option<String> {
    use crate::commands::projects::{detect_project_type, is_expo_project};
    match detect_project_type(project_path) {
        crate::types::ProjectType::Flutter => Some(format!("flutter run -d {udid}")),
        crate::types::ProjectType::Reactnative => {
            // Expo apps build/launch via `expo run:ios`; bare RN via the RN CLI.
            // Both target the specific booted device by udid.
            if is_expo_project(project_path) {
                Some(format!("npx expo run:ios --device {udid}"))
            } else {
                Some(format!("npx react-native run-ios --udid {udid}"))
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

/// Shut down the simulator backing a project's mobile preview — but only if WE
/// booted it — and stop its serve-sim mirror. Called when the project closes.
/// Best-effort: a missing registration or already-shut-down device is fine.
#[tauri::command]
#[tracing::instrument]
pub async fn shutdown_simulator_for_project(project_path: String) -> Result<(), CommandError> {
    let Some(sim) = crate::state::take_booted_sim(&project_path) else {
        return Ok(());
    };
    // Stop the mirror daemon for this device regardless of who booted it.
    let mut kill = npx_command();
    kill.args(["-y", "serve-sim", "--kill", &sim.udid]);
    let _ = run_to_stdout(
        tokio::process::Command::from(kill),
        "serve-sim --kill",
        SIMCTL_TIMEOUT_SECS,
    )
    .await;
    if sim.booted_by_us {
        tracing::info!(udid = %sim.udid, "shutting down simulator we booted");
        let _ = simctl_stdout(
            &["shutdown", &sim.udid],
            "xcrun simctl shutdown",
            SIMCTL_TIMEOUT_SECS,
        )
        .await;
    }
    Ok(())
}

/// Best-effort synchronous shutdown of every simulator we booted, for the
/// window-Destroyed handler (which can't await). Spawns detached and returns.
pub fn shutdown_all_booted_sims_sync() {
    for sim in crate::state::take_all_booted_sims() {
        if sim.booted_by_us {
            let _ = std::process::Command::new("xcrun")
                .args(["simctl", "shutdown", &sim.udid])
                .env("PATH", get_extended_path())
                .spawn();
        }
    }
}

/// Start (or attach to) a serve-sim mirror for the given booted simulator.
/// Returns the stream + control-channel URLs for the frontend to embed.
#[tauri::command]
#[tracing::instrument]
pub async fn start_simulator_mirror(udid: String) -> Result<MirrorInfo, CommandError> {
    if udid.trim().is_empty() {
        return Err("A simulator UDID is required".into());
    }
    tracing::info!(%udid, "start_simulator_mirror: spawning serve-sim");
    let mut cmd = npx_command();
    cmd.args(["-y", "serve-sim", "--detach", "--quiet", &udid]);
    let stdout = run_to_stdout(
        tokio::process::Command::from(cmd),
        "serve-sim --detach",
        SERVE_SIM_TIMEOUT_SECS,
    )
    .await?;
    tracing::info!("start_simulator_mirror: serve-sim returned");
    parse_mirror_info(&stdout)
}

/// Stop the serve-sim mirror for a simulator (best-effort). Killing an
/// already-stopped mirror is not an error.
#[tauri::command]
#[tracing::instrument]
pub async fn stop_simulator_mirror(udid: String) -> Result<(), CommandError> {
    let mut cmd = npx_command();
    if udid.trim().is_empty() {
        cmd.args(["-y", "serve-sim", "--kill"]);
    } else {
        cmd.args(["-y", "serve-sim", "--kill", &udid]);
    }
    // Best-effort: ignore non-zero exit (nothing to kill is fine).
    let _ = run_to_stdout(
        tokio::process::Command::from(cmd),
        "serve-sim --kill",
        SIMCTL_TIMEOUT_SECS,
    )
    .await;
    Ok(())
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
            Some("npx expo run:ios --device UDID")
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
            Some("npx react-native run-ios --udid UDID")
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
