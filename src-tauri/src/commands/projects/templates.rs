//! Template extraction and export commands.
//!
//! Handles creating new projects from zip templates and exporting
//! existing projects as zip template files.

use super::detection::has_html_files;
use crate::errors::CommandError;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::ZipArchive;

/// Extracts a zip template file to create a new project.
/// The zip file should contain a single root directory (like GitHub downloads).
/// Returns the path to the created project.
///
/// Accepts either:
/// - `zip_data`: Raw zip bytes (from browser File API)
/// - `zip_path`: Path to a zip file on disk (from Tauri drag-drop)
#[tauri::command]
#[tracing::instrument]
pub async fn extract_template_zip(
    project_name: String,
    zip_data: Option<Vec<u8>>,
    zip_path: Option<String>,
) -> Result<String, CommandError> {
    let shipstudio_dir = crate::utils::projects_root()?;

    // Ensure the projects root exists
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create projects directory: {e}"))?;
    }

    // Sanitize project name
    let safe_name = project_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect::<String>();

    if safe_name.is_empty() {
        return Err(("Invalid project name".to_string()).into());
    }

    let project_path = shipstudio_dir.join(&safe_name);

    // Check if project already exists
    if project_path.exists() {
        return Err((format!("A project named '{safe_name}' already exists")).into());
    }

    // Extract from direct bytes or stream from disk. On-disk zips are opened
    // as files (not slurped into memory) so a large template can't OOM the app.
    let extract_result = if let Some(bytes) = zip_data {
        extract_archive_to(std::io::Cursor::new(bytes), &project_path)
    } else if let Some(path) = zip_path {
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Failed to open zip file '{path}': {e}"))?;
        extract_archive_to(std::io::BufReader::new(file), &project_path)
    } else {
        return Err(("No zip data or path provided".to_string()).into());
    };

    if let Err(e) = extract_result {
        // Don't leave a half-extracted project behind on failure.
        std::fs::remove_dir_all(&project_path).ok();
        return Err(e);
    }

    // Verify it's a valid project (has package.json, HTML files, or a Shopify
    // theme layout — searched a few levels deep, since templates routinely
    // nest these under src/, dist/, or a wrapper directory; issue #641).
    if !contains_project_markers(&project_path, TEMPLATE_MARKER_SEARCH_DEPTH) {
        // Log what was actually extracted so a report can distinguish "the
        // template really is invalid" from "extraction produced an unexpected
        // layout" (issue #641).
        let top_entries: Vec<String> = std::fs::read_dir(&project_path)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        tracing::warn!(
            entries = ?top_entries,
            "template validation failed; extracted top-level entries"
        );
        // Clean up invalid project
        std::fs::remove_dir_all(&project_path).ok();
        // The zip's content is the user's input, not an app malfunction.
        return Err(CommandError::expected(
            "Invalid template: no package.json, .html files, or Shopify theme layout found. Please use a valid project template.",
        ));
    }

    Ok(project_path.to_string_lossy().to_string())
}

/// How many directory levels below the extraction root to search for project
/// markers. Covers an unstripped wrapper dir plus common nesting like
/// `src/index.html` or `wrapper/dist/index.html`.
const TEMPLATE_MARKER_SEARCH_DEPTH: usize = 3;

/// Whether `dir` (or any subdirectory up to `depth` levels down) contains a
/// recognizable project marker: a `package.json`, any `.html` file, or a
/// Shopify theme's `layout/theme.liquid`.
///
/// Root-only checks used to reject legitimately-structured templates whose
/// project files sit one level deeper — e.g. when root-stripping didn't kick
/// in, or when the site lives in `src/`/`dist/` (issue #641). Heavy and
/// hidden directories are skipped.
fn contains_project_markers(dir: &std::path::Path, depth: usize) -> bool {
    if dir.join("package.json").exists()
        || dir.join("layout").join("theme.liquid").exists()
        || has_html_files(dir)
    {
        return true;
    }
    if depth == 0 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        // `file_type()` doesn't follow symlinks, so a symlinked dir can't
        // recurse out of the extracted tree (or loop).
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if contains_project_markers(&entry.path(), depth - 1) {
            return true;
        }
    }
    false
}

/// Zip entries that are packaging junk, not template content: macOS resource
/// forks (`__MACOSX/`), Finder metadata (`.DS_Store`), and AppleDouble
/// sidecar files (`._*`). Finder's "Compress" adds these next to the real
/// root directory, which used to defeat the shared-root detection below and
/// leave every file nested one level too deep (issue #641).
fn is_junk_zip_entry(name: &str) -> bool {
    name.split('/')
        .any(|segment| segment == "__MACOSX" || segment == ".DS_Store" || segment.starts_with("._"))
}

/// Extract a zip archive into `project_path`, streaming each entry to disk
/// (no per-file in-memory buffering). Errors carry the operation, the entry
/// or destination path, and the underlying cause.
fn extract_archive_to<R: std::io::Read + std::io::Seek>(
    reader: R,
    project_path: &std::path::Path,
) -> Result<(), CommandError> {
    let mut archive =
        ZipArchive::new(reader).map_err(|e| format!("Failed to open zip file: {e}"))?;

    if archive.is_empty() {
        return Err(("Zip file is empty".to_string()).into());
    }

    // Detect whether every real entry shares a single root directory
    // (GitHub-style download). Packaging junk (__MACOSX/, .DS_Store, ._*)
    // is ignored here — macOS zips add it at top level next to the real
    // root, and counting it used to silently disable root-stripping, which
    // then failed validation on a perfectly valid template (issue #641).
    let mut shared_root: Option<String> = None;
    let mut single_root = true;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{i}: {e}"))?
            .name()
            .to_string();
        if is_junk_zip_entry(&name) {
            continue;
        }
        match name.split_once('/') {
            Some((top, _)) if !top.is_empty() => match &shared_root {
                None => shared_root = Some(top.to_string()),
                Some(root) if root == top => {}
                Some(_) => {
                    single_root = false;
                    break;
                }
            },
            // A top-level file (or a weird leading-slash name): no single root.
            _ => {
                single_root = false;
                break;
            }
        }
    }
    let root_prefix = if single_root {
        shared_root.map(|root| format!("{root}/"))
    } else {
        None
    };
    let strip_root = root_prefix.is_some();

    // Create project directory
    std::fs::create_dir_all(project_path).map_err(|e| {
        format!(
            "Failed to create project directory '{}': {e}",
            project_path.display()
        )
    })?;

    // Extract files
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{i}: {e}"))?;

        let mut outpath = file.name().to_string();

        // Never materialize packaging junk (issue #641).
        if is_junk_zip_entry(&outpath) {
            continue;
        }

        // Strip root directory if present
        if strip_root {
            if let Some(ref prefix) = root_prefix {
                outpath = outpath.strip_prefix(prefix).unwrap_or(&outpath).to_string();
            }
        }

        // Skip empty paths (the root directory itself)
        if outpath.is_empty() {
            continue;
        }

        // Security: prevent zip-slip. A substring `..` check is insufficient —
        // an absolute entry name (e.g. `/Users/me/.zshenv`) contains no `..`,
        // and `Path::join` with an absolute path DISCARDS the base, writing
        // outside the project. Reject any entry that isn't a plain relative path
        // (no root, no drive prefix, no `..` component).
        let rel = std::path::Path::new(&outpath);
        let is_safe_relative = rel.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        });
        if !is_safe_relative {
            tracing::warn!(entry = %outpath, "Skipping unsafe zip entry during template extraction");
            continue;
        }

        let dest_path = project_path.join(rel);

        if file.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| {
                format!("Failed to create directory '{}': {e}", dest_path.display())
            })?;
        } else {
            // Ensure parent directory exists
            if let Some(parent) = dest_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        format!(
                            "Failed to create parent directory '{}': {e}",
                            parent.display()
                        )
                    })?;
                }
            }

            // Extract file, streaming from the archive to disk so a large
            // entry is never buffered fully in memory.
            let mut outfile = std::fs::File::create(&dest_path)
                .map_err(|e| format!("Failed to create file '{}': {e}", dest_path.display()))?;

            std::io::copy(&mut file, &mut outfile).map_err(|e| {
                format!(
                    "Failed to extract zip entry '{outpath}' to '{}': {e}",
                    dest_path.display()
                )
            })?;

            // Set executable permission for scripts on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    if mode & 0o111 != 0 {
                        // Has execute bit. Set a fixed 0o755 rather than the
                        // raw archive mode so a malicious template can't ship a
                        // setuid/setgid binary.
                        let mut perms = std::fs::metadata(&dest_path)
                            .map_err(|e| {
                                format!(
                                    "Failed to get file metadata for '{}': {e}",
                                    dest_path.display()
                                )
                            })?
                            .permissions();
                        perms.set_mode(0o755);
                        std::fs::set_permissions(&dest_path, perms).ok();
                    }
                }
            }
        }
    }

    Ok(())
}

/// Directories to exclude when exporting a project as a template
const EXPORT_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".shipstudio",
    ".next",
    ".vercel",
    "dist",
    "build",
    ".turbo",
    ".cache",
    ".svelte-kit",
    ".nuxt",
    ".output",
    "out",
];

/// Exports a project as a zip template file.
/// Opens a save dialog for the user to choose the destination.
/// Returns the path to the saved file, or None if cancelled.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn export_project_as_template(
    app: AppHandle,
    project_path: String,
) -> Result<Option<String>, CommandError> {
    let project = std::path::PathBuf::from(&project_path);

    // Validate project exists
    if !project.exists() {
        return Err(("Project does not exist".to_string()).into());
    }

    // Get project name for default filename
    let project_name = project
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let default_filename = format!("{project_name}-template.zip");

    // Open save dialog
    let file_path = app
        .dialog()
        .file()
        .set_file_name(&default_filename)
        .add_filter("Zip Archive", &["zip"])
        .blocking_save_file();

    let save_path = match file_path {
        Some(path) => path
            .into_path()
            .map_err(|e| format!("Invalid file path: {e}"))?,
        None => return Ok(None), // User cancelled
    };

    // Create the zip file
    let file =
        std::fs::File::create(&save_path).map_err(|e| format!("Failed to create zip file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // Walk the project directory
    for entry in WalkDir::new(&project) {
        let entry = entry.map_err(|e| format!("Failed to read directory: {e}"))?;
        let path = entry.path();

        // Get relative path from project root
        let relative_path = path
            .strip_prefix(&project)
            .map_err(|e| format!("Failed to get relative path: {e}"))?;

        // Skip if empty path (the root itself)
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        // Check if this path should be excluded
        let should_exclude = relative_path.components().any(|component| {
            if let std::path::Component::Normal(name) = component {
                if let Some(name_str) = name.to_str() {
                    return EXPORT_EXCLUDED_DIRS.contains(&name_str);
                }
            }
            false
        });

        if should_exclude {
            continue;
        }

        let relative_path_str = relative_path.to_string_lossy();

        if path.is_dir() {
            // Add directory entry
            zip.add_directory(format!("{relative_path_str}/"), options)
                .map_err(|e| format!("Failed to add directory to zip: {e}"))?;
        } else {
            // Add file entry, streaming from disk so a large file (video,
            // binary asset) is never buffered fully in memory.
            zip.start_file(&relative_path_str, options)
                .map_err(|e| format!("Failed to start file '{relative_path_str}' in zip: {e}"))?;

            let mut file = std::fs::File::open(path)
                .map_err(|e| format!("Failed to open file '{}': {e}", path.display()))?;

            std::io::copy(&mut file, &mut zip)
                .map_err(|e| format!("Failed to write file '{}' to zip: {e}", path.display()))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip file: {e}"))?;

    Ok(Some(save_path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::{contains_project_markers, extract_archive_to, is_junk_zip_entry};
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    /// Build an in-memory zip with the given (name, content) entries.
    /// Directory entries are names ending in '/'.
    fn make_zip(entries: &[(&str, &str)]) -> std::io::Cursor<Vec<u8>> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default();
            for (name, content) in entries {
                if name.ends_with('/') {
                    writer.add_directory(name.to_string(), options).unwrap();
                } else {
                    writer.start_file(name.to_string(), options).unwrap();
                    writer.write_all(content.as_bytes()).unwrap();
                }
            }
            writer.finish().unwrap();
        }
        cursor.set_position(0);
        cursor
    }

    #[test]
    fn strips_shared_root_directory() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("proj");
        let zip = make_zip(&[
            ("repo-main/", ""),
            ("repo-main/package.json", "{}"),
            ("repo-main/src/app.js", "x"),
        ]);
        extract_archive_to(zip, &dest).unwrap();
        assert!(dest.join("package.json").exists());
        assert!(dest.join("src/app.js").exists());
    }

    /// Issue #641: macOS Finder zips carry __MACOSX/, .DS_Store, and ._*
    /// sidecar entries at top level next to the real root. These must not
    /// defeat root-stripping (which then made a valid template fail
    /// validation), and must not be extracted.
    #[test]
    fn junk_entries_do_not_defeat_root_stripping() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("proj");
        let zip = make_zip(&[
            ("repo-main/", ""),
            ("repo-main/package.json", "{}"),
            ("__MACOSX/repo-main/._package.json", "junk"),
            (".DS_Store", "junk"),
            ("repo-main/.DS_Store", "junk"),
        ]);
        extract_archive_to(zip, &dest).unwrap();
        assert!(
            dest.join("package.json").exists(),
            "root must be stripped despite junk siblings"
        );
        assert!(!dest.join("__MACOSX").exists());
        assert!(!dest.join(".DS_Store").exists());
    }

    #[test]
    fn mixed_roots_are_not_stripped() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("proj");
        let zip = make_zip(&[
            ("repo-main/package.json", "{}"),
            ("README.txt", "top-level stray file"),
        ]);
        extract_archive_to(zip, &dest).unwrap();
        // No single shared root → files land where the zip put them.
        assert!(dest.join("repo-main/package.json").exists());
        assert!(dest.join("README.txt").exists());
    }

    #[test]
    fn junk_entry_detection() {
        assert!(is_junk_zip_entry("__MACOSX/repo/._file"));
        assert!(is_junk_zip_entry(".DS_Store"));
        assert!(is_junk_zip_entry("repo/.DS_Store"));
        assert!(is_junk_zip_entry("repo/._index.html"));
        assert!(!is_junk_zip_entry("repo/index.html"));
        assert!(!is_junk_zip_entry("repo/_private/file.js"));
    }

    #[test]
    fn markers_found_at_root() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}").unwrap();
        assert!(contains_project_markers(tmp.path(), 3));
    }

    /// Issue #641: html nested under src/ or dist/ (or a wrapper dir that
    /// wasn't stripped) must still count as a valid template.
    #[test]
    fn markers_found_in_nested_directories() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/index.html"), "<html></html>").unwrap();
        assert!(contains_project_markers(tmp.path(), 3));

        let tmp2 = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp2.path().join("wrapper/dist")).unwrap();
        std::fs::write(tmp2.path().join("wrapper/dist/index.html"), "x").unwrap();
        assert!(contains_project_markers(tmp2.path(), 3));

        let tmp3 = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp3.path().join("theme/layout")).unwrap();
        std::fs::write(tmp3.path().join("theme/layout/theme.liquid"), "x").unwrap();
        assert!(contains_project_markers(tmp3.path(), 3));
    }

    #[test]
    fn markers_respect_depth_limit_and_skip_heavy_dirs() {
        let tmp = TempDir::new().unwrap();
        // Beyond the depth limit → not found.
        let deep = tmp.path().join("a/b/c/d");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("index.html"), "x").unwrap();
        assert!(!contains_project_markers(tmp.path(), 3));

        // node_modules must never make a template "valid".
        let tmp2 = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp2.path().join("node_modules/pkg")).unwrap();
        std::fs::write(tmp2.path().join("node_modules/pkg/package.json"), "{}").unwrap();
        assert!(!contains_project_markers(tmp2.path(), 3));
    }

    #[test]
    fn empty_dir_has_no_markers() {
        let tmp = TempDir::new().unwrap();
        assert!(!contains_project_markers(tmp.path(), 3));
    }
}
