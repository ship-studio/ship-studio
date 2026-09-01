/**
 * Plugin lifecycle commands: listing, installing, uninstalling, updating, and toggling plugins.
 */
use crate::errors::CommandError;
use crate::utils::{create_command, find_executable, get_extended_path};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::{
    check_min_app_version, get_plugins_dir, now_ms, read_git_head, read_manifest, read_registry,
    validate_plugin_id, validate_required_commands, warn_on_setup_items, write_registry,
    PluginInfo, PluginUpdateCheck, RegistryEntry,
};

/// Validate a git URL before passing it to `git clone`.
///
/// Blocks two classes of attack:
/// 1. Argument injection — a value starting with `-` is interpreted by git as a
///    flag rather than a URL.
/// 2. Local/command-executing transports — git's `ext::` transport runs an
///    arbitrary command, and `file://`/bare local paths can pull from anywhere
///    on disk. Only network transports to a remote host are allowed.
///
/// Every refusal here is `Expected`: the URL is user input, so a bad one is the
/// app working correctly, not a malfunction to auto-report (issue #803).
fn validate_clone_url(url: &str) -> Result<(), CommandError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(CommandError::expected("Plugin repository URL is empty"));
    }
    if trimmed.starts_with('-') {
        return Err(CommandError::expected("Invalid plugin repository URL"));
    }
    let lowered = trimmed.to_ascii_lowercase();
    let allowed = lowered.starts_with("https://")
        || lowered.starts_with("git://")
        || lowered.starts_with("ssh://")
        || lowered.starts_with("git@");
    if !allowed {
        return Err(CommandError::expected(
            "Plugin repository URL must be an https://, ssh://, git:// or git@ remote",
        ));
    }
    // A link to a *page inside* a repository (GitHub's /blob/ or /tree/ web
    // views) is well-formed but not clonable — pasting a docs page URL is a
    // common mistake, and it used to sail through validation and only fail on
    // git's "repository not found" 404 (issue #803). Reject it up front with
    // wording that points at the repository root.
    if lowered.contains("/blob/") || lowered.contains("/tree/") {
        return Err(CommandError::expected(
            "That link points at a page inside a repository, not the repository itself. \
             Use the repository's main URL (e.g. https://github.com/owner/repo).",
        ));
    }
    Ok(())
}

/// Network-git failures that are the user's URL, credentials, or connection —
/// not a Ship Studio defect. `Some(Expected)` with actionable wording for the
/// shapes we recognize (issues #803, #732); `None` for anything else so a
/// genuinely novel git failure still reaches telemetry with its raw stderr.
fn classify_remote_git_failure(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    // git fell back to an interactive credential prompt and there's no tty in a
    // GUI-spawned process, so it dies with "Device not configured" (macOS) or
    // "terminal prompts disabled" (with GIT_TERMINAL_PROMPT=0). Mirrors
    // github.rs's gh_auth_error / publishing.rs's push_auth_error (issue #732).
    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("authentication failed")
    {
        return Some(CommandError::expected(
            "This plugin's repository requires sign-in, and Ship Studio can't authenticate to \
             it automatically. Use a plugin hosted in a public repository, or clone it yourself \
             and add it with Link Dev Plugin.",
        ));
    }
    // A mistyped, renamed, deleted, or private repository URL (issue #803).
    if lower.contains("repository not found")
        || lower.contains("could not read from remote repository")
        || (lower.contains("not found") && lower.contains("fatal:"))
    {
        return Some(CommandError::expected(
            "Couldn't find a git repository at that URL. Double-check the plugin's repository \
             link — it may be mistyped, private, renamed, or deleted.",
        ));
    }
    // Offline / DNS / firewall — the machine's network, not the app.
    if lower.contains("could not resolve host")
        || lower.contains("could not resolve proxy")
        || lower.contains("connection timed out")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
    {
        return Some(CommandError::expected(
            "Couldn't reach the plugin's repository — check your internet connection and \
             try again.",
        ));
    }
    None
}

/// [`classify_remote_git_failure`] with the clone call sites' raw fallback.
fn classify_clone_failure(stderr: &str) -> CommandError {
    classify_remote_git_failure(stderr)
        .unwrap_or_else(|| CommandError::from(format!("Git clone failed: {stderr}")))
}

/// Run `git clone` for a plugin, with the shared spawn-pressure retry and the
/// no-interactive-prompt guard.
///
/// * The spawn is retried on transient EAGAIN/EMFILE (a one-shot install used
///   to die outright on momentary process-table pressure, issue #774).
/// * `GIT_TERMINAL_PROMPT=0` makes a credential-requiring host fail fast
///   instead of blocking on a prompt no one can answer, matching `run_git_net`
///   in `commands/git/mod.rs` (issue #732).
fn run_plugin_clone(
    git: &Path,
    repo_url: &str,
    dest: &Path,
) -> Result<std::process::Output, CommandError> {
    let dest = dest.to_string_lossy().to_string();
    crate::external_command::spawn_with_pressure_retry("git clone", || {
        create_command(git)
            .args(["clone", "--depth", "1", "--", repo_url, &dest])
            .env("PATH", get_extended_path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
    })
}

/// `remove_dir_all_relaxed` with the same backoff `rename_with_retry` uses.
/// A stale `.tmp-install` left by a previous run can be transiently locked
/// (Windows AV/indexer, a cloud-sync daemon); the old single best-effort
/// attempt silently gave up, and `git clone` then failed with the baffling
/// "destination path already exists" (issue #839).
fn remove_dir_all_with_retry(dir: &Path) -> std::io::Result<()> {
    let mut result = remove_dir_all_relaxed(dir);
    let mut delay = std::time::Duration::from_millis(100);
    for _ in 0..4 {
        if result.is_ok() || !dir.exists() {
            return Ok(());
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(std::time::Duration::from_millis(800));
        result = remove_dir_all_relaxed(dir);
    }
    result
}

/// Resolve the `git` executable to an absolute path, mirroring how the setup
/// wizard checks for git. Spawning bare `"git"` with an overridden `PATH` can
/// fail to resolve on Windows even when git is installed; resolving the full
/// path first avoids that and lets us return a clear "install git" error.
fn resolve_git() -> Result<PathBuf, CommandError> {
    find_executable("git").ok_or_else(|| {
        // A missing tool is an environment gap, not an app malfunction.
        CommandError::expected(
            "Git isn't installed or couldn't be located. Install Git (https://git-scm.com) \
             and restart Ship Studio, then try again.",
        )
    })
}

/// `fs::rename` with retries and a copy fallback. On Windows a rename fails
/// with a sharing violation / "Access is denied" while antivirus or the search
/// indexer scans files git just wrote. The old ~600ms retry window regularly
/// lost that race — Defender scans of a fresh clone can hold locks for
/// seconds (issue #244) — so back off up to ~5s, then fall back to
/// copy+delete: copying only needs read access to the source files, not the
/// exclusive lock on the whole tree that a rename requires.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut result = fs::rename(from, to);
    let mut delay = std::time::Duration::from_millis(100);
    for _ in 0..6 {
        if result.is_ok() {
            return Ok(());
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(std::time::Duration::from_millis(1600));
        result = fs::rename(from, to);
    }
    let Err(rename_err) = result else {
        return Ok(());
    };
    tracing::warn!(
        "rename {} -> {} still failing after retries ({rename_err}); falling back to copy",
        from.display(),
        to.display()
    );
    if let Err(copy_err) = copy_dir_recursive(from, to) {
        // Don't leave a half-copied plugin behind — it would load broken.
        let _ = remove_dir_all_relaxed(to);
        return Err(copy_err);
    }
    // Source cleanup is best-effort: the plugin is installed either way, and
    // the stale `.tmp-install` dir is cleared at the start of the next install.
    let _ = remove_dir_all_relaxed(from);
    Ok(())
}

/// Recursively copy a directory tree. Fallback path for `rename_with_retry`.
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// `fs::remove_dir_all` that first clears read-only attributes. Git marks pack
/// files under `.git` read-only, which makes a plain `remove_dir_all` fail on
/// Windows with "Access is denied".
fn remove_dir_all_relaxed(dir: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    clear_readonly_recursive(dir);
    fs::remove_dir_all(dir)
}

/// Recursively clear the read-only flag on every file under `dir` so it can be
/// deleted. Best-effort: unreadable entries are skipped.
#[cfg(windows)]
fn clear_readonly_recursive(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            clear_readonly_recursive(&entry.path());
        } else {
            let mut perms = metadata.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = fs::set_permissions(entry.path(), perms);
            }
        }
    }
}

/// Normalize a git remote URL to a comparable `host/path` form: trims
/// whitespace/trailing slashes/a trailing `.git`, drops the scheme and any
/// `user@` in the authority, folds scp-style `git@host:owner/repo` into
/// `host/owner/repo`, and lower-cases the host (paths stay case-sensitive).
///
/// Mirrors `normalizeRepoUrl` in `src/lib/pluginRepoUrl.ts` — keep in sync.
fn normalize_repo_url(url: &str) -> String {
    let mut u = url.trim().to_string();

    // scp-style: git@host:owner/repo (no slash before the colon)
    if let Some(rest) = u.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            if !host.contains('/') && !host.is_empty() {
                u = format!("{host}/{path}");
            }
        }
    }

    // Drop scheme://
    if let Some(idx) = u.find("://") {
        let scheme_ok = !u[..idx].is_empty()
            && u[..idx]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
        if scheme_ok {
            u = u[idx + 3..].to_string();
        }
    }

    // Drop user@ in the authority (never past the first '/')
    if let Some(at) = u.find('@') {
        let slash = u.find('/').unwrap_or(u.len());
        if at < slash {
            u = u[at + 1..].to_string();
        }
    }

    let mut u = u.trim_end_matches('/').to_string();
    if u.to_ascii_lowercase().ends_with(".git") {
        u.truncate(u.len() - 4);
    }
    let u = u.trim_end_matches('/');

    match u.find('/') {
        Some(slash) => format!("{}{}", u[..slash].to_ascii_lowercase(), &u[slash..]),
        None => u.to_ascii_lowercase(),
    }
}

/// True when two repo URLs identify the same repository after normalization.
/// Empty URLs never match (dev plugins have no source URL).
fn repo_urls_match(a: &str, b: &str) -> bool {
    let na = normalize_repo_url(a);
    !na.is_empty() && na == normalize_repo_url(b)
}

/// List all installed plugins for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_plugins(project_path: String) -> Result<Vec<PluginInfo>, CommandError> {
    let registry = read_registry(&project_path)?;
    let plugins_dir = get_plugins_dir(&project_path)?;
    let mut results = Vec::new();

    for entry in &registry.plugins {
        let plugin_dir = if entry.is_dev {
            PathBuf::from(&entry.local_path)
        } else {
            plugins_dir.join(&entry.plugin_id)
        };
        match read_manifest(&plugin_dir) {
            Ok(manifest) => {
                results.push(PluginInfo {
                    manifest,
                    enabled: entry.enabled,
                    installed_at: entry.installed_at,
                    source_url: entry.source_url.clone(),
                    is_dev: entry.is_dev,
                    local_path: entry.local_path.clone(),
                });
            }
            Err(e) => {
                tracing::warn!("Skipping plugin {}: {}", entry.plugin_id, e);
            }
        }
    }

    Ok(results)
}

/// Install a plugin from a GitHub repository URL into a project
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn install_plugin(
    app: AppHandle,
    project_path: String,
    repo_url: String,
) -> Result<PluginInfo, CommandError> {
    validate_clone_url(&repo_url)?;

    let plugins_dir = get_plugins_dir(&project_path)?;
    // classify_fs_error, like write_registry: a denied/read-only project folder
    // is an environment state with a user-side fix, not telemetry (#762/#831).
    fs::create_dir_all(&plugins_dir).map_err(|e| {
        crate::utils::classify_fs_error("create this project's plugins folder", &plugins_dir, &e)
    })?;

    let git = resolve_git()?;

    // Clone into a temp directory first, then move. A leftover .tmp-install
    // from an interrupted run must actually be gone before the clone: git's
    // own "destination path already exists" is unactionable for a directory
    // the user never made and can't see (issue #839).
    let temp_dir = plugins_dir.join(".tmp-install");
    if temp_dir.exists() {
        remove_dir_all_with_retry(&temp_dir).map_err(|e| {
            CommandError::expected(format!(
                "Couldn't clear the leftover install folder at {} ({e}). Something else is \
                 holding it open — close other apps that may be scanning or syncing this \
                 project, then try again.",
                temp_dir.display()
            ))
        })?;
    }

    let output = run_plugin_clone(&git, &repo_url, &temp_dir)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(classify_clone_failure(&stderr));
    }

    // Read manifest to get plugin ID
    let manifest = match read_manifest(&temp_dir) {
        Ok(m) => m,
        Err(e) => {
            let _ = remove_dir_all_relaxed(&temp_dir);
            // Repo-content problems (manifest not at root, bad JSON) are the
            // plugin author's input, not an app malfunction (issue #472).
            return Err(CommandError::expected(format!("Invalid plugin: {e}")));
        }
    };

    warn_on_setup_items(&manifest);

    // Validate the built bundle exists before registering anything — a repo
    // without a committed dist/ otherwise installs "successfully" and only
    // fails later with a confusing "Plugin bundle not found" when the app
    // tries to load it (issue #381). Mirrors link_dev_plugin's check.
    if !temp_dir.join("dist").join("index.js").exists() {
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(CommandError::expected(
            "This plugin can't be installed: its repository has no built bundle (dist/index.js). \
             The plugin author needs to build it and commit the dist folder.",
        ));
    }

    // Validate manifest has required fields
    if manifest.id.is_empty() || manifest.name.is_empty() {
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(CommandError::expected(
            "Plugin manifest must have 'id' and 'name' fields",
        ));
    }

    // Validate plugin ID is safe for filesystem
    if manifest.id.contains('/')
        || manifest.id.contains('\\')
        || manifest.id.contains("..")
        || manifest.id.starts_with('.')
    {
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(CommandError::expected(
            "Plugin ID contains invalid characters",
        ));
    }

    // Check min_app_version compatibility — a version/content mismatch is a
    // by-design refusal, not an app malfunction (issue #472).
    if let Err(e) = check_min_app_version(&manifest, &app) {
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(CommandError::expected(e));
    }

    // Validate required_commands are all in the allowed set (same: #472).
    if let Err(e) = validate_required_commands(&manifest) {
        let _ = remove_dir_all_relaxed(&temp_dir);
        return Err(CommandError::expected(e));
    }

    // Read the commit hash and strip `.git` while still in the temp dir, BEFORE
    // the move. On Windows the move (rename) fails if any handle is open in the
    // source tree, and git leaves read-only pack files under `.git` that scanners
    // briefly hold — moving a directory with no `.git` avoids both problems.
    let commit_hash = read_git_head(&temp_dir);
    let temp_git_dir = temp_dir.join(".git");
    if temp_git_dir.exists() {
        let _ = remove_dir_all_relaxed(&temp_git_dir);
    }

    let plugin_dir = plugins_dir.join(&manifest.id);

    // Remove existing version if present
    if plugin_dir.exists() {
        remove_dir_all_relaxed(&plugin_dir)
            .map_err(|e| format!("Failed to remove existing plugin: {e}"))?;
    }

    // Move temp to final location (retried — Windows scanners transiently lock
    // freshly written files).
    rename_with_retry(&temp_dir, &plugin_dir).map_err(|e| {
        let _ = remove_dir_all_relaxed(&temp_dir);
        format!("Failed to move plugin to final location: {e}")
    })?;

    // Update registry
    let mut registry = read_registry(&project_path)?;

    // Remove the old entry if it exists — matched by manifest id, and also by
    // source URL so a plugin whose manifest id changed upstream (slug rename)
    // replaces the old install instead of duplicating it. Stale directories
    // left by a renamed id are cleaned up best-effort.
    let mut stale_dirs: Vec<PathBuf> = Vec::new();
    registry.plugins.retain(|e| {
        let same_id = e.plugin_id == manifest.id;
        let same_source = !e.is_dev && repo_urls_match(&e.source_url, &repo_url);
        if same_source && !same_id && validate_plugin_id(&e.plugin_id).is_ok() {
            stale_dirs.push(plugins_dir.join(&e.plugin_id));
        }
        !same_id && !same_source
    });
    for dir in stale_dirs {
        if dir.exists() {
            if let Err(e) = fs::remove_dir_all(&dir) {
                tracing::warn!("Failed to remove stale plugin dir {}: {e}", dir.display());
            }
        }
    }

    let entry = RegistryEntry {
        plugin_id: manifest.id.clone(),
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url.clone(),
        installed_commit: commit_hash,
        is_dev: false,
        local_path: String::new(),
    };

    registry.plugins.push(entry);
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: true,
        installed_at: now_ms(),
        source_url: repo_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Uninstall a plugin by its ID from a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn uninstall_plugin(project_path: String, plugin_id: String) -> Result<(), CommandError> {
    // Reject traversal-style IDs before joining onto the plugins dir — this
    // command calls remove_dir_all on the result without requiring registry
    // membership, so an unchecked `../../x` would delete outside .shipstudio.
    validate_plugin_id(&plugin_id)?;

    // Guard: dev plugins should use unlink instead
    let registry = read_registry(&project_path)?;
    if let Some(entry) = registry.plugins.iter().find(|e| e.plugin_id == plugin_id) {
        if entry.is_dev {
            return Err(
                ("Dev plugins cannot be uninstalled. Use Unlink instead.".to_string()).into(),
            );
        }
    }

    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    // Remove plugin directory
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| format!("Failed to remove plugin directory: {e}"))?;
    }

    // Update registry
    let mut registry = read_registry(&project_path)?;
    registry.plugins.retain(|e| e.plugin_id != plugin_id);
    write_registry(&project_path, &registry)?;

    Ok(())
}

/// Update a plugin by pulling latest from its source repository
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn update_plugin(
    app: AppHandle,
    project_path: String,
    plugin_id: String,
) -> Result<PluginInfo, CommandError> {
    validate_plugin_id(&plugin_id)?;
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' not found in registry"))?;

    let source_url = entry.source_url.clone();
    let was_enabled = entry.enabled;

    validate_clone_url(&source_url)?;

    let git = resolve_git()?;

    // Re-install from source (clean install)
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);

    if plugin_dir.exists() {
        remove_dir_all_relaxed(&plugin_dir)
            .map_err(|e| format!("Failed to remove old plugin: {e}"))?;
    }

    // Clone fresh
    let output = run_plugin_clone(&git, &source_url, &plugin_dir)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_clone_failure(&stderr));
    }

    // Validate the built bundle exists — same guard as install_plugin (issue
    // #381). Without it an update from a repo whose dist/ was removed would
    // leave a registered-but-unloadable plugin, exactly the broken state the
    // self-heal path (issue #624) exists to repair.
    if !plugin_dir.join("dist").join("index.js").exists() {
        let _ = remove_dir_all_relaxed(&plugin_dir);
        return Err(CommandError::expected(
            "This plugin can't be updated: its repository has no built bundle (dist/index.js). \
             The plugin author needs to build it and commit the dist folder.",
        ));
    }

    // Read commit hash before removing .git
    let commit_hash = read_git_head(&plugin_dir);

    // Remove .git directory (relaxed — git leaves read-only pack files that a
    // plain remove_dir_all can't delete on Windows).
    let git_dir = plugin_dir.join(".git");
    if git_dir.exists() {
        let _ = remove_dir_all_relaxed(&git_dir);
    }

    let manifest = read_manifest(&plugin_dir)?;

    warn_on_setup_items(&manifest);

    // Check min_app_version compatibility
    check_min_app_version(&manifest, &app)?;

    // Validate required_commands are all in the allowed set
    validate_required_commands(&manifest)?;

    // Update registry entry (preserve enabled state, update commit hash)
    let mut registry = read_registry(&project_path)?;
    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = was_enabled;
        entry.installed_commit = commit_hash;
    }
    write_registry(&project_path, &registry)?;

    Ok(PluginInfo {
        manifest,
        enabled: was_enabled,
        installed_at: now_ms(),
        source_url,
        is_dev: false,
        local_path: String::new(),
    })
}

/// Check if a plugin has an update available by comparing commit hashes
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn check_plugin_update(
    project_path: String,
    plugin_id: String,
) -> Result<PluginUpdateCheck, CommandError> {
    let registry = read_registry(&project_path)?;
    let entry = registry
        .plugins
        .iter()
        .find(|e| e.plugin_id == plugin_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' not found in registry"))?;

    if entry.is_dev {
        return Err(
            "Dev plugins do not support remote update checks. Use Reload instead."
                .to_string()
                .into(),
        );
    }

    let source_url = entry.source_url.clone();
    let installed_commit = entry.installed_commit.clone();

    // Get installed version from manifest
    let plugins_dir = get_plugins_dir(&project_path)?;
    let plugin_dir = plugins_dir.join(&plugin_id);
    let manifest = read_manifest(&plugin_dir)?;
    let installed_version = manifest.version.clone();

    // Get remote HEAD commit via git ls-remote
    // Same guards as the clone paths: no interactive credential prompt with no
    // tty to answer it (#732), an EAGAIN-tolerant spawn (#774), and Expected
    // classification for URL/auth/offline failures (#803). This one runs
    // unattended for every installed plugin on each Plugin Manager open, so an
    // unreachable remote would otherwise file a report per plugin per open.
    let git = resolve_git()?;
    let output = crate::external_command::spawn_with_pressure_retry("git ls-remote", || {
        create_command(&git)
            .args(["ls-remote", &source_url, "HEAD"])
            .env("PATH", get_extended_path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_remote_git_failure(&stderr)
            .unwrap_or_else(|| CommandError::from(format!("Failed to check remote: {stderr}"))));
    }

    let remote_output = String::from_utf8_lossy(&output.stdout);
    let remote_commit = remote_output
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();

    // If we don't have an installed commit hash (legacy install), assume update available
    let has_update = if installed_commit.is_empty() {
        true
    } else {
        !remote_commit.is_empty() && remote_commit != installed_commit
    };

    Ok(PluginUpdateCheck {
        has_update,
        installed_version,
        installed_commit,
        remote_commit,
    })
}

/// Toggle a plugin's enabled state
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn toggle_plugin(
    project_path: String,
    plugin_id: String,
    enabled: bool,
) -> Result<(), CommandError> {
    let mut registry = read_registry(&project_path)?;

    if let Some(entry) = registry
        .plugins
        .iter_mut()
        .find(|e| e.plugin_id == plugin_id)
    {
        entry.enabled = enabled;
        write_registry(&project_path, &registry)?;
        Ok(())
    } else {
        Err(CommandError::expected(format!(
            "Plugin '{plugin_id}' not found"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_clone_failure, classify_remote_git_failure, normalize_repo_url,
        remove_dir_all_relaxed, remove_dir_all_with_retry, rename_with_retry, repo_urls_match,
        validate_clone_url, CommandError,
    };
    use std::fs;

    #[test]
    fn accepts_normal_remotes() {
        for url in [
            "https://github.com/owner/repo",
            "https://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git://example.com/repo.git",
            "git@github.com:owner/repo.git",
        ] {
            assert!(validate_clone_url(url).is_ok(), "should accept {url}");
        }
    }

    #[test]
    fn rejects_command_executing_transports() {
        // git's ext:: transport runs an arbitrary command during clone.
        assert!(validate_clone_url("ext::sh -c 'touch /tmp/pwned'").is_err());
        assert!(validate_clone_url("file:///etc/passwd").is_err());
        assert!(validate_clone_url("/some/local/path").is_err());
    }

    #[test]
    fn normalizes_repo_url_variants() {
        assert_eq!(
            normalize_repo_url("https://github.com/owner/repo.git"),
            "github.com/owner/repo"
        );
        assert_eq!(
            normalize_repo_url("https://github.com/owner/repo/"),
            "github.com/owner/repo"
        );
        assert_eq!(
            normalize_repo_url("git@github.com:owner/repo.git"),
            "github.com/owner/repo"
        );
        assert_eq!(
            normalize_repo_url("ssh://git@github.com/owner/repo.git"),
            "github.com/owner/repo"
        );
        // Host is case-insensitive, path is not
        assert_eq!(
            normalize_repo_url("https://GitHub.COM/Owner/Repo"),
            "github.com/Owner/Repo"
        );
        // An @ in the path is not a user
        assert_eq!(
            normalize_repo_url("https://github.com/owner/repo@v2"),
            "github.com/owner/repo@v2"
        );
    }

    #[test]
    fn matches_equivalent_repo_urls() {
        assert!(repo_urls_match(
            "https://github.com/ship-studio/plugin-figma",
            "git@github.com:ship-studio/plugin-figma.git"
        ));
        assert!(repo_urls_match(
            "https://github.com/ship-studio/plugin-figma/",
            "HTTPS://GITHUB.com/ship-studio/plugin-figma.git"
        ));
        assert!(!repo_urls_match(
            "https://github.com/ship-studio/plugin-figma",
            "https://github.com/ship-studio/plugin-vercel"
        ));
        // Dev plugins have empty source URLs — never match
        assert!(!repo_urls_match("", ""));
        assert!(!repo_urls_match("", "https://github.com/a/b"));
    }

    #[test]
    fn removes_dir_with_readonly_files() {
        // Mirrors what git leaves under `.git`: read-only files that a plain
        // remove_dir_all can't delete on Windows.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir_all(root.join("objects")).unwrap();
        let file = root.join("objects").join("pack");
        fs::write(&file, b"data").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms).unwrap();

        remove_dir_all_relaxed(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn rename_with_retry_moves_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("src");
        let to = tmp.path().join("dst");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("f.txt"), b"x").unwrap();

        rename_with_retry(&from, &to).unwrap();
        assert!(!from.exists());
        assert!(to.join("f.txt").exists());
    }

    #[test]
    fn copy_dir_recursive_copies_nested_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("src");
        let to = tmp.path().join("dst");
        fs::create_dir_all(from.join("a/b")).unwrap();
        fs::write(from.join("top.txt"), b"1").unwrap();
        fs::write(from.join("a/mid.txt"), b"2").unwrap();
        fs::write(from.join("a/b/leaf.txt"), b"3").unwrap();

        super::copy_dir_recursive(&from, &to).unwrap();
        assert_eq!(fs::read(to.join("top.txt")).unwrap(), b"1");
        assert_eq!(fs::read(to.join("a/mid.txt")).unwrap(), b"2");
        assert_eq!(fs::read(to.join("a/b/leaf.txt")).unwrap(), b"3");
        // Source is untouched by the copy itself.
        assert!(from.join("a/b/leaf.txt").exists());
    }

    #[test]
    fn rejects_repository_page_urls() {
        // A GitHub docs page isn't clonable — issue #803's actual occurrence.
        for url in [
            "https://github.com/ship-studio/ship-studio/blob/main/docs/plugins.md",
            "https://github.com/owner/repo/tree/main/packages/plugin",
        ] {
            let err = validate_clone_url(url).unwrap_err();
            assert!(matches!(err, CommandError::Expected { .. }));
            assert!(err.to_string().contains("repository's main URL"));
        }
    }

    #[test]
    fn url_refusals_are_expected_not_telemetry() {
        // Bad user input is the app working correctly, not a bug to file.
        for url in ["", "-oProxyCommand=evil", "file:///etc/passwd"] {
            assert!(matches!(
                validate_clone_url(url),
                Err(CommandError::Expected { .. })
            ));
        }
    }

    #[test]
    fn classifies_missing_repository_as_expected() {
        // Issue #803: a mistyped/deleted/private repo URL.
        let err = classify_clone_failure(
            "Cloning into '.tmp-install'...\n\
             fatal: repository 'https://github.com/owner/nope/' not found\n",
        );
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("Couldn't find a git repository"));
    }

    #[test]
    fn classifies_credential_prompt_as_expected() {
        // Issue #732: no tty for git's interactive credential prompt.
        let err = classify_clone_failure(
            "fatal: could not read Username for 'https://replit-mcp.com': Device not configured\n",
        );
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(err.to_string().contains("requires sign-in"));
        // …including the wording GIT_TERMINAL_PROMPT=0 itself produces.
        assert!(classify_remote_git_failure(
            "fatal: could not read Username for 'https://x.dev': terminal prompts disabled"
        )
        .is_some());
    }

    #[test]
    fn classifies_offline_clone_as_expected() {
        let err = classify_clone_failure(
            "fatal: unable to access '...': Could not resolve host: github.com",
        );
        assert!(matches!(err, CommandError::Expected { .. }));
    }

    #[test]
    fn leaves_unrecognized_clone_failures_reportable() {
        // Anything we don't recognize must keep reaching telemetry raw.
        assert!(classify_remote_git_failure("error: object file is empty").is_none());
        let err = classify_clone_failure("error: object file is empty");
        assert!(matches!(err, CommandError::Other { .. }));
        assert!(err.to_string().starts_with("Git clone failed:"));
    }

    #[test]
    fn remove_dir_all_with_retry_clears_stale_tmp_install() {
        // Issue #839: the leftover temp dir must actually be gone, otherwise
        // git fails with an unactionable "destination path already exists".
        let tmp = tempfile::tempdir().unwrap();
        let stale = tmp.path().join(".tmp-install");
        fs::create_dir_all(stale.join("dist")).unwrap();
        fs::write(stale.join("dist/index.js"), b"x").unwrap();

        remove_dir_all_with_retry(&stale).unwrap();
        assert!(!stale.exists());
        // Already-gone is success, not an error.
        remove_dir_all_with_retry(&stale).unwrap();
    }

    #[test]
    fn rejects_argument_injection() {
        // A leading dash would be parsed by `git clone` as a flag, not a URL.
        assert!(validate_clone_url("--upload-pack=touch /tmp/x").is_err());
        assert!(validate_clone_url("-oProxyCommand=evil").is_err());
        assert!(validate_clone_url("").is_err());
        assert!(validate_clone_url("   ").is_err());
    }
}
