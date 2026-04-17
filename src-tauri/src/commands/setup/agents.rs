//! # Agent Management Commands
//!
//! Dashboard-surfaced commands for managing AI agent installations and accounts:
//! installed/auth status, signing out, uninstalling.

use crate::agent::{get_agent_by_id, ALL_AGENTS};
use crate::commands::claude::find_binary_by_name;
use crate::errors::CommandError;
use crate::utils::create_command;
use serde::Serialize;

/// Rich per-agent status for the dashboard's Agents panel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: String,
    pub display_name: String,
    pub binary_name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub authed: bool,
    pub is_default: bool,
    pub install_supported: bool,
    pub uninstall_supported: bool,
}

/// Return the status of every known agent in a single call.
/// Avoids the N round-trips the dashboard would otherwise need.
#[tauri::command]
#[tracing::instrument]
pub async fn get_agents_status() -> Vec<AgentStatus> {
    let default_id = super::read_app_state()
        .default_agent_id
        .unwrap_or_else(|| "claude-code".to_string());

    ALL_AGENTS
        .iter()
        .map(|agent| {
            let binary_path = find_binary_by_name(agent.binary_name);
            let installed = binary_path.is_some();

            let version = binary_path.as_ref().and_then(|p| {
                create_command(p)
                    .args([agent.version_flag])
                    .output()
                    .ok()
                    .and_then(|o| {
                        if o.status.success() {
                            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                        } else {
                            None
                        }
                    })
            });

            let authed = if !installed {
                false
            } else if let Some(home) = dirs::home_dir() {
                let dir = home.join(agent.auth_config_dir);
                agent
                    .auth_indicators
                    .iter()
                    .any(|indicator| dir.join(indicator).exists())
            } else {
                false
            };

            #[cfg(windows)]
            let install_supported = agent.install_message_windows.is_some();
            #[cfg(not(windows))]
            let install_supported = agent.install_command_unix.is_some();

            #[cfg(windows)]
            let uninstall_supported = agent.uninstall_command_windows.is_some();
            #[cfg(not(windows))]
            let uninstall_supported = agent.uninstall_command_unix.is_some();

            AgentStatus {
                id: agent.id.to_string(),
                display_name: agent.display_name.to_string(),
                binary_name: agent.binary_name.to_string(),
                installed,
                version,
                authed,
                is_default: agent.id == default_id,
                install_supported,
                uninstall_supported,
            }
        })
        .collect()
}

/// Remove an agent's auth indicator files so the CLI is no longer signed in.
/// The binary itself is left intact.
#[tauri::command]
#[tracing::instrument]
pub async fn sign_out_agent(agent_id: String) -> Result<(), CommandError> {
    let agent = get_agent_by_id(&agent_id);

    // Reject unknown IDs: get_agent_by_id falls back to CLAUDE_CODE, so explicitly check.
    if agent.id != agent_id {
        return Err((format!("Unknown agent: {agent_id}")).into());
    }

    let home = dirs::home_dir().ok_or("Could not resolve home directory")?;
    let dir = home.join(agent.auth_config_dir);

    if !dir.exists() {
        // Already signed out
        return Ok(());
    }

    for indicator in agent.auth_indicators {
        let path = dir.join(indicator);
        if path.exists() {
            if path.is_dir() {
                std::fs::remove_dir_all(&path)
                    .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
            } else {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
            }
        }
    }

    tracing::info!(agent_id = agent_id.as_str(), "Agent signed out");
    Ok(())
}

/// Run the agent's uninstall command. Best-effort: the command is expected to
/// be idempotent and ignore missing files.
#[tauri::command]
#[tracing::instrument]
pub async fn uninstall_agent(agent_id: String) -> Result<String, CommandError> {
    let agent = get_agent_by_id(&agent_id);

    if agent.id != agent_id {
        return Err((format!("Unknown agent: {agent_id}")).into());
    }

    #[cfg(windows)]
    let cmd_str = agent.uninstall_command_windows;
    #[cfg(not(windows))]
    let cmd_str = agent.uninstall_command_unix;

    let command = cmd_str.ok_or_else(|| {
        format!(
            "Uninstall is not supported for {} on this platform.",
            agent.display_name
        )
    })?;

    #[cfg(windows)]
    let output = create_command("cmd")
        .args(["/C", command])
        .output()
        .map_err(|e| format!("Failed to run uninstall: {e}"))?;

    #[cfg(not(windows))]
    let output = create_command("/bin/bash")
        .args(["-c", command])
        .output()
        .map_err(|e| format!("Failed to run uninstall: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // npm uninstall of a non-installed package is not a fatal failure — but
        // we surface any real error so the UI can tell the user.
        return Err((format!(
            "Uninstall reported an error: {}",
            stderr.lines().next().unwrap_or("unknown").trim()
        ))
        .into());
    }

    tracing::info!(agent_id = agent_id.as_str(), "Agent uninstalled");
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
