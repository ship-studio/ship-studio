//! # Template Gallery Commands
//!
//! Fetches community templates from the Ship Studio API and downloads template zips.

use crate::errors::CommandError;

const TEMPLATES_API_URL: &str = "https://www.ship.studio/api/v1/templates";

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
/// A timeout or a dropped connection talking to ship.studio is the user's
/// network (or our API being briefly unreachable), not an app malfunction —
/// `Expected` keeps it out of telemetry while still carrying the underlying
/// cause for the UI to show (issue #754).
fn network_failure(context: &str, e: &reqwest::Error) -> CommandError {
    CommandError::expected(format!("{context}: {}", describe_reqwest_error(e)))
}

/// Classify a non-success status from a template zip download.
///
/// `zip_url` is a signed link that expires (the gallery re-fetches every 50
/// minutes to stay ahead of the one-hour expiry, but a laptop asleep past that
/// still holds a stale one), so a 4xx is a stale/refused link and a 5xx is the
/// storage host being unavailable — neither is an app malfunction, and both
/// were reaching telemetry as `Other` (issue #1036), unlike every sibling
/// failure in this file.
fn download_status_error(status: reqwest::StatusCode) -> CommandError {
    if status.is_client_error() {
        CommandError::expected(format!(
            "the download link was refused (server returned {status}) — it may have \
             expired, and reopening New Project fetches a fresh one"
        ))
    } else {
        CommandError::expected(format!(
            "the template download is unavailable right now (server returned {status})"
        ))
    }
}

/// Fetch community templates from the Ship Studio API.
/// Accepts optional query parameters that map to the API spec.
/// Returns the raw JSON string so the frontend can parse it.
#[tauri::command]
#[tracing::instrument]
pub async fn fetch_community_templates(
    search: Option<String>,
    category: Option<String>,
    sort: Option<String>,
    pricing: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<String, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut url =
        reqwest::Url::parse(TEMPLATES_API_URL).map_err(|e| format!("Invalid URL: {e}"))?;

    {
        let mut params = url.query_pairs_mut();
        if let Some(s) = &search {
            if !s.is_empty() {
                params.append_pair("search", s);
            }
        }
        if let Some(c) = &category {
            params.append_pair("category", c);
        }
        if let Some(s) = &sort {
            params.append_pair("sort", s);
        }
        if let Some(p) = &pricing {
            params.append_pair("pricing", p);
        }
        if let Some(l) = limit {
            params.append_pair("limit", &l.to_string());
        }
        if let Some(o) = offset {
            params.append_pair("offset", &o.to_string());
        }
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| network_failure("Failed to fetch templates", &e))?;

    if !response.status().is_success() {
        return Err(CommandError::expected(format!(
            "The template gallery is unavailable right now (server returned {}). Try again in a moment.",
            response.status()
        )));
    }

    response
        .text()
        .await
        .map_err(|e| network_failure("Failed to read templates response", &e))
}

/// Download a template zip from a signed URL to a temporary file.
/// Returns the path to the downloaded file.
#[tauri::command]
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
        return Err(download_status_error(response.status()));
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

#[cfg(test)]
mod tests {
    use super::download_status_error;
    use crate::errors::CommandError;

    /// Issue #1036: a refused/expired signed download link is Expected, not
    /// an auto-reported `Other`.
    #[test]
    fn download_status_errors_are_expected() {
        let refused = download_status_error(reqwest::StatusCode::BAD_REQUEST);
        assert!(
            matches!(refused, CommandError::Expected { .. }),
            "got: {refused:?}"
        );
        assert!(
            refused.to_string().contains("400 Bad Request"),
            "got: {refused}"
        );
        assert!(
            refused.to_string().contains("may have expired"),
            "got: {refused}"
        );

        let down = download_status_error(reqwest::StatusCode::BAD_GATEWAY);
        assert!(
            matches!(down, CommandError::Expected { .. }),
            "got: {down:?}"
        );
        assert!(down.to_string().contains("502"), "got: {down}");
    }
}
