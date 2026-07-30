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
use crate::utils::{create_command, get_extended_path, validate_project_path};
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
///
/// Uses the same thorough resolver as the rest of the app
/// (every NVM version's bin, `~/.<agent>/bin`, pnpm/volta/fnm dirs…) — the
/// narrower `find_executable` missed installs like `~/.codex/bin/codex`, so
/// the MCP modal said "Codex binary not found" while the Agents panel showed
/// it installed (issue #250). Candidates are validated with the agent's
/// version flag so a broken install (e.g. an npm package whose platform
/// vendor binary is missing on disk) is skipped instead of being invoked and
/// surfacing its internal ENOENT stack trace (issue #286).
fn find_agent_binary(
    agent: &crate::agent::AgentConfig,
) -> Result<std::path::PathBuf, CommandError> {
    crate::commands::claude::find_validated_binary(agent.binary_name, agent.version_flag)
        // Expected: "agent not installed" is an environment gap, not a bug.
        .ok_or_else(|| CommandError::expected(format!("{} binary not found", agent.display_name)))
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

    // Constrain the agent's working directory to a known project.
    let validated_cwd = match &project_path {
        Some(p) => Some(validate_project_path(p)?),
        None => None,
    };

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

    if let Some(ref path) = validated_cwd {
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
            .env("HOME", &home)
            .envs(crate::commands::accounts::get_env_vars_for_active_account());

        if agent.id == "claude-code" {
            get_cmd.env_remove("CLAUDECODE");
        }

        if let Some(ref path) = validated_cwd {
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

/// OpenCode's global config file (`~/.config/opencode/opencode.json` — the
/// path OpenCode documents on every platform).
fn opencode_config_path() -> Result<std::path::PathBuf, CommandError> {
    let home = dirs::home_dir()
        .ok_or_else(|| CommandError::from("Could not determine home directory".to_string()))?;
    Ok(home.join(".config").join("opencode").join("opencode.json"))
}

/// Load OpenCode's config for editing. A config that exists but isn't valid
/// JSON fails closed with an actionable message — never risk rewriting (and
/// destroying) another tool's configuration.
fn opencode_config_load() -> Result<(std::path::PathBuf, serde_json::Value), CommandError> {
    let path = opencode_config_path()?;
    let root = if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read OpenCode config {}: {e}", path.display()))?;
        serde_json::from_str(&raw).map_err(|e| {
            CommandError::expected(format!(
                "OpenCode's config ({}) isn't valid JSON, so Ship Studio won't edit it. Fix the file, then try again. (parse error: {e})",
                path.display()
            ))
        })?
    } else {
        serde_json::json!({ "$schema": "https://opencode.ai/config.json" })
    };
    Ok((path, root))
}

fn opencode_config_save(
    path: &std::path::Path,
    root: &serde_json::Value,
) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create OpenCode config directory: {e}"))?;
    }
    let serialized = serde_json::to_string_pretty(root)
        .map_err(|e| format!("Failed to serialize OpenCode config: {e}"))?;
    std::fs::write(path, serialized)
        .map_err(|e| format!("Failed to write OpenCode config {}: {e}", path.display()))?;
    Ok(())
}

/// Add (or overwrite — OpenCode adds are upserts by name) an MCP server in
/// OpenCode's config file. OpenCode's `opencode mcp add` is an interactive
/// wizard with no scriptable form, so shelling out just prints its usage
/// banner and fails (issue #308) — instead we merge the entry into its config
/// directly, the same way the preview bridge merges into Cursor's
/// `~/.cursor/mcp.json` (`register_cursor_mcp`).
///
/// Accepts the same shapes the modal/bridge already produce:
/// `<name> --url <url>` (remote server) or `<name> [--] <command...>` (local).
fn opencode_mcp_entry(args_str: &str) -> Result<(String, serde_json::Value), CommandError> {
    let tokens = shell_split(args_str);
    let Some((name, rest)) = tokens.split_first() else {
        return Err(("No arguments provided for mcp add".to_string()).into());
    };
    let entry = if rest.first().map(String::as_str) == Some("--url") {
        let Some(url) = rest.get(1) else {
            return Err(CommandError::expected(
                "mcp add: --url needs a value, e.g. `my-server --url https://example.com/mcp`",
            ));
        };
        serde_json::json!({ "type": "remote", "url": url, "enabled": true })
    } else {
        // Strip the optional `--` separator between the name and the command.
        let command = if rest.first().map(String::as_str) == Some("--") {
            &rest[1..]
        } else {
            rest
        };
        if command.is_empty() {
            return Err(CommandError::expected(
                "OpenCode MCP servers need a command or a --url, e.g. `my-server -- npx -y @some/mcp-server`",
            ));
        }
        serde_json::json!({ "type": "local", "command": command, "enabled": true })
    };
    Ok((name.clone(), entry))
}

fn add_opencode_mcp_server(args_str: &str) -> Result<(), CommandError> {
    let (name, entry) = opencode_mcp_entry(args_str)?;

    let (path, mut root) = opencode_config_load()?;
    let Some(root_obj) = root.as_object_mut() else {
        return Err(CommandError::expected(format!(
            "OpenCode's config ({}) doesn't have a JSON object at its root, so Ship Studio won't edit it.",
            path.display()
        )));
    };
    let servers = root_obj
        .entry("mcp")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers_obj) = servers.as_object_mut() else {
        return Err(CommandError::expected(format!(
            "OpenCode's config ({}) has a non-object `mcp` key, so Ship Studio won't edit it.",
            path.display()
        )));
    };
    servers_obj.insert(name.clone(), entry);
    opencode_config_save(&path, &root)?;
    tracing::info!(server = %name, "Added MCP server to OpenCode config");
    Ok(())
}

/// Remove an MCP server from OpenCode's config file (OpenCode has no
/// `mcp remove` subcommand). Already-absent entries are the goal state, not an
/// error — matching the CLI path's idempotent-remove semantics (issue #295).
fn remove_opencode_mcp_server(name: &str) -> Result<(), CommandError> {
    let path = opencode_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    let (path, mut root) = opencode_config_load()?;
    let removed = root
        .as_object_mut()
        .and_then(|o| o.get_mut("mcp"))
        .and_then(|m| m.as_object_mut())
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if removed {
        opencode_config_save(&path, &root)?;
        tracing::info!(server = %name, "Removed MCP server from OpenCode config");
    }
    Ok(())
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

    // OpenCode's `mcp add` is interactive-only — edit its config file instead
    // (issue #308). The binary lookup above still gates on OpenCode actually
    // being installed.
    if agent.id == "opencode" {
        return add_opencode_mcp_server(args_str);
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
        cmd.current_dir(validate_project_path(path)?);
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
        let message = format!("Failed to add MCP server: {details}");
        // "Already exists" is a benign race with a concurrent registration —
        // the goal state is reached; callers treat it accordingly (#292).
        if details.to_ascii_lowercase().contains("already exists") {
            return Err(CommandError::expected(message));
        }
        return Err(message.into());
    }

    Ok(())
}

/// Does this CLI error text mean "no server with that name exists"?
///
/// Wording varies by agent CLI and version: "No MCP server named x",
/// "No project-local MCP server found with name: x", "x not found",
/// "no such server". An allowlist of exact phrases kept missing variants
/// (issue #295), so match on the shape instead.
fn mcp_server_not_found(details: &str) -> bool {
    let lower = details.to_ascii_lowercase();
    lower.contains("not found")
        || lower.contains("no such")
        || (lower.contains("no ")
            && lower.contains("server")
            && (lower.contains("found") || lower.contains("named")))
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

    // OpenCode has no `mcp remove` subcommand — edit its config file instead
    // (issue #308).
    if agent.id == "opencode" {
        return remove_opencode_mcp_server(&name);
    }

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
        cmd.current_dir(validate_project_path(path)?);
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
        // Removing a server that's already gone is the goal state, not an
        // error — the preview bridge's remove-then-add cycle races manual
        // removes and re-registrations, and CLI wording for "not found"
        // varies by agent/version ("No MCP server named …", "No
        // project-local MCP server found with name: …"), so match broadly
        // (issues #248, #295).
        if mcp_server_not_found(&details) {
            tracing::info!(server = %name, "mcp remove: server already absent — treating as success");
            return Ok(());
        }
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
    fn opencode_entry_remote_url() {
        let (name, entry) =
            opencode_mcp_entry("shipstudio-preview --url http://127.0.0.1:4923/mcp/active")
                .unwrap();
        assert_eq!(name, "shipstudio-preview");
        assert_eq!(entry["type"], "remote");
        assert_eq!(entry["url"], "http://127.0.0.1:4923/mcp/active");
        assert_eq!(entry["enabled"], true);
    }

    #[test]
    fn opencode_entry_local_command_with_separator() {
        let (name, entry) = opencode_mcp_entry("my-server -- npx -y @some/mcp-server").unwrap();
        assert_eq!(name, "my-server");
        assert_eq!(entry["type"], "local");
        assert_eq!(
            entry["command"],
            serde_json::json!(["npx", "-y", "@some/mcp-server"])
        );
    }

    #[test]
    fn opencode_entry_local_command_without_separator() {
        let (_, entry) = opencode_mcp_entry("my-server npx -y pkg").unwrap();
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["command"], serde_json::json!(["npx", "-y", "pkg"]));
    }

    #[test]
    fn opencode_entry_rejects_bare_name_and_dangling_url() {
        assert!(opencode_mcp_entry("just-a-name").is_err());
        assert!(opencode_mcp_entry("just-a-name --url").is_err());
        assert!(opencode_mcp_entry("").is_err());
    }

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

    #[test]
    fn not_found_matches_known_cli_wordings() {
        // Claude Code
        assert!(mcp_server_not_found(
            "No MCP server named \"shipstudio-preview\" in local scope"
        ));
        // The #295 variant that slipped past the old exact-phrase check
        assert!(mcp_server_not_found(
            "No project-local MCP server found with name: shipstudio-preview"
        ));
        assert!(mcp_server_not_found("server 'x' not found"));
        assert!(mcp_server_not_found("no such server: x"));
    }

    #[test]
    fn not_found_rejects_real_failures() {
        assert!(!mcp_server_not_found(
            "MCP server shipstudio-preview already exists in local config"
        ));
        assert!(!mcp_server_not_found("permission denied writing config"));
        assert!(!mcp_server_not_found(""));
    }
}
