//! # Workflows
//!
//! A workflow is a standing instruction: a prompt, a project, and something that
//! sets it off. Running one is a headless agent invocation in the project
//! directory; what it finds is filed to the Inbox.
//!
//! The design goal is that Ship Studio owns as little as possible. Three of the
//! four moving parts already existed:
//!
//! | Piece      | What it is                          | Lives in                     |
//! |------------|-------------------------------------|------------------------------|
//! | A workflow  | a markdown file with frontmatter    | `<project>/.shipstudio/workflows/` |
//! | A run      | `claude -p` / `codex exec`          | [`crate::commands::ai::run_agent_headless`] |
//! | A schedule | a tick over armed workflows          | [`crate::workflow_scheduler`] |
//! | A report   | a fenced JSON block in the reply    | [`runs::parse_findings`]     |
//!
//! ## Why the definition is a file and the results are not
//!
//! Workflow files live *in the repo*, under `.shipstudio/workflows/`. They are
//! meant to be read, edited, reviewed and committed like any other source file
//! — and, crucially, **written by the agent itself** (see [`skill`]), which is
//! only possible because the format is plain markdown a model can author
//! without an API.
//!
//! Run history and findings deliberately do **not** live in the repo. They are
//! per-machine, high-churn, and would show up in `git status` and pull requests
//! within a day of use. They go to `~/ShipStudio/.shipstudio/workflows-state.json`,
//! alongside the other workspace-level config (`folders.json`,
//! `attached-libraries.json`).

mod files;
mod progress;
mod runs;
mod skill;
mod state;

pub use files::*;
pub use progress::*;
pub use runs::*;
pub use skill::*;
pub use state::*;

use serde::{Deserialize, Serialize};

/// How severe a finding is. Drives colour, sort order, and the delivery floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

impl Severity {
    /// Lower is more severe — used for both sorting and the delivery floor.
    pub fn rank(self) -> u8 {
        match self {
            Severity::Critical => 0,
            Severity::Warning => 1,
            Severity::Info => 2,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "critical" => Some(Severity::Critical),
            "warning" | "warn" => Some(Severity::Warning),
            "info" | "informational" => Some(Severity::Info),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// What a workflow's agent may do while it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowPermission {
    ReadOnly,
    CanEdit,
}

impl WorkflowPermission {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "read-only" | "readonly" | "read" => Some(WorkflowPermission::ReadOnly),
            "can-edit" | "canedit" | "edit" | "write" => Some(WorkflowPermission::CanEdit),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WorkflowPermission::ReadOnly => "read-only",
            WorkflowPermission::CanEdit => "can-edit",
        }
    }
}

/// Non-time triggers, all of which the app already observes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowEvent {
    Push,
    PrOpened,
}

/// What sets a workflow off.
///
/// Mirrors `WorkflowTrigger` in `src/lib/workflows.ts` exactly — the tag is
/// `kind` and the payload fields are camelCase, so the union deserializes on
/// the frontend without a translation layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkflowTrigger {
    Manual,
    #[serde(rename_all = "camelCase")]
    Interval {
        every_minutes: u32,
    },
    #[serde(rename_all = "camelCase")]
    Daily {
        at_hour: u32,
        at_minute: u32,
    },
    #[serde(rename_all = "camelCase")]
    Weekly {
        /// 0 = Sunday, matching JavaScript's `Date#getDay`.
        weekday: u32,
        at_hour: u32,
        at_minute: u32,
    },
    Event {
        event: WorkflowEvent,
    },
}

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

impl WorkflowTrigger {
    /// The shape of the trigger, with none of its detail — the safe half to
    /// report in analytics, where "daily" is the interesting fact and "09:00"
    /// is somebody's working day.
    pub fn kind_name(self) -> &'static str {
        match self {
            WorkflowTrigger::Manual => "manual",
            WorkflowTrigger::Interval { .. } => "interval",
            WorkflowTrigger::Daily { .. } => "daily",
            WorkflowTrigger::Weekly { .. } => "weekly",
            WorkflowTrigger::Event { .. } => "event",
        }
    }

    /// Parse the frontmatter `trigger:` phrase.
    ///
    /// The grammar is deliberately a human sentence rather than a nested
    /// object: an agent writing one of these files by hand (which is the
    /// primary authoring path — see [`skill`]) gets `trigger: daily at 09:00`
    /// right on the first try far more reliably than a three-key sub-map. An
    /// unrecognised phrase falls back to `manual` rather than failing the whole
    /// file, so one typo costs the schedule, not the workflow.
    pub fn parse(raw: &str) -> Option<Self> {
        let s = raw.trim().to_ascii_lowercase();
        if s.is_empty() || s == "manual" || s == "none" {
            return Some(WorkflowTrigger::Manual);
        }
        if let Some(rest) = s.strip_prefix("on ") {
            return match rest.trim() {
                "push" => Some(WorkflowTrigger::Event {
                    event: WorkflowEvent::Push,
                }),
                "pr" | "pr-opened" | "pull request" => Some(WorkflowTrigger::Event {
                    event: WorkflowEvent::PrOpened,
                }),
                _ => None,
            };
        }
        if let Some(rest) = s.strip_prefix("every ") {
            return parse_duration_minutes(rest.trim())
                .map(|every_minutes| WorkflowTrigger::Interval { every_minutes });
        }
        if let Some(rest) = s.strip_prefix("daily at ") {
            let (at_hour, at_minute) = parse_clock(rest.trim())?;
            return Some(WorkflowTrigger::Daily { at_hour, at_minute });
        }
        if let Some(rest) = s.strip_prefix("weekly on ") {
            let (day_part, time_part) = rest.split_once(" at ")?;
            let weekday = WEEKDAYS
                .iter()
                .position(|d| *d == day_part.trim())
                .map(|i| i as u32)?;
            let (at_hour, at_minute) = parse_clock(time_part.trim())?;
            return Some(WorkflowTrigger::Weekly {
                weekday,
                at_hour,
                at_minute,
            });
        }
        None
    }

    /// The canonical phrase, round-tripping [`WorkflowTrigger::parse`].
    pub fn to_phrase(self) -> String {
        match self {
            WorkflowTrigger::Manual => "manual".to_string(),
            WorkflowTrigger::Interval { every_minutes } => {
                if every_minutes % 60 == 0 && every_minutes >= 60 {
                    format!("every {}h", every_minutes / 60)
                } else {
                    format!("every {every_minutes}m")
                }
            }
            WorkflowTrigger::Daily { at_hour, at_minute } => {
                format!("daily at {at_hour:02}:{at_minute:02}")
            }
            WorkflowTrigger::Weekly {
                weekday,
                at_hour,
                at_minute,
            } => format!(
                "weekly on {} at {at_hour:02}:{at_minute:02}",
                WEEKDAYS[(weekday as usize).min(6)]
            ),
            WorkflowTrigger::Event { event } => match event {
                WorkflowEvent::Push => "on push".to_string(),
                WorkflowEvent::PrOpened => "on pr".to_string(),
            },
        }
    }

    /// Whether arming this trigger means anything. A manual workflow has no
    /// timer to arm — pressing Run is the whole trigger.
    pub fn is_armable(self) -> bool {
        !matches!(self, WorkflowTrigger::Manual)
    }
}

/// `90m`, `2h`, `45` (bare numbers are minutes).
fn parse_duration_minutes(raw: &str) -> Option<u32> {
    let raw = raw.trim();
    let (digits, multiplier) = if let Some(d) = raw.strip_suffix('h') {
        (d, 60)
    } else if let Some(d) = raw.strip_suffix("hr") {
        (d, 60)
    } else if let Some(d) = raw.strip_suffix('m') {
        (d, 1)
    } else if let Some(d) = raw.strip_suffix("min") {
        (d, 1)
    } else {
        (raw, 1)
    };
    let value: u32 = digits.trim().parse().ok()?;
    let minutes = value.checked_mul(multiplier)?;
    // A sub-5-minute loop would burn the user's agent quota faster than they
    // could notice, and a week-long one is a scheduling mistake, not an intent.
    (5..=10_080).contains(&minutes).then_some(minutes)
}

/// `09:00`, `9:00`, `0900`.
fn parse_clock(raw: &str) -> Option<(u32, u32)> {
    let raw = raw.trim();
    let (h, m) = match raw.split_once(':') {
        Some((h, m)) => (h, m),
        None if raw.len() == 4 => raw.split_at(2),
        None => (raw, "0"),
    };
    let hour: u32 = h.trim().parse().ok()?;
    let minute: u32 = m.trim().parse().ok()?;
    (hour < 24 && minute < 60).then_some((hour, minute))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_phrases_round_trip() {
        let cases = [
            WorkflowTrigger::Manual,
            WorkflowTrigger::Interval { every_minutes: 30 },
            WorkflowTrigger::Interval { every_minutes: 120 },
            WorkflowTrigger::Daily {
                at_hour: 9,
                at_minute: 0,
            },
            WorkflowTrigger::Weekly {
                weekday: 1,
                at_hour: 18,
                at_minute: 30,
            },
            WorkflowTrigger::Event {
                event: WorkflowEvent::Push,
            },
            WorkflowTrigger::Event {
                event: WorkflowEvent::PrOpened,
            },
        ];
        for case in cases {
            let phrase = case.to_phrase();
            assert_eq!(
                WorkflowTrigger::parse(&phrase),
                Some(case),
                "round trip failed for {phrase}"
            );
        }
    }

    #[test]
    fn trigger_accepts_the_phrasings_an_agent_would_write() {
        assert_eq!(
            WorkflowTrigger::parse("Every 30 m"),
            Some(WorkflowTrigger::Interval { every_minutes: 30 }),
            "a stray space before the unit must not cost the schedule"
        );
        assert_eq!(
            WorkflowTrigger::parse("every 2h"),
            Some(WorkflowTrigger::Interval { every_minutes: 120 })
        );
        assert_eq!(
            WorkflowTrigger::parse("Daily at 9:00"),
            Some(WorkflowTrigger::Daily {
                at_hour: 9,
                at_minute: 0
            })
        );
        assert_eq!(
            WorkflowTrigger::parse("weekly on friday at 17:30"),
            Some(WorkflowTrigger::Weekly {
                weekday: 5,
                at_hour: 17,
                at_minute: 30
            })
        );
        assert_eq!(
            WorkflowTrigger::parse("on pull request"),
            Some(WorkflowTrigger::Event {
                event: WorkflowEvent::PrOpened
            })
        );
        assert_eq!(WorkflowTrigger::parse(""), Some(WorkflowTrigger::Manual));
    }

    #[test]
    fn interval_bounds_reject_quota_burning_and_nonsense() {
        assert_eq!(WorkflowTrigger::parse("every 1m"), None);
        assert_eq!(WorkflowTrigger::parse("every 4m"), None);
        assert!(WorkflowTrigger::parse("every 5m").is_some());
        assert_eq!(WorkflowTrigger::parse("every 200h"), None);
        assert_eq!(WorkflowTrigger::parse("every banana"), None);
    }

    #[test]
    fn severity_and_permission_parse_loosely() {
        assert_eq!(Severity::parse("CRITICAL"), Some(Severity::Critical));
        assert_eq!(Severity::parse(" warn "), Some(Severity::Warning));
        assert_eq!(Severity::parse("nope"), None);
        assert_eq!(
            WorkflowPermission::parse("readonly"),
            Some(WorkflowPermission::ReadOnly)
        );
        assert_eq!(
            WorkflowPermission::parse("can_edit"),
            Some(WorkflowPermission::CanEdit)
        );
    }

    #[test]
    fn trigger_serializes_as_the_frontend_union() {
        let json = serde_json::to_string(&WorkflowTrigger::Interval { every_minutes: 30 }).unwrap();
        assert_eq!(json, r#"{"kind":"interval","everyMinutes":30}"#);
        let json = serde_json::to_string(&WorkflowTrigger::Event {
            event: WorkflowEvent::PrOpened,
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"event","event":"pr-opened"}"#);
    }
}
