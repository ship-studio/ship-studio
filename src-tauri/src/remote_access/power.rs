//! Keeping the Mac reachable: awake, awake with the lid shut, and back after a
//! restart — plus reading whether it is on mains power.
//!
//! Remote access is only as good as the machine being on. Everything here is
//! about the ways it stops being on, each handled at the level macOS actually
//! allows:
//!
//! - **Idle sleep** — `caffeinate -i -s -m -w <our pid>`. No privileges, and it
//!   dies with us, so a crash can never leave the Mac unable to sleep. `-s`
//!   only has effect on mains power; on battery the Mac can still sleep when
//!   the lid closes, which is why being plugged in is a checklist item.
//! - **Lid closed** — no assertion survives closing the lid on a laptop without
//!   an external display. `pmset -a disablesleep 1` does, but it needs an
//!   admin password and outlives us, so it is opt-in, read back from `pmset`
//!   rather than remembered, and offered for undo on every launch it is
//!   still set.
//! - **Restart** — a LaunchAgent that reopens the app at login. macOS still
//!   needs someone to log in after a restart when FileVault is on; nothing an
//!   app does gets around that, and the UI says so instead of implying it.

use crate::errors::CommandError;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    /// Whether this machine has a battery at all (desktops don't).
    pub has_battery: bool,
    /// Drawing from mains power. `None` when `pmset` couldn't be read.
    pub on_ac: Option<bool>,
    pub battery_percent: Option<u8>,
    pub charging: Option<bool>,
}

/// Parse `pmset -g batt`. Example output:
///
/// ```text
/// Now drawing from 'Battery Power'
///  -InternalBattery-0 (id=4653155)    87%; discharging; 6:12 remaining present: true
/// ```
pub fn parse_pmset_batt(output: &str) -> PowerStatus {
    let mut status = PowerStatus::default();
    if output.contains("'AC Power'") {
        status.on_ac = Some(true);
    } else if output.contains("'Battery Power'") {
        status.on_ac = Some(false);
    }
    if let Some(line) = output.lines().find(|l| l.contains("InternalBattery")) {
        status.has_battery = true;
        status.battery_percent = line
            .split_whitespace()
            .find_map(|w| w.strip_suffix("%;").and_then(|n| n.parse().ok()));
        // "charged" means full on AC — not draining, which is what matters.
        status.charging = if line.contains("discharging") {
            Some(false)
        } else if line.contains("charging") || line.contains("charged") {
            Some(true)
        } else {
            None
        };
    }
    status
}

/// Parse `pmset -g` for the global SleepDisabled flag. macOS only prints the
/// line while it is set, so a readable report without it means "off".
pub fn parse_sleep_disabled(output: &str) -> Option<bool> {
    let flag = output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next() == Some("SleepDisabled")).then(|| parts.next() == Some("1"))
    });
    match flag {
        Some(v) => Some(v),
        None if output.contains("System-wide power settings") => Some(false),
        None => None,
    }
}

async fn pmset(args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/pmset");
    cmd.args(args);
    let output = crate::external_command::run_with_timeout(cmd, "pmset", 5)
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn read_power() -> PowerStatus {
    if !cfg!(target_os = "macos") {
        return PowerStatus::default();
    }
    pmset(&["-g", "batt"])
        .await
        .map(|out| parse_pmset_batt(&out))
        .unwrap_or_default()
}

/// Is lid-closed mode on right now? Read from the system every time — the
/// flag outlives this process, so remembering it would go stale.
pub async fn lid_closed_mode_active() -> Option<bool> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    pmset(&["-g"])
        .await
        .and_then(|out| parse_sleep_disabled(&out))
}

/// Turn lid-closed mode on or off. Shows the macOS admin password dialog.
pub async fn set_lid_closed_mode(enabled: bool) -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Err(CommandError::expected(
            "Keeping the computer awake with the lid closed is only available on macOS.",
        ));
    }
    let value = if enabled { "1" } else { "0" };
    let script = format!(
        "do shell script \"/usr/bin/pmset -a disablesleep {value}\" with administrator privileges"
    );
    let mut cmd = tokio::process::Command::new("/usr/bin/osascript");
    cmd.args(["-e", &script]);
    // Long timeout: a person is typing a password.
    let output = crate::external_command::run_with_timeout(cmd, "osascript pmset", 180).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // -128 is "User canceled." — a choice, not a failure.
    if stderr.contains("-128") {
        return Err(CommandError::expected("Cancelled — nothing was changed."));
    }
    Err(CommandError::expected(format!(
        "macOS refused the change: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Idle-sleep assertion
// ============================================================================

static CAFFEINATE: LazyLock<Mutex<Option<std::process::Child>>> =
    LazyLock::new(|| Mutex::new(None));

/// Hold the Mac awake until [`stop_keep_awake`] or until this process exits.
pub fn start_keep_awake() -> Result<(), CommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let mut guard = CAFFEINATE
        .lock()
        .map_err(|e| format!("keep-awake lock poisoned: {e}"))?;
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    // -i idle sleep, -s system sleep (mains only), -m disk sleep. The display
    // is allowed to sleep: nobody is looking at it. -w ties the assertion to
    // our pid, so it is released even if we crash.
    let child = crate::utils::create_command("/usr/bin/caffeinate")
        .args(["-i", "-s", "-m", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| CommandError::from(format!("Could not start caffeinate: {e}")))?;
    tracing::info!(pid = child.id(), "[Remote] Keeping the Mac awake");
    *guard = Some(child);
    Ok(())
}

pub fn stop_keep_awake() {
    let child = CAFFEINATE.lock().ok().and_then(|mut g| g.take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        tracing::info!("[Remote] Released the keep-awake assertion");
    }
}

/// The user asked for the Mac to stay awake on its own account ("Keep this
/// Mac awake" in Agents), apart from remote access. Remote access turning off
/// must not release an assertion the user asked for separately.
static KEEP_AWAKE_ASKED: AtomicBool = AtomicBool::new(false);

/// Hold or release the assertion for the user's own preference. Releasing
/// leaves it held while remote access is on, which needs it as well.
pub fn set_keep_awake_asked(asked: bool, remote_on: bool) -> Result<(), CommandError> {
    KEEP_AWAKE_ASKED.store(asked, Ordering::SeqCst);
    if asked {
        start_keep_awake()
    } else {
        if !remote_on {
            stop_keep_awake();
        }
        Ok(())
    }
}

pub fn keep_awake_asked() -> bool {
    KEEP_AWAKE_ASKED.load(Ordering::SeqCst)
}

pub fn keep_awake_active() -> bool {
    CAFFEINATE
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().map(|c| matches!(c.try_wait(), Ok(None))))
        .unwrap_or(false)
}

// ============================================================================
// Reopen after restart
// ============================================================================

const LAUNCH_AGENT_LABEL: &str = "studio.ship.reopen-at-login";

fn launch_agent_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library/LaunchAgents")
            .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
    })
}

/// The `.app` bundle we are running from. `None` in a dev build, where there
/// is no bundle to reopen and the toggle is shown as unavailable.
pub fn app_bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| p.to_path_buf())
}

pub fn open_at_login_active() -> bool {
    launch_agent_path().is_some_and(|p| p.exists())
}

pub fn launch_agent_plist(bundle: &std::path::Path) -> String {
    let bundle = bundle
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>{bundle}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
}

pub fn set_open_at_login(enabled: bool) -> Result<(), CommandError> {
    let path = launch_agent_path()
        .ok_or_else(|| CommandError::expected("Could not find your home folder."))?;
    if !enabled {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        return Ok(());
    }
    if !cfg!(target_os = "macos") {
        return Err(CommandError::expected(
            "Reopening after a restart is only available on macOS.",
        ));
    }
    let bundle = app_bundle_path().ok_or_else(|| {
        CommandError::expected(
            "This build isn't running from an installed app, so there is nothing to reopen.",
        )
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, launch_agent_plist(&bundle))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_laptop_on_battery() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 6:12 remaining present: true\n";
        assert_eq!(
            parse_pmset_batt(out),
            PowerStatus {
                has_battery: true,
                on_ac: Some(false),
                battery_percent: Some(87),
                charging: Some(false),
            }
        );
    }

    #[test]
    fn parses_a_laptop_charging() {
        let out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t42%; charging; 1:02 remaining present: true\n";
        let s = parse_pmset_batt(out);
        assert_eq!(s.on_ac, Some(true));
        assert_eq!(s.battery_percent, Some(42));
        assert_eq!(s.charging, Some(true));
    }

    #[test]
    fn full_on_ac_counts_as_not_draining() {
        let out = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
        assert_eq!(parse_pmset_batt(out).charging, Some(true));
    }

    #[test]
    fn a_desktop_has_no_battery() {
        let s = parse_pmset_batt("Now drawing from 'AC Power'\n");
        assert!(!s.has_battery);
        assert_eq!(s.on_ac, Some(true));
        assert_eq!(s.battery_percent, None);
    }

    #[test]
    fn unreadable_output_claims_nothing() {
        assert_eq!(parse_pmset_batt(""), PowerStatus::default());
    }

    #[test]
    fn reads_sleep_disabled() {
        let on = "System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n";
        let off = "System-wide power settings:\n SleepDisabled\t\t0\n";
        assert_eq!(parse_sleep_disabled(on), Some(true));
        assert_eq!(parse_sleep_disabled(off), Some(false));
        // Real output on a Mac where it's off: the section is there, the line isn't.
        let absent = "System-wide power settings:\nCurrently in use:\n standby              1\n";
        assert_eq!(parse_sleep_disabled(absent), Some(false));
        assert_eq!(parse_sleep_disabled(""), None);
    }

    #[test]
    fn plist_escapes_the_bundle_path() {
        let plist = launch_agent_plist(std::path::Path::new("/Applications/A&B.app"));
        assert!(plist.contains("<string>/Applications/A&amp;B.app</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }
}
