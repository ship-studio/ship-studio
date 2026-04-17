//! # Setup/Onboarding Commands
//!
//! Commands for the setup wizard and onboarding flow.
//!
//! ## Testing Modes
//!
//! Two env vars control onboarding testing:
//!
//! ### `SHIPSTUDIO_FORCE_ONBOARDING=1`
//! Forces the onboarding wizard to appear but runs REAL system checks.
//! Items show their actual status. Terminal installs work normally.
//! After completing onboarding, an in-memory flag (`FORCE_ONBOARDING_COMPLETED`)
//! prevents background verification from looping back. Nothing is persisted
//! to disk, so onboarding shows again on next launch.
//!
//! ### `SHIPSTUDIO_FORCE_SETUP=<scenario>`
//! Uses a fully mocked backend. Item statuses are faked based on the scenario.
//! Clicking "Install" triggers a 2-second mock install. Terminal-based items
//! (homebrew, gh_auth, claude, codex) still spawn real processes.
//! Scenarios: `fresh`, `auth-only`, `almost-done`, `both-agents`, `codex-only`,
//! or comma-separated item IDs (e.g. `homebrew,node,git,gh,gh_auth`).
//!
//! ## Submodules
//!
//! - `state` — AppState persistence (read/write, mark_setup_complete, agent ID)
//! - `status` — Full and quick setup status checks
//! - `install` — Tool installation via Homebrew/Winget
//! - `auth` — Authentication flows, process cleanup, version management

mod agents;
mod auth;
mod install;
mod state;
mod status;

pub use agents::*;
pub use auth::*;
pub use install::*;
pub use state::*;
pub use status::*;

use crate::types::AppState;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

// ============ Shared State ============

// Mock state for testing - tracks which items have been "installed" in debug mode
pub(super) static MOCK_INSTALLED: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static MOCK_INITIALIZED: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));
/// Global registry of spawned auth process PIDs for cleanup
/// Maps auth type (e.g., "github", "claude") -> OS process ID (PID)
pub(super) static AUTH_PIDS: LazyLock<Mutex<std::collections::HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
/// Tracks whether onboarding was completed this session in force-onboarding mode.
/// Once set, stop overriding all_ready so background verification doesn't loop.
pub(super) static FORCE_ONBOARDING_COMPLETED: LazyLock<Mutex<bool>> =
    LazyLock::new(|| Mutex::new(false));

/// All setup item IDs in dependency order
const ALL_ITEMS: &[&str] = &[
    "homebrew",
    "node",
    "git",
    "gh",
    "gh_auth",
    "claude",
    "claude_auth",
    "codex",
    "codex_auth",
    "opencode",
    "opencode_auth",
    "vercel",
    "vercel_auth",
];

/// Tool items (not auth)
const TOOL_ITEMS: &[&str] = &[
    "homebrew", "node", "git", "gh", "claude", "codex", "opencode", "vercel",
];

// ============ App State Persistence (shared helpers) ============

/// Read the persisted app state
pub fn read_app_state() -> AppState {
    let path = state::get_app_state_path();
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
    let path = state::get_app_state_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app state directory: {e}"))?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {e}"))?;

    std::fs::write(&path, json).map_err(|e| format!("Failed to write app state: {e}"))
}

// ============ Mock Mode ============

/// Get items that should be pre-installed for a given scenario
fn get_scenario_items(scenario: &str) -> Vec<&'static str> {
    match scenario {
        // Fresh install - nothing installed (default)
        "1" | "fresh" => vec![],

        // All tools installed, but no auth configured
        "auth-only" => TOOL_ITEMS.to_vec(),

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

        // Almost done - only gh_auth left
        "almost-done" => ALL_ITEMS
            .iter()
            .filter(|&&item| item != "gh_auth")
            .copied()
            .collect(),

        // Both agents installed and authed + vercel (tests agent selection screen)
        "both-agents" => ALL_ITEMS.to_vec(),

        // Vercel installed and authed (for testing hosting step)
        "vercel-ready" => vec!["vercel", "vercel_auth"],

        // Only Codex installed (no Claude, no Opencode)
        "codex-only" => ALL_ITEMS
            .iter()
            .filter(|&&item| {
                item != "claude"
                    && item != "claude_auth"
                    && item != "opencode"
                    && item != "opencode_auth"
            })
            .copied()
            .collect(),

        // Only Opencode installed (no Claude, no Codex)
        "opencode-only" => ALL_ITEMS
            .iter()
            .filter(|&&item| {
                item != "claude" && item != "claude_auth" && item != "codex" && item != "codex_auth"
            })
            .copied()
            .collect(),

        // Comma-separated list of specific items to pre-install
        // e.g., "homebrew,node,git" or "homebrew,node,git,gh,gh_auth,claude,claude_auth"
        _ => scenario
            .split(',')
            .map(|s| s.trim())
            .filter_map(|s| ALL_ITEMS.iter().find(|&&item| item == s).copied())
            .collect(),
    }
}

/// Initialize mock state from SHIPSTUDIO_FORCE_SETUP env var
fn initialize_mock_state() {
    let mut initialized = MOCK_INITIALIZED
        .lock()
        .expect("MOCK_INITIALIZED mutex poisoned");
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

/// Check if we're in "force onboarding" mode.
/// Unlike mock mode, this runs REAL system checks but forces the onboarding
/// screen to appear so you can test the wizard flow on a fully set up machine.
/// Once onboarding completes this session, stops overriding so background
/// verification doesn't loop back.
///
/// Usage: SHIPSTUDIO_FORCE_ONBOARDING=1 npm run tauri dev
pub(super) fn is_force_onboarding_mode() -> bool {
    if std::env::var("SHIPSTUDIO_FORCE_ONBOARDING").is_err() {
        return false;
    }
    // Once onboarding completed this session, stop forcing
    FORCE_ONBOARDING_COMPLETED
        .lock()
        .map(|completed| !*completed)
        .unwrap_or(false)
}

/// Mark an item as mock-installed (for testing)
pub fn mock_install(item_id: &str) {
    if let Ok(mut set) = MOCK_INSTALLED.lock() {
        set.insert(item_id.to_string());
    }
}

/// Check if an item is mock-installed
pub(super) fn is_mock_installed(item_id: &str) -> bool {
    MOCK_INSTALLED
        .lock()
        .map(|set| set.contains(item_id))
        .unwrap_or(false)
}

// ============ Tests ============

#[cfg(test)]
mod tests {
    use super::*;

    // ============ get_scenario_items ============

    #[test]
    fn scenario_fresh_returns_empty() {
        let items = get_scenario_items("fresh");
        assert!(items.is_empty());
    }

    #[test]
    fn scenario_1_alias_returns_empty() {
        let items = get_scenario_items("1");
        assert!(items.is_empty());
    }

    #[test]
    fn scenario_auth_only_returns_tool_items() {
        let items = get_scenario_items("auth-only");
        assert_eq!(items, TOOL_ITEMS.to_vec());
    }

    #[test]
    fn scenario_both_agents_returns_all_items() {
        let items = get_scenario_items("both-agents");
        assert_eq!(items, ALL_ITEMS.to_vec());
    }

    #[test]
    fn scenario_codex_only_excludes_claude() {
        let items = get_scenario_items("codex-only");
        assert!(!items.contains(&"claude"));
        assert!(!items.contains(&"claude_auth"));
        assert!(items.contains(&"codex"));
        assert!(items.contains(&"codex_auth"));
    }

    #[test]
    fn scenario_github_missing_excludes_gh_auth() {
        let items = get_scenario_items("github-missing");
        assert!(!items.contains(&"gh_auth"));
        assert!(items.contains(&"gh"));
    }

    #[test]
    fn scenario_homebrew_missing_excludes_homebrew() {
        let items = get_scenario_items("homebrew-missing");
        assert!(!items.contains(&"homebrew"));
        assert!(items.contains(&"node"));
    }

    #[test]
    fn scenario_comma_separated_returns_exact_items() {
        let items = get_scenario_items("homebrew,node,git");
        assert_eq!(items.len(), 3);
        assert!(items.contains(&"homebrew"));
        assert!(items.contains(&"node"));
        assert!(items.contains(&"git"));
    }

    #[test]
    fn scenario_unknown_item_in_csv_returns_empty() {
        let items = get_scenario_items("unknown_item");
        assert!(items.is_empty());
    }

    #[test]
    fn all_items_contains_13_items_including_all_agents_and_vercel() {
        assert_eq!(ALL_ITEMS.len(), 13);
        assert!(ALL_ITEMS.contains(&"codex"));
        assert!(ALL_ITEMS.contains(&"codex_auth"));
        assert!(ALL_ITEMS.contains(&"opencode"));
        assert!(ALL_ITEMS.contains(&"opencode_auth"));
        assert!(ALL_ITEMS.contains(&"vercel"));
        assert!(ALL_ITEMS.contains(&"vercel_auth"));
    }

    #[test]
    fn tool_items_contains_8_items_including_all_agents_and_vercel() {
        assert_eq!(TOOL_ITEMS.len(), 8);
        assert!(TOOL_ITEMS.contains(&"codex"));
        assert!(TOOL_ITEMS.contains(&"claude"));
        assert!(TOOL_ITEMS.contains(&"opencode"));
        assert!(TOOL_ITEMS.contains(&"vercel"));
    }

    #[test]
    fn scenario_opencode_only_excludes_claude_and_codex() {
        let items = get_scenario_items("opencode-only");
        assert!(!items.contains(&"claude"));
        assert!(!items.contains(&"codex"));
        assert!(items.contains(&"opencode"));
        assert!(items.contains(&"opencode_auth"));
    }

    // ============ AppState ============

    #[test]
    fn app_state_default_has_no_default_agent_id() {
        let state = AppState::default();
        assert!(state.default_agent_id.is_none());
        assert!(!state.setup_complete);
    }

    #[test]
    fn app_state_deserializes_without_default_agent_id() {
        // Simulate a legacy JSON without the default_agent_id field
        let json = r#"{"setupComplete": true, "setupCompletedAt": 12345}"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        assert!(state.setup_complete);
        assert!(state.default_agent_id.is_none());
    }

    #[test]
    fn app_state_deserializes_with_default_agent_id() {
        let json = r#"{"setupComplete": true, "defaultAgentId": "codex"}"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        assert_eq!(state.default_agent_id, Some("codex".to_string()));
    }
}
