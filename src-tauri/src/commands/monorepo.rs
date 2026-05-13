//! Monorepo workspace detection.
//!
//! Given a freshly-cloned repo root, enumerate the runnable apps inside so the
//! import wizard can ask the user which one they want to focus on. Detects:
//! - `pnpm-workspace.yaml` (`packages:` list)
//! - root `package.json#workspaces` (array or `{ packages: [...] }` form)
//!
//! Returns subdirs that have a `package.json` with a `dev` or `start` script.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct WorkspaceInfo {
    /// Package name from the workspace's `package.json` (e.g. `@sugarshark/admin`).
    pub name: String,
    /// Relative path from the repo root (e.g. `apps/admin`). POSIX separators.
    pub relative_path: String,
    /// Whichever of `dev` / `start` is present, in that priority. None means no runnable script.
    pub dev_script: Option<String>,
    /// Port hinted by the dev script (`next dev -p 3001` → 3001). None if not explicit.
    pub port_hint: Option<u16>,
    /// True when the dev script suggests a web framework we can preview
    /// (next/vite/astro/remix/sveltekit/nuxt/storybook). Used to pre-select a
    /// sensible default in the picker.
    pub is_web: bool,
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn detect_workspaces(project_path: String) -> Result<Vec<WorkspaceInfo>, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(detect_workspaces_at(&root))
}

pub fn detect_workspaces_at(root: &Path) -> Vec<WorkspaceInfo> {
    let mut patterns = collect_workspace_globs(root);
    if patterns.is_empty() {
        return Vec::new();
    }
    patterns.sort();
    patterns.dedup();

    let mut workspaces: Vec<WorkspaceInfo> = patterns
        .iter()
        .flat_map(|pattern| expand_pattern(root, pattern))
        .filter_map(|dir| inspect_workspace(root, &dir))
        .filter(|w| w.dev_script.is_some())
        .collect();

    workspaces.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    workspaces.dedup_by(|a, b| a.relative_path == b.relative_path);
    workspaces
}

/// Read workspace globs from `pnpm-workspace.yaml` and root `package.json#workspaces`.
fn collect_workspace_globs(root: &Path) -> Vec<String> {
    let mut out = Vec::new();

    if let Ok(contents) = std::fs::read_to_string(root.join("pnpm-workspace.yaml")) {
        out.extend(parse_pnpm_workspace_yaml(&contents));
    }

    if let Ok(contents) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            out.extend(parse_package_json_workspaces(&json));
        }
    }

    out
}

/// Parse the `packages:` list from a pnpm-workspace.yaml. Hand-rolled because
/// the file is dead-simple in practice and we don't want a yaml dependency for
/// one schema. Handles:
///   packages:
///     - "apps/*"
///     - packages/*
fn parse_pnpm_workspace_yaml(contents: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_packages = false;
    for line in contents.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        // A non-indented line that isn't a list item ends the packages block.
        let indented = trimmed.starts_with(' ') || trimmed.starts_with('\t');
        let trimmed_left = trimmed.trim_start();
        if !indented && !trimmed_left.starts_with('-') {
            in_packages = trimmed_left.starts_with("packages:");
            continue;
        }
        if !in_packages {
            continue;
        }
        if let Some(rest) = trimmed_left.strip_prefix('-') {
            let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !value.is_empty() {
                out.push(value);
            }
        }
    }
    out
}

/// Pull workspace globs from the root `package.json`. Supports both shapes:
///   "workspaces": ["apps/*", "packages/*"]
///   "workspaces": { "packages": ["apps/*", "packages/*"] }
fn parse_package_json_workspaces(json: &serde_json::Value) -> Vec<String> {
    let workspaces = match json.get("workspaces") {
        Some(v) => v,
        None => return Vec::new(),
    };
    if let Some(arr) = workspaces.as_array() {
        return arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
    }
    if let Some(obj) = workspaces.as_object() {
        if let Some(packages) = obj.get("packages").and_then(|v| v.as_array()) {
            return packages
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
        }
    }
    Vec::new()
}

/// Expand a workspace pattern into concrete subdirectories under `root`.
/// Supports the only forms that show up in real-world configs: a literal path
/// and a single `*` segment at the end (e.g. `apps/*`).
fn expand_pattern(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let cleaned = pattern.trim_matches('/');
    if cleaned.is_empty() {
        return Vec::new();
    }

    // Exclusion patterns (`!foo`) are uncommon — ignore for v1.
    if cleaned.starts_with('!') {
        return Vec::new();
    }

    if let Some(prefix) = cleaned.strip_suffix("/*") {
        let parent = root.join(prefix);
        let entries = match std::fs::read_dir(&parent) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        return entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
    }

    let direct = root.join(cleaned);
    if direct.is_dir() {
        vec![direct]
    } else {
        Vec::new()
    }
}

fn inspect_workspace(root: &Path, dir: &Path) -> Option<WorkspaceInfo> {
    let pkg_path = dir.join("package.json");
    let contents = std::fs::read_to_string(&pkg_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&contents).ok()?;

    let name = json
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace")
                .to_string()
        });

    let scripts = json.get("scripts").and_then(|v| v.as_object());
    let dev_script = scripts.and_then(|s| {
        s.get("dev")
            .and_then(|v| v.as_str())
            .or_else(|| s.get("start").and_then(|v| v.as_str()))
            .map(String::from)
    });

    let port_hint = dev_script.as_deref().and_then(parse_port_from_script);
    let is_web = dev_script.as_deref().is_some_and(is_web_dev_command);

    let relative = dir.strip_prefix(root).ok()?;
    let relative_path = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");

    Some(WorkspaceInfo {
        name,
        relative_path,
        dev_script,
        port_hint,
        is_web,
    })
}

/// Look for an explicit port flag in a dev script. Catches the common forms:
/// `-p 3001`, `--port=3001`, `--port 3001`, `PORT=3001 ...`.
fn parse_port_from_script(script: &str) -> Option<u16> {
    let tokens: Vec<&str> = script.split_whitespace().collect();
    for (i, tok) in tokens.iter().enumerate() {
        if let Some(rest) = tok.strip_prefix("--port=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
        if *tok == "--port" || *tok == "-p" {
            if let Some(next) = tokens.get(i + 1) {
                if let Ok(n) = next.parse::<u16>() {
                    return Some(n);
                }
            }
        }
        if let Some(rest) = tok.strip_prefix("PORT=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
    }
    None
}

fn is_web_dev_command(script: &str) -> bool {
    let lowered = script.to_lowercase();
    [
        "next",
        "vite",
        "astro",
        "remix",
        "svelte-kit",
        "sveltekit",
        "nuxt",
        "storybook",
        "expo",
        "gatsby",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, body).unwrap();
    }

    fn make_app(root: &Path, rel: &str, name: &str, dev: &str) {
        write(
            root,
            &format!("{rel}/package.json"),
            &format!(r#"{{ "name": "{name}", "scripts": {{ "dev": "{dev}" }} }}"#),
        );
    }

    #[test]
    fn returns_empty_for_non_monorepo() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "solo" }"#);
        assert!(detect_workspaces_at(tmp.path()).is_empty());
    }

    #[test]
    fn parses_pnpm_workspace_yaml_and_apps() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "pnpm-workspace.yaml",
            "packages:\n  - \"apps/*\"\n  - packages/*\n",
        );
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        make_app(tmp.path(), "apps/admin", "@x/admin", "next dev -p 3001");
        make_app(tmp.path(), "apps/marketing", "@x/marketing", "next dev");
        // packages/types has no dev script — should be filtered out
        write(
            tmp.path(),
            "packages/types/package.json",
            r#"{ "name": "@x/types" }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 2);

        let admin = workspaces
            .iter()
            .find(|w| w.relative_path == "apps/admin")
            .unwrap();
        assert_eq!(admin.port_hint, Some(3001));
        assert!(admin.is_web);

        let marketing = workspaces
            .iter()
            .find(|w| w.relative_path == "apps/marketing")
            .unwrap();
        assert_eq!(marketing.port_hint, None);
        assert!(marketing.is_web);
    }

    #[test]
    fn parses_package_json_workspaces_array_form() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "package.json",
            r#"{ "name": "root", "workspaces": ["apps/*"] }"#,
        );
        make_app(tmp.path(), "apps/web", "web", "vite");
        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert!(workspaces[0].is_web);
    }

    #[test]
    fn parses_package_json_workspaces_object_form() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "package.json",
            r#"{ "workspaces": { "packages": ["apps/*"] } }"#,
        );
        make_app(tmp.path(), "apps/api", "api", "tsx watch src/index.ts");
        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].relative_path, "apps/api");
        assert!(!workspaces[0].is_web);
    }

    #[test]
    fn parses_port_from_various_script_forms() {
        assert_eq!(parse_port_from_script("next dev -p 3001"), Some(3001));
        assert_eq!(parse_port_from_script("next dev --port 4000"), Some(4000));
        assert_eq!(parse_port_from_script("vite --port=5173"), Some(5173));
        assert_eq!(
            parse_port_from_script("PORT=8080 node server.js"),
            Some(8080)
        );
        assert_eq!(parse_port_from_script("next dev"), None);
    }

    #[test]
    fn filters_workspaces_without_runnable_script() {
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "pnpm-workspace.yaml",
            "packages:\n  - packages/*\n",
        );
        // library package with only a build script
        write(
            tmp.path(),
            "packages/ui/package.json",
            r#"{ "name": "@x/ui", "scripts": { "build": "tsc" } }"#,
        );
        assert!(detect_workspaces_at(tmp.path()).is_empty());
    }
}
