//! # Hosting
//!
//! Answers one question for the workspace: **did the commit I just pushed
//! actually deploy, and can I open it?**
//!
//! That framing is the whole design. The previous implementation reported the
//! *most recent deployment on the project* — any branch, any environment, any
//! teammate — which is a different question with a frequently different answer.
//! Everything here is keyed to a specific commit SHA, and when a provider has
//! nothing for that SHA we say so rather than showing someone else's build.
//!
//! Structure:
//!
//! * [`model`] — the provider-agnostic vocabulary the frontend renders.
//! * [`provider`] — the adapter boundary; one exhaustive match per operation.
//! * `vercel` / (cloudflare, netlify to follow) — per-provider adapters.
//! * [`http`] — one client, one error taxonomy.
//! * [`credentials`] — keychain first, CLI credential file as a fallback.
//! * [`link`] — which provider project this repo deploys to.
//! * [`git_ref`] — the commit the provider could actually have seen.
//!
//! Verified provider behaviour is recorded in
//! `docs/internal/hosting-provider-matrix.md`; anything unverified is marked
//! there and must not become load-bearing until it is checked.

pub mod cloudflare;
pub mod credentials;
pub mod git_ref;
pub mod http;
pub mod link;
pub mod model;
pub mod netlify;
pub mod provider;
pub mod vercel;

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use model::{
    now_ms, Auth, BuildLog, Deployment, DeploymentSnapshot, DetectedLink, HostingLink,
    HostingProjectChoice, HostingProvider, HostingStatus, Lookup, ProviderStatus, TokenCheck,
};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a status is reused before we ask the provider again.
///
/// Short, because the frontend polls on roughly this cadence while a build is
/// running and two open windows on the same project should share one call
/// rather than doubling the request rate.
const ACTIVE_TTL: Duration = Duration::from_secs(3);
/// A finished deployment does not change. Re-asking is pure waste, so a
/// terminal phase is held far longer.
const TERMINAL_TTL: Duration = Duration::from_secs(600);

struct CacheEntry {
    status: ProviderStatus,
    expires_at: Instant,
}

/// Keyed by project, provider, and commit — so a new push is never served a
/// previous commit's answer.
static STATUS_CACHE: LazyLock<Mutex<HashMap<(String, HostingProvider, String), CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached(key: &(String, HostingProvider, String)) -> Option<ProviderStatus> {
    let cache = STATUS_CACHE.lock().ok()?;
    let entry = cache.get(key)?;
    if Instant::now() >= entry.expires_at {
        return None;
    }
    let mut status = entry.status.clone();
    status.from_cache = true;
    Some(status)
}

fn cache(key: (String, HostingProvider, String), status: &ProviderStatus) {
    let ttl = match &status.lookup {
        Some(Lookup::Found { deployment }) if deployment.phase.is_terminal() => TERMINAL_TTL,
        _ => ACTIVE_TTL,
    };
    if let Ok(mut c) = STATUS_CACHE.lock() {
        c.insert(
            key,
            CacheEntry {
                status: status.clone(),
                expires_at: Instant::now() + ttl,
            },
        );
    }
}

/// Drop every cached answer for a project — used when a link or credential
/// changes and the previous answers can no longer be trusted.
fn invalidate_project(project_path: &str) {
    if let Ok(mut c) = STATUS_CACHE.lock() {
        c.retain(|(path, _, _), _| path != project_path);
    }
}

/// Ask one provider about one commit.
async fn status_for_link(
    project: &std::path::Path,
    link: &HostingLink,
    sha: &str,
    branch: &str,
) -> ProviderStatus {
    let base = ProviderStatus {
        link: link.clone(),
        auth: Auth::Ok,
        token_source: None,
        lookup: None,
        transport_error: None,
        retry_after_secs: None,
        fetched_at: now_ms(),
        from_cache: false,
    };

    let Some(resolved) = credentials::token_for(link.provider, project) else {
        return ProviderStatus {
            auth: Auth::NoToken,
            ..base
        };
    };

    match provider::find_for_commit(link, &resolved.token, sha, branch).await {
        Ok(lookup) => ProviderStatus {
            token_source: Some(resolved.source),
            lookup: Some(lookup),
            ..base
        },
        Err(http::HostingHttpError::Rejected) => {
            // Never rendered as healthy. An expired Vercel CLI login answers
            // 403, and calling that "connected" is the defect this replaces.
            tracing::warn!(
                provider = link.provider.label(),
                source = ?resolved.source,
                "Hosting provider rejected the credential"
            );
            ProviderStatus {
                auth: Auth::Rejected,
                token_source: Some(resolved.source),
                ..base
            }
        }
        Err(http::HostingHttpError::RateLimited { retry_after_secs }) => ProviderStatus {
            token_source: Some(resolved.source),
            transport_error: Some(format!(
                "{} is rate limiting requests.",
                link.provider.label()
            )),
            retry_after_secs,
            ..base
        },
        Err(http::HostingHttpError::Transport { message }) => ProviderStatus {
            token_source: Some(resolved.source),
            transport_error: Some(message),
            ..base
        },
        Err(http::HostingHttpError::Malformed { message }) => {
            // Ours to fix: either the provider changed shape or the adapter is
            // wrong. Logged loudly, shown to the user as "couldn't read".
            tracing::error!(
                provider = link.provider.label(),
                error = %message,
                "Unexpected response shape from hosting provider"
            );
            ProviderStatus {
                token_source: Some(resolved.source),
                transport_error: Some(format!(
                    "Couldn't read {}'s response.",
                    link.provider.label()
                )),
                ..base
            }
        }
    }
}

/// The state of every provider this project deploys to, for the commit that was
/// actually pushed.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_hosting_status(project_path: String) -> Result<HostingStatus, CommandError> {
    let project = validate_project_path(&project_path)?;
    let commit = git_ref::pushed_commit(&project)?;
    let links = link::effective_links(&project);

    let mut providers = Vec::with_capacity(links.len());
    for link in links {
        let key = (project_path.clone(), link.provider, commit.sha.clone());

        if let Some(hit) = cached(&key) {
            providers.push(hit);
            continue;
        }

        let status = status_for_link(&project, &link, &commit.sha, &commit.branch).await;
        cache(key, &status);
        providers.push(status);
    }

    // Remember the newest terminal answer so the next open paints instantly and
    // an offline session can say what it last knew, with its age.
    if let Some((link, deployment)) = providers.iter().find_map(|p| match &p.lookup {
        Some(Lookup::Found { deployment }) => Some((&p.link, deployment)),
        _ => None,
    }) {
        let mut meta = link::read_metadata(&project);
        meta.last = Some(DeploymentSnapshot {
            provider: link.provider,
            sha: commit.sha.clone(),
            phase: deployment.phase.clone(),
            primary_url: deployment.urls.primary.clone(),
            fetched_at: now_ms(),
        });
        let _ = link::write_metadata(&project, meta);
    }

    Ok(HostingStatus {
        commit,
        providers,
        detected: link::unconfirmed_links(&project),
    })
}

/// Links discoverable from provider CLI files. Local only — no network, so this
/// is safe to call on project open.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn detect_hosting_links(project_path: String) -> Result<Vec<DetectedLink>, CommandError> {
    let project = validate_project_path(&project_path)?;
    Ok(link::detect_local_links(&project))
}

/// Projects the user could link this repo to.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_hosting_projects(
    project_path: String,
    provider: HostingProvider,
    scope_id: Option<String>,
) -> Result<Vec<HostingProjectChoice>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let resolved = credentials::token_for(provider, &project).ok_or_else(|| {
        CommandError::NotAuthenticated {
            service: provider.label().to_string(),
        }
    })?;

    provider::list_projects(provider, &resolved.token, scope_id.as_deref())
        .await
        .map_err(|e| e.into_command_error(provider.label()))
}

/// Record which provider project this repo deploys to.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn set_hosting_link(project_path: String, link: HostingLink) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let mut meta = link::read_metadata(&project);
    meta.links.retain(|l| l.provider != link.provider);
    meta.links.push(HostingLink {
        linked_at: now_ms(),
        ..link
    });
    // The snapshot describes a deployment on the project we just stopped
    // pointing at.
    meta.last = None;
    link::write_metadata(&project, meta)?;
    invalidate_project(&project_path);
    Ok(())
}

/// Forget a provider link.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn clear_hosting_link(
    project_path: String,
    provider: HostingProvider,
) -> Result<(), CommandError> {
    let project = validate_project_path(&project_path)?;
    let mut meta = link::read_metadata(&project);
    meta.links.retain(|l| l.provider != provider);
    if meta.last.as_ref().is_some_and(|s| s.provider == provider) {
        meta.last = None;
    }
    link::write_metadata(&project, meta)?;
    invalidate_project(&project_path);
    Ok(())
}

/// The recent deployment history for a project, newest first.
///
/// The same data the provider's dashboard leads with, so a user can see the
/// shape of the last few pushes without leaving the app.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_recent_deployments(
    project_path: String,
    provider: HostingProvider,
    limit: Option<u32>,
) -> Result<Vec<Deployment>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let link = link::effective_links(&project)
        .into_iter()
        .find(|l| l.provider == provider)
        .ok_or_else(|| {
            CommandError::expected(format!(
                "This project isn't linked to {}.",
                provider.label()
            ))
        })?;

    let resolved = credentials::token_for(provider, &project).ok_or_else(|| {
        CommandError::NotAuthenticated {
            service: provider.label().to_string(),
        }
    })?;

    provider::list_recent(&link, &resolved.token, limit.unwrap_or(10))
        .await
        .map_err(|e| e.into_command_error(provider.label()))
}

/// A deployment's build output.
///
/// This is the call that makes the provider's dashboard unnecessary for the
/// case people actually go there for: the deployments API reports that a build
/// failed, and only the log says why.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_deployment_log(
    project_path: String,
    provider: HostingProvider,
    deployment_id: String,
) -> Result<BuildLog, CommandError> {
    let project = validate_project_path(&project_path)?;
    let link = link::effective_links(&project)
        .into_iter()
        .find(|l| l.provider == provider)
        .ok_or_else(|| {
            CommandError::expected(format!(
                "This project isn't linked to {}.",
                provider.label()
            ))
        })?;

    let resolved = credentials::token_for(provider, &project).ok_or_else(|| {
        CommandError::NotAuthenticated {
            service: provider.label().to_string(),
        }
    })?;

    provider::fetch_logs(&link, &resolved.token, &deployment_id)
        .await
        .map_err(|e| e.into_command_error(provider.label()))
}

/// Check a stored credential without asking about any deployment.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn verify_hosting_token(
    project_path: String,
    provider: HostingProvider,
) -> Result<TokenCheck, CommandError> {
    let project = validate_project_path(&project_path)?;

    let Some(resolved) = credentials::token_for(provider, &project) else {
        return Ok(TokenCheck {
            auth: Auth::NoToken,
            token_source: None,
            account_label: None,
        });
    };

    match provider::verify_token(provider, &resolved.token).await {
        Ok(account_label) => Ok(TokenCheck {
            auth: Auth::Ok,
            token_source: Some(resolved.source),
            account_label,
        }),
        Err(http::HostingHttpError::Rejected) => Ok(TokenCheck {
            auth: Auth::Rejected,
            token_source: Some(resolved.source),
            account_label: None,
        }),
        Err(e) => Err(e.into_command_error(provider.label())),
    }
}

/// Drop cached hosting answers for a project. Called when a credential changes,
/// since a new token can produce a different answer for the same commit.
pub fn invalidate_hosting_cache(project_path: &str) {
    invalidate_project(project_path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::{Deployment, DeploymentPhase, DeploymentUrls, Environment, LinkSource};

    fn link_for(provider: HostingProvider) -> HostingLink {
        HostingLink {
            provider,
            project_id: "prj_1".into(),
            scope_id: None,
            project_name: None,
            source: LinkSource::UserPicked,
            linked_at: 0,
        }
    }

    fn status_with(phase: DeploymentPhase) -> ProviderStatus {
        ProviderStatus {
            link: link_for(HostingProvider::Vercel),
            auth: Auth::Ok,
            token_source: None,
            lookup: Some(Lookup::Found {
                deployment: Deployment {
                    id: "dpl_1".into(),
                    status_label: "Ready".into(),
                    phase,
                    detail: None,
                    environment: Environment::Production,
                    branch: Some("main".into()),
                    commit_sha: "abc".into(),
                    commit_message: None,
                    urls: DeploymentUrls::default(),
                    dashboard_url: None,
                    error_message: None,
                    created_at: 0,
                    ready_at: None,
                },
            }),
            transport_error: None,
            retry_after_secs: None,
            fetched_at: 0,
            from_cache: false,
        }
    }

    #[test]
    fn a_cache_hit_is_labelled_so_the_ui_can_be_honest_about_freshness() {
        let key = (
            "/p/fresh".to_string(),
            HostingProvider::Vercel,
            "abc".to_string(),
        );
        cache(key.clone(), &status_with(DeploymentPhase::Ready));

        let hit = cached(&key).expect("still within TTL");
        assert!(hit.from_cache);
        invalidate_project("/p/fresh");
    }

    #[test]
    fn a_different_commit_never_reads_the_previous_commits_answer() {
        // The whole point of the rewrite: the status is per-commit.
        let old = (
            "/p/commits".to_string(),
            HostingProvider::Vercel,
            "old-sha".to_string(),
        );
        cache(old, &status_with(DeploymentPhase::Ready));

        let new = (
            "/p/commits".to_string(),
            HostingProvider::Vercel,
            "new-sha".to_string(),
        );
        assert!(
            cached(&new).is_none(),
            "a new push must not inherit the previous commit's status"
        );
        invalidate_project("/p/commits");
    }

    #[test]
    fn an_in_flight_build_is_cached_only_briefly() {
        let key = (
            "/p/ttl".to_string(),
            HostingProvider::Vercel,
            "abc".to_string(),
        );
        cache(key.clone(), &status_with(DeploymentPhase::Building));

        let expires = {
            let c = STATUS_CACHE.lock().unwrap();
            c.get(&key).unwrap().expires_at
        };
        assert!(expires <= Instant::now() + ACTIVE_TTL);
        invalidate_project("/p/ttl");
    }

    #[test]
    fn a_finished_deployment_is_cached_for_much_longer() {
        let key = (
            "/p/done".to_string(),
            HostingProvider::Vercel,
            "abc".to_string(),
        );
        cache(key.clone(), &status_with(DeploymentPhase::Ready));

        let expires = {
            let c = STATUS_CACHE.lock().unwrap();
            c.get(&key).unwrap().expires_at
        };
        assert!(expires > Instant::now() + ACTIVE_TTL);
        invalidate_project("/p/done");
    }

    #[test]
    fn invalidating_one_project_leaves_others_alone() {
        let a = (
            "/p/a".to_string(),
            HostingProvider::Vercel,
            "abc".to_string(),
        );
        let b = (
            "/p/b".to_string(),
            HostingProvider::Vercel,
            "abc".to_string(),
        );
        cache(a.clone(), &status_with(DeploymentPhase::Ready));
        cache(b.clone(), &status_with(DeploymentPhase::Ready));

        invalidate_project("/p/a");

        assert!(cached(&a).is_none());
        assert!(cached(&b).is_some());
        invalidate_project("/p/b");
    }
}
