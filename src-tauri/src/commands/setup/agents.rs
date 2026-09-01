//! # Agent Management Commands
//!
//! Dashboard-surfaced commands for managing AI agent installations and accounts:
//! installed/auth status, signing out, uninstalling.

use crate::agent::{get_agent_by_id, ALL_AGENTS};
use crate::commands::accounts::{
    agent_auth_dir, get_active_account_id, resolve_claude_identity, ClaudeConnState,
};
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
    /// The signed-in account's email, when known (currently only Claude Code,
    /// resolved per active workspace). `None` for agents we can't identify.
    pub auth_email: Option<String>,
    /// True when the agent was connected but its credential has expired and the
    /// user must reconnect — drives the red stroke + inline Reconnect on the card.
    /// Never true for the "never connected" state (that keeps the neutral UI).
    pub needs_reconnect: bool,
    pub is_default: bool,
    pub install_supported: bool,
    pub uninstall_supported: bool,
}

/// Determine an agent's sign-in state by asking its own CLI, for agents whose
/// credential lives outside the filesystem (e.g. Cursor keeps its token in the
/// system keychain, so no auth-indicator file is reliable). Runs the agent's
/// `auth_status_args` and looks for `auth_status_ready_substr` in the output.
///
/// Returns `None` for agents that use file-based auth indicators — the caller
/// then falls back to checking `auth_indicators` on disk.
pub fn agent_command_auth_status(agent: &crate::agent::AgentConfig) -> Option<bool> {
    let args = agent.auth_status_args?;
    let needle = agent.auth_status_ready_substr?;
    let binary = find_binary_by_name(agent.binary_name)?;
    let output = create_command(&binary).args(args).output().ok()?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    Some(combined.contains(needle))
}

/// Async variant of [`agent_command_auth_status`] with a per-call timeout, for
/// status probes that must never hang (e.g. the onboarding wizard's
/// `get_full_setup_status`). On timeout or spawn failure it logs a warning and
/// returns `None`, letting the caller fall back to file-based auth indicators —
/// mirroring the sync variant's behavior on spawn failure.
pub async fn agent_command_auth_status_with_timeout(
    agent: &crate::agent::AgentConfig,
    timeout_secs: u64,
) -> Option<bool> {
    let args = agent.auth_status_args?;
    let needle = agent.auth_status_ready_substr?;
    let binary = find_binary_by_name(agent.binary_name)?;
    let mut std_cmd = create_command(&binary);
    std_cmd.args(args);
    let mut cmd = tokio::process::Command::from(std_cmd);
    // If the probe times out, kill the child instead of leaving it wedged.
    cmd.kill_on_drop(true);
    let label = format!("{} {}", agent.binary_name, args.join(" "));
    match crate::external_command::run_with_timeout(cmd, label.clone(), timeout_secs).await {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            Some(combined.contains(needle))
        }
        Err(err) => {
            tracing::warn!(
                cmd = %label,
                error = %err,
                "agent auth status probe failed; falling back to file indicators"
            );
            None
        }
    }
}

/// Return the status of every known agent in a single call.
/// Avoids the N round-trips the dashboard would otherwise need.
#[tauri::command]
#[tracing::instrument]
pub async fn get_agents_status() -> Vec<AgentStatus> {
    let default_id = super::read_app_state()
        .default_agent_id
        .unwrap_or_else(|| "claude-code".to_string());
    let active_account_id = get_active_account_id().unwrap_or_else(|_| "default".to_string());

    // Claude's auth can't be inferred from config files (its macOS login is a
    // global keychain entry that ignores CLAUDE_CONFIG_DIR), so resolve the real
    // per-workspace identity once up front and fold it into the Claude row below.
    let claude_identity = resolve_claude_identity(&active_account_id).await;

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

            let is_claude = agent.id == "claude-code";
            let (authed, auth_email, needs_reconnect) = if is_claude {
                // Real per-workspace identity, not file existence.
                (
                    claude_identity.state != ClaudeConnState::NotConnected,
                    claude_identity.email.clone(),
                    claude_identity.state == ClaudeConnState::NeedsReconnect,
                )
            } else if !installed {
                (false, None, false)
            } else if let Some(authed) = agent_command_auth_status(agent) {
                // Keychain-based agents (Cursor): ask the CLI, not the filesystem.
                (authed, None, false)
            } else {
                let dir = agent_auth_dir(&active_account_id, agent);
                let authed = agent
                    .auth_indicators
                    .iter()
                    .any(|indicator| dir.join(indicator).exists());
                (authed, None, false)
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
                auth_email,
                needs_reconnect,
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

    // Keychain-based agents (Cursor) can't be signed out by deleting files —
    // their token lives in the system keychain. Use the CLI's own logout.
    if let Some(args) = agent.logout_args {
        if let Some(binary) = find_binary_by_name(agent.binary_name) {
            let _ = create_command(&binary).args(args).output();
        }
        tracing::info!(
            agent_id = agent_id.as_str(),
            "Agent signed out via CLI logout"
        );
        return Ok(());
    }

    let active_account_id = get_active_account_id().unwrap_or_else(|_| "default".to_string());
    let dir = agent_auth_dir(&active_account_id, agent);

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

    // Retry a file-lock failure before giving up: on Windows npm's unlink of a
    // just-used binary regularly loses a race with antivirus or a still-open
    // terminal, and the lock clears on its own within a second or two
    // (issue #844) — the same shape `rename_with_retry` handles for plugins.
    let mut attempt: u32 = 0;
    let output = loop {
        attempt += 1;
        let output =
            run_uninstall_command(command).map_err(|e| format!("Failed to run uninstall: {e}"))?;
        if output.status.success() {
            break output;
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if is_file_lock_failure(&stderr) {
            if attempt < 4 {
                tracing::warn!(
                    agent_id = agent_id.as_str(),
                    attempt,
                    "uninstall blocked by a file lock; retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(
                    300 * 2u64.pow(attempt - 1),
                ))
                .await;
                continue;
            }
            return Err(CommandError::expected(format!(
                "Couldn't uninstall {} because another program still has its files open. \
                 Close any terminals or editors running it (antivirus can hold the files \
                 briefly too), then try again.",
                agent.display_name
            )));
        }

        // npm uninstall of a non-installed package is not a fatal failure — but
        // we surface any real error so the UI can tell the user.
        return Err((format!(
            "Uninstall reported an error: {}",
            stderr.lines().next().unwrap_or("unknown").trim()
        ))
        .into());
    };

    tracing::info!(agent_id = agent_id.as_str(), "Agent uninstalled");
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run an agent's uninstall command through the platform shell.
///
/// The extended PATH is required, not cosmetic: a Finder-launched macOS app
/// doesn't inherit the user's shell PATH, so `npm` (and anything else the
/// uninstall line calls) simply isn't found without it (issue #757).
fn run_uninstall_command(command: &str) -> std::io::Result<std::process::Output> {
    #[cfg(windows)]
    let (shell, args) = ("cmd", ["/C", command]);
    #[cfg(not(windows))]
    let (shell, args) = ("/bin/bash", ["-c", command]);

    create_command(shell)
        .args(args)
        .env("PATH", crate::utils::get_extended_path())
        .output()
}

/// npm/OS wording for "the file is locked by another process" — Windows EBUSY
/// on an unlink, and its localized/OS-level equivalent (issue #844).
fn is_file_lock_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("ebusy")
        || lower.contains("resource busy or locked")
        || lower.contains("being used by another process")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ sign_out_agent ============

    #[tokio::test]
    async fn sign_out_agent_rejects_unknown_id() {
        let result = sign_out_agent("not-a-real-agent".to_string()).await;
        assert!(result.is_err(), "unknown agent id must be rejected");
        let err = format!("{:?}", result.unwrap_err());
        assert!(
            err.contains("Unknown agent"),
            "error should mention unknown agent, got: {err}"
        );
    }

    #[tokio::test]
    async fn sign_out_agent_rejects_empty_id() {
        let result = sign_out_agent(String::new()).await;
        assert!(result.is_err(), "empty agent id must be rejected");
    }

    #[tokio::test]
    async fn sign_out_agent_accepts_all_known_ids() {
        // Every agent in ALL_AGENTS must round-trip through sign_out_agent's
        // id-validation step without the "Unknown agent" error. (The actual
        // file-removal step may be a no-op on a machine that never signed in,
        // but the id check should always pass.)
        for agent in crate::agent::ALL_AGENTS {
            let result = sign_out_agent(agent.id.to_string()).await;
            if let Err(e) = &result {
                let msg = format!("{:?}", e);
                assert!(
                    !msg.contains("Unknown agent"),
                    "agent {} should not be rejected as unknown: {msg}",
                    agent.id
                );
            }
        }
    }

    // ============ uninstall_agent ============

    #[tokio::test]
    async fn uninstall_agent_rejects_unknown_id() {
        let result = uninstall_agent("not-a-real-agent".to_string()).await;
        assert!(result.is_err(), "unknown agent id must be rejected");
        let err = format!("{:?}", result.unwrap_err());
        assert!(
            err.contains("Unknown agent"),
            "error should mention unknown agent, got: {err}"
        );
    }

    #[tokio::test]
    async fn uninstall_agent_rejects_empty_id() {
        let result = uninstall_agent(String::new()).await;
        assert!(result.is_err());
    }

    /// Issue #844: npm's EBUSY file-lock shape must be recognized so the
    /// uninstall retries and, if it still fails, explains itself instead of
    /// dumping the raw npm error.
    #[test]
    fn recognizes_npm_file_lock_failures() {
        assert!(is_file_lock_failure(
            "npm error code EBUSY\nnpm error syscall unlink\nnpm error EBUSY: resource busy or \
             locked, unlink 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'"
        ));
        assert!(is_file_lock_failure(
            "The process cannot access the file because it is being used by another process."
        ));
        // A genuine npm failure still flows through to the reportable path.
        assert!(!is_file_lock_failure("npm error 404 Not Found - GET ..."));
        assert!(!is_file_lock_failure(""));
    }

    // ============ get_agents_status ============

    #[tokio::test]
    async fn get_agents_status_returns_one_entry_per_known_agent() {
        let statuses = get_agents_status().await;
        assert_eq!(
            statuses.len(),
            crate::agent::ALL_AGENTS.len(),
            "should return one status per agent in ALL_AGENTS"
        );
        // Order and IDs should match ALL_AGENTS.
        for (status, agent) in statuses.iter().zip(crate::agent::ALL_AGENTS.iter()) {
            assert_eq!(status.id, agent.id);
            assert_eq!(status.display_name, agent.display_name);
            assert_eq!(status.binary_name, agent.binary_name);
        }
    }

    #[tokio::test]
    async fn get_agents_status_marks_exactly_one_default() {
        let statuses = get_agents_status().await;
        let default_count = statuses.iter().filter(|s| s.is_default).count();
        assert_eq!(
            default_count, 1,
            "exactly one agent should be marked as default"
        );
    }

    #[tokio::test]
    async fn get_agents_status_install_supported_tracks_platform() {
        let statuses = get_agents_status().await;
        for status in &statuses {
            let agent = crate::agent::get_agent_by_id(&status.id);
            #[cfg(windows)]
            let expected = agent.install_message_windows.is_some();
            #[cfg(not(windows))]
            let expected = agent.install_command_unix.is_some();
            assert_eq!(
                status.install_supported, expected,
                "install_supported for {} should match platform-specific install command presence",
                status.id
            );
        }
    }

    #[tokio::test]
    async fn get_agents_status_uninstall_supported_tracks_platform() {
        let statuses = get_agents_status().await;
        for status in &statuses {
            let agent = crate::agent::get_agent_by_id(&status.id);
            #[cfg(windows)]
            let expected = agent.uninstall_command_windows.is_some();
            #[cfg(not(windows))]
            let expected = agent.uninstall_command_unix.is_some();
            assert_eq!(
                status.uninstall_supported, expected,
                "uninstall_supported for {} should match platform-specific uninstall command presence",
                status.id
            );
        }
    }

    // ============ AgentStatus serialization ============

    #[test]
    fn agent_status_serializes_to_camel_case_for_frontend() {
        let status = AgentStatus {
            id: "claude-code".to_string(),
            display_name: "Claude Code".to_string(),
            binary_name: "claude".to_string(),
            installed: true,
            version: Some("1.2.3".to_string()),
            authed: true,
            auth_email: Some("user@example.com".to_string()),
            needs_reconnect: false,
            is_default: true,
            install_supported: true,
            uninstall_supported: true,
        };
        let json = serde_json::to_string(&status).expect("serialize");
        // The frontend reads these as camelCase — lock the contract.
        assert!(json.contains("\"displayName\":\"Claude Code\""));
        assert!(json.contains("\"binaryName\":\"claude\""));
        assert!(json.contains("\"isDefault\":true"));
        assert!(json.contains("\"installSupported\":true"));
        assert!(json.contains("\"uninstallSupported\":true"));
        assert!(json.contains("\"authEmail\":\"user@example.com\""));
        assert!(json.contains("\"needsReconnect\":false"));
    }
}
