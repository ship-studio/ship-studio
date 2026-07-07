//! # Vercel domain lookup
//!
//! Reads the production custom domain for a project so the UI can show the real
//! site address (e.g. `pop.bimbi.co`) instead of nothing. Ship Studio publishes
//! through Vercel's GitHub integration and never knew the deployed domain.
//!
//! Projects deployed that way usually have **no** local `.vercel/project.json`
//! (nobody ran `vercel link`), and they often live under a Vercel **team**
//! rather than the personal scope — so we can't rely on a project id on disk.
//! Instead we match the Vercel project by its linked **GitHub repo**
//! (`owner/name`), searching the personal scope and every team to find the
//! project id, then read its production domains and pick the **canonical** one
//! (the domain Vercel does not redirect away from — every other custom host on
//! the project redirects to it).
//!
//! Auth: the app authenticates Vercel through the `vercel` CLI, so we reuse the
//! token that CLI already stored on disk. The token stays in the backend — it is
//! never logged, never returned to the frontend, and only sent to api.vercel.com.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const VERCEL_API: &str = "https://api.vercel.com";
const VERCEL_TIMEOUT_SECS: u64 = 15;

/// The production domains Vercel knows about for a project.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct VercelDomainInfo {
    /// The canonical production custom domain (e.g. "pop.bimbi.co"), if one exists.
    pub custom_domain: Option<String>,
    /// The system `*.vercel.app` URL Vercel returned, used as a fallback display.
    pub system_url: Option<String>,
}

#[derive(Deserialize)]
struct ProjectLink {
    org: Option<String>,
    repo: Option<String>,
}

#[derive(Deserialize)]
struct VercelProject {
    id: String,
    link: Option<ProjectLink>,
}

#[derive(Deserialize)]
struct ProjectsResponse {
    projects: Vec<VercelProject>,
}

#[derive(Deserialize)]
struct Team {
    id: String,
}

#[derive(Deserialize)]
struct TeamsResponse {
    teams: Vec<Team>,
}

/// One entry from `GET /v9/projects/{id}/domains`.
#[derive(Deserialize, Debug)]
struct DomainEntry {
    name: String,
    #[serde(rename = "apexName")]
    apex_name: Option<String>,
    #[serde(default)]
    verified: bool,
    /// When set, this host redirects to another — so it is NOT the canonical domain.
    #[serde(default)]
    redirect: Option<String>,
}

#[derive(Deserialize)]
struct DomainsResponse {
    domains: Vec<DomainEntry>,
}

fn is_system_domain(d: &DomainEntry) -> bool {
    d.apex_name.as_deref() == Some("vercel.app") || d.name.ends_with(".vercel.app")
}

/// Pick the canonical production custom domain (and the system `*.vercel.app`
/// fallback). Pure filtering — never constructs a host.
///
/// The canonical domain is one Vercel does NOT redirect (`redirect == null`):
/// for src-mx, `src.mx`/`src.org.mx`/... all redirect to `www.src.org.mx`, which
/// is the only non-redirect host and therefore the real site address. Among
/// non-redirect custom domains, prefer a verified one, then the apex
/// (name == apexName), then a `www.` host, then the first Vercel listed.
fn select_production_domain(domains: &[DomainEntry]) -> VercelDomainInfo {
    let system_url = domains
        .iter()
        .find(|d| is_system_domain(d))
        .map(|d| d.name.clone());

    let pick = |verified_only: bool| -> Option<String> {
        let mut pool: Vec<&DomainEntry> = domains
            .iter()
            .filter(|d| {
                !is_system_domain(d) && d.redirect.is_none() && (!verified_only || d.verified)
            })
            .collect();
        pool.sort_by_key(|d| {
            if d.apex_name.as_deref() == Some(d.name.as_str()) {
                0
            } else if d.name.starts_with("www.") {
                1
            } else {
                2
            }
        });
        pool.first().map(|d| d.name.clone())
    };

    VercelDomainInfo {
        custom_domain: pick(true).or_else(|| pick(false)),
        system_url,
    }
}

async fn read_vercel_token() -> Option<String> {
    let path = dirs::data_dir()?.join("com.vercel.cli").join("auth.json");
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
}

/// GET a Vercel API path and parse JSON. Returns `None` on timeout, transport
/// error, non-2xx, or parse failure — the domain lookup is best-effort.
async fn get_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Option<T> {
    let req = client.get(url).bearer_auth(token).send();
    let resp = tokio::time::timeout(Duration::from_secs(VERCEL_TIMEOUT_SECS), req)
        .await
        .ok()?
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<T>().await.ok()
}

/// Find the id of the project linked to `owner/repo` in one scope (personal when
/// `team_id` is `None`).
async fn find_project_id(
    client: &reqwest::Client,
    token: &str,
    team_id: Option<&str>,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let mut url = format!("{VERCEL_API}/v9/projects?limit=100");
    if let Some(team) = team_id {
        url.push_str("&teamId=");
        url.push_str(team);
    }
    let list: ProjectsResponse = get_json(client, &url, token).await?;
    list.projects.into_iter().find_map(|p| {
        let link = p.link?;
        if link.org.as_deref() == Some(owner) && link.repo.as_deref() == Some(repo) {
            Some(p.id)
        } else {
            None
        }
    })
}

/// Fetch the production custom domain for a project, matched by its GitHub repo.
///
/// `github_repo` is the `owner/name` Ship Studio already resolved from the git
/// remote. Returns `Ok(None)` (never an error) when there's no repo, the Vercel
/// CLI isn't authenticated, no Vercel project is linked to that repo, or there's
/// no domain to report — so callers show the affordance only when a real value
/// exists. Never constructs a host.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, repo = ?github_repo))]
pub async fn get_vercel_production_domain(
    project_path: String,
    github_repo: Option<String>,
) -> Result<Option<VercelDomainInfo>, CommandError> {
    let _ = validate_project_path(&project_path)?;

    let Some(repo) = github_repo.filter(|r| !r.trim().is_empty()) else {
        return Ok(None);
    };
    let Some((owner, name)) = repo.split_once('/') else {
        return Ok(None);
    };
    let name = name.trim_end_matches(".git");

    let Some(token) = read_vercel_token().await else {
        return Ok(None); // Vercel CLI not authenticated
    };

    let client = reqwest::Client::new();

    // Find the project + the scope (team) it lives in: personal first, then teams.
    let mut found: Option<(String, Option<String>)> =
        find_project_id(&client, &token, None, owner, name)
            .await
            .map(|id| (id, None));
    if found.is_none() {
        let teams_url = format!("{VERCEL_API}/v2/teams?limit=100");
        if let Some(teams) = get_json::<TeamsResponse>(&client, &teams_url, &token).await {
            for team in teams.teams {
                if let Some(id) =
                    find_project_id(&client, &token, Some(&team.id), owner, name).await
                {
                    found = Some((id, Some(team.id)));
                    break;
                }
            }
        }
    }

    let Some((project_id, team_id)) = found else {
        return Ok(None); // no Vercel project linked to this repo in any scope
    };

    // Fetch the project's production domains (with redirect/verified metadata) in
    // the same scope, and pick the canonical one.
    let mut url =
        format!("{VERCEL_API}/v9/projects/{project_id}/domains?production=true&limit=100");
    if let Some(team) = team_id.as_deref() {
        url.push_str("&teamId=");
        url.push_str(team);
    }
    let Some(data) = get_json::<DomainsResponse>(&client, &url, &token).await else {
        return Ok(None);
    };

    let info = select_production_domain(&data.domains);
    if info.custom_domain.is_none() && info.system_url.is_none() {
        return Ok(None);
    }
    Ok(Some(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, apex: &str, verified: bool, redirect: Option<&str>) -> DomainEntry {
        DomainEntry {
            name: name.to_string(),
            apex_name: Some(apex.to_string()),
            verified,
            redirect: redirect.map(|s| s.to_string()),
        }
    }

    #[test]
    fn picks_verified_custom_domain_over_system() {
        // Real `pop` /domains shape.
        let domains = vec![
            entry("pop.bimbi.co", "bimbi.co", true, None),
            entry("pop-sandy-five.vercel.app", "vercel.app", true, None),
        ];
        let info = select_production_domain(&domains);
        assert_eq!(info.custom_domain.as_deref(), Some("pop.bimbi.co"));
        assert_eq!(
            info.system_url.as_deref(),
            Some("pop-sandy-five.vercel.app")
        );
    }

    #[test]
    fn picks_the_non_redirect_canonical_among_many() {
        // Real `src-mx` /domains shape: only www.src.org.mx has redirect: null.
        let domains = vec![
            entry(
                "statisticalresearch.org",
                "statisticalresearch.org",
                true,
                Some("www.src.org.mx"),
            ),
            entry(
                "www.statisticalresearch.org",
                "statisticalresearch.org",
                true,
                Some("www.src.org.mx"),
            ),
            entry("src.org.mx", "src.org.mx", true, Some("www.src.org.mx")),
            entry("www.src.org.mx", "src.org.mx", true, None),
            entry("src.mx", "src.mx", true, Some("www.src.org.mx")),
            entry("www.src.mx", "src.mx", true, Some("www.src.org.mx")),
            entry("src-mx.vercel.app", "vercel.app", true, None),
        ];
        let info = select_production_domain(&domains);
        assert_eq!(info.custom_domain.as_deref(), Some("www.src.org.mx"));
        assert_eq!(info.system_url.as_deref(), Some("src-mx.vercel.app"));
    }

    #[test]
    fn no_custom_domain_falls_back_to_system() {
        let domains = vec![entry(
            "creatormatch-v2.vercel.app",
            "vercel.app",
            true,
            None,
        )];
        let info = select_production_domain(&domains);
        assert_eq!(info.custom_domain, None);
        assert_eq!(
            info.system_url.as_deref(),
            Some("creatormatch-v2.vercel.app")
        );
    }

    #[test]
    fn prefers_apex_over_www_when_both_are_canonical() {
        let domains = vec![
            entry("www.example.com", "example.com", true, None),
            entry("example.com", "example.com", true, None),
        ];
        let info = select_production_domain(&domains);
        assert_eq!(info.custom_domain.as_deref(), Some("example.com"));
    }

    #[test]
    fn uses_unverified_only_when_no_verified_canonical_exists() {
        let domains = vec![entry("pending.example.com", "example.com", false, None)];
        let info = select_production_domain(&domains);
        assert_eq!(info.custom_domain.as_deref(), Some("pending.example.com"));
    }

    #[test]
    fn empty_yields_nothing() {
        assert_eq!(select_production_domain(&[]), VercelDomainInfo::default());
    }
}
