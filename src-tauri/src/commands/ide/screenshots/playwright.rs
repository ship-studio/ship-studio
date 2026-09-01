//! Playwright-based screenshot capture: environment setup, full-page, and viewport captures.

use super::node_tool_command;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::validate_project_path;

/// Ceiling for one capture-script run (page load + scroll + shot). Must cover
/// the script's own worst-case inner budgets — a 60s first goto attempt plus
/// the 120s retry (issue #606), the capped scroll pass, the 120s
/// screenshot/stitch, and the short-budget CDP screenshot retries
/// (issue #657: up to 2 × (2s beat + 30s attempt) ≈ 64s) — or we kill
/// captures that were progressing legitimately and would have failed (or
/// succeeded) with a far better error on their own (issue #527).
const CAPTURE_TIMEOUT_SECS: u64 = 420;
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
        let install_out = match run_with_timeout(
            tokio::process::Command::from(install),
            "playwright install chromium",
            BROWSER_INSTALL_TIMEOUT_SECS,
        )
        .await
        {
            Ok(out) => out,
            // A ~130MB download not finishing inside the ceiling is a slow or
            // interrupted connection, not an app malfunction — say so instead
            // of surfacing the raw timeout (issue #718).
            Err(CommandError::Timeout { .. }) => {
                return Err(CommandError::expected(format!(
                    "Downloading the screenshot browser (Chromium, about 130MB) didn't finish \
                     within {BROWSER_INSTALL_TIMEOUT_SECS} seconds. This is usually a slow or \
                     interrupted connection — check your network (including any VPN or proxy), \
                     then try again."
                )));
            }
            Err(e) => return Err(e),
        };
        if !install_out.status.success() {
            return Err(browser_install_error(&install_out));
        }
        return run().await;
    }

    // Other failures pass through — callers report status + stderr in detail.
    Ok(output)
}

/// How a failed process exited, in words. A capture that wrote nothing at all
/// must still be able to say *whether* it crashed, was killed, or exited
/// cleanly (issues #829/#796).
fn exit_status_detail(output: &std::process::Output) -> String {
    if let Some(code) = output.status.code() {
        return format!("exit code {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = output.status.signal() {
            return format!("killed by signal {signal}");
        }
    }
    "killed by signal".to_string()
}

/// Map a failed `playwright install chromium` run to a `CommandError`. The
/// reinstall downloads ~130MB from Playwright's CDN and unpacks it into the
/// user's browser cache, so its failures are overwhelmingly environmental —
/// network, disk, permissions — and those classify Expected. Anything else
/// stays reportable, but must still say something: this process can exit
/// non-zero having written no stderr at all, which previously produced a
/// message that trailed off after the colon (issue #796).
fn browser_install_error(output: &std::process::Output) -> CommandError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{}\n{}", stderr.trim(), stdout.trim());

    const NETWORK_SIGNATURES: &[&str] = &[
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "socket hang up",
        "getaddrinfo",
        "unable to verify the first certificate",
        "self-signed certificate",
    ];
    if NETWORK_SIGNATURES.iter().any(|s| combined.contains(s)) {
        return CommandError::expected(
            "The screenshot browser couldn't be downloaded — Ship Studio couldn't reach \
             Playwright's download server. Check your internet connection (including any VPN, \
             proxy, or firewall), then try again.",
        );
    }
    if combined.contains("ENOSPC")
        || combined.contains("No space left on device")
        || combined.contains("not enough space on the disk")
    {
        return CommandError::expected(
            "The screenshot browser couldn't be downloaded — this computer is out of disk \
             space. Free up some space, then try again.",
        );
    }
    if combined.contains("EACCES") || combined.contains("EPERM") {
        return CommandError::expected(
            "The screenshot browser couldn't be downloaded — Ship Studio wasn't allowed to \
             write to Playwright's browser cache. Check the permissions on that folder \
             (~/Library/Caches/ms-playwright on macOS, %LOCALAPPDATA%\\ms-playwright on \
             Windows), then try again.",
        );
    }

    let status = exit_status_detail(output);
    let detail = combined.trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        let snippet: String = detail.chars().take(300).collect();
        format!(" Output: {snippet}")
    };
    (format!(
        "Playwright's Chromium browser is missing and reinstalling it failed ({status}). Try \
         again — if it keeps failing, running `npx playwright install chromium` in a terminal \
         shows the full output.{detail}"
    ))
    .into()
}

/// True when stderr shows the process (Node itself, or a child) failing at
/// the dynamic-linker level — the binary can spawn but can't resolve a shared
/// library it was linked against. Classic case: Homebrew upgrades `icu4c` out
/// from under a `node` that wasn't relinked, and every `node` invocation dies
/// with a raw `dyld[...]: Library not loaded` dump (issue #645). A broken
/// local toolchain, not an app malfunction.
fn is_broken_loader_error(stderr: &str) -> bool {
    stderr.contains("Library not loaded")
        || stderr.contains("dyld[")
        || stderr.contains("dyld: ")
        || stderr.contains("error while loading shared libraries")
}

/// Map a failed capture-script run to a `CommandError`. A connection refused
/// or invalid-HTTP-response that survived the in-script retry means the dev
/// server went away mid-flight (crashed, restarted on another port) — an
/// expected state exactly like the pre-capture readiness miss (#349), not an
/// app malfunction (issues #514/#703).
fn capture_script_error(what: &str, url: &str, output: &std::process::Output) -> CommandError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("ERR_CONNECTION_REFUSED") {
        return CommandError::expected(format!(
            "The dev server at {url} stopped responding while the screenshot was being captured. Wait for the preview to finish reloading, then try again."
        ));
    }
    // A malformed/empty HTTP response mid-navigation is the same dev-server
    // restart race as the refused connection above, caught one step later:
    // the server accepted the socket but died mid-answer (issue #703). The
    // script already retried it once — persisting means the server is still
    // down, an expected state, not an app bug.
    if stderr.contains("ERR_INVALID_HTTP_RESPONSE") {
        return CommandError::expected(format!(
            "The dev server at {url} stopped responding while loading the page — it was probably restarting mid-request. Wait for the preview to finish reloading, then try again."
        ));
    }
    // Node itself failing to start (dyld can't resolve a linked library) is a
    // broken local Node install — e.g. Homebrew upgraded icu4c without node
    // being relinked. Actionable for the user, not an app bug (issue #645).
    if is_broken_loader_error(&stderr) {
        return CommandError::expected(
            "Your system Node.js installation appears broken (it failed to start because a \
             library it depends on is missing). Reinstall Node.js — e.g. `brew reinstall node` \
             — then try again.",
        );
    }
    // The headless browser process dying at startup ("Target crashed" before
    // any navigation) is an environment-level failure — GPU/driver quirks or
    // security software killing the fresh Chromium process — that a retry
    // usually clears. Persistent occurrences are still not app bugs
    // (issue #558).
    if stderr.contains("Target crashed") {
        return CommandError::expected(
            "The screenshot browser crashed while starting up. This is usually a one-off \
             (graphics driver or security software interfering with the headless browser) — \
             try again, and if it keeps happening, restarting your machine often clears it.",
        );
    }
    // Chromium's CDP refusing the screenshot outright ("Page.captureScreenshot:
    // Unable to capture screenshot") is a known transient renderer failure —
    // GPU/memory pressure or backing-store limits (puppeteer#5341). The
    // capture script already retries it in place; one that persists through
    // those retries is still an environment-level condition, not an app bug
    // (issue #657, same signature as #569 on the full-page path).
    if stderr.contains("Unable to capture screenshot") {
        return CommandError::expected(
            "The screenshot browser couldn't render the capture (a transient graphics/memory \
             hiccup in headless Chromium). Try again in a moment — if it keeps happening, \
             closing other applications or restarting your machine usually clears it.",
        );
    }
    // A URL that serves a file download instead of a document (a PDF export,
    // an invoice API route) aborts the navigation with "Download is starting"
    // every single time — a fact about that page, not a transient race, so
    // there is nothing to retry (issue #801).
    if stderr.contains("Download is starting") {
        return CommandError::expected(format!(
            "{url} starts a file download instead of rendering a page, so there's nothing to \
             screenshot. Point the preview at a page URL and try again."
        ));
    }
    // Chromium aborting the navigation (net::ERR_ABORTED) means something
    // superseded it mid-flight — a dev-server hot reload or a client-side
    // redirect landing while page.goto was still waiting for `load`. The
    // script already retries it once; one that persists is the same
    // dev-server race as #514/#703, not an app bug (issue #782).
    if stderr.contains("ERR_ABORTED") {
        return CommandError::expected(format!(
            "Loading {url} was interrupted before the page finished — the preview was probably \
             reloading (hot reload or a redirect) as the screenshot started. Wait for it to \
             settle, then try again."
        ));
    }
    // The page going away mid-session ("Target page, context or browser has
    // been closed") means the renderer died after the navigation had already
    // succeeded — the same environment-level browser failure as the startup
    // crash above (#558), caught later in the run (issue #815).
    if stderr.contains("Target page, context or browser has been closed") {
        return CommandError::expected(
            "The screenshot browser closed unexpectedly while capturing the page. This is \
             usually a one-off (memory pressure, or security software stopping the headless \
             browser) — try again in a moment.",
        );
    }
    // Both goto attempts exhausting their navigation timeout is a recurring,
    // environmental condition on slow dev servers (Windows first-compile +
    // antivirus overhead — issues #385/#606), not a malfunction: the route
    // simply didn't finish loading inside the budget.
    if stderr.contains("page.goto") && stderr.contains("Timeout") {
        return CommandError::expected(format!(
            "The page at {url} didn't finish loading in time for the screenshot — the dev \
             server is probably still compiling this route. Wait for the preview to load \
             fully, then try again."
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let status = exit_status_detail(output);
    // A capture that produced neither stdout nor stderr told us nothing about
    // why it died. The exit status is then the only signal there is, so name
    // it and say what a silent death usually means (issue #829).
    if stdout.trim().is_empty() && stderr.trim().is_empty() {
        if output.status.success() {
            // The script ran to completion but no screenshot file is there —
            // a different shape entirely from a killed process, so don't
            // describe it as a crash.
            return (format!(
                "{what} finished without writing a screenshot and without reporting why. \
                 Try again in a moment."
            ))
            .into();
        }
        return (format!(
            "{what} failed with no output at all ({status}) — the capture process died before \
             it could report anything, which usually means it was killed (security software, \
             or the machine running out of memory). Try again in a moment."
        ))
        .into();
    }
    (format!("{what} failed ({status}). stdout: {stdout} stderr: {stderr}")).into()
}

/// Parse the major version out of `node --version` output ("v16.17.0" -> 16).
fn node_major_version(version_output: &str) -> Option<u32> {
    version_output
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Playwright 1.60+ requires Node 18+. A system Node that's too old fails the
/// capture with Playwright's raw "You are running Node.js 16..." dump — check
/// up front and return an actionable, expected error instead (issue #440).
/// If the probe itself fails, let the capture proceed and surface its own error.
async fn ensure_node_supports_playwright() -> Result<(), CommandError> {
    let mut cmd = node_tool_command("node");
    cmd.arg("--version");
    let Ok(output) =
        run_with_timeout(tokio::process::Command::from(cmd), "node --version", 10).await
    else {
        return Ok(());
    };
    if !output.status.success() {
        // Even `node --version` failing means node itself can't run. When the
        // stderr shows a dynamic-linker failure (Homebrew library upgraded out
        // from under node), stop here with an actionable message instead of
        // letting the capture re-hit the identical dyld dump and surface it
        // raw (issue #645). Any other probe failure stays tolerated — the
        // capture proceeds and reports its own, more specific error.
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_broken_loader_error(&stderr) {
            return Err(CommandError::expected(
                "Your system Node.js installation appears broken (it failed to start because \
                 a library it depends on is missing). Reinstall Node.js — e.g. `brew reinstall \
                 node` — then try again.",
            ));
        }
        return Ok(());
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(major) = node_major_version(&version) {
        if major < 18 {
            return Err(CommandError::expected(format!(
                "Screenshots need Node.js 18 or newer, but your system has Node {version}.                  Update Node.js, then try again."
            )));
        }
    }
    Ok(())
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
pub(super) fn get_playwright_env() -> Result<std::path::PathBuf, CommandError> {
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
                    .map_err(|e| {
                        CommandError::from(format!("Failed to upgrade playwright: {e}"))
                    })?;
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

    // Nothing below can work without npm. `node_tool_command` falls back to
    // the bare name when it can't resolve the binary, and spawning that on a
    // machine with no Node.js installed dies with Rust's raw "program not
    // found" — an unhelpful, unclassified error for what is simply a missing
    // prerequisite (issue #738, same treatment as git in #297).
    if crate::utils::find_executable("npm").is_none() {
        return Err(CommandError::expected(
            "Screenshots need Node.js (which provides npm), and it isn't installed or couldn't \
             be found. Install Node.js from https://nodejs.org, then try again.",
        ));
    }

    tracing::info!("Setting up Playwright environment at {:?}", playwright_dir);

    // Create the directory
    std::fs::create_dir_all(&playwright_dir)
        .map_err(|e| CommandError::from(format!("Failed to create playwright env dir: {e}")))?;

    // Write package.json
    let package_json = r#"{"name": "ship-studio-playwright", "private": true}"#;
    std::fs::write(playwright_dir.join("package.json"), package_json)
        .map_err(|e| CommandError::from(format!("Failed to write package.json: {e}")))?;

    // Install playwright
    tracing::info!("Installing Playwright (this may take a moment on first run)...");
    let install_output = node_tool_command("npm")
        .args(["install", PLAYWRIGHT_INSTALL_SPEC])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| CommandError::from(format!("Failed to run npm install playwright: {e}")))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        return Err(format!("Failed to install playwright: {stderr}").into());
    }

    // Install Chromium browser
    tracing::info!("Installing Chromium browser...");
    let browser_output = node_tool_command("npx")
        .args(["playwright", "install", "chromium"])
        .current_dir(&playwright_dir)
        .output()
        .map_err(|e| CommandError::from(format!("Failed to install chromium: {e}")))?;

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

    ensure_node_supports_playwright().await?;

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
        // Headless Chromium can crash at startup on some Windows GPU/driver
        // combos ("Target crashed" on newPage, before any navigation) —
        // disable the GPU like the Chrome CLI thumbnail fallback already
        // does, and relaunch once if the fresh browser process still dies
        // (issue #558).
        const newPageOptions = {{ viewport: {{ width: {viewport_width}, height: 800 }} }};
        browser = await chromium.launch({{ args: ['--disable-gpu'] }});
        let page;
        try {{
            page = await browser.newPage(newPageOptions);
        }} catch (err) {{
            if (!String((err && err.message) || err).includes('Target crashed')) throw err;
            await browser.close().catch(() => {{}});
            browser = await chromium.launch({{ args: ['--disable-gpu'] }});
            page = await browser.newPage(newPageOptions);
        }}

        // Dev servers keep HMR/live-reload connections open forever, so
        // 'networkidle' may never arrive — wait for 'load', then settle
        // best-effort without ever failing the capture on it (issues #309/#310).
        // A TCP-accepting port can still take >30s to serve `load` when the dev
        // server compiles the route on first request (issue #385): give the
        // navigation a longer budget, and retry once on timeout — the compile
        // keeps progressing server-side, so a warmed route answers quickly.
        // The retry gets double the budget: 60s twice was still not enough on
        // slow Windows dev servers (issue #606).
        try {{
            await page.goto('{}', {{ waitUntil: 'load', timeout: 60000 }});
        }} catch (err) {{
            const msg = String((err && err.message) || err);
            // A refused connection here, right after the Rust-side TCP
            // readiness check passed, means the dev server died or is
            // restarting in the gap between check and capture (issue #514) —
            // give it a short beat before the one retry. A malformed/empty
            // HTTP response is the same race caught one step later: the
            // server accepted the socket but died mid-answer while
            // restarting (issue #703) — same beat, same retry. An aborted
            // navigation (ERR_ABORTED) is the same family once more: a hot
            // reload or client-side redirect superseded this goto before
            // `load` fired (issue #782).
            if (msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_INVALID_HTTP_RESPONSE') || msg.includes('ERR_ABORTED')) {{
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }} else if (!msg.includes('Timeout')) {{
                throw err;
            }}
            await page.goto('{}', {{ waitUntil: 'load', timeout: 120000 }});
        }}
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
        // Overlay hiding is cosmetic — a dev-server reload/redirect right
        // after `load` destroys the execution context mid-evaluate, and that
        // must not kill the whole capture (issue #438).
        }}).catch(() => {{}});

        // Scroll slowly through the page to trigger lazy content and animations.
        // Capped: an infinite-scroll page would otherwise walk forever and eat
        // the whole outer budget (issue #527).
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
        const viewportHeight = 800;
        const maxScrollSteps = 40;

        for (let step = 0, y = 0; y < scrollHeight && step < maxScrollSteps; step++, y += viewportHeight / 2) {{
            await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y).catch(() => {{}});
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
        }}).catch(() => {{}});
        await page.waitForTimeout(500);

        // Chromium's CDP can refuse a screenshot outright ("Protocol error
        // (Page.captureScreenshot): Unable to capture screenshot") under
        // transient GPU/memory pressure — a known flaky Chromium failure,
        // not a page problem. Retry that exact error up to twice after a
        // short beat; anything else propagates unchanged (issue #657).
        // Retries get a short budget: this failure mode errors out quickly,
        // and the outer capture ceiling has already paid for one
        // full-length attempt.
        const screenshotWithRetry = async (options) => {{
            for (let attempt = 0; ; attempt++) {{
                try {{
                    return await page.screenshot(attempt === 0 ? options : {{ ...options, timeout: 30000 }});
                }} catch (err) {{
                    const msg = String((err && err.message) || err);
                    if (attempt >= 2 || !msg.includes('Unable to capture screenshot')) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }}
            }}
        }};

        // Take full-page screenshot
        // fullPage stitches the entire scrollable height — on tall pages
        // that can exceed Playwright's default 30s action timeout, and the
        // overall script budget leaves room for it, so give it real headroom
        // (issue #461).
        await screenshotWithRetry({{ path: '{}', fullPage: true, timeout: 120000 }});
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

    Err(capture_script_error("Playwright screenshot", &url, &output))
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

    ensure_node_supports_playwright().await?;

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
        // Headless Chromium can crash at startup on some Windows GPU/driver
        // combos ("Target crashed" on newPage, before any navigation) —
        // disable the GPU like the Chrome CLI thumbnail fallback already
        // does, and relaunch once if the fresh browser process still dies
        // (issue #558).
        const newPageOptions = {{ viewport: {{ width: {viewport_width}, height: 800 }} }};
        browser = await chromium.launch({{ args: ['--disable-gpu'] }});
        let page;
        try {{
            page = await browser.newPage(newPageOptions);
        }} catch (err) {{
            if (!String((err && err.message) || err).includes('Target crashed')) throw err;
            await browser.close().catch(() => {{}});
            browser = await chromium.launch({{ args: ['--disable-gpu'] }});
            page = await browser.newPage(newPageOptions);
        }}

        // Same wait strategy as the full-page capture: 'networkidle' may never
        // arrive on dev servers with persistent connections (issues #309/#310),
        // and a cold route compiling on first request can need >30s to reach
        // `load` — long budget plus one retry on timeout (issue #385). The
        // retry gets double the budget: on slow Windows dev servers (first
        // compile + antivirus overhead) 60s twice was still not enough, and
        // the compile keeps progressing server-side while we wait
        // (issue #606).
        try {{
            await page.goto('{}', {{ waitUntil: 'load', timeout: 60000 }});
        }} catch (err) {{
            const msg = String((err && err.message) || err);
            // A refused connection here, right after the Rust-side TCP
            // readiness check passed, means the dev server died or is
            // restarting in the gap between check and capture (issue #514) —
            // give it a short beat before the one retry. A malformed/empty
            // HTTP response is the same race caught one step later: the
            // server accepted the socket but died mid-answer while
            // restarting (issue #703) — same beat, same retry. An aborted
            // navigation (ERR_ABORTED) is the same family once more: a hot
            // reload or client-side redirect superseded this goto before
            // `load` fired (issue #782).
            if (msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_INVALID_HTTP_RESPONSE') || msg.includes('ERR_ABORTED')) {{
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }} else if (!msg.includes('Timeout')) {{
                throw err;
            }}
            await page.goto('{}', {{ waitUntil: 'load', timeout: 120000 }});
        }}
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
        // Cosmetic — see the same guard in the full-page script (issue #438).
        }}).catch(() => {{}});

        // Wait for animations to complete
        await page.waitForTimeout(3000);

        // Chromium's CDP can refuse a screenshot outright ("Protocol error
        // (Page.captureScreenshot): Unable to capture screenshot") under
        // transient GPU/memory pressure — a known flaky Chromium failure,
        // not a page problem. Retry that exact error up to twice after a
        // short beat; anything else propagates unchanged (issue #657).
        // Retries get a short budget: this failure mode errors out quickly,
        // and the outer capture ceiling has already paid for one
        // full-length attempt.
        const screenshotWithRetry = async (options) => {{
            for (let attempt = 0; ; attempt++) {{
                try {{
                    return await page.screenshot(attempt === 0 ? options : {{ ...options, timeout: 30000 }});
                }} catch (err) {{
                    const msg = String((err && err.message) || err);
                    if (attempt >= 2 || !msg.includes('Unable to capture screenshot')) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }}
            }}
        }};

        // Take viewport screenshot (not full page). Explicit timeout replaces
        // Playwright's 30s action default, which slow machines exceeded — the
        // full-page capture already has this, the viewport one was missed
        // (issue #568).
        await screenshotWithRetry({{ path: '{}', timeout: 120000 }});
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

    Err(capture_script_error(
        "Playwright viewport screenshot",
        &url,
        &output,
    ))
}

#[cfg(test)]
mod capture_error_tests {
    use super::*;

    /// A non-zero ExitStatus, built via the platform's own extension trait so
    /// these tests compile and run on Windows CI too.
    fn failed_status() -> std::process::ExitStatus {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(256)
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(1)
        }
    }

    fn failed_output(stderr: &str) -> std::process::Output {
        std::process::Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn connection_refused_after_retry_is_expected_not_telemetry() {
        // Issue #514: the server dying between readiness check and capture is
        // an expected race, not an app bug.
        let output =
            failed_output("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/");
        match capture_script_error("Playwright screenshot", "http://localhost:3000", &output) {
            CommandError::Expected { message } => {
                assert!(message.contains("stopped responding"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn invalid_http_response_after_retry_is_expected_not_telemetry() {
        // Issue #703: the dev server accepting the socket but dying mid-answer
        // (restart race) surfaces as ERR_INVALID_HTTP_RESPONSE — the same
        // expected class as the refused-connection race (#514), and it must
        // not dump raw stderr or auto-file a report.
        let output = failed_output(
            "page.goto: net::ERR_INVALID_HTTP_RESPONSE at http://localhost:3000/\nCall log:\n  - navigating to \"http://localhost:3000/\", waiting until \"load\"",
        );
        match capture_script_error("Playwright screenshot", "http://localhost:3000", &output) {
            CommandError::Expected { message } => {
                assert!(message.contains("stopped responding"), "got: {message}");
                assert!(message.contains("http://localhost:3000"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn other_failures_stay_real_errors_with_detail() {
        let output = failed_output("SyntaxError: something broke");
        let err = capture_script_error("Playwright screenshot", "http://localhost:3000", &output);
        assert!(!matches!(err, CommandError::Expected { .. }));
        assert!(format!("{err}").contains("something broke"));
    }

    #[test]
    fn broken_node_dyld_error_is_expected_with_reinstall_guidance() {
        // Issue #645: Homebrew upgraded icu4c without relinking node — node
        // itself can't start. A broken local toolchain, not an app bug.
        let output = failed_output(
            "dyld[54199]: Library not loaded: /opt/homebrew/opt/icu4c/lib/libicui18n.74.dylib\n\
             Referenced from: /opt/homebrew/Cellar/node/22.9.0/bin/node\n\
             Reason: tried: '/opt/homebrew/opt/icu4c/lib/libicui18n.74.dylib' (no such file)",
        );
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:3000",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(
                    message.contains("Node.js installation appears broken"),
                    "got: {message}"
                );
                assert!(message.contains("Reinstall Node.js"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn linux_loader_error_is_also_classified_broken_node() {
        assert!(is_broken_loader_error(
            "node: error while loading shared libraries: libicui18n.so.74: cannot open shared object file"
        ));
        assert!(!is_broken_loader_error("SyntaxError: unexpected token"));
    }

    #[test]
    fn target_crashed_is_expected_not_telemetry() {
        // Issue #558: the headless browser process dying at startup is a
        // GPU-driver / security-software environment failure.
        let output = failed_output("browser.newPage: Target crashed");
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:3000",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("browser crashed"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn cdp_unable_to_capture_screenshot_is_expected_not_telemetry() {
        // Issue #657 (same signature as #569 on the full-page path): CDP
        // refusing Page.captureScreenshot is a known transient Chromium
        // failure. The script retries it in place; one that persists is an
        // environment-level condition, not an app bug.
        let output = failed_output(
            "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\n\
             Call log:\n  - taking page screenshot\n  - waiting for fonts to load...\n  - fonts loaded",
        );
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:3000",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("couldn't render"), "got: {message}");
                assert!(message.contains("Try again"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn goto_timeout_after_both_attempts_is_expected() {
        // Issue #606: both navigation attempts exhausting their budget on a
        // slow first compile is a recurring environmental condition.
        let output = failed_output(
            "page.goto: Timeout 120000ms exceeded.\nCall log:\n  - navigating to \"http://localhost:59973/\", waiting until \"load\"",
        );
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:59973",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("didn't finish loading"), "got: {message}");
                assert!(message.contains("http://localhost:59973"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn download_url_is_expected_with_no_retry_advice() {
        // Issue #801: a PDF/export route always aborts navigation this way —
        // deterministic, so the message must not promise a retry will help.
        let output = failed_output(
            "page.goto: Download is starting\nCall log:\n  - navigating to \"http://localhost:58648/api/facturen/1/pdf\", waiting until \"load\"",
        );
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:58648/api/facturen/1/pdf",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("file download"), "got: {message}");
                assert!(message.contains("/api/facturen/1/pdf"), "got: {message}");
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn aborted_navigation_is_expected_reload_race() {
        // Issue #782: a hot reload or redirect superseding the goto.
        let output = failed_output(
            "page.goto: net::ERR_ABORTED at http://localhost:51379/opa\nCall log:\n  - navigating to \"http://localhost:51379/opa\", waiting until \"load\"",
        );
        match capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:51379/opa",
            &output,
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("was interrupted"), "got: {message}");
                assert!(
                    message.contains("http://localhost:51379/opa"),
                    "got: {message}"
                );
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn closed_target_mid_capture_is_expected_not_telemetry() {
        // Issue #815: the renderer dying after a successful navigation.
        let output =
            failed_output("page.screenshot: Target page, context or browser has been closed");
        match capture_script_error("Playwright screenshot", "http://localhost:3000", &output) {
            CommandError::Expected { message } => {
                assert!(message.contains("closed unexpectedly"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn silent_failure_still_names_the_exit_status() {
        // Issue #829: no stdout, no stderr — the exit status is the only
        // signal there is, so the message must carry it.
        let output = failed_output("");
        let err = capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:3000",
            &output,
        );
        assert!(!matches!(err, CommandError::Expected { .. }));
        let message = format!("{err}");
        assert!(message.contains("no output at all"), "got: {message}");
        assert!(
            message.contains("exit code") || message.contains("killed by signal"),
            "got: {message}"
        );
    }

    #[test]
    fn empty_stderr_install_failure_still_says_something_actionable() {
        // Issue #796: the reinstall exiting non-zero with no output at all
        // used to produce a message that trailed off after the colon.
        let err = browser_install_error(&failed_output(""));
        assert!(!matches!(err, CommandError::Expected { .. }));
        let message = format!("{err}");
        assert!(
            message.contains("exit code") || message.contains("killed by signal"),
            "got: {message}"
        );
        assert!(
            message.contains("npx playwright install chromium"),
            "got: {message}"
        );
    }

    #[test]
    fn network_install_failure_is_expected_with_connection_guidance() {
        let err = browser_install_error(&failed_output(
            "Error: getaddrinfo ENOTFOUND cdn.playwright.dev",
        ));
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("internet connection"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn disk_full_install_failure_is_expected_with_disk_guidance() {
        let err = browser_install_error(&failed_output("Error: ENOSPC: no space left on device"));
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("out of disk"), "got: {message}")
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }

    #[test]
    fn non_goto_timeouts_are_not_swallowed_as_expected() {
        // A timeout elsewhere (e.g. the screenshot action) isn't the
        // slow-compile navigation shape — keep it a real, detailed error.
        let output = failed_output("page.screenshot: Timeout 120000ms exceeded.");
        let err = capture_script_error(
            "Playwright viewport screenshot",
            "http://localhost:3000",
            &output,
        );
        assert!(!matches!(err, CommandError::Expected { .. }));
    }
}

#[cfg(test)]
mod node_version_tests {
    use super::*;

    #[test]
    fn parses_standard_node_version_output() {
        assert_eq!(node_major_version("v16.17.0\n"), Some(16));
        assert_eq!(node_major_version("v18.20.4"), Some(18));
        assert_eq!(node_major_version("v22.1.0"), Some(22));
    }

    #[test]
    fn garbage_output_is_none_not_a_false_block() {
        // An unparseable probe must never block captures (issue #440).
        assert_eq!(node_major_version(""), None);
        assert_eq!(node_major_version("command not found"), None);
    }
}
