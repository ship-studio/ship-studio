//! # Template Gallery Commands
//!
//! Provides the compatibility surface for community templates.

use crate::errors::CommandError;
use ship_studio_macros::ship_command;

/// Render a reqwest error with its full source chain. reqwest's `Display` only
/// prints the top-level context ("error sending request for url (...)"), while
/// the actionable detail — DNS failure, connection refused, timed out, TLS —
/// lives in the `source()` chain (issue #255).
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        msg.push_str(&format!(": {s}"));
        source = s.source();
    }
    msg
}

/// Wrap a network failure as `Expected`.
///
/// A timeout or dropped connection while downloading a template is a network
/// condition, not an app malfunction —
/// `Expected` keeps it out of telemetry while still carrying the underlying
/// cause for the UI to show (issue #754).
fn network_failure(context: &str, e: &reqwest::Error) -> CommandError {
    CommandError::expected(format!("{context}: {}", describe_reqwest_error(e)))
}

/// Return an empty gallery until Harbr has an independent template registry.
#[ship_command]
#[tracing::instrument]
pub async fn fetch_community_templates(
    _search: Option<String>,
    _category: Option<String>,
    _sort: Option<String>,
    _pricing: Option<String>,
    _limit: Option<u32>,
    _offset: Option<u32>,
) -> Result<String, CommandError> {
    Ok(r#"{"templates":[]}"#.to_string())
}

/// Download a template zip from a signed URL to a temporary file.
/// Returns the path to the downloaded file.
#[ship_command]
#[tracing::instrument]
pub async fn download_template_zip(url: String) -> Result<String, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| network_failure("Failed to download template", &e))?;

    if !response.status().is_success() {
        return Err((format!("Download failed with status {}", response.status())).into());
    }

    // A truncated/interrupted download is a network condition too, and the
    // actionable detail lives in the source chain, not the top-level message
    // (issue #749).
    let bytes = response
        .bytes()
        .await
        .map_err(|e| network_failure("Failed to read download", &e))?;

    let tmp_dir = std::env::temp_dir().join("shipstudio-templates");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let file_name = format!("{}.zip", uuid::Uuid::new_v4());
    let file_path = tmp_dir.join(&file_name);

    std::fs::write(&file_path, &bytes).map_err(|e| format!("Failed to write template zip: {e}"))?;

    file_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| CommandError::Other {
            message: "Invalid temp file path".to_string(),
        })
}
