//! # Setup Status Checks
//!
//! Full and quick setup status detection for the onboarding wizard.
//! Checks for homebrew, node, git, gh, agent CLIs, vercel, and their auth states.

use super::{is_force_onboarding_mode, is_mock_installed, is_mock_mode, read_app_state};
use crate::agent::ALL_AGENTS;
use crate::commands::accounts::{
    agent_auth_dir, get_active_account_id, get_env_vars_for_account, DEFAULT_ACCOUNT_ID,
};
use crate::commands::claude::find_binary_by_name;
use crate::commands::github::get_gh_command;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{FullSetupStatus, OptionalAuths, SetupItemInfo, SetupItemStatus};
use crate::utils::{create_command, find_executable};
use std::path::Path;

#[cfg(windows)]
use crate::utils::get_winget_command;

#[cfg(not(windows))]
use crate::utils::get_brew_command;

/// Timeout for local probes (`node --version`, agent status, …). Generous for a
/// version print, but bounded — a CLI wedged on stdin or a broken install must
/// never stall the onboarding wizard's status check.
const LOCAL_PROBE_TIMEOUT_SECS: u64 = 5;

/// Timeout for probes that may hit the network (`gh auth status`,
/// `gh api user`, `vercel whoami`). Slightly longer to tolerate slow links,
/// still bounded so an offline machine degrades instead of hanging.
const NETWORK_PROBE_TIMEOUT_SECS: u64 = 8;

/// Run `binary <args…>` bounded by a timeout and return its trimmed stdout when
/// it exits successfully. Any failure — non-zero exit, spawn error, or timeout —
/// degrades to `None` so a single wedged tool can never block the remaining
/// checks (the item just reports as not ready / version unknown).
async fn probe_stdout(binary: &Path, args: &[&str], timeout_secs: u64) -> Option<String> {
    let label = format!("{} {}", binary.display(), args.join(" "));
    let mut std_cmd = create_command(binary);
    std_cmd.args(args);
    let mut cmd = tokio::process::Command::from(std_cmd);
    // If the probe times out, kill the child instead of leaving it wedged.
    cmd.kill_on_drop(true);
    match run_with_timeout(cmd, label.clone(), timeout_secs).await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        Ok(_) => None,
        Err(err) => {
            tracing::warn!(
                cmd = %label,
                error = %err,
                "setup status probe failed; treating item as not ready"
            );
            None
        }
    }
}

/// Like [`probe_stdout`] but returns only the first line — for CLIs that print
/// multi-line version banners (brew, gh).
async fn probe_stdout_first_line(
    binary: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Option<String> {
    probe_stdout(binary, args, timeout_secs)
        .await
        .and_then(|out| out.lines().next().map(|line| line.trim().to_string()))
}

/// Run a `gh` subcommand (extended PATH + active-workspace env) with a timeout.
/// Returns `None` when the command times out or fails to spawn.
async fn run_gh_with_timeout(args: &[&str], timeout_secs: u64) -> Option<std::process::Output> {
    let mut std_cmd = get_gh_command();
    std_cmd.args(args);
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let label = format!("gh {}", args.join(" "));
    match run_with_timeout(cmd, label.clone(), timeout_secs).await {
        Ok(output) => Some(output),
        Err(err) => {
            tracing::warn!(
                cmd = %label,
                error = %err,
                "setup status: gh probe failed; treating GitHub as not authenticated"
            );
            None
        }
    }
}

/// Run `vercel whoami` (optionally with an explicit token) with a network
/// timeout. `None` on any failure — not signed in, spawn error, or timeout.
async fn run_vercel_whoami(vercel_path: &Path, token: Option<&str>) -> Option<String> {
    let mut std_cmd = create_command(vercel_path);
    std_cmd.args(["whoami"]);
    if let Some(t) = token {
        std_cmd.env("VERCEL_TOKEN", t);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    match run_with_timeout(cmd, "vercel whoami", NETWORK_PROBE_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        Ok(_) => None,
        Err(err) => {
            tracing::warn!(
                cmd = "vercel whoami",
                error = %err,
                "setup status: vercel probe failed; treating Vercel as not authenticated"
            );
            None
        }
    }
}

/// Get full setup status for all items
#[tauri::command]
#[tracing::instrument]
pub async fn get_full_setup_status() -> FullSetupStatus {
    // Debug/mock mode: return mock state for testing onboarding flow
    if is_mock_mode() {
        let items = vec![
            ("homebrew", "Package Manager", None),
            ("node", "Node.js", Some("homebrew")),
            ("git", "Git", Some("homebrew")),
            ("gh", "GitHub CLI", Some("homebrew")),
            ("gh_auth", "GitHub Account", Some("gh")),
            ("claude", "Claude Code", None),
            ("claude_auth", "Claude Account", Some("claude")),
            ("codex", "Codex", None),
            ("codex_auth", "Codex Account", Some("codex")),
            ("opencode", "Opencode", None),
            ("opencode_auth", "Opencode Account", Some("opencode")),
            ("cursor", "Cursor", None),
            ("cursor_auth", "Cursor Account", Some("cursor")),
            ("copilot", "GitHub Copilot", None),
            ("copilot_auth", "GitHub Account", Some("copilot")),
            ("pi", "Pi", None),
            ("pi_auth", "Pi Account", Some("pi")),
            ("hermes", "Hermes", None),
            ("hermes_auth", "Hermes Account", Some("hermes")),
            ("devin", "Devin", None),
            ("devin_auth", "Devin Account", Some("devin")),
            ("grok", "Grok", None),
            ("grok_auth", "Grok Account", Some("grok")),
            ("kimi-code", "Kimi Code", None),
            ("kimi-code_auth", "Kimi Code Account", Some("kimi-code")),
            ("antigravity-cli", "Antigravity", None),
            (
                "antigravity-cli_auth",
                "Antigravity Account",
                Some("antigravity-cli"),
            ),
            ("jcode", "Jcode", None),
            ("jcode_auth", "Jcode Account", Some("jcode")),
            ("droid", "Droid", None),
            ("droid_auth", "Droid Account", Some("droid")),
            ("amp", "Amp", None),
            ("amp_auth", "Amp Account", Some("amp")),
            ("qwen", "Qwen", None),
            ("qwen_auth", "Qwen Account", Some("qwen")),
            ("vercel", "Vercel CLI", None),
            ("vercel_auth", "Vercel Account", Some("vercel")),
        ];

        let mock_items: Vec<SetupItemInfo> = items
            .iter()
            .map(|(id, name, dep)| {
                let is_ready = is_mock_installed(id);
                let dep_ready = dep.map(is_mock_installed).unwrap_or(true);
                let is_auth = id.ends_with("_auth");

                SetupItemInfo {
                    id: id.to_string(),
                    friendly_name: name.to_string(),
                    status: if is_ready {
                        SetupItemStatus::Ready
                    } else if !dep_ready {
                        SetupItemStatus::NotInstalled
                    } else if is_auth {
                        SetupItemStatus::NotAuthenticated
                    } else {
                        SetupItemStatus::NotInstalled
                    },
                    version: if is_ready && !is_auth {
                        Some("mock-1.0.0".to_string())
                    } else {
                        None
                    },
                    username: if is_ready && is_auth {
                        Some("mock-user".to_string())
                    } else {
                        None
                    },
                    error_message: None,
                }
            })
            .collect();

        // In mock mode, check which items are ready for optional_auths
        let github_authenticated = mock_items
            .iter()
            .find(|i| i.id == "gh_auth")
            .map(|i| matches!(i.status, SetupItemStatus::Ready))
            .unwrap_or(false);

        // Required base items for setup completion
        const REQUIRED_ITEMS_MOCK: &[&str] = &["homebrew", "node", "git", "gh"];

        let base_ready = mock_items
            .iter()
            .filter(|i| REQUIRED_ITEMS_MOCK.contains(&i.id.as_str()))
            .all(|i| matches!(i.status, SetupItemStatus::Ready));

        // Check which agent pairs are fully ready
        let mut detected_agents = Vec::new();
        for agent in ALL_AGENTS {
            let binary_ready = mock_items
                .iter()
                .find(|i| i.id == agent.setup_item_ids.0)
                .map(|i| matches!(i.status, SetupItemStatus::Ready))
                .unwrap_or(false);
            let auth_ready = mock_items
                .iter()
                .find(|i| i.id == agent.setup_item_ids.1)
                .map(|i| matches!(i.status, SetupItemStatus::Ready))
                .unwrap_or(false);
            if binary_ready && auth_ready {
                detected_agents.push(agent.id.to_string());
            }
        }

        let at_least_one_agent = !detected_agents.is_empty();
        // In mock mode, also require all items ready so the wizard shows
        // for any incomplete step (including optional ones like hosting).
        // The wizard handles skippable steps internally.
        let all_items_ready = mock_items
            .iter()
            .all(|i| matches!(i.status, SetupItemStatus::Ready));
        let all_ready = base_ready && at_least_one_agent && all_items_ready;

        return FullSetupStatus {
            all_ready,
            items: mock_items,
            optional_auths: OptionalAuths {
                github_authenticated,
            },
            detected_agents,
        };
    }

    let active_account_id = get_active_account_id().unwrap_or_else(|_| "default".to_string());

    // Locate binaries up front (pure filesystem checks — fast, no subprocesses).
    #[cfg(windows)]
    let pkg_mgr_path = get_winget_command();
    #[cfg(not(windows))]
    let pkg_mgr_path = get_brew_command();
    let node_path = find_executable("node");
    let git_path = find_executable("git");
    let gh_path = find_executable("gh");
    let vercel_path = find_executable("vercel");
    let agent_paths: Vec<Option<std::path::PathBuf>> = ALL_AGENTS
        .iter()
        .map(|agent| find_binary_by_name(agent.binary_name))
        .collect();

    // Probe everything concurrently, each subprocess bounded by its own
    // timeout, so one wedged CLI can neither stall the other checks nor hang
    // the onboarding wizard's status probe.
    let pkg_mgr_fut = async {
        match &pkg_mgr_path {
            Some(p) => probe_stdout_first_line(p, &["--version"], LOCAL_PROBE_TIMEOUT_SECS).await,
            None => None,
        }
    };
    let node_fut = async {
        match &node_path {
            Some(p) => probe_stdout(p, &["--version"], LOCAL_PROBE_TIMEOUT_SECS).await,
            None => None,
        }
    };
    let git_fut = async {
        match &git_path {
            Some(p) => probe_stdout(p, &["--version"], LOCAL_PROBE_TIMEOUT_SECS).await,
            None => None,
        }
    };
    let gh_fut = async {
        let version = match &gh_path {
            Some(p) => probe_stdout_first_line(p, &["--version"], LOCAL_PROBE_TIMEOUT_SECS).await,
            None => None,
        };

        // Parse the output for a valid active login rather than trusting the
        // exit code: `gh auth status` exits non-zero if any configured account
        // has an invalid token, even when the active account is fine — which
        // would wrongly strand the user on the GitHub step of onboarding. See
        // accounts::parse_gh_auth_status.
        let authed = if gh_path.is_some() {
            run_gh_with_timeout(&["auth", "status"], NETWORK_PROBE_TIMEOUT_SECS)
                .await
                .map(|o| {
                    crate::commands::accounts::parse_gh_auth_status(
                        &String::from_utf8_lossy(&o.stdout),
                        &String::from_utf8_lossy(&o.stderr),
                    )
                    .is_some()
                })
                .unwrap_or(false)
        } else {
            false
        };
        let username = if authed {
            run_gh_with_timeout(
                &["api", "user", "--jq", ".login"],
                NETWORK_PROBE_TIMEOUT_SECS,
            )
            .await
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
        } else {
            None
        };
        (version, authed, username)
    };
    let agents_fut = futures_util::future::join_all(ALL_AGENTS.iter().zip(&agent_paths).map(
        |(agent, agent_path)| async move {
            let version = match agent_path {
                Some(p) => probe_stdout(p, &[agent.version_flag], LOCAL_PROBE_TIMEOUT_SECS).await,
                None => None,
            };
            // Keychain-based agents (Cursor): ask the CLI, not the filesystem.
            // The answer is global (no per-account dir), so probe once here and
            // reuse it for both the per-account and global auth decisions below.
            let command_auth = if agent_path.is_some() {
                crate::commands::setup::agents::agent_command_auth_status_with_timeout(
                    agent,
                    LOCAL_PROBE_TIMEOUT_SECS,
                )
                .await
            } else {
                None
            };
            (version, command_auth)
        },
    ));
    let vercel_fut = async {
        let version = match &vercel_path {
            Some(p) => probe_stdout(p, &["--version"], LOCAL_PROBE_TIMEOUT_SECS).await,
            None => None,
        };

        // Vercel Auth — per-workspace:
        //    • Non-default accounts: only authed if VERCEL_TOKEN is in the
        //      account's keychain (browser-based `vercel login` stores a global
        //      session that would bleed across workspaces — require an explicit
        //      token instead so each workspace is fully isolated).
        //    • Default account: existing global `vercel whoami` behaviour
        //      (preserves logins from before Workspace isolation existed).
        let account_vercel_token =
            get_env_vars_for_account(&active_account_id).remove("VERCEL_TOKEN");
        let whoami = match &vercel_path {
            Some(p) => {
                if let Some(ref token) = account_vercel_token {
                    // Account has an explicit token → verify it and get username
                    run_vercel_whoami(p, Some(token)).await
                } else if active_account_id == DEFAULT_ACCOUNT_ID {
                    // Default account → use global CLI session (browser-based login)
                    run_vercel_whoami(p, None).await
                } else {
                    // Non-default account without a token → not connected for this workspace
                    None
                }
            }
            None => None,
        };
        (version, whoami)
    };

    // Claude auth goes through the ONE shared truth (CLI-first, file
    // fallback) — the same answer the wizard pre-checks and dashboard get.
    // File indicators alone lied in both directions: they survive a sign-out
    // (issue #159) and don't exist yet mid-first-login on a fresh machine,
    // which deadlocked the Connect button against this checklist. Computed
    // once here (not per item) because the guided phase polls this command
    // every 3s and the CLI probe spawns a subprocess.
    //
    // Joined with the other probes rather than awaited after them: run
    // sequentially, its up-to-10s CLI probe stacked on the ~8s probe phase
    // and could blow past the frontend's boot-gate timeout, dumping a fully
    // set-up user into onboarding (issue #272).
    let claude_binary_ready = agent_paths
        .get(
            ALL_AGENTS
                .iter()
                .position(|a| a.id == "claude-code")
                .unwrap_or(0),
        )
        .map(|p| p.is_some())
        .unwrap_or(false);
    let claude_auth_fut = async {
        if !claude_binary_ready {
            return (false, false);
        }
        if active_account_id == crate::commands::accounts::DEFAULT_ACCOUNT_ID {
            let active = crate::commands::setup::auth::claude_auth_truth(&active_account_id).await;
            (active, active)
        } else {
            tokio::join!(
                crate::commands::setup::auth::claude_auth_truth(&active_account_id),
                crate::commands::setup::auth::claude_auth_truth(
                    crate::commands::accounts::DEFAULT_ACCOUNT_ID,
                )
            )
        }
    };

    let (
        pkg_mgr_version,
        node_version,
        git_version,
        (gh_version, gh_auth, gh_username),
        agent_probes,
        (vercel_version, vercel_whoami_result),
        (claude_auth_active, claude_auth_global),
    ) = tokio::join!(
        pkg_mgr_fut,
        node_fut,
        git_fut,
        gh_fut,
        agents_fut,
        vercel_fut,
        claude_auth_fut
    );

    let mut items = Vec::new();

    // 1. Package Manager (Homebrew on macOS/Linux, Winget on Windows)
    #[cfg(windows)]
    let pkg_mgr_name = "Winget";
    #[cfg(not(windows))]
    let pkg_mgr_name = "Package Manager";

    items.push(SetupItemInfo {
        id: "homebrew".to_string(), // Keep ID for backward compatibility
        friendly_name: pkg_mgr_name.to_string(),
        status: if pkg_mgr_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: pkg_mgr_version,
        username: None,
        error_message: None,
    });

    // 2. Node.js
    let node_installed = node_path.is_some();
    items.push(SetupItemInfo {
        id: "node".to_string(),
        friendly_name: "Node.js".to_string(),
        status: if node_installed {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: node_version,
        username: None,
        error_message: None,
    });

    // 2b. npm cache permissions (only check if Node is installed)
    if node_installed {
        let npm_cache_ok = if let Some(home) = dirs::home_dir() {
            let npm_cache = home.join(".npm");
            if !npm_cache.exists() {
                true
            } else {
                let test_file = npm_cache.join(".shipstudio-write-test");
                match std::fs::write(&test_file, "test") {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&test_file);
                        true
                    }
                    Err(_) => false,
                }
            }
        } else {
            true
        };

        if !npm_cache_ok {
            items.push(SetupItemInfo {
                id: "npm_fix".to_string(),
                friendly_name: "Fix npm Permissions".to_string(),
                status: SetupItemStatus::NotInstalled,
                version: None,
                username: None,
                error_message: Some(
                    "npm cache has incorrect permissions. Click to fix.".to_string(),
                ),
            });
        }
    }

    // 3. Git
    items.push(SetupItemInfo {
        id: "git".to_string(),
        friendly_name: "Git".to_string(),
        status: if git_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: git_version,
        username: None,
        error_message: None,
    });

    // 4. GitHub CLI
    items.push(SetupItemInfo {
        id: "gh".to_string(),
        friendly_name: "GitHub CLI".to_string(),
        status: if gh_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: gh_version,
        username: None,
        error_message: None,
    });

    // 5. GitHub Auth (probed above with a network timeout)
    items.push(SetupItemInfo {
        id: "gh_auth".to_string(),
        friendly_name: "GitHub Account".to_string(),
        status: if gh_auth {
            SetupItemStatus::Ready
        } else if gh_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: gh_username,
        error_message: None,
    });

    // 6-7. Agent CLIs and Auth — check ALL agents (probed above with timeouts).
    // claude_auth_active / claude_auth_global come from the joined
    // claude_auth_fut above.
    let mut detected_agents = Vec::new();

    for ((agent, agent_path), (agent_version, command_auth)) in
        ALL_AGENTS.iter().zip(&agent_paths).zip(agent_probes)
    {
        let binary_ready = agent_path.is_some();
        items.push(SetupItemInfo {
            id: agent.setup_item_ids.0.to_string(),
            friendly_name: agent.setup_display_names.0.to_string(),
            status: if binary_ready {
                SetupItemStatus::Ready
            } else {
                SetupItemStatus::NotInstalled
            },
            version: agent_version,
            username: None,
            error_message: None,
        });

        // Agent Auth
        let agent_auth = if !binary_ready {
            false
        } else if agent.id == "claude-code" {
            // Shared truth with the wizard pre-checks — see claude_auth_truth.
            claude_auth_active
        } else if let Some(authed) = command_auth {
            // Keychain-based agents (Cursor): ask the CLI, not the filesystem.
            authed
        } else {
            let agent_dir = agent_auth_dir(&active_account_id, agent);
            agent.auth_indicators.iter().any(|indicator| {
                let path = agent_dir.join(indicator);
                path.exists()
            })
        };
        items.push(SetupItemInfo {
            id: agent.setup_item_ids.1.to_string(),
            friendly_name: agent.setup_display_names.1.to_string(),
            status: if agent_auth {
                SetupItemStatus::Ready
            } else if binary_ready {
                SetupItemStatus::NotAuthenticated
            } else {
                SetupItemStatus::NotInstalled
            },
            version: None,
            username: None,
            error_message: None,
        });

        // Onboarding completeness ("is at least one agent installed and
        // authenticated on this machine") is a global concern independent of
        // which Workspace is active — otherwise switching to a fresh
        // Workspace that hasn't signed into any agent yet would force the
        // user back into the onboarding wizard. Check the Default account's
        // (real, global) auth dir for this purpose.
        let agent_auth_global = if !binary_ready {
            false
        } else if agent.id == "claude-code" {
            // Shared truth with the wizard pre-checks — see claude_auth_truth.
            claude_auth_global
        } else if let Some(authed) = command_auth {
            // Cursor's keychain login is already global (no per-account dir), so
            // the CLI status check is the same answer for every account.
            authed
        } else {
            let agent_dir = agent_auth_dir(crate::commands::accounts::DEFAULT_ACCOUNT_ID, agent);
            agent
                .auth_indicators
                .iter()
                .any(|indicator| agent_dir.join(indicator).exists())
        };

        if binary_ready && agent_auth_global {
            detected_agents.push(agent.id.to_string());
        }
    }

    // 8. Vercel CLI
    items.push(SetupItemInfo {
        id: "vercel".to_string(),
        friendly_name: "Vercel CLI".to_string(),
        status: if vercel_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: vercel_version,
        username: None,
        error_message: None,
    });

    // 9. Vercel Auth (probed above with a network timeout; see the per-workspace
    //    rules on the vercel probe future)
    let vercel_auth = vercel_whoami_result.is_some();
    let vercel_username = vercel_whoami_result;
    items.push(SetupItemInfo {
        id: "vercel_auth".to_string(),
        friendly_name: "Vercel Account".to_string(),
        status: if vercel_auth {
            SetupItemStatus::Ready
        } else if vercel_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: vercel_username,
        error_message: None,
    });

    // Required base items for setup completion (GitHub auth and individual agent items are optional)
    const REQUIRED_ITEMS: &[&str] = &["homebrew", "node", "git", "gh"];

    let base_ready = items
        .iter()
        .filter(|i| REQUIRED_ITEMS.contains(&i.id.as_str()) || i.id == "npm_fix")
        .all(|i| matches!(i.status, SetupItemStatus::Ready));

    // At least one agent pair must be fully ready — or the user declared they
    // bring their own agent ("Other" in agent-led onboarding).
    let external_agent = read_app_state().external_agent.unwrap_or(false);
    let at_least_one_agent = !detected_agents.is_empty() || external_agent;
    let all_ready = base_ready && at_least_one_agent;

    // Track optional auth status separately
    let github_authenticated = items
        .iter()
        .find(|i| i.id == "gh_auth")
        .map(|i| matches!(i.status, SetupItemStatus::Ready))
        .unwrap_or(false);

    // Force onboarding mode: run real checks but always report not-all-ready
    // so the onboarding wizard is shown with real item statuses
    let all_ready = if is_force_onboarding_mode() {
        false
    } else {
        all_ready
    };

    FullSetupStatus {
        all_ready,
        items,
        optional_auths: OptionalAuths {
            github_authenticated,
        },
        detected_agents,
    }
}

/// Quick setup check - only checks binary/file existence (no subprocess calls)
/// This is ~10ms vs 2-5 seconds for full setup check
#[tauri::command]
#[tracing::instrument]
pub async fn quick_setup_check() -> crate::types::QuickSetupCheck {
    // Force onboarding mode: always show onboarding with real checks
    if is_force_onboarding_mode() {
        return crate::types::QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Mock mode: always show onboarding so the mock scenario is visible
    if is_mock_mode() {
        return crate::types::QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Check persisted state first
    let app_state = read_app_state();

    if !app_state.setup_complete {
        return crate::types::QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Fast Tier-1 checks: binary existence only (no --version calls)
    #[cfg(windows)]
    let pkg_mgr_present = get_winget_command().is_some();
    #[cfg(not(windows))]
    let pkg_mgr_present = get_brew_command().is_some();

    let node_present = find_executable("node").is_some();
    let git_present = find_executable("git").is_some();
    let gh_present = find_executable("gh").is_some();

    // Check ALL agents — at least one pair must be present (or the user
    // opted to bring their own agent via "Other" in agent-led onboarding)
    let quick_account_id = app_state
        .active_account_id
        .clone()
        .unwrap_or_else(|| crate::commands::accounts::DEFAULT_ACCOUNT_ID.to_string());
    let at_least_one_agent = app_state.external_agent.unwrap_or(false)
        || ALL_AGENTS.iter().any(|agent| {
            let binary_present = find_binary_by_name(agent.binary_name).is_some();
            if !binary_present {
                return false;
            }
            // Same resolver as the full setup check — it has agent-specific
            // directory mappings (claude/codex/opencode), so the quick and
            // full checks can never disagree about auth state.
            let agent_dir = agent_auth_dir(&quick_account_id, agent);
            agent
                .auth_indicators
                .iter()
                .any(|indicator| agent_dir.join(indicator).exists())
        });

    // For gh_auth, we trust the cached state since checking requires subprocess
    // It will be verified in the background after showing projects

    let all_present =
        pkg_mgr_present && node_present && git_present && gh_present && at_least_one_agent;

    crate::types::QuickSetupCheck {
        all_present,
        setup_complete_cached: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_stdout_returns_trimmed_output() {
        let out = probe_stdout(Path::new("/bin/echo"), &["hello"], 5).await;
        assert_eq!(out.as_deref(), Some("hello"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_stdout_degrades_to_none_on_timeout() {
        // A wedged binary (simulated with `sleep`) must degrade to None
        // instead of hanging the status check.
        let out = probe_stdout(Path::new("/bin/sleep"), &["5"], 1).await;
        assert_eq!(out, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_stdout_degrades_to_none_on_nonzero_exit() {
        let out = probe_stdout(Path::new("/bin/sh"), &["-c", "echo nope; exit 3"], 5).await;
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn probe_stdout_degrades_to_none_on_missing_binary() {
        let out = probe_stdout(Path::new("/definitely/not/a/real/binary"), &[], 5).await;
        assert_eq!(out, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_stdout_first_line_takes_first_line() {
        let out = probe_stdout_first_line(
            Path::new("/bin/sh"),
            &["-c", "printf 'line1\\nline2\\n'"],
            5,
        )
        .await;
        assert_eq!(out.as_deref(), Some("line1"));
    }
}

/// A CLI binary resolved on the backend's extended PATH.
///
/// Returned by [`resolve_cli_path`] so the frontend can (a) fail fast with a
/// clear message when a binary is missing instead of spawning a PTY that
/// silently produces nothing, and (b) add the binary's directory to the PTY's
/// PATH so the spawn sees the same binary the status checks saw. The install
/// status checks (`find_executable`) search the user's login-shell PATH plus
/// common install locations — the frontend's hand-built PTY PATH is a subset,
/// so "installed ✓ but Connect hangs" was possible whenever a tool lived in a
/// nonstandard prefix (MacPorts, custom Homebrew, portable installs).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCli {
    /// Absolute path to the resolved binary.
    pub path: String,
    /// Directory containing the binary — for appending to a PTY PATH.
    pub dir: String,
}

/// Resolve a CLI binary name to an absolute path using the same discovery the
/// setup status checks use. Returns `Ok(None)` when the binary genuinely
/// isn't installed anywhere we know how to look.
#[tauri::command]
#[tracing::instrument]
pub async fn resolve_cli_path(name: String) -> Result<Option<ResolvedCli>, CommandError> {
    // Bare command names only — reject separators/metacharacters so this can
    // never be used to probe arbitrary filesystem paths from the frontend.
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid {
        return Err(CommandError::Validation {
            field: "name".to_string(),
            reason: "must be a bare command name".to_string(),
        });
    }

    // find_binary_by_name, NOT find_executable: it walks which() + the
    // extended PATH + well-known install dirs (~/.local/bin, ~/.opencode/bin,
    // …). On a fresh machine the claude installer drops the binary in
    // ~/.local/bin BEFORE any shell profile puts that dir on PATH — the
    // status checks (find_binary_by_name) saw it and reported "installed ✓",
    // while this resolver (find_executable) said "not found", so the
    // sign-in terminal refused to spawn. The checklist and this resolver
    // must share one notion of "installed".
    Ok(find_binary_by_name(&name).map(|path| {
        let dir = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        ResolvedCli {
            path: path.to_string_lossy().to_string(),
            dir,
        }
    }))
}

#[cfg(test)]
mod resolve_cli_tests {
    use super::resolve_cli_path;

    #[tokio::test]
    async fn resolves_a_ubiquitous_binary() {
        // `ls` exists on every Unix; `cmd` on every Windows.
        let name = if cfg!(windows) { "cmd" } else { "ls" };
        let resolved = resolve_cli_path(name.to_string()).await.unwrap();
        let resolved = resolved.expect("binary should resolve");
        assert!(!resolved.path.is_empty());
        assert!(!resolved.dir.is_empty());
    }

    #[tokio::test]
    async fn returns_none_for_missing_binary() {
        let resolved = resolve_cli_path("definitely-not-a-real-cli-98765".to_string())
            .await
            .unwrap();
        assert!(resolved.is_none());
    }

    #[tokio::test]
    async fn rejects_paths_and_metacharacters() {
        for bad in ["/bin/ls", "..\\cmd", "a b", "x;y", "", "ls\n"] {
            assert!(
                resolve_cli_path(bad.to_string()).await.is_err(),
                "should reject {bad:?}"
            );
        }
    }
}
