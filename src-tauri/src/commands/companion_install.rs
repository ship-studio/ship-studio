//! "Install on my phone": the app's own checks for building the companion
//! app on this Mac and putting it on a plugged-in phone.
//!
//! The agent does the work in a terminal; these commands decide what is done.
//! Every check here is read-only — nothing installs, signs or builds. The
//! only command that acts is `companion_install_ios_launch`, which opens the
//! already-installed app on the phone, and the expiry reminder.
//!
//! Design: docs/mobile.md, "Installing the app".

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::commands::mobile::{
    adb_command, android_sdk_root, detect_jdk_home, xcode_clt_installed, xcrun_command,
};
use crate::errors::CommandError;
use crate::external_command::{run_to_stdout, run_with_timeout};
use crate::utils::{create_command, get_extended_path};

/// Expo SDK 58 builds with Xcode 26.4 or later (mobile/README.md).
pub const XCODE_MINIMUM: (u32, u32) = (26, 4);
/// The Android package of an app built on this Mac. Never the official one,
/// so a self-build and the official APK can't trip over each other's
/// signatures.
pub const ANDROID_PACKAGE: &str = "studio.ship.companion.self";

const QUICK_SECS: u64 = 15;
const DEVICECTL_SECS: u64 = 30;

// ---- Where the app's source is ---------------------------------------------

/// The `mobile/` folder the build runs in. A dev build uses the checkout it
/// was built from; an installed app uses a sparse checkout the agent makes at
/// the tag matching this version. `SHIPSTUDIO_COMPANION_SOURCE` overrides both,
/// for forks.
fn source_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SHIPSTUDIO_COMPANION_SOURCE") {
        return std::path::PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mobile");
        if repo.join("package.json").is_file() {
            return repo.canonicalize().unwrap_or(repo);
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join("ShipStudio/.companion-build/mobile")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    /// The `mobile/` folder the build runs in.
    pub path: String,
    /// Its `package.json` exists.
    pub present: bool,
    /// Its dependencies are installed (`node_modules/expo`).
    pub installed: bool,
    /// The desktop's version: the checkout is made at tag `v<version>`.
    pub desktop_version: String,
}

fn check_source() -> SourceCheck {
    let dir = source_dir();
    SourceCheck {
        path: dir.to_string_lossy().into_owned(),
        present: dir.join("package.json").is_file(),
        installed: dir.join("node_modules/expo/package.json").is_file(),
        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

// ---- iOS ---------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum XcodeCheck {
    /// No developer directory at all.
    Missing,
    /// Only the Command Line Tools: they can't build for a device.
    CltOnly,
    TooOld {
        version: String,
    },
    /// The license or first-launch components still need accepting.
    NeedsFirstLaunch {
        version: String,
    },
    Ok {
        version: String,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IosDevice {
    pub udid: String,
    pub name: String,
    pub model: Option<String>,
    pub os_version: Option<String>,
    /// Plugged in (or reachable) right now.
    pub connected: bool,
    /// The phone trusted this Mac.
    pub paired: bool,
    /// `enabled | disabled | unknown`.
    pub developer_mode: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signing {
    pub team_id: String,
    /// The certificate's name, e.g. "Apple Development: me@icloud.com (5VD2FLB8HU)".
    pub identity: String,
    /// The bundle id this team builds as.
    pub bundle_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosInstallStatus {
    pub xcode: XcodeCheck,
    /// "26.4".
    pub xcode_minimum: String,
    pub clt: bool,
    pub cocoapods: Option<String>,
    pub node: Option<String>,
    pub devices: Vec<IosDevice>,
    pub signing: Option<Signing>,
    pub source: SourceCheck,
}

/// `Xcode 26.1\nBuild version 17B55` → (26, 1).
fn parse_xcode_version(out: &str) -> Option<(u32, u32, String)> {
    let line = out.lines().find(|l| l.starts_with("Xcode "))?;
    let version = line.trim_start_matches("Xcode ").trim().to_string();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor, version))
}

fn meets_minimum(major: u32, minor: u32) -> bool {
    (major, minor) >= XCODE_MINIMUM
}

fn stdout_of(program: &str, args: &[&str]) -> std::process::Command {
    let mut cmd = create_command(program);
    cmd.args(args);
    cmd.env("PATH", get_extended_path());
    cmd
}

async fn quick(program: &str, args: &[&str]) -> Option<String> {
    let label = format!("{program} {}", args.join(" "));
    run_to_stdout(
        tokio::process::Command::from(stdout_of(program, args)),
        label,
        QUICK_SECS,
    )
    .await
    .ok()
}

async fn check_xcode() -> XcodeCheck {
    let Some(dir) = quick("xcode-select", &["-p"]).await else {
        return XcodeCheck::Missing;
    };
    if !dir.contains(".app/") {
        return XcodeCheck::CltOnly;
    }
    let Some((major, minor, version)) = quick("xcodebuild", &["-version"])
        .await
        .as_deref()
        .and_then(parse_xcode_version)
    else {
        return XcodeCheck::Missing;
    };
    if !meets_minimum(major, minor) {
        return XcodeCheck::TooOld { version };
    }
    if quick("xcodebuild", &["-checkFirstLaunchStatus"])
        .await
        .is_none()
    {
        return XcodeCheck::NeedsFirstLaunch { version };
    }
    XcodeCheck::Ok { version }
}

/// `xcrun devicectl … --json-output <file>` and read the file back: devicectl
/// writes its JSON to a path, not to stdout.
async fn devicectl_json(args: &[&str]) -> Result<serde_json::Value, CommandError> {
    let file = tempfile::NamedTempFile::new().map_err(|e| CommandError::Io {
        message: e.to_string(),
    })?;
    let path = file.path().to_string_lossy().into_owned();
    let mut cmd = xcrun_command();
    cmd.arg("devicectl")
        .args(args)
        .args(["--json-output", &path, "-q"]);
    let label = format!("devicectl {}", args.join(" "));
    run_to_stdout(tokio::process::Command::from(cmd), label, DEVICECTL_SECS).await?;
    let text = std::fs::read_to_string(file.path()).map_err(|e| CommandError::Io {
        message: e.to_string(),
    })?;
    serde_json::from_str(&text).map_err(|e| CommandError::Other {
        message: format!("devicectl answered with unreadable JSON: {e}"),
    })
}

fn str_at<'a>(v: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

/// iPhones and iPads from `devicectl list devices`; watches, TVs and
/// simulators are left out.
fn parse_devicectl_devices(json: &serde_json::Value) -> Vec<IosDevice> {
    let Some(list) = json.pointer("/result/devices").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter(|d| str_at(d, &["hardwareProperties", "platform"]) == Some("iOS"))
        .filter(|d| str_at(d, &["hardwareProperties", "reality"]) != Some("virtual"))
        .filter_map(|d| {
            let udid = str_at(d, &["hardwareProperties", "udid"])
                .or_else(|| str_at(d, &["identifier"]))?
                .to_string();
            Some(IosDevice {
                name: str_at(d, &["deviceProperties", "name"])
                    .unwrap_or("iPhone")
                    .to_string(),
                model: str_at(d, &["hardwareProperties", "marketingName"]).map(str::to_string),
                os_version: str_at(d, &["deviceProperties", "osVersionNumber"]).map(str::to_string),
                connected: str_at(d, &["connectionProperties", "transportType"]).is_some(),
                paired: str_at(d, &["connectionProperties", "pairingState"]) == Some("paired"),
                developer_mode: str_at(d, &["deviceProperties", "developerModeStatus"])
                    .unwrap_or("unknown")
                    .to_string(),
                udid,
            })
        })
        .collect()
}

/// The first "Apple Development" identity from `security find-identity`.
fn parse_dev_identity(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let start = l.find("\"Apple Development: ")?;
        let rest = &l[start + 1..];
        Some(rest[..rest.find('"')?].to_string())
    })
}

/// The team id is the certificate subject's OU, not the bracketed id in its
/// name (that one is the person's).
fn parse_subject_ou(subject: &str) -> Option<String> {
    subject
        .split(['/', ','])
        .map(str::trim)
        .find_map(|part| {
            part.strip_prefix("OU=")
                .or_else(|| part.strip_prefix("OU = "))
        })
        .map(|ou| ou.trim().to_string())
        .filter(|ou| !ou.is_empty())
}

/// `studio.ship.companion.<6 hex of the team id>`: a free team can't take an
/// id someone else holds, and this one never collides with the official app.
pub fn bundle_id_for_team(team_id: &str) -> String {
    let digest = Sha256::digest(team_id.as_bytes());
    let hex: String = digest.iter().take(3).map(|b| format!("{b:02x}")).collect();
    format!("studio.ship.companion.{hex}")
}

async fn check_signing() -> Option<Signing> {
    let identity = parse_dev_identity(
        &quick("security", &["find-identity", "-v", "-p", "codesigning"]).await?,
    )?;
    let pem = quick("security", &["find-certificate", "-c", &identity, "-p"]).await?;
    let out = crate::external_command::run_with_timeout_stdin(
        tokio::process::Command::from(stdout_of("openssl", &["x509", "-noout", "-subject"])),
        &pem,
        "openssl x509 -subject",
        QUICK_SECS,
    )
    .await
    .ok()?;
    let team_id = parse_subject_ou(&String::from_utf8_lossy(&out.stdout))?;
    Some(Signing {
        bundle_id: bundle_id_for_team(&team_id),
        team_id,
        identity,
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn companion_install_ios_status() -> Result<IosInstallStatus, CommandError> {
    if std::env::consts::OS != "macos" {
        return Err(CommandError::expected(
            "Building the iPhone app needs a Mac with Xcode.",
        ));
    }
    let (xcode, clt, cocoapods, node, devices, signing) = tokio::join!(
        check_xcode(),
        xcode_clt_installed(),
        quick("pod", &["--version"]),
        quick("node", &["--version"]),
        devicectl_json(&["list", "devices"]),
        check_signing(),
    );
    Ok(IosInstallStatus {
        xcode,
        xcode_minimum: format!("{}.{}", XCODE_MINIMUM.0, XCODE_MINIMUM.1),
        clt,
        cocoapods: cocoapods.map(|v| v.trim().to_string()),
        node: node.map(|v| v.trim().to_string()),
        devices: devices
            .map(|j| parse_devicectl_devices(&j))
            .unwrap_or_default(),
        signing,
        source: check_source(),
    })
}

// ---- What's on the phone -----------------------------------------------------

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// `None` when the phone couldn't be asked (locked, Developer Mode off).
    pub installed: Option<bool>,
    pub version: Option<String>,
    /// When a free team's profile stops the app opening, in ms. iOS only.
    pub expires_at: Option<i64>,
}

fn valid_token(field: &str, v: &str) -> Result<(), CommandError> {
    let ok = !v.is_empty()
        && v.len() < 128
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':'));
    if ok {
        Ok(())
    } else {
        Err(CommandError::Validation {
            field: field.into(),
            reason: "unexpected characters".into(),
        })
    }
}

fn parse_devicectl_app(json: &serde_json::Value, bundle_id: &str) -> InstalledApp {
    let apps = json.pointer("/result/apps").and_then(|a| a.as_array());
    let app = apps.and_then(|a| {
        a.iter()
            .find(|app| str_at(app, &["bundleIdentifier"]) == Some(bundle_id))
    });
    InstalledApp {
        installed: apps.map(|_| app.is_some()),
        version: app.and_then(|a| str_at(a, &["version"]).map(str::to_string)),
        expires_at: None,
    }
}

/// A plist value following `<key>name</key>` in `security cms -D` output.
fn plist_value<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let at = xml.find(&format!("<key>{key}</key>"))?;
    let rest = &xml[at..];
    let open = rest.find("<string>").map(|i| (i, "<string>", "</string>"));
    let date = rest.find("<date>").map(|i| (i, "<date>", "</date>"));
    let (i, tag, close) = match (open, date) {
        (Some(a), Some(b)) => {
            if a.0 < b.0 {
                a
            } else {
                b
            }
        }
        (a, b) => a.or(b)?,
    };
    let value = &rest[i + tag.len()..];
    Some(value[..value.find(close)?].trim())
}

/// The profile's expiry, in ms, if it signs `<team>.<bundle>`.
fn profile_expiry(xml: &str, app_identifier: &str) -> Option<i64> {
    if plist_value(xml, "application-identifier")? != app_identifier {
        return None;
    }
    let date = plist_value(xml, "ExpirationDate")?;
    chrono::DateTime::parse_from_rfc3339(date)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// The latest expiry among the provisioning profiles Xcode made for this app.
async fn ios_expiry(team_id: &str, bundle_id: &str) -> Option<i64> {
    let home = dirs::home_dir()?;
    let app_identifier = format!("{team_id}.{bundle_id}");
    let mut best = None;
    for dir in [
        "Library/Developer/Xcode/UserData/Provisioning Profiles",
        "Library/MobileDevice/Provisioning Profiles",
    ] {
        let Ok(entries) = std::fs::read_dir(home.join(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("mobileprovision") {
                continue;
            }
            let path = path.to_string_lossy().into_owned();
            if let Some(xml) = quick("security", &["cms", "-D", "-i", &path]).await {
                best = best.max(profile_expiry(&xml, &app_identifier));
            }
        }
    }
    best
}

#[tauri::command]
#[tracing::instrument]
pub async fn companion_install_ios_app(
    udid: String,
    team_id: String,
) -> Result<InstalledApp, CommandError> {
    valid_token("udid", &udid)?;
    valid_token("teamId", &team_id)?;
    let bundle_id = bundle_id_for_team(&team_id);
    let mut app = devicectl_json(&[
        "device",
        "info",
        "apps",
        "--device",
        &udid,
        "--bundle-id",
        &bundle_id,
    ])
    .await
    .map(|j| parse_devicectl_app(&j, &bundle_id))
    .unwrap_or_default();
    if app.installed == Some(true) {
        app.expires_at = ios_expiry(&team_id, &bundle_id).await;
    }
    Ok(app)
}

/// Open the installed app on the phone. Fails, in iOS's words, when the
/// developer isn't trusted on the phone yet: that can't be checked from here.
#[tauri::command]
#[tracing::instrument]
pub async fn companion_install_ios_launch(
    udid: String,
    team_id: String,
) -> Result<(), CommandError> {
    valid_token("udid", &udid)?;
    valid_token("teamId", &team_id)?;
    let bundle_id = bundle_id_for_team(&team_id);
    let mut cmd = xcrun_command();
    cmd.args([
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        &udid,
        &bundle_id,
    ]);
    let out = run_with_timeout(
        tokio::process::Command::from(cmd),
        "devicectl launch",
        DEVICECTL_SECS,
    )
    .await?;
    if out.status.success() {
        return Ok(());
    }
    let text =
        String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    if text.contains("profile has not been explicitly trusted") || text.contains("untrusted") {
        return Err(CommandError::expected(
            "Your phone doesn’t trust this developer yet. On the phone: Settings → General → VPN & Device Management → your Apple ID → Trust.",
        ));
    }
    if text.contains("locked") {
        return Err(CommandError::expected("Unlock your phone, then try again."));
    }
    Err(CommandError::Process {
        cmd: "devicectl launch".into(),
        exit_code: out.status.code().unwrap_or(-1),
        stderr: text.chars().take(600).collect(),
    })
}

// ---- Android -----------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPhone {
    pub serial: String,
    /// adb's word: `device`, `unauthorized`, `offline`, `no permissions`…
    pub state: String,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidInstallStatus {
    /// `adb version`'s first line, when adb runs.
    pub adb: Option<String>,
    pub sdk: bool,
    pub jdk: bool,
    pub node: Option<String>,
    /// Physical phones only; emulators are left out.
    pub devices: Vec<AndroidPhone>,
    pub package: String,
    pub source: SourceCheck,
}

/// `adb devices -l`, every line in every state, emulators left out.
fn parse_adb_devices_long(out: &str) -> Vec<AndroidPhone> {
    out.lines()
        .skip_while(|l| !l.starts_with("List of devices"))
        .skip(1)
        .filter_map(|line| {
            let line = line.trim();
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            if serial.starts_with("emulator-") {
                return None;
            }
            let rest: Vec<&str> = parts.collect();
            // "no permissions (…)" is two words; every key:value pair has a colon.
            let state = rest
                .iter()
                .take_while(|w| !w.contains(':'))
                .copied()
                .collect::<Vec<_>>()
                .join(" ");
            let model = rest
                .iter()
                .find_map(|w| w.strip_prefix("model:"))
                .map(|m| m.replace('_', " "));
            Some(AndroidPhone {
                serial,
                state: if state.is_empty() {
                    "unknown".into()
                } else {
                    state
                },
                model,
            })
        })
        .collect()
}

#[tauri::command]
#[tracing::instrument]
pub async fn companion_install_android_status() -> Result<AndroidInstallStatus, CommandError> {
    let mut version = adb_command();
    version.arg("version");
    let adb = run_to_stdout(
        tokio::process::Command::from(version),
        "adb version",
        QUICK_SECS,
    )
    .await
    .ok()
    .and_then(|o| o.lines().next().map(str::to_string));
    let devices = if adb.is_some() {
        let mut list = adb_command();
        list.args(["devices", "-l"]);
        run_to_stdout(
            tokio::process::Command::from(list),
            "adb devices -l",
            QUICK_SECS,
        )
        .await
        .map(|o| parse_adb_devices_long(&o))
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(AndroidInstallStatus {
        adb,
        sdk: android_sdk_root().is_some(),
        jdk: detect_jdk_home().is_some(),
        node: quick("node", &["--version"])
            .await
            .map(|v| v.trim().to_string()),
        devices,
        package: ANDROID_PACKAGE.to_string(),
        source: check_source(),
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn companion_install_android_app(serial: String) -> Result<InstalledApp, CommandError> {
    valid_token("serial", &serial)?;
    let mut cmd = adb_command();
    cmd.args([
        "-s",
        &serial,
        "shell",
        "pm",
        "list",
        "packages",
        ANDROID_PACKAGE,
    ]);
    let out = run_to_stdout(
        tokio::process::Command::from(cmd),
        "adb pm list",
        QUICK_SECS,
    )
    .await
    .ok();
    Ok(InstalledApp {
        installed: out.map(|o| {
            o.lines()
                .any(|l| l.trim() == format!("package:{ANDROID_PACKAGE}"))
        }),
        version: None,
        expires_at: None,
    })
}

// ---- The expiry reminder -----------------------------------------------------

/// A macOS notification, 24 h before a free team's build stops opening.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_install_remind(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), CommandError> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| CommandError::Other {
            message: e.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xcode_version_and_minimum() {
        let (maj, min, v) = parse_xcode_version("Xcode 26.1\nBuild version 17B55\n").unwrap();
        assert_eq!((maj, min, v.as_str()), (26, 1, "26.1"));
        assert!(!meets_minimum(26, 1));
        assert!(meets_minimum(26, 4));
        assert!(meets_minimum(27, 0));
        let (maj, min, _) = parse_xcode_version("Xcode 27\nBuild version 1").unwrap();
        assert_eq!((maj, min), (27, 0));
        assert!(parse_xcode_version("xcode-select: error").is_none());
    }

    #[test]
    fn devicectl_devices_keep_physical_iphones() {
        let json = serde_json::json!({ "result": { "devices": [
            {
                "identifier": "A1",
                "connectionProperties": { "pairingState": "paired", "transportType": "wired", "tunnelState": "connected" },
                "deviceProperties": { "name": "Julian’s iPhone", "developerModeStatus": "disabled", "osVersionNumber": "26.1" },
                "hardwareProperties": { "platform": "iOS", "udid": "00008140-001", "marketingName": "iPhone 16 Pro", "reality": "physical" }
            },
            {
                "identifier": "B2",
                "connectionProperties": { "pairingState": "paired", "tunnelState": "unavailable" },
                "deviceProperties": { "name": "Old iPhone" },
                "hardwareProperties": { "platform": "iOS", "udid": "00008030-002" }
            },
            {
                "identifier": "W",
                "connectionProperties": { "pairingState": "paired" },
                "deviceProperties": { "name": "Watch" },
                "hardwareProperties": { "platform": "watchOS", "udid": "w" }
            }
        ]}});
        let devices = parse_devicectl_devices(&json);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].udid, "00008140-001");
        assert!(devices[0].connected && devices[0].paired);
        assert_eq!(devices[0].developer_mode, "disabled");
        assert!(!devices[1].connected);
        assert_eq!(devices[1].developer_mode, "unknown");
        assert!(
            parse_devicectl_devices(&serde_json::json!({ "result": { "devices": [] } })).is_empty()
        );
    }

    #[test]
    fn signing_identity_and_team() {
        let out = "  1) C06 \"Apple Development: me@icloud.com (5VD2FLB8HU)\"\n  2) 24F \"Developer ID Application: Co (J335CB82MX)\"\n     2 valid identities found\n";
        assert_eq!(
            parse_dev_identity(out).as_deref(),
            Some("Apple Development: me@icloud.com (5VD2FLB8HU)")
        );
        assert!(parse_dev_identity("     0 valid identities found").is_none());
        let subject = "subject= /UID=ZWCX9Q6MBA/CN=Apple Development: me (5VD2FLB8HU)/OU=H8NN6DM6G6/O=Me/C=US";
        assert_eq!(parse_subject_ou(subject).as_deref(), Some("H8NN6DM6G6"));
        let openssl3 = "subject=UID=Z, CN=Apple Development: me, OU=ABCDE12345, O=Me, C=US";
        assert_eq!(parse_subject_ou(openssl3).as_deref(), Some("ABCDE12345"));
    }

    #[test]
    fn bundle_id_is_stable_and_never_official() {
        let a = bundle_id_for_team("H8NN6DM6G6");
        assert_eq!(a, bundle_id_for_team("H8NN6DM6G6"));
        assert_ne!(a, bundle_id_for_team("ABCDE12345"));
        assert!(a.starts_with("studio.ship.companion."));
        assert_eq!(a.len(), "studio.ship.companion.".len() + 6);
    }

    #[test]
    fn installed_app_from_devicectl() {
        let json = serde_json::json!({ "result": { "apps": [
            { "bundleIdentifier": "studio.ship.companion.abc123", "version": "0.1.0" }
        ]}});
        let app = parse_devicectl_app(&json, "studio.ship.companion.abc123");
        assert_eq!(app.installed, Some(true));
        assert_eq!(app.version.as_deref(), Some("0.1.0"));
        let none = parse_devicectl_app(&serde_json::json!({ "result": { "apps": [] } }), "x");
        assert_eq!(none.installed, Some(false));
        assert_eq!(
            parse_devicectl_app(&serde_json::json!({}), "x").installed,
            None
        );
    }

    #[test]
    fn profile_expiry_matches_the_app() {
        let xml = "<plist><dict><key>Entitlements</key><dict><key>application-identifier</key>\n<string>TEAM.studio.ship.companion.abc123</string></dict>\
                   <key>ExpirationDate</key>\n<date>2026-11-11T10:00:00Z</date></dict></plist>";
        let at = profile_expiry(xml, "TEAM.studio.ship.companion.abc123").unwrap();
        assert_eq!(at, 1_794_391_200_000);
        assert!(profile_expiry(xml, "TEAM.other").is_none());
    }

    #[test]
    fn adb_devices_in_every_state() {
        let out = "* daemon started successfully\nList of devices attached\n\
                   R58M device usb:1-1 product:p model:Pixel_9 device:d transport_id:1\n\
                   ZY22 unauthorized usb:1-2 transport_id:2\n\
                   emulator-5554 device product:sdk model:sdk transport_id:3\n\
                   AB12 no permissions (missing udev rules) usb:1-3 transport_id:4\n\n";
        let phones = parse_adb_devices_long(out);
        assert_eq!(phones.len(), 3);
        assert_eq!(phones[0].state, "device");
        assert_eq!(phones[0].model.as_deref(), Some("Pixel 9"));
        assert_eq!(phones[1].state, "unauthorized");
        assert!(phones[2].state.starts_with("no permissions"));
    }

    #[test]
    fn tokens_are_validated() {
        assert!(valid_token("udid", "00008140-001A2B").is_ok());
        assert!(valid_token("udid", "a; rm -rf /").is_err());
        assert!(valid_token("udid", "").is_err());
    }

    /// The real, read-only checks against this machine:
    /// `cargo test --lib companion_install::tests::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_read_only_checks_on_this_mac() {
        let ios = companion_install_ios_status().await;
        println!("iOS: {}", serde_json::to_string_pretty(&ios.ok()).unwrap());
        let android = companion_install_android_status().await;
        println!(
            "Android: {}",
            serde_json::to_string_pretty(&android.ok()).unwrap()
        );
    }
}
