//! What each agent's turns cost, as Claude Code reports it.
//!
//! The source is the stream's final `result` event: `usage` (token counts),
//! `total_cost_usd` and `duration_ms`. Only those numbers are kept. Nothing is estimated: a turn
//! that reports no cost adds tokens only, and a window containing such a turn
//! shows no dollar figure at all rather than a partial one.

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// Days of history kept per agent: enough for "this week".
const KEEP_DAYS: i64 = 7;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// Sum of `total_cost_usd` over the turns that reported one.
    #[serde(default)]
    pub cost_usd: f64,
    /// Turns that reported a cost. `cost_usd` is the whole story only when
    /// this equals `turns`.
    #[serde(default)]
    pub priced_turns: u32,
    /// Wall-clock time of the turns, as the CLI timed them.
    #[serde(default)]
    pub duration_ms: u64,
}

impl UsageTotals {
    fn add(&mut self, other: &UsageTotals) {
        self.turns += other.turns;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.cost_usd += other.cost_usd;
        self.priced_turns += other.priced_turns;
        self.duration_ms += other.duration_ms;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

/// Stored on the agent in the registry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(default)]
    pub all_time: UsageTotals,
    /// The last few days, oldest first.
    #[serde(default)]
    pub days: Vec<DayUsage>,
}

/// What the edit dialog shows.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// Today and the six days before it.
    pub week: UsageTotals,
    pub all_time: UsageTotals,
}

/// One turn's numbers from a `result` event. `None` when the event carries
/// no usage at all (nothing to record).
pub fn from_result(value: &serde_json::Value) -> Option<UsageTotals> {
    let usage = value.get("usage")?.as_object()?;
    let n = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let cost = value.get("total_cost_usd").and_then(|v| v.as_f64());
    Some(UsageTotals {
        turns: 1,
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_read_tokens: n("cache_read_input_tokens"),
        cache_write_tokens: n("cache_creation_input_tokens"),
        cost_usd: cost.unwrap_or(0.0),
        priced_turns: u32::from(cost.is_some()),
        duration_ms: value
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

fn day_key(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

fn in_window(key: &str, today: NaiveDate) -> bool {
    NaiveDate::parse_from_str(key, "%Y-%m-%d")
        .map(|d| d <= today && today - d < Duration::days(KEEP_DAYS))
        .unwrap_or(false)
}

impl AgentUsage {
    pub fn record(&mut self, turn: &UsageTotals, today: NaiveDate) {
        self.all_time.add(turn);
        let key = day_key(today);
        match self.days.iter_mut().find(|d| d.day == key) {
            Some(day) => day.totals.add(turn),
            None => self.days.push(DayUsage {
                day: key,
                totals: turn.clone(),
            }),
        }
        self.days.retain(|d| in_window(&d.day, today));
        self.days.sort_by(|a, b| a.day.cmp(&b.day));
    }

    pub fn summary(&self, today: NaiveDate) -> UsageSummary {
        let mut week = UsageTotals::default();
        for day in self.days.iter().filter(|d| in_window(&d.day, today)) {
            week.add(&day.totals);
        }
        UsageSummary {
            week,
            all_time: self.all_time.clone(),
        }
    }
}

pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn reads_a_real_result_event() {
        // Trimmed from `claude -p "say ok" --output-format stream-json --verbose`
        // (Claude Code, 2026-11-03).
        let event = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false,
            "total_cost_usd": 0.1448284, "duration_ms": 2381,
            "usage": {"input_tokens": 2, "cache_creation_input_tokens": 17808,
                      "cache_read_input_tokens": 11382, "output_tokens": 4}
        });
        let turn = from_result(&event).unwrap();
        assert_eq!(turn.input_tokens, 2);
        assert_eq!(turn.output_tokens, 4);
        assert_eq!(turn.cache_read_tokens, 11382);
        assert_eq!(turn.cache_write_tokens, 17808);
        assert_eq!(turn.priced_turns, 1);
        assert_eq!(turn.duration_ms, 2381);
        assert!((turn.cost_usd - 0.1448284).abs() < 1e-9);
    }

    #[test]
    fn a_turn_without_cost_counts_tokens_only() {
        let event =
            serde_json::json!({"type": "result", "usage": {"input_tokens": 5, "output_tokens": 7}});
        let turn = from_result(&event).unwrap();
        assert_eq!((turn.turns, turn.priced_turns), (1, 0));
        assert_eq!(turn.cost_usd, 0.0);
        assert!(from_result(&serde_json::json!({"type": "result"})).is_none());
    }

    #[test]
    fn accumulates_per_day_and_keeps_only_the_last_week() {
        let turn = |tokens: u64, cost: f64| UsageTotals {
            turns: 1,
            input_tokens: tokens,
            cost_usd: cost,
            priced_turns: 1,
            ..Default::default()
        };
        let mut usage = AgentUsage::default();
        usage.record(&turn(100, 1.0), day("2026-10-20"));
        usage.record(&turn(10, 0.5), day("2026-10-28"));
        usage.record(&turn(20, 0.25), day("2026-11-03"));
        usage.record(&turn(30, 0.25), day("2026-11-03"));

        // 10-20 fell out of the window when 10-28 was recorded.
        assert_eq!(
            usage
                .days
                .iter()
                .map(|d| d.day.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-10-28", "2026-11-03"]
        );
        assert_eq!(usage.days[1].totals.input_tokens, 50);
        assert_eq!(usage.all_time.turns, 4);
        assert_eq!(usage.all_time.input_tokens, 160);

        // On 11-03 the week is 10-28 ..= 11-03.
        let summary = usage.summary(day("2026-11-03"));
        assert_eq!(summary.week.turns, 3);
        assert_eq!(summary.week.input_tokens, 60);
        assert!((summary.week.cost_usd - 1.0).abs() < 1e-9);
        // A few days later, only what's still inside counts, even unwritten.
        let later = usage.summary(day("2026-11-04"));
        assert_eq!(later.week.input_tokens, 50);
        assert_eq!(later.all_time.input_tokens, 160);
    }

    #[test]
    fn old_registries_without_usage_still_load() {
        let usage: AgentUsage = serde_json::from_str("{}").unwrap();
        assert_eq!(usage, AgentUsage::default());
        let day: DayUsage = serde_json::from_str(r#"{"day":"2026-11-03","turns":2}"#).unwrap();
        assert_eq!(day.totals.turns, 2);
    }
}
