//! # Support Commands
//!
//! cStar customer support integration for Ship Studio.
//! Only handles identity verification (HMAC signing) — the identity secret
//! stays server-side while all ticket/message operations use the ChatClient
//! SDK on the frontend.

use crate::commands::github::get_gh_command;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tracing::debug;

const CSTAR_IDENTITY_SECRET: &str = env!("CSTAR_IDENTITY_SECRET");

type HmacSha256 = Hmac<Sha256>;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SupportIdentity {
    pub external_id: String,
    pub name: String,
    pub email: String,
    pub timestamp: i64,
    pub signature: String,
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/// Fetch the current GitHub user profile via `gh api user`.
fn get_github_user() -> Result<(String, String, String), String> {
    let output = get_gh_command()
        .args([
            "api",
            "user",
            "--jq",
            r#"[.login, .email // "", .name // ""] | @tsv"#,
        ])
        .output()
        .map_err(|e| format!("Failed to run gh: {e}"))?;

    if !output.status.success() {
        return Err("GitHub CLI not authenticated. Please connect GitHub first.".to_string());
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = raw.split('\t').collect();

    let login = parts.first().unwrap_or(&"").to_string();
    let email = parts.get(1).unwrap_or(&"").to_string();
    let name = parts.get(2).unwrap_or(&"").to_string();

    if login.is_empty() {
        return Err("Could not determine GitHub username".to_string());
    }

    let email = if email.is_empty() {
        format!("{login}@users.noreply.github.com")
    } else {
        email
    };

    let name = if name.is_empty() { login.clone() } else { name };

    Ok((login, email, name))
}

/// Sign an identity payload using HMAC-SHA256.
/// Payload format: JSON.stringify({ email, externalId, name, timestamp })
/// with keys sorted alphabetically.
fn sign_identity(external_id: &str, email: &str, name: &str, timestamp: i64) -> String {
    // IMPORTANT: Keys MUST be in alphabetical order. The HMAC signature
    // depends on the exact JSON serialization. serde_json::json! preserves
    // insertion order, so keep these alphabetical to match the ChatClient SDK.
    let payload = serde_json::json!({
        "email": email,
        "externalId": external_id,
        "name": name,
        "timestamp": timestamp,
    });
    let payload_str = serde_json::to_string(&payload).unwrap_or_default();

    let mut mac = HmacSha256::new_from_slice(CSTAR_IDENTITY_SECRET.as_bytes())
        .expect("HMAC can take any key size");
    mac.update(payload_str.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Returns the current user's identity + HMAC signature for ChatClient.
#[tauri::command]
pub async fn get_support_identity() -> Result<SupportIdentity, String> {
    let (login, email, name) = get_github_user()?;

    let timestamp = chrono::Utc::now().timestamp();
    let signature = sign_identity(&login, &email, &name, timestamp);

    debug!("Generated support identity for {login}");

    Ok(SupportIdentity {
        external_id: login,
        name,
        email,
        timestamp,
        signature,
    })
}
