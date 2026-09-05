//! # Spotify Widget Commands (macOS only)
//!
//! Read-only "now playing" state plus a small transport/volume control surface
//! for the opt-in Spotify widget, driven through Spotify.app's AppleScript
//! dictionary (`/Applications/Spotify.app/Contents/Resources/Spotify.sdef`).
//!
//! Three properties of this module matter more than the code:
//!
//! 1. **It must never launch Spotify.** Merely *referencing* `application
//!    "Spotify"` in AppleScript launches it. Every entry point therefore runs
//!    `pgrep -x Spotify` first and bails out before osascript is ever spawned.
//!    That guard is also what makes the widget auto-detect: it appears only
//!    while Spotify is genuinely running.
//! 2. **"Not running" is not an error.** It is the normal idle state, so
//!    [`get_spotify_state`] returns `Ok` with [`SpotifyStatus::NotRunning`].
//! 3. **"Permission denied" is its own state.** Under hardened runtime (every
//!    notarized build) Apple Events are gated by TCC; before the user approves
//!    the prompt, osascript fails with `-1743` / "Not authorized to send Apple
//!    events". That surfaces as [`SpotifyStatus::PermissionDenied`] so the UI
//!    can point at System Settings → Privacy & Security → Automation instead of
//!    showing a generic failure.
//!
//! One osascript call per poll returns every field joined by `\u{1}` (a control
//! character that cannot occur in a track title — tabs and pipes both can).

use crate::errors::CommandError;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use crate::external_command::run_with_timeout;
#[cfg(target_os = "macos")]
use crate::utils::create_command;

/// Coarse state of the widget. Serialized as `"ok" | "not_running" |
/// "permission_denied" | "unsupported"` — the frontend switches on these
/// exact strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpotifyStatus {
    /// Spotify is running and answered; the payload fields are populated.
    Ok,
    /// Spotify is not running. Normal idle state, not a failure.
    NotRunning,
    /// macOS blocked the Apple Event (TCC / hardened runtime).
    PermissionDenied,
    /// Not macOS — the widget has no implementation on this platform.
    Unsupported,
}

/// Everything the widget renders, in one poll.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyState {
    pub status: SpotifyStatus,
    /// `"playing" | "paused" | "stopped"`.
    pub player_state: Option<String>,
    pub track_name: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    /// Playback position, in seconds.
    pub position: Option<f64>,
    /// Track length, in seconds (Spotify reports milliseconds; converted here).
    pub duration: Option<f64>,
    /// Output volume, 0-100.
    pub volume: Option<i64>,
    pub shuffling: Option<bool>,
    pub repeating: Option<bool>,
}

impl SpotifyState {
    /// A state carrying nothing but a status — used for every non-`Ok` case.
    fn empty(status: SpotifyStatus) -> Self {
        Self {
            status,
            player_state: None,
            track_name: None,
            artist: None,
            album: None,
            artwork_url: None,
            position: None,
            duration: None,
            volume: None,
            shuffling: None,
            repeating: None,
        }
    }
}

/// Field separator for the single-call AppleScript payload. `\u{1}` (SOH) is
/// not representable in a Spotify track/artist/album name, unlike `\t` or `|`
/// which show up in real titles.
///
/// Only the macOS path (and the tests) parse a payload, so the parsing half of
/// this module is compiled out on other platforms rather than sitting there as
/// dead code in the Windows/Linux builds.
#[cfg(any(target_os = "macos", test))]
const FIELD_DELIMITER: char = '\u{1}';

/// Number of fields [`SPOTIFY_STATE_SCRIPT`] emits. Kept in lockstep with the
/// script's `return` line and with [`parse_state_payload`].
#[cfg(any(target_os = "macos", test))]
const EXPECTED_FIELDS: usize = 10;

/// Parse the delimited osascript payload into a [`SpotifyState`].
///
/// Field order matches the script's `return` expression:
/// `player state, player position, sound volume, shuffling, repeating,
/// track name, artist, album, artwork url, duration`.
///
/// Split on the whole payload rather than per line, so a track name that
/// somehow contains a newline stays inside its own field.
#[cfg(any(target_os = "macos", test))]
fn parse_state_payload(raw: &str) -> Result<SpotifyState, CommandError> {
    let trimmed = raw.trim_end_matches(['\n', '\r']);
    let fields: Vec<&str> = trimmed.split(FIELD_DELIMITER).collect();

    if fields.len() != EXPECTED_FIELDS {
        return Err(CommandError::Other {
            message: format!(
                "Unexpected Spotify state payload: expected {EXPECTED_FIELDS} fields, got {}",
                fields.len()
            ),
        });
    }

    // Duration is the one unit conversion: Spotify's sdef documents `duration`
    // as seconds, but the app reports milliseconds. Confirmed against a live
    // session — a ~4:00 track returned 238720. A zero/absent value means "no
    // current track", not "a zero-length track".
    let duration = parse_number(fields[9])
        .filter(|ms| *ms > 0.0)
        .map(|ms| ms / 1000.0);

    Ok(SpotifyState {
        status: SpotifyStatus::Ok,
        player_state: parse_text(fields[0]).map(|s| s.to_lowercase()),
        position: parse_number(fields[1]),
        volume: parse_number(fields[2]).map(|v| v.round() as i64),
        shuffling: parse_bool(fields[3]),
        repeating: parse_bool(fields[4]),
        track_name: parse_text(fields[5]),
        artist: parse_text(fields[6]),
        album: parse_text(fields[7]),
        artwork_url: parse_text(fields[8]),
        duration,
    })
}

/// Free-text field: empty means "absent". Deliberately does *not* trim — a
/// leading/trailing space can be part of a real track title.
#[cfg(any(target_os = "macos", test))]
fn parse_text(field: &str) -> Option<String> {
    if field.is_empty() {
        None
    } else {
        Some(field.to_string())
    }
}

/// AppleScript renders reals with the *user's* decimal separator, so a
/// comma-decimal locale yields `12,5`. Swap it only when there is no `.`
/// already present, so a well-formed value is never mangled.
#[cfg(any(target_os = "macos", test))]
fn parse_number(field: &str) -> Option<f64> {
    let trimmed = field.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = if trimmed.contains('.') {
        trimmed.to_string()
    } else {
        trimmed.replace(',', ".")
    };
    normalized.parse::<f64>().ok()
}

#[cfg(any(target_os = "macos", test))]
fn parse_bool(field: &str) -> Option<bool> {
    match field.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    }
}

/// True when osascript failed because macOS blocked the Apple Event.
///
/// `-1743` is `errAEEventNotPermitted` (TCC has not been granted, or the user
/// declined the Automation prompt).
#[cfg(target_os = "macos")]
fn is_permission_denied(stderr: &str) -> bool {
    stderr.contains("-1743")
        || stderr
            .to_ascii_lowercase()
            .contains("not authorized to send apple events")
}

/// True when osascript failed because Spotify vanished between the `pgrep`
/// guard and the Apple Event (`-600` is `procNotFound`). A benign race, not a
/// malfunction.
#[cfg(target_os = "macos")]
fn is_not_running_error(stderr: &str) -> bool {
    stderr.contains("-600") || stderr.to_ascii_lowercase().contains("isn't running")
}

/// Actions accepted by [`spotify_control`]. A fixed allowlist — no
/// user-controlled string is ever interpolated into AppleScript source.
const CONTROL_ACTIONS: &[&str] = &[
    "playpause",
    "next",
    "previous",
    "seek",
    "volume",
    "activate",
];

/// Timeout for every osascript / pgrep spawn. A hung osascript must never
/// wedge the widget's polling loop.
#[cfg(target_os = "macos")]
const SPOTIFY_TIMEOUT_SECS: u64 = 2;

/// Single round-trip that reads every field the widget needs.
///
/// Each property name is verified against Spotify.sdef. The inner `try` blocks
/// matter: with the player stopped, `current track` raises rather than
/// returning an empty track, and `artwork url` can be missing for local files.
/// Failing soft there keeps the transport fields usable.
#[cfg(target_os = "macos")]
const SPOTIFY_STATE_SCRIPT: &str = r#"set sep to (character id 1)
tell application "Spotify"
	set ps to (player state as text)
	set pp to (player position as text)
	set sv to (sound volume as text)
	set sf to (shuffling as text)
	set rp to (repeating as text)
	set tn to ""
	set ar to ""
	set al to ""
	set aw to ""
	set du to ""
	try
		set ct to current track
		set tn to (name of ct as text)
		set ar to (artist of ct as text)
		set al to (album of ct as text)
		set du to (duration of ct as text)
		try
			set aw to (artwork url of ct as text)
		end try
	end try
end tell
return ps & sep & pp & sep & sv & sep & sf & sep & rp & sep & tn & sep & ar & sep & al & sep & aw & sep & du"#;

/// Is Spotify running right now?
///
/// This runs *before* any osascript call, because referencing `application
/// "Spotify"` in AppleScript launches the app. `-x` matches the process name
/// exactly, so the `Spotify Helper` processes don't produce a false positive.
///
/// A failure to even run `pgrep` is treated as "not running" — the safe answer,
/// since the alternative is launching Spotify behind the user's back.
#[cfg(target_os = "macos")]
async fn is_spotify_running() -> bool {
    let mut cmd = create_command("/usr/bin/pgrep");
    cmd.args(["-x", "Spotify"]);
    let tokio_cmd = tokio::process::Command::from(cmd);

    match run_with_timeout(tokio_cmd, "pgrep -x Spotify", SPOTIFY_TIMEOUT_SECS).await {
        Ok(output) => output.status.success(),
        Err(error) => {
            tracing::warn!(%error, "pgrep failed; assuming Spotify is not running");
            false
        }
    }
}

/// Run an AppleScript through osascript. Returns the raw stdout on success.
///
/// `script` is always a compile-time constant or built from formatted numbers —
/// never from a user-supplied string.
#[cfg(target_os = "macos")]
async fn run_osascript(script: &str, label: &str) -> Result<OsascriptOutcome, CommandError> {
    let mut cmd = create_command("/usr/bin/osascript");
    cmd.args(["-e", script]);
    let tokio_cmd = tokio::process::Command::from(cmd);

    let output = run_with_timeout(tokio_cmd, label.to_string(), SPOTIFY_TIMEOUT_SECS).await?;

    if output.status.success() {
        return Ok(OsascriptOutcome::Ok(
            String::from_utf8_lossy(&output.stdout).to_string(),
        ));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if is_permission_denied(&stderr) {
        Ok(OsascriptOutcome::PermissionDenied)
    } else if is_not_running_error(&stderr) {
        Ok(OsascriptOutcome::NotRunning)
    } else {
        Err(CommandError::Process {
            cmd: label.to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: stderr.trim().to_string(),
        })
    }
}

/// The three outcomes of an osascript call that the caller must distinguish.
/// Anything else is a real `CommandError`.
#[cfg(target_os = "macos")]
enum OsascriptOutcome {
    Ok(String),
    PermissionDenied,
    NotRunning,
}

/// Message shown when macOS has blocked the Apple Event. Kept in one place so
/// the read and control paths say the same thing.
#[cfg(target_os = "macos")]
const PERMISSION_DENIED_MESSAGE: &str =
    "Ship Studio isn't allowed to control Spotify. Enable it in System Settings → \
     Privacy & Security → Automation, under Ship Studio.";

#[cfg(target_os = "macos")]
const NOT_RUNNING_MESSAGE: &str = "Spotify isn't running.";

#[cfg(target_os = "macos")]
async fn platform_get_state() -> Result<SpotifyState, CommandError> {
    if !is_spotify_running().await {
        return Ok(SpotifyState::empty(SpotifyStatus::NotRunning));
    }

    match run_osascript(SPOTIFY_STATE_SCRIPT, "osascript (spotify state)").await? {
        OsascriptOutcome::Ok(stdout) => parse_state_payload(&stdout),
        OsascriptOutcome::PermissionDenied => {
            Ok(SpotifyState::empty(SpotifyStatus::PermissionDenied))
        }
        OsascriptOutcome::NotRunning => Ok(SpotifyState::empty(SpotifyStatus::NotRunning)),
    }
}

/// Non-macOS backstop. The frontend already hides the widget off macOS; this
/// mirrors the `mobile.rs` precedent of answering honestly rather than 500ing.
#[cfg(not(target_os = "macos"))]
async fn platform_get_state() -> Result<SpotifyState, CommandError> {
    Ok(SpotifyState::empty(SpotifyStatus::Unsupported))
}

/// Read Spotify's current playback state.
///
/// Never fails just because Spotify is closed or unapproved — those are
/// reported through [`SpotifyState::status`], not through `Err`.
#[tauri::command]
#[tracing::instrument]
pub async fn get_spotify_state() -> Result<SpotifyState, CommandError> {
    platform_get_state().await
}

/// Validate `action`/`value` and render the AppleScript for it.
///
/// Returns the script source. The action is matched against a fixed allowlist
/// and numeric values are re-formatted as numbers, so nothing user-controlled
/// reaches the AppleScript compiler as text.
fn build_control_script(action: &str, value: Option<f64>) -> Result<String, CommandError> {
    let invalid_action = || CommandError::Validation {
        field: "action".to_string(),
        reason: format!("Unknown action `{action}`. Expected one of {CONTROL_ACTIONS:?}."),
    };

    let require_value = |field: &str| -> Result<f64, CommandError> {
        match value {
            Some(v) if v.is_finite() => Ok(v),
            _ => Err(CommandError::Validation {
                field: field.to_string(),
                reason: format!("`{action}` requires a finite numeric `value`."),
            }),
        }
    };

    let script = match action {
        "playpause" => "tell application \"Spotify\" to playpause".to_string(),
        "next" => "tell application \"Spotify\" to next track".to_string(),
        "previous" => "tell application \"Spotify\" to previous track".to_string(),
        // Brings Spotify to the foreground so the widget can hand off to the
        // full app. `value` is meaningless here and is ignored, as it is for
        // the other valueless actions.
        //
        // The `pgrep` guard in `platform_control` is load-bearing for this
        // arm specifically: `activate` on a non-running app *launches* it,
        // which is the one behaviour this whole module exists to avoid. The
        // guard runs before any script is spawned, so a closed Spotify is an
        // expected error rather than a surprise launch.
        "activate" => "tell application \"Spotify\" to activate".to_string(),
        "seek" => {
            let seconds = require_value("value")?;
            if seconds < 0.0 {
                return Err(CommandError::Validation {
                    field: "value".to_string(),
                    reason: "Seek position cannot be negative.".to_string(),
                });
            }
            // `{:.3}` always emits a `.`-decimal literal, which is what the
            // AppleScript parser expects regardless of the user's locale.
            format!("tell application \"Spotify\" to set player position to {seconds:.3}")
        }
        "volume" => {
            // Clamp rather than reject: a slider dragged to 100.4 is a UI
            // rounding artifact, not a caller error.
            let level = require_value("value")?.round().clamp(0.0, 100.0) as i64;
            format!("tell application \"Spotify\" to set sound volume to {level}")
        }
        _ => return Err(invalid_action()),
    };

    Ok(script)
}

#[cfg(target_os = "macos")]
async fn platform_control(action: String, value: Option<f64>) -> Result<(), CommandError> {
    // Validate before the pgrep guard so a bad action is reported as a bad
    // action even when Spotify happens to be closed.
    let script = build_control_script(&action, value)?;

    if !is_spotify_running().await {
        return Err(CommandError::expected(NOT_RUNNING_MESSAGE));
    }

    match run_osascript(&script, "osascript (spotify control)").await? {
        OsascriptOutcome::Ok(_) => Ok(()),
        OsascriptOutcome::PermissionDenied => {
            Err(CommandError::expected(PERMISSION_DENIED_MESSAGE))
        }
        OsascriptOutcome::NotRunning => Err(CommandError::expected(NOT_RUNNING_MESSAGE)),
    }
}

#[cfg(not(target_os = "macos"))]
async fn platform_control(action: String, value: Option<f64>) -> Result<(), CommandError> {
    // Still validate, so the error the caller sees is about the platform only
    // when the request itself was well-formed.
    build_control_script(&action, value)?;
    Err(CommandError::expected(
        "Controlling Spotify is available on macOS only.",
    ))
}

/// Drive Spotify playback.
///
/// `action` is one of `playpause`, `next`, `previous`, `seek` (seconds in
/// `value`), `volume` (0-100 in `value`) or `activate` (focus the Spotify
/// window). Anything else is a
/// [`CommandError::Validation`]; controlling a closed Spotify is a clean
/// [`CommandError::Expected`] rather than a launch.
#[tauri::command]
#[tracing::instrument]
pub async fn spotify_control(action: String, value: Option<f64>) -> Result<(), CommandError> {
    platform_control(action, value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a payload the way the AppleScript does, so the tests can't drift
    /// from the field order without failing.
    fn payload(fields: &[&str]) -> String {
        fields.join(&FIELD_DELIMITER.to_string())
    }

    #[test]
    fn parses_a_normal_playing_track() {
        let raw = payload(&[
            "playing",
            "42.5",
            "70",
            "false",
            "false",
            "Everything In Its Right Place",
            "Radiohead",
            "Kid A",
            "https://i.scdn.co/image/abc123",
            "251000",
        ]) + "\n";

        let state = parse_state_payload(&raw).expect("payload should parse");

        assert_eq!(state.status, SpotifyStatus::Ok);
        assert_eq!(state.player_state.as_deref(), Some("playing"));
        assert_eq!(state.position, Some(42.5));
        assert_eq!(state.volume, Some(70));
        assert_eq!(state.shuffling, Some(false));
        assert_eq!(state.repeating, Some(false));
        assert_eq!(
            state.track_name.as_deref(),
            Some("Everything In Its Right Place")
        );
        assert_eq!(state.artist.as_deref(), Some("Radiohead"));
        assert_eq!(state.album.as_deref(), Some("Kid A"));
        assert_eq!(
            state.artwork_url.as_deref(),
            Some("https://i.scdn.co/image/abc123")
        );
        // Spotify reports milliseconds even though the sdef claims seconds.
        assert_eq!(state.duration, Some(251.0));
    }

    /// The whole reason the delimiter is `\u{1}` and not `\t` or `|`.
    #[test]
    fn track_names_may_contain_tabs_and_pipes() {
        let raw = payload(&[
            "paused",
            "0.0",
            "100",
            "true",
            "true",
            "Tab\there | Pipe\tthere",
            "A|B\tC",
            "Album | With\tBoth",
            "",
            "180500",
        ]);

        let state = parse_state_payload(&raw).expect("payload should parse");

        assert_eq!(state.player_state.as_deref(), Some("paused"));
        assert_eq!(state.track_name.as_deref(), Some("Tab\there | Pipe\tthere"));
        assert_eq!(state.artist.as_deref(), Some("A|B\tC"));
        assert_eq!(state.album.as_deref(), Some("Album | With\tBoth"));
        assert_eq!(state.artwork_url, None);
        assert_eq!(state.shuffling, Some(true));
        assert_eq!(state.repeating, Some(true));
        assert_eq!(state.duration, Some(180.5));
    }

    /// Player stopped: the script's inner `try` leaves every track field empty
    /// but the transport fields still arrive.
    #[test]
    fn stopped_player_yields_empty_track_fields() {
        let raw = payload(&["stopped", "0", "35", "false", "false", "", "", "", "", ""]);

        let state = parse_state_payload(&raw).expect("payload should parse");

        assert_eq!(state.status, SpotifyStatus::Ok);
        assert_eq!(state.player_state.as_deref(), Some("stopped"));
        assert_eq!(state.volume, Some(35));
        assert_eq!(state.track_name, None);
        assert_eq!(state.artist, None);
        assert_eq!(state.album, None);
        assert_eq!(state.duration, None);
    }

    #[test]
    fn comma_decimal_locales_still_parse() {
        let raw = payload(&[
            "playing", "12,75", "50", "false", "false", "Song", "Artist", "Album", "", "200000",
        ]);

        let state = parse_state_payload(&raw).expect("payload should parse");
        assert_eq!(state.position, Some(12.75));
    }

    #[test]
    fn short_payload_is_an_error() {
        let raw = payload(&["playing", "1.0", "50"]);
        assert!(parse_state_payload(&raw).is_err());
    }

    #[test]
    fn malformed_payload_without_delimiters_is_an_error() {
        assert!(parse_state_payload("execution error: something went wrong").is_err());
        assert!(parse_state_payload("").is_err());
    }

    #[test]
    fn too_many_fields_is_an_error() {
        let raw = payload(&[
            "playing", "1.0", "50", "false", "false", "S", "A", "Al", "", "1000", "extra",
        ]);
        assert!(parse_state_payload(&raw).is_err());
    }

    #[test]
    fn unparseable_numbers_degrade_to_none_rather_than_failing() {
        let raw = payload(&[
            "playing", "n/a", "n/a", "maybe", "maybe", "S", "A", "Al", "", "n/a",
        ]);

        let state = parse_state_payload(&raw).expect("payload should still parse");
        assert_eq!(state.position, None);
        assert_eq!(state.volume, None);
        assert_eq!(state.shuffling, None);
        assert_eq!(state.repeating, None);
        assert_eq!(state.duration, None);
    }

    #[test]
    fn status_serializes_to_the_strings_the_frontend_switches_on() {
        let json = |status| serde_json::to_string(&SpotifyState::empty(status)).unwrap();

        assert!(json(SpotifyStatus::Ok).contains(r#""status":"ok""#));
        assert!(json(SpotifyStatus::NotRunning).contains(r#""status":"not_running""#));
        assert!(json(SpotifyStatus::PermissionDenied).contains(r#""status":"permission_denied""#));
        assert!(json(SpotifyStatus::Unsupported).contains(r#""status":"unsupported""#));
    }

    #[test]
    fn state_serializes_camel_case_keys() {
        let mut state = SpotifyState::empty(SpotifyStatus::Ok);
        state.track_name = Some("Song".into());
        state.artwork_url = Some("https://example.test/a.jpg".into());
        state.player_state = Some("playing".into());

        let json = serde_json::to_string(&state).unwrap();
        for key in [
            "playerState",
            "trackName",
            "artworkUrl",
            "artist",
            "album",
            "position",
            "duration",
            "volume",
            "shuffling",
            "repeating",
        ] {
            assert!(json.contains(&format!("\"{key}\"")), "missing key {key}");
        }
    }

    #[test]
    fn control_accepts_only_the_allowlisted_actions() {
        assert!(build_control_script("playpause", None).is_ok());
        assert!(build_control_script("next", None).is_ok());
        assert!(build_control_script("previous", None).is_ok());
        assert!(build_control_script("seek", Some(30.0)).is_ok());
        assert!(build_control_script("volume", Some(50.0)).is_ok());
        assert!(build_control_script("activate", None).is_ok());

        for bogus in ["play", "quit", "pause", "", "PLAYPAUSE", "playpause; quit"] {
            let err = build_control_script(bogus, Some(1.0)).unwrap_err();
            assert!(
                matches!(err, CommandError::Validation { .. }),
                "`{bogus}` should be a validation error"
            );
        }
    }

    #[test]
    fn activate_focuses_spotify_and_ignores_any_value() {
        let script = build_control_script("activate", None).unwrap();
        assert_eq!(script, "tell application \"Spotify\" to activate");
        // A stray `value` must not change the emitted script, and must not be
        // silently reinterpreted as a seek/volume argument.
        assert_eq!(
            build_control_script("activate", Some(42.0)).unwrap(),
            script
        );
    }

    #[test]
    fn seek_rejects_negative_and_missing_values() {
        assert!(matches!(
            build_control_script("seek", Some(-1.0)).unwrap_err(),
            CommandError::Validation { .. }
        ));
        assert!(matches!(
            build_control_script("seek", None).unwrap_err(),
            CommandError::Validation { .. }
        ));
        assert!(matches!(
            build_control_script("seek", Some(f64::NAN)).unwrap_err(),
            CommandError::Validation { .. }
        ));
    }

    #[test]
    fn volume_is_clamped_to_0_100() {
        assert_eq!(
            build_control_script("volume", Some(250.0)).unwrap(),
            "tell application \"Spotify\" to set sound volume to 100"
        );
        assert_eq!(
            build_control_script("volume", Some(-40.0)).unwrap(),
            "tell application \"Spotify\" to set sound volume to 0"
        );
        assert_eq!(
            build_control_script("volume", Some(63.4)).unwrap(),
            "tell application \"Spotify\" to set sound volume to 63"
        );
    }

    /// Numbers are re-formatted, never echoed, so nothing a caller sends can
    /// become AppleScript source.
    #[test]
    fn seek_emits_a_locale_independent_numeric_literal() {
        assert_eq!(
            build_control_script("seek", Some(42.5)).unwrap(),
            "tell application \"Spotify\" to set player position to 42.500"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognizes_the_tcc_denial_stderr() {
        assert!(is_permission_denied(
            "execution error: Not authorized to send Apple events to Spotify. (-1743)"
        ));
        assert!(is_permission_denied("error -1743"));
        assert!(!is_permission_denied(
            "execution error: Spotify got an error: Can't get current track. (-1728)"
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognizes_the_app_quit_race_stderr() {
        assert!(is_not_running_error(
            "execution error: Spotify isn't running. (-600)"
        ));
        assert!(!is_not_running_error("execution error: something else"));
    }
}
