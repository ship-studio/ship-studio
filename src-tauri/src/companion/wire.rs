//! The companion's wire types: the Rust side of `packages/companion-protocol`.
//!
//! Agent payloads (messages, the overview, statuses) are the desktop's own
//! types serialized as they are for the webview, so they travel here as
//! `serde_json::Value`. Everything new to the companion is typed below, and
//! `fixtures.rs` holds both to the TypeScript by generating
//! `fixtures.gen.ts` from real serialized values.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::CommandError;

// ---- Versions ---------------------------------------------------------------

pub const PROTOCOL_VERSION: u32 = 1;
pub const MIN_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

pub const SUPPORTED: ProtocolRange = ProtocolRange {
    min: MIN_PROTOCOL_VERSION,
    max: PROTOCOL_VERSION,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Negotiation {
    Ok(u32),
    /// The phone is behind.
    UpdateApp,
    /// This Mac is behind.
    UpdateMac,
}

/// `negotiate` in version.ts: the highest version both speak.
pub fn negotiate(phone: ProtocolRange, mac: ProtocolRange) -> Negotiation {
    if phone.max < mac.min {
        Negotiation::UpdateApp
    } else if mac.max < phone.min {
        Negotiation::UpdateMac
    } else {
        Negotiation::Ok(phone.max.min(mac.max))
    }
}

// ---- The Mac, routes, devices -----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub epoch: String,
    pub seq: u64,
}

/// "We couldn't tell" is never shown as yes or no.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Known {
    Yes,
    No,
    Unknown,
}

impl From<Option<bool>> for Known {
    fn from(v: Option<bool>) -> Self {
        match v {
            Some(true) => Known::Yes,
            Some(false) => Known::No,
            None => Known::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Tailscale,
    Lan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Route {
    pub kind: RouteKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PowerInfo {
    pub keep_awake: bool,
    pub lid_closed_mode: Known,
    pub on_battery: Known,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery_percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub installed: bool,
    pub signed_in: Known,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacStatus {
    pub name: String,
    pub app_version: String,
    pub power: PowerInfo,
    pub claude: ClaudeInfo,
    pub routes: Vec<Route>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Ios,
    Android,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BuildKind {
    #[serde(rename = "official")]
    Official,
    /// Built on this Mac (a fork or a self-install).
    #[serde(rename = "self")]
    SelfBuilt,
}

/// `Device` in model.ts: a paired phone as the phone and the Phone panel see it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
    pub paired_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_route: Option<RouteKind>,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

// ---- Pairing ----------------------------------------------------------------

pub const PAIRING_SCHEME: &str = "shipstudio-companion";

/// What the pairing QR code carries. No long-lived secret.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingLink {
    pub v: u8,
    pub code: String,
    pub server_id: String,
    pub name: String,
    pub routes: Vec<Route>,
}

impl PairingLink {
    /// `formatPairingLink` in pairing.ts: `shipstudio-companion://pair?d=<base64url(JSON)>`.
    pub fn format(&self) -> String {
        use base64::Engine;
        let json = serde_json::to_string(self).unwrap_or_default();
        format!(
            "{PAIRING_SCHEME}://pair?d={}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairDevice {
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub device: PairDevice,
    pub protocol: ProtocolRange,
    #[serde(default)]
    pub public_key: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairRefusal {
    Expired,
    Used,
    Denied,
    Timeout,
    UpdateApp,
    UpdateMac,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum PairResponse {
    #[serde(rename_all = "camelCase")]
    Allowed {
        ok: bool,
        device_id: String,
        token: String,
        server_id: String,
        /// For the future relay's end-to-end encryption. Direct routes don't
        /// use it and P1 issues no server key, so it is empty rather than a
        /// key nothing holds the private half of.
        server_public_key: String,
    },
    Refused {
        ok: bool,
        reason: PairRefusal,
        message: String,
    },
}

impl PairResponse {
    pub fn refused(reason: PairRefusal, message: impl Into<String>) -> Self {
        PairResponse::Refused {
            ok: false,
            reason,
            message: message.into(),
        }
    }
}

// ---- Frames -----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloApp {
    pub version: String,
    #[serde(default)]
    pub update_id: Option<String>,
    #[serde(default)]
    pub runtime_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloFrame {
    pub protocol: ProtocolRange,
    pub token: String,
    pub app: HelloApp,
    #[serde(default)]
    pub resume: Option<Cursor>,
    #[serde(default)]
    pub foreground: bool,
}

/// Phone → Mac. Unknown frame types are ignored, as the protocol promises.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientFrame {
    Hello(HelloFrame),
    Req {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Presence {
        foreground: bool,
    },
    Ping,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMode {
    Replay,
    Snapshot,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefusedReason {
    Unauthorized,
    Revoked,
    UpdateApp,
    UpdateMac,
    TooManyConnections,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub app_version: String,
}

/// The `type: 'Protocol'` error: the companion's own failures.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolCode {
    UnknownMethod,
    BadParams,
    RateLimited,
    TooLarge,
    Refused,
    NotConnected,
}

#[derive(Debug, Clone)]
pub enum WireError {
    Command(CommandError),
    Protocol { code: ProtocolCode, message: String },
}

impl WireError {
    pub fn protocol(code: ProtocolCode, message: impl Into<String>) -> Self {
        WireError::Protocol {
            code,
            message: message.into(),
        }
    }

    /// A one-line form for the audit log.
    pub fn summary(&self) -> String {
        match self {
            WireError::Command(e) => e.to_string(),
            WireError::Protocol { message, .. } => message.clone(),
        }
    }
}

impl From<CommandError> for WireError {
    fn from(e: CommandError) -> Self {
        WireError::Command(e)
    }
}

impl Serialize for WireError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(tag = "type")]
        enum Tagged<'a> {
            Protocol {
                code: ProtocolCode,
                message: &'a str,
            },
        }
        match self {
            WireError::Command(e) => e.serialize(serializer),
            WireError::Protocol { code, message } => Tagged::Protocol {
                code: *code,
                message,
            }
            .serialize(serializer),
        }
    }
}

/// Mac → phone.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    Welcome {
        protocol: u32,
        server: ServerInfo,
        device_id: String,
        resume: ResumeMode,
        methods: Vec<&'static str>,
    },
    Refused {
        reason: RefusedReason,
        message: String,
    },
    Res {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    Evt {
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
        event: Event,
    },
    Pong,
}

impl ServerFrame {
    pub fn response(id: u64, result: Result<Value, WireError>) -> Self {
        match result {
            Ok(value) => ServerFrame::Res {
                id,
                ok: true,
                result: Some(value),
                error: None,
            },
            Err(e) => ServerFrame::Res {
                id,
                ok: false,
                result: None,
                error: Some(e),
            },
        }
    }
}

/// Every event (events.ts). Agent payloads are the desktop's own JSON.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum Event {
    #[serde(rename = "agents.message")]
    Message { message: Value },
    #[serde(rename = "agents.status")]
    Status { agent_id: String, status: Value },
    #[serde(rename = "agents.registry")]
    Registry { overview: Value },
    #[serde(rename = "system.status")]
    System { status: MacStatus },
    #[serde(rename = "agents.draft")]
    Draft {
        agent_id: String,
        id: String,
        from: usize,
        text: String,
    },
    #[serde(rename = "sync.snapshot")]
    Snapshot {
        cursor: Cursor,
        overview: Value,
        status: MacStatus,
        projects: Vec<Value>,
    },
    #[serde(rename = "sync.caughtUp")]
    CaughtUp { cursor: Cursor },
}

/// The desktop's `agents_overview`, as the phone gets it. Each agent's
/// lifetime `usage` totals are dropped: `Agent` in model.ts doesn't carry
/// them (the phone asks `agents.usage` when it shows them), and this goes
/// out on every registry change.
pub fn phone_overview(mut overview: Value) -> Value {
    if let Some(agents) = overview.get_mut("agents").and_then(Value::as_array_mut) {
        for agent in agents {
            if let Some(fields) = agent.as_object_mut() {
                fields.remove("usage");
            }
        }
    }
    overview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_matches_version_ts() {
        let r = |min, max| ProtocolRange { min, max };
        assert_eq!(negotiate(r(1, 3), r(2, 2)), Negotiation::Ok(2));
        assert_eq!(negotiate(r(1, 1), r(2, 3)), Negotiation::UpdateApp);
        assert_eq!(negotiate(r(3, 4), r(1, 2)), Negotiation::UpdateMac);
    }

    #[test]
    fn a_pairing_link_is_the_scheme_and_base64url_json() {
        let link = PairingLink {
            v: 1,
            code: "ABC".into(),
            server_id: "srv".into(),
            name: "Julian’s Mac".into(),
            routes: vec![Route {
                kind: RouteKind::Tailscale,
                url: "https://mac.ts.net:47443".into(),
                pin: None,
            }],
        };
        let text = link.format();
        let d = text.strip_prefix("shipstudio-companion://pair?d=").unwrap();
        assert!(d
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        use base64::Engine;
        let json: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(d)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["serverId"], "srv");
        assert_eq!(json["name"], "Julian’s Mac");
    }

    #[test]
    fn a_null_result_is_still_sent() {
        let frame = ServerFrame::response(4, Ok(Value::Null));
        let json = serde_json::to_value(frame).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"t": "res", "id": 4, "ok": true, "result": null})
        );
    }

    #[test]
    fn unknown_client_frames_fail_to_parse_rather_than_panic() {
        assert!(serde_json::from_str::<ClientFrame>(r#"{"t":"nope"}"#).is_err());
        assert!(matches!(
            serde_json::from_str::<ClientFrame>(r#"{"t":"ping"}"#),
            Ok(ClientFrame::Ping)
        ));
    }
}
