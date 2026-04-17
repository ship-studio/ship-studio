//! # Agent CLI Integration Commands
//!
//! Commands for checking agent CLI status and installation.
//! Uses the agent abstraction layer to support multiple AI coding agents.

use crate::agent::get_active_agent;
use crate::commands::setup::is_mock_mode;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::AgentCliStatus;
use crate::utils::{create_command, get_extended_path};

/// Check whether a Claude CLI session exists on disk for the given project.
///
/// Claude CLI stores conversations under `~/.claude/projects/<sanitized-path>/`,
/// where each session is either `<session-id>.jsonl` or a directory named
/// `<session-id>`. Sanitization replaces `/` with `-` (so `/Users/foo/bar`
/// becomes `-Users-foo-bar`).
///
/// Used by the frontend before passing `--resume <session-id>` to the Claude
/// CLI. Without this check, we optimistically try resume on every project
/// open — if the project has never had a Claude conversation (or Claude
/// pruned it), resume exits code 1 and we fall back to a fresh session.
/// The fallback works but wastes ~1s and produces noisy logs.
#[tauri::command]
pub fn claude_session_exists(project_path: String, session_id: String) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    // Claude CLI's path sanitization: replace path separators with `-`.
    // The leading `/` also becomes `-`, hence the leading dash in directory names.
    let sanitized: String = project_path
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    let project_dir = home.join(".claude").join("projects").join(&sanitized);
    if !project_dir.is_dir() {
        return false;
    }
    let jsonl = project_dir.join(format!("{session_id}.jsonl"));
    if jsonl.is_file() {
        return true;
    }
    let dir = project_dir.join(&session_id);
    dir.is_dir()
}

/// Lightweight detection timeout — version checks should be near-instant.
const CLAUDE_DETECT_TIMEOUT_SECS: u64 = 10;

/// Finds the active agent's CLI binary by checking common installation paths.
pub fn find_agent_binary() -> Option<std::path::PathBuf> {
    let agent = get_active_agent();
    find_binary_by_name(agent.binary_name)
}

/// Backward-compatible alias for `find_agent_binary`.
pub fn find_claude_binary() -> Option<std::path::PathBuf> {
    find_agent_binary()
}

/// Finds a CLI binary by name, checking common installation paths.
pub fn find_binary_by_name(binary_name: &str) -> Option<std::path::PathBuf> {
    // First try which
    if let Ok(path) = which::which(binary_name) {
        return Some(path);
    }

    #[cfg(windows)]
    {
        let exe_name = format!("{binary_name}.exe");
        let cmd_name = format!("{binary_name}.cmd");
        // On Windows, also try with .exe extension
        if let Ok(path) = which::which(&exe_name) {
            return Some(path);
        }

        // Check Windows-specific paths
        if let Some(home) = dirs::home_dir() {
            let windows_paths = vec![
                home.join(format!("AppData\\Local\\Programs\\Claude\\{}", exe_name)),
                home.join(format!(
                    "AppData\\Local\\Programs\\Claude Code\\{}",
                    exe_name
                )),
                home.join(format!(r".local\bin\{}", exe_name)),
            ];

            for path in windows_paths {
                if path.exists() {
                    return Some(path);
                }
            }
        }

        // Check npm global (uses .cmd wrapper on Windows)
        if let Ok(app_data) = std::env::var("APPDATA") {
            let npm_paths = vec![
                std::path::PathBuf::from(&app_data).join(format!("npm\\{}", cmd_name)),
                std::path::PathBuf::from(&app_data).join(format!("npm\\{}", exe_name)),
            ];
            for path in npm_paths {
                if path.exists() {
                    return Some(path);
                }
            }
        }

        // Check Program Files
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let path =
                std::path::PathBuf::from(&program_files).join(format!("Claude\\{}", exe_name));
            if path.exists() {
                return Some(path);
            }
        }

        // Check npm prefix on Windows
        if let Ok(output) = create_command("npm")
            .args(["prefix", "-g"])
            .env("PATH", get_extended_path())
            .output()
        {
            if output.status.success() {
                let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let bin_path = std::path::PathBuf::from(&prefix).join(&cmd_name);
                if bin_path.exists() {
                    return Some(bin_path);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Check common installation locations (Unix)
        if let Some(home) = dirs::home_dir() {
            let common_paths = vec![
                home.join(format!(".local/bin/{binary_name}")),
                home.join(format!(".npm-global/bin/{binary_name}")),
                home.join(".nvm/versions/node")
                    .join("*")
                    .join(format!("bin/{binary_name}")),
                home.join(format!("n/bin/{binary_name}")),
                // Tools that install into ~/.<name>/bin/<name> (opencode, bun, cargo, etc.)
                home.join(format!(".{binary_name}/bin/{binary_name}")),
                home.join(format!(".bun/bin/{binary_name}")),
                std::path::PathBuf::from(format!("/usr/local/bin/{binary_name}")),
                std::path::PathBuf::from(format!("/opt/homebrew/bin/{binary_name}")),
            ];

            for path in common_paths {
                if path.exists() {
                    return Some(path);
                }
            }

            // Check Claude desktop app's bundled CLI (~/Library/Application Support/Claude/claude-code/{version}/{binary})
            let claude_app_base = home.join("Library/Application Support/Claude/claude-code");
            if claude_app_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&claude_app_base) {
                    // Find the latest version directory
                    let mut versions: Vec<_> =
                        entries.flatten().filter(|e| e.path().is_dir()).collect();
                    // Sort by semantic version (descending) to get latest first
                    versions.sort_by_key(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let parts: Vec<u64> = name
                            .trim_start_matches('v')
                            .split('.')
                            .map(|p| p.parse().unwrap_or(0))
                            .collect();
                        std::cmp::Reverse(parts)
                    });

                    for entry in versions {
                        let bin_path = entry.path().join(binary_name);
                        if bin_path.exists() {
                            return Some(bin_path);
                        }
                    }
                }
            }

            // Check npm prefix
            if let Ok(output) = create_command("npm")
                .args(["prefix", "-g"])
                .env("PATH", get_extended_path())
                .output()
            {
                if output.status.success() {
                    let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let bin_path =
                        std::path::PathBuf::from(&prefix).join(format!("bin/{binary_name}"));
                    if bin_path.exists() {
                        return Some(bin_path);
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
#[tracing::instrument]
pub async fn check_claude_cli_status() -> AgentCliStatus {
    let agent = get_active_agent();

    // Check if agent CLI is installed
    let agent_path = match find_agent_binary() {
        Some(path) => path,
        None => {
            return AgentCliStatus {
                installed: false,
                version: None,
            };
        }
    };

    // Get version — short timeout so a hung CLI doesn't stall onboarding.
    let mut cmd = create_command(&agent_path);
    cmd.args([agent.version_flag]);
    let tokio_cmd = tokio::process::Command::from(cmd);
    let version = run_with_timeout(
        tokio_cmd,
        format!("{} --version", agent.display_name),
        CLAUDE_DETECT_TIMEOUT_SECS,
    )
    .await
    .ok()
    .and_then(|output| {
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        }
    });

    AgentCliStatus {
        installed: true,
        version,
    }
}

#[tauri::command]
#[tracing::instrument]
pub async fn install_claude_cli() -> Result<(), CommandError> {
    let agent = get_active_agent();

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        crate::commands::setup::mock_install(agent.setup_item_ids.0);
        return Ok(());
    }

    #[cfg(windows)]
    {
        if let Some(msg) = agent.install_message_windows {
            return Err((msg.to_string()).into());
        }
        return Err((format!(
            "{} does not support automatic installation on Windows.",
            agent.display_name
        ))
        .into());
    }

    #[cfg(not(windows))]
    {
        let install_cmd = agent.install_command_unix.ok_or_else(|| {
            format!(
                "{} does not support automatic installation.",
                agent.display_name
            )
        })?;

        let output = create_command("bash")
            .args(["-c", install_cmd])
            .env("PATH", get_extended_path())
            .output()
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err((format!("Failed to install {}: {}", agent.display_name, stderr)).into());
        }

        Ok(())
    }
}
