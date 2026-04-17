//! Playwright-based screenshot capture: environment setup, full-page, and viewport captures.

use crate::errors::CommandError;
use crate::utils::{create_command, validate_project_path};

/// Get or create a shared Playwright environment directory.
/// Installs Playwright and Chromium once, reused for all screenshots.
pub(super) fn get_playwright_env() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let playwright_dir = home.join(".ship-studio").join("playwright-env");

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
        .map_err(|e| format!("Failed to create playwright env dir: {e}"))?;

    // Write package.json
    let package_json = r#"{"name": "ship-studio-playwright", "private": true}"#;
    std::fs::write(playwright_dir.join("package.json"), package_json)
        .map_err(|e| format!("Failed to write package.json: {e}"))?;

    // Install playwright
    tracing::info!("Installing Playwright (this may take a moment on first run)...");
    let install_output = create_command("npm")
        .args(["install", "playwright"])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| format!("Failed to run npm install playwright: {e}"))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        return Err(format!("Failed to install playwright: {stderr}"));
    }

    // Install Chromium browser
    tracing::info!("Installing Chromium browser...");
    let browser_output = create_command("npx")
        .args(["playwright", "install", "chromium"])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| format!("Failed to install chromium: {e}"))?;

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
#[tracing::instrument(fields(project = %project_path))]
pub async fn capture_fullpage_playwright(
    project_path: String,
    url: String,
) -> Result<String, CommandError> {
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
    let screenshot_path = screenshots_dir.join(format!("fullpage-{timestamp}.png"));
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
        .map_err(|e| format!("Failed to write capture script: {e}"))?;

    // Run the script from the playwright environment directory
    // This ensures require('playwright') can find the module
    let output = create_command("node")
        .arg(&script_path)
        .current_dir(&playwright_env)
        .output()
        .map_err(|e| format!("Failed to run capture script: {e}"))?;

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
    Err((format!("Playwright screenshot failed. stdout: {stdout} stderr: {stderr}")).into())
}

/// Capture a viewport screenshot using Playwright.
/// Hides Next.js dev tools and other overlays before capturing.
/// Faster than full-page since it doesn't scroll.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn capture_viewport_playwright(
    project_path: String,
    url: String,
) -> Result<String, CommandError> {
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
    let screenshot_path = screenshots_dir.join(format!("screenshot-{timestamp}.png"));
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
        .map_err(|e| format!("Failed to write capture script: {e}"))?;

    // Run the script
    let output = create_command("node")
        .arg(&script_path)
        .current_dir(&playwright_env)
        .output()
        .map_err(|e| format!("Failed to run capture script: {e}"))?;

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
    Err(
        (format!("Playwright viewport screenshot failed. stdout: {stdout} stderr: {stderr}"))
            .into(),
    )
}
