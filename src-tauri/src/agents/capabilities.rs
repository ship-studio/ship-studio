//! What an agent can actually use, read from Claude Code's own `system/init`
//! event rather than assumed.
//!
//! Every turn's stream starts with an `init` that lists the session's tools
//! and MCP servers, with each server's status. The runner keeps the last one
//! on the agent (`Agent.capabilities`), and two things are built from it:
//! the "What you can do" section of the agent's next prompt, so it knows how
//! capable it is, and "What <agent> can do" in the agent editor. A connector
//! the user hasn't signed in to is said to need sign-in, never claimed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::engine::Engine;
use super::prompts::SERVER_KEY;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// When the init this was read from arrived.
    pub seen_at: i64,
    /// One line per kind of thing it can do, in a fixed order.
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub what: String,
    pub detail: String,
}

pub struct Server {
    pub name: String,
    /// Claude Code: its init says "connected". Codex: not reported as needing sign-in.
    pub connected: bool,
}

const CHROME: &str = "claude-in-chrome";

fn is_computer_use(name: &str) -> bool {
    name.to_ascii_lowercase().contains("computer-use")
}

/// "claude.ai Gmail" → "Gmail"; other names as Claude Code reports them.
fn display_name(name: &str) -> &str {
    name.strip_prefix("claude.ai ").unwrap_or(name)
}

/// Read an `init` event. `None` for anything else.
pub fn from_init(event: &Value, now: i64) -> Option<Capabilities> {
    if event.get("type")?.as_str()? != "system" || event.get("subtype")?.as_str()? != "init" {
        return None;
    }
    let tools: Vec<&str> = event
        .get("tools")
        .and_then(Value::as_array)
        .map(|t| t.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let servers: Vec<Server> = event
        .get("mcp_servers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    Some(Server {
                        name: s.get("name")?.as_str()?.to_string(),
                        connected: s.get("status").and_then(Value::as_str) == Some("connected"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Capabilities {
        seen_at: now,
        lines: lines(Engine::Claude, &tools, &servers),
    })
}

/// The lines, from the tool ids the session has (Claude Code's names; Codex's
/// built-ins are given as the ones they correspond to) and its MCP servers.
pub fn lines(engine: Engine, tools: &[&str], servers: &[Server]) -> Vec<Line> {
    let ours = |name: &str| tools.contains(&format!("mcp__{SERVER_KEY}__{name}").as_str());
    let has = |name: &str| tools.contains(&name);
    let mut out = Vec::new();
    let mut push = |what: &str, detail: String| {
        out.push(Line {
            what: what.to_string(),
            detail,
        })
    };

    if ours("session_start") {
        push(
            "Ship Studio projects",
            "Create projects, start and continue sessions in them, screenshot their previews, check git, push with your OK, and check deploys.".into(),
        );
    }
    if ours("create_agent") {
        push(
            "The team",
            "Create, brief, message and manage the other agents.".into(),
        );
    } else if ours("message_agent") {
        push("The team", "Message the other agents.".into());
    }
    let server = |pred: &dyn Fn(&str) -> bool| servers.iter().find(|s| pred(&s.name));
    match server(&|n| n == CHROME) {
        Some(s) if s.connected => push(
            "Chrome",
            "Browse in your Chrome: open pages, click, fill in forms and read what's showing."
                .into(),
        ),
        Some(_) => push(
            "Chrome",
            "Not connected: the Claude in Chrome extension isn't reachable.".into(),
        ),
        None => {}
    }
    match server(&is_computer_use) {
        Some(s) if s.connected => push(
            "Computer use",
            "See and control this Mac's screen and apps.".into(),
        ),
        Some(_) => push("Computer use", "Not connected.".into()),
        None => {}
    }
    let mut work = Vec::new();
    if has("Bash") {
        work.push("run commands");
    }
    if has("Edit") || has("Write") {
        work.push("read and edit files");
    }
    if has("WebSearch") || has("WebFetch") {
        work.push("use the web");
    }
    if ours("share_file") {
        work.push("send you files");
    }
    if ours("schedule_check_in") {
        work.push("schedule check-ins");
    }
    if !work.is_empty() {
        let mut detail = join(&work);
        if let Some(first) = detail.get(..1) {
            detail = first.to_uppercase() + &detail[1..];
        }
        if engine == Engine::Codex {
            // Codex's sandbox, as Ship Studio starts it (see `codex`).
            detail.push_str(", in Codex's sandbox: your projects and its own folder, with no network for commands");
        }
        push("On this Mac", format!("{detail}."));
    }
    let others = |connected: bool| -> Vec<&str> {
        servers
            .iter()
            .filter(|s| s.connected == connected)
            .filter(|s| s.name != SERVER_KEY && s.name != CHROME && !is_computer_use(&s.name))
            .map(|s| display_name(&s.name))
            .collect()
    };
    let connected = others(true);
    if !connected.is_empty() {
        push("Connectors", join(&connected));
    }
    let signed_out = others(false);
    if !signed_out.is_empty() {
        push(
            "Needs sign-in",
            format!(
                "{}. Connect them in {} to use them here.",
                join(&signed_out),
                engine.label()
            ),
        );
    }
    out
}

fn join(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The prompt section, or nothing before the agent's first turn has said.
pub fn prompt_section(caps: Option<&Capabilities>, engine: Engine) -> Option<String> {
    let caps = caps.filter(|c| !c.lines.is_empty())?;
    let lines: Vec<String> = caps
        .lines
        .iter()
        .map(|l| format!("- {}: {}", l.what, l.detail))
        .collect();
    Some(format!(
        "## What you can do here\n\nAs of your last turn ({}'s own list):\n\n{}\n\n\
Use these when they serve what the user asked, within the approval rules. Don't \
claim anything that isn't listed; if something needs sign-in, say so.",
        engine.label(),
        lines.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn init() -> Value {
        json!({
            "type": "system", "subtype": "init",
            "tools": [
                "Bash", "Edit", "Read", "WebFetch",
                "mcp__shipstudio_agents__message_agent",
                "mcp__shipstudio_agents__session_start",
                "mcp__shipstudio_agents__share_file",
                "mcp__claude-in-chrome__navigate",
                "mcp__claude_ai_Gmail__send_email"
            ],
            "mcp_servers": [
                { "name": "shipstudio_agents", "status": "connected" },
                { "name": "claude-in-chrome", "status": "connected", "source": "dynamic" },
                { "name": "claude.ai Gmail", "status": "connected" },
                { "name": "Sanity", "status": "connected" },
                { "name": "webflow", "status": "needs-auth" }
            ]
        })
    }

    #[test]
    fn capabilities_come_from_what_claude_code_listed() {
        let caps = from_init(&init(), 5).unwrap();
        let what: Vec<&str> = caps.lines.iter().map(|l| l.what.as_str()).collect();
        assert_eq!(
            what,
            [
                "Ship Studio projects",
                "The team",
                "Chrome",
                "On this Mac",
                "Connectors",
                "Needs sign-in"
            ]
        );
        let detail = |w: &str| {
            caps.lines
                .iter()
                .find(|l| l.what == w)
                .unwrap()
                .detail
                .clone()
        };
        assert_eq!(detail("Connectors"), "Gmail and Sanity");
        assert!(detail("Needs sign-in").starts_with("webflow."));
        assert_eq!(
            detail("On this Mac"),
            "Run commands, read and edit files, use the web and send you files."
        );
        // Nothing listed, nothing claimed: no computer use here.
        assert!(!what.contains(&"Computer use"));
    }

    #[test]
    fn an_unreachable_extension_is_said_to_be_unreachable() {
        let mut event = init();
        event["mcp_servers"][1]["status"] = json!("failed");
        let caps = from_init(&event, 0).unwrap();
        let chrome = caps.lines.iter().find(|l| l.what == "Chrome").unwrap();
        assert!(chrome.detail.starts_with("Not connected"));
    }

    #[test]
    fn only_init_events_count_and_the_prompt_waits_for_one() {
        assert!(from_init(&json!({ "type": "system", "subtype": "status" }), 0).is_none());
        assert!(prompt_section(None, Engine::Claude).is_none());
        let caps = from_init(&init(), 0).unwrap();
        let section = prompt_section(Some(&caps), Engine::Claude).unwrap();
        assert!(section.contains("- Chrome: Browse in your Chrome"));
    }

    /// A real headless turn, the way agents run: does Claude in Chrome load
    /// under `--print --chrome`, and is it read as a capability? Spends a
    /// little Haiku quota and needs Claude Code signed in.
    #[test]
    #[ignore = "runs real Claude Code; run deliberately with --ignored"]
    fn a_real_headless_turn_lists_chrome() {
        let Some(binary) = crate::commands::claude::find_validated_binary("claude", "--version")
        else {
            panic!("Claude Code isn't installed");
        };
        let dir = std::env::temp_dir().join(format!("ss-caps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cmd = std::process::Command::new(binary);
        cmd.args([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--chrome",
            "--model",
            "haiku",
            "Reply with just: ok",
        ])
        .current_dir(&dir);
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().to_string();
            if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
                cmd.env_remove(key);
            }
        }
        let out = cmd.output().unwrap();
        let caps = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find_map(|v| from_init(&v, 0))
            .expect("no init event");
        let chrome = caps.lines.iter().find(|l| l.what == "Chrome");
        assert!(chrome.is_some(), "Chrome missing: {:?}", caps.lines);
        eprintln!("{:#?}", caps.lines);
    }
}
