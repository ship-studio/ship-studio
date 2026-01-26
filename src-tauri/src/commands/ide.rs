//! # IDE and Webview Commands
//!
//! Commands for IDE integration, preview webviews, and screenshots.

use crate::types::IdeAvailability;
use crate::utils::validate_project_path;
use std::process::Command;
use std::sync::Mutex;
use tauri::{Manager, Webview, WebviewUrl};

/// Tracks whether a preview webview currently exists
static PREVIEW_WEBVIEW_EXISTS: Mutex<bool> = Mutex::new(false);

#[tauri::command]
pub async fn check_ide_availability() -> IdeAvailability {
    #[cfg(target_os = "macos")]
    {
        // Check if apps exist in /Applications
        let vscode = std::path::Path::new("/Applications/Visual Studio Code.app").exists();
        let cursor = std::path::Path::new("/Applications/Cursor.app").exists();
        IdeAvailability { vscode, cursor }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Check if commands are in PATH
        let vscode = which::which("code").is_ok();
        let cursor = which::which("cursor").is_ok();
        IdeAvailability { vscode, cursor }
    }
}

#[tauri::command]
pub async fn open_in_ide(project_path: String, ide: String) -> Result<(), String> {
    let validated_path = validate_project_path(&project_path)?;
    let path_str = validated_path.to_string_lossy();

    #[cfg(target_os = "macos")]
    {
        let app_name = match ide.as_str() {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            _ => return Err(format!("Unknown IDE: {}", ide)),
        };

        // Use 'open -a' on macOS which is more reliable
        Command::new("open")
            .args(["-a", app_name, path_str.as_ref()])
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", ide, e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let cmd = match ide.as_str() {
            "vscode" => "code",
            "cursor" => "cursor",
            _ => return Err(format!("Unknown IDE: {}", ide)),
        };

        Command::new(cmd)
            .arg(path_str.as_ref())
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", ide, e))?;
    }

    Ok(())
}

/// Creates a native child webview at the specified position.
/// Used for Sanity Studio to support OAuth authentication.
/// Only one preview webview can exist at a time.
#[tauri::command]
pub async fn create_preview_webview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    // Access the underlying Window through the Webview
    let webview_ref: &Webview<tauri::Wry> = webview_window.as_ref();
    let window = webview_ref.window();

    // Check if webview already exists
    let mut exists = PREVIEW_WEBVIEW_EXISTS
        .lock()
        .map_err(|e| format!("Failed to acquire webview lock: {}", e))?;
    if *exists {
        // Just navigate the existing webview
        if let Some(webview) = app.get_webview("preview") {
            let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
            webview.navigate(parsed_url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Create the preview webview
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new("preview", WebviewUrl::External(parsed_url))
        .auto_resize();

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    *exists = true;
    Ok(())
}

#[tauri::command]
pub async fn navigate_preview_webview(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview") {
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_preview_webview(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview("preview") {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn destroy_preview_webview(app: tauri::AppHandle) -> Result<(), String> {
    let mut exists = PREVIEW_WEBVIEW_EXISTS
        .lock()
        .map_err(|e| format!("Failed to acquire webview lock: {}", e))?;
    if let Some(webview) = app.get_webview("preview") {
        webview.close().map_err(|e| e.to_string())?;
        *exists = false;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_studio_window(
    app: tauri::AppHandle,
    url: String,
    title: String,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    // Check if studio window already exists
    if let Some(window) = app.get_webview_window("studio") {
        // Focus existing window and navigate to URL
        window.set_focus().map_err(|e| e.to_string())?;
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        window.navigate(parsed_url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new studio window
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    WebviewWindowBuilder::new(&app, "studio", WebviewUrl::External(parsed_url))
        .title(&title)
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create studio window: {}", e))?;

    Ok(())
}

/// Crop an image and save it to the project's screenshots folder
/// Takes the source image path, crop bounds (x, y, width, height), and returns the saved path
#[tauri::command]
pub async fn crop_and_save_screenshot(
    project_path: String,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("screenshot-{}.png", timestamp));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Load the source image
    let img = image::open(&source_path).map_err(|e| format!("Failed to open image: {}", e))?;

    // Crop the image (ensure bounds are within image dimensions)
    let img_width = img.width();
    let img_height = img.height();

    let crop_x = x.min(img_width.saturating_sub(1));
    let crop_y = y.min(img_height.saturating_sub(1));
    let crop_width = width.min(img_width.saturating_sub(crop_x));
    let crop_height = height.min(img_height.saturating_sub(crop_y));

    let cropped = img.crop_imm(crop_x, crop_y, crop_width, crop_height);

    // Save the cropped image
    cropped
        .save(&screenshot_path)
        .map_err(|e| format!("Failed to save cropped image: {}", e))?;

    // Clean up the source temp file
    let _ = std::fs::remove_file(&source_path);

    Ok(screenshot_path_str)
}

#[tauri::command]
pub async fn capture_project_thumbnail(
    project_path: String,
    url: String,
) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");

    // Ensure .shipstudio directory exists
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir).map_err(|e| e.to_string())?;
    }

    let thumbnail_path = shipstudio_dir.join("thumbnail.png");
    let thumbnail_path_str = thumbnail_path.to_string_lossy().to_string();

    // Try using Playwright first (more reliable viewport control)
    let npx_result = Command::new("npx")
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
            // Resize to thumbnail width
            let _ = Command::new("sips")
                .args(["--resampleWidth", "640", &thumbnail_path_str])
                .output();
            return Ok(thumbnail_path_str);
        }
    }

    // Fall back to Chrome CLI if Playwright not available
    let chrome_paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];

    let chrome_path = chrome_paths
        .iter()
        .find(|p| std::path::Path::new(p).exists());

    if let Some(browser) = chrome_path {
        // Use a temp file for raw capture, then process
        let temp_path = shipstudio_dir.join("thumbnail_raw.png");
        let temp_path_str = temp_path.to_string_lossy().to_string();
        let screenshot_arg = format!("--screenshot={}", temp_path_str);

        // Use new headless mode with explicit viewport control
        // Set background to white so any extra captured area isn't black
        let output = Command::new(browser)
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
            .map_err(|e| format!("Failed to run browser: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Browser screenshot failed: {}", stderr));
        }

        // Get actual image dimensions
        let size_output = Command::new("sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight", &temp_path_str])
            .output()
            .map_err(|e| format!("Failed to get image size: {}", e))?;

        let size_str = String::from_utf8_lossy(&size_output.stdout);
        let mut width_val = 1280u32;
        let mut height_val = 800u32;

        for line in size_str.lines() {
            if line.contains("pixelWidth") {
                if let Some(w) = line.split_whitespace().last() {
                    width_val = w.parse().unwrap_or(1280);
                }
            } else if line.contains("pixelHeight") {
                if let Some(h) = line.split_whitespace().last() {
                    height_val = h.parse().unwrap_or(800);
                }
            }
        }

        // If captured at 2x (Retina), scale down to 1280x800 first
        // The content is correct, just at 2x resolution
        if width_val >= 2560 && height_val >= 1600 {
            // Scale down from 2x to 1x
            let _ = Command::new("sips")
                .args([
                    "--resampleWidth",
                    "1280",
                    &temp_path_str,
                    "--out",
                    &thumbnail_path_str,
                ])
                .output();
        } else if width_val > 1280 || height_val > 800 {
            // Unexpected size - resize to fit 1280 width
            let _ = Command::new("sips")
                .args([
                    "--resampleWidth",
                    "1280",
                    &temp_path_str,
                    "--out",
                    &thumbnail_path_str,
                ])
                .output();
        } else {
            // Already correct size, just copy
            let _ = std::fs::copy(&temp_path, &thumbnail_path);
        }

        // Clean up temp file
        let _ = std::fs::remove_file(&temp_path);

        // Resize to thumbnail width (640)
        let _ = Command::new("sips")
            .args(["--resampleWidth", "640", &thumbnail_path_str])
            .output();

        Ok(thumbnail_path_str)
    } else {
        Err(
            "No supported browser found for screenshots (Chrome, Chromium, or Edge required)"
                .to_string(),
        )
    }
}

#[tauri::command]
pub async fn get_project_thumbnail(project_path: String) -> Result<Option<String>, String> {
    let project = validate_project_path(&project_path)?;
    let thumbnail_path = project.join(".shipstudio").join("thumbnail.png");

    if thumbnail_path.exists() {
        // Return as base64 data URL for easy display
        use base64::Engine;
        let data = std::fs::read(&thumbnail_path).map_err(|e| e.to_string())?;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok(Some(format!("data:image/png;base64,{}", base64_data)))
    } else {
        Ok(None)
    }
}
