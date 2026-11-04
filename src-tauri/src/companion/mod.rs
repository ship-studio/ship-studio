//! # Mobile companion
//!
//! Serves the Ship Studio phone app from this Mac: pairing by QR code with a
//! click to Allow at the desk, then one WebSocket per phone carrying requests
//! (routed to the same command functions the desktop runs) and a journal of
//! events the phone resumes from by cursor.
//!
//! P1 is Tailscale only: the server binds loopback and `tailscale serve`
//! publishes it to the user's own tailnet at `https://<mac>.ts.net:47443`,
//! with Tailscale's certificate. Nothing passes through anything we run.
//!
//! - `wire` — the Rust side of `packages/companion-protocol`
//! - `pairing` — codes, the desk confirmation, token hashing
//! - `hub` — the event journal, replay, and draft appends
//! - `router` — method → command function, refusals, idempotent send, audit
//! - `server` — HTTP (`/v1/pair`) and the WebSocket (`/v1/ws`)
//! - `desktop` — the real backend, event wiring, Tailscale, lifecycle
//!
//! Full design: docs/mobile.md.

pub mod desktop;
#[cfg(test)]
mod fixtures;
pub mod hub;
pub mod pairing;
pub mod router;
pub mod server;
#[cfg(test)]
pub(crate) mod testkit;
pub mod wire;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::errors::CommandError;
use wire::{BuildKind, Device, DevicePlatform, PairDevice, RouteKind};

pub use desktop::{is_showing, resume_on_launch};

/// The HTTPS port `tailscale serve` publishes on. Deliberately not 443, 8443
/// or 10000: those are the only ports Funnel can open to the internet, and
/// Remote Access already funnels 443.
pub const TAILNET_HTTPS_PORT: u16 = 47443;
/// Sockets per device and in total.
pub const MAX_SOCKETS_PER_DEVICE: usize = 4;
pub const MAX_SOCKETS: usize = 16;
/// Requests per rolling minute per device.
pub const MAX_REQUESTS_PER_MINUTE: usize = 600;
/// Revoked token hashes remembered, so a removed phone hears "removed"
/// rather than "unknown".
const REVOKED_KEPT: usize = 64;

pub(crate) fn now_ms() -> u64 {
    crate::remote_access::now_ms()
}

/// Who acted, as the audit log names a phone.
pub fn actor_for(device_name: &str) -> String {
    format!("Phone · {device_name}")
}

// ============================================================================
// The device registry (companion.json, 0600)
// ============================================================================

/// A paired phone as stored on the Mac: the token only as its SHA-256.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(default)]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
    pub paired_at: i64,
    #[serde(default)]
    pub last_seen_at: Option<i64>,
    #[serde(default)]
    pub last_route: Option<RouteKind>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    pub token_hash: String,
    /// The phone's X25519 key from pairing, kept for the future relay.
    #[serde(default)]
    pub public_key: String,
}

impl DeviceRecord {
    pub fn view(&self, connected: bool) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            platform: self.platform,
            model: self.model.clone(),
            app_version: self.app_version.clone(),
            build: self.build,
            paired_at: self.paired_at,
            last_seen_at: self.last_seen_at,
            last_route: self.last_route,
            connected,
            expires_at: self.expires_at,
        }
    }

    /// The same phone pairing again: replaces rather than stacks up.
    fn same_phone(&self, d: &PairDevice) -> bool {
        self.name == d.name && self.platform == d.platform && self.model == d.model
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Stored {
    pub enabled: bool,
    /// This Mac's stable id, so a re-pair replaces the old entry on the phone.
    pub server_id: String,
    /// The loopback port, kept so the serve handler stays valid across restarts.
    pub port: Option<u16>,
    pub devices: Vec<DeviceRecord>,
    /// Hashes of revoked tokens, newest last.
    pub revoked: Vec<String>,
}

pub enum Auth {
    Device(DeviceRecord),
    Revoked,
    Unknown,
}

pub struct Registry {
    /// `None` keeps it in memory (tests).
    path: Option<PathBuf>,
    stored: Mutex<Stored>,
}

impl Registry {
    pub fn load(path: PathBuf) -> Self {
        let stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let r = Registry {
            path: Some(path),
            stored: Mutex::new(stored),
        };
        r.ensure_server_id();
        r
    }

    pub fn in_memory() -> Self {
        let r = Registry {
            path: None,
            stored: Mutex::new(Stored::default()),
        };
        r.ensure_server_id();
        r
    }

    fn ensure_server_id(&self) {
        let missing = self.read(|s| s.server_id.is_empty());
        if missing {
            let id = format!("srv_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
            let _ = self.write(|s| s.server_id = id);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Stored> {
        self.stored.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn read<T>(&self, f: impl FnOnce(&Stored) -> T) -> T {
        f(&self.lock())
    }

    /// Change and persist, under one lock.
    pub fn write<T>(&self, f: impl FnOnce(&mut Stored) -> T) -> Result<T, CommandError> {
        let mut s = self.lock();
        let out = f(&mut s);
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let json = serde_json::to_string_pretty(&*s)
                .map_err(|e| CommandError::from(format!("serialize companion config: {e}")))?;
            crate::remote_access::write_private(path, json.as_bytes())?;
        }
        Ok(out)
    }

    pub fn server_id(&self) -> String {
        self.read(|s| s.server_id.clone())
    }

    pub fn get(&self, device_id: &str) -> Option<DeviceRecord> {
        self.read(|s| s.devices.iter().find(|d| d.id == device_id).cloned())
    }

    pub fn devices(&self) -> Vec<DeviceRecord> {
        self.read(|s| s.devices.clone())
    }

    /// Which device a token belongs to. Every stored hash is compared in
    /// constant time, so timing says nothing about which one nearly matched.
    pub fn authenticate(&self, token: &str) -> Auth {
        let hash = pairing::hash_token(token);
        self.read(|s| {
            let mut found = None;
            for d in &s.devices {
                if pairing::constant_time_eq(d.token_hash.as_bytes(), hash.as_bytes()) {
                    found = Some(d.clone());
                }
            }
            if let Some(d) = found {
                return Auth::Device(d);
            }
            let revoked = s.revoked.iter().fold(false, |acc, r| {
                acc | pairing::constant_time_eq(r.as_bytes(), hash.as_bytes())
            });
            if revoked {
                Auth::Revoked
            } else {
                Auth::Unknown
            }
        })
    }

    /// Record an allowed phone and mint its token. The same phone paired
    /// before is replaced (its old token revoked); returns the ids replaced so
    /// their sockets can be closed.
    pub fn add(
        &self,
        device: &PairDevice,
        public_key: String,
        now: i64,
    ) -> Result<(DeviceRecord, String, Vec<String>), CommandError> {
        let token = pairing::new_token();
        let record = DeviceRecord {
            id: format!("dev_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]),
            name: device.name.chars().take(80).collect(),
            platform: device.platform,
            model: device.model.as_ref().map(|m| m.chars().take(80).collect()),
            app_version: device.app_version.chars().take(40).collect(),
            build: device.build,
            paired_at: now,
            last_seen_at: None,
            last_route: None,
            expires_at: None,
            token_hash: pairing::hash_token(&token),
            public_key,
        };
        let replaced = self.write(|s| {
            let (old, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut s.devices)
                .into_iter()
                .partition(|d| d.same_phone(device));
            s.devices = keep;
            for d in &old {
                remember_revoked(s, d.token_hash.clone());
            }
            s.devices.push(record.clone());
            old.into_iter().map(|d| d.id).collect::<Vec<_>>()
        })?;
        Ok((record, token, replaced))
    }

    /// Forget a device. Returns it, if it was there.
    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceRecord>, CommandError> {
        self.write(|s| {
            let index = s.devices.iter().position(|d| d.id == device_id)?;
            let gone = s.devices.remove(index);
            remember_revoked(s, gone.token_hash.clone());
            Some(gone)
        })
    }

    /// Last seen, over which route. Persisted only when asked (connect and
    /// disconnect), not on every frame.
    pub fn touch(&self, device_id: &str, now: i64, route: RouteKind, persist: bool) {
        let apply = |s: &mut Stored| {
            if let Some(d) = s.devices.iter_mut().find(|d| d.id == device_id) {
                d.last_seen_at = Some(now);
                d.last_route = Some(route);
            }
        };
        if persist {
            if let Err(e) = self.write(apply) {
                tracing::warn!("[Companion] Could not save last seen: {}", e);
            }
        } else {
            apply(&mut self.lock());
        }
    }
}

fn remember_revoked(s: &mut Stored, hash: String) {
    s.revoked.push(hash);
    let excess = s.revoked.len().saturating_sub(REVOKED_KEPT);
    s.revoked.drain(..excess);
}

// ============================================================================
// The companion: everything a connection needs
// ============================================================================

#[derive(Debug, Clone)]
struct Conn {
    device_id: String,
    foreground: bool,
}

pub struct Companion {
    pub registry: Registry,
    pub hub: hub::Hub,
    pub pairing: pairing::Pairing,
    pub backend: Arc<dyn router::Backend>,
    pub sends: router::SendCache,
    conns: Mutex<HashMap<u64, Conn>>,
    next_conn: AtomicU64,
    requests: Mutex<HashMap<String, VecDeque<u64>>>,
    last_status: Mutex<Option<wire::MacStatus>>,
}

impl Companion {
    pub fn new(registry: Registry, backend: Arc<dyn router::Backend>) -> Self {
        Self::with_epoch(registry, backend, uuid::Uuid::new_v4().simple().to_string())
    }

    /// With a known journal epoch (tests and fixtures).
    pub fn with_epoch(
        registry: Registry,
        backend: Arc<dyn router::Backend>,
        epoch: String,
    ) -> Self {
        Companion {
            registry,
            hub: hub::Hub::new(epoch),
            pairing: pairing::Pairing::default(),
            backend,
            sends: router::SendCache::default(),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            requests: Mutex::new(HashMap::new()),
            last_status: Mutex::new(None),
        }
    }

    /// Keep the latest Mac status; true when it differs from the last one.
    pub fn remember_status(&self, status: &wire::MacStatus) -> bool {
        let mut last = self.last_status.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(status) {
            return false;
        }
        *last = Some(status.clone());
        true
    }

    fn conns(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Conn>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Admit a socket for `device_id`, within the per-device and total caps.
    pub fn open_conn(&self, device_id: &str, foreground: bool) -> Option<u64> {
        let mut conns = self.conns();
        let mine = conns.values().filter(|c| c.device_id == device_id).count();
        if mine >= MAX_SOCKETS_PER_DEVICE || conns.len() >= MAX_SOCKETS {
            return None;
        }
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        conns.insert(
            id,
            Conn {
                device_id: device_id.to_string(),
                foreground,
            },
        );
        Some(id)
    }

    pub fn close_conn(&self, conn: u64) {
        self.conns().remove(&conn);
    }

    pub fn set_foreground(&self, conn: u64, foreground: bool) {
        if let Some(c) = self.conns().get_mut(&conn) {
            c.foreground = foreground;
        }
    }

    pub fn is_connected(&self, device_id: &str) -> bool {
        self.conns().values().any(|c| c.device_id == device_id)
    }

    /// The `notify::set_showing` label for one socket. Per socket rather than
    /// per device, so a stale socket closing can't clear a newer one's chat.
    pub fn label(device_id: &str, conn: u64) -> String {
        format!("companion:{device_id}:{conn}")
    }

    /// Whether the socket behind `label` is open with the app in front:
    /// only then does a chat on the phone count as on screen.
    pub fn label_on_screen(&self, label: &str) -> bool {
        let Some(conn) = label.rsplit(':').next().and_then(|n| n.parse::<u64>().ok()) else {
            return false;
        };
        self.conns().get(&conn).is_some_and(|c| c.foreground)
    }

    /// Paired devices, with whether each is connected now.
    pub fn device_views(&self) -> Vec<Device> {
        self.registry
            .devices()
            .iter()
            .map(|d| d.view(self.is_connected(&d.id)))
            .collect()
    }

    /// Sliding-minute rate limit per device.
    pub fn allow_request(&self, device_id: &str, now: u64) -> bool {
        let mut all = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let window = all.entry(device_id.to_string()).or_default();
        while window
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= 60_000)
        {
            window.pop_front();
        }
        if window.len() >= MAX_REQUESTS_PER_MINUTE {
            return false;
        }
        window.push_back(now);
        true
    }

    /// Revoke at the Mac: the token stops working and its sockets close now.
    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceRecord>, CommandError> {
        let gone = self.registry.revoke(device_id)?;
        if let Some(d) = &gone {
            self.hub.signal(hub::HubItem::Revoked {
                device_id: d.id.clone(),
            });
            self.backend.audit(
                &actor_for(&d.name),
                "revoked",
                "removed on this Mac".into(),
                true,
            );
            self.backend.changed();
        }
        Ok(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(name: &str) -> PairDevice {
        PairDevice {
            name: name.into(),
            platform: DevicePlatform::Ios,
            model: Some("iPhone 16".into()),
            app_version: "1.0.0".into(),
            build: BuildKind::Official,
        }
    }

    #[test]
    fn tokens_authenticate_and_only_their_hash_is_stored() {
        let r = Registry::in_memory();
        let (record, token, replaced) = r.add(&phone("A"), "pk".into(), 1).unwrap();
        assert!(replaced.is_empty());
        assert_ne!(record.token_hash, token);
        let stored = serde_json::to_string(&r.read(|s| s.clone())).unwrap();
        assert!(
            !stored.contains(&token),
            "the token itself is never written"
        );
        assert!(matches!(r.authenticate(&token), Auth::Device(d) if d.id == record.id));
        assert!(matches!(r.authenticate("nope"), Auth::Unknown));
    }

    #[test]
    fn revoking_turns_the_token_into_revoked() {
        let r = Registry::in_memory();
        let (record, token, _) = r.add(&phone("A"), String::new(), 1).unwrap();
        assert!(r.revoke(&record.id).unwrap().is_some());
        assert!(matches!(r.authenticate(&token), Auth::Revoked));
        assert!(r.revoke(&record.id).unwrap().is_none(), "already gone");
    }

    #[test]
    fn pairing_the_same_phone_again_replaces_it() {
        let r = Registry::in_memory();
        let (first, old_token, _) = r.add(&phone("A"), String::new(), 1).unwrap();
        r.add(&phone("B"), String::new(), 2).unwrap();
        let (second, new_token, replaced) = r.add(&phone("A"), String::new(), 3).unwrap();
        assert_eq!(replaced, vec![first.id.clone()]);
        assert_eq!(r.devices().len(), 2);
        assert!(matches!(r.authenticate(&old_token), Auth::Revoked));
        assert!(matches!(r.authenticate(&new_token), Auth::Device(d) if d.id == second.id));
    }

    #[test]
    fn the_registry_file_is_owner_only_and_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let r = Registry::load(path.clone());
        let server_id = r.server_id();
        let (record, token, _) = r.add(&phone("A"), String::new(), 1).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let again = Registry::load(path);
        assert_eq!(again.server_id(), server_id, "the server id is stable");
        assert!(matches!(again.authenticate(&token), Auth::Device(d) if d.id == record.id));
    }

    #[test]
    fn revoked_hashes_are_bounded() {
        let mut s = Stored::default();
        for i in 0..(REVOKED_KEPT + 10) {
            remember_revoked(&mut s, i.to_string());
        }
        assert_eq!(s.revoked.len(), REVOKED_KEPT);
        assert_eq!(s.revoked.last().unwrap(), &(REVOKED_KEPT + 9).to_string());
    }
}
