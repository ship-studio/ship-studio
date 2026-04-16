//! # Template Gallery Commands
//!
//! Fetches community templates from the Ship Studio API and downloads template zips.

use crate::errors::CommandError;

const TEMPLATES_API_URL: &str = "https://www.ship.studio/api/v1/templates";

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
        .map_err(|e| format!("Failed to fetch templates: {e}"))?;

    if !response.status().is_success() {
        return Err((format!("API returned status {}", response.status())).into());
    }

    response.text().await.map_err(|e| CommandError::Other {
        message: format!("Failed to read response: {e}"),
    })
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
        .map_err(|e| format!("Failed to download template: {e}"))?;

    if !response.status().is_success() {
        return Err((format!("Download failed with status {}", response.status())).into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {e}"))?;

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
