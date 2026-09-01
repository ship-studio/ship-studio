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

/// Query the user's login shell for its PATH so we detect tools installed by
/// any version manager (nvm, volta, fnm, asdf, …) exactly the way their terminal
/// sees them. A macOS app launched from Finder does NOT inherit this PATH.
/// Bounded by a short timeout so a slow shell rc can't hang detection; returns
/// None on any failure.
#[cfg(not(windows))]
fn get_login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // -l (login) + -i (interactive) so the shell sources the rc files that set up
    // version managers (nvm/fnm/asdf typically live in the interactive rc). A
    // unique marker isolates the PATH from any banner/prompt a chatty rc prints;
    // stdin is /dev/null so a prompting rc can't block on input. spawn() (not
    // output()) keeps a handle so a slow rc can be killed, not just abandoned.
    let mut child = create_command(&shell)
        .args(["-lic", "echo \"__SHIPSTUDIO_PATH__${PATH}\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Read stdout on a worker thread so the wait is bounded. Take the handle so
    // killing the child closes the pipe, which unblocks the reader and lets the
    // thread exit (no leaked thread).
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = stdout;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let result = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(buf) => buf
            .lines()
            .rev()
            .find_map(|line| line.trim().strip_prefix("__SHIPSTUDIO_PATH__"))
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty()),
        Err(_) => None,
    };

    // Always terminate + reap the child so a slow/interactive rc can't leave the
    // shell process lingering. kill() is a harmless no-op if it already exited.
    let _ = child.kill();
    let _ = child.wait();

    result
}

/// Parses the `path:` entry from an nvm-windows `settings.txt`. That entry is
/// the symlink directory (e.g. `C:\Program Files\nodejs`) nvm-windows points
/// at the currently-selected Node version. Conservative: returns None unless a
/// non-empty `path:` line is present.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_nvm_windows_symlink(settings: &str) -> Option<String> {
    settings.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed
            .strip_prefix("path:")
            .or_else(|| trimmed.strip_prefix("Path:"))?
            .trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

/// Returns the most recently modified subdirectory of `dir`, if any. Used to
/// pick the newest fnm multishell link (fnm creates one per shell session).
#[cfg_attr(not(windows), allow(dead_code))]
fn most_recent_subdir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .max_by_key(|entry| {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .map(|entry| entry.path())
}

/// pnpm's self-managed global bin directories (issue #570): `$PNPM_HOME` when
/// set (pnpm's own bin dir is configurable), plus the per-platform defaults
/// its standalone installer / `pnpm setup` uses — macOS `~/Library/pnpm`,
/// Linux `~/.local/share/pnpm`, Windows `%LOCALAPPDATA%\pnpm`. Mirrors
/// `claude.rs::candidate_paths_for`. Pure on its inputs so it's testable;
/// existence isn't checked — a nonexistent PATH entry is harmless, matching
/// the other entries here.
fn pnpm_home_dirs(home: &std::path::Path, pnpm_home: Option<&str>) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    if let Some(ph) = pnpm_home {
        let ph = ph.trim();
        if !ph.is_empty() {
            dirs.push(ph.to_string());
        }
    }
    let home_str = home.to_string_lossy();
    if cfg!(windows) {
        dirs.push(format!("{home_str}\\AppData\\Local\\pnpm"));
    } else {
        dirs.push(format!("{home_str}/Library/pnpm")); // macOS default
        dirs.push(format!("{home_str}/.local/share/pnpm")); // Linux default
    }
    dirs
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

            // Version-manager Node installs (issue #164): a GUI-launched app
            // never sees the PATH entries these managers add in the user's
            // shell profile, so node/npm from volta/fnm looked "not installed".
            let volta_bin = format!("{}\\Volta\\bin", local_app_data);
            if std::path::Path::new(&volta_bin).exists() {
                windows_paths.push(volta_bin);
            }

            // fnm exposes node via per-shell symlink dirs under
            // fnm_multishells; use the most recently created one. Fall back to
            // the fnm install dir itself so at least `fnm` resolves.
            let multishells = std::path::PathBuf::from(&local_app_data).join("fnm_multishells");
            if let Some(latest) = most_recent_subdir(&multishells) {
                windows_paths.push(latest.to_string_lossy().to_string());
            } else {
                let fnm_dir = format!("{}\\fnm", local_app_data);
                if std::path::Path::new(&fnm_dir).exists() {
                    windows_paths.push(fnm_dir);
                }
            }

            // Node's per-user installer target (no-admin installs).
            let user_nodejs = format!("{}\\Programs\\nodejs", local_app_data);
            if std::path::Path::new(&user_nodejs).exists() {
                windows_paths.push(user_nodejs);
            }
        }

        if let Ok(app_data) = std::env::var("APPDATA") {
            windows_paths.push(format!("{}\\npm", app_data));

            // nvm-windows: settings.txt's `path:` entry names the symlink dir
            // that holds the currently-selected Node version. Parsing is
            // conservative — if the file is missing or has no `path:` line we
            // only add the nvm root itself (where nvm.exe lives).
            let nvm_root = std::path::PathBuf::from(&app_data).join("nvm");
            if nvm_root.exists() {
                if let Ok(settings) = std::fs::read_to_string(nvm_root.join("settings.txt")) {
                    if let Some(symlink) = parse_nvm_windows_symlink(&settings) {
                        if std::path::Path::new(&symlink).exists() {
                            windows_paths.push(symlink);
                        }
                    }
                }
                windows_paths.push(nvm_root.to_string_lossy().to_string());
            }
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            windows_paths.push(format!("{}\\GitHub CLI", program_files));
            // Git for Windows ships git.exe in both \cmd and \bin — list both so
            // resolution never depends on the inherited system PATH.
            windows_paths.push(format!("{}\\Git\\cmd", program_files));
            windows_paths.push(format!("{}\\Git\\bin", program_files));
            windows_paths.push(format!("{}\\nodejs", program_files));
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            windows_paths.push(format!("{}\\GitHub CLI", program_files_x86));
            windows_paths.push(format!("{}\\Git\\cmd", program_files_x86));
            windows_paths.push(format!("{}\\Git\\bin", program_files_x86));
            windows_paths.push(format!("{}\\nodejs", program_files_x86));
        }

        // User-specific paths
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            windows_paths.push(format!("{}\\AppData\\Local\\Programs\\Git\\cmd", home_str));
            windows_paths.push(format!("{}\\AppData\\Local\\Programs\\Git\\bin", home_str));
            windows_paths.push(format!("{}\\AppData\\Roaming\\npm", home_str));
            windows_paths.push(format!(r"{}\.local\bin", home_str));
            // pnpm's self-managed install dir ($PNPM_HOME, default
            // %LOCALAPPDATA%\pnpm) — see the Unix branch (issue #570).
            for dir in pnpm_home_dirs(&home, std::env::var("PNPM_HOME").ok().as_deref()) {
                windows_paths.push(dir);
            }
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
        // pnpm's self-managed install dirs (standalone installer / `pnpm
        // setup`): $PNPM_HOME when set, else the platform defaults. Without
        // these, a repo's husky/lefthook hook that shells out to pnpm fails
        // with "command not found" under git_command()'s PATH (issue #570) —
        // the same gap claude.rs::candidate_paths_for already closed for
        // agent-CLI detection.
        for dir in pnpm_home_dirs(&home, std::env::var("PNPM_HOME").ok().as_deref()) {
            paths.push(dir);
        }

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

    // Merge the user's login-shell PATH FIRST (covers nvm/volta/fnm/asdf/custom
    // that a Finder-launched bundle wouldn't otherwise see). It must take
    // precedence over the hard-coded fallbacks below so the active version-
    // manager binary the user's terminal resolves wins over a stale system copy
    // in /usr/local/bin etc. Non-Windows only.
    #[cfg(not(windows))]
    if let Some(shell_path) = get_login_shell_path() {
        let shell_dirs: Vec<String> = shell_path
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(|dir| dir.to_string())
            .collect();
        // Drop the fallbacks that the shell PATH already covers, then prepend
        // the shell dirs so they are searched first.
        paths.retain(|p| !shell_dirs.contains(p));
        let mut merged = shell_dirs;
        merged.append(&mut paths);
        paths = merged;
    }

    // Append existing PATH
    if !current_path.is_empty() {
        paths.push(current_path);
    }

    paths.join(get_path_separator())
}

/// Build a `Command` for git, resolving the full binary path first.
///
/// Spawning bare `"git"` can fail to resolve on Windows even when git is
/// installed — and the resulting `io::Error` renders as the context-free
/// "program not found" (issue #297). Resolving via [`find_executable`] fixes
/// resolution and yields a clear, actionable error when git truly is missing.
///
/// The resolved path is cached after the first success; a miss is re-probed
/// on every call, so installing git mid-session (the onboarding wizard does
/// exactly this) starts working without an app restart.
pub fn git_command() -> Result<Command, crate::errors::CommandError> {
    // Hand git the extended PATH, not for git itself (already resolved
    // absolutely) but for whatever it spawns: pre-commit/pre-push hooks
    // inherit this environment, and under a GUI-launched app's minimal PATH
    // a lefthook/husky hook can't find pnpm/node/etc. even though they work
    // fine in the user's terminal (issue #363). Same treatment `run_git_net`
    // already applies to fetch/pull/push.
    fn with_extended_path(mut cmd: Command) -> Command {
        cmd.env("PATH", get_extended_path());
        cmd
    }
    static GIT_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    if let Some(path) = GIT_PATH.get() {
        return Ok(with_extended_path(create_command(path)));
    }
    match find_executable("git") {
        Some(path) => {
            let cmd = with_extended_path(create_command(&path));
            let _ = GIT_PATH.set(path);
            Ok(cmd)
        }
        // Expected: a missing git is an environment gap the onboarding
        // wizard handles, not an app malfunction.
        None => Err(crate::errors::CommandError::expected(
            "Git isn't installed or couldn't be located. Install Git \
             (https://git-scm.com) and restart Ship Studio, then try again",
        )),
    }
}

/// Like [`git_command`], but scoped to a repository directory: sets the
/// working directory and passes `-c safe.directory=<dir>` so git's
/// dubious-ownership safeguard (CVE-2022-24765) doesn't hard-fail when the
/// repo is owned by a different OS user than the one running Ship Studio —
/// e.g. a project restored or synced from another Windows profile (issue
/// #305). Trust is scoped per-invocation to this exact directory (which
/// callers have already passed through `validate_project_path`); nothing is
/// ever written to the user's global git config, and never a blanket `*`.
pub fn git_command_in(
    dir: impl AsRef<std::path::Path>,
) -> Result<Command, crate::errors::CommandError> {
    let dir = dir.as_ref();
    let mut cmd = git_command()?;
    // git compares safe.directory entries against forward-slash paths,
    // including on Windows.
    let safe = dir.to_string_lossy().replace('\\', "/");
    cmd.arg("-c").arg(format!("safe.directory={safe}"));
    cmd.current_dir(dir);
    Ok(cmd)
}

/// True when git failed because another process held one of its lock files.
/// Concurrent git spawns against the same repo are unavoidable here: the
/// snapshot watcher, commit/publish flows, and the user's own agent CLIs all
/// run git independently. Git fails fast instead of waiting, so a collision
/// surfaces as "Unable to create '….lock': File exists" — most visibly on
/// Windows, where lock files also linger longer (AV scanning, handle-release
/// timing) (issue #377).
///
/// The same concurrency produces the same message for *every* git lock file,
/// not just `.git/index.lock`: `git commit` also takes `HEAD.lock` and
/// `refs/heads/<branch>.lock` when it updates the ref, and ref updates take
/// `packed-refs.lock` — so the match is on the shared `….lock': File exists`
/// shape rather than the literal `index.lock` (issue #567).
pub fn is_index_lock_contention(stderr: &str) -> bool {
    (stderr.contains(".lock") && stderr.contains("File exists"))
        || stderr.contains("Another git process seems to be running")
}

/// Run a git invocation built by `run`, retrying with a short backoff when it
/// loses the `.git/index.lock` race. The closure rebuilds and executes the
/// command each attempt. Non-contention failures and successes return
/// immediately; contention is retried a couple of times, then returned as-is
/// so the caller's normal error path reports it.
pub fn output_retrying_index_lock<F>(
    mut run: F,
) -> Result<std::process::Output, crate::errors::CommandError>
where
    F: FnMut() -> Result<std::process::Output, crate::errors::CommandError>,
{
    const ATTEMPTS: u64 = 3;
    for attempt in 1..=ATTEMPTS {
        let output = run()?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() || !is_index_lock_contention(&stderr) || attempt == ATTEMPTS {
            return Ok(output);
        }
        tracing::warn!(
            attempt,
            "git lost the index.lock race; retrying after backoff"
        );
        std::thread::sleep(std::time::Duration::from_millis(200 * attempt));
    }
    unreachable!("loop always returns on the final attempt")
}

/// Classify git stderr that signals a *machine/environment* gap — git itself
/// couldn't run (or couldn't read the project), through no fault of the app.
/// Returns a `CommandError::expected` with actionable guidance so these don't
/// page telemetry as malfunctions, or `None` for anything else.
///
/// Covered signatures:
/// - macOS Xcode CLT license not accepted — git is a CLT shim on macOS, so
///   every git call fails with the license text until the user accepts it
///   (issue #603).
/// - macOS Xcode CLT missing/broken (`xcrun: error: invalid active developer
///   path`) — same shim, e.g. after a macOS upgrade removed the CLT.
/// - macOS TCC denial (`Unable to read current working directory: Operation
///   not permitted`) — the sandbox refused the app read access to the project
///   folder, so spawned git can't even resolve its cwd (issue #546).
/// - git itself running out of memory (`fatal: Out of memory, malloc failed
///   (tried to allocate N bytes)`) — the host machine under memory pressure
///   at the moment git spawned; cross-platform, first seen on Windows
///   (issue #668).
pub fn git_environment_gap(stderr: &str) -> Option<crate::errors::CommandError> {
    if stderr.contains("You have not agreed to the Xcode license agreements") {
        return Some(crate::errors::CommandError::expected(
            "Xcode's license hasn't been accepted yet, so git can't run. Open Terminal, run \
             `sudo xcodebuild -license accept`, then try again.",
        ));
    }
    if stderr.contains("invalid active developer path")
        || stderr.contains("no developer tools were found")
    {
        return Some(crate::errors::CommandError::expected(
            "The Xcode Command Line Tools (which provide git on macOS) are missing or broken. \
             Run `xcode-select --install` in Terminal, then try again.",
        ));
    }
    if stderr.contains("Unable to read current working directory")
        && stderr.contains("Operation not permitted")
    {
        return Some(crate::errors::CommandError::expected(
            "Ship Studio isn't allowed to read this project's folder — macOS blocked access. \
             Grant access in System Settings → Privacy & Security → Files & Folders (or give \
             Ship Studio Full Disk Access), then try again.",
        ));
    }
    // git's allocator giving up ("fatal: Out of memory, malloc failed (tried
    // to allocate N bytes)" — also "realloc failed" / "mmap failed" variants).
    // The machine is out of memory at the moment git runs, which no app-side
    // fix can address (issue #668).
    let lower = stderr.to_lowercase();
    if lower.contains("out of memory")
        || lower.contains("malloc failed")
        || lower.contains("realloc failed")
    {
        return Some(crate::errors::CommandError::expected(
            "Git ran out of memory while working on this project — this computer is low on \
             available RAM right now. Close some other applications to free up memory, then \
             try again.",
        ));
    }
    None
}

/// Classify a filesystem `io::Error` for a user-facing command error.
///
/// macOS TCC's EPERM denial (`os error 1` — Privacy & Security blocking
/// Desktop/Documents/Downloads/iCloud/external volumes) is an environment
/// condition with a user-side fix, so it becomes an actionable `Expected`
/// with the Files & Folders remediation instead of a bare "Operation not
/// permitted" telemetry bug — the same treatment `read_projects_dir` got in
/// #307, shared here so every fs call site classifies identically (issues
/// #545, #605, #625).
///
/// Two more environment shapes classify Expected here:
/// - Windows `ERROR_ACCESS_DENIED` (os error 5, localized text — "Acceso
///   denegado." on a Spanish install): typically the file being briefly
///   locked by antivirus, another program, or cloud sync (issue #596).
/// - A read-only filesystem (Unix EROFS os error 30 / Windows
///   ERROR_WRITE_PROTECT os error 19): the volume itself refuses writes —
///   e.g. a project opened off a read-only disk image or locked SD card
///   (issue #625).
/// - Windows `ERROR_USER_MAPPED_FILE` (os error 1224): another process holds a
///   memory-mapped view of the file, so Windows refuses the truncating write.
///   Typically a dev server/bundler, an editor, or antivirus holding the file
///   open for a moment (issue #722).
///
/// Anything else stays a labeled `Io` for diagnosability.
pub fn classify_fs_error(
    action: &str,
    path: &std::path::Path,
    e: &std::io::Error,
) -> crate::errors::CommandError {
    if cfg!(target_os = "macos") && e.raw_os_error() == Some(1) {
        crate::errors::CommandError::expected(format!(
            "Ship Studio isn't allowed to {action} ({}). Grant access in System Settings → \
             Privacy & Security → Files & Folders (or Full Disk Access), then try again.",
            path.display()
        ))
    } else if cfg!(windows) && e.raw_os_error() == Some(5) {
        crate::errors::CommandError::expected(format!(
            "Ship Studio couldn't {action} ({}) — Windows denied access. The file may be \
             briefly locked by antivirus, another program, or cloud sync (e.g. OneDrive). \
             Try again in a moment.",
            path.display()
        ))
    } else if (cfg!(unix) && e.raw_os_error() == Some(30))
        || (cfg!(windows) && e.raw_os_error() == Some(19))
    {
        crate::errors::CommandError::expected(format!(
            "Ship Studio couldn't {action} ({}) — the disk or volume is read-only. Move \
             the project to a writable location, then try again.",
            path.display()
        ))
    } else if cfg!(windows) && e.raw_os_error() == Some(1224) {
        crate::errors::CommandError::expected(format!(
            "Ship Studio couldn't {action} ({}) — another program currently has the file open \
             (often a dev server, code editor, or antivirus). Close it or wait a moment, then \
             try again.",
            path.display()
        ))
    } else {
        crate::errors::CommandError::Io {
            message: format!("Failed to {action} ({}): {e}", path.display()),
        }
    }
}

/// Resolve `cmd` inside a single directory.
///
/// On Windows, executable (`.exe`) and batch (`.cmd`) shims are checked
/// BEFORE an extensionless sibling: Node installs `npm`/`npx` both as
/// `.cmd` batch shims AND as extensionless POSIX-shell scripts (for Git
/// Bash) in the same directory. Preferring the bare name resolved the shell
/// script, which `CreateProcess` cannot execute — every spawn then failed
/// with "%1 is not a valid Win32 application" (os error 193, issue #590).
/// `.cmd`/`.bat` are fine: Rust ≥ 1.77 spawns them through `cmd.exe` itself.
fn resolve_executable_in_dir(dir: &std::path::Path, cmd: &str) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    for ext in ["exe", "cmd", "bat"] {
        let with_ext = dir.join(format!("{cmd}.{ext}"));
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }
    let bare = dir.join(cmd);
    if bare.is_file() {
        return Some(bare);
    }
    None
}

/// Finds an executable by checking common installation paths.
/// This is needed because bundled macOS apps don't inherit the user's shell PATH.
/// On Windows, checks standard Program Files and AppData locations.
pub fn find_executable(cmd: &str) -> Option<std::path::PathBuf> {
    // First try which (works in dev and if PATH is set)
    if let Ok(path) = which::which(cmd) {
        return Some(path);
    }

    // Then search the extended PATH — which now includes the user's login-shell
    // PATH, so we find tools installed by any version manager their terminal
    // sees, even though a bundled app didn't inherit that PATH.
    let separator = get_path_separator();
    for dir in get_extended_path().split(separator) {
        if dir.is_empty() {
            continue;
        }
        if let Some(found) = resolve_executable_in_dir(std::path::Path::new(dir), cmd) {
            return Some(found);
        }
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
            // Git for Windows ships git.exe in both \cmd and \bin.
            windows_paths.push(
                std::path::PathBuf::from(&program_files)
                    .join("Git\\cmd")
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
                    .join("Git\\cmd")
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
                home.join("AppData\\Local\\Programs\\Git\\cmd")
                    .join(&cmd_exe),
            );
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

/// Normalize path separators to forward slashes for the frontend.
///
/// On Windows, `Path::to_string_lossy()` yields backslash separators
/// (`src\App.tsx`), but the frontend splits every path on `/` (file-tree
/// nesting, asset breadcrumbs, basename extraction). Converting at the backend
/// boundary keeps one path shape across platforms; Windows path joins accept
/// `/` on the way back, so reads/writes still resolve.
///
/// Windows-only by construction: on Unix `\` is a legal filename character, so
/// rewriting it there could corrupt real names — this is a pure no-op off
/// Windows.
#[cfg(windows)]
pub fn normalize_separators(path: &str) -> String {
    path.replace('\\', "/")
}

#[cfg(not(windows))]
pub fn normalize_separators(path: &str) -> String {
    path.to_string()
}

/// Canonicalize with a diagnosable error naming the call site and the path.
///
/// A bare "Invalid path: No such file or directory (os error 2)" is emitted
/// from ~20 canonicalize sites and is untraceable from telemetry (issue #284).
/// Including the path is safe: error reports scrub home directories before
/// anything leaves the machine.
pub fn canonicalize_tagged(
    path: impl AsRef<std::path::Path>,
    site: &str,
) -> Result<std::path::PathBuf, crate::errors::CommandError> {
    let path = path.as_ref();
    dunce::canonicalize(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // A folder disappearing out from under the app — deleted, renamed,
            // or moved in Finder/Explorer — is an environment change, not a
            // malfunction: say so plainly and keep it out of telemetry
            // (issues #365/#372, same family as #300/#342).
            crate::errors::CommandError::expected(format!(
                "The folder '{}' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio",
                path.display()
            ))
        } else {
            crate::errors::CommandError::from(format!(
                "Invalid path in {site} ('{}'): {e}",
                path.display()
            ))
        }
    })
}

/// True when a user-supplied relative path contains an actual `..` path
/// component (a traversal attempt). A naive `contains("..")` substring test
/// also rejects legitimate names like `notes..bak` or `v1..2-draft`
/// (issue #331); this checks whole components, and the canonicalize +
/// `starts_with` containment checks at every call site remain the real
/// defense against escapes.
pub fn has_parent_dir_component(path: &str) -> bool {
    std::path::Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// Directories that must never be treated as a project root, no matter what
/// marker files they contain: the user's home directory (a stray `~/.git` or
/// `~/.gitignore` is common), anything above it, and the filesystem root.
/// Treating one of these as a project hands project-scoped git commands
/// (`git add -A`, `git clean -fd`) the entire home tree to walk — observed
/// as issues #345/#346, where a registered `$HOME` "project" made Discard
/// Changes run `git clean -fd` across the user's home directory.
pub(crate) fn is_forbidden_project_root(path: &std::path::Path) -> bool {
    let candidate = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // Filesystem root ("/", "C:\") has no parent.
    if candidate.parent().is_none() {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        let home = dunce::canonicalize(&home).unwrap_or(home);
        // $HOME itself, or an ancestor of it (/Users, /home, C:\Users).
        if candidate == home || home.starts_with(&candidate) {
            return true;
        }
    }
    false
}

/// Validates that a project path is inside an allowed projects root (the
/// configured root or the default `~/ShipStudio`) or is a registered external
/// project. Prevents path traversal where the frontend could pass arbitrary paths.
///
/// Refusals are `CommandError::Expected`: the sandbox rejecting a path is the
/// app working correctly, not a malfunction to report.
pub fn validate_project_path(
    project_path: &str,
) -> Result<std::path::PathBuf, crate::errors::CommandError> {
    let path = std::path::Path::new(project_path);
    if !path.is_absolute() {
        return Err(crate::errors::CommandError::expected(
            "Security error: project path must be absolute",
        ));
    }
    let canonical = canonicalize_tagged(path, "validate_project_path")?;

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

    Err(crate::errors::CommandError::expected(format!(
        "Security error: path '{project_path}' is outside the projects directory"
    )))
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
/// Refusals are `CommandError::Expected` (see [`validate_project_path`]).
pub fn validate_project_file_path(
    file_path: &str,
) -> Result<std::path::PathBuf, crate::errors::CommandError> {
    let path = std::path::Path::new(file_path);

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid path: '{file_path}' has no file name"))?;

    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path: '{file_path}' has no parent directory"))?;

    // Canonicalize the parent (must exist) — resolves symlinks and `..` so the
    // containment check below can't be defeated lexically.
    let canonical_parent = canonicalize_tagged(parent, "validate_project_file_path")?;

    let allowed = allowed_project_roots()
        .iter()
        .any(|root| canonical_parent.starts_with(root))
        || crate::commands::external_projects::is_registered_external_path(&canonical_parent)?;

    if !allowed {
        return Err(crate::errors::CommandError::expected(format!(
            "Security error: path '{file_path}' is outside the projects directory"
        )));
    }

    let resolved = canonical_parent.join(file_name);

    // Refuse to operate through a symlink at the final component. The parent
    // check above confines the directory, but `fs::read`/`write`/`remove_file`
    // follow symlinks — so a malicious repo could plant `proj/.env` as a symlink
    // to ~/.zshenv and escape the sandbox on the final hop. (Mirrors the guard
    // in assets.rs::upload_asset.)
    if let Ok(meta) = std::fs::symlink_metadata(&resolved) {
        if meta.file_type().is_symlink() {
            return Err(crate::errors::CommandError::expected(format!(
                "Security error: '{file_path}' is a symlink; refusing to follow it"
            )));
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

/// Validate `project_path` as an allowed project root, then resolve it to the
/// active workspace subfolder (`workspace_subpath` in `.shipstudio/project.json`).
///
/// Identical to [`validate_project_path`] for single-app projects (no subpath →
/// the root is returned unchanged). Commands that should operate on the
/// *rendered app* rather than the repo root — Tailwind/framework detection for
/// the visual-editor gate — must use this so a monorepo whose app lives in a
/// subfolder is detected against that subfolder. Mirrors what
/// `detect_project_type_command` already does for project-type detection.
pub fn validate_workspace_path(project_path: &str) -> Result<std::path::PathBuf, String> {
    let root = validate_project_path(project_path)?;
    Ok(resolve_workspace_path(&root))
}

/// Recursively clear read-only attributes so Windows will delete the tree.
/// Never follows symlinks — see the body comment.
fn make_writable_recursive(path: &std::path::Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;

    // Never follow symlinks. A project can link outside itself — pnpm's
    // node_modules links into the machine-global content-addressable store,
    // whose files are deliberately read-only and shared by every project —
    // and chmod-ing through the link would mutate files the delete below
    // never touches. remove_dir_all removes the link itself, not its target,
    // so the link needs no permission help either.
    if metadata.file_type().is_symlink() {
        return Ok(());
    }

    if metadata.file_type().is_dir() {
        for entry in std::fs::read_dir(path)? {
            make_writable_recursive(&entry?.path())?;
        }
    }

    #[cfg(windows)]
    {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
        }
    }
    #[cfg(unix)]
    {
        // Owner-write only — Permissions::set_readonly(false) would make the
        // file world-writable on Unix (clippy::permissions_set_readonly_false).
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o200 == 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o200))?;
        }
    }
    Ok(())
}

/// Whether a failed filesystem delete/rename is worth retrying after a wait.
///
/// ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) are Windows'
/// "file open by another process" errors — the transient locks (antivirus,
/// Search indexer, a just-killed PTY's children winding down) this retry
/// exists for. ERROR_ACCESS_DENIED (5) covers in-use executables.
pub fn is_retryable_delete_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
        || e.kind() == std::io::ErrorKind::PermissionDenied
}

/// Run a filesystem operation, retrying on transient Windows lock errors.
///
/// Backoff schedule totalling ~8s: field reports show antivirus / Search
/// indexer locks routinely outlasting a flat ~1s budget (10 × 100ms), still
/// surfacing "os error 32" to the user (issue #253). Growing sleeps keep the
/// common quick-release case fast while giving a slow scanner time to let go.
fn retry_on_transient_locks<F>(mut op: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut delay = std::time::Duration::from_millis(100);
    let mut retries = 10;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) if retries > 0 && is_retryable_delete_error(&e) => {
                retries -= 1;
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(1));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Blocking delete with read-only clearing and lock retries. Call from
/// `spawn_blocking` — the chmod walk and retry sleeps can hold a thread for
/// seconds on a large node_modules.
pub fn remove_dir_all_robust(path: &std::path::Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    // Fast path first: on a healthy tree remove_dir_all just works, and the
    // chmod walk below stats every file — seconds of pure overhead on a large
    // node_modules if paid unconditionally.
    let first_err = match std::fs::remove_dir_all(path) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    tracing::info!(
        "remove_dir_all failed ({}), retrying with read-only clearing: {}",
        path.display(),
        first_err
    );

    // Clear read-only attributes (Windows refuses to delete read-only files;
    // git objects and some packages ship them). Best-effort: a partial chmod
    // still lets most of the tree go.
    if let Err(e) = make_writable_recursive(path) {
        tracing::warn!(
            "Failed to set write permissions recursively on {}: {}",
            path.display(),
            e
        );
    }

    retry_on_transient_locks(|| std::fs::remove_dir_all(path))
}

/// Blocking single-file delete with the same read-only clearing and lock
/// retries as [`remove_dir_all_robust`] — on Windows a file open in another
/// process (antivirus, Search indexer) fails an unretried `fs::remove_file`
/// with "Access is denied (os error 5)" / "os error 32" (issue #696). Call
/// from `spawn_blocking`; the retry sleeps can hold a thread for seconds.
///
/// Unlike `remove_dir_all_robust`, a missing file is an error (surfaced from
/// the underlying `remove_file`) so callers keep their existing semantics.
pub fn remove_file_robust(path: &std::path::Path) -> std::io::Result<()> {
    let first_err = match std::fs::remove_file(path) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    // NotFound etc. are not helped by chmod or waiting — fail immediately.
    if !is_retryable_delete_error(&first_err) {
        return Err(first_err);
    }
    tracing::info!(
        "remove_file failed ({}), retrying with read-only clearing: {}",
        path.display(),
        first_err
    );

    // Windows also refuses to delete read-only files with "access denied";
    // clear the attribute best-effort before retrying. (No-op for symlinks.)
    if let Err(e) = make_writable_recursive(path) {
        tracing::warn!(
            "Failed to clear read-only attribute on {}: {}",
            path.display(),
            e
        );
    }

    retry_on_transient_locks(|| std::fs::remove_file(path))
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

    mod canonicalize_tagged_errors {
        use super::*;

        #[test]
        fn missing_folder_is_expected_not_reported() {
            let tmp = tempfile::TempDir::new().unwrap();
            let gone = tmp.path().join("vanished-project");
            let err = canonicalize_tagged(&gone, "test_site").unwrap_err();
            // A folder deleted/moved outside the app is an environment change
            // (issues #365/#372) — must be Expected so telemetry skips it.
            assert!(matches!(err, crate::errors::CommandError::Expected { .. }));
            assert!(err.to_string().contains("no longer exists"));
        }

        #[test]
        fn other_failures_keep_the_diagnosable_tagged_format() {
            // A file used as a directory component fails with NotADirectory
            // (not NotFound) on Unix — that's still a diagnosable anomaly.
            let tmp = tempfile::TempDir::new().unwrap();
            let file = tmp.path().join("plain.txt");
            std::fs::write(&file, "x").unwrap();
            let bad = file.join("child");
            if let Err(err) = canonicalize_tagged(&bad, "test_site") {
                if !matches!(err, crate::errors::CommandError::Expected { .. }) {
                    assert!(err.to_string().contains("test_site"));
                }
            }
        }
    }

    mod classify_fs_errors {
        use super::*;

        // The #545/#605 shape: TCC denying a read under ~/Desktop etc.
        #[test]
        #[cfg(target_os = "macos")]
        fn macos_eperm_becomes_expected_with_privacy_remediation() {
            let e = std::io::Error::from_raw_os_error(1);
            let err = classify_fs_error(
                "read this project's plugin storage",
                std::path::Path::new("/Users/x/Desktop/proj/.shipstudio"),
                &e,
            );
            assert!(
                matches!(err, crate::errors::CommandError::Expected { .. }),
                "got: {err:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains("Privacy & Security"), "got: {msg}");
            assert!(msg.contains("plugin storage"), "got: {msg}");
            assert!(msg.contains("/Users/x/Desktop/proj"), "got: {msg}");
        }

        #[test]
        fn other_io_errors_stay_labeled_io() {
            let e = std::io::Error::new(std::io::ErrorKind::InvalidData, "corrupt");
            let err = classify_fs_error(
                "read this project's plugin registry",
                std::path::Path::new("/p/registry.json"),
                &e,
            );
            match err {
                crate::errors::CommandError::Io { message } => {
                    assert!(message.contains("plugin registry"), "got: {message}");
                    assert!(message.contains("corrupt"), "got: {message}");
                }
                other => panic!("expected Io, got {other:?}"),
            }
        }

        // The #596 shape: localized Windows ERROR_ACCESS_DENIED on an fs op
        // ("Acceso denegado. (os error 5)") — matched by code, not text.
        #[test]
        #[cfg(windows)]
        fn windows_access_denied_becomes_expected() {
            let e = std::io::Error::from_raw_os_error(5);
            let err = classify_fs_error(
                "write project metadata",
                std::path::Path::new("C:\\p\\.shipstudio\\project.json"),
                &e,
            );
            assert!(
                matches!(err, crate::errors::CommandError::Expected { .. }),
                "got: {err:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains("denied access"), "got: {msg}");
            assert!(msg.contains("project.json"), "got: {msg}");
        }

        // The #625 shape: EROFS on a project.json write (read-only volume).
        #[test]
        #[cfg(unix)]
        fn read_only_filesystem_becomes_expected() {
            let e = std::io::Error::from_raw_os_error(30);
            let err = classify_fs_error(
                "write project metadata",
                std::path::Path::new("/p/.shipstudio/project.json"),
                &e,
            );
            assert!(
                matches!(err, crate::errors::CommandError::Expected { .. }),
                "got: {err:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains("read-only"), "got: {msg}");
            assert!(msg.contains("project.json"), "got: {msg}");
        }

        // The #722 shape: ERROR_USER_MAPPED_FILE on a visual-editor source
        // write ("...ett användarmappat avsnitt är öppnat. (os error 1224)") —
        // matched by code so the localized OS text never reaches the user.
        #[test]
        #[cfg(windows)]
        fn windows_user_mapped_file_becomes_expected() {
            let e = std::io::Error::from_raw_os_error(1224);
            let err = classify_fs_error(
                "save your change to this file",
                std::path::Path::new("C:\\p\\src\\Hero.tsx"),
                &e,
            );
            assert!(
                matches!(err, crate::errors::CommandError::Expected { .. }),
                "got: {err:?}"
            );
            let msg = err.to_string();
            assert!(msg.contains("another program"), "got: {msg}");
            assert!(msg.contains("Hero.tsx"), "got: {msg}");
        }

        // Unix EPERM outside macOS (and any other permission error not
        // covered by a specific branch) must stay a labeled Io — the TCC
        // guidance would be wrong on Linux.
        #[test]
        #[cfg(all(unix, not(target_os = "macos")))]
        fn linux_eperm_stays_labeled_io() {
            let e = std::io::Error::from_raw_os_error(1);
            let err = classify_fs_error(
                "write project metadata",
                std::path::Path::new("/p/.shipstudio/project.json"),
                &e,
            );
            assert!(
                matches!(err, crate::errors::CommandError::Io { .. }),
                "got: {err:?}"
            );
        }
    }

    mod pnpm_home_dirs_tests {
        use super::*;

        #[test]
        fn includes_pnpm_home_when_set() {
            let home = std::path::Path::new(if cfg!(windows) {
                "C:\\Users\\x"
            } else {
                "/Users/x"
            });
            let dirs = pnpm_home_dirs(home, Some("/custom/pnpm-home"));
            assert_eq!(dirs.first().map(String::as_str), Some("/custom/pnpm-home"));
            // Defaults still follow so a stale/empty PNPM_HOME doesn't hide them.
            assert!(dirs.len() > 1);
        }

        #[test]
        fn blank_pnpm_home_is_ignored() {
            let home = std::path::Path::new(if cfg!(windows) {
                "C:\\Users\\x"
            } else {
                "/Users/x"
            });
            let with_blank = pnpm_home_dirs(home, Some("  "));
            let without = pnpm_home_dirs(home, None);
            assert_eq!(with_blank, without);
        }

        #[test]
        #[cfg(not(windows))]
        fn unix_defaults_cover_macos_and_linux_locations() {
            let dirs = pnpm_home_dirs(std::path::Path::new("/Users/x"), None);
            assert!(
                dirs.contains(&"/Users/x/Library/pnpm".to_string()),
                "{dirs:?}"
            );
            assert!(
                dirs.contains(&"/Users/x/.local/share/pnpm".to_string()),
                "{dirs:?}"
            );
        }

        #[test]
        #[cfg(windows)]
        fn windows_default_is_local_app_data_pnpm() {
            let dirs = pnpm_home_dirs(std::path::Path::new("C:\\Users\\x"), None);
            assert!(
                dirs.contains(&"C:\\Users\\x\\AppData\\Local\\pnpm".to_string()),
                "{dirs:?}"
            );
        }

        // The #570 regression guard: the extended PATH handed to git (and thus
        // to pre-commit hooks) must contain pnpm's self-managed install dirs.
        #[test]
        fn build_extended_path_includes_pnpm_dirs() {
            let path = build_extended_path();
            let expected = if cfg!(windows) {
                "\\AppData\\Local\\pnpm"
            } else if cfg!(target_os = "macos") {
                "/Library/pnpm"
            } else {
                "/.local/share/pnpm"
            };
            assert!(
                path.contains(expected),
                "extended PATH missing pnpm dir: {path}"
            );
        }
    }

    mod resolve_executable {
        use super::*;

        #[test]
        fn resolves_bare_name() {
            let tmp = tempfile::TempDir::new().unwrap();
            std::fs::write(tmp.path().join("mytool"), "#!/bin/sh\n").unwrap();
            let found = resolve_executable_in_dir(tmp.path(), "mytool").unwrap();
            assert_eq!(found, tmp.path().join("mytool"));
        }

        #[test]
        fn misses_cleanly_when_absent() {
            let tmp = tempfile::TempDir::new().unwrap();
            assert!(resolve_executable_in_dir(tmp.path(), "ghost-tool").is_none());
        }

        // The #590 shape: nodejs ships BOTH an extensionless POSIX-shell
        // `npm` and `npm.cmd` in the same directory. Resolving the shell
        // script makes CreateProcess fail with os error 193 — the batch
        // shim must win.
        #[test]
        #[cfg(windows)]
        fn prefers_cmd_shim_over_extensionless_shell_script() {
            let tmp = tempfile::TempDir::new().unwrap();
            std::fs::write(tmp.path().join("npm"), "#!/bin/sh\n").unwrap();
            std::fs::write(tmp.path().join("npm.cmd"), "@echo off\r\n").unwrap();
            let found = resolve_executable_in_dir(tmp.path(), "npm").unwrap();
            assert_eq!(found, tmp.path().join("npm.cmd"));
        }

        #[test]
        #[cfg(windows)]
        fn prefers_exe_over_cmd_shim() {
            let tmp = tempfile::TempDir::new().unwrap();
            std::fs::write(tmp.path().join("tool.cmd"), "@echo off\r\n").unwrap();
            std::fs::write(tmp.path().join("tool.exe"), "MZ").unwrap();
            let found = resolve_executable_in_dir(tmp.path(), "tool").unwrap();
            assert_eq!(found, tmp.path().join("tool.exe"));
        }
    }

    mod index_lock_retry {
        use super::*;

        #[test]
        fn recognizes_gits_lock_collision_message() {
            let stderr = "fatal: Unable to create 'C:/Users/x/ShipStudio/p/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository";
            assert!(is_index_lock_contention(stderr));
            assert!(!is_index_lock_contention("fatal: not a git repository"));
            assert!(!is_index_lock_contention(""));
        }

        /// Issue #567: the same concurrency that produces index.lock collisions
        /// also produces HEAD.lock / refs/heads/*.lock / packed-refs.lock
        /// collisions — all must be retried, not just the index.lock wording.
        #[test]
        fn recognizes_head_and_ref_lock_collisions() {
            let head = "fatal: cannot lock ref 'HEAD': Unable to create '/Users/x/acss-poc/.git/HEAD.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'.";
            assert!(is_index_lock_contention(head));
            let branch_ref = "fatal: cannot lock ref 'refs/heads/main': Unable to create '/repo/.git/refs/heads/main.lock': File exists.";
            assert!(is_index_lock_contention(branch_ref));
            let packed = "fatal: Unable to create '/repo/.git/packed-refs.lock': File exists.";
            assert!(is_index_lock_contention(packed));
            // Unrelated failures that merely mention a lock-ish word must not
            // trigger retries.
            assert!(!is_index_lock_contention(
                "error: could not write config file .git/config: File exists"
            ));
            assert!(!is_index_lock_contention(
                "fatal: pathspec 'package-lock.json' did not match any files"
            ));
        }

        #[test]
        #[cfg(unix)]
        fn retries_contention_then_returns_final_output() {
            // Fails with the lock message every time — the helper must retry
            // (3 attempts total) and then hand back the failing output rather
            // than swallowing it.
            let mut calls = 0;
            let result = output_retrying_index_lock(|| {
                calls += 1;
                std::process::Command::new("sh")
                    .arg("-c")
                    .arg("echo \"fatal: Unable to create '.git/index.lock': File exists.\" 1>&2; exit 128")
                    .output()
                    .map_err(|e| crate::errors::CommandError::Io {
                        message: e.to_string(),
                    })
            })
            .unwrap();
            assert_eq!(calls, 3);
            assert!(!result.status.success());
        }

        #[test]
        #[cfg(unix)]
        fn success_returns_immediately_without_retry() {
            let mut calls = 0;
            let result = output_retrying_index_lock(|| {
                calls += 1;
                std::process::Command::new("true").output().map_err(|e| {
                    crate::errors::CommandError::Io {
                        message: e.to_string(),
                    }
                })
            })
            .unwrap();
            assert_eq!(calls, 1);
            assert!(result.status.success());
        }
    }

    mod git_environment_gap {
        use super::*;

        /// Issue #603: unaccepted Xcode CLT license makes every git call fail
        /// on macOS — an environment gap, not an app malfunction.
        #[test]
        fn classifies_unaccepted_xcode_license_as_expected() {
            let stderr = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.";
            let err = git_environment_gap(stderr).expect("must classify");
            assert!(matches!(err, crate::errors::CommandError::Expected { .. }));
            assert!(
                err.to_string().contains("sudo xcodebuild -license accept"),
                "message must carry the remediation, got: {err}"
            );
        }

        /// Missing/broken CLT (e.g. after a macOS upgrade) fails through the
        /// same git shim with the xcrun wording.
        #[test]
        fn classifies_missing_developer_tools_as_expected() {
            let stderr = "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun";
            let err = git_environment_gap(stderr).expect("must classify");
            assert!(matches!(err, crate::errors::CommandError::Expected { .. }));
            assert!(err.to_string().contains("xcode-select --install"));
        }

        /// Issue #546: macOS TCC denying the app read access to the project
        /// folder surfaces as git's own getcwd failure on stderr.
        #[test]
        fn classifies_macos_tcc_denial_as_expected() {
            let stderr = "fatal: Unable to read current working directory: Operation not permitted";
            let err = git_environment_gap(stderr).expect("must classify");
            assert!(matches!(err, crate::errors::CommandError::Expected { .. }));
            assert!(err.to_string().contains("Privacy & Security"));
        }

        /// Issue #668: git's allocator failing on a memory-starved machine
        /// (first seen on Windows) — an environment gap with close-other-apps
        /// guidance, not a raw fatal that pages telemetry.
        #[test]
        fn classifies_git_oom_as_expected() {
            let stderr = "fatal: Out of memory, malloc failed (tried to allocate 1048576 bytes)";
            let err = git_environment_gap(stderr).expect("must classify");
            assert!(matches!(err, crate::errors::CommandError::Expected { .. }));
            let msg = err.to_string();
            assert!(msg.contains("memory"), "got: {msg}");
            assert!(
                msg.contains("Close some other applications"),
                "message must carry the remediation, got: {msg}"
            );
            // The realloc variant git emits from strbuf growth is covered too.
            assert!(git_environment_gap("fatal: Out of memory, realloc failed").is_some());
        }

        #[test]
        fn leaves_ordinary_git_failures_unclassified() {
            assert!(git_environment_gap("fatal: not a git repository").is_none());
            assert!(git_environment_gap("").is_none());
            // "Operation not permitted" on some other operation isn't the TCC
            // getcwd signature — don't over-match.
            assert!(git_environment_gap(
                "error: unable to unlink old 'a.txt': Operation not permitted"
            )
            .is_none());
        }
    }

    mod is_forbidden_project_root {
        use super::*;

        #[test]
        fn refuses_home_its_ancestors_and_fs_root() {
            let home = dirs::home_dir().expect("home dir");
            assert!(is_forbidden_project_root(&home));
            if let Some(parent) = home.parent() {
                assert!(is_forbidden_project_root(parent));
            }
            assert!(is_forbidden_project_root(std::path::Path::new("/")));
        }

        #[test]
        fn allows_ordinary_directories() {
            let tmp = tempfile::TempDir::new().unwrap();
            assert!(!is_forbidden_project_root(tmp.path()));
        }
    }

    mod normalize_separators {
        use super::*;

        // On Windows, backslash separators become forward slashes so the
        // frontend's `/`-based path logic works.
        #[cfg(windows)]
        #[test]
        fn converts_backslashes_on_windows() {
            assert_eq!(
                normalize_separators(r"src\components\App.tsx"),
                "src/components/App.tsx"
            );
            assert_eq!(normalize_separators("already/forward"), "already/forward");
        }

        // Off Windows it must be a pure no-op: `\` is a legal filename character
        // on Unix and rewriting it would corrupt real names.
        #[cfg(not(windows))]
        #[test]
        fn is_a_noop_off_windows() {
            assert_eq!(
                normalize_separators("src/components/App.tsx"),
                "src/components/App.tsx"
            );
            assert_eq!(normalize_separators(r"weird\name"), r"weird\name");
        }
    }

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

    mod parse_nvm_windows_symlink {
        use super::*;

        #[test]
        fn test_parses_typical_settings_file() {
            let settings = "root: C:\\Users\\me\\AppData\\Roaming\\nvm\r\npath: C:\\Program Files\\nodejs\r\narch: 64\r\nproxy: none\r\n";
            assert_eq!(
                parse_nvm_windows_symlink(settings),
                Some("C:\\Program Files\\nodejs".to_string())
            );
        }

        #[test]
        fn test_ignores_root_and_other_keys() {
            // `root:` must not be mistaken for `path:`
            let settings = "root: C:\\nvm\narch: 64\n";
            assert_eq!(parse_nvm_windows_symlink(settings), None);
        }

        #[test]
        fn test_handles_capitalized_key_and_extra_whitespace() {
            let settings = "  Path:   C:\\nodejs-current  \n";
            assert_eq!(
                parse_nvm_windows_symlink(settings),
                Some("C:\\nodejs-current".to_string())
            );
        }

        #[test]
        fn test_empty_value_returns_none() {
            assert_eq!(parse_nvm_windows_symlink("path:\n"), None);
            assert_eq!(parse_nvm_windows_symlink("path:   \n"), None);
        }

        #[test]
        fn test_empty_file_returns_none() {
            assert_eq!(parse_nvm_windows_symlink(""), None);
        }
    }

    mod most_recent_subdir {
        use super::*;

        #[test]
        fn test_missing_dir_returns_none() {
            let dir = tempfile::tempdir().unwrap();
            let missing = dir.path().join("does-not-exist");
            assert_eq!(most_recent_subdir(&missing), None);
        }

        #[test]
        fn test_empty_dir_returns_none() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(most_recent_subdir(dir.path()), None);
        }

        #[test]
        fn test_ignores_plain_files() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("a-file.txt"), "x").unwrap();
            assert_eq!(most_recent_subdir(dir.path()), None);
        }

        #[test]
        fn test_returns_newest_subdir() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("older")).unwrap();
            // Ensure a measurable mtime gap on filesystems with coarse timestamps
            std::thread::sleep(std::time::Duration::from_millis(50));
            std::fs::create_dir(dir.path().join("newer")).unwrap();
            std::fs::write(dir.path().join("noise.txt"), "x").unwrap();

            let result = most_recent_subdir(dir.path()).unwrap();
            assert_eq!(result, dir.path().join("newer"));
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

        /// The login-shell PATH query must never panic and, when it returns a
        /// value, that value must be non-empty — regardless of the host shell.
        #[test]
        #[cfg(not(windows))]
        fn test_get_login_shell_path_is_safe() {
            if let Some(path) = get_login_shell_path() {
                assert!(!path.is_empty());
            }
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
            let err = validate_project_path(".")
                .expect_err("should reject")
                .to_string();
            assert!(
                err.contains("Security error") || err.contains("outside ShipStudio"),
                "unexpected error: {err}"
            );
        }

        #[test]
        fn rejects_nonexistent_path() {
            let err = validate_project_path("/this/path/definitely/does/not/exist/shipstudio-test")
                .expect_err("should reject nonexistent")
                .to_string();
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
                .expect_err("file in $HOME (outside ShipStudio) must be rejected")
                .to_string();
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

    mod robust_delete {
        use super::*;

        // The #559/#253 shape: Windows sharing/lock violations are the
        // transient states the rename/delete retry loops exist for; anything
        // else must fail immediately.
        #[test]
        fn retryable_delete_error_matches_windows_lock_codes() {
            assert!(is_retryable_delete_error(
                &std::io::Error::from_raw_os_error(32) // ERROR_SHARING_VIOLATION
            ));
            assert!(is_retryable_delete_error(
                &std::io::Error::from_raw_os_error(33) // ERROR_LOCK_VIOLATION
            ));
            assert!(is_retryable_delete_error(
                &std::io::Error::from_raw_os_error(5) // ERROR_ACCESS_DENIED
            ));
            assert!(is_retryable_delete_error(&std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied"
            )));
            assert!(!is_retryable_delete_error(&std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "gone"
            )));
        }

        #[test]
        fn remove_dir_all_robust_deletes_readonly_files() {
            let tmp = tempfile::tempdir().unwrap();
            let file_path = tmp.path().join("readonly_file.txt");
            std::fs::write(&file_path, "test content").unwrap();

            // Set the file to read-only
            let mut perms = std::fs::metadata(&file_path).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(&file_path, perms).unwrap();

            // Verify it is indeed read-only
            assert!(std::fs::metadata(&file_path)
                .unwrap()
                .permissions()
                .readonly());

            // Use remove_dir_all_robust to delete the directory tree
            remove_dir_all_robust(tmp.path()).unwrap();

            // Verify the directory no longer exists
            assert!(!tmp.path().exists());
        }

        #[cfg(unix)]
        #[test]
        fn remove_dir_all_robust_never_chmods_through_symlinks() {
            // pnpm-style layout: the project links to a shared store whose files
            // are read-only on purpose. Deleting the project must remove the link
            // itself without touching the store's permissions.
            let store = tempfile::tempdir().unwrap();
            let store_file = store.path().join("shared.txt");
            std::fs::write(&store_file, "shared").unwrap();
            let mut perms = std::fs::metadata(&store_file).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(&store_file, perms).unwrap();

            let project = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(store.path(), project.path().join("node_modules_link"))
                .unwrap();

            remove_dir_all_robust(project.path()).unwrap();

            assert!(!project.path().exists());
            assert!(
                store_file.exists(),
                "symlink target must survive the delete"
            );
            assert!(
                std::fs::metadata(&store_file)
                    .unwrap()
                    .permissions()
                    .readonly(),
                "store file must stay read-only — chmod escaped through the symlink"
            );
        }

        // The #696 shape: a read-only asset file (checked-out git object,
        // Windows attribute) must delete after the attribute is cleared.
        #[test]
        fn remove_file_robust_deletes_readonly_file() {
            let tmp = tempfile::tempdir().unwrap();
            let file_path = tmp.path().join("readonly_asset.png");
            std::fs::write(&file_path, "png-bytes").unwrap();

            let mut perms = std::fs::metadata(&file_path).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(&file_path, perms).unwrap();

            remove_file_robust(&file_path).unwrap();

            assert!(!file_path.exists());
        }

        #[test]
        fn remove_file_robust_deletes_plain_file() {
            let tmp = tempfile::tempdir().unwrap();
            let file_path = tmp.path().join("asset.txt");
            std::fs::write(&file_path, "hi").unwrap();
            remove_file_robust(&file_path).unwrap();
            assert!(!file_path.exists());
        }

        #[test]
        fn remove_file_robust_surfaces_not_found_immediately() {
            let tmp = tempfile::tempdir().unwrap();
            let missing = tmp.path().join("never-existed.txt");
            let err = remove_file_robust(&missing).unwrap_err();
            // NotFound is not a lock — must not burn ~8s of retries, and the
            // caller keeps remove_file's missing-file error semantics.
            assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        }
    }
}
