//! Project thumbnail capture and retrieval.

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, PROJECT_METADATA_SCHEMA_VERSION};
use crate::utils::{create_command, validate_project_path};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use crate::commands::ide::{find_chromium_browser, resize_thumbnail_image};

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
    // Extract port from URL (e.g., "http://localhost:3000" -> 3000)
    let port: u16 = url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split(':')
        .next_back()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    // Try both IPv4 and IPv6 - some dev servers (especially Vite) may only bind to IPv6
    let ipv4_addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let ipv6_addr = std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)); // ::1

    let ipv4_ok = TcpStream::connect_timeout(&ipv4_addr, Duration::from_millis(500)).is_ok();
    let ipv6_ok = TcpStream::connect_timeout(&ipv6_addr, Duration::from_millis(500)).is_ok();

    if !ipv4_ok && !ipv6_ok {
        tracing::warn!(
            "Dev server health check failed on both IPv4 and IPv6 for port {}",
            port
        );
        return Err(("Dev server not responding, skipping thumbnail capture".to_string()).into());
    }
    tracing::info!(
        "Dev server health check passed (IPv4: {}, IPv6: {}) on port {}",
        ipv4_ok,
        ipv6_ok,
        port
    );

    let shipstudio_dir = project.join(".shipstudio");

    // Ensure .shipstudio directory exists
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| e.to_string())?;
    }

    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    let thumbnail_path_str = thumbnail_path.to_string_lossy().to_string();

    // Try using Playwright first (more reliable viewport control)
    let npx_result = create_command("npx")
        .args([
            "playwright",
            "screenshot",
            "--viewport-size=1280,800",
            "--wait-for-timeout=2000",
            &url,
            &thumbnail_path_str,
        ])
        .current_dir(&project)
        .output();

    if let Ok(output) = npx_result {
        if output.status.success() && thumbnail_path.exists() {
            // Resize to thumbnail width using image crate (cross-platform)
            resize_thumbnail_image(&thumbnail_path, 640);
            return Ok(thumbnail_path_str);
        }
    }

    // Fall back to Chrome/Edge CLI if Playwright not available
    let browser_exe = find_chromium_browser();

    if let Some(browser) = browser_exe {
        // Use a temp file for raw capture, then process
        let temp_path = shipstudio_dir.join("thumbnail_raw.png");
        let temp_path_str = temp_path.to_string_lossy().to_string();
        let screenshot_arg = format!("--screenshot={temp_path_str}");

        // Use new headless mode with explicit viewport control
        // Set background to white so any extra captured area isn't black
        let output = create_command(&browser)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                "--default-background-color=FFFFFFFF",
                "--window-position=0,0",
                "--window-size=1280,800",
                "--virtual-time-budget=3000",
                &screenshot_arg,
                &url,
            ])
            .output()
            .map_err(|e| format!("Failed to run browser: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err((format!("Browser screenshot failed: {stderr}")).into());
        }

        // Read the captured image and resize using the image crate (cross-platform)
        if temp_path.exists() {
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
        }

        Ok(thumbnail_path_str)
    } else {
        Err(
            "No supported browser found for screenshots (Chrome, Chromium, or Edge required)"
                .to_string()
                .into(),
        )
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
