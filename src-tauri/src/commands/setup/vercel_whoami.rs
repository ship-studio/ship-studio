//! # Vercel identity probe
//!
//! The one place Ship Studio runs `vercel whoami`. Setup status and the
//! workspace credential status both go through here.
//!
//! `whoami` is not a passive read in Vercel CLI 54.x. It can start the OAuth
//! device-code login and open the user's browser on its "authorize device"
//! page, in two ways:
//!
//! - **No credentials, and the CLI thinks an AI agent is running it.** In that
//!   case `index.js` calls `login()` instead of printing "No existing
//!   credentials". It decides it's an agent from env vars like `CLAUDECODE` and
//!   `AI_AGENT` (`@vercel/detect-agent`). Ship Studio inherits those whenever it
//!   is launched from an agent's shell, and the CLI inherits them from us.
//! - **A team scope that needs re-authentication** (SAML). `reauthenticate()`
//!   runs the device flow unless `CI` is set and stdin is not a TTY.
//!
//! A status check must never do either, so the probe strips the agent markers
//! and sets `CI=1`, which also stops the device flow from opening a browser.
//! The answer is cached, and calls are serialized: the CLI rotates its refresh
//! token, and two `whoami`s refreshing at once leave the loser's process
//! wiping `auth.json`, which logs the user out.

use crate::external_command::run_with_timeout;
use crate::utils::{create_command, get_extended_path};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Env vars `@vercel/detect-agent` reads to decide an AI agent is running the
/// CLI (54.x). Any of them, with no stored credentials, turns `whoami` into a
/// browser login.
const AGENT_MARKER_ENV: &[&str] = &[
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE",
    "CLAUDE_CODE_IS_COWORK",
    "CURSOR_TRACE_ID",
    "CURSOR_AGENT",
    "CURSOR_EXTENSION_HOST_ROLE",
    "GEMINI_CLI",
    "CODEX_SANDBOX",
    "CODEX_CI",
    "CODEX_THREAD_ID",
    "ANTIGRAVITY_AGENT",
    "AUGMENT_AGENT",
    "OPENCODE_CLIENT",
    "REPL_ID",
    "COPILOT_MODEL",
    "COPILOT_ALLOW_ALL",
    "COPILOT_GITHUB_TOKEN",
    // Makes the CLI treat a pipe as a terminal.
    "FORCE_TTY",
];

/// How long a signed-in answer is reused. Switching between Projects and
/// Agents remounts the dashboard, which asks again each time.
const SIGNED_IN_TTL: Duration = Duration::from_secs(300);
/// Shorter for "not signed in", so a login done in a terminal shows up soon.
const SIGNED_OUT_TTL: Duration = Duration::from_secs(15);
const WHOAMI_TIMEOUT_SECS: u64 = 10;

struct Cached {
    username: Option<String>,
    at: Instant,
}

/// Keyed by a hash of the token, `0` for the CLI's own login. Raw tokens are
/// never kept here.
static CACHE: LazyLock<Mutex<HashMap<u64, Cached>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// One `whoami` at a time (see the module doc on refresh-token rotation).
static IN_FLIGHT: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn cache_key(token: Option<&str>) -> u64 {
    token.map_or(0, |t| {
        let mut h = DefaultHasher::new();
        t.hash(&mut h);
        h.finish() | 1
    })
}

fn cached(key: u64) -> Option<Option<String>> {
    let cache = CACHE.lock().ok()?;
    let entry = cache.get(&key)?;
    let ttl = if entry.username.is_some() {
        SIGNED_IN_TTL
    } else {
        SIGNED_OUT_TTL
    };
    (entry.at.elapsed() < ttl).then(|| entry.username.clone())
}

/// Forget every cached answer. Call when a Vercel credential changes.
pub fn invalidate_vercel_whoami_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
}

/// `vercel whoami`, built so it can only answer and never log in.
pub(crate) fn whoami_command(vercel_path: &Path, token: Option<&str>) -> Command {
    let mut cmd = create_command(vercel_path);
    cmd.arg("whoami")
        .env("PATH", get_extended_path())
        .env("CI", "1")
        .env("NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null());
    for var in AGENT_MARKER_ENV {
        cmd.env_remove(var);
    }
    match token {
        Some(t) => cmd.env("VERCEL_TOKEN", t),
        None => cmd.env_remove("VERCEL_TOKEN"),
    };
    cmd
}

/// The signed-in Vercel username, or `None` (not signed in, CLI failure, or
/// timeout). `token` is a workspace's own token; `None` uses the CLI's login.
pub async fn vercel_whoami(vercel_path: &Path, token: Option<&str>) -> Option<String> {
    let key = cache_key(token);
    if let Some(hit) = cached(key) {
        return hit;
    }
    let _guard = IN_FLIGHT.lock().await;
    // Whoever held the lock may have just answered this.
    if let Some(hit) = cached(key) {
        return hit;
    }

    let mut cmd = tokio::process::Command::from(whoami_command(vercel_path, token));
    cmd.kill_on_drop(true);
    let username = match run_with_timeout(cmd, "vercel whoami", WHOAMI_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!name.is_empty()).then_some(name)
        }
        Ok(_) => None,
        Err(err) => {
            tracing::warn!(error = %err, "vercel whoami failed; treating Vercel as not signed in");
            None
        }
    };
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(
            key,
            Cached {
                username: username.clone(),
                at: Instant::now(),
            },
        );
    }
    username
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn env_of<'a>(cmd: &'a Command, name: &str) -> Option<Option<&'a OsStr>> {
        cmd.get_envs()
            .find(|(k, _)| *k == OsStr::new(name))
            .map(|(_, v)| v)
    }

    #[test]
    fn whoami_is_non_interactive() {
        let cmd = whoami_command(Path::new("/usr/local/bin/vercel"), None);
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), [OsStr::new("whoami")]);
        // CI=1: reauthenticate() refuses the device flow, and the flow never
        // opens a browser.
        assert_eq!(env_of(&cmd, "CI"), Some(Some(OsStr::new("1"))));
        // Every agent marker is removed, so a missing login is an error, not
        // `login()`.
        for var in AGENT_MARKER_ENV {
            assert_eq!(env_of(&cmd, var), Some(None), "{var} must be removed");
        }
        assert_eq!(env_of(&cmd, "VERCEL_TOKEN"), Some(None));
    }

    #[test]
    fn workspace_token_is_passed_by_env_only() {
        let cmd = whoami_command(Path::new("vercel"), Some("tok"));
        assert_eq!(env_of(&cmd, "VERCEL_TOKEN"), Some(Some(OsStr::new("tok"))));
        assert!(cmd.get_args().all(|a| a != OsStr::new("tok")));
    }

    #[test]
    fn cache_keys_separate_cli_login_from_tokens() {
        assert_eq!(cache_key(None), 0);
        assert_ne!(cache_key(Some("a")), 0);
        assert_ne!(cache_key(Some("a")), cache_key(Some("b")));
    }

    #[test]
    fn signed_out_answers_expire_sooner() {
        let key = cache_key(Some("ttl-test"));
        let old = Instant::now() - SIGNED_OUT_TTL - Duration::from_secs(1);
        CACHE.lock().unwrap().insert(
            key,
            Cached {
                username: None,
                at: old,
            },
        );
        assert_eq!(cached(key), None);
        CACHE.lock().unwrap().insert(
            key,
            Cached {
                username: Some("me".into()),
                at: old,
            },
        );
        assert_eq!(cached(key), Some(Some("me".into())));
        CACHE.lock().unwrap().remove(&key);
    }
}
