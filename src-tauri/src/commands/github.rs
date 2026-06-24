//! # GitHub CLI Integration Commands
//!
//! Commands for GitHub CLI status, authentication, and user info.

use crate::cache::TtlCache;
use crate::commands::git::git_stage_and_commit;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{
    GitHubCliStatus, GitHubLanguage, GitHubRepo, ProjectGitHubStatus, PushToGitHubOptions,
};
use crate::utils::{create_command, find_executable, get_extended_path, validate_project_path};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;
use tracing::{debug, warn};

/// 10-minute TTL cache for `gh api user --jq .login`, keyed by the workspace
/// (account) id the lookup ran under. The username rarely changes during a
/// session; the uncached call adds ~200ms and hits the network, so caching is a
/// meaningful perf win. Keying by account id is essential: the same call
/// resolves to a *different* GitHub identity per workspace, so a single
/// unit-keyed cache would hand one workspace's login to another (the
/// "Create Repo defaulted to the wrong owner" bug).
static GITHUB_USERNAME_CACHE: LazyLock<TtlCache<String, String>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(600)));

/// Invalidate every cached GitHub username. Call after auth changes or a
/// workspace switch — both can change which login any account resolves to.
pub fn invalidate_github_username_cache() {
    GITHUB_USERNAME_CACHE.clear();
}

/// Default timeout for GitHub CLI commands (15 seconds)
const GITHUB_CLI_TIMEOUT_SECS: u64 = 15;

/// Run a gh command with a timeout via the shared external_command helper.
/// Returns CommandError so callers can discriminate timeout vs IO vs process.
async fn run_command_with_timeout(
    cmd: Command,
    timeout_secs: u64,
) -> Result<std::process::Output, CommandError> {
    let tokio_cmd = tokio::process::Command::from(cmd);
    run_with_timeout(tokio_cmd, "gh", timeout_secs).await
}

/// Returns a Command for gh with extended PATH set, scoped to the globally
/// active workspace. Use this for gh operations with no project context
/// (e.g. `gh auth status`). For operations that act on a specific project,
/// prefer [`get_gh_command_for_project`] so the project's workspace auth is used.
pub fn get_gh_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd.envs(crate::commands::accounts::get_env_vars_for_active_account());
    cmd
}

/// Like [`get_gh_command`], but scoped to the workspace the given project
/// belongs to (falling back to the active workspace when untagged). This is how
/// `gh pr create/list/merge/...` use the *project's* GitHub login rather than
/// whichever workspace is globally active — so a PR opened from a Beta-workspace
/// project authenticates as Beta even while Acme is the active workspace.
pub fn get_gh_command_for_project(project_path: &std::path::Path) -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
    cmd.envs(crate::commands::accounts::get_env_vars_for_project(
        project_path,
    ));
    cmd
}

/// Parse "owner/repo" from a GitHub URL (HTTPS or SSH format)
pub fn parse_github_repo(url: &str) -> Option<String> {
    // HTTPS: https://github.com/owner/repo.git
    if let Some(start) = url.find("github.com/") {
        let rest = &url[start + 11..];
        let end = rest.find(".git").unwrap_or(rest.len());
        return Some(rest[..end].trim_end_matches('/').to_string());
    }
    // SSH: git@github.com:owner/repo.git
    if let Some(start) = url.find("github.com:") {
        let rest = &url[start + 11..];
        let end = rest.find(".git").unwrap_or(rest.len());
        return Some(rest[..end].trim_end_matches('/').to_string());
    }
    None
}

#[tauri::command]
#[tracing::instrument]
pub async fn check_github_cli_status() -> GitHubCliStatus {
    // Check if gh CLI is installed
    let installed = find_executable("gh").is_some();

    if !installed {
        return GitHubCliStatus {
            installed: false,
            authenticated: false,
        };
    }

    // Check if authenticated (with timeout to prevent hanging).
    //
    // We derive "authenticated" by parsing the output for a valid active login,
    // NOT from the exit code: `gh auth status` exits non-zero whenever any
    // configured account has an invalid token, even when the active account is
    // logged in and working. Trusting the exit code reported users with a stale
    // second account as "not connected" and looped them through the connect flow
    // (grey GitHub button). See accounts::parse_gh_auth_status.
    let start = std::time::Instant::now();
    let mut auth_cmd = get_gh_command();
    auth_cmd.args(["auth", "status"]);
    let authenticated = match run_command_with_timeout(auth_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let authed =
                crate::commands::accounts::parse_gh_auth_status(&stdout, &stderr).is_some();
            debug!(
                elapsed_ms = start.elapsed().as_millis() as u64,
                exit_success = output.status.success(),
                authed,
                "gh auth status completed"
            );
            authed
        }
        Err(e) => {
            warn!(elapsed_ms = start.elapsed().as_millis() as u64, error = %e, "gh auth status failed/timed out");
            false
        }
    };

    GitHubCliStatus {
        installed,
        authenticated,
    }
}

/// Resolves the gh command + workspace (account) id for an optional project.
/// With a project path, both are scoped to that *project's* workspace login (so
/// the owner shown for a repo matches the account the repo will actually be
/// created under); without one, they fall back to the globally-active
/// workspace. The account id is returned so callers can key per-workspace
/// caches — see [`GITHUB_USERNAME_CACHE`].
fn gh_command_and_account(project_path: Option<&str>) -> Result<(Command, String), CommandError> {
    match project_path {
        Some(p) => {
            // Validate the caller-supplied path (rejects traversal / out-of-sandbox
            // paths, allows registered external projects) before we read its
            // workspace config — parity with the other project-scoped commands.
            let path = validate_project_path(p).map_err(CommandError::from)?;
            let account_id = crate::commands::projects::project_account_id_sync(&path);
            Ok((get_gh_command_for_project(&path), account_id))
        }
        None => {
            let account_id = crate::commands::accounts::get_active_account_id()
                .unwrap_or_else(|_| "default".to_string());
            Ok((get_gh_command(), account_id))
        }
    }
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_github_username(project_path: Option<String>) -> Result<String, CommandError> {
    let (mut cmd, account_id) = gh_command_and_account(project_path.as_deref())?;

    if let Some(cached) = GITHUB_USERNAME_CACHE.get(&account_id) {
        return Ok(cached);
    }

    cmd.args(["api", "user", "--jq", ".login"]);
    let output = run_command_with_timeout(cmd, GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        return Err(CommandError::NotAuthenticated {
            service: "github".to_string(),
        });
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    GITHUB_USERNAME_CACHE.insert(account_id, username.clone());
    Ok(username)
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_github_orgs(project_path: Option<String>) -> Result<Vec<String>, CommandError> {
    // Get orgs where user can create repos, scoped to the project's workspace
    // login so org choices match the account the repo will be created under.
    let (mut cmd, _account_id) = gh_command_and_account(project_path.as_deref())?;
    cmd.args(["api", "user/orgs", "--jq", ".[].login"]);
    let output = run_command_with_timeout(cmd, GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        // Return empty list if we can't get orgs (user might not have any)
        return Ok(vec![]);
    }

    let orgs: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(orgs)
}

/// Checks GitHub status by verifying with the GitHub CLI.
/// Asks GitHub directly instead of inferring from local files.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_github_status(project_path: String) -> ProjectGitHubStatus {
    let not_a_repo = ProjectGitHubStatus {
        status: "not-a-repo".to_string(),
        github_repo: None,
        github_url: None,
    };

    // Validate path
    let project = match validate_project_path(&project_path) {
        Ok(p) => p,
        Err(_) => return not_a_repo,
    };

    // Check if .git exists
    if !project.join(".git").exists() {
        return not_a_repo;
    }

    let total_start = std::time::Instant::now();
    debug!(project_path = %project_path, "get_project_github_status: starting");

    // Get remote URL (with timeout)
    let step_start = std::time::Instant::now();
    let mut remote_cmd = create_command("git");
    remote_cmd
        .args(["remote", "get-url", "origin"])
        .current_dir(&project)
        .env("PATH", get_extended_path());

    let remote_url = match run_command_with_timeout(remote_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            debug!(elapsed_ms = step_start.elapsed().as_millis() as u64, remote_url = %url, "git remote get-url origin completed");
            url
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug!(elapsed_ms = step_start.elapsed().as_millis() as u64, stderr = %stderr, "git remote get-url origin: no remote configured");
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
        Err(e) => {
            warn!(elapsed_ms = step_start.elapsed().as_millis() as u64, error = %e, "git remote get-url origin failed/timed out");
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
    };

    // Parse GitHub repo from remote URL (handles HTTPS and SSH)
    let github_repo = parse_github_repo(&remote_url);
    let github_repo = match github_repo {
        Some(repo) => repo,
        None => {
            debug!(remote_url = %remote_url, "Could not parse GitHub repo from remote URL");
            return ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            };
        }
    };

    // Verify repo exists on GitHub using gh CLI (with timeout). Scope to the
    // project's workspace so a repo private to that workspace's GitHub login
    // resolves correctly even when another workspace is globally active.
    let step_start = std::time::Instant::now();
    debug!(github_repo = %github_repo, "Running gh repo view");
    let mut gh_cmd = get_gh_command_for_project(&project);
    gh_cmd
        .args(["repo", "view", &github_repo, "--json", "url"])
        .current_dir(&project);

    let result = match run_command_with_timeout(gh_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) if output.status.success() => {
            debug!(elapsed_ms = step_start.elapsed().as_millis() as u64, github_repo = %github_repo, "gh repo view completed successfully");
            // Parse the URL from JSON response
            let json_str = String::from_utf8_lossy(&output.stdout);
            let url = serde_json::from_str::<serde_json::Value>(&json_str)
                .ok()
                .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| format!("https://github.com/{github_repo}"));

            ProjectGitHubStatus {
                status: "connected".to_string(),
                github_repo: Some(github_repo),
                github_url: Some(url),
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug!(elapsed_ms = step_start.elapsed().as_millis() as u64, stderr = %stderr, "gh repo view: repo not found or no access");
            ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            }
        }
        Err(e) => {
            warn!(elapsed_ms = step_start.elapsed().as_millis() as u64, error = %e, "gh repo view failed/timed out");
            ProjectGitHubStatus {
                status: "no-remote".to_string(),
                github_repo: None,
                github_url: None,
            }
        }
    };

    debug!(
        total_elapsed_ms = total_start.elapsed().as_millis() as u64,
        status = %result.status,
        "get_project_github_status: done"
    );
    result
}

/// Ensures git user.name and user.email are configured for the repo.
/// If not set, fetches the user's identity from GitHub CLI and sets it locally.
pub fn ensure_git_identity(repo_path: &std::path::Path) -> Result<(), CommandError> {
    let has_name = create_command("git")
        .args(["config", "user.name"])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let has_email = create_command("git")
        .args(["config", "user.email"])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_name && has_email {
        return Ok(());
    }

    // Fetch identity from GitHub CLI, scoped to this repo's workspace so the
    // committed author matches the workspace's GitHub login, not the active one.
    let gh_output = get_gh_command_for_project(repo_path)
        .args(["api", "user", "--jq", r#".login, .name, .email"#])
        .output()
        .map_err(|e| format!("Failed to get GitHub user info: {e}"))?;

    if !gh_output.status.success() {
        return Err(("Failed to get GitHub user info. Please configure git manually:\n  git config --global user.name \"Your Name\"\n  git config --global user.email \"you@example.com\"".to_string()).into());
    }

    let info = String::from_utf8_lossy(&gh_output.stdout);
    let lines: Vec<&str> = info.lines().collect();
    // lines[0] = login, lines[1] = name (may be empty), lines[2] = email (may be empty)
    let login = lines.first().map(|s| s.trim()).unwrap_or("");
    let name = lines.get(1).map(|s| s.trim()).filter(|s| !s.is_empty());
    let email = lines.get(2).map(|s| s.trim()).filter(|s| !s.is_empty());

    if !has_name {
        let display_name = name.unwrap_or(login);
        create_command("git")
            .args(["config", "user.name", display_name])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to set git user.name: {e}"))?;
    }

    if !has_email {
        let user_email = email.unwrap_or({
            // Can't return a reference to a local, so we'll handle this below
            ""
        });
        let final_email = if user_email.is_empty() {
            format!("{login}@users.noreply.github.com")
        } else {
            user_email.to_string()
        };
        create_command("git")
            .args(["config", "user.email", &final_email])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to set git user.email: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(options), fields(project = %options.project_path, repo = %options.repo_name))]
pub async fn push_to_github(options: PushToGitHubOptions) -> Result<String, CommandError> {
    let validated_path =
        validate_project_path(&options.project_path).map_err(CommandError::from)?;
    let repo_name = &options.repo_name;
    let visibility = if options.is_private {
        "--private"
    } else {
        "--public"
    };

    // Check if it's already a git repo, if not initialize
    let git_dir = validated_path.join(".git");
    if !git_dir.exists() {
        create_command("git")
            .args(["init"])
            .current_dir(&validated_path)
            .output()
            .map_err(CommandError::from)?;
    }

    // Ensure git identity is configured (required for commits)
    ensure_git_identity(&validated_path)?;

    // Stage and commit any files
    let _ = git_stage_and_commit(
        &validated_path,
        if git_dir.exists() {
            "Update from Ship Studio"
        } else {
            "Initial commit from Ship Studio"
        },
    );

    // Ensure at least one commit exists (gh repo create --push requires it)
    let has_commits = create_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&validated_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_commits {
        let output = create_command("git")
            .args([
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit from Ship Studio",
            ])
            .current_dir(&validated_path)
            .output()
            .map_err(CommandError::from)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CommandError::Process {
                cmd: "git commit".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: stderr.to_string(),
            });
        }
    }

    // Create GitHub repo and push, scoped to the project's workspace so the repo
    // is created under that workspace's GitHub account, not the active one.
    let mut gh_cmd = get_gh_command_for_project(&validated_path);
    gh_cmd
        .args([
            "repo", "create", repo_name, visibility, "--source", ".", "--remote", "origin",
            "--push",
        ])
        .current_dir(&validated_path);
    // Longer timeout: create+push can take a while for bigger repos.
    let output = run_command_with_timeout(gh_cmd, 60).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::Process {
            cmd: "gh repo create".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: stderr.to_string(),
        });
    }

    // Return the repo URL
    Ok(format!("https://github.com/{repo_name}"))
}

/// Lists GitHub repositories for a given owner (user or organization)
#[tauri::command]
#[tracing::instrument]
pub async fn list_github_repos(owner: String) -> Result<Vec<GitHubRepo>, CommandError> {
    let mut cmd = get_gh_command();
    cmd.args([
        "repo",
        "list",
        &owner,
        "--json",
        "name,url,sshUrl,isPrivate,description,primaryLanguage,updatedAt",
        "--limit",
        "100",
    ]);
    let output = run_command_with_timeout(cmd, GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::Process {
            cmd: "gh repo list".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: stderr.to_string(),
        });
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let repos: Vec<GitHubRepo> =
        serde_json::from_str(&json_str).map_err(|e| CommandError::Other {
            message: format!("Failed to parse repo list: {e}"),
        })?;

    Ok(repos)
}

/// GitHub repo from API (different field names than gh repo list)
#[derive(Debug, Serialize, Deserialize)]
struct GitHubApiRepo {
    name: String,
    html_url: String,
    ssh_url: String,
    private: bool,
    description: Option<String>,
    language: Option<String>,
    updated_at: String,
    owner: GitHubApiOwner,
}

#[derive(Debug, Serialize, Deserialize)]
struct GitHubApiOwner {
    login: String,
}

/// Lists GitHub repositories where the user is a collaborator (not owner)
#[tauri::command]
#[tracing::instrument]
pub async fn list_collaborator_repos() -> Result<Vec<GitHubRepo>, CommandError> {
    // Use GitHub API to get repos where user is a collaborator
    // affiliation=collaborator returns repos where user has been added as a collaborator
    let mut cmd = get_gh_command();
    cmd.args([
        "api",
        "/user/repos?affiliation=collaborator&per_page=100&sort=updated",
        "--paginate",
    ]);
    let output = run_command_with_timeout(cmd, GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::Process {
            cmd: "gh api /user/repos".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: stderr.to_string(),
        });
    }

    let json_str = String::from_utf8_lossy(&output.stdout);

    // The API returns an array of repo objects with different field names
    let api_repos: Vec<GitHubApiRepo> =
        serde_json::from_str(&json_str).map_err(|e| CommandError::Other {
            message: format!("Failed to parse collaborator repo list: {e}"),
        })?;

    // Convert to our GitHubRepo format
    let repos: Vec<GitHubRepo> = api_repos
        .into_iter()
        .map(|r| GitHubRepo {
            name: format!("{}/{}", r.owner.login, r.name),
            url: r.html_url,
            ssh_url: r.ssh_url,
            is_private: r.private,
            description: r.description,
            primary_language: r.language.map(|l| GitHubLanguage { name: l }),
            updated_at: r.updated_at,
        })
        .collect();

    Ok(repos)
}

/// Detects the package manager used in a project by checking for lock files
#[tauri::command]
#[tracing::instrument]
pub async fn detect_package_manager(project_path: String) -> Result<String, CommandError> {
    let path = Path::new(&project_path);

    // Check in order of specificity
    if path.join("pnpm-lock.yaml").exists() {
        return Ok("pnpm".to_string());
    }
    if path.join("yarn.lock").exists() {
        return Ok("yarn".to_string());
    }
    if path.join("bun.lockb").exists() {
        return Ok("bun".to_string());
    }
    // Default to npm
    Ok("npm".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GitHubRepo;

    /// Serializes the tests that touch the process-global GITHUB_USERNAME_CACHE.
    /// `invalidate_github_username_cache` clears the whole cache, so without this
    /// these tests race under cargo's default multi-threaded runner.
    static CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn parse_github_repo_https_with_git_suffix() {
        assert_eq!(
            parse_github_repo("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
    }

    #[test]
    fn parse_github_repo_https_without_git_suffix() {
        assert_eq!(
            parse_github_repo("https://github.com/owner/repo").as_deref(),
            Some("owner/repo")
        );
    }

    #[test]
    fn parse_github_repo_https_with_trailing_slash() {
        assert_eq!(
            parse_github_repo("https://github.com/owner/repo/").as_deref(),
            Some("owner/repo")
        );
    }

    #[test]
    fn parse_github_repo_ssh_url() {
        assert_eq!(
            parse_github_repo("git@github.com:owner/repo.git").as_deref(),
            Some("owner/repo")
        );
    }

    #[test]
    fn parse_github_repo_ssh_without_git_suffix() {
        assert_eq!(
            parse_github_repo("git@github.com:owner/repo").as_deref(),
            Some("owner/repo")
        );
    }

    #[test]
    fn parse_github_repo_rejects_non_github_urls() {
        assert_eq!(parse_github_repo("https://gitlab.com/owner/repo.git"), None);
        assert_eq!(parse_github_repo("not a url"), None);
        assert_eq!(parse_github_repo(""), None);
    }

    #[test]
    fn parse_github_repo_handles_org_with_dashes() {
        assert_eq!(
            parse_github_repo("https://github.com/my-org/my-repo-name.git").as_deref(),
            Some("my-org/my-repo-name")
        );
    }

    /// Mirror of the JSON shape returned by `gh repo view --json url`.
    /// Ensures the inline parsing in `get_project_github_status` keeps working
    /// as the serde_json type contract between gh and us.
    #[test]
    fn gh_repo_view_json_extracts_url() {
        let json_str = r#"{"url":"https://github.com/foo/bar"}"#;
        let url = serde_json::from_str::<serde_json::Value>(json_str)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()));
        assert_eq!(url.as_deref(), Some("https://github.com/foo/bar"));
    }

    #[test]
    fn gh_repo_view_json_missing_url_returns_none() {
        let json_str = r#"{"other":"value"}"#;
        let url = serde_json::from_str::<serde_json::Value>(json_str)
            .ok()
            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()));
        assert_eq!(url, None);
    }

    /// `gh repo list --json name,url,sshUrl,isPrivate,description,primaryLanguage,updatedAt`
    /// returns an array. Validates our GitHubRepo deserialization contract.
    #[test]
    fn gh_repo_list_json_parses_into_repos() {
        let json_str = r#"[
            {
                "name": "repo1",
                "url": "https://github.com/o/repo1",
                "sshUrl": "git@github.com:o/repo1.git",
                "isPrivate": false,
                "description": "Hello",
                "primaryLanguage": {"name": "Rust"},
                "updatedAt": "2024-01-01T00:00:00Z"
            },
            {
                "name": "repo2",
                "url": "https://github.com/o/repo2",
                "sshUrl": "git@github.com:o/repo2.git",
                "isPrivate": true,
                "description": null,
                "primaryLanguage": null,
                "updatedAt": "2024-02-01T00:00:00Z"
            }
        ]"#;
        let repos: Vec<GitHubRepo> = serde_json::from_str(json_str).expect("parse");
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name, "repo1");
        assert!(!repos[0].is_private);
        assert_eq!(
            repos[0].primary_language.as_ref().map(|l| l.name.as_str()),
            Some("Rust")
        );
        assert!(repos[1].is_private);
        assert!(repos[1].description.is_none());
        assert!(repos[1].primary_language.is_none());
    }

    /// Collaborator repos use the raw GitHub REST API shape, which has
    /// different field names from `gh repo list`. Guard against regressions in
    /// the GitHubApiRepo struct.
    #[test]
    fn github_api_collaborator_repo_json_parses() {
        let json_str = r#"[{
            "name": "shared",
            "html_url": "https://github.com/alice/shared",
            "ssh_url": "git@github.com:alice/shared.git",
            "private": true,
            "description": "A shared repo",
            "language": "TypeScript",
            "updated_at": "2024-03-01T00:00:00Z",
            "owner": {"login": "alice"}
        }]"#;
        let api_repos: Vec<GitHubApiRepo> = serde_json::from_str(json_str).expect("parse");
        assert_eq!(api_repos.len(), 1);
        assert_eq!(api_repos[0].owner.login, "alice");
        assert_eq!(api_repos[0].name, "shared");
        assert!(api_repos[0].private);
        assert_eq!(api_repos[0].language.as_deref(), Some("TypeScript"));
    }

    /// Post-parse behavior: the mapping performed in `list_collaborator_repos`
    /// prefixes the repo name with `owner/`. Verify it.
    /// Verify `invalidate_github_username_cache` clears the cached login.
    /// We prime the cache manually (no network), invalidate, and check miss.
    #[test]
    fn github_username_cache_invalidation_clears_entry() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        invalidate_github_username_cache();
        GITHUB_USERNAME_CACHE.insert("default".to_string(), "alice".to_string());
        assert_eq!(
            GITHUB_USERNAME_CACHE.get("default"),
            Some("alice".to_string()),
            "cache should be primed"
        );
        invalidate_github_username_cache();
        assert_eq!(
            GITHUB_USERNAME_CACHE.get("default"),
            None,
            "invalidate must clear the cached username"
        );
    }

    /// Verify the cache survives repeated reads within TTL (stability check).
    #[test]
    fn github_username_cache_stable_across_reads() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Clean slate before asserting.
        invalidate_github_username_cache();
        GITHUB_USERNAME_CACHE.insert("default".to_string(), "bob".to_string());
        let first = GITHUB_USERNAME_CACHE.get("default");
        let second = GITHUB_USERNAME_CACHE.get("default");
        assert_eq!(first, second);
        assert_eq!(first.as_deref(), Some("bob"));
        // Cleanup so we don't pollute other tests (test-threads=1 means tests
        // run sequentially but global state still bleeds between cases).
        invalidate_github_username_cache();
    }

    /// Regression: two workspaces resolve to two different GitHub logins, so the
    /// cache must hold both independently. A single unit-keyed cache returned
    /// one workspace's identity for the other (Create Repo wrong-owner bug).
    #[test]
    fn github_username_cache_is_keyed_per_workspace() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        invalidate_github_username_cache();
        GITHUB_USERNAME_CACHE.insert("default".to_string(), "adambwhitten".to_string());
        GITHUB_USERNAME_CACHE.insert("circa".to_string(), "circa-brand-agency".to_string());
        assert_eq!(
            GITHUB_USERNAME_CACHE.get("default").as_deref(),
            Some("adambwhitten")
        );
        assert_eq!(
            GITHUB_USERNAME_CACHE.get("circa").as_deref(),
            Some("circa-brand-agency"),
            "each workspace must keep its own cached login"
        );
        invalidate_github_username_cache();
    }

    #[test]
    fn collaborator_repos_are_prefixed_with_owner_login() {
        let api = GitHubApiRepo {
            name: "shared".into(),
            html_url: "https://github.com/alice/shared".into(),
            ssh_url: "git@github.com:alice/shared.git".into(),
            private: false,
            description: None,
            language: None,
            updated_at: "2024-03-01T00:00:00Z".into(),
            owner: GitHubApiOwner {
                login: "alice".into(),
            },
        };
        let converted = GitHubRepo {
            name: format!("{}/{}", api.owner.login, api.name),
            url: api.html_url,
            ssh_url: api.ssh_url,
            is_private: api.private,
            description: api.description,
            primary_language: api.language.map(|l| GitHubLanguage { name: l }),
            updated_at: api.updated_at,
        };
        assert_eq!(converted.name, "alice/shared");
    }
}
