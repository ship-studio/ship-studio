//! A failed turn in Agents' own words, and what the UI can offer for it.
//!
//! Claude Code's failures reach us raw (stderr, a `result` error) or already
//! classified for another feature (`commands::ai`, whose copy talks about "AI
//! generation"). The two states people actually hit — the usage limit and an
//! expired sign-in — are said plainly here, and tagged so the chat and the
//! sidebar can treat them as the expected, self-healing states they are.
//!
//! The reset time is only ever Claude Code's own: an epoch it printed, or a
//! clock time in this Mac's time zone. A time in another zone is quoted, not
//! converted, because we carry no time-zone database to convert it with.

use chrono::{Datelike, Duration, TimeZone};
use serde::{Deserialize, Serialize};

use super::engine::Engine;
use super::schedule;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    UsageLimit,
    SignedOut,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: FailureKind,
    /// When the usage limit resets (epoch ms), when Claude Code said so in a
    /// form that can be put on this Mac's clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

impl Failure {
    pub const OTHER: Failure = Failure {
        kind: FailureKind::Other,
        resets_at: None,
    };
}

/// The chat line and its tag for a failed turn, on this Mac's clock.
pub fn describe_now(engine: Engine, detail: &str) -> (String, Failure) {
    let zone = iana_time_zone::get_timezone().ok();
    describe(
        engine,
        detail,
        &chrono::Local,
        zone.as_deref(),
        super::store::now_ms(),
    )
}

pub fn describe<Tz: TimeZone>(
    engine: Engine,
    detail: &str,
    tz: &Tz,
    zone: Option<&str>,
    now: i64,
) -> (String, Failure)
where
    Tz::Offset: std::fmt::Display,
{
    let who = engine.label();
    let lower = detail.to_lowercase();
    if is_usage_limit(&lower) {
        let reset = reset_words(&lower);
        let resets_at = reset_epoch(&lower).or_else(|| {
            let (words, named_zone) = reset.as_ref()?;
            // Another zone's clock time can't be placed without a tz database.
            if named_zone.is_some()
                && named_zone.as_deref() != zone.map(str::to_lowercase).as_deref()
            {
                return None;
            }
            next_clock_time(tz, words, now)
        });
        let when = match (resets_at, &reset) {
            (Some(at), _) => format!("It resets {}.", clock_phrase(tz, at, now)),
            (None, Some((words, zone))) => match zone {
                Some(_) => format!("{who} says it resets {}.", original_case(detail, words)),
                None => format!("{who} says it resets at {words}."),
            },
            (None, None) => "It resets on its own; try again later.".to_string(),
        };
        return (
            format!("{who}'s usage limit is reached. {when}"),
            Failure {
                kind: FailureKind::UsageLimit,
                resets_at,
            },
        );
    }
    if is_signed_out(&lower) {
        return (
            format!("{who} is signed out."),
            Failure {
                kind: FailureKind::SignedOut,
                resets_at: None,
            },
        );
    }
    (detail.to_string(), Failure::OTHER)
}

/// A failure that heals on its own, so a scheduled run is worth trying again:
/// the usage limit, the provider (Anthropic or OpenAI) overloaded or
/// erroring, or the network, in either engine's wording. Not a
/// sign-in (that needs the user), and not anything we can't name.
pub fn is_temporary(detail: &str, failure: &Failure) -> bool {
    match failure.kind {
        FailureKind::UsageLimit => true,
        FailureKind::SignedOut => false,
        FailureKind::Other => {
            let lower = detail.to_lowercase();
            let server_error = [
                "api error: 5",
                "api error (5",
                "status 5",
                "status: 5",
                "status code 5",
            ]
            .iter()
            .any(|w| lower.contains(w));
            server_error
                || [
                    "overloaded",
                    "internal server error",
                    "service unavailable",
                    "bad gateway",
                    "gateway timeout",
                    "connection error",
                    "connection reset",
                    "connection refused",
                    "network",
                    "econnreset",
                    "econnrefused",
                    "etimedout",
                    "enotfound",
                    "eai_again",
                    "socket hang up",
                    "fetch failed",
                    "timed out",
                    "temporarily unavailable",
                    // Codex, when its connection to OpenAI drops mid-turn.
                    "stream disconnected",
                ]
                .iter()
                .any(|w| lower.contains(w))
        }
    }
}

fn is_usage_limit(lower: &str) -> bool {
    // Not "usage credits": that one resets when the user tops up, not on a clock.
    [
        "usage limit",
        "session limit",
        "weekly limit",
        "rate limit",
        "hour limit",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// Claude Code's and Codex's own wordings, and `commands::ai`'s classified
/// sentence. Codex signed out, against OpenAI (observed): "unexpected status
/// 401 Unauthorized: Missing bearer or basic authentication in header".
fn is_signed_out(lower: &str) -> bool {
    [
        "please run /login",
        "401 unauthorized",
        "sign in again",
        "oauth token has expired",
        "isn't signed in anymore",
        "not logged in",
        "invalid api key",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// "Claude AI usage limit reached|1730000000": the reset as epoch seconds.
fn reset_epoch(lower: &str) -> Option<i64> {
    let (_, rest) = lower.split_once("limit reached|")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    (digits.len() >= 9).then(|| digits.parse::<i64>().ok().map(|s| s * 1000))?
}

/// "resets 4:40pm (asia/dubai)" → ("4:40pm", Some("asia/dubai")). Only a clock
/// time counts; "resets Nov 7" and the like are left to the generic line.
/// Codex says "try again at 7:18 pm." (observed), in this Mac's time.
fn reset_words(lower: &str) -> Option<(String, Option<String>)> {
    let (_, rest) = lower
        .split_once("resets ")
        .or_else(|| lower.split_once("reset at "))
        .or_else(|| lower.split_once("try again at "))?;
    let rest = rest.trim_start_matches("at ").trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == ':' || c == 'a' || c == 'p' || c == 'm'))
        .unwrap_or(rest.len());
    // "7:18 pm" (Codex) reads as "7:18pm" (Claude Code).
    let spaced = [" am", " pm"]
        .into_iter()
        .find(|m| rest[end..].starts_with(m));
    let time = match spaced {
        Some(m) => format!("{}{}", &rest[..end], m.trim()),
        None => rest[..end].to_string(),
    };
    let end = end + spaced.map_or(0, str::len);
    parse_clock(&time)?;
    let after = rest[end..].trim_start();
    let zone = after
        .strip_prefix('(')
        .and_then(|z| z.split_once(')'))
        .map(|(z, _)| z.trim().to_string())
        .filter(|z| !z.is_empty());
    Some((time, zone))
}

/// The span of `words` as Claude Code wrote it (case and zone included), for quoting.
fn original_case(detail: &str, words: &str) -> String {
    let lower = detail.to_lowercase();
    let Some(start) = lower.find(&format!("resets {words}")).map(|i| i + 7) else {
        return words.to_string();
    };
    let Some(tail) = detail.get(start..) else {
        return words.to_string();
    };
    let end = tail.find(')').map(|i| i + 1).unwrap_or(words.len());
    tail.get(..end).unwrap_or(words).to_string()
}

/// "4:40pm" / "3pm" / "15:00" → (hour, minute).
fn parse_clock(time: &str) -> Option<(u32, u32)> {
    let (digits, meridiem) = match time.strip_suffix("am").or_else(|| time.strip_suffix("pm")) {
        Some(d) => (d, Some(time.ends_with("pm"))),
        None => (time, None),
    };
    let (h, m) = match digits.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (digits.parse::<u32>().ok()?, 0),
    };
    if m > 59 {
        return None;
    }
    let hour = match meridiem {
        Some(pm) if (1..=12).contains(&h) => (h % 12) + if pm { 12 } else { 0 },
        Some(_) => return None,
        // A bare number isn't a time ("resets 5" could be anything).
        None if digits.contains(':') && h < 24 => h,
        None => return None,
    };
    Some((hour, m))
}

/// The next time the clock reads `words`, from `now`.
fn next_clock_time<Tz: TimeZone>(tz: &Tz, words: &str, now: i64) -> Option<i64> {
    let (hour, minute) = parse_clock(words)?;
    let today = tz.timestamp_millis_opt(now).single()?.date_naive();
    let at = schedule::resolve(tz, today, hour, minute)?;
    if at > now {
        return Some(at);
    }
    schedule::resolve(tz, today + Duration::days(1), hour, minute)
}

/// "at 3:00 PM", "tomorrow at 3:00 PM", "on Nov 7 at 3:00 PM".
pub fn clock_phrase<Tz: TimeZone>(tz: &Tz, at: i64, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let (Some(then), Some(today)) = (
        tz.timestamp_millis_opt(at).single(),
        tz.timestamp_millis_opt(now).single(),
    ) else {
        return "soon".to_string();
    };
    let time = then.format("%-I:%M %p").to_string();
    let days = (then.date_naive() - today.date_naive()).num_days();
    match days {
        0 => format!("at {time}"),
        1 => format!("tomorrow at {time}"),
        _ => format!("on {} {} at {time}", then.format("%b"), then.day()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Utc};

    #[test]
    fn only_failures_that_heal_on_their_own_are_temporary() {
        let temp = |d: &str| is_temporary(d, &describe(Engine::Claude, d, &Utc, None, NOW).1);
        let codex = |d: &str| is_temporary(d, &describe(Engine::Codex, d, &Utc, None, NOW).1);
        assert!(temp("Claude AI usage limit reached|1793620800"));
        assert!(temp(
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}"
        ));
        assert!(temp("API Error: 500 Internal server error"));
        assert!(temp("API Error: Connection error."));
        assert!(temp("API Error (Request timed out.)"));
        assert!(temp(
            "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com"
        ));
        assert!(!temp("Claude Code is signed out. Please run /login"));
        assert!(!temp(
            "API Error: 400 invalid_request_error: prompt is too long"
        ));
        assert!(!temp("exit code Some(1), no output"));
        assert!(!temp("Spent 500 tokens"));
        // Codex's own wordings (observed).
        assert!(codex("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."));
        assert!(codex("stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"));
        assert!(codex(
            "exceeded retry limit, last status: 503 Service Unavailable"
        ));
        assert!(codex("unexpected status 502 Bad Gateway"));
        assert!(!codex(
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"
        ));
        assert!(!codex("Codex says: Not logged in."));
        assert!(!codex("exceeded retry limit, last status: 400 Bad Request"));
    }

    /// Mon 2 Nov 2026, 10:00 UTC.
    const NOW: i64 = 1_793_613_600_000;

    #[test]
    fn a_local_clock_time_becomes_a_reset_time() {
        let (text, failure) = describe(
            Engine::Claude,
            "exit code Some(1): You've hit your session limit · resets 4:40pm",
            &Utc,
            Some("Etc/UTC"),
            NOW,
        );
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        let at = failure.resets_at.expect("placed on the clock");
        assert_eq!(at, NOW + (6 * 60 + 40) * 60_000);
        assert_eq!(
            text,
            "Claude Code's usage limit is reached. It resets at 4:40 PM."
        );
    }

    #[test]
    fn a_time_already_passed_today_is_tomorrow() {
        let (text, failure) = describe(
            Engine::Claude,
            "usage limit reached · resets 9am",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, Some(NOW + 23 * 60 * 60_000));
        assert!(text.ends_with("It resets tomorrow at 9:00 AM."), "{text}");
    }

    #[test]
    fn this_macs_named_zone_is_placed_and_another_is_only_quoted() {
        let here = describe(
            Engine::Claude,
            "You've hit your session limit · resets 4:40pm (Asia/Dubai)",
            &FixedOffset::east_opt(4 * 3600).unwrap(),
            Some("Asia/Dubai"),
            NOW,
        );
        assert!(here.1.resets_at.is_some());

        let (text, failure) = describe(
            Engine::Claude,
            "You've hit your session limit · resets 4:40pm (Asia/Dubai)",
            &Utc,
            Some("Europe/London"),
            NOW,
        );
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        assert_eq!(failure.resets_at, None, "never invented");
        assert!(
            text.contains("Claude Code says it resets 4:40pm (Asia/Dubai)."),
            "{text}"
        );
    }

    #[test]
    fn an_epoch_reset_is_exact() {
        let (_, failure) = describe(
            Engine::Claude,
            "Claude AI usage limit reached|1793635200",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, Some(1_793_635_200_000));
    }

    #[test]
    fn no_reset_time_offers_none() {
        let (text, failure) = describe(
            Engine::Claude,
            "Claude AI usage limit reached",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, None);
        assert!(text.ends_with("It resets on its own; try again later."));
        // Nor does a bare number pass for a time.
        assert_eq!(
            describe(Engine::Claude, "usage limit · resets 5", &Utc, None, NOW)
                .1
                .resets_at,
            None
        );
    }

    #[test]
    fn the_other_features_wording_never_reaches_the_chat() {
        let classified =
            "Claude Code hit its usage limit, so AI generation isn't available right now. \
                          The limit resets automatically — try again later. (resets 4:40pm)";
        let (text, _) = describe(Engine::Claude, classified, &Utc, None, NOW);
        assert!(!text.contains("AI generation"), "{text}");

        let signed_out = "Claude Code isn't signed in anymore (its session expired). Open an agent \
                          terminal and sign in again — for Claude Code, run /login — then try again.";
        let (text, failure) = describe(Engine::Claude, signed_out, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
        assert_eq!(text, "Claude Code is signed out.");
    }

    #[test]
    fn codex_says_its_own_failures_and_they_read_the_same() {
        // Codex 0.166's own words (observed), its clock time on this Mac's clock.
        let limit = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM.";
        let (text, failure) = describe(Engine::Codex, limit, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        assert_eq!(failure.resets_at, Some(NOW + (9 * 60 + 18) * 60_000));
        assert_eq!(
            text,
            "Codex's usage limit is reached. It resets at 7:18 PM."
        );
        let signed_out = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
        let (text, failure) = describe(Engine::Codex, signed_out, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
        assert_eq!(text, "Codex is signed out.");
        let (_, failure) = describe(Engine::Codex, "Not logged in", &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
    }

    #[test]
    fn usage_credits_and_anything_else_pass_through() {
        let credits = "Fable 5 requires usage credits. Run /usage-credits to continue.";
        assert_eq!(
            describe(Engine::Claude, credits, &Utc, None, NOW),
            (credits.to_string(), Failure::OTHER)
        );
    }
}
