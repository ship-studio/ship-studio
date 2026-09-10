//! # Authentication & Version Management
//!
//! Commands for GitHub/agent authentication flows, auth process cleanup,
//! version rewinding (download + install), and system architecture detection.

use super::{is_mock_installed, is_mock_mode, AUTH_PIDS};
use crate::agent::{get_active_agent, get_agent_by_id};
use crate::commands::accounts::{
    agent_auth_dir, claude_cli_auth_status, get_active_account_id, resolve_claude_identity,
    ClaudeConnState, DEFAULT_ACCOUNT_ID,
};
use crate::commands::claude::find_binary_by_name;
use crate::errors::CommandError;
use crate::utils::create_command;
use tauri::Emitter;

/// Check if an agent is authenticated.
/// If `agent_id` is provided, check that specific agent. Otherwise, use the active agent.
#[ship_studio_macros::ship_command]
#[tracing::instrument]
pub async fn check_claude_auth_status(agent_id: Option<String>) -> bool {
    let agent = match agent_id.as_deref() {
        Some(id) => get_agent_by_id(id),
        None => get_active_agent(),
    };

    if is_mock_mode() {
        return is_mock_installed(agent.setup_item_ids.1);
    }

    if find_binary_by_name(agent.binary_name).is_none() {
        return false;
    }

    // Keychain-based agents (Cursor): ask the CLI rather than checking files.
    if let Some(authed) = crate::commands::setup::agents::agent_command_auth_status(agent) {
        return authed;
    }

    let active_account_id = get_active_account_id().unwrap_or_else(|_| "default".to_string());

    if agent.id == "claude-code" {
        return claude_auth_truth(&active_account_id).await;
    }

    let agent_dir = agent_auth_dir(&active_account_id, agent);
    agent.auth_indicators.iter().any(|indicator| {
        let path = agent_dir.join(indicator);
        path.exists()
    })
}

/// THE single source of truth for "is Claude signed in" for an account.
///
/// Every surface that answers this question (the onboarding checklist item in
/// `get_full_setup_status`, the wizard pre-checks, the dashboard) must go
/// through here — two probes with different answers deadlock the UI: the
/// "Connect" button trusts one and skips the login terminal, the checklist
/// trusts the other and never turns green (issue #159, and its fresh-machine
/// mirror where a mid-OAuth CLI says logged-in before any indicator files
/// exist).
///
/// Order of truth: isolated workspaces are vault-driven; the Default
/// workspace asks the CLI's native keychain login; file indicators are only
/// the fallback for when the CLI can't answer (e.g. an older binary without
/// `auth status`). The verdict and which source produced it are logged so a
/// field report with a log file answers "which probe lied" immediately.
pub async fn claude_auth_truth(account_id: &str) -> bool {
    if account_id != DEFAULT_ACCOUNT_ID {
        // NeedsReconnect (expired token) counts as not authenticated so the
        // wizard prompts a reconnect instead of green-lighting a dead token.
        let identity = resolve_claude_identity(account_id).await;
        let authed = identity.state == ClaudeConnState::Connected;
        tracing::info!(account_id, authed, source = "vault", "claude auth verdict");
        return authed;
    }
    if let Some((logged_in, _email)) = claude_cli_auth_status().await {
        tracing::info!(authed = logged_in, source = "cli", "claude auth verdict");
        return logged_in;
    }
    let agent_dir = agent_auth_dir(account_id, crate::agent::get_agent_by_id("claude-code"));
    let authed = crate::agent::get_agent_by_id("claude-code")
        .auth_indicators
        .iter()
        .any(|indicator| agent_dir.join(indicator).exists());
    tracing::info!(authed, source = "file_fallback", "claude auth verdict");
    authed
}

/// Kill all tracked auth processes (synchronous helper).
///
/// This is useful for cleanup when closing the app to prevent orphaned processes.
/// Returns the number of processes that were killed.
pub fn cleanup_auth_processes_sync() -> u32 {
    let pids: Vec<(String, u32)> = {
        match AUTH_PIDS.lock() {
            Ok(pids) => pids.iter().map(|(k, &v)| (k.clone(), v)).collect(),
            Err(_) => return 0,
        }
    };

    let count = pids.len() as u32;

    for (_auth_type, pid) in pids {
        #[cfg(unix)]
        {
            // Send SIGTERM for graceful shutdown
            let _ = create_command("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = create_command("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }
    }

    // Clear the registry
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.clear();
    }

    count
}

/// Download and install a specific app version (for downgrading/rewinding).
///
/// On macOS: downloads the .tar.gz update bundle, extracts, and swaps the .app bundle.
/// On Windows: downloads the .nsis.zip, extracts, and runs the NSIS installer silently.
/// The frontend should call `relaunch()` after this completes (macOS only;
/// on Windows the installer handles restart).
#[ship_studio_macros::ship_command]
#[tracing::instrument(skip(app))]
pub async fn install_version(app: tauri::AppHandle, version: String) -> Result<(), CommandError> {
    if cfg!(debug_assertions) {
        return Err(("Version rewind is only available in production builds.".to_string()).into());
    }

    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "downloading" }),
    );

    // Create temp directory
    let temp_dir = std::env::temp_dir().join("shipstudio-rewind");
    let _ = std::fs::remove_dir_all(&temp_dir);
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Cannot create temp dir: {e}"))?;

    let result = install_version_platform(&app, &version, &temp_dir).await;

    // Always cleanup temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    result?;

    tracing::info!("Rewind: v{} installed successfully", version);
    let _ = app.emit("rewind-progress", serde_json::json!({ "stage": "done" }));

    Ok(())
}

/// Download a file from the releases repo using curl.
async fn download_release_artifact(url: &str, dest: &std::path::Path) -> Result<(), CommandError> {
    tracing::info!("Rewind: downloading {}", url);

    let dest_str = dest
        .to_str()
        .ok_or_else(|| "Invalid UTF-8 in destination path".to_string())?;
    let download = tokio::process::Command::new("curl")
        .args(["-L", "--fail", "-o", dest_str, url])
        .output()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !download.status.success() {
        let stderr = String::from_utf8_lossy(&download.stderr);
        return Err((format!(
            "Download failed. This version may not be available.\n{}",
            stderr.lines().next().unwrap_or("")
        ))
        .into());
    }

    Ok(())
}

#[cfg(target_os = "macos")]
async fn install_version_platform(
    app: &tauri::AppHandle,
    version: &str,
    temp_dir: &std::path::Path,
) -> Result<(), CommandError> {
    let arch = std::env::consts::ARCH;
    let arch_suffix = if arch == "aarch64" {
        "aarch64"
    } else {
        "x86_64"
    };

    let url = format!(
        "https://github.com/kacigaya/harbr/releases/download/v{version}/Harbr_darwin-{arch_suffix}.app.tar.gz"
    );

    // Find current app bundle path (e.g., /Applications/Harbr.app)
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find app path: {e}"))?;
    let app_bundle = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Harbr.app
        .ok_or("Could not determine app bundle path")?
        .to_path_buf();

    tracing::info!("Rewind: app bundle at {:?}", app_bundle);

    // Download the update bundle
    let tar_path = temp_dir.join("update.tar.gz");
    download_release_artifact(&url, &tar_path).await?;

    tracing::info!("Rewind: download complete, extracting");
    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "installing" }),
    );

    // Extract the tar.gz
    let extract_dir = temp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Cannot create extract dir: {e}"))?;

    let tar_str = tar_path
        .to_str()
        .ok_or_else(|| "Invalid UTF-8 in tar path".to_string())?;
    let extract_str = extract_dir
        .to_str()
        .ok_or_else(|| "Invalid UTF-8 in extract dir path".to_string())?;
    let extract = tokio::process::Command::new("tar")
        .args(["xzf", tar_str, "-C", extract_str])
        .output()
        .await
        .map_err(|e| format!("Extraction failed: {e}"))?;

    if !extract.status.success() {
        let stderr = String::from_utf8_lossy(&extract.stderr);
        return Err((format!("Extraction failed: {stderr}")).into());
    }

    // Find the extracted .app bundle
    let extracted_app = extract_dir.join("Harbr.app");
    if !extracted_app.exists() {
        return Err(("Extracted app bundle not found".to_string()).into());
    }

    // Swap the app bundle: rename current -> .old, move new -> current, delete .old
    let backup_path = app_bundle.with_extension("app.old");
    let _ = std::fs::remove_dir_all(&backup_path);

    // Rename current app to .old (macOS allows renaming a running app)
    std::fs::rename(&app_bundle, &backup_path)
        .map_err(|e| format!("Cannot move current app: {e}"))?;

    // Move extracted app into place
    if let Err(e) = std::fs::rename(&extracted_app, &app_bundle) {
        // Restore backup on failure
        if let Err(restore_err) = std::fs::rename(&backup_path, &app_bundle) {
            tracing::warn!(
                "Failed to restore backup after install failure: {}",
                restore_err
            );
        }
        return Err((format!("Cannot install new version: {e}")).into());
    }

    // Cleanup backup
    let _ = std::fs::remove_dir_all(&backup_path);

    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_version_platform(
    app: &tauri::AppHandle,
    version: &str,
    temp_dir: &std::path::Path,
) -> Result<(), CommandError> {
    let url = format!(
        "https://github.com/kacigaya/harbr/releases/download/v{}/Harbr_windows-x86_64.nsis.zip",
        version
    );

    // Download the NSIS zip
    let zip_path = temp_dir.join("update.nsis.zip");
    download_release_artifact(&url, &zip_path).await?;

    tracing::info!("Rewind: download complete, extracting");
    let _ = app.emit(
        "rewind-progress",
        serde_json::json!({ "stage": "installing" }),
    );

    // Extract using PowerShell
    let extract_dir = temp_dir.join("extracted");
    let extract = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(),
                extract_dir.display()
            ),
        ])
        .output()
        .await
        .map_err(|e| format!("Extraction failed: {e}"))?;

    if !extract.status.success() {
        let stderr = String::from_utf8_lossy(&extract.stderr);
        return Err((format!("Extraction failed: {}", stderr)).into());
    }

    // Find the setup exe inside the extracted directory
    let setup_exe = find_setup_exe(&extract_dir)?;
    tracing::info!("Rewind: running installer {:?}", setup_exe);

    // Run the NSIS installer silently — it will close the current app,
    // install the new version, and relaunch automatically
    let install = tokio::process::Command::new(&setup_exe)
        .args(["/S", "--update"])
        .spawn()
        .map_err(|e| format!("Cannot run installer: {e}"))?;

    // Detach — the installer will handle closing this process and relaunching
    drop(install);

    Ok(())
}

/// Find the NSIS setup .exe inside an extracted directory.
#[cfg(target_os = "windows")]
fn find_setup_exe(dir: &std::path::Path) -> Result<std::path::PathBuf, CommandError> {
    for entry in walkdir::WalkDir::new(dir).max_depth(2) {
        if let Ok(entry) = entry {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with("-setup.exe") {
                    return Ok(path.to_path_buf());
                }
            }
        }
    }
    Err(("Setup installer not found in downloaded archive".to_string()).into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn install_version_platform(
    _app: &tauri::AppHandle,
    _version: &str,
    _temp_dir: &std::path::Path,
) -> Result<(), CommandError> {
    Err(("Version rewind is not yet available on this platform.".to_string()).into())
}
