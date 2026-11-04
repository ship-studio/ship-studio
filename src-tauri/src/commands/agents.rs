//! Tauri commands for the Agents view. The logic lives in `crate::agents`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agents::{self, import, mcp, runner, search, store, usage};
use crate::errors::CommandError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    #[serde(flatten)]
    pub agent: store::Agent,
    pub status: runner::Status,
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
#[tracing::instrument]
pub async fn agents_overview() -> Result<AgentsOverview, CommandError> {
    agents::ensure_main()?;
    let engine_ready = engine_ready().await;
    let agents = store::list()?
        .into_iter()
        .map(|agent| AgentView {
            status: runner::status_of(&agent.id),
            agent,
        })
        .collect();
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
#[tracing::instrument(skip(app, text))]
pub async fn agents_send(
    app: AppHandle,
    agent_id: String,
    text: String,
) -> Result<store::AgentMessage, CommandError> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(agents::err_invalid("text", "Type a message first."));
    }
    store::get(&agent_id)?;
    let message = runner::record(
        &app,
        runner::new_message(&agent_id, store::MessageKind::User, text.clone()),
    )?;
    runner::enqueue(&app, &agent_id, text, runner::From::User);
    Ok(message)
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
    let agent = store::create(store::NewAgent {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        shape: input.shape,
        color: input.color,
        is_main: false,
    })?;
    let agent = match model {
        Some(model) => store::update(&agent.id, |a| a.model = Some(model))?,
        None => agent,
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
    /// `--model`; an empty string goes back to Claude Code's default.
    pub model: Option<String>,
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
        if let Some(m) = model {
            a.model = m;
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
    Ok(updated)
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
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_stop(agent_id: String) -> Result<bool, CommandError> {
    Ok(runner::stop(&agent_id))
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_answer_approval(
    app: AppHandle,
    agent_id: String,
    request_id: String,
    allow: bool,
) -> Result<(), CommandError> {
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
    // Write the decision before waking the waiter, so the card can't be
    // overwritten by the waiter's own cleanup.
    let updated = store::set_approval_status(&agent_id, &request_id, status)?;
    if let Some(message) = updated {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    emit_registry(&app);
    if !mcp::answer_approval(&request_id, allow) {
        // Nobody is waiting on it (the agent paused, or the app restarted):
        // a late Allow grants that exact call and wakes the agent.
        mcp::answer_late(&app, &agent_id, &approval, allow)?;
    }
    Ok(())
}

/// The agent on screen: its messages don't count as unread, and opening it
/// clears what had piled up.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn agents_focus(app: AppHandle, agent_id: Option<String>) -> Result<(), CommandError> {
    runner::set_focused(agent_id.clone());
    if let Some(id) = agent_id {
        let before = store::get(&id)?;
        if before.unread > 0 {
            store::update(&id, |a| a.unread = 0)?;
            emit_registry(&app);
        }
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument]
pub async fn agents_mark_unread(agent_id: String) -> Result<(), CommandError> {
    store::update(&agent_id, |a| a.unread = a.unread.max(1))?;
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
