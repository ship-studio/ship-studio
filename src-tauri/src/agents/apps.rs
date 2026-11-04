//! Apps agents can use: the user's own Claude Code MCP servers.
//!
//! Every agent turn is a `claude` process, and Claude Code loads the user's
//! MCP servers into it, so connecting an app here is connecting it in Claude
//! Code. Nothing is stored by Ship Studio; this module only asks and tells
//! Claude Code:
//!
//! - **List**: `claude mcp list` (it health-checks each server, so the status
//!   is Claude Code's own), plus a read-only look at Claude Code's config for
//!   which of those are user-scope, the only ones this panel will remove.
//! - **Add**: one of [`SUGGESTED`], with
//!   `claude mcp add --scope user --transport http <name> <url>`. Only the
//!   built-in list can be added from here, so no URL comes from the webview.
//!   Sign-in is Claude Code's own OAuth, the first time an agent uses it.
//! - **Remove**: `claude mcp remove --scope user <name>`.
//!
//! Each call runs with the same stripped session environment as a turn
//! (`runner::strip_session_env`), so what's listed is what agents get.

use serde::Serialize;
use std::path::PathBuf;

use crate::commands::mcp::{
    classify_mcp_failure, drop_stale_git_bash_path, mcp_server_not_found, parse_status_text,
    strip_ansi,
};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;

/// `claude mcp list` connects to every server to report its health.
const LIST_TIMEOUT_SECS: u64 = 60;
const CHANGE_TIMEOUT_SECS: u64 = 30;

/// A popular app with an official remote MCP server, added by name.
///
/// Only endpoints the vendor itself publishes for remote MCP clients, each of
/// which signs in with OAuth in the browser. Left out on purpose: GitHub (its
/// remote server wants a personal access token in a header, not OAuth), and
/// Gmail, Google Calendar and Slack (no public remote endpoint of their own;
/// they come through claude.ai's connectors instead, which Claude Code
/// loads when signed in with that account).
pub struct Suggested {
    pub server_name: &'static str,
    pub title: &'static str,
    pub blurb: &'static str,
    pub url: &'static str,
}

pub const SUGGESTED: &[Suggested] = &[
    Suggested {
        server_name: "linear",
        title: "Linear",
        blurb: "Issues, projects and cycles",
        url: "https://mcp.linear.app/mcp",
    },
    Suggested {
        server_name: "notion",
        title: "Notion",
        blurb: "Pages and databases",
        url: "https://mcp.notion.com/mcp",
    },
    Suggested {
        server_name: "figma",
        title: "Figma",
        blurb: "Designs, frames and comments",
        url: "https://mcp.figma.com/mcp",
    },
    Suggested {
        server_name: "sentry",
        title: "Sentry",
        blurb: "Errors and their stack traces",
        url: "https://mcp.sentry.dev/mcp",
    },
    Suggested {
        server_name: "stripe",
        title: "Stripe",
        blurb: "Customers, payments and invoices",
        url: "https://mcp.stripe.com",
    },
    Suggested {
        server_name: "vercel",
        title: "Vercel",
        blurb: "Deployments, logs and projects",
        url: "https://mcp.vercel.com",
    },
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// In Claude Code's user config: every agent gets it; removable here.
    User,
    /// One of the user's claude.ai connectors; managed on claude.ai.
    ClaudeAi,
    /// Project/local scope or a plugin: listed, but managed where it was set up.
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    /// The server's URL, or the command for a local one.
    pub target: String,
    /// `connected`, `needs_auth`, `error` or `unknown`, as Claude Code reported it.
    pub status: String,
    pub source: Source,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub server_name: String,
    pub title: String,
    pub blurb: String,
    pub url: String,
    /// Already set up, under this name or at this URL.
    pub added: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Apps {
    pub connected: Vec<App>,
    pub suggestions: Vec<Suggestion>,
}

/// One line of `claude mcp list`:
/// `<name>: <url or command> [(HTTP)] - <mark> <status>`. A claude.ai
/// connector's name has spaces in it ("claude.ai Google Drive").
fn parse_line(line: &str) -> Option<(String, String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with("Checking") || line.starts_with("No MCP") {
        return None;
    }
    let (name, rest) = line.split_once(": ")?;
    let (target, status) = match rest.rsplit_once(" - ") {
        Some((t, s)) => (t, parse_status_text(s)),
        None => (rest, "unknown".to_string()),
    };
    let target = target
        .trim()
        .trim_end_matches("(HTTP)")
        .trim_end_matches("(SSE)")
        .trim();
    Some((name.trim().to_string(), target.to_string(), status))
}

pub fn parse_list(output: &str, user_names: &[String]) -> Vec<App> {
    strip_ansi(output)
        .lines()
        .filter_map(parse_line)
        .map(|(name, target, status)| {
            let source = if user_names.contains(&name) {
                Source::User
            } else if name.starts_with("claude.ai ") {
                Source::ClaudeAi
            } else {
                Source::Other
            };
            App {
                name,
                target,
                status,
                source,
            }
        })
        .collect()
}

fn same_url(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

pub fn suggestions(connected: &[App]) -> Vec<Suggestion> {
    SUGGESTED
        .iter()
        .map(|s| Suggestion {
            server_name: s.server_name.to_string(),
            title: s.title.to_string(),
            blurb: s.blurb.to_string(),
            url: s.url.to_string(),
            added: connected
                .iter()
                .any(|a| a.name.eq_ignore_ascii_case(s.server_name) || same_url(&a.target, s.url)),
        })
        .collect()
}

/// Claude Code's own config file: `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json`.
fn claude_config_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Names of the user-scope servers, read (never written) from Claude Code's config.
pub fn user_scope_names(config: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(config)
        .ok()
        .and_then(|v| v.get("mcpServers")?.as_object().cloned())
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}

fn read_user_scope_names() -> Vec<String> {
    claude_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|text| user_scope_names(&text))
        .unwrap_or_default()
}

/// `claude <args>` as an agent turn would run it: same binary, same PATH,
/// none of a parent Claude Code session's variables, from the agents folder.
fn claude(args: &[&str]) -> Result<tokio::process::Command, CommandError> {
    let binary = crate::commands::claude::find_validated_binary("claude", "--version")
        .ok_or_else(|| {
            CommandError::expected(
                "Claude Code isn't installed, or Ship Studio can't find it. Install it from Settings → Agents.",
            )
        })?;
    let mut cmd = crate::utils::create_command(&binary);
    cmd.args(args)
        .env("PATH", crate::utils::get_extended_path());
    if let Some(home) = dirs::home_dir() {
        cmd.env("HOME", home);
    }
    super::runner::strip_session_env(&mut cmd);
    drop_stale_git_bash_path(&mut cmd);
    // Local-scope servers are keyed by folder; agents run under this one.
    if let Ok(root) = super::store::agents_root() {
        if root.is_dir() {
            cmd.current_dir(root);
        }
    }
    Ok(tokio::process::Command::from(cmd))
}

fn failure_details(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        stderr.into_owned()
    }
}

pub async fn list() -> Result<Apps, CommandError> {
    let output = run_with_timeout(
        claude(&["mcp", "list"])?,
        "claude mcp list",
        LIST_TIMEOUT_SECS,
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let details = failure_details(&output);
        if !details.to_ascii_lowercase().contains("no mcp servers") {
            return Err(classify_mcp_failure("list Claude Code's apps", &details));
        }
    }
    let connected = parse_list(&stdout, &read_user_scope_names());
    let suggestions = suggestions(&connected);
    Ok(Apps {
        connected,
        suggestions,
    })
}

/// Add one of [`SUGGESTED`] for every agent (user scope).
pub async fn add(server_name: &str) -> Result<(), CommandError> {
    let s = SUGGESTED
        .iter()
        .find(|s| s.server_name == server_name)
        .ok_or_else(|| super::err_invalid("serverName", "That app isn't on the list."))?;
    let cmd = claude(&[
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        s.server_name,
        s.url,
    ])?;
    let output = run_with_timeout(cmd, "claude mcp add", CHANGE_TIMEOUT_SECS).await?;
    if output.status.success() {
        return Ok(());
    }
    let details = failure_details(&output);
    // Added meanwhile (another window, or by hand): that's the goal state.
    if details.to_ascii_lowercase().contains("already exists") {
        return Ok(());
    }
    Err(classify_mcp_failure("add the app", &details))
}

/// Remove a user-scope server. Others are managed where they were set up.
pub async fn remove(name: &str) -> Result<(), CommandError> {
    if !read_user_scope_names().iter().any(|n| n == name) {
        return Err(CommandError::expected(format!(
            "{name} isn't in your Claude Code user settings, so it's managed where it was set up."
        )));
    }
    let cmd = claude(&["mcp", "remove", "--scope", "user", name])?;
    let output = run_with_timeout(cmd, "claude mcp remove", CHANGE_TIMEOUT_SECS).await?;
    if output.status.success() {
        return Ok(());
    }
    let details = failure_details(&output);
    if mcp_server_not_found(&details) {
        return Ok(());
    }
    Err(classify_mcp_failure("remove the app", &details))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from Claude Code 2.1.318 (URLs shortened).
    const LIST: &str = "Checking MCP server health…\n\n\
        claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - \u{2714} Connected\n\
        Sanity: https://mcp.sanity.io (HTTP) - \u{2714} Connected\n\
        webflow: https://mcp.webflow.com/mcp (HTTP) - ! Needs authentication\n\
        figma: https://mcp.figma.com/mcp (HTTP) - \u{2714} Connected\n\
        playwright: npx @playwright/mcp@latest - \u{2717} Failed to connect\n";

    fn apps() -> Vec<App> {
        parse_list(LIST, &["Sanity".into(), "webflow".into(), "figma".into()])
    }

    #[test]
    fn reads_every_server_with_its_status_and_where_it_lives() {
        let apps = apps();
        let row = |name: &str| apps.iter().find(|a| a.name == name).unwrap().clone();
        assert_eq!(apps.len(), 5);
        assert_eq!(row("claude.ai Google Drive").source, Source::ClaudeAi);
        assert_eq!(row("claude.ai Google Drive").status, "connected");
        assert_eq!(row("Sanity").target, "https://mcp.sanity.io");
        assert_eq!(row("Sanity").source, Source::User);
        assert_eq!(row("webflow").status, "needs_auth");
        assert_eq!(row("playwright").status, "error");
        assert_eq!(row("playwright").target, "npx @playwright/mcp@latest");
        assert_eq!(row("playwright").source, Source::Other);
        assert!(parse_list(
            "No MCP servers configured. Use `claude mcp add` to add a server.",
            &[]
        )
        .is_empty());
    }

    #[test]
    fn a_suggestion_already_set_up_by_name_or_url_reads_as_added() {
        let mut connected = apps();
        connected.push(App {
            name: "my-linear".into(),
            target: "https://mcp.linear.app/mcp/".into(),
            status: "connected".into(),
            source: Source::User,
        });
        let s = suggestions(&connected);
        let added = |n: &str| s.iter().find(|x| x.server_name == n).unwrap().added;
        assert!(added("figma"));
        assert!(added("linear"));
        assert!(!added("notion"));
    }

    #[test]
    fn user_scope_is_read_from_the_top_level_servers_only() {
        let config = r#"{"mcpServers":{"figma":{"type":"http"}},"projects":{"/x":{"mcpServers":{"playwright":{}}}}}"#;
        assert_eq!(user_scope_names(config), vec!["figma".to_string()]);
        assert!(user_scope_names("not json").is_empty());
        assert!(user_scope_names("{}").is_empty());
    }

    #[test]
    fn the_curated_list_is_https_and_uniquely_named() {
        let mut names: Vec<_> = SUGGESTED.iter().map(|s| s.server_name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), SUGGESTED.len());
        assert!(SUGGESTED.iter().all(|s| s.url.starts_with("https://")));
    }
}
