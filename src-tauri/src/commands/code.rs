//! # Code Browser Commands
//!
//! Commands for browsing project files with syntax highlighting support.
//! Provides a read-only file browser that respects .gitignore.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;

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
const SKIP_DIRS: &[&str] = &[
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
}
