//! # Installation Commands
//!
//! Commands for installing tools via Homebrew (macOS/Linux) or Winget (Windows).
//! Includes npm cache permission checking.

use super::{is_mock_mode, mock_install};
use crate::errors::CommandError;
use crate::utils::{create_command, get_brew_command};
use tauri::Emitter;

#[cfg(windows)]
use crate::utils::get_winget_command;

/// Install Homebrew
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_homebrew(app: tauri::AppHandle) -> Result<(), CommandError> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "homebrew",
            "message": "Installing package manager..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("homebrew");
        return Ok(());
    }

    let output = create_command("bash")
        .args(["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""])
        .env("NONINTERACTIVE", "1")
        .output()
        .map_err(|e| format!("Failed to run Homebrew installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((format!("Homebrew installation failed: {stderr}")).into());
    }

    Ok(())
}

/// Install Node.js via Homebrew
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_node_via_brew(app: tauri::AppHandle) -> Result<(), CommandError> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "node",
            "message": "Installing Node.js..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("node");
        return Ok(());
    }

    let brew = get_brew_command().ok_or(
        "Homebrew is needed to install this. Install Homebrew from the Package Manager step first, then try again.",
    )?;

    let output = create_command(&brew)
        .args(["install", "node"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_brew_failure("Failed to install Node.js", &stderr));
    }

    Ok(())
}

/// Install Git via Homebrew
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_git_via_brew(app: tauri::AppHandle) -> Result<(), CommandError> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "git",
            "message": "Installing Git..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("git");
        return Ok(());
    }

    let brew = get_brew_command().ok_or(
        "Homebrew is needed to install this. Install Homebrew from the Package Manager step first, then try again.",
    )?;

    let output = create_command(&brew)
        .args(["install", "git"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_brew_failure("Failed to install Git", &stderr));
    }

    Ok(())
}

/// Install GitHub CLI via Homebrew
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_gh_via_brew(app: tauri::AppHandle) -> Result<(), CommandError> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "gh",
            "message": "Installing GitHub CLI..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        mock_install("gh");
        return Ok(());
    }

    let brew = get_brew_command().ok_or(
        "Homebrew is needed to install this. Install Homebrew from the Package Manager step first, then try again.",
    )?;

    let output = create_command(&brew)
        .args(["install", "gh"])
        .env("HOMEBREW_NO_AUTO_UPDATE", "1") // Skip auto-update for faster install
        .output()
        .map_err(|e| format!("Failed to run brew: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_brew_failure(
            "Failed to install GitHub CLI",
            &stderr,
        ));
    }

    Ok(())
}

/// Batch install multiple Homebrew packages in a single command.
/// This is faster than individual installs because:
/// 1. Auto-update only runs once
/// 2. Homebrew can download bottles in parallel
///
/// Mapping from item IDs to brew package names:
/// - node -> node
/// - git -> git
/// - gh -> gh
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_brew_packages(
    app: tauri::AppHandle,
    packages: Vec<String>,
) -> Result<(), CommandError> {
    if packages.is_empty() {
        return Ok(());
    }

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "brew_batch",
            "message": format!("Installing {}...", packages.join(", "))
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        for pkg in &packages {
            mock_install(pkg);
        }
        return Ok(());
    }

    let brew = get_brew_command().ok_or(
        "Homebrew is needed to install this. Install Homebrew from the Package Manager step first, then try again.",
    )?;

    let brew_packages: Vec<&str> = packages.iter().map(|p| p.as_str()).collect();

    let mut args = vec!["install"];
    args.extend(brew_packages.iter().copied());

    let output = create_command(&brew)
        .args(&args)
        // Allow auto-update since it only runs once for all packages
        .output()
        .map_err(|e| format!("Failed to run brew: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(humanize_brew_failure("Failed to install packages", &stderr));
    }

    Ok(())
}

/// Turn a failed `brew` run's stderr into an actionable `CommandError`.
///
/// Homebrew failures fall into a few recurring machine-state buckets that the
/// generic "first stderr line" fallback used to mangle (issues #448, #571,
/// #580, #581). Known-bad-environment states become `Expected` (they're not
/// app malfunctions, so they stay out of telemetry) with Homebrew's own
/// remediation; everything else surfaces the *actual* error line instead of
/// whatever progress banner happened to be printed first.
fn humanize_brew_failure(context: &str, stderr: &str) -> crate::errors::CommandError {
    // "prefix isn't writable" — left behind by a prior sudo/multi-user
    // install (issue #448).
    if let Some(err) = brew_permission_error(stderr) {
        return err;
    }

    // "A legacy DSL was used" — Homebrew rejecting a pre-1.0 formula file,
    // which means a very stale or corrupted local formula database, not a
    // problem with the package itself (issue #581).
    if stderr.contains("legacy DSL") {
        return crate::errors::CommandError::expected(format!(
            "{context}: your Homebrew formula database is stale or corrupted \
             (Homebrew reported a \"legacy DSL\" formula error). Open Terminal and run: \
             brew update-reset — then retry this step."
        ));
    }

    // version.rb TypeError ("Version value must be a string; got a NilClass")
    // — Homebrew's own Ruby crashing because it can't read the macOS version;
    // a broken/mixed Homebrew install, not something the app did (issue #571).
    if stderr.contains("Version value must be a string") {
        return crate::errors::CommandError::expected(format!(
            "{context}: your Homebrew installation is in a broken state (it crashed while \
             reading your macOS version). Open Terminal and run: brew update-reset — and if \
             that doesn't help, reinstall the Xcode Command Line Tools with: \
             xcode-select --install — then retry this step."
        ));
    }

    // Generic failure: surface the real error, not brew's auto-update banner.
    (format!("{context}: {}", brew_error_line(stderr))).into()
}

/// Pick the most meaningful line out of brew's stderr.
///
/// The batch installer allows brew's auto-update to run, so stderr routinely
/// *starts* with progress banners ("Updating Homebrew...", "==> Downloading
/// ...") before the actual failure appears further down — naively taking the
/// first line surfaces the banner and swallows the error (issue #580).
/// Prefer the first `Error:` line (brew prefixes real errors with it); fall
/// back to the last non-banner line.
fn brew_error_line(stderr: &str) -> &str {
    let is_banner = |l: &str| {
        l.is_empty()
            || l.starts_with("==>")
            || l.starts_with("Updating Homebrew")
            || l.starts_with("Warning:")
            || l.chars()
                .all(|c| matches!(c, '#' | '%' | '.' | ' ' | '-' | '=') || c.is_ascii_digit())
    };
    let mut lines = stderr.lines().map(str::trim);
    if let Some(err) = lines.clone().find(|l| l.starts_with("Error:")) {
        return err;
    }
    lines.rfind(|l| !is_banner(l)).unwrap_or("Unknown error")
}

/// Homebrew's "prefix isn't writable" failure — a machine state left behind by
/// a prior `sudo brew` or multi-user install, not an app malfunction. Surface
/// Homebrew's own remediation instead of the bare first stderr line
/// (issue #448).
fn brew_permission_error(stderr: &str) -> Option<crate::errors::CommandError> {
    if stderr.contains("is not writable") {
        // brew names the offending path in the same message; fall back to the
        // standard prefix if the format ever changes.
        let prefix = stderr
            .lines()
            .find(|l| l.contains("is not writable"))
            .and_then(|l| l.split_whitespace().find(|w| w.starts_with('/')))
            .unwrap_or("$(brew --prefix)");
        return Some(crate::errors::CommandError::expected(format!(
            "Homebrew can't install anything because {prefix} isn't writable by your user          (usually left over from a previous sudo or multi-user install). Open Terminal and run:          sudo chown -R $(whoami) {prefix} — then retry this step."
        )));
    }

    // Ruby's raw EACCES, surfaced when Homebrew's own preflight check didn't
    // catch the bad ownership and FileUtils hits it mid-operation instead
    // (e.g. staging a reinstall into the Cellar). Same leftover-ownership
    // state as the "is not writable" case above, different wording
    // (issue #736).
    if let Some(line) = stderr
        .lines()
        .find(|l| l.to_lowercase().contains("permission denied @ apply2files"))
    {
        let path = line
            .split_once(" - ")
            .map(|(_, path)| path.trim())
            .filter(|p| p.starts_with('/'))
            .unwrap_or("$(brew --prefix)");
        return Some(crate::errors::CommandError::expected(format!(
            "Homebrew couldn't change {path} because it isn't owned by your user (usually \
             left over from a previous sudo or multi-user install). Open Terminal and run: \
             sudo chown -R $(whoami) $(brew --prefix) — then retry this step."
        )));
    }

    None
}

/// Pull a human-readable error line out of winget's output.
///
/// winget renders download progress with carriage returns (`\r`) rather than
/// newlines, so a naive `lines().next()` returns the entire progress animation
/// as one giant line (the "[object Object]"-era wall of progress bars). Here we
/// normalize CR→LF, drop blank and progress-only segments (block-bar glyphs and
/// bare size/percent readouts), and return the last meaningful line — which on
/// a failed install is the actual error (e.g. "failed when searching source:
/// msstore").
///
/// winget also ends a failed *installer* run with a "Installer log is available
/// at: <path>" line, which would otherwise win as the "last meaningful line"
/// and hide the real reason a line or two above it (issue #745) — the same
/// trailing-noise problem `brew_error_line` solves for Homebrew's banners.
#[cfg_attr(not(windows), allow(dead_code))]
fn extract_winget_error(stderr: &str, stdout: &str) -> String {
    let is_progress_only = |l: &str| {
        l.chars().all(|c| {
            c.is_ascii_digit() || matches!(c, '%' | '.' | ' ' | '/' | '█' | '▒' | '░' | '-')
        }) || l.contains('█')
            || l.contains('▒')
            || l.contains('░')
    };
    // Pointers to a log file the user would have to open themselves — never
    // the error itself.
    let is_log_pointer = |l: &str| {
        let lower = l.to_lowercase();
        lower.starts_with("installer log is available at")
            || lower.starts_with("please refer to the log")
    };
    format!("{stderr}\n{stdout}")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|&l| !l.is_empty() && !is_progress_only(l) && !is_log_pointer(l))
        .last()
        .unwrap_or("Unknown error")
        .to_string()
}

/// winget failing only in its *post-install cleanup* step: it deletes the
/// downloaded installer from `%TEMP%\WinGet\...` after running it, and that
/// delete loses a race against antivirus (or the installer itself) still
/// holding the file open. The package is usually installed by then, so this
/// exit code says nothing about whether the install worked (issue #780).
#[cfg_attr(not(windows), allow(dead_code))]
fn is_winget_cleanup_race(stderr: &str, stdout: &str) -> bool {
    let combined = format!("{stderr}\n{stdout}").to_lowercase();
    combined.contains("remove:") && combined.contains("being used by another process")
}

/// Turn a winget *spawn* failure (the process never started, so there's no
/// output to classify) into a user-facing error.
///
/// `which::which("winget")` resolves to the App Execution Alias stub under
/// `%LOCALAPPDATA%\Microsoft\WindowsApps`, which isn't a real binary. Windows
/// refuses to launch it with ERROR_CANT_ACCESS_FILE (os error 1920) when the
/// alias is switched off, App Installer is mid-update, or endpoint software
/// intercepts alias stubs — all environment states, not app malfunctions
/// (issue #810).
#[cfg_attr(not(windows), allow(dead_code))]
fn winget_spawn_error(err: &std::io::Error) -> CommandError {
    if err.raw_os_error() == Some(1920) {
        return CommandError::expected(
            "Windows wouldn't let Ship Studio start winget (the App Installer alias is \
             turned off or needs repairing). Open Settings → Apps → Advanced app settings → \
             App execution aliases and switch on \"App Installer (winget.exe)\", or update \
             App Installer from the Microsoft Store, then try again."
                .to_string(),
        );
    }
    (format!("Failed to run winget: {err}")).into()
}

/// Ask winget whether `package` is installed. Used to tell a genuine install
/// failure apart from a cleanup-only failure (issue #780); any error answering
/// the question counts as "not installed" so we never claim success blindly.
#[cfg(windows)]
fn winget_package_installed(winget: &std::path::Path, package: &str) -> bool {
    create_command(winget)
        .args([
            "list",
            "--id",
            package,
            "--exact",
            "--disable-interactivity",
            "--accept-source-agreements",
        ])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(package))
        .unwrap_or(false)
}

/// Batch install multiple packages via Winget (Windows only).
/// This is the Windows equivalent of install_brew_packages.
///
/// Mapping from item IDs to winget package IDs:
/// - node -> OpenJS.NodeJS
/// - git -> Git.Git
/// - gh -> GitHub.cli
#[cfg(windows)]
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn install_winget_packages(
    app: tauri::AppHandle,
    packages: Vec<String>,
) -> Result<(), CommandError> {
    if packages.is_empty() {
        return Ok(());
    }

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "winget_batch",
            "message": format!("Installing {}...", packages.join(", "))
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        for pkg in &packages {
            mock_install(pkg);
        }
        return Ok(());
    }

    let winget = get_winget_command().ok_or("Winget not found")?;

    // Map item IDs to actual winget package IDs
    let winget_packages: Vec<&str> = packages
        .iter()
        .filter_map(|p| match p.as_str() {
            "node" => Some("OpenJS.NodeJS"),
            "git" => Some("Git.Git"),
            "gh" => Some("GitHub.cli"),
            _ => None,
        })
        .collect();

    if winget_packages.is_empty() {
        return Ok(());
    }

    // Install packages one at a time (winget doesn't support batch installs well)
    for package in winget_packages {
        let output = create_command(&winget)
            .args([
                "install",
                "--id",
                package,
                "--exact",
                // Scope the search to the community `winget` source. Without
                // this, winget also searches `msstore`, which needs Store
                // sign-in and fails in this silent/headless context with
                // "failed when searching source: msstore" — sinking the whole
                // install even though the package lives in the winget source.
                // All packages we install (OpenJS.NodeJS, Git.Git, GitHub.cli)
                // are in the winget source, so this is safe.
                "--source",
                "winget",
                "--silent",
                // Never block on an interactive prompt in a headless install.
                "--disable-interactivity",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .output()
            .map_err(|e| winget_spawn_error(&e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Don't fail if package is already installed
            if stdout.contains("already installed") || stderr.contains("already installed") {
                continue;
            }
            // winget's temp-file cleanup lost a race with antivirus. The
            // install step already ran, so ask winget whether the package
            // landed before calling this a failure (issue #780).
            if is_winget_cleanup_race(&stderr, &stdout) {
                if winget_package_installed(&winget, package) {
                    tracing::warn!(
                        package,
                        "winget installed the package but couldn't delete its temporary \
                         installer file; treating the install as successful"
                    );
                    continue;
                }
                return Err(CommandError::expected(format!(
                    "Windows couldn't finish installing {package} because another program \
                     (usually antivirus) still had winget's temporary installer file open. \
                     Try this step again in a moment."
                )));
            }
            return Err((format!(
                "Failed to install {}: {}",
                package,
                extract_winget_error(&stderr, &stdout)
            ))
            .into());
        }
    }

    Ok(())
}

// Stub for non-Windows platforms
#[cfg(not(windows))]
#[tauri::command]
#[tracing::instrument(skip(_app))]
pub async fn install_winget_packages(
    _app: tauri::AppHandle,
    _packages: Vec<String>,
) -> Result<(), CommandError> {
    Err(("Winget is only available on Windows".to_string()).into())
}

/// Check if the npm cache directory (~/.npm) is writable by the current user.
/// Returns "ok" if writable or doesn't exist, "not_writable" if it exists but isn't writable.
#[tauri::command]
#[tracing::instrument]
pub async fn check_npm_cache_permissions() -> String {
    if let Some(home) = dirs::home_dir() {
        let npm_cache = home.join(".npm");
        if !npm_cache.exists() {
            return "ok".to_string();
        }

        // Try to create and delete a temp file to test write access
        let test_file = npm_cache.join(".shipstudio-write-test");
        match std::fs::write(&test_file, "test") {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
                "ok".to_string()
            }
            Err(_) => "not_writable".to_string(),
        }
    } else {
        "ok".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        brew_error_line, extract_winget_error, humanize_brew_failure, is_winget_cleanup_race,
        winget_spawn_error,
    };
    use crate::errors::CommandError;

    /// Issue #580: brew's auto-update banner must never be surfaced as *the*
    /// error — the real failure appears further down stderr.
    #[test]
    fn skips_updating_homebrew_banner_and_finds_real_error() {
        let stderr = "Updating Homebrew...\n\
                      ==> Downloading https://formulae.brew.sh/api/formula.jws.json\n\
                      Error: node: no bottle available!\n\
                      You can try to install from source with:\n  brew install --build-from-source node";
        let err = humanize_brew_failure("Failed to install packages", stderr);
        let msg = err.to_string();
        assert!(
            msg.contains("Error: node: no bottle available!"),
            "got: {msg}"
        );
        assert!(!msg.contains("Updating Homebrew"), "got: {msg}");
        // An unknown brew failure stays reportable (not Expected).
        assert!(!matches!(err, CommandError::Expected { .. }));
    }

    #[test]
    fn falls_back_to_last_meaningful_line_without_error_prefix() {
        let stderr = "Updating Homebrew...\n\
                      ==> Fetching node\n\
                      ########## 45.0%\n\
                      curl: (28) Operation timed out\n";
        assert_eq!(brew_error_line(stderr), "curl: (28) Operation timed out");
    }

    #[test]
    fn all_banner_stderr_falls_back_to_unknown() {
        assert_eq!(
            brew_error_line("Updating Homebrew...\n==> Fetching\n"),
            "Unknown error"
        );
        assert_eq!(brew_error_line(""), "Unknown error");
    }

    /// Issue #581: a "legacy DSL" formula error means the local formula
    /// database is stale/corrupted — Expected, with `brew update-reset` advice.
    #[test]
    fn legacy_dsl_is_expected_with_update_reset_advice() {
        let stderr = "Updating Homebrew...\n\
                      Error: A legacy DSL was used: sha256 ({\"d7f992eb\" => :catalina})";
        let err = humanize_brew_failure("Failed to install packages", stderr);
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains("brew update-reset"), "got: {msg}");
    }

    /// Issue #571: Homebrew's version.rb TypeError is a broken Homebrew
    /// environment — Expected, advising update-reset / reinstalling CLT.
    #[test]
    fn version_rb_crash_is_expected_with_guidance() {
        let stderr = "/usr/local/Homebrew/Library/Homebrew/version.rb:368:in `initialize': \
                      Version value must be a string; got a NilClass () (TypeError)";
        let err = humanize_brew_failure("Failed to install packages", stderr);
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains("brew update-reset"), "got: {msg}");
        assert!(msg.contains("xcode-select --install"), "got: {msg}");
    }

    /// Issue #448 regression guard: the permission classification still wins.
    #[test]
    fn permission_error_still_classified() {
        let stderr = "Error: The following directories are not writable by your user:\n\
                      /opt/homebrew/lib is not writable";
        let err = humanize_brew_failure("Failed to install packages", stderr);
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        assert!(err.to_string().contains("sudo chown"), "got: {err}");
    }

    /// Issue #736: Ruby's raw EACCES wording is the same leftover-ownership
    /// state as #448 — Expected, with the offending path and chown advice.
    #[test]
    fn ruby_apply2files_permission_denied_is_expected() {
        let stderr = "Error: Permission denied @ apply2files - \
                      /opt/homebrew/Cellar/mongodb-community/8.2.7.reinstall/bin/mongod";
        let err = humanize_brew_failure("Failed to install packages", stderr);
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        let msg = err.to_string();
        assert!(
            msg.contains("/opt/homebrew/Cellar/mongodb-community/8.2.7.reinstall/bin/mongod"),
            "got: {msg}"
        );
        assert!(msg.contains("sudo chown -R $(whoami)"), "got: {msg}");
    }

    /// Issue #745: the trailing "Installer log is available at" pointer must
    /// never win over the real error line above it.
    #[test]
    fn winget_error_skips_installer_log_pointer() {
        let stdout = "Found Git [Git.Git]\r\
                      ██████  50.0%\r\n\
                      Installer failed with exit code: 1603\n\
                      Installer log is available at: C:\\Users\\me\\AppData\\Local\\Temp\\WinGet\\x.log\n";
        assert_eq!(
            extract_winget_error("", stdout),
            "Installer failed with exit code: 1603"
        );
    }

    #[test]
    fn winget_error_still_returns_last_real_line() {
        assert_eq!(
            extract_winget_error("failed when searching source: msstore", ""),
            "failed when searching source: msstore"
        );
        assert_eq!(extract_winget_error("", ""), "Unknown error");
    }

    /// Issue #780: winget's post-install temp-file delete losing a race with
    /// antivirus is a cleanup-only failure, recognizable from its wording.
    #[test]
    fn recognizes_winget_cleanup_race() {
        let stderr = "remove: The process cannot access the file because it is being used by \
                      another process.: \"C:\\Users\\me\\AppData\\Local\\Temp\\WinGet\\GitHub.cli.2.97.0\\abc\"";
        assert!(is_winget_cleanup_race(stderr, ""));
        assert!(is_winget_cleanup_race("", stderr));
        assert!(!is_winget_cleanup_race(
            "failed when searching source: msstore",
            ""
        ));
    }

    /// Issue #810: ERROR_CANT_ACCESS_FILE spawning the App Execution Alias is
    /// an environment state — Expected, with alias/Store guidance.
    #[test]
    fn winget_alias_spawn_failure_is_expected() {
        let err = winget_spawn_error(&std::io::Error::from_raw_os_error(1920));
        assert!(matches!(err, CommandError::Expected { .. }), "got: {err:?}");
        let msg = err.to_string();
        assert!(msg.contains("App execution aliases"), "got: {msg}");
        assert!(msg.contains("App Installer"), "got: {msg}");

        // Any other spawn failure stays reportable.
        let other = winget_spawn_error(&std::io::Error::from_raw_os_error(2));
        assert!(
            !matches!(other, CommandError::Expected { .. }),
            "got: {other:?}"
        );
        assert!(
            other.to_string().contains("Failed to run winget"),
            "got: {other}"
        );
    }
}
