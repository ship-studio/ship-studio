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
use crate::commands::claude::find_binary_by_name;
use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{Account, AccountCredentialStatus};
use crate::utils::{create_command, get_extended_path};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// The ID of the built-in default account. Always exists; cannot be deleted.
pub const DEFAULT_ACCOUNT_ID: &str = "default";

const KEYCHAIN_PREFIX: &str = "ship-studio-account-";

/// Credential key -> injected environment variable name.
const CRED_ENV_VARS: &[(&str, &str)] = &[
    ("anthropic_base_url", "ANTHROPIC_BASE_URL"),
    ("vercel_token", "VERCEL_TOKEN"),
];

/// All credential keys storable in the keychain (including git identity,
/// which isn't injected via `CRED_ENV_VARS` but via `GIT_*` env vars).
const ALL_CRED_KEYS: &[&str] = &[
    "anthropic_base_url",
    "vercel_token",
    "git_name",
    "git_email",
];

/// Credential keys managed internally by the backend (never settable or
/// clearable through the frontend `set/clear_account_credential` commands, so
/// they're deliberately NOT in `ALL_CRED_KEYS`). They still belong to the
/// account, so they're wiped alongside the rest on account deletion.
///
/// `claude_oauth_token` is a long-lived token captured by `connect_claude_account`
/// (via `claude setup-token`) and injected as `CLAUDE_CODE_OAUTH_TOKEN`; see
/// `get_env_vars_for_account`. `claude_email` is the account identity captured
/// at connect time, used only for display.
const MANAGED_CRED_KEYS: &[&str] = &[
    "claude_oauth_token",
    "claude_email",
    "claude_token_expires_at",
];

/// Keychain key holding a workspace's captured Claude OAuth token.
const CLAUDE_TOKEN_KEY: &str = "claude_oauth_token";
/// Keychain key holding the email for a workspace's connected Claude account.
const CLAUDE_EMAIL_KEY: &str = "claude_email";
/// Keychain key holding the unix-seconds expiry of the captured Claude token.
const CLAUDE_EXPIRES_KEY: &str = "claude_token_expires_at";

/// How long a `claude setup-token` token is valid. The CLI states "valid for 1
/// year" when it mints one; we record an expiry at connect time and surface a
/// "needs reconnect" (red) state once it passes. There is no cheap server-side
/// validity check for these opaque tokens (verified: `claude auth status`
/// reports `loggedIn:true` even for a garbage token), so this local expiry is
/// our reconnect signal. Revocation before expiry isn't detected here.
const CLAUDE_TOKEN_TTL_SECS: u64 = 365 * 24 * 60 * 60;

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
    for key in ALL_CRED_KEYS.iter().chain(MANAGED_CRED_KEYS.iter()) {
        delete_from_keychain(account_id, key);
    }
}

/// Persist a workspace's captured Claude OAuth token (and account email, when
/// known) to its keychain vault. Called by the connect flow after a successful
/// `claude setup-token`. Stored under [`MANAGED_CRED_KEYS`], so it's never
/// writable via the frontend and is wiped when the workspace is deleted.
pub fn store_claude_token(
    account_id: &str,
    token: &str,
    email: Option<&str>,
) -> Result<(), CommandError> {
    write_to_keychain(account_id, CLAUDE_TOKEN_KEY, token.trim())?;
    if let Some(email) = email.map(str::trim).filter(|e| !e.is_empty()) {
        // Email is display-only; a failure to store it must not fail the connect.
        let _ = write_to_keychain(account_id, CLAUDE_EMAIL_KEY, email);
    } else {
        // Reconnecting without re-supplying an email shouldn't leave a stale one.
        delete_from_keychain(account_id, CLAUDE_EMAIL_KEY);
    }
    let expires_at = unix_now().saturating_add(CLAUDE_TOKEN_TTL_SECS);
    let _ = write_to_keychain(account_id, CLAUDE_EXPIRES_KEY, &expires_at.to_string());
    Ok(())
}

/// Remove a workspace's captured Claude token + email + expiry (i.e. disconnect
/// Claude for that workspace). Its terminals fall back to no injected token.
pub fn clear_claude_token(account_id: &str) {
    delete_from_keychain(account_id, CLAUDE_TOKEN_KEY);
    delete_from_keychain(account_id, CLAUDE_EMAIL_KEY);
    delete_from_keychain(account_id, CLAUDE_EXPIRES_KEY);
}

/// Current wall-clock time in unix seconds (0 if the clock is before the epoch).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Connection state of a workspace's Claude login, for the agent card.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeConnState {
    /// Never connected — render today's neutral "Not signed in / Sign in" UI.
    NotConnected,
    /// Connected with a token believed valid — green stroke, show email.
    Connected,
    /// Was connected but the token has expired — red stroke + inline Reconnect.
    NeedsReconnect,
}

/// Resolved Claude identity for a workspace: connection state + the email to show.
pub struct ClaudeIdentity {
    pub state: ClaudeConnState,
    pub email: Option<String>,
}

/// Resolve a workspace's Claude login state + display email.
///
/// - **Default workspace**: uses Claude's native keychain login, so we ask the
///   CLI directly via `claude auth status` (which returns the email for a
///   `claude.ai` login). No injected token.
/// - **Other workspaces**: driven entirely by the per-workspace vault — token
///   presence means connected, the stored expiry decides connected-vs-reconnect,
///   and the email is whatever was captured at connect time. We deliberately do
///   NOT shell out here (the opaque token can't be validated cheaply anyway).
pub async fn resolve_claude_identity(account_id: &str) -> ClaudeIdentity {
    if account_id == DEFAULT_ACCOUNT_ID {
        return resolve_default_claude_identity().await;
    }

    let Some(_token) = read_from_keychain(account_id, CLAUDE_TOKEN_KEY) else {
        return ClaudeIdentity {
            state: ClaudeConnState::NotConnected,
            email: None,
        };
    };
    let email = read_from_keychain(account_id, CLAUDE_EMAIL_KEY);
    let expired = read_from_keychain(account_id, CLAUDE_EXPIRES_KEY)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|exp| unix_now() >= exp)
        // No expiry recorded (older connect): treat as still valid rather than
        // nagging the user with a false red.
        .unwrap_or(false);
    ClaudeIdentity {
        state: if expired {
            ClaudeConnState::NeedsReconnect
        } else {
            ClaudeConnState::Connected
        },
        email,
    }
}

/// Identity for the Default workspace via `claude auth status` (native login).
async fn resolve_default_claude_identity() -> ClaudeIdentity {
    let Some(binary) = find_binary_by_name("claude") else {
        return ClaudeIdentity {
            state: ClaudeConnState::NotConnected,
            email: None,
        };
    };
    let mut cmd = create_command(binary);
    cmd.args(["auth", "status"]);
    cmd.env("PATH", get_extended_path());
    // Default = native locations; do NOT pin CLAUDE_CONFIG_DIR or inject a token.
    let tokio_cmd = tokio::process::Command::from(cmd);
    let stdout = match run_with_timeout(tokio_cmd, "claude auth status", 10).await {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => {
            return ClaudeIdentity {
                state: ClaudeConnState::NotConnected,
                email: None,
            }
        }
    };
    let (logged_in, email) = parse_claude_auth_status(&stdout);
    ClaudeIdentity {
        state: if logged_in {
            ClaudeConnState::Connected
        } else {
            ClaudeConnState::NotConnected
        },
        email,
    }
}

/// Parse `claude auth status` JSON → (logged_in, email). Tolerant of unknown
/// fields and non-JSON output (returns `(false, None)`).
fn parse_claude_auth_status(stdout: &str) -> (bool, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return (false, None);
    };
    let logged_in = v.get("loggedIn").and_then(|b| b.as_bool()).unwrap_or(false);
    let email = v
        .get("email")
        .and_then(|e| e.as_str())
        .map(str::to_string)
        .filter(|e| !e.is_empty());
    (logged_in, email)
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

/// Create `dir` (and ancestors) and lock it down to owner-only (`0700`) on Unix.
///
/// Isolated workspace dirs hold real auth tokens (gh `hosts.yml`, Claude creds,
/// codex auth). A bare `create_dir_all` leaves them at the default `0755`
/// (world-readable/traversable); on a shared machine another local user could
/// walk in. We also tighten the `~/.ship-studio/accounts/<id>` parent so the
/// whole per-account subtree is private, not just the leaf.
fn create_private_dir(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// Build a per-account config subdir (e.g. `claude`, `gh`), creating both it and
/// the account root with owner-only permissions.
fn private_account_subdir(account_id: &str, leaf: &str) -> PathBuf {
    let root = account_config_root(account_id);
    let dir = root.join(leaf);
    create_private_dir(&dir);
    // Also lock the account root itself (create_private_dir made its ancestors
    // with default perms while creating the leaf).
    create_private_dir(&root);
    dir
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
    private_account_subdir(account_id, "claude")
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
    private_account_subdir(account_id, "gh")
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
    private_account_subdir(account_id, "codex")
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
    private_account_subdir(account_id, "data")
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
                projects_root: None,
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
    // Single chokepoint for every env-injection path (active account, project
    // account, direct). The active-account id is read from app_state.json, which
    // is a plain user-writable file that never re-validates on read — a tampered
    // or recovered id could otherwise be joined into filesystem paths
    // (create_dir_all) below. Refuse anything that isn't a well-formed id and
    // fall back to the Default workspace so we never traverse outside the
    // accounts root.
    let account_id = if validate_account_id(account_id).is_ok() {
        account_id
    } else {
        tracing::warn!(account_id = %account_id, "Invalid account id during env resolution; falling back to Default");
        DEFAULT_ACCOUNT_ID
    };

    let mut vars = HashMap::new();

    // Only override the CLI config/data dirs for isolated (non-default)
    // workspaces. The Default workspace MUST let each tool resolve its own
    // native location so the user's existing global login is found on every
    // platform. Forcing these for Default broke GitHub auth on Windows (gh's
    // native dir is %AppData%\GitHub CLI, never ~/.config/gh) and on Macs whose
    // token lived elsewhere (e.g. a shell-set GH_CONFIG_DIR/XDG_CONFIG_HOME a
    // Dock-launched GUI can't see, the same limitation we work around for PATH),
    // and broke opencode on Windows (XDG_DATA_HOME != %LOCALAPPDATA%). Not
    // injecting restores pre-Workspaces behavior: if the app's own environment
    // already carries one of these (launched from a configured shell), the child
    // still inherits it; otherwise the tool resolves natively.
    if account_id != DEFAULT_ACCOUNT_ID {
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

        // Per-workspace Claude login. Unlike the CLI config dirs above, Claude
        // Code on macOS stores its OAuth token in a single global Keychain
        // entry that ignores CLAUDE_CONFIG_DIR (Claude bug #20553) — so config
        // isolation alone can't separate logins, and an interactive `/login` in
        // one workspace silently clobbers every other workspace's (and the
        // Default workspace's) token. Instead we capture a long-lived token per
        // workspace via `claude setup-token` (see connect_claude_account) and
        // inject it here. CLAUDE_CODE_OAUTH_TOKEN takes precedence over the
        // keychain, so each workspace authenticates as its own identity without
        // ever reading or writing the shared keychain entry. Only injected when
        // the workspace has actually connected Claude; otherwise its terminals
        // stay logged out (the correct "not connected" state).
        if let Some(token) = read_from_keychain(account_id, CLAUDE_TOKEN_KEY) {
            vars.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), token);
        }
    }

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

/// Parses `gh auth status` output, returning the connected github.com username
/// or `None` when there is no usable login.
///
/// We intentionally key off the printed output, NOT the process exit code:
/// `gh auth status` exits NON-ZERO whenever *any* configured account has an
/// invalid token, even when a different account is logged in and active. A user
/// with a stale second account (`X Failed to log in to github.com account ...`)
/// was therefore reported as "Not connected" — a grey GitHub button that
/// re-prompted in a loop. The `✓ Logged in to github.com ...` line is the
/// source of truth.
///
/// When gh reports multiple accounts we prefer the one it marks
/// `Active account: true`, because every git/gh operation the app runs uses
/// that account — so its validity, not just "any login exists", determines
/// whether we're really connected. If the active account's token is invalid we
/// return `None` even if some other account is valid. When there's no active
/// marker at all (older single-account gh), any valid login counts.
///
/// `gh` changed the phrasing in ~v2.40: older builds print
/// `Logged in to github.com as <user>` while newer ones print
/// `Logged in to github.com account <user>`. We accept both so modern `gh`
/// installs aren't reported as "Not connected".
pub(crate) fn parse_gh_auth_status(stdout: &str, stderr: &str) -> Option<String> {
    const LOGGED_IN: &str = "Logged in to github.com ";
    const FAILED: &str = "Failed to log in to github.com ";

    // Extract the username following the connector word ("as" on older gh,
    // "account" on ~v2.40+) after `marker` within `line`.
    fn username_after(line: &str, marker: &str) -> Option<String> {
        let idx = line.find(marker)?;
        let rest = &line[idx + marker.len()..];
        let mut words = rest.split_whitespace();
        match words.next() {
            Some("as") | Some("account") => {
                words.next().filter(|u| !u.is_empty()).map(String::from)
            }
            _ => None,
        }
    }

    // One account block in the output. `valid` is the ✓ vs ✗ distinction;
    // `active` is set when the following `- Active account: true` line is seen.
    struct Entry {
        user: String,
        valid: bool,
        active: bool,
    }

    let combined = format!("{stdout}{stderr}");
    let mut entries: Vec<Entry> = Vec::new();
    for line in combined.lines() {
        let trimmed = line.trim();
        // "Failed to log in" does not contain "Logged in" (capital L), so the two
        // markers never collide — a failed account is never read as a login.
        if let Some(user) = username_after(trimmed, LOGGED_IN) {
            entries.push(Entry {
                user,
                valid: true,
                active: false,
            });
        } else if let Some(user) = username_after(trimmed, FAILED) {
            entries.push(Entry {
                user,
                valid: false,
                active: false,
            });
        } else if trimmed.contains("Active account: true") {
            if let Some(last) = entries.last_mut() {
                last.active = true;
            }
        }
    }

    // Prefer the account gh treats as active; the app operates as that account.
    if let Some(active) = entries.iter().find(|e| e.active) {
        return active.valid.then(|| active.user.clone());
    }
    // No active marker (older single-account gh): any valid login counts.
    entries.into_iter().find(|e| e.valid).map(|e| e.user)
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
        projects_root: None,
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
    // The projects folder is per-workspace, so switching changes which folder
    // the dashboard scans — drop the cached active root.
    crate::utils::invalidate_projects_root_cache();
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

    // An agent is "connected" for this workspace if its auth file exists in the
    // workspace's isolated config dir (the same file-based check used in setup).
    let agent_connected = |agent_id: &str| -> Option<String> {
        let agent = crate::agent::get_agent_by_id(agent_id);
        let dir = agent_auth_dir(&id, agent);
        agent
            .auth_indicators
            .iter()
            .any(|indicator| dir.join(indicator).exists())
            .then(|| "Connected".to_string())
    };
    // Claude can't use the file-indicator check: on macOS its login lives in a
    // global keychain entry that ignores CLAUDE_CONFIG_DIR, so indicator files
    // exist even for workspaces that were never connected. Use the real
    // per-workspace token/identity instead, surfacing the actual email.
    let claude = resolve_claude_identity(&id).await;
    let claude_auth_email = match claude.state {
        ClaudeConnState::Connected => Some(
            claude
                .email
                .clone()
                .unwrap_or_else(|| "Connected".to_string()),
        ),
        ClaudeConnState::NeedsReconnect => Some("Reconnect needed".to_string()),
        ClaudeConnState::NotConnected => None,
    };
    let codex_auth_email = agent_connected("codex");
    let opencode_auth_email = agent_connected("opencode");

    let mut gh_cmd = tokio::process::Command::from(create_command("gh"));
    gh_cmd.args(["auth", "status"]);
    gh_cmd.env("PATH", get_extended_path());
    // Only pin GH_CONFIG_DIR for isolated workspaces; the Default workspace must
    // let `gh` find its own native config (see get_env_vars_for_account) or this
    // status read reports "not connected" even when the user is logged in.
    if id != DEFAULT_ACCOUNT_ID {
        gh_cmd.env("GH_CONFIG_DIR", gh_config_dir(&id));
    }
    let github_auth_email = match run_with_timeout(gh_cmd, "gh auth status", 10).await {
        Ok(output) => parse_gh_auth_status(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(_) => None,
    };

    // Vercel identity, resolved the same way setup/status.rs does: verify the
    // workspace's injected token via `vercel whoami`. The Default workspace
    // (no injected token) falls back to the machine's native CLI session.
    let vercel_username = {
        let token = get_env_vars_for_account(&id).remove("VERCEL_TOKEN");
        if token.is_some() || id == DEFAULT_ACCOUNT_ID {
            if let Some(p) = find_binary_by_name("vercel") {
                let mut cmd = tokio::process::Command::from(create_command(&p));
                cmd.args(["whoami"]);
                cmd.env("PATH", get_extended_path());
                if let Some(ref t) = token {
                    cmd.env("VERCEL_TOKEN", t);
                }
                match run_with_timeout(cmd, "vercel whoami", 10).await {
                    Ok(output) if output.status.success() => {
                        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        (!name.is_empty()).then_some(name)
                    }
                    _ => None,
                }
            } else {
                None
            }
        } else {
            // Non-default workspace without a token → not connected for Vercel.
            None
        }
    };

    Ok(AccountCredentialStatus {
        claude_auth_email,
        codex_auth_email,
        opencode_auth_email,
        github_auth_email,
        vercel_username,
        has_anthropic_base_url: read_from_keychain(&id, "anthropic_base_url").is_some(),
        has_vercel_token: read_from_keychain(&id, "vercel_token").is_some(),
        has_git_name: read_from_keychain(&id, "git_name").is_some(),
        has_git_email: read_from_keychain(&id, "git_email").is_some(),
    })
}

// NOTE: there is deliberately no Tauri command that returns a Workspace's env
// vars to the frontend. Those maps contain real secret token values
// (Vercel/Figma/OpenAI/Anthropic-base-url) and must never cross the IPC
// boundary into the webview. PTYs get the right Workspace env injected
// server-side in `pty/spawn.rs` and `pty_session.rs` via the internal
// `get_env_vars_for_project` / `get_env_vars_for_active_account` helpers.

/// Reject any credential key not on the allowlist. Both set and clear funnel
/// through this so the frontend can't probe or delete arbitrary keychain items
/// under this account's service name.
fn validate_credential_key(key: &str) -> Result<(), CommandError> {
    if ALL_CRED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: "key".into(),
            reason: format!("Unknown credential key '{key}'"),
        })
    }
}

/// Store a credential in the keychain for an account.
///
/// Allowed keys: `anthropic_base_url`, `vercel_token`, `git_name`, `git_email`
#[tauri::command]
#[tracing::instrument(skip(value))]
pub fn set_account_credential(id: String, key: String, value: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_credential_key(&key)?;
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
    validate_credential_key(&key)?;
    delete_from_keychain(&id, &key);
    Ok(())
}

// ============ Claude connect (backend-owned PTY) ============
//
// `claude setup-token` is inherently interactive: it prints an authorization
// URL, the user logs in via the browser, and the hosted callback page shows a
// code the user must PASTE BACK at the CLI's `Paste code here >` prompt. Run
// headless (stdin closed) it hangs forever. So the backend spawns it in a real
// pseudo-terminal, streams the terminal to the webview, accepts keystrokes via
// a command — and, crucially, scrapes the printed `sk-ant-…` token out of the
// byte stream and stores it IN RUST, redacting it from the streamed bytes so
// the secret never reaches the webview.

/// One in-flight `claude setup-token` PTY, keyed by a frontend-supplied session
/// id. The backend owns the PTY end to end (spawn, stream, token capture).
struct ConnectSession {
    writer: Mutex<Box<dyn Write + Send>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    /// Set once the token has been scraped + stored, so the reader thread stops
    /// redacting and streams the remaining output verbatim.
    captured: AtomicBool,
}

static CONNECT_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<ConnectSession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The prefix every long-lived Claude token starts with.
const TOKEN_PREFIX: &[u8] = b"sk-ant-";
/// Real tokens are ~108 chars; guard against redacting a stray `sk-ant-` word.
const TOKEN_MIN_LEN: usize = 20;
/// What the user sees in the terminal where the token would have printed.
const TOKEN_PLACEHOLDER: &[u8] = b"sk-ant-[redacted by Ship Studio]";

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

/// First index of `needle` within `haystack`, if present.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Length of the longest suffix of `data` that is a *proper* prefix of `prefix`.
/// Used to hold back a partial `sk-ant-` straddling a read boundary so it isn't
/// emitted before we can tell whether a token follows.
fn partial_prefix_len(data: &[u8], prefix: &[u8]) -> usize {
    let max = data.len().min(prefix.len().saturating_sub(1));
    (1..=max)
        .rev()
        .find(|&k| data[data.len() - k..] == prefix[..k])
        .unwrap_or(0)
}

/// Token-redaction pass over the PTY byte stream.
///
/// `carry` holds bytes received but not yet emitted. We split off the prefix
/// that is safe to forward to the webview — with any complete `sk-ant-…` token
/// replaced by [`TOKEN_PLACEHOLDER`] — and leave in `carry` only the trailing
/// bytes that might still be (or begin) a token. The captured token, if a
/// complete one was found, is returned so the caller can store it in the vault.
///
/// `eof` flips the "still growing" case: mid-stream an unterminated token is
/// held back for the next read; at end-of-stream there is no next read, so a
/// long-enough unterminated run IS the token.
fn redact_token_stream(carry: &mut Vec<u8>, eof: bool) -> (Vec<u8>, Option<String>) {
    let data = std::mem::take(carry);
    let n = data.len();
    let mut emit = Vec::with_capacity(n);
    let mut captured: Option<String> = None;
    let mut pos = 0;

    loop {
        match find_subslice(&data[pos..], TOKEN_PREFIX) {
            Some(rel) => {
                let i = pos + rel;
                emit.extend_from_slice(&data[pos..i]);
                let mut j = i + TOKEN_PREFIX.len();
                while j < n && is_token_byte(data[j]) {
                    j += 1;
                }
                let terminated = j < n;
                if !terminated && !eof {
                    // Token may still be growing — retain it for the next read.
                    *carry = data[i..].to_vec();
                    return (emit, captured);
                }
                if j - i >= TOKEN_MIN_LEN {
                    if captured.is_none() {
                        captured = Some(String::from_utf8_lossy(&data[i..j]).into_owned());
                    }
                    emit.extend_from_slice(TOKEN_PLACEHOLDER);
                } else {
                    // Too short to be a real token — pass through untouched.
                    emit.extend_from_slice(&data[i..j]);
                }
                pos = j;
                if pos >= n {
                    return (emit, captured);
                }
            }
            None => {
                let rem = &data[pos..];
                let hold = if eof {
                    0
                } else {
                    partial_prefix_len(rem, TOKEN_PREFIX)
                };
                let split = rem.len() - hold;
                emit.extend_from_slice(&rem[..split]);
                *carry = rem[split..].to_vec();
                return (emit, captured);
            }
        }
    }
}

/// Emit a chunk of PTY output to the webview for the given connect session.
fn emit_connect_data(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    let _ = app.emit(
        "claude-connect-data",
        serde_json::json!({ "sessionId": session_id, "data": bytes }),
    );
}

/// Start an interactive Claude connect for a workspace in a backend-owned PTY.
///
/// Spawns `claude setup-token` in a real pseudo-terminal under the workspace's
/// isolated env (minus any previously injected token, so identity comes from
/// the fresh browser login). Output streams to the webview via
/// `claude-connect-data` events; the user types into it via
/// [`claude_connect_write`]. The reader thread scrapes the printed token,
/// stores it in the workspace vault via [`store_claude_token`], emits
/// `claude-connect-captured`, and redacts the token from the streamed bytes —
/// so the secret is captured entirely in Rust and never crosses into the
/// webview. `claude-connect-exit` fires when the process ends.
///
/// `email` is display-only: Claude exposes no way to resolve the account from
/// the opaque token, so the caller passes what the user logged in as.
#[tauri::command]
#[tracing::instrument(skip(app, email), fields(session_id = %session_id, id = %id))]
pub fn claude_connect_start(
    app: AppHandle,
    session_id: String,
    id: String,
    email: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_account_id(&session_id)?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace uses your machine's native Claude login; \
                     run `claude` and use /login there instead of connecting a token."
                .into(),
        });
    }

    let binary = find_binary_by_name("claude").ok_or_else(|| CommandError::Io {
        message: "Claude Code CLI not found. Install Claude Code first, then connect.".into(),
    })?;

    // Idempotent: a live session under this id means connect is already running.
    {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("claude connect registry poisoned: {e}"))?;
        if map.contains_key(&session_id) {
            return Ok(());
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary);
    cmd.arg("setup-token");
    cmd.cwd(dirs::home_dir().unwrap_or_default());
    cmd.env("PATH", get_extended_path());
    // A real terminal type so the CLI renders its interactive prompts properly.
    cmd.env("TERM", "xterm-256color");
    // Run inside the workspace's isolated env so any files setup-token writes
    // land under the workspace dir, never the global one. Strip any previously
    // injected token: setup-token derives identity from the fresh BROWSER login,
    // and a stale token in the env shouldn't shadow that.
    let mut env = get_env_vars_for_account(&id);
    env.remove("CLAUDE_CODE_OAUTH_TOKEN");
    for (k, v) in env {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command: {e}"))?;
    let child_killer = child.clone_killer();

    let session = Arc::new(ConnectSession {
        writer: Mutex::new(writer),
        child_killer: Mutex::new(child_killer),
        master: Mutex::new(pair.master),
        captured: AtomicBool::new(false),
    });
    CONNECT_REGISTRY
        .lock()
        .map_err(|e| format!("claude connect registry poisoned: {e}"))?
        .insert(session_id.clone(), session.clone());

    // Reader thread: scrapes + redacts the token, streams the rest.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let account_id = id.clone();
        let email = email
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string);
        let session = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            let store_and_signal = |token: String| {
                if let Err(e) = store_claude_token(&account_id, &token, email.as_deref()) {
                    tracing::warn!("failed to store captured Claude token: {e}");
                }
                session.captured.store(true, Ordering::Relaxed);
                let _ = app.emit(
                    "claude-connect-captured",
                    serde_json::json!({ "sessionId": session_id }),
                );
            };
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if session.captured.load(Ordering::Relaxed) {
                    emit_connect_data(&app, &session_id, &buf[..n]);
                    continue;
                }
                carry.extend_from_slice(&buf[..n]);
                let (emit, token) = redact_token_stream(&mut carry, false);
                if !emit.is_empty() {
                    emit_connect_data(&app, &session_id, &emit);
                }
                if let Some(token) = token {
                    store_and_signal(token);
                    // The retained tail is unrelated text now — flush it raw.
                    if !carry.is_empty() {
                        let tail = std::mem::take(&mut carry);
                        emit_connect_data(&app, &session_id, &tail);
                    }
                }
            }
            // EOF flush: treat end-of-stream as a token terminator.
            if !session.captured.load(Ordering::Relaxed) {
                let (emit, token) = redact_token_stream(&mut carry, true);
                if !emit.is_empty() {
                    emit_connect_data(&app, &session_id, &emit);
                }
                if let Some(token) = token {
                    store_and_signal(token);
                }
            } else if !carry.is_empty() {
                let tail = std::mem::take(&mut carry);
                emit_connect_data(&app, &session_id, &tail);
            }
        });
    }

    // Waiter thread: reaps the child, drops the registry entry, signals exit.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) if status.success() => 0,
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            if let Ok(mut map) = CONNECT_REGISTRY.lock() {
                map.remove(&session_id);
            }
            let _ = app.emit(
                "claude-connect-exit",
                serde_json::json!({ "sessionId": session_id, "exitCode": code }),
            );
        });
    }

    Ok(())
}

/// Forward keystrokes (e.g. the pasted authorization code) to a connect PTY.
#[tauri::command]
#[tracing::instrument(skip(data))]
pub fn claude_connect_write(session_id: String, data: Vec<u8>) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("claude connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown connect session".to_string().into());
    };
    let mut w = session
        .writer
        .lock()
        .map_err(|e| format!("writer lock poisoned: {e}"))?;
    w.write_all(&data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Resize a connect PTY to match the on-screen terminal.
#[tauri::command]
#[tracing::instrument]
pub fn claude_connect_resize(session_id: String, cols: u16, rows: u16) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("claude connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown connect session".to_string().into());
    };
    let master = session
        .master
        .lock()
        .map_err(|e| format!("master lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

/// Kill a connect PTY and drop its registry entry. Idempotent — called when the
/// user closes the connect modal (whether or not a token was captured).
#[tauri::command]
#[tracing::instrument]
pub fn claude_connect_close(session_id: String) -> Result<(), CommandError> {
    let session = {
        let mut map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("claude connect registry poisoned: {e}"))?;
        map.remove(&session_id)
    };
    if let Some(session) = session {
        if let Ok(mut killer) = session.child_killer.lock() {
            let _ = killer.kill();
        }
    }
    Ok(())
}

/// Disconnect a workspace's Claude login: clears its captured token, email, and
/// expiry. The workspace's terminals fall back to no injected token (logged out).
#[tauri::command]
#[tracing::instrument]
pub fn disconnect_claude_account(id: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace's Claude login isn't managed by Ship Studio; \
                     run `claude` and use /logout there instead."
                .into(),
        });
    }
    clear_claude_token(&id);
    Ok(())
}

// ── Generalized per-workspace login PTY (GitHub / Codex / Opencode) ──────────
//
// Claude needs token scraping (its login is a global keychain entry), but the
// other three logins are *config-dir* based: running their login CLI under the
// workspace's injected `GH_CONFIG_DIR` / `CODEX_HOME` / `XDG_DATA_HOME` writes
// the credentials into the workspace's isolated dir. So these reuse the same
// backend-owned PTY machinery as Claude (ConnectSession + CONNECT_REGISTRY) but
// stream output verbatim — there's no secret to redact — and treat process exit
// as the completion signal (no "captured" event).

/// A login service that authenticates by writing into a per-workspace config dir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectService {
    Github,
    Codex,
    Opencode,
}

impl ConnectService {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "github" => Some(Self::Github),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            _ => None,
        }
    }

    /// The CLI binary name to look up on PATH.
    fn binary(self) -> &'static str {
        match self {
            Self::Github => "gh",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    /// Login subcommand args for the binary.
    fn args(self) -> &'static [&'static str] {
        match self {
            // `--web` uses the device flow (prints a one-time code + opens the
            // browser); `--git-protocol https` skips the protocol prompt.
            Self::Github => &["auth", "login", "--web", "--git-protocol", "https"],
            Self::Codex => &["login"],
            Self::Opencode => &["auth", "login"],
        }
    }

    /// Whether this service's CLI pauses on a "Press Enter to open…" prompt that
    /// we can auto-advance so the browser opens without a manual keystroke.
    fn auto_enter(self) -> bool {
        matches!(self, Self::Github)
    }
}

/// Emit a chunk of PTY output to the webview for a workspace-connect session.
fn emit_workspace_connect_data(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    let _ = app.emit(
        "workspace-connect-data",
        serde_json::json!({ "sessionId": session_id, "data": bytes }),
    );
}

/// Start an interactive GitHub/Codex/Opencode login for a workspace in a
/// backend-owned PTY.
///
/// Spawns the service's login CLI under the workspace's isolated env (so the
/// credentials land in the workspace's config dir, never the global one).
/// Output streams to the webview via `workspace-connect-data`; the user types
/// into it via [`workspace_connect_write`]. There is no token to capture — the
/// CLI writes its own credential files — so completion is signalled purely by
/// `workspace-connect-exit` when the process ends. For GitHub we watch for the
/// "Press Enter to open…" prompt and send Enter once so the browser opens
/// immediately.
#[tauri::command]
#[tracing::instrument(skip(app), fields(session_id = %session_id, id = %id, service = %service))]
pub fn workspace_connect_start(
    app: AppHandle,
    session_id: String,
    id: String,
    service: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    validate_account_id(&session_id)?;
    let svc = ConnectService::parse(&service).ok_or_else(|| CommandError::Validation {
        field: "service".into(),
        reason: format!("unknown connect service '{service}'"),
    })?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace uses your machine's native logins; \
                     run the CLI's login command in a terminal instead of connecting."
                .into(),
        });
    }

    let binary = find_binary_by_name(svc.binary()).ok_or_else(|| CommandError::Io {
        message: format!(
            "{} CLI not found. Install it first, then connect.",
            svc.binary()
        ),
    })?;

    // Idempotent: a live session under this id means connect is already running.
    {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        if map.contains_key(&session_id) {
            return Ok(());
        }
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let mut cmd = CommandBuilder::new(&binary);
    for arg in svc.args() {
        cmd.arg(arg);
    }
    cmd.cwd(dirs::home_dir().unwrap_or_default());
    cmd.env("PATH", get_extended_path());
    cmd.env("TERM", "xterm-256color");
    // Run inside the workspace's isolated env so the login writes into the
    // workspace's config dir (GH_CONFIG_DIR / CODEX_HOME / XDG_DATA_HOME).
    for (k, v) in get_env_vars_for_account(&id) {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command: {e}"))?;
    let child_killer = child.clone_killer();

    let session = Arc::new(ConnectSession {
        writer: Mutex::new(writer),
        child_killer: Mutex::new(child_killer),
        master: Mutex::new(pair.master),
        captured: AtomicBool::new(false),
    });
    CONNECT_REGISTRY
        .lock()
        .map_err(|e| format!("connect registry poisoned: {e}"))?
        .insert(session_id.clone(), session.clone());

    // Reader thread: stream output verbatim. For GitHub, auto-send Enter once we
    // see the "Press Enter to open…" prompt so the browser launches itself.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let session = session.clone();
        let auto_enter = svc.auto_enter();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut sent_enter = false;
            // Small rolling window so the prompt is matched even when it straddles
            // a read boundary.
            let mut tail: Vec<u8> = Vec::new();
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                emit_workspace_connect_data(&app, &session_id, &buf[..n]);
                if auto_enter && !sent_enter {
                    tail.extend_from_slice(&buf[..n]);
                    let hay = String::from_utf8_lossy(&tail).to_lowercase();
                    if hay.contains("press enter") {
                        if let Ok(mut w) = session.writer.lock() {
                            let _ = w.write_all(b"\r");
                        }
                        sent_enter = true;
                        tail.clear();
                    } else if tail.len() > 4096 {
                        // Bound the window; keep only the most recent bytes.
                        let keep = tail.len() - 2048;
                        tail.drain(..keep);
                    }
                }
            }
        });
    }

    // Waiter thread: reaps the child, drops the registry entry, signals exit.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) if status.success() => 0,
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            if let Ok(mut map) = CONNECT_REGISTRY.lock() {
                map.remove(&session_id);
            }
            let _ = app.emit(
                "workspace-connect-exit",
                serde_json::json!({ "sessionId": session_id, "exitCode": code }),
            );
        });
    }

    Ok(())
}

/// Forward keystrokes to a workspace-connect PTY.
#[tauri::command]
#[tracing::instrument(skip(data))]
pub fn workspace_connect_write(session_id: String, data: Vec<u8>) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown connect session".to_string().into());
    };
    let mut w = session
        .writer
        .lock()
        .map_err(|e| format!("writer lock poisoned: {e}"))?;
    w.write_all(&data).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Resize a workspace-connect PTY to match the on-screen terminal.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_connect_resize(
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let session = {
        let map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return Err("unknown connect session".to_string().into());
    };
    let master = session
        .master
        .lock()
        .map_err(|e| format!("master lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

/// Kill a workspace-connect PTY and drop its registry entry. Idempotent.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_connect_close(session_id: String) -> Result<(), CommandError> {
    let session = {
        let mut map = CONNECT_REGISTRY
            .lock()
            .map_err(|e| format!("connect registry poisoned: {e}"))?;
        map.remove(&session_id)
    };
    if let Some(session) = session {
        if let Ok(mut killer) = session.child_killer.lock() {
            let _ = killer.kill();
        }
    }
    Ok(())
}

/// Sign a workspace out of a config-dir login (GitHub / Codex / Opencode) by
/// running the CLI's logout under the workspace's isolated env. Best-effort:
/// returns the captured output for surfacing, but a non-zero exit (already
/// logged out) is not treated as an error.
#[tauri::command]
#[tracing::instrument]
pub fn workspace_disconnect_service(id: String, service: String) -> Result<(), CommandError> {
    validate_account_id(&id)?;
    let svc = ConnectService::parse(&service).ok_or_else(|| CommandError::Validation {
        field: "service".into(),
        reason: format!("unknown connect service '{service}'"),
    })?;
    if id == DEFAULT_ACCOUNT_ID {
        return Err(CommandError::Validation {
            field: "id".into(),
            reason: "The Default workspace uses your machine's native logins; \
                     sign out with the CLI directly."
                .into(),
        });
    }
    let binary = find_binary_by_name(svc.binary()).ok_or_else(|| CommandError::Io {
        message: format!("{} CLI not found.", svc.binary()),
    })?;
    let logout_args: &[&str] = match svc {
        ConnectService::Github => &["auth", "logout", "--hostname", "github.com"],
        ConnectService::Codex => &["logout"],
        ConnectService::Opencode => &["auth", "logout"],
    };
    let mut command = std::process::Command::new(&binary);
    command.args(logout_args);
    command.env("PATH", get_extended_path());
    for (k, v) in get_env_vars_for_account(&id) {
        command.env(k, v);
    }
    // Best-effort: failures (e.g. "not logged in") are fine.
    let _ = command.output();
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
    fn get_env_vars_injects_config_dirs_for_isolated_workspaces() {
        // A non-default workspace must override the CLI config/data dirs so its
        // logins stay isolated from the global ones.
        let vars = get_env_vars_for_account("nonexistent-account-xyz-test");
        assert!(vars.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(vars.contains_key("GH_CONFIG_DIR"));
        assert!(vars.contains_key("CODEX_HOME"));
        assert!(vars.contains_key("XDG_DATA_HOME"));
        // No credentials stored for this account, so no token vars. Claude's
        // per-workspace token is only injected once the workspace connects.
        assert!(!vars.contains_key("VERCEL_TOKEN"));
        assert!(!vars.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[test]
    fn get_env_vars_omits_config_dirs_for_default_workspace() {
        // Regression (GitHub auth loop on Windows + some Macs): forcing these on
        // the Default workspace pointed gh/opencode at a dir the token wasn't in,
        // so status reads found no login and the connect button looped. The
        // Default workspace must let each tool resolve its own native location.
        let vars = get_env_vars_for_account(DEFAULT_ACCOUNT_ID);
        assert!(!vars.contains_key("GH_CONFIG_DIR"));
        assert!(!vars.contains_key("CLAUDE_CONFIG_DIR"));
        assert!(!vars.contains_key("CODEX_HOME"));
        assert!(!vars.contains_key("XDG_DATA_HOME"));
        // The Default workspace uses Claude's native keychain login, never an
        // injected token — injecting one would override the user's real login.
        assert!(!vars.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    /// Convenience: run the stream redactor over a single complete buffer.
    fn redact_once(input: &[u8]) -> (Vec<u8>, Option<String>) {
        let mut carry = input.to_vec();
        let (mut emit, token) = redact_token_stream(&mut carry, true);
        // EOF flush leaves nothing behind, but be defensive.
        emit.extend_from_slice(&carry);
        (emit, token)
    }

    #[test]
    fn redact_captures_token_and_replaces_it_in_the_stream() {
        // Mirrors real `claude setup-token` output (token is sk-ant-oat…, ~108 chars).
        let out =
            b"\nLong-lived token created!\n\nsk-ant-oat01-abcDEF_123-456.789xyz\n\nStore it.\n";
        let (emit, token) = redact_once(out);
        assert_eq!(token.as_deref(), Some("sk-ant-oat01-abcDEF_123-456.789xyz"));
        // The real token is gone from what the webview would see; placeholder stays.
        let shown = String::from_utf8_lossy(&emit);
        assert!(!shown.contains("oat01-abcDEF"), "token leaked: {shown}");
        assert!(shown.contains("sk-ant-[redacted by Ship Studio]"));
        // Surrounding text is preserved verbatim.
        assert!(shown.contains("Long-lived token created!"));
        assert!(shown.contains("Store it."));
    }

    #[test]
    fn connect_service_parses_known_services_only() {
        assert_eq!(
            ConnectService::parse("github"),
            Some(ConnectService::Github)
        );
        assert_eq!(ConnectService::parse("codex"), Some(ConnectService::Codex));
        assert_eq!(
            ConnectService::parse("opencode"),
            Some(ConnectService::Opencode)
        );
        assert_eq!(ConnectService::parse("claude"), None);
        assert_eq!(ConnectService::parse("vercel"), None);
        assert_eq!(ConnectService::parse(""), None);
    }

    #[test]
    fn connect_service_only_github_auto_enters() {
        // Only GitHub's device flow pauses on a "Press Enter to open…" prompt.
        assert!(ConnectService::Github.auto_enter());
        assert!(!ConnectService::Codex.auto_enter());
        assert!(!ConnectService::Opencode.auto_enter());
    }

    #[test]
    fn connect_service_uses_isolated_login_commands() {
        assert_eq!(ConnectService::Github.binary(), "gh");
        assert!(ConnectService::Github
            .args()
            .starts_with(&["auth", "login"]));
        assert_eq!(ConnectService::Codex.binary(), "codex");
        assert_eq!(ConnectService::Codex.args(), &["login"]);
        assert_eq!(ConnectService::Opencode.binary(), "opencode");
        assert_eq!(ConnectService::Opencode.args(), &["auth", "login"]);
    }

    #[test]
    fn workspace_disconnect_rejects_default_and_unknown_service() {
        // Unknown service is rejected before anything is run.
        assert!(workspace_disconnect_service("some-workspace".into(), "bogus".into()).is_err());
        // The Default workspace's native logins aren't managed here.
        assert!(workspace_disconnect_service(DEFAULT_ACCOUNT_ID.into(), "github".into()).is_err());
    }

    #[test]
    fn redact_handles_ansi_color_around_token() {
        // setup-token may color the token; ANSI brackets it rather than splitting
        // it, so the prefix is still found and the run terminates at the ESC.
        let colored = b"\x1b[32msk-ant-oat01-tokenWithEnoughLength12345\x1b[0m done";
        let (emit, token) = redact_once(colored);
        assert_eq!(
            token.as_deref(),
            Some("sk-ant-oat01-tokenWithEnoughLength12345")
        );
        assert!(!String::from_utf8_lossy(&emit).contains("tokenWithEnoughLength"));
    }

    #[test]
    fn redact_leaves_non_token_text_untouched() {
        let (emit, token) = redact_once(b"no token here, just a prompt > ");
        assert_eq!(token, None);
        assert_eq!(emit, b"no token here, just a prompt > ");
        // A too-short sk-ant- fragment is not mistaken for a token.
        let (emit, token) = redact_once(b"see sk-ant-x in docs");
        assert_eq!(token, None);
        assert_eq!(emit, b"see sk-ant-x in docs");
    }

    #[test]
    fn redact_captures_token_split_across_reads() {
        // The token straddles two PTY reads — including a split mid-prefix. The
        // held-back tail must let us still capture + redact it.
        let mut carry: Vec<u8> = Vec::new();
        let mut all_emitted: Vec<u8> = Vec::new();
        let mut captured: Option<String> = None;

        for chunk in [
            &b"token: sk-an"[..],
            &b"t-oat01-splitAcrossTwoReads99"[..],
            &b"\n(done)"[..],
        ] {
            carry.extend_from_slice(chunk);
            let (emit, token) = redact_token_stream(&mut carry, false);
            all_emitted.extend_from_slice(&emit);
            if token.is_some() {
                captured = token;
            }
        }
        let (emit, token) = redact_token_stream(&mut carry, true);
        all_emitted.extend_from_slice(&emit);
        if token.is_some() {
            captured = token;
        }

        assert_eq!(
            captured.as_deref(),
            Some("sk-ant-oat01-splitAcrossTwoReads99")
        );
        let shown = String::from_utf8_lossy(&all_emitted);
        assert!(
            !shown.contains("splitAcrossTwoReads"),
            "token leaked: {shown}"
        );
        assert!(shown.contains("sk-ant-[redacted by Ship Studio]"));
        assert!(shown.contains("(done)"));
    }

    #[test]
    fn redact_does_not_emit_a_partial_prefix_early() {
        // A buffer ending mid-prefix must hold the partial back (not emit it),
        // so a token completing on the next read is still redacted.
        let mut carry = b"prompt sk-an".to_vec();
        let (emit, token) = redact_token_stream(&mut carry, false);
        assert_eq!(token, None);
        assert_eq!(emit, b"prompt ");
        assert_eq!(carry, b"sk-an"); // retained for the next read
    }

    #[test]
    fn parse_claude_auth_status_reads_email_and_logged_in() {
        // The shape `claude auth status` returns for a native claude.ai login.
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.com"}"#;
        assert_eq!(
            parse_claude_auth_status(json),
            (true, Some("a@b.com".into()))
        );

        // Token-auth shape has no email — must not invent one.
        let token_shape = r#"{"loggedIn":true,"authMethod":"oauth_token"}"#;
        assert_eq!(parse_claude_auth_status(token_shape), (true, None));

        // Non-JSON / empty → not logged in, no email (never panics).
        assert_eq!(parse_claude_auth_status("not json"), (false, None));
        assert_eq!(parse_claude_auth_status(""), (false, None));
    }

    #[test]
    fn managed_cred_keys_are_not_frontend_settable() {
        // claude_oauth_token / claude_email are backend-managed: the frontend
        // must not be able to write or probe them via set/clear_account_credential.
        for key in MANAGED_CRED_KEYS {
            assert!(
                validate_credential_key(key).is_err(),
                "managed key {key:?} must be rejected by the frontend credential allowlist"
            );
        }
    }

    #[test]
    fn get_env_vars_falls_back_to_default_for_invalid_id() {
        // An invalid id falls back to Default, which (post-fix) injects no config
        // dirs — so a tampered id can't smuggle in a forced GH_CONFIG_DIR either.
        let vars = get_env_vars_for_account("../../etc");
        assert!(!vars.contains_key("GH_CONFIG_DIR"));
    }

    #[test]
    fn parse_gh_auth_status_extracts_username() {
        // Old gh phrasing ("... as <user>"), no "Active account" marker.
        let old = "github.com\n  Logged in to github.com as octocat (oauth_token)\n";
        assert_eq!(parse_gh_auth_status(old, ""), Some("octocat".to_string()));

        // New gh phrasing (~v2.40+: "... account <user>"), with the ✓ glyph.
        let new = "github.com\n  ✓ Logged in to github.com account julianmemberstack (keyring)\n  - Active account: true\n";
        assert_eq!(
            parse_gh_auth_status(new, ""),
            Some("julianmemberstack".to_string())
        );
    }

    #[test]
    fn parse_gh_auth_status_returns_none_when_not_logged_in() {
        assert_eq!(
            parse_gh_auth_status("", "You are not logged into any GitHub hosts."),
            None
        );
    }

    #[test]
    fn parse_gh_auth_status_finds_active_login_despite_failed_second_account() {
        // Regression (grey GitHub button / connect loop): `gh auth status` exits
        // NON-ZERO when any configured account has an invalid token, even though a
        // different account is logged in and active. We must report the user as
        // connected by reading the ✓ active login, not the exit code — and the
        // "X Failed to log in" line must NOT be mistaken for a login.
        let out = "github.com\n  \u{2713} Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Token scopes: 'gist', 'read:org', 'repo'\n\n  X Failed to log in to github.com account hubot (keyring)\n  - Active account: false\n  - The token in keyring is invalid.\n";
        assert_eq!(parse_gh_auth_status(out, ""), Some("octocat".to_string()));
    }

    #[test]
    fn parse_gh_auth_status_reports_disconnected_when_active_account_invalid() {
        // Inverse edge: the *active* account's token is invalid while a different
        // (non-active) account is still valid. gh operations run as the active
        // account, so this must report "not connected" rather than a false green.
        let out = "github.com\n  X Failed to log in to github.com account broken-active (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n\n  \u{2713} Logged in to github.com account good-inactive (keyring)\n  - Active account: false\n";
        assert_eq!(parse_gh_auth_status(out, ""), None);
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
