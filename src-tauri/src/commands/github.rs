//! # GitHub CLI Integration Commands
//!
//! Commands for GitHub CLI status, authentication, and user info.

use crate::cache::TtlCache;
use crate::commands::git::git_stage_and_commit;
use crate::errors::CommandError;
use crate::external_command::{run_with_timeout, truncate_output};
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
///
/// `label` names the specific invocation ("gh auth status", "gh repo create
/// --push", …): the timeout error message and its telemetry fingerprint are
/// derived from it, so a bare "gh" would collapse every distinct hang into one
/// undiagnosable bucket (issue #611).
async fn run_command_with_timeout(
    cmd: Command,
    label: &str,
    timeout_secs: u64,
) -> Result<std::process::Output, CommandError> {
    let tokio_cmd = tokio::process::Command::from(cmd);
    run_with_timeout(tokio_cmd, label, timeout_secs).await
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
    // No caller feeds gh stdin, and a GUI-spawned gh has no tty — if gh ever
    // decides to prompt (stale credential, ambiguous host) it must fail fast
    // instead of blocking on input that can never arrive until the 60s network
    // timeout kills it with a bare "timed out" (issue #259).
    cmd.stdin(std::process::Stdio::null());
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
    // Fail fast instead of blocking on a prompt — see get_gh_command().
    cmd.stdin(std::process::Stdio::null());
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
    let authenticated = match run_command_with_timeout(
        auth_cmd,
        "gh auth status",
        GITHUB_CLI_TIMEOUT_SECS,
    )
    .await
    {
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

/// User-facing message when a `gh api` call blows its time budget — a slow or
/// flaky network, not an app malfunction (issue #686). `Expected` keeps it out
/// of telemetry; ImportProject.tsx matches the "took too long" wording to
/// suggest retrying instead of re-authenticating — keep them in sync.
const GH_TIMEOUT_MESSAGE: &str =
    "GitHub took too long to respond. Check your internet connection and try again.";

/// User-facing message when `gh repo create --push` blows its (longer) time
/// budget — a big repo or a slow uplink, not a malfunction (issue #771).
/// Keeps the "check your internet connection" wording so errors.ts's
/// BACKEND_HUMANIZED_GIT_PHRASES still recognizes it as already-humanized.
const GH_PUSH_TIMEOUT_MESSAGE: &str =
    "Creating the repository on GitHub took too long and timed out. Larger projects can take a \
     while to upload — check your internet connection and try again.";

#[tauri::command]
#[tracing::instrument]
pub async fn get_github_username(project_path: Option<String>) -> Result<String, CommandError> {
    let (mut cmd, account_id) = gh_command_and_account(project_path.as_deref())?;

    if let Some(cached) = GITHUB_USERNAME_CACHE.get(&account_id) {
        return Ok(cached);
    }

    cmd.args(["api", "user", "--jq", ".login"]);
    let output = match run_command_with_timeout(cmd, "gh api user", GITHUB_CLI_TIMEOUT_SECS).await {
        // A blown time budget is the network, not a malfunction — same
        // mapping pattern as mobile.rs's simctl timeouts (issue #686).
        Err(CommandError::Timeout { .. }) => {
            return Err(CommandError::expected(GH_TIMEOUT_MESSAGE))
        }
        other => other?,
    };

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
    let output =
        match run_command_with_timeout(cmd, "gh api user/orgs", GITHUB_CLI_TIMEOUT_SECS).await {
            // Same network-not-malfunction mapping as get_github_username
            // (issue #686).
            Err(CommandError::Timeout { .. }) => {
                return Err(CommandError::expected(GH_TIMEOUT_MESSAGE))
            }
            other => other?,
        };

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
    let Ok(mut remote_cmd) = crate::utils::git_command_in(&project) else {
        return not_a_repo;
    };
    remote_cmd
        .args(["remote", "get-url", "origin"])
        .env("PATH", get_extended_path());

    let remote_url = match run_command_with_timeout(
        remote_cmd,
        "git remote get-url origin",
        GITHUB_CLI_TIMEOUT_SECS,
    )
    .await
    {
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

    let result = match run_command_with_timeout(gh_cmd, "gh repo view", GITHUB_CLI_TIMEOUT_SECS)
        .await
    {
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
    let has_name = crate::utils::git_command_in(repo_path)?
        .args(["config", "user.name"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let has_email = crate::utils::git_command_in(repo_path)?
        .args(["config", "user.email"])
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
        crate::utils::git_command_in(repo_path)?
            .args(["config", "user.name", display_name])
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
        crate::utils::git_command_in(repo_path)?
            .args(["config", "user.email", &final_email])
            .output()
            .map_err(|e| format!("Failed to set git user.email: {e}"))?;
    }

    Ok(())
}

/// The project's configured `origin` remote URL, if it has one. A missing
/// remote (or a repo git can't read) is simply "none" — the caller only uses
/// this to decide whether `gh repo create --remote origin` can safely run.
fn existing_origin_url(repo_path: &Path) -> Option<String> {
    let output = crate::utils::git_command_in(repo_path)
        .ok()?
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

/// True when an existing `origin` already points at the repository the user is
/// asking to create — the signature of a half-finished earlier run (`gh repo
/// create` succeeded, the push after it didn't). `repo_name` is either bare
/// ("my-app") or owner-qualified ("acme/my-app"); a bare name can only be
/// matched on the repo segment, since which account gh would create it under
/// isn't known here.
fn origin_matches_repo(origin_url: &str, repo_name: &str) -> bool {
    let Some(existing) = parse_github_repo(origin_url) else {
        return false;
    };
    let existing = existing.to_lowercase();
    let target = repo_name.trim().to_lowercase();
    if target.is_empty() {
        return false;
    }
    if target.contains('/') {
        return existing == target;
    }
    existing.rsplit('/').next() == Some(target.as_str())
}

/// Finish a run that already created the GitHub repo and wired up `origin`:
/// push the branch and report the repo URL derived from the *actual* remote
/// (never a guessed one). Failures classify through the shared git/gh
/// classifiers so a connectivity blip here reads like it does everywhere else.
async fn push_to_existing_origin(
    repo_path: &Path,
    origin_url: &str,
) -> Result<String, CommandError> {
    let output =
        crate::commands::git::run_git_net(&["push", "-u", "origin", "HEAD"], repo_path, "push")
            .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("Everything up-to-date") {
            if let Some(err) = crate::commands::git::classify_git_net_error(&stderr) {
                return Err(err);
            }
            return Err(CommandError::Process {
                cmd: "git push".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: truncate_output(&stderr),
            });
        }
    }

    let slug = parse_github_repo(origin_url).ok_or_else(|| CommandError::Other {
        message: format!("Couldn't read the GitHub repository from the remote URL {origin_url}"),
    })?;
    Ok(format!("https://github.com/{slug}"))
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
        crate::utils::git_command_in(&validated_path)?
            .args(["init"])
            .output()
            .map_err(CommandError::from)?;
    }

    // Ensure git identity is configured (required for commits)
    ensure_git_identity(&validated_path)?;

    // Whether the repo already has a commit decides the message. `git_dir`
    // can't answer that here — the `git init` above just created it, so the
    // very first commit of a brand-new repo used to be labelled "Update from
    // Ship Studio". Ask for HEAD instead, which is also correct for a repo
    // that was initialised outside the app but never committed to.
    let had_commits = crate::utils::git_command_in(&validated_path)?
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // Stage and commit any files. Do not continue to repo creation when a
    // commit hook rejects the commit: doing so creates the remote and then
    // reports the hook output as a misleading push failure.
    git_stage_and_commit(
        &validated_path,
        if had_commits {
            "Update from Ship Studio"
        } else {
            "Initial commit from Ship Studio"
        },
    )?;

    // Ensure at least one commit exists (gh repo create --push requires it)
    let has_commits = crate::utils::git_command_in(&validated_path)?
        .args(["rev-parse", "HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_commits {
        let output = crate::utils::git_command_in(&validated_path)?
            .args([
                "commit",
                "--allow-empty",
                "-m",
                "Initial commit from Ship Studio",
            ])
            .output()
            .map_err(CommandError::from)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CommandError::Process {
                cmd: "git commit".to_string(),
                exit_code: output.status.code().unwrap_or(-1),
                stderr: truncate_output(&stderr),
            });
        }
    }

    // `gh repo create --remote origin` runs `git remote add origin` itself —
    // *after* creating the repo on GitHub — so a project that already has an
    // origin leaves a partial success: the repo exists, the project isn't
    // linked, and the user sees gh's raw `Unable to add remote "origin"`
    // (issue #779). Settle it before anything is created.
    if let Some(origin_url) = existing_origin_url(&validated_path) {
        if origin_matches_repo(&origin_url, repo_name) {
            // The remote already points at the repo being created — a retry of
            // an earlier run whose push failed after the create succeeded.
            // Reuse it and finish the job instead of re-creating anything.
            return push_to_existing_origin(&validated_path, &origin_url).await;
        }
        return Err(CommandError::expected(format!(
            "This project is already connected to a different GitHub repository ({origin_url}). \
             Publish to that repository, or remove the existing remote \
             (`git remote remove origin`) before creating a new one."
        )));
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
    let output = match run_command_with_timeout(gh_cmd, "gh repo create --push", 60).await {
        // A blown time budget on a big upload is the network, not a
        // malfunction — the same mapping the gh api calls above use
        // (issues #771/#686).
        Err(CommandError::Timeout { .. }) => {
            return Err(CommandError::expected(GH_PUSH_TIMEOUT_MESSAGE))
        }
        other => other?,
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A name collision is user input needing a different name, not a
        // malfunction — surface it in plain language instead of GitHub's raw
        // "GraphQL: Name already exists on this account (createRepository)"
        // (issue #279). Expected: routine collisions aren't telemetry.
        if stderr.contains("Name already exists on this account") {
            return Err(CommandError::expected(format!(
                "A repository named \"{repo_name}\" already exists on this account. Choose a different name."
            )));
        }
        // The remote-add step still lost the race (a remote appeared between
        // the pre-flight check and now). gh creates the repo on GitHub before
        // wiring the remote up, so the repo exists and only the local link is
        // missing — say that instead of forwarding gh's raw wording, and don't
        // silently repoint a remote the user set up (issue #779).
        let lower = stderr.to_lowercase();
        if lower.contains("unable to add remote") || lower.contains("remote origin already exists")
        {
            return Err(CommandError::expected(format!(
                "The repository \"{repo_name}\" was created on GitHub, but this project couldn't \
                 be connected to it because it already has a remote named \"origin\". Point that \
                 remote at the new repository (`git remote set-url origin <url>`) and push, or \
                 remove it and try again."
            )));
        }
        // Connectivity blips and GitHub's transient API 400s are the
        // environment/GitHub, not a malfunction (#420, #602).
        if let Some(err) = gh_common_error(&stderr) {
            return Err(err);
        }
        return Err(CommandError::Process {
            cmd: "gh repo create".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: truncate_output(&stderr),
        });
    }

    // Return the repo URL
    Ok(format!("https://github.com/{repo_name}"))
}

/// gh's stderr when a subcommand needs auth and none is configured — "To get
/// started with GitHub CLI, please run:  gh auth login" plus the GH_TOKEN
/// hint. Modeled as the app's first-class NotAuthenticated state (skipped by
/// telemetry, and the frontend shows its connect-GitHub UI) instead of
/// surfacing the raw CLI text (issue #326).
pub(crate) fn gh_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    // "gh auth login"/GH_TOKEN = no credential at all (issue #326);
    // "gh auth refresh"/"Requires authentication" = a credential exists but
    // GitHub rejected it (expired/revoked token, HTTP 401) — same reconnect
    // UX applies (issue #470). "could not read Username/Password" = git fell
    // back to an interactive credential prompt because no usable credential
    // helper answered — no tty in a GUI-spawned process, so it dies with
    // "Device not configured"/"terminal prompts disabled"; the same reconnect
    // UX fixes it (issue #638, mirroring publishing.rs's push_auth_error).
    if stderr.contains("gh auth login")
        || stderr.contains("GH_TOKEN")
        || stderr.contains("gh auth refresh")
        || lower.contains("requires authentication")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
    {
        return Some(CommandError::NotAuthenticated {
            service: "github".to_string(),
        });
    }
    None
}

/// gh's stderr when the machine simply can't reach GitHub (offline, DNS or
/// firewall block, flaky network). Covers Go's `net/http` dial errors —
/// including the Windows-specific `connectex: A connection attempt failed…`
/// wording, which contains none of the usual "timed out"/"refused"
/// substrings (issue #375). A connectivity blip is the environment, not a
/// malfunction: `Expected` keeps it out of telemetry and the message is
/// something the user can act on.
pub(crate) fn gh_network_error(stderr: &str) -> Option<CommandError> {
    let s = stderr.to_lowercase();
    let unreachable = s.contains("dial tcp")
        || s.contains("connectex")
        || s.contains("could not resolve host")
        || s.contains("no such host")
        || s.contains("connection refused")
        || s.contains("network is unreachable")
        || s.contains("i/o timeout")
        || s.contains("tls handshake timeout")
        // Go's net/http error when the connection drops mid-request —
        // flaky wifi, VPN/proxy interference (issue #434).
        || s.contains("unexpected eof")
        // Mid-request TCP reset ("read tcp …: read: connection reset by
        // peer") — the read-time counterpart of "dial tcp"'s connect-time
        // failures (issue #592).
        || s.contains("connection reset by peer")
        || s.contains("read tcp")
        // gh's own top-level DNS-failure handler swallows the raw Go error
        // and prints only "error connecting to <host>\ncheck your internet
        // connection or https://githubstatus.com" (issue #473).
        || s.contains("check your internet connection")
        || s.contains("error connecting to ")
        // Go's bare net/http `EOF` — the connection closed before any response
        // byte, without the "unexpected" prefix #434 covered. A naked "eof"
        // substring would false-positive on ordinary words ("thereof"), so
        // match the error-position shape `…: EOF` at the end of a line
        // (issue #642).
        || s.lines().any(|l| l.trim_end().ends_with(": eof"));
    unreachable.then(|| {
        CommandError::expected(
            "Couldn't reach GitHub. Check your internet connection and try again.",
        )
    })
}

/// Go's `crypto/tls`/`crypto/x509` error when gh can reach a server but can't
/// verify the certificate chain it presents — "tls: failed to verify
/// certificate: x509: certificate signed by unknown authority". Almost always
/// a corporate proxy or antivirus doing TLS interception with a private CA
/// the system doesn't trust, or a broken/outdated certificate store — the
/// environment, not an app malfunction (issue #658). Deliberately NOT folded
/// into gh_network_error's "check your internet connection" message: retrying
/// or checking connectivity can't fix a trust chain — the user needs to
/// install the intercepting proxy's CA cert or repair their trust store.
pub(crate) fn gh_tls_error(stderr: &str) -> Option<CommandError> {
    let s = stderr.to_lowercase();
    // "x509:" prefixes every Go certificate-verification failure variant
    // (unknown authority, expired, hostname mismatch, …) and appears nowhere
    // in ordinary gh/GraphQL output.
    let cert_unverifiable = s.contains("failed to verify certificate") || s.contains("x509:");
    cert_unverifiable.then(|| {
        CommandError::expected(
            "GitHub's secure connection couldn't be verified. This usually means a corporate \
             proxy, VPN, or antivirus is inspecting HTTPS traffic on this computer (its \
             certificate isn't trusted yet), or the system's certificate store is out of date. \
             Install your proxy's certificate or update your system, then try again.",
        )
    })
}

/// gh's passthrough of GitHub's generic HTTP 400 GraphQL response — "HTTP 400:
/// We received a malformed request from your client. Sorry about that. Please
/// try resubmitting your request…". GitHub emits this when the API can't parse
/// the request body (e.g. odd Unicode in a PR title/body getting serialized
/// into the GraphQL payload) — a transient API-side failure with a built-in
/// retry suggestion, not an app malfunction (issue #602). `Expected` keeps it
/// out of telemetry.
pub(crate) fn gh_malformed_request_error(stderr: &str) -> Option<CommandError> {
    stderr
        .to_lowercase()
        .contains("we received a malformed request")
        .then(|| {
            CommandError::expected(
                "GitHub couldn't process the request (a temporary GitHub API error). \
                 Try again in a moment.",
            )
        })
}

/// GitHub's API answering with a transient server-side status — gh passes the
/// response text through ("HTTP 504: We couldn't respond to your request in
/// time…", "HTTP 502: Bad Gateway", …). The request reached GitHub and
/// GitHub fell over; nothing the app did wrong and nothing the user can do
/// but retry — the sibling of the HTTP 400 case below (issues #627/#602).
/// `Expected` keeps it out of telemetry.
///
/// HTTP 499 ("Client Closed Request") belongs here too despite not being a
/// 5xx: it's the nginx-originated status GitHub's edge returns when the
/// request is abandoned before a response is produced — an infrastructure
/// blip on the same retry-and-it-works footing (issue #806).
pub(crate) fn gh_server_error(stderr: &str) -> Option<CommandError> {
    let s = stderr.to_lowercase();
    let is_transient = s.contains("http 500")
        || s.contains("http 502")
        || s.contains("http 503")
        || s.contains("http 504")
        || s.contains("http 499")
        || s.contains("bad gateway")
        || s.contains("service unavailable")
        || s.contains("gateway timeout")
        // The prose GitHub uses for its GraphQL 504s ("We couldn't respond to
        // your request in time. Sorry about that. Please try resubmitting…").
        || s.contains("respond to your request in time");
    is_transient.then(|| {
        CommandError::expected(
            "GitHub's API is temporarily unavailable (a GitHub server error). \
             Try again in a moment.",
        )
    })
}

/// gh failing before it even runs a subcommand because it can't read its own
/// config file — "failed to load config: open …/.config/gh/config.yml:
/// permission denied" / "failed to create root command: failed to read
/// configuration: …". A local file-permissions problem (typically a prior
/// sudo run left the directory root-owned), not a Ship Studio bug and not a
/// GitHub sign-in failure — reconnecting can't fix a file the OS won't let gh
/// read (issue #631). Recurs on every gh call for the affected user, so
/// `Expected` keeps it from flooding telemetry, and the message names the
/// real fix (same precedent as the ~/.npm chown guidance in errors.ts).
pub(crate) fn gh_config_error(stderr: &str) -> Option<CommandError> {
    let s = stderr.to_lowercase();
    let config_unreadable = (s.contains("failed to read configuration")
        || s.contains("failed to load config"))
        && s.contains("permission denied");
    config_unreadable.then(|| {
        CommandError::expected(
            "The GitHub CLI (gh) can't read its own settings because of a file-permissions \
             problem on this computer — this isn't a GitHub sign-in issue. Open a terminal and \
             run `sudo chown -R $(whoami) ~/.config/gh`, then try again.",
        )
    })
}

/// gh (a Go binary) crashing with a Go runtime panic/fatal error — stderr is
/// the runtime's full crash dump ("fatal error: …\n\nruntime stack:\n…" or
/// "panic: …\n\ngoroutine N [running]:\n…"), dozens of stack-trace lines that
/// are useless to a user. The known real-world case is the runtime failing to
/// reserve its heap arena at startup on a memory-starved Windows machine
/// (issue #610, the child-process sibling of errors.rs's
/// `windows_out_of_memory` for our own spawns, #356). The environment killed
/// the child, not the app — `Expected` keeps the dump out of telemetry and the
/// message is something the user can act on. The matched literals are
/// untranslated Go-runtime strings, stable across Go versions.
pub(crate) fn gh_crash_error(stderr: &str) -> Option<CommandError> {
    if stderr.contains("out of memory allocating heap arena map") {
        return Some(CommandError::expected(
            "The GitHub CLI (gh) couldn't start because the system is low on memory. \
             Close some other apps (on Windows, increasing the paging file size can also help) \
             and try again.",
        ));
    }
    let go_crash = (stderr.contains("fatal error:") && stderr.contains("runtime stack:"))
        || (stderr.contains("panic:") && stderr.contains("goroutine "));
    go_crash.then(|| {
        CommandError::expected(
            "The GitHub CLI (gh) crashed unexpectedly. Try again — if it keeps happening, \
             reinstalling the GitHub CLI may help.",
        )
    })
}

/// A Node.js crash dump from a program named `gh` that isn't GitHub's CLI.
/// GitHub ships `gh` as a Go binary — it never emits `node:internal/...`
/// frames — so this shape means PATH resolved something else: in the reported
/// case the unrelated npm package literally named `gh`, installed globally
/// under `%APPDATA%\npm` where `find_executable` can find it ahead of the real
/// `gh.exe`. Handed real-gh arguments and the null stdin
/// [`get_gh_command`] sets, its `inquirer` prompt tears down an already-closed
/// readline, which Node ≥ 24 turns into a thrown `ERR_USE_AFTER_CLOSE`
/// (issue #737). Nothing the app can retry: `Expected` keeps the dump out of
/// telemetry and the message names the real fix.
///
/// The Node-crash shape alone isn't enough to conclude that: `gh_common_error`
/// is also reached from [`classify_git_net_error`], which sees plain
/// `git push` stderr, and a husky/Node pre-push hook crashing there has
/// nothing to do with `gh`. The dump must also point at a program actually
/// named `gh` — otherwise the user gets the wrong remedy and the real failure
/// is hidden behind it.
pub(crate) fn gh_shadowed_binary_error(stderr: &str) -> Option<CommandError> {
    let is_node_crash = stderr.contains("node:internal/") || stderr.contains("ERR_USE_AFTER_CLOSE");
    (is_node_crash && stderr_names_gh_program(stderr)).then(|| {
        CommandError::expected(
            "The program named `gh` on this computer isn't GitHub's CLI — something else \
             (most often an unrelated global npm package called \"gh\") is being found first. \
             Remove it (`npm uninstall -g gh`) or reinstall the GitHub CLI, then try again.",
        )
    })
}

/// Whether a stack trace points at a file or directory actually named `gh` —
/// `…\node_modules\gh\…`, `…/bin/gh`, `…\gh.cmd`. Requires `gh` to be a whole
/// path component (or a script stem), so `github.com`, `gh-pages` and
/// `~/gh-repos` don't count.
fn stderr_names_gh_program(stderr: &str) -> bool {
    let bytes = stderr.as_bytes();
    let mut from = 0;
    while let Some(rel) = stderr[from..].find("gh") {
        let i = from + rel;
        from = i + 2;
        let after_sep = i > 0 && matches!(bytes[i - 1], b'/' | b'\\');
        let ends_component = match bytes.get(i + 2) {
            None => true,
            Some(c) => matches!(
                c,
                b'/' | b'\\' | b'.' | b'\'' | b'"' | b' ' | b'\t' | b'\r' | b'\n' | b':'
            ),
        };
        if after_sep && ends_component {
            return true;
        }
    }
    false
}

/// A `gh` invocation that hits GitHub can fail these ways regardless of which
/// subcommand ran: a connectivity blip, GitHub's transient HTTP 400 or 5xx,
/// an unreadable gh config file, gh itself crashing, or `gh` not being
/// GitHub's CLI at all. One-stop classification for the shared cases — call
/// sites still layer their own auth / subcommand-specific checks on top.
pub(crate) fn gh_common_error(stderr: &str) -> Option<CommandError> {
    // TLS first: a cert-verification failure needs its trust-store guidance,
    // not the generic "check your internet connection" message (issue #658).
    gh_tls_error(stderr)
        .or_else(|| gh_network_error(stderr))
        .or_else(|| gh_malformed_request_error(stderr))
        .or_else(|| gh_server_error(stderr))
        .or_else(|| gh_config_error(stderr))
        // Before gh_crash_error: a wrong-binary crash needs its own remedy,
        // not "reinstalling the GitHub CLI may help" (issue #737).
        .or_else(|| gh_shadowed_binary_error(stderr))
        .or_else(|| gh_crash_error(stderr))
}

/// gh's own wrapper for a failing internal git call — "failed to run git:
/// <git's stderr>" (gh's git/errors.go, GitError). Most commonly hit when gh
/// can't resolve repo context because the project isn't a git repository. The
/// underlying git fatal text is locale-dependent (e.g. Russian installs print
/// a translated "not a git repository"), so matching git's own words — as
/// report_command_error does for issue #254 — silently fails on non-English
/// machines; gh's wrapper prefix is an untranslated Go literal and therefore
/// stable (issue #403). A by-design refusal, not a malfunction.
pub(crate) fn gh_git_repo_error(stderr: &str) -> Option<CommandError> {
    stderr.contains("failed to run git:").then(|| {
        CommandError::expected(
            "This project isn't set up with git yet, so GitHub pull request actions aren't available.",
        )
    })
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
    let output = run_command_with_timeout(cmd, "gh repo list", GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(err) = gh_auth_error(&stderr) {
            return Err(err);
        }
        // Connectivity blips and GitHub's transient API 400s are the
        // environment/GitHub, not a malfunction (#420, #602).
        if let Some(err) = gh_common_error(&stderr) {
            return Err(err);
        }
        return Err(CommandError::Process {
            cmd: "gh repo list".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: truncate_output(&stderr),
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
    let output =
        run_command_with_timeout(cmd, "gh api user/repos", GITHUB_CLI_TIMEOUT_SECS).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(err) = gh_auth_error(&stderr) {
            return Err(err);
        }
        // Connectivity blips and GitHub's transient API 400s are the
        // environment/GitHub, not a malfunction (#420, #602).
        if let Some(err) = gh_common_error(&stderr) {
            return Err(err);
        }
        return Err(CommandError::Process {
            cmd: "gh api /user/repos".to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr: truncate_output(&stderr),
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

/// True when any dependency map in a package.json uses pnpm/yarn's
/// `workspace:` or pnpm's `catalog:` specifier. npm understands neither and
/// aborts the whole install with EUNSUPPORTEDPROTOCOL (issues #707/#708), so
/// their presence is a stronger signal than the missing lockfile.
fn manifest_uses_workspace_protocol(manifest: &serde_json::Value) -> bool {
    const DEP_KEYS: [&str; 4] = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ];
    DEP_KEYS.iter().any(|key| {
        manifest
            .get(key)
            .and_then(|deps| deps.as_object())
            .is_some_and(|deps| {
                deps.values().any(|spec| {
                    spec.as_str()
                        .is_some_and(|s| s.starts_with("workspace:") || s.starts_with("catalog:"))
                })
            })
    })
}

/// The package manager a project structurally requires, ignoring whether that
/// tool is actually installed. `None` means "no signal" — the caller defaults
/// to npm.
///
/// Lockfiles come first: they're the repo's own record of what it was installed
/// with. When none is committed (gitignored lockfile, a workspace package cloned
/// without its root lockfile), fall back to what the manifest declares —
/// Corepack's `packageManager` field, a `pnpm-workspace.yaml`, or `workspace:`/
/// `catalog:` dependency specifiers. Defaulting to npm in those cases ran the
/// one package manager the project can't be installed with (issues #707/#708).
fn preferred_package_manager(path: &Path) -> Option<String> {
    // Check in order of specificity
    if path.join("pnpm-lock.yaml").exists() {
        return Some("pnpm".to_string());
    }
    if path.join("yarn.lock").exists() {
        return Some("yarn".to_string());
    }
    if path.join("bun.lockb").exists() {
        return Some("bun".to_string());
    }

    let manifest = std::fs::read_to_string(path.join("package.json"))
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok());

    // Corepack declaration, e.g. "packageManager": "pnpm@9.0.0"
    if let Some(spec) = manifest
        .as_ref()
        .and_then(|m| m.get("packageManager"))
        .and_then(|v| v.as_str())
    {
        let name = spec.split('@').next().unwrap_or("").trim();
        if matches!(name, "pnpm" | "yarn" | "bun" | "npm") {
            return Some(name.to_string());
        }
    }

    // A pnpm workspace file is pnpm's alone.
    if path.join("pnpm-workspace.yaml").exists() || path.join("pnpm-workspace.yml").exists() {
        return Some("pnpm".to_string());
    }
    if manifest
        .as_ref()
        .is_some_and(manifest_uses_workspace_protocol)
    {
        // `workspace:` is NOT pnpm-only — Yarn 2+ (berry) uses the same
        // protocol, and `catalog:` landed in Yarn 4.9. A berry repo whose
        // yarn.lock isn't reachable (gitignored, or a package cloned without
        // its root lockfile) would otherwise get a pnpm install it can't use,
        // so check berry's own on-disk markers first.
        if path.join(".yarnrc.yml").exists() || path.join(".yarn").is_dir() {
            return Some("yarn".to_string());
        }
        return Some("pnpm".to_string());
    }

    None
}

/// Detects the package manager a project needs (lockfiles first, then the
/// manifest's own declarations), falling back to npm.
#[tauri::command]
#[tracing::instrument]
pub async fn detect_package_manager(project_path: String) -> Result<String, CommandError> {
    let path = Path::new(&project_path);

    // A lockfile names the repo's preferred manager, but the user may not have
    // that tool: running it anyway dies with a raw "'bun' is not recognized"
    // shell error (issues #454/#455). npm ships with Node (a hard app
    // dependency), so fall back to it — npm can install from any repo even if
    // it ignores the foreign lockfile.
    fn or_npm(preferred: &str) -> String {
        if crate::utils::find_executable(preferred).is_some() {
            preferred.to_string()
        } else {
            tracing::warn!(
                preferred,
                "lockfile's package manager isn't installed; falling back to npm"
            );
            "npm".to_string()
        }
    }

    match preferred_package_manager(path) {
        Some(preferred) if preferred != "npm" => Ok(or_npm(&preferred)),
        // No signal (or the project asks for npm explicitly) → npm.
        _ => Ok("npm".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GitHubRepo;

    /// Serializes the tests that touch the process-global GITHUB_USERNAME_CACHE.
    /// `invalidate_github_username_cache` clears the whole cache, so without this
    /// these tests race under cargo's default multi-threaded runner.
    static CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // The #686 contract: ImportProject.tsx special-cases the "took too long"
    // wording to suggest retrying (not re-authenticating), and errors.ts's
    // isRecognizedGitFailure matches "check your internet connection" — a
    // rewording here silently breaks both.
    #[test]
    fn gh_timeout_message_keeps_the_frontend_matched_wording() {
        assert!(GH_TIMEOUT_MESSAGE.contains("took too long"));
        assert!(GH_TIMEOUT_MESSAGE
            .to_lowercase()
            .contains("check your internet connection"));
    }

    /// The #771 mapping: a timed-out `gh repo create --push` must still read
    /// as a network condition to errors.ts's BACKEND_HUMANIZED_GIT_PHRASES,
    /// which matches on "check your internet connection".
    #[test]
    fn gh_push_timeout_message_keeps_the_frontend_matched_wording() {
        assert!(GH_PUSH_TIMEOUT_MESSAGE.contains("took too long"));
        assert!(GH_PUSH_TIMEOUT_MESSAGE
            .to_lowercase()
            .contains("check your internet connection"));
    }

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

    #[test]
    fn gh_network_error_classifies_windows_connectex_as_expected() {
        let stderr = r#"Post "https://api.github.com/graphql": dial tcp 20.207.73.85:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond."#;
        let err = gh_network_error(stderr).expect("should classify as network error");
        assert!(matches!(err, CommandError::Expected { .. }));
    }

    #[test]
    fn gh_network_error_classifies_dns_failure() {
        assert!(
            gh_network_error("error connecting to api.github.com: could not resolve host")
                .is_some()
        );
    }

    #[test]
    fn gh_git_repo_error_matches_localized_git_fatal() {
        // gh's "failed to run git:" prefix is stable English; git's own fatal
        // text is localized (Russian here) — the classification must not
        // depend on git's words (issue #403).
        let stderr = "failed to run git: fatal: не найден git репозиторий (или один из родительских каталогов): .git";
        let err = gh_git_repo_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
    }

    #[test]
    fn gh_git_repo_error_ignores_unrelated_stderr() {
        assert!(gh_git_repo_error("GraphQL: something else went wrong").is_none());
        assert!(gh_git_repo_error("").is_none());
    }

    #[test]
    fn gh_network_error_ignores_unrelated_stderr() {
        assert!(gh_network_error("GraphQL: name already exists on this account").is_none());
        assert!(gh_network_error("").is_none());
    }

    // The #602 shape: GitHub's generic HTTP 400 GraphQL response passed
    // through verbatim by gh — a transient API-side failure, not app text.
    #[test]
    fn gh_malformed_request_classifies_github_http_400_as_expected() {
        let stderr = "HTTP 400: We received a malformed request from your client. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql)";
        let err = gh_malformed_request_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        // The user-facing message must carry a retry suggestion.
        assert!(err.to_string().contains("Try again"), "got: {err}");
    }

    #[test]
    fn gh_malformed_request_ignores_unrelated_stderr() {
        assert!(gh_malformed_request_error("HTTP 404: Not Found").is_none());
        assert!(gh_malformed_request_error("").is_none());
    }

    // gh_common_error is the one-stop classifier every gh call site funnels
    // through — it must cover each shared family and stay quiet otherwise.
    #[test]
    fn gh_common_error_covers_shared_families() {
        assert!(gh_common_error("dial tcp 1.2.3.4:443: connect: connection refused").is_some());
        assert!(
            gh_common_error("HTTP 400: We received a malformed request from your client.")
                .is_some()
        );
        assert!(gh_common_error("GraphQL: something app-specific went wrong").is_none());
        assert!(gh_common_error("").is_none());
    }

    // The #610 shape: gh's Go runtime failing to reserve its heap arena at
    // startup on a memory-starved Windows box — stderr is a full crash dump.
    #[test]
    fn gh_crash_error_classifies_heap_arena_oom_as_expected() {
        let stderr = "fatal error: out of memory allocating heap arena map\n\nruntime stack:\nruntime.throw(...)\n\tC:/hostedtoolcache/windows/go/1.26.4/x64/src/runtime/panic.go:1229\nruntime.(*mheap).sysAlloc(...)\nruntime.cpuinit(...)\nruntime.schedinit(...)\nruntime.rt0_go()";
        let err = gh_crash_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("low on memory"), "got: {msg}");
        assert!(!msg.contains("runtime stack"), "must not forward the dump");
    }

    #[test]
    fn gh_crash_error_classifies_generic_go_panic() {
        let stderr = "panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 1 [running]:\ngithub.com/cli/cli/v2/pkg/cmd/root.NewCmdRoot(...)";
        let err = gh_crash_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        let fatal =
            "fatal error: concurrent map read and map write\n\nruntime stack:\nruntime.throw(...)";
        assert!(gh_crash_error(fatal).is_some());
    }

    #[test]
    fn gh_crash_error_ignores_non_crash_stderr() {
        // git's "fatal:" prefix is not a Go "fatal error:" crash.
        assert!(gh_crash_error("fatal: not a git repository").is_none());
        // "panic:"/"fatal error:" alone without a runtime dump shouldn't match.
        assert!(gh_crash_error("request failed: panic: see logs").is_none());
        assert!(gh_crash_error("").is_none());
    }

    // The #592 shape: a mid-request TCP reset returned to gh's GraphQL client.
    // "dial tcp" only covers connect-time failures; the read-time wording is
    // distinct and must classify as the same connectivity blip.
    #[test]
    fn gh_network_error_classifies_connection_reset_by_peer() {
        let stderr = r#"Post "https://api.github.com/graphql": read tcp 198.18.0.1:59334->140.82.121.6:443: read: connection reset by peer"#;
        let err = gh_network_error(stderr).expect("should classify as network error");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("Couldn't reach GitHub"));
    }

    // The #642 shape: Go's bare "EOF" (no "unexpected" prefix, which #434
    // already covered) — the connection closed before any response byte.
    #[test]
    fn gh_network_error_classifies_bare_eof() {
        let stderr = r#"Post "https://api.github.com/graphql": EOF"#;
        let err = gh_network_error(stderr).expect("should classify as network error");
        assert!(matches!(err, CommandError::Expected { .. }));
        // The "unexpected EOF" variant keeps matching too.
        assert!(
            gh_network_error(r#"Post "https://api.github.com/graphql": unexpected EOF"#).is_some()
        );
        // Bare "eof" inside an ordinary word must NOT match.
        assert!(gh_network_error("GraphQL: field thereof is deprecated").is_none());
    }

    // The #627 shape: GitHub's API answering a transient 5xx (504 from the
    // GraphQL endpoint) — server-side, retryable, not an app malfunction.
    // TLS cert-verification failures (corporate proxy / AV interception,
    // broken trust store) get their own trust-store guidance, kept out of
    // telemetry (issue #658).
    #[test]
    fn gh_tls_error_classifies_cert_verification_failure_as_expected() {
        let stderr = r#"Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: certificate signed by unknown authority"#;
        let err = gh_tls_error(stderr).expect("should classify as TLS trust failure");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = format!("{err}");
        assert!(msg.contains("couldn't be verified"), "got: {msg}");
        // Must NOT be the generic connectivity advice — retrying can't fix a
        // trust chain.
        assert!(!msg.to_lowercase().contains("internet connection"));
        // gh_common_error routes it to the TLS message, not the network one.
        let common = gh_common_error(stderr).expect("common classifier must cover TLS");
        assert!(format!("{common}").contains("couldn't be verified"));
    }

    #[test]
    fn gh_tls_error_ignores_unrelated_stderr() {
        assert!(gh_tls_error("GraphQL: name already exists on this account").is_none());
        assert!(gh_tls_error("dial tcp 1.2.3.4:443: connect: connection refused").is_none());
        assert!(gh_tls_error("tls handshake timeout").is_none());
        assert!(gh_tls_error("").is_none());
    }

    #[test]
    fn gh_server_error_classifies_github_5xx_as_expected() {
        let terse = "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)";
        let err = gh_server_error(terse).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("Try again"), "got: {err}");
        // The prose 504 variant GitHub sends for GraphQL timeouts.
        let prose = "HTTP 504: We couldn't respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql)";
        assert!(gh_server_error(prose).is_some());
        assert!(
            gh_server_error("HTTP 502: Bad Gateway (https://api.github.com/graphql)").is_some()
        );
        assert!(gh_server_error("HTTP 503: Service Unavailable").is_some());
    }

    // The #806 shape: GitHub's edge answering 499 ("Client Closed Request")
    // — not a 5xx, but the same abandoned-request blip that retrying fixes.
    #[test]
    fn gh_server_error_classifies_http_499_as_expected() {
        let stderr = "HTTP 499: 499  (https://api.github.com/graphql)";
        let err = gh_server_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("Try again"), "got: {err}");
        // And through the shared classifier every gh call site funnels into.
        assert!(gh_common_error(stderr).is_some());
    }

    #[test]
    fn gh_server_error_ignores_non_5xx_stderr() {
        assert!(gh_server_error("HTTP 404: Not Found (https://api.github.com/graphql)").is_none());
        assert!(gh_server_error("HTTP 400: We received a malformed request").is_none());
        assert!(gh_server_error("GraphQL: name already exists on this account").is_none());
        assert!(gh_server_error("").is_none());
    }

    // The #737 shape: an unrelated global npm package named `gh` resolving
    // ahead of GitHub's CLI and dying with a Node crash dump. GitHub's gh is a
    // Go binary, so Node frames mean the wrong program ran.
    #[test]
    fn gh_shadowed_binary_error_classifies_node_crash_as_expected() {
        let stderr = "node:internal/readline/interface:564\n      throw new ERR_USE_AFTER_CLOSE('readline');\n      ^\n\nError [ERR_USE_AFTER_CLOSE]: readline was closed\n    at Interface.pause (node:internal/readline/interface:564:13)\n    at PromptUI.close (C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\gh\\node_modules\\inquirer\\lib\\ui\\baseUI.js:57:13)\n\nNode.js v24.14.0";
        let err = gh_shadowed_binary_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("isn't GitHub's CLI"), "got: {msg}");
        assert!(
            msg.contains("npm uninstall -g gh"),
            "must name the fix, got: {msg}"
        );
        assert!(!msg.contains("node:internal"), "must not forward the dump");
        // Routed through the shared classifier, and ahead of gh_crash_error so
        // it doesn't get the misleading "reinstall the GitHub CLI" advice.
        let common = gh_common_error(stderr).expect("common classifier must cover it");
        assert!(format!("{common}").contains("isn't GitHub's CLI"));
    }

    #[test]
    fn gh_shadowed_binary_error_ignores_real_gh_output() {
        // A genuine Go crash stays with gh_crash_error's wording.
        assert!(gh_shadowed_binary_error(
            "panic: runtime error: nil pointer\n\ngoroutine 1 [running]:"
        )
        .is_none());
        assert!(gh_shadowed_binary_error("GraphQL: no commits between main and x").is_none());
        assert!(gh_shadowed_binary_error("").is_none());
    }

    // gh_common_error is reached from classify_git_net_error, so it also sees
    // plain `git push` stderr. A husky/Node pre-push hook crashing there is not
    // a shadowed `gh`: blaming npm would give the wrong fix and bury the real
    // failure. The dump must name a program called `gh`.
    #[test]
    fn a_node_pre_push_hook_crash_is_not_a_shadowed_gh() {
        let stderr = "node:internal/modules/cjs/loader:1215\n  throw err;\n  ^\n\nError: Cannot find module '/Users/me/proj/.husky/lint-staged.mjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1212:15)\n\nNode.js v22.3.0\nhusky - pre-push script failed (code 1)\nerror: failed to push some refs to 'https://github.com/o/r.git'";
        assert!(gh_shadowed_binary_error(stderr).is_none());
        assert!(gh_common_error(stderr).is_none());
        assert!(crate::commands::git::classify_git_net_error(stderr).is_none());
    }

    #[test]
    fn stderr_names_gh_program_needs_a_whole_path_component() {
        assert!(stderr_names_gh_program(
            "C:\\npm\\node_modules\\gh\\index.js"
        ));
        assert!(stderr_names_gh_program("/usr/local/bin/gh"));
        assert!(stderr_names_gh_program("/opt/homebrew/bin/gh.cmd:1"));
        // Near-misses that must not count.
        assert!(!stderr_names_gh_program("https://github.com/o/r.git"));
        assert!(!stderr_names_gh_program("/Users/me/gh-repos/app/index.js"));
        assert!(!stderr_names_gh_program("running the gh command"));
        assert!(!stderr_names_gh_program(""));
    }

    // The #779 pre-flight: an existing `origin` decides whether the create
    // step can run at all. A remote pointing at the repo being created means a
    // half-finished earlier run (create succeeded, push didn't) — reuse it.
    #[test]
    fn origin_matches_repo_recognizes_the_repo_being_created() {
        assert!(origin_matches_repo(
            "https://github.com/alice/my-app.git",
            "my-app"
        ));
        assert!(origin_matches_repo(
            "git@github.com:alice/my-app.git",
            "alice/my-app"
        ));
        // Case differences in GitHub repo names are not meaningful.
        assert!(origin_matches_repo(
            "https://github.com/Alice/My-App",
            "my-app"
        ));
    }

    #[test]
    fn origin_matches_repo_rejects_a_different_remote() {
        // A remote for some other project — the case that must stop the
        // create instead of leaving an orphan repo on GitHub.
        assert!(!origin_matches_repo(
            "https://github.com/alice/other-project.git",
            "my-app"
        ));
        // Same repo name under a different owner, when the owner was given.
        assert!(!origin_matches_repo(
            "https://github.com/bob/my-app.git",
            "alice/my-app"
        ));
        // Non-GitHub and unparseable remotes are never a match.
        assert!(!origin_matches_repo(
            "https://gitlab.com/alice/my-app.git",
            "my-app"
        ));
        assert!(!origin_matches_repo("", "my-app"));
        assert!(!origin_matches_repo("https://github.com/alice/my-app", ""));
    }

    // The #631 shape: gh dying at startup because its own config file is
    // unreadable — a local file-permissions problem, not a sign-in failure.
    #[test]
    fn gh_config_error_classifies_unreadable_config_as_expected() {
        let stderr = "warning: failed to load config: open /Users/x/.config/gh/config.yml: permission denied\nfailed to create root command: failed to read configuration: open /Users/x/.config/gh/config.yml: permission denied";
        let err = gh_config_error(stderr).expect("should classify as expected");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = err.to_string();
        assert!(msg.contains("chown"), "must name the real fix, got: {msg}");
        assert!(
            msg.contains("isn't a GitHub sign-in issue"),
            "must steer away from the reconnect flow, got: {msg}"
        );
    }

    #[test]
    fn gh_config_error_ignores_other_permission_or_config_errors() {
        // A repo-access permission denial is auth, not a config-file problem.
        assert!(gh_config_error("remote: Permission denied (publickey)").is_none());
        // A config parse error without a permissions component stays unclassified.
        assert!(gh_config_error("failed to read configuration: invalid yaml").is_none());
        assert!(gh_config_error("").is_none());
    }

    // The #638 shape: git falling back to an interactive credential prompt in
    // a tty-less GUI process — an auth-setup state, not an app bug.
    #[test]
    fn gh_auth_error_classifies_credential_prompt_failure() {
        let stderr =
            "fatal: could not read Username for 'https://github.com': Device not configured";
        let err = gh_auth_error(stderr).expect("should classify as auth error");
        assert!(matches!(err, CommandError::NotAuthenticated { .. }));
        assert!(gh_auth_error(
            "fatal: could not read Password for 'https://user@github.com': terminal prompts disabled"
        )
        .is_some());
        assert!(gh_auth_error("fatal: not a git repository").is_none());
    }

    // Issues #707/#708: a repo whose lockfile isn't committed but whose
    // manifest structurally requires pnpm must not be installed with npm.
    mod package_manager_detection {
        use super::*;
        use std::fs;

        fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
            let dir = tempfile::tempdir().expect("tempdir");
            for (name, contents) in files {
                fs::write(dir.path().join(name), contents).expect("write");
            }
            dir
        }

        #[test]
        fn lockfiles_still_win() {
            let dir = project(&[("pnpm-lock.yaml", ""), ("package.json", "{}")]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
            let dir = project(&[("yarn.lock", "")]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("yarn")
            );
            let dir = project(&[("bun.lockb", "")]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("bun")
            );
        }

        #[test]
        fn corepack_package_manager_field_is_honored_without_a_lockfile() {
            let dir = project(&[(
                "package.json",
                r#"{"name":"x","packageManager":"pnpm@9.0.0"}"#,
            )]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
        }

        #[test]
        fn workspace_and_catalog_specifiers_select_pnpm() {
            let dir = project(&[(
                "package.json",
                r#"{"dependencies":{"@acme/ui":"workspace:*"}}"#,
            )]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
            let dir = project(&[(
                "package.json",
                r#"{"devDependencies":{"eslint":"catalog:lint"}}"#,
            )]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
        }

        // `workspace:` is Yarn 2+'s protocol too, so berry's own markers decide
        // before the pnpm fallback does — otherwise a berry repo without a
        // reachable yarn.lock gets a pnpm install it can't use.
        #[test]
        fn yarn_berry_markers_beat_the_workspace_protocol_fallback() {
            let dir = project(&[
                (
                    "package.json",
                    r#"{"dependencies":{"@acme/ui":"workspace:*"}}"#,
                ),
                (".yarnrc.yml", "nodeLinker: node-modules\n"),
            ]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("yarn")
            );

            // A `.yarn/` directory (releases, plugins, cache) counts the same.
            let dir = project(&[(
                "package.json",
                r#"{"devDependencies":{"eslint":"catalog:lint"}}"#,
            )]);
            fs::create_dir(dir.path().join(".yarn")).expect("mkdir");
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("yarn")
            );

            // A pnpm workspace file is still pnpm's alone, berry markers or not.
            let dir = project(&[
                ("pnpm-workspace.yaml", "packages:\n  - apps/*\n"),
                (".yarnrc.yml", ""),
            ]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
        }

        #[test]
        fn pnpm_workspace_file_selects_pnpm() {
            let dir = project(&[("pnpm-workspace.yaml", "packages:\n  - apps/*\n")]);
            assert_eq!(
                preferred_package_manager(dir.path()).as_deref(),
                Some("pnpm")
            );
        }

        #[test]
        fn plain_npm_projects_keep_falling_back_to_npm() {
            let dir = project(&[("package.json", r#"{"dependencies":{"react":"^19.0.0"}}"#)]);
            assert_eq!(preferred_package_manager(dir.path()), None);
            // Unparseable or absent manifests must not panic or misdetect.
            let dir = project(&[("package.json", "not json {")]);
            assert_eq!(preferred_package_manager(dir.path()), None);
            let dir = project(&[]);
            assert_eq!(preferred_package_manager(dir.path()), None);
        }
    }
}
