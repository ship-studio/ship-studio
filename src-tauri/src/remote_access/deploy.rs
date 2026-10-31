//! `deploy_status`: did the push actually go live?
//!
//! After a remote push the person on the phone wants one more answer —
//! whether the site has the change — and the alternative is opening the
//! host's dashboard on a phone. This asks the same native hosting code the
//! Push popover uses (see the Hosting Flow), so the two never disagree, and
//! keeps its honesty rules: the provider's own status word, a missing
//! deployment is "not found" and never "failed", and a URL only when the
//! provider returned one.

use crate::commands::hosting::{
    self,
    model::{Auth, Deployment, DeploymentPhase, HostingStatus, Lookup, ProviderStatus},
};
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_WAIT_SECS: u64 = 40;
const MAX_WAIT_SECS: u64 = 50;
const POLL: Duration = Duration::from_secs(5);

fn text(s: String) -> Value {
    json!({ "content": [{ "type": "text", "text": s }] })
}

fn error(s: String) -> Value {
    json!({ "content": [{ "type": "text", "text": s }], "isError": true })
}

/// Still worth waiting on: a build in progress, or a deployment the host
/// hasn't listed yet.
fn unsettled(p: &ProviderStatus) -> bool {
    matches!(p.auth, Auth::Ok)
        && p.transport_error.is_none()
        && match &p.lookup {
            Some(Lookup::Found { deployment }) => !deployment.phase.is_terminal(),
            Some(Lookup::NotFound { .. }) => true,
            None => false,
        }
}

fn deployment_line(label: &str, d: &Deployment) -> String {
    let url = d.urls.primary.as_deref().or(d.urls.site.as_deref());
    match &d.phase {
        DeploymentPhase::Ready => match url {
            Some(u) => format!("{label}: {} — live at {u}", d.status_label),
            None => format!("{label}: {}", d.status_label),
        },
        DeploymentPhase::Failed => format!(
            "{label}: {}{}",
            d.status_label,
            d.error_message
                .as_deref()
                .map(|e| format!(" — {e}"))
                .unwrap_or_default()
        ),
        _ => format!("{label}: {}", d.status_label),
    }
}

/// One line per provider, and the NEXT step that follows from them.
pub(crate) fn describe(status: &HostingStatus) -> (Vec<String>, &'static str) {
    let short = &status.commit.short_sha;
    if !status.commit.has_upstream {
        return (
            vec![format!(
                "Nothing has been pushed from {} yet, so there's no deployment to check.",
                status.commit.branch
            )],
            "NEXT: Tell the user nothing has been pushed from this branch yet. prepare_push starts a push if they want one.",
        );
    }
    if status.providers.is_empty() {
        return (
            vec!["This project isn't connected to a host (Vercel, Cloudflare Pages or Netlify) in Ship Studio, so whether it deployed can't be checked from here.".into()],
            "NEXT: Tell the user the push reached GitHub, and that Ship Studio can't see a host for this project — they can connect one in the Push menu at the computer.",
        );
    }
    let mut lines = vec![format!(
        "Commit {short} on {}{}:",
        status.commit.branch,
        status
            .commit
            .subject
            .as_deref()
            .map(|s| format!(" (\"{s}\")"))
            .unwrap_or_default()
    )];
    let mut any_failed = false;
    let mut any_pending = false;
    for p in &status.providers {
        let label = p.link.provider.label();
        lines.push(match (&p.auth, &p.transport_error, &p.lookup) {
            (Auth::NoToken, _, _) => {
                format!("{label}: Ship Studio isn't signed in to {label}, so it can't check.")
            }
            (Auth::Rejected, _, _) => format!(
                "{label}: {label} rejected the saved sign-in; it needs renewing at the computer."
            ),
            (_, Some(e), _) => format!("{label}: couldn't reach {label} — {e}"),
            (_, _, Some(Lookup::Found { deployment })) => {
                any_failed |= deployment.phase == DeploymentPhase::Failed;
                any_pending |= !deployment.phase.is_terminal();
                deployment_line(label, deployment)
            }
            (_, _, Some(Lookup::NotFound { .. })) => {
                any_pending = true;
                format!("{label}: no deployment for {short} yet — it may not have been picked up.")
            }
            (_, _, None) => format!("{label}: no answer."),
        });
    }
    let next = if any_failed {
        "NEXT: Tell the user the deploy failed and the reason above in plain words, and offer to have the agent fix it (message_agent with the error)."
    } else if any_pending {
        "NEXT: Tell the user it's still deploying. Call deploy_status again in a minute if they want to know when it's live."
    } else {
        "NEXT: Tell the user in one sentence whether it's live, with the address if there is one."
    };
    (lines, next)
}

/// The build log's likeliest error line, when the deployment record itself
/// didn't say why it failed.
async fn fill_failure_reasons(project: &str, status: &mut HostingStatus) {
    for p in &mut status.providers {
        let Some(Lookup::Found { deployment }) = &mut p.lookup else {
            continue;
        };
        if deployment.phase != DeploymentPhase::Failed || deployment.error_message.is_some() {
            continue;
        }
        if let Ok(log) =
            hosting::get_deployment_log(project.to_string(), p.link.provider, deployment.id.clone())
                .await
        {
            deployment.error_message = log.likely_error();
        }
    }
}

pub(crate) async fn deploy_status(project: &str, args: &Value) -> Value {
    let wait = Duration::from_secs(
        args.get("wait_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WAIT_SECS)
            .min(MAX_WAIT_SECS),
    );
    let deadline = tokio::time::Instant::now() + wait;
    let mut status = loop {
        let status = match hosting::get_hosting_status(project.to_string()).await {
            Ok(s) => s,
            Err(e) => return error(format!("Couldn't check the deployment: {e}")),
        };
        if !status.providers.iter().any(unsettled) || tokio::time::Instant::now() + POLL > deadline
        {
            break status;
        }
        tokio::time::sleep(POLL).await;
    };
    fill_failure_reasons(project, &mut status).await;
    let (lines, next) = describe(&status);
    text(format!("{}\n\n{next}", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::hosting::model::{
        CommitRef, DeploymentUrls, Environment, HostingLink, HostingProvider, LinkSource,
    };

    fn commit(has_upstream: bool) -> CommitRef {
        CommitRef {
            sha: "abcdef1234567".into(),
            short_sha: "abcdef1".into(),
            subject: Some("Fix header".into()),
            committed_at: None,
            branch: "main".into(),
            has_upstream,
        }
    }

    fn provider(lookup: Option<Lookup>) -> ProviderStatus {
        ProviderStatus {
            link: HostingLink {
                provider: HostingProvider::Vercel,
                project_id: "prj".into(),
                scope_id: None,
                project_name: None,
                source: LinkSource::VercelCliFile,
                linked_at: 0,
            },
            auth: Auth::Ok,
            token_source: None,
            lookup,
            transport_error: None,
            retry_after_secs: None,
            fetched_at: 0,
            from_cache: false,
        }
    }

    fn deployment(phase: DeploymentPhase, label: &str, primary: Option<&str>) -> Lookup {
        Lookup::Found {
            deployment: Deployment {
                id: "dpl".into(),
                phase,
                status_label: label.into(),
                detail: None,
                environment: Environment::Production,
                branch: Some("main".into()),
                commit_sha: "abcdef1234567".into(),
                commit_message: None,
                urls: DeploymentUrls {
                    primary: primary.map(Into::into),
                    ..Default::default()
                },
                dashboard_url: None,
                error_message: None,
                created_at: 0,
                ready_at: None,
            },
        }
    }

    fn status(providers: Vec<ProviderStatus>) -> HostingStatus {
        HostingStatus {
            commit: commit(true),
            providers,
            detected: vec![],
        }
    }

    #[test]
    fn ready_reports_the_providers_word_and_its_url() {
        let (lines, next) = describe(&status(vec![provider(Some(deployment(
            DeploymentPhase::Ready,
            "Ready",
            Some("https://bakery.example"),
        )))]));
        assert_eq!(lines[1], "Vercel: Ready — live at https://bakery.example");
        assert!(next.contains("whether it's live"));
    }

    #[test]
    fn a_missing_deployment_is_never_called_failed() {
        let s = status(vec![provider(Some(Lookup::NotFound {
            latest_on_branch: None,
        }))]);
        let (lines, next) = describe(&s);
        assert!(lines[1].contains("no deployment for abcdef1 yet"));
        assert!(!lines.join(" ").to_lowercase().contains("fail"));
        assert!(next.contains("still deploying"));
        assert!(unsettled(&s.providers[0]));
    }

    #[test]
    fn a_failure_offers_the_fix() {
        let (_, next) = describe(&status(vec![provider(Some(deployment(
            DeploymentPhase::Failed,
            "Error",
            None,
        )))]));
        assert!(next.contains("failed"));
    }

    #[test]
    fn a_building_deploy_is_worth_waiting_on_and_a_rejected_token_is_not() {
        let building = provider(Some(deployment(
            DeploymentPhase::Building,
            "Building",
            None,
        )));
        assert!(unsettled(&building));
        let rejected = ProviderStatus {
            auth: Auth::Rejected,
            ..building
        };
        assert!(!unsettled(&rejected));
        assert!(describe(&status(vec![rejected])).0[1].contains("rejected"));
    }

    #[test]
    fn no_host_and_nothing_pushed_say_so() {
        assert!(describe(&status(vec![])).0[0].contains("isn't connected to a host"));
        let unpushed = HostingStatus {
            commit: commit(false),
            providers: vec![],
            detected: vec![],
        };
        assert!(describe(&unpushed).0[0].contains("Nothing has been pushed"));
    }
}
