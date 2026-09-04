//! The in-app routine scheduler.
//!
//! One tokio task, ticking once a minute over every armed routine in every
//! known project. This is Tier A of the two-tier model described in
//! `docs/routines-inbox.md`: it fires only while Ship Studio is running, and
//! the UI says so in those words rather than implying a clock the app cannot
//! keep.
//!
//! ## What the tick deliberately does not do
//!
//! - **It never catches up.** An interval means "at least this long since it
//!   last looked", so closing the app for a week produces one run on reopen,
//!   not a week of backlog. A daily routine that was due while the app was
//!   closed is simply late, and runs on the next tick.
//! - **It runs at most one routine per tick.** Routines spend the user's own
//!   agent subscription. Five armed routines coming due in the same minute
//!   must not fire five agents at once and eat someone's quota before they've
//!   noticed the feature exists.
//! - **It skips a project that already has a run in flight.** Two agents
//!   reading and reasoning about the same working tree at once is confusing at
//!   best; if either has `can-edit`, it's a corruption risk.

use crate::commands::routines::{
    next_due_at, projects_with_routines, read_project_routines, Routine,
};
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tracing::{debug, info, warn};

/// How often to look for something due. A minute is the finest granularity the
/// trigger grammar can express, and the scan itself is a handful of `readdir`s.
const TICK: Duration = Duration::from_secs(60);

/// Give the app a moment to finish starting before the first scan, so a routine
/// due at launch doesn't compete with window creation and project loading.
const STARTUP_GRACE: Duration = Duration::from_secs(45);

/// Start the scheduler. Called once from app setup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        info!("routine scheduler started");
        loop {
            if let Err(err) = tick(&app).await {
                // A failing tick must never kill the loop — the next one may
                // well succeed (a project mounted, a CLI reinstalled).
                warn!(error = %err, "routine scheduler tick failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// The armed, time-triggered routine that is most overdue, if any.
fn most_overdue(now: i64) -> Option<Routine> {
    let state = crate::commands::routines::load_state();
    let mut best: Option<(i64, Routine)> = None;

    for project in projects_with_routines() {
        for routine in read_project_routines(&project) {
            if !routine.auto_run || !routine.trigger.is_armable() {
                continue;
            }
            let last = state.last_run_at.get(&routine.id).copied();
            let Some(due) = next_due_at(routine.trigger, last, now) else {
                continue;
            };
            if due > now {
                continue;
            }
            // Most overdue first, so a backlog drains oldest-first rather than
            // letting one routine's cadence starve another's.
            if best.as_ref().is_none_or(|(best_due, _)| due < *best_due) {
                best = Some((due, routine));
            }
        }
    }
    best.map(|(_, routine)| routine)
}

async fn tick(app: &AppHandle) -> Result<(), crate::errors::CommandError> {
    let running = crate::commands::routines::running_routine_ids().await?;
    if !running.is_empty() {
        debug!(?running, "routine already in flight — skipping this tick");
        return Ok(());
    }

    let now = crate::commands::routines::now_ms();
    let Some(routine) = most_overdue(now) else {
        return Ok(());
    };

    info!(routine = %routine.name, "routine came due");
    // A failure is already recorded against the run and surfaced in the
    // routine's history and status dot; the loop keeps going.
    if let Err(err) = crate::commands::routines::run_routine(
        app.clone(),
        routine.project_path.clone(),
        routine.slug.clone(),
    )
    .await
    {
        warn!(routine = %routine.name, error = %err, "scheduled run failed");
    }
    Ok(())
}

/// Run every armed routine whose trigger is `event`, for one project.
///
/// Called when Ship Studio observes the thing itself — a push completing, a PR
/// opening — so these fire during work, which is exactly when the app is open
/// and the honesty problem doesn't arise.
pub async fn fire_event(
    app: &AppHandle,
    project_path: &str,
    event: crate::commands::routines::RoutineEvent,
) {
    let project = PathBuf::from(project_path);
    let matching: Vec<Routine> = read_project_routines(&project)
        .into_iter()
        .filter(|routine| {
            routine.auto_run
                && matches!(
                    routine.trigger,
                    crate::commands::routines::RoutineTrigger::Event { event: e } if e == event
                )
        })
        .collect();

    for routine in matching {
        info!(routine = %routine.name, ?event, "event-triggered routine firing");
        if let Err(err) = crate::commands::routines::run_routine(
            app.clone(),
            routine.project_path.clone(),
            routine.slug.clone(),
        )
        .await
        {
            warn!(routine = %routine.name, error = %err, "event-triggered run failed");
        }
    }
}

/// Fire every `on project-open` routine for a project the user just opened.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn fire_project_open_routines(
    app: AppHandle,
    project_path: String,
) -> Result<(), crate::errors::CommandError> {
    let validated = crate::utils::validate_project_path(&project_path)?;
    fire_event(
        &app,
        &validated.to_string_lossy(),
        crate::commands::routines::RoutineEvent::ProjectOpen,
    )
    .await;
    Ok(())
}

/// Fire every `on push` routine for a project that just pushed.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn fire_push_routines(
    app: AppHandle,
    project_path: String,
) -> Result<(), crate::errors::CommandError> {
    let validated = crate::utils::validate_project_path(&project_path)?;
    fire_event(
        &app,
        &validated.to_string_lossy(),
        crate::commands::routines::RoutineEvent::Push,
    )
    .await;
    Ok(())
}
