//! Persistence for Agents: the registry of agents and each agent's chat log.
//!
//! Layout, under the projects root (`~/ShipStudio` by default):
//!
//! ```text
//! .shipstudio/agents/
//!   agents.json              the registry (every agent's identity and state)
//!   <agent-id>/              the agent's home: its working directory
//!     CLAUDE.md              instructions + memory; Claude Code loads it every turn
//!     messages.jsonl         the conversation as the user sees it (append-only)
//!     approvals.jsonl        how its approval cards were answered
//!     turn.json, inbox.json  a turn in flight and what's queued behind it
//! ```
//!
//! The chat log is ours, not Claude Code's session file. It records exactly
//! what the user was shown — their messages, the agent's replies, the lines
//! where agents talked to each other, approval cards — so the UI never has to
//! reconstruct a conversation from a tool transcript it doesn't own.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use crate::errors::CommandError;

/// The avatar palette. Keys, not colours: the frontend maps each to a token,
/// so a theme change never leaves stale hex in someone's registry.
pub const COLORS: &[&str] = &[
    "white", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "gray",
];
/// Number of avatar shapes the frontend draws (indices `0..SHAPE_COUNT`).
pub const SHAPE_COUNT: u8 = 14;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// One line saying what this agent is for. Shown to other agents in
    /// `list_agents`, so the Chief of Staff can route work by it.
    #[serde(default)]
    pub role: String,
    pub shape: u8,
    pub color: String,
    /// The Chief of Staff: exactly one, created on first open, can't be deleted.
    #[serde(default)]
    pub is_main: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub hidden: bool,
    /// Claude Code session this agent resumes. `None` until its first turn.
    #[serde(default)]
    pub session_id: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub last_activity_at: i64,
    /// First line of the latest message, for the sidebar row.
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub unread: u32,
    /// Approval cards still waiting on the user. Kept here so the sidebar can
    /// say "Needs your OK" without reading every chat log.
    #[serde(default)]
    pub pending_approvals: u32,
    /// Explicit model override (`--model`); `None` uses Claude Code's default.
    #[serde(default)]
    pub model: Option<String>,
    /// No OS notifications for this agent. Unread and the Dock badge still count it.
    #[serde(default)]
    pub muted: bool,
    /// Check-ins and routines this agent is woken by (see `schedule`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub check_ins: Vec<super::schedule::CheckIn>,
    /// Tokens and cost of its turns, as Claude Code reported them.
    #[serde(default)]
    pub usage: super::usage::AgentUsage,
    /// "Always allow" rules: calls matching one skip the approval card.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<super::permissions::Rule>,
    /// The newest line in its chat is a failed turn: what kind. Cleared by
    /// anything said after it, so the sidebar can show a failure where it
    /// happened without reading the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<super::failure::Failure>,
    /// The Ship Studio project this agent works in (its path, as `list_projects`
    /// gives it). A bound agent's turns run there, so the project's own
    /// CLAUDE.md and settings load; `None` runs in its home, as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Fields a newer Ship Studio wrote that this build doesn't know: kept
    /// and written back as they were, so running an older build never
    /// strips what a newer one saved.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// The user wrote this.
    User,
    /// This agent said this to the user.
    Agent,
    /// This agent sent `text` to `peer` (rendered as "Messaged <peer>").
    SentToAgent,
    /// `peer` sent `text` to this agent (rendered as "Message from <peer>").
    FromAgent,
    /// A permission request the user answers inline.
    Approval,
    /// Something went wrong running the agent — shown, never hidden.
    Error,
    /// A scheduled check-in or routine fired; `text` is the note it left.
    CheckIn,
    /// A quiet line about something Ship Studio did on the agent's behalf
    /// ("Allowed automatically: npm test · Always allowed", "Interrupted").
    /// With `peer`, the line names that agent ("Created Finance").
    Note,
    /// Files a project-bound agent's turn changed in its project (`changes`).
    Changes,
}

impl MessageKind {
    /// The kinds that are news for the user when they arrive off screen: they
    /// count as unread, and they are what the notifications slice raises a
    /// macOS notification for. A fired check-in is one — the user (or the
    /// agent, on their behalf) asked for it to happen at that time.
    pub fn wants_user(self) -> bool {
        matches!(
            self,
            Self::Agent | Self::Approval | Self::Error | Self::CheckIn
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Allowed,
    Denied,
    /// Nobody answered in time, or the app restarted while it waited.
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub request_id: String,
    /// What the agent wants to do, in a few words ("Run a command").
    pub title: String,
    /// The exact thing it will do (the command, the file, the URL).
    pub detail: String,
    pub status: ApprovalStatus,
    /// The Claude Code tool and input this card is about. Present for
    /// permission prompts, which stay answerable after the agent stopped
    /// waiting (Claude Code abandons a prompt at 300s): a late Allow grants
    /// exactly this call and wakes the agent. Absent for Ship Studio's own
    /// confirmations (delete an agent), which only mean something while asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    /// What "Always allow" would cover, when the card may offer it. Only
    /// permission prompts get one; Ship Studio's own confirmations never do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always: Option<super::permissions::Scope>,
    /// Allowed by an "Always allow" rule (chosen on this card, or added on
    /// another card and covering this one), not just once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always_allowed: bool,
    /// What the user said when they declined, handed to the agent with the No.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub agent_id: String,
    pub ts: i64,
    pub kind: MessageKind,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// Files sent with a user message. Absent in logs written before attachments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<super::attachments::Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_in: Option<super::schedule::CheckInMark>,
    /// A reply cut off by Stop (or a turn that died mid-sentence): what had
    /// streamed by then, kept rather than thrown away.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    /// Agents the user @mentioned in this message, as they were named then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<AgentRef>,
    /// On an `error` line: what kind of failure, for the remedy it offers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<super::failure::Failure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<super::project::ChangeSummary>,
}

/// `agents.json`. Read and written losslessly: an entry this build can't
/// read (a newer build's, or a bad hand edit) is hidden but written back
/// untouched, and so are top-level keys it doesn't know. An older build must
/// never delete an agent a newer one saved.
#[derive(Debug, Default)]
struct Registry {
    agents: Vec<Agent>,
    unreadable: Vec<serde_json::Value>,
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Registry {
    /// `None` when the JSON isn't a registry at all.
    fn from_value(value: serde_json::Value) -> Option<Registry> {
        let serde_json::Value::Object(mut extra) = value else {
            return None;
        };
        let entries = match extra.remove("agents") {
            None => Vec::new(),
            Some(serde_json::Value::Array(entries)) => entries,
            Some(_) => return None,
        };
        let mut registry = Registry {
            extra,
            ..Registry::default()
        };
        for entry in entries {
            match serde_json::from_value::<Agent>(entry.clone()) {
                Ok(agent) => registry.agents.push(agent),
                Err(e) => {
                    tracing::warn!("[Agents] keeping an agent entry this build can't read: {e}");
                    registry.unreadable.push(entry);
                }
            }
        }
        Some(registry)
    }

    fn to_value(&self) -> Result<serde_json::Value, CommandError> {
        let mut entries = Vec::with_capacity(self.agents.len() + self.unreadable.len());
        for agent in &self.agents {
            entries.push(serde_json::to_value(agent).map_err(|e| super::err_other(e.to_string()))?);
        }
        entries.extend(self.unreadable.iter().cloned());
        let mut out = self.extra.clone();
        out.insert("agents".into(), serde_json::Value::Array(entries));
        Ok(serde_json::Value::Object(out))
    }
}

/// One lock around every registry read-modify-write. The registry is small
/// and written rarely; serialising access is simpler than being clever.
static REGISTRY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Test hook: point the store somewhere disposable.
static ROOT_OVERRIDE: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// The store has process-wide state; tests touching it run one at a time.
#[cfg(test)]
pub fn tests_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
pub fn set_root_for_tests(path: Option<PathBuf>) {
    *ROOT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = path;
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn agents_root() -> Result<PathBuf, CommandError> {
    if let Some(root) = ROOT_OVERRIDE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(root);
    }
    let root = crate::utils::projects_root().map_err(super::err_other)?;
    Ok(root.join(".shipstudio").join("agents"))
}

pub fn agent_home(id: &str) -> Result<PathBuf, CommandError> {
    validate_id(id)?;
    Ok(agents_root()?.join(id))
}

/// Ids are generated by us (hex), but they arrive back from the frontend and
/// from MCP calls, and they become path segments.
fn validate_id(id: &str) -> Result<(), CommandError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(super::err_invalid("agentId", "not a valid agent id"));
    }
    Ok(())
}

fn registry_path() -> Result<PathBuf, CommandError> {
    Ok(agents_root()?.join("agents.json"))
}

fn read_registry() -> Result<Registry, CommandError> {
    let path = registry_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    match serde_json::from_str(&raw) {
        Ok(value) => match Registry::from_value(value) {
            Some(registry) => Ok(registry),
            None => recover_registry(&path, "not an agents registry"),
        },
        Err(e) => recover_registry(&path, &e.to_string()),
    }
}

/// The registry isn't JSON (a crash or a full disk mid-write, or a bad hand
/// edit). Load the copy kept beside it on every write, rather than every
/// agent vanishing. (Valid JSON with an entry this build can't read is not
/// damage: see [`Registry`].) The damaged file is kept aside first, because
/// the recovered one replaces it.
fn recover_registry(path: &Path, why: &str) -> Result<Registry, CommandError> {
    let Some(recovered) = std::fs::read_to_string(path.with_extension("json.bak"))
        .ok()
        .and_then(|b| serde_json::from_str(&b).ok())
        .and_then(Registry::from_value)
    else {
        return Err(super::err_other(format!(
            "The agents registry at {} is unreadable: {why}",
            path.display()
        )));
    };
    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
    std::fs::copy(path, &aside).map_err(|e| super::err_io(e.to_string()))?;
    tracing::error!(
        "[Agents] registry unreadable ({why}); recovered {} agents, damaged copy kept at {}",
        recovered.agents.len(),
        aside.display()
    );
    write_registry(&recovered)?;
    Ok(recovered)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| super::err_io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| super::err_io(e.to_string()))
}

/// Written twice: the copy is what [`recover_registry`] falls back on if the
/// main file is ever torn.
fn write_registry(registry: &Registry) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(&registry.to_value()?)
        .map_err(|e| super::err_other(e.to_string()))?;
    let path = registry_path()?;
    write_atomic(&path, &json)?;
    if let Err(e) = write_atomic(&path.with_extension("json.bak"), &json) {
        tracing::warn!("[Agents] registry backup not written: {e}");
    }
    Ok(())
}

pub fn list() -> Result<Vec<Agent>, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read_registry()?.agents)
}

pub fn get(id: &str) -> Result<Agent, CommandError> {
    list()?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))
}

/// Find an agent the way another agent names it: by id, or by name ignoring case.
pub fn find(name_or_id: &str) -> Result<Option<Agent>, CommandError> {
    let needle = name_or_id.trim();
    let agents = list()?;
    if let Some(found) = agents.iter().find(|a| a.id == needle) {
        return Ok(Some(found.clone()));
    }
    Ok(agents
        .into_iter()
        .find(|a| a.name.eq_ignore_ascii_case(needle)))
}

/// Read-modify-write one agent under the registry lock.
pub fn update<F: FnOnce(&mut Agent)>(id: &str, change: F) -> Result<Agent, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    let agent = registry
        .agents
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    change(agent);
    let updated = agent.clone();
    write_registry(&registry)?;
    Ok(updated)
}

pub struct NewAgent {
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub shape: Option<u8>,
    pub color: Option<String>,
    pub is_main: bool,
}

pub fn validate_name(name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(super::err_invalid("name", "Give the agent a name."));
    }
    if name.chars().count() > 40 {
        return Err(super::err_invalid(
            "name",
            "Keep the name under 40 characters.",
        ));
    }
    Ok(name.to_string())
}

/// The `--model` values offered: Claude Code's own aliases, which always
/// resolve to the current model of that family. `None` is Claude Code's default.
pub const MODELS: [&str; 3] = ["opus", "sonnet", "haiku"];

/// A `--model` value: empty means Claude Code's default; anything else must
/// be one of [`MODELS`]. It becomes a CLI argument, so nothing else gets through.
pub fn normalize_model(model: &str) -> Result<Option<String>, CommandError> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if !MODELS.contains(&model) {
        return Err(super::err_invalid(
            "model",
            "Pick Opus, Sonnet, Haiku or Default.",
        ));
    }
    Ok(Some(model.to_string()))
}

pub fn create(new: NewAgent) -> Result<Agent, CommandError> {
    let name = validate_name(&new.name)?;
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    if registry
        .agents
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&name))
    {
        return Err(super::err_invalid(
            "name",
            format!("There's already an agent called {name}."),
        ));
    }
    if new.is_main && registry.agents.iter().any(|a| a.is_main) {
        return Err(CommandError::expected("There's already a Chief of Staff."));
    }
    let index = registry.agents.len();
    let color = match new.color {
        Some(c) if COLORS.contains(&c.as_str()) => c,
        // Spread new agents across the palette instead of making them all purple.
        _ => COLORS[(index * 7 + 3) % COLORS.len()].to_string(),
    };
    let shape = new
        .shape
        .filter(|s| *s < SHAPE_COUNT)
        .unwrap_or((index as u8 * 5 + 1) % SHAPE_COUNT);
    let now = now_ms();
    let agent = Agent {
        id: new_id(),
        name,
        role: new.role.trim().to_string(),
        shape,
        color,
        is_main: new.is_main,
        // The one agent you're told to talk to stays put at the top; unpinnable.
        pinned: new.is_main,
        hidden: false,
        session_id: None,
        created_at: now,
        last_activity_at: now,
        preview: None,
        unread: 0,
        pending_approvals: 0,
        model: None,
        muted: false,
        check_ins: Vec::new(),
        usage: Default::default(),
        permissions: Vec::new(),
        failure: None,
        project: None,
        extra: Default::default(),
    };
    let home = agents_root()?.join(&agent.id);
    std::fs::create_dir_all(&home).map_err(|e| super::err_io(e.to_string()))?;
    write_instructions(&home, &agent, &new.instructions)?;
    registry.agents.push(agent.clone());
    write_registry(&registry)?;
    Ok(agent)
}

const MEMORY_HEADING: &str = "## Memory";

/// CLAUDE.md is the agent's own file: instructions on top, a memory section it
/// maintains below. Rewriting instructions keeps whatever it has remembered.
pub fn write_instructions(
    home: &Path,
    agent: &Agent,
    instructions: &str,
) -> Result<(), CommandError> {
    let path = home.join("CLAUDE.md");
    let memory = std::fs::read_to_string(&path)
        .ok()
        .and_then(|existing| existing.find(MEMORY_HEADING).map(|i| existing[i..].to_string()))
        .unwrap_or_else(|| {
            format!("{MEMORY_HEADING}\n\nThings worth remembering between conversations. Keep this short and current.\n")
        });
    let role = if agent.role.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", agent.role)
    };
    let body = instructions.trim();
    let instructions = if body.is_empty() {
        String::new()
    } else {
        format!("## Instructions\n\n{body}\n\n")
    };
    let content = format!("# {}\n\n{role}{instructions}{memory}", agent.name);
    write_atomic(&path, content.as_bytes())
}

pub fn read_instructions(id: &str) -> Result<String, CommandError> {
    let path = agent_home(id)?.join("CLAUDE.md");
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let start = raw
        .find("## Instructions")
        .map(|i| i + "## Instructions".len());
    let Some(start) = start else {
        return Ok(String::new());
    };
    let end = raw[start..]
        .find(MEMORY_HEADING)
        .map(|i| start + i)
        .unwrap_or(raw.len());
    Ok(raw[start..end].trim().to_string())
}

pub fn delete(id: &str) -> Result<Agent, CommandError> {
    let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut registry = read_registry()?;
    let index = registry
        .agents
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| CommandError::expected("That agent no longer exists."))?;
    if registry.agents[index].is_main {
        return Err(CommandError::expected(
            "The Chief of Staff can't be deleted.",
        ));
    }
    let removed = registry.agents.remove(index);
    write_registry(&registry)?;
    // The home goes with it: its memory and chat are the agent.
    let home = agents_root()?.join(&removed.id);
    if home.exists() {
        let _ = crate::utils::remove_dir_all_robust(&home);
    }
    Ok(removed)
}

/* ------------------------------------------------------------- chat log */

fn log_path(agent_id: &str) -> Result<PathBuf, CommandError> {
    Ok(agent_home(agent_id)?.join("messages.jsonl"))
}

/// How approval cards were answered, one line per answer, beside the log
/// (`approvals.jsonl`). The log itself is only ever appended to: answering a
/// card used to rewrite every message the agent had, under a lock every
/// other agent's appends waited on.
fn answers_path(agent_id: &str) -> Result<PathBuf, CommandError> {
    Ok(agent_home(agent_id)?.join("approvals.jsonl"))
}

/// One agent's log lock. Appends from concurrent turns of the *same* agent
/// must not interleave; different agents never wait on each other.
fn log_lock(agent_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(agent_id.to_string())
        .or_default()
        .clone()
}

/// An answer to an approval card, applied over the card when the log is read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    request_id: String,
    status: ApprovalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    always: Option<super::permissions::Scope>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    always_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl Answer {
    fn apply(&self, approval: &mut Approval) {
        approval.status = self.status;
        if self.always.is_some() {
            approval.always = self.always.clone();
        }
        approval.always_allowed |= self.always_allowed;
        approval.note = self.note.clone();
    }
}

/// Append one JSON line, never fused onto a torn last line.
fn append_line<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let mut line = serde_json::to_string(value).map_err(|e| super::err_other(e.to_string()))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)
        .map_err(|e| super::err_io(e.to_string()))?;
    // A crash mid-append leaves a last line with no newline. Appending straight
    // after it would fuse this line into that broken one and lose it too.
    if !ends_with_newline(&mut file) {
        line.insert(0, '\n');
    }
    file.write_all(line.as_bytes())
        .map_err(|e| super::err_io(e.to_string()))
}

pub fn append_message(message: &AgentMessage) -> Result<(), CommandError> {
    let lock = log_lock(&message.agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    append_line(&log_path(&message.agent_id)?, message)
}

/// True for an empty file, or one whose last byte is a newline.
fn ends_with_newline(file: &mut std::fs::File) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::End(-1)).is_err() {
        return true;
    }
    let mut last = [0u8; 1];
    file.read_exact(&mut last).is_err() || last[0] == b'\n'
}

fn read_text(path: &Path) -> Result<String, CommandError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(super::err_io(e.to_string())),
    }
}

/// The newest `limit` lines of a file, read from its end: opening a long
/// chat costs what it shows, not the whole history.
fn tail_lines(path: &Path, limit: usize) -> Result<Vec<String>, CommandError> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 256 * 1024;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    let len = file
        .metadata()
        .map_err(|e| super::err_io(e.to_string()))?
        .len();
    let mut start = len;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let from = start.saturating_sub(CHUNK);
        let mut chunk = vec![0u8; (start - from) as usize];
        file.seek(SeekFrom::Start(from))
            .and_then(|_| file.read_exact(&mut chunk))
            .map_err(|e| super::err_io(e.to_string()))?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        start = from;
        // One more newline than lines wanted: the first may be cut.
        if start == 0 || buf.iter().filter(|b| **b == b'\n').count() > limit {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(limit);
    Ok(lines[skip..].iter().map(|l| l.to_string()).collect())
}

fn read_answers(agent_id: &str) -> Result<HashMap<String, Answer>, CommandError> {
    Ok(read_text(&answers_path(agent_id)?)?
        .lines()
        .filter_map(|l| serde_json::from_str::<Answer>(l).ok())
        .map(|a| (a.request_id.clone(), a))
        .collect())
}

/// Parse log lines (a torn one is skipped rather than failing the chat) and
/// apply the answers given since each card was written.
fn parse_log<'a>(
    agent_id: &str,
    lines: impl Iterator<Item = &'a str>,
) -> Result<Vec<AgentMessage>, CommandError> {
    let mut log: Vec<AgentMessage> = lines.filter_map(|l| serde_json::from_str(l).ok()).collect();
    if log.iter().any(|m| m.approval.is_some()) {
        let answers = read_answers(agent_id)?;
        for approval in log.iter_mut().filter_map(|m| m.approval.as_mut()) {
            if let Some(answer) = answers.get(&approval.request_id) {
                answer.apply(approval);
            }
        }
    }
    Ok(log)
}

/// The approval cards in an agent's log, answers applied. Only lines that
/// can be cards are parsed.
fn cards(agent_id: &str, request_id: Option<&str>) -> Result<Vec<AgentMessage>, CommandError> {
    let raw = read_text(&log_path(agent_id)?)?;
    let lines = raw
        .lines()
        .filter(|l| l.contains("\"requestId\"") && request_id.is_none_or(|id| l.contains(id)));
    Ok(parse_log(agent_id, lines)?
        .into_iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| request_id.is_none_or(|id| a.request_id == id))
        })
        .collect())
}

/// The newest `limit` messages, oldest first.
pub fn messages(agent_id: &str, limit: usize) -> Result<Vec<AgentMessage>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(agent_id)?;
    if limit == usize::MAX {
        let raw = read_text(&path)?;
        return parse_log(agent_id, raw.lines());
    }
    // A torn line in the tail is dropped, so read a few extra.
    let lines = tail_lines(&path, limit.saturating_add(8))?;
    let all = parse_log(agent_id, lines.iter().map(String::as_str))?;
    let start = all.len().saturating_sub(limit);
    Ok(all[start..].to_vec())
}

/// Set an approval's outcome.
pub fn set_approval_status(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(agent_id, request_id, status, None, None)
}

/// Decline a pending card with what the user said, which the agent is handed too.
pub fn deny_with_note(
    agent_id: &str,
    request_id: &str,
    note: &str,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(
        agent_id,
        request_id,
        ApprovalStatus::Denied,
        None,
        Some(note),
    )
}

/// Allow a pending card under an "Always allow" rule, so it says so and
/// names the rule (which may be broader than what the card itself offered).
pub fn allow_always(
    agent_id: &str,
    request_id: &str,
    rule: &super::permissions::Scope,
) -> Result<Option<AgentMessage>, CommandError> {
    resolve_approval(
        agent_id,
        request_id,
        ApprovalStatus::Allowed,
        Some(rule),
        None,
    )
}

/// Answer a card once: an answer line is appended, the log isn't touched.
/// Returns the card as it now reads, or `None` if it was already answered.
fn resolve_approval(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
    rule: Option<&super::permissions::Scope>,
    note: Option<&str>,
) -> Result<Option<AgentMessage>, CommandError> {
    let lock = log_lock(agent_id);
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = cards(agent_id, None)?;
    let mut changed = None;
    if let Some(message) = all.iter_mut().find(|m| {
        m.approval
            .as_ref()
            .is_some_and(|a| a.request_id == request_id && a.status == ApprovalStatus::Pending)
    }) {
        let answer = Answer {
            request_id: request_id.to_string(),
            status,
            always: rule.cloned(),
            always_allowed: rule.is_some(),
            note: note.map(str::to_string),
        };
        append_line(&answers_path(agent_id)?, &answer)?;
        if let Some(approval) = message.approval.as_mut() {
            answer.apply(approval);
        }
        changed = Some(message.clone());
    }
    let pending = count_pending(&all);
    drop(guard);
    let _ = update(agent_id, |a| a.pending_approvals = pending);
    Ok(changed)
}

fn count_pending(log: &[AgentMessage]) -> u32 {
    log.iter()
        .filter(|m| {
            m.approval
                .as_ref()
                .is_some_and(|a| a.status == ApprovalStatus::Pending)
        })
        .count() as u32
}

/// Recount an agent's pending cards (after one is added).
pub fn refresh_pending(agent_id: &str) {
    let pending = {
        let lock = log_lock(agent_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        cards(agent_id, None)
            .map(|log| count_pending(&log))
            .unwrap_or(0)
    };
    let _ = update(agent_id, |a| a.pending_approvals = pending);
}

pub fn find_approval(agent_id: &str, request_id: &str) -> Result<Option<Approval>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    Ok(cards(agent_id, Some(request_id))?
        .into_iter()
        .find_map(|m| m.approval))
}

/// The cards still waiting on an answer, oldest first.
pub fn pending_approvals(agent_id: &str) -> Result<Vec<Approval>, CommandError> {
    let lock = log_lock(agent_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    Ok(cards(agent_id, None)?
        .into_iter()
        .filter_map(|m| m.approval)
        .filter(|a| a.status == ApprovalStatus::Pending)
        .collect())
}

/// On startup nothing is waiting on an approval any more: the process that
/// asked is gone. Mark leftovers expired so the card doesn't offer a button
/// that can't do anything.
pub fn expire_stale_approvals() {
    let Ok(agents) = list() else { return };
    for agent in agents {
        // Permission cards stay answerable across restarts (a late Allow
        // re-wakes the agent); only Ship Studio's own confirmations lose
        // their meaning when the asker is gone.
        let Ok(stale) = pending_approvals(&agent.id) else {
            continue;
        };
        for a in stale.into_iter().filter(|a| a.tool.is_none()) {
            let _ = set_approval_status(&agent.id, &a.request_id, ApprovalStatus::Expired);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_root<F: FnOnce()>(f: F) {
        let _serial = tests_lock();
        let dir = tempfile::tempdir().unwrap();
        set_root_for_tests(Some(dir.path().to_path_buf()));
        f();
        set_root_for_tests(None);
    }

    fn new(name: &str) -> NewAgent {
        NewAgent {
            name: name.into(),
            role: "Does things".into(),
            instructions: "Be brief.".into(),
            shape: None,
            color: None,
            is_main: false,
        }
    }

    #[test]
    fn creates_lists_and_finds_by_name_case_insensitively() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            assert_eq!(list().unwrap().len(), 1);
            assert_eq!(find("finance").unwrap().unwrap().id, a.id);
            assert_eq!(find(&a.id).unwrap().unwrap().name, "Finance");
            assert!(find("Nobody").unwrap().is_none());
        });
    }

    #[test]
    fn refuses_duplicate_names_and_a_second_main() {
        with_root(|| {
            create(new("Finance")).unwrap();
            assert!(create(new("FINANCE")).is_err());
            let mut main = new("Chief of Staff");
            main.is_main = true;
            create(main).unwrap();
            let mut again = new("Other Chief");
            again.is_main = true;
            assert!(create(again).is_err());
        });
    }

    #[test]
    fn the_main_agent_cannot_be_deleted() {
        with_root(|| {
            let mut main = new("Chief of Staff");
            main.is_main = true;
            let chief = create(main).unwrap();
            assert!(delete(&chief.id).is_err());
            let other = create(new("Finance")).unwrap();
            delete(&other.id).unwrap();
            assert!(!agents_root().unwrap().join(&other.id).exists());
        });
    }

    #[test]
    fn rewriting_instructions_keeps_memory() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            let home = agent_home(&a.id).unwrap();
            let path = home.join("CLAUDE.md");
            let with_memory =
                std::fs::read_to_string(&path).unwrap() + "- Julian's accountant is Sam.\n";
            std::fs::write(&path, with_memory).unwrap();
            write_instructions(&home, &a, "New rules.").unwrap();
            let after = std::fs::read_to_string(&path).unwrap();
            assert!(after.contains("New rules."));
            assert!(!after.contains("Be brief."));
            assert!(after.contains("Julian's accountant is Sam."));
            assert_eq!(read_instructions(&a.id).unwrap(), "New rules.");
        });
    }

    #[test]
    fn approvals_resolve_once_and_stale_ones_expire() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            let pending = |rid: &str| AgentMessage {
                id: new_id(),
                agent_id: a.id.clone(),
                ts: now_ms(),
                kind: MessageKind::Approval,
                text: String::new(),
                peer: None,
                approval: Some(Approval {
                    request_id: rid.into(),
                    title: "Run a command".into(),
                    detail: "ls".into(),
                    status: ApprovalStatus::Pending,
                    tool: None,
                    input: None,
                    always: None,
                    always_allowed: false,
                    note: None,
                }),
                attachments: Vec::new(),
                check_in: None,
                stopped: false,
                mentions: Vec::new(),
                failure: None,
                changes: None,
            };
            append_message(&pending("r1")).unwrap();
            append_message(&pending("r2")).unwrap();
            assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Allowed)
                .unwrap()
                .is_some());
            // A second answer to the same card changes nothing.
            assert!(set_approval_status(&a.id, "r1", ApprovalStatus::Denied)
                .unwrap()
                .is_none());
            expire_stale_approvals();
            let log = messages(&a.id, 10).unwrap();
            assert_eq!(
                log[0].approval.as_ref().unwrap().status,
                ApprovalStatus::Allowed
            );
            assert_eq!(
                log[1].approval.as_ref().unwrap().status,
                ApprovalStatus::Expired
            );
        });
    }

    fn note(agent_id: &str, text: &str) -> AgentMessage {
        AgentMessage {
            id: new_id(),
            agent_id: agent_id.into(),
            ts: now_ms(),
            kind: MessageKind::Note,
            text: text.into(),
            peer: None,
            approval: None,
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
            mentions: Vec::new(),
            changes: None,
            failure: None,
        }
    }

    #[test]
    fn a_torn_last_line_doesnt_swallow_the_next_message() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            append_message(&note(&a.id, "one")).unwrap();
            let path = log_path(&a.id).unwrap();
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(br#"{"id":"torn","kind":"us"#).unwrap();
            append_message(&note(&a.id, "two")).unwrap();
            let texts: Vec<String> = messages(&a.id, 10)
                .unwrap()
                .into_iter()
                .map(|m| m.text)
                .collect();
            assert_eq!(texts, ["one", "two"]);
        });
    }

    #[test]
    fn answering_a_card_appends_and_never_rewrites_the_log() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            append_message(&note(&a.id, "before")).unwrap();
            let mut card = note(&a.id, "");
            card.kind = MessageKind::Approval;
            card.approval = Some(Approval {
                request_id: "r9".into(),
                title: "Run a command".into(),
                detail: "ls".into(),
                status: ApprovalStatus::Pending,
                tool: Some("Bash".into()),
                input: None,
                always: None,
                always_allowed: false,
                note: None,
            });
            append_message(&card).unwrap();
            let raw = std::fs::read(log_path(&a.id).unwrap()).unwrap();
            let answered = deny_with_note(&a.id, "r9", "not now").unwrap().unwrap();
            assert_eq!(
                answered.approval.as_ref().unwrap().status,
                ApprovalStatus::Denied
            );
            assert_eq!(std::fs::read(log_path(&a.id).unwrap()).unwrap(), raw);
            let found = find_approval(&a.id, "r9").unwrap().unwrap();
            assert_eq!(found.note.as_deref(), Some("not now"));
            assert!(pending_approvals(&a.id).unwrap().is_empty());
            assert_eq!(get(&a.id).unwrap().pending_approvals, 0);
            let shown = messages(&a.id, 1).unwrap();
            assert_eq!(
                shown[0].approval.as_ref().unwrap().status,
                ApprovalStatus::Denied
            );
        });
    }

    #[test]
    fn a_long_log_is_read_from_its_end() {
        with_root(|| {
            let a = create(new("Finance")).unwrap();
            // Long enough to span several read chunks.
            let filler = "x".repeat(3000);
            for i in 0..400 {
                append_message(&note(&a.id, &format!("{i} {filler}"))).unwrap();
            }
            let last: Vec<String> = messages(&a.id, 3)
                .unwrap()
                .into_iter()
                .map(|m| m.text.split(' ').next().unwrap().to_string())
                .collect();
            assert_eq!(last, ["397", "398", "399"]);
            assert_eq!(messages(&a.id, 1000).unwrap().len(), 400);
            assert_eq!(messages(&a.id, usize::MAX).unwrap().len(), 400);
        });
    }

    /* ---------------------------------------------- backwards compatibility */

    // Data users already have on disk must load in every future release.
    // The fixtures are frozen: never edit them to make a test pass; add new
    // ones for new formats.
    const COMPAT_REGISTRY: &str = include_str!("testdata/compat/agents.json");
    const COMPAT_LOG: &str = include_str!("testdata/compat/messages.jsonl");
    const CHIEF: &str = "c0ffee00-0000-4000-8000-000000000001";

    /// Every key of `old` is in `new` with a value that covers it (an
    /// absent key may come back as its default; a null may be left out).
    fn covers(new: Option<&serde_json::Value>, old: &serde_json::Value) -> bool {
        use serde_json::Value;
        match (new, old) {
            (None, Value::Null) => true,
            (Some(Value::Object(n)), Value::Object(o)) => {
                o.iter().all(|(k, v)| covers(n.get(k), v))
            }
            (Some(Value::Array(n)), Value::Array(o)) => {
                n.len() == o.len() && n.iter().zip(o).all(|(n, o)| covers(Some(n), o))
            }
            (Some(n), o) => n == o,
            (None, _) => false,
        }
    }

    fn registry_on_disk() -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(registry_path().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn registries_from_every_release_load_and_survive_a_write() {
        with_root(|| {
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
            let agents = list().unwrap();
            let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
            assert_eq!(names, ["Chief of Staff", "Builder", "Finance", "Scout"]);
            let chief = &agents[0];
            assert!(chief.is_main && chief.pinned);
            assert_eq!(chief.check_ins.len(), 3);
            assert_eq!(chief.permissions.len(), 4);
            assert_eq!(chief.usage.all_time.turns, 41);
            assert_eq!(chief.usage.days.len(), 1);
            assert_eq!(chief.model.as_deref(), Some("opus"));
            assert!(chief.failure.as_ref().unwrap().resets_at.is_some());
            assert_eq!(
                agents[1].project.as_deref(),
                Some("/Users/someone/ShipStudio/site")
            );
            // The oldest shape: only the original fields.
            let scout = &agents[3];
            assert!(scout.role.is_empty() && !scout.pinned && scout.check_ins.is_empty());

            // A write (any update) keeps everything that was there.
            update(&agents[3].id, |a| a.unread = 1).unwrap();
            let old: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
            let mut new = registry_on_disk();
            new["agents"][3]["unread"] = serde_json::json!(0);
            assert!(covers(Some(&new), &old), "a write dropped data:\n{new:#}");
        });
    }

    #[test]
    fn an_older_build_keeps_what_a_newer_one_wrote() {
        with_root(|| {
            let mut future: serde_json::Value = serde_json::from_str(COMPAT_REGISTRY).unwrap();
            future["formatVersion"] = serde_json::json!(9);
            future["agents"][0]["voice"] = serde_json::json!({ "name": "Ava", "speed": 1.1 });
            future["agents"][0]["checkIns"][0]["quietHours"] = serde_json::json!([22, 7]);
            future["agents"][0]["permissions"][0]["expiresAt"] =
                serde_json::json!(1799999999999i64);
            // A whole entry this build can't read (a repeat it has no word for).
            let mut newer = future["agents"][3].clone();
            newer["id"] = serde_json::json!("c0ffee00-0000-4000-8000-000000000005");
            newer["name"] = serde_json::json!("Monthly");
            newer["checkIns"] = serde_json::json!([{ "id": "x", "note": "n", "repeat": { "kind": "monthly", "day": 1 }, "nextAt": 1, "createdAt": 1 }]);
            future["agents"].as_array_mut().unwrap().push(newer);
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), future.to_string()).unwrap();

            assert_eq!(list().unwrap().len(), 4, "the unreadable entry is hidden");
            update(CHIEF, |a| a.unread = 7).unwrap();
            let chief = get(CHIEF).unwrap();
            assert_eq!(chief.extra["voice"]["name"], "Ava");
            let mut on_disk = registry_on_disk();
            on_disk["agents"][0]["unread"] = future["agents"][0]["unread"].clone();
            assert!(
                covers(Some(&on_disk), &future),
                "a write dropped newer data:\n{on_disk:#}"
            );
            // Nothing was treated as damage.
            let aside = std::fs::read_dir(agents_root().unwrap())
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
            assert!(!aside);
        });
    }

    /// Every kind of chat line, so a new kind can't ship without a fixture:
    /// this match stops compiling until it is listed (and added to the log).
    fn fixture_line_for(kind: MessageKind) -> &'static str {
        match kind {
            MessageKind::User => "m01",
            MessageKind::SentToAgent => "m02",
            MessageKind::FromAgent => "m03",
            MessageKind::Agent => "m04",
            MessageKind::Approval => "m05",
            MessageKind::Note => "m09",
            MessageKind::CheckIn => "m13",
            MessageKind::Changes => "m14",
            MessageKind::Error => "m16",
        }
    }

    #[test]
    fn chat_logs_from_every_release_load_in_full() {
        with_root(|| {
            std::fs::create_dir_all(agents_root().unwrap()).unwrap();
            std::fs::write(registry_path().unwrap(), COMPAT_REGISTRY).unwrap();
            let home = agent_home(CHIEF).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            // Plus lines a newer build might write: a kind and a field this one doesn't know.
            let future_kind = r#"{"id":"m21","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000021,"kind":"voice_memo","text":"hi"}"#;
            let future_field = r#"{"id":"m22","agentId":"c0ffee00-0000-4000-8000-000000000001","ts":1762200000022,"kind":"agent","text":"ok","reactions":["👍"]}"#;
            let raw = format!("{COMPAT_LOG}{future_kind}\n{future_field}\n");
            std::fs::write(home.join("messages.jsonl"), &raw).unwrap();

            let log = messages(CHIEF, usize::MAX).unwrap();
            let ids: Vec<&str> = log.iter().map(|m| m.id.as_str()).collect();
            let expected: Vec<String> = (1..=20)
                .map(|n| format!("m{n:02}"))
                .chain(["m22".into()])
                .collect();
            assert_eq!(ids, expected, "a line was dropped");
            for kind in [
                MessageKind::User,
                MessageKind::Agent,
                MessageKind::SentToAgent,
                MessageKind::FromAgent,
                MessageKind::Approval,
                MessageKind::Error,
                MessageKind::CheckIn,
                MessageKind::Note,
                MessageKind::Changes,
            ] {
                let id = fixture_line_for(kind);
                assert!(log.iter().any(|m| m.id == id && m.kind == kind), "{kind:?}");
            }
            let status = |rid: &str| {
                log.iter()
                    .filter_map(|m| m.approval.as_ref())
                    .find(|a| a.request_id == rid)
                    .unwrap()
                    .status
            };
            assert_eq!(status("req-pending"), ApprovalStatus::Pending);
            assert_eq!(status("req-allowed"), ApprovalStatus::Allowed);
            assert_eq!(status("req-denied"), ApprovalStatus::Denied);
            assert_eq!(status("req-expired"), ApprovalStatus::Expired);
            let by_id = |id: &str| log.iter().find(|m| m.id == id).unwrap();
            assert_eq!(by_id("m01").attachments.len(), 1);
            assert_eq!(by_id("m01").mentions.len(), 1);
            assert_eq!(by_id("m04").attachments[0].name, "october.csv");
            assert!(by_id("m11").stopped);
            assert!(by_id("m13").check_in.as_ref().unwrap().late);
            assert_eq!(by_id("m14").changes.as_ref().unwrap().files.len(), 3);
            assert!(by_id("m15").changes.as_ref().unwrap().branch.is_none());
            assert!(by_id("m16").failure.as_ref().unwrap().resets_at.is_some());
            assert!(by_id("m18").failure.is_none());
            assert_eq!(messages(CHIEF, 3).unwrap().len(), 3);

            // Answering a card and appending leave every existing line as it was.
            set_approval_status(CHIEF, "req-pending", ApprovalStatus::Allowed)
                .unwrap()
                .unwrap();
            append_message(&note(CHIEF, "after")).unwrap();
            let now = std::fs::read_to_string(home.join("messages.jsonl")).unwrap();
            assert!(now.starts_with(&raw), "the log was rewritten");
            assert_eq!(get(CHIEF).unwrap().pending_approvals, 0);
        });
    }

    #[test]
    fn a_torn_registry_comes_back_from_its_copy_and_is_kept_aside() {
        with_root(|| {
            create(new("Finance")).unwrap();
            create(new("Travel")).unwrap();
            let path = registry_path().unwrap();
            let raw = std::fs::read(&path).unwrap();
            std::fs::write(&path, &raw[..raw.len() / 2]).unwrap();
            assert_eq!(list().unwrap().len(), 2);
            let aside = std::fs::read_dir(agents_root().unwrap())
                .unwrap()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("agents.json.corrupt-")
                })
                .count();
            assert_eq!(aside, 1);
            // Repaired on disk: the next read neither recovers nor copies again.
            assert_eq!(list().unwrap().len(), 2);
        });
    }

    #[test]
    fn one_bad_entry_doesnt_hide_the_rest() {
        with_root(|| {
            create(new("Finance")).unwrap();
            create(new("Travel")).unwrap();
            let path = registry_path().unwrap();
            let mut value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            value["agents"][0]["shape"] = serde_json::json!("not a number");
            std::fs::write(&path, value.to_string()).unwrap();
            std::fs::remove_file(path.with_extension("json.bak")).unwrap();
            let names: Vec<String> = list().unwrap().into_iter().map(|a| a.name).collect();
            assert_eq!(names, ["Travel"]);
        });
    }

    #[test]
    fn an_unrecoverable_registry_is_an_error_not_an_empty_list() {
        with_root(|| {
            create(new("Finance")).unwrap();
            let path = registry_path().unwrap();
            std::fs::write(&path, b"{\"agents\": [").unwrap();
            std::fs::remove_file(path.with_extension("json.bak")).unwrap();
            assert!(list().is_err());
            assert!(
                create(new("Travel")).is_err(),
                "must not overwrite what it couldn't read"
            );
        });
    }

    #[test]
    fn models_are_the_cli_aliases_only() {
        assert_eq!(normalize_model(" ").unwrap(), None);
        assert_eq!(normalize_model(" opus ").unwrap().as_deref(), Some("opus"));
        assert!(normalize_model("haiku").is_ok());
        assert!(normalize_model("gpt-5").is_err());
        assert!(normalize_model("--dangerously-skip-permissions").is_err());
        assert!(normalize_model("opus; rm -rf").is_err());
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(agent_home("../etc").is_err());
        assert!(agent_home("").is_err());
    }
}
