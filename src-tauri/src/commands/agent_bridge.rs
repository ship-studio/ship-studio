//! Commands for the agent preview bridge (the global loopback MCP server that
//! lets the workspace agent read the preview's console/network/DOM, interact
//! with the page, navigate it, and take screenshots). The server itself lives
//! in `crate::agent_bridge` and starts at app launch.

use crate::agent_bridge;
use crate::errors::CommandError;
use crate::utils::validate_project_path;

/// The MCP URL to register for this project (starts the global bridge if it
/// isn't running yet). The project path rides inside the URL so the server
/// can route tool calls to whichever window has the project open.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_agent_bridge_url(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<String, CommandError> {
    let validated = validate_project_path(&project_path)?;
    let canonical = validated.to_string_lossy().to_string();
    agent_bridge::agent_bridge_url_for_project(app, &canonical)
        .await
        .map_err(CommandError::from)
}

/// The "active project" MCP URL for agents with global configs (Codex,
/// Opencode, Cursor): tool calls resolve to the focused project at call time.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_agent_bridge_active_url(app: tauri::AppHandle) -> Result<String, CommandError> {
    agent_bridge::agent_bridge_active_url(app)
        .await
        .map_err(CommandError::from)
}

/// Register the bridge in Cursor's MCP config. Cursor's CLI has no `mcp add`
/// subcommand — its config is `~/.cursor/mcp.json` — so we merge our entry
/// in directly, preserving everything else. Returns false (without touching
/// anything) when Cursor isn't in use or its config can't be parsed: never
/// risk destroying another tool's configuration.
#[tauri::command]
#[tracing::instrument]
pub async fn register_cursor_mcp(url: String) -> Result<bool, CommandError> {
    let Some(home) = dirs::home_dir() else {
        return Err(("Could not determine home directory".to_string()).into());
    };
    let cursor_dir = home.join(".cursor");
    if !cursor_dir.is_dir() {
        // Cursor has never run on this machine — don't create its config.
        return Ok(false);
    }
    let path = cursor_dir.join("mcp.json");
    let mut root: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read Cursor mcp.json: {e}"))?;
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Cursor mcp.json is not valid JSON — leaving it untouched: {e}");
                return Ok(false);
            }
        }
    } else {
        serde_json::json!({})
    };
    let Some(root_obj) = root.as_object_mut() else {
        tracing::warn!("Cursor mcp.json root is not an object — leaving it untouched");
        return Ok(false);
    };
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers_obj) = servers.as_object_mut() else {
        tracing::warn!("Cursor mcp.json mcpServers is not an object — leaving it untouched");
        return Ok(false);
    };
    let already_current = servers_obj
        .get("shipstudio-preview")
        .and_then(|s| s.get("url"))
        .and_then(|u| u.as_str())
        == Some(url.as_str());
    if !already_current {
        servers_obj.insert(
            "shipstudio-preview".to_string(),
            serde_json::json!({ "url": url }),
        );
        let serialized = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("Failed to serialize Cursor mcp.json: {e}"))?;
        std::fs::write(&path, serialized)
            .map_err(|e| format!("Failed to write Cursor mcp.json: {e}"))?;
        tracing::info!("Registered shipstudio-preview in Cursor's mcp.json");
    }
    Ok(true)
}

/// Mark this project's preview bridge listener as attached (mounted and
/// answering) or detached. Detached projects fail tool calls fast with an
/// honest "preview isn't active" message instead of a long timeout.
#[tauri::command]
#[tracing::instrument]
pub async fn agent_bridge_attach(project_path: String, attached: bool) -> Result<(), CommandError> {
    let validated = validate_project_path(&project_path)?;
    let canonical = validated.to_string_lossy().to_string();
    agent_bridge::set_project_attached(&canonical, attached);
    Ok(())
}

/// Answer an in-flight bridge tool call. `result` must be a full MCP
/// CallToolResult ({ content: [...], isError? }) — it is passed through to
/// the agent verbatim.
#[tauri::command]
#[tracing::instrument(skip(result))]
pub async fn agent_bridge_respond(
    request_id: u64,
    result: serde_json::Value,
) -> Result<(), CommandError> {
    if !agent_bridge::resolve_bridge_request(request_id, result) {
        // Not an error worth failing on: the call likely timed out server-side
        // moments before the frontend answered.
        tracing::warn!(
            "[AgentBridge] Response for request {} arrived after timeout (dropped)",
            request_id
        );
    }
    Ok(())
}
