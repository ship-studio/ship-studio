//! # Discord Rich Presence Commands
//!
//! Provides Discord Rich Presence integration showing project status, current editing file,
//! coding language icon (large_image), and Ship Studio logo (small_image) matching vscord specs.

use crate::commands::setup::{read_app_state, write_app_state};
use crate::errors::CommandError;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing;

const DISCORD_CLIENT_ID: &str = "1532357218673103101";
const DEFAULT_TITLE: &str = "🚢'in with Ship Studio";
const SMALL_IMAGE_KEY: &str = "ship_studio_full_noshadow";
const SMALL_IMAGE_TEXT: &str = "Ship Studio";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPresencePayload {
    /// Custom details line (defaults to "🚢'in with Ship Studio")
    pub details: Option<String>,
    /// State line (e.g. "Editing App.tsx" or "Working on my-project")
    pub state: Option<String>,
    /// File path or filename being edited
    pub filename: Option<String>,
    /// Active project name
    pub project_name: Option<String>,
    /// Custom override for coding language key (large_image)
    pub language_key: Option<String>,
    /// Custom override for coding language display name
    pub language_name: Option<String>,
    /// Start timestamp (Unix milliseconds or seconds)
    pub start_timestamp: Option<u64>,
    /// Whether user is actively editing code (true) or browsing (false)
    pub is_editing: Option<bool>,
}

enum DiscordCommand {
    Update(DiscordPresencePayload),
    Clear,
    SetEnabled(bool),
}

static DISCORD_TX: OnceLock<mpsc::UnboundedSender<DiscordCommand>> = OnceLock::new();

fn get_discord_tx() -> &'static mpsc::UnboundedSender<DiscordCommand> {
    DISCORD_TX.get_or_init(|| {
        let (tx, rx) = mpsc::unbounded_channel();
        tauri::async_runtime::spawn(discord_presence_loop(rx));
        tx
    })
}

/// Map file name / extension to Discord RPC language key and display name.
pub fn map_language_from_filename(filename: &str) -> (&'static str, &'static str) {
    let clean_name = filename.split(&['/', '\\'][..]).last().unwrap_or(filename);
    let lower = clean_name.to_lowercase();

    if lower == "dockerfile" || lower.ends_with(".dockerfile") {
        return ("docker", "Docker");
    }
    if lower == ".gitignore" || lower == ".gitattributes" || lower == ".gitmodules" {
        return ("git", "Git");
    }
    if lower == ".env" || lower.starts_with(".env.") {
        return ("env", "Environment Config");
    }

    let ext = lower.split('.').last().unwrap_or("");
    match ext {
        "ts" => ("typescript", "TypeScript"),
        "tsx" => ("react_ts", "TypeScript React"),
        "js" | "mjs" | "cjs" => ("javascript", "JavaScript"),
        "jsx" => ("react_js", "JavaScript React"),
        "rs" => ("rust", "Rust"),
        "py" | "pyw" => ("python", "Python"),
        "html" | "htm" => ("html", "HTML"),
        "css" => ("css", "CSS"),
        "scss" | "sass" => ("scss", "SCSS"),
        "less" => ("less", "LESS"),
        "json" | "jsonc" => ("json", "JSON"),
        "toml" => ("toml", "TOML"),
        "xml" => ("xml", "XML"),
        "md" | "mdx" => ("markdown", "Markdown"),
        "go" => ("go", "Go"),
        "c" | "h" => ("c", "C"),
        "cpp" | "cc" | "cxx" | "hpp" => ("cpp", "C++"),
        "cs" => ("csharp", "C#"),
        "php" => ("php", "PHP"),
        "vue" => ("vue", "Vue"),
        "svelte" => ("svelte", "Svelte"),
        "astro" => ("astro", "Astro"),
        "java" => ("java", "Java"),
        "kt" | "kts" => ("kotlin", "Kotlin"),
        "swift" => ("swift", "Swift"),
        "rb" => ("ruby", "Ruby"),
        "sh" | "bash" | "zsh" | "ps1" => ("shell", "Shell Script"),
        "sql" => ("sql", "SQL"),
        "yaml" | "yml" => ("yaml", "YAML"),
        "graphql" | "gql" => ("graphql", "GraphQL"),
        "gitignore" | "gitattributes" => ("git", "Git"),
        "lua" => ("lua", "Lua"),
        "dart" => ("dart", "Dart"),
        "zig" => ("zig", "Zig"),
        "ex" | "exs" => ("elixir", "Elixir"),
        "prisma" => ("prisma", "Prisma"),
        "txt" | "log" => ("text", "Text Document"),
        _ => ("code", "Code"),
    }
}

/// Helper enum for cross-platform stream handling
enum DiscordStream {
    #[cfg(windows)]
    Windows(tokio::net::windows::named_pipe::NamedPipeClient),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
}

impl DiscordStream {
    async fn send_packet(&mut self, opcode: u32, payload: &str) -> std::io::Result<()> {
        let len = payload.len() as u32;
        let mut header = [0u8; 8];
        header[0..4].copy_from_slice(&opcode.to_le_bytes());
        header[4..8].copy_from_slice(&len.to_le_bytes());

        match self {
            #[cfg(windows)]
            DiscordStream::Windows(stream) => {
                stream.write_all(&header).await?;
                stream.write_all(payload.as_bytes()).await?;
                stream.flush().await?;
            }
            #[cfg(unix)]
            DiscordStream::Unix(stream) => {
                stream.write_all(&header).await?;
                stream.write_all(payload.as_bytes()).await?;
                stream.flush().await?;
            }
        }
        Ok(())
    }

    async fn read_packet(&mut self) -> std::io::Result<(u32, String)> {
        let mut header = [0u8; 8];
        match self {
            #[cfg(windows)]
            DiscordStream::Windows(stream) => {
                stream.read_exact(&mut header).await?;
                let opcode = u32::from_le_bytes(header[0..4].try_into().unwrap());
                let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
                let mut buf = vec![0u8; len];
                stream.read_exact(&mut buf).await?;
                Ok((opcode, String::from_utf8_lossy(&buf).to_string()))
            }
            #[cfg(unix)]
            DiscordStream::Unix(stream) => {
                stream.read_exact(&mut header).await?;
                let opcode = u32::from_le_bytes(header[0..4].try_into().unwrap());
                let len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
                let mut buf = vec![0u8; len];
                stream.read_exact(&mut buf).await?;
                Ok((opcode, String::from_utf8_lossy(&buf).to_string()))
            }
        }
    }
}

async fn try_connect_discord() -> Option<DiscordStream> {
    #[cfg(windows)]
    {
        for i in 0..10 {
            let pipe_name = format!(r"\\.\pipe\discord-ipc-{}", i);
            if let Ok(client) =
                tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe_name)
            {
                return Some(DiscordStream::Windows(client));
            }
        }
    }

    #[cfg(unix)]
    {
        let dirs = [
            std::env::var("XDG_RUNTIME_DIR").ok(),
            std::env::var("TMPDIR").ok(),
            Some("/tmp".to_string()),
            Some("/tmp/app/com.discordapp.Discord".to_string()),
        ];

        for dir in dirs.into_iter().flatten() {
            for i in 0..10 {
                let path = format!("{}/discord-ipc-{}", dir, i);
                if let Ok(stream) = tokio::net::UnixStream::connect(&path).await {
                    return Some(DiscordStream::Unix(stream));
                }
            }
        }
    }

    None
}

async fn discord_presence_loop(mut rx: mpsc::UnboundedReceiver<DiscordCommand>) {
    let mut stream_opt: Option<DiscordStream> = None;
    let mut is_enabled = read_app_state().discord_presence_enabled.unwrap_or(true);
    let mut last_payload: Option<DiscordPresencePayload> = None;

    while let Some(cmd) = rx.recv().await {
        match cmd {
            DiscordCommand::SetEnabled(enabled) => {
                is_enabled = enabled;
                if !enabled {
                    if let Some(ref mut stream) = stream_opt {
                        let nonce = uuid::Uuid::new_v4().to_string();
                        let clear_json = serde_json::json!({
                            "cmd": "SET_ACTIVITY",
                            "args": {
                                "pid": std::process::id(),
                                "activity": null
                            },
                            "nonce": nonce
                        });
                        let _ = stream.send_packet(1, &clear_json.to_string()).await;
                    }
                    stream_opt = None;
                } else if let Some(payload) = last_payload.clone() {
                    let _ = send_activity_to_discord(&mut stream_opt, &payload).await;
                }
            }
            DiscordCommand::Clear => {
                last_payload = None;
                if let Some(ref mut stream) = stream_opt {
                    let nonce = uuid::Uuid::new_v4().to_string();
                    let clear_json = serde_json::json!({
                        "cmd": "SET_ACTIVITY",
                        "args": {
                            "pid": std::process::id(),
                            "activity": null
                        },
                        "nonce": nonce
                    });
                    let _ = stream.send_packet(1, &clear_json.to_string()).await;
                }
            }
            DiscordCommand::Update(payload) => {
                last_payload = Some(payload.clone());
                if is_enabled {
                    let _ = send_activity_to_discord(&mut stream_opt, &payload).await;
                }
            }
        }
    }
}

async fn send_activity_to_discord(
    stream_opt: &mut Option<DiscordStream>,
    payload: &DiscordPresencePayload,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if stream_opt.is_none() {
        if let Some(mut stream) = try_connect_discord().await {
            let handshake = serde_json::json!({
                "v": 1,
                "client_id": DISCORD_CLIENT_ID
            });
            if stream.send_packet(0, &handshake.to_string()).await.is_ok() {
                if let Ok((_op, _res)) = stream.read_packet().await {
                    *stream_opt = Some(stream);
                }
            }
        }
    }

    let stream = match stream_opt {
        Some(s) => s,
        None => return Ok(()),
    };

    let details_str = payload
        .details
        .clone()
        .unwrap_or_else(|| DEFAULT_TITLE.to_string());

    let is_editing = payload.is_editing.unwrap_or(false);
    let filename_ref = payload.filename.as_deref().unwrap_or("");

    let (assets_val, default_state) = if is_editing && !filename_ref.is_empty() {
        let (detected_key, detected_name) = map_language_from_filename(filename_ref);
        let lang_key = payload.language_key.as_deref().unwrap_or(detected_key);
        let lang_name = payload.language_name.as_deref().unwrap_or(detected_name);

        let state = if let Some(ref proj) = payload.project_name {
            format!("In {}: {}", proj, filename_ref)
        } else {
            format!("Editing {}", filename_ref)
        };

        (
            serde_json::json!({
                "large_image": lang_key,
                "large_text": lang_name,
                "small_image": SMALL_IMAGE_KEY,
                "small_text": SMALL_IMAGE_TEXT
            }),
            state,
        )
    } else {
        let state = if let Some(ref proj) = payload.project_name {
            format!("Working on {}", proj)
        } else {
            "In Dashboard".to_string()
        };

        (
            serde_json::json!({
                "large_image": SMALL_IMAGE_KEY,
                "large_text": SMALL_IMAGE_TEXT
            }),
            state,
        )
    };

    let state_str = payload.state.clone().unwrap_or(default_state);

    let start_ts = payload
        .start_timestamp
        .unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);

    let nonce = uuid::Uuid::new_v4().to_string();
    let activity_json = serde_json::json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": {
                "details": details_str,
                "state": state_str,
                "timestamps": {
                    "start": start_ts
                },
                "assets": assets_val,
                "buttons": [
                    {
                        "label": "Ship Studio",
                        "url": "https://github.com/ship-studio/ship-studio"
                    }
                ]
            }
        },
        "nonce": nonce
    });

    if let Err(e) = stream.send_packet(1, &activity_json.to_string()).await {
        tracing::warn!("Failed to send Discord RPC activity packet: {}", e);
        *stream_opt = None; // Reset stream to attempt reconnect next time
    }

    Ok(())
}

/// Get whether Discord Rich Presence is enabled. Defaults to true.
#[tauri::command]
#[tracing::instrument]
pub fn get_discord_presence_enabled() -> Result<bool, CommandError> {
    let state = read_app_state();
    Ok(state.discord_presence_enabled.unwrap_or(true))
}

/// Set whether Discord Rich Presence is enabled (persisted to app state).
#[tauri::command]
#[tracing::instrument]
pub fn set_discord_presence_enabled(enabled: bool) -> Result<(), CommandError> {
    let mut state = read_app_state();
    state.discord_presence_enabled = Some(enabled);
    write_app_state(&state).map_err(CommandError::from)?;
    let _ = get_discord_tx().send(DiscordCommand::SetEnabled(enabled));
    Ok(())
}

/// Update the active Discord Rich Presence.
#[tauri::command]
#[tracing::instrument]
pub fn update_discord_presence(payload: DiscordPresencePayload) -> Result<(), CommandError> {
    let _ = get_discord_tx().send(DiscordCommand::Update(payload));
    Ok(())
}

/// Clear active Discord Rich Presence.
#[tauri::command]
#[tracing::instrument]
pub fn clear_discord_presence() -> Result<(), CommandError> {
    let _ = get_discord_tx().send(DiscordCommand::Clear);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_map_language_from_filename() {
        assert_eq!(
            map_language_from_filename("index.ts"),
            ("typescript", "TypeScript")
        );
        assert_eq!(
            map_language_from_filename("App.tsx"),
            ("react_ts", "TypeScript React")
        );
        assert_eq!(map_language_from_filename("main.rs"), ("rust", "Rust"));
        assert_eq!(
            map_language_from_filename("script.py"),
            ("python", "Python")
        );
        assert_eq!(map_language_from_filename("index.html"), ("html", "HTML"));
        assert_eq!(map_language_from_filename("styles.css"), ("css", "CSS"));
        assert_eq!(map_language_from_filename("package.json"), ("json", "JSON"));
        assert_eq!(
            map_language_from_filename("README.md"),
            ("markdown", "Markdown")
        );
        assert_eq!(map_language_from_filename("server.go"), ("go", "Go"));
        assert_eq!(
            map_language_from_filename("Dockerfile"),
            ("docker", "Docker")
        );
        assert_eq!(map_language_from_filename(".gitignore"), ("git", "Git"));
        assert_eq!(
            map_language_from_filename(".env"),
            ("env", "Environment Config")
        );
        assert_eq!(map_language_from_filename("Cargo.toml"), ("toml", "TOML"));
        assert_eq!(map_language_from_filename("unknown.xyz"), ("code", "Code"));
    }
}
