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
        return Err((format!("Failed to install Node.js: {stderr}")).into());
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
        return Err((format!("Failed to install Git: {stderr}")).into());
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
        return Err((format!("Failed to install GitHub CLI: {stderr}")).into());
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
        return Err((format!(
            "Failed to install packages: {}",
            stderr.lines().next().unwrap_or("Unknown error")
        ))
        .into());
    }

    Ok(())
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
#[cfg(windows)]
fn extract_winget_error(stderr: &str, stdout: &str) -> String {
    let is_progress_only = |l: &str| {
        l.chars().all(|c| {
            c.is_ascii_digit() || matches!(c, '%' | '.' | ' ' | '/' | '█' | '▒' | '░' | '-')
        }) || l.contains('█')
            || l.contains('▒')
            || l.contains('░')
    };
    format!("{stderr}\n{stdout}")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|&l| !l.is_empty() && !is_progress_only(l))
        .last()
        .unwrap_or("Unknown error")
        .to_string()
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
            .map_err(|e| format!("Failed to run winget: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Don't fail if package is already installed
            if !stdout.contains("already installed") && !stderr.contains("already installed") {
                return Err((format!(
                    "Failed to install {}: {}",
                    package,
                    extract_winget_error(&stderr, &stdout)
                ))
                .into());
            }
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
