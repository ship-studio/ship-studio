//! Persistence for Agents: the registry of agents and each agent's chat log.
//!
//! Layout, under the projects root (`~/ShipStudio` by default):
//!
//! ```text
//! .shipstudio/agents/
//!   agents.json              the registry (every agent's identity and state)
//!   <agent-id>/              the agent's home: its working directory
//!     CLAUDE.md              instructions + memory; Claude Code loads it every turn
//!     messages.jsonl         the conversation as the user sees it
//! ```
//!
//! The chat log is ours, not Claude Code's session file. It records exactly
//! what the user was shown — their messages, the agent's replies, the lines
//! where agents talked to each other, approval cards — so the UI never has to
//! reconstruct a conversation from a tool transcript it doesn't own.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

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
    Note,
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default)]
    agents: Vec<Agent>,
}

/// One lock around every registry read-modify-write. The registry is small
/// and written rarely; serialising access is simpler than being clever.
static REGISTRY_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// Same for chat logs (appends from concurrent turns must not interleave).
static LOG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

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
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            super::err_other(format!(
                "The agents registry at {} is unreadable: {e}",
                path.display()
            ))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(e) => Err(super::err_io(e.to_string())),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| super::err_io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| super::err_io(e.to_string()))
}

fn write_registry(registry: &Registry) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(registry).map_err(|e| super::err_other(e.to_string()))?;
    write_atomic(&registry_path()?, &json)
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
        pinned: false,
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

pub fn append_message(message: &AgentMessage) -> Result<(), CommandError> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(&message.agent_id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| super::err_io(e.to_string()))?;
    }
    let mut line = serde_json::to_string(message).map_err(|e| super::err_other(e.to_string()))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| super::err_io(e.to_string()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| super::err_io(e.to_string()))
}

fn read_log(agent_id: &str) -> Result<Vec<AgentMessage>, CommandError> {
    let path = log_path(agent_id)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(super::err_io(e.to_string())),
    };
    // A torn last line (crash mid-append) is skipped rather than failing the chat.
    Ok(raw
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}

/// The newest `limit` messages, oldest first.
pub fn messages(agent_id: &str, limit: usize) -> Result<Vec<AgentMessage>, CommandError> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let all = read_log(agent_id)?;
    let start = all.len().saturating_sub(limit);
    Ok(all[start..].to_vec())
}

/// Set an approval's outcome. Rewrites the log; approvals are rare enough
/// that this is cheaper than a second file of updates.
pub fn set_approval_status(
    agent_id: &str,
    request_id: &str,
    status: ApprovalStatus,
) -> Result<Option<AgentMessage>, CommandError> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_log(agent_id)?;
    let mut changed = None;
    for message in all.iter_mut() {
        if let Some(approval) = message.approval.as_mut() {
            if approval.request_id == request_id && approval.status == ApprovalStatus::Pending {
                approval.status = status;
                changed = Some(message.clone());
            }
        }
    }
    if changed.is_some() {
        let mut out = String::new();
        for m in &all {
            out.push_str(&serde_json::to_string(m).map_err(|e| super::err_other(e.to_string()))?);
            out.push('\n');
        }
        write_atomic(&log_path(agent_id)?, out.as_bytes())?;
    }
    let pending = count_pending(&all);
    drop(_guard);
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
        let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_log(agent_id)
            .map(|log| count_pending(&log))
            .unwrap_or(0)
    };
    let _ = update(agent_id, |a| a.pending_approvals = pending);
}

pub fn find_approval(agent_id: &str, request_id: &str) -> Result<Option<Approval>, CommandError> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read_log(agent_id)?
        .into_iter()
        .filter_map(|m| m.approval)
        .find(|a| a.request_id == request_id))
}

/// On startup nothing is waiting on an approval any more: the process that
/// asked is gone. Mark leftovers expired so the card doesn't offer a button
/// that can't do anything.
pub fn expire_stale_approvals() {
    let Ok(agents) = list() else { return };
    for agent in agents {
        let Ok(log) = messages(&agent.id, usize::MAX) else {
            continue;
        };
        for m in log {
            if let Some(a) = m.approval {
                // Permission cards stay answerable across restarts (a late
                // Allow re-wakes the agent); only Ship Studio's own
                // confirmations lose their meaning when the asker is gone.
                if a.status == ApprovalStatus::Pending && a.tool.is_none() {
                    let _ = set_approval_status(&agent.id, &a.request_id, ApprovalStatus::Expired);
                }
            }
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
                }),
                attachments: Vec::new(),
                check_in: None,
                stopped: false,
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
