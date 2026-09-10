//! Shared HTTP plumbing for the hosting adapters.
//!
//! One client, one error taxonomy. The adapters call providers directly over
//! HTTPS rather than scraping a CLI's human-formatted table — the current
//! plugin's entire commit history is a record of that approach breaking.

use crate::errors::CommandError;
use std::sync::LazyLock;
use std::time::Duration;

/// Total budget for one provider call. The frontend polls on a few-second
/// cadence, so a request that outlives that is already useless; failing fast
/// keeps a wedged provider from stalling the poll chain.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("Harbr/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// How a provider call failed, separated by who can do something about it.
#[derive(Debug, Clone)]
pub enum HostingHttpError {
    /// The provider refused our credential. Both 401 and 403 land here: Vercel
    /// answers an *expired* token with `403 {"invalidToken":true}`, and
    /// treating that as anything but rejection is exactly the defect that makes
    /// the current plugin render a healthy card for a dead login.
    Rejected,
    /// Asked to slow down, with the provider's own retry hint when it gave one.
    RateLimited { retry_after_secs: Option<u64> },
    /// Network, DNS, TLS, timeout, or a provider 5xx. Not the user's fault and
    /// not ours — shown as "couldn't reach", kept out of telemetry.
    Transport { message: String },
    /// The call succeeded but the body wasn't what we expect. This one *is*
    /// ours: either the provider changed shape or our adapter is wrong, and we
    /// want to hear about it.
    Malformed { message: String },
}

impl HostingHttpError {
    /// Convert to the app's error type for the rare command that surfaces the
    /// failure directly rather than folding it into a `ProviderStatus`.
    pub fn into_command_error(self, provider: &str) -> CommandError {
        match self {
            HostingHttpError::Rejected => CommandError::NotAuthenticated {
                service: provider.to_string(),
            },
            HostingHttpError::RateLimited { retry_after_secs } => {
                let wait = retry_after_secs
                    .map(|s| format!(" Try again in about {s}s."))
                    .unwrap_or_default();
                CommandError::expected(format!("{provider} is rate limiting requests.{wait}"))
            }
            HostingHttpError::Transport { message } => {
                CommandError::expected(format!("Couldn't reach {provider}: {message}"))
            }
            HostingHttpError::Malformed { message } => CommandError::Other {
                message: format!("Unexpected response from {provider}: {message}"),
            },
        }
    }
}

/// Render a reqwest error as its source chain, **without** the request URL.
///
/// reqwest's own `Display` is `error sending request for url (<the whole
/// URL>)`, and every hosting URL carries the user's account: Cloudflare's is
/// `/accounts/<account id>/pages/projects/<project>`, Vercel's is
/// `?projectId=…&teamId=…&sha=…`. That string is not kept for a log — it is
/// the `transport_error` the reducer folds into `offline`, which the Push
/// popover prints verbatim on its third line. A DNS blip therefore put the
/// user's Cloudflare account id on screen, which is the leak issue #787 filed
/// against the old plugin.
///
/// It also said nothing. The actionable cause — DNS, connection refused, TLS,
/// timeout — lives in `source()`, so dropping the wrapper loses no
/// information and removes 100+ characters of URL from a 320px row.
///
/// When there is no source chain (a `Display`-only error), the URL is stripped
/// from the parentheses instead of trusting that this shape can't carry one.
pub fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        parts.push(s.to_string());
        source = s.source();
    }

    if parts.is_empty() {
        return redact_urls(&e.to_string());
    }
    redact_urls(&parts.join(": "))
}

/// Remove anything that looks like a URL from a message we are about to show.
///
/// A belt-and-braces pass over text that came from a library: the source chain
/// is not documented to be URL-free, and this text is user-facing.
fn redact_urls(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;

    while let Some(start) = rest.find("http") {
        if !rest[start..].starts_with("http://") && !rest[start..].starts_with("https://") {
            let (head, tail) = rest.split_at(start + 4);
            out.push_str(head);
            rest = tail;
            continue;
        }
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let end = after
            .find(|c: char| c.is_whitespace() || c == ')' || c == '"')
            .unwrap_or(after.len());
        out.push_str("<url>");
        rest = &after[end..];
    }

    out.push_str(rest);
    // The wrapper leaves an empty "for url (<url>)" behind; tidy the artifact.
    out.replace(" (<url>)", "").trim().to_string()
}

/// Parse a `Retry-After` header. Only the delta-seconds form is handled; the
/// HTTP-date form is rare on these APIs and a missing hint just means the
/// caller falls back to its own backoff.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// GET a provider endpoint with a bearer token and decode the JSON body.
///
/// Status is classified before the body is touched, so a provider that returns
/// an error document with a 200-shaped body can't be mistaken for success and
/// an auth failure can't be mistaken for "no data".
pub async fn get_json<T: serde::de::DeserializeOwned>(
    url: &str,
    token: &str,
) -> Result<T, HostingHttpError> {
    let response = CLIENT
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| HostingHttpError::Transport {
            message: describe_reqwest_error(&e),
        })?;

    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(HostingHttpError::Rejected);
    }

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(HostingHttpError::RateLimited {
            retry_after_secs: parse_retry_after(response.headers()),
        });
    }

    if status.is_server_error() {
        return Err(HostingHttpError::Transport {
            message: format!(
                "{provider_status} from the provider",
                provider_status = status
            ),
        });
    }

    if !status.is_success() {
        // A 404 on a deployments endpoint means the project id we hold is
        // wrong or the project was deleted — a real, reportable mismatch
        // rather than a transient blip.
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(HostingHttpError::Malformed {
            message: format!("HTTP {status}: {snippet}"),
        });
    }

    let body = response
        .text()
        .await
        .map_err(|e| HostingHttpError::Transport {
            message: describe_reqwest_error(&e),
        })?;

    serde_json::from_str::<T>(&body).map_err(|e| {
        let snippet: String = body.chars().take(200).collect();
        HostingHttpError::Malformed {
            message: format!("{e} (body started: {snippet})"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

    /// The message this produces is not a log line — it becomes
    /// `ProviderStatus::transport_error`, which the reducer folds into
    /// `offline` and the Push popover prints verbatim. reqwest's `Display` is
    /// `error sending request for url (<the whole URL>)`, and every hosting
    /// URL identifies the user's account, so a DNS blip used to put a
    /// Cloudflare account id (or a Vercel `projectId`/`teamId`) on screen.
    ///
    /// `.invalid` is reserved by RFC 2606 and never resolves, so this fails
    /// the same way with or without a network.
    #[tokio::test]
    async fn a_transport_error_never_carries_the_request_url() {
        let url = "https://api.cloudflare.invalid/client/v4/accounts/SECRETACCOUNT123\
                   /pages/projects/my-private-project/deployments?per_page=25";
        let Err(err) = CLIENT.get(url).bearer_auth("t").send().await else {
            // A resolver that answers for `.invalid` would make this vacuous.
            return;
        };

        let described = describe_reqwest_error(&err);

        assert!(
            !described.contains("SECRETACCOUNT123"),
            "the account id reached user-facing copy: {described}"
        );
        assert!(
            !described.contains("my-private-project"),
            "the project name reached user-facing copy: {described}"
        );
        assert!(
            !described.contains("api.cloudflare.invalid"),
            "the request URL reached user-facing copy: {described}"
        );
        // Still says what went wrong — redaction must not empty the message.
        assert!(
            described.to_lowercase().contains("dns")
                || described.to_lowercase().contains("connect"),
            "the actionable cause was lost: {described}"
        );
    }

    #[test]
    fn redaction_keeps_the_sentence_and_drops_only_the_address() {
        assert_eq!(
            redact_urls("error sending request for url (https://api.vercel.com/v6?teamId=t_1)"),
            "error sending request for url"
        );
        assert_eq!(
            redact_urls("connection refused"),
            "connection refused",
            "a message with no URL must be left exactly as it is"
        );
        assert_eq!(
            redact_urls("failed to reach https://api.netlify.com/sites/abc after 3 tries"),
            "failed to reach <url> after 3 tries"
        );
    }

    #[test]
    fn retry_after_reads_delta_seconds() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("30"));
        assert_eq!(parse_retry_after(&headers), Some(30));
    }

    #[test]
    fn retry_after_tolerates_a_missing_or_unparseable_header() {
        assert_eq!(parse_retry_after(&HeaderMap::new()), None);

        let mut headers = HeaderMap::new();
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(parse_retry_after(&headers), None);
    }

    #[test]
    fn rejection_maps_to_not_authenticated_not_a_generic_failure() {
        let err = HostingHttpError::Rejected.into_command_error("Vercel");
        assert!(matches!(err, CommandError::NotAuthenticated { .. }));
    }

    #[test]
    fn transport_and_rate_limit_stay_out_of_telemetry() {
        // `Expected` is the variant that error_reporting skips.
        let transport = HostingHttpError::Transport {
            message: "dns error".into(),
        }
        .into_command_error("Netlify");
        assert!(matches!(transport, CommandError::Expected { .. }));

        let limited = HostingHttpError::RateLimited {
            retry_after_secs: Some(30),
        }
        .into_command_error("Netlify");
        assert!(matches!(limited, CommandError::Expected { .. }));
    }

    #[test]
    fn a_malformed_body_is_reportable_because_it_means_we_are_wrong() {
        let err = HostingHttpError::Malformed {
            message: "expected sequence".into(),
        }
        .into_command_error("Cloudflare");
        assert!(matches!(err, CommandError::Other { .. }));
    }
}
