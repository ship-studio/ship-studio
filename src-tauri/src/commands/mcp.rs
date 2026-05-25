//! MCP Server management command module.
//!
//! Provides commands for:
//! - Listing MCP servers configured for the active agent
//! - Adding new MCP servers via the agent's CLI
//! - Removing MCP servers via the agent's CLI
//!
//! Both Claude Code and Codex support MCP servers via their `mcp` subcommand:
//! - Claude: `claude mcp list`, `claude mcp add`, `claude mcp remove`
//! - Codex: `codex mcp list`, `codex mcp add`, `codex mcp remove`
use crate::errors::CommandError;
use crate::utils::{create_command, find_executable, get_extended_path};
use serde::Serialize;

/// Represents an MCP server configured for an agent.
#[derive(Debug, Serialize, Clone)]
pub struct McpServer {
    /// Server name (identifier)
    pub name: String,
    /// The command string (for stdio) or URL (for http/sse)
    pub command_or_url: String,
    /// Server status: "connected", "needs_auth", "error", "unknown"
    pub status: String,
    /// Configuration scope: "user", "project", "local"
    pub scope: String,
}

/// Strip ANSI escape codes from a string.
fn strip_ansi(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            while let Some(&next) = chars.peek() {
                chars.next();
                if next == 'm' {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Find the agent binary path.
fn find_agent_binary(agent: &crate::agent::AgentConfig) -> Result<std::path::PathBuf, String> {
    find_executable(agent.binary_name)
        .ok_or_else(|| format!("{} binary not found", agent.display_name))
}

/// Parse the output of `claude mcp list` which has the format:
///
/// ```text
/// Checking MCP server health...
///
/// example: npx mcp-remote https://mcp.example.com/mcp - ✓ Connected
/// Sanity: https://mcp.sanity.io (HTTP) - ! Needs authentication
/// ```
///
/// Each server line: `<name>: <command_or_url> [(<type>)] - <status_indicator> <status_text>`
fn parse_mcp_list_output(output: &str) -> Vec<McpServer> {
    let clean = strip_ansi(output);
    let mut servers = Vec::new();

    for line in clean.lines() {
        let line = line.trim();

        // Skip empty lines and non-server lines (e.g. "Checking MCP server health...")
        if line.is_empty() || !line.contains(": ") {
            continue;
        }

        // Split on first ": " to get name and the rest
        let Some(colon_pos) = line.find(": ") else {
            continue;
        };
        let name = line[..colon_pos].to_string();

        // Skip if name looks like a status/info line rather than a server name
        if name.contains(' ') || name.starts_with("Checking") || name.starts_with("No ") {
            continue;
        }

        let rest = &line[colon_pos + 2..];

        // Parse status from the " - " separator
        let (command_part, status) = if let Some(dash_pos) = rest.rfind(" - ") {
            let cmd = rest[..dash_pos].trim().to_string();
            let status_text = rest[dash_pos + 3..].trim().to_string();
            let status = parse_status_text(&status_text);
            (cmd, status)
        } else {
            (rest.trim().to_string(), "unknown".to_string())
        };

        // Strip trailing "(HTTP)" or "(SSE)" type annotations from the command
        let command_or_url = command_part
            .trim_end_matches("(HTTP)")
            .trim_end_matches("(SSE)")
            .trim_end_matches("(http)")
            .trim_end_matches("(sse)")
            .trim()
            .to_string();

        servers.push(McpServer {
            name,
            command_or_url,
            status,
            scope: "user".to_string(), // Default; enriched by mcp get below
        });
    }

    servers
}

/// Map status text from CLI output to a normalized status string.
fn parse_status_text(text: &str) -> String {
    let lower = text.to_lowercase();
    // Remove common unicode status indicators
    let lower = lower
        .replace(['\u{2713}', '\u{2714}', '!', '\u{2717}', '\u{2718}'], "") // ✘
        .trim()
        .to_string();

    if lower.contains("connected") {
        "connected".to_string()
    } else if lower.contains("auth") {
        "needs_auth".to_string()
    } else if lower.contains("error") || lower.contains("fail") {
        "error".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Parse the output of `<agent> mcp get <name>` for scope information.
/// Claude outputs key-value lines like:
/// ```text
///   Scope: User config (available in all your projects)
///   Status: ✓ Connected
/// ```
fn parse_scope_from_mcp_get(output: &str) -> String {
    let clean = strip_ansi(output);

    for line in clean.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("Scope:") {
            let val_lower = val.trim().to_lowercase();
            // "User config (available in all your projects)" -> user
            // "Project config" -> project
            // "Local config" -> local
            // Check the beginning of the scope value to avoid false matches
            // (e.g. "User config" contains "your projects" but is user scope)
            if val_lower.starts_with("project") {
                return "project".to_string();
            } else if val_lower.starts_with("local") {
                return "local".to_string();
            } else {
                return "user".to_string();
            }
        }
    }

    "user".to_string()
}

/// List all MCP servers configured for the given agent.
///
/// Strategy: Parse `<binary> mcp list` output which contains name, command/URL,
/// and status for each server. Then run `<binary> mcp get <name>` per server
/// to enrich with scope information.
#[tauri::command]
#[tracing::instrument(skip_all, fields(project = ?project_path, agent = ?agent_id))]
pub async fn list_mcp_servers(
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<Vec<McpServer>, CommandError> {
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);

    let binary = find_agent_binary(agent)?;
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    // Run `<binary> mcp list` — this returns name, command/URL, and status
    let mut list_cmd = create_command(&binary);
    list_cmd
        .args(["mcp", "list"])
        .env("PATH", get_extended_path())
        .env("HOME", &home);

    // For Claude Code, unset CLAUDECODE to avoid nested-session error
    if agent.id == "claude-code" {
        list_cmd.env_remove("CLAUDECODE");
    }

    if let Some(ref path) = project_path {
        list_cmd.current_dir(path);
    }

    let list_output = list_cmd
        .output()
        .map_err(|e| format!("Failed to run {} mcp list: {}", agent.display_name, e))?;

    let stdout = String::from_utf8_lossy(&list_output.stdout);

    if !list_output.status.success() {
        let stderr = String::from_utf8_lossy(&list_output.stderr);
        // If no servers, return empty list
        if stderr.contains("No MCP servers")
            || stderr.contains("no mcp")
            || stdout.trim().is_empty()
        {
            return Ok(Vec::new());
        }
        return Err((format!("{} mcp list failed: {}", agent.display_name, stderr)).into());
    }

    let mut servers = parse_mcp_list_output(&stdout);
    if servers.is_empty() {
        return Ok(Vec::new());
    }

    // Enrich each server with scope from `mcp get <name>`
    for server in &mut servers {
        let mut get_cmd = create_command(&binary);
        get_cmd
            .args(["mcp", "get", &server.name])
            .env("PATH", get_extended_path())
            .env("HOME", &home);

        if agent.id == "claude-code" {
            get_cmd.env_remove("CLAUDECODE");
        }

        if let Some(ref path) = project_path {
            get_cmd.current_dir(path);
        }

        if let Ok(output) = get_cmd.output() {
            if output.status.success() {
                let out = String::from_utf8_lossy(&output.stdout);
                server.scope = parse_scope_from_mcp_get(&out);
            }
        }
    }

    Ok(servers)
}

/// Add an MCP server using the agent's CLI.
///
/// The `raw_args` parameter contains the arguments after `mcp add`, e.g.:
/// "my-server -- npx -y @some/mcp-server"
///
/// For Claude Code, appends `-s <scope>` for the configuration scope.
#[tauri::command]
#[tracing::instrument(skip_all, fields(agent = ?agent_id))]
pub async fn add_mcp_server(
    raw_args: String,
    scope: Option<String>,
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);

    let binary = find_agent_binary(agent)?;
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    // Strip any leading binary name / "mcp add" prefix the user may have included
    let args_str = raw_args.trim();
    let args_str = args_str
        .strip_prefix(agent.binary_name)
        .map(|s| s.trim_start())
        .unwrap_or(args_str);
    let args_str = args_str
        .strip_prefix("mcp add")
        .map(|s| s.trim_start())
        .unwrap_or(args_str);

    if args_str.is_empty() {
        return Err(("No arguments provided for mcp add".to_string()).into());
    }

    // Build the command: <binary> mcp add <args>
    let mut cmd = create_command(&binary);
    cmd.arg("mcp")
        .arg("add")
        .env("PATH", get_extended_path())
        .env("HOME", &home);

    if agent.id == "claude-code" {
        cmd.env_remove("CLAUDECODE");
        // Add scope flag for Claude Code
        if let Some(ref s) = scope {
            cmd.args(["-s", s]);
        }
    }

    // Split the raw args respecting -- separator
    // We use shell-like splitting: split on whitespace but respect quotes
    let parsed_args = shell_split(args_str);
    cmd.args(&parsed_args);

    if let Some(ref path) = project_path {
        cmd.current_dir(path);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run {} mcp add: {}", agent.display_name, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err((format!("Failed to add MCP server: {details}")).into());
    }

    Ok(())
}

/// Remove an MCP server by name using the agent's CLI.
#[tauri::command]
#[tracing::instrument(skip_all, fields(agent = ?agent_id))]
pub async fn remove_mcp_server(
    name: String,
    scope: Option<String>,
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);

    let binary = find_agent_binary(agent)?;
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut cmd = create_command(&binary);
    cmd.args(["mcp", "remove"])
        .env("PATH", get_extended_path())
        .env("HOME", &home);

    if agent.id == "claude-code" {
        cmd.env_remove("CLAUDECODE");
        if let Some(ref s) = scope {
            cmd.args(["-s", s]);
        }
    }

    cmd.arg(&name);

    if let Some(ref path) = project_path {
        cmd.current_dir(path);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run {} mcp remove: {}", agent.display_name, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        return Err((format!("Failed to remove MCP server: {details}")).into());
    }

    Ok(())
}

/// Simple shell-like argument splitting.
/// Splits on whitespace but respects double and single quotes.
fn shell_split(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
            }
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
            }
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    args.push(current.clone());
                    current.clear();
                }
            }
            '\\' if in_double_quote => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        chars.next();
                        current.push(next);
                    } else {
                        current.push(c);
                    }
                } else {
                    current.push(c);
                }
            }
            _ => {
                current.push(c);
            }
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi() {
        let input = "\x1b[38;5;145mserver-name\x1b[0m";
        assert_eq!(strip_ansi(input), "server-name");
    }

    #[test]
    fn test_strip_ansi_no_codes() {
        let input = "plain text";
        assert_eq!(strip_ansi(input), "plain text");
    }

    #[test]
    fn test_parse_mcp_list_real_output() {
        let output = "Checking MCP server health...\n\nexample: npx mcp-remote https://mcp.example.com/mcp - \u{2713} Connected\nSanity: https://mcp.sanity.io (HTTP) - ! Needs authentication\n";
        let servers = parse_mcp_list_output(output);
        assert_eq!(servers.len(), 2);

        assert_eq!(servers[0].name, "example");
        assert_eq!(
            servers[0].command_or_url,
            "npx mcp-remote https://mcp.example.com/mcp"
        );
        assert_eq!(servers[0].status, "connected");

        assert_eq!(servers[1].name, "Sanity");
        assert_eq!(servers[1].command_or_url, "https://mcp.sanity.io");
        assert_eq!(servers[1].status, "needs_auth");
    }

    #[test]
    fn test_parse_mcp_list_empty() {
        let output = "Checking MCP server health...\n\n";
        let servers = parse_mcp_list_output(output);
        assert!(servers.is_empty());
    }

    #[test]
    fn test_parse_mcp_list_error_status() {
        let output = "myserver: npx some-server - \u{2717} Error connecting\n";
        let servers = parse_mcp_list_output(output);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].status, "error");
    }

    #[test]
    fn test_parse_status_text_connected() {
        assert_eq!(parse_status_text("\u{2713} Connected"), "connected");
        assert_eq!(parse_status_text("Connected"), "connected");
    }

    #[test]
    fn test_parse_status_text_needs_auth() {
        assert_eq!(parse_status_text("! Needs authentication"), "needs_auth");
    }

    #[test]
    fn test_parse_status_text_error() {
        assert_eq!(parse_status_text("\u{2717} Error connecting"), "error");
        assert_eq!(parse_status_text("Failed to connect"), "error");
    }

    #[test]
    fn test_parse_status_text_unknown() {
        assert_eq!(parse_status_text("something else"), "unknown");
    }

    #[test]
    fn test_parse_scope_from_mcp_get_user() {
        let output = "example:\n  Scope: User config (available in all your projects)\n  Status: \u{2713} Connected\n";
        assert_eq!(parse_scope_from_mcp_get(output), "user");
    }

    #[test]
    fn test_parse_scope_from_mcp_get_project() {
        let output = "myserver:\n  Scope: Project config\n  Status: \u{2713} Connected\n";
        assert_eq!(parse_scope_from_mcp_get(output), "project");
    }

    #[test]
    fn test_parse_scope_from_mcp_get_local() {
        let output = "myserver:\n  Scope: Local config\n";
        assert_eq!(parse_scope_from_mcp_get(output), "local");
    }

    #[test]
    fn test_shell_split_simple() {
        let args = shell_split("my-server -- npx -y @some/package");
        assert_eq!(args, vec!["my-server", "--", "npx", "-y", "@some/package"]);
    }

    #[test]
    fn test_shell_split_quoted() {
        let args = shell_split(r#"my-server -- npx "hello world""#);
        assert_eq!(args, vec!["my-server", "--", "npx", "hello world"]);
    }

    #[test]
    fn test_shell_split_single_quoted() {
        let args = shell_split("my-server -- npx 'hello world'");
        assert_eq!(args, vec!["my-server", "--", "npx", "hello world"]);
    }

    #[test]
    fn test_shell_split_empty() {
        let args = shell_split("");
        assert!(args.is_empty());
    }

    #[test]
    fn test_shell_split_extra_whitespace() {
        let args = shell_split("  my-server   --   npx  ");
        assert_eq!(args, vec!["my-server", "--", "npx"]);
    }
}
