//! # Client Agent Commands
//!
//! Manages the Node.js sidecar process that runs the deepagents-based
//! Client AI agent. Communicates over stdio using JSON-RPC 2.0.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

use crate::utils::get_extended_path;

// ============ Registry ============

/// Tracks a running sidecar instance.
struct SidecarEntry {
    child: Child,
}

/// Global registry of sidecar instances keyed by window label.
static SIDECAR_REGISTRY: LazyLock<Mutex<HashMap<String, SidecarEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// JSON-RPC request counter for unique IDs.
static RPC_ID_COUNTER: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));

fn next_rpc_id() -> u64 {
    let mut counter = RPC_ID_COUNTER.lock().unwrap();
    *counter += 1;
    *counter
}

// ============ JSON-RPC Types ============

#[derive(Serialize)]
struct RpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: serde_json::Value,
}

#[derive(Deserialize, Debug)]
struct RpcMessage {
    #[allow(dead_code)]
    jsonrpc: String,
    /// Present for responses, absent for notifications (used by JSON-RPC spec)
    #[allow(dead_code)]
    id: Option<u64>,
    /// Present for notifications and requests
    method: Option<String>,
    /// Present for successful responses
    result: Option<serde_json::Value>,
    /// Present for error responses
    error: Option<RpcError>,
    /// Present for notifications
    params: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug, Serialize, Clone)]
struct RpcError {
    code: i32,
    message: String,
    data: Option<serde_json::Value>,
}

// ============ Event Payloads ============

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClientAgentEvent {
    /// Event type: "stream/token", "stream/toolStart", "stream/toolEnd",
    /// "stream/done", "stream/error", "stream/planUpdate", "ready",
    /// "response", "error"
    event_type: String,
    /// Event-specific data
    data: serde_json::Value,
}

// ============ Sidecar Path ============

/// Locate the sidecar entry point. In development, it's in the project tree.
/// In production, it's bundled in the app resources.
fn find_sidecar_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Try development path first (relative to project root).
    // This MUST come before the resource directory check because Tauri copies
    // sidecar/dist/* into the resource dir, but NOT node_modules. The dev path
    // sits next to sidecar/node_modules so ESM resolution works correctly.
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("sidecar")
        .join("dist")
        .join("index.js");

    if dev_path.exists() {
        return Ok(dev_path);
    }

    // Fall back to resource directory (production bundle)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_path = resource_dir.join("sidecar").join("index.js");
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    Err("Sidecar not found. Run 'npm run build' in the sidecar directory.".to_string())
}

/// Find the node binary path.
fn find_node_binary() -> Result<String, String> {
    which::which("node")
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| "Node.js not found. Ensure it's installed and in your PATH.".to_string())
}

// ============ Stdout Reader ============

/// Spawn a background thread that reads the sidecar's stdout and emits events.
fn spawn_stdout_reader(
    app: tauri::AppHandle,
    window_label: String,
    stdout: std::process::ChildStdout,
) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    tracing::warn!("Sidecar stdout read error: {}", e);
                    break;
                }
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Parse the JSON-RPC message
            let msg: RpcMessage = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("Invalid JSON from sidecar: {} (line: {})", e, trimmed);
                    continue;
                }
            };

            // Determine event type
            let (event_type, data) = if let Some(method) = &msg.method {
                // Notification (stream events, ready, etc.)
                (
                    method.clone(),
                    msg.params.unwrap_or(serde_json::Value::Null),
                )
            } else if msg.error.is_some() {
                // Error response
                let err = msg.error.unwrap();
                (
                    "error".to_string(),
                    serde_json::to_value(&err).unwrap_or(serde_json::Value::Null),
                )
            } else {
                // Success response
                (
                    "response".to_string(),
                    msg.result.unwrap_or(serde_json::Value::Null),
                )
            };

            let payload = ClientAgentEvent { event_type, data };

            if let Err(e) = app.emit_to(&window_label, "client-agent-event", &payload) {
                tracing::warn!("Failed to emit client-agent-event: {}", e);
            }
        }

        tracing::info!("Sidecar stdout reader finished for window {}", window_label);

        // Emit exit event
        let exit_payload = ClientAgentEvent {
            event_type: "exit".to_string(),
            data: serde_json::Value::Null,
        };
        let _ = app.emit_to(&window_label, "client-agent-event", &exit_payload);
    });
}

/// Send a JSON-RPC request to the sidecar's stdin.
fn send_rpc(child: &mut Child, method: &str, params: serde_json::Value) -> Result<u64, String> {
    let id = next_rpc_id();
    let request = RpcRequest {
        jsonrpc: "2.0",
        id,
        method: method.to_string(),
        params,
    };

    let serialized =
        serde_json::to_string(&request).map_err(|e| format!("Failed to serialize RPC: {}", e))?;

    let stdin = child.stdin.as_mut().ok_or("Sidecar stdin not available")?;

    writeln!(stdin, "{}", serialized).map_err(|e| format!("Failed to write to sidecar: {}", e))?;

    stdin
        .flush()
        .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;

    Ok(id)
}

// ============ Tauri Commands ============

/// Start the Client agent sidecar for a specific window.
#[tauri::command]
pub async fn start_client_agent(
    app: tauri::AppHandle,
    window_label: String,
    project_path: String,
    api_key: String,
    model: String,
    hitl_enabled: Option<bool>,
    spending_limit: Option<f64>,
) -> Result<(), String> {
    // Stop any existing sidecar for this window
    stop_client_agent_internal(&window_label);

    let node_path = find_node_binary()?;
    let sidecar_path = find_sidecar_path(&app)?;
    let extended_path = get_extended_path();

    tracing::info!(
        "Starting client agent sidecar for window {} (model: {}, project: {}, hitl: {:?})",
        window_label,
        model,
        project_path,
        hitl_enabled
    );

    // Spawn the Node.js sidecar
    let mut child = Command::new(&node_path)
        .arg(sidecar_path.to_string_lossy().as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", &extended_path)
        .env(
            "HOME",
            dirs::home_dir()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Take stdout and start the reader thread
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture sidecar stdout")?;

    spawn_stdout_reader(app.clone(), window_label.clone(), stdout);

    // Also spawn a stderr reader for debug logging
    if let Some(stderr) = child.stderr.take() {
        let wl = window_label.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    tracing::info!("[sidecar:{}] {}", wl, l);
                }
            }
        });
    }

    // Send initialize RPC with all settings
    let init_params = serde_json::json!({
        "apiKey": api_key,
        "model": model,
        "projectPath": project_path,
        "hitlEnabled": hitl_enabled.unwrap_or(false),
        "spendingLimit": spending_limit,
    });

    send_rpc(&mut child, "initialize", init_params)?;

    // Register in the global registry
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    registry.insert(window_label.clone(), SidecarEntry { child });

    Ok(())
}

/// Stop the Client agent sidecar for a specific window.
#[tauri::command]
pub fn stop_client_agent(window_label: String) -> Result<(), String> {
    stop_client_agent_internal(&window_label);
    Ok(())
}

fn stop_client_agent_internal(window_label: &str) {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    if let Some(mut entry) = registry.remove(window_label) {
        tracing::info!("Stopping client agent sidecar for window {}", window_label);

        // Try graceful shutdown via stdin close
        drop(entry.child.stdin.take());

        // Wait briefly, then force kill if needed
        match entry.child.try_wait() {
            Ok(Some(_)) => {
                tracing::debug!("Sidecar exited gracefully");
            }
            _ => {
                if let Err(e) = entry.child.kill() {
                    tracing::warn!("Failed to kill sidecar: {}", e);
                }
                let _ = entry.child.wait();
            }
        }
    }
}

/// Send a chat message to the Client agent.
#[tauri::command]
pub fn send_chat_message(window_label: String, message: String) -> Result<(), String> {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    let entry = registry
        .get_mut(&window_label)
        .ok_or("Client agent not running for this window")?;

    let params = serde_json::json!({ "message": message });
    send_rpc(&mut entry.child, "chat", params)?;
    Ok(())
}

/// Cancel the current generation.
#[tauri::command]
pub fn cancel_generation(window_label: String) -> Result<(), String> {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    let entry = registry
        .get_mut(&window_label)
        .ok_or("Client agent not running for this window")?;

    send_rpc(&mut entry.child, "cancel", serde_json::json!({}))?;
    Ok(())
}

/// Clear the chat history.
#[tauri::command]
pub fn clear_chat_history(window_label: String) -> Result<(), String> {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    let entry = registry
        .get_mut(&window_label)
        .ok_or("Client agent not running for this window")?;

    send_rpc(&mut entry.child, "clearHistory", serde_json::json!({}))?;
    Ok(())
}

/// Change the LLM model mid-session.
#[tauri::command]
pub fn set_client_model(window_label: String, model: String) -> Result<(), String> {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    let entry = registry
        .get_mut(&window_label)
        .ok_or("Client agent not running for this window")?;

    let params = serde_json::json!({ "model": model });
    send_rpc(&mut entry.child, "setModel", params)?;
    Ok(())
}

/// Resume after a HITL interrupt (approve or reject the pending tool call).
#[tauri::command]
pub fn resume_generation(window_label: String, approved: bool) -> Result<(), String> {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    let entry = registry
        .get_mut(&window_label)
        .ok_or("Client agent not running for this window")?;

    let params = serde_json::json!({ "approved": approved });
    send_rpc(&mut entry.child, "resume", params)?;
    Ok(())
}

/// Kill all sidecar processes for a specific window (called on window close).
pub fn kill_window_sidecars_sync(window_label: &str) -> usize {
    let mut registry = SIDECAR_REGISTRY.lock().unwrap();
    if let Some(mut entry) = registry.remove(window_label) {
        drop(entry.child.stdin.take());
        let _ = entry.child.kill();
        let _ = entry.child.wait();
        1
    } else {
        0
    }
}
