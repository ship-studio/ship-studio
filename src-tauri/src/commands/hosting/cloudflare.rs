//! Cloudflare Pages adapter.
//!
//! **Unverified.** Every other adapter in this module was checked against a
//! live account; this one was written from Cloudflare's API reference with no
//! credentials to observe a real response. The field names and stage values
//! below are documented, not seen. `docs/internal/hosting-provider-matrix.md`
//! lists exactly what remains unconfirmed, and the deserialisation is
//! deliberately permissive so a wrong guess degrades one line of copy rather
//! than failing the lookup.
//!
//! Three things make Cloudflare different from the other two:
//!
//! * **Status is two-dimensional.** There is no flat state string: a
//!   deployment has a `latest_stage` with a `name` (which phase) and a
//!   `status` (how that phase went), and they have to be read together.
//! * **Nothing identifies a Pages project on disk.** Vercel writes
//!   `.vercel/project.json` and Netlify `.netlify/state.json`; Cloudflare
//!   writes nothing, so a link here can only ever come from the user picking
//!   one.
//! * **It has the cleanest skip signal of the three.** `is_skipped` plus a
//!   `skip_reason` enum says plainly that a commit was deliberately not built —
//!   which neither Vercel nor Netlify can fully express.

use super::http::{get_json, HostingHttpError};
use super::model::{
    iso_to_ms, BuildLog, Deployment, DeploymentDetail, DeploymentPhase, DeploymentUrls,
    Environment, HostingLink, HostingProjectChoice, Lookup,
};
use serde::Deserialize;

const API: &str = "https://api.cloudflare.com/client/v4";

/// Cloudflare wraps every response in a result envelope.
#[derive(Debug, Deserialize)]
struct Envelope<T> {
    #[serde(default = "default_true")]
    success: bool,
    result: Option<T>,
}

fn default_true() -> bool {
    true
}

impl<T> Envelope<T> {
    fn into_result(self) -> Result<T, HostingHttpError> {
        match (self.success, self.result) {
            (true, Some(result)) => Ok(result),
            _ => Err(HostingHttpError::Malformed {
                message: "Cloudflare reported the request did not succeed".into(),
            }),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawDeployment {
    id: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    aliases: Option<Vec<String>>,
    #[serde(default)]
    latest_stage: Option<RawStage>,
    #[serde(default)]
    deployment_trigger: Option<RawTrigger>,
    #[serde(default)]
    is_skipped: Option<bool>,
    #[serde(default)]
    skip_reason: Option<String>,
    #[serde(default)]
    created_on: Option<String>,
    #[serde(default)]
    modified_on: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStage {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawTrigger {
    #[serde(default)]
    metadata: Option<RawTriggerMeta>,
}

#[derive(Debug, Deserialize)]
struct RawTriggerMeta {
    #[serde(default)]
    commit_hash: Option<String>,
    #[serde(default)]
    commit_message: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProject {
    name: String,
    #[serde(default)]
    subdomain: Option<String>,
    #[serde(default)]
    domains: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct RawAccount {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

/// Fold Cloudflare's `(stage name, stage status)` pair into one phase.
///
/// Order matters: a failure or cancellation in *any* stage decides the
/// outcome, so status is checked before the stage name. Only once the run is
/// still going does the stage name say how far it got.
fn phase_from_stage(name: &str, status: &str) -> DeploymentPhase {
    match status.to_ascii_lowercase().as_str() {
        "failure" => return DeploymentPhase::Failed,
        "canceled" | "cancelled" => return DeploymentPhase::Canceled,
        _ => {}
    }

    match name.to_ascii_lowercase().as_str() {
        "queued" => DeploymentPhase::Queued,
        "initialize" | "clone_repo" | "build" => DeploymentPhase::Building,
        "deploy" if status.eq_ignore_ascii_case("success") => DeploymentPhase::Ready,
        "deploy" => DeploymentPhase::Publishing,
        other => DeploymentPhase::Unknown {
            raw: other.to_string(),
        },
    }
}

/// Cloudflare's own words for what is happening, joined as its dashboard reads:
/// the stage that is current, and how it went.
fn status_label(name: &str, status: &str) -> String {
    let stage = match name.to_ascii_lowercase().as_str() {
        "queued" => "Queued",
        "initialize" => "Initializing",
        "clone_repo" => "Cloning repository",
        "build" => "Building",
        "deploy" => "Deploying",
        _ => return "Unknown".to_string(),
    };

    match status.to_ascii_lowercase().as_str() {
        "success" if name.eq_ignore_ascii_case("deploy") => "Success".to_string(),
        "failure" => "Failed".to_string(),
        "canceled" | "cancelled" => "Canceled".to_string(),
        _ => stage.to_string(),
    }
}

/// Turn `skip_reason` into something a person would say. Cloudflare's values
/// are snake_case tokens; the ones with an obvious meaning get a sentence and
/// anything unrecognised is passed through rather than dropped.
fn humanize_skip_reason(reason: &str) -> String {
    match reason {
        "commit_message" => "the commit message asked Cloudflare to skip it".into(),
        "preview_deployments_disabled" => "preview deployments are turned off".into(),
        "production_deployments_disabled" => "production deployments are turned off".into(),
        "path_config" => "no files matched this project's path settings".into(),
        "branch_config" => "this branch is excluded by the project's branch settings".into(),
        "pages_to_workers_conversion" => "the project is being converted to Workers".into(),
        other => other.replace('_', " "),
    }
}

fn to_deployment(raw: RawDeployment) -> Deployment {
    let stage = raw.latest_stage.as_ref();
    let stage_name = stage.and_then(|s| s.name.as_deref()).unwrap_or("");
    let stage_status = stage.and_then(|s| s.status.as_deref()).unwrap_or("");

    let skipped = raw.is_skipped.unwrap_or(false);
    let phase = if skipped {
        DeploymentPhase::Skipped
    } else {
        phase_from_stage(stage_name, stage_status)
    };

    let detail = if skipped {
        Some(DeploymentDetail::SkippedBecause {
            reason: raw.skip_reason.as_deref().map(humanize_skip_reason),
        })
    } else {
        None
    };

    let environment = match raw.environment.as_deref() {
        Some("production") => Environment::Production,
        _ => Environment::Preview,
    };

    let aliases = raw.aliases.clone().unwrap_or_default();
    let deployment_url = raw.url.clone();
    // `site` is filled in by the caller from the project's domains; a
    // deployment record does not carry the project's address.
    let primary = match environment {
        Environment::Preview => deployment_url.clone(),
        Environment::Production => aliases.first().cloned().or_else(|| deployment_url.clone()),
    };

    let meta = raw
        .deployment_trigger
        .as_ref()
        .and_then(|t| t.metadata.as_ref());

    Deployment {
        id: raw.id,
        status_label: status_label(stage_name, stage_status),
        phase,
        detail,
        environment,
        branch: meta.and_then(|m| m.branch.clone()),
        commit_sha: meta.and_then(|m| m.commit_hash.clone()).unwrap_or_default(),
        commit_message: meta
            .and_then(|m| m.commit_message.clone())
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
        urls: DeploymentUrls {
            site: None,
            deployment: deployment_url,
            aliases,
            primary,
        },
        // Cloudflare's API returns no link to the dashboard, and assembling one
        // from account and project ids would be inventing an address.
        dashboard_url: None,
        error_message: None,
        created_at: iso_to_ms(raw.created_on.as_deref()).unwrap_or(0),
        ready_at: iso_to_ms(raw.modified_on.as_deref()),
    }
}

fn account_id(link: &HostingLink) -> Result<&str, HostingHttpError> {
    link.scope_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| HostingHttpError::Malformed {
            message: "This Cloudflare link is missing its account id — relink the project.".into(),
        })
}

/// The project's address. Cloudflare returns a `subdomain` (the
/// `*.pages.dev` one) and any custom `domains`; a custom one is what the owner
/// would call the site.
pub async fn fetch_site_url(
    link: &HostingLink,
    token: &str,
) -> Result<Option<String>, HostingHttpError> {
    let account = account_id(link)?;
    let url = format!(
        "{API}/accounts/{account}/pages/projects/{project}",
        project = link.project_id,
    );
    let project: RawProject = get_json::<Envelope<RawProject>>(&url, token)
        .await?
        .into_result()?;

    let custom = project
        .domains
        .unwrap_or_default()
        .into_iter()
        .find(|d| !d.ends_with(".pages.dev"));

    Ok(custom
        .or(project.subdomain)
        .filter(|d| !d.is_empty())
        .map(|d| {
            if d.starts_with("http") {
                d
            } else {
                format!("https://{d}")
            }
        }))
}

/// Find the deployment for an exact commit.
///
/// Cloudflare has no commit filter and no branch filter, so this lists a page
/// of deployments and scans `deployment_trigger.metadata.commit_hash`.
pub async fn find_for_commit(
    link: &HostingLink,
    token: &str,
    sha: &str,
    branch: &str,
) -> Result<Lookup, HostingHttpError> {
    let account = account_id(link)?;
    let url = format!(
        "{API}/accounts/{account}/pages/projects/{project}/deployments?per_page=25",
        project = link.project_id,
    );
    let raw: Vec<RawDeployment> = get_json::<Envelope<Vec<RawDeployment>>>(&url, token)
        .await?
        .into_result()?;

    let mut deployments: Vec<Deployment> = raw.into_iter().map(to_deployment).collect();
    deployments.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let site = fetch_site_url(link, token).await.ok().flatten();

    if let Some(mut found) = deployments.iter().find(|d| d.commit_sha == sha).cloned() {
        found.urls.site = site.clone();
        if found.environment == Environment::Production {
            found.urls.primary = site.or(found.urls.deployment.clone());
        }
        return Ok(Lookup::Found { deployment: found });
    }

    let mut latest = deployments
        .into_iter()
        .find(|d| d.branch.as_deref() == Some(branch));
    if let Some(deployment) = latest.as_mut() {
        deployment.urls.site = site;
    }

    Ok(Lookup::NotFound {
        latest_on_branch: latest.map(Box::new),
    })
}

/// Recent deployments for the project, newest first.
pub async fn list_recent(
    link: &HostingLink,
    token: &str,
    limit: u32,
) -> Result<Vec<Deployment>, HostingHttpError> {
    let account = account_id(link)?;
    let url = format!(
        "{API}/accounts/{account}/pages/projects/{project}/deployments?per_page={limit}",
        project = link.project_id,
    );
    let raw: Vec<RawDeployment> = get_json::<Envelope<Vec<RawDeployment>>>(&url, token)
        .await?
        .into_result()?;

    let mut deployments: Vec<Deployment> = raw.into_iter().map(to_deployment).collect();
    deployments.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(deployments)
}

/// A deployment's build output.
///
/// Cloudflare returns its log as a list of lines with timestamps; the shape of
/// each entry is documented but unobserved, so a missing field degrades to an
/// empty log rather than failing.
#[derive(Debug, Deserialize)]
struct RawLogs {
    #[serde(default)]
    data: Vec<RawLogLine>,
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    includes_container_logs: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RawLogLine {
    #[serde(default)]
    ts: Option<String>,
    #[serde(default)]
    line: Option<String>,
}

pub async fn fetch_logs(
    link: &HostingLink,
    token: &str,
    deployment_id: &str,
) -> Result<BuildLog, HostingHttpError> {
    use super::model::{LogLine, LogStream};

    let account = account_id(link)?;
    let url = format!(
        "{API}/accounts/{account}/pages/projects/{project}/deployments/{deployment_id}/history/logs",
        project = link.project_id,
    );
    let logs: RawLogs = get_json::<Envelope<RawLogs>>(&url, token)
        .await?
        .into_result()?;

    let total = logs.total;
    let lines: Vec<LogLine> = logs
        .data
        .into_iter()
        .filter_map(|entry| {
            let text = entry.line?;
            let trimmed = text.trim_end();
            if trimmed.is_empty() {
                return None;
            }
            Some(LogLine {
                at: iso_to_ms(entry.ts.as_deref()).unwrap_or(0),
                // Cloudflare does not separate the streams, so everything is
                // reported as stdout rather than guessing which lines are
                // errors.
                stream: LogStream::Stdout,
                text: trimmed.to_string(),
            })
        })
        .collect();

    let truncated = total.map(|t| t as usize > lines.len()).unwrap_or(false);
    let _ = logs.includes_container_logs;

    Ok(BuildLog {
        deployment_id: deployment_id.to_string(),
        lines,
        truncated,
    })
}

/// Pages projects this token can see.
///
/// Needs an account id, which is why the token requires Account Settings:Read
/// alongside Pages:Read — with only the latter this returns nothing and the
/// picker looks broken.
pub async fn list_projects(
    token: &str,
    scope_id: Option<&str>,
) -> Result<Vec<HostingProjectChoice>, HostingHttpError> {
    let accounts: Vec<RawAccount> = match scope_id.filter(|s| !s.is_empty()) {
        Some(id) => vec![RawAccount {
            id: id.to_string(),
            name: None,
        }],
        None => get_json::<Envelope<Vec<RawAccount>>>(&format!("{API}/accounts"), token)
            .await?
            .into_result()?,
    };

    let mut choices = Vec::new();
    for account in accounts {
        let url = format!("{API}/accounts/{}/pages/projects", account.id);
        let projects: Vec<RawProject> = get_json::<Envelope<Vec<RawProject>>>(&url, token)
            .await?
            .into_result()?;

        for project in projects {
            choices.push(HostingProjectChoice {
                id: project.name.clone(),
                name: project.name,
                scope_id: Some(account.id.clone()),
                scope_name: account.name.clone(),
            });
        }
    }

    Ok(choices)
}

/// Confirm a token works. Cloudflare's verify endpoint reports the token's own
/// status rather than a user, so there is no name to show.
pub async fn verify_token(token: &str) -> Result<Option<String>, HostingHttpError> {
    #[derive(Debug, Deserialize)]
    struct RawVerify {
        #[serde(default)]
        status: Option<String>,
    }

    let verify: RawVerify =
        get_json::<Envelope<RawVerify>>(&format!("{API}/user/tokens/verify"), token)
            .await?
            .into_result()?;

    match verify.status.as_deref() {
        Some("active") | None => Ok(None),
        Some(other) => Err(HostingHttpError::Malformed {
            message: format!("Cloudflare reports this token is {other}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_in_any_stage_decides_the_outcome() {
        // The stage name says how far it got; the status says whether it is
        // still going. Reading the name first would call a failed build
        // "Building" forever.
        assert_eq!(
            phase_from_stage("build", "failure"),
            DeploymentPhase::Failed
        );
        assert_eq!(
            phase_from_stage("clone_repo", "failure"),
            DeploymentPhase::Failed
        );
        assert_eq!(
            phase_from_stage("deploy", "canceled"),
            DeploymentPhase::Canceled
        );
    }

    #[test]
    fn the_stage_name_says_how_far_a_running_deployment_got() {
        assert_eq!(
            phase_from_stage("queued", "active"),
            DeploymentPhase::Queued
        );
        assert_eq!(
            phase_from_stage("initialize", "active"),
            DeploymentPhase::Building
        );
        assert_eq!(
            phase_from_stage("clone_repo", "active"),
            DeploymentPhase::Building
        );
        assert_eq!(
            phase_from_stage("build", "active"),
            DeploymentPhase::Building
        );
        assert_eq!(
            phase_from_stage("deploy", "active"),
            DeploymentPhase::Publishing
        );
    }

    #[test]
    fn only_a_successful_deploy_stage_is_ready() {
        assert_eq!(
            phase_from_stage("deploy", "success"),
            DeploymentPhase::Ready
        );
        // A successful *build* stage is not a finished deployment.
        assert_eq!(
            phase_from_stage("build", "success"),
            DeploymentPhase::Building
        );
    }

    #[test]
    fn an_unrecognized_stage_is_surfaced_not_guessed() {
        assert_eq!(
            phase_from_stage("some_new_stage", "active"),
            DeploymentPhase::Unknown {
                raw: "some_new_stage".into()
            }
        );
    }

    #[test]
    fn a_skipped_commit_says_why_in_plain_words() {
        // Cloudflare has the clearest skip signal of the three providers, so
        // it is worth spending words on.
        let body = r#"{
            "id":"dep_1","url":"https://abc.my-project.pages.dev",
            "environment":"production","is_skipped":true,
            "skip_reason":"branch_config",
            "latest_stage":{"name":"queued","status":"idle"},
            "created_on":"2026-02-22T17:26:51.942Z"
        }"#;
        let raw: RawDeployment = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.phase, DeploymentPhase::Skipped);
        assert_eq!(
            d.detail,
            Some(DeploymentDetail::SkippedBecause {
                reason: Some("this branch is excluded by the project's branch settings".into())
            })
        );
    }

    #[test]
    fn an_unfamiliar_skip_reason_is_passed_through_rather_than_dropped() {
        assert_eq!(humanize_skip_reason("some_new_reason"), "some new reason");
    }

    #[test]
    fn a_deployment_parses_with_its_commit_and_addresses() {
        let body = r#"{
            "id":"dep_1","url":"https://abc123.my-project.pages.dev",
            "environment":"production",
            "aliases":["https://my-project.pages.dev"],
            "latest_stage":{"name":"deploy","status":"success"},
            "deployment_trigger":{"metadata":{
                "commit_hash":"222c59fd6dd081cf11dbf40a6779aeb9000be145",
                "commit_message":"Update the nav",
                "branch":"main"
            }},
            "created_on":"2026-02-22T17:26:51.942Z",
            "modified_on":"2026-02-22T17:27:51.942Z"
        }"#;
        let raw: RawDeployment = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.phase, DeploymentPhase::Ready);
        assert_eq!(d.status_label, "Success");
        assert_eq!(d.commit_sha, "222c59fd6dd081cf11dbf40a6779aeb9000be145");
        assert_eq!(d.branch.as_deref(), Some("main"));
        assert_eq!(d.commit_message.as_deref(), Some("Update the nav"));
        assert_eq!(d.environment, Environment::Production);
        // Cloudflare gives no dashboard link, and one must not be assembled.
        assert_eq!(d.dashboard_url, None);
    }

    #[test]
    fn a_deployment_with_no_trigger_metadata_still_parses() {
        // A direct upload has no commit behind it.
        let body = r#"{"id":"dep_2","latest_stage":{"name":"deploy","status":"success"}}"#;
        let raw: RawDeployment = serde_json::from_str(body).unwrap();
        let d = to_deployment(raw);

        assert_eq!(d.commit_sha, "");
        assert_eq!(d.branch, None);
    }

    #[test]
    fn a_link_without_an_account_id_asks_to_be_relinked() {
        // Cloudflare writes nothing to disk, so an account id can only come
        // from the picker; without one every call would 404 confusingly.
        let link = HostingLink {
            provider: super::super::model::HostingProvider::Cloudflare,
            project_id: "my-project".into(),
            scope_id: None,
            project_name: None,
            source: super::super::model::LinkSource::UserPicked,
            linked_at: 0,
        };
        assert!(account_id(&link).is_err());
    }

    #[test]
    fn an_unsuccessful_envelope_is_not_read_as_data() {
        let body = r#"{"success":false,"errors":[{"code":10000}],"result":null}"#;
        let envelope: Envelope<Vec<RawDeployment>> = serde_json::from_str(body).unwrap();
        assert!(envelope.into_result().is_err());
    }
}
