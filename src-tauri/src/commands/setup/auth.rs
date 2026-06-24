//! # Authentication & Version Management
//!
//! Commands for GitHub/agent authentication flows, auth process cleanup,
//! version rewinding (download + install), and system architecture detection.

use super::{is_mock_installed, is_mock_mode, mock_install, AUTH_PIDS};
use crate::agent::{get_active_agent, get_agent_by_id};
use crate::commands::accounts::{
    agent_auth_dir, get_active_account_id, get_env_vars_for_active_account,
};
use crate::commands::claude::find_binary_by_name;
use crate::errors::CommandError;
use crate::utils::{create_command, find_executable};
use tauri::Emitter;

/// Start GitHub authentication (opens browser)
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn start_github_auth(app: tauri::AppHandle) -> Result<String, CommandError> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "gh_auth",
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("gh_auth");
        return Ok("Mock auth completed".to_string());
    }

    let gh_path = find_executable("gh").ok_or("GitHub CLI not installed")?;

    let child = create_command(&gh_path)
        .args([
            "auth",
            "login",
            "--web",
            "--git-protocol",
            "https",
            "--clipboard",
        ])
        .envs(get_env_vars_for_active_account())
        .spawn()
        .map_err(|e| format!("Failed to start GitHub auth: {e}"))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert("github".to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove("github");
        }
    });

    Ok("A code has been copied to your clipboard. Paste it in the browser to connect.".to_string())
}

/// Start agent authentication.
/// If `agent_id` is provided, authenticate that specific agent. Otherwise, use the active agent.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn start_claude_auth(
    app: tauri::AppHandle,
    agent_id: Option<String>,
) -> Result<String, CommandError> {
    let agent = match agent_id.as_deref() {
        Some(id) => get_agent_by_id(id),
        None => get_active_agent(),
    };

    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": agent.setup_item_ids.1,
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install(agent.setup_item_ids.1);
        return Ok("Mock auth completed".to_string());
    }

    let agent_path = find_binary_by_name(agent.binary_name)
        .ok_or(format!("{} not installed", agent.display_name))?;

    let child = create_command(&agent_path)
        .args(agent.auth_trigger_args)
        .envs(get_env_vars_for_active_account())
        .spawn()
        .map_err(|e| format!("Failed to start {} auth: {}", agent.display_name, e))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert(agent.id.to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    let agent_id_str = agent.id.to_string();
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove(&agent_id_str);
        }
    });

    Ok(format!(
        "Browser opened. Log in to your {} account to continue.",
        agent.display_name
    ))
}

/// Check if an agent is authenticated.
/// If `agent_id` is provided, check that specific agent. Otherwise, use the active agent.
#[tauri::command]
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
    let agent_dir = agent_auth_dir(&active_account_id, agent);
    agent.auth_indicators.iter().any(|indicator| {
        let path = agent_dir.join(indicator);
        path.exists()
    })
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

/// Kill all tracked auth processes (Tauri command wrapper).
///
/// This is useful for cleanup when closing the app to prevent orphaned processes.
/// Returns the number of processes that were killed.
#[tauri::command]
#[tracing::instrument]
pub async fn cleanup_auth_processes() -> Result<u32, CommandError> {
    Ok(cleanup_auth_processes_sync())
}

/// Get the system CPU architecture (e.g., "aarch64" or "x86_64").
#[tauri::command]
#[tracing::instrument]
pub fn get_system_arch() -> String {
    std::env::consts::ARCH.to_string()
}

/// Download and install a specific app version (for downgrading/rewinding).
///
/// On macOS: downloads the .tar.gz update bundle, extracts, and swaps the .app bundle.
/// On Windows: downloads the .nsis.zip, extracts, and runs the NSIS installer silently.
/// The frontend should call `relaunch()` after this completes (macOS only;
/// on Windows the installer handles restart).
#[tauri::command]
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
        "https://github.com/ship-studio/releases/releases/download/v{version}/ShipStudio_darwin-{arch_suffix}.app.tar.gz"
    );

    // Find current app bundle path (e.g., /Applications/Ship Studio.app)
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find app path: {e}"))?;
    let app_bundle = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Ship Studio.app
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
    let extracted_app = extract_dir.join("Ship Studio.app");
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
        "https://github.com/ship-studio/releases/releases/download/v{}/ShipStudio_windows-x86_64.nsis.zip",
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
