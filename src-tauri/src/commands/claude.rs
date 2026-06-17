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
#[tracing::instrument(skip(project_path, session_id), fields(project = %project_path, session_id = %session_id))]
pub fn claude_session_exists(project_path: String, session_id: String) -> bool {
    // Resolve the claude config dir from THIS project's workspace, not the
    // globally active one. Otherwise resume probing looks in the wrong dir for
    // any project whose workspace isn't currently active, and resume silently
    // fails (falls back to a fresh session) for non-active-workspace projects.
    let account_id =
        crate::commands::projects::project_account_id_sync(std::path::Path::new(&project_path));
    let claude_dir = crate::commands::accounts::claude_config_dir(&account_id);
    // Claude CLI's path sanitization: replace path separators with `-`.
    // The leading `/` also becomes `-`, hence the leading dash in directory names.
    let sanitized: String = project_path
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    let project_dir = claude_dir.join("projects").join(&sanitized);
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

/// Per-candidate validation timeout when probing whether a found binary is functional.
/// Kept short because the only thing we run is `<binary> --version`.
const BINARY_VALIDATION_TIMEOUT_SECS: u64 = 4;

/// Finds the active agent's CLI binary by checking common installation paths.
///
/// Validates each candidate by running `<binary> <version_flag>` and skips broken
/// installs (e.g. an npm wrapper whose platform-native dep failed to download).
/// This means a broken `/opt/homebrew/bin/claude` no longer shadows a working
/// `~/.local/bin/claude` install.
pub fn find_agent_binary() -> Option<std::path::PathBuf> {
    let agent = get_active_agent();
    find_validated_binary(agent.binary_name, agent.version_flag)
}

/// Backward-compatible alias for `find_agent_binary`.
pub fn find_claude_binary() -> Option<std::path::PathBuf> {
    find_agent_binary()
}

/// Finds a CLI binary by name, checking common installation paths.
///
/// Returns the first existing path without runtime validation. Prefer
/// `find_validated_binary` for callers that will spawn the binary — this
/// variant exists for callers that only need to know whether a file is
/// present on disk.
pub fn find_binary_by_name(binary_name: &str) -> Option<std::path::PathBuf> {
    candidate_paths_for(binary_name)
        .into_iter()
        .find(|p| p.exists())
}

/// Finds a CLI binary by name and validates that it actually runs.
///
/// Walks the same candidate list as `find_binary_by_name` but probes each one
/// with `<binary> <version_flag>` (short timeout). Returns the first path that
/// exits zero, skipping over any candidates that don't exist or whose version
/// probe fails. This protects us from shadowing scenarios where a broken
/// binary on the GUI PATH masks a working install elsewhere on the system.
pub fn find_validated_binary(binary_name: &str, version_flag: &str) -> Option<std::path::PathBuf> {
    for candidate in candidate_paths_for(binary_name) {
        if !candidate.exists() {
            continue;
        }
        if binary_runs(&candidate, version_flag) {
            return Some(candidate);
        }
        tracing::warn!(
            broken_binary = %candidate.display(),
            "Found {binary_name} at this path but `{binary_name} {version_flag}` failed; trying next candidate",
        );
    }
    None
}

/// Probes whether `<binary> <version_flag>` exits successfully within the
/// validation timeout. Used to skip installs that exist on disk but are
/// non-functional (broken npm wrappers, partial extracts, etc.).
fn binary_runs(path: &std::path::Path, version_flag: &str) -> bool {
    use std::sync::mpsc;
    use std::time::Duration;

    let path = path.to_path_buf();
    let flag = version_flag.to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = create_command(&path)
            .args([&flag])
            .env("PATH", get_extended_path())
            .output();
        let _ = tx.send(matches!(result, Ok(out) if out.status.success()));
    });
    rx.recv_timeout(Duration::from_secs(BINARY_VALIDATION_TIMEOUT_SECS))
        .unwrap_or(false)
}

/// Returns the ordered list of locations to probe for a CLI binary.
///
/// Order matters: earlier entries win when multiple working installs are
/// present. `which::which` comes first so we honor whatever the user's shell
/// would resolve, then we fall through to well-known locations.
fn candidate_paths_for(binary_name: &str) -> Vec<std::path::PathBuf> {
    let mut paths: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(path) = which::which(binary_name) {
        paths.push(path);
    }

    #[cfg(windows)]
    {
        let exe_name = format!("{binary_name}.exe");
        let cmd_name = format!("{binary_name}.cmd");
        if let Ok(path) = which::which(&exe_name) {
            paths.push(path);
        }

        if let Some(home) = dirs::home_dir() {
            paths.extend([
                home.join(format!("AppData\\Local\\Programs\\Claude\\{}", exe_name)),
                home.join(format!(
                    "AppData\\Local\\Programs\\Claude Code\\{}",
                    exe_name
                )),
                home.join(format!(r".local\bin\{}", exe_name)),
            ]);
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            paths.extend([
                std::path::PathBuf::from(&app_data).join(format!("npm\\{}", cmd_name)),
                std::path::PathBuf::from(&app_data).join(format!("npm\\{}", exe_name)),
            ]);
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            paths.push(
                std::path::PathBuf::from(&program_files).join(format!("Claude\\{}", exe_name)),
            );
        }

        if let Ok(output) = create_command("npm")
            .args(["prefix", "-g"])
            .env("PATH", get_extended_path())
            .output()
        {
            if output.status.success() {
                let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                paths.push(std::path::PathBuf::from(&prefix).join(&cmd_name));
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            paths.extend([
                home.join(format!(".local/bin/{binary_name}")),
                home.join(format!(".npm-global/bin/{binary_name}")),
                home.join(".nvm/versions/node")
                    .join("*")
                    .join(format!("bin/{binary_name}")),
                home.join(format!("n/bin/{binary_name}")),
                home.join(format!(".{binary_name}/bin/{binary_name}")),
                home.join(format!(".bun/bin/{binary_name}")),
                std::path::PathBuf::from(format!("/usr/local/bin/{binary_name}")),
                std::path::PathBuf::from(format!("/opt/homebrew/bin/{binary_name}")),
            ]);

            // Claude desktop app's bundled CLI (latest version dir wins).
            let claude_app_base = home.join("Library/Application Support/Claude/claude-code");
            if claude_app_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&claude_app_base) {
                    let mut versions: Vec<_> =
                        entries.flatten().filter(|e| e.path().is_dir()).collect();
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
                        paths.push(entry.path().join(binary_name));
                    }
                }
            }

            if let Ok(output) = create_command("npm")
                .args(["prefix", "-g"])
                .env("PATH", get_extended_path())
                .output()
            {
                if output.status.success() {
                    let prefix = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    paths
                        .push(std::path::PathBuf::from(&prefix).join(format!("bin/{binary_name}")));
                }
            }
        }
    }

    paths
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_runs_returns_false_for_nonexistent_path() {
        let path = std::path::Path::new("/definitely/not/a/real/binary/xyzzy");
        assert!(!binary_runs(path, "--version"));
    }

    #[cfg(not(windows))]
    #[test]
    fn binary_runs_returns_true_for_working_binary() {
        // `/bin/echo --version` exits 0 on macOS and Linux. We use it as a
        // stand-in for any well-behaved CLI that responds to a version probe.
        let path = std::path::Path::new("/bin/echo");
        if path.exists() {
            assert!(binary_runs(path, "--version"));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn binary_runs_returns_false_for_failing_binary() {
        // `/bin/false` always exits non-zero — simulates a broken install.
        let path = std::path::Path::new("/bin/false");
        if path.exists() {
            assert!(!binary_runs(path, "--version"));
        }
    }

    #[test]
    fn candidate_paths_for_includes_well_known_locations() {
        let paths = candidate_paths_for("claude");
        // Should include at least one entry — at minimum the built-in fallbacks
        // even on a machine without a `claude` install.
        assert!(!paths.is_empty());
    }
}
