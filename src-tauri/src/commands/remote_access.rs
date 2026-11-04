//! Tauri commands behind the Remote access modal. The server, tunnel and
//! power handling live in `crate::remote_access`; this is the UI's view of
//! them, every field read back from the thing it describes.
//!
//! The link's secret never crosses into the webview. Plugins run JavaScript
//! there, and anything a plugin can read it can send somewhere; so the UI is
//! given a masked link, and "Copy link" puts the real one on the clipboard
//! from Rust, marked to stay out of clipboard history, and clears it again
//! shortly after.

use crate::errors::CommandError;
use crate::remote_access::{self, power, tailscale};
use serde::Serialize;
use std::sync::{LazyLock, Mutex};

/// The last Funnel attempt's result, so a "needs approval" link survives the
/// modal re-polling. Cleared whenever the Funnel is confirmed on.
static LAST_FUNNEL: LazyLock<Mutex<Option<tailscale::FunnelOutcome>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub supported: bool,
    pub enabled: bool,
    pub server_running: bool,
    pub tailscale: tailscale::TailscaleState,
    /// Confirmed from `tailscale funnel status`, not from our own command.
    pub funnel_on: bool,
    pub funnel_approval_url: Option<String>,
    pub funnel_error: Option<String>,
    /// The link with its secret masked, present only when the Funnel is
    /// confirmed on. The real link is only ever copied, never returned.
    pub link_masked: Option<String>,
    /// Whether a request through the public internet actually reaches this
    /// server. `None` until the Funnel is on. Only `reachable` is "live".
    pub reachability: Option<tailscale::Reachability>,
    /// How long we've been waiting for the address to go public, and whether
    /// Ship Studio already asked Tailscale again.
    pub publish: remote_access::PublishProgress,
    pub power: power::PowerStatus,
    pub keep_awake: bool,
    pub lid_closed_mode: Option<bool>,
    pub open_at_login: bool,
    pub open_at_login_available: bool,
    pub projects: Vec<String>,
    pub ever_connected: bool,
    pub push_pin: remote_access::PushPinState,
    pub activity: remote_access::Activity,
}

fn connector_url(dns_name: &str, token: &str) -> String {
    format!("https://{dns_name}{}/mcp/{token}", tailscale::MOUNT_PATH)
}

fn mask(dns_name: &str, token: &str) -> String {
    connector_url(
        dns_name,
        &format!("{}••••••••", token.chars().take(4).collect::<String>()),
    )
}

async fn build_status() -> RemoteAccessStatus {
    let config = remote_access::read_config();
    let ts = tailscale::status().await;
    let port = remote_access::running_port();
    let funnel_on = match (&ts, port) {
        (tailscale::TailscaleState::Connected { dns_name }, Some(port)) => {
            tailscale::funnel_active(dns_name, port).await
        }
        _ => false,
    };
    let (link_masked, reachability) = match &ts {
        tailscale::TailscaleState::Connected { dns_name } if funnel_on && config.enabled => (
            Some(mask(dns_name, &config.token)),
            Some(tailscale::public_reachability(dns_name, &config.token).await),
        ),
        _ => (None, None),
    };
    let last = LAST_FUNNEL.lock().ok().and_then(|l| l.clone());
    if funnel_on {
        if let Ok(mut l) = LAST_FUNNEL.lock() {
            *l = None;
        }
    }
    let (funnel_approval_url, funnel_error) = match (funnel_on, last) {
        (false, Some(tailscale::FunnelOutcome::NeedsApproval { url })) => (Some(url), None),
        (false, Some(tailscale::FunnelOutcome::Failed { detail })) => (None, Some(detail)),
        _ => (None, None),
    };
    RemoteAccessStatus {
        supported: cfg!(target_os = "macos"),
        enabled: config.enabled,
        server_running: remote_access::is_running(),
        tailscale: ts,
        funnel_on,
        funnel_approval_url,
        funnel_error,
        link_masked,
        reachability,
        publish: remote_access::publish_progress(),
        power: power::read_power().await,
        keep_awake: power::keep_awake_active(),
        lid_closed_mode: power::lid_closed_mode_active().await,
        open_at_login: power::open_at_login_active(),
        open_at_login_available: power::app_bundle_path().is_some(),
        push_pin: remote_access::push_pin_state(&config),
        projects: config.projects,
        ever_connected: config.ever_connected,
        activity: remote_access::activity(),
    }
}

/// How long the copied link stays on the clipboard before we take it back.
const CLIPBOARD_CLEAR_SECS: u64 = 90;

/// Put the real link on the clipboard. Refused unless the Funnel is live, so
/// a copied link always works.
#[tauri::command]
#[tracing::instrument]
pub async fn copy_remote_link() -> Result<(), CommandError> {
    let config = remote_access::read_config();
    let tailscale::TailscaleState::Connected { dns_name } = tailscale::status().await else {
        return Err(CommandError::expected("Tailscale isn't connected."));
    };
    let live = match remote_access::running_port() {
        Some(port) => tailscale::funnel_active(&dns_name, port).await,
        None => false,
    };
    if !config.enabled || !live {
        return Err(CommandError::expected("The link isn't live right now."));
    }
    let url = connector_url(&dns_name, &config.token);
    let to_set = url.clone();
    tokio::task::spawn_blocking(move || -> Result<(), arboard::Error> {
        let mut clipboard = arboard::Clipboard::new()?;
        #[cfg(target_os = "macos")]
        {
            use arboard::SetExtApple;
            clipboard.set().exclude_from_history().text(to_set)
        }
        #[cfg(not(target_os = "macos"))]
        {
            clipboard.set_text(to_set)
        }
    })
    .await
    .map_err(|e| CommandError::from(format!("clipboard task: {e}")))?
    .map_err(|e| CommandError::from(format!("Couldn't copy the link: {e}")))?;
    // Take it back later — but only if it's still what we put there, so we
    // never clear something the user copied since.
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(CLIPBOARD_CLEAR_SECS)).await;
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                if clipboard.get_text().is_ok_and(|t| t == url) {
                    let _ = clipboard.clear();
                }
            }
        })
        .await;
    });
    Ok(())
}

/// Set the push PIN (turns remote pushing on, and unlocks it).
#[tauri::command]
#[tracing::instrument(skip(pin))]
pub async fn set_remote_push_pin(pin: String) -> Result<RemoteAccessStatus, CommandError> {
    tokio::task::spawn_blocking(move || remote_access::set_push_pin(&pin))
        .await
        .map_err(|e| CommandError::from(format!("pin task: {e}")))??;
    remote_access::audit(
        "push_pin",
        None,
        "push PIN set at the computer".into(),
        true,
    );
    Ok(build_status().await)
}

/// Remove the push PIN (turns remote pushing off).
#[tauri::command]
#[tracing::instrument]
pub async fn clear_remote_push_pin() -> Result<RemoteAccessStatus, CommandError> {
    remote_access::clear_push_pin()?;
    remote_access::audit("push_pin", None, "remote pushing turned off".into(), true);
    Ok(build_status().await)
}

/// The newest remote actions, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn get_remote_audit(
    limit: Option<usize>,
) -> Result<Vec<remote_access::AuditEntry>, CommandError> {
    Ok(remote_access::read_audit(limit.unwrap_or(50).min(500)))
}

/// What the sidebar indicator needs, without asking Tailscale anything: it
/// polls from every window, and the full status spawns the tailscale CLI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessBrief {
    pub enabled: bool,
    pub server_running: bool,
    pub keep_awake: bool,
    pub power: power::PowerStatus,
    pub lid_closed_mode: Option<bool>,
    pub activity: remote_access::Activity,
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_remote_access_brief() -> Result<RemoteAccessBrief, CommandError> {
    let config = remote_access::read_config();
    if !config.enabled {
        return Ok(RemoteAccessBrief {
            enabled: false,
            server_running: false,
            keep_awake: false,
            power: power::PowerStatus::default(),
            lid_closed_mode: None,
            activity: remote_access::Activity::default(),
        });
    }
    Ok(RemoteAccessBrief {
        enabled: true,
        server_running: remote_access::is_running(),
        keep_awake: power::keep_awake_active(),
        power: power::read_power().await,
        lid_closed_mode: power::lid_closed_mode_active().await,
        activity: remote_access::activity(),
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_remote_access_status() -> Result<RemoteAccessStatus, CommandError> {
    Ok(build_status().await)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn set_remote_access_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<RemoteAccessStatus, CommandError> {
    if enabled && !cfg!(target_os = "macos") {
        return Err(CommandError::expected(
            "Remote access is only available on macOS for now.",
        ));
    }
    remote_access::update_config(|c| c.enabled = enabled)?;
    if enabled {
        tailscale::forget_reachability();
        let outcome = remote_access::bring_up(app).await?;
        if let Ok(mut l) = LAST_FUNNEL.lock() {
            *l = Some(outcome);
        }
    } else {
        remote_access::tear_down().await;
        if let Ok(mut l) = LAST_FUNNEL.lock() {
            *l = None;
        }
        // Put the lid setting back if remote access is what changed it. This
        // shows the macOS password prompt; if the user cancels, it stays on
        // and the checklist keeps saying so.
        if remote_access::read_config().lid_mode_by_us
            && power::lid_closed_mode_active().await == Some(true)
        {
            match power::set_lid_closed_mode(false).await {
                Ok(()) => {
                    remote_access::update_config(|c| c.lid_mode_by_us = false)?;
                }
                Err(e) => tracing::warn!("[Remote] Lid-closed mode left on: {}", e),
            }
        }
    }
    Ok(build_status().await)
}

/// Share or unshare one project. The path must be a real project Ship Studio
/// manages — the same check every other project command makes.
#[tauri::command]
#[tracing::instrument]
pub async fn set_remote_project(
    project_path: String,
    shared: bool,
) -> Result<Vec<String>, CommandError> {
    if shared {
        crate::utils::validate_project_path(&project_path)?;
    }
    remote_access::update_config(|c| {
        c.projects.retain(|p| p != &project_path);
        if shared {
            c.projects.push(project_path.clone());
        }
        c.projects.clone()
    })
}

/// Ask Tailscale to publish the address again (Funnel off and on).
#[tauri::command]
#[tracing::instrument]
pub async fn republish_remote_link() -> Result<RemoteAccessStatus, CommandError> {
    let outcome = remote_access::republish().await?;
    if let Ok(mut l) = LAST_FUNNEL.lock() {
        *l = Some(outcome);
    }
    Ok(build_status().await)
}

/// Replace the token. The old connector URL stops working immediately.
#[tauri::command]
#[tracing::instrument]
pub async fn reset_remote_link() -> Result<RemoteAccessStatus, CommandError> {
    remote_access::update_config(|c| {
        c.token = remote_access::new_token();
        // A new link has to be added to the assistant again.
        c.ever_connected = false;
    })?;
    remote_access::clear_pending_push();
    remote_access::shots::clear();
    tailscale::forget_reachability();
    remote_access::audit(
        "new_link",
        None,
        "link replaced; the old one stopped working".into(),
        true,
    );
    Ok(build_status().await)
}

#[tauri::command]
#[tracing::instrument]
pub async fn set_lid_closed_mode(enabled: bool) -> Result<RemoteAccessStatus, CommandError> {
    let was_on = power::lid_closed_mode_active().await == Some(true);
    power::set_lid_closed_mode(enabled).await?;
    // Remember only a change we made, so turning remote access off restores
    // what the user had rather than overriding a setting they chose.
    remote_access::update_config(|c| c.lid_mode_by_us = enabled && !was_on)?;
    Ok(build_status().await)
}

#[tauri::command]
#[tracing::instrument]
pub async fn set_open_at_login(enabled: bool) -> Result<RemoteAccessStatus, CommandError> {
    power::set_open_at_login(enabled)?;
    Ok(build_status().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_masked_link_never_contains_the_secret() {
        let token = "3f9c2a7be1d04c55a9e2f1b7c6d8e9f03f9c2a7be1d04c55a9e2f1b7c6d8e9f0";
        let masked = mask("m.t.ts.net", token);
        assert!(masked.starts_with("https://m.t.ts.net/shipstudio/mcp/3f9c"));
        assert!(!masked.contains(&token[4..12]));
        assert_eq!(
            connector_url("m.t.ts.net", "abc"),
            "https://m.t.ts.net/shipstudio/mcp/abc"
        );
    }
}

/// What keeps agents going on this Mac, as offered in Agents: "Keep this Mac
/// awake" (the same `caffeinate` assertion remote access holds), "Keep running
/// when windows close", and "Open at login" (remote access's own LaunchAgent,
/// one file shared by both). Each is read back from the thing itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StayOn {
    /// macOS only; elsewhere none of this is offered.
    pub supported: bool,
    /// True while the assertion is held, including by remote access.
    pub keep_awake: bool,
    pub keep_running: bool,
    pub open_at_login: bool,
    /// False in a dev build, which has no app bundle to reopen.
    pub open_at_login_available: bool,
}

fn stay_on_now() -> StayOn {
    StayOn {
        supported: cfg!(target_os = "macos"),
        keep_awake: power::keep_awake_active(),
        keep_running: crate::commands::window::keep_running_when_closed(),
        open_at_login: power::open_at_login_active(),
        open_at_login_available: power::app_bundle_path().is_some(),
    }
}

#[tauri::command]
#[tracing::instrument]
pub fn get_stay_on() -> Result<StayOn, CommandError> {
    Ok(stay_on_now())
}

/// Change any of the three; `None` leaves that one as it is.
#[tauri::command]
#[tracing::instrument]
pub fn set_stay_on(
    keep_awake: Option<bool>,
    keep_running: Option<bool>,
    open_at_login: Option<bool>,
) -> Result<StayOn, CommandError> {
    if keep_awake.is_some() || keep_running.is_some() {
        let mut state = crate::commands::setup::read_app_state();
        if keep_awake.is_some() {
            state.keep_awake = keep_awake;
        }
        if keep_running.is_some() {
            state.keep_running_when_closed = keep_running;
        }
        crate::commands::setup::write_app_state(&state)?;
    }
    if let Some(enabled) = keep_awake {
        power::set_keep_awake_asked(enabled, remote_access::read_config().enabled)?;
    }
    if let Some(enabled) = open_at_login {
        power::set_open_at_login(enabled)?;
    }
    Ok(stay_on_now())
}
