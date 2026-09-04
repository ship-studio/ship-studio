//! The in-app workflow scheduler.
//!
//! One tokio task, ticking once a minute over every armed workflow in every
//! known project. This is Tier A of the two-tier model described in
//! `docs/workflows-inbox.md`: it fires only while Ship Studio is running, and
//! the UI says so in those words rather than implying a clock the app cannot
//! keep.
//!
//! ## What the tick deliberately does not do
//!
//! - **It never catches up.** An interval means "at least this long since it
//!   last looked", so closing the app for a week produces one run on reopen,
//!   not a week of backlog. A daily workflow that was due while the app was
//!   closed is simply late, and runs on the next tick.
//! - **It runs at most one workflow per tick.** Workflows spend the user's own
//!   agent subscription. Five armed workflows coming due in the same minute
//!   must not fire five agents at once and eat someone's quota before they've
//!   noticed the feature exists.
//! - **It skips the tick entirely while any run is in flight.** Two agents
//!   reading and reasoning about the same working tree at once is confusing at
//!   best; if either has `can-edit`, it's a corruption risk. The guard is
//!   global rather than per-project because a run started by hand in one
//!   project is still the user's quota and still their machine's CPU.

use crate::commands::workflows::{
    due_at, projects_with_workflows, read_project_workflows, Workflow,
};
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tracing::{debug, info, warn};

/// How often to look for something due. A minute is the finest granularity the
/// trigger grammar can express, and the scan itself is a handful of `readdir`s.
const TICK: Duration = Duration::from_secs(60);

/// Give the app a moment to finish starting before the first scan, so a workflow
/// due at launch doesn't compete with window creation and project loading.
const STARTUP_GRACE: Duration = Duration::from_secs(45);

/// Start the scheduler. Called once from app setup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        info!("workflow scheduler started");
        loop {
            if let Err(err) = tick(&app).await {
                // A failing tick must never kill the loop — the next one may
                // well succeed (a project mounted, a CLI reinstalled).
                warn!(error = %err, "workflow scheduler tick failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// The armed, time-triggered workflow that is most overdue, if any.
fn most_overdue(now: i64) -> Option<Workflow> {
    let state = crate::commands::workflows::load_state();
    let candidates = projects_with_workflows()
        .into_iter()
        .flat_map(|project| read_project_workflows(&project));
    pick_due(candidates, &state.last_run_at, now)
}

/// Choose what to run from a set of candidates.
///
/// Split out from the filesystem scan so the choice itself can be tested: the
/// bug this guards against — asking "when is the next occurrence?" instead of
/// "did one pass?", which made every daily and weekly workflow unrunnable —
/// lived here, in nine lines that read fine and did nothing.
fn pick_due(
    workflows: impl IntoIterator<Item = Workflow>,
    last_run_at: &std::collections::BTreeMap<String, i64>,
    now: i64,
) -> Option<Workflow> {
    let mut best: Option<(i64, Workflow)> = None;
    for workflow in workflows {
        if !workflow.auto_run || !workflow.trigger.is_armable() {
            continue;
        }
        let last = last_run_at.get(&workflow.id).copied();
        // `due_at`, not `next_due_at`: the next occurrence of a daily trigger
        // is always in the future, so asking that question here means daily
        // and weekly workflows never run at all.
        let Some(due) = due_at(workflow.trigger, last, workflow.updated_at, now) else {
            continue;
        };
        // Most overdue first, so a backlog drains oldest-first rather than
        // letting one workflow's cadence starve another's.
        if best.as_ref().is_none_or(|(best_due, _)| due < *best_due) {
            best = Some((due, workflow));
        }
    }
    best.map(|(_, workflow)| workflow)
}

async fn tick(app: &AppHandle) -> Result<(), crate::errors::CommandError> {
    let running = crate::commands::workflows::running_workflow_ids().await?;
    if !running.is_empty() {
        debug!(?running, "workflow already in flight — skipping this tick");
        return Ok(());
    }

    let now = crate::commands::workflows::now_ms();
    let Some(workflow) = most_overdue(now) else {
        return Ok(());
    };

    info!(workflow = %workflow.name, "workflow came due");
    // A failure is already recorded against the run and surfaced in the
    // workflow's history and status dot; the loop keeps going.
    if let Err(err) = crate::commands::workflows::run_workflow_from(
        app.clone(),
        workflow.project_path.clone(),
        workflow.slug.clone(),
        crate::commands::workflows::RunSource::Schedule,
    )
    .await
    {
        warn!(workflow = %workflow.name, error = %err, "scheduled run failed");
    }
    Ok(())
}

/// Run every armed workflow whose trigger is `event`, for one project.
///
/// Called when Ship Studio observes the thing itself — a push completing, a PR
/// opening — so these fire during work, which is exactly when the app is open
/// and the honesty problem doesn't arise.
pub async fn fire_event(
    app: &AppHandle,
    project_path: &str,
    event: crate::commands::workflows::WorkflowEvent,
) {
    let project = PathBuf::from(project_path);
    let matching: Vec<Workflow> = read_project_workflows(&project)
        .into_iter()
        .filter(|workflow| {
            workflow.auto_run
                && matches!(
                    workflow.trigger,
                    crate::commands::workflows::WorkflowTrigger::Event { event: e } if e == event
                )
        })
        .collect();

    for workflow in matching {
        info!(workflow = %workflow.name, ?event, "event-triggered workflow firing");
        if let Err(err) = crate::commands::workflows::run_workflow_from(
            app.clone(),
            workflow.project_path.clone(),
            workflow.slug.clone(),
            crate::commands::workflows::RunSource::Event,
        )
        .await
        {
            warn!(workflow = %workflow.name, error = %err, "event-triggered run failed");
        }
    }
}

/// Fire matching event workflows without making the caller wait.
///
/// The events that trigger workflows are all the tail of an action the user is
/// waiting on — a branch published, a PR opened. Awaiting an agent run there
/// would turn a two-second operation into a two-minute one.
pub fn spawn_event(
    app: &AppHandle,
    project_path: &str,
    event: crate::commands::workflows::WorkflowEvent,
) {
    let app = app.clone();
    let project_path = project_path.to_string();
    tauri::async_runtime::spawn(async move {
        fire_event(&app, &project_path, event).await;
    });
}

/// Fire every `on push` workflow for a project that just pushed.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn fire_push_workflows(
    app: AppHandle,
    project_path: String,
) -> Result<(), crate::errors::CommandError> {
    let validated = crate::utils::validate_project_path(&project_path)?;
    fire_event(
        &app,
        &validated.to_string_lossy(),
        crate::commands::workflows::WorkflowEvent::Push,
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::workflows::{Severity, WorkflowPermission, WorkflowTrigger};
    use std::collections::BTreeMap;

    fn workflow(slug: &str, trigger: WorkflowTrigger, auto_run: bool, updated_at: i64) -> Workflow {
        Workflow {
            id: format!("/p::{slug}"),
            slug: slug.to_string(),
            name: slug.to_string(),
            icon: None,
            description: String::new(),
            agent_id: None,
            project_path: "/p".to_string(),
            project_name: "p".to_string(),
            trigger,
            permission: WorkflowPermission::ReadOnly,
            prompt: "look at something".to_string(),
            severity_floor: Severity::Info,
            auto_run,
            file_path: format!("/p/.shipstudio/workflows/{slug}.md"),
            updated_at: Some(updated_at),
            extra: Default::default(),
        }
    }

    /// Local 09:00 today, so these mean the same thing in any timezone.
    fn nine_am_today() -> i64 {
        use chrono::{Local, TimeZone};
        let day = Local::now().date_naive();
        Local
            .from_local_datetime(&day.and_hms_opt(9, 0, 0).unwrap())
            .single()
            .map(|dt| dt.timestamp_millis())
            // Spring-forward night: 10:00 exists on every day of the year.
            .unwrap_or_else(|| {
                Local
                    .from_local_datetime(&day.and_hms_opt(10, 0, 0).unwrap())
                    .single()
                    .unwrap()
                    .timestamp_millis()
            })
    }

    const DAILY: WorkflowTrigger = WorkflowTrigger::Daily {
        at_hour: 9,
        at_minute: 0,
    };

    #[test]
    fn a_daily_workflow_gets_picked_up_once_its_hour_has_passed() {
        // The regression. This scheduler shipped for weeks selecting nothing
        // here, because it asked for the *next* occurrence and skipped anything
        // in the future — which a next occurrence always is.
        let nine = nine_am_today();
        let armed_yesterday = nine - 86_400_000;
        let workflows = vec![workflow("daily-audit", DAILY, true, armed_yesterday)];
        let picked = pick_due(workflows, &BTreeMap::new(), nine + 60_000);
        assert_eq!(picked.map(|w| w.slug), Some("daily-audit".to_string()));
    }

    #[test]
    fn nothing_is_picked_before_the_hour_arrives() {
        let nine = nine_am_today();
        let workflows = vec![workflow("daily-audit", DAILY, true, nine - 86_400_000)];
        assert!(pick_due(workflows, &BTreeMap::new(), nine - 60_000).is_none());
    }

    #[test]
    fn a_disarmed_or_manual_workflow_is_never_picked() {
        let nine = nine_am_today();
        let yesterday = nine - 86_400_000;
        let workflows = vec![
            workflow("disarmed", DAILY, false, yesterday),
            workflow("manual", WorkflowTrigger::Manual, true, yesterday),
            workflow(
                "on-push",
                WorkflowTrigger::Event {
                    event: crate::commands::workflows::WorkflowEvent::Push,
                },
                true,
                yesterday,
            ),
        ];
        assert!(pick_due(workflows, &BTreeMap::new(), nine + 60_000).is_none());
    }

    #[test]
    fn the_most_overdue_workflow_wins_the_tick() {
        // One run per tick, so which one it is decides whether a slow cadence
        // can be starved by a fast one.
        let now = 1_700_000_000_000;
        let workflows = vec![
            workflow(
                "recent",
                WorkflowTrigger::Interval { every_minutes: 30 },
                true,
                now - 40 * 60_000,
            ),
            workflow(
                "ancient",
                WorkflowTrigger::Interval { every_minutes: 30 },
                true,
                now - 10 * 60 * 60_000,
            ),
        ];
        assert_eq!(
            pick_due(workflows, &BTreeMap::new(), now).map(|w| w.slug),
            Some("ancient".to_string())
        );
    }

    #[test]
    fn a_workflow_that_already_ran_this_hour_is_left_alone() {
        let nine = nine_am_today();
        let mut last_run = BTreeMap::new();
        last_run.insert("/p::daily-audit".to_string(), nine + 30_000);
        let workflows = vec![workflow("daily-audit", DAILY, true, nine - 86_400_000)];
        assert!(pick_due(workflows, &last_run, nine + 3_600_000).is_none());
    }
}
