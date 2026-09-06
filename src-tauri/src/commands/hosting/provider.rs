//! The adapter boundary.
//!
//! Every provider-specific call goes through one of these functions, and each
//! is an exhaustive `match` on [`HostingProvider`]. Adding a provider is then a
//! compile error in exactly the places that need work, rather than a runtime
//! surprise in the one path nobody remembered.

use super::http::HostingHttpError;
use super::model::{BuildLog, Deployment, HostingLink, HostingProjectChoice, HostingProvider, Lookup};
use super::vercel;

/// Placeholder for a provider whose adapter has not landed yet. Returns a
/// transport-shaped failure so the UI shows "couldn't reach" rather than
/// pretending the project is unlinked or, worse, healthy.
fn not_yet_implemented(provider: HostingProvider) -> HostingHttpError {
    HostingHttpError::Transport {
        message: format!("{} support is still being built.", provider.label()),
    }
}

/// Find the deployment for an exact commit.
pub async fn find_for_commit(
    link: &HostingLink,
    token: &str,
    sha: &str,
    branch: &str,
) -> Result<Lookup, HostingHttpError> {
    match link.provider {
        HostingProvider::Vercel => vercel::find_for_commit(link, token, sha, branch).await,
        HostingProvider::Cloudflare | HostingProvider::Netlify => {
            Err(not_yet_implemented(link.provider))
        }
    }
}

/// A deployment's build output — the reason a failure happened, which the
/// deployments endpoints do not carry.
pub async fn fetch_logs(
    link: &HostingLink,
    token: &str,
    deployment_id: &str,
) -> Result<BuildLog, HostingHttpError> {
    match link.provider {
        HostingProvider::Vercel => vercel::fetch_logs(link, token, deployment_id).await,
        HostingProvider::Cloudflare | HostingProvider::Netlify => {
            Err(not_yet_implemented(link.provider))
        }
    }
}

/// Recent deployments on this project, newest first.
pub async fn list_recent(
    link: &HostingLink,
    token: &str,
    limit: u32,
) -> Result<Vec<Deployment>, HostingHttpError> {
    match link.provider {
        HostingProvider::Vercel => vercel::list_recent(link, token, limit).await,
        HostingProvider::Cloudflare | HostingProvider::Netlify => {
            Err(not_yet_implemented(link.provider))
        }
    }
}

/// Projects this token can see, for the link picker.
pub async fn list_projects(
    provider: HostingProvider,
    token: &str,
    scope_id: Option<&str>,
) -> Result<Vec<HostingProjectChoice>, HostingHttpError> {
    match provider {
        HostingProvider::Vercel => vercel::list_projects(token, scope_id).await,
        HostingProvider::Cloudflare | HostingProvider::Netlify => {
            Err(not_yet_implemented(provider))
        }
    }
}

/// Confirm a credential works, and say whose it is.
pub async fn verify_token(
    provider: HostingProvider,
    token: &str,
) -> Result<Option<String>, HostingHttpError> {
    match provider {
        HostingProvider::Vercel => vercel::verify_token(token).await,
        HostingProvider::Cloudflare | HostingProvider::Netlify => {
            Err(not_yet_implemented(provider))
        }
    }
}
