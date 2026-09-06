//! Provider-agnostic hosting types.
//!
//! Every provider's raw response is reduced to these shapes by its adapter, so
//! the frontend renders one vocabulary regardless of who is hosting. Pure data
//! and pure functions only — no I/O, so the reducers stay unit-testable against
//! recorded fixtures.
//!
//! The TS mirror is `src/lib/hosting.ts`; changing a shape here means changing
//! it there.

use serde::{Deserialize, Serialize};

/// A hosting provider we can talk to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostingProvider {
    Vercel,
    Cloudflare,
    Netlify,
}

impl HostingProvider {
    /// Display name, used verbatim in user-facing copy.
    pub fn label(self) -> &'static str {
        match self {
            HostingProvider::Vercel => "Vercel",
            HostingProvider::Cloudflare => "Cloudflare",
            HostingProvider::Netlify => "Netlify",
        }
    }

    /// The keychain credential key (see `accounts::CRED_ENV_VARS`).
    pub fn credential_key(self) -> &'static str {
        match self {
            HostingProvider::Vercel => "vercel_token",
            HostingProvider::Cloudflare => "cloudflare_api_token",
            HostingProvider::Netlify => "netlify_auth_token",
        }
    }

    /// The environment variable the token is injected as.
    pub fn env_var(self) -> &'static str {
        match self {
            HostingProvider::Vercel => "VERCEL_TOKEN",
            HostingProvider::Cloudflare => "CLOUDFLARE_API_TOKEN",
            HostingProvider::Netlify => "NETLIFY_AUTH_TOKEN",
        }
    }
}

/// How we learned about a link, which decides whether it can be trusted
/// without asking the user to confirm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkSource {
    /// Read from `.vercel/project.json`, written by the Vercel CLI.
    VercelCliFile,
    /// Read from `.netlify/state.json`, written by the Netlify CLI.
    NetlifyCliFile,
    /// The user picked it in the link picker. Cloudflare Pages leaves nothing
    /// on disk, so this is the only way that provider is ever linked.
    UserPicked,
}

/// Which project on which provider this repo deploys to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostingLink {
    pub provider: HostingProvider,
    /// Vercel: `projectId` · Cloudflare: Pages project name · Netlify: site id.
    pub project_id: String,
    /// Vercel: `teamId` · Cloudflare: `account_id` · Netlify: unused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    /// Saved at link time for display; never used to build a request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub source: LinkSource,
    pub linked_at: u64,
}

/// A link we found on disk but that the user has not confirmed yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedLink {
    pub provider: HostingProvider,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub source: LinkSource,
}

/// The commit whose deployment we are asking about — always what the remote
/// has, never local `HEAD`, because a provider can only have deployed what it
/// could actually fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRef {
    pub sha: String,
    pub short_sha: String,
    /// `git log -1 --format=%s`. Available instantly and offline, so it is the
    /// primary source for "what was deployed" — the provider's own commit
    /// message is only a fallback (Netlify's is frequently null).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// Commit timestamp in ms. Used as the floor for the not-found grace
    /// period so an old, never-deployed commit doesn't sit on a spinner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<u64>,
    pub branch: String,
    /// False when the branch has no upstream — nothing has been pushed, so no
    /// deployment can exist and the UI says so rather than looking broken.
    pub has_upstream: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Production,
    Preview,
}

/// The unified lifecycle. Every provider's native states reduce into exactly
/// one of these.
///
/// `Unknown` exists because the alternative is worse: mapping an unrecognized
/// provider status onto `Ready` or `Failed` would state something we do not
/// know, which the project's "never assume data" rule forbids. Providers add
/// states without warning; this degrades honestly instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum DeploymentPhase {
    Queued,
    Building,
    Publishing,
    Ready,
    Failed,
    Canceled,
    Skipped,
    Gated,
    Unknown { raw: String },
}

impl DeploymentPhase {
    /// Terminal phases stop the fast poll. `Gated` is terminal for us even
    /// though the provider may still move: it is waiting on a human, not on a
    /// build, so polling it every few seconds buys nothing.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            DeploymentPhase::Ready
                | DeploymentPhase::Failed
                | DeploymentPhase::Canceled
                | DeploymentPhase::Skipped
                | DeploymentPhase::Gated
                | DeploymentPhase::Unknown { .. }
        )
    }
}

/// A qualifier on a phase, already de-jargoned by the adapter so the frontend
/// never sees a provider enum. Kept as a closed set rather than free text
/// because copy is chosen from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "detail", rename_all = "snake_case")]
pub enum DeploymentDetail {
    /// Built and available, but not yet serving production traffic
    /// (Vercel `readySubstate: STAGED`).
    NotYetPromoted,
    /// Being handed production traffic (Vercel `readySubstate: ROLLING`).
    RollingOut,
    /// The provider deliberately did not build this commit. `reason` is the
    /// provider's own explanation where it gives one — Cloudflare's
    /// `skip_reason`, Netlify's `skipped_log`; Vercel supplies nothing.
    SkippedBecause { reason: Option<String> },
    /// Netlify's author-trust gate: waiting for a human to approve the build.
    AwaitingReview { reason: Option<String> },
    /// Netlify's author-trust gate: a human declined the build.
    ReviewRejected,
    /// Superseded by a newer push before it finished.
    SupersededByNewer,
}

/// URLs for a deployment. Every value here is copied verbatim from a provider
/// response — nothing in this struct is ever assembled from parts. Building a
/// URL from a naming pattern is how the current plugins produce links that
/// 404, and the adapters have a test asserting each string appears in the raw
/// response body.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeploymentUrls {
    /// The address people actually visit — the project's production domain.
    ///
    /// This is a property of the *project*, not of a deployment, and on Vercel
    /// it lives on a different endpoint entirely. Reading it off the deployment
    /// record is why this section spent a day showing an unrecognisable
    /// per-build permalink and calling it the site.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    /// This specific build's immutable URL. Always resolves to this exact
    /// commit, even after newer deploys — which is what makes it useful, and
    /// also what makes it the wrong thing to show as "your site".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment: Option<String>,
    /// Every alias the provider reported for it.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// What a single "open" should go to: the site if we know it, else this
    /// build. Kept so callers that want one URL don't re-derive the rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
}

/// One deployment, reduced to the fields the UI can honestly display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment {
    pub id: String,
    pub phase: DeploymentPhase,
    /// The provider's own word for this status, shown to the user verbatim.
    ///
    /// `phase` drives behaviour (what to poll, what colour the dot is);
    /// this drives copy. Keeping them separate means the UI can say exactly
    /// what Vercel's dashboard says — "Ready", not a synonym this app made up
    /// — while the polling logic stays provider-agnostic. It also means each
    /// provider gets to keep its own vocabulary instead of being flattened
    /// into a shared one that matches none of them.
    pub status_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<DeploymentDetail>,
    pub environment: Environment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The commit this deployment was built from, as the provider reported it.
    pub commit_sha: String,
    /// The provider's own commit message. Frequently absent (Netlify returned
    /// null on a real production deploy), so the UI prefers `CommitRef.subject`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<String>,
    pub urls: DeploymentUrls,
    /// Link to the provider's own page for this deployment. `None` for
    /// Cloudflare, whose API returns nothing usable — and we do not invent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<u64>,
}

/// Which stream a build-log line came from. `stderr` is not the same as "an
/// error" — build tools warn on it constantly — but it is where the failure
/// usually is when there was one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// One line of a provider's build output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub at: u64,
    pub stream: LogStream,
    pub text: String,
}

/// A deployment's build output, as far as the provider will give it to us.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildLog {
    pub deployment_id: String,
    pub lines: Vec<LogLine>,
    /// True when the provider capped what it returned, so the UI can say the
    /// log is partial rather than implying this is all of it.
    pub truncated: bool,
}

impl BuildLog {
    /// The line most likely to explain a failure, for the one-line summary the
    /// popover shows before anyone opens the full log.
    ///
    /// Heuristic, and deliberately conservative: build tools write to `stderr`
    /// constantly without failing, so this looks for the last line that reads
    /// like an error and returns nothing when it can't find one. Showing no
    /// summary is better than confidently surfacing a deprecation warning as
    /// the reason a build failed.
    pub fn likely_error(&self) -> Option<String> {
        const MARKERS: [&str; 8] = [
            "error",
            "failed",
            "cannot find",
            "not found",
            "unexpected",
            "exited with",
            "syntaxerror",
            "typeerror",
        ];

        self.lines
            .iter()
            .rev()
            .find(|line| {
                let lower = line.text.to_lowercase();
                // A bare "warning: ..." on stderr is not the failure.
                !lower.starts_with("warning") && MARKERS.iter().any(|m| lower.contains(m))
            })
            .map(|line| line.text.clone())
    }
}

/// The result of asking "what happened to this commit?".
///
/// `NotFound` is deliberately not an error and never becomes `Failed`. No
/// provider documents how long it takes for a pushed commit to appear in their
/// API, so absence can only ever mean "we don't see it", never "it failed to
/// trigger". The frontend decides when to stop showing hope, using the push
/// time it alone knows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Lookup {
    Found {
        deployment: Deployment,
    },
    NotFound {
        /// Offered as context ("latest on this branch"), never presented as the
        /// status of the commit the user asked about.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        latest_on_branch: Option<Box<Deployment>>,
    },
}

/// Whether we can talk to the provider at all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Auth {
    Ok,
    /// No credential available from the keychain or a CLI file.
    NoToken,
    /// The provider refused the credential we had. Vercel answers an expired
    /// token with 403, not 401, so both are classified here — treating a 403 as
    /// anything other than rejection is precisely the bug that makes the
    /// current plugin show a healthy card for a dead token.
    Rejected,
}

/// Where the credential came from, so the UI can explain a rejection that the
/// user never opted into ("the Vercel CLI's login expired").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    /// A durable token the user stored in the keychain.
    Keychain,
    /// Borrowed from the provider CLI's own credential file. Free, but the
    /// provider controls its lifetime — Vercel's lasts hours.
    CliFile,
}

/// Everything known about one linked provider for one commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub link: HostingLink,
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_source: Option<TokenSource>,
    /// `None` whenever `auth` is not `Ok`, or the request never completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookup: Option<Lookup>,
    /// Set when the call failed for reasons that are not the user's fault —
    /// offline, DNS, 5xx. Carries the cause so the UI can say what went wrong
    /// rather than silently showing nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_error: Option<String>,
    /// Seconds to wait before retrying, from a rate-limit response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    pub fetched_at: u64,
    pub from_cache: bool,
}

/// The whole answer to "did my push deploy?", for every provider this project
/// is linked to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostingStatus {
    pub commit: CommitRef,
    /// One per persisted link. Empty means the project isn't linked to
    /// anything, which the UI renders as an invitation rather than an error.
    pub providers: Vec<ProviderStatus>,
    /// Links found on disk that aren't persisted yet, so the UI can offer
    /// one-click setup instead of a picker.
    #[serde(default)]
    pub detected: Vec<DetectedLink>,
}

/// A project the user could link to, for the picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostingProjectChoice {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_name: Option<String>,
}

/// Enough of the last known state to paint instantly on open and to be honest
/// about staleness when the network is gone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentSnapshot {
    pub provider: HostingProvider,
    pub sha: String,
    pub phase: DeploymentPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_url: Option<String>,
    pub fetched_at: u64,
}

/// What we persist in `.shipstudio/project.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostingMetadata {
    #[serde(default)]
    pub links: Vec<HostingLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<DeploymentSnapshot>,
}

/// Result of checking a credential without asking about any deployment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenCheck {
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_source: Option<TokenSource>,
    /// The account name the provider says the token belongs to, so the user can
    /// notice they connected the wrong one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

/// ISO-8601 to epoch milliseconds. Netlify sends `2026-02-22T17:26:51.942Z`
/// where Vercel sends a number, and the shared model uses milliseconds.
pub fn iso_to_ms(value: Option<&str>) -> Option<u64> {
    let raw = value?;
    let date = raw.get(0..10)?;
    let time = raw.get(11..19)?;

    let year: i64 = date.get(0..4)?.parse().ok()?;
    let month: i64 = date.get(5..7)?.parse().ok()?;
    let day: i64 = date.get(8..10)?.parse().ok()?;
    let hour: i64 = time.get(0..2)?.parse().ok()?;
    let minute: i64 = time.get(3..5)?.parse().ok()?;
    let second: i64 = time.get(6..8)?.parse().ok()?;

    // Days from the civil epoch (Howard Hinnant's algorithm), which avoids
    // pulling in a date crate for one field.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(secs * 1_000).ok()
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(lines: &[(LogStream, &str)]) -> BuildLog {
        BuildLog {
            deployment_id: "dpl_1".into(),
            lines: lines
                .iter()
                .map(|(stream, text)| LogLine {
                    at: 0,
                    stream: *stream,
                    text: (*text).to_string(),
                })
                .collect(),
            truncated: false,
        }
    }

    #[test]
    fn the_error_summary_finds_the_actual_failure() {
        let build = log(&[
            (LogStream::Stdout, "Installing dependencies..."),
            (LogStream::Stdout, "Compiling"),
            (LogStream::Stderr, "Error: Cannot find module './missing'"),
            (LogStream::Stdout, "Build failed"),
        ]);
        assert_eq!(
            build.likely_error().as_deref(),
            Some("Build failed"),
            "the last error-shaped line wins, since it is closest to the failure"
        );
    }

    #[test]
    fn the_error_summary_ignores_a_build_that_merely_warned() {
        // The failure mode worth preventing: a successful build that wrote
        // deprecation notices to stderr must not produce a "reason it failed".
        let build = log(&[
            (LogStream::Stderr, "warning: 'foo' is deprecated"),
            (LogStream::Stderr, "Warning: peer dependency unmet"),
            (LogStream::Stdout, "Build completed in 12s"),
        ]);
        assert_eq!(build.likely_error(), None);
    }

    #[test]
    fn the_error_summary_says_nothing_rather_than_guessing() {
        let build = log(&[
            (LogStream::Stdout, "Running build"),
            (LogStream::Stdout, "Done"),
        ]);
        assert_eq!(build.likely_error(), None);

        assert_eq!(log(&[]).likely_error(), None);
    }

    /// The TS mirror in `src/lib/hosting.ts` is written by hand, so a field
    /// renamed here drifts silently: Rust still compiles, TypeScript still
    /// compiles, and the field simply arrives as `undefined` at runtime. That
    /// is exactly how this section spent a day showing a build permalink where
    /// the site's address belonged — the value was real, it was just read from
    /// the wrong key.
    ///
    /// Pinning the exact key set turns a rename into a failing test rather than
    /// a missing row. Update this list and `src/lib/hosting.ts` together.
    #[test]
    fn the_wire_shape_the_frontend_reads_is_pinned() {
        let deployment = Deployment {
            id: "dpl_1".into(),
            status_label: "Ready".into(),
            phase: DeploymentPhase::Ready,
            detail: None,
            environment: Environment::Production,
            branch: Some("main".into()),
            commit_sha: "abc".into(),
            commit_message: Some("Fix the nav".into()),
            urls: DeploymentUrls {
                site: Some("https://example.com".into()),
                deployment: Some("https://abc.example.com".into()),
                aliases: vec![],
                primary: Some("https://example.com".into()),
            },
            dashboard_url: Some("https://vercel.com/x".into()),
            error_message: None,
            created_at: 1,
            ready_at: Some(2),
        };

        let json = serde_json::to_value(&deployment).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "branch",
                "commit_message",
                "commit_sha",
                "created_at",
                "dashboard_url",
                "environment",
                "id",
                "phase",
                "ready_at",
                "status_label",
                "urls",
            ]
        );

        let mut url_keys: Vec<&str> = json["urls"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        url_keys.sort_unstable();
        // `site` and `deployment` are different addresses and are not
        // interchangeable; conflating them is the original defect.
        assert_eq!(url_keys, ["aliases", "deployment", "primary", "site"]);
    }

    #[test]
    fn an_absent_address_is_omitted_rather_than_sent_as_null() {
        // The TS mirror types these as optional. Emitting an explicit null
        // where the frontend expects absence is the kind of mismatch that
        // shows up as a row rendering the word "null".
        let urls = DeploymentUrls::default();
        let json = serde_json::to_value(&urls).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["aliases"]);
    }

    #[test]
    fn terminal_phases_stop_the_fast_poll() {
        assert!(DeploymentPhase::Ready.is_terminal());
        assert!(DeploymentPhase::Failed.is_terminal());
        assert!(DeploymentPhase::Canceled.is_terminal());
        assert!(DeploymentPhase::Skipped.is_terminal());
        assert!(DeploymentPhase::Gated.is_terminal());
        assert!(DeploymentPhase::Unknown { raw: "WAT".into() }.is_terminal());

        assert!(!DeploymentPhase::Queued.is_terminal());
        assert!(!DeploymentPhase::Building.is_terminal());
        assert!(!DeploymentPhase::Publishing.is_terminal());
    }

    #[test]
    fn phase_serializes_with_a_tag_the_frontend_can_switch_on() {
        let json = serde_json::to_string(&DeploymentPhase::Building).unwrap();
        assert_eq!(json, r#"{"phase":"building"}"#);

        let json = serde_json::to_string(&DeploymentPhase::Unknown {
            raw: "SOMETHING_NEW".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"phase":"unknown","raw":"SOMETHING_NEW"}"#);
    }

    #[test]
    fn provider_credential_wiring_matches_the_documented_env_vars() {
        assert_eq!(HostingProvider::Vercel.env_var(), "VERCEL_TOKEN");
        assert_eq!(
            HostingProvider::Cloudflare.env_var(),
            "CLOUDFLARE_API_TOKEN"
        );
        assert_eq!(HostingProvider::Netlify.env_var(), "NETLIFY_AUTH_TOKEN");

        assert_eq!(HostingProvider::Vercel.credential_key(), "vercel_token");
        assert_eq!(
            HostingProvider::Cloudflare.credential_key(),
            "cloudflare_api_token"
        );
        assert_eq!(
            HostingProvider::Netlify.credential_key(),
            "netlify_auth_token"
        );
    }

    #[test]
    fn provider_round_trips_as_a_lowercase_string() {
        let json = serde_json::to_string(&HostingProvider::Cloudflare).unwrap();
        assert_eq!(json, r#""cloudflare""#);
        let back: HostingProvider = serde_json::from_str(&json).unwrap();
        assert_eq!(back, HostingProvider::Cloudflare);
    }

    #[test]
    fn not_found_carries_branch_context_without_claiming_it_is_the_answer() {
        let lookup = Lookup::NotFound {
            latest_on_branch: None,
        };
        let json = serde_json::to_string(&lookup).unwrap();
        assert_eq!(json, r#"{"kind":"not_found"}"#);
    }
}
