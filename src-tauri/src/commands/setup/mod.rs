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
//! In the classic wizard, clicking "Install" triggers a 2-second mock install
//! and terminal-based items (homebrew, gh_auth, claude, codex) still spawn
//! real processes. The agent-led onboarding is fully deterministic under this
//! mode: actions flip mock state directly and the guided phase plays a
//! scripted demo session driven by `mock_mark_setup_item_ready`.
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

use crate::errors::CommandError;
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
    "cursor",
    "cursor_auth",
    "copilot",
    "copilot_auth",
    "pi",
    "pi_auth",
    "hermes",
    "hermes_auth",
    "devin",
    "devin_auth",
    "grok",
    "grok_auth",
    "kimi-code",
    "kimi-code_auth",
    "antigravity-cli",
    "antigravity-cli_auth",
    "jcode",
    "jcode_auth",
    "droid",
    "droid_auth",
    "amp",
    "amp_auth",
    "qwen",
    "qwen_auth",
    "vercel",
    "vercel_auth",
];

/// Tool items (not auth)
const TOOL_ITEMS: &[&str] = &[
    "homebrew",
    "node",
    "git",
    "gh",
    "claude",
    "codex",
    "opencode",
    "cursor",
    "copilot",
    "pi",
    "hermes",
    "devin",
    "grok",
    "kimi-code",
    "antigravity-cli",
    "jcode",
    "droid",
    "amp",
    "qwen",
    "vercel",
];

// ============ App State Persistence (shared helpers) ============

/// Read the persisted app state, falling back to defaults if it can't be read.
///
/// Read-only callers can use this directly. Anything doing read-modify-write
/// must go through [`try_read_app_state`] instead — see its doc comment.
pub fn read_app_state() -> AppState {
    try_read_app_state().unwrap_or_else(|e| {
        // Not `error!`: an unreadable state file is an environment condition
        // (the file is transiently locked, the disk is busy), and this path
        // already degrades safely to defaults for read-only callers (#756).
        tracing::warn!("Failed to read app state file, using defaults: {e}");
        AppState::default()
    })
}

/// Read the persisted app state, distinguishing "nothing saved yet" (`Ok` with
/// defaults) from "couldn't read what's saved" (`Err`).
///
/// A transient read failure — Windows ERROR_NO_SYSTEM_RESOURCES (os error 1450)
/// was the reported one — used to silently yield `AppState::default()`, which
/// the read-modify-write call sites then persisted straight over an intact
/// file, wiping workspaces/accounts/setup flags. Those call sites must abort
/// the write instead (issue #756). A single retry absorbs the transient case.
///
/// A *parse* failure is not an error here: it keeps its existing best-effort
/// partial recovery, which is strictly better than refusing to write forever.
pub fn try_read_app_state() -> Result<AppState, std::io::Error> {
    let path = state::get_app_state_path();
    if !path.exists() {
        return Ok(AppState::default());
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(first) => {
            std::thread::sleep(std::time::Duration::from_millis(100));
            match std::fs::read_to_string(&path) {
                Ok(s) => s,
                // Report the original error: the retry's may be a different
                // (less informative) symptom of the same condition.
                Err(_) => return Err(first),
            }
        }
    };

    Ok(match serde_json::from_str::<AppState>(&raw) {
        Ok(state) => state,
        Err(e) => {
            // Log the parse failure so it's visible in ~/Library/Logs/ShipStudio/
            // rather than silently resetting all data (including saved Workspaces).
            tracing::error!("Failed to parse app state — keeping defaults. Error: {e}. Raw: {raw}");
            // Attempt a best-effort partial recovery: pull the accounts array out
            // of the raw JSON even if other fields fail to parse. This prevents
            // a one-time schema evolution from wiping all workspaces.
            if let Ok(raw_value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let mut state = AppState::default();
                if let Some(accounts_val) = raw_value.get("accounts") {
                    if let Ok(accounts) =
                        serde_json::from_value::<Vec<crate::types::Account>>(accounts_val.clone())
                    {
                        state.accounts = accounts;
                    }
                }
                if let Some(id) = raw_value.get("activeAccountId").and_then(|v| v.as_str()) {
                    state.active_account_id = Some(id.to_string());
                }
                return Ok(state);
            }
            AppState::default()
        }
    })
}

/// Read-modify-write the persisted app state.
///
/// The only safe way to change one field: reading through `try_read_app_state`
/// means a transient read failure aborts the write instead of persisting
/// `AppState::default()` over an intact file, which would wipe every field the
/// caller wasn't even touching — accounts/workspaces included (issue #756).
pub fn update_app_state<T>(
    mutate: impl FnOnce(&mut AppState) -> T,
) -> Result<T, crate::errors::CommandError> {
    let mut state = try_read_app_state().map_err(|e| {
        crate::errors::CommandError::expected(format!(
            "Ship Studio couldn't read its saved settings ({e}), so nothing was changed — \
             your existing settings are safe. Try again in a moment."
        ))
    })?;
    let out = mutate(&mut state);
    write_app_state(&state)?;
    Ok(out)
}

/// Write the app state to disk
pub fn write_app_state(state: &AppState) -> Result<(), crate::errors::CommandError> {
    let path = state::get_app_state_path();

    // Ensure parent directory exists. Filesystem failures go through the
    // shared classifier so EACCES / a read-only volume / a full disk come
    // back as actionable Expected errors, not raw OS strings (issue #858).
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::utils::classify_fs_error("create the app state directory", parent, &e)
        })?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize app state: {e}"))?;

    // Atomic write: write to a temp file in the same directory, then rename over
    // the real file. `rename` is atomic on the same filesystem, so a reader can
    // never observe a half-written file and — critically — if the process is
    // killed mid-write (e.g. a dev-server relaunch, a crash, or the OS), the
    // real `app_state.json` is left intact rather than truncated. A truncated
    // state file is unparseable and silently resets to defaults, which is how a
    // freshly-created Workspace could vanish on the next launch.
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json)
        .map_err(|e| crate::utils::classify_fs_error("write the app state file", &tmp_path, &e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| crate::utils::classify_fs_error("persist the app state file", &path, &e))
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

        // Only Codex installed (no Claude, no Opencode, no Cursor, no new agents)
        "codex-only" => ALL_ITEMS
            .iter()
            .filter(|&&item| {
                item != "claude"
                    && item != "claude_auth"
                    && item != "opencode"
                    && item != "opencode_auth"
                    && item != "cursor"
                    && item != "cursor_auth"
                    && item != "copilot"
                    && item != "copilot_auth"
                    && item != "pi"
                    && item != "pi_auth"
                    && item != "hermes"
                    && item != "hermes_auth"
                    && item != "devin"
                    && item != "devin_auth"
                    && item != "grok"
                    && item != "grok_auth"
                    && item != "kimi-code"
                    && item != "kimi-code_auth"
                    && item != "antigravity-cli"
                    && item != "antigravity-cli_auth"
                    && item != "jcode"
                    && item != "jcode_auth"
                    && item != "droid"
                    && item != "droid_auth"
                    && item != "amp"
                    && item != "amp_auth"
                    && item != "qwen"
                    && item != "qwen_auth"
            })
            .copied()
            .collect(),

        // Only Opencode installed (no Claude, no Codex, no Cursor, no new agents)
        "opencode-only" => ALL_ITEMS
            .iter()
            .filter(|&&item| {
                item != "claude"
                    && item != "claude_auth"
                    && item != "codex"
                    && item != "codex_auth"
                    && item != "cursor"
                    && item != "cursor_auth"
                    && item != "copilot"
                    && item != "copilot_auth"
                    && item != "pi"
                    && item != "pi_auth"
                    && item != "hermes"
                    && item != "hermes_auth"
                    && item != "devin"
                    && item != "devin_auth"
                    && item != "grok"
                    && item != "grok_auth"
                    && item != "kimi-code"
                    && item != "kimi-code_auth"
                    && item != "antigravity-cli"
                    && item != "antigravity-cli_auth"
                    && item != "jcode"
                    && item != "jcode_auth"
                    && item != "droid"
                    && item != "droid_auth"
                    && item != "amp"
                    && item != "amp_auth"
                    && item != "qwen"
                    && item != "qwen_auth"
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

// ============ Onboarding Test Mode ============

/// Which onboarding test mode (if any) the app was launched in. The frontend
/// uses this to swap real side effects for deterministic ones: under mock mode
/// (`SHIPSTUDIO_FORCE_SETUP`) the agent-led onboarding runs a scripted demo
/// session instead of spawning a real agent PTY or real installers.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingTestMode {
    /// `SHIPSTUDIO_FORCE_SETUP` is set — item statuses are mocked.
    pub mock: bool,
    /// `SHIPSTUDIO_FORCE_ONBOARDING` is set — real checks, wizard forced open.
    pub force_onboarding: bool,
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_onboarding_test_mode() -> Result<OnboardingTestMode, CommandError> {
    Ok(OnboardingTestMode {
        mock: is_mock_mode(),
        // Raw env-var check on purpose: is_force_onboarding_mode() flips off
        // after completion, but the frontend cares about how we were launched.
        force_onboarding: std::env::var("SHIPSTUDIO_FORCE_ONBOARDING").is_ok(),
    })
}

/// Mark a single setup item as ready in the mock state. Drives the scripted
/// demo of the agent-led onboarding: the demo terminal flips items ready on a
/// timeline and the real status polling picks them up, so the checklist UI is
/// exercised end-to-end with zero changes to the host machine. Refuses to run
/// outside mock mode.
#[tauri::command]
#[tracing::instrument]
pub async fn mock_mark_setup_item_ready(
    item_id: String,
) -> Result<(), crate::errors::CommandError> {
    if !is_mock_mode() {
        return Err(crate::errors::CommandError::Validation {
            field: "item_id".to_string(),
            reason: "mock_mark_setup_item_ready only works when SHIPSTUDIO_FORCE_SETUP is set"
                .to_string(),
        });
    }
    if !is_valid_mock_item(&item_id) {
        return Err(crate::errors::CommandError::Validation {
            field: "item_id".to_string(),
            reason: format!("unknown setup item `{item_id}`"),
        });
    }
    mock_install(&item_id);
    Ok(())
}

/// Whether an id names a real setup item the mock state can hold. `npm_fix`
/// is conditional (only exists while ~/.npm is broken) so it's not in
/// ALL_ITEMS, but the demo may still flip it.
fn is_valid_mock_item(item_id: &str) -> bool {
    ALL_ITEMS.contains(&item_id) || item_id == "npm_fix"
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
    fn all_items_contains_37_items_including_all_agents_and_vercel() {
        assert_eq!(ALL_ITEMS.len(), 37);
        assert!(ALL_ITEMS.contains(&"copilot"));
        assert!(ALL_ITEMS.contains(&"copilot_auth"));
        assert!(ALL_ITEMS.contains(&"codex"));
        assert!(ALL_ITEMS.contains(&"codex_auth"));
        assert!(ALL_ITEMS.contains(&"opencode"));
        assert!(ALL_ITEMS.contains(&"opencode_auth"));
        assert!(ALL_ITEMS.contains(&"cursor"));
        assert!(ALL_ITEMS.contains(&"cursor_auth"));
        assert!(ALL_ITEMS.contains(&"pi"));
        assert!(ALL_ITEMS.contains(&"pi_auth"));
        assert!(ALL_ITEMS.contains(&"hermes"));
        assert!(ALL_ITEMS.contains(&"hermes_auth"));
        assert!(ALL_ITEMS.contains(&"devin"));
        assert!(ALL_ITEMS.contains(&"devin_auth"));
        assert!(ALL_ITEMS.contains(&"grok"));
        assert!(ALL_ITEMS.contains(&"grok_auth"));
        assert!(ALL_ITEMS.contains(&"kimi-code"));
        assert!(ALL_ITEMS.contains(&"kimi-code_auth"));
        assert!(ALL_ITEMS.contains(&"antigravity-cli"));
        assert!(ALL_ITEMS.contains(&"antigravity-cli_auth"));
        assert!(ALL_ITEMS.contains(&"jcode"));
        assert!(ALL_ITEMS.contains(&"jcode_auth"));
        assert!(ALL_ITEMS.contains(&"droid"));
        assert!(ALL_ITEMS.contains(&"droid_auth"));
        assert!(ALL_ITEMS.contains(&"amp"));
        assert!(ALL_ITEMS.contains(&"amp_auth"));
        assert!(ALL_ITEMS.contains(&"qwen"));
        assert!(ALL_ITEMS.contains(&"qwen_auth"));
        assert!(ALL_ITEMS.contains(&"vercel"));
        assert!(ALL_ITEMS.contains(&"vercel_auth"));
    }

    #[test]
    fn tool_items_contains_20_items_including_all_agents_and_vercel() {
        assert_eq!(TOOL_ITEMS.len(), 20);
        assert!(TOOL_ITEMS.contains(&"copilot"));
        assert!(TOOL_ITEMS.contains(&"codex"));
        assert!(TOOL_ITEMS.contains(&"claude"));
        assert!(TOOL_ITEMS.contains(&"opencode"));
        assert!(TOOL_ITEMS.contains(&"cursor"));
        assert!(TOOL_ITEMS.contains(&"pi"));
        assert!(TOOL_ITEMS.contains(&"hermes"));
        assert!(TOOL_ITEMS.contains(&"devin"));
        assert!(TOOL_ITEMS.contains(&"grok"));
        assert!(TOOL_ITEMS.contains(&"kimi-code"));
        assert!(TOOL_ITEMS.contains(&"antigravity-cli"));
        assert!(TOOL_ITEMS.contains(&"jcode"));
        assert!(TOOL_ITEMS.contains(&"droid"));
        assert!(TOOL_ITEMS.contains(&"amp"));
        assert!(TOOL_ITEMS.contains(&"qwen"));
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

    // ============ is_valid_mock_item ============

    #[test]
    fn valid_mock_items_accept_all_items_and_npm_fix() {
        for item in ALL_ITEMS {
            assert!(is_valid_mock_item(item), "{item} should be valid");
        }
        assert!(is_valid_mock_item("npm_fix"));
    }

    #[test]
    fn invalid_mock_items_rejected() {
        assert!(!is_valid_mock_item("rm -rf /"));
        assert!(!is_valid_mock_item(""));
        assert!(!is_valid_mock_item("HOMEBREW"));
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
