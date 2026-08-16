//! Monorepo workspace detection.
//!
//! Given a freshly-cloned repo root, enumerate the runnable apps inside so the
//! import wizard can ask the user which one they want to focus on. Detects:
//! - `pnpm-workspace.yaml` (`packages:` list)
//! - root `package.json#workspaces` (array or `{ packages: [...] }` form)
//! - `nx.json` (integrated-style Nx repos without npm workspaces: apps live
//!   under `workspaceLayout.appsDir`, default `apps/`)
//!
//! Returns subdirs that are runnable: either their `package.json` has a
//! `dev`/`start` script, or (Nx) their `project.json` declares a `serve`/`dev`
//! target (issue #691) — in that case the reported dev script is a synthesized
//! `nx <target> <project>` hint.

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

/// Read workspace globs from `pnpm-workspace.yaml`, root
/// `package.json#workspaces`, and — for Nx — `nx.json`.
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

    // Integrated-style Nx repos declare no npm workspaces at all — apps live
    // under nx.json's workspaceLayout.appsDir (default "apps"). Without this,
    // such repos never even reach the runnable-workspace check (issue #691).
    // Non-runnable dirs matched by these globs are still filtered out later.
    if let Ok(contents) = std::fs::read_to_string(root.join("nx.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            let layout = json.get("workspaceLayout");
            let dir_glob = |key: &str, default: &str| {
                let dir = layout
                    .and_then(|l| l.get(key))
                    .and_then(|v| v.as_str())
                    .unwrap_or(default)
                    .trim_matches('/')
                    .to_string();
                if dir.is_empty() {
                    None
                } else {
                    Some(format!("{dir}/*"))
                }
            };
            out.extend(dir_glob("appsDir", "apps"));
            out.extend(dir_glob("libsDir", "libs"));
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

/// The Nx run target a workspace can be served with, pulled from its
/// `project.json`.
struct NxRunTarget {
    /// Target name (`serve` or `dev`) — becomes part of the `nx <target> <project>` hint.
    name: &'static str,
    /// Executor (modern `executor`, legacy `builder`) — used to guess web-ness.
    executor: Option<String>,
    /// `targets.<name>.options.port` when explicitly configured.
    port: Option<u16>,
}

/// Find a runnable target in an Nx `project.json`: a `targets` (or legacy
/// `architect`) object containing a `serve` or `dev` entry, in that priority.
fn nx_serve_target(project_json: &serde_json::Value) -> Option<NxRunTarget> {
    let targets = project_json
        .get("targets")
        .or_else(|| project_json.get("architect"))?
        .as_object()?;
    for name in ["serve", "dev"] {
        if let Some(target) = targets.get(name) {
            let executor = target
                .get("executor")
                .or_else(|| target.get("builder"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let port = target
                .get("options")
                .and_then(|o| o.get("port"))
                .and_then(|v| v.as_u64())
                .and_then(|n| u16::try_from(n).ok());
            return Some(NxRunTarget {
                name,
                executor,
                port,
            });
        }
    }
    None
}

/// Web-ness guess for an Nx executor string. Framework executors carry the
/// framework name (`@nx/next:server`, `@nx/vite:dev-server`); plain React /
/// Angular apps serve via webpack/angular dev-server executors.
fn is_web_nx_executor(executor: &str) -> bool {
    let lowered = executor.to_lowercase();
    is_web_dev_command(&lowered)
        || ["dev-server", "angular", "webpack", "@nx/web"]
            .iter()
            .any(|needle| lowered.contains(needle))
}

fn inspect_workspace(root: &Path, dir: &Path) -> Option<WorkspaceInfo> {
    let read_json = |file: &str| -> Option<serde_json::Value> {
        let contents = std::fs::read_to_string(dir.join(file)).ok()?;
        serde_json::from_str(&contents).ok()
    };
    let pkg = read_json("package.json");
    let nx = read_json("project.json");

    // A dir with neither manifest isn't a workspace we can describe.
    if pkg.is_none() && nx.is_none() {
        return None;
    }

    let get_name = |json: &Option<serde_json::Value>| -> Option<String> {
        json.as_ref()
            .and_then(|j| j.get("name"))
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    let pkg_name = get_name(&pkg);
    let nx_name = get_name(&nx);
    let dir_name = || {
        dir.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_string()
    };

    let scripts = pkg
        .as_ref()
        .and_then(|j| j.get("scripts"))
        .and_then(|v| v.as_object());
    let mut dev_script = scripts.and_then(|s| {
        s.get("dev")
            .and_then(|v| v.as_str())
            .or_else(|| s.get("start").and_then(|v| v.as_str()))
            .map(String::from)
    });

    let mut port_hint = dev_script.as_deref().and_then(parse_port_from_script);
    let mut is_web = dev_script.as_deref().is_some_and(is_web_dev_command);

    // Nx apps declare run targets in a per-app project.json instead of
    // package.json scripts; without this they were filtered out as "not
    // runnable" and the picker never offered them (issue #691). The
    // synthesized `nx <target> <project>` value is a *hint* — the picker
    // displays it, and it's what the user runs (or saves as the custom dev
    // command) to serve the app; it is never executed blindly.
    if dev_script.is_none() {
        if let Some(target) = nx.as_ref().and_then(nx_serve_target) {
            let nx_project = nx_name
                .clone()
                .or_else(|| pkg_name.clone())
                .unwrap_or_else(dir_name);
            dev_script = Some(format!("nx {} {}", target.name, nx_project));
            port_hint = target.port;
            is_web = target.executor.as_deref().is_some_and(is_web_nx_executor);
        }
    }

    let name = pkg_name.or(nx_name).unwrap_or_else(dir_name);

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

    // ── Nx (issue #691) ──────────────────────────────────────────────────

    #[test]
    fn offers_nx_app_with_project_json_serve_target() {
        // Package-based Nx repo: npm workspaces exist, but the app declares
        // its run target in project.json, not package.json scripts.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "package.json",
            r#"{ "name": "root", "workspaces": ["apps/*"] }"#,
        );
        write(
            tmp.path(),
            "apps/web/package.json",
            r#"{ "name": "@x/web" }"#,
        );
        write(
            tmp.path(),
            "apps/web/project.json",
            r#"{
                "name": "web",
                "targets": {
                    "build": { "executor": "@nx/next:build" },
                    "serve": {
                        "executor": "@nx/next:server",
                        "options": { "port": 4200 }
                    }
                }
            }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        let web = &workspaces[0];
        assert_eq!(web.relative_path, "apps/web");
        // Package name wins for display; the nx hint uses the Nx project name.
        assert_eq!(web.name, "@x/web");
        assert_eq!(web.dev_script.as_deref(), Some("nx serve web"));
        assert_eq!(web.port_hint, Some(4200));
        assert!(web.is_web);
    }

    #[test]
    fn offers_nx_app_without_package_json_via_nx_json_layout() {
        // Integrated-style Nx repo: no npm workspaces at all; apps found via
        // nx.json's default apps/ layout, described by project.json alone.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        write(tmp.path(), "nx.json", r#"{ "npmScope": "x" }"#);
        write(
            tmp.path(),
            "apps/site/project.json",
            r#"{
                "name": "site",
                "targets": {
                    "serve": { "executor": "@nx/vite:dev-server" }
                }
            }"#,
        );
        // A lib without a serve target must stay filtered out.
        write(
            tmp.path(),
            "libs/ui/project.json",
            r#"{ "name": "ui", "targets": { "build": { "executor": "@nx/js:tsc" } } }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].relative_path, "apps/site");
        assert_eq!(workspaces[0].name, "site");
        assert_eq!(workspaces[0].dev_script.as_deref(), Some("nx serve site"));
        assert_eq!(workspaces[0].port_hint, None);
        assert!(workspaces[0].is_web);
    }

    #[test]
    fn respects_nx_json_workspace_layout_override() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        write(
            tmp.path(),
            "nx.json",
            r#"{ "workspaceLayout": { "appsDir": "applications" } }"#,
        );
        write(
            tmp.path(),
            "applications/store/project.json",
            r#"{ "name": "store", "targets": { "serve": { "executor": "@nx/webpack:dev-server" } } }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].relative_path, "applications/store");
        assert!(workspaces[0].is_web);
    }

    #[test]
    fn parses_legacy_architect_dev_target() {
        // Older Angular-flavored config: `architect` instead of `targets`,
        // `builder` instead of `executor`; `dev` accepted when `serve` absent.
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        write(tmp.path(), "nx.json", "{}");
        write(
            tmp.path(),
            "apps/admin/project.json",
            r#"{
                "name": "admin",
                "architect": {
                    "dev": {
                        "builder": "@angular-devkit/build-angular:dev-server",
                        "options": { "port": 4300 }
                    }
                }
            }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].dev_script.as_deref(), Some("nx dev admin"));
        assert_eq!(workspaces[0].port_hint, Some(4300));
        assert!(workspaces[0].is_web);
    }

    #[test]
    fn package_json_dev_script_takes_precedence_over_nx_target() {
        // When the app has a real dev script, keep it — it's what the dev
        // server will actually run at the workspace cwd.
        let tmp = TempDir::new().unwrap();
        write(
            tmp.path(),
            "package.json",
            r#"{ "name": "root", "workspaces": ["apps/*"] }"#,
        );
        make_app(tmp.path(), "apps/web", "web", "next dev -p 3001");
        write(
            tmp.path(),
            "apps/web/project.json",
            r#"{ "name": "web", "targets": { "serve": { "executor": "@nx/next:server" } } }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0].dev_script.as_deref(),
            Some("next dev -p 3001")
        );
        assert_eq!(workspaces[0].port_hint, Some(3001));
    }

    #[test]
    fn nx_project_json_without_serve_or_dev_is_not_runnable() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        write(tmp.path(), "nx.json", "{}");
        write(
            tmp.path(),
            "apps/tool/project.json",
            r#"{ "name": "tool", "targets": { "build": { "executor": "@nx/js:tsc" } } }"#,
        );
        assert!(detect_workspaces_at(tmp.path()).is_empty());
    }

    #[test]
    fn non_web_nx_executor_is_not_marked_web() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "package.json", r#"{ "name": "root" }"#);
        write(tmp.path(), "nx.json", "{}");
        write(
            tmp.path(),
            "apps/api/project.json",
            r#"{ "name": "api", "targets": { "serve": { "executor": "@nx/js:node" } } }"#,
        );

        let workspaces = detect_workspaces_at(tmp.path());
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].dev_script.as_deref(), Some("nx serve api"));
        assert!(!workspaces[0].is_web);
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
