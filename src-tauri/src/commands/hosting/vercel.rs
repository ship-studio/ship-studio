//! Vercel adapter.
//!
//! Everything here talks to `api.vercel.com` directly. The previous
//! implementation scraped `vercel ls`, and its entire commit history is a log
//! of that table changing shape underneath it.
//!
//! Two verified facts shape this file (see
//! `docs/internal/hosting-provider-matrix.md`):
//!
//! * `?sha=` really is a server-side filter — a real SHA returns its
//!   deployment, a bogus one returns nothing.
//! * The list endpoint carries **no** aliases. Resolving a commit to the URLs a
//!   human can open needs a second call to `/v13/deployments/{uid}`, so this
//!   adapter only pays for it once a deployment is actually live.
//!
//! Git metadata lives on `meta.github*`. `gitSource` was absent from a real
//! response even with `withGitRepoInfo=true`, so nothing here depends on it.

use super::http::{get_json, HostingHttpError};
use super::model::{
    BuildLog, Deployment, DeploymentDetail, DeploymentPhase, DeploymentUrls, Environment,
    HostingLink, HostingProjectChoice, LogLine, LogStream, Lookup,
};
use serde::Deserialize;

const API: &str = "https://api.vercel.com";

// --------------------------------------------------------------------------
// Raw response shapes. Deliberately permissive: every field the UI doesn't
// strictly need is optional, so a missing one degrades a single line of copy
// instead of failing the whole lookup.
// --------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RawList {
    #[serde(default)]
    deployments: Vec<RawDeployment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDeployment {
    uid: String,
    #[serde(default)]
    url: Option<String>,
    /// Present on both the list and detail endpoints; `state` is the older
    /// alias and is accepted as a fallback.
    #[serde(default)]
    ready_state: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    ready_substate: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    ready: Option<u64>,
    #[serde(default)]
    inspector_url: Option<String>,
    /// Only ever populated on the detail endpoint — the list endpoint returns
    /// no aliases at all.
    #[serde(default)]
    alias: Vec<String>,
    /// The list endpoint's answer to "are the aliases attached yet", which is
    /// the only way to tell "built" from "serving" without the detail call.
    ///
    /// Its type is not stable: a live response returned the epoch-millisecond
    /// timestamp of the assignment (`1787594676951`) where the docs imply a
    /// boolean. Both are accepted, and anything else is treated as "unknown"
    /// rather than failing the whole lookup over one field.
    #[serde(default)]
    alias_assigned: Option<AliasAssigned>,
    #[serde(default)]
    meta: RawMeta,
}

/// `aliasAssigned` arrives as either a flag or the timestamp at which the
/// aliases were attached. A timestamp means they are attached.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AliasAssigned {
    Flag(bool),
    At(u64),
}

impl AliasAssigned {
    fn is_assigned(&self) -> bool {
        match self {
            AliasAssigned::Flag(v) => *v,
            AliasAssigned::At(ts) => *ts > 0,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMeta {
    #[serde(default)]
    github_commit_sha: Option<String>,
    #[serde(default)]
    github_commit_ref: Option<String>,
    #[serde(default)]
    github_commit_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProjectList {
    #[serde(default)]
    projects: Vec<RawProject>,
}

#[derive(Debug, Deserialize)]
struct RawProject {
    id: String,
    name: String,
}

/// A domain attached to the project. `git_branch` marks a branch-specific
/// alias; `redirect` marks one that only forwards elsewhere. Neither is the
/// site's address.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDomain {
    name: String,
    #[serde(default)]
    verified: Option<bool>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    redirect: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawDomainList {
    #[serde(default)]
    domains: Vec<RawDomain>,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    user: Option<RawUserInner>,
}

#[derive(Debug, Deserialize)]
struct RawUserInner {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

// --------------------------------------------------------------------------
// Reducers
// --------------------------------------------------------------------------

/// Map Vercel's `readyState` onto the shared lifecycle used for behaviour.
///
/// Only for deciding what to poll and which colour the dot is — the words the
/// user reads come from `status_label`, which is Vercel's own.
fn phase_from_ready_state(raw: &str) -> DeploymentPhase {
    match raw.to_ascii_uppercase().as_str() {
        "QUEUED" | "INITIALIZING" => DeploymentPhase::Queued,
        "BUILDING" => DeploymentPhase::Building,
        "READY" => DeploymentPhase::Ready,
        "ERROR" => DeploymentPhase::Failed,
        "CANCELED" | "CANCELLED" => DeploymentPhase::Canceled,
        other => DeploymentPhase::Unknown {
            raw: other.to_string(),
        },
    }
}

/// Vercel's status word, as Vercel writes it: `READY` becomes "Ready".
///
/// Not translated into a synonym. The dashboard says "Ready" and so does this,
/// so there is no vocabulary to reconcile when someone looks at both.
fn status_label(raw: &str) -> String {
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => "Unknown".to_string(),
    }
}

/// Vercel's production-traffic cutover, translated out of its own vocabulary.
/// `PROMOTED` is the normal end state and needs no qualifier.
fn detail_from_substate(substate: Option<&str>) -> Option<DeploymentDetail> {
    match substate?.to_ascii_uppercase().as_str() {
        "STAGED" => Some(DeploymentDetail::NotYetPromoted),
        "ROLLING" => Some(DeploymentDetail::RollingOut),
        _ => None,
    }
}

/// Prefix a bare host with a scheme. Vercel returns `url` without one; this is
/// formatting a value the API gave us, not inventing an address.
fn with_scheme(host: &str) -> String {
    if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{host}")
    }
}

/// Convert a raw deployment into the shared shape.
///
/// Every URL here originates in the response. Nothing is assembled from a
/// naming pattern — the plugin's constructed preview URLs 404 whenever a name
/// pushes the alias past Vercel's 63-character limit.
fn to_deployment(raw: RawDeployment) -> Deployment {
    let ready_state = raw
        .ready_state
        .as_deref()
        .or(raw.state.as_deref())
        .unwrap_or("");

    let phase = phase_from_ready_state(ready_state);
    let detail = if matches!(phase, DeploymentPhase::Ready) {
        detail_from_substate(raw.ready_substate.as_deref())
    } else {
        None
    };

    let aliases: Vec<String> = raw.alias.iter().map(|a| with_scheme(a)).collect();
    let deployment_url = raw.url.as_deref().map(with_scheme);
    // `site` is filled in by the caller from the project's domains — it is not
    // on this record. Until then the build permalink is the only thing we can
    // honestly offer.
    let primary = deployment_url.clone();

    let environment = match raw.target.as_deref() {
        Some("production") => Environment::Production,
        _ => Environment::Preview,
    };

    Deployment {
        id: raw.uid,
        status_label: status_label(ready_state),
        phase,
        detail,
        environment,
        branch: raw.meta.github_commit_ref.clone(),
        commit_sha: raw.meta.github_commit_sha.clone().unwrap_or_default(),
        commit_message: raw
            .meta
            .github_commit_message
            .clone()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        urls: DeploymentUrls {
            site: None,
            deployment: deployment_url,
            aliases,
            primary,
        },
        dashboard_url: raw.inspector_url.clone(),
        error_message: None,
        created_at: raw.created_at.unwrap_or(0),
        ready_at: raw.ready,
    }
}

// --------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------

fn scope_query(link: &HostingLink) -> String {
    link.scope_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|team| format!("&teamId={team}"))
        .unwrap_or_default()
}

/// Find the deployment for an exact commit.
///
/// The `sha=` filter is server-side, so the common case is one cheap call. When
/// it finds nothing we make a second, wider request to offer "latest on this
/// branch" as context — never as the answer to the question that was asked.
pub async fn find_for_commit(
    link: &HostingLink,
    token: &str,
    sha: &str,
    branch: &str,
) -> Result<Lookup, HostingHttpError> {
    let scope = scope_query(link);
    let url = format!(
        "{API}/v6/deployments?projectId={project}{scope}&sha={sha}&limit=5",
        project = link.project_id,
    );

    let list: RawList = get_json(&url, token).await?;

    // Newest first, preferring production when a commit produced both a
    // preview and a production deployment.
    let mut candidates: Vec<Deployment> = list.deployments.into_iter().map(to_deployment).collect();
    candidates.sort_by(|a, b| {
        let a_prod = a.environment == Environment::Production;
        let b_prod = b.environment == Environment::Production;
        b_prod.cmp(&a_prod).then(b.created_at.cmp(&a.created_at))
    });

    // The site's address is a project property on a separate endpoint, so it
    // is fetched once here and attached to whatever deployment we return.
    let site = fetch_site_url(link, token).await.ok().flatten();

    if let Some(mut found) = candidates.into_iter().next() {
        // Only worth a second call once it is live: that is the only moment
        // aliases exist and the only moment the user wants a link to click.
        if matches!(
            found.phase,
            DeploymentPhase::Ready | DeploymentPhase::Publishing
        ) {
            if let Ok(detailed) = fetch_detail(link, token, &found.id).await {
                found = detailed;
            }
        }

        // A failed build is the one case where the deployments API alone sends
        // the user to the provider's dashboard: it reports the failure without
        // the reason. One extra call, only on failure, buys the reason.
        if matches!(found.phase, DeploymentPhase::Failed) && found.error_message.is_none() {
            if let Ok(log) = fetch_logs(link, token, &found.id).await {
                found.error_message = log.likely_error();
            }
        }

        found.urls.site = site.clone();
        found.urls.primary = primary_for(&found, site.clone());

        return Ok(Lookup::Found { deployment: found });
    }

    let mut latest = latest_for_branch(link, token, branch).await.ok().flatten();
    if let Some(deployment) = latest.as_mut() {
        deployment.urls.site = site.clone();
        deployment.urls.primary = primary_for(deployment, site.clone());
    }

    Ok(Lookup::NotFound {
        latest_on_branch: latest.map(Box::new),
    })
}

/// Fetch one deployment's full record — the only source of aliases.
async fn fetch_detail(
    link: &HostingLink,
    token: &str,
    uid: &str,
) -> Result<Deployment, HostingHttpError> {
    let scope = scope_query(link);
    let scope = scope
        .strip_prefix('&')
        .map(|s| format!("?{s}"))
        .unwrap_or_default();
    let url = format!("{API}/v13/deployments/{uid}{scope}");
    let raw: RawDeployment = get_json(&url, token).await?;
    Ok(to_deployment(raw))
}

/// The most recent deployment on a branch, used only as context for a commit we
/// could not find.
pub async fn latest_for_branch(
    link: &HostingLink,
    token: &str,
    branch: &str,
) -> Result<Option<Deployment>, HostingHttpError> {
    let scope = scope_query(link);
    let url = format!(
        "{API}/v6/deployments?projectId={project}{scope}&limit=20",
        project = link.project_id,
    );
    let list: RawList = get_json(&url, token).await?;

    let mut on_branch: Vec<Deployment> = list
        .deployments
        .into_iter()
        .map(to_deployment)
        .filter(|d| d.branch.as_deref() == Some(branch))
        .collect();
    on_branch.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(on_branch.into_iter().next())
}

/// Projects the token can see, for the link picker.
pub async fn list_projects(
    token: &str,
    scope_id: Option<&str>,
) -> Result<Vec<HostingProjectChoice>, HostingHttpError> {
    let scope = scope_id
        .filter(|s| !s.is_empty())
        .map(|t| format!("&teamId={t}"))
        .unwrap_or_default();
    let url = format!("{API}/v9/projects?limit=100{scope}");
    let list: RawProjectList = get_json(&url, token).await?;
    Ok(list
        .projects
        .into_iter()
        .map(|p| HostingProjectChoice {
            id: p.id,
            name: p.name,
            scope_id: scope_id.map(str::to_string),
            scope_name: None,
        })
        .collect())
}

/// The one address a single "open" should go to.
///
/// A preview deployment never reached production, so sending someone to the
/// production domain from a feature branch would open a page that does not
/// contain the change they just pushed.
fn primary_for(deployment: &Deployment, site: Option<String>) -> Option<String> {
    match deployment.environment {
        Environment::Preview => deployment.urls.deployment.clone(),
        Environment::Production => site.or_else(|| deployment.urls.deployment.clone()),
    }
}

/// The address people visit.
///
/// A custom domain wins over the generated `*.vercel.app` when there is one —
/// it is what the owner would say the site's address is. Unverified domains
/// are skipped: Vercel will list a domain the moment it is added, long before
/// DNS resolves, and offering a link that does not load is worse than offering
/// the one that does.
fn pick_site_domain(domains: Vec<RawDomain>) -> Option<String> {
    let usable: Vec<RawDomain> = domains
        .into_iter()
        .filter(|d| d.verified.unwrap_or(false) && d.git_branch.is_none() && d.redirect.is_none())
        .collect();

    let custom = usable
        .iter()
        .find(|d| !d.name.ends_with(".vercel.app"))
        .map(|d| d.name.clone());

    custom.or_else(|| usable.first().map(|d| d.name.clone()))
}

/// The project's production domain, which is not on the deployment record.
pub async fn fetch_site_url(
    link: &HostingLink,
    token: &str,
) -> Result<Option<String>, HostingHttpError> {
    let scope = scope_query(link);
    let url = format!(
        "{API}/v9/projects/{project}/domains?limit=50{scope}",
        project = link.project_id,
    );
    let list: RawDomainList = get_json(&url, token).await?;
    Ok(pick_site_domain(list.domains).map(|d| with_scheme(&d)))
}

/// One line of build output as Vercel sends it.
#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(default)]
    created: Option<u64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
}

/// Vercel caps a single events response; beyond this we tell the user the log
/// is partial rather than pretending it is complete.
const LOG_LIMIT: usize = 1000;

/// Fetch a deployment's build output.
///
/// This is the endpoint that makes the provider dashboard unnecessary: the
/// deployments API says a build failed, but only the event stream says why.
pub async fn fetch_logs(
    link: &HostingLink,
    token: &str,
    deployment_id: &str,
) -> Result<BuildLog, HostingHttpError> {
    let scope = scope_query(link);
    let scope = scope
        .strip_prefix('&')
        .map(|s| format!("&{s}"))
        .unwrap_or_default();
    let url = format!("{API}/v3/deployments/{deployment_id}/events?limit={LOG_LIMIT}{scope}");

    let raw: Vec<RawEvent> = get_json(&url, token).await?;
    let truncated = raw.len() >= LOG_LIMIT;

    let lines = raw
        .into_iter()
        .filter_map(|e| {
            let text = e.text?;
            let trimmed = text.trim_end();
            if trimmed.is_empty() {
                return None;
            }
            Some(LogLine {
                at: e.created.unwrap_or(0),
                stream: match e.kind.as_deref() {
                    Some("stderr") => LogStream::Stderr,
                    _ => LogStream::Stdout,
                },
                text: trimmed.to_string(),
            })
        })
        .collect();

    Ok(BuildLog {
        deployment_id: deployment_id.to_string(),
        lines,
        truncated,
    })
}

/// The most recent deployments on this project, newest first.
pub async fn list_recent(
    link: &HostingLink,
    token: &str,
    limit: u32,
) -> Result<Vec<Deployment>, HostingHttpError> {
    let scope = scope_query(link);
    let url = format!(
        "{API}/v6/deployments?projectId={project}{scope}&limit={limit}",
        project = link.project_id,
    );
    let list: RawList = get_json(&url, token).await?;
    let mut out: Vec<Deployment> = list.deployments.into_iter().map(to_deployment).collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Confirm a token works and say who it belongs to.
pub async fn verify_token(token: &str) -> Result<Option<String>, HostingHttpError> {
    let raw: RawUser = get_json(&format!("{API}/v2/user"), token).await?;
    Ok(raw.user.and_then(|u| u.username.or(u.email)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_state_maps_onto_the_shared_lifecycle() {
        assert_eq!(phase_from_ready_state("QUEUED"), DeploymentPhase::Queued);
        assert_eq!(
            phase_from_ready_state("INITIALIZING"),
            DeploymentPhase::Queued
        );
        assert_eq!(
            phase_from_ready_state("BUILDING"),
            DeploymentPhase::Building
        );
        assert_eq!(phase_from_ready_state("READY"), DeploymentPhase::Ready);
        assert_eq!(phase_from_ready_state("ERROR"), DeploymentPhase::Failed);
        assert_eq!(
            phase_from_ready_state("CANCELED"),
            DeploymentPhase::Canceled
        );
    }

    #[test]
    fn the_status_word_is_vercels_own() {
        // "Ready" is what the dashboard says, so it is what this says. The
        // previous mapping invented "Live" and a "Publishing" state Vercel
        // does not have, leaving two vocabularies to reconcile.
        assert_eq!(status_label("READY"), "Ready");
        assert_eq!(status_label("BUILDING"), "Building");
        assert_eq!(status_label("ERROR"), "Error");
        assert_eq!(status_label("CANCELED"), "Canceled");
        assert_eq!(status_label("QUEUED"), "Queued");
        assert_eq!(status_label(""), "Unknown");
    }

    #[test]
    fn an_unrecognized_state_is_surfaced_not_guessed() {
        // The failure mode this prevents: a new provider state silently
        // rendering as success or failure.
        let phase = phase_from_ready_state("SOME_NEW_STATE");
        assert_eq!(
            phase,
            DeploymentPhase::Unknown {
                raw: "SOME_NEW_STATE".into()
            }
        );
    }

    #[test]
    fn substate_is_translated_out_of_vercel_vocabulary() {
        assert_eq!(
            detail_from_substate(Some("STAGED")),
            Some(DeploymentDetail::NotYetPromoted)
        );
        assert_eq!(
            detail_from_substate(Some("ROLLING")),
            Some(DeploymentDetail::RollingOut)
        );
        // The normal end state needs no qualifier.
        assert_eq!(detail_from_substate(Some("PROMOTED")), None);
        assert_eq!(detail_from_substate(None), None);
    }

    /// Shaped from a real `/v6/deployments` response.
    fn list_fixture() -> &'static str {
        r#"{"deployments":[{
            "uid":"dpl_74f2kUYmdRRBKxirrb3bAdQdVHnx",
            "url":"acme-saas-fi9rttan8-native-073e1cec.vercel.app",
            "state":"READY","readyState":"READY","readySubstate":"PROMOTED",
            "target":"production","createdAt":1757100000000,"ready":1757100060000,
            "aliasAssigned":true,
            "inspectorUrl":"https://vercel.com/native/acme-saas/74f2kUYm",
            "meta":{
                "githubCommitSha":"a0728a0c6f1976dee739b994e8d2108993ecf6b1",
                "githubCommitRef":"main",
                "githubCommitMessage":"Update from Ship Studio"
            }
        }]}"#
    }

    #[test]
    fn list_response_parses_into_the_shared_shape() {
        let list: RawList = serde_json::from_str(list_fixture()).unwrap();
        let d = to_deployment(list.deployments.into_iter().next().unwrap());

        assert_eq!(d.commit_sha, "a0728a0c6f1976dee739b994e8d2108993ecf6b1");
        assert_eq!(d.branch.as_deref(), Some("main"));
        assert_eq!(d.commit_message.as_deref(), Some("Update from Ship Studio"));
        assert_eq!(d.environment, Environment::Production);
        assert_eq!(
            d.dashboard_url.as_deref(),
            Some("https://vercel.com/native/acme-saas/74f2kUYm")
        );
    }

    #[test]
    fn the_list_endpoint_is_ready_but_has_no_urls_to_offer_yet() {
        // The status is trustworthy from the list; the addresses still need
        // the detail call, because the list carries no aliases at all.
        let list: RawList = serde_json::from_str(list_fixture()).unwrap();
        let d = to_deployment(list.deployments.into_iter().next().unwrap());
        assert_eq!(d.phase, DeploymentPhase::Ready);
        assert!(d.urls.aliases.is_empty());
    }

    #[test]
    fn detail_response_supplies_the_urls_and_marks_it_live() {
        let detail = r#"{
            "uid":"dpl_74f2kUYmdRRBKxirrb3bAdQdVHnx",
            "url":"acme-saas-fi9rttan8-native-073e1cec.vercel.app",
            "readyState":"READY","readySubstate":"PROMOTED","target":"production",
            "createdAt":1757100000000,
            "alias":["acme-saas-tau.vercel.app","acme-saas-native-073e1cec.vercel.app"],
            "meta":{"githubCommitSha":"a0728a0c","githubCommitRef":"main"}
        }"#;
        let raw: RawDeployment = serde_json::from_str(detail).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.phase, DeploymentPhase::Ready);
        assert_eq!(d.status_label, "Ready");
        assert_eq!(d.urls.aliases.len(), 2);
        // A deployment record alone can only offer its own permalink; the
        // site's address is attached by the caller from the project's domains.
        assert_eq!(
            d.urls.primary.as_deref(),
            Some("https://acme-saas-fi9rttan8-native-073e1cec.vercel.app")
        );
        assert_eq!(d.urls.site, None);
    }

    #[test]
    fn the_site_address_is_the_project_domain_not_a_build_permalink() {
        // The bug this pins: every deployment's `url` is a per-build permalink
        // carrying a generated hash and the account name. It is not the site,
        // it is unrecognisable, and it does not fit anywhere. The address
        // people visit lives on the project's domains endpoint.
        let domains = vec![
            RawDomain {
                name: "pepper-cayenne-accessories.vercel.app".into(),
                verified: Some(true),
                git_branch: None,
                redirect: None,
            },
            RawDomain {
                name: "preview.example.com".into(),
                verified: Some(true),
                git_branch: Some("dev".into()),
                redirect: None,
            },
        ];
        assert_eq!(
            pick_site_domain(domains).as_deref(),
            Some("pepper-cayenne-accessories.vercel.app"),
            "a branch-specific alias is not the site's address"
        );
    }

    /// The success path must attach the site address, not just the not-found
    /// path. It silently did not for one build: the domain was fetched and
    /// then dropped, so a live deployment showed only its build permalink.
    #[test]
    fn the_found_path_attaches_the_site_address() {
        let source = include_str!("vercel.rs");
        let found_branch = source
            .split("if let Some(mut found) = candidates.into_iter().next() {")
            .nth(1)
            .expect("find_for_commit still has a found branch");
        let body = found_branch
            .split("return Ok(Lookup::Found")
            .next()
            .expect("the found branch still returns");

        assert!(
            body.contains("found.urls.site = site"),
            "a found deployment must carry the site address, or the section \
             shows only an unrecognisable per-build permalink"
        );
    }

    #[test]
    fn a_custom_domain_beats_the_generated_one() {
        let domains = vec![
            RawDomain {
                name: "acme-saas.vercel.app".into(),
                verified: Some(true),
                git_branch: None,
                redirect: None,
            },
            RawDomain {
                name: "peppercayenne.com".into(),
                verified: Some(true),
                git_branch: None,
                redirect: None,
            },
        ];
        assert_eq!(
            pick_site_domain(domains).as_deref(),
            Some("peppercayenne.com"),
            "the owner would call the custom domain the site's address"
        );
    }

    #[test]
    fn an_unverified_or_redirecting_domain_is_never_offered() {
        // Vercel lists a domain the moment it is added, long before DNS
        // resolves. Linking to one that does not load is worse than linking to
        // the generated address that does.
        let domains = vec![
            RawDomain {
                name: "not-live-yet.com".into(),
                verified: Some(false),
                git_branch: None,
                redirect: None,
            },
            RawDomain {
                name: "old-domain.com".into(),
                verified: Some(true),
                git_branch: None,
                redirect: Some("https://new.com".into()),
            },
        ];
        assert_eq!(pick_site_domain(domains), None);
        assert_eq!(pick_site_domain(Vec::new()), None);
    }

    #[test]
    fn alias_assigned_accepts_the_timestamp_form_vercel_actually_sends() {
        // A live response returned the epoch-millisecond assignment time where
        // the docs imply a boolean, which failed the whole lookup.
        let body = r#"{"deployments":[{
            "uid":"dpl_3","url":"x.vercel.app","readyState":"READY",
            "aliasAssigned":1787594676951,"target":"production","createdAt":3,
            "meta":{"githubCommitSha":"abc","githubCommitRef":"main"}
        }]}"#;
        let list: RawList = serde_json::from_str(body).unwrap();
        let d = to_deployment(list.deployments.into_iter().next().unwrap());
        assert_eq!(d.phase, DeploymentPhase::Ready);
    }

    #[test]
    fn every_url_we_emit_came_from_the_response() {
        // The guard against reintroducing constructed URLs.
        let body = r#"{
            "uid":"dpl_1","url":"one.vercel.app","readyState":"READY","target":"production",
            "createdAt":1,"alias":["two.vercel.app"],
            "meta":{"githubCommitSha":"abc","githubCommitRef":"feature/long-branch-name"}
        }"#;
        let raw: RawDeployment = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        for url in d
            .urls
            .aliases
            .iter()
            .chain(d.urls.deployment.iter())
            .chain(d.urls.primary.iter())
        {
            let host = url.trim_start_matches("https://");
            assert!(
                body.contains(host),
                "{url} was assembled rather than read from the response"
            );
        }
    }

    #[test]
    fn a_deployment_with_no_git_metadata_still_parses() {
        // Manual `vercel --prod` deploys carry no commit info.
        let body = r#"{"uid":"dpl_x","readyState":"READY","createdAt":1,"meta":{}}"#;
        let raw: RawDeployment = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);
        assert_eq!(d.commit_sha, "");
        assert_eq!(d.branch, None);
        assert_eq!(d.environment, Environment::Preview);
    }

    #[test]
    fn scope_query_is_omitted_entirely_for_a_personal_account() {
        let link = HostingLink {
            provider: super::super::model::HostingProvider::Vercel,
            project_id: "prj_1".into(),
            scope_id: None,
            project_name: None,
            source: super::super::model::LinkSource::VercelCliFile,
            linked_at: 0,
        };
        assert_eq!(scope_query(&link), "");

        let team = HostingLink {
            scope_id: Some("team_1".into()),
            ..link
        };
        assert_eq!(scope_query(&team), "&teamId=team_1");
    }
}
