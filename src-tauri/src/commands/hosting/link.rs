//! Which provider project a repo deploys to, and where that fact lives.
//!
//! Two sources:
//!
//! * The provider CLI's own link file, when there is one. Reading `.vercel/`
//!   and `.netlify/` rather than keeping a private copy means the app and the
//!   user's CLI can never drift apart — link with the CLI and the app follows.
//! * Our own `.shipstudio/project.json`, for links the user picked in the app.
//!   Cloudflare Pages leaves nothing on disk, so that is the only record of a
//!   Cloudflare link.

use super::model::{DetectedLink, HostingLink, HostingMetadata, HostingProvider, LinkSource};
use crate::errors::CommandError;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct VercelProjectJson {
    #[serde(rename = "projectId")]
    project_id: Option<String>,
    #[serde(rename = "orgId")]
    org_id: Option<String>,
    #[serde(rename = "projectName")]
    project_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NetlifyStateJson {
    #[serde(rename = "siteId")]
    site_id: Option<String>,
}

/// Links discoverable from files the provider CLIs wrote. Cheap, offline, and
/// the reason a project someone linked with `vercel link` needs no setup here.
pub fn detect_local_links(project: &Path) -> Vec<DetectedLink> {
    let mut found = Vec::new();

    if let Ok(raw) = std::fs::read_to_string(project.join(".vercel/project.json")) {
        if let Ok(parsed) = serde_json::from_str::<VercelProjectJson>(&raw) {
            if let Some(project_id) = parsed.project_id.filter(|s| !s.is_empty()) {
                found.push(DetectedLink {
                    provider: HostingProvider::Vercel,
                    project_id,
                    scope_id: parsed.org_id.filter(|s| !s.is_empty()),
                    project_name: parsed.project_name.filter(|s| !s.is_empty()),
                    source: LinkSource::VercelCliFile,
                });
            }
        }
    }

    if let Ok(raw) = std::fs::read_to_string(project.join(".netlify/state.json")) {
        if let Ok(parsed) = serde_json::from_str::<NetlifyStateJson>(&raw) {
            if let Some(site_id) = parsed.site_id.filter(|s| !s.is_empty()) {
                found.push(DetectedLink {
                    provider: HostingProvider::Netlify,
                    project_id: site_id,
                    scope_id: None,
                    project_name: None,
                    source: LinkSource::NetlifyCliFile,
                });
            }
        }
    }

    found
}

/// Read the hosting block we persist.
pub fn read_metadata(project: &Path) -> HostingMetadata {
    crate::commands::projects::read_project_metadata_sync(project)
        .ok()
        .flatten()
        .and_then(|m| m.hosting)
        .unwrap_or_default()
}

/// Persist the hosting block, leaving every other field of the metadata file
/// untouched.
pub fn write_metadata(project: &Path, hosting: HostingMetadata) -> Result<(), CommandError> {
    // The read error propagates rather than being swallowed. `.ok().flatten()`
    // turned "this file is corrupt or unreadable" into "there is no metadata",
    // and the save below then wrote a *default* file over it — so connecting a
    // host to a project whose metadata had been damaged would silently discard
    // its pins, dev-server config and session state. `None` here still means
    // genuinely absent, which is the only case that may safely default.
    let mut metadata =
        crate::commands::projects::read_project_metadata_sync(project)?.unwrap_or_default();
    metadata.hosting = Some(hosting);
    crate::commands::projects::save_project_metadata(project, &metadata)
}

/// The links to actually query: everything the user has confirmed, plus any
/// CLI-file link for a provider they haven't explicitly linked.
///
/// The CLI file wins on content for a provider it covers, because it is what
/// the provider itself will act on — a stale saved id would otherwise keep
/// reporting a project the repo no longer deploys to.
pub fn effective_links(project: &Path) -> Vec<HostingLink> {
    let saved = read_metadata(project).links;
    let detected = detect_local_links(project);

    let mut links: Vec<HostingLink> = Vec::new();

    for link in &saved {
        match detected.iter().find(|d| d.provider == link.provider) {
            // The CLI relinked this project elsewhere; follow it.
            Some(d) if d.project_id != link.project_id => links.push(HostingLink {
                provider: d.provider,
                project_id: d.project_id.clone(),
                scope_id: d.scope_id.clone(),
                project_name: d.project_name.clone(),
                source: d.source,
                linked_at: link.linked_at,
            }),
            _ => links.push(link.clone()),
        }
    }

    for d in detected {
        if !links.iter().any(|l| l.provider == d.provider) {
            links.push(HostingLink {
                provider: d.provider,
                project_id: d.project_id,
                scope_id: d.scope_id,
                project_name: d.project_name,
                source: d.source,
                linked_at: 0,
            });
        }
    }

    links
}

/// Links found on disk that aren't saved yet, so the UI can offer one-click
/// setup instead of a picker.
pub fn unconfirmed_links(project: &Path) -> Vec<DetectedLink> {
    let saved = read_metadata(project).links;
    detect_local_links(project)
        .into_iter()
        .filter(|d| !saved.iter().any(|l| l.provider == d.provider))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, contents: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn reads_a_vercel_cli_link() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".vercel/project.json",
            r#"{"projectId":"prj_1","orgId":"team_1","projectName":"acme"}"#,
        );

        let found = detect_local_links(dir.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].provider, HostingProvider::Vercel);
        assert_eq!(found[0].project_id, "prj_1");
        assert_eq!(found[0].scope_id.as_deref(), Some("team_1"));
        assert_eq!(found[0].source, LinkSource::VercelCliFile);
    }

    #[test]
    fn reads_a_netlify_cli_link() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".netlify/state.json",
            r#"{"siteId":"2077e54f-aa34-4517-9fdf-36c2391e08ca"}"#,
        );

        let found = detect_local_links(dir.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].provider, HostingProvider::Netlify);
        assert_eq!(found[0].project_id, "2077e54f-aa34-4517-9fdf-36c2391e08ca");
    }

    #[test]
    fn a_missing_or_corrupt_link_file_yields_nothing_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect_local_links(dir.path()).is_empty());

        write(dir.path(), ".vercel/project.json", "not json at all");
        assert!(detect_local_links(dir.path()).is_empty());

        write(dir.path(), ".vercel/project.json", r#"{"orgId":"team_1"}"#);
        assert!(
            detect_local_links(dir.path()).is_empty(),
            "a link with no project id is not a link"
        );

        write(dir.path(), ".vercel/project.json", r#"{"projectId":""}"#);
        assert!(detect_local_links(dir.path()).is_empty());
    }

    #[test]
    fn detects_both_providers_independently() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".vercel/project.json",
            r#"{"projectId":"prj_1"}"#,
        );
        write(dir.path(), ".netlify/state.json", r#"{"siteId":"site_1"}"#);

        let found = detect_local_links(dir.path());
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn cloudflare_is_never_detected_from_disk() {
        // Pages projects leave no local marker, which is why they must be
        // picked explicitly. Nothing here should ever invent one.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "wrangler.toml", "name = \"my-pages-project\"\n");
        assert!(detect_local_links(dir.path())
            .iter()
            .all(|l| l.provider != HostingProvider::Cloudflare));
    }
}
