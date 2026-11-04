//! Tauri commands for the Agents view. The logic lives in `crate::agents`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::{
    self, attachments, files, import, mcp, notify, project, prompts, runner, schedule, search,
    store, usage,
};
use crate::errors::CommandError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    #[serde(flatten)]
    pub agent: store::Agent,
    pub status: runner::Status,
    /// The agent's home, which attachment paths are relative to.
    pub home: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsOverview {
    pub agents: Vec<AgentView>,
    /// Whether Claude Code is installed and runs. Without it nothing works,
    /// and the view says so instead of letting a message fail.
    pub engine_ready: bool,
}

/// Whether `claude` runs, re-checked at most once a minute: the overview is
/// refetched on every chat message, and probing spawns a process.
async fn engine_ready() -> bool {
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};
    static CACHE: LazyLock<Mutex<Option<(bool, Instant)>>> = LazyLock::new(|| Mutex::new(None));
    if let Some((ready, at)) = *CACHE.lock().unwrap_or_else(|e| e.into_inner()) {
        if at.elapsed() < Duration::from_secs(60) {
            return ready;
        }
    }
    let ready = tokio::task::spawn_blocking(|| {
        crate::commands::claude::find_validated_binary("claude", "--version").is_some()
    })
    .await
    .unwrap_or(false);
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((ready, Instant::now()));
    ready
}

fn emit_registry(app: &AppHandle) {
    let _ = app.emit(runner::EVENT_REGISTRY, ());
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_overview(app: AppHandle) -> Result<AgentsOverview, CommandError> {
    agents::ensure_main()?;
    attachments::grant_asset_scope(&app);
    let engine_ready = engine_ready().await;
    let agents = store::list()?
        .into_iter()
        .map(|agent| {
            Ok(AgentView {
                status: runner::status_of(&agent.id),
                home: store::agent_home(&agent.id)?.display().to_string(),
                agent,
            })
        })
        .collect::<Result<_, CommandError>>()?;
    Ok(AgentsOverview {
        agents,
        engine_ready,
    })
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_messages(
    agent_id: String,
    limit: Option<usize>,
) -> Result<Vec<store::AgentMessage>, CommandError> {
    store::messages(&agent_id, limit.unwrap_or(400).min(5000))
}

#[tauri::command]
#[tracing::instrument(skip(app, text, attachments))]
pub async fn agents_send(
    app: AppHandle,
    agent_id: String,
    text: String,
    attachments: Option<Vec<attachments::OutgoingAttachment>>,
    mentions: Option<Vec<String>>,
) -> Result<store::AgentMessage, CommandError> {
    let text = text.trim().to_string();
    let incoming = attachments.unwrap_or_default();
    if text.is_empty() && incoming.is_empty() {
        return Err(agents::err_invalid("text", "Type a message first."));
    }
    let recipient = store::get(&agent_id)?;
    let home = store::agent_home(&agent_id)?;
    let mut message = runner::new_message(&agent_id, store::MessageKind::User, text.clone());
    // Only real agents, other than the recipient, once each; anything else is dropped.
    for id in mentions.unwrap_or_default() {
        if id == agent_id || message.mentions.iter().any(|m| m.id == id) {
            continue;
        }
        if let Ok(peer) = store::get(&id) {
            message.mentions.push(store::AgentRef {
                id: peer.id,
                name: peer.name,
            });
        }
    }
    let id = message.id.clone();
    message.attachments =
        tokio::task::spawn_blocking(move || attachments::save(&home, &id, incoming))
            .await
            .map_err(agents::err_other)??;
    // The log keeps what the user typed; the agent also gets where the files are.
    let block = attachments::prompt_block(&store::agent_home(&agent_id)?, &message.attachments);
    let names: Vec<String> = message.mentions.iter().map(|m| m.name.clone()).collect();
    let prompt = [text, prompts::mentions(&names, recipient.is_main), block]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let message = runner::record(&app, message)?;
    runner::enqueue(&app, &agent_id, prompt, runner::From::User);
    Ok(message)
}

/// Name, type and size for files about to be attached, refusing folders and
/// anything over the limit before the user gets as far as sending. Images the
/// user picked or dropped become loadable, so the composer can show them.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_inspect_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<attachments::FileInfo>, CommandError> {
    use tauri::Manager;
    let files = attachments::inspect(&paths)?;
    for file in files.iter().filter(|f| f.mime.starts_with("image/")) {
        let _ = app.asset_protocol_scope().allow_file(&file.path);
    }
    Ok(files)
}

/// Open an attachment in its default app (a PDF in Preview, a CSV in Numbers),
/// or with `reveal`, show it in Finder.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_attachment(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<(), CommandError> {
    let full = attachments::resolve(&store::agent_home(&agent_id)?, &path)?;
    let action = if reveal.unwrap_or(false) {
        files::PathAction::Reveal
    } else {
        files::PathAction::Open
    };
    files::perform(&full, action)
}

/// Everything shared in one conversation, both ways, newest first.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_files(agent_id: String) -> Result<Vec<files::SharedFile>, CommandError> {
    tokio::task::spawn_blocking(move || files::list(&agent_id))
        .await
        .map_err(agents::err_other)?
}

/// A path an agent wrote in its reply, clicked: a document opens in its
/// default app; folders, apps and scripts are only shown in Finder. Returns
/// what was done, so the UI can say "Shown in Finder".
#[tauri::command]
#[tracing::instrument]
pub async fn agents_open_path(
    agent_id: String,
    path: String,
    reveal: Option<bool>,
) -> Result<files::PathAction, CommandError> {
    let home = store::agent_home(&agent_id)?;
    let (full, action) = files::local_path(&path, &home, reveal.unwrap_or(false))?;
    files::perform(&full, action)?;
    Ok(action)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    pub shape: Option<u8>,
    pub color: Option<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instructions: String,
    /// `--model`; omitted or empty uses Claude Code's default.
    #[serde(default)]
    pub model: Option<String>,
    /// A project path from `list_projects`; omitted or empty leaves it unbound.
    #[serde(default)]
    pub project: Option<String>,
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_create(
    app: AppHandle,
    input: CreateAgentInput,
) -> Result<store::Agent, CommandError> {
    let model = input
        .model
        .as_deref()
        .map(store::normalize_model)
        .transpose()?
        .flatten();
    let project = match input.project.as_deref() {
        Some(p) => project::resolve(p).await?.map(|p| p.path),
        None => None,
    };
    let agent = store::create(store::NewAgent {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        shape: input.shape,
        color: input.color,
        is_main: false,
    })?;
    let agent = if model.is_some() || project.is_some() {
        store::update(&agent.id, |a| {
            a.model = model;
            a.project = project;
        })?
    } else {
        agent
    };
    emit_registry(&app);
    Ok(agent)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentInput {
    pub name: Option<String>,
    pub shape: Option<u8>,
    pub color: Option<String>,
    pub role: Option<String>,
    pub instructions: Option<String>,
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    /// `--model`; an empty string goes back to Claude Code's default.
    pub model: Option<String>,
    /// A project path from `list_projects`; an empty string unbinds it.
    pub project: Option<String>,
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_update(
    app: AppHandle,
    agent_id: String,
    input: UpdateAgentInput,
) -> Result<store::Agent, CommandError> {
    let name = input
        .name
        .as_deref()
        .map(store::validate_name)
        .transpose()?;
    if let Some(name) = &name {
        if let Some(other) = store::find(name)? {
            if other.id != agent_id {
                return Err(agents::err_invalid(
                    "name",
                    format!("There's already an agent called {name}."),
                ));
            }
        }
    }
    let color = input.color.filter(|c| store::COLORS.contains(&c.as_str()));
    let shape = input.shape.filter(|s| *s < store::SHAPE_COUNT);
    let role = input.role.clone();
    let model = input
        .model
        .as_deref()
        .map(store::normalize_model)
        .transpose()?;
    let project = match input.project.as_deref() {
        Some(p) => Some(project::resolve(p).await?.map(|p| p.path)),
        None => None,
    };
    let updated = store::update(&agent_id, |a| {
        if let Some(n) = name {
            a.name = n;
        }
        if let Some(c) = color {
            a.color = c;
        }
        if let Some(s) = shape {
            a.shape = s;
        }
        if let Some(r) = role {
            a.role = r.trim().to_string();
        }
        if let Some(p) = input.pinned {
            a.pinned = p;
        }
        if let Some(h) = input.hidden {
            a.hidden = h;
        }
        if let Some(m) = input.muted {
            a.muted = m;
        }
        if let Some(m) = model {
            a.model = m;
        }
        if let Some(p) = project {
            a.project = p;
        }
    })?;
    // The name and role are written into CLAUDE.md's heading, so any change
    // to them (or the instructions) rewrites it — memory is preserved.
    if input.instructions.is_some() || input.name.is_some() || input.role.is_some() {
        let instructions = match input.instructions {
            Some(i) => i,
            None => store::read_instructions(&agent_id)?,
        };
        store::write_instructions(&store::agent_home(&agent_id)?, &updated, &instructions)?;
    }
    emit_registry(&app);
    // Hiding an agent takes its unread out of the badge, as it does the sidebar's.
    if input.hidden.is_some() {
        notify::refresh_badge(&app);
    }
    Ok(updated)
}

/// One file of a change card, as the diff modal shows it: this turn's change
/// only, between the snapshots the card recorded. The project and snapshots
/// come from the stored card, never from the caller.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_change_diff(
    agent_id: String,
    message_id: String,
    path: String,
) -> Result<crate::types::FileDiff, CommandError> {
    let summary = store::messages(&agent_id, usize::MAX)?
        .into_iter()
        .find(|m| m.id == message_id)
        .and_then(|m| m.changes)
        .ok_or_else(|| CommandError::expected("That change card no longer exists."))?;
    if !summary.files.iter().any(|f| f.path == path) {
        return Err(agents::err_invalid("path", "not a file in this change"));
    }
    let dir = crate::utils::validate_project_path(&summary.project)?;
    project::file_diff(&dir, &summary.from, &summary.to, &path).await
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_instructions(agent_id: String) -> Result<String, CommandError> {
    store::read_instructions(&agent_id)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_delete(app: AppHandle, agent_id: String) -> Result<(), CommandError> {
    runner::stop(&agent_id);
    store::delete(&agent_id)?;
    emit_registry(&app);
    notify::refresh_badge(&app);
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_stop(agent_id: String) -> Result<bool, CommandError> {
    Ok(runner::stop(&agent_id))
}

/// Stop the turn in progress so the messages queued behind it run now. The
/// next turn is told what it was doing when it was cut off.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_interrupt(agent_id: String) -> Result<bool, CommandError> {
    Ok(runner::interrupt(&agent_id))
}

/// `always`: allow, and keep allowing what the card offered to (its stored
/// scope, never one the caller supplies).
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_answer_approval(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    allow: bool,
    always: Option<bool>,
    note: Option<String>,
) -> Result<(), CommandError> {
    let note = note
        .map(|n| n.trim().chars().take(MAX_DENY_NOTE).collect::<String>())
        .filter(|n| !allow && !n.is_empty());
    let status = if allow {
        store::ApprovalStatus::Allowed
    } else {
        store::ApprovalStatus::Denied
    };
    let approval = store::find_approval(&agent_id, &request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    if approval.status != store::ApprovalStatus::Pending {
        return Err(CommandError::expected("That request was already answered."));
    }
    let rule = if allow && always == Some(true) {
        Some(mcp::always_allow(&agent_id, &approval)?)
    } else {
        None
    };
    // Write the decision before waking the waiter, so the card can't be
    // overwritten by the waiter's own cleanup.
    let updated = if let Some(scope) = &rule {
        store::allow_always(&agent_id, &request_id, scope)?
    } else if let Some(note) = &note {
        store::deny_with_note(&agent_id, &request_id, note)?
    } else {
        store::set_approval_status(&agent_id, &request_id, status)?
    };
    if let Some(message) = updated {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    emit_registry(&app);
    notify::refresh_badge(&app);
    wake(&app, &agent_id, &approval, allow, note.as_deref())?;

    // The new rule answers the other open cards it covers, the same way.
    if let Some(scope) = rule {
        let open = store::pending_approvals(&agent_id)?;
        for id in mcp::covered_by(&scope, &open, &request_id) {
            let Some(card) = open.iter().find(|a| a.request_id == id) else {
                continue;
            };
            if let Some(message) = store::allow_always(&agent_id, &id, &scope)? {
                let _ = app.emit(runner::EVENT_MESSAGE, &message);
            }
            if let Err(e) = wake(&app, &agent_id, card, true, None) {
                tracing::warn!(request_id = %id, error = %e, "covered card could not wake its agent");
            }
        }
        emit_registry(&app);
        notify::refresh_badge(&app);
    }
    Ok(())
}

/// Hand an answer to whoever is waiting on the card. Nobody is waiting on it
/// (the agent paused, or the app restarted): a late Allow grants that exact
/// call and wakes the agent; a late No with a note hands the agent the note.
fn wake(
    app: &AppHandle,
    agent_id: &str,
    approval: &store::Approval,
    allow: bool,
    note: Option<&str>,
) -> Result<(), CommandError> {
    if !mcp::answer_approval(&approval.request_id, allow) {
        mcp::answer_late(app, agent_id, approval, allow)?;
        if let Some(note) = note {
            runner::enqueue(
                app,
                agent_id,
                format!(
                    "[The user declined what you asked for earlier: {} — {}. They said: \"{note}\". Do that instead.]",
                    approval.title, approval.detail
                ),
                runner::From::User,
            );
        }
    }
    Ok(())
}

/// A "Deny with note…" is a steer, not an essay.
const MAX_DENY_NOTE: usize = 500;

/// Take back an "Always allow" rule: matching calls ask again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_revoke_permission(
    app: AppHandle,
    agent_id: String,
    rule_id: String,
) -> Result<(), CommandError> {
    store::update(&agent_id, |a| a.permissions.retain(|r| r.id != rule_id))?;
    emit_registry(&app);
    Ok(())
}

/// The agent this window shows (`None` once it leaves Agents mode). While the
/// window has focus, that agent's messages don't count as unread and don't
/// notify; opening it clears what had piled up.
#[tauri::command]
#[tracing::instrument(skip(app, window))]
pub async fn agents_focus(
    app: AppHandle,
    window: tauri::WebviewWindow,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    notify::set_showing(window.label(), agent_id.clone());
    if let Some(id) = agent_id {
        let before = store::get(&id)?;
        if before.unread > 0 {
            store::update(&id, |a| a.unread = 0)?;
            emit_registry(&app);
            notify::refresh_badge(&app);
        }
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_mark_unread(app: AppHandle, agent_id: String) -> Result<(), CommandError> {
    store::update(&agent_id, |a| a.unread = a.unread.max(1))?;
    notify::refresh_badge(&app);
    Ok(())
}

/// Every agent's conversation, searched: all words must match, newest first.
#[tauri::command]
#[tracing::instrument(skip(query))]
pub async fn agents_search(query: String) -> Result<Vec<search::SearchHit>, CommandError> {
    tokio::task::spawn_blocking(move || search::search(&query))
        .await
        .map_err(agents::err_other)?
}

/// Tokens and cost for one agent: this week and all time.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_usage(agent_id: String) -> Result<usage::UsageSummary, CommandError> {
    Ok(store::get(&agent_id)?.usage.summary(usage::today()))
}

/// What the user pastes into their other assistant to start an import.
#[tauri::command]
#[tracing::instrument]
pub async fn agents_import_prompt() -> Result<String, CommandError> {
    Ok(import::IMPORT_PROMPT.to_string())
}

/// What a `when` phrase means, as the user types it in the schedule popover:
/// the resolved first time and, for a routine, how it repeats (structured, so
/// the UI words it the same way it words the list). A parse error comes
/// back as a Validation error with the shapes that work.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub next_at: i64,
    pub repeat: Option<schedule::Repeat>,
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_schedule_preview(when: String) -> Result<SchedulePreview, CommandError> {
    let (repeat, next_at) = schedule::parse(&when, &chrono::Local, store::now_ms())
        .map_err(|e| agents::err_invalid("when", e))?;
    Ok(SchedulePreview { next_at, repeat })
}

#[tauri::command]
#[tracing::instrument(skip(app, note))]
pub async fn agents_schedule_create(
    app: AppHandle,
    agent_id: String,
    when: String,
    note: String,
) -> Result<schedule::CheckIn, CommandError> {
    let created = schedule::create(&agent_id, &when, &note)?;
    emit_registry(&app);
    Ok(created.check_in)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_schedule_cancel(
    app: AppHandle,
    agent_id: String,
    id: String,
) -> Result<(), CommandError> {
    schedule::cancel(&agent_id, &id)?;
    emit_registry(&app);
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_schedule_pause(
    app: AppHandle,
    agent_id: String,
    id: String,
    paused: bool,
) -> Result<(), CommandError> {
    schedule::set_paused(&agent_id, &id, paused)?;
    emit_registry(&app);
    Ok(())
}
