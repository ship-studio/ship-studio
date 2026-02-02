//! # Setup/Onboarding Commands
//!
//! Commands for the setup wizard and onboarding flow.

use crate::commands::claude::find_claude_binary;
use crate::commands::github::get_gh_command;
use crate::commands::vercel::{find_vercel_binary, get_vercel_command};
use crate::types::{
    AppState, FullSetupStatus, OptionalAuths, QuickSetupCheck, SetupItemInfo, SetupItemStatus,
};
use crate::utils::{check_homebrew, find_executable, get_brew_command};
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

// ============ App State Persistence ============

/// Get the app state file path
fn get_app_state_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/ShipStudio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ShipStudio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("C:/temp/ship-studio-app-state.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .map(|d| d.join("ship-studio/app_state.json"))
            .unwrap_or_else(|| PathBuf::from("/tmp/ship-studio-app-state.json"))
    }
}

/// Read the persisted app state
pub fn read_app_state() -> AppState {
    let path = get_app_state_path();
    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        AppState::default()
    }
}

/// Write the app state to disk
pub fn write_app_state(state: &AppState) -> Result<(), String> {
    let path = get_app_state_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {}", e))?;

    std::fs::write(&path, json).map_err(|e| format!("Failed to write app state: {}", e))
}

// Mock state for testing - tracks which items have been "installed" in debug mode
lazy_static::lazy_static! {
    static ref MOCK_INSTALLED: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    static ref MOCK_INITIALIZED: Mutex<bool> = Mutex::new(false);
    /// Global registry of spawned auth process PIDs for cleanup
    /// Maps auth type (e.g., "github", "claude", "vercel") -> OS process ID (PID)
    static ref AUTH_PIDS: Mutex<std::collections::HashMap<String, u32>> = Mutex::new(std::collections::HashMap::new());
}

/// All setup item IDs in dependency order
const ALL_ITEMS: &[&str] = &[
    "homebrew",
    "node",
    "git",
    "gh",
    "gh_auth",
    "claude",
    "claude_auth",
    "vercel",
    "vercel_auth",
];

/// Tool items (not auth)
const TOOL_ITEMS: &[&str] = &["homebrew", "node", "git", "gh", "claude", "vercel"];

/// Get items that should be pre-installed for a given scenario
fn get_scenario_items(scenario: &str) -> Vec<&'static str> {
    match scenario {
        // Fresh install - nothing installed (default)
        "1" | "fresh" => vec![],

        // All tools installed, but no auth configured
        "auth-only" => TOOL_ITEMS.to_vec(),

        // Everything except Vercel auth
        "vercel-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "vercel_auth")
            .copied()
            .collect(),

        // Everything except GitHub auth
        "github-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "gh_auth")
            .copied()
            .collect(),

        // Everything except Claude auth
        "claude-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "claude_auth")
            .copied()
            .collect(),

        // Only Homebrew missing (tests dependency blocking)
        "homebrew-missing" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "homebrew")
            .copied()
            .collect(),

        // Almost done - only vercel_auth left
        "almost-done" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "vercel_auth")
            .copied()
            .collect(),

        // Comma-separated list of specific items to pre-install
        // e.g., "homebrew,node,git" or "homebrew,node,git,gh,gh_auth,claude,claude_auth,vercel"
        _ => scenario
            .split(',')
            .map(|s| s.trim())
            .filter_map(|s| ALL_ITEMS.iter().find(|&&item| item == s).copied())
            .collect(),
    }
}

/// Initialize mock state from SHIPSTUDIO_FORCE_SETUP env var
fn initialize_mock_state() {
    let mut initialized = MOCK_INITIALIZED.lock().unwrap();
    if *initialized {
        return;
    }
    *initialized = true;

    if let Ok(scenario) = std::env::var("SHIPSTUDIO_FORCE_SETUP") {
        let items = get_scenario_items(&scenario);
        if let Ok(mut set) = MOCK_INSTALLED.lock() {
            for item in items {
                set.insert(item.to_string());
            }
        }
        tracing::info!(scenario = scenario, "Mock mode initialized with scenario");
    }
}

/// Check if we're in mock/debug mode
pub fn is_mock_mode() -> bool {
    let is_mock = std::env::var("SHIPSTUDIO_FORCE_SETUP").is_ok();
    if is_mock {
        initialize_mock_state();
    }
    is_mock
}

/// Mark an item as mock-installed (for testing)
pub fn mock_install(item_id: &str) {
    if let Ok(mut set) = MOCK_INSTALLED.lock() {
        set.insert(item_id.to_string());
    }
}

/// Check if an item is mock-installed
fn is_mock_installed(item_id: &str) -> bool {
    MOCK_INSTALLED
        .lock()
        .map(|set| set.contains(item_id))
        .unwrap_or(false)
}

/// Get full setup status for all items
#[tauri::command]
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
            ("vercel", "Vercel CLI", Some("node")),
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
        let vercel_authenticated = mock_items
            .iter()
            .find(|i| i.id == "vercel_auth")
            .map(|i| matches!(i.status, SetupItemStatus::Ready))
            .unwrap_or(false);

        // Required items for setup completion (GitHub and Vercel auth are optional)
        const REQUIRED_ITEMS_MOCK: &[&str] = &[
            "homebrew",
            "node",
            "git",
            "gh",
            "claude",
            "claude_auth",
            "vercel",
        ];

        let all_ready = mock_items
            .iter()
            .filter(|i| REQUIRED_ITEMS_MOCK.contains(&i.id.as_str()))
            .all(|i| matches!(i.status, SetupItemStatus::Ready));
        return FullSetupStatus {
            all_ready,
            items: mock_items,
            optional_auths: OptionalAuths {
                github_authenticated,
                vercel_authenticated,
            },
        };
    }

    let mut items = Vec::new();

    // 1. Homebrew
    let (brew_installed, brew_version) = check_homebrew();
    items.push(SetupItemInfo {
        id: "homebrew".to_string(),
        friendly_name: "Package Manager".to_string(),
        status: if brew_installed {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: brew_version,
        username: None,
        error_message: None,
    });

    // 2. Node.js
    let node_path = find_executable("node");
    let node_version = node_path.as_ref().and_then(|p| {
        Command::new(p)
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
        id: "node".to_string(),
        friendly_name: "Node.js".to_string(),
        status: if node_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: node_version,
        username: None,
        error_message: None,
    });

    // 3. Git
    let git_path = find_executable("git");
    let git_version = git_path.as_ref().and_then(|p| {
        Command::new(p)
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
        Command::new(p)
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
    let gh_auth = if gh_path.is_some() {
        get_gh_command()
            .args(["auth", "status"])
            .output()
            .map(|o| o.status.success())
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

    // 6. Claude Code
    let claude_path = find_claude_binary();
    let claude_version = claude_path.as_ref().and_then(|p| {
        Command::new(p)
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
        id: "claude".to_string(),
        friendly_name: "Claude Code".to_string(),
        status: if claude_path.is_some() {
            SetupItemStatus::Ready
        } else {
            SetupItemStatus::NotInstalled
        },
        version: claude_version,
        username: None,
        error_message: None,
    });

    // 7. Claude Auth
    let claude_auth = if claude_path.is_some() {
        if let Some(home) = dirs::home_dir() {
            let claude_dir = home.join(".claude");
            // Check for various indicators that Claude has been authenticated/used:
            // - settings.json (older versions)
            // - statsig directory (created after auth)
            // - projects directory (created after using Claude)
            let settings_exists = claude_dir.join("settings.json").exists();
            let statsig_exists = claude_dir.join("statsig").is_dir();
            let projects_exists = claude_dir.join("projects").is_dir();
            settings_exists || statsig_exists || projects_exists
        } else {
            false
        }
    } else {
        false
    };
    items.push(SetupItemInfo {
        id: "claude_auth".to_string(),
        friendly_name: "Claude Account".to_string(),
        status: if claude_auth {
            SetupItemStatus::Ready
        } else if claude_path.is_some() {
            SetupItemStatus::NotAuthenticated
        } else {
            SetupItemStatus::NotInstalled
        },
        version: None,
        username: None,
        error_message: None,
    });

    // 8. Vercel CLI
    let vercel_path = find_vercel_binary();
    let vercel_version = vercel_path.as_ref().and_then(|p| {
        Command::new(p)
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

    // 9. Vercel Auth
    let vercel_auth = if vercel_path.is_some() {
        get_vercel_command()
            .args(["whoami"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    let vercel_username = if vercel_auth {
        get_vercel_command()
            .args(["whoami"])
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

    // Required items for setup completion (GitHub and Vercel auth are optional)
    const REQUIRED_ITEMS: &[&str] = &[
        "homebrew",
        "node",
        "git",
        "gh",
        "claude",
        "claude_auth",
        "vercel",
    ];

    let all_ready = items
        .iter()
        .filter(|i| REQUIRED_ITEMS.contains(&i.id.as_str()))
        .all(|i| matches!(i.status, SetupItemStatus::Ready));

    // Track optional auth status separately
    let github_authenticated = items
        .iter()
        .find(|i| i.id == "gh_auth")
        .map(|i| matches!(i.status, SetupItemStatus::Ready))
        .unwrap_or(false);

    let vercel_authenticated = items
        .iter()
        .find(|i| i.id == "vercel_auth")
        .map(|i| matches!(i.status, SetupItemStatus::Ready))
        .unwrap_or(false);

    FullSetupStatus {
        all_ready,
        items,
        optional_auths: OptionalAuths {
            github_authenticated,
            vercel_authenticated,
        },
    }
}

/// Quick setup check - only checks binary/file existence (no subprocess calls)
/// This is ~10ms vs 2-5 seconds for full setup check
#[tauri::command]
pub async fn quick_setup_check() -> QuickSetupCheck {
    // Check persisted state first
    let app_state = read_app_state();

    if !app_state.setup_complete {
        return QuickSetupCheck {
            all_present: false,
            setup_complete_cached: false,
        };
    }

    // Fast Tier-1 checks: binary existence only (no --version calls)
    let brew_present = check_homebrew().0;
    let node_present = find_executable("node").is_some();
    let git_present = find_executable("git").is_some();
    let gh_present = find_executable("gh").is_some();
    let claude_present = find_claude_binary().is_some();
    let vercel_present = find_vercel_binary().is_some();

    // Fast auth checks: file/directory existence only
    let claude_auth_present = if let Some(home) = dirs::home_dir() {
        let claude_dir = home.join(".claude");
        claude_dir.join("settings.json").exists()
            || claude_dir.join("statsig").is_dir()
            || claude_dir.join("projects").is_dir()
    } else {
        false
    };

    // For gh_auth and vercel_auth, we trust the cached state since checking requires subprocess
    // These will be verified in the background after showing projects

    let all_present = brew_present
        && node_present
        && git_present
        && gh_present
        && claude_present
        && vercel_present
        && claude_auth_present;

    QuickSetupCheck {
        all_present,
        setup_complete_cached: true,
    }
}

/// Mark setup as complete (persists to disk)
#[tauri::command]
pub async fn mark_setup_complete() -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Read existing state to preserve other fields (e.g., compact_mode)
    let mut state = read_app_state();
    state.setup_complete = true;
    state.setup_completed_at = Some(timestamp);

    write_app_state(&state)?;
    tracing::info!("Setup marked as complete");
    Ok(())
}

/// Clear setup complete flag (for testing/reset)
#[tauri::command]
pub async fn reset_setup_state() -> Result<(), String> {
    // Read existing state to preserve other fields (e.g., compact_mode)
    let mut state = read_app_state();
    state.setup_complete = false;
    state.setup_completed_at = None;

    write_app_state(&state)?;
    tracing::info!("Setup state reset");
    Ok(())
}

/// Install Homebrew
#[tauri::command]
pub async fn install_homebrew(app: tauri::AppHandle) -> Result<(), String> {
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

    let output = Command::new("bash")
        .args(["-c", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""])
        .env("NONINTERACTIVE", "1")
        .output()
        .map_err(|e| format!("Failed to run Homebrew installer: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Homebrew installation failed: {}", stderr));
    }

    Ok(())
}

/// Install Node.js via Homebrew
#[tauri::command]
pub async fn install_node_via_brew(app: tauri::AppHandle) -> Result<(), String> {
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

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "node"])
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install Node.js: {}", stderr));
    }

    Ok(())
}

/// Install Git via Homebrew
#[tauri::command]
pub async fn install_git_via_brew(app: tauri::AppHandle) -> Result<(), String> {
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

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "git"])
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install Git: {}", stderr));
    }

    Ok(())
}

/// Install GitHub CLI via Homebrew
#[tauri::command]
pub async fn install_gh_via_brew(app: tauri::AppHandle) -> Result<(), String> {
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

    let brew = get_brew_command().ok_or("Homebrew not found")?;

    let output = Command::new(&brew)
        .args(["install", "gh"])
        .output()
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install GitHub CLI: {}", stderr));
    }

    Ok(())
}

/// Start GitHub authentication (opens browser)
#[tauri::command]
pub async fn start_github_auth(app: tauri::AppHandle) -> Result<String, String> {
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

    let child = Command::new(&gh_path)
        .args([
            "auth",
            "login",
            "--web",
            "--git-protocol",
            "https",
            "--clipboard",
        ])
        .spawn()
        .map_err(|e| format!("Failed to start GitHub auth: {}", e))?;

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

/// Start Claude authentication
#[tauri::command]
pub async fn start_claude_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "claude_auth",
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("claude_auth");
        return Ok("Mock auth completed".to_string());
    }

    let claude_path = find_claude_binary().ok_or("Claude Code not installed")?;

    let child = Command::new(&claude_path)
        .args(["--print", "hello"])
        .spawn()
        .map_err(|e| format!("Failed to start Claude auth: {}", e))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert("claude".to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove("claude");
        }
    });

    Ok("Browser opened. Log in to your Anthropic account to continue.".to_string())
}

/// Check if Claude is authenticated
#[tauri::command]
pub async fn check_claude_auth_status() -> bool {
    if is_mock_mode() {
        return is_mock_installed("claude_auth");
    }

    if find_claude_binary().is_none() {
        return false;
    }

    if let Some(home) = dirs::home_dir() {
        let claude_dir = home.join(".claude");
        // Check for various indicators that Claude has been authenticated/used:
        // - settings.json (older versions)
        // - statsig directory (created after auth)
        // - projects directory with content (created after using Claude)
        let settings_exists = claude_dir.join("settings.json").exists();
        let statsig_exists = claude_dir.join("statsig").is_dir();
        let projects_exists = claude_dir.join("projects").is_dir();

        return settings_exists || statsig_exists || projects_exists;
    }

    false
}

/// Start Vercel authentication (opens browser)
#[tauri::command]
pub async fn start_vercel_auth(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "itemId": "vercel_auth",
            "message": "Opening browser..."
        }),
    );

    if is_mock_mode() {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        mock_install("vercel_auth");
        return Ok("Mock auth completed".to_string());
    }

    let child = get_vercel_command()
        .arg("login")
        .spawn()
        .map_err(|e| format!("Failed to start Vercel auth: {}", e))?;

    // Store the process PID for potential cleanup instead of forgetting it
    let pid = child.id();
    if let Ok(mut pids) = AUTH_PIDS.lock() {
        pids.insert("vercel".to_string(), pid);
    }
    // Spawn a thread to wait for the process and clean up the registry when it exits
    std::thread::spawn(move || {
        let _ = child.wait_with_output();
        if let Ok(mut pids) = AUTH_PIDS.lock() {
            pids.remove("vercel");
        }
    });

    Ok("Browser opened. Log in to your Vercel account to continue.".to_string())
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
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }

        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
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
pub async fn cleanup_auth_processes() -> Result<u32, String> {
    Ok(cleanup_auth_processes_sync())
}
