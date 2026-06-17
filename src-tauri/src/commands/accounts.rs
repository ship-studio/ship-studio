//! # Account (Workspace) Management Commands
//!
//! Accounts ("Workspaces" in the UI) isolate Claude Code login, GitHub CLI
//! login, and a small credential vault per org/client context. Unlike the
//! old per-project profile assignment, an Account is selected once per
//! session at app startup (or via "Switch Workspace") and applies to newly
//! spawned terminals/processes.
//!
//! Credentials (Vercel/Figma/OpenAI tokens, git identity) are stored in the
//! macOS Keychain via the `security` CLI — values never leave the Rust layer.
//! Claude Code and GitHub CLI logins are isolated via `CLAUDE_CONFIG_DIR` /
//! `GH_CONFIG_DIR`, each pointed at a per-account directory under
//! `~/.ship-studio/accounts/<id>/`.
//!
//! ## Env var injection
//!
//! Call `get_env_vars_for_active_account()` to get a `HashMap<String, String>`
//! of environment variables to inject when spawning Claude/GitHub CLI
//! processes. This is the integration point used by `pty::spawn`, `ai`,
//! `github`, and `pull_requests`.

use crate::agent::AgentConfig;
use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{Account, AccountCredentialStatus};
use crate::utils::{create_command, get_extended_path};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// The ID of the built-in default account. Always exists; cannot be deleted.
pub const DEFAULT_ACCOUNT_ID: &str = "default";

const KEYCHAIN_PREFIX: &str = "ship-studio-account-";

/// Credential key -> injected environment variable name.
const CRED_ENV_VARS: &[(&str, &str)] = &[
    ("anthropic_base_url", "ANTHROPIC_BASE_URL"),
    ("vercel_token", "VERCEL_TOKEN"),
    ("figma_token", "FIGMA_PERSONAL_ACCESS_TOKEN"),
    ("openai_api_key", "OPENAI_API_KEY"),
];

/// All credential keys storable in the keychain (including git identity,
/// which isn't injected via `CRED_ENV_VARS` but via `GIT_*` env vars).
const ALL_CRED_KEYS: &[&str] = &[
    "anthropic_base_url",
    "vercel_token",
    "figma_token",
    "openai_api_key",
    "git_name",
    "git_email",
];

/// Validates a frontend-supplied account id before it's joined into filesystem
/// paths (`~/.ship-studio/accounts/<id>/`), keychain service names, or env vars.
///
/// Account ids are always either the literal `"default"` or a generated UUID, so
/// we hold a strict allowlist: non-empty, at most 64 chars, ASCII alphanumeric
/// and `-` only. This rejects `..`, `/`, `\`, and other traversal/injection
/// payloads that would otherwise let a caller read or create directories outside
/// the accounts root.
pub fn validate_account_id(account_id: &str) -> Result<(), CommandError> {
    let valid = !account_id.is_empty()
        && account_id.len() <= 64
        && account_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "account_id".into(),
            reason: "Invalid workspace id".into(),
        })
    }
}

// ============ Keychain helpers (macOS `security` CLI) ============

fn keychain_service(account_id: &str) -> String {
    format!("{KEYCHAIN_PREFIX}{account_id}")
}

fn write_to_keychain(account_id: &str, key: &str, value: &str) -> Result<(), CommandError> {
    use std::io::Write;
    use std::process::Stdio;

    let service = keychain_service(account_id);
    // Pass the secret on stdin rather than as an argv entry — a CLI argument is
    // visible to any user via `ps`/`/proc`, leaking the credential. With `-w`
    // and no inline value, `security` prompts for the password and then a
    // confirmation ("retype password"), reading both from stdin, so we send the
    // value twice. Callers trim to a single line (no embedded newline), so the
    // two reads each receive the full value.
    let mut child = create_command("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            key,
            "-s",
            &service,
            "-w",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Keychain write failed: {e}"))?;

    child
        .stdin
        .take()
        .ok_or_else(|| CommandError::from("Keychain write failed: no stdin handle"))?
        .write_all(format!("{value}\n{value}\n").as_bytes())
        .map_err(|e| format!("Keychain write failed: {e}"))?;

    let status = child
        .wait()
        .map_err(|e| format!("Keychain write failed: {e}"))?;

    if !status.success() {
        return Err(format!("Failed to store credential '{key}' in keychain").into());
    }
    Ok(())
}

fn read_from_keychain(account_id: &str, key: &str) -> Option<String> {
    let service = keychain_service(account_id);
    let output = create_command("security")
        .args(["find-generic-password", "-a", key, "-s", &service, "-w"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn delete_from_keychain(account_id: &str, key: &str) {
    let service = keychain_service(account_id);
    let _ = create_command("security")
        .args(["delete-generic-password", "-a", key, "-s", &service])
        .status();
}

fn delete_all_account_credentials(account_id: &str) {
    for key in ALL_CRED_KEYS {
        delete_from_keychain(account_id, key);
    }
}

// ============ Config dir isolation ============

/// Root directory for an account's isolated config: `~/.ship-studio/accounts/<id>/`
fn account_config_root(account_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ship-studio")
        .join("accounts")
        .join(account_id)
}

/// Directory used as `CLAUDE_CONFIG_DIR` for this account, created on access.
///
/// The Default account resolves to the real, global Claude config directory
/// (honoring `CLAUDE_CONFIG_DIR` if already set in the environment, else
/// `~/.claude`) so existing users' logins are unaffected by Workspace
/// isolation. Other accounts get an isolated directory under
/// `~/.ship-studio/accounts/<id>/`.
pub fn claude_config_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".claude"));
    }
    let dir = account_config_root(account_id).join("claude");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Directory used as `GH_CONFIG_DIR` for this account, created on access.
///
/// The Default account resolves to the real, global `gh` config directory
/// (honoring `GH_CONFIG_DIR`/`XDG_CONFIG_HOME` if already set, else
/// `~/.config/gh`) so existing users' `gh` logins are unaffected by Workspace
/// isolation. Other accounts get an isolated directory under
/// `~/.ship-studio/accounts/<id>/`.
pub fn gh_config_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        if let Ok(dir) = std::env::var("GH_CONFIG_DIR") {
            return PathBuf::from(dir);
        }
        let config_home = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"));
        return config_home.join("gh");
    }
    let dir = account_config_root(account_id).join("gh");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Directory used as `CODEX_HOME` for this account, created on access.
///
/// The Default account resolves to the real, global Codex directory
/// (honoring `CODEX_HOME` if already set, else `~/.codex`). Other accounts
/// get an isolated directory under `~/.ship-studio/accounts/<id>/`.
pub fn codex_home_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".codex"));
    }
    let dir = account_config_root(account_id).join("codex");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Directory used as `XDG_DATA_HOME` for this account, created on access.
///
/// The Default account resolves to the real, global data directory (honoring
/// `XDG_DATA_HOME` if already set, else `~/.local/share`) so Opencode's
/// existing `~/.local/share/opencode` login is unaffected. Other accounts get
/// an isolated directory under `~/.ship-studio/accounts/<id>/`.
pub fn opencode_data_home_dir(account_id: &str) -> PathBuf {
    if account_id == DEFAULT_ACCOUNT_ID {
        return std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".local")
                    .join("share")
            });
    }
    let dir = account_config_root(account_id).join("data");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Resolves the directory that holds `agent`'s auth/config state for the
/// given account — the per-account equivalent of `$HOME/<agent.auth_config_dir>`.
/// The Default account maps to the real global directory; other accounts get
/// an isolated directory under `~/.ship-studio/accounts/<id>/`.
pub fn agent_auth_dir(account_id: &str, agent: &AgentConfig) -> PathBuf {
    match agent.id {
        "claude-code" => claude_config_dir(account_id),
        "codex" => codex_home_dir(account_id),
        "opencode" => opencode_data_home_dir(account_id).join("opencode"),
        _ => account_config_root(account_id).join(agent.auth_config_dir),
    }
}

// ============ Internal helpers ============

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ensures the built-in "Default" account exists and that an active account
/// is set, seeding both on first run.
fn ensure_default_account(state: &mut crate::types::AppState) {
    if !state.accounts.iter().any(|a| a.id == DEFAULT_ACCOUNT_ID) {
        state.accounts.insert(
            0,
            Account {
                id: DEFAULT_ACCOUNT_ID.to_string(),
                name: "Default".to_string(),
                color: "#6b7280".to_string(),
                is_default: true,
                created_at: now_ms(),
            },
        );
    }
    if state.active_account_id.is_none() {
        state.active_account_id = Some(DEFAULT_ACCOUNT_ID.to_string());
    }
}

/// Returns env vars to inject for the currently active account.
pub fn get_env_vars_for_active_account() -> HashMap<String, String> {
    let state = read_app_state();
    let account_id = state
        .active_account_id
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
    get_env_vars_for_account(&account_id)
}

/// Env vars for the account a *project* belongs to — its tagged workspace,
/// falling back to the active account when the project is untagged. Operations
/// that act on a specific project (terminal spawn, git push, PR create, AI
/// generation) use this instead of `get_env_vars_for_active_account` so they
/// inherit the project's workspace credentials rather than whichever workspace
/// happens to be globally active — letting you work two projects in two
/// different workspaces at once without their logins crossing.
pub fn get_env_vars_for_project(project_path: &std::path::Path) -> HashMap<String, String> {
    let account_id = crate::commands::projects::project_account_id_sync(project_path);
    get_env_vars_for_account(&account_id)
}

/// Returns env vars to inject for a specific account: isolated Claude/GitHub
/// config dirs, plus any credentials stored in the keychain for that account.
pub fn get_env_vars_for_account(account_id: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();

    vars.insert(
        "CLAUDE_CONFIG_DIR".to_string(),
        claude_config_dir(account_id).to_string_lossy().to_string(),
    );
    vars.insert(
        "GH_CONFIG_DIR".to_string(),
        gh_config_dir(account_id).to_string_lossy().to_string(),
    );
    vars.insert(
        "CODEX_HOME".to_string(),
        codex_home_dir(account_id).to_string_lossy().to_string(),
    );
    vars.insert(
        "XDG_DATA_HOME".to_string(),
        opencode_data_home_dir(account_id)
            .to_string_lossy()
            .to_string(),
    );

    for (key, env_name) in CRED_ENV_VARS {
        if let Some(value) = read_from_keychain(account_id, key) {
            vars.insert(env_name.to_string(), value);
        }
    }

    if let Some(name) = read_from_keychain(account_id, "git_name") {
        vars.insert("GIT_AUTHOR_NAME".to_string(), name.clone());
        vars.insert("GIT_COMMITTER_NAME".to_string(), name);
    }
    if let Some(email) = read_from_keychain(account_id, "git_email") {
        vars.insert("GIT_AUTHOR_EMAIL".to_string(), email.clone());
        vars.insert("GIT_COMMITTER_EMAIL".to_string(), email);
    }

    vars
}

/// Parses `gh auth status` output for the logged-in github.com username.
fn parse_gh_auth_status(success: bool, stdout: &str, stderr: &str) -> Option<String> {
    if !success {
        return None;
    }
    let combined = format!("{stdout}{stderr}");
    const MARKER: &str = "Logged in to github.com as ";
    for line in combined.lines() {
        let trimmed = line.trim();
        if let Some(idx) = trimmed.find(MARKER) {
            let rest = &trimmed[idx + MARKER.len()..];
            if let Some(username) = rest.split_whitespace().next() {
                if !username.is_empty() {
                    return Some(username.to_string());
                }
            }
        }
    }
    None
}

// ============ Tauri commands ============

/// List all accounts (workspaces). Creates the Default account on first call.
#[tauri::command]
#[tracing::instrument]
pub fn list_accounts() -> Result<Vec<Account>, CommandError> {
    let mut state = read_app_state();
    // Ensure the built-in Default exists in the returned list, but DON'T persist
    // here — this is a read-path getter called very frequently (every workspace
    // indicator refresh, focus, etc.). Writing on read created an unguarded
    // read-modify-write race that clobbered concurrent set_active_account_id /
    // create_account writes (the "switch didn't stick / wrong active workspace"
    // bug). The Default account is persisted lazily by the next real mutation.
    ensure_default_account(&mut state);
    Ok(state.accounts)
}

/// Create a new account (workspace).
#[tauri::command]
#[tracing::instrument]
pub fn create_account(name: String, color: String) -> Result<Account, CommandError> {
    if name.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "name".into(),
            reason: "Workspace name cannot be empty".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);

    let account = Account {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        color,
        is_default: false,
        created_at: now_ms(),
    };
    state.accounts.push(account.clone());
    write_app_state(&state)?;
    tracing::info!(name = %account.name, "Account created");
    Ok(account)
}

/// Update an account's name and color.
#[tauri::command]
#[tracing::instrument]
pub fn update_account(id: String, name: String, color: String) -> Result<Account, CommandError> {
    validate_account_id(&id)?;
    if name.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "name".into(),
            reason: "Workspace name cannot be empty".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    let account = state
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::Other {
            message: format!("Account '{id}' not found"),
        })?;

    account.name = name.trim().to_string();
    account.color = color;
    let updated = account.clone();
    write_app_state(&state)?;
    Ok(updated)
}

/// Delete an account. The Default account cannot be deleted.
/// If the deleted account was active, the active account falls back to Default.
#[tauri::command]
#[tracing::instrument]
pub fn delete_account(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "Cannot delete the Default workspace".into(),
        });
    }
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    let before = state.accounts.len();
    state.accounts.retain(|a| a.id != id);
    if state.accounts.len() == before {
        return Err(CommandError::Other {
            message: format!("Account '{id}' not found"),
        });
    }

    if state.active_account_id.as_deref() == Some(id.as_str()) {
        state.active_account_id = Some(DEFAULT_ACCOUNT_ID.to_string());
    }

    delete_all_account_credentials(&id);
    // Remove the workspace's isolated config dir too — it holds live Claude /
    // gh / codex session tokens. Leaving it behind means a deleted workspace's
    // logins survive on disk (and would be reused if the id were ever reused).
    // Guarded by validate_account_id above so this can't escape the accounts root.
    let config_dir = account_config_root(&id);
    if let Err(e) = std::fs::remove_dir_all(&config_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(id = %id, error = %e, "Failed to remove account config dir on delete");
        }
    }
    write_app_state(&state)?;
    tracing::info!(id = %id, "Account deleted");
    Ok(())
}

/// Returns the currently active account's ID (defaults to "default").
#[tauri::command]
#[tracing::instrument]
pub fn get_active_account_id() -> Result<String, CommandError> {
    // Read-only getter: do NOT write here. It's called on every dashboard
    // refresh, env injection, and indicator update; persisting on read raced
    // with set_active_account_id and silently reverted workspace switches.
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    Ok(state
        .active_account_id
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string()))
}

/// Sets the currently active account. Already-running terminals keep their
/// existing env; only newly spawned processes pick up the new account.
#[tauri::command]
#[tracing::instrument]
pub fn set_active_account_id(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    let mut state = read_app_state();
    ensure_default_account(&mut state);
    if !state.accounts.iter().any(|a| a.id == id) {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: format!("Account '{id}' does not exist"),
        });
    }
    state.active_account_id = Some(id.clone());
    write_app_state(&state)?;
    // The GitHub username is cached with a 10-min TTL; without busting it here a
    // workspace switch would keep reporting the previous workspace's identity.
    crate::commands::github::invalidate_github_username_cache();
    tracing::info!(id = %id, "Active account changed");
    Ok(())
}

/// Returns auth/credential status for an account, for display in the account
/// settings modal. Secret values never leave the Rust layer.
#[tauri::command]
#[tracing::instrument]
pub async fn get_account_credential_status(
    id: String,
) -> Result<AccountCredentialStatus, CommandError> {
    validate_account_id(&id)?;
    let claude_dir = claude_config_dir(&id);
    let claude_agent = crate::agent::get_agent_by_id("claude-code");
    let claude_auth_email = if claude_agent
        .auth_indicators
        .iter()
        .any(|indicator| claude_dir.join(indicator).exists())
    {
        Some("Connected".to_string())
    } else {
        None
    };

    let mut gh_cmd = tokio::process::Command::from(create_command("gh"));
    gh_cmd.args(["auth", "status"]);
    gh_cmd.env("PATH", get_extended_path());
    gh_cmd.env("GH_CONFIG_DIR", gh_config_dir(&id));
    let github_auth_email = match run_with_timeout(gh_cmd, "gh auth status", 10).await {
        Ok(output) => parse_gh_auth_status(
            output.status.success(),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(_) => None,
    };

    Ok(AccountCredentialStatus {
        claude_auth_email,
        github_auth_email,
        has_anthropic_base_url: read_from_keychain(&id, "anthropic_base_url").is_some(),
        has_vercel_token: read_from_keychain(&id, "vercel_token").is_some(),
        has_figma_token: read_from_keychain(&id, "figma_token").is_some(),
        has_openai_api_key: read_from_keychain(&id, "openai_api_key").is_some(),
        has_git_name: read_from_keychain(&id, "git_name").is_some(),
        has_git_email: read_from_keychain(&id, "git_email").is_some(),
    })
}

/// Returns env vars for the active account so the frontend can inject them
/// into PTY sessions it spawns directly (e.g. OnboardingTerminal).
///
/// Includes `CLAUDE_CONFIG_DIR`, `GH_CONFIG_DIR`, `CODEX_HOME`,
/// `XDG_DATA_HOME`, and any credential env vars (tokens, git identity)
/// stored in the account's keychain.
#[tauri::command]
#[tracing::instrument]
pub fn get_active_account_env_vars() -> HashMap<String, String> {
    get_env_vars_for_active_account()
}

/// Returns env vars for a specific account, so the frontend can spawn a
/// project's PTY using that project's workspace rather than the globally
/// active one. Each open project is tagged with an `account_id`; the agent
/// terminal resolves it via `get_project_account_id` and passes it here so
/// Claude/GitHub/Codex auth follows the project, not a session-wide toggle.
#[tauri::command]
#[tracing::instrument]
pub fn get_account_env_vars(account_id: String) -> HashMap<String, String> {
    // Frontend-supplied id is joined into filesystem paths inside
    // get_env_vars_for_account (create_dir_all). Reject anything that isn't a
    // plain id rather than risk traversal; an empty map is a safe no-op.
    if validate_account_id(&account_id).is_err() {
        tracing::warn!(account_id = %account_id, "Rejected invalid account id for env vars");
        return HashMap::new();
    }
    get_env_vars_for_account(&account_id)
}

/// Store a credential in the keychain for an account.
///
/// Allowed keys: `anthropic_base_url`, `vercel_token`, `figma_token`,
/// `openai_api_key`, `git_name`, `git_email`
#[tauri::command]
#[tracing::instrument(skip(value))]
pub fn set_account_credential(id: String, key: String, value: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    if !ALL_CRED_KEYS.contains(&key.as_str()) {
        return Err(CommandError::Validation {
            field: "key".into(),
            reason: format!("Unknown credential key '{key}'"),
        });
    }
    if value.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "value".into(),
            reason: "Credential value cannot be empty".into(),
        });
    }
    write_to_keychain(&id, &key, value.trim())
}

/// Remove a credential from the keychain for an account.
#[tauri::command]
#[tracing::instrument]
pub fn clear_account_credential(id: String, key: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    delete_from_keychain(&id, &key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_uses_prefix() {
        assert_eq!(keychain_service("default"), "ship-studio-account-default");
        assert_eq!(keychain_service("abc-123"), "ship-studio-account-abc-123");
    }

    #[test]
    fn get_env_vars_always_includes_config_dirs() {
        let vars = get_env_vars_for_account("nonexistent-account-xyz-test");
        assert!(vars.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(vars.contains_key("GH_CONFIG_DIR"));
        // No credentials stored for this account, so no token vars
        assert!(!vars.contains_key("VERCEL_TOKEN"));
    }

    #[test]
    fn parse_gh_auth_status_extracts_username() {
        let stdout = "github.com\n  Logged in to github.com as octocat (oauth_token)\n";
        assert_eq!(
            parse_gh_auth_status(true, stdout, ""),
            Some("octocat".to_string())
        );
    }

    #[test]
    fn parse_gh_auth_status_returns_none_when_not_logged_in() {
        assert_eq!(
            parse_gh_auth_status(false, "", "You are not logged into any GitHub hosts."),
            None
        );
    }

    #[test]
    fn validate_account_id_accepts_default_and_uuids() {
        assert!(validate_account_id("default").is_ok());
        assert!(validate_account_id("bd2a40a3-268d-4242-a350-fa720de78dd7").is_ok());
    }

    #[test]
    fn validate_account_id_rejects_traversal_and_injection() {
        for bad in [
            "",
            "..",
            "../../etc",
            "a/b",
            "a\\b",
            "foo/../bar",
            ".",
            "id with space",
            "name;rm -rf",
        ] {
            assert!(
                validate_account_id(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn validate_account_id_rejects_overlong() {
        let long = "a".repeat(65);
        assert!(validate_account_id(&long).is_err());
    }
}
