//! Playwright-based screenshot capture: environment setup, full-page, and viewport captures.

use super::node_tool_command;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::validate_project_path;

/// Ceiling for one capture-script run (page load + scroll + shot).
const CAPTURE_TIMEOUT_SECS: u64 = 180;
/// Ceiling for downloading Chromium during self-heal (~130MB).
const BROWSER_INSTALL_TIMEOUT_SECS: u64 = 600;

/// Run a capture script, self-healing the failure mode that otherwise bricks
/// screenshots forever: the playwright npm package is present but its browser
/// binary is gone (macOS evicts ~/Library/Caches/ms-playwright, and a
/// playwright version bump moves to a new browser build the old cache doesn't
/// have). `get_playwright_env()` only checks node_modules, so detect the miss
/// from the script's own error output, reinstall Chromium, and retry once.
async fn run_capture_script(
    script_path: &std::path::Path,
    playwright_env: &std::path::Path,
) -> Result<std::process::Output, CommandError> {
    let run = || {
        let mut cmd = node_tool_command("node");
        cmd.arg(script_path).current_dir(playwright_env);
        run_with_timeout(
            tokio::process::Command::from(cmd),
            "playwright capture",
            CAPTURE_TIMEOUT_SECS,
        )
    };

    let output = run().await?;
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stderr.contains("Executable doesn't exist") || stderr.contains("playwright install") {
        tracing::warn!("Playwright browser binary missing — reinstalling Chromium and retrying");
        let mut install = node_tool_command("npx");
        install
            .args(["playwright", "install", "chromium"])
            .current_dir(playwright_env);
        let install_out = run_with_timeout(
            tokio::process::Command::from(install),
            "playwright install chromium",
            BROWSER_INSTALL_TIMEOUT_SECS,
        )
        .await?;
        if !install_out.status.success() {
            let install_stderr = String::from_utf8_lossy(&install_out.stderr);
            return Err((format!(
                "Playwright's Chromium browser is missing and reinstalling it failed: {install_stderr}"
            ))
            .into());
        }
        return run().await;
    }

    // Other failures pass through — callers report status + stderr in detail.
    Ok(output)
}

/// Playwright versions below this hang forever in `playwright install` on
/// Node >= 24.16 (yauzl stream regression during archive extraction — fixed
/// in Playwright 1.60; see microsoft/playwright#41000). Old envs upgrade in
/// place; new envs install this range directly.
const MIN_PLAYWRIGHT_MINOR: u32 = 60;
const PLAYWRIGHT_INSTALL_SPEC: &str = "playwright@^1.60.0";

/// Read the installed playwright version's (major, minor) from its package.json.
fn installed_playwright_version(playwright_dir: &std::path::Path) -> Option<(u32, u32)> {
    let pkg = playwright_dir
        .join("node_modules")
        .join("playwright")
        .join("package.json");
    let raw = std::fs::read_to_string(pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = json.get("version")?.as_str()?;
    let mut parts = version.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Get or create a shared Playwright environment directory.
/// Installs Playwright and Chromium once, reused for all screenshots.
pub(super) fn get_playwright_env() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let playwright_dir = home.join(".ship-studio").join("playwright-env");

    // Check if playwright is already installed
    let node_modules = playwright_dir.join("node_modules").join("playwright");
    if node_modules.exists() {
        match installed_playwright_version(&playwright_dir) {
            Some((1, minor)) if minor < MIN_PLAYWRIGHT_MINOR => {
                tracing::warn!(
                    "Playwright 1.{} is affected by the Node >= 24.16 install hang — upgrading to {}",
                    minor,
                    PLAYWRIGHT_INSTALL_SPEC
                );
                let upgrade = node_tool_command("npm")
                    .args(["install", PLAYWRIGHT_INSTALL_SPEC])
                    .current_dir(&playwright_dir)
                    .output()
                    .map_err(|e| format!("Failed to upgrade playwright: {e}"))?;
                if !upgrade.status.success() {
                    let stderr = String::from_utf8_lossy(&upgrade.stderr);
                    tracing::warn!(
                        "Playwright upgrade failed (continuing with old version): {stderr}"
                    );
                }
            }
            _ => {}
        }
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
    let install_output = node_tool_command("npm")
        .args(["install", PLAYWRIGHT_INSTALL_SPEC])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| format!("Failed to run npm install playwright: {e}"))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        return Err(format!("Failed to install playwright: {stderr}"));
    }

    // Install Chromium browser
    tracing::info!("Installing Chromium browser...");
    let browser_output = node_tool_command("npx")
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
    width: Option<u32>,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;

    // Fail fast with a clean, expected error when nothing is listening on the
    // dev-server port — otherwise Playwright's page.goto dies with a raw
    // ERR_CONNECTION_REFUSED stack trace (issue #349). An expected state:
    // the server may still be booting or was just restarted on another port.
    if !super::dev_server_listening(&url) {
        return Err(CommandError::expected(format!(
            "The dev server isn't accepting connections at {url} yet. Wait for the preview to finish loading, then try again."
        )));
    }

    let screenshots_dir = project.join(".shipstudio").join("screenshots");
    // Match the preview's current viewport when given (agent bridge responsive
    // checks); clamp to sane bounds so a bad value can't wedge Chromium.
    let viewport_width = width.unwrap_or(1280).clamp(200, 3000);

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
        const page = await browser.newPage({{ viewport: {{ width: {viewport_width}, height: 800 }} }});

        // Dev servers keep HMR/live-reload connections open forever, so
        // 'networkidle' may never arrive — wait for 'load', then settle
        // best-effort without ever failing the capture on it (issues #309/#310).
        await page.goto('{}', {{ waitUntil: 'load', timeout: 30000 }});
        await page.waitForLoadState('networkidle', {{ timeout: 5000 }}).catch(() => {{}});

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
}})().catch((err) => {{
    // Surface a clean one-line failure instead of Node's uncaught-exception
    // stack dump (issues #309/#310).
    console.error(String((err && err.message) || err));
    process.exit(1);
}});
"#,
        url,
        screenshot_path_str.replace('\\', "\\\\")
    );

    // Write script to the playwright env directory (where node_modules is).
    // Unique name per invocation: a fixed filename let concurrent captures
    // delete/overwrite each other's script mid-run — Node then died with
    // MODULE_NOT_FOUND on the shared path (issue #282).
    let script_path = playwright_env.join(format!("capture-script-{}.js", uuid::Uuid::new_v4()));
    std::fs::write(&script_path, &script)
        .map_err(|e| format!("Failed to write capture script: {e}"))?;

    // Run the script from the playwright environment directory
    // This ensures require('playwright') can find the module
    let output = run_capture_script(&script_path, &playwright_env).await?;

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
    width: Option<u32>,
) -> Result<String, CommandError> {
    let project = validate_project_path(&project_path)?;

    // Fail fast with a clean, expected error when nothing is listening on the
    // dev-server port — otherwise Playwright's page.goto dies with a raw
    // ERR_CONNECTION_REFUSED stack trace (issue #349). An expected state:
    // the server may still be booting or was just restarted on another port.
    if !super::dev_server_listening(&url) {
        return Err(CommandError::expected(format!(
            "The dev server isn't accepting connections at {url} yet. Wait for the preview to finish loading, then try again."
        )));
    }

    let screenshots_dir = project.join(".shipstudio").join("screenshots");
    // Match the preview's current viewport when given (agent bridge responsive
    // checks); clamp to sane bounds so a bad value can't wedge Chromium.
    let viewport_width = width.unwrap_or(1280).clamp(200, 3000);

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
        const page = await browser.newPage({{ viewport: {{ width: {viewport_width}, height: 800 }} }});

        // Same wait strategy as the full-page capture: 'networkidle' may never
        // arrive on dev servers with persistent connections (issues #309/#310).
        await page.goto('{}', {{ waitUntil: 'load', timeout: 30000 }});
        await page.waitForLoadState('networkidle', {{ timeout: 5000 }}).catch(() => {{}});

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
}})().catch((err) => {{
    // Surface a clean one-line failure instead of Node's uncaught-exception
    // stack dump (issues #309/#310).
    console.error(String((err && err.message) || err));
    process.exit(1);
}});
"#,
        url,
        screenshot_path_str.replace('\\', "\\\\")
    );

    // Write script to the playwright env directory. Unique per invocation —
    // see the same fix in capture_fullpage_playwright (issue #282).
    let script_path = playwright_env.join(format!(
        "capture-viewport-script-{}.js",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&script_path, &script)
        .map_err(|e| format!("Failed to write capture script: {e}"))?;

    // Run the script
    let output = run_capture_script(&script_path, &playwright_env).await?;

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
