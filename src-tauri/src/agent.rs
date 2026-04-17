//! # Agent Configuration
//!
//! Defines the agent abstraction layer. All agent-specific values (binary names,
//! flags, auth indicators, etc.) are centralized here so the rest of the codebase
//! is agent-agnostic.
//!
//! Supports multiple agents (Claude Code, Codex). The default agent is persisted
//! in AppState and cached in-memory via a RwLock for fast access.

use std::sync::RwLock;

/// Configuration for an AI coding agent integrated with Ship Studio.
pub struct AgentConfig {
    /// Unique identifier (e.g., "claude-code")
    pub id: &'static str,
    /// Human-readable name (e.g., "Claude Code")
    pub display_name: &'static str,
    /// Binary name to search for in PATH (e.g., "claude")
    pub binary_name: &'static str,
    /// Process name for `pgrep`/`pkill` (e.g., "claude")
    pub process_name: &'static str,
    /// Flag to check version (e.g., "--version")
    pub version_flag: &'static str,
    /// Flags for non-interactive print mode (e.g., ["--print", "-p"])
    pub print_mode_flags: &'static [&'static str],
    /// Flag to skip permission prompts, if supported
    pub auto_accept_flag: Option<&'static str>,
    /// Args to trigger authentication (e.g., ["--print", "hello"])
    pub auth_trigger_args: &'static [&'static str],
    /// Config directory under home (e.g., ".claude")
    pub auth_config_dir: &'static str,
    /// Files/dirs whose existence indicates authentication (e.g., ["settings.json", "statsig", "projects"])
    pub auth_indicators: &'static [&'static str],
    /// Agent ID for the skills CLI `--agent` flag
    pub skills_agent_id: Option<&'static str>,
    /// Subdirectory name for skills within the config dir
    pub skills_dir_name: Option<&'static str>,
    /// Unix install command (piped to bash)
    pub install_command_unix: Option<&'static str>,
    /// Windows install message (manual download)
    pub install_message_windows: Option<&'static str>,
    /// Unix uninstall command (removes binary + associated files, leaves auth indicators alone)
    pub uninstall_command_unix: Option<&'static str>,
    /// Windows uninstall command or message
    pub uninstall_command_windows: Option<&'static str>,
    /// Setup item IDs: (binary_id, auth_id)
    pub setup_item_ids: (&'static str, &'static str),
    /// Setup display names: (binary_name, auth_name)
    pub setup_display_names: (&'static str, &'static str),
}

/// Claude Code agent configuration.
pub const CLAUDE_CODE: AgentConfig = AgentConfig {
    id: "claude-code",
    display_name: "Claude Code",
    binary_name: "claude",
    process_name: "claude",
    version_flag: "--version",
    print_mode_flags: &["--print", "-p"],
    auto_accept_flag: Some("--dangerously-skip-permissions"),
    auth_trigger_args: &["--print", "hello"],
    auth_config_dir: ".claude",
    auth_indicators: &["settings.json", "statsig", "projects"],
    skills_agent_id: Some("claude-code"),
    skills_dir_name: Some("skills"),
    install_command_unix: Some("curl -fsSL https://claude.ai/install.sh | bash"),
    install_message_windows: Some(
        "Please download Claude Code from https://claude.ai and run the installer.",
    ),
    uninstall_command_unix: Some(
        "rm -rf \"$HOME/.local/share/Claude\" \"$HOME/Library/Application Support/Claude/claude-code\" 2>/dev/null; rm -f \"$HOME/.local/bin/claude\" 2>/dev/null; npm uninstall -g @anthropic-ai/claude-code 2>/dev/null; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("npm uninstall -g @anthropic-ai/claude-code"),
    setup_item_ids: ("claude", "claude_auth"),
    setup_display_names: ("Claude Code", "Claude Account"),
};

/// Codex agent configuration.
pub const CODEX: AgentConfig = AgentConfig {
    id: "codex",
    display_name: "Codex",
    binary_name: "codex",
    process_name: "codex",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: Some("--yolo"),
    auth_trigger_args: &[],
    auth_config_dir: ".codex",
    auth_indicators: &["auth.json"],
    skills_agent_id: Some("codex"),
    skills_dir_name: Some("skills"),
    install_command_unix: Some("npm install -g @openai/codex"),
    install_message_windows: Some("Install Codex: npm install -g @openai/codex"),
    uninstall_command_unix: Some("npm uninstall -g @openai/codex"),
    uninstall_command_windows: Some("npm uninstall -g @openai/codex"),
    setup_item_ids: ("codex", "codex_auth"),
    setup_display_names: ("Codex", "Codex Account"),
};

/// Opencode agent configuration.
pub const OPENCODE: AgentConfig = AgentConfig {
    id: "opencode",
    display_name: "Opencode",
    binary_name: "opencode",
    process_name: "opencode",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &["auth", "login"],
    auth_config_dir: ".local/share/opencode",
    auth_indicators: &["auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://opencode.ai/install | bash"),
    install_message_windows: Some(
        "Please download Opencode from https://opencode.ai and run the installer.",
    ),
    uninstall_command_unix: Some(
        "rm -rf \"$HOME/.opencode\" \"$HOME/.local/share/opencode\" 2>/dev/null; rm -f \"$HOME/.local/bin/opencode\" 2>/dev/null; npm uninstall -g opencode-ai 2>/dev/null; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("npm uninstall -g opencode-ai"),
    setup_item_ids: ("opencode", "opencode_auth"),
    setup_display_names: ("Opencode", "Opencode Account"),
};

/// All available agent configurations.
pub const ALL_AGENTS: &[&AgentConfig] = &[&CLAUDE_CODE, &CODEX, &OPENCODE];

/// In-memory cache for the default agent ID. `None` means unset (falls back to Claude Code).
static DEFAULT_AGENT_ID: RwLock<Option<String>> = RwLock::new(None);

/// Initialize the default agent cache from persisted AppState (called on startup).
pub fn init_default_agent(agent_id: Option<&str>) {
    if let Ok(mut cache) = DEFAULT_AGENT_ID.write() {
        *cache = agent_id.map(|s| s.to_string());
    }
}

/// Update the in-memory default agent cache (called when user picks their agent).
pub fn set_default_agent_cached(agent_id: &str) {
    if let Ok(mut cache) = DEFAULT_AGENT_ID.write() {
        *cache = Some(agent_id.to_string());
    }
}

/// Returns the currently active agent configuration.
///
/// Reads from the in-memory cache. Falls back to `CLAUDE_CODE` if unset or unrecognized.
pub fn get_active_agent() -> &'static AgentConfig {
    if let Ok(cache) = DEFAULT_AGENT_ID.read() {
        if let Some(id) = cache.as_deref() {
            return get_agent_by_id(id);
        }
    }
    &CLAUDE_CODE
}

/// Look up an agent by its unique ID. Falls back to `CLAUDE_CODE` if unrecognized.
pub fn get_agent_by_id(id: &str) -> &'static AgentConfig {
    match id {
        "codex" => &CODEX,
        "opencode" => &OPENCODE,
        _ => &CLAUDE_CODE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_agent_by_id_claude_code() {
        let agent = get_agent_by_id("claude-code");
        assert_eq!(agent.id, "claude-code");
        assert_eq!(agent.display_name, "Claude Code");
    }

    #[test]
    fn get_agent_by_id_codex() {
        let agent = get_agent_by_id("codex");
        assert_eq!(agent.id, "codex");
        assert_eq!(agent.display_name, "Codex");
    }

    #[test]
    fn get_agent_by_id_unknown_falls_back_to_claude() {
        let agent = get_agent_by_id("unknown");
        assert_eq!(agent.id, "claude-code");
    }

    #[test]
    fn all_agents_has_length_3() {
        assert_eq!(ALL_AGENTS.len(), 3);
    }

    #[test]
    fn get_agent_by_id_opencode() {
        let agent = get_agent_by_id("opencode");
        assert_eq!(agent.id, "opencode");
        assert_eq!(agent.display_name, "Opencode");
    }

    #[test]
    fn opencode_setup_item_ids() {
        assert_eq!(OPENCODE.setup_item_ids, ("opencode", "opencode_auth"));
    }

    #[test]
    fn claude_code_setup_item_ids() {
        assert_eq!(CLAUDE_CODE.setup_item_ids, ("claude", "claude_auth"));
    }

    #[test]
    fn codex_setup_item_ids() {
        assert_eq!(CODEX.setup_item_ids, ("codex", "codex_auth"));
    }

    #[test]
    fn init_and_get_active_agent_round_trip() {
        // Default (None) -> Claude Code
        init_default_agent(None);
        let agent = get_active_agent();
        assert_eq!(agent.id, "claude-code");

        // Set to codex
        init_default_agent(Some("codex"));
        let agent = get_active_agent();
        assert_eq!(agent.id, "codex");

        // Reset
        init_default_agent(None);
    }

    #[test]
    fn set_default_agent_cached_updates_active_agent() {
        init_default_agent(None);
        set_default_agent_cached("codex");
        let agent = get_active_agent();
        assert_eq!(agent.id, "codex");

        // Reset
        init_default_agent(None);
    }
}
