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
    Deployment, DeploymentDetail, DeploymentPhase, DeploymentUrls, Environment, HostingLink,
    HostingProjectChoice, Lookup,
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

/// Map Vercel's `readyState` onto the shared lifecycle.
///
/// `alias_assigned` distinguishes "built" from "actually serving": a READY
/// deployment whose aliases haven't been attached yet is still finishing, and
/// calling it live would be premature.
fn phase_from_ready_state(raw: &str, alias_assigned: bool) -> DeploymentPhase {
    match raw.to_ascii_uppercase().as_str() {
        "QUEUED" => DeploymentPhase::Queued,
        "INITIALIZING" => DeploymentPhase::Queued,
        "BUILDING" => DeploymentPhase::Building,
        "READY" if !alias_assigned => DeploymentPhase::Publishing,
        "READY" => DeploymentPhase::Ready,
        "ERROR" => DeploymentPhase::Failed,
        "CANCELED" | "CANCELLED" => DeploymentPhase::Canceled,
        // Documented on the list endpoint but not the detail one, and not a
        // state a user's own push produces. Surfaced honestly rather than
        // guessed at.
        other => DeploymentPhase::Unknown {
            raw: other.to_string(),
        },
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
    // `aliasAssigned` is authoritative where the endpoint sends it (the list);
    // on the detail response the presence of aliases says the same thing.
    let alias_assigned = raw
        .alias_assigned
        .as_ref()
        .map(AliasAssigned::is_assigned)
        .unwrap_or(!raw.alias.is_empty());
    let ready_state = raw
        .ready_state
        .as_deref()
        .or(raw.state.as_deref())
        .unwrap_or("");

    let phase = phase_from_ready_state(ready_state, alias_assigned);
    let detail = if matches!(phase, DeploymentPhase::Ready) {
        detail_from_substate(raw.ready_substate.as_deref())
    } else {
        None
    };

    let aliases: Vec<String> = raw.alias.iter().map(|a| with_scheme(a)).collect();
    let deployment_url = raw.url.as_deref().map(with_scheme);
    let primary = aliases.first().cloned().or_else(|| deployment_url.clone());

    let environment = match raw.target.as_deref() {
        Some("production") => Environment::Production,
        _ => Environment::Preview,
    };

    Deployment {
        id: raw.uid,
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
        return Ok(Lookup::Found { deployment: found });
    }

    Ok(Lookup::NotFound {
        latest_on_branch: latest_for_branch(link, token, branch)
            .await
            .ok()
            .flatten()
            .map(Box::new),
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
        assert_eq!(
            phase_from_ready_state("QUEUED", true),
            DeploymentPhase::Queued
        );
        assert_eq!(
            phase_from_ready_state("INITIALIZING", true),
            DeploymentPhase::Queued
        );
        assert_eq!(
            phase_from_ready_state("BUILDING", true),
            DeploymentPhase::Building
        );
        assert_eq!(
            phase_from_ready_state("READY", true),
            DeploymentPhase::Ready
        );
        assert_eq!(
            phase_from_ready_state("ERROR", true),
            DeploymentPhase::Failed
        );
        assert_eq!(
            phase_from_ready_state("CANCELED", true),
            DeploymentPhase::Canceled
        );
    }

    #[test]
    fn a_ready_deployment_without_aliases_is_still_finishing() {
        assert_eq!(
            phase_from_ready_state("READY", false),
            DeploymentPhase::Publishing
        );
    }

    #[test]
    fn an_unrecognized_state_is_surfaced_not_guessed() {
        // The failure mode this prevents: a new provider state silently
        // rendering as success or failure.
        let phase = phase_from_ready_state("SOME_NEW_STATE", true);
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
    fn the_list_endpoint_is_live_but_has_no_urls_to_offer_yet() {
        // It reports `aliasAssigned` but sends no aliases, so the phase is
        // trustworthy while the links still require the detail call.
        let list: RawList = serde_json::from_str(list_fixture()).unwrap();
        let d = to_deployment(list.deployments.into_iter().next().unwrap());
        assert_eq!(d.phase, DeploymentPhase::Ready);
        assert!(d.urls.aliases.is_empty());
    }

    #[test]
    fn a_built_deployment_whose_aliases_are_not_attached_is_still_finishing() {
        // `aliasAssigned: false` is the difference between "built" and
        // "serving"; calling it live here would be premature.
        let body = r#"{"deployments":[{
            "uid":"dpl_2","url":"two.vercel.app","readyState":"READY",
            "aliasAssigned":false,"target":"production","createdAt":2,
            "meta":{"githubCommitSha":"def","githubCommitRef":"main"}
        }]}"#;
        let list: RawList = serde_json::from_str(body).unwrap();
        let d = to_deployment(list.deployments.into_iter().next().unwrap());
        assert_eq!(d.phase, DeploymentPhase::Publishing);
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
        assert_eq!(d.urls.aliases.len(), 2);
        assert_eq!(
            d.urls.primary.as_deref(),
            Some("https://acme-saas-tau.vercel.app")
        );
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
