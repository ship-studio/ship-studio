//! Where a provider token comes from.
//!
//! Two sources, in priority order:
//!
//! 1. The keychain, via the existing per-workspace credential mechanism in
//!    `commands::accounts`. Durable, user-controlled, and already injected into
//!    that workspace's terminals so the provider CLI agrees with the app.
//! 2. The provider CLI's own credential file, if one is present and still
//!    valid. This is what makes hosting work with zero setup for someone who
//!    has simply run `vercel login` — but it is borrowed, not ours.
//!
//! The distinction is not academic. The Vercel CLI's token is a short-lived
//! OAuth access token: a real one observed on a developer machine expired
//! roughly seven hours after issue, carrying a `refreshToken` we deliberately
//! do not use (refreshing someone's OAuth session behind their back, against a
//! file whose own header says it must not be edited, is not a contract we can
//! keep). So a CLI-sourced token is best-effort: great while it lasts, and when
//! it stops working the UI says so and offers a durable one, instead of
//! rendering a healthy card over a dead login the way the plugin does today.

use super::model::{HostingProvider, TokenSource};
use std::path::{Path, PathBuf};

/// A token plus where it came from, so a rejection can be explained honestly.
pub struct ResolvedToken {
    pub token: String,
    pub source: TokenSource,
}

/// Resolve a token for this provider in this project's workspace.
///
/// Returns `None` when nothing is available, which the caller renders as an
/// invitation to connect — never as an error.
pub fn token_for(provider: HostingProvider, project_path: &Path) -> Option<ResolvedToken> {
    if let Some(token) = keychain_token(provider, project_path) {
        return Some(ResolvedToken {
            token,
            source: TokenSource::Keychain,
        });
    }
    cli_token(provider).map(|token| ResolvedToken {
        token,
        source: TokenSource::CliFile,
    })
}

/// The workspace-scoped token the user stored, surfaced as an env var by
/// `accounts`. Reading it through the same path the terminals use means the app
/// and the user's own CLI can never disagree about which account is active.
fn keychain_token(provider: HostingProvider, project_path: &Path) -> Option<String> {
    let vars = crate::commands::accounts::get_env_vars_for_project(project_path);
    vars.get(provider.env_var())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Best-effort read of the provider CLI's credential file.
fn cli_token(provider: HostingProvider) -> Option<String> {
    match provider {
        HostingProvider::Vercel => vercel_cli_token(),
        HostingProvider::Netlify => netlify_cli_token(),
        // Wrangler stores nothing until the user logs in, and recent versions
        // keep it in the OS keyring rather than a readable file. There is no
        // file to borrow, so Cloudflare always needs a real token.
        HostingProvider::Cloudflare => None,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Documented locations of the Vercel CLI's `auth.json`, per platform.
fn vercel_auth_paths() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };
    vec![
        home.join("Library/Application Support/com.vercel.cli/auth.json"),
        home.join(".local/share/com.vercel.cli/auth.json"),
        home.join("AppData/Roaming/xdg.data/com.vercel.cli/auth.json"),
    ]
}

/// Read the Vercel CLI token, honouring its expiry.
///
/// `expiresAt` is in **seconds**, not milliseconds — reading it as ms puts the
/// expiry in 1970 and makes every token look long dead.
fn vercel_cli_token() -> Option<String> {
    for path in vercel_auth_paths() {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let token = json.get("token")?.as_str()?.trim().to_string();
        if token.is_empty() {
            continue;
        }
        if let Some(expires_at) = json.get("expiresAt").and_then(|v| v.as_u64()) {
            let now_secs = super::model::now_ms() / 1000;
            if expires_at <= now_secs {
                tracing::debug!(
                    "Vercel CLI token at {} has expired; not using it",
                    path.display()
                );
                continue;
            }
        }
        return Some(token);
    }
    None
}

/// Documented locations of the Netlify CLI's `config.json`, per platform, plus
/// the legacy path older CLI versions used.
fn netlify_config_paths() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("netlify/config.json"));
    }
    paths.push(home.join("Library/Preferences/netlify/config.json"));
    paths.push(home.join(".config/netlify/config.json"));
    paths.push(home.join("AppData/Roaming/netlify/Config/config.json"));
    paths.push(home.join(".netlify/config.json"));
    paths
}

/// Read the Netlify CLI token.
///
/// The file's internal shape is undocumented and has moved across CLI versions,
/// so this reads defensively: the active user first, then any user entry that
/// happens to carry a token. No expiry field is present on observed configs.
fn netlify_cli_token() -> Option<String> {
    for path in netlify_config_paths() {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(token) = netlify_token_from_config(&json) {
            return Some(token);
        }
    }
    None
}

/// Split out so the shape-tolerance is testable without touching a real home
/// directory.
fn netlify_token_from_config(json: &serde_json::Value) -> Option<String> {
    let users = json.get("users")?.as_object()?;

    let active = json.get("userId").and_then(|v| v.as_str());
    if let Some(id) = active {
        if let Some(token) = users
            .get(id)
            .and_then(|u| u.pointer("/auth/token"))
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            return Some(token.to_string());
        }
    }

    users
        .values()
        .filter_map(|u| u.pointer("/auth/token"))
        .filter_map(|t| t.as_str())
        .map(str::trim)
        .find(|t| !t.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn netlify_token_prefers_the_active_user() {
        let config = json!({
            "userId": "active",
            "users": {
                "active":  { "auth": { "token": "the-right-one" } },
                "someone": { "auth": { "token": "the-wrong-one" } },
            }
        });
        assert_eq!(
            netlify_token_from_config(&config).as_deref(),
            Some("the-right-one")
        );
    }

    #[test]
    fn netlify_token_falls_back_when_the_active_id_is_stale() {
        // Observed in the wild after a CLI upgrade rewrote the file.
        let config = json!({
            "userId": "no-longer-present",
            "users": { "someone": { "auth": { "token": "still-usable" } } }
        });
        assert_eq!(
            netlify_token_from_config(&config).as_deref(),
            Some("still-usable")
        );
    }

    #[test]
    fn netlify_token_absent_rather_than_panicking_on_odd_shapes() {
        assert_eq!(netlify_token_from_config(&json!({})), None);
        assert_eq!(netlify_token_from_config(&json!({ "users": {} })), None);
        assert_eq!(
            netlify_token_from_config(&json!({ "users": { "a": { "auth": {} } } })),
            None
        );
        assert_eq!(
            netlify_token_from_config(&json!({ "users": { "a": { "auth": { "token": "  " } } } })),
            None
        );
        assert_eq!(netlify_token_from_config(&json!({ "users": 5 })), None);
    }

    #[test]
    fn cloudflare_never_borrows_a_cli_token() {
        assert!(cli_token(HostingProvider::Cloudflare).is_none());
    }

    #[test]
    fn every_provider_offers_at_least_one_credential_path_when_home_is_set() {
        if home().is_some() {
            assert!(!vercel_auth_paths().is_empty());
            assert!(!netlify_config_paths().is_empty());
        }
    }
}
