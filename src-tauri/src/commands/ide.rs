//! # IDE, Browser, and Webview Commands
//!
//! Commands for IDE integration, browser selection, preview webviews, and screenshots.

use crate::types::{BrowserInfo, IdeAvailability};
use crate::utils::validate_project_path;
use std::net::TcpStream;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, Webview, WebviewUrl};

/// Browser configurations for macOS
/// Tuple: (id, display_name, app_path)
#[cfg(target_os = "macos")]
const MACOS_BROWSERS: &[(&str, &str, &str)] = &[
    ("safari", "Safari", "/Applications/Safari.app"),
    ("chrome", "Google Chrome", "/Applications/Google Chrome.app"),
    ("firefox", "Firefox", "/Applications/Firefox.app"),
    ("arc", "Arc", "/Applications/Arc.app"),
    ("brave", "Brave", "/Applications/Brave Browser.app"),
    ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app"),
];

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

/// Check which browsers are available on the system
#[tauri::command]
pub async fn check_browser_availability() -> Vec<BrowserInfo> {
    #[cfg(target_os = "macos")]
    {
        MACOS_BROWSERS
            .iter()
            .filter_map(|(id, name, path)| {
                if std::path::Path::new(path).exists() {
                    Some(BrowserInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    #[cfg(not(target_os = "macos"))]
    {
        // For non-macOS, return empty list (future: implement for Windows/Linux)
        vec![]
    }
}

/// Open a URL in a specific browser
#[tauri::command]
pub async fn open_url_in_browser(url: String, browser_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_name = MACOS_BROWSERS
            .iter()
            .find(|(id, _, _)| *id == browser_id)
            .map(|(_, name, _)| *name)
            .ok_or_else(|| format!("Unknown browser: {}", browser_id))?;

        Command::new("open")
            .args(["-a", app_name, &url])
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", browser_id, e))?;

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (url, browser_id);
        Err("Browser selection not supported on this platform".to_string())
    }
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

/// Scroll dimensions returned from a webview
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ScrollDimensions {
    pub scroll_height: u32,
    pub viewport_height: u32,
    pub sticky_header_height: u32,
}

/// Evaluate JavaScript in the preview webview (fire and forget).
#[tauri::command]
pub async fn eval_preview_js(app: tauri::AppHandle, js: String) -> Result<(), String> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    webview
        .eval(&js)
        .map_err(|e| format!("Failed to evaluate JS: {}", e))?;
    Ok(())
}

/// Scroll the preview webview to a specific Y position and return the actual scroll position.
/// Returns the actual scrollY after scrolling (may be less than requested if at bottom).
#[tauri::command]
pub async fn scroll_preview_webview(app: tauri::AppHandle, y: u32) -> Result<(), String> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    let js = format!("window.scrollTo(0, {});", y);
    webview
        .eval(&js)
        .map_err(|e| format!("Failed to scroll: {}", e))?;
    Ok(())
}

/// Get the current scroll position from the preview webview.
/// Note: This is a best-effort approach since we can't easily get return values from JS eval.
/// The stitch_screenshots function handles duplicate detection as a fallback.
#[tauri::command]
pub async fn get_preview_scroll_info(app: tauri::AppHandle) -> Result<(u32, u32), String> {
    // We can't reliably get JS return values from the preview webview,
    // so this returns a placeholder. The actual duplicate detection
    // happens in stitch_screenshots via image comparison.
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    // Just verify the webview exists
    let _ = webview;

    // Return placeholder values - the image comparison will handle duplicates
    Ok((0, 0))
}

/// Check if the webview can still scroll down (returns true if not at bottom).
/// This is a simpler approach than trying to get exact scroll dimensions.
#[tauri::command]
pub async fn check_preview_can_scroll(app: tauri::AppHandle) -> Result<bool, String> {
    let webview = app
        .get_webview("preview")
        .ok_or("Preview webview not found")?;

    // Scroll down a tiny bit and check if position changed
    // This is a workaround since we can't easily get scroll position
    let js = r#"
        (function() {
            var before = window.scrollY;
            var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            // We're at the bottom if scrollY is at or near maxScroll
            window.__canScrollMore = before < (maxScroll - 10);
        })();
    "#;

    webview
        .eval(js)
        .map_err(|e| format!("Failed to check scroll: {}", e))?;

    // We can't get the result back directly, so this always returns true
    // The frontend will handle stopping when captures look the same
    Ok(true)
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
    // Quick health check: verify the dev server is still responding before launching Playwright.
    // This reduces (but doesn't eliminate) race conditions where the server dies mid-capture.
    // Extract port from URL (e.g., "http://localhost:3000" -> 3000)
    let port: u16 = url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split(':')
        .last()
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
        return Err("Dev server not responding, skipping thumbnail capture".to_string());
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

/// Get or create a shared Playwright environment directory.
/// Installs Playwright and Chromium once, reused for all screenshots.
fn get_playwright_env() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set")?;
    let playwright_dir = std::path::PathBuf::from(&home)
        .join(".ship-studio")
        .join("playwright-env");

    // Check if playwright is already installed
    let node_modules = playwright_dir.join("node_modules").join("playwright");
    if node_modules.exists() {
        tracing::debug!(
            "Using existing Playwright environment at {:?}",
            playwright_dir
        );
        return Ok(playwright_dir);
    }

    tracing::info!("Setting up Playwright environment at {:?}", playwright_dir);

    // Create the directory
    std::fs::create_dir_all(&playwright_dir)
        .map_err(|e| format!("Failed to create playwright env dir: {}", e))?;

    // Write package.json
    let package_json = r#"{"name": "ship-studio-playwright", "private": true}"#;
    std::fs::write(playwright_dir.join("package.json"), package_json)
        .map_err(|e| format!("Failed to write package.json: {}", e))?;

    // Install playwright
    tracing::info!("Installing Playwright (this may take a moment on first run)...");
    let install_output = Command::new("npm")
        .args(["install", "playwright"])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| format!("Failed to run npm install playwright: {}", e))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        return Err(format!("Failed to install playwright: {}", stderr));
    }

    // Install Chromium browser
    tracing::info!("Installing Chromium browser...");
    let browser_output = Command::new("npx")
        .args(["playwright", "install", "chromium"])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| format!("Failed to install chromium: {}", e))?;

    if !browser_output.status.success() {
        let stderr = String::from_utf8_lossy(&browser_output.stderr);
        tracing::warn!("Chromium install warning: {}", stderr);
        // Don't fail here - playwright might still work
    }

    tracing::info!("Playwright environment ready");
    Ok(playwright_dir)
}

/// Capture a full-page screenshot using Playwright.
/// Scrolls through the page first to trigger lazy-loaded content and animations,
/// then captures the full page in one shot.
#[tauri::command]
pub async fn capture_fullpage_playwright(
    project_path: String,
    url: String,
) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Get the shared Playwright environment
    let playwright_env = get_playwright_env()?;

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("fullpage-{}.png", timestamp));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Create a script that scrolls the page before capturing
    // This triggers lazy-loaded content and scroll animations (GSAP, etc.)
    // Also hides Next.js dev tools and other overlays
    // Uses try/finally to ensure browser is always closed (prevents zombie processes)
    let script = format!(
        r#"
const {{ chromium }} = require('playwright');

(async () => {{
    let browser;
    try {{
        browser = await chromium.launch();
        const page = await browser.newPage({{ viewport: {{ width: 1280, height: 800 }} }});

        await page.goto('{}', {{ waitUntil: 'networkidle', timeout: 30000 }});

        // Hide dev tools and feedback overlays
        await page.evaluate(() => {{
            const selectors = [
                'nextjs-portal',
                '[data-nextjs-toast]',
                '[data-nextjs-dialog]',
                '#__next-build-watcher',
                '[class*="nextjs-"]',
                '[data-feedback-toolbar]',
                '[data-feedback-toolbar="true"]',
                '[class*="feedback-toolbar"]',
                '[class*="styles-module__toolbar"]'
            ];
            selectors.forEach(sel => {{
                document.querySelectorAll(sel).forEach(el => {{
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                }});
            }});
        }});

        // Scroll slowly through the page to trigger lazy content and animations
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const viewportHeight = 800;

        for (let y = 0; y < scrollHeight; y += viewportHeight / 2) {{
            await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
            await page.waitForTimeout(300); // Pause for animations to trigger
        }}

        // Scroll back to top and hide overlays again (they may have reappeared)
        await page.evaluate(() => {{
            window.scrollTo(0, 0);
            const selectors = [
                'nextjs-portal', '[data-nextjs-toast]', '[class*="nextjs-"]',
                '[data-feedback-toolbar]', '[data-feedback-toolbar="true"]',
                '[class*="feedback-toolbar"]', '[class*="styles-module__toolbar"]'
            ];
            selectors.forEach(sel => {{
                document.querySelectorAll(sel).forEach(el => {{
                    el.style.setProperty('display', 'none', 'important');
                }});
            }});
        }});
        await page.waitForTimeout(500);

        // Take full-page screenshot
        await page.screenshot({{ path: '{}', fullPage: true }});
        console.log('Screenshot saved successfully');
    }} finally {{
        if (browser) await browser.close();
    }}
}})();
"#,
        url,
        screenshot_path_str.replace('\\', "\\\\")
    );

    // Write script to the playwright env directory (where node_modules is)
    let script_path = playwright_env.join("capture-script.js");
    std::fs::write(&script_path, &script)
        .map_err(|e| format!("Failed to write capture script: {}", e))?;

    // Run the script from the playwright environment directory
    // This ensures require('playwright') can find the module
    let output = Command::new("node")
        .arg(&script_path)
        .current_dir(&playwright_env)
        .output()
        .map_err(|e| format!("Failed to run capture script: {}", e))?;

    // Clean up script file
    let _ = std::fs::remove_file(&script_path);

    if output.status.success() && screenshot_path.exists() {
        tracing::info!(
            "Full-page screenshot captured with Playwright: {}",
            screenshot_path_str
        );
        return Ok(screenshot_path_str);
    }

    // If failed, return error with details
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "Playwright screenshot failed. stdout: {} stderr: {}",
        stdout, stderr
    ))
}

/// Capture a viewport screenshot using Playwright.
/// Hides Next.js dev tools and other overlays before capturing.
/// Faster than full-page since it doesn't scroll.
#[tauri::command]
pub async fn capture_viewport_playwright(
    project_path: String,
    url: String,
) -> Result<String, String> {
    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Get the shared Playwright environment
    let playwright_env = get_playwright_env()?;

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let screenshot_path = screenshots_dir.join(format!("screenshot-{}.png", timestamp));
    let screenshot_path_str = screenshot_path.to_string_lossy().to_string();

    // Create a script that hides overlays and captures viewport
    // Uses try/finally to ensure browser is always closed (prevents zombie processes)
    let script = format!(
        r#"
const {{ chromium }} = require('playwright');

(async () => {{
    let browser;
    try {{
        browser = await chromium.launch();
        const page = await browser.newPage({{ viewport: {{ width: 1280, height: 800 }} }});

        await page.goto('{}', {{ waitUntil: 'networkidle', timeout: 30000 }});

        // Hide dev tools and feedback overlays
        await page.evaluate(() => {{
            const selectors = [
                'nextjs-portal',
                '[data-nextjs-toast]',
                '[data-nextjs-dialog]',
                '#__next-build-watcher',
                '[class*="nextjs-"]',
                '[data-feedback-toolbar]',
                '[data-feedback-toolbar="true"]',
                '[class*="feedback-toolbar"]',
                '[class*="styles-module__toolbar"]'
            ];
            selectors.forEach(sel => {{
                document.querySelectorAll(sel).forEach(el => {{
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                }});
            }});
        }});

        // Wait for animations to complete
        await page.waitForTimeout(3000);

        // Take viewport screenshot (not full page)
        await page.screenshot({{ path: '{}' }});
    }} finally {{
        if (browser) await browser.close();
    }}
}})();
"#,
        url,
        screenshot_path_str.replace('\\', "\\\\")
    );

    // Write script to the playwright env directory
    let script_path = playwright_env.join("capture-viewport-script.js");
    std::fs::write(&script_path, &script)
        .map_err(|e| format!("Failed to write capture script: {}", e))?;

    // Run the script
    let output = Command::new("node")
        .arg(&script_path)
        .current_dir(&playwright_env)
        .output()
        .map_err(|e| format!("Failed to run capture script: {}", e))?;

    // Clean up script file
    let _ = std::fs::remove_file(&script_path);

    if output.status.success() && screenshot_path.exists() {
        tracing::info!(
            "Viewport screenshot captured with Playwright: {}",
            screenshot_path_str
        );
        return Ok(screenshot_path_str);
    }

    // If failed, return error with details
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "Playwright viewport screenshot failed. stdout: {} stderr: {}",
        stdout, stderr
    ))
}

/// Read a screenshot file and return it as a base64 data URL.
/// Used for displaying screenshot previews in the UI.
#[tauri::command]
pub async fn get_screenshot_base64(file_path: String) -> Result<String, String> {
    use base64::Engine;

    let path = std::path::PathBuf::from(&file_path);

    if !path.exists() {
        return Err(format!("Screenshot file not found: {}", file_path));
    }

    let data = std::fs::read(&path).map_err(|e| format!("Failed to read screenshot: {}", e))?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{}", base64_data))
}

/// Compare two screenshot images to detect if we've hit the page bottom.
/// When scrolling stops working (page bottom reached), the BOTTOM EDGE of both
/// captures will be identical (same footer/content).
/// This is more reliable than comparing the whole image.
#[tauri::command]
pub async fn compare_screenshots(
    path1: String,
    path2: String,
    _skip_header_pixels: u32, // kept for API compatibility
) -> Result<bool, String> {
    use image::GenericImageView;

    let img1 = image::open(&path1).map_err(|e| format!("Failed to open image 1: {}", e))?;
    let img2 = image::open(&path2).map_err(|e| format!("Failed to open image 2: {}", e))?;

    // Different dimensions = not similar
    if img1.width() != img2.width() || img1.height() != img2.height() {
        return Ok(false);
    }

    let width = img1.width();
    let height = img1.height();

    // Compare just the bottom 100 pixels of each image
    // When we hit page bottom, both images will have the same footer
    let bottom_region = 100.min(height / 4); // At most 25% of image height
    let compare_start = height.saturating_sub(bottom_region);

    // Sample every 20th pixel for accurate comparison
    let sample_step = 20;
    let mut matching = 0;
    let mut total = 0;

    for y in (compare_start..height).step_by(sample_step as usize) {
        for x in (0..width).step_by(sample_step as usize) {
            let p1 = img1.get_pixel(x, y);
            let p2 = img2.get_pixel(x, y);
            total += 1;
            // Allow small differences due to compression artifacts
            if (p1[0] as i32 - p2[0] as i32).abs() < 10
                && (p1[1] as i32 - p2[1] as i32).abs() < 10
                && (p1[2] as i32 - p2[2] as i32).abs() < 10
            {
                matching += 1;
            }
        }
    }

    // Bottom edges are the same if >95% of sampled pixels match
    // This is strict because we're only comparing a small region
    let is_similar = total > 0 && (matching * 100 / total) > 95;

    tracing::debug!(
        "Screenshot comparison: {}/{} pixels match ({}%) - {}",
        matching,
        total,
        if total > 0 { matching * 100 / total } else { 0 },
        if is_similar { "DUPLICATE" } else { "different" }
    );

    Ok(is_similar)
}

/// Stitch multiple screenshots together vertically for full-page capture.
/// Takes multiple image paths and combines them into a single image.
/// sticky_header_height: height of fixed/sticky elements at the top to skip in subsequent captures
#[tauri::command]
pub async fn stitch_screenshots(
    project_path: String,
    image_paths: Vec<String>,
    viewport_height: u32,
    full_height: u32,
    sticky_header_height: u32,
) -> Result<String, String> {
    use image::{DynamicImage, GenericImageView, RgbaImage};

    if image_paths.is_empty() {
        return Err("No images to stitch".to_string());
    }

    let project = validate_project_path(&project_path)?;
    let screenshots_dir = project.join(".shipstudio").join("screenshots");

    // Ensure screenshots directory exists
    if !screenshots_dir.exists() {
        std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;
    }

    // Helper function to compare two images for similarity (returns true if they're nearly identical)
    // Focuses on the bottom 60% of each image where duplicates are most apparent
    fn images_are_similar(img1: &DynamicImage, img2: &DynamicImage, skip_header: u32) -> bool {
        // Compare dimensions first
        if img1.width() != img2.width() || img1.height() != img2.height() {
            return false;
        }

        let width = img1.width();
        let height = img1.height();

        // Focus on bottom 60% of the image (where duplicates appear when hitting page bottom)
        let content_height = height.saturating_sub(skip_header);
        let compare_start = skip_header + (content_height * 40 / 100);

        // Sample every 30th pixel for accurate comparison
        let sample_step = 30;
        let mut matching = 0;
        let mut total = 0;

        for y in (compare_start..height).step_by(sample_step as usize) {
            for x in (0..width).step_by(sample_step as usize) {
                let p1 = img1.get_pixel(x, y);
                let p2 = img2.get_pixel(x, y);
                total += 1;
                // Allow small differences due to compression artifacts
                if (p1[0] as i32 - p2[0] as i32).abs() < 10
                    && (p1[1] as i32 - p2[1] as i32).abs() < 10
                    && (p1[2] as i32 - p2[2] as i32).abs() < 10
                {
                    matching += 1;
                }
            }
        }

        // Images are similar if >90% of sampled pixels in the bottom half match
        total > 0 && (matching * 100 / total) > 93
    }

    // Load all images first to detect duplicates
    let mut images: Vec<DynamicImage> = Vec::new();
    let mut unique_count = 0;

    for (i, path) in image_paths.iter().enumerate() {
        let img = image::open(path).map_err(|e| format!("Failed to open image {}: {}", path, e))?;

        // Check if this image is a duplicate of the previous one (we've hit the bottom)
        if i > 0 {
            if images_are_similar(&images[i - 1], &img, sticky_header_height) {
                tracing::info!(
                    "Detected duplicate image at index {} - stopping stitch (page bottom reached)",
                    i
                );
                // Clean up remaining temp files
                for remaining_path in image_paths.iter().skip(i) {
                    let _ = std::fs::remove_file(remaining_path);
                }
                break;
            }
        }

        images.push(img);
        unique_count += 1;
    }

    if images.is_empty() {
        return Err("No valid images to stitch".to_string());
    }

    // Load first image to get width
    let width = images[0].width();

    // Calculate actual content height per capture (excluding sticky header for images after first)
    let content_height_first = viewport_height;
    let content_height_rest = viewport_height.saturating_sub(sticky_header_height);

    // Calculate total output height based on actual unique images
    let num_images = unique_count as u32;
    let calculated_height = if num_images > 1 {
        content_height_first + (num_images - 1) * content_height_rest
    } else {
        content_height_first
    };
    // Use the smaller of calculated height and reported full height
    let output_height = calculated_height.min(full_height);

    // Create output image
    let mut output = RgbaImage::new(width, output_height);

    let mut y_offset = 0u32;

    for (i, img) in images.iter().enumerate() {
        // For first image, copy from top; for subsequent images, skip the sticky header
        let source_y_start = if i == 0 { 0 } else { sticky_header_height };
        let available_source_height = img.height().saturating_sub(source_y_start);

        // Calculate how much of this image to copy
        let remaining = output_height.saturating_sub(y_offset);
        let copy_height = remaining.min(available_source_height);

        // Copy pixels from source to output
        for y in 0..copy_height {
            for x in 0..width.min(img.width()) {
                let pixel = img.get_pixel(x, source_y_start + y);
                if y_offset + y < output_height {
                    output.put_pixel(x, y_offset + y, pixel);
                }
            }
        }

        y_offset += copy_height;

        // Clean up temp file
        let _ = std::fs::remove_file(&image_paths[i]);

        // Log progress for debugging
        tracing::debug!(
            "Stitched image {} of {}: copied {} rows (skipped {} header rows) at y_offset {}",
            i + 1,
            unique_count,
            copy_height,
            source_y_start,
            y_offset - copy_height
        );
    }

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let output_path = screenshots_dir.join(format!("fullpage-{}.png", timestamp));
    let output_path_str = output_path.to_string_lossy().to_string();

    // Save the stitched image
    output
        .save(&output_path)
        .map_err(|e| format!("Failed to save stitched image: {}", e))?;

    tracing::info!(
        "Full-page screenshot saved: {} ({}x{}, sticky header: {}px)",
        output_path_str,
        width,
        output_height,
        sticky_header_height
    );

    Ok(output_path_str)
}
