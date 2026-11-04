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
    /// Args that print sign-in status (e.g. ["status"]), for agents whose
    /// credential lives outside the filesystem (system keychain) so the
    /// `auth_indicators` file check is unreliable. `None` → use file indicators.
    pub auth_status_args: Option<&'static [&'static str]>,
    /// Substring in `auth_status_args` output that means "signed in"
    /// (e.g. "Logged in as"). Only consulted when `auth_status_args` is set.
    pub auth_status_ready_substr: Option<&'static str>,
    /// Args that sign the agent out via the CLI (e.g. ["logout"]). Set for
    /// agents whose token isn't a file we can delete. `None` → remove the
    /// `auth_indicators` files instead.
    pub logout_args: Option<&'static [&'static str]>,
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
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
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
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Opencode agent configuration.
pub const OPENCODE: AgentConfig = AgentConfig {
    id: "opencode",
    display_name: "Opencode",
    binary_name: "opencode",
    process_name: "opencode",
    version_flag: "--version",
    // `opencode run` is its non-interactive mode; with no positional message
    // it reads the prompt from stdin (verified on 1.18.9 — issue #862).
    print_mode_flags: &["run"],
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
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Cursor CLI (`cursor-agent`) agent configuration.
///
/// Unlike the others, Cursor stores its credential in the system keychain (the
/// only file it writes under `~/.cursor` is UI state), and it respects only
/// `HOME` — there is no config-dir env var to redirect per workspace. So Cursor
/// uses a single global login (auth detected via `cursor-agent status`, signed
/// out via `cursor-agent logout`) rather than the per-workspace file isolation
/// the other agents get.
pub const CURSOR: AgentConfig = AgentConfig {
    id: "cursor",
    display_name: "Cursor",
    binary_name: "cursor-agent",
    process_name: "cursor-agent",
    version_flag: "--version",
    print_mode_flags: &["-p", "--print"],
    auto_accept_flag: Some("--force"),
    auth_trigger_args: &["login"],
    auth_config_dir: ".cursor",
    // Auth is keychain-based; detection goes through `auth_status_args` below.
    auth_indicators: &[],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl https://cursor.com/install -fsS | bash"),
    install_message_windows: Some("irm 'https://cursor.com/install?win32=true' | iex"),
    uninstall_command_unix: Some(
        "rm -f \"$HOME/.local/bin/cursor-agent\" \"$HOME/.local/bin/agent\" 2>/dev/null; rm -rf \"$HOME/.local/share/cursor-agent\" 2>/dev/null; echo Uninstalled.",
    ),
    // Runs via `cmd /C`. The Windows installer (`?win32=true`) mirrors the Unix
    // layout under %USERPROFILE%\.local. `2>nul` + a trailing `echo` keep it
    // exit-0 even if the paths are absent, so a missing install won't error.
    uninstall_command_windows: Some(
        "del /q \"%USERPROFILE%\\.local\\bin\\cursor-agent.exe\" \"%USERPROFILE%\\.local\\bin\\agent.exe\" 2>nul & rmdir /s /q \"%USERPROFILE%\\.local\\share\\cursor-agent\" 2>nul & echo Uninstalled.",
    ),
    setup_item_ids: ("cursor", "cursor_auth"),
    setup_display_names: ("Cursor", "Cursor Account"),
    auth_status_args: Some(&["status"]),
    auth_status_ready_substr: Some("Logged in as"),
    logout_args: Some(&["logout"]),
};

/// GitHub Copilot CLI agent configuration.
pub const COPILOT: AgentConfig = AgentConfig {
    id: "copilot",
    display_name: "GitHub Copilot",
    binary_name: "copilot",
    process_name: "copilot",
    version_flag: "--version",
    print_mode_flags: &["-p", "--prompt"],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".copilot",
    auth_indicators: &["otel"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://gh.io/copilot-install | bash"),
    install_message_windows: Some("winget install GitHub.Copilot"),
    uninstall_command_unix: Some("npm uninstall -g @github/copilot 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("echo Please uninstall GitHub Copilot manually."),
    setup_item_ids: ("copilot", "copilot_auth"),
    setup_display_names: ("GitHub Copilot", "GitHub Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Pi agent configuration.
pub const PI: AgentConfig = AgentConfig {
    id: "pi",
    display_name: "Pi",
    binary_name: "pi",
    process_name: "pi",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".pi",
    auth_indicators: &["agent/auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://pi.dev/install.sh | sh"),
    install_message_windows: Some("curl -fsSL https://pi.dev/install.sh | sh"),
    uninstall_command_unix: Some(
        "npm uninstall -g @earendil-works/pi-coding-agent 2>/dev/null; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("echo Please uninstall Pi manually."),
    setup_item_ids: ("pi", "pi_auth"),
    setup_display_names: ("Pi", "Pi Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Hermes Agent configuration.
pub const HERMES: AgentConfig = AgentConfig {
    id: "hermes",
    display_name: "Hermes",
    binary_name: "hermes",
    process_name: "hermes",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".hermes",
    auth_indicators: &["auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some(
        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    ),
    install_message_windows: Some(
        "Please download Hermes from https://hermes-agent.nousresearch.com and run the installer.",
    ),
    uninstall_command_unix: Some("rm -rf \"$HOME/.hermes\" 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("echo Please uninstall Hermes manually from Control Panel."),
    setup_item_ids: ("hermes", "hermes_auth"),
    setup_display_names: ("Hermes", "Hermes Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Devin CLI agent configuration.
pub const DEVIN: AgentConfig = AgentConfig {
    id: "devin",
    display_name: "Devin",
    binary_name: "devin",
    process_name: "devin",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".local/share/devin",
    auth_indicators: &["cli/sessions.db"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://cli.devin.ai/install.sh | bash"),
    install_message_windows: Some("Please download Devin CLI from https://devin.ai and run the installer."),
    uninstall_command_unix: Some("rm -rf \"$HOME/.local/share/devin\" \"$HOME/.config/devin\" 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("echo Please uninstall Devin manually."),
    setup_item_ids: ("devin", "devin_auth"),
    setup_display_names: ("Devin", "Devin Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Grok Build agent configuration.
pub const GROK: AgentConfig = AgentConfig {
    id: "grok",
    display_name: "Grok",
    binary_name: "grok",
    process_name: "grok",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".grok",
    auth_indicators: &["auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://x.ai/cli/install.sh | bash"),
    install_message_windows: Some("npm install -g @xai-official/grok"),
    uninstall_command_unix: Some("rm -rf \"$HOME/.grok\" && echo \"Uninstalled.\""),
    uninstall_command_windows: Some("npm uninstall -g @xai-official/grok"),
    setup_item_ids: ("grok", "grok_auth"),
    setup_display_names: ("Grok", "Grok Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Kimi Code agent configuration.
pub const KIMI_CODE: AgentConfig = AgentConfig {
    id: "kimi-code",
    display_name: "Kimi Code",
    binary_name: "kimi",
    process_name: "kimi",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".kimi-code",
    auth_indicators: &["config.toml"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"),
    install_message_windows: Some(
        "Please download Kimi Code from https://code.kimi.com and run the installer.",
    ),
    uninstall_command_unix: Some(
        "rm -rf \"$HOME/.kimi-code\" \"$HOME/.kimi\" 2>/dev/null; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("echo Please uninstall Kimi Code manually."),
    setup_item_ids: ("kimi-code", "kimi-code_auth"),
    setup_display_names: ("Kimi Code", "Kimi Code Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Antigravity CLI agent configuration.
pub const ANTIGRAVITY_CLI: AgentConfig = AgentConfig {
    id: "antigravity-cli",
    display_name: "Antigravity",
    binary_name: "agy",
    process_name: "agy",
    version_flag: "--version",
    print_mode_flags: &["-p", "--print"],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".gemini/antigravity-cli",
    auth_indicators: &["settings.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
    install_message_windows: Some(
        "Please download Antigravity CLI from https://antigravity.google and run the installer.",
    ),
    uninstall_command_unix: Some(
        "rm -rf \"$HOME/.gemini/antigravity-cli\" 2>/dev/null; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("echo Please uninstall Antigravity CLI manually."),
    setup_item_ids: ("antigravity-cli", "antigravity-cli_auth"),
    setup_display_names: ("Antigravity", "Antigravity Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Jcode agent configuration.
pub const JCODE: AgentConfig = AgentConfig {
    id: "jcode",
    display_name: "Jcode",
    binary_name: "jcode",
    process_name: "jcode",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".jcode",
    auth_indicators: &["auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://jcode.sh/install | bash"),
    install_message_windows: Some(
        "Please download Jcode from https://jcode.sh and run the installer.",
    ),
    uninstall_command_unix: Some("rm -rf \"$HOME/.jcode\" 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("echo Please uninstall Jcode manually."),
    setup_item_ids: ("jcode", "jcode_auth"),
    setup_display_names: ("Jcode", "Jcode Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Droid (Factory) agent configuration.
pub const DROID: AgentConfig = AgentConfig {
    id: "droid",
    display_name: "Droid",
    binary_name: "droid",
    process_name: "droid",
    version_flag: "--version",
    print_mode_flags: &[],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".factory",
    auth_indicators: &["auth.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://app.factory.ai/cli | sh"),
    install_message_windows: Some("npm install -g droid"),
    uninstall_command_unix: Some("npm uninstall -g droid 2>/dev/null; rm -rf \"$HOME/.factory\" 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("npm uninstall -g droid"),
    setup_item_ids: ("droid", "droid_auth"),
    setup_display_names: ("Droid", "Droid Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Amp (AmpCode) agent configuration.
pub const AMP: AgentConfig = AgentConfig {
    id: "amp",
    display_name: "Amp",
    binary_name: "amp",
    process_name: "amp",
    version_flag: "--version",
    print_mode_flags: &["-x"],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".config/amp",
    auth_indicators: &["settings.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://ampcode.com/install.sh | bash"),
    install_message_windows: Some("npm install -g @anthropic-ai/claude-code 2>/dev/null; npm install -g @ampcode/cli"),
    uninstall_command_unix: Some("npm uninstall -g @ampcode/cli 2>/dev/null; rm -rf \"$HOME/.config/amp\" \"$HOME/.local/share/amp\" 2>/dev/null; echo Uninstalled."),
    uninstall_command_windows: Some("npm uninstall -g @ampcode/cli"),
    setup_item_ids: ("amp", "amp_auth"),
    setup_display_names: ("Amp", "Amp Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// Qwen Code agent configuration.
pub const QWEN: AgentConfig = AgentConfig {
    id: "qwen",
    display_name: "Qwen",
    binary_name: "qwen",
    process_name: "qwen",
    version_flag: "--version",
    print_mode_flags: &["-p"],
    auto_accept_flag: None,
    auth_trigger_args: &[],
    auth_config_dir: ".qwen",
    auth_indicators: &["settings.json"],
    skills_agent_id: None,
    skills_dir_name: None,
    install_command_unix: Some("curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash"),
    install_message_windows: Some("curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash"),
    uninstall_command_unix: Some(
        "if [ -x \"$HOME/.qwen/bin/qwen-uninstall\" ]; then \"$HOME/.qwen/bin/qwen-uninstall\"; else npm uninstall -g @qwen-code/qwen-code 2>/dev/null; fi; echo Uninstalled.",
    ),
    uninstall_command_windows: Some("npm uninstall -g @qwen-code/qwen-code"),
    setup_item_ids: ("qwen", "qwen_auth"),
    setup_display_names: ("Qwen", "Qwen Account"),
    auth_status_args: None,
    auth_status_ready_substr: None,
    logout_args: None,
};

/// All available agent configurations.
pub const ALL_AGENTS: &[&AgentConfig] = &[
    &CLAUDE_CODE,
    &CODEX,
    &OPENCODE,
    &CURSOR,
    &COPILOT,
    &PI,
    &HERMES,
    &DEVIN,
    &GROK,
    &KIMI_CODE,
    &ANTIGRAVITY_CLI,
    &JCODE,
    &DROID,
    &AMP,
    &QWEN,
];

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
        "cursor" => &CURSOR,
        "copilot" => &COPILOT,
        "pi" => &PI,
        "hermes" => &HERMES,
        "devin" => &DEVIN,
        "grok" => &GROK,
        "kimi-code" => &KIMI_CODE,
        "antigravity-cli" => &ANTIGRAVITY_CLI,
        "jcode" => &JCODE,
        "droid" => &DROID,
        "amp" => &AMP,
        "qwen" => &QWEN,
        _ => &CLAUDE_CODE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize the tests that mutate `DEFAULT_AGENT_ID` so parallel runs
    // don't clobber each other (the RwLock is a process singleton).
    static SINGLETON_GUARD: Mutex<()> = Mutex::new(());

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
    fn all_agents_has_length_15() {
        assert_eq!(ALL_AGENTS.len(), 15);
    }

    #[test]
    fn get_agent_by_id_opencode() {
        let agent = get_agent_by_id("opencode");
        assert_eq!(agent.id, "opencode");
        assert_eq!(agent.display_name, "Opencode");
    }

    #[test]
    fn get_agent_by_id_cursor() {
        let agent = get_agent_by_id("cursor");
        assert_eq!(agent.id, "cursor");
        assert_eq!(agent.display_name, "Cursor");
        assert_eq!(agent.binary_name, "cursor-agent");
    }

    #[test]
    fn cursor_uses_command_based_auth() {
        // Cursor's token is in the keychain, so it must declare a status command
        // and a logout command rather than relying on file indicators.
        assert!(CURSOR.auth_status_args.is_some());
        assert!(CURSOR.auth_status_ready_substr.is_some());
        assert!(CURSOR.logout_args.is_some());
        assert!(CURSOR.auth_indicators.is_empty());
    }

    #[test]
    fn file_based_agents_have_no_status_command() {
        // The keychain path must stay opt-in: the file-indicator agents must not
        // accidentally declare a status command (which would change detection).
        for agent in [
            &CLAUDE_CODE,
            &CODEX,
            &OPENCODE,
            &COPILOT,
            &PI,
            &HERMES,
            &DEVIN,
            &GROK,
            &KIMI_CODE,
            &ANTIGRAVITY_CLI,
            &JCODE,
            &DROID,
            &AMP,
            &QWEN,
        ] {
            assert!(
                agent.auth_status_args.is_none(),
                "{} should use file-based auth",
                agent.id
            );
            assert!(agent.logout_args.is_none());
        }
    }

    #[test]
    fn opencode_setup_item_ids() {
        assert_eq!(OPENCODE.setup_item_ids, ("opencode", "opencode_auth"));
    }

    #[test]
    fn opencode_auth_indicator_matches_cli_credentials_path() {
        // Verified against the CLI itself (issue #47): `opencode auth list`
        // prints "Credentials ~/.local/share/opencode/auth.json". If detection
        // ever shows "Not signed in" after a successful login, re-verify with
        // that command before touching these values.
        assert_eq!(OPENCODE.auth_config_dir, ".local/share/opencode");
        assert_eq!(OPENCODE.auth_indicators, &["auth.json"]);
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
    fn get_agent_by_id_pi() {
        let agent = get_agent_by_id("pi");
        assert_eq!(agent.id, "pi");
        assert_eq!(agent.display_name, "Pi");
    }

    #[test]
    fn get_agent_by_id_hermes() {
        let agent = get_agent_by_id("hermes");
        assert_eq!(agent.id, "hermes");
        assert_eq!(agent.display_name, "Hermes");
    }

    #[test]
    fn get_agent_by_id_devin() {
        let agent = get_agent_by_id("devin");
        assert_eq!(agent.id, "devin");
        assert_eq!(agent.display_name, "Devin");
    }

    #[test]
    fn get_agent_by_id_grok() {
        let agent = get_agent_by_id("grok");
        assert_eq!(agent.id, "grok");
        assert_eq!(agent.display_name, "Grok");
    }

    #[test]
    fn get_agent_by_id_kimi_code() {
        let agent = get_agent_by_id("kimi-code");
        assert_eq!(agent.id, "kimi-code");
        assert_eq!(agent.display_name, "Kimi Code");
    }

    #[test]
    fn get_agent_by_id_antigravity_cli() {
        let agent = get_agent_by_id("antigravity-cli");
        assert_eq!(agent.id, "antigravity-cli");
        assert_eq!(agent.display_name, "Antigravity");
    }

    #[test]
    fn get_agent_by_id_jcode() {
        let agent = get_agent_by_id("jcode");
        assert_eq!(agent.id, "jcode");
        assert_eq!(agent.display_name, "Jcode");
    }

    #[test]
    fn get_agent_by_id_droid() {
        let agent = get_agent_by_id("droid");
        assert_eq!(agent.id, "droid");
        assert_eq!(agent.display_name, "Droid");
    }

    #[test]
    fn get_agent_by_id_amp() {
        let agent = get_agent_by_id("amp");
        assert_eq!(agent.id, "amp");
        assert_eq!(agent.display_name, "Amp");
    }

    #[test]
    fn get_agent_by_id_qwen() {
        let agent = get_agent_by_id("qwen");
        assert_eq!(agent.id, "qwen");
        assert_eq!(agent.display_name, "Qwen");
    }

    #[test]
    fn get_agent_by_id_copilot() {
        let agent = get_agent_by_id("copilot");
        assert_eq!(agent.id, "copilot");
        assert_eq!(agent.display_name, "GitHub Copilot");
        assert_eq!(agent.binary_name, "copilot");
    }

    #[test]
    fn init_and_get_active_agent_round_trip() {
        let _guard = SINGLETON_GUARD.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = SINGLETON_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        init_default_agent(None);
        set_default_agent_cached("codex");
        let agent = get_active_agent();
        assert_eq!(agent.id, "codex");

        // Reset
        init_default_agent(None);
    }
}
