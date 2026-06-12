//! # Shopify Theme Integration Commands
//!
//! Detection of the Shopify CLI and per-project store configuration for
//! Shopify theme projects. The dev server (`shopify theme dev`) itself is
//! spawned by the frontend through the standard custom-command PTY path;
//! these commands only answer "is the CLI here?" and "which store?".

use crate::commands::claude::find_validated_binary;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{AgentCliStatus, ProjectMetadata};
use crate::utils::{create_command, validate_project_path};

/// Version probes should be near-instant; a hung CLI must not stall the
/// preview-pane setup gate.
const SHOPIFY_DETECT_TIMEOUT_SECS: u64 = 10;

/// Check whether the Shopify CLI is installed and report its version.
///
/// Uses the same validated-binary probe as the agent CLIs so a broken install
/// (e.g. an npm wrapper missing its native dep) doesn't read as "installed".
#[tauri::command]
#[tracing::instrument]
pub async fn check_shopify_cli_status() -> AgentCliStatus {
    let Some(path) = find_validated_binary("shopify", "version") else {
        return AgentCliStatus {
            installed: false,
            version: None,
        };
    };

    let mut cmd = create_command(&path);
    cmd.arg("version");
    let tokio_cmd = tokio::process::Command::from(cmd);
    let version = run_with_timeout(
        tokio_cmd,
        "shopify version".to_string(),
        SHOPIFY_DETECT_TIMEOUT_SECS,
    )
    .await
    .ok()
    .and_then(|output| {
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        }
    });

    AgentCliStatus {
        installed: true,
        version,
    }
}

/// A store domain ends up as an argument to `shopify theme dev --store <x>`.
/// The PTY spawn passes args as an array (no shell), but the frontend splits
/// the command string on whitespace — so reject anything that isn't a plain
/// domain to keep the command unambiguous.
fn validate_store_domain(store: &str) -> Result<(), CommandError> {
    if store.is_empty() {
        return Err(("Store domain cannot be empty".to_string()).into());
    }
    if !store
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err((format!(
            "Invalid store domain '{store}': only letters, digits, '-' and '.' are allowed"
        ))
        .into());
    }
    Ok(())
}

/// Kill any `shopify theme dev` processes left over from previous runs
/// against this store. A stuck instance (blocked on an interactive prompt —
/// login, store password, a y/n confirm) never binds its port, so the
/// port-based orphan reaper can't see it; the stale session then makes the
/// NEXT run stop on a "proceed?" confirm. Called before every theme dev
/// spawn. The store domain is validated, so the pkill pattern is inert.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_stale_theme_dev(store: String) -> Result<(), CommandError> {
    validate_store_domain(&store)?;
    #[cfg(unix)]
    {
        let pattern = format!("shopify theme dev --store {store}");
        let _ = create_command("pkill").args(["-f", &pattern]).output();
    }
    Ok(())
}

/// Gets the connected Shopify store domain for a theme project, or None if
/// the user hasn't connected a store yet.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_shopify_store(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.shopify_store)
}

/// Sets (or clears, with None) the connected Shopify store domain for a
/// theme project. The domain must be a bare hostname like
/// `my-store.myshopify.com` — the frontend normalizes user input first.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_shopify_store(
    project_path: String,
    store: Option<String>,
) -> Result<(), CommandError> {
    if let Some(ref s) = store {
        validate_store_domain(s)?;
    }

    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        std::fs::read_to_string(&metadata_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
            .unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    metadata.shopify_store = store;

    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_domain_accepts_plain_hostnames() {
        assert!(validate_store_domain("my-store.myshopify.com").is_ok());
        assert!(validate_store_domain("shop123.myshopify.com").is_ok());
    }

    #[test]
    fn store_domain_rejects_empty_and_unsafe_input() {
        assert!(validate_store_domain("").is_err());
        // Whitespace would smuggle extra args into the dev command string.
        assert!(validate_store_domain("store --theme-editor-sync").is_err());
        assert!(validate_store_domain("https://store.myshopify.com").is_err());
        assert!(validate_store_domain("store;rm -rf").is_err());
    }
}
