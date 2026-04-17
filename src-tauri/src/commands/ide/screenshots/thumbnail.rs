//! Project thumbnail capture and retrieval.

use crate::errors::CommandError;
use crate::utils::{create_command, validate_project_path};
use std::net::TcpStream;
use std::time::Duration;

use crate::commands::ide::{find_chromium_browser, resize_thumbnail_image};

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn capture_project_thumbnail(
    project_path: String,
    url: String,
) -> Result<String, CommandError> {
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

    let project = validate_project_path(&project_path)?;
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
