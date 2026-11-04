//! Codex as an engine: what every Codex turn shares (models, config,
//! capabilities, activity labels), and the `codex exec --json` fallback for a
//! Codex without a usable app-server (turns normally run through
//! [`super::codex_app`]). Its JSONL maps onto the same [`Step`]s Claude
//! Code's stream gives, so the chat, the activity line, usage and failures
//! are the same.
//!
//! Verified against Codex 0.166 driven by a scripted Responses endpoint
//! (`testdata/codex-exec.jsonl` is its real output), and signed out against
//! OpenAI's own:
//!
//! - Events: `thread.started {thread_id}`, `turn.started`, `item.started` /
//!   `item.completed` (`agent_message`, `command_execution`, `mcp_tool_call`,
//!   `file_change`, `web_search`, `todo_list`, `error`), `turn.completed
//!   {usage}`, `turn.failed {error}`, and `error {message}` while it retries.
//! - No text deltas: an `agent_message` only arrives complete, even when the
//!   model streamed it, so a Codex reply appears whole (no draft).
//! - `exec` forces the approval policy to "never" whatever is configured: no
//!   approval reaches a client or a `PermissionRequest` hook, and hooks set
//!   with `-c` aren't trusted (and so don't run) without a bypass flag we
//!   don't use. So commands run in Codex's `workspace-write` sandbox (the
//!   agent's folder and the user's projects, no network) and anything beyond
//!   it fails inside the turn rather than asking. Ship Studio's own cards
//!   (push, delete an agent) still appear: they're our tools.
//! - An MCP tool needs approval by default, which "never" refuses, so our
//!   server is set to `default_tools_approval_mode = "approve"`. The user's
//!   own Codex MCP servers keep their defaults: their write tools are refused.
//! - `developer_instructions` is fixed when a session starts (a resume keeps
//!   the first one), but the project doc is re-read every turn, and when it
//!   changed Codex hands over the new one. So the agent's CLAUDE.md is its
//!   project doc (`project_doc_fallback_filenames`), and memory edits reach
//!   the next turn, as with Claude Code.

use serde_json::Value;
use std::path::{Path, PathBuf};

use super::capabilities::{self, Capabilities, Server};
use super::engine::{Engine, ModelChoice};
use super::store::Agent;
use super::stream::Step;
use super::usage::UsageTotals;

/// Codex's own folder: `$CODEX_HOME`, else `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".codex")),
    }
}

/// The models Codex lists for this account, from its own cache, in its own
/// order. Empty before Codex has fetched them (it does on first use).
pub fn models() -> Vec<ModelChoice> {
    codex_home()
        .and_then(|home| std::fs::read_to_string(home.join("models_cache.json")).ok())
        .map(|raw| models_from(&raw))
        .unwrap_or_default()
}

fn models_from(raw: &str) -> Vec<ModelChoice> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut listed: Vec<(i64, ModelChoice)> = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?;
            // It becomes an argument: a plain model name or nothing.
            let plain = !slug.starts_with('-')
                && slug
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
            plain.then(|| {
                let label = m
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(slug);
                let priority = m
                    .get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX);
                (
                    priority,
                    ModelChoice {
                        value: slug.to_string(),
                        label: label.to_string(),
                    },
                )
            })
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    listed.into_iter().map(|(_, m)| m).collect()
}

/// A TOML value for `-c`: JSON's string and array syntax is TOML's too.
fn toml<T: serde::Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Extra `-c` overrides, one per line, in debug builds only: how the e2e
/// suite points Codex at a scripted model when no account is signed in.
fn extra_config() -> Vec<String> {
    if !cfg!(debug_assertions) {
        return Vec::new();
    }
    std::env::var("SHIPSTUDIO_AGENTS_CODEX_CONFIG")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// Codex is pointed at the e2e suite's scripted model, which needs no sign-in.
pub(super) fn scripted() -> bool {
    !extra_config().is_empty()
}

/// The `-c` overrides every Codex turn gets, whichever way it runs: where
/// commands may write, our MCP server (its tools pre-approved: they put up
/// their own cards), and CLAUDE.md as the project doc. Then the e2e suite's
/// own, in debug builds.
pub(super) fn shared_config(url: &str, writable: &[String]) -> Vec<String> {
    let server = format!(
        "mcp_servers.{}={{url={},tool_timeout_sec={},default_tools_approval_mode=\"approve\"}}",
        super::prompts::SERVER_KEY,
        toml(url),
        super::mcp::APPROVAL_WAIT_SECS + 60,
    );
    [
        format!("sandbox_workspace_write.writable_roots={}", toml(writable)),
        server,
        "project_doc_fallback_filenames=[\"CLAUDE.md\"]".to_string(),
    ]
    .into_iter()
    .chain(extra_config())
    .collect()
}

/// Every argument a turn's `codex exec` gets, for a Codex without
/// `app-server` (see [`super::codex_app::available`]). The prompt goes on
/// stdin (`-`).
pub fn args(
    model: Option<&str>,
    session: Option<&str>,
    url: &str,
    developer_instructions: &str,
    writable: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if session.is_some() {
        args.push("resume".into());
    }
    args.extend(["--json".into(), "--skip-git-repo-check".into()]);
    let config = [
        "sandbox_mode=\"workspace-write\"".to_string(),
        "approval_policy=\"never\"".to_string(),
        format!("developer_instructions={}", toml(developer_instructions)),
    ];
    for value in config.into_iter().chain(shared_config(url, writable)) {
        args.extend(["-c".into(), value]);
    }
    if let Some(model) = model {
        args.extend(["-m".into(), model.to_string()]);
    }
    if let Some(id) = session {
        args.push(id.to_string());
    }
    args.push("-".into());
    args
}

/// `/bin/zsh -lc 'npm test'` → `npm test`: the command, as the agent wrote it.
pub(super) fn unwrap_shell(command: &str) -> &str {
    let inner = command
        .split_once(" -lc ")
        .or_else(|| command.split_once(" -c "))
        .filter(|(shell, _)| shell.starts_with('/') && !shell.contains(' '))
        .map_or(command, |(_, rest)| rest);
    inner
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .unwrap_or(inner)
}

/// What a Codex item is doing, in the activity line's words: the item as the
/// Claude Code tool call it corresponds to, labelled the same way.
pub(super) fn activity(item: &Value) -> Option<String> {
    let field = |k: &str| item.get(k).cloned().unwrap_or(Value::Null);
    let (name, input) = match item.get("type")?.as_str()? {
        "command_execution" => (
            "Bash".to_string(),
            serde_json::json!({ "command": unwrap_shell(item.get("command")?.as_str()?) }),
        ),
        "file_change" => (
            "Edit".to_string(),
            serde_json::json!({ "file_path": item.pointer("/changes/0/path").cloned().unwrap_or(Value::Null) }),
        ),
        "mcp_tool_call" => (
            format!(
                "mcp__{}__{}",
                item.get("server")?.as_str()?,
                item.get("tool")?.as_str()?
            ),
            field("arguments"),
        ),
        "web_search" => (
            "WebSearch".to_string(),
            serde_json::json!({ "query": field("query") }),
        ),
        "todo_list" => ("TodoWrite".to_string(), Value::Null),
        _ => return None,
    };
    let line = serde_json::json!({
        "type": "assistant",
        "message": { "content": [{ "type": "tool_use", "name": name, "input": input }] }
    });
    super::runner::describe_activity(&line.to_string())
}

fn usage(value: &Value) -> Option<UsageTotals> {
    let usage = value.get("usage")?.as_object()?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    // Codex's input count includes what was read from cache; ours doesn't.
    let cached = n("cached_input_tokens");
    Some(UsageTotals {
        turns: 1,
        input_tokens: n("input_tokens").saturating_sub(cached),
        output_tokens: n("output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: n("cache_write_input_tokens"),
        // A ChatGPT plan reports no price: tokens only, never an estimate.
        cost_usd: 0.0,
        priced_turns: 0,
        duration_ms: 0,
    })
}

/// One line of `codex exec --json`, as turn steps.
pub fn steps(value: &Value) -> Vec<Step> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let text = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match kind {
        "thread.started" => text("/thread_id").map(Step::Session).into_iter().collect(),
        "item.started" | "item.completed" => {
            let Some(item) = value.get("item") else {
                return Vec::new();
            };
            let item_type = item.get("type").and_then(Value::as_str);
            if kind == "item.completed" && item_type == Some("agent_message") {
                return text("/item/text").map(Step::Reply).into_iter().collect();
            }
            // A file change only arrives complete; everything else says so as it starts.
            if kind == "item.started" || item_type == Some("file_change") {
                return activity(item).map(Step::Activity).into_iter().collect();
            }
            Vec::new()
        }
        "turn.completed" => usage(value)
            .map(Step::Usage)
            .into_iter()
            .chain([Step::Done])
            .collect(),
        "turn.failed" => {
            vec![
                Step::Failed(text("/error/message").unwrap_or_else(|| {
                    "Codex stopped with an error it didn't describe.".to_string()
                })),
                Step::Done,
            ]
        }
        // Retries say "Reconnecting... 2/5 (…)" and then carry on, or fail the turn.
        "error" => {
            let Some(message) = text("/message") else {
                return Vec::new();
            };
            let mut out = Vec::new();
            if let Some(rest) = message.strip_prefix("Reconnecting...") {
                let attempt = rest.split_whitespace().next().unwrap_or("");
                out.push(Step::Activity(
                    format!("Reconnecting to Codex {attempt}")
                        .trim()
                        .to_string(),
                ));
            }
            out.push(Step::Detail(message));
            out
        }
        _ => Vec::new(),
    }
}

/// What a Codex agent can use: our own tools as served to it, Codex's
/// built-in shell, file edits and web search (seen in what it sends its
/// model), and the user's Codex MCP servers as `codex mcp list` reports them.
/// `asks`: the turn runs on app-server, where going past the sandbox asks.
pub async fn capabilities(caller: &Agent, binary: &Path, now: i64, asks: bool) -> Capabilities {
    let ours: Vec<String> = super::mcp::tool_names(caller)
        .into_iter()
        .map(|name| format!("mcp__{}__{name}", super::prompts::SERVER_KEY))
        .collect();
    let mut tools: Vec<&str> = ours.iter().map(String::as_str).collect();
    tools.extend(["Bash", "Edit", "WebSearch"]);
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["mcp", "list", "--json"])
        .env("PATH", crate::utils::get_extended_path());
    let servers = crate::external_command::run_with_timeout(cmd, "codex mcp list", 15)
        .await
        .ok()
        .map(|out| servers_from(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default();
    let mut lines = capabilities::lines(Engine::Codex, &tools, &servers);
    if asks {
        for line in &mut lines {
            line.detail = line.detail.replace(
                SANDBOX_LINE,
                "with no network for commands unless you allow it",
            );
        }
    }
    Capabilities {
        seen_at: now,
        lines,
    }
}

/// How the capability line ends for the sandbox (see `capabilities::lines`).
const SANDBOX_LINE: &str = "with no network for commands";

/// `codex mcp list --json`: enabled servers; one it says isn't logged in needs sign-in.
fn servers_from(raw: &str) -> Vec<Server> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    list.iter()
        .filter(|s| s.get("enabled").and_then(Value::as_bool) != Some(false))
        .filter_map(|s| {
            Some(Server {
                name: s.get("name")?.as_str()?.to_string(),
                connected: s.get("auth_status").and_then(Value::as_str) != Some("not_logged_in"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("testdata/codex-exec.jsonl");

    fn all_steps(sample: &str) -> Vec<Step> {
        sample
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .flat_map(|v| steps(&v))
            .collect()
    }

    #[test]
    fn a_real_codex_turn_maps_onto_the_same_steps() {
        let steps = all_steps(SAMPLE);
        assert!(matches!(&steps[0], Step::Session(id) if id.starts_with("01a1a8a4")));
        let activities: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                Step::Activity(a) => Some(a.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            activities,
            [
                "$ echo hi > note.txt && cat note.txt",
                "Checking on the team"
            ]
        );
        let replies: Vec<&Step> = steps
            .iter()
            .filter(|s| matches!(s, Step::Reply(_)))
            .collect();
        assert!(matches!(replies.as_slice(), [Step::Reply(t)] if t == "All done."));
        let usage = steps.iter().find_map(|s| match s {
            Step::Usage(u) => Some(u.clone()),
            _ => None,
        });
        let usage = usage.unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens
            ),
            (600, 3000, 102)
        );
        assert_eq!(usage.priced_turns, 0, "a plan reports no price");
        assert!(matches!(steps.last(), Some(Step::Done)));
        // The model-metadata warning is an item, not something the agent said.
        assert!(!steps
            .iter()
            .any(|s| matches!(s, Step::Reply(t) if t.contains("metadata"))));
    }

    #[test]
    fn a_failed_turn_keeps_codexs_own_words() {
        let usage_limit = r#"{"type":"error","message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."}
{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."}}"#;
        let steps = all_steps(usage_limit);
        assert!(matches!(&steps[1], Step::Failed(t) if t.contains("try again at 7:18 PM")));
        assert!(matches!(steps.last(), Some(Step::Done)));
        let retrying = r#"{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}"#;
        let steps = all_steps(retrying);
        assert!(matches!(&steps[0], Step::Activity(a) if a == "Reconnecting to Codex 2/5"));
        assert!(matches!(&steps[1], Step::Detail(d) if d.contains("401 Unauthorized")));
    }

    #[test]
    fn the_command_line_runs_sandboxed_with_our_server_approved() {
        let agent: Agent = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "Finance", "shape": 0, "color": "red", "createdAt": 0,
            "engine": "codex", "model": "gpt-5.5"
        }))
        .unwrap();
        let roots = vec!["/h/a".to_string(), "/u/Ship \"Studio\"".to_string()];
        let fresh = args(
            agent.model.as_deref(),
            None,
            "http://127.0.0.1:9/mcp/t/agents/a",
            "Be \"brief\".\nOk",
            &roots,
        );
        assert_eq!(&fresh[..3], ["exec", "--json", "--skip-git-repo-check"]);
        let config: Vec<&str> = fresh
            .windows(2)
            .filter(|w| w[0] == "-c")
            .map(|w| w[1].as_str())
            .collect();
        assert!(config.contains(&"sandbox_mode=\"workspace-write\""));
        assert!(config
            .contains(&r#"sandbox_workspace_write.writable_roots=["/h/a","/u/Ship \"Studio\""]"#));
        assert!(config.contains(&r#"mcp_servers.shipstudio_agents={url="http://127.0.0.1:9/mcp/t/agents/a",tool_timeout_sec=300,default_tools_approval_mode="approve"}"#));
        assert!(config.contains(&r#"developer_instructions="Be \"brief\".\nOk""#));
        assert!(fresh.windows(2).any(|w| w[0] == "-m" && w[1] == "gpt-5.5"));
        assert_eq!(fresh.last().unwrap(), "-");
        let resumed = args(agent.model.as_deref(), Some("01a1"), "http://x", "", &roots);
        assert_eq!(&resumed[..2], ["exec", "resume"]);
        assert_eq!(&resumed[resumed.len() - 2..], ["01a1", "-"]);
    }

    #[test]
    fn models_are_codexs_listed_ones_in_its_order() {
        let raw = r#"{"models":[
            {"slug":"gpt-b","display_name":"GPT-B","visibility":"list","priority":7},
            {"slug":"hidden","display_name":"Hidden","visibility":"hide","priority":1},
            {"slug":"gpt-a","display_name":"GPT-A","visibility":"list","priority":2},
            {"slug":"--evil","display_name":"Evil","visibility":"list","priority":0}
        ]}"#;
        let values: Vec<String> = models_from(raw).into_iter().map(|m| m.value).collect();
        assert_eq!(values, ["gpt-a", "gpt-b"]);
        assert!(models_from("not json").is_empty());
    }

    #[test]
    fn mcp_servers_are_read_from_codexs_list() {
        let raw = r#"[{"name":"Sanity","enabled":true,"auth_status":"bearer_token"},
            {"name":"linear","enabled":true,"auth_status":"not_logged_in"},
            {"name":"off","enabled":false,"auth_status":"unknown"}]"#;
        let servers = servers_from(raw);
        assert_eq!(servers.len(), 2);
        assert!(servers[0].connected && !servers[1].connected);
    }

    #[test]
    fn the_sandbox_line_is_the_one_capabilities_writes() {
        let lines = capabilities::lines(Engine::Codex, &["Bash"], &[]);
        assert!(lines.iter().any(|l| l.detail.contains(SANDBOX_LINE)));
    }

    #[test]
    fn shell_wrappers_are_peeled_off() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'npm test'"), "npm test");
        assert_eq!(unwrap_shell("/bin/bash -c ls"), "ls");
        assert_eq!(unwrap_shell("git status"), "git status");
    }
}
