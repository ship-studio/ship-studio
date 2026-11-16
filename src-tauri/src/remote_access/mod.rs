//! # Remote access
//!
//! Lets a chat assistant on the user's phone (Grok Bot first; anything that
//! speaks MCP) drive the Ship Studio running on their own Mac: read what an
//! agent tab is showing, answer it, start a new agent, look at the preview,
//! and — with a confirmation step — push.
//!
//! The shape, and why:
//!
//! - **An MCP server, not SSH.** The work keeps happening in the same agent
//!   tabs the user left, so when they sit back down the conversation is right
//!   there. A shell would start a second, parallel session instead.
//! - **The user's own tunnel.** Tailscale Funnel on their own account
//!   publishes the server. Nothing passes through infrastructure we run, so
//!   there is nothing of ours to breach and nothing for us to be liable for.
//! - **A narrow surface.** Only opted-in projects are visible. Text goes only
//!   to agent tabs, never to plain shell tabs. A push takes two calls with a
//!   summary between them, bound to the exact commit and changes summarised.
//! - **The machine has to be on.** Most of this module and its UI exist to
//!   make that true for as long as possible and to say plainly when it isn't.
//!
//! Full design: `docs/remote-access.md`.

mod agent_state;
mod deploy;
pub mod power;
pub mod screen;
mod server;
pub mod shots;
pub mod tailscale;
mod tools;

use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};

pub use server::{is_running, running_port, start_server, stop_server};

// ============================================================================
// Persisted settings
// ============================================================================

/// What the user chose, in its own owner-only file next to app_state.json —
/// same reasoning as the agent bridge's identity file: app_state.json is
/// read-modify-written by many writers, and this one holds a credential.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub token: String,
    pub port: Option<u16>,
    /// Project paths the remote may see, exactly as the dashboard knows them.
    pub projects: Vec<String>,
    /// An authenticated client has reached the server at least once with the
    /// current link. This — not "the link exists" — is what finishes setup,
    /// so it survives restarts and is cleared when the link is replaced.
    pub ever_connected: bool,
    /// Salted, stretched hash of the push PIN. `None` = remote pushing off.
    pub push_pin_hash: Option<String>,
    pub push_pin_salt: Option<String>,
    /// Wrong PINs in a row. At [`PUSH_MAX_FAILURES`] pushing locks.
    pub push_failures: u8,
    /// Lid-closed mode was switched on from Remote access, so turning remote
    /// access off should switch it back. Never set when the user had it on
    /// already — we only undo what we did.
    pub lid_mode_by_us: bool,
}

static CONFIG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn config_path() -> Option<std::path::PathBuf> {
    crate::commands::setup::get_app_state_path()
        .parent()
        .map(|dir| dir.join("remote_access.json"))
}

pub fn read_config() -> RemoteConfig {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_config(config: &RemoteConfig) -> Result<(), CommandError> {
    let path = config_path().ok_or_else(|| CommandError::expected("No home folder."))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| CommandError::from(format!("serialize remote config: {e}")))?;
    write_private(&path, json.as_bytes())?;
    Ok(())
}

/// Write a file only its owner can read. Created 0600 rather than chmod-ed
/// after, so the token is never briefly world-readable.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Read-modify-write the config under one lock.
pub fn update_config<T>(f: impl FnOnce(&mut RemoteConfig) -> T) -> Result<T, CommandError> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| format!("remote config lock poisoned: {e}"))?;
    let mut config = read_config();
    let out = f(&mut config);
    write_config(&config)?;
    Ok(out)
}

/// 256 bits from the OS RNG, hex.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    // The OS CSPRNG. If it's unavailable there's no safe token to mint, and
    // a predictable one would be worse than refusing to start.
    getrandom::getrandom(&mut bytes).expect("the OS random number generator is unavailable");
    hex::encode(bytes)
}

/// The token, minting one on first use.
pub fn ensure_token() -> Result<String, CommandError> {
    update_config(|c| {
        if c.token.len() < 32 {
            c.token = new_token();
        }
        c.token.clone()
    })
}

/// Is `project_path` one the user opted in?
pub fn project_allowed(config: &RemoteConfig, project_path: &str) -> bool {
    config.projects.iter().any(|p| p == project_path)
}

// ============================================================================
// Activity — what the user sees as proof the connector actually works
// ============================================================================

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Unix ms of the last authenticated request.
    pub last_request_ms: Option<u64>,
    /// `clientInfo.name` from the last `initialize`, as the client reported it.
    pub last_client: Option<String>,
    /// Requests that reached the server without a valid token, this run.
    pub rejected_requests: u64,
}

static ACTIVITY: LazyLock<Mutex<Activity>> = LazyLock::new(|| Mutex::new(Activity::default()));

pub fn activity() -> Activity {
    ACTIVITY.lock().map(|a| a.clone()).unwrap_or_default()
}

pub(crate) fn record_request(client: Option<String>) {
    if let Ok(mut a) = ACTIVITY.lock() {
        a.last_request_ms = Some(now_ms());
        if client.is_some() {
            a.last_client = client;
        }
    }
    // Written once per link, not per request.
    if !read_config().ever_connected {
        if let Err(e) = update_config(|c| c.ever_connected = true) {
            tracing::warn!("[Remote] Could not record the first connection: {}", e);
        }
    }
}

pub(crate) fn record_rejected() {
    if let Ok(mut a) = ACTIVITY.lock() {
        a.rejected_requests += 1;
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// Audit log — what the remote did, for the person who comes back to it
// ============================================================================

/// One remote action. Written for a person reading it later: which tool,
/// which project, a short preview of what was typed, and whether it worked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at_ms: u64,
    pub tool: String,
    pub project: Option<String>,
    pub detail: String,
    pub ok: bool,
}

/// Keep the log to a size anyone would read: past this it is cut to its
/// newer half.
const AUDIT_MAX_BYTES: u64 = 1024 * 1024;
const AUDIT_PREVIEW_CHARS: usize = 140;

fn audit_path() -> Option<std::path::PathBuf> {
    config_path().map(|p| p.with_file_name("remote_audit.jsonl"))
}

static AUDIT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A one-line preview of user-supplied text for the log.
pub(crate) fn preview(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= AUDIT_PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(AUDIT_PREVIEW_CHARS).collect();
    format!("{cut}…")
}

pub(crate) fn audit(tool: &str, project: Option<&str>, detail: String, ok: bool) {
    let entry = AuditEntry {
        at_ms: now_ms(),
        tool: tool.to_string(),
        project: project.map(str::to_string),
        detail,
        ok,
    };
    let Some(path) = audit_path() else { return };
    let Ok(_guard) = AUDIT_LOCK.lock() else {
        return;
    };
    let Ok(mut line) = serde_json::to_string(&entry) else {
        return;
    };
    line.push('\n');
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > AUDIT_MAX_BYTES) {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = existing.lines().collect();
            let keep = lines[lines.len() / 2..].join("\n") + "\n";
            let _ = write_private(&path, keep.as_bytes());
        }
    }
    let result = {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
    };
    if let Err(e) = result {
        tracing::warn!("[Remote] Could not write the audit log: {}", e);
    }
}

/// The newest `limit` entries, newest first.
pub fn read_audit(limit: usize) -> Vec<AuditEntry> {
    let Some(raw) = audit_path().and_then(|p| std::fs::read_to_string(p).ok()) else {
        return Vec::new();
    };
    raw.lines()
        .rev()
        .filter_map(|l| serde_json::from_str(l).ok())
        .take(limit)
        .collect()
}

// ============================================================================
// Pushing: a PIN only the user knows
// ============================================================================
//
// The remote assistant reads terminal output, and terminal output can contain
// text written by anyone — a web page the agent fetched, a dependency's
// README. If confirming a push needed only something the assistant had seen
// (a code in a tool result), injected text could tell it to confirm. So the
// confirmation is a PIN the user set on this Mac and types into the chat
// themselves. It is never sent to the assistant, stored only as a salted,
// stretched hash, and five wrong tries switch remote pushing off until the
// user sets a new PIN at the computer.

/// How long a push summary stays confirmable.
const PUSH_TTL_MS: u64 = 10 * 60 * 1000;
/// Wrong PINs, in a row, before remote pushing locks.
pub const PUSH_MAX_FAILURES: u8 = 5;
const PIN_STRETCH_ROUNDS: u32 = 200_000;

/// Hash a PIN with its salt. Stretched so that a copy of the config file
/// doesn't give up a short PIN instantly.
pub(crate) fn hash_pin(salt: &str, pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::digest(format!("{salt}:{pin}").as_bytes());
    for _ in 0..PIN_STRETCH_ROUNDS {
        let mut h = Sha256::new();
        h.update(salt.as_bytes());
        h.update(digest);
        digest = h.finalize();
    }
    hex::encode(digest)
}

/// 6 to 12 digits, and not something trivially guessable.
pub fn validate_pin(pin: &str) -> Result<(), CommandError> {
    let bad = |reason: &str| CommandError::Validation {
        field: "pin".into(),
        reason: reason.into(),
    };
    if !(6..=12).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad("Use 6 to 12 digits."));
    }
    let bytes = pin.as_bytes();
    let all_same = bytes.iter().all(|b| *b == bytes[0]);
    let ascending = bytes.windows(2).all(|w| w[1] == w[0] + 1);
    let descending = bytes.windows(2).all(|w| w[0] == w[1] + 1);
    if all_same || ascending || descending {
        return Err(bad("That PIN is too easy to guess."));
    }
    Ok(())
}

/// Set (or replace) the push PIN. Also clears any lockout.
pub fn set_push_pin(pin: &str) -> Result<(), CommandError> {
    validate_pin(pin)?;
    let salt = new_token();
    let hash = hash_pin(&salt, pin);
    update_config(|c| {
        c.push_pin_salt = Some(salt);
        c.push_pin_hash = Some(hash);
        c.push_failures = 0;
    })?;
    clear_pending_push();
    Ok(())
}

/// Turn remote pushing off entirely.
pub fn clear_push_pin() -> Result<(), CommandError> {
    update_config(|c| {
        c.push_pin_salt = None;
        c.push_pin_hash = None;
        c.push_failures = 0;
    })?;
    clear_pending_push();
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PushPinState {
    /// No PIN: remote pushing is off.
    NotSet,
    Set,
    /// Too many wrong PINs; off until a new PIN is set at the computer.
    Locked,
}

pub fn push_pin_state(config: &RemoteConfig) -> PushPinState {
    match (
        &config.push_pin_hash,
        config.push_failures >= PUSH_MAX_FAILURES,
    ) {
        (None, _) => PushPinState::NotSet,
        (Some(_), true) => PushPinState::Locked,
        (Some(_), false) => PushPinState::Set,
    }
}

/// A push the remote has been shown the summary of. Bound to the exact
/// commit and working-tree state summarised: if either changes before
/// confirmation, the confirmation is refused, so what gets pushed is always
/// what was described.
#[derive(Debug, Clone)]
pub(crate) struct PendingPush {
    pub project_path: String,
    /// The branch the summary named — what gets pushed to, whatever is
    /// checked out by the time the PIN arrives.
    pub branch: String,
    pub head: String,
    /// The git tree the working copy would commit as (see
    /// `tools::frozen_tree`): an exact content hash of everything summarised.
    pub tree_fingerprint: String,
    pub created_ms: u64,
}

static PENDING_PUSH: LazyLock<Mutex<Option<PendingPush>>> = LazyLock::new(|| Mutex::new(None));
/// Serialises PIN checks so parallel guesses can't race the failure counter.
static PIN_CHECK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

pub(crate) fn set_pending_push(push: PendingPush) {
    if let Ok(mut p) = PENDING_PUSH.lock() {
        *p = Some(push);
    }
}

pub(crate) fn clear_pending_push() {
    if let Ok(mut p) = PENDING_PUSH.lock() {
        *p = None;
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PushCheck {
    Ok,
    NoPin,
    Locked,
    NothingPending,
    Expired,
    WrongPin { attempts_left: u8 },
    Changed,
}

/// Everything a confirmation is decided on, with no I/O.
pub(crate) struct PushAttempt<'a> {
    pub project_path: &'a str,
    pub has_pin: bool,
    pub failures: u8,
    pub pending: Option<&'a PendingPush>,
    pub pin_matches: bool,
    pub head: &'a str,
    pub tree_fingerprint: &'a str,
    pub now: u64,
}

/// The rules, in order. A wrong PIN is counted before anything about the
/// pending push is revealed, and a lockout beats everything.
pub(crate) fn decide_push(a: &PushAttempt) -> PushCheck {
    if !a.has_pin {
        return PushCheck::NoPin;
    }
    if a.failures >= PUSH_MAX_FAILURES {
        return PushCheck::Locked;
    }
    let Some(pending) = a.pending.filter(|p| p.project_path == a.project_path) else {
        return PushCheck::NothingPending;
    };
    if a.now.saturating_sub(pending.created_ms) > PUSH_TTL_MS {
        return PushCheck::Expired;
    }
    if !a.pin_matches {
        let failures = a.failures.saturating_add(1);
        return if failures >= PUSH_MAX_FAILURES {
            PushCheck::Locked
        } else {
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - failures,
            }
        };
    }
    if pending.head != a.head || pending.tree_fingerprint != a.tree_fingerprint {
        return PushCheck::Changed;
    }
    PushCheck::Ok
}

/// Check a confirmation and apply its consequences: count a wrong PIN, reset
/// the count on a right one, and consume the pending push on anything final.
pub(crate) async fn check_push(
    project_path: &str,
    pin: &str,
    head: &str,
    tree_fingerprint: &str,
    now: u64,
) -> (PushCheck, Option<PendingPush>) {
    let _serial = PIN_CHECK.lock().await;
    let config = read_config();
    let pending = PENDING_PUSH.lock().ok().and_then(|p| p.clone());
    let pin_matches = match (&config.push_pin_salt, &config.push_pin_hash) {
        (Some(salt), Some(expected)) => {
            let (salt, pin) = (salt.clone(), pin.trim().to_string());
            let given = tokio::task::spawn_blocking(move || hash_pin(&salt, &pin))
                .await
                .unwrap_or_default();
            server::constant_time_eq(given.as_bytes(), expected.as_bytes())
        }
        _ => false,
    };
    let result = decide_push(&PushAttempt {
        project_path,
        has_pin: config.push_pin_hash.is_some(),
        failures: config.push_failures,
        pending: pending.as_ref(),
        pin_matches,
        head,
        tree_fingerprint,
        now,
    });
    match result {
        PushCheck::WrongPin { .. } | PushCheck::Locked if !pin_matches => {
            let _ = update_config(|c| c.push_failures = c.push_failures.saturating_add(1));
        }
        PushCheck::Ok | PushCheck::Changed if config.push_failures > 0 => {
            let _ = update_config(|c| c.push_failures = 0);
        }
        _ => {}
    }
    if matches!(
        result,
        PushCheck::Ok | PushCheck::Changed | PushCheck::Expired | PushCheck::Locked
    ) {
        clear_pending_push();
    }
    let confirmed = (result == PushCheck::Ok).then_some(pending).flatten();
    (result, confirmed)
}

// ============================================================================
// Lifecycle
// ============================================================================

/// Bring everything up for an enabled config: server, keep-awake, Funnel.
/// Each piece is reported separately by the status command, so a Funnel that
/// needs approval doesn't stop the rest from running.
pub async fn bring_up(app: tauri::AppHandle) -> Result<tailscale::FunnelOutcome, CommandError> {
    ensure_token()?;
    let port = start_server(app).await?;
    power::start_keep_awake()?;
    let outcome = match tailscale::status().await {
        tailscale::TailscaleState::Connected { .. } => tailscale::enable_funnel(port).await,
        tailscale::TailscaleState::NotInstalled => tailscale::FunnelOutcome::Failed {
            detail: "Tailscale isn't installed.".to_string(),
        },
        tailscale::TailscaleState::NeedsLogin => tailscale::FunnelOutcome::Failed {
            detail: "Sign in to Tailscale first.".to_string(),
        },
        tailscale::TailscaleState::Unknown { detail } => {
            tailscale::FunnelOutcome::Failed { detail }
        }
    };
    if outcome == tailscale::FunnelOutcome::On {
        start_publish_watch(port);
    }
    Ok(outcome)
}

/// Take everything down. The Funnel goes first so nothing new arrives while
/// the server stops.
pub async fn tear_down() {
    stop_publish_watch();
    shots::clear();
    if tailscale::find_binary().is_some() {
        if let Err(e) = tailscale::disable_funnel().await {
            tracing::warn!("[Remote] Could not remove the Funnel: {}", e);
        }
    }
    stop_server();
    power::stop_keep_awake();
}

// ============================================================================
// Publishing — getting from "Funnel on" to "the internet can reach it"
// ============================================================================
//
// A real first run sat with Funnel on and Tailscale's public DNS holding no
// record for the machine, and the user had nothing to press. So once the
// Funnel is on, a watchdog checks the public path; if the address still isn't
// published after a few minutes it asks Tailscale again (Funnel off and on)
// once, by itself, and it keeps the timeline so the UI can say how long it
// has been and what was tried. The user can also ask again at any time.

/// How long to wait before asking Tailscale again on the user's behalf.
const AUTO_REPUBLISH_AFTER: std::time::Duration = std::time::Duration::from_secs(2 * 60);
/// How long the watchdog keeps checking before leaving it to the user.
const PUBLISH_WATCH_FOR: std::time::Duration = std::time::Duration::from_secs(20 * 60);
const PUBLISH_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishProgress {
    /// When the Funnel was (last) turned on and we started waiting, Unix ms.
    pub since_ms: Option<u64>,
    /// Ship Studio already asked Tailscale again by itself.
    pub auto_retried: bool,
    /// The watchdog gave up waiting; it's over to the user.
    pub gave_up: bool,
}

struct PublishWatch {
    progress: PublishProgress,
    generation: u64,
}

static PUBLISH: LazyLock<Mutex<PublishWatch>> = LazyLock::new(|| {
    Mutex::new(PublishWatch {
        progress: PublishProgress::default(),
        generation: 0,
    })
});

pub fn publish_progress() -> PublishProgress {
    PUBLISH
        .lock()
        .map(|p| p.progress.clone())
        .unwrap_or_default()
}

fn stop_publish_watch() {
    if let Ok(mut p) = PUBLISH.lock() {
        p.generation += 1;
        p.progress = PublishProgress::default();
    }
}

/// Start (or restart) waiting for the public address. Each start bumps a
/// generation number, so an older watchdog notices and stops.
fn start_publish_watch(port: u16) {
    let generation = {
        let Ok(mut p) = PUBLISH.lock() else { return };
        p.generation += 1;
        p.progress = PublishProgress {
            since_ms: Some(now_ms()),
            auto_retried: false,
            gave_up: false,
        };
        p.generation
    };
    tailscale::forget_reachability();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            tokio::time::sleep(PUBLISH_CHECK_EVERY).await;
            let current = PUBLISH.lock().map(|p| p.generation).unwrap_or(0);
            if current != generation {
                return;
            }
            let tailscale::TailscaleState::Connected { dns_name } = tailscale::status().await
            else {
                continue;
            };
            let token = read_config().token;
            if tailscale::public_reachability(&dns_name, &token).await
                == tailscale::Reachability::Reachable
            {
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.since_ms = None;
                    }
                }
                tracing::info!("[Remote] Reachable from the internet");
                return;
            }
            let auto_retried = publish_progress().auto_retried;
            if !auto_retried && started.elapsed() >= AUTO_REPUBLISH_AFTER {
                tracing::warn!("[Remote] Still not published; asking Tailscale again");
                let _ = tailscale::disable_funnel().await;
                let outcome = tailscale::enable_funnel(port).await;
                tailscale::forget_reachability();
                audit(
                    "republish",
                    None,
                    format!("asked Tailscale to publish the address again ({outcome:?})"),
                    outcome == tailscale::FunnelOutcome::On,
                );
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.auto_retried = true;
                    }
                }
            }
            if started.elapsed() >= PUBLISH_WATCH_FOR {
                if let Ok(mut p) = PUBLISH.lock() {
                    if p.generation == generation {
                        p.progress.gave_up = true;
                    }
                }
                return;
            }
        }
    });
}

/// Ask Tailscale to publish the address again: Funnel off, Funnel on, and
/// start waiting afresh. What "Ask Tailscale again" does.
pub async fn republish() -> Result<tailscale::FunnelOutcome, CommandError> {
    let port =
        running_port().ok_or_else(|| CommandError::expected("Remote access isn't running."))?;
    let _ = tailscale::disable_funnel().await;
    let outcome = tailscale::enable_funnel(port).await;
    if outcome == tailscale::FunnelOutcome::On {
        start_publish_watch(port);
    }
    audit(
        "republish",
        None,
        "asked Tailscale to publish the address again".into(),
        outcome == tailscale::FunnelOutcome::On,
    );
    Ok(outcome)
}

/// Called at launch: if the user left remote access on, put it back.
pub async fn resume_on_launch(app: tauri::AppHandle) {
    if !read_config().enabled {
        return;
    }
    match bring_up(app).await {
        Ok(outcome) => tracing::info!(?outcome, "[Remote] Resumed remote access at launch"),
        Err(e) => tracing::error!("[Remote] Could not resume remote access: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_must_be_digits_and_not_obvious() {
        assert!(validate_pin("482915").is_ok());
        assert!(validate_pin("12345").is_err(), "too short");
        assert!(validate_pin("1234567890123").is_err(), "too long");
        assert!(validate_pin("48a915").is_err());
        assert!(validate_pin("000000").is_err());
        assert!(validate_pin("123456").is_err());
        assert!(validate_pin("987654").is_err());
    }

    #[test]
    fn pin_hashes_depend_on_salt_and_pin() {
        let a = hash_pin("salt-a", "482915");
        assert_eq!(a, hash_pin("salt-a", "482915"));
        assert_ne!(a, hash_pin("salt-b", "482915"));
        assert_ne!(a, hash_pin("salt-a", "482916"));
        assert!(!a.contains("482915"));
    }

    fn pending() -> PendingPush {
        PendingPush {
            project_path: "/p".into(),
            branch: "main".into(),
            head: "abc".into(),
            tree_fingerprint: "t1".into(),
            created_ms: 1_000,
        }
    }

    fn attempt<'a>(pending: Option<&'a PendingPush>) -> PushAttempt<'a> {
        PushAttempt {
            project_path: "/p",
            has_pin: true,
            failures: 0,
            pending,
            pin_matches: true,
            head: "abc",
            tree_fingerprint: "t1",
            now: 2_000,
        }
    }

    #[test]
    fn push_rules() {
        let p = pending();
        assert_eq!(decide_push(&attempt(Some(&p))), PushCheck::Ok);
        assert_eq!(
            decide_push(&PushAttempt {
                has_pin: false,
                ..attempt(Some(&p))
            }),
            PushCheck::NoPin
        );
        assert_eq!(decide_push(&attempt(None)), PushCheck::NothingPending);
        assert_eq!(
            decide_push(&PushAttempt {
                project_path: "/other",
                ..attempt(Some(&p))
            }),
            PushCheck::NothingPending
        );
        assert_eq!(
            decide_push(&PushAttempt {
                now: 1_000 + PUSH_TTL_MS + 1,
                ..attempt(Some(&p))
            }),
            PushCheck::Expired
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                ..attempt(Some(&p))
            }),
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - 1
            }
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                failures: PUSH_MAX_FAILURES - 1,
                ..attempt(Some(&p))
            }),
            PushCheck::Locked,
            "the last allowed wrong PIN locks"
        );
        assert_eq!(
            decide_push(&PushAttempt {
                failures: PUSH_MAX_FAILURES,
                ..attempt(Some(&p))
            }),
            PushCheck::Locked,
            "locked even with the right PIN"
        );
        assert_eq!(
            decide_push(&PushAttempt {
                head: "def",
                ..attempt(Some(&p))
            }),
            PushCheck::Changed
        );
        assert_eq!(
            decide_push(&PushAttempt {
                tree_fingerprint: "t2",
                ..attempt(Some(&p))
            }),
            PushCheck::Changed
        );
        assert_eq!(
            decide_push(&PushAttempt {
                pin_matches: false,
                head: "def",
                ..attempt(Some(&p))
            }),
            PushCheck::WrongPin {
                attempts_left: PUSH_MAX_FAILURES - 1
            },
            "a wrong PIN learns nothing about the project"
        );
    }

    #[test]
    fn pin_state_follows_the_config() {
        let mut c = RemoteConfig::default();
        assert_eq!(push_pin_state(&c), PushPinState::NotSet);
        c.push_pin_hash = Some("h".into());
        assert_eq!(push_pin_state(&c), PushPinState::Set);
        c.push_failures = PUSH_MAX_FAILURES;
        assert_eq!(push_pin_state(&c), PushPinState::Locked);
    }

    #[test]
    fn previews_are_one_short_line() {
        assert_eq!(preview("fix\n  the   header"), "fix the header");
        let long = "x".repeat(500);
        let p = preview(&long);
        assert_eq!(p.chars().count(), AUDIT_PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let a = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, new_token());
    }
}
