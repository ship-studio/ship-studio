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
        // The same config-parse / gateway / policy conditions that break add
        // and remove break listing too (issue #755).
        return Err(classify_mcp_failure("list MCP servers", &stderr));
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
        .map_err(|e| {
            // EACCES here is machine state (config dir owned by root after a
            // sudo install, etc.), not an app bug — give the fix, skip
            // telemetry (issue #471).
            if e.raw_os_error() == Some(13) || e.kind() == std::io::ErrorKind::PermissionDenied {
                crate::errors::CommandError::expected(format!(
                    "Ship Studio can't write OpenCode's config at {} — permission denied. The                      folder is likely owned by another user (often from a sudo install). In a                      terminal, run: sudo chown -R $(whoami) ~/.config/opencode — then try again.",
                    path.display()
                ))
            } else {
                crate::errors::CommandError::from(format!(
                    "Failed to write OpenCode config {}: {e}",
                    path.display()
                ))
            }
        })?;
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
        return Err(classify_mcp_failure("add MCP server", &details));
    }

    Ok(())
}

/// Turn a failed `<agent> mcp …` invocation's output into a `CommandError`,
/// classifying the shapes that reflect machine state, org policy or the
/// user's own agent config — not a Ship Studio bug — as `Expected` so they
/// stay out of telemetry.
///
/// Shared by the add, remove and list paths: the add path has classified
/// these since #675/#677 while remove and list forwarded the very same CLI
/// failures raw (issues #746, #755, #800). `action` completes "Failed to …"
/// ("add MCP server", "remove MCP server", "list MCP servers").
fn classify_mcp_failure(action: &str, details: &str) -> CommandError {
    let message = format!("Failed to {action}: {details}");
    let lower = details.to_ascii_lowercase();

    // "Already exists" is a benign race with a concurrent registration —
    // the goal state is reached; callers treat it accordingly (#292).
    if lower.contains("already exists") {
        return CommandError::expected(message);
    }

    // Claude Code's enterprise-managed settings can refuse servers that
    // aren't on the org's MCP allowlist ("Cannot add MCP server \"x\": not
    // allowed by enterprise policy" / "…explicitly blocked by enterprise
    // policy" / "…enterprise MCP configuration is active"). An org policy
    // decision, not an app bug (issue #675).
    if lower.contains("enterprise policy") || lower.contains("enterprise mcp configuration") {
        return CommandError::expected(format!(
            "{message}\n\nYour organization's managed agent settings block this MCP server. Ask your admin to allowlist it, then try again."
        ));
    }

    // Enterprise Claude Code installs route through an org-managed "Cloud
    // gateway"; when it's unreachable or the session with it has expired the
    // CLI refuses to run at all ("Couldn't load settings from Cloud gateway
    // <host>. Check your network connection, or run `claude auth login` to
    // re-authenticate."). An org network/session condition on the user's
    // machine, not an app bug (issues #799, #800).
    if lower.contains("cloud gateway")
        || (lower.contains("couldn't load settings") && lower.contains("auth login"))
    {
        return CommandError::expected(format!(
            "{message}\n\nYour organization's agent gateway couldn't be reached. Check your network (or VPN) connection, or run `claude auth login` in a terminal to sign in again, then try again."
        ));
    }

    // The CLI rejected an `-e` environment variable. Usually a typo in the
    // user's own entry (a missing `=`, a stray quote), but recent Claude Code
    // versions also mis-parse valid `-e KEY=value` pairs and echo a stray
    // token back (anthropics/claude-code#23365). Either way the app can't fix
    // it from here, so state the format requirement first and offer the known
    // CLI bug as a possibility rather than asserting it (issue #763).
    if lower.contains("invalid environment variable format") {
        return CommandError::expected(format!(
            "{message}\n\nEnvironment variables must be entered as `KEY=value`, one per line, with no surrounding quotes — check the entries for a missing `=` or a stray character. If they already look right, recent Claude Code CLI versions have a known `mcp add` parsing bug (anthropics/claude-code#23365): add the server without its `-e` variables for now (set them in the server's own config instead), or update Claude Code."
        ));
    }

    // The agent CLI parses its entire config file before running any `mcp`
    // subcommand, so a single value the installed version no longer accepts
    // (e.g. `service_tier = "default"` in ~/.codex/config.toml) breaks add,
    // remove and list alike. The user's own config, not our call (issue #755).
    if lower.contains("failed to load configuration")
        || (lower.contains("unknown variant") && lower.contains("config.toml"))
    {
        let setting = invalid_config_key(details)
            .map(|key| format!(" (`{key}`)"))
            .unwrap_or_default();
        return CommandError::expected(format!(
            "{message}\n\nThe agent CLI couldn't read its own config file — a setting in it{setting} has a value this version no longer accepts. Fix or remove that setting in the config file named above, then try again."
        ));
    }

    // The agent CLI failed to write its own config file because the OS
    // denied access — Windows "Access is denied. (os error 5)" (e.g. Codex
    // persisting ~/.codex/config.toml) or POSIX EACCES/"Permission denied".
    // Machine state: file read-only, locked by antivirus/OneDrive sync, or
    // a config dir owned by another account — mirroring the EACCES handling
    // in `opencode_config_save` (issues #471, #677).
    let os_denied = lower.contains("access is denied")
        || lower.contains("(os error 5)")
        || lower.contains("permission denied")
        || lower.contains("eacces");
    let config_write = lower.contains("config")
        || lower.contains("failed to write mcp servers")
        || lower.contains(".codex")
        || lower.contains(".claude");
    if os_denied && config_write {
        return CommandError::expected(format!(
            "{message}\n\nThe agent couldn't write its own config file — the OS denied access. Check that the file isn't read-only or locked by another program (antivirus, OneDrive/cloud sync), and that its folder is owned by your user account, then try again."
        ));
    }

    message.into()
}

/// Pull the offending setting's name out of a Codex config-parse error,
/// whose final line is `in \`service_tier\`` (issue #755). Without that shape
/// the guidance simply omits the name rather than guessing one.
fn invalid_config_key(details: &str) -> Option<String> {
    details.lines().rev().find_map(|line| {
        let key = line.trim().strip_prefix("in `")?.strip_suffix('`')?;
        if key.is_empty() {
            None
        } else {
            Some(key.to_string())
        }
    })
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
        // A non-zero exit with nothing on either stream used to surface as
        // "Failed to remove MCP server: " — an empty string with no signal
        // for the user or for telemetry. Keep the exit code instead (#710).
        if details.trim().is_empty() {
            return Err(CommandError::Process {
                cmd: format!("{} mcp remove", agent.binary_name),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: String::new(),
            });
        }
        // Everything the add path already classifies — enterprise policy,
        // config read/write failures, gateway auth — fails the same way here
        // (issues #746, #755, #800).
        return Err(classify_mcp_failure("remove MCP server", &details));
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

    #[test]
    fn add_failure_already_exists_is_expected() {
        let err = classify_mcp_failure(
            "add MCP server",
            "MCP server shipstudio-preview already exists in local config",
        );
        assert!(matches!(err, CommandError::Expected { .. }));
    }

    #[test]
    fn add_failure_enterprise_policy_is_expected() {
        // Exact wording from issue #675.
        let err = classify_mcp_failure(
            "add MCP server",
            "Cannot add MCP server \"shipstudio-preview\": not allowed by enterprise policy",
        );
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("Failed to add MCP server"));
                assert!(message.contains("Ask your admin"));
            }
            other => panic!("expected Expected, got {other:?}"),
        }
        // Wording variants of the same policy denial.
        assert!(matches!(
            classify_mcp_failure(
                "add MCP server",
                "MCP server \"x\" is explicitly blocked by enterprise policy"
            ),
            CommandError::Expected { .. }
        ));
        assert!(matches!(
            classify_mcp_failure(
                "add MCP server",
                "Cannot modify MCP servers: enterprise MCP configuration is active"
            ),
            CommandError::Expected { .. }
        ));
    }

    #[test]
    fn add_failure_windows_config_access_denied_is_expected() {
        // Exact shape from issue #677 (Codex CLI on Windows).
        let err = classify_mcp_failure("add MCP server", "Error: failed to write MCP servers to C:\\Users\\me\\.codex\n\nCaused by:\n    0: failed to persist config at C:\\Users\\me\\.codex\\config.toml\n    1: Access is denied. (os error 5)",
        );
        match err {
            CommandError::Expected { message } => {
                assert!(message.contains("denied access"));
                assert!(message.contains("read-only"));
            }
            other => panic!("expected Expected, got {other:?}"),
        }
        // POSIX flavor of the same machine state.
        assert!(matches!(
            classify_mcp_failure("add MCP server", "failed to persist config at /Users/me/.codex/config.toml: Permission denied (os error 13)"
            ),
            CommandError::Expected { .. }
        ));
    }

    #[test]
    fn add_failure_generic_stays_reportable() {
        // Unrecognized failures must remain `Other` so telemetry still sees
        // genuine bugs.
        assert!(matches!(
            classify_mcp_failure("add MCP server", "unexpected argument '--transport'"),
            CommandError::Other { .. }
        ));
        // Access-denied wording without any config-write context isn't the
        // #677 shape — don't over-classify.
        assert!(matches!(
            classify_mcp_failure("add MCP server", "Access is denied."),
            CommandError::Other { .. }
        ));
    }

    #[test]
    fn cloud_gateway_failure_is_expected_on_every_action() {
        // Exact wording from issues #799 (add) and #800 (remove).
        let details = "Couldn't load settings from Cloud gateway https://claude-gateway.internal.example.com. Check your network connection, or run `claude auth login` to re-authenticate.";
        for action in ["add MCP server", "remove MCP server", "list MCP servers"] {
            match classify_mcp_failure(action, details) {
                CommandError::Expected { message } => {
                    assert!(message.contains(&format!("Failed to {action}")));
                    assert!(message.contains("claude auth login"));
                }
                other => panic!("expected Expected for {action}, got {other:?}"),
            }
        }
    }

    #[test]
    fn config_parse_failure_is_expected_and_names_the_setting() {
        // Exact shape from issue #755 (Codex CLI, Windows).
        let details = "Error: failed to load configuration\n\nCaused by:\n    0: C:\\Users\\me\\.codex\\config.toml:3:16: unknown variant `default`, expected `fast` or `flex`\n    1: unknown variant `default`, expected `fast` or `flex`\n       in `service_tier`";
        // The same broken config breaks list and remove too — the CLI parses
        // it before running any `mcp` subcommand.
        for action in ["add MCP server", "remove MCP server", "list MCP servers"] {
            match classify_mcp_failure(action, details) {
                CommandError::Expected { message } => {
                    assert!(message.contains("`service_tier`"));
                    assert!(message.contains("config file"));
                }
                other => panic!("expected Expected for {action}, got {other:?}"),
            }
        }
        // Without the trailing `in \`key\`` line the guidance just omits the
        // name instead of guessing one.
        assert!(matches!(
            classify_mcp_failure("add MCP server", "Error: failed to load configuration"),
            CommandError::Expected { .. }
        ));
        assert_eq!(invalid_config_key(details).as_deref(), Some("service_tier"));
        assert_eq!(invalid_config_key("no key here"), None);
    }

    #[test]
    fn invalid_env_var_format_is_expected() {
        // Nothing Ship Studio can fix, either way — but the same refusal fires
        // for a genuine typo in the user's own entry, so the message must lead
        // with the format requirement and offer the known upstream CLI bug
        // (issue #763, anthropics/claude-code#23365) as a possibility rather
        // than asserting it.
        match classify_mcp_failure(
            "add MCP server",
            "Invalid environment variable format: \\, environment variables should be added as: -e KEY1=value1 -e KEY2=value2",
        ) {
            CommandError::Expected { message } => {
                assert!(message.contains("KEY=value"), "got: {message}");
                assert!(message.contains("anthropics/claude-code#23365"));
                // Not asserted as the cause.
                assert!(
                    !message.contains("This is a known bug"),
                    "must not blame the CLI outright, got: {message}"
                );
            }
            other => panic!("expected Expected, got {other:?}"),
        }
    }
}
