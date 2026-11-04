//! What the approval broker (`mcp::approve`) trusts before it puts a card in
//! front of the user, and what it checks Claude Code is actually doing.
//!
//! - **A request belongs to a live turn.** Each turn gets an id, carried in
//!   its MCP URL (`?turn=`). A request with no turn, from a turn that has
//!   ended (a dying process, a Stop that raced it), or naming a turn that was
//!   never issued is denied at once: it would only ever be a zombie card
//!   nobody can act on.
//! - **A request is asked once.** A repeated `tool_use_id` is denied rather
//!   than shown twice.
//! - **The permission mode is read, not assumed.** We start every turn in
//!   `acceptEdits` and rely on Claude Code asking us for everything else. Its
//!   `system/init` event says the mode it really runs in (verified on Claude
//!   Code 2.1.318: `"permissionMode": "acceptEdits"`). If that is
//!   `bypassPermissions`, nothing would ever ask, so the turn is stopped
//!   before it does anything; a stricter mode is noted once and carried on.
//!   If our own server failed to start, its approval tool doesn't exist, and
//!   the turn is stopped too.
//!
//! The same event lists the user's connectors and which of them need signing
//! in again (`"status": "needs-auth"`); scheduled runs report those.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use tauri::AppHandle;

use super::prompts::SERVER_KEY;
use super::runner;
use super::store::MessageKind;

/// Request ids remembered per agent, for refusing a repeat.
const SEEN_PER_AGENT: usize = 256;

#[derive(Default)]
struct Book {
    issued: u64,
    /// Agent id → the turn it has open.
    open: HashMap<String, u64>,
    seen: HashMap<String, VecDeque<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Live,
    /// No turn named, or one that was never issued.
    NoTurn,
    /// A turn that has ended, or one replaced by a newer turn.
    Closed,
    /// This request id was already asked.
    Duplicate,
}

impl Book {
    fn open(&mut self, agent_id: &str) -> u64 {
        self.issued += 1;
        self.open.insert(agent_id.to_string(), self.issued);
        self.issued
    }

    fn close(&mut self, agent_id: &str, turn: u64) {
        if self.open.get(agent_id) == Some(&turn) {
            self.open.remove(agent_id);
        }
    }

    fn admit(&mut self, agent_id: &str, turn: Option<u64>, request_id: Option<&str>) -> Admission {
        let Some(turn) = turn.filter(|t| (1..=self.issued).contains(t)) else {
            return Admission::NoTurn;
        };
        if self.open.get(agent_id) != Some(&turn) {
            return Admission::Closed;
        }
        if let Some(id) = request_id {
            let seen = self.seen.entry(agent_id.to_string()).or_default();
            if seen.iter().any(|s| s == id) {
                return Admission::Duplicate;
            }
            seen.push_back(id.to_string());
            if seen.len() > SEEN_PER_AGENT {
                seen.pop_front();
            }
        }
        Admission::Live
    }
}

static BOOK: LazyLock<Mutex<Book>> = LazyLock::new(|| Mutex::new(Book::default()));

fn book() -> std::sync::MutexGuard<'static, Book> {
    BOOK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A turn's id, open for as long as this is held: dropped when `run_turn`
/// returns, however it returns.
pub struct TurnGuard {
    agent_id: String,
    id: u64,
}

impl TurnGuard {
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        book().close(&self.agent_id, self.id);
    }
}

pub fn open_turn(agent_id: &str) -> TurnGuard {
    TurnGuard {
        agent_id: agent_id.to_string(),
        id: book().open(agent_id),
    }
}

/// Whether the broker should take this request to the user at all.
pub fn admit(agent_id: &str, turn: Option<u64>, request_id: Option<&str>) -> Admission {
    book().admit(agent_id, turn, request_id)
}

/// What Claude Code is told when a request is refused without asking.
pub fn refusal(admission: Admission) -> &'static str {
    match admission {
        Admission::Live => "",
        Admission::Duplicate => "This exact request was already put to the user; it isn't asked twice. Wait for that answer, or tell the user what you need.",
        Admission::NoTurn | Admission::Closed => "This request arrived after its turn had ended, so it was declined without asking the user. If you still need it, say so in your next reply.",
    }
}

/// `?turn=7` on the agent's MCP URL.
pub fn turn_from_query(query: Option<&str>) -> Option<u64> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("turn="))
        .and_then(|v| v.parse().ok())
}

/* ------------------------------------------------------- the init event */

/// What a turn's `system/init` event said that matters here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Init {
    pub permission_mode: Option<String>,
    /// Connectors Claude Code says need signing in again, by display name.
    pub needs_sign_in: Vec<String>,
    /// Our own server's status, if it was listed.
    pub ours: Option<String>,
}

pub fn read_init(event: &Value) -> Option<Init> {
    if event.get("type")?.as_str()? != "system" || event.get("subtype")?.as_str()? != "init" {
        return None;
    }
    let servers = event
        .get("mcp_servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let status = |s: &Value| s.get("status").and_then(Value::as_str).map(str::to_string);
    Some(Init {
        permission_mode: event
            .get("permissionMode")
            .and_then(Value::as_str)
            .map(str::to_string),
        needs_sign_in: servers
            .iter()
            .filter(|s| status(s).as_deref() == Some("needs-auth"))
            .filter_map(|s| s.get("name").and_then(Value::as_str))
            .map(|n| n.trim_start_matches("claude.ai ").to_string())
            .collect(),
        ours: servers
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(SERVER_KEY))
            .and_then(status),
    })
}

/// The permission mode every turn is started in (`runner::turn_args`).
pub const EXPECTED_MODE: &str = "acceptEdits";

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Fine,
    /// Carry on, saying this once in the chat.
    Note(String),
    /// Stop the turn before it does anything, with this as its error.
    Stop(&'static str),
}

pub fn judge(init: &Init) -> Verdict {
    if init.ours.as_deref() == Some("failed") {
        return Verdict::Stop("Ship Studio's connection to Claude Code didn't start for this turn, so nothing could ask you before acting. It was stopped. Send your message again.");
    }
    match init.permission_mode.as_deref() {
        None | Some(EXPECTED_MODE) => Verdict::Fine,
        Some("bypassPermissions") => Verdict::Stop("Claude Code started this turn with permission checks off (bypassPermissions), so nothing would have asked you first. It was stopped before doing anything. Check Claude Code's permission settings, then send your message again."),
        Some(mode @ ("default" | "plan" | "dontAsk")) => Verdict::Note(format!(
            "Claude Code ran this turn in its “{mode}” permission mode rather than accept-edits, so it may ask more often or do less."
        )),
        Some(mode) => Verdict::Note(format!(
            "Claude Code reported a permission mode Ship Studio doesn't know (“{mode}”). Requests still come to you here."
        )),
    }
}

/// The latest init per agent, for scheduled runs to report connectors.
static SEEN_INIT: LazyLock<Mutex<HashMap<String, Init>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Agents already told about an unexpected mode this session.
static NOTED: LazyLock<Mutex<HashSet<(String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Called with each `system` event of a turn. Returns the reason to stop the
/// turn, if it must not go on.
pub fn observe(app: &AppHandle, agent_id: &str, event: &Value) -> Option<&'static str> {
    let init = read_init(event)?;
    if init.permission_mode.is_none() {
        tracing::warn!("[Agents] Claude Code's init didn't say its permission mode; approvals can't be checked");
    }
    let verdict = judge(&init);
    SEEN_INIT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), init.clone());
    match verdict {
        Verdict::Fine => None,
        Verdict::Stop(why) => {
            tracing::warn!(agent = agent_id, mode = ?init.permission_mode, ours = ?init.ours, "[Agents] stopping a turn whose permissions can't be trusted");
            Some(why)
        }
        Verdict::Note(text) => {
            let key = (
                agent_id.to_string(),
                init.permission_mode.clone().unwrap_or_default(),
            );
            if NOTED.lock().unwrap_or_else(|e| e.into_inner()).insert(key) {
                tracing::warn!(agent = agent_id, mode = ?init.permission_mode, "[Agents] unexpected permission mode");
                let _ = runner::record(app, runner::new_message(agent_id, MessageKind::Note, text));
            }
            None
        }
    }
}

/// Connectors the agent's latest turn couldn't use until they're signed in again.
pub fn needs_sign_in(agent_id: &str) -> Vec<String> {
    SEEN_INIT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(agent_id)
        .map(|i| i.needs_sign_in.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_live_turns_requests_reach_the_user() {
        let mut book = Book::default();
        assert_eq!(book.admit("a", None, Some("t1")), Admission::NoTurn);
        assert_eq!(book.admit("a", Some(9), Some("t1")), Admission::NoTurn);
        let first = book.open("a");
        assert_eq!(book.admit("a", Some(first), Some("t1")), Admission::Live);
        // Another agent's turn isn't this one's.
        let other = book.open("b");
        assert_eq!(book.admit("a", Some(other), Some("t2")), Admission::Closed);
        // A newer turn replaces the old one: the old one's late requests are refused.
        let second = book.open("a");
        assert_eq!(book.admit("a", Some(first), Some("t3")), Admission::Closed);
        assert_eq!(book.admit("a", Some(second), Some("t3")), Admission::Live);
        // After it ends, nothing from it is asked.
        book.close("a", second);
        assert_eq!(book.admit("a", Some(second), Some("t4")), Admission::Closed);
        // Closing an old turn doesn't close the new one.
        let third = book.open("a");
        book.close("a", second);
        assert_eq!(book.admit("a", Some(third), Some("t5")), Admission::Live);
    }

    #[test]
    fn a_repeated_request_id_is_refused() {
        let mut book = Book::default();
        let turn = book.open("a");
        assert_eq!(
            book.admit("a", Some(turn), Some("toolu_1")),
            Admission::Live
        );
        assert_eq!(
            book.admit("a", Some(turn), Some("toolu_1")),
            Admission::Duplicate
        );
        // Even in a later turn.
        let next = book.open("a");
        assert_eq!(
            book.admit("a", Some(next), Some("toolu_1")),
            Admission::Duplicate
        );
        // Another agent's ids are its own.
        let b = book.open("b");
        assert_eq!(book.admit("b", Some(b), Some("toolu_1")), Admission::Live);
        // No id: can't be checked for repeats, but still needs a live turn.
        assert_eq!(book.admit("a", Some(next), None), Admission::Live);
    }

    #[test]
    fn the_guard_closes_its_turn_on_any_return() {
        let (turn, id) = {
            let guard = open_turn("guarded-agent");
            let id = guard.id();
            (admit("guarded-agent", Some(id), Some("g1")), id)
        };
        assert_eq!(turn, Admission::Live);
        assert_eq!(
            admit("guarded-agent", Some(id), Some("g2")),
            Admission::Closed
        );
    }

    #[test]
    fn the_turn_rides_on_the_url() {
        assert_eq!(turn_from_query(Some("turn=12")), Some(12));
        assert_eq!(turn_from_query(Some("x=1&turn=3")), Some(3));
        assert_eq!(turn_from_query(Some("turn=abc")), None);
        assert_eq!(turn_from_query(None), None);
    }

    /// Trimmed from a real Claude Code 2.1.318 init event.
    fn init_event(mode: Option<&str>, ours: &str) -> Value {
        let mut event = json!({
            "type": "system", "subtype": "init", "session_id": "s",
            "mcp_servers": [
                {"name": "Sanity", "status": "connected", "source": "user"},
                {"name": "webflow", "status": "needs-auth", "source": "user"},
                {"name": "claude.ai Google Drive", "status": "needs-auth", "source": "claudeai"},
                {"name": SERVER_KEY, "status": ours}
            ],
            "claude_code_version": "2.1.318"
        });
        if let Some(mode) = mode {
            event["permissionMode"] = json!(mode);
        }
        event
    }

    #[test]
    fn the_real_permission_mode_is_read_and_judged() {
        let init = read_init(&init_event(Some("acceptEdits"), "connected")).unwrap();
        assert_eq!(init.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(init.needs_sign_in, vec!["webflow", "Google Drive"]);
        assert_eq!(judge(&init), Verdict::Fine);

        let bypass = read_init(&init_event(Some("bypassPermissions"), "connected")).unwrap();
        assert!(matches!(judge(&bypass), Verdict::Stop(_)));
        let plan = read_init(&init_event(Some("plan"), "connected")).unwrap();
        assert!(matches!(judge(&plan), Verdict::Note(n) if n.contains("plan")));
        let odd = read_init(&init_event(Some("auto"), "connected")).unwrap();
        assert!(matches!(judge(&odd), Verdict::Note(_)));
        // Not said: nothing to check against, so nothing is claimed.
        let silent = read_init(&init_event(None, "connected")).unwrap();
        assert_eq!(judge(&silent), Verdict::Fine);
        // Our server down means no approval tool: never carry on without it.
        let down = read_init(&init_event(Some("acceptEdits"), "failed")).unwrap();
        assert!(matches!(judge(&down), Verdict::Stop(_)));
        // Only the init event counts.
        assert!(read_init(&json!({"type": "system", "subtype": "compact_boundary"})).is_none());
    }
}
