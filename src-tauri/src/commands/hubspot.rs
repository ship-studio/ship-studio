//! # HubSpot CMS Integration Commands
//!
//! Detection of the HubSpot CLI (`hs`) and per-project theme destination
//! configuration for HubSpot CMS theme projects. The preview server
//! (`hs cms theme preview`) itself is spawned by the frontend through the
//! standard custom-command PTY path; these commands only answer "is the CLI
//! here?", "is it signed in?", and "which Design Tools path?".

use crate::commands::claude::find_validated_binary;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{AgentCliStatus, ProjectMetadata};
use crate::utils::{create_command, validate_project_path};

/// Version probes should be near-instant; a hung CLI must not stall the
/// preview-pane setup gate.
const HUBSPOT_DETECT_TIMEOUT_SECS: u64 = 10;

/// `hs account list` reads local config only, but leave headroom for slow
/// disks and node startup.
const HUBSPOT_AUTH_TIMEOUT_SECS: u64 = 10;

/// Check whether the HubSpot CLI is installed and report its version.
///
/// Uses the same validated-binary probe as the agent CLIs so a broken install
/// (e.g. an npm wrapper missing its native dep) doesn't read as "installed".
#[tauri::command]
#[tracing::instrument]
pub async fn check_hubspot_cli_status() -> AgentCliStatus {
    let Some(path) = find_validated_binary("hs", "--version") else {
        return AgentCliStatus {
            installed: false,
            version: None,
        };
    };

    let mut cmd = create_command(&path);
    cmd.arg("--version");
    let tokio_cmd = tokio::process::Command::from(cmd);
    let version = run_with_timeout(
        tokio_cmd,
        "hs --version".to_string(),
        HUBSPOT_DETECT_TIMEOUT_SECS,
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

/// Check whether the HubSpot CLI has a configured (signed-in) account.
///
/// `hs account list` prints a "Account: <name> [<type>] (<id>)" line for the
/// default account when config exists, and fails or prints nothing useful when
/// the CLI has never been authenticated. False on any failure — the setup gate
/// offers a retry, so a transient miss is recoverable.
#[tauri::command]
#[tracing::instrument]
pub async fn check_hubspot_auth_status() -> bool {
    let Some(path) = find_validated_binary("hs", "--version") else {
        return false;
    };

    let mut cmd = create_command(&path);
    cmd.args(["account", "list"]);
    let tokio_cmd = tokio::process::Command::from(cmd);
    run_with_timeout(
        tokio_cmd,
        "hs account list".to_string(),
        HUBSPOT_AUTH_TIMEOUT_SECS,
    )
    .await
    .ok()
    .map(|output| {
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("Account:")
    })
    .unwrap_or(false)
}

/// The destination ends up as an argument to
/// `hs cms theme preview --dest <x>`. The PTY spawn passes args as an array
/// (no shell), but the frontend splits the command string on whitespace — so
/// reject anything that isn't a plain Design Tools path to keep the command
/// unambiguous.
fn validate_theme_dest(dest: &str) -> Result<(), CommandError> {
    if dest.is_empty() {
        return Err(("Theme path cannot be empty".to_string()).into());
    }
    if dest.starts_with('-') {
        return Err((format!("Invalid theme path '{dest}': cannot start with '-'")).into());
    }
    if dest.contains("..") {
        return Err((format!("Invalid theme path '{dest}': '..' is not allowed")).into());
    }
    if !dest
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'/')
    {
        return Err((format!(
            "Invalid theme path '{dest}': only letters, digits, '-', '_', '.' and '/' are allowed"
        ))
        .into());
    }
    Ok(())
}

/// Kill any `hs cms theme preview` processes left over from previous runs.
/// A stuck instance (blocked on an interactive prompt) never binds its port,
/// so the port-based orphan reaper can't see it. Called before every preview
/// spawn. Mirrors `kill_stale_theme_dev` for Shopify.
#[tauri::command]
#[tracing::instrument]
pub async fn kill_stale_hubspot_preview() -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        let _ = create_command("pkill")
            .args(["-f", "hs cms theme preview"])
            .output();
    }
    Ok(())
}

/// The project-relative directory holding the theme (`"."` or a direct child
/// like `rti-2026`), or None when no theme markers are found. The frontend
/// passes this to `hs cms theme preview --src` so nested themes preview
/// correctly.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_hubspot_theme_src(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(crate::commands::projects::find_hubspot_theme_src_dir(
        &project,
    ))
}

/// Gets the configured Design Tools destination path for a HubSpot CMS theme
/// project, or None if the user hasn't set one (the frontend then defaults to
/// the project folder name).
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_hubspot_dest(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default();

    Ok(metadata.hubspot_dest)
}

/// Sets (or clears, with None) the Design Tools destination path for a
/// HubSpot CMS theme project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_hubspot_dest(
    project_path: String,
    dest: Option<String>,
) -> Result<(), CommandError> {
    if let Some(ref d) = dest {
        validate_theme_dest(d)?;
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

    metadata.hubspot_dest = dest;

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
    fn theme_dest_accepts_plain_paths() {
        assert!(validate_theme_dest("my-theme").is_ok());
        assert!(validate_theme_dest("themes/marketing-site").is_ok());
        assert!(validate_theme_dest("theme_2.0").is_ok());
    }

    #[test]
    fn theme_dest_rejects_empty_and_unsafe_input() {
        assert!(validate_theme_dest("").is_err());
        // Whitespace would smuggle extra args into the preview command string.
        assert!(validate_theme_dest("theme --clean").is_err());
        assert!(validate_theme_dest("-rf").is_err());
        assert!(validate_theme_dest("../escape").is_err());
        assert!(validate_theme_dest("theme;rm").is_err());
    }
}
