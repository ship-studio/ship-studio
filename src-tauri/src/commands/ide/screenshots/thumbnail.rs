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
/// Per-attempt ceiling for the Chrome/Edge CLI fallback. The virtual-time
/// budget is 3s (15s on the one retry — issue #647); the rest is browser
/// startup + page load headroom.
const BROWSER_THUMBNAIL_TIMEOUT_SECS: u64 = 60;

/// Projects with a thumbnail capture currently in flight. The 5-minute timer,
/// its retry ladder, and multiple windows can all invoke captures with no
/// coordination; without this guard each overlapping call spawned another
/// headless browser against an already-busy dev server (issue #387).
static CAPTURES_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// RAII claim on a project's capture slot — released on every exit path,
/// including timeouts and panics.
pub(super) struct CaptureClaim(String);

impl CaptureClaim {
    pub(super) fn try_new(project: &Path) -> Option<Self> {
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

/// True for Chromium stderr lines that are subsystem chatter, never a failure
/// cause: crashpad's IPC teardown races (issue #422), GoogleUpdater process
/// lifecycle, GCM push-registration retries, TensorFlow Lite delegate init,
/// and the allocator double-load warning (issues #498–#500), Windows' PDH
/// CPU-telemetry counter registration failing inside Hyper-V-backed VMs
/// (issue #807), and macOS CoreVideo's display-link probe finding no display
/// in a headless process (issue #817). A headless capture emits these freely;
/// keeping them buries the actionable line.
fn is_chromium_noise(line: &str) -> bool {
    const NOISE_MARKERS: &[&str] = &[
        "crashpad",
        "TransactNamedPipe",
        "chrome/updater/",
        "GoogleUpdater",
        "google_apis/gcm",
        "Registration response error message",
        "TensorFlow Lite",
        "XNNPACK delegate",
        "Trying to load the allocator multiple times",
        "cpu_probe_win",
        "PdhAddEnglishCounter",
        "cv_display_link_mac",
        "CVDisplayLinkCreateWithCGDisplay",
    ];
    NOISE_MARKERS.iter().any(|m| line.contains(m))
}

/// Distill headless-Chromium stderr down to the lines worth reporting:
/// drops empty and known-noise lines and caps the result. Returns `None`
/// when nothing real remains, so the caller falls back to exit code +
/// stdout — same treatment as an empty stderr.
fn browser_failure_detail(stderr: &str) -> Option<String> {
    let real: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_chromium_noise(l))
        .collect();
    if real.is_empty() {
        return None;
    }
    let joined = real.join("\n");
    if joined.chars().count() > 600 {
        let capped: String = joined.chars().take(600).collect();
        Some(format!("{capped}…"))
    } else {
        Some(joined)
    }
}

/// True for Chromium's ProcessSingleton failure: it couldn't lock the profile
/// directory it was told to use ("Failed to create ... SingletonLock: File
/// exists", "Failed to create a ProcessSingleton for your profile directory").
/// With per-capture profile dirs plus the stale sweep this should be rare —
/// but when it does happen (e.g. a crashed capture's lock surviving inside a
/// dirty profile) it's a transient environment state the next capture clears,
/// not an app malfunction (issue #644).
fn is_profile_singleton_error(stderr: &str) -> bool {
    stderr.contains("ProcessSingleton") || stderr.contains("SingletonLock")
}

/// Chromium stderr signatures naming a machine-level resource exhaustion
/// rather than anything about the page: Windows' commit limit running out
/// while the loader maps chrome.dll (ERROR_COMMITMENT_LIMIT / 0x5AF —
/// issue #812), and the throwaway GPU cache failing to write because the
/// volume is full (ERROR_DISK_FULL / 0x70 on Windows, ENOSPC elsewhere —
/// issue #784). Both are user-fixable environment states, not app
/// malfunctions, and the retry ladder can't help either — so name them
/// instead of surfacing the raw C++ log dump.
fn browser_resource_exhaustion_error(stderr: &str) -> Option<CommandError> {
    if stderr.contains("paging file is too small") || stderr.contains("(0x5AF)") {
        return Some(CommandError::expected(
            "The capture browser couldn't start because this computer is low on memory (its \
             paging file is too small or full). Close some other apps, or increase the paging \
             file size (Settings → System → About → Advanced system settings → Performance → \
             Virtual memory) — the thumbnail will be retried automatically.",
        ));
    }
    if stderr.contains("not enough space on the disk")
        || stderr.contains("(0x70)")
        || stderr.contains("No space left on device")
        || stderr.contains("ENOSPC")
    {
        return Some(CommandError::expected(
            "The capture browser couldn't write its temporary cache — this computer's disk is \
             full or nearly full. Free up some disk space and the thumbnail will be retried \
             automatically.",
        ));
    }
    None
}

/// Name the exit codes a capture browser reports when it dies with no output
/// at all: Crashpad's `kCrashExitCodeNoDump` (0xFFFF7001 — the crash server
/// never answered, so the process self-terminated after its internal wait,
/// issue #821) and Windows NTSTATUS fatal-exception codes such as
/// STATUS_ACCESS_VIOLATION (0xC0000005 — issue #705). Either way the browser
/// process itself crashed: an environment-level failure (damaged browser
/// install, graphics driver, security software), not an app malfunction.
fn browser_crash_exit_message(code: i32) -> Option<String> {
    /// Crashpad's `kCrashExitCodeNoDump`.
    const CRASHPAD_NO_DUMP: i32 = -36863;
    if code == CRASHPAD_NO_DUMP {
        return Some(
            "The capture browser crashed and self-terminated without a diagnostic dump."
                .to_string(),
        );
    }
    // NTSTATUS values with the error severity bits set (0xC0000000–0xCFFFFFFF)
    // are the crash codes Windows reports for a fatally faulting process.
    let unsigned = code as u32;
    if (0xC000_0000..=0xCFFF_FFFF).contains(&unsigned) {
        return Some(format!(
            "The capture browser crashed (Windows fatal exception 0x{unsigned:08X})."
        ));
    }
    None
}

/// Map an `image` crate failure decoding user-uploaded thumbnail bytes to an
/// actionable error. "The image format could not be determined" means the
/// magic bytes matched no decoder we ship — commonly HEIC, the default photo
/// format on macOS/iOS, plus BMP/TIFF/AVIF/ICO — a fact about the user's
/// file, not an app malfunction (issue #649). A decode failure mid-stream
/// means the file is corrupt or truncated. Both are expected user-input
/// states; only genuinely unexplained failures stay reportable.
fn humanize_image_decode_error(err: image::ImageError) -> CommandError {
    match err {
        image::ImageError::Unsupported(_) => CommandError::expected(
            "That file isn't a recognized image format. Please upload a PNG, JPEG, GIF, or \
             WEBP image — HEIC photos (the iPhone/macOS default) need converting to one of \
             those first.",
        ),
        image::ImageError::Decoding(_) => CommandError::expected(
            "That image couldn't be read — the file appears to be corrupted or truncated. \
             Try re-exporting it as PNG or JPEG, then upload again.",
        ),
        other => format!("Could not read uploaded image: {other}").into(),
    }
}

/// Returns true when the project's metadata marks the thumbnail as
/// user-supplied — auto-capture must skip these so it doesn't clobber
/// the upload on the next dev-server boot.
pub(super) fn is_thumbnail_locked(project: &Path) -> bool {
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

        // Two attempts with an escalating virtual-time budget. 3s of virtual
        // time covers a warmed dev server; a route compiling on first request
        // (slow Windows machines especially) can exhaust it before the page
        // ever paints — the browser then exits 0 without writing any file
        // (issue #526). That shape is detectable, so retry it once with a
        // much longer budget before giving up (issue #647).
        let mut capture_written;
        let budgets = [3000u32, 15000u32];
        let last_attempt = budgets.len() - 1;
        let mut attempt = 0;
        let output = loop {
            let budget_ms = budgets[attempt];
            let profile_dir = shipstudio_dir.join(format!(
                "thumbnail_profile_{}_{}",
                std::process::id(),
                PROFILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let user_data_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());
            let virtual_time_arg = format!("--virtual-time-budget={budget_ms}");

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
                // A disposable one-shot capture has no business phoning home:
                // background networking spins up GoogleUpdater/GCM machinery
                // whose log spew drowned real failure signals (issues #498–#500).
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                "--default-background-color=FFFFFFFF",
                "--window-position=0,0",
                "--window-size=1280,800",
                &virtual_time_arg,
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
            // On timeout the killed browser can leave it half-written — the
            // stale sweep above mops those up on later captures.
            let _ = std::fs::remove_dir_all(&profile_dir);
            let out = result?;

            // Success is "the screenshot file exists", not "the exit code was
            // 0": headless Chromium on Windows can write the PNG and still
            // exit non-zero over unrelated internal warnings, and failing on
            // the exit code alone throws away a perfectly good capture
            // (issue #374).
            capture_written = std::fs::metadata(&temp_path)
                .map(|m| m.len() > 0)
                .unwrap_or(false);

            let silent_success_without_file = out.status.success() && !capture_written;
            if !silent_success_without_file || attempt == last_attempt {
                break out;
            }
            attempt += 1;
            tracing::warn!(
                "Browser exited 0 without writing {} — retrying with a longer virtual-time budget (issue #647)",
                temp_path.display()
            );
        };

        if capture_written && !output.status.success() {
            tracing::warn!(
                "Browser exited with {:?} but wrote the screenshot; proceeding",
                output.status.code()
            );
        }

        if !capture_written {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Chrome refusing to start because it couldn't lock the profile
            // dir (stale SingletonLock from a crashed capture, or an
            // overlapping capture racing on the same profile) is a transient
            // environment state the per-capture dirs + stale sweep clear on
            // the next run — expected, not telemetry (issue #644).
            if is_profile_singleton_error(&stderr) {
                return Err(CommandError::expected(
                    "The capture browser couldn't lock its temporary profile directory \
                     (a leftover lock from an interrupted capture). Stale profiles are \
                     cleaned up automatically — the next capture attempt should succeed.",
                ));
            }
            // The machine running out of memory or disk mid-capture is an
            // environment condition with a user-side fix — name it instead of
            // dumping Chromium's raw loader/cache log line (issues #812/#784).
            if let Some(err) = browser_resource_exhaustion_error(&stderr) {
                return Err(err);
            }
            // Headless Chromium can die with EMPTY stderr (crash, killed by
            // AV/security software) — fall back to the exit code plus a
            // stdout snippet so the report says something (issue #291).
            // Known-noise subsystem lines (crashpad, GoogleUpdater, GCM…)
            // aren't a cause either — filter per line so the one real signal
            // survives instead of drowning in them (issues #422, #498–#500).
            let detail = match browser_failure_detail(stderr.trim()) {
                Some(detail) => {
                    // macOS refusing the browser's Mach IPC registration is a
                    // distinct environment-level failure class (sandboxing /
                    // security / MDM software) — name it instead of passing
                    // the raw mojo log line through (issues #499, #500).
                    if detail.contains("bootstrap_check_in") && detail.contains("Permission denied")
                    {
                        "macOS refused the browser's IPC registration (bootstrap_check_in: \
                         Permission denied). This is usually caused by security or \
                         device-management software restricting processes spawned by Ship Studio."
                            .to_string()
                    } else {
                        detail
                    }
                }
                None => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stdout = stdout.trim();
                    let code = output
                        .status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "killed by signal".to_string());
                    if output.status.success() && stdout.is_empty() {
                        // Exit 0 + silence + no file, even after the
                        // longer-budget retry above: the page didn't render in
                        // time (dev server still compiling the route) or
                        // security software blocked the file write
                        // (issues #526/#647). A recurring environment
                        // condition, not an app malfunction — the capture
                        // timer will simply try again later.
                        return Err(CommandError::expected(format!(
                            "The capture browser finished without writing a screenshot at {} — \
                             the page probably didn't render in time (the dev server may still \
                             be compiling), or security software blocked the file write. The \
                             thumbnail will be retried automatically.",
                            temp_path.display()
                        )));
                    } else if stdout.is_empty() {
                        // A hard crash exits with a nameable code and writes
                        // nothing at all. Say what happened instead of the
                        // bare number, and treat it as the environment-level
                        // failure it is (issues #705/#821).
                        if let Some(crash) =
                            output.status.code().and_then(browser_crash_exit_message)
                        {
                            return Err(CommandError::expected(format!(
                                "{crash} This is usually a graphics driver, security software, \
                                 or a damaged browser install interfering with headless capture \
                                 — the thumbnail will be retried automatically."
                            )));
                        }
                        format!("exit code {code}, no output")
                    } else {
                        let snippet: String = stdout.chars().take(300).collect();
                        format!("exit code {code}: {snippet}")
                    }
                }
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
        // classify_fs_error: labels the op/path and turns environment denials
        // (TCC, Windows access-denied) into Expected (issues #596, #625).
        let data = std::fs::read(&thumbnail_path).map_err(|e| {
            crate::utils::classify_fs_error("read this project's thumbnail", &thumbnail_path, &e)
        })?;
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
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| {
            crate::utils::classify_fs_error(
                "create this project's .shipstudio folder",
                &shipstudio_dir,
                &e,
            )
        })?;
    }

    // Decode through the `image` crate — gives us format detection + a
    // hard reject for non-image input. Then re-encode as PNG at the same
    // 640px width as the auto-capture path so the dashboard renders
    // consistently regardless of source. Unrecognized/corrupt input gets a
    // human message naming the supported formats instead of the crate's raw
    // "format could not be determined" (issue #649).
    let img = image::load_from_memory(&image_data).map_err(humanize_image_decode_error)?;
    let resized = img.resize(640, 400, image::imageops::FilterType::Lanczos3);

    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    // `save` wraps the underlying io::Error, so unwrap it and route through
    // classify_fs_error like every other fs step here — macOS TCC denials
    // (EPERM) and Windows access-denied are environment states with a
    // user-side fix, not app malfunctions (issue #768).
    resized.save(&thumbnail_path).map_err(|e| match e {
        image::ImageError::IoError(io) => {
            crate::utils::classify_fs_error("save this project's thumbnail", &thumbnail_path, &io)
        }
        other => format!("Failed to save thumbnail: {other}").into(),
    })?;

    // Mark the metadata so capture_project_thumbnail no-ops next time.
    // Reads-then-writes the whole file rather than calling the
    // sibling tauri command directly so we stay synchronous on disk.
    let metadata_path = shipstudio_dir.join("project.json");
    let mut metadata: ProjectMetadata = if metadata_path.exists() {
        let contents = std::fs::read_to_string(&metadata_path).map_err(|e| {
            crate::utils::classify_fs_error("read project metadata", &metadata_path, &e)
        })?;
        let mut existing: ProjectMetadata = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse project metadata: {e}"))?;
        existing.migrate();
        existing
    } else {
        ProjectMetadata::default()
    };
    metadata.custom_thumbnail = Some(true);
    metadata.schema_version = PROJECT_METADATA_SCHEMA_VERSION;
    // classify_fs_error routing: TCC/access-denied/read-only failures
    // classify Expected instead of paging telemetry (issue #625).
    crate::commands::projects::save_project_metadata(&project, &metadata)?;

    let bytes = std::fs::read(&thumbnail_path).map_err(|e| {
        crate::utils::classify_fs_error("read this project's thumbnail", &thumbnail_path, &e)
    })?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{base64_data}"))
}

#[cfg(test)]
mod browser_stderr_tests {
    use super::*;

    #[test]
    fn crashpad_only_stderr_is_treated_as_empty() {
        let stderr = "[1:2:0803] ERROR:crashpad_client_win.cc(123)] something\n\
                      TransactNamedPipe: The pipe has been ended. (0x6D)";
        assert_eq!(browser_failure_detail(stderr), None);
    }

    #[test]
    fn real_signal_survives_macos_updater_and_gcm_noise() {
        // Condensed from the real report behind issues #498–#500.
        let stderr = "[78255:16006070:0803] ERROR:mojo/public/cpp/platform/named_platform_channel_mac.cc:44] bootstrap_check_in com.google.Chrome.apps.156F: Permission denied (1100)\n\
            Trying to load the allocator multiple times. This is *not* supported.\n\
            [78300:1:0803] ERROR:google_apis/gcm/engine/registration_request.cc(291)] Registration response error message: PHONE_REGISTRATION_ERROR\n\
            Created TensorFlow Lite XNNPACK delegate for CPU.\n\
            [78310:1:0803] chrome/updater/updater.cc(93)] starting GoogleUpdater wake-all";
        let detail = browser_failure_detail(stderr).expect("bootstrap line must survive");
        assert!(detail.contains("bootstrap_check_in"));
        assert!(!detail.contains("GoogleUpdater"));
        assert!(!detail.contains("PHONE_REGISTRATION_ERROR"));
        assert!(!detail.contains("XNNPACK"));
    }

    #[test]
    fn empty_and_whitespace_stderr_yield_none() {
        assert_eq!(browser_failure_detail(""), None);
        assert_eq!(browser_failure_detail("  \n\t\n"), None);
    }

    #[test]
    fn genuine_multiline_stderr_is_preserved() {
        let stderr = "line one: something broke\nline two: more detail";
        assert_eq!(browser_failure_detail(stderr).as_deref(), Some(stderr));
    }

    #[test]
    fn oversized_detail_is_capped() {
        let stderr = "x".repeat(2000);
        let detail = browser_failure_detail(&stderr).unwrap();
        assert!(detail.chars().count() <= 601);
        assert!(detail.ends_with('…'));
    }
}

#[cfg(test)]
mod singleton_classification_tests {
    use super::*;

    #[test]
    fn stale_singleton_lock_stderr_is_recognized() {
        // Condensed from the real report behind issue #644.
        let stderr = "[0810/163833.123:ERROR:chrome/browser/process_singleton_posix.cc:347] Failed to create /Users/x/ShipStudio/p/.shipstudio/thumbnail_profile/SingletonLock: File exists (17)\n\
            [0810/163833.456:ERROR:chrome/app/chrome_main_delegate.cc:520] Failed to create a ProcessSingleton for your profile directory.";
        assert!(is_profile_singleton_error(stderr));
    }

    #[test]
    fn unrelated_stderr_is_not_a_singleton_error() {
        assert!(!is_profile_singleton_error(""));
        assert!(!is_profile_singleton_error(
            "ERROR:gpu_init.cc(523)] Passthrough is not supported"
        ));
    }
}

#[cfg(test)]
mod browser_environment_tests {
    use super::*;

    #[test]
    fn pagefile_exhaustion_is_expected_with_memory_guidance() {
        // Condensed from the real report behind issue #812.
        let stderr = "[0825/123326.200:ERROR:chrome\\app\\main_dll_loader_win.cc:208] Failed to \
            load Chrome DLL from C:\\Program Files\\Google\\Chrome\\Application\\151.0.7922.174\\chrome.dll: \
            The paging file is too small for this operation to complete. (0x5AF)";
        match browser_resource_exhaustion_error(stderr).expect("must classify") {
            CommandError::Expected { message } => {
                assert!(message.contains("low on memory"), "got: {message}");
                assert!(message.contains("paging file"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn disk_full_gpu_cache_failure_is_expected_with_disk_guidance() {
        // Condensed from the real report behind issue #784.
        let stderr = "[29376:25724:0820/180957.319:ERROR:components\\viz\\host\\persistent_cache_sandboxed_file_factory.cc:83] \
            Failed to create cache directory: C:\\Users\\x\\ShipStudio\\p\\.shipstudio\\thumbnail_profile_1\\GPUPersistentCache: \
            There is not enough space on the disk. (0x70)";
        match browser_resource_exhaustion_error(stderr).expect("must classify") {
            CommandError::Expected { message } => {
                assert!(message.contains("disk is full"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn posix_enospc_is_also_classified_disk_full() {
        assert!(browser_resource_exhaustion_error(
            "ERROR:disk_cache.cc(91)] write failed: No space left on device"
        )
        .is_some());
    }

    #[test]
    fn unrelated_stderr_is_not_resource_exhaustion() {
        assert!(browser_resource_exhaustion_error("").is_none());
        assert!(browser_resource_exhaustion_error(
            "ERROR:gpu_init.cc(523)] Passthrough is not supported"
        )
        .is_none());
    }

    #[test]
    fn benign_pdh_and_display_link_lines_are_filtered_as_noise() {
        // Issues #807 / #817: unrelated Chromium subsystems logging to stderr
        // must never become the reported failure cause.
        let stderr = "[4044:40428:0824/184726.367:ERROR:components\\system_cpu\\cpu_probe_win.cc:112] \
            PdhAddEnglishCounter failed for '\\Hyper-V Hypervisor Logical Processor(_Total)\\% Total Run Time': \
            Error (0x13D) while retrieving error. (0xC0000BC8)\n\
            [1:2:0824/184726.368:ERROR:media/base/mac/cv_display_link_mac.cc:64] CVDisplayLinkCreateWithCGDisplay failed";
        assert_eq!(browser_failure_detail(stderr), None);
    }

    #[test]
    fn crashpad_no_dump_exit_code_is_named() {
        // Issue #821: 0xFFFF7001 is Crashpad's kCrashExitCodeNoDump.
        let message = browser_crash_exit_message(-36863).expect("must be named");
        assert!(message.contains("crashed"), "got: {message}");
        assert!(
            message.contains("without a diagnostic dump"),
            "got: {message}"
        );
    }

    #[test]
    fn windows_ntstatus_crash_codes_are_named() {
        // Issue #705: the reported -1073741205 plus the canonical
        // STATUS_ACCESS_VIOLATION both live in the NTSTATUS error range.
        for code in [-1073741205, 0xC000_0005u32 as i32] {
            let message = browser_crash_exit_message(code)
                .unwrap_or_else(|| panic!("{code} must be named as a crash"));
            assert!(message.contains("crashed"), "got: {message}");
        }
    }

    #[test]
    fn ordinary_exit_codes_are_not_treated_as_crashes() {
        assert_eq!(browser_crash_exit_message(1), None);
        assert_eq!(browser_crash_exit_message(21), None);
        assert_eq!(browser_crash_exit_message(-1), None);
    }
}

#[cfg(test)]
mod upload_decode_error_tests {
    use super::*;

    #[test]
    fn unrecognized_format_is_expected_and_names_supported_formats() {
        // Bytes matching no decoder's magic signature — the shape a HEIC
        // upload produces (issue #649).
        let err = image::load_from_memory(&[0u8; 32]).expect_err("garbage must not decode");
        match humanize_image_decode_error(err) {
            CommandError::Expected { message } => {
                for fmt in ["PNG", "JPEG", "GIF", "WEBP"] {
                    assert!(message.contains(fmt), "missing {fmt} in: {message}");
                }
                assert!(message.contains("HEIC"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn truncated_png_is_expected_corruption_message() {
        // Valid PNG magic, garbage after — recognized format, broken file.
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0u8; 16]);
        let err = image::load_from_memory(&bytes).expect_err("truncated png must not decode");
        match humanize_image_decode_error(err) {
            CommandError::Expected { message } => {
                assert!(message.contains("corrupted or truncated"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }
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
