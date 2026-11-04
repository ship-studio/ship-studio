//! Check-ins and routines: an agent that says "I'll check back Thursday" and
//! then does.
//!
//! An agent schedules one with the `schedule_check_in` tool, in the user's
//! local time: once ("tomorrow at 9:00", "in 2 hours") or on repeat ("every
//! weekday at 9:00", "every 2 hours"). It's stored on the agent's registry
//! entry. When it comes due, a turn is queued for that agent with the note it
//! left itself, and a quiet "Scheduled check-in" line goes in the chat above
//! the reply.
//!
//! The rules are the workflow scheduler's (`crate::workflow_scheduler`), and
//! the UI and the tool both say them out loud:
//!
//! - **Nothing fires while Ship Studio is closed.** There is no server.
//! - **A missed one-time check-in fires once, late, when the app reopens**,
//!   and says it's late. The user asked for it; late beats never. An agent
//!   that missed several is woken once, with all of their notes.
//! - **A missed routine doesn't backfill.** A week away is not seven briefs.
//!   A run missed by a few minutes (the Mac was asleep at 9:00 and woke at
//!   9:10) still runs, marked late; anything older waits for its next time.
//! - **At most one check-in fires per tick**, most overdue first, so a
//!   backlog at launch can't start every agent at once.
//!
//! Its own loop, not a line in the workflow tick: that tick awaits a whole
//! workflow run, which can take minutes, and every check-in queued behind it
//! would arrive "late" for a reason that has nothing to do with the user.

use chrono::{
    DateTime, Datelike, Duration as Span, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

use super::runner;
use super::store::{self, MessageKind};
use crate::errors::CommandError;

/// More than this and an agent is spamming, not following up.
pub const MAX_PER_AGENT: usize = 12;
/// A turn spends the user's Claude quota; half an hour is the tightest loop
/// worth having. A week is the loosest an "every" phrase should mean.
pub const MIN_EVERY_MINUTES: u32 = 30;
pub const MAX_EVERY_MINUTES: u32 = 7 * 24 * 60;
const MAX_AHEAD_DAYS: i64 = 366;
const MAX_NOTE_CHARS: usize = 600;

/// Fired more than this after it was due: the app wasn't running (or the Mac
/// was asleep), so it's marked late. A tick is a minute; three is slack.
pub const LATE_AFTER_MS: i64 = 3 * 60_000;
/// A routine missed by more than this is skipped, not run late.
pub const ROUTINE_GRACE_MS: i64 = 30 * 60_000;

const TICK: Duration = Duration::from_secs(60);
/// Same grace as the workflow scheduler: let the window and projects load.
const STARTUP_GRACE: Duration = Duration::from_secs(45);

const MINUTE_MS: i64 = 60_000;

/// How a routine repeats. A one-time check-in has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Repeat {
    /// On these weekdays (0 = Sunday, as in JavaScript), at a local time.
    Days {
        days: Vec<u8>,
        hour: u32,
        minute: u32,
    },
    /// A fixed interval, measured in real minutes (DST doesn't stretch it).
    Every { minutes: u32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIn {
    pub id: String,
    /// What the agent told itself to do, in its own words.
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    /// When it next fires, epoch ms. Advanced past `now` every time a routine
    /// fires or is skipped, so it is always the one true next time.
    pub next_at: i64,
    pub created_at: i64,
    #[serde(default)]
    pub paused: bool,
}

/// Stored on the chat line a firing leaves, so the UI can say when it was for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInMark {
    pub due_at: i64,
    pub late: bool,
    pub repeats: bool,
}

/* -------------------------------------------------------------- grammar */

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

const EXAMPLES: &str = "Examples: \"in 2 hours\", \"tomorrow at 9:00\", \"friday at 14:30\", \"2026-11-20 09:00\", \"every weekday at 9:00\", \"every monday at 8am\", \"every 2 hours\".";

fn weekday(word: &str) -> Option<u8> {
    let word = word.trim().trim_end_matches('s');
    WEEKDAYS
        .iter()
        .position(|d| *d == word || (word.len() >= 3 && d.starts_with(word)))
        .map(|i| i as u8)
}

/// `9`, `9:30`, `09:30`, `9am`, `9:30 pm`, `17:00`, `noon`, `midnight`.
fn clock(raw: &str) -> Option<(u32, u32)> {
    let s = raw.trim().replace('.', "");
    match s.as_str() {
        "noon" => return Some((12, 0)),
        "midnight" => return Some((0, 0)),
        _ => {}
    }
    let (body, meridiem) = if let Some(b) = s.strip_suffix("am") {
        (b.trim(), Some(false))
    } else if let Some(b) = s.strip_suffix("pm") {
        (b.trim(), Some(true))
    } else {
        (s.as_str(), None)
    };
    let (h, m) = body.split_once(':').unwrap_or((body, "0"));
    if h.is_empty() || m.len() > 2 || !h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (mut hour, minute): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if minute > 59 {
        return None;
    }
    match meridiem {
        Some(pm) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour = match (pm, hour) {
                (false, 12) => 0,
                (true, 12) => 12,
                (true, h) => h + 12,
                (false, h) => h,
            };
        }
        None if hour > 23 => return None,
        None => {}
    }
    Some((hour, minute))
}

/// `"<day part> at <time>"`, or `"<day part> <time>"` when the time is the last word.
fn split_at_time(s: &str) -> Option<(&str, (u32, u32))> {
    if let Some((day, time)) = s.rsplit_once(" at ") {
        return Some((day.trim(), clock(time)?));
    }
    // A bare time: "9:00", "5pm".
    if let Some(t) = clock(s) {
        return Some(("", t));
    }
    // "tomorrow 9am", "friday 14:30", "2026-11-20 09:00", "monday 9 am"
    let words: Vec<&str> = s.split(' ').collect();
    for take in [2, 1] {
        if words.len() > take {
            let (day, time) = words.split_at(words.len() - take);
            if let Some(t) = clock(&time.join(" ")) {
                return Some((s[..day.join(" ").len()].trim(), t));
            }
        }
    }
    None
}

/// A wall-clock time on a date in `tz`. On the spring-forward night a time
/// that doesn't exist (02:30) becomes the same time an hour on (03:30), as if
/// the clock had never jumped; on the fall-back night the first of the two
/// 01:30s is used. Both are what a person setting an alarm would expect.
pub fn resolve<Tz: TimeZone>(tz: &Tz, date: NaiveDate, hour: u32, minute: u32) -> Option<i64> {
    let naive = NaiveDateTime::new(date, NaiveTime::from_hms_opt(hour, minute, 0)?);
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => tz
            .from_local_datetime(&(naive + Span::hours(1)))
            .earliest()
            .map(|t| t.timestamp_millis()),
    }
}

fn local<Tz: TimeZone>(tz: &Tz, ms: i64) -> Option<DateTime<Tz>> {
    tz.timestamp_millis_opt(ms).single()
}

/// The first time strictly after `after` that is on one of `days` at `hour:minute`.
pub fn next_on_days<Tz: TimeZone>(
    tz: &Tz,
    days: &[u8],
    hour: u32,
    minute: u32,
    after: i64,
) -> Option<i64> {
    let mut date = local(tz, after)?.date_naive();
    // Eight days covers any weekday, plus today when its time already went.
    for _ in 0..9 {
        if days.contains(&(date.weekday().num_days_from_sunday() as u8)) {
            if let Some(at) = resolve(tz, date, hour, minute) {
                if at > after {
                    return Some(at);
                }
            }
        }
        date = date.succ_opt()?;
    }
    None
}

/// The next time a routine fires after it was due at `due`, skipping every
/// occurrence up to `now` — that is the "no backfill" rule.
pub fn advance<Tz: TimeZone>(tz: &Tz, repeat: &Repeat, due: i64, now: i64) -> Option<i64> {
    match repeat {
        Repeat::Every { minutes } => {
            // Anchored on the schedule, not on when the tick happened to run,
            // so "every 2 hours" doesn't drift a minute a day.
            let step = *minutes as i64 * MINUTE_MS;
            let behind = (now - due).max(0) / step + 1;
            Some(due + behind * step)
        }
        Repeat::Days { days, hour, minute } => next_on_days(tz, days, *hour, *minute, now),
    }
}

/// Parse `when`, relative to `now`, into a repeat (if any) and the first time it fires.
///
/// Errors are written for the agent: they say what was wrong and show the
/// shapes that work, because the agent will simply try again.
pub fn parse<Tz: TimeZone>(when: &str, tz: &Tz, now: i64) -> Result<(Option<Repeat>, i64), String> {
    let s = when
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    if s.is_empty() {
        return fail("`when` is empty.");
    }

    let recurring = s
        .strip_prefix("every ")
        .map(str::to_string)
        .or_else(|| s.strip_prefix("daily at ").map(|t| format!("day at {t}")));
    if let Some(rest) = recurring {
        let repeat = parse_repeat(&rest)?;
        let next = match &repeat {
            Repeat::Every { minutes } => now + *minutes as i64 * MINUTE_MS,
            Repeat::Days { days, hour, minute } => next_on_days(tz, days, *hour, *minute, now)
                .ok_or_else(|| "That time doesn't exist.".to_string())?,
        };
        return Ok((Some(repeat), next));
    }

    let at = parse_once(&s, tz, now)?;
    if at <= now {
        return fail("That time has already passed.");
    }
    if at - now > MAX_AHEAD_DAYS * 24 * 60 * MINUTE_MS {
        return fail("That's more than a year away.");
    }
    Ok((None, at))
}

fn unit_minutes(unit: &str) -> Option<i64> {
    match unit.trim_end_matches('s') {
        "m" | "min" | "minute" => Some(1),
        "h" | "hr" | "hour" => Some(60),
        "d" | "day" => Some(24 * 60),
        "w" | "wk" | "week" => Some(7 * 24 * 60),
        _ => None,
    }
}

/// `30 minutes`, `2h`, `an hour`, `3 days`.
fn amount(s: &str) -> Option<(i64, i64)> {
    let s = s.trim();
    let (n, unit) = match s.split_once(' ') {
        Some((n, unit)) => (n, unit),
        None => {
            let split = s.find(|c: char| !c.is_ascii_digit())?;
            s.split_at(split)
        }
    };
    let n: i64 = match n {
        "a" | "an" | "one" | "" => 1,
        n => n.parse().ok()?,
    };
    (n > 0).then_some(())?;
    Some((n, unit_minutes(unit.trim())?))
}

fn parse_repeat(rest: &str) -> Result<Repeat, String> {
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    // "every 2 hours", "every hour", "every 90 minutes"
    if let Some((n, per)) = amount(rest).or_else(|| amount(&format!("1 {rest}"))) {
        if per < 24 * 60 {
            let minutes = n * per;
            if minutes < MIN_EVERY_MINUTES as i64 {
                return fail("Routines can't run more often than every 30 minutes.");
            }
            return Ok(Repeat::Every {
                minutes: minutes as u32,
            });
        }
        if n == 1 && rest.trim_start_matches("1 ").trim_end_matches('s') != "week" {
            return fail("Give it a time of day, e.g. \"every day at 9:00\".");
        }
        if (n * per) > MAX_EVERY_MINUTES as i64 {
            return fail("That's too far apart for a routine.");
        }
        return fail(
            "For a daily or weekly routine, name the day and time, e.g. \"every monday at 9:00\".",
        );
    }
    let Some((day_part, (hour, minute))) = split_at_time(rest) else {
        return fail("Give the routine a time of day.");
    };
    let mut days: Vec<u8> = match day_part {
        "day" | "morning" | "evening" | "night" => (0..7).collect(),
        "weekday" | "work day" | "workday" => (1..=5).collect(),
        "weekend" | "weekend day" => vec![0, 6],
        list => {
            let mut days = Vec::new();
            for word in list
                .split([',', ' ', '/'])
                .filter(|w| !w.is_empty() && *w != "and")
            {
                match weekday(word) {
                    Some(d) => days.push(d),
                    None => return fail(&format!("\"{word}\" isn't a day I know.")),
                }
            }
            days
        }
    };
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return fail("Name the days.");
    }
    Ok(Repeat::Days { days, hour, minute })
}

fn parse_once<Tz: TimeZone>(s: &str, tz: &Tz, now: i64) -> Result<i64, String> {
    let fail = |why: &str| Err(format!("{why} {EXAMPLES}"));
    let today = local(tz, now)
        .ok_or("The clock is unreadable.")?
        .date_naive();

    // "in 2 hours", "in 3 days". Days and weeks keep the wall-clock time
    // ("in 3 days" at 9:00 is 9:00, even across a DST change).
    if let Some(rest) = s.strip_prefix("in ") {
        let Some((n, per)) = amount(rest) else {
            return fail(&format!("I can't read \"{rest}\" as an amount of time."));
        };
        if per < 24 * 60 {
            return Ok(now + n * per * MINUTE_MS);
        }
        let then = local(tz, now).ok_or("The clock is unreadable.")?;
        let date = today + Span::days(n * per / (24 * 60));
        return resolve(tz, date, then.hour_(), then.minute_())
            .ok_or_else(|| "That time doesn't exist.".to_string());
    }

    let Some((day_part, (hour, minute))) = split_at_time(s) else {
        return fail("Give it a day and a time.");
    };
    let day_part = day_part
        .trim_start_matches("on ")
        .trim_start_matches("next ")
        .trim_start_matches("this ")
        .trim();
    let at = |date: NaiveDate| {
        resolve(tz, date, hour, minute).ok_or_else(|| "That time doesn't exist.".to_string())
    };
    match day_part {
        "" | "today" | "tonight" => {
            let t = at(today)?;
            // A bare time that already went today means tomorrow.
            if t <= now && day_part.is_empty() {
                at(today + Span::days(1))
            } else {
                Ok(t)
            }
        }
        "tomorrow" => at(today + Span::days(1)),
        other => {
            if let Some(d) = weekday(other) {
                return next_on_days(tz, &[d], hour, minute, now)
                    .ok_or_else(|| "That time doesn't exist.".to_string());
            }
            match NaiveDate::parse_from_str(other.trim_end_matches('t'), "%Y-%m-%d") {
                Ok(date) => at(date),
                Err(_) => fail(&format!("I can't read \"{other}\" as a day.")),
            }
        }
    }
}

/// chrono's `Timelike` getters, without importing a trait named like a field.
trait HourMinute {
    fn hour_(&self) -> u32;
    fn minute_(&self) -> u32;
}
impl<Tz: TimeZone> HourMinute for DateTime<Tz> {
    fn hour_(&self) -> u32 {
        chrono::Timelike::hour(&self.naive_local())
    }
    fn minute_(&self) -> u32 {
        chrono::Timelike::minute(&self.naive_local())
    }
}

/* ------------------------------------------------------------- describe */

fn clock_text(hour: u32, minute: u32) -> String {
    format!("{hour:02}:{minute:02}")
}

/// "every weekday at 09:00", "every Monday and Thursday at 08:30", "every 2 hours".
pub fn describe(repeat: &Repeat) -> String {
    match repeat {
        Repeat::Every { minutes } if minutes % 60 == 0 => match minutes / 60 {
            1 => "every hour".to_string(),
            h => format!("every {h} hours"),
        },
        Repeat::Every { minutes } => format!("every {minutes} minutes"),
        Repeat::Days { days, hour, minute } => {
            let at = clock_text(*hour, *minute);
            let named = match days.as_slice() {
                [0, 1, 2, 3, 4, 5, 6] => "day".to_string(),
                [1, 2, 3, 4, 5] => "weekday".to_string(),
                [0, 6] => "weekend day".to_string(),
                list => {
                    let names: Vec<String> = list
                        .iter()
                        .map(|d| {
                            let n = WEEKDAYS[*d as usize % 7];
                            n[..1].to_uppercase() + &n[1..]
                        })
                        .collect();
                    match names.split_last() {
                        Some((last, [])) => last.clone(),
                        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
                        None => String::new(),
                    }
                }
            };
            format!("every {named} at {at}")
        }
    }
}

/// "Thu 5 Nov 2026, 09:00 (UTC-05:00)": exact, and unambiguous to an agent
/// that will repeat it to the user.
pub fn format_time<Tz: TimeZone>(tz: &Tz, ms: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match local(tz, ms) {
        Some(t) => t.format("%a %-d %b %Y, %H:%M (UTC%:z)").to_string(),
        None => ms.to_string(),
    }
}

/* ------------------------------------------------------- what's due now */

#[derive(Debug, Clone, PartialEq)]
pub enum Due {
    /// Run it now. `next` is when a routine fires after this; `None` for a
    /// one-time check-in, which is then removed.
    Fire { late: bool, next: Option<i64> },
    /// A routine whose time passed long ago: move on without running it.
    Skip { next: i64 },
}

/// Whether a check-in is due at `now`, and what happens if so.
pub fn due<Tz: TimeZone>(tz: &Tz, check_in: &CheckIn, now: i64) -> Option<Due> {
    if check_in.paused || check_in.next_at > now {
        return None;
    }
    let overdue = now - check_in.next_at;
    let late = overdue > LATE_AFTER_MS;
    let Some(repeat) = &check_in.repeat else {
        return Some(Due::Fire { late, next: None });
    };
    let next = advance(tz, repeat, check_in.next_at, now)?;
    if overdue > ROUTINE_GRACE_MS {
        Some(Due::Skip { next })
    } else {
        Some(Due::Fire {
            late,
            next: Some(next),
        })
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// (agent id, check-in id, new next time) for routines skipped this tick.
    pub skips: Vec<(String, String, i64)>,
    /// The one check-in that fires this tick, most overdue first.
    pub fire: Option<Firing>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Firing {
    pub agent_id: String,
    pub check_in: CheckIn,
    pub late: bool,
    pub next: Option<i64>,
    /// The same agent's other one-time check-ins that were missed while the
    /// app was closed: folded into this wake and removed with it, so a
    /// reopened app wakes each agent once, not once per missed note.
    pub also: Vec<CheckIn>,
}

pub fn plan<Tz: TimeZone>(tz: &Tz, agents: &[store::Agent], now: i64) -> Plan {
    let mut plan = Plan::default();
    for agent in agents {
        for check_in in &agent.check_ins {
            match due(tz, check_in, now) {
                None => {}
                Some(Due::Skip { next }) => {
                    plan.skips
                        .push((agent.id.clone(), check_in.id.clone(), next))
                }
                Some(Due::Fire { late, next }) => {
                    let older = plan
                        .fire
                        .as_ref()
                        .is_none_or(|f| check_in.next_at < f.check_in.next_at);
                    if older {
                        let also = if late && next.is_none() {
                            agent
                                .check_ins
                                .iter()
                                .filter(|c| c.id != check_in.id && c.repeat.is_none())
                                .filter(|c| !c.paused && now - c.next_at > LATE_AFTER_MS)
                                .cloned()
                                .collect()
                        } else {
                            Vec::new()
                        };
                        plan.fire = Some(Firing {
                            agent_id: agent.id.clone(),
                            check_in: check_in.clone(),
                            late,
                            next,
                            also,
                        });
                    }
                }
            }
        }
    }
    plan
}

/// What the agent is woken with.
pub fn wake_prompt<Tz: TimeZone>(tz: &Tz, firing: &Firing, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let c = &firing.check_in;
    let late = if firing.late {
        format!(
            " It was due {}, but Ship Studio wasn't running then, so it's late.",
            format_time(tz, c.next_at)
        )
    } else {
        String::new()
    };
    let repeats = match &c.repeat {
        Some(r) => format!(
            " This is a routine ({}); cancel_check_in with id {} stops it if it's no longer useful.",
            describe(r),
            c.id
        ),
        None => String::new(),
    };
    let also: String = firing
        .also
        .iter()
        .map(|o| {
            format!(
                "\n[Also missed, due {}: {}]",
                format_time(tz, o.next_at),
                o.note
            )
        })
        .collect();
    format!(
        "[Scheduled check-in you set: {}]{also}\n\n[It's now {}.{late}{repeats} Do what the note says, then tell the user what you found in a few lines. If there's nothing worth their attention, say so in one line.]",
        c.note,
        format_time(tz, now)
    )
}

/* ------------------------------------------------------ store + tools */

pub struct Created {
    pub check_in: CheckIn,
    pub summary: String,
}

/// Add a check-in to an agent. The returned summary is what the tool says
/// back: the exact resolved time, so the agent tells the user something true.
pub fn create(agent_id: &str, when: &str, note: &str) -> Result<Created, CommandError> {
    create_in(&chrono::Local, agent_id, when, note, store::now_ms())
}

fn create_in<Tz: TimeZone>(
    tz: &Tz,
    agent_id: &str,
    when: &str,
    note: &str,
    now: i64,
) -> Result<Created, CommandError>
where
    Tz::Offset: std::fmt::Display,
{
    let note = note.trim();
    if note.is_empty() {
        return Err(super::err_invalid(
            "note",
            "Write a note to yourself saying what to do when it fires.",
        ));
    }
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(super::err_invalid(
            "note",
            "Keep the note under 600 characters.",
        ));
    }
    let (repeat, next_at) = parse(when, tz, now).map_err(|e| super::err_invalid("when", e))?;
    let check_in = CheckIn {
        id: store::new_id()[..8].to_string(),
        note: note.to_string(),
        repeat,
        next_at,
        created_at: now,
        paused: false,
    };
    let mut refused: Option<CommandError> = None;
    let candidate = check_in.clone();
    store::update(agent_id, |agent| {
        if agent.check_ins.len() >= MAX_PER_AGENT {
            refused = Some(CommandError::expected(format!(
                "You already have {MAX_PER_AGENT} check-ins. Cancel one you don't need first (list_check_ins)."
            )));
            return;
        }
        if agent.check_ins.iter().any(|c| {
            c.note == candidate.note
                && c.repeat == candidate.repeat
                && (c.repeat.is_some() || c.next_at == candidate.next_at)
        }) {
            refused = Some(CommandError::expected(
                "That check-in is already scheduled. list_check_ins shows it.",
            ));
            return;
        }
        agent.check_ins.push(candidate);
    })?;
    if let Some(err) = refused {
        return Err(err);
    }
    let when_text = format_time(tz, check_in.next_at);
    let summary = match &check_in.repeat {
        None => format!(
            "Scheduled for {when_text}, your user's local time (id {}). It fires only while Ship Studio is open on this Mac; if it's closed then, it runs as soon as Ship Studio reopens, marked late. Tell the user the time.",
            check_in.id
        ),
        Some(r) => format!(
            "Routine set: {}, your user's local time. First run {when_text} (id {}). It runs only while Ship Studio is open on this Mac; a run missed while it's closed is skipped, not made up. Tell the user exactly this.",
            describe(r),
            check_in.id
        ),
    };
    Ok(Created { check_in, summary })
}

/// The tool's answer to `list_check_ins`.
pub fn list_text(agent: &store::Agent) -> String {
    if agent.check_ins.is_empty() {
        return "Nothing scheduled.".to_string();
    }
    let tz = chrono::Local;
    agent
        .check_ins
        .iter()
        .map(|c| {
            let when = match &c.repeat {
                Some(r) => format!("{}, next {}", describe(r), format_time(&tz, c.next_at)),
                None => format_time(&tz, c.next_at),
            };
            let paused = if c.paused {
                " [paused by the user]"
            } else {
                ""
            };
            format!("- {} · {when}{paused}: {}", c.id, c.note)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove one. Errors if it doesn't exist (the agent should know).
pub fn cancel(agent_id: &str, id: &str) -> Result<CheckIn, CommandError> {
    let id = id.trim();
    let mut removed = None;
    store::update(agent_id, |agent| {
        if let Some(i) = agent.check_ins.iter().position(|c| c.id == id) {
            removed = Some(agent.check_ins.remove(i));
        }
    })?;
    removed.ok_or_else(|| {
        CommandError::expected(format!(
            "There's no check-in with id {id}. list_check_ins shows what's scheduled."
        ))
    })
}

/// Pause or resume. A resumed routine picks up at its next time from now
/// rather than firing for what it missed while paused.
pub fn set_paused(agent_id: &str, id: &str, paused: bool) -> Result<(), CommandError> {
    let now = store::now_ms();
    let tz = chrono::Local;
    let mut found = false;
    store::update(agent_id, |agent| {
        if let Some(c) = agent.check_ins.iter_mut().find(|c| c.id == id) {
            found = true;
            if c.paused && !paused && c.next_at <= now {
                if let Some(r) = &c.repeat {
                    if let Some(next) = advance(&tz, r, c.next_at, now) {
                        c.next_at = next;
                    }
                }
            }
            c.paused = paused;
        }
    })?;
    if found {
        Ok(())
    } else {
        Err(CommandError::expected("That check-in no longer exists."))
    }
}

/* ------------------------------------------------------------- the tick */

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        loop {
            if let Err(err) = tick(&app) {
                tracing::warn!(error = %err, "agent check-in tick failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

fn tick(app: &AppHandle) -> Result<(), CommandError> {
    let tz = chrono::Local;
    let now = store::now_ms();
    let agents = store::list()?;
    let plan = plan(&tz, &agents, now);
    let changed = !plan.skips.is_empty() || plan.fire.is_some();

    for (agent_id, id, next) in &plan.skips {
        tracing::info!(agent = %agent_id, check_in = %id, "routine missed while closed; skipped to its next time");
        let _ = store::update(agent_id, |a| {
            if let Some(c) = a.check_ins.iter_mut().find(|c| &c.id == id) {
                c.next_at = *next;
            }
        });
    }

    if let Some(firing) = plan.fire {
        // Move it on before waking anyone, so a crash mid-turn can't fire it twice.
        store::update(&firing.agent_id, |a| match firing.next {
            Some(next) => {
                if let Some(c) = a.check_ins.iter_mut().find(|c| c.id == firing.check_in.id) {
                    c.next_at = next;
                }
            }
            None => a.check_ins.retain(|c| {
                c.id != firing.check_in.id && !firing.also.iter().any(|o| o.id == c.id)
            }),
        })?;
        let note = std::iter::once(&firing.check_in)
            .chain(&firing.also)
            .map(|c| c.note.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut line = runner::new_message(&firing.agent_id, MessageKind::CheckIn, note);
        line.check_in = Some(CheckInMark {
            due_at: firing.check_in.next_at,
            late: firing.late,
            repeats: firing.check_in.repeat.is_some(),
        });
        // Wake first, then record the line: recorded during the turn, it goes
        // through `runner::record` like a reply (a `wants_user` kind), so the
        // notifications slice posts one banner for the check-in and its
        // answer when the turn ends, rather than one for each.
        runner::enqueue(
            app,
            &firing.agent_id,
            wake_prompt(&tz, &firing, now),
            runner::From::User,
        );
        runner::record(app, line)?;
    }
    if changed {
        let _ = tauri::Emitter::emit(app, runner::EVENT_REGISTRY, ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate, Offset};

    /// US Eastern for 2026, by hand (chrono has no tz database here):
    /// EDT (UTC-4) from Sun 8 Mar 02:00 local to Sun 1 Nov 02:00 local.
    #[derive(Debug, Clone, Copy)]
    struct Eastern;

    fn est() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }
    fn edt() -> FixedOffset {
        FixedOffset::west_opt(4 * 3600).unwrap()
    }
    fn dst_start_utc() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(7, 0, 0)
            .unwrap()
    }
    fn dst_end_utc() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 1)
            .unwrap()
            .and_hms_opt(6, 0, 0)
            .unwrap()
    }

    impl TimeZone for Eastern {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            Eastern
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let as_est = *local + Span::hours(5);
            let as_edt = *local + Span::hours(4);
            let est_ok = self.offset_from_utc_datetime(&as_est) == est();
            let edt_ok = self.offset_from_utc_datetime(&as_edt) == edt();
            match (edt_ok, est_ok) {
                (true, true) => LocalResult::Ambiguous(edt(), est()),
                (true, false) => LocalResult::Single(edt()),
                (false, true) => LocalResult::Single(est()),
                (false, false) => LocalResult::None,
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            if *utc >= dst_start_utc() && *utc < dst_end_utc() {
                edt()
            } else {
                est()
            }
        }
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        resolve(&Eastern, NaiveDate::from_ymd_opt(y, mo, d).unwrap(), h, mi).unwrap()
    }
    fn show(ms: i64) -> String {
        Eastern
            .timestamp_millis_opt(ms)
            .unwrap()
            .format("%a %Y-%m-%d %H:%M %:z")
            .to_string()
    }
    /// Tue 3 Nov 2026, 15:00 Eastern.
    fn now() -> i64 {
        at(2026, 11, 3, 15, 0)
    }
    fn once(when: &str) -> String {
        let (repeat, next) = parse(when, &Eastern, now()).unwrap();
        assert!(repeat.is_none(), "{when} should be one-time");
        show(next)
    }

    #[test]
    fn the_test_zone_really_has_dst() {
        assert_eq!(
            Eastern.offset_from_utc_datetime(&dst_start_utc()).fix(),
            edt()
        );
        assert_eq!(show(at(2026, 7, 1, 9, 0)), "Wed 2026-07-01 09:00 -04:00");
        assert_eq!(show(at(2026, 12, 1, 9, 0)), "Tue 2026-12-01 09:00 -05:00");
    }

    #[test]
    fn one_time_phrases_resolve_to_exact_local_times() {
        assert_eq!(once("tomorrow at 9:00"), "Wed 2026-11-04 09:00 -05:00");
        assert_eq!(once("Tomorrow 9am"), "Wed 2026-11-04 09:00 -05:00");
        assert_eq!(once("friday at 2:30pm"), "Fri 2026-11-06 14:30 -05:00");
        assert_eq!(once("on Thursday at 17:00"), "Thu 2026-11-05 17:00 -05:00");
        assert_eq!(once("next monday 08:15"), "Mon 2026-11-09 08:15 -05:00");
        assert_eq!(once("2026-11-20 09:00"), "Fri 2026-11-20 09:00 -05:00");
        assert_eq!(once("today at 6pm"), "Tue 2026-11-03 18:00 -05:00");
        assert_eq!(once("in 2 hours"), "Tue 2026-11-03 17:00 -05:00");
        assert_eq!(once("in 90 minutes"), "Tue 2026-11-03 16:30 -05:00");
        assert_eq!(once("in an hour"), "Tue 2026-11-03 16:00 -05:00");
        assert_eq!(once("in 3 days"), "Fri 2026-11-06 15:00 -05:00");
        // A bare time that already went today means tomorrow.
        assert_eq!(once("9:00"), "Wed 2026-11-04 09:00 -05:00");
        // The same weekday as today, later today, is today.
        assert_eq!(once("tuesday at 16:00"), "Tue 2026-11-03 16:00 -05:00");
        assert_eq!(once("tuesday at 10:00"), "Tue 2026-11-10 10:00 -05:00");
        assert_eq!(once("tomorrow at noon"), "Wed 2026-11-04 12:00 -05:00");
        assert_eq!(once("tomorrow at 12am"), "Wed 2026-11-04 00:00 -05:00");
    }

    #[test]
    fn recurring_phrases_parse_into_routines() {
        let r = |w: &str| parse(w, &Eastern, now()).unwrap().0.unwrap();
        assert_eq!(
            r("every weekday at 9:00"),
            Repeat::Days {
                days: vec![1, 2, 3, 4, 5],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            r("Every Monday at 8am"),
            Repeat::Days {
                days: vec![1],
                hour: 8,
                minute: 0
            }
        );
        assert_eq!(
            r("every mon, thu and fri at 17:30"),
            Repeat::Days {
                days: vec![1, 4, 5],
                hour: 17,
                minute: 30
            }
        );
        assert_eq!(
            r("every mondays at 9"),
            Repeat::Days {
                days: vec![1],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            r("daily at 07:45"),
            Repeat::Days {
                days: (0..7).collect(),
                hour: 7,
                minute: 45
            }
        );
        assert_eq!(r("every 2 hours"), Repeat::Every { minutes: 120 });
        assert_eq!(r("every hour"), Repeat::Every { minutes: 60 });
        assert_eq!(r("every 45 minutes"), Repeat::Every { minutes: 45 });
    }

    #[test]
    fn the_grammar_refuses_what_it_cant_mean() {
        for bad in [
            "",
            "soon",
            "yesterday at 9",
            "tomorrow",
            "every day",
            "every monday",
            "every 5 minutes",
            "every 2 days",
            "every blursday at 9",
            "tomorrow at 25:00",
            "tomorrow at 13pm",
            "today at 9:00",
            "2025-01-01 09:00",
            "2028-01-01 09:00",
            "in 0 minutes",
        ] {
            let result = parse(bad, &Eastern, now());
            assert!(result.is_err(), "{bad:?} parsed as {result:?}");
        }
        // And the error teaches the agent the shapes that work.
        assert!(parse("soon", &Eastern, now())
            .unwrap_err()
            .contains("every weekday at 9:00"));
    }

    #[test]
    fn describes_routines_the_way_a_person_would() {
        let d = |w: &str| describe(&parse(w, &Eastern, now()).unwrap().0.unwrap());
        assert_eq!(d("every weekday at 9:00"), "every weekday at 09:00");
        assert_eq!(d("every day at 9"), "every day at 09:00");
        assert_eq!(d("every sat, sun at 10"), "every weekend day at 10:00");
        assert_eq!(
            d("every mon and thu at 8:30"),
            "every Monday and Thursday at 08:30"
        );
        assert_eq!(d("every 2 hours"), "every 2 hours");
        assert_eq!(d("every 90 minutes"), "every 90 minutes");
    }

    #[test]
    fn a_daily_routine_stays_at_nine_across_both_dst_changes() {
        let days: Vec<u8> = (0..7).collect();
        // Spring: Sat 7 Mar 09:00 EST → Sun 8 Mar 09:00 EDT, 23 hours later.
        let sat = at(2026, 3, 7, 9, 0);
        let sun = next_on_days(&Eastern, &days, 9, 0, sat).unwrap();
        assert_eq!(show(sun), "Sun 2026-03-08 09:00 -04:00");
        assert_eq!(sun - sat, 23 * 3_600_000);
        // Autumn: Sat 31 Oct 09:00 EDT → Sun 1 Nov 09:00 EST, 25 hours later.
        let sat = at(2026, 10, 31, 9, 0);
        let sun = next_on_days(&Eastern, &days, 9, 0, sat).unwrap();
        assert_eq!(show(sun), "Sun 2026-11-01 09:00 -05:00");
        assert_eq!(sun - sat, 25 * 3_600_000);
    }

    #[test]
    fn a_time_inside_the_dst_gap_or_overlap_still_fires_once() {
        let days: Vec<u8> = (0..7).collect();
        // 02:30 doesn't exist on 8 Mar: it fires at 03:30, as if the clock hadn't jumped.
        let before = at(2026, 3, 7, 12, 0);
        let gap = next_on_days(&Eastern, &days, 2, 30, before).unwrap();
        assert_eq!(show(gap), "Sun 2026-03-08 03:30 -04:00");
        // And the next day is back to 02:30.
        let after = next_on_days(&Eastern, &days, 2, 30, gap).unwrap();
        assert_eq!(show(after), "Mon 2026-03-09 02:30 -04:00");
        // 01:30 happens twice on 1 Nov: the first one, and only once.
        let before = at(2026, 10, 31, 12, 0);
        let first = next_on_days(&Eastern, &days, 1, 30, before).unwrap();
        assert_eq!(show(first), "Sun 2026-11-01 01:30 -04:00");
        let next = next_on_days(&Eastern, &days, 1, 30, first).unwrap();
        assert_eq!(show(next), "Mon 2026-11-02 01:30 -05:00");
    }

    #[test]
    fn in_n_days_keeps_the_wall_clock_across_dst() {
        let fri = at(2026, 10, 30, 9, 0);
        let (_, next) = parse("in 3 days", &Eastern, fri).unwrap();
        assert_eq!(show(next), "Mon 2026-11-02 09:00 -05:00");
        // Hours are real hours.
        let (_, next) = parse("in 48 hours", &Eastern, fri).unwrap();
        assert_eq!(show(next), "Sun 2026-11-01 08:00 -05:00");
    }

    #[test]
    fn an_interval_routine_counts_real_time_and_does_not_drift() {
        let r = Repeat::Every { minutes: 120 };
        let due_at = at(2026, 11, 3, 9, 0);
        // The tick ran 40s late: the next is still 11:00, not 11:00:40.
        assert_eq!(
            show(advance(&Eastern, &r, due_at, due_at + 40_000).unwrap()),
            "Tue 2026-11-03 11:00 -05:00"
        );
        // Across the fall-back hour, 2 hours is 2 real hours.
        let night = at(2026, 11, 1, 0, 30);
        assert_eq!(
            show(advance(&Eastern, &r, night, night).unwrap()),
            "Sun 2026-11-01 01:30 -05:00"
        );
    }

    fn check_in(id: &str, next_at: i64, repeat: Option<Repeat>) -> CheckIn {
        CheckIn {
            id: id.into(),
            note: format!("note {id}"),
            repeat,
            next_at,
            created_at: 0,
            paused: false,
        }
    }

    fn weekdays_at_nine() -> Option<Repeat> {
        Some(Repeat::Days {
            days: vec![1, 2, 3, 4, 5],
            hour: 9,
            minute: 0,
        })
    }

    #[test]
    fn nothing_fires_before_its_time_or_while_paused() {
        let nine = at(2026, 11, 3, 9, 0);
        assert_eq!(due(&Eastern, &check_in("a", nine, None), nine - 1), None);
        let mut paused = check_in("a", nine, None);
        paused.paused = true;
        assert_eq!(due(&Eastern, &paused, nine + 3_600_000), None);
    }

    #[test]
    fn on_time_firing_is_not_late() {
        let nine = at(2026, 11, 3, 9, 0);
        assert_eq!(
            due(&Eastern, &check_in("a", nine, None), nine + 30_000),
            Some(Due::Fire {
                late: false,
                next: None
            })
        );
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", nine, weekdays_at_nine()),
                nine + 30_000
            ),
            Some(Due::Fire {
                late: false,
                next: Some(at(2026, 11, 4, 9, 0))
            })
        );
    }

    #[test]
    fn a_missed_one_time_check_in_fires_once_late() {
        // Due Monday 9:00; Ship Studio reopened Wednesday afternoon.
        let due_at = at(2026, 11, 2, 9, 0);
        let reopened = at(2026, 11, 4, 14, 0);
        assert_eq!(
            due(&Eastern, &check_in("a", due_at, None), reopened),
            Some(Due::Fire {
                late: true,
                next: None
            })
        );
    }

    #[test]
    fn a_routine_missed_by_minutes_runs_late_but_one_missed_for_days_is_skipped() {
        let due_at = at(2026, 11, 3, 9, 0);
        // The Mac woke at 9:10: today's brief still comes, marked late.
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", due_at, weekdays_at_nine()),
                due_at + 10 * 60_000
            ),
            Some(Due::Fire {
                late: true,
                next: Some(at(2026, 11, 4, 9, 0))
            })
        );
        // Closed since last Monday's 9:00, reopened this Saturday: no backfill,
        // just the next weekday at 9:00.
        let last_monday = at(2026, 10, 26, 9, 0);
        let saturday = at(2026, 10, 31, 11, 0);
        assert_eq!(
            due(
                &Eastern,
                &check_in("r", last_monday, weekdays_at_nine()),
                saturday
            ),
            Some(Due::Skip {
                next: at(2026, 11, 2, 9, 0)
            })
        );
    }

    fn agent_with(id: &str, check_ins: Vec<CheckIn>) -> store::Agent {
        store::Agent {
            id: id.into(),
            name: id.into(),
            role: String::new(),
            shape: 0,
            color: "red".into(),
            is_main: false,
            pinned: false,
            hidden: false,
            session_id: None,
            created_at: 0,
            last_activity_at: 0,
            preview: None,
            unread: 0,
            pending_approvals: 0,
            model: None,
            muted: false,
            check_ins,
            usage: Default::default(),
            permissions: Vec::new(),
            failure: None,
            project: None,
        }
    }

    #[test]
    fn one_check_in_fires_per_tick_most_overdue_first_and_skips_are_all_applied() {
        let now = at(2026, 11, 3, 15, 0);
        let agents = vec![
            agent_with("a", vec![check_in("recent", now - 60_000, None)]),
            agent_with(
                "b",
                vec![
                    check_in("oldest", now - 86_400_000, None),
                    check_in("stale-routine", now - 3 * 86_400_000, weekdays_at_nine()),
                ],
            ),
        ];
        let plan = plan(&Eastern, &agents, now);
        let fire = plan.fire.unwrap();
        assert_eq!(
            (fire.agent_id.as_str(), fire.check_in.id.as_str(), fire.late),
            ("b", "oldest", true)
        );
        assert_eq!(
            plan.skips,
            vec![("b".into(), "stale-routine".into(), at(2026, 11, 4, 9, 0))]
        );
    }

    #[test]
    fn the_wake_prompt_carries_the_note_and_says_when_it_is_late() {
        let due_at = at(2026, 11, 2, 9, 0);
        let firing = Firing {
            agent_id: "a".into(),
            check_in: check_in("x1", due_at, None),
            late: true,
            next: None,
            also: vec![check_in("x2", due_at + 3_600_000, None)],
        };
        let prompt = wake_prompt(&Eastern, &firing, at(2026, 11, 3, 15, 0));
        assert!(prompt.starts_with("[Scheduled check-in you set: note x1]"));
        assert!(prompt.contains("Mon 2 Nov 2026, 09:00 (UTC-05:00)"));
        assert!(prompt.contains("late"));
        assert!(prompt.contains("[Also missed, due Mon 2 Nov 2026, 10:00 (UTC-05:00): note x2]"));
    }

    #[test]
    fn a_reopened_app_wakes_each_agent_once_for_everything_it_missed() {
        let now = at(2026, 11, 3, 15, 0);
        let agents = vec![agent_with(
            "a",
            vec![
                check_in("first", now - 2 * 86_400_000, None),
                check_in("second", now - 86_400_000, None),
                // Not missed: due in a minute, stays for its own time.
                check_in("upcoming", now + 60_000, None),
                // A routine is never folded into a one-off's wake.
                check_in("routine", now - 60_000, weekdays_at_nine()),
            ],
        )];
        let fire = plan(&Eastern, &agents, now).fire.unwrap();
        assert_eq!(fire.check_in.id, "first");
        let also: Vec<&str> = fire.also.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(also, vec!["second"]);
        // On time: nothing is folded in.
        let on_time = vec![agent_with(
            "a",
            vec![
                check_in("now", now - 10_000, None),
                check_in("now2", now - 5_000, None),
            ],
        )];
        assert!(plan(&Eastern, &on_time, now).fire.unwrap().also.is_empty());
    }

    #[test]
    fn creating_answers_with_the_exact_time_and_refuses_spam() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let agent = store::create(store::NewAgent {
            name: "Finance".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        let made = create_in(
            &Eastern,
            &agent.id,
            "friday at 9:00",
            "Chase Northwind",
            now(),
        )
        .unwrap();
        assert!(
            made.summary.contains("Fri 6 Nov 2026, 09:00 (UTC-05:00)"),
            "{}",
            made.summary
        );
        assert!(made.summary.contains("only while Ship Studio is open"));
        let again = create_in(
            &Eastern,
            &agent.id,
            "friday at 10:00",
            "Chase Northwind",
            now(),
        );
        assert!(
            again.is_ok(),
            "a different time for the same note is a new one-off"
        );
        let routine = create_in(&Eastern, &agent.id, "every weekday at 9", "Brief", now()).unwrap();
        assert!(routine.summary.contains("every weekday at 09:00"));
        assert!(routine.summary.contains("skipped, not made up"));
        assert!(create_in(&Eastern, &agent.id, "every weekday at 10", "Brief", now()).is_ok());
        assert!(create_in(&Eastern, &agent.id, "every weekday at 10", "Brief", now()).is_err());
        assert!(create_in(&Eastern, &agent.id, "tomorrow at 9", "  ", now()).is_err());

        assert_eq!(store::get(&agent.id).unwrap().check_ins.len(), 4);
        cancel(&agent.id, &made.check_in.id).unwrap();
        assert!(cancel(&agent.id, &made.check_in.id).is_err());
        for i in 0..MAX_PER_AGENT {
            let _ = create_in(&Eastern, &agent.id, "in 3 hours", &format!("n{i}"), now());
        }
        assert_eq!(
            store::get(&agent.id).unwrap().check_ins.len(),
            MAX_PER_AGENT
        );
        store::set_root_for_tests(None);
    }

    #[test]
    fn check_ins_are_optional_in_an_old_registry() {
        let old = r#"{"id":"a","name":"A","shape":0,"color":"red","createdAt":0}"#;
        let agent: store::Agent = serde_json::from_str(old).unwrap();
        assert!(agent.check_ins.is_empty());
        // And an agent with none doesn't grow the file.
        assert!(!serde_json::to_string(&agent).unwrap().contains("checkIns"));
    }
}
