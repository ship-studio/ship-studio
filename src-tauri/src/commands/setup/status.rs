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
use crate::types::{FullSetupStatus, OptionalAuths, SetupItemInfo, SetupItemStatus};
use crate::utils::{create_command, find_executable};

#[cfg(windows)]
use crate::utils::check_winget;

#[cfg(not(windows))]
use crate::utils::check_homebrew;

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

    let mut items = Vec::new();

    // 1. Package Manager (Homebrew on macOS/Linux, Winget on Windows)
    #[cfg(windows)]
    let (pkg_mgr_installed, pkg_mgr_version) = check_winget();
    #[cfg(not(windows))]
    let (pkg_mgr_installed, pkg_mgr_version) = check_homebrew();

    #[cfg(windows)]
    let pkg_mgr_name = "Winget";
    #[cfg(not(windows))]
    let pkg_mgr_name = "Package Manager";

    items.push(SetupItemInfo {
        id: "homebrew".to_string(), // Keep ID for backward compatibility
        friendly_name: pkg_mgr_name.to_string(),
        status: if pkg_mgr_installed {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: pkg_mgr_version,
        username: None,
        error_message: None,
    });

    // 2. Node.js
    let node_path = find_executable("node");
    let node_version = node_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
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
    let git_path = find_executable("git");
    let git_version = git_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
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
    let gh_path = find_executable("gh");
    let gh_version = gh_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let out = String::from_utf8_lossy(&o.stdout);
                    out.lines().next().map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
    });
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

    // 5. GitHub Auth
    //
    // Parse the output for a valid active login rather than trusting the exit
    // code: `gh auth status` exits non-zero if any configured account has an
    // invalid token, even when the active account is fine — which would wrongly
    // strand the user on the GitHub step of onboarding. See
    // accounts::parse_gh_auth_status.
    let gh_auth = if gh_path.is_some() {
        get_gh_command()
            .args(["auth", "status"])
            .output()
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
    let gh_username = if gh_auth {
        get_gh_command()
            .args(["api", "user", "--jq", ".login"])
            .output()
            .ok()
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

    // 6-7. Agent CLIs and Auth — check ALL agents
    let mut detected_agents = Vec::new();
    let active_account_id = get_active_account_id().unwrap_or_else(|_| "default".to_string());

    for agent in ALL_AGENTS {
        let agent_path = find_binary_by_name(agent.binary_name);
        let agent_version = agent_path.as_ref().and_then(|p| {
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
        } else if let Some(authed) =
            crate::commands::setup::agents::agent_command_auth_status(agent)
        {
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
        } else if let Some(authed) =
            crate::commands::setup::agents::agent_command_auth_status(agent)
        {
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
    let vercel_path = find_executable("vercel");
    let vercel_version = vercel_path.as_ref().and_then(|p| {
        create_command(p)
            .args(["--version"])
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

    // 9. Vercel Auth — per-workspace:
    //    • Non-default accounts: only authed if VERCEL_TOKEN is in the
    //      account's keychain (browser-based `vercel login` stores a global
    //      session that would bleed across workspaces — require an explicit
    //      token instead so each workspace is fully isolated).
    //    • Default account: existing global `vercel whoami` behaviour
    //      (preserves logins from before Workspace isolation existed).
    let account_vercel_token = get_env_vars_for_account(&active_account_id).remove("VERCEL_TOKEN");
    let run_vercel_whoami = |token: Option<&str>| -> Option<String> {
        let p = find_executable("vercel")?;
        let mut cmd = create_command(&p);
        cmd.args(["whoami"]);
        if let Some(t) = token {
            cmd.env("VERCEL_TOKEN", t);
        }
        let out = cmd.output().ok()?;
        if out.status.success() {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            None
        }
    };
    let vercel_whoami_result = if vercel_path.is_some() {
        if let Some(ref token) = account_vercel_token {
            // Account has an explicit token → verify it and get username
            run_vercel_whoami(Some(token))
        } else if active_account_id == DEFAULT_ACCOUNT_ID {
            // Default account → use global CLI session (browser-based login)
            run_vercel_whoami(None)
        } else {
            // Non-default account without a token → not connected for this workspace
            None
        }
    } else {
        None
    };
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

    // At least one agent pair must be fully ready
    let at_least_one_agent = !detected_agents.is_empty();
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
    let pkg_mgr_present = check_winget().0;
    #[cfg(not(windows))]
    let pkg_mgr_present = check_homebrew().0;

    let node_present = find_executable("node").is_some();
    let git_present = find_executable("git").is_some();
    let gh_present = find_executable("gh").is_some();

    // Check ALL agents — at least one pair must be present
    let at_least_one_agent = ALL_AGENTS.iter().any(|agent| {
        let binary_present = find_binary_by_name(agent.binary_name).is_some();
        if !binary_present {
            return false;
        }
        if let Some(home) = dirs::home_dir() {
            let agent_dir = home.join(agent.auth_config_dir);
            agent
                .auth_indicators
                .iter()
                .any(|indicator| agent_dir.join(indicator).exists())
        } else {
            false
        }
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
