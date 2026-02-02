//! # Shared Types
//!
//! This module contains all shared structs and types used across the Ship Studio backend.

use serde::{Deserialize, Serialize};

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
    /// Production URL from Vercel
    pub production_url: Option<String>,
    /// Relative time string for last deployment (e.g., "2h ago")
    pub last_deployed: Option<String>,
    /// Deployment state: READY, BUILDING, ERROR, QUEUED, CANCELED
    pub deployment_state: Option<String>,
    /// Whether to run Claude in auto-accept mode
    pub auto_accept_mode: Option<bool>,
    /// Whether to hide the main branch warning banner
    pub hide_main_branch_warning: Option<bool>,
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

/// Current schema version for project metadata.
/// Increment this when making breaking changes to the schema.
pub const PROJECT_METADATA_SCHEMA_VERSION: u32 = 1;

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

// ============ Claude Integration ============

#[derive(Serialize)]
pub struct ClaudeCliStatus {
    pub installed: bool,
    pub version: Option<String>,
}

// ============ Vercel Integration ============

#[derive(Serialize)]
pub struct VercelCliStatus {
    pub installed: bool,
    pub authenticated: bool,
}

/// A Vercel team/organization
#[derive(Serialize)]
pub struct VercelTeam {
    pub id: String,
    pub name: String,
    pub is_current: bool,
}

/// A Vercel project
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VercelProject {
    pub id: String,
    pub name: String,
    pub org_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployToVercelOptions {
    pub project_path: String,
    pub project_name: String,
    pub github_repo: Option<String>,
    /// Team/scope ID to deploy under (optional, uses current team if not provided)
    pub scope: Option<String>,
}

/// Vercel connection status - verified against Vercel API
#[derive(Serialize)]
pub struct ProjectVercelStatus {
    /// "not-linked" | "not-git-connected" | "connected"
    pub status: String,
    /// Vercel project name
    pub project_name: Option<String>,
    /// Vercel org/team slug for dashboard URLs
    pub vercel_org: Option<String>,
    /// Production URL (shortest alias, could be custom domain)
    pub production_url: Option<String>,
    /// Staging URL (contains -git-staging-)
    pub staging_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkToVercelOptions {
    pub project_path: String,
    pub github_repo: String, // e.g., "username/repo-name"
}

#[derive(Serialize)]
pub struct VercelDeployment {
    pub uid: String,
    pub url: String,
    pub state: String, // "READY", "BUILDING", "ERROR", "QUEUED", "CANCELED"
    pub target: Option<String>, // "production" or null for preview
    pub created_at: u64, // Unix timestamp in ms
}

#[derive(Serialize)]
pub struct VercelDeploymentStatus {
    pub staging: Option<VercelDeployment>,
    pub production: Option<VercelDeployment>,
    pub preview_url: Option<String>,
    pub production_url: Option<String>,
}

/// Deployment status from Vercel
#[derive(Serialize)]
pub struct DeploymentStatus {
    /// Current state: BUILDING, QUEUED, READY, ERROR, CANCELED
    pub state: String,
    /// Deployment URL (e.g., https://project-xxx.vercel.app)
    pub url: Option<String>,
    /// Unix timestamp (ms) when deployment was created
    #[serde(rename = "createdAt")]
    pub created_at: Option<u64>,
    /// Unix timestamp (ms) when deployment became ready
    #[serde(rename = "readyAt")]
    pub ready_at: Option<u64>,
}

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

/// Optional authentication status (GitHub and Vercel can be skipped during onboarding)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptionalAuths {
    pub github_authenticated: bool,
    pub vercel_authenticated: bool,
}

/// Full setup status response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSetupStatus {
    pub all_ready: bool,
    pub items: Vec<SetupItemInfo>,
    pub optional_auths: OptionalAuths,
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
