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
        HostingProvider::Cloudflare => wrangler_cli_token(),
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

/// Where wrangler keeps its OAuth credentials.
///
/// **Not** `~/.config/.wrangler` on macOS, which is what the documentation's
/// XDG-style description implies — an actual `wrangler login` on macOS wrote
/// to `~/Library/Preferences/.wrangler/config/default.toml`. Both are tried,
/// plus the Windows location.
fn wrangler_config_paths() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join(".wrangler/config/default.toml"));
    }
    paths.push(home.join("Library/Preferences/.wrangler/config/default.toml"));
    paths.push(home.join(".config/.wrangler/config/default.toml"));
    paths.push(home.join("AppData/Roaming/xdg.config/.wrangler/config/default.toml"));
    paths
}

/// Read wrangler's OAuth token, honouring its expiry.
///
/// Short-lived like Vercel's: a token observed straight after `wrangler login`
/// carried an `expiration_time` one hour out. It is borrowed for convenience
/// and never depended on — an expired one is skipped so the UI asks for a real
/// token rather than showing a rejection the user cannot explain.
fn wrangler_cli_token() -> Option<String> {
    for path in wrangler_config_paths() {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(token) = toml_string(&raw, "oauth_token") else {
            continue;
        };
        if let Some(expires) = toml_string(&raw, "expiration_time") {
            if iso_is_past(&expires) {
                tracing::debug!(
                    "wrangler token at {} has expired; not using it",
                    path.display()
                );
                continue;
            }
        }
        return Some(token);
    }
    None
}

/// Pull one quoted value out of a flat TOML file.
///
/// Deliberately not a TOML parser: this reads exactly two keys from a file the
/// app does not own, and a dependency for that would be a poor trade.
fn toml_string(raw: &str, key: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .find_map(|line| {
            let (name, value) = line.split_once('=')?;
            if name.trim() != key {
                return None;
            }
            let value = value.trim().trim_matches('"').trim();
            (!value.is_empty()).then(|| value.to_string())
        })
}

/// Whether an ISO-8601 instant is in the past.
fn iso_is_past(value: &str) -> bool {
    match super::model::iso_to_ms(Some(value)) {
        Some(at) => at <= super::model::now_ms(),
        // An unparseable expiry is treated as still valid: the provider will
        // reject the token if it is not, and that path already explains itself.
        None => false,
    }
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
    fn wrangler_credentials_are_read_from_the_path_it_actually_writes() {
        // The documentation describes an XDG-style location; a real
        // `wrangler login` on macOS wrote somewhere else entirely, so both are
        // tried rather than trusting the docs.
        let paths = wrangler_config_paths();
        assert!(
            paths
                .iter()
                .any(|p| p.ends_with("Library/Preferences/.wrangler/config/default.toml")),
            "the macOS path wrangler actually uses must be tried"
        );
        assert!(
            paths
                .iter()
                .any(|p| p.ends_with(".config/.wrangler/config/default.toml")),
            "the documented path must still be tried"
        );
    }

    #[test]
    fn a_flat_toml_value_is_read_without_a_parser() {
        let raw = concat!(
            "oauth_token = \"abc123\"\n",
            "expiration_time = \"2026-09-06T04:17:18.337Z\"\n",
            "# oauth_token = \"commented-out\"\n",
            "scopes = [ \"account:read\" ]\n"
        );
        assert_eq!(toml_string(raw, "oauth_token").as_deref(), Some("abc123"));
        assert_eq!(
            toml_string(raw, "expiration_time").as_deref(),
            Some("2026-09-06T04:17:18.337Z")
        );
        assert_eq!(toml_string(raw, "missing"), None);
    }

    #[test]
    fn an_expired_wrangler_token_is_skipped_not_offered() {
        assert!(iso_is_past("2020-01-01T00:00:00.000Z"));
        assert!(!iso_is_past("2099-01-01T00:00:00.000Z"));
        // An expiry we cannot read is not treated as expired — the provider
        // will reject it if it is, and that path already explains itself.
        assert!(!iso_is_past("not a date"));
    }

    #[test]
    fn every_provider_offers_at_least_one_credential_path_when_home_is_set() {
        if home().is_some() {
            assert!(!vercel_auth_paths().is_empty());
            assert!(!netlify_config_paths().is_empty());
        }
    }
}
