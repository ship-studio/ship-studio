//! # External Project Management Commands
//!
//! Commands for registering and managing projects that live outside ~/ShipStudio.

use crate::errors::CommandError;
use crate::types::{
    ExternalProject, ExternalProjectsConfig, EXTERNAL_PROJECTS_CONFIG_SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

// ============ Helper Functions ============

/// Directories that look like projects to `is_valid_project` (they contain a
/// package.json, a manifest, or a .git) but never are: dependency trees and
/// build output. Excluded from the nested-project scan so a stray
/// `node_modules` can't masquerade as hundreds of sibling projects (#826).
const NON_PROJECT_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "bower_components",
];

/// How many nested-project names the guidance message lists before summarizing.
const MAX_LISTED_NESTED: usize = 5;

/// Render a folder-name list for a user-facing message, capped so a
/// pathological folder can't produce an unbounded string (#826).
fn summarize_names(names: &[String]) -> String {
    if names.len() <= MAX_LISTED_NESTED {
        return names.join(", ");
    }
    format!(
        "{}, and {} more",
        names[..MAX_LISTED_NESTED].join(", "),
        names.len() - MAX_LISTED_NESTED
    )
}

/// Grant the asset protocol (`convertFileSrc`) read access to a directory at
/// runtime. The static scope in tauri.conf.json deliberately only covers
/// ~/ShipStudio; external projects live anywhere on disk, so we widen the scope
/// for each registered external root individually rather than exposing all of
/// `$HOME`/`/Volumes` (which would let any main-frame script read ~/.ssh etc.).
pub fn grant_asset_scope(app: &AppHandle, path: &Path) {
    use tauri::Manager;
    if path.is_dir() {
        if let Err(e) = app.asset_protocol_scope().allow_directory(path, true) {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Failed to grant asset-protocol scope for external project"
            );
        }
    }
}

/// Grant asset-protocol scope to every already-registered external project.
/// Called once at startup so reopening an external project shows its thumbnails
/// and assets without re-registering.
pub fn grant_asset_scope_for_registered(app: &AppHandle) {
    if let Ok(cfg) = load_config() {
        for proj in &cfg.projects {
            grant_asset_scope(app, Path::new(&proj.path));
        }
    }
}

/// Get the path to the external projects config file
fn get_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home
        .join("ShipStudio")
        .join(".shipstudio")
        .join("external-projects.json"))
}

/// Load the external projects config from disk
pub fn load_config() -> Result<ExternalProjectsConfig, String> {
    let config_path = get_config_path()?;

    if !config_path.exists() {
        return Ok(ExternalProjectsConfig {
            schema_version: EXTERNAL_PROJECTS_CONFIG_SCHEMA_VERSION,
            projects: Vec::new(),
        });
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read external projects config: {e}"))?;

    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse external projects config: {e}"))
}

/// Save the external projects config to disk
pub fn save_config(config: &ExternalProjectsConfig) -> Result<(), String> {
    let config_path = get_config_path()?;

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
        }
    }

    let contents = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize external projects config: {e}"))?;

    std::fs::write(&config_path, contents)
        .map_err(|e| format!("Failed to write external projects config: {e}"))?;

    Ok(())
}

/// Check if a canonical path is a registered external project path
pub fn is_registered_external_path(canonical: &Path) -> Result<bool, String> {
    let config = load_config()?;
    for project in &config.projects {
        let project_path = Path::new(&project.path);
        if let Ok(project_canonical) = dunce::canonicalize(project_path) {
            // Neutralize any pre-existing bad registration of $HOME (or wider):
            // honoring it would make every path under the home directory pass
            // validate_project_path via starts_with (issue #345).
            if crate::utils::is_forbidden_project_root(&project_canonical) {
                continue;
            }
            if canonical.starts_with(&project_canonical) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

// ============ Tauri Commands ============

/// Opens a native folder picker and registers the selected folder as an external project.
/// Returns the path of the registered project, or None if cancelled.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn register_external_project(app: AppHandle) -> Result<Option<String>, CommandError> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select Project Folder")
        .blocking_pick_folder();

    let folder_path = match folder {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid folder path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    // The home directory (or anything above it) is never a project, even when
    // a stray ~/.git or ~/.gitignore makes it look like one — registering it
    // would scope destructive git ops to the whole home tree (issue #345).
    if crate::utils::is_forbidden_project_root(&folder_path) {
        return Err(CommandError::expected(
            "That folder is your home directory (or a folder above it), which can't be added as a \
             project. Pick the specific project folder instead.",
        ));
    }

    // Use the same predicate as dashboard discovery so removed projects can be
    // restored even when they were blank, git-only, or Ship Studio metadata-only.
    let is_valid_project = crate::commands::projects::is_valid_project(&folder_path);

    if !is_valid_project {
        // Check one level deep for a nested project
        let mut nested_projects: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&folder_path) {
            for entry in entries.flatten() {
                if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                    let sub = entry.path();
                    // Skip hidden dirs
                    if entry
                        .file_name()
                        .to_str()
                        .map_or(false, |n| n.starts_with('.'))
                    {
                        continue;
                    }
                    // Dependency and build directories aren't nested projects.
                    // Every package under node_modules has a package.json, so
                    // without this the guidance listed ~900 npm package names
                    // instead of the user's actual subfolders (issue #826).
                    if entry
                        .file_name()
                        .to_str()
                        .is_some_and(|n| NON_PROJECT_DIRS.contains(&n))
                    {
                        continue;
                    }
                    if crate::commands::projects::is_valid_project(&sub) {
                        if let Some(name) = entry.file_name().to_str() {
                            nested_projects.push(name.to_string());
                        }
                    }
                }
            }
        }

        // All of these are by-design guidance about the user's folder pick,
        // not malfunctions — Expected keeps them out of telemetry (issue #416).
        if nested_projects.len() == 1 {
            return Err(CommandError::expected(format!(
                "The project appears to be inside the \"{}\" subfolder. Please select that folder instead.",
                nested_projects[0]
            )));
        } else if nested_projects.len() > 1 {
            return Err(CommandError::expected(format!(
                "This folder contains multiple projects inside it: {}. Please select the specific project folder you want to import.",
                summarize_names(&nested_projects)
            )));
        }

        return Err(CommandError::expected(
            "Selected folder doesn't appear to be a project — no project files found (package.json, .html, .git, or a language manifest like Cargo.toml, go.mod, pyproject.toml…)."
        ));
    }

    // Canonicalize the path
    let canonical = crate::utils::canonicalize_tagged(&folder_path, "register_external_project")?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Reject folders that already live under a projects root (configured or
    // default) — those are listed automatically and aren't "external".
    if crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        if crate::commands::projects::restore_removed_project(&canonical)? {
            return Ok(Some(canonical_str));
        }

        return Err(CommandError::expected(
            "This project is already inside your projects folder. It will appear automatically.",
        ));
    }

    // Check if already registered
    let mut config = load_config()?;
    if config.projects.iter().any(|p| {
        dunce::canonicalize(Path::new(&p.path))
            .map(|c| c == canonical)
            .unwrap_or(false)
    }) {
        return Err(CommandError::expected(
            "This project is already registered.",
        ));
    }

    // Register
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    config.projects.push(ExternalProject {
        path: canonical_str.clone(),
        registered_at: now,
    });

    save_config(&config)?;

    // Widen the asset-protocol scope to this newly-registered root so its
    // thumbnails/assets render without a restart.
    grant_asset_scope(&app, &canonical);

    Ok(Some(canonical_str))
}

/// Removes an external project from the registry (does not delete files).
///
/// Also clears the in-folder `workspace_subpath` so that re-registering the
/// same path triggers the monorepo picker again — otherwise the gate reads
/// the saved subpath and silently skips the picker after a remove/re-add.
/// Other metadata (terminal state, last_opened, custom thumbnail, etc.) is
/// preserved so a user who remove+re-adds for organisation reasons doesn't
/// lose everything.
#[tauri::command]
#[tracing::instrument]
pub async fn unregister_external_project(path: String) -> Result<(), CommandError> {
    let mut config = load_config()?;

    let canonical = dunce::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));

    let initial_len = config.projects.len();
    config.projects.retain(|p| {
        let project_canonical =
            dunce::canonicalize(Path::new(&p.path)).unwrap_or_else(|_| PathBuf::from(&p.path));
        project_canonical != canonical
    });

    if config.projects.len() == initial_len {
        return Err(("Project not found in external projects list.".to_string()).into());
    }

    save_config(&config)?;

    // Reset workspace_subpath so re-add re-prompts the picker. Best-effort —
    // a failure here just means the user sees no picker on re-import, which
    // is the current bug we're fixing, so we log instead of erroring out.
    if let Err(err) = clear_workspace_subpath_in_metadata(&canonical) {
        tracing::warn!(
            project = %canonical.display(),
            error = %err,
            "Failed to clear workspace_subpath on unregister; re-import may skip the picker"
        );
    }

    Ok(())
}

/// Clear the `workspace_subpath` field in a project's `.shipstudio/project.json`
/// without touching any other metadata. No-op when the file is absent.
fn clear_workspace_subpath_in_metadata(project_root: &Path) -> Result<(), String> {
    use crate::types::ProjectMetadata;
    let metadata_path = project_root.join(".shipstudio").join("project.json");
    if !metadata_path.exists() {
        return Ok(());
    }
    let contents =
        std::fs::read_to_string(&metadata_path).map_err(|e| format!("read metadata: {e}"))?;
    let mut metadata: ProjectMetadata =
        serde_json::from_str(&contents).map_err(|e| format!("parse metadata: {e}"))?;
    if metadata.workspace_subpath.is_none() {
        return Ok(());
    }
    metadata.workspace_subpath = None;
    let updated =
        serde_json::to_string_pretty(&metadata).map_err(|e| format!("serialise metadata: {e}"))?;
    std::fs::write(&metadata_path, updated).map_err(|e| format!("write metadata: {e}"))?;
    Ok(())
}

/// Heuristic: does this directory look like a real project root the user would
/// legitimately open? Used to gate dialog-less auto-registration so the trust
/// boundary can't be silently widened to arbitrary directories. Intentionally
/// generous about *project* shapes but excludes things like ~/.ssh, ~/.aws.
fn looks_like_project_root(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    // Never the home directory or above it, regardless of markers (#345).
    if crate::utils::is_forbidden_project_root(path) {
        return false;
    }
    const MARKERS: &[&str] = &[
        ".git",
        "package.json",
        ".shipstudio",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "Gemfile",
        "pom.xml",
        "build.gradle",
        "composer.json",
        "index.html",
    ];
    // Mirror register_external_project's picker check: any .html file (root or
    // Vercel-style public/) counts as a project, so static sites whose entry
    // isn't a root index.html still auto-register.
    MARKERS.iter().any(|m| path.join(m).exists())
        || crate::commands::projects::static_site_dir(path).is_some()
}

/// Register an external project by path (no folder picker dialog).
///
/// Called automatically when a project outside ~/ShipStudio is opened
/// (e.g., via session restore or URL params) to ensure backend commands
/// don't fail with "Security error: path is outside ShipStudio directory".
///
/// Returns Ok(true) if newly registered, Ok(false) if already registered or inside ~/ShipStudio.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn ensure_external_project_registered(
    app: AppHandle,
    path: String,
) -> Result<bool, CommandError> {
    let canonical =
        crate::utils::canonicalize_tagged(Path::new(&path), "ensure_external_project_registered")?;

    // Skip if already inside a projects root (configured or default) — those are
    // already trusted by validate_project_path and listed automatically.
    if crate::utils::allowed_project_roots()
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Ok(false);
    }

    // Skip if already registered
    if is_registered_external_path(&canonical)? {
        return Ok(false);
    }

    // This command registers a NEW path into the trust boundary without a native
    // folder-picker dialog (unlike `register_external_project`). To stop a
    // compromised webview from registering arbitrary sensitive directories
    // (e.g. ~/.ssh, ~/.aws) and thereby making them pass `validate_project_path`,
    // only auto-register paths that actually look like a project root. The
    // picker flow remains the way to add anything that doesn't.
    if !looks_like_project_root(&canonical) {
        // A by-design security refusal, not a malfunction — Expected keeps it
        // out of bug telemetry (issue #598, same classification #416 applied
        // to the folder-picker guidance branches in this file). Serializes
        // identically to Other, so the frontend sees the same message.
        return Err(CommandError::expected(format!(
            "Refusing to auto-register '{}': it does not look like a project directory. Add it via the folder picker instead.",
            canonical.display()
        )));
    }

    // Register it
    let canonical_str = canonical.to_string_lossy().to_string();
    let mut config = load_config()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    config.projects.push(ExternalProject {
        path: canonical_str.clone(),
        registered_at: now,
    });

    save_config(&config)?;
    grant_asset_scope(&app, &canonical);
    tracing::info!("Auto-registered external project: {}", canonical_str);

    Ok(true)
}

/// Check if a project path is an external project.
#[tauri::command]
#[tracing::instrument]
pub async fn is_project_external(path: String) -> Result<bool, CommandError> {
    let canonical = crate::utils::canonicalize_tagged(Path::new(&path), "is_project_external")?;

    let config = load_config()?;
    for project in &config.projects {
        let project_path = Path::new(&project.path);
        if let Ok(project_canonical) = dunce::canonicalize(project_path) {
            if canonical == project_canonical {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::looks_like_project_root;
    use std::fs;

    #[test]
    fn rejects_sensitive_non_project_dirs() {
        // A directory with no project markers (the ~/.ssh attack shape) must not
        // be auto-registerable into the trust boundary.
        let base = std::env::temp_dir().join("ss-audit-not-a-project");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("mkdir");
        fs::write(base.join("id_rsa"), b"x").expect("write");
        assert!(!looks_like_project_root(&base));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn accepts_dir_with_project_marker() {
        let base = std::env::temp_dir().join("ss-audit-is-a-project");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("mkdir");
        fs::write(base.join("package.json"), b"{}").expect("write");
        assert!(looks_like_project_root(&base));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_nonexistent_or_file() {
        let missing = std::env::temp_dir().join("ss-audit-missing-xyz");
        let _ = fs::remove_dir_all(&missing);
        assert!(!looks_like_project_root(&missing));
    }

    // #826: an unbounded name list flooded the guidance message (and the
    // truncated copy no longer matched the frontend's Expected-refusal phrase).
    #[test]
    fn summarize_names_caps_long_lists() {
        let few: Vec<String> = ["api", "web"].iter().map(|s| s.to_string()).collect();
        assert_eq!(super::summarize_names(&few), "api, web");

        let many: Vec<String> = (0..40).map(|i| format!("pkg{i}")).collect();
        let summary = super::summarize_names(&many);
        assert!(
            summary.starts_with("pkg0, pkg1, pkg2, pkg3, pkg4,"),
            "{summary}"
        );
        assert!(summary.ends_with("and 35 more"), "{summary}");
        assert!(!summary.contains("pkg5,"), "{summary}");
    }
}
