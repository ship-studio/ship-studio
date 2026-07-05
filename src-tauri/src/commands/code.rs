//! # Code Browser Commands
//!
//! Commands for browsing project files with syntax highlighting support.
//! Provides a read-only file browser that respects .gitignore.

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::{create_command, validate_project_path};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A file or directory entry in the project tree.
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
}

/// Content of a single file with metadata for the viewer.
#[derive(Debug, Serialize)]
pub struct FileContent {
    pub content: String,
    pub is_binary: bool,
    pub is_truncated: bool,
    pub size: u64,
    pub language: String,
}

/// Maximum number of file entries to return.
const MAX_ENTRIES: usize = 10_000;

/// Maximum file size to read (500KB).
const MAX_FILE_SIZE: u64 = 500 * 1024;

/// Directories to always skip, even if not in .gitignore.
pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".shipstudio",
    ".next",
    ".vercel",
    "dist",
    "build",
    ".turbo",
    ".cache",
];

/// List all files in a project, respecting .gitignore.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn list_project_files(project_path: &str) -> Result<Vec<FileEntry>, CommandError> {
    let project = validate_project_path(project_path)?;

    let mut entries = Vec::new();

    let walker = WalkBuilder::new(&project)
        .hidden(false) // Don't skip dotfiles by default (gitignore handles this)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        // Prune always-skip directories during the walk by their own name.
        // This matters most on Windows and for non-git projects: the `ignore`
        // crate only applies .gitignore when a `.git` dir is present, so without
        // this `node_modules` would be descended into and flood the tree.
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        })
        .build();

    for result in walker {
        if entries.len() >= MAX_ENTRIES {
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        // Skip the root directory itself
        if path == project.as_path() {
            continue;
        }

        // Get the relative path
        let relative = match path.strip_prefix(&project) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let relative_str = relative.to_string_lossy().to_string();

        // Skip entries in always-skipped directories
        if should_skip_path(relative) {
            continue;
        }

        let is_dir = path.is_dir();
        let size = if is_dir {
            0
        } else {
            path.metadata().map(|m| m.len()).unwrap_or(0)
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        entries.push(FileEntry {
            name,
            path: relative_str,
            is_directory: is_dir,
            size,
        });
    }

    Ok(entries)
}

/// Check if a relative path should be skipped based on SKIP_DIRS.
///
/// Matches on individual path components so it behaves identically on Windows
/// (`\` separators) and Unix (`/`). The previous string-based matching on `/`
/// silently failed on Windows and leaked `node_modules` contents into the tree.
fn should_skip_path(relative: &Path) -> bool {
    relative.components().any(|component| match component {
        std::path::Component::Normal(name) => SKIP_DIRS
            .iter()
            .any(|skip| name == std::ffi::OsStr::new(skip)),
        _ => false,
    })
}

/// Read a single file from the project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn read_project_file(project_path: &str, file_path: &str) -> Result<FileContent, CommandError> {
    let project = validate_project_path(project_path)?;

    // Prevent path traversal
    if file_path.contains("..") {
        return Err(("Invalid path: path traversal not allowed".to_string()).into());
    }

    let full_path = project.join(file_path);

    // Verify the file is within the project
    let canonical = dunce::canonicalize(&full_path).map_err(|e| format!("File not found: {e}"))?;
    if !canonical.starts_with(&project) {
        return Err(("Security error: path is outside project directory".to_string()).into());
    }

    if !canonical.is_file() {
        return Err(("Path is not a file".to_string()).into());
    }

    let metadata =
        std::fs::metadata(&canonical).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let size = metadata.len();

    // Check file size limit
    if size > MAX_FILE_SIZE {
        return Ok(FileContent {
            content: String::new(),
            is_binary: false,
            is_truncated: true,
            size,
            language: infer_language(file_path),
        });
    }

    // Read the file bytes
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Failed to read file: {e}"))?;

    // Check for binary content (null bytes in first 8KB)
    let check_len = bytes.len().min(8192);
    let is_binary = bytes[..check_len].contains(&0);

    if is_binary {
        return Ok(FileContent {
            content: String::new(),
            is_binary: true,
            is_truncated: false,
            size,
            language: String::new(),
        });
    }

    let content = String::from_utf8_lossy(&bytes).to_string();
    let language = infer_language(file_path);

    Ok(FileContent {
        content,
        is_binary: false,
        is_truncated: false,
        size,
        language,
    })
}

/// Timeout for the small git porcelain calls used by the move command.
const GIT_MOVE_TIMEOUT_SECS: u64 = 30;

/// Validate a caller-supplied, project-relative path. Rejects absolute paths,
/// backslashes, and any `.`/`..`/empty segment (traversal). An empty string is
/// allowed and means "the project root". Returns the cleaned, forward-slashed
/// relative path.
fn sanitize_rel(rel: &str) -> Result<String, CommandError> {
    let trimmed = rel.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.contains('\\')
        || Path::new(trimmed).is_absolute()
        || trimmed
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: format!("'{rel}' is not a valid project-relative path"),
        });
    }
    Ok(trimmed.to_string())
}

/// True when relocating `from_rel` (a directory) into `to_dir_rel` would place
/// it inside itself or one of its own descendants — which must be rejected.
/// Both args are project-relative. Pure/string-based so it is unit-testable.
fn is_self_or_descendant(from_rel: &str, to_dir_rel: &str) -> bool {
    let from = from_rel.trim_matches('/');
    let to = to_dir_rel.trim_matches('/');
    if from.is_empty() {
        return false;
    }
    to == from || to.starts_with(&format!("{from}/"))
}

/// Is something already present at `path`? Uses `symlink_metadata` (not
/// `exists`) so a BROKEN symlink also counts as occupied — otherwise a planted
/// broken symlink reads as "free" and a later write would follow it out of the
/// sandbox.
fn occupied(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Compute a non-colliding name in `dir` for `name`, inserting `-2`, `-3`, …
/// before the extension (`logo.png` → `logo-2.png`; `assets` → `assets-2`).
fn unique_name(dir: &Path, name: &str) -> String {
    if !occupied(&dir.join(name)) {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string());
    let ext = path.extension().map(|e| e.to_string_lossy().to_string());
    let mut n = 2u32;
    loop {
        let candidate = match (&stem, &ext) {
            (Some(stem), Some(ext)) if !stem.is_empty() => format!("{stem}-{n}.{ext}"),
            _ => format!("{name}-{n}"),
        };
        if !occupied(&dir.join(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// Render an absolute path as a forward-slashed path relative to `root`.
fn to_rel_string(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Recursively copy a directory tree, skipping symlinks for safety. The caller
/// must have already confined `dest` to the project (canonical containment) —
/// this function trusts that and does not re-check on each recursion.
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), CommandError> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if file_type.is_symlink() {
            // Don't follow symlinks from an untrusted source into the project.
            continue;
        } else if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
        // Skip FIFOs, device files, sockets, etc. — only regular files and dirs.
    }
    Ok(())
}

/// Does git track anything at `rel` inside `root`? Returns false outside a repo.
async fn git_tracks(root: &Path, rel: &str) -> bool {
    let mut cmd = create_command("git");
    cmd.args(["ls-files", "--", rel]).current_dir(root);
    match run_with_timeout(
        tokio::process::Command::from(cmd),
        "git ls-files",
        GIT_MOVE_TIMEOUT_SECS,
    )
    .await
    {
        Ok(output) => output.status.success() && !output.stdout.is_empty(),
        Err(err) => {
            // Distinguish "not a repo / not tracked" (a normal false) from a
            // genuine git invocation failure, which silently degrades to a plain
            // rename — log it so that degradation is diagnosable.
            tracing::warn!(error = %err, path = rel, "git ls-files failed; treating path as untracked");
            false
        }
    }
}

/// A planned destination after applying the conflict policy.
#[derive(Debug)]
struct DestPlan {
    /// Final path to write to (possibly renamed for the "rename" policy).
    dest: PathBuf,
    /// True when an existing, non-symlink target must be overwritten in place.
    replace: bool,
}

/// Decide the destination + overwrite intent for `base_name` in `dest_dir` under
/// `on_conflict` ("replace" | "rename" | anything-else = error). Never mutates
/// the filesystem. Two distinguishable error shapes:
/// - `Validation { field: "destination" }` — a genuine name collision; the
///   frontend turns this into a Rename/Replace/Skip prompt.
/// - `Validation { field: "symlink" }` — asked to replace a symlinked target; a
///   hard refusal (NOT a re-promptable collision, so it must be told apart).
fn plan_dest(
    dest_dir: &Path,
    base_name: &str,
    on_conflict: &str,
) -> Result<DestPlan, CommandError> {
    let dest = dest_dir.join(base_name);
    if !occupied(&dest) {
        return Ok(DestPlan {
            dest,
            replace: false,
        });
    }
    match on_conflict {
        "replace" => {
            // remove_*/rename/copy all follow symlinks — refuse to clobber one.
            let is_symlink = std::fs::symlink_metadata(&dest)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if is_symlink {
                return Err(CommandError::Validation {
                    field: "symlink".to_string(),
                    reason: "Refusing to replace a symlinked path".to_string(),
                });
            }
            Ok(DestPlan {
                dest,
                replace: true,
            })
        }
        "rename" => Ok(DestPlan {
            dest: dest_dir.join(unique_name(dest_dir, base_name)),
            replace: false,
        }),
        _ => Err(CommandError::Validation {
            field: "destination".to_string(),
            reason: format!("An item named '{base_name}' already exists in that folder"),
        }),
    }
}

/// Remove an existing (already-confirmed non-symlink) destination so a move/copy
/// can overwrite it in place.
fn remove_existing(dest: &Path) -> Result<(), CommandError> {
    if dest.is_dir() {
        std::fs::remove_dir_all(dest)?;
    } else {
        std::fs::remove_file(dest)?;
    }
    Ok(())
}

/// Per-source result of an import — lets the frontend resolve conflicts per file
/// (Rename/Replace/Skip) instead of failing the whole drag.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// The input source path, echoed back so the frontend can correlate.
    pub source: String,
    /// "imported" — copied in; "conflict" — name already taken (nothing written).
    pub status: String,
    /// New project-relative path; present only when `status == "imported"`.
    pub new_rel: Option<String>,
    /// Whether the source is a directory (drives the frontend's prompt + icon).
    pub is_dir: bool,
}

/// Move/relocate a file or directory within the project tree, preserving git
/// tracking when the source is tracked (`git mv`), otherwise a plain rename.
///
/// `from_rel` and `to_dir_rel` are project-relative (`to_dir_rel == ""` is the
/// project root). `on_conflict` is `"error"` (default — surfaces a `Validation`
/// error the UI turns into a Rename/Replace/Skip prompt), `"replace"`, or
/// `"rename"`. Rejects traversal, moving the root, and moving a folder into
/// itself or a descendant. Returns the new project-relative path.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn move_project_entry(
    project_path: String,
    from_rel: String,
    to_dir_rel: String,
    on_conflict: String,
) -> Result<String, CommandError> {
    let root = validate_project_path(&project_path)?;

    let from = sanitize_rel(&from_rel)?;
    if from.is_empty() {
        return Err(CommandError::Validation {
            field: "from".to_string(),
            reason: "Cannot move the project root".to_string(),
        });
    }
    let to_dir = sanitize_rel(&to_dir_rel)?;

    // Reject moving a folder into itself or one of its descendants.
    if is_self_or_descendant(&from, &to_dir) {
        return Err(CommandError::Validation {
            field: "to".to_string(),
            reason: "Cannot move a folder into itself".to_string(),
        });
    }

    // Source must exist and resolve inside the project.
    let source = root.join(&from);
    let source_canon = dunce::canonicalize(&source).map_err(|e| CommandError::Validation {
        field: "from".to_string(),
        reason: format!("Source not found: {e}"),
    })?;
    if !source_canon.starts_with(&root) {
        return Err(CommandError::Validation {
            field: "from".to_string(),
            reason: "Source is outside the project".to_string(),
        });
    }

    // Destination directory must be an existing folder inside the project.
    let dest_dir = if to_dir.is_empty() {
        root.clone()
    } else {
        root.join(&to_dir)
    };
    let dest_dir_canon = dunce::canonicalize(&dest_dir).map_err(|e| CommandError::Validation {
        field: "to".to_string(),
        reason: format!("Target folder not found: {e}"),
    })?;
    if !dest_dir_canon.starts_with(&root) {
        return Err(CommandError::Validation {
            field: "to".to_string(),
            reason: "Target is outside the project".to_string(),
        });
    }
    if !dest_dir_canon.is_dir() {
        return Err(CommandError::Validation {
            field: "to".to_string(),
            reason: "Target is not a folder".to_string(),
        });
    }

    // No-op: dropping an entry into the folder it already lives in.
    if source_canon.parent() == Some(dest_dir_canon.as_path()) {
        return Ok(from);
    }

    let base_name = source_canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| CommandError::Validation {
            field: "from".to_string(),
            reason: "Invalid source name".to_string(),
        })?;

    let plan = plan_dest(&dest_dir_canon, &base_name, &on_conflict)?;
    let dest_rel = to_rel_string(&root, &plan.dest);

    if git_tracks(&root, &from).await {
        // Let git own the move so tracking + index stay consistent. `-f` lets it
        // clobber the (non-symlink) target git-atomically in the replace case —
        // a manual fs delete would leave the index pointing at a stale path.
        // `--` stops a leading-dash path from being read as an option.
        let mut cmd = create_command("git");
        cmd.arg("mv");
        if plan.replace {
            cmd.arg("-f");
        }
        cmd.arg("--").arg(&from).arg(&dest_rel).current_dir(&root);
        let output = run_with_timeout(
            tokio::process::Command::from(cmd),
            "git mv",
            GIT_MOVE_TIMEOUT_SECS,
        )
        .await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            // Narrow fallback: a path git ls-files matched but `git mv` won't
            // move (e.g. "not under version control") still completes as a plain
            // FS move. Any other failure is surfaced, not silently masked.
            if stderr.contains("not under version control") {
                if plan.replace {
                    remove_existing(&plan.dest)?;
                }
                // Move the entry itself (not the canonicalized target) so a
                // symlink is relocated rather than its link target. Containment
                // was already enforced above via `source_canon.starts_with(&root)`.
                std::fs::rename(&source, &plan.dest)?;
            } else {
                return Err(CommandError::Process {
                    cmd: "git mv".to_string(),
                    exit_code: output.status.code().unwrap_or(-1),
                    stderr,
                });
            }
        }
    } else {
        if plan.replace {
            remove_existing(&plan.dest)?;
        }
        // Move the entry itself (not the canonicalized target) so a symlink is
        // relocated rather than its link target. Containment was already
        // enforced above via `source_canon.starts_with(&root)`.
        std::fs::rename(&source, &plan.dest)?;
    }

    Ok(dest_rel)
}

/// Import (copy) files/folders from arbitrary OS locations into a project
/// folder — the backend for dragging from Finder onto the file tree.
///
/// `sources` are absolute OS paths (validated to exist; intentionally NOT
/// confined to ShipStudio — importing external files is the point). Only the
/// destination is confined to the project. `to_dir_rel` is project-relative
/// (`""` = root, created if missing). `on_conflict` matches
/// [`move_project_entry`]. Symlinks inside copied folders are skipped.
///
/// Returns one [`ImportOutcome`] per source, in input order: collisions under
/// the default policy come back as `status: "conflict"` (nothing written) rather
/// than aborting the whole drag, so the frontend can prompt Rename/Replace/Skip
/// per file and re-import only the unresolved ones with a chosen policy.
#[tauri::command]
#[tracing::instrument(skip(project_path, sources), fields(project = %project_path))]
pub async fn import_paths_to_project(
    project_path: String,
    sources: Vec<String>,
    to_dir_rel: String,
    on_conflict: String,
) -> Result<Vec<ImportOutcome>, CommandError> {
    let root = validate_project_path(&project_path)?;
    if sources.is_empty() {
        return Err(CommandError::Validation {
            field: "sources".to_string(),
            reason: "No files to import".to_string(),
        });
    }

    let to_dir = sanitize_rel(&to_dir_rel)?;
    let dest_dir = if to_dir.is_empty() {
        root.clone()
    } else {
        root.join(&to_dir)
    };
    // Validate containment BEFORE creating anything: walk up to the nearest
    // existing ancestor, canonicalize it, and confirm it is inside the project.
    // Otherwise create_dir_all could materialize directories THROUGH an
    // in-project symlink that escapes the root before the post-check rejects it.
    {
        let mut ancestor: &Path = dest_dir.as_path();
        while !ancestor.exists() {
            match ancestor.parent() {
                Some(parent) => ancestor = parent,
                None => break,
            }
        }
        let ancestor_canon =
            dunce::canonicalize(ancestor).map_err(|e| CommandError::Validation {
                field: "to".to_string(),
                reason: format!("Target folder not found: {e}"),
            })?;
        if !ancestor_canon.starts_with(&root) {
            return Err(CommandError::Validation {
                field: "to".to_string(),
                reason: "Target is outside the project".to_string(),
            });
        }
    }
    // Create the target folder if needed, then re-canonicalize + confirm it is
    // inside the project. canonicalize resolves symlinks, so a symlinked folder
    // that escapes the root fails the containment check here too (defense in
    // depth against a symlink created by the operation itself).
    if !dest_dir.exists() {
        std::fs::create_dir_all(&dest_dir).map_err(|e| CommandError::Io {
            message: format!("Failed to create folder: {e}"),
        })?;
    }
    let dest_dir_canon = dunce::canonicalize(&dest_dir).map_err(|e| CommandError::Validation {
        field: "to".to_string(),
        reason: format!("Target folder not found: {e}"),
    })?;
    if !dest_dir_canon.starts_with(&root) {
        return Err(CommandError::Validation {
            field: "to".to_string(),
            reason: "Target is outside the project".to_string(),
        });
    }
    if !dest_dir_canon.is_dir() {
        return Err(CommandError::Validation {
            field: "to".to_string(),
            reason: "Target is not a folder".to_string(),
        });
    }

    let mut outcomes = Vec::with_capacity(sources.len());
    for src in &sources {
        let src_canon =
            dunce::canonicalize(Path::new(src)).map_err(|e| CommandError::Validation {
                field: "source".to_string(),
                reason: format!("Cannot read '{src}': {e}"),
            })?;

        // Reject importing a folder that contains the destination (would loop).
        if src_canon.is_dir() && dest_dir_canon.starts_with(&src_canon) {
            return Err(CommandError::Validation {
                field: "source".to_string(),
                reason: "Cannot import a folder into itself".to_string(),
            });
        }

        let base_name = src_canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| CommandError::Validation {
                field: "source".to_string(),
                reason: "Invalid source name".to_string(),
            })?;
        let is_dir = src_canon.is_dir();

        // Under the default policy a collision is reported per-source (not a
        // batch error), so the frontend can prompt for just the conflicting
        // files and re-import them with a chosen policy.
        if on_conflict != "replace"
            && on_conflict != "rename"
            && occupied(&dest_dir_canon.join(&base_name))
        {
            outcomes.push(ImportOutcome {
                source: src.clone(),
                status: "conflict".to_string(),
                new_rel: None,
                is_dir,
            });
            continue;
        }

        let plan = plan_dest(&dest_dir_canon, &base_name, &on_conflict)?;
        if plan.replace {
            // Guard: source and destination are the same path — nothing to do
            // (importing a file into its own parent with on_conflict=replace would
            // otherwise delete the source before the copy runs).
            if dunce::canonicalize(&plan.dest).ok().as_deref() == Some(src_canon.as_path()) {
                outcomes.push(ImportOutcome {
                    source: src.clone(),
                    status: "imported".to_string(),
                    new_rel: Some(to_rel_string(&root, &plan.dest)),
                    is_dir,
                });
                continue;
            }
            remove_existing(&plan.dest)?;
        }

        if is_dir {
            copy_dir_recursive(&src_canon, &plan.dest)?;
        } else {
            std::fs::copy(&src_canon, &plan.dest).map_err(|e| CommandError::Io {
                message: format!("Failed to copy '{base_name}': {e}"),
            })?;
        }

        outcomes.push(ImportOutcome {
            source: src.clone(),
            status: "imported".to_string(),
            new_rel: Some(to_rel_string(&root, &plan.dest)),
            is_dir,
        });
    }

    Ok(outcomes)
}

/// Validate a project-relative path for deletion and return the absolute target.
///
/// Resolves the PARENT directory's canonical path (not the entry itself) so a
/// symlinked entry is deleted as the link rather than followed out of the
/// project, then confirms that parent is inside `root`. Rejects traversal, the
/// empty/root path, and an entry that no longer exists. `root` must already be
/// canonical (as returned by `validate_project_path`). Pure (no deletion) so the
/// guard logic is unit-testable without touching the OS trash.
fn resolve_deletable(root: &Path, rel: &str) -> Result<std::path::PathBuf, CommandError> {
    let rel = sanitize_rel(rel)?;
    if rel.is_empty() {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: "Cannot delete the project root".to_string(),
        });
    }

    let target = root.join(&rel);
    let parent = target.parent().ok_or_else(|| CommandError::Validation {
        field: "path".to_string(),
        reason: "Invalid path".to_string(),
    })?;
    let parent_canon = dunce::canonicalize(parent).map_err(|e| CommandError::Validation {
        field: "path".to_string(),
        reason: format!("Cannot find '{rel}': {e}"),
    })?;
    if !parent_canon.starts_with(root) {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: "Target is outside the project".to_string(),
        });
    }

    let file_name = target.file_name().ok_or_else(|| CommandError::Validation {
        field: "path".to_string(),
        reason: "Invalid path".to_string(),
    })?;
    let final_target = parent_canon.join(file_name);
    if final_target == *root {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: "Cannot delete the project root".to_string(),
        });
    }
    // symlink_metadata (via occupied) counts a broken symlink as present, so a
    // dangling link is still deletable rather than reported as "missing".
    if !occupied(&final_target) {
        return Err(CommandError::Validation {
            field: "path".to_string(),
            reason: format!("'{rel}' no longer exists"),
        });
    }
    Ok(final_target)
}

/// Delete a file or directory from the project by moving it to the OS Trash /
/// Recycle Bin (recoverable), rather than permanently unlinking it. `rel` is
/// project-relative; traversal, the project root, and missing entries are
/// rejected before anything is touched.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn delete_project_entry(project_path: String, rel: String) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let target = resolve_deletable(&root, &rel)?;
    // trash::delete is a synchronous platform call; trashing a large directory
    // tree can take a while, so run it off the async runtime's worker threads.
    tokio::task::spawn_blocking(move || trash::delete(&target))
        .await
        .map_err(|e| CommandError::Io {
            message: format!("Delete task panicked: {e}"),
        })?
        .map_err(|e| CommandError::Io {
            message: format!("Failed to move to Trash: {e}"),
        })?;

    Ok(())
}

/// Overwrite a single project file with new content.
///
/// Used by the Code tab's inline editor. Only edits files that already exist
/// and live inside the project; refuses path traversal, symlink escapes, and
/// oversized writes (matching the [`MAX_FILE_SIZE`] read limit). Directories
/// and brand-new paths are intentionally out of scope — the editor only saves
/// files it first opened via [`read_project_file`].
#[tauri::command]
// skip_all so the file `content` argument is never captured into the span/logs;
// only the safe path fields are recorded.
#[tracing::instrument(skip_all, fields(project = %project_path, file = %file_path))]
pub fn save_project_file(
    project_path: &str,
    file_path: &str,
    content: &str,
) -> Result<(), CommandError> {
    let project = validate_project_path(project_path)?;

    // Prevent path traversal
    if file_path.contains("..") {
        return Err(("Invalid path: path traversal not allowed".to_string()).into());
    }

    let full_path = project.join(file_path);

    // Canonicalize the existing file and verify it stays within the project.
    // The editor only ever saves a file it already opened, so the target must
    // exist — this also resolves symlinks so we can reject escapes.
    let canonical = dunce::canonicalize(&full_path).map_err(|e| format!("File not found: {e}"))?;
    if !canonical.starts_with(&project) {
        return Err(("Security error: path is outside project directory".to_string()).into());
    }

    if !canonical.is_file() {
        return Err(("Path is not a file".to_string()).into());
    }

    // Keep writes bounded to the same limit the reader enforces.
    if content.len() as u64 > MAX_FILE_SIZE {
        return Err(("File is too large to save".to_string()).into());
    }

    std::fs::write(&canonical, content).map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(())
}

/// Infer the Shiki language identifier from a file path.
///
/// Checks the filename first for well-known extensionless files (Dockerfile, Makefile, etc.),
/// then falls back to extension-based matching.
fn infer_language(file_path: &str) -> String {
    // Check filename for extensionless files
    let filename = Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    match filename.as_str() {
        "Dockerfile" | "dockerfile" | "Containerfile" => return "dockerfile".to_string(),
        "Makefile" | "makefile" | "GNUmakefile" => return "makefile".to_string(),
        "Justfile" | "justfile" => return "just".to_string(),
        ".gitignore" | ".gitattributes" | ".dockerignore" | ".editorconfig" => {
            return "ini".to_string()
        }
        ".env" | ".env.local" | ".env.production" | ".env.development" => return "ini".to_string(),
        _ => {}
    }

    let ext = Path::new(file_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "rs" => "rust",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "md" | "mdx" => "markdown",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "ps1" => "powershell",
        "dockerfile" => "dockerfile",
        "graphql" | "gql" => "graphql",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "php" => "php",
        "lua" => "lua",
        "r" => "r",
        "dart" => "dart",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "erl" => "erlang",
        "clj" | "cljs" => "clojure",
        "hs" => "haskell",
        "scala" => "scala",
        "tf" => "hcl",
        "prisma" => "prisma",
        "env" => "ini",
        "ini" | "cfg" => "ini",
        "log" => "log",
        "txt" => "plaintext",
        _ => "plaintext",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infer_language() {
        assert_eq!(infer_language("src/main.rs"), "rust");
        assert_eq!(infer_language("index.tsx"), "tsx");
        assert_eq!(infer_language("package.json"), "json");
        assert_eq!(infer_language("styles.css"), "css");
        assert_eq!(infer_language("README.md"), "markdown");
        assert_eq!(infer_language("Dockerfile"), "dockerfile");
        assert_eq!(infer_language("Makefile"), "makefile");
        assert_eq!(infer_language(".gitignore"), "ini");
        assert_eq!(infer_language("path/to/Justfile"), "just");
        assert_eq!(infer_language("script.sh"), "bash");
        assert_eq!(infer_language("unknown.xyz"), "plaintext");
    }

    #[test]
    fn test_save_project_file_roundtrip() {
        // The path validator only trusts projects under the configured projects
        // root (default ~/ShipStudio), so the fixture must live there.
        let root = crate::utils::projects_root().expect("projects root");
        let dir = root.join(format!("shipstudio-code-save-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_string_lossy().to_string();
        let file = dir.join("note.txt");
        std::fs::write(&file, "original").unwrap();

        // Happy path: existing file is overwritten.
        save_project_file(&project, "note.txt", "updated").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "updated");

        // Path traversal is rejected.
        assert!(save_project_file(&project, "../escape.txt", "x").is_err());

        // Saving a path that doesn't exist yet is rejected (the editor only
        // edits files it first opened).
        assert!(save_project_file(&project, "does-not-exist.txt", "x").is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_should_skip_path() {
        assert!(should_skip_path(Path::new(".git")));
        assert!(should_skip_path(Path::new(".git/HEAD")));
        assert!(should_skip_path(Path::new("node_modules")));
        assert!(should_skip_path(Path::new("node_modules/react/index.js")));
        assert!(should_skip_path(Path::new(".shipstudio")));
        assert!(should_skip_path(Path::new("src/.shipstudio")));
        assert!(!should_skip_path(Path::new("src/main.rs")));
        assert!(!should_skip_path(Path::new("README.md")));
        assert!(!should_skip_path(Path::new("src/components/GitView.tsx")));
    }

    /// Regression: Windows paths use `\` separators. The old string-based
    /// matcher only checked `/`, so `node_modules` leaked into the Code tab on
    /// Windows. Component matching handles both separators.
    #[test]
    fn test_should_skip_path_windows_separators() {
        use std::path::PathBuf;
        // PathBuf::from with backslashes is parsed as separators on Windows and
        // as a single component on Unix, so build the path from components to
        // exercise the component matcher identically on both platforms.
        let nested: PathBuf = ["node_modules", ".cache", "@babel", "fixture.cjs"]
            .iter()
            .collect();
        assert!(should_skip_path(&nested));

        let real: PathBuf = ["src", "app", "page.tsx"].iter().collect();
        assert!(!should_skip_path(&real));
    }

    #[test]
    fn test_sanitize_rel() {
        assert_eq!(sanitize_rel("").unwrap(), "");
        assert_eq!(sanitize_rel("/").unwrap(), "");
        assert_eq!(sanitize_rel("src").unwrap(), "src");
        assert_eq!(sanitize_rel("src/components").unwrap(), "src/components");
        // a trailing slash (directory form) is cleaned, but a LEADING slash is
        // an absolute path and must be rejected (empty first segment).
        assert_eq!(sanitize_rel("src/lib/").unwrap(), "src/lib");
        assert!(sanitize_rel("/src/lib/").is_err());
        // dotfiles/dot-dirs are legitimate
        assert_eq!(
            sanitize_rel(".github/workflows").unwrap(),
            ".github/workflows"
        );
        // traversal and absolute/backslash paths are rejected
        assert!(sanitize_rel("../etc").is_err());
        assert!(sanitize_rel("src/../../etc").is_err());
        assert!(sanitize_rel("a/./b").is_err());
        assert!(sanitize_rel("/abs/path").is_err()); // leading slash → absolute, rejected
        assert!(sanitize_rel("a\\b").is_err());
        assert!(sanitize_rel("a//b").is_err());
    }

    #[test]
    fn test_is_self_or_descendant() {
        assert!(is_self_or_descendant("src", "src")); // into itself
        assert!(is_self_or_descendant("src", "src/components")); // into a descendant
        assert!(is_self_or_descendant("a/b", "a/b/c/d"));
        assert!(!is_self_or_descendant("src", "lib"));
        assert!(!is_self_or_descendant("src", "")); // into root is fine
        assert!(!is_self_or_descendant("src", "src-utils")); // prefix but not a child
        assert!(!is_self_or_descendant("", "src")); // no source
    }

    #[test]
    fn test_unique_name() {
        let dir = std::env::temp_dir().join(format!("ss-code-unique-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No collision → unchanged.
        assert_eq!(unique_name(&dir, "logo.png"), "logo.png");

        // Collision on a file with extension → insert -2 before the extension.
        std::fs::write(dir.join("logo.png"), b"x").unwrap();
        assert_eq!(unique_name(&dir, "logo.png"), "logo-2.png");

        // Collision on a folder (no extension) → suffix -2.
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        assert_eq!(unique_name(&dir, "assets"), "assets-2");

        // Cascade past an existing -2.
        std::fs::write(dir.join("logo-2.png"), b"x").unwrap();
        assert_eq!(unique_name(&dir, "logo.png"), "logo-3.png");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_to_rel_string() {
        let root = Path::new("/home/u/ShipStudio/proj");
        assert_eq!(
            to_rel_string(root, &root.join("src").join("main.rs")),
            "src/main.rs"
        );
        assert_eq!(to_rel_string(root, &root.join("README.md")), "README.md");
    }

    #[test]
    fn test_copy_dir_recursive() {
        let base = std::env::temp_dir().join(format!("ss-code-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        std::fs::write(src.join("nested").join("b.txt"), b"b").unwrap();

        let dest = base.join("dest");
        copy_dir_recursive(&src, &dest).unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(dest.join("nested").join("b.txt")).unwrap(),
            "b"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_plan_dest() {
        let dir = std::env::temp_dir().join(format!("ss-code-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No existing target → plain dest, no overwrite, regardless of policy.
        let p = plan_dest(&dir, "new.txt", "error").unwrap();
        assert_eq!(p.dest, dir.join("new.txt"));
        assert!(!p.replace);

        // Existing + "error" → Validation tagged `destination` (re-promptable).
        std::fs::write(dir.join("dup.txt"), b"x").unwrap();
        match plan_dest(&dir, "dup.txt", "error") {
            Err(CommandError::Validation { field, .. }) => assert_eq!(field, "destination"),
            other => panic!("expected Validation/destination, got {other:?}"),
        }

        // "rename" → a non-colliding sibling, no overwrite, original untouched.
        let p = plan_dest(&dir, "dup.txt", "rename").unwrap();
        assert_eq!(p.dest, dir.join("dup-2.txt"));
        assert!(!p.replace);
        assert!(dir.join("dup.txt").exists());

        // "replace" → same path + replace flag, but plan_dest itself does NOT
        // delete (the caller does, via remove_existing).
        let p = plan_dest(&dir, "dup.txt", "replace").unwrap();
        assert_eq!(p.dest, dir.join("dup.txt"));
        assert!(p.replace);
        assert!(dir.join("dup.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn test_plan_dest_symlink_safety() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("ss-code-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A broken symlink points nowhere, but must still read as occupied so we
        // never write through it. Replacing it is a hard refusal tagged `symlink`.
        symlink(
            "/tmp/ss-code-symlink-nonexistent-target",
            dir.join("link.txt"),
        )
        .unwrap();
        match plan_dest(&dir, "link.txt", "replace") {
            Err(CommandError::Validation { field, .. }) => assert_eq!(field, "symlink"),
            other => panic!("expected Validation/symlink, got {other:?}"),
        }
        // Under "error" the same broken symlink is a re-promptable collision.
        match plan_dest(&dir, "link.txt", "error") {
            Err(CommandError::Validation { field, .. }) => assert_eq!(field, "destination"),
            other => panic!("expected Validation/destination, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_deletable() {
        // Canonicalize the root so parent_canon.starts_with(root) holds (the
        // command path canonicalizes via validate_project_path).
        let base = std::env::temp_dir().join(format!("ss-code-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src").join("main.rs"), b"x").unwrap();
        std::fs::write(base.join("README.md"), b"x").unwrap();
        let root = dunce::canonicalize(&base).unwrap();

        // Valid file → returns its absolute path (no deletion happens here).
        assert_eq!(
            resolve_deletable(&root, "src/main.rs").unwrap(),
            root.join("src").join("main.rs")
        );
        assert_eq!(
            resolve_deletable(&root, "README.md").unwrap(),
            root.join("README.md")
        );

        // A directory is deletable too.
        assert_eq!(resolve_deletable(&root, "src").unwrap(), root.join("src"));

        // Empty / root path is refused.
        match resolve_deletable(&root, "") {
            Err(CommandError::Validation { field, reason }) => {
                assert_eq!(field, "path");
                assert!(reason.contains("project root"));
            }
            other => panic!("expected root refusal, got {other:?}"),
        }

        // Traversal is rejected by sanitize_rel before any fs touch.
        assert!(resolve_deletable(&root, "../outside").is_err());
        assert!(resolve_deletable(&root, "src/../../etc").is_err());

        // A path that does not exist is reported as missing, not deleted.
        match resolve_deletable(&root, "src/ghost.rs") {
            Err(CommandError::Validation { field, reason }) => {
                assert_eq!(field, "path");
                assert!(reason.contains("no longer exists"));
            }
            other => panic!("expected missing-entry error, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A symlink entry inside the project is deleted as the LINK, not followed
    /// out of the sandbox: resolve_deletable returns the in-project link path
    /// (its parent is canonicalized, the final component is not).
    #[test]
    #[cfg(unix)]
    fn test_resolve_deletable_symlink_not_followed() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("ss-code-del-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // A symlink pointing OUTSIDE the project.
        symlink("/tmp/ss-del-external-target", base.join("escape")).unwrap();
        let root = dunce::canonicalize(&base).unwrap();

        // Resolves to the link's own in-project path (broken link still counts
        // as occupied), so trashing it removes the link, not its target.
        assert_eq!(
            resolve_deletable(&root, "escape").unwrap(),
            root.join("escape")
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
