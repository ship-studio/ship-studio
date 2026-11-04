//! The Phone panel's commands: turn the companion on, show a pairing code,
//! Allow or Deny a phone, and see or remove paired devices. The server
//! itself is `crate::companion`.

use serde::Serialize;
use tauri::AppHandle;

use crate::companion::{actor_for, desktop, now_ms, pairing::PairingView, wire};
use crate::errors::CommandError;
use crate::remote_access::tailscale;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub enabled: bool,
    /// The loopback server is up.
    pub running: bool,
    /// The tailnet route, as read back from Tailscale.
    pub serve: desktop::ServeState,
    pub tailscale: tailscale::TailscaleState,
    pub devices: Vec<wire::Device>,
    pub pairing: PairingView,
    /// Each device's latest action, by device id (absent: none recorded).
    pub activity: std::collections::HashMap<String, PhoneActivity>,
    /// What a paired phone can call on this Mac (`welcome.methods`).
    pub methods: Vec<&'static str>,
    /// Phone notifications through the push relay.
    pub push: crate::companion::push::PushView,
}

/// One line of a phone's audit trail: what it did, and when.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneActivity {
    pub tool: String,
    pub detail: String,
    pub ok: bool,
    pub at_ms: u64,
}

/// Audit lines that are presence or pairing, not something the phone did
/// (connecting is already "Connected now" / "Last seen"). `agents.focus` is a
/// chat coming on screen, logged often and saying little.
const NOT_ACTIVITY: &[&str] = &[
    "connected",
    "refused",
    "pair_request",
    "paired",
    "pair_denied",
    "pair_timeout",
    "revoked",
    "agents.focus",
];

fn activity(devices: &[wire::Device]) -> std::collections::HashMap<String, PhoneActivity> {
    let actors: Vec<String> = devices.iter().map(|d| actor_for(&d.name)).collect();
    let mut latest = crate::remote_access::latest_by_actor(&actors, NOT_ACTIVITY);
    devices
        .iter()
        .filter_map(|d| {
            let e = latest.remove(&actor_for(&d.name))?;
            Some((
                d.id.clone(),
                PhoneActivity {
                    tool: e.tool,
                    detail: e.detail,
                    ok: e.ok,
                    at_ms: e.at_ms,
                },
            ))
        })
        .collect()
}

async fn read_status(app: &AppHandle) -> PhoneStatus {
    let c = desktop::ensure(app);
    let devices = c.device_views();
    let activity = {
        let devices = devices.clone();
        tokio::task::spawn_blocking(move || activity(&devices))
            .await
            .unwrap_or_default()
    };
    PhoneStatus {
        enabled: c.registry.read(|s| s.enabled),
        running: desktop::running_port().is_some(),
        serve: desktop::serve_state(),
        tailscale: tailscale::status().await,
        devices,
        pairing: c.pairing.view(now_ms()),
        activity,
        methods: crate::companion::router::METHODS.to_vec(),
        push: c.push.view(&c),
    }
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_status(app: AppHandle) -> Result<PhoneStatus, CommandError> {
    Ok(read_status(&app).await)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<PhoneStatus, CommandError> {
    desktop::set_enabled(&app, enabled).await?;
    Ok(read_status(&app).await)
}

/// "Phone notifications via Ship Studio's push service". Off tells the
/// relay to forget this Mac and every token it registered.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_set_push(
    app: AppHandle,
    enabled: bool,
) -> Result<PhoneStatus, CommandError> {
    let c = desktop::ensure(&app);
    crate::companion::push::set_enabled(&c, enabled).await?;
    Ok(read_status(&app).await)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_retry_tailscale(app: AppHandle) -> Result<PhoneStatus, CommandError> {
    desktop::retry_publish(&app).await?;
    Ok(read_status(&app).await)
}

/// A QR code's modules, row by row, `1` for dark.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub size: u32,
    pub modules: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// `shipstudio-companion://pair?d=…`: what the QR code says, for pasting.
    pub link: String,
    pub qr: QrMatrix,
    pub expires_at: u64,
}

/// Low error correction: the code is read off a screen, not a crumpled
/// label, and fewer modules make each one bigger for the camera.
fn qr_matrix(text: &str) -> Result<QrMatrix, CommandError> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(text, QrCodeEcc::Low)
        .map_err(|e| CommandError::from(format!("QR code: {e:?}")))?;
    let size = qr.size();
    let modules = (0..size)
        .flat_map(|y| (0..size).map(move |x| (x, y)))
        .map(|(x, y)| if qr.get_module(x, y) { '1' } else { '0' })
        .collect();
    Ok(QrMatrix {
        size: size as u32,
        modules,
    })
}

/// Issue a one-time code (replacing any earlier one) and the QR code for it.
/// Only offered once the phone has a route to this Mac.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_start(app: AppHandle) -> Result<PairingCode, CommandError> {
    let c = desktop::ensure(&app);
    let routes = desktop::routes();
    if routes.is_empty() {
        return Err(CommandError::expected(
            "Your phone can't reach this Mac yet. Turn on phone access and wait for Tailscale.",
        ));
    }
    let (code, expires_at) = c.pairing.start(now_ms());
    let link = wire::PairingLink {
        v: 1,
        code,
        server_id: c.registry.server_id(),
        name: c.backend.server_name(),
        routes,
    }
    .format();
    let qr = qr_matrix(&link)?;
    c.backend.changed();
    Ok(PairingCode {
        link,
        qr,
        expires_at,
    })
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_cancel(app: AppHandle) -> Result<(), CommandError> {
    let c = desktop::ensure(&app);
    c.pairing.cancel();
    c.backend.changed();
    Ok(())
}

/// Allow or Deny the phone waiting at the desk.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_decide(app: AppHandle, allow: bool) -> Result<(), CommandError> {
    let c = desktop::ensure(&app);
    let answered = c.pairing.decide(allow);
    c.backend.changed();
    answered
        .map(|_| ())
        .ok_or_else(|| CommandError::expected("That phone stopped waiting. Pair it again."))
}

/// Remove a paired phone: its token stops working and its sockets close now.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_revoke(
    app: AppHandle,
    device_id: String,
) -> Result<PhoneStatus, CommandError> {
    desktop::ensure(&app).revoke(&device_id)?;
    Ok(read_status(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_link_fits_a_scannable_qr_code() {
        let link = wire::PairingLink {
            v: 1,
            code: crate::companion::pairing::new_code(),
            server_id: "srv_0123456789abcdef".into(),
            name: "Julian’s MacBook Pro".into(),
            routes: vec![wire::Route {
                kind: wire::RouteKind::Tailscale,
                url: "https://julians-macbook-pro.tailc1f170.ts.net:47443".into(),
                pin: None,
            }],
        }
        .format();
        let qr = qr_matrix(&link).unwrap();
        assert_eq!(qr.modules.len(), (qr.size * qr.size) as usize);
        assert!(qr.modules.chars().all(|c| c == '0' || c == '1'));
        // Small enough to scan comfortably off a laptop screen.
        assert!(qr.size <= 81, "version {} is too dense", (qr.size - 17) / 4);
    }
}
