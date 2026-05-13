//! # Shared Types
//!
//! This module contains all shared structs and types used across the Ship Studio backend.

use serde::{Deserialize, Serialize};

// ============ Project Type ============

/// Detected project type based on config files and directory structure
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectType {
    Nextjs,
    Sveltekit,
    Astro,
    Nuxt,
    /// Vite-based project (React, Vue, etc. without a meta-framework)
    Vite,
    /// Plain HTML/CSS/JS project (no framework, no package.json required)
    Statichtml,
    /// Has package.json but isn't a recognized web framework (Tauri, CLI tools, etc.)
    Generic,
    Unknown,
}

// ============ Prerequisites ============

/// Result of checking if a prerequisite tool is installed
#[derive(Serialize)]
pub struct PrerequisiteCheck {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
}

// ============ Project Management ============

/// Project metadata returned by list_projects
#[derive(Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    /// Asset protocol URL to thumbnail image, if it exists
    pub thumbnail: Option<String>,
    /// Unix timestamp (ms) when project was last opened
    pub last_opened: Option<u64>,
}

/// Enhanced project info for dashboard display
#[derive(Serialize)]
pub struct DashboardProject {
    pub name: String,
    pub path: String,
    pub thumbnail: Option<String>,
    pub last_opened: Option<u64>,
    /// Current git branch name
    pub git_branch: Option<String>,
    /// Number of uncommitted changes (staged + unstaged)
    pub uncommitted_count: Option<u32>,
    /// Whether to run Claude in auto-accept mode
    pub auto_accept_mode: Option<bool>,
    /// Whether to hide the main branch warning banner
    pub hide_main_branch_warning: Option<bool>,
    /// Whether this project is an external (non-~/ShipStudio) project
    pub is_external: bool,
    /// Active monorepo workspace subpath (e.g. `apps/admin`), or None for
    /// single-package projects. Surfaced on the dashboard card so the user
    /// can tell two imports of the same repo apart.
    pub workspace_subpath: Option<String>,
}

/// Next.js page route information
#[derive(Serialize)]
pub struct PageInfo {
    /// URL route (e.g., "/about", "/blog/[slug]")
    pub route: String,
    /// Path to the page file
    pub file_path: String,
}

// ============ Project Metadata (Publish State Persistence) ============

/// Record of a single publish event (staging or production)
#[derive(Serialize, Deserialize, Clone)]
pub struct PublishRecord {
    pub url: String,
    pub state: String,
    #[serde(rename = "publishedAt")]
    pub published_at: u64,
}

/// Publish metadata for staging and production
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PublishMetadata {
    pub staging: Option<PublishRecord>,
    pub production: Option<PublishRecord>,
}

/// Information about stashed changes from a branch switch
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct StashInfo {
    /// The branch that was active when changes were stashed
    pub from_branch: String,
    /// Unix timestamp (ms) when the stash was created
    pub stashed_at: u64,
}

/// A backup entry representing a git commit
#[derive(Serialize, Deserialize, Clone)]
pub struct Backup {
    /// Git commit hash (short form)
    pub hash: String,
    /// Full commit hash
    pub full_hash: String,
    /// Commit message
    pub message: String,
    /// Unix timestamp (seconds) when the commit was made
    pub timestamp: i64,
    /// Relative time string (e.g., "2 hours ago")
    pub relative_time: String,
}

/// Result of restoring a backup
#[derive(Serialize, Deserialize, Clone)]
pub struct RestoreResult {
    /// The name of the new branch created for the restore
    pub branch_name: String,
    /// The commit message used for the restore commit
    pub commit_message: String,
}

/// Current schema version for project metadata.
/// Increment this when making breaking changes to the schema.
pub const PROJECT_METADATA_SCHEMA_VERSION: u32 = 3;

/// A single saved terminal tab.
#[derive(Serialize, Deserialize, Clone)]
pub struct SavedTerminalTab {
    /// Agent ID (e.g., "claude-code", "codex", "terminal")
    pub agent_id: String,
    /// Unique session ID (UUID) for resuming agent conversations
    pub session_id: String,
    /// User-supplied tab title from the sidebar's rename UI. Persisted so
    /// manual renames survive across app launches. `None` (the default)
    /// falls back to the PTY-emitted title at runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
}

/// Saved terminal state for restoring tabs when reopening a project.
#[derive(Serialize, Deserialize, Clone)]
pub struct TerminalState {
    /// Saved tabs in order
    pub tabs: Vec<SavedTerminalTab>,
    /// Index of the active tab (0-based)
    pub active_tab_index: usize,
}

/// Project metadata stored in .shipstudio/project.json
#[derive(Serialize, Deserialize)]
pub struct ProjectMetadata {
    #[serde(rename = "_description")]
    pub description: String,
    /// Schema version for migration support. Defaults to 1 if not present (legacy files).
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub publish: PublishMetadata,
    /// Unix timestamp (ms) when project was last opened
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened: Option<u64>,
    /// Whether to prefix branch names with username (default true)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_prefix_username: Option<bool>,
    /// Information about auto-stashed changes from branch switching
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash_info: Option<StashInfo>,
    /// Code health check results (tests, lint, typecheck, format)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<HealthCheckStatus>,
    /// Whether to run Claude in auto-accept mode (--dangerously-skip-permissions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_accept_mode: Option<bool>,
    /// Whether to hide the main branch warning banner for this project
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_main_branch_warning: Option<bool>,
    /// Custom dev command for generic projects (e.g., "cargo run", "npm run dev")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_dev_command: Option<String>,
    /// Preferred dev server port for this project (default: 3000)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub dev_server_port: Option<u16>,
    /// Saved terminal tab state for session restoration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_state: Option<TerminalState>,
    /// True when the user has uploaded a custom thumbnail. Auto-capture
    /// (capture_project_thumbnail) no-ops while this is set, so the upload
    /// isn't silently overwritten the next time the dev server boots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_thumbnail: Option<bool>,
    /// Relative path under the project root that is the "active" workspace
    /// (set when the project is a monorepo and the user picked an app to focus
    /// on at import). `None` for single-package projects. The dev server,
    /// preview, and `/public` asset management run against this subdir; git
    /// operations stay at the repo root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_subpath: Option<String>,
}

fn default_schema_version() -> u32 {
    1
}

impl Default for ProjectMetadata {
    fn default() -> Self {
        ProjectMetadata {
            description: "Ship Studio project metadata. Auto-generated - safe to delete if needed, will be recreated.".to_string(),
            schema_version: PROJECT_METADATA_SCHEMA_VERSION,
            publish: PublishMetadata::default(),
            last_opened: None,
            branch_prefix_username: None,
            stash_info: None,
            health: None,
            auto_accept_mode: None,
            hide_main_branch_warning: None,
            custom_dev_command: None,
            dev_server_port: None,
            terminal_state: None,
            custom_thumbnail: None,
            workspace_subpath: None,
        }
    }
}

impl ProjectMetadata {
    /// Migrate metadata from an older schema version to the current version.
    /// Returns true if migration was performed, false if already current.
    pub fn migrate(&mut self) -> bool {
        if self.schema_version >= PROJECT_METADATA_SCHEMA_VERSION {
            return false;
        }

        // Future migrations go here:
        // if self.schema_version < 2 {
        //     // Migrate from v1 to v2
        //     self.schema_version = 2;
        // }

        // Update to current version
        self.schema_version = PROJECT_METADATA_SCHEMA_VERSION;
        true
    }
}

// ============ Environment Variables ============

#[derive(Serialize)]
pub struct EnvFile {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

// ============ IDE ============

#[derive(Serialize)]
pub struct IdeAvailability {
    pub vscode: bool,
    pub cursor: bool,
}

// ============ Browser ============

/// Information about an available browser
#[derive(Serialize)]
pub struct BrowserInfo {
    /// Unique identifier (e.g., "chrome", "safari")
    pub id: String,
    /// Display name (e.g., "Google Chrome", "Safari")
    pub name: String,
}

// ============ Agent CLI Integration ============

#[derive(Serialize)]
pub struct AgentCliStatus {
    pub installed: bool,
    pub version: Option<String>,
}

/// Backward-compatible alias
pub type ClaudeCliStatus = AgentCliStatus;

// ============ GitHub Integration ============

#[derive(Serialize)]
pub struct GitHubCliStatus {
    pub installed: bool,
    pub authenticated: bool,
}

/// GitHub connection status - verified against GitHub API
#[derive(Serialize)]
pub struct ProjectGitHubStatus {
    /// "not-a-repo" | "no-remote" | "connected"
    pub status: String,
    /// e.g., "username/repo-name" - only set if connected
    pub github_repo: Option<String>,
    /// e.g., "https://github.com/username/repo-name" - only set if connected
    pub github_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushToGitHubOptions {
    pub project_path: String,
    pub repo_name: String,
    pub is_private: bool,
}

/// GitHub repository info from gh CLI
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepo {
    pub name: String,
    pub url: String,
    #[serde(rename = "sshUrl")]
    pub ssh_url: String,
    #[serde(rename = "isPrivate")]
    pub is_private: bool,
    pub description: Option<String>,
    #[serde(rename = "primaryLanguage")]
    pub primary_language: Option<GitHubLanguage>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// GitHub repository primary language
#[derive(Serialize, Deserialize)]
pub struct GitHubLanguage {
    pub name: String,
}

// ============ Publishing ============

#[derive(Serialize)]
pub struct PublishResult {
    pub url: String,
    pub state: String,
}

// ============ Branch Management ============

#[derive(Serialize)]
pub struct BranchStatus {
    pub local_changes: bool,
    pub staging_ahead: i32,  // Commits local is ahead of staging
    pub staging_behind: i32, // Commits local is behind staging
    pub main_ahead: i32,     // Commits local is ahead of main
    pub main_behind: i32,    // Commits local is behind main
    pub staging_exists: bool,
}

/// Information about a git branch
#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub is_default: bool,
    pub last_commit_date: u64,
    pub last_commit_author: String,
    pub ahead_of_main: i32,
    pub behind_main: i32,
}

/// Result of switching branches
#[derive(Serialize)]
pub struct SwitchResult {
    pub success: bool,
    /// True if changes were stashed during this switch
    pub stashed_changes: bool,
    /// If switching to a branch that has a pending stash, this contains the source branch name
    pub pending_stash_from: Option<String>,
    /// True if a stash was automatically applied
    pub stash_applied: bool,
    pub error: Option<String>,
}

/// A file with uncommitted changes
#[derive(Serialize, Clone)]
pub struct ChangedFile {
    /// Relative file path from project root
    pub path: String,
    /// Change type: "modified", "added", "deleted"
    pub status: String,
}

/// Diff content for a single uncommitted file
#[derive(Serialize)]
pub struct FileDiff {
    /// Relative file path from project root
    pub file_path: String,
    /// True if this is a newly added/untracked file
    pub is_new_file: bool,
    /// True if the file was deleted
    pub is_deleted: bool,
    /// True if this is a binary file
    pub is_binary: bool,
    /// The raw diff content (or full file content for new files)
    pub content: String,
    /// Number of lines added
    pub additions: u32,
    /// Number of lines deleted
    pub deletions: u32,
}

// ============ Pull Requests ============

/// Information about a pull request
#[derive(Serialize)]
pub struct PullRequestInfo {
    pub number: i32,
    pub title: String,
    pub head_ref: String,
    pub base_ref: String,
    pub author: String,
    pub state: String,
    pub mergeable: Option<bool>,
    pub url: String,
    pub created_at: String,
}

// ============ AI Generation ============

/// AI-generated pull request title and description
#[derive(Serialize)]
pub struct GeneratedPR {
    pub title: String,
    pub description: String,
}

// ============ Merge Conflict Resolution ============

/// A single conflict block within a file
#[derive(Serialize)]
pub struct ConflictBlock {
    pub line_start: u32,
    pub line_end: u32,
    pub current_content: String,  // Between <<<<<<< and =======
    pub incoming_content: String, // Between ======= and >>>>>>>
    pub context_before: String,   // 3 lines before conflict
    pub context_after: String,    // 3 lines after conflict
}

/// Information about a file with conflicts
#[derive(Serialize)]
pub struct ConflictedFile {
    pub file_path: String,
    pub is_binary: bool,
    pub conflicts: Vec<ConflictBlock>,
    pub ours_branch: String,
    pub theirs_branch: String,
}

// ============ Folders ============

/// Current schema version for folder config.
pub const FOLDER_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Folder configuration stored in ~/ShipStudio/.shipstudio/folders.json
#[derive(Serialize, Deserialize, Default)]
pub struct FolderConfig {
    pub schema_version: u32,
    pub folders: Vec<Folder>,
}

/// A folder containing multiple projects
#[derive(Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// Array of project paths in this folder
    pub project_paths: Vec<String>,
    /// Unix timestamp (ms) when folder was created
    pub created_at: u64,
    /// Unix timestamp (ms) when folder was last updated
    pub updated_at: u64,
}

/// Folder info for dashboard display (includes preview thumbnails)
#[derive(Serialize)]
pub struct FolderInfo {
    pub id: String,
    pub name: String,
    pub project_count: u32,
    /// Up to 4 thumbnails for grid preview (base64 encoded)
    pub preview_thumbnails: Vec<Option<String>>,
    pub updated_at: u64,
}

// ============ External Projects ============

/// Current schema version for external projects config.
pub const EXTERNAL_PROJECTS_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Configuration for external projects stored in ~/ShipStudio/.shipstudio/external-projects.json
#[derive(Serialize, Deserialize, Default)]
pub struct ExternalProjectsConfig {
    pub schema_version: u32,
    pub projects: Vec<ExternalProject>,
}

/// An external project registered from outside ~/ShipStudio
#[derive(Serialize, Deserialize, Clone)]
pub struct ExternalProject {
    pub path: String,
    /// Unix timestamp (ms) when the project was registered
    pub registered_at: u64,
}

// ============ Assets ============

/// Asset file/folder in the /public directory
#[derive(Serialize)]
pub struct Asset {
    /// File or folder name
    pub name: String,
    /// Relative path from /public (e.g., "images/logo.png")
    pub path: String,
    /// Full filesystem path
    pub full_path: String,
    /// File size in bytes (0 for directories)
    pub size: u64,
    /// Whether this is a directory
    pub is_directory: bool,
    /// Last modified timestamp in milliseconds since Unix epoch
    pub modified_at: u64,
}

// ============ PTY ============

#[derive(Deserialize)]
pub struct SpawnPtyOptions {
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    #[allow(dead_code)]
    pub rows: u32,
    #[allow(dead_code)]
    pub cols: u32,
}

// ============ Code Health ============

/// Package manager detected from lockfiles
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

/// Script category for health checks
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ScriptCategory {
    Test,
    Lint,
    Typecheck,
    Format,
}

/// A suggestion for adding a missing script
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSuggestion {
    /// The category of the suggested script
    pub category: ScriptCategory,
    /// The suggested script name to add
    pub script_name: String,
    /// The suggested script command
    pub script_command: String,
    /// Why this is suggested (e.g., "typescript is installed")
    pub reason: String,
}

/// Available scripts detected from package.json
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedScripts {
    pub package_manager: PackageManager,
    pub test: Option<String>,
    pub lint: Option<String>,
    pub typecheck: Option<String>,
    pub format: Option<String>,
    pub has_package_json: bool,
    /// Suggestions for scripts that could be added based on installed packages
    pub suggestions: Vec<ScriptSuggestion>,
}

/// Result of running a health check script
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResult {
    /// "pass" or "fail"
    pub status: String,
    /// ISO timestamp of last run
    pub last_run: String,
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Full stdout output
    pub stdout: String,
    /// Full stderr output
    pub stderr: String,
    /// Exit code from the script
    pub exit_code: i32,
    /// The script name that was run
    pub script_name: String,
    /// The category of the check
    pub category: ScriptCategory,
}

/// Stored health check status for all categories
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckStatus {
    pub test: Option<HealthCheckResult>,
    pub lint: Option<HealthCheckResult>,
    pub typecheck: Option<HealthCheckResult>,
    pub format: Option<HealthCheckResult>,
}

// ============ Setup/Onboarding ============

/// Individual setup item status
#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Error variant reserved for future use
pub enum SetupItemStatus {
    Ready,
    NotInstalled,
    NotAuthenticated,
    Error,
}

/// Individual setup item
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetupItemInfo {
    pub id: String,
    pub friendly_name: String,
    pub status: SetupItemStatus,
    pub version: Option<String>,
    pub username: Option<String>,
    pub error_message: Option<String>,
}

/// Optional authentication status (GitHub can be skipped during onboarding)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalAuths {
    pub github_authenticated: bool,
}

/// Full setup status response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSetupStatus {
    pub all_ready: bool,
    pub items: Vec<SetupItemInfo>,
    pub optional_auths: OptionalAuths,
    /// Agent IDs that are fully set up (installed + authenticated)
    pub detected_agents: Vec<String>,
}

/// Quick setup check result (fast binary/file existence only)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSetupCheck {
    /// Whether all binaries and auth files exist (fast check)
    pub all_present: bool,
    /// Whether we have a cached setup_complete state
    pub setup_complete_cached: bool,
}

/// Persisted app-level state (stored in app data directory)
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Whether full setup has been completed at least once
    pub setup_complete: bool,
    /// Timestamp when setup was completed (Unix ms)
    pub setup_completed_at: Option<u64>,
    /// Compact mode preferences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_mode: Option<CompactModePreferences>,
    /// Default AI agent ID (e.g., "claude-code" or "codex"). None falls back to Claude Code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_id: Option<String>,
    /// Unique device identifier for anonymous analytics (generated on first launch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Whether anonymous analytics are enabled (defaults to true)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analytics_enabled: Option<bool>,
    /// Whether the GitHub contribution calendar is hidden on the dashboard
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_hidden: Option<bool>,
    /// Whether the Slack community CTA banner is hidden on the dashboard
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_cta_hidden: Option<bool>,
    /// Whether the terminal uses WebGL (GPU-accelerated) rendering. Defaults to true.
    /// Disable if the terminal renders corrupted/fragmented characters (known issue on some
    /// macOS beta / GPU-driver combinations).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_gpu_enabled: Option<bool>,
}

// ============ Compact Mode ============

/// Position coordinates for compact mode window
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

/// Compact mode preferences (persisted at app level)
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompactModePreferences {
    /// Last saved window position
    pub position: Option<WindowPosition>,
    /// Whether compact mode window should stay on top of other windows
    pub always_on_top: bool,
    /// Whether the output area is currently expanded
    pub is_expanded: bool,
}
