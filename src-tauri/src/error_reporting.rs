//! # Automatic Error Reporting
//!
//! Sends error reports to the Ship Studio admin agent
//! (<https://shipstudio-admin-agent.vercel.app>), which investigates them
//! against the codebase, files deduplicated GitHub issues, and can open draft
//! fix PRs. See `docs/error-reporting.md` for the full integration contract.
//!
//! This complements Sentry (aggregation/alerting); the admin agent is the
//! act-on-it pipeline. Rules enforced here:
//!
//! - **Production builds only** — dev-loop noise never reaches the agent
//!   (override with `SHIPSTUDIO_BUG_REPORT_FORCE=1` for integration testing).
//! - **Secret stays in Rust** — injected at build time via
//!   `option_env!("BUG_REPORT_SECRET")`; builds without it are a silent no-op.
//! - **Fire-and-forget** — reporting can never block or fail the UX.
//! - **One report per fingerprint per app session** — the server dedups too,
//!   but we don't hammer it from tight error loops.
//! - **No PII** — messages and stacks are scrubbed of home-dir paths
//!   (usernames, project folder names) before leaving the machine, since
//!   reports can end up in public GitHub issues.

use crate::logging::scrub_string;
use once_cell::sync::Lazy;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

const ENDPOINT: &str = "https://shipstudio-admin-agent.vercel.app/report";
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// Hard cap on reports per app session — a pathological error loop with
/// varying messages (which defeat fingerprint dedup) stops here.
const MAX_REPORTS_PER_SESSION: usize = 25;

/// Dedup keys already reported this app session.
static REPORTED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn enabled() -> bool {
    let force = std::env::var("SHIPSTUDIO_BUG_REPORT_FORCE").ok().as_deref() == Some("1");
    !cfg!(debug_assertions) || force
}

fn secret() -> Option<&'static str> {
    option_env!("BUG_REPORT_SECRET").filter(|s| !s.is_empty())
}

/// Stable per-session dedup key: the explicit fingerprint when the catch-site
/// provides one, otherwise source + the first line of the message.
fn dedupe_key(message: &str, source: &str, fingerprint: Option<&str>) -> String {
    match fingerprint {
        Some(f) => f.to_string(),
        None => {
            let first_line = message.lines().next().unwrap_or_default();
            let truncated: String = first_line.chars().take(200).collect();
            format!("{source}:{truncated}")
        }
    }
}

/// Returns true only the first time a key is seen this session.
fn first_occurrence(key: &str) -> bool {
    match REPORTED.lock() {
        Ok(mut seen) => {
            if seen.len() >= MAX_REPORTS_PER_SESSION {
                return false;
            }
            seen.insert(key.to_string())
        }
        // Poisoned lock (a panic mid-insert): stop reporting rather than risk
        // duplicate storms.
        Err(_) => false,
    }
}

fn build_body(
    message: &str,
    stack: Option<&str>,
    source: &str,
    fingerprint: Option<&str>,
) -> serde_json::Value {
    json!({
        "message": scrub_string(message),
        "stack": stack.map(scrub_string),
        "source": source,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "fingerprint": fingerprint,
        "context": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
    })
}

async fn post(secret: &'static str, body: serde_json::Value) {
    let _ = reqwest::Client::new()
        .post(ENDPOINT)
        .bearer_auth(secret)
        .json(&body)
        .timeout(SEND_TIMEOUT)
        .send()
        .await;
}

/// Report an error to the admin agent. Fire-and-forget: returns immediately,
/// never blocks, never surfaces a failure.
///
/// Call this from `Err` branches at known catch-sites with a stable
/// `fingerprint` slug (e.g. `"cmd-publish_to_staging"`) so repeat occurrences
/// land on the agent's existing session instead of filing duplicate issues.
pub fn report_error(message: &str, stack: Option<&str>, source: &str, fingerprint: Option<&str>) {
    if !enabled() {
        return;
    }
    let Some(secret) = secret() else { return };
    if !first_occurrence(&dedupe_key(message, source, fingerprint)) {
        return;
    }
    let body = build_body(message, stack, source, fingerprint);
    tauri::async_runtime::spawn(async move {
        post(secret, body).await;
    });
}

/// Panic-path variant: sends synchronously (bounded by [`SEND_TIMEOUT`])
/// because the process may be about to die and a spawned task would be lost.
fn report_panic(message: &str, location: Option<&str>) {
    if !enabled() {
        return;
    }
    let Some(secret) = secret() else { return };
    let fingerprint = location.map(|l| format!("panic-{}", scrub_string(l)));
    if !first_occurrence(&dedupe_key(message, "panic", fingerprint.as_deref())) {
        return;
    }
    let body = build_body(
        &format!("panic: {message}"),
        location,
        "panic",
        fingerprint.as_deref(),
    );
    // Dedicated thread + single-threaded runtime: the panic hook can fire on
    // any thread, including inside an async context where block_on would panic.
    let handle = std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            rt.block_on(post(secret, body));
        }
    });
    let _ = handle.join();
}

/// Install a panic hook that reports to the admin agent, chaining the
/// previously installed hook (Sentry's, when initialized) so both fire.
/// Call after `logging::init_sentry()`.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic with non-string payload".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        report_panic(&message, location.as_deref());
        prev(info);
    }));
}

/// Forward an uncaught frontend error (ErrorBoundary, window.onerror,
/// unhandledrejection) to the admin agent. The frontend gates on production
/// and dedups per fingerprint too; this side re-checks both and scrubs paths.
#[tauri::command]
#[tracing::instrument(skip_all)]
pub fn report_frontend_error(
    message: String,
    stack: Option<String>,
    source: Option<String>,
    fingerprint: Option<String>,
) {
    report_error(
        &message,
        stack.as_deref(),
        source.as_deref().unwrap_or("frontend"),
        fingerprint.as_deref(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_key_prefers_explicit_fingerprint() {
        assert_eq!(
            dedupe_key(
                "anything at all",
                "publishing",
                Some("publish-staging-io-error")
            ),
            "publish-staging-io-error"
        );
    }

    #[test]
    fn dedupe_key_falls_back_to_source_and_first_line() {
        let key = dedupe_key("boom happened\n    at some_frame:12", "frontend", None);
        assert_eq!(key, "frontend:boom happened");
    }

    #[test]
    fn dedupe_key_truncates_long_messages() {
        let long = "x".repeat(500);
        let key = dedupe_key(&long, "frontend", None);
        assert_eq!(key.len(), "frontend:".len() + 200);
    }

    #[test]
    fn first_occurrence_dedups_within_session() {
        let key = "test-unique-fingerprint-for-dedup";
        assert!(first_occurrence(key));
        assert!(!first_occurrence(key));
    }

    #[test]
    fn body_scrubs_home_dir_paths() {
        let body = build_body(
            "ENOENT: /Users/julian/ShipStudio/my-app/package.json",
            Some("at load (/Users/julian/ShipStudio/my-app/src/index.ts:1:1)"),
            "frontend",
            None,
        );
        let text = body.to_string();
        assert!(!text.contains("julian"), "username leaked: {text}");
        assert!(text.contains("/Users/<redacted>"));
    }
}
