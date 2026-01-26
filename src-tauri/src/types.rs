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

/// Full setup status response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSetupStatus {
    pub all_ready: bool,
    pub items: Vec<SetupItemInfo>,
}
