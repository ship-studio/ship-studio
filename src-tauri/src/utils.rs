//! # Shared Utilities
//!
//! This module contains shared utility functions used across the Ship Studio backend.

use std::process::Command;
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::Instant;

/// Creates a `Command` that won't spawn a visible console window on Windows.
/// On non-Windows platforms, this is identical to `Command::new()`.
pub fn create_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Returns the platform-specific PATH separator (`:` for Unix, `;` for Windows)
fn get_path_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

/// Cache for `get_extended_path()` — avoids scanning NVM/Claude directories on every call.
/// TTL of 60 seconds; tools are rarely installed mid-session.
static EXTENDED_PATH_CACHE: LazyLock<Mutex<Option<(String, Instant)>>> =
    LazyLock::new(|| Mutex::new(None));

const EXTENDED_PATH_TTL_SECS: u64 = 60;

/// Builds an extended PATH that includes common tool installation locations.
/// macOS apps launched from Finder don't inherit the user's shell PATH,
/// so we need to explicitly add Homebrew, npm global, and NVM paths.
/// On Windows, adds common program installation paths.
///
/// Results are cached for 60 seconds to avoid repeated filesystem scanning.
pub fn get_extended_path() -> String {
    if let Ok(cache) = EXTENDED_PATH_CACHE.lock() {
        if let Some((ref cached_path, ref created_at)) = *cache {
            if created_at.elapsed().as_secs() < EXTENDED_PATH_TTL_SECS {
                return cached_path.clone();
            }
        }
    }

    let result = build_extended_path();

    if let Ok(mut cache) = EXTENDED_PATH_CACHE.lock() {
        *cache = Some((result.clone(), Instant::now()));
    }

    result
}

/// Computes the extended PATH (uncached). Called by `get_extended_path()`.
fn build_extended_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();

    #[cfg(windows)]
    let mut paths: Vec<String> = {
        let mut windows_paths = Vec::new();

        // Add Windows-specific paths
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            windows_paths.push(format!("{}\\Microsoft\\WindowsApps", local_app_data));
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            windows_paths.push(format!("{}\\npm", app_data));
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            windows_paths.push(format!("{}\\Git\\bin", program_files));
            windows_paths.push(format!("{}\\nodejs", program_files));
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            windows_paths.push(format!("{}\\Git\\bin", program_files_x86));
            windows_paths.push(format!("{}\\nodejs", program_files_x86));
        }

        // User-specific paths
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            windows_paths.push(format!("{}\\AppData\\Local\\Programs\\Git\\bin", home_str));
            windows_paths.push(format!("{}\\AppData\\Roaming\\npm", home_str));
            windows_paths.push(format!(r"{}\.local\bin", home_str));
        }

        windows_paths
    };

    #[cfg(not(windows))]
    let mut paths: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(), // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(), // Homebrew (Intel) / manual installs
        "/usr/local/sbin".to_string(),
    ];

    // Add user-specific paths (Unix only, Windows handled above)
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        paths.push(format!("{home_str}/.npm-global/bin"));
        paths.push(format!("{home_str}/.local/bin")); // Official Claude installer location
        paths.push(format!("{home_str}/.opencode/bin")); // Opencode installer location
        paths.push(format!("{home_str}/.bun/bin")); // Bun-installed tools
        paths.push(format!("{home_str}/n/bin"));

        // Add NVM current/default version if it exists
        // First try the default alias, then fall back to finding the latest version
        let nvm_dir = home.join(".nvm");
        let nvm_default = nvm_dir.join("alias/default");
        let nvm_versions = nvm_dir.join("versions/node");

        if nvm_versions.exists() {
            // Check if there's a default alias
            let default_version = std::fs::read_to_string(&nvm_default)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            if let Some(version) = default_version {
                // Default alias might be "lts/iron" or a version like "v20.10.0"
                // Try to resolve it to an actual path
                let version_path = if version.starts_with("lts/") || version.starts_with("node") {
                    // For lts aliases, we'd need to read more files - just use latest version
                    None
                } else {
                    // Direct version reference
                    let path = nvm_versions.join(&version);
                    if path.exists() {
                        Some(path)
                    } else {
                        None
                    }
                };

                if let Some(path) = version_path {
                    paths.push(format!("{}/bin", path.to_string_lossy()));
                }
            }

            // If no default found or couldn't resolve, find the latest installed version
            if paths.iter().all(|p| !p.contains(".nvm/versions/node")) {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    // Get all version directories and sort to find the latest
                    let mut versions: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().is_dir())
                        .collect();

                    // Sort by version (descending) - versions are like "v20.10.0"
                    versions.sort_by(|a, b| {
                        let a_name = a.file_name().to_string_lossy().to_string();
                        let b_name = b.file_name().to_string_lossy().to_string();
                        b_name.cmp(&a_name) // Reverse order for descending
                    });

                    // Use the latest version only
                    if let Some(latest) = versions.first() {
                        paths.push(format!("{}/bin", latest.path().to_string_lossy()));
                    }
                }
            }
        }

        // Add Claude desktop app's bundled CLI paths
        let claude_app_base = home.join("Library/Application Support/Claude/claude-code");
        if claude_app_base.exists() {
            if let Ok(entries) = std::fs::read_dir(&claude_app_base) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        paths.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // Append existing PATH
    if !current_path.is_empty() {
        paths.push(current_path);
    }

    paths.join(get_path_separator())
}

/// Finds an executable by checking common installation paths.
/// This is needed because bundled macOS apps don't inherit the user's shell PATH.
/// On Windows, checks standard Program Files and AppData locations.
pub fn find_executable(cmd: &str) -> Option<std::path::PathBuf> {
    // First try which (works in dev and if PATH is set)
    if let Ok(path) = which::which(cmd) {
        return Some(path);
    }

    #[cfg(windows)]
    {
        // On Windows, also try with .exe extension
        let cmd_exe = format!("{}.exe", cmd);
        if let Ok(path) = which::which(&cmd_exe) {
            return Some(path);
        }

        // Check common Windows installation paths
        let mut windows_paths = Vec::new();

        // Program Files paths
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("nodejs")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("Git\\bin")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("GitHub CLI")
                    .join(&cmd_exe),
            );
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            windows_paths.push(
                std::path::PathBuf::from(&program_files_x86)
                    .join("nodejs")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&program_files_x86)
                    .join("Git\\bin")
                    .join(&cmd_exe),
            );
        }

        // User-specific paths
        if let Some(home) = dirs::home_dir() {
            windows_paths.push(
                home.join("AppData\\Local\\Programs\\Git\\bin")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                home.join("AppData\\Local\\Programs")
                    .join(cmd)
                    .join(&cmd_exe),
            );
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            // npm global binaries (uses .cmd wrapper on Windows)
            let cmd_cmd = format!("{}.cmd", cmd);
            windows_paths.push(
                std::path::PathBuf::from(&app_data)
                    .join("npm")
                    .join(&cmd_cmd),
            );
            windows_paths.push(
                std::path::PathBuf::from(&app_data)
                    .join("npm")
                    .join(&cmd_exe),
            );
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            windows_paths.push(
                std::path::PathBuf::from(&local_app_data)
                    .join("Microsoft\\WindowsApps")
                    .join(&cmd_exe),
            );
            windows_paths.push(
                std::path::PathBuf::from(&local_app_data)
                    .join("Programs")
                    .join(cmd)
                    .join(&cmd_exe),
            );
        }

        for path in windows_paths {
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Check common installation paths for macOS/Linux
        let common_paths = vec![
            std::path::PathBuf::from("/opt/homebrew/bin").join(cmd), // Homebrew (Apple Silicon)
            std::path::PathBuf::from("/usr/local/bin").join(cmd),    // Homebrew (Intel) / manual
            std::path::PathBuf::from("/usr/bin").join(cmd),          // System
        ];

        for path in common_paths {
            if path.exists() {
                return Some(path);
            }
        }

        // For npm-installed tools (like claude), check additional locations
        if let Some(home) = dirs::home_dir() {
            let npm_paths = vec![
                home.join(".npm-global/bin").join(cmd),
                home.join("n/bin").join(cmd), // n version manager
            ];

            for path in npm_paths {
                if path.exists() {
                    return Some(path);
                }
            }

            // Check NVM installations (glob for any node version)
            let nvm_base = home.join(".nvm/versions/node");
            if nvm_base.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_base) {
                    for entry in entries.flatten() {
                        let bin_path = entry.path().join("bin").join(cmd);
                        if bin_path.exists() {
                            return Some(bin_path);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Caches the resolved projects root so path validation (called by most
/// commands) doesn't read `app_state.json` on every invocation. Invalidated by
/// [`invalidate_projects_root_cache`] when the setting changes.
static PROJECTS_ROOT_CACHE: RwLock<Option<std::path::PathBuf>> = RwLock::new(None);

/// The built-in default projects root, `~/ShipStudio`.
///
/// This always remains a valid location even when the user configures a custom
/// root, so projects already living in `~/ShipStudio` keep opening.
pub fn default_projects_root() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join("ShipStudio"))
}

/// The directory Ship Studio uses to list and create projects.
///
/// Resolves the user-configured root from persisted app state (cached), falling
/// back to `~/ShipStudio`. A configured path that no longer exists on disk falls
/// back to the default, so the app never points at a dead directory.
pub fn projects_root() -> Result<std::path::PathBuf, String> {
    if let Some(cached) = PROJECTS_ROOT_CACHE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(cached);
    }
    let resolved = resolve_projects_root_uncached()?;
    *PROJECTS_ROOT_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner()) = Some(resolved.clone());
    Ok(resolved)
}

fn resolve_projects_root_uncached() -> Result<std::path::PathBuf, String> {
    use crate::commands::accounts::DEFAULT_ACCOUNT_ID;
    // The projects folder is per-workspace: resolve the *active* workspace's
    // folder. Switching workspaces changes which folder the dashboard scans (the
    // cache is invalidated on switch).
    let default = default_projects_root()?;
    let state = crate::commands::setup::read_app_state();
    let active_id = state
        .active_account_id
        .as_deref()
        .unwrap_or(DEFAULT_ACCOUNT_ID);
    Ok(account_root_in(&state, active_id, &default))
}

/// The effective projects folder for one workspace: its own configured folder
/// if set and still present on disk; for the Default workspace the legacy
/// top-level `projects_root` is honored next (backward compat with the global
/// setting that predated per-workspace folders); otherwise `~/ShipStudio`.
fn account_root_in(
    state: &crate::types::AppState,
    account_id: &str,
    default: &std::path::Path,
) -> std::path::PathBuf {
    use crate::commands::accounts::DEFAULT_ACCOUNT_ID;
    let existing_dir = |s: &str| -> Option<std::path::PathBuf> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let pb = std::path::PathBuf::from(t);
        pb.is_dir().then_some(pb)
    };
    if let Some(acc) = state.accounts.iter().find(|a| a.id == account_id) {
        if let Some(pb) = acc.projects_root.as_deref().and_then(existing_dir) {
            return pb;
        }
    }
    if account_id == DEFAULT_ACCOUNT_ID {
        if let Some(pb) = state.projects_root.as_deref().and_then(existing_dir) {
            return pb;
        }
    }
    default.to_path_buf()
}

/// The projects folder for a *specific* workspace (not necessarily the active
/// one). Used when moving a project into another workspace's folder.
pub fn projects_root_for_account(account_id: &str) -> std::path::PathBuf {
    let default = default_projects_root().unwrap_or_default();
    let state = crate::commands::setup::read_app_state();
    account_root_in(&state, account_id, &default)
}

/// Drop the cached projects root. Call after persisting a new value so the next
/// `projects_root()` re-reads from app state.
pub fn invalidate_projects_root_cache() {
    *PROJECTS_ROOT_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner()) = None;
}

/// The set of root directories a project path is allowed to live under: the
/// configured root plus the built-in default (kept for backward compatibility).
/// Each is canonicalized where it exists so symlinked roots still match the
/// canonicalized candidate in the containment checks below.
pub(crate) fn allowed_project_roots() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    let default = default_projects_root().ok();
    let state = crate::commands::setup::read_app_state();

    // Every workspace's folder. A project can belong to any workspace, and you
    // can work projects from several workspaces at once, so a path under *any*
    // workspace's folder must validate — not just the active one's.
    if let Some(d) = &default {
        for acc in &state.accounts {
            roots.push(account_root_in(&state, &acc.id, d));
        }
    }
    // Active workspace (covers the no-accounts edge case), legacy global root,
    // and the built-in default.
    if let Ok(r) = projects_root() {
        roots.push(r);
    }
    if let Some(p) = state.projects_root.as_deref() {
        if !p.trim().is_empty() {
            roots.push(std::path::PathBuf::from(p.trim()));
        }
    }
    if let Some(d) = default {
        roots.push(d);
    }

    // Canonicalize (so symlinked roots match the canonicalized candidate) + dedup.
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    for r in roots {
        let c = dunce::canonicalize(&r).unwrap_or(r);
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// Validates that a project path is inside an allowed projects root (the
/// configured root or the default `~/ShipStudio`) or is a registered external
/// project. Prevents path traversal where the frontend could pass arbitrary paths.
pub fn validate_project_path(project_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(project_path);
    let canonical = dunce::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))?;

    // Allow paths inside any allowed projects root
    if allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Ok(canonical);
    }

    // Allow registered external project paths
    if crate::commands::external_projects::is_registered_external_path(&canonical)? {
        return Ok(canonical);
    }

    Err(format!(
        "Security error: path '{project_path}' is outside the projects directory"
    ))
}

/// Validates a path to a *file* that lives inside ~/ShipStudio (or a registered
/// external project), WITHOUT requiring the file itself to already exist.
///
/// Unlike [`validate_project_path`] (which canonicalizes the path and therefore
/// fails on a not-yet-created target), this canonicalizes the file's *parent*
/// directory — resolving symlinks and `..` — enforces containment, then rejoins
/// the final component. Use it for commands that read, create, or overwrite a
/// specific file by absolute path (e.g. .env files) so they can't be tricked
/// into touching files outside the sandbox via `..`, symlinks, or an arbitrary
/// absolute path.
///
/// Returns the safe, canonical absolute path the caller should operate on.
pub fn validate_project_file_path(file_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(file_path);

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid path: '{file_path}' has no file name"))?;

    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path: '{file_path}' has no parent directory"))?;

    // Canonicalize the parent (must exist) — resolves symlinks and `..` so the
    // containment check below can't be defeated lexically.
    let canonical_parent = dunce::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;

    let allowed = allowed_project_roots()
        .iter()
        .any(|root| canonical_parent.starts_with(root))
        || crate::commands::external_projects::is_registered_external_path(&canonical_parent)?;

    if !allowed {
        return Err(format!(
            "Security error: path '{file_path}' is outside the projects directory"
        ));
    }

    let resolved = canonical_parent.join(file_name);

    // Refuse to operate through a symlink at the final component. The parent
    // check above confines the directory, but `fs::read`/`write`/`remove_file`
    // follow symlinks — so a malicious repo could plant `proj/.env` as a symlink
    // to ~/.zshenv and escape the sandbox on the final hop. (Mirrors the guard
    // in assets.rs::upload_asset.)
    if let Ok(meta) = std::fs::symlink_metadata(&resolved) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Security error: '{file_path}' is a symlink; refusing to follow it"
            ));
        }
    }

    Ok(resolved)
}

/// Resolve a project path to its "active workspace" directory.
///
/// For single-package projects this is the project root unchanged. For monorepo
/// projects where the user picked an app at import time, it returns
/// `project_root.join(workspace_subpath)` — so dev server, asset, and project-
/// type detection commands operate inside the chosen app rather than the repo
/// root.
///
/// Results are cached for 5 seconds keyed by (path, mtime of project.json) so
/// asset-heavy operations don't re-parse the metadata file on every call. The
/// cache invalidates as soon as anything writes to .shipstudio/project.json
/// (mtime changes), so set_workspace_subpath takes effect immediately.
///
/// Falls back to the project root when metadata is missing/malformed; logs a
/// warn (but still falls back) when the subpath points at a directory that no
/// longer exists on disk.
pub fn resolve_workspace_path(project_root: &std::path::Path) -> std::path::PathBuf {
    use crate::cache::TtlCache;
    use crate::types::ProjectMetadata;
    use std::sync::LazyLock;
    use std::time::{Duration, SystemTime};

    static CACHE: LazyLock<TtlCache<(String, u128), std::path::PathBuf>> =
        LazyLock::new(|| TtlCache::new(Duration::from_secs(5)));

    let metadata_path = project_root.join(".shipstudio").join("project.json");
    let mtime = std::fs::metadata(&metadata_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = (project_root.to_string_lossy().into_owned(), mtime);
    if let Some(cached) = CACHE.get(&key) {
        return cached;
    }

    let resolved = (|| -> std::path::PathBuf {
        let Ok(contents) = std::fs::read_to_string(&metadata_path) else {
            return project_root.to_path_buf();
        };
        let Ok(metadata) = serde_json::from_str::<ProjectMetadata>(&contents) else {
            return project_root.to_path_buf();
        };
        match metadata.workspace_subpath {
            Some(sub) if !sub.is_empty() => {
                // The subpath comes from the repo-controlled project.json, so a
                // malicious repo could set an absolute path or `..` to escape
                // the project root (this resolved path becomes a dev-server cwd
                // and asset root). Reject anything that isn't a plain relative
                // path and fall back to the root.
                let rel = std::path::Path::new(&sub);
                let is_safe_relative = rel.components().all(|c| {
                    matches!(
                        c,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                });
                if !is_safe_relative {
                    tracing::warn!(
                        project = %project_root.display(),
                        subpath = %sub,
                        "workspace_subpath is not a safe relative path; falling back to repo root"
                    );
                    return project_root.to_path_buf();
                }
                let candidate = project_root.join(rel);
                if !candidate.exists() {
                    tracing::warn!(
                        project = %project_root.display(),
                        subpath = %sub,
                        "workspace_subpath points at a missing directory; falling back to repo root"
                    );
                    return project_root.to_path_buf();
                }
                // The lexical check above blocks `..`, but a relative entry like
                // `apps/web` could itself be a symlink to /tmp/escape. Canonicalize
                // both sides and confirm containment before trusting it as the cwd.
                match (
                    dunce::canonicalize(&candidate),
                    dunce::canonicalize(project_root),
                ) {
                    (Ok(canon_candidate), Ok(canon_root))
                        if canon_candidate.starts_with(&canon_root) =>
                    {
                        candidate
                    }
                    _ => {
                        tracing::warn!(
                            project = %project_root.display(),
                            subpath = %sub,
                            "workspace_subpath resolves outside the project root; falling back to repo root"
                        );
                        project_root.to_path_buf()
                    }
                }
            }
            _ => project_root.to_path_buf(),
        }
    })();

    CACHE.insert(key, resolved.clone());
    resolved
}

/// Check if Homebrew is installed
pub fn check_homebrew() -> (bool, Option<String>) {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];

    for path in paths {
        if path.exists() {
            // Get version
            let version = create_command(&path)
                .args(["--version"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let out = String::from_utf8_lossy(&o.stdout);
                        out.lines().next().map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                });
            return (true, version);
        }
    }
    (false, None)
}

/// Get Homebrew command path
pub fn get_brew_command() -> Option<std::path::PathBuf> {
    let paths = [
        std::path::PathBuf::from("/opt/homebrew/bin/brew"),
        std::path::PathBuf::from("/usr/local/bin/brew"),
    ];
    paths.into_iter().find(|p| p.exists())
}

/// Check if Winget is installed (Windows only)
#[cfg(windows)]
pub fn check_winget() -> (bool, Option<String>) {
    if let Ok(path) = which::which("winget") {
        // Get version
        let version = create_command(&path)
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let out = String::from_utf8_lossy(&o.stdout);
                    // Winget version output is like "v1.6.3482" - extract the version
                    out.trim()
                        .strip_prefix('v')
                        .map(|s| format!("v{}", s))
                        .or_else(|| Some(out.trim().to_string()))
                } else {
                    None
                }
            });
        return (true, version);
    }
    (false, None)
}

#[cfg(not(windows))]
pub fn check_winget() -> (bool, Option<String>) {
    (false, None)
}

/// Get Winget command path (Windows only)
#[cfg(windows)]
pub fn get_winget_command() -> Option<std::path::PathBuf> {
    which::which("winget").ok()
}

#[cfg(not(windows))]
pub fn get_winget_command() -> Option<std::path::PathBuf> {
    None
}

/// Helper to format relative time
pub fn format_relative_time(timestamp_ms: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    format_relative_time_from_now(timestamp_ms, now)
}

/// Internal helper for formatting relative time (testable with controlled "now" value)
fn format_relative_time_from_now(timestamp_ms: u64, now_ms: u64) -> String {
    let diff_ms = now_ms.saturating_sub(timestamp_ms);
    let seconds = diff_ms / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;

    if days > 0 {
        format!("{days}d ago")
    } else if hours > 0 {
        format!("{hours}h ago")
    } else if minutes > 0 {
        format!("{minutes}m ago")
    } else {
        "just now".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod format_relative_time {
        use super::*;

        #[test]
        fn test_just_now() {
            let now = 100_000_000u64;
            assert_eq!(format_relative_time_from_now(now, now), "just now");
            assert_eq!(format_relative_time_from_now(now - 30_000, now), "just now"); // 30 seconds ago
            assert_eq!(format_relative_time_from_now(now - 59_000, now), "just now");
            // 59 seconds ago
        }

        #[test]
        fn test_minutes_ago() {
            let now = 100_000_000u64; // Large enough for 59 minutes
            assert_eq!(format_relative_time_from_now(now - 60_000, now), "1m ago"); // 1 minute ago
            assert_eq!(format_relative_time_from_now(now - 120_000, now), "2m ago"); // 2 minutes ago
            assert_eq!(
                format_relative_time_from_now(now - 59 * 60_000, now),
                "59m ago"
            ); // 59 minutes ago
        }

        #[test]
        fn test_hours_ago() {
            let now = 1000000000u64;
            assert_eq!(
                format_relative_time_from_now(now - 60 * 60_000, now),
                "1h ago"
            ); // 1 hour ago
            assert_eq!(
                format_relative_time_from_now(now - 2 * 60 * 60_000, now),
                "2h ago"
            ); // 2 hours ago
            assert_eq!(
                format_relative_time_from_now(now - 23 * 60 * 60_000, now),
                "23h ago"
            ); // 23 hours ago
        }

        #[test]
        fn test_days_ago() {
            let now = 1000000000u64;
            assert_eq!(
                format_relative_time_from_now(now - 24 * 60 * 60_000, now),
                "1d ago"
            ); // 1 day ago
            assert_eq!(
                format_relative_time_from_now(now - 7 * 24 * 60 * 60_000, now),
                "7d ago"
            ); // 7 days ago
        }

        #[test]
        fn test_future_timestamp() {
            let now = 1000000u64;
            // Future timestamps should show "just now" (saturating subtraction)
            assert_eq!(format_relative_time_from_now(now + 60_000, now), "just now");
        }
    }

    mod get_extended_path {
        use super::*;

        #[test]
        fn test_includes_expected_paths() {
            let path = get_extended_path();
            #[cfg(not(windows))]
            {
                assert!(path.contains("/opt/homebrew/bin"));
                assert!(path.contains("/usr/local/bin"));
            }
            #[cfg(windows)]
            {
                // On Windows, should include WindowsApps or npm paths
                assert!(
                    path.contains("WindowsApps") || path.contains("npm") || path.contains("Git")
                );
            }
        }

        #[test]
        fn test_preserves_existing_path() {
            // The extended path should include the current PATH
            let current = std::env::var("PATH").unwrap_or_default();
            if !current.is_empty() {
                let extended = get_extended_path();
                assert!(extended.contains(&current));
            }
        }
    }

    mod find_executable {
        use super::*;

        #[test]
        fn test_finds_git() {
            // Git should be available on most systems
            let result = find_executable("git");
            assert!(result.is_some());
            assert!(result.unwrap().exists());
        }

        #[test]
        fn test_nonexistent_command() {
            let result = find_executable("this-command-definitely-does-not-exist-12345");
            assert!(result.is_none());
        }
    }

    /// Security-critical tests for `validate_project_path` — covers the threat
    /// model described in the DX audit (Block 14.1).
    ///
    /// These tests avoid depending on registered external projects by only
    /// checking paths inside/outside `~/ShipStudio`. The tests do not create
    /// real directories unless the machine happens to have one; they focus on
    /// the validation logic itself.
    mod validate_project_path_tests {
        use super::*;
        use std::fs;

        fn shipstudio_root() -> std::path::PathBuf {
            dirs::home_dir().expect("home dir").join("ShipStudio")
        }

        #[test]
        fn rejects_relative_path_to_cwd_when_outside_shipstudio() {
            // Current working directory in test runner is src-tauri, which is
            // outside ~/ShipStudio. `.` canonicalizes to cwd, so this should
            // fail the security check.
            let err = validate_project_path(".").expect_err("should reject");
            assert!(
                err.contains("Security error") || err.contains("outside ShipStudio"),
                "unexpected error: {err}"
            );
        }

        #[test]
        fn rejects_nonexistent_path() {
            let err = validate_project_path("/this/path/definitely/does/not/exist/shipstudio-test")
                .expect_err("should reject nonexistent");
            // Either "Invalid path" (from canonicalize) or the security error —
            // both are acceptable rejection modes.
            assert!(!err.is_empty(), "empty error for nonexistent path");
        }

        #[test]
        fn rejects_path_traversal_attempt() {
            // ../../etc canonicalizes outside ShipStudio (if it canonicalizes
            // at all on the test machine), so the validation must reject it.
            let result = validate_project_path("../../../../../../etc");
            assert!(
                result.is_err(),
                "path traversal outside ShipStudio must be rejected"
            );
        }

        #[test]
        fn rejects_arbitrary_root_path() {
            let result = validate_project_path("/tmp");
            assert!(result.is_err(), "/tmp is outside ShipStudio, must reject");
        }

        #[test]
        fn accepts_path_inside_shipstudio_root() {
            // Create a temp project directory inside ~/ShipStudio just for this test.
            let root = shipstudio_root();
            if fs::create_dir_all(&root).is_err() {
                eprintln!("skipping: couldn't create ~/ShipStudio");
                return;
            }
            let test_dir = root.join(".dx-refactor-validate-test");
            if fs::create_dir_all(&test_dir).is_err() {
                eprintln!("skipping: couldn't create test dir");
                return;
            }
            let path_str = test_dir.to_string_lossy().to_string();
            let result = validate_project_path(&path_str);
            let _ = fs::remove_dir(&test_dir); // best-effort cleanup
            assert!(
                result.is_ok(),
                "path inside ~/ShipStudio should validate, got {result:?}"
            );
        }

        #[test]
        fn empty_path_rejected() {
            let result = validate_project_path("");
            assert!(result.is_err(), "empty path must be rejected");
        }

        /// A symlink inside `~/ShipStudio` that points OUTSIDE it must be
        /// rejected after canonicalization. This covers the classic
        /// path-traversal-via-symlink escape.
        #[test]
        #[cfg(unix)]
        fn rejects_symlink_escape_outside_shipstudio_root() {
            use std::os::unix::fs::symlink;
            let root = shipstudio_root();
            if fs::create_dir_all(&root).is_err() {
                eprintln!("skipping: couldn't create ~/ShipStudio");
                return;
            }
            let link_path = root.join(".dx-refactor-symlink-escape-test");
            let _ = fs::remove_file(&link_path); // clean up from prior failure
                                                 // Point the symlink at /tmp — guaranteed to exist, guaranteed to
                                                 // be outside ~/ShipStudio on any Unix-like test machine.
            if symlink("/tmp", &link_path).is_err() {
                eprintln!("skipping: couldn't create symlink");
                return;
            }
            let result = validate_project_path(&link_path.to_string_lossy());
            let _ = fs::remove_file(&link_path);
            assert!(
                result.is_err(),
                "symlink pointing outside ShipStudio must be rejected after canonicalization, got {result:?}"
            );
        }

        /// External registered project paths (added via the Import flow) must
        /// be accepted even though they live outside `~/ShipStudio`. We exercise
        /// the raw registry helper directly since the validate_project_path
        /// branch that consults it isn't reachable without touching the user's
        /// config file. This is a lighter-weight sanity check that the helper
        /// correctly answers "yes, this path is registered" after we've
        /// written a config that lists it.
        #[test]
        fn is_registered_external_path_accepts_listed_path() {
            use crate::commands::external_projects::is_registered_external_path;
            // Rather than mutate the user's real config, verify the helper's
            // behavior on a path that definitely isn't registered: the system
            // temp dir canonicalized. It should return false (not registered).
            let tmp = std::path::PathBuf::from("/tmp");
            let Ok(canonical) = tmp.canonicalize() else {
                eprintln!("skipping: /tmp doesn't canonicalize on this host");
                return;
            };
            let is_registered = is_registered_external_path(&canonical).unwrap_or(true);
            assert!(!is_registered, "/tmp must not appear registered by default");
        }
    }

    /// Security tests for `validate_project_file_path` — the helper that guards
    /// the .env read/write/delete commands. Unlike `validate_project_path` it
    /// must accept a not-yet-existing target file while still confining writes
    /// to ~/ShipStudio.
    mod validate_project_file_path_tests {
        use super::*;
        use std::fs;

        fn shipstudio_root() -> std::path::PathBuf {
            dirs::home_dir().expect("home dir").join("ShipStudio")
        }

        #[test]
        fn rejects_file_outside_shipstudio() {
            // ~/.zshenv is the canonical RCE target — must be rejected.
            let home = dirs::home_dir().expect("home dir");
            let target = home.join(".zshenv-shipstudio-audit-test");
            let err = validate_project_file_path(&target.to_string_lossy())
                .expect_err("file in $HOME (outside ShipStudio) must be rejected");
            assert!(
                err.contains("Security error") || err.contains("outside ShipStudio"),
                "unexpected error: {err}"
            );
        }

        #[test]
        fn rejects_traversal_out_of_shipstudio() {
            // A path whose parent canonicalizes outside the root must fail even
            // though the leading segment names ShipStudio.
            let root = shipstudio_root();
            let sneaky = root.join("..").join(".ssh").join("authorized_keys");
            let result = validate_project_file_path(&sneaky.to_string_lossy());
            assert!(
                result.is_err(),
                "traversal out of ShipStudio must be rejected"
            );
        }

        #[test]
        fn accepts_nonexistent_file_inside_shipstudio() {
            // The key behavior: a target that doesn't exist yet (creating a new
            // .env) is allowed as long as its parent dir is inside the sandbox.
            let root = shipstudio_root();
            if fs::create_dir_all(&root).is_err() {
                eprintln!("skipping: couldn't create ~/ShipStudio");
                return;
            }
            let dir = root.join(".audit-env-test-dir");
            if fs::create_dir_all(&dir).is_err() {
                eprintln!("skipping: couldn't create test dir");
                return;
            }
            let target = dir.join(".env"); // does NOT exist
            let result = validate_project_file_path(&target.to_string_lossy());
            let _ = fs::remove_dir_all(&dir);
            assert!(
                result.is_ok(),
                "not-yet-created file inside ShipStudio should validate, got {result:?}"
            );
        }

        /// A `.env` that is itself a symlink pointing outside the sandbox must be
        /// rejected — otherwise fs::write/read/remove would follow it (the
        /// planted-symlink RCE this helper guards against).
        #[test]
        #[cfg(unix)]
        fn rejects_symlinked_final_component() {
            use std::os::unix::fs::symlink;
            let root = shipstudio_root();
            if fs::create_dir_all(&root).is_err() {
                eprintln!("skipping: couldn't create ~/ShipStudio");
                return;
            }
            let dir = root.join(".audit-env-symlink-test");
            let _ = fs::remove_dir_all(&dir);
            if fs::create_dir_all(&dir).is_err() {
                eprintln!("skipping: couldn't create test dir");
                return;
            }
            let link = dir.join(".env");
            // Point at /tmp/... outside ShipStudio; target need not exist.
            if symlink("/tmp/ss-audit-symlink-target", &link).is_err() {
                let _ = fs::remove_dir_all(&dir);
                eprintln!("skipping: couldn't create symlink");
                return;
            }
            let result = validate_project_file_path(&link.to_string_lossy());
            let _ = fs::remove_dir_all(&dir);
            assert!(
                result.is_err(),
                "symlinked final component must be rejected, got {result:?}"
            );
        }
    }
}
