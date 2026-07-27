//! # WordPress Integration Commands
//!
//! Per-project configuration for WordPress theme projects.
//!
//! Unlike Shopify and HubSpot, WordPress has no vendor CLI that renders a
//! local theme against remote content, so there is no dev server to spawn.
//! The preview instead reverse-proxies the project's live site (see
//! `proxy::start_preview_proxy`'s remote-host mode), which means the pane
//! shows *deployed* content — local theme edits are not reflected.
//!
//! These commands only answer "which site does this project preview?".

use crate::errors::CommandError;
use crate::types::{ProjectMetadata, WordpressSsh};
use crate::utils::validate_project_path;

/// Validate a site origin: `https://host` or `http://host`, no path, no
/// credentials, no whitespace. The value is interpolated into the proxy's
/// upstream connection and `Host` header, so it must not carry surprises.
fn validate_site_url(url: &str) -> Result<(), CommandError> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| CommandError::Validation {
            field: "site_url".to_string(),
            reason: "must start with https:// or http://".to_string(),
        })?;

    if rest.is_empty() {
        return Err(CommandError::Validation {
            field: "site_url".to_string(),
            reason: "is missing a hostname".to_string(),
        });
    }
    if rest.contains('/') {
        return Err(CommandError::Validation {
            field: "site_url".to_string(),
            reason: "must be just the domain, with no path (e.g. https://example.com)".to_string(),
        });
    }
    if rest.contains('@') {
        return Err(CommandError::Validation {
            field: "site_url".to_string(),
            reason: "must not contain credentials".to_string(),
        });
    }
    // Hostname, optionally :port. Keep the charset tight — this string reaches
    // a TCP connect, a TLS SNI name and an HTTP header value.
    let host = rest.split(':').next().unwrap_or(rest);
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err(CommandError::Validation {
            field: "site_url".to_string(),
            reason: format!("\"{host}\" is not a valid hostname"),
        });
    }
    if let Some(port) = rest.split(':').nth(1) {
        if port.parse::<u16>().is_err() {
            return Err(CommandError::Validation {
                field: "site_url".to_string(),
                reason: format!("\"{port}\" is not a valid port"),
            });
        }
    }
    Ok(())
}

fn read_metadata(metadata_path: &std::path::Path) -> ProjectMetadata {
    std::fs::read_to_string(metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<ProjectMetadata>(&contents).ok())
        .unwrap_or_default()
}

/// Gets the live site this WordPress project previews, or None if the user
/// hasn't connected one yet.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_wordpress_site_url(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    Ok(read_metadata(&metadata_path).wordpress_site_url)
}

/// Sets (or clears, with None) the live site a WordPress project previews.
/// Expects a bare origin like `https://example.com` — the frontend normalizes
/// user input (trims, adds the scheme, strips the path) before calling.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_wordpress_site_url(
    project_path: String,
    site_url: Option<String>,
) -> Result<(), CommandError> {
    if let Some(ref url) = site_url {
        validate_site_url(url)?;
    }

    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        read_metadata(&metadata_path)
    } else {
        ProjectMetadata::default()
    };

    metadata.wordpress_site_url = site_url;

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

/// Probe a candidate WordPress site before saving it, so the setup gate can
/// say "that host didn't respond" instead of handing the user a blank preview.
///
/// Sends a browser-like `User-Agent`: the origin may sit behind a CDN with bot
/// protection (WP Engine fronts sites with Cloudflare) that challenges default
/// client agents. Returns the final status code, or None if the host was
/// unreachable.
#[tauri::command]
#[tracing::instrument]
pub async fn probe_wordpress_site(site_url: String) -> Option<u16> {
    validate_site_url(&site_url).ok()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .build()
        .ok()?;

    client
        .get(&site_url)
        .send()
        .await
        .ok()
        .map(|resp| resp.status().as_u16())
}

/// Derive a full WP Engine connection from an install name.
///
/// WP Engine names everything after the install, so one input yields the SSH
/// host, user, WordPress path and public URL:
/// `myinstall` → `myinstall@myinstall.ssh.wpengine.net`,
/// `--path=/sites/myinstall`, `https://myinstall.wpenginepowered.com`.
#[tauri::command]
#[tracing::instrument]
pub fn derive_wpengine_config(install: String) -> Result<WordpressConnection, CommandError> {
    let install = install.trim().to_ascii_lowercase();
    if install.is_empty()
        || !install
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(CommandError::Validation {
            field: "install".to_string(),
            reason: "WP Engine install names are letters, numbers and hyphens".to_string(),
        });
    }
    Ok(WordpressConnection {
        site_url: format!("https://{install}.wpenginepowered.com"),
        ssh: WordpressSsh {
            host: Some(format!("{install}.ssh.wpengine.net")),
            user: Some(install.clone()),
            key_path: Some(format!("~/.ssh/{install}_wpengine")),
            wp_path: Some(format!("/sites/{install}")),
        },
    })
}

/// A complete WordPress connection: what to preview, and how to reach it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WordpressConnection {
    pub site_url: String,
    pub ssh: WordpressSsh,
}

/// Read the stored SSH connection for a project, if one is configured.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_wordpress_ssh(project_path: String) -> Result<Option<WordpressSsh>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");
    if !metadata_path.exists() {
        return Ok(None);
    }
    Ok(read_metadata(&metadata_path).wordpress_ssh)
}

/// Persist (or clear) the SSH connection for a project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_wordpress_ssh(
    project_path: String,
    ssh: Option<WordpressSsh>,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        read_metadata(&metadata_path)
    } else {
        ProjectMetadata::default()
    };
    metadata.wordpress_ssh = ssh;
    write_metadata(&shipstudio_dir, &metadata_path, &metadata)
}

/// Mark a project as WordPress before any theme files exist, so a
/// freshly-created project opens into the WordPress setup flow instead of
/// detecting as `unknown` and showing no preview at all.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_wordpress_pending(
    project_path: String,
    pending: bool,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let shipstudio_dir = project.join(".shipstudio");
    let metadata_path = shipstudio_dir.join("project.json");

    let mut metadata = if metadata_path.exists() {
        read_metadata(&metadata_path)
    } else {
        ProjectMetadata::default()
    };
    metadata.wordpress_pending = if pending { Some(true) } else { None };
    write_metadata(&shipstudio_dir, &metadata_path, &metadata)
}

/// Drop the `wordpress_pending` marker once the project carries real
/// WordPress files, so detection stands on its own evidence.
///
/// The marker must NOT be cleared merely because a site was connected: a
/// project that previews a live site legitimately has no WordPress files of
/// its own, and clearing it there would make the project detect as `unknown`
/// and lose its preview entirely.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn reconcile_wordpress_pending(project_path: String) -> Result<bool, CommandError> {
    let project = validate_project_path(&project_path)?;
    let metadata_path = project.join(".shipstudio").join("project.json");
    if !metadata_path.exists() {
        return Ok(false);
    }
    let mut metadata = read_metadata(&metadata_path);
    if metadata.wordpress_pending != Some(true) {
        return Ok(false);
    }
    // Real files = a theme, or a full install.
    let has_files = crate::commands::projects::detection::is_wordpress_project(&project)
        || find_wordpress_install(&project).is_some();
    if !has_files {
        return Ok(false);
    }
    metadata.wordpress_pending = None;
    write_metadata(&project.join(".shipstudio"), &metadata_path, &metadata)?;
    Ok(true)
}

fn write_metadata(
    shipstudio_dir: &std::path::Path,
    metadata_path: &std::path::Path,
    metadata: &ProjectMetadata,
) -> Result<(), CommandError> {
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }
    let contents = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize project metadata: {e}"))?;
    std::fs::write(metadata_path, contents)
        .map_err(|e| format!("Failed to write project metadata: {e}"))?;
    Ok(())
}

/// Find a WordPress *install* (core files, not just a theme) inside the
/// project — the project root or a direct child such as `wp/`.
///
/// This is what proves a locally-provisioned site exists. The setup flow can't
/// rely on the site answering over HTTP, because Ship Studio is the thing that
/// serves it and it won't do that until a site is connected: probing first
/// would deadlock. Files on disk break the cycle.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn detect_local_wordpress(project_path: String) -> Result<Option<String>, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(find_wordpress_install(&project))
}

/// Core files (`wp-config.php` + `wp-includes/`) mark a WordPress install, as
/// opposed to a theme-only project. Checks the root and each direct child.
fn find_wordpress_install(project: &std::path::Path) -> Option<String> {
    let is_install = |dir: &std::path::Path| {
        dir.join("wp-config.php").exists() && dir.join("wp-includes").is_dir()
    };
    if is_install(project) {
        return Some(".".to_string());
    }
    let entries = std::fs::read_dir(project).ok()?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| !n.starts_with('.') && n != "node_modules")
        .collect();
    names.sort();
    names.into_iter().find(|n| is_install(&project.join(n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_origins() {
        assert!(validate_site_url("https://example.com").is_ok());
        assert!(validate_site_url("http://example.com").is_ok());
        assert!(validate_site_url("https://myinstall.wpenginepowered.com").is_ok());
        assert!(validate_site_url("http://localhost:8888").is_ok());
    }

    #[test]
    fn rejects_paths_and_missing_scheme() {
        assert!(validate_site_url("example.com").is_err());
        assert!(validate_site_url("https://example.com/blog").is_err());
        // A trailing slash is still a path — the frontend strips it first.
        assert!(validate_site_url("https://example.com/").is_err());
        assert!(validate_site_url("https://").is_err());
    }

    #[test]
    fn finds_a_wordpress_install_on_disk() {
        let tmp = std::env::temp_dir().join(format!("ss-wp-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("wp").join("wp-includes")).unwrap();
        std::fs::write(tmp.join("wp").join("wp-config.php"), "<?php").unwrap();
        assert_eq!(find_wordpress_install(&tmp).as_deref(), Some("wp"));

        // An install at the project root, not a subdirectory.
        let root = std::env::temp_dir().join(format!("ss-wp-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("wp-includes")).unwrap();
        std::fs::write(root.join("wp-config.php"), "<?php").unwrap();
        assert_eq!(find_wordpress_install(&root).as_deref(), Some("."));

        // A theme-only project is not an install — core files are the marker.
        let bare = std::env::temp_dir().join(format!("ss-wp-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(find_wordpress_install(&bare), None);

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn pending_marker_only_clears_once_real_files_exist() {
        // The marker is what keeps a live-site project (which legitimately has
        // no WordPress files of its own) detected as WordPress. Clearing it on
        // "site connected" would make such a project detect as `unknown` and
        // silently lose its preview — so presence of files is the only trigger.
        let bare = std::env::temp_dir().join(format!("ss-wp-pend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        assert!(find_wordpress_install(&bare).is_none());
        assert!(!crate::commands::projects::detection::is_wordpress_project(
            &bare
        ));

        // Give it a real install: now detection can stand on its own.
        std::fs::create_dir_all(bare.join("wp").join("wp-includes")).unwrap();
        std::fs::write(bare.join("wp").join("wp-config.php"), "<?php").unwrap();
        assert!(find_wordpress_install(&bare).is_some());

        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn derives_wpengine_connection_from_install_name() {
        // The shape WP Engine uses: every field derives from the install name.
        let c = derive_wpengine_config("myinstall".to_string()).unwrap();
        assert_eq!(c.site_url, "https://myinstall.wpenginepowered.com");
        assert_eq!(
            c.ssh.host.as_deref(),
            Some("myinstall.ssh.wpengine.net")
        );
        assert_eq!(c.ssh.user.as_deref(), Some("myinstall"));
        assert_eq!(c.ssh.wp_path.as_deref(), Some("/sites/myinstall"));
        assert_eq!(
            c.ssh.key_path.as_deref(),
            Some("~/.ssh/myinstall_wpengine")
        );
    }

    #[test]
    fn rejects_bad_install_names() {
        assert!(derive_wpengine_config("".to_string()).is_err());
        assert!(derive_wpengine_config("has space".to_string()).is_err());
        // Command-injection shaped input must never reach an ssh invocation.
        assert!(derive_wpengine_config("a; rm -rf /".to_string()).is_err());
        assert!(derive_wpengine_config("a/../b".to_string()).is_err());
    }

    #[test]
    fn rejects_injection_shaped_input() {
        assert!(validate_site_url("https://user:pass@example.com").is_err());
        assert!(validate_site_url("https://exa mple.com").is_err());
        assert!(validate_site_url("https://example.com:notaport").is_err());
        assert!(validate_site_url("https://example.com\r\nX-Evil: 1").is_err());
    }
}
