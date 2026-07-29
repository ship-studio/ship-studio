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
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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

// --- Cross-session throttle ------------------------------------------------
//
// Each report can trigger a paid agent investigation, so the in-session dedup
// alone isn't enough: a crash-looping install that relaunches every few
// seconds would send one report per relaunch. Persist a small throttle file
// next to app_state.json: the same fingerprint reports at most once per 24h,
// and there's a global daily cap per machine. Any I/O failure fails open to
// the in-session dedup — a broken disk must not disable crash reporting.

/// Same fingerprint reports at most once per this window, across restarts.
const REFRACTORY_SECS: i64 = 24 * 60 * 60;
/// Global daily report cap per machine.
const DAILY_CAP: usize = 30;
/// Bound the throttle file: prune entries older than this…
const PRUNE_AFTER_SECS: i64 = 7 * 24 * 60 * 60;
/// …and never track more fingerprints than this (oldest dropped first).
const MAX_TRACKED_FINGERPRINTS: usize = 300;

#[derive(Default, Serialize, Deserialize)]
struct Throttle {
    #[serde(default)]
    day: String,
    #[serde(default)]
    count: usize,
    /// fingerprint -> unix timestamp of last report
    #[serde(default)]
    fingerprints: HashMap<String, i64>,
}

fn throttle_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/ShipStudio/bug-report-throttle.json"))
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("ShipStudio/bug-report-throttle.json"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir().map(|d| d.join("ship-studio/bug-report-throttle.json"))
    }
}

/// Check + record `key` against the persistent throttle. Corrupt or missing
/// files reset to an empty throttle (fail open); write failures are ignored.
fn passes_persistent_throttle(path: &Path, key: &str, now: i64, today: &str) -> bool {
    let mut throttle: Throttle = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if throttle.day != today {
        throttle.day = today.to_string();
        throttle.count = 0;
    }
    if throttle.count >= DAILY_CAP {
        return false;
    }
    if let Some(&last) = throttle.fingerprints.get(key) {
        if now - last < REFRACTORY_SECS {
            return false;
        }
    }

    throttle.count += 1;
    throttle.fingerprints.insert(key.to_string(), now);
    throttle
        .fingerprints
        .retain(|_, ts| now - *ts < PRUNE_AFTER_SECS);
    if throttle.fingerprints.len() > MAX_TRACKED_FINGERPRINTS {
        let mut by_age: Vec<(String, i64)> = throttle
            .fingerprints
            .iter()
            .map(|(k, ts)| (k.clone(), *ts))
            .collect();
        by_age.sort_by_key(|(_, ts)| *ts);
        for (old_key, _) in by_age
            .iter()
            .take(throttle.fingerprints.len() - MAX_TRACKED_FINGERPRINTS)
        {
            throttle.fingerprints.remove(old_key);
        }
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string(&throttle) {
        let _ = std::fs::write(path, serialized);
    }
    true
}

/// Full send gate: in-session dedup, then the persistent cross-session
/// throttle. Returns true when this occurrence should be reported.
fn allow_report(key: &str) -> bool {
    if !first_occurrence(key) {
        return false;
    }
    let Some(path) = throttle_path() else {
        return true;
    };
    let now = chrono::Utc::now();
    passes_persistent_throttle(
        &path,
        key,
        now.timestamp(),
        &now.format("%Y-%m-%d").to_string(),
    )
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
    if !allow_report(&dedupe_key(message, source, fingerprint)) {
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
    if !allow_report(&dedupe_key(message, "panic", fingerprint.as_deref())) {
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

// --- Tracing integration ---------------------------------------------------

/// Forwards every `tracing::error!` from Ship Studio code to the admin agent,
/// fingerprinted by callsite (`rs-<file>:<line>` — stable across occurrences
/// and releases). Attached in `logging::init_logging()` alongside the Sentry
/// layer, so any error-level log — existing or future — reports automatically
/// without per-site wiring. When something isn't working as intended, log it
/// with `tracing::error!` and the agent hears about it.
pub struct AdminAgentLayer;

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for AdminAgentLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let meta = event.metadata();
        if *meta.level() != tracing::Level::ERROR {
            return;
        }
        let target = meta.target();
        // Only our own code — error logs from dependencies aren't our bugs.
        if !target.starts_with("ship_studio") {
            return;
        }
        // Frontend logger errors arrive via `logging::log_frontend_event`; the
        // frontend reports those itself with proper stacks (`errorReporting.ts`).
        // Skipping here prevents double reports for the same incident.
        if target.starts_with("ship_studio_lib::logging") {
            return;
        }

        let mut visitor = EventVisitor::default();
        event.record(&mut visitor);
        if visitor.message.is_empty() {
            return;
        }
        let fingerprint = match (meta.file(), meta.line()) {
            (Some(file), Some(line)) => Some(format!("rs-{file}:{line}")),
            _ => None,
        };
        let fields = if visitor.fields.is_empty() {
            None
        } else {
            Some(visitor.fields.join("\n"))
        };
        report_error(
            &visitor.message,
            fields.as_deref(),
            target,
            fingerprint.as_deref(),
        );
    }
}

/// Collects the event's `message` field plus remaining fields as `key=value`
/// lines (sent as the report's `stack` for extra context).
#[derive(Default)]
struct EventVisitor {
    message: String,
    fields: Vec<String>,
}

impl tracing::field::Visit for EventVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.push(format!("{}={:?}", field.name(), value));
        }
    }
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
    fn throttle_allows_first_and_blocks_repeat_within_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        let now = 1_000_000;
        assert!(passes_persistent_throttle(&path, "fp-a", now, "2026-07-28"));
        // Same key, next session, one hour later: blocked.
        assert!(!passes_persistent_throttle(
            &path,
            "fp-a",
            now + 3_600,
            "2026-07-28"
        ));
        // Different key still allowed.
        assert!(passes_persistent_throttle(
            &path,
            "fp-b",
            now + 3_600,
            "2026-07-28"
        ));
        // Same key after the 24h window: allowed again.
        assert!(passes_persistent_throttle(
            &path,
            "fp-a",
            now + REFRACTORY_SECS + 1,
            "2026-07-29"
        ));
    }

    #[test]
    fn throttle_enforces_daily_cap_and_resets_next_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        let now = 1_000_000;
        for i in 0..DAILY_CAP {
            assert!(passes_persistent_throttle(
                &path,
                &format!("fp-{i}"),
                now,
                "2026-07-28"
            ));
        }
        assert!(!passes_persistent_throttle(
            &path,
            "fp-over-cap",
            now,
            "2026-07-28"
        ));
        // New day: cap resets.
        assert!(passes_persistent_throttle(
            &path,
            "fp-over-cap",
            now + REFRACTORY_SECS + 1,
            "2026-07-29"
        ));
    }

    #[test]
    fn throttle_fails_open_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("throttle.json");
        std::fs::write(&path, "not json{{{").unwrap();
        assert!(passes_persistent_throttle(
            &path,
            "fp-a",
            1_000_000,
            "2026-07-28"
        ));
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
