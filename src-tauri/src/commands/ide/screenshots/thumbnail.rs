//! Project thumbnail capture and retrieval.

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION};
use crate::utils::{create_command, validate_project_path};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use super::node_tool_command;
use crate::commands::ide::{find_chromium_browser, resize_thumbnail_image};

/// Ceiling for the `npx playwright screenshot` path. Generous — npx may fetch
/// the package on first use and a dev server mid-compile is slow — but bounded:
/// this used to be an untimed blocking `.output()` inside an async command, so
/// a hung capture pinned a tokio worker thread forever. A few of those (multiple
/// projects on the 5-minute capture timer, dev servers busy under the user's own
/// Playwright runs) starved the runtime and froze every IPC call in the app
/// (issue #387).
const PLAYWRIGHT_THUMBNAIL_TIMEOUT_SECS: u64 = 120;
/// Ceiling for the Chrome/Edge CLI fallback. Its virtual-time budget is 3s;
/// the rest is browser startup + page load headroom.
const BROWSER_THUMBNAIL_TIMEOUT_SECS: u64 = 60;

/// Projects with a thumbnail capture currently in flight. The 5-minute timer,
/// its retry ladder, and multiple windows can all invoke captures with no
/// coordination; without this guard each overlapping call spawned another
/// headless browser against an already-busy dev server (issue #387).
static CAPTURES_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// RAII claim on a project's capture slot — released on every exit path,
/// including timeouts and panics.
struct CaptureClaim(String);

impl CaptureClaim {
    fn try_new(project: &Path) -> Option<Self> {
        let key = project.to_string_lossy().to_string();
        let mut in_flight = CAPTURES_IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        in_flight.insert(key.clone()).then(|| Self(key))
    }
}

impl Drop for CaptureClaim {
    fn drop(&mut self) {
        CAPTURES_IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// Best-effort cleanup of thumbnail Chromium profiles left behind by earlier
/// captures that never reached their own cleanup (app quit, crash, kill).
/// Removes the legacy fixed `thumbnail_profile` dir unconditionally — nothing
/// uses that path anymore, and a stale SingletonLock inside it permanently
/// broke every capture (issue #358) — plus any per-capture
/// `thumbnail_profile_*` dir older than an hour. The age gate keeps this from
/// yanking a profile out from under a concurrent capture, which only lives
/// for seconds.
fn sweep_stale_thumbnail_profiles(shipstudio_dir: &Path) {
    let _ = std::fs::remove_dir_all(shipstudio_dir.join("thumbnail_profile"));
    let Ok(entries) = std::fs::read_dir(shipstudio_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("thumbnail_profile_") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(60 * 60));
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Returns true when the project's metadata marks the thumbnail as
/// user-supplied — auto-capture must skip these so it doesn't clobber
/// the upload on the next dev-server boot.
fn is_thumbnail_locked(project: &Path) -> bool {
    let metadata_path = project.join(".shipstudio").join("project.json");
    let Ok(contents) = std::fs::read_to_string(&metadata_path) else {
        return false;
    };
    let Ok(metadata) = serde_json::from_str::<ProjectMetadata>(&contents) else {
        return false;
    };
    metadata.custom_thumbnail.unwrap_or(false)
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn capture_project_thumbnail(
    project_path: String,
    url: String,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;

    // One capture per project at a time. Expected, not an error state: the
    // previous capture is still running and the timer will simply try again.
    let Some(_claim) = CaptureClaim::try_new(&project) else {
        return Err(CommandError::expected(
            "A thumbnail capture for this project is already in progress",
        ));
    };

    // Skip capture entirely when the user has uploaded a custom thumbnail.
    // Returns the existing thumbnail path so the caller still treats the
    // call as success (the user's image stays put).
    if is_thumbnail_locked(&project) {
        let thumbnail_path = project.join(".shipstudio").join("thumbnail.png");
        tracing::info!("Skipping auto-capture; custom thumbnail in place");
        return Ok(thumbnail_path.to_string_lossy().to_string());
    }

    // Quick health check: verify the dev server is still responding before launching Playwright.
    // This reduces (but doesn't eliminate) race conditions where the server dies mid-capture.
    if !super::dev_server_listening(&url) {
        tracing::warn!("Dev server health check failed for {}", url);
        return Err(("Dev server not responding, skipping thumbnail capture".to_string()).into());
    }

    let shipstudio_dir = project.join(".shipstudio");

    // Ensure .shipstudio directory exists
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| e.to_string())?;
    }

    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    let thumbnail_path_str = thumbnail_path.to_string_lossy().to_string();

    // Try using Playwright first (more reliable viewport control)
    let mut npx_cmd = node_tool_command("npx");
    npx_cmd
        .args([
            "playwright",
            "screenshot",
            "--viewport-size=1280,800",
            "--wait-for-timeout=2000",
            &url,
            &thumbnail_path_str,
        ])
        .current_dir(&project);
    let npx_result = run_with_timeout(
        tokio::process::Command::from(npx_cmd),
        "npx playwright screenshot",
        PLAYWRIGHT_THUMBNAIL_TIMEOUT_SECS,
    )
    .await;

    match npx_result {
        Ok(output) if output.status.success() && thumbnail_path.exists() => {
            // Resize to thumbnail width using image crate (cross-platform)
            resize_thumbnail_image(&thumbnail_path, 640);
            return Ok(thumbnail_path_str);
        }
        Err(e) => {
            // Timeout or spawn failure — fall through to the Chrome fallback,
            // which has its own (shorter) budget.
            tracing::warn!("Playwright thumbnail path failed, trying browser fallback: {e}");
        }
        Ok(_) => {}
    }

    // Fall back to Chrome/Edge CLI if Playwright not available
    let browser_exe = find_chromium_browser();

    if let Some(browser) = browser_exe {
        // Use a temp file for raw capture, then process
        let temp_path = shipstudio_dir.join("thumbnail_raw.png");
        let temp_path_str = temp_path.to_string_lossy().to_string();
        let screenshot_arg = format!("--screenshot={temp_path_str}");

        // An isolated profile dir is required, not an optimization: since the
        // headless/headful merge, `--headless=new` on the default profile
        // shares the singleton lock with any already-running instance of the
        // same browser and instantly exits with code 21 — a developer's normal
        // browser being open silently killed every thumbnail (issue #335).
        //
        // The dir must also be unique per capture: a fixed path recreates the
        // same singleton collision between two overlapping captures, and a
        // capture interrupted before cleanup leaves a stale SingletonLock that
        // blocks every subsequent capture forever (issue #358 and its many
        // duplicates). PID + a process-wide counter is collision-free across
        // both concurrent captures and app restarts into a dirty .shipstudio.
        static PROFILE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        sweep_stale_thumbnail_profiles(&shipstudio_dir);
        let profile_dir = shipstudio_dir.join(format!(
            "thumbnail_profile_{}_{}",
            std::process::id(),
            PROFILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let user_data_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());

        // Use new headless mode with explicit viewport control
        // Set background to white so any extra captured area isn't black
        let mut browser_cmd = create_command(&browser);
        browser_cmd.args([
            "--headless=new",
            &user_data_arg,
            "--no-first-run",
            "--disable-gpu",
            "--no-sandbox",
            // A one-shot throwaway capture gains nothing from Chromium's
            // crash reporter, and spinning up a crashpad_handler per capture
            // added a whole extra failure mode: its named-pipe handshake can
            // lose a race with process teardown/AV and kill the capture with
            // "TransactNamedPipe: The pipe has been ended" (issue #421).
            "--disable-crash-reporter",
            "--disable-breakpad",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--default-background-color=FFFFFFFF",
            "--window-position=0,0",
            "--window-size=1280,800",
            "--virtual-time-budget=3000",
            &screenshot_arg,
            &url,
        ]);
        let result = run_with_timeout(
            tokio::process::Command::from(browser_cmd),
            "headless browser thumbnail",
            BROWSER_THUMBNAIL_TIMEOUT_SECS,
        )
        .await;

        // The throwaway profile has served its purpose; don't let it grow.
        // On timeout the killed browser can leave it half-written — the stale
        // sweep above mops those up on later captures.
        let _ = std::fs::remove_dir_all(&profile_dir);
        let output = result?;

        // Success is "the screenshot file exists", not "the exit code was 0":
        // headless Chromium on Windows can write the PNG and still exit
        // non-zero over unrelated internal warnings, and failing on the exit
        // code alone throws away a perfectly good capture (issue #374).
        let capture_written = std::fs::metadata(&temp_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);

        if capture_written && !output.status.success() {
            tracing::warn!(
                "Browser exited with {:?} but wrote the screenshot; proceeding",
                output.status.code()
            );
        }

        if !capture_written {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            // Headless Chromium can die with EMPTY stderr (crash, killed by
            // AV/security software) — fall back to the exit code plus a
            // stdout snippet so the report says something (issue #291).
            // Crashpad/registration-protocol log lines aren't a cause — they
            // just say the crash reporter's IPC pipe died along with the
            // browser process. Treat a stderr made of only that noise like an
            // empty stderr so the report carries the exit code + stdout
            // snippet instead (issue #422).
            let is_crashpad_noise =
                |line: &str| line.contains("crashpad") || line.contains("TransactNamedPipe");
            let has_real_stderr = stderr.lines().any(|l| {
                let l = l.trim();
                !l.is_empty() && !is_crashpad_noise(l)
            });
            let detail = if stderr.is_empty() || !has_real_stderr {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stdout = stdout.trim();
                let code = output
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "killed by signal".to_string());
                if stdout.is_empty() {
                    format!("exit code {code}, no output")
                } else {
                    let snippet: String = stdout.chars().take(300).collect();
                    format!("exit code {code}: {snippet}")
                }
            } else {
                stderr.to_string()
            };
            return Err((format!("Browser screenshot failed: {detail}")).into());
        }

        // Read the captured image and resize using the image crate (cross-platform)
        if let Ok(img) = image::open(&temp_path) {
            let (width_val, height_val) = (img.width(), img.height());

            // If captured at 2x (Retina) or oversized, resize to 1280 width first
            let processed = if width_val > 1280 || height_val > 800 {
                img.resize(1280, 800, image::imageops::FilterType::Lanczos3)
            } else {
                img
            };

            // Save as thumbnail at 640px width
            let thumb = processed.resize(640, 400, image::imageops::FilterType::Lanczos3);
            let _ = thumb.save(&thumbnail_path);
        } else {
            // If image crate can't read it, just copy as-is
            let _ = std::fs::copy(&temp_path, &thumbnail_path);
        }
        // Clean up temp file
        let _ = std::fs::remove_file(&temp_path);

        Ok(thumbnail_path_str)
    } else {
        // Expected: a machine without a Chromium-based browser is an
        // environment gap, not a malfunction — not telemetry.
        Err(CommandError::expected(
            "No supported browser found for screenshots (a Chromium-based browser is required: Chrome, Chromium, Edge, Brave, or Arc)",
        ))
    }
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_thumbnail(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let thumbnail_path = project.join(".shipstudio").join("thumbnail.png");

    if thumbnail_path.exists() {
        // Return as base64 data URL for easy display
        use base64::Engine;
        let data = std::fs::read(&thumbnail_path).map_err(|e| e.to_string())?;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok(Some(format!("data:image/png;base64,{base64_data}")))
    } else {
        Ok(None)
    }
}

/// Save a user-supplied image as the project's thumbnail and lock
/// auto-capture so subsequent dev-server-driven captures don't overwrite
/// it. Returns the new thumbnail as a base64 data URL so the dashboard
/// can refresh without a second round-trip.
#[tauri::command]
#[tracing::instrument(skip(image_data), fields(project = %project_path, bytes = image_data.len()))]
pub async fn upload_project_thumbnail(
    project_path: String,
    image_data: Vec<u8>,
) -> Result<String, CommandError> {
    use base64::Engine;

    if image_data.is_empty() {
        return Err("Empty image upload".to_string().into());
    }

    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    // Decode through the `image` crate — gives us format detection + a
    // hard reject for non-image input. Then re-encode as PNG at the same
    // 640px width as the auto-capture path so the dashboard renders
    // consistently regardless of source.
    let img = image::load_from_memory(&image_data)
        .map_err(|e| format!("Could not read uploaded image: {e}"))?;
    let resized = img.resize(640, 400, image::imageops::FilterType::Lanczos3);

    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    resized
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {e}"))?;

    // Mark the metadata so capture_project_thumbnail no-ops next time.
    // Reads-then-writes the whole file rather than calling the
    // sibling tauri command directly so we stay synchronous on disk.
    let metadata_path = shipstudio_dir.join("project.json");
    let mut metadata: ProjectMetadata = if metadata_path.exists() {
        let contents = std::fs::read_to_string(&metadata_path)
            .map_err(|e| format!("Failed to read project metadata: {e}"))?;
        let mut existing: ProjectMetadata = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse project metadata: {e}"))?;
        existing.migrate();
        existing
    } else {
        ProjectMetadata::default()
    };
    metadata.custom_thumbnail = Some(true);
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;
    let serialized = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, serialized)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    let bytes = std::fs::read(&thumbnail_path).map_err(|e| e.to_string())?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{base64_data}"))
}

#[cfg(test)]
mod capture_claim_tests {
    use super::*;

    #[test]
    fn second_claim_for_same_project_is_rejected_until_first_drops() {
        let project = Path::new("/tmp/shipstudio-claim-test-project");
        let first = CaptureClaim::try_new(project);
        assert!(first.is_some(), "first claim should succeed");
        assert!(
            CaptureClaim::try_new(project).is_none(),
            "overlapping claim must be rejected while the first is alive"
        );
        drop(first);
        assert!(
            CaptureClaim::try_new(project).is_some(),
            "slot must be released when the claim drops"
        );
    }

    #[test]
    fn claims_for_different_projects_are_independent() {
        let _a = CaptureClaim::try_new(Path::new("/tmp/shipstudio-claim-test-a")).unwrap();
        assert!(CaptureClaim::try_new(Path::new("/tmp/shipstudio-claim-test-b")).is_some());
    }
}
