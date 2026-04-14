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

/// 10-minute TTL cache for `gh api user --jq .login`. The username rarely
/// changes during a session; the uncached call adds ~200ms and hits the
/// network, so caching is a meaningful perf win.
static GITHUB_USERNAME_CACHE: LazyLock<TtlCache<(), String>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(600)));

/// Invalidate the cached GitHub username. Call after auth changes.
pub fn invalidate_github_username_cache() {
    GITHUB_USERNAME_CACHE.invalidate(&());
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

/// Returns a Command for gh with extended PATH set
pub fn get_gh_command() -> Command {
    let mut cmd = if let Some(path) = find_executable("gh") {
        create_command(path)
    } else {
        create_command("gh")
    };
    cmd.env("PATH", get_extended_path());
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

    // Check if authenticated (with timeout to prevent hanging)
    let start = std::time::Instant::now();
    let mut auth_cmd = get_gh_command();
    auth_cmd.args(["auth", "status"]);
    let authenticated = match run_command_with_timeout(auth_cmd, GITHUB_CLI_TIMEOUT_SECS).await {
        Ok(output) => {
            debug!(
                elapsed_ms = start.elapsed().as_millis() as u64,
                success = output.status.success(),
                "gh auth status completed"
            );
            output.status.success()
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

#[tauri::command]
#[tracing::instrument]
pub async fn get_github_username() -> Result<String, CommandError> {
    if let Some(cached) = GITHUB_USERNAME_CACHE.get(&()) {
        return Ok(cached);
    }

    let mut cmd = get_gh_command();
    cmd.args(["api", "user", "--jq", ".login"]);
    let output = run_command_with_timeout(cmd, GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        return Err(CommandError::NotAuthenticated {
            service: "github".to_string(),
        });
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    GITHUB_USERNAME_CACHE.insert((), username.clone());
    Ok(username)
}

#[tauri::command]
#[tracing::instrument]
pub async fn get_github_orgs() -> Result<Vec<String>, CommandError> {
    // Get orgs where user can create repos
    let mut cmd = get_gh_command();
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

    // Verify repo exists on GitHub using gh CLI (with timeout)
    let step_start = std::time::Instant::now();
    debug!(github_repo = %github_repo, "Running gh repo view");
    let mut gh_cmd = get_gh_command();
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

    // Fetch identity from GitHub CLI
    let gh_output = get_gh_command()
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
    ensure_git_identity(&validated_path).map_err(CommandError::from)?;

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

    // Create GitHub repo and push
    let mut gh_cmd = get_gh_command();
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
    let repos: Vec<GitHubRepo> = serde_json::from_str(&json_str)
        .map_err(|e| CommandError::Other(format!("Failed to parse repo list: {e}")))?;

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
    let api_repos: Vec<GitHubApiRepo> = serde_json::from_str(&json_str)
        .map_err(|e| CommandError::Other(format!("Failed to parse collaborator repo list: {e}")))?;

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
