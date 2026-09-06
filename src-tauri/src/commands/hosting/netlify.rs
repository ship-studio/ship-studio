//! Netlify adapter.
//!
//! Shapes here were checked against a live site and deploy (see
//! `docs/internal/hosting-provider-matrix.md`), not taken from documentation:
//!
//! * A deploy carries `commit_ref` (the full SHA) but Netlify has **no**
//!   server-side commit filter, so finding one means narrowing by branch and
//!   scanning.
//! * Every address is returned. `links.alias` is the site's, `links.permalink`
//!   is this deploy's, and `deploy_ssl_url` is the branch's. None of them ever
//!   needs assembling — which is what the previous Netlify integration did.
//! * `commit_message` and `title` were both null on a real production deploy,
//!   so neither can be relied on for what was shipped.
//! * Timestamps are ISO-8601 strings here, not epoch milliseconds like Vercel.

use super::http::{get_json, HostingHttpError};
use super::model::{
    iso_to_ms, BuildLog, Deployment, DeploymentDetail, DeploymentPhase, DeploymentUrls,
    Environment, HostingLink, HostingProjectChoice, Lookup,
};
use serde::Deserialize;

const API: &str = "https://api.netlify.com/api/v1";

#[derive(Debug, Deserialize)]
struct RawDeploy {
    id: String,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    commit_ref: Option<String>,
    #[serde(default)]
    commit_message: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    admin_url: Option<String>,
    #[serde(default)]
    ssl_url: Option<String>,
    #[serde(default)]
    deploy_ssl_url: Option<String>,
    #[serde(default)]
    links: RawLinks,
    #[serde(default)]
    error_message: Option<String>,
    /// Absent rather than `false` when a deploy was not skipped.
    #[serde(default)]
    skipped: Option<bool>,
    #[serde(default)]
    skipped_log: Option<String>,
    #[serde(default)]
    pending_review_reason: Option<String>,
    /// True for a CLI or drag-and-drop deploy, which has no commit behind it
    /// and so must never be matched against a pushed SHA.
    #[serde(default)]
    manual_deploy: Option<bool>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawLinks {
    /// This deploy's immutable address.
    #[serde(default)]
    permalink: Option<String>,
    /// The site's address.
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSite {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ssl_url: Option<String>,
    #[serde(default)]
    custom_domain: Option<String>,
    #[serde(default)]
    admin_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// Map Netlify's fifteen-value `state` onto the shared lifecycle.
///
/// Netlify genuinely separates building from uploading and CDN propagation, so
/// unlike Vercel it earns the `Publishing` phase rather than having one
/// invented for it.
fn phase_from_state(raw: &str) -> DeploymentPhase {
    match raw.to_ascii_lowercase().as_str() {
        "new" | "enqueued" | "accepted" => DeploymentPhase::Queued,
        "pending_review" | "rejected" => DeploymentPhase::Gated,
        "building" | "retrying" => DeploymentPhase::Building,
        "uploading" | "uploaded" | "preparing" | "prepared" | "processing" => {
            DeploymentPhase::Publishing
        }
        "ready" | "processed" => DeploymentPhase::Ready,
        "error" => DeploymentPhase::Failed,
        other => DeploymentPhase::Unknown {
            raw: other.to_string(),
        },
    }
}

/// Netlify's own word, capitalised the way its dashboard capitalises it:
/// `pending_review` reads as "Pending review".
fn status_label(raw: &str) -> String {
    let spaced = raw.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Unknown".to_string(),
    }
}

fn detail_from(raw: &RawDeploy, phase: &DeploymentPhase) -> Option<DeploymentDetail> {
    match phase {
        DeploymentPhase::Skipped => Some(DeploymentDetail::SkippedBecause {
            reason: raw.skipped_log.clone(),
        }),
        DeploymentPhase::Gated if raw.state.as_deref() == Some("rejected") => {
            Some(DeploymentDetail::ReviewRejected)
        }
        DeploymentPhase::Gated => Some(DeploymentDetail::AwaitingReview {
            reason: raw.pending_review_reason.clone(),
        }),
        _ => None,
    }
}

fn to_deployment(raw: RawDeploy) -> Deployment {
    let state = raw.state.clone().unwrap_or_default();
    // The boolean wins over the state: a skipped deploy still reports some
    // other word in `state`, and "skipped" is the more useful thing to say.
    let phase = if raw.skipped.unwrap_or(false) {
        DeploymentPhase::Skipped
    } else {
        phase_from_state(&state)
    };
    let detail = detail_from(&raw, &phase);

    let environment = match raw.context.as_deref() {
        Some("production") => Environment::Production,
        _ => Environment::Preview,
    };

    // Every one of these came from the response. Netlify returns the branch
    // address too — the previous integration assembled `branch--site` by hand
    // and got it wrong for any name Netlify slugifies differently.
    let site = raw.links.alias.clone().or_else(|| raw.ssl_url.clone());
    let deployment_url = raw
        .links
        .permalink
        .clone()
        .or_else(|| raw.deploy_ssl_url.clone());

    let mut aliases = Vec::new();
    for candidate in [
        raw.links.branch.clone(),
        raw.deploy_ssl_url.clone(),
        site.clone(),
    ]
    .into_iter()
    .flatten()
    {
        if !aliases.contains(&candidate) {
            aliases.push(candidate);
        }
    }

    let primary = match environment {
        Environment::Preview => deployment_url.clone(),
        Environment::Production => site.clone().or_else(|| deployment_url.clone()),
    };

    Deployment {
        id: raw.id,
        status_label: status_label(&state),
        phase,
        detail,
        environment,
        branch: raw.branch.clone(),
        commit_sha: raw.commit_ref.clone().unwrap_or_default(),
        // Both of these were null on a real production deploy, so the local
        // git subject is the reliable source and this is only a fallback.
        commit_message: raw
            .commit_message
            .clone()
            .or_else(|| raw.title.clone())
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        urls: DeploymentUrls {
            site,
            deployment: deployment_url,
            aliases,
            primary,
        },
        // The site's page on Netlify. Netlify returns no per-deploy admin link,
        // and building one from the id would be assembling a URL.
        dashboard_url: raw.admin_url.clone(),
        error_message: raw
            .error_message
            .clone()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        created_at: iso_to_ms(raw.created_at.as_deref()).unwrap_or(0),
        ready_at: iso_to_ms(raw.published_at.as_deref()),
    }
}

/// Find the deploy for an exact commit.
///
/// Netlify has no commit filter, so this narrows by branch — which it does
/// support — and scans. Manual deploys are excluded: they carry no commit and
/// matching one to a push would be inventing a link that isn't there.
pub async fn find_for_commit(
    link: &HostingLink,
    token: &str,
    sha: &str,
    branch: &str,
) -> Result<Lookup, HostingHttpError> {
    let url = format!(
        "{API}/sites/{site}/deploys?branch={branch}&per_page=30",
        site = link.project_id,
    );
    let raw: Vec<RawDeploy> = get_json(&url, token).await?;

    let mut deploys: Vec<Deployment> = raw
        .into_iter()
        .filter(|d| !d.manual_deploy.unwrap_or(false))
        .map(to_deployment)
        .collect();
    deploys.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    if let Some(found) = deploys.iter().find(|d| d.commit_sha == sha).cloned() {
        return Ok(Lookup::Found { deployment: found });
    }

    Ok(Lookup::NotFound {
        latest_on_branch: deploys.into_iter().next().map(Box::new),
    })
}

/// Recent deploys for the site, newest first.
pub async fn list_recent(
    link: &HostingLink,
    token: &str,
    limit: u32,
) -> Result<Vec<Deployment>, HostingHttpError> {
    let url = format!(
        "{API}/sites/{site}/deploys?per_page={limit}",
        site = link.project_id,
    );
    let raw: Vec<RawDeploy> = get_json(&url, token).await?;
    let mut deploys: Vec<Deployment> = raw.into_iter().map(to_deployment).collect();
    deploys.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(deploys)
}

/// Netlify publishes no build-log endpoint, so there is nothing to fetch.
///
/// A failure still explains itself: `error_message` is on the deploy record
/// and the panel shows it above where the log would be. Returning an empty log
/// rather than an error keeps that panel honest — "Netlify returned no build
/// output" is true, where "couldn't read Netlify's response" would not be.
pub async fn fetch_logs(
    _link: &HostingLink,
    _token: &str,
    deployment_id: &str,
) -> Result<BuildLog, HostingHttpError> {
    Ok(BuildLog {
        deployment_id: deployment_id.to_string(),
        lines: Vec::new(),
        truncated: false,
    })
}

/// Sites this token can see, for the link picker.
pub async fn list_projects(token: &str) -> Result<Vec<HostingProjectChoice>, HostingHttpError> {
    let raw: Vec<RawSite> = get_json(&format!("{API}/sites?per_page=100"), token).await?;
    Ok(raw
        .into_iter()
        .map(|s| HostingProjectChoice {
            name: s.name.clone().unwrap_or_else(|| s.id.clone()),
            id: s.id,
            scope_id: None,
            scope_name: None,
        })
        .collect())
}

/// The site's own address, preferring a custom domain when one is attached.
pub async fn fetch_site_url(
    link: &HostingLink,
    token: &str,
) -> Result<Option<String>, HostingHttpError> {
    let site: RawSite = get_json(
        &format!("{API}/sites/{site}", site = link.project_id),
        token,
    )
    .await?;
    Ok(site
        .custom_domain
        .filter(|d| !d.is_empty())
        .map(|d| format!("https://{d}"))
        .or(site.ssl_url))
}

/// Confirm a token works and say whose it is.
pub async fn verify_token(token: &str) -> Result<Option<String>, HostingHttpError> {
    let user: RawUser = get_json(&format!("{API}/user"), token).await?;
    Ok(user.full_name.or(user.email))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped from a real production deploy.
    fn ready_fixture() -> &'static str {
        r#"{
            "id":"699b3c5b8c460f0cec5a8f5b",
            "state":"ready","context":"production","branch":"main",
            "commit_ref":"222c59fd6dd081cf11dbf40a6779aeb9000be145",
            "commit_message":null,"title":null,
            "admin_url":"https://app.netlify.com/projects/netlify-proj-3",
            "ssl_url":"https://netlify-proj-3.netlify.app",
            "deploy_ssl_url":"https://main--netlify-proj-3.netlify.app",
            "links":{
              "permalink":"https://699b3c5b--netlify-proj-3.netlify.app",
              "alias":"https://netlify-proj-3.netlify.app",
              "branch":null
            },
            "created_at":"2026-02-22T17:26:51.942Z",
            "published_at":"2026-02-22T17:26:57.427Z",
            "manual_deploy":false
        }"#
    }

    #[test]
    fn a_real_deploy_parses_into_the_shared_shape() {
        let raw: RawDeploy = serde_json::from_str(ready_fixture()).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.phase, DeploymentPhase::Ready);
        assert_eq!(d.status_label, "Ready");
        assert_eq!(d.environment, Environment::Production);
        assert_eq!(d.commit_sha, "222c59fd6dd081cf11dbf40a6779aeb9000be145");
        assert_eq!(
            d.urls.site.as_deref(),
            Some("https://netlify-proj-3.netlify.app")
        );
        assert_eq!(
            d.urls.deployment.as_deref(),
            Some("https://699b3c5b--netlify-proj-3.netlify.app")
        );
    }

    #[test]
    fn every_address_came_from_the_response() {
        // The previous integration assembled `branch--site.netlify.app` by
        // hand. Netlify returns it, so there is no reason to.
        let body = ready_fixture();
        let raw: RawDeploy = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        for url in d
            .urls
            .aliases
            .iter()
            .chain(d.urls.site.iter())
            .chain(d.urls.deployment.iter())
        {
            assert!(body.contains(url.as_str()), "{url} was assembled");
        }
    }

    #[test]
    fn the_status_word_is_netlifys_own() {
        assert_eq!(status_label("ready"), "Ready");
        assert_eq!(status_label("building"), "Building");
        assert_eq!(status_label("error"), "Error");
        assert_eq!(status_label("pending_review"), "Pending review");
        assert_eq!(status_label(""), "Unknown");
    }

    #[test]
    fn netlify_earns_the_publishing_phase_vercel_did_not() {
        // Netlify really does separate building from uploading and CDN
        // propagation, and names each one.
        for state in [
            "uploading",
            "uploaded",
            "preparing",
            "prepared",
            "processing",
        ] {
            assert_eq!(
                phase_from_state(state),
                DeploymentPhase::Publishing,
                "{state}"
            );
        }
        assert_eq!(phase_from_state("building"), DeploymentPhase::Building);
        assert_eq!(phase_from_state("ready"), DeploymentPhase::Ready);
        assert_eq!(phase_from_state("error"), DeploymentPhase::Failed);
    }

    #[test]
    fn the_author_trust_gate_is_not_a_failure() {
        assert_eq!(phase_from_state("pending_review"), DeploymentPhase::Gated);
        assert_eq!(phase_from_state("rejected"), DeploymentPhase::Gated);
    }

    #[test]
    fn an_unrecognized_state_is_surfaced_not_guessed() {
        assert_eq!(
            phase_from_state("some_new_state"),
            DeploymentPhase::Unknown {
                raw: "some_new_state".into()
            }
        );
    }

    #[test]
    fn a_skipped_deploy_says_why_when_netlify_says_why() {
        let body = r#"{"id":"d1","state":"ready","skipped":true,
            "skipped_log":"Skipped due to [skip ci] in commit message",
            "created_at":"2026-02-22T17:26:51.942Z"}"#;
        let raw: RawDeploy = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.phase, DeploymentPhase::Skipped);
        assert_eq!(
            d.detail,
            Some(DeploymentDetail::SkippedBecause {
                reason: Some("Skipped due to [skip ci] in commit message".into())
            })
        );
    }

    #[test]
    fn iso_timestamps_become_milliseconds() {
        // Netlify sends ISO-8601 where Vercel sends a number.
        let ms = iso_to_ms(Some("2026-02-22T17:26:51.942Z")).unwrap();
        assert_eq!(ms, 1_771_781_211_000);

        assert_eq!(iso_to_ms(Some("1970-01-01T00:00:00.000Z")), Some(0));
        assert_eq!(iso_to_ms(None), None);
        assert_eq!(iso_to_ms(Some("not a date")), None);
    }

    #[test]
    fn a_manual_deploy_is_never_matched_to_a_push() {
        // A CLI or drag-and-drop deploy has no commit behind it, so reporting
        // one as the result of a push would be inventing a link.
        let body = r#"{"id":"d1","state":"ready","manual_deploy":true,
            "created_at":"2026-02-22T17:26:51.942Z"}"#;
        let raw: RawDeploy = serde_json::from_str(body).unwrap();
        assert!(raw.manual_deploy.unwrap_or(false));
        assert_eq!(to_deployment(raw).commit_sha, "");
    }
}
