//! # Web server configuration
//!
//! Everything the self-hosted server needs, read from the environment once at
//! startup. Anything missing or unsafe is a hard failure here rather than a
//! surprise at request time — this process hands out a shell on the host, so
//! "start anyway with a default" is never the right call for auth.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

type HmacSha256 = Hmac<Sha256>;

/// Minimum accepted `SHIP_AUTH_TOKEN` length. The token is the only thing
/// standing between the internet and `spawn_pty`, so a short one is refused
/// outright rather than warned about.
const MIN_TOKEN_LEN: usize = 16;

/// Default listen address. Loopback — binding anywhere else needs an explicit
/// opt-in (see [`Config::from_env`]).
const DEFAULT_BIND: &str = "127.0.0.1:1420";

/// Default range the preview proxy and static server allocate listeners from.
/// Bounded so a container can publish exactly this range.
const DEFAULT_PREVIEW_PORTS: (u16, u16) = (3100, 3130);

/// Fully resolved server configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Address to listen on.
    pub bind: SocketAddr,
    /// Shared secret a client must present to `POST /api/login`.
    pub auth_token: String,
    /// Key used to sign session cookies. Derived from `auth_token`, so rotating
    /// the token invalidates every outstanding session for free.
    pub session_key: [u8; 32],
    /// Origin the browser is expected to use, e.g. `https://ship.example.com`.
    /// State-changing requests and WebSocket upgrades are checked against it.
    /// `None` falls back to checking the request's own `Host` header.
    pub public_origin: Option<String>,
    /// Directory holding the built frontend (`dist/`).
    pub static_dir: PathBuf,
    /// Inclusive port range for preview/static-server listeners.
    pub preview_ports: (u16, u16),
    /// Address preview listeners bind to. `0.0.0.0` inside a container.
    pub preview_bind: IpAddr,
    /// How the *browser* reaches a preview listener, as a template containing
    /// `{port}` — e.g. `https://preview-{port}.example.com`.
    ///
    /// Needed because the port the server binds is not necessarily the address
    /// a remote browser can dial. When the app is served over TLS, an
    /// `http://host:port` preview is blocked as mixed content before it is even
    /// attempted, so a deployment behind a reverse proxy must be able to say
    /// "the preview on port N lives *here*" rather than have the client guess.
    ///
    /// `None` keeps the historical `http://{previewHost}:{port}` behaviour.
    pub preview_url_template: Option<String>,
    /// Session cookie lifetime.
    pub session_ttl_secs: u64,
}

impl Config {
    /// Read and validate configuration from the process environment.
    pub fn from_env() -> Result<Self, String> {
        let auth_token = std::env::var("SHIP_AUTH_TOKEN")
            .map_err(|_| "SHIP_AUTH_TOKEN is not set. Refusing to start: this server exposes shell access and must not run unauthenticated.".to_string())?;

        if auth_token.trim().len() < MIN_TOKEN_LEN {
            return Err(format!(
                "SHIP_AUTH_TOKEN must be at least {MIN_TOKEN_LEN} characters. Refusing to start."
            ));
        }

        let bind_raw = env_or("SHIP_BIND", DEFAULT_BIND);
        let bind = bind_raw
            .to_socket_addrs()
            .map_err(|e| format!("SHIP_BIND `{bind_raw}` is not a valid address: {e}"))?
            .next()
            .ok_or_else(|| format!("SHIP_BIND `{bind_raw}` resolved to no address"))?;

        check_bind_allowed(&bind, env_flag("SHIP_ALLOW_EXTERNAL_BIND"))?;

        let preview_ports = match std::env::var("SHIP_PREVIEW_PORT_RANGE") {
            Ok(raw) => parse_port_range(&raw)?,
            Err(_) => DEFAULT_PREVIEW_PORTS,
        };

        let preview_bind: IpAddr = env_or("SHIP_PREVIEW_BIND", "127.0.0.1")
            .parse()
            .map_err(|e| format!("SHIP_PREVIEW_BIND is not a valid IP address: {e}"))?;

        let preview_url_template = std::env::var("SHIP_PREVIEW_URL_TEMPLATE")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        if let Some(template) = &preview_url_template {
            validate_preview_url_template(template)?;
        }

        Ok(Config {
            session_key: derive_session_key(&auth_token),
            auth_token,
            bind,
            public_origin: std::env::var("SHIP_PUBLIC_ORIGIN")
                .ok()
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty()),
            static_dir: PathBuf::from(env_or("SHIP_STATIC_DIR", "dist")),
            preview_ports,
            preview_bind,
            preview_url_template,
            session_ttl_secs: 60 * 60 * 24 * 7,
        })
    }

    /// True when this config exposes the server beyond loopback — the caller
    /// logs a warning banner so it can't happen silently.
    pub fn is_externally_bound(&self) -> bool {
        !self.bind.ip().is_loopback()
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Truthy env flag. Only explicit affirmatives count — a typo reads as "no",
/// which is the safe direction for every flag this gates.
fn env_flag(key: &str) -> bool {
    matches!(
        std::env::var(key).unwrap_or_default().trim(),
        "1" | "true" | "TRUE" | "yes" | "YES"
    )
}

/// Refuse a non-loopback bind unless the operator explicitly opted in.
///
/// This is the difference between "a dev tool on my laptop" and "a remote shell
/// on the internet", so it fails closed and says why.
fn check_bind_allowed(bind: &SocketAddr, allow_external: bool) -> Result<(), String> {
    if bind.ip().is_loopback() || allow_external {
        return Ok(());
    }
    Err(format!(
        "SHIP_BIND `{bind}` is not a loopback address. Set SHIP_ALLOW_EXTERNAL_BIND=1 to confirm you intend to expose this server, and put TLS in front of it."
    ))
}

/// Reject a preview URL template that could not produce working preview URLs.
///
/// Both failures are silent at runtime if left unchecked — a missing `{port}`
/// sends every preview to one address, and a scheme-less template yields a
/// relative URL the browser resolves against the app's own origin — so this is
/// a startup error rather than a per-request surprise.
fn validate_preview_url_template(template: &str) -> Result<(), String> {
    if !template.contains("{port}") {
        return Err(format!(
            "SHIP_PREVIEW_URL_TEMPLATE `{template}` must contain `{{port}}`"
        ));
    }
    if !template.starts_with("http://") && !template.starts_with("https://") {
        return Err(format!(
            "SHIP_PREVIEW_URL_TEMPLATE `{template}` must start with http:// or https://"
        ));
    }
    Ok(())
}

/// Parse `"3100-3130"` into an inclusive port range.
fn parse_port_range(raw: &str) -> Result<(u16, u16), String> {
    let (lo, hi) = raw
        .split_once('-')
        .ok_or_else(|| format!("SHIP_PREVIEW_PORT_RANGE `{raw}` must look like `3100-3130`"))?;
    let lo: u16 = lo
        .trim()
        .parse()
        .map_err(|e| format!("SHIP_PREVIEW_PORT_RANGE start is not a port: {e}"))?;
    let hi: u16 = hi
        .trim()
        .parse()
        .map_err(|e| format!("SHIP_PREVIEW_PORT_RANGE end is not a port: {e}"))?;
    if lo == 0 || hi < lo {
        return Err(format!(
            "SHIP_PREVIEW_PORT_RANGE `{raw}` is empty or inverted"
        ));
    }
    Ok((lo, hi))
}

/// Derive the cookie-signing key from the auth token.
///
/// Deliberately deterministic rather than random-per-boot: a restart shouldn't
/// log the user out, and rotating `SHIP_AUTH_TOKEN` *should* invalidate every
/// session. The domain-separation label stops this key from colliding with any
/// other HMAC use of the same token.
fn derive_session_key(token: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(b"ship-studio/session-cookie/v1")
        .expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    let bytes = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_port_range() {
        assert_eq!(parse_port_range("3100-3130").unwrap(), (3100, 3130));
        assert_eq!(parse_port_range(" 100 - 200 ").unwrap(), (100, 200));
    }

    #[test]
    fn accepts_a_usable_preview_url_template() {
        assert!(validate_preview_url_template("https://preview-{port}.example.com").is_ok());
        assert!(validate_preview_url_template("http://127.0.0.1:{port}").is_ok());
    }

    #[test]
    fn rejects_a_template_without_a_port_placeholder() {
        // Would point every preview at the same host, silently showing one
        // project's dev server in another project's pane.
        assert!(validate_preview_url_template("https://preview.example.com").is_err());
    }

    #[test]
    fn rejects_a_template_without_a_scheme() {
        // Resolves relative to the app's own origin instead of the preview's.
        assert!(validate_preview_url_template("preview-{port}.example.com").is_err());
        assert!(validate_preview_url_template("//preview-{port}.example.com").is_err());
    }

    #[test]
    fn rejects_malformed_or_inverted_ranges() {
        assert!(parse_port_range("3100").is_err());
        assert!(parse_port_range("3130-3100").is_err());
        assert!(parse_port_range("0-10").is_err());
        assert!(parse_port_range("abc-def").is_err());
    }

    #[test]
    fn session_key_follows_the_token() {
        // Same token → same key (restarts keep sessions alive).
        assert_eq!(
            derive_session_key("hunter2hunter2hunter2"),
            derive_session_key("hunter2hunter2hunter2")
        );
        // Different token → different key (rotation logs everyone out).
        assert_ne!(
            derive_session_key("hunter2hunter2hunter2"),
            derive_session_key("hunter3hunter3hunter3")
        );
    }

    #[test]
    fn non_loopback_bind_needs_an_explicit_opt_in() {
        let external: SocketAddr = "0.0.0.0:1420".parse().unwrap();
        let public: SocketAddr = "203.0.113.7:1420".parse().unwrap();
        let loopback: SocketAddr = "127.0.0.1:1420".parse().unwrap();
        let loopback_v6: SocketAddr = "[::1]:1420".parse().unwrap();

        // Loopback is always fine, opt-in or not.
        assert!(check_bind_allowed(&loopback, false).is_ok());
        assert!(check_bind_allowed(&loopback_v6, false).is_ok());

        // Anything else is refused until the operator says so.
        assert!(check_bind_allowed(&external, false).is_err());
        assert!(check_bind_allowed(&public, false).is_err());
        assert!(check_bind_allowed(&external, true).is_ok());
        assert!(check_bind_allowed(&public, true).is_ok());
    }

    #[test]
    fn env_flag_only_accepts_explicit_affirmatives() {
        // Uses a key no other test touches; env is process-global.
        let key = "SHIP_TEST_FLAG_AFFIRMATIVE";
        for (value, expected) in [
            ("1", true),
            ("true", true),
            ("yes", true),
            ("0", false),
            ("false", false),
            ("", false),
            ("ture", false),
        ] {
            std::env::set_var(key, value);
            assert_eq!(env_flag(key), expected, "value `{value}`");
        }
        std::env::remove_var(key);
    }
}
