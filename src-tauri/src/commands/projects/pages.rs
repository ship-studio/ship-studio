//! Safe source-file mutations for Astro routes.
//!
//! The Pages panel owns presentation and organization. This module owns only
//! source routes: it maps canonical static URL paths to Astro page files,
//! refuses ambiguous or unsafe targets, applies the change, and returns the
//! scanner's authoritative inventory.

use super::{detection, list_pages_in};
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::{PageInfo, ProjectType};
use crate::utils::{
    classify_fs_error, create_command, resolve_workspace_path, validate_project_file_path,
    validate_project_path,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

static PAGE_MUTATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const STARTER_ASTRO_PAGE: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>New page</title>
  </head>
  <body>
    <main>
      <h1>New page</h1>
      <p>Start building your page here.</p>
    </main>
  </body>
</html>
"#;

const TEMPLATE_ENTRIES_NODE: &str = r#"
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const [root, file, pattern] = process.argv.slice(1);
let devServer;
try {
  const require = createRequire(path.join(root, 'package.json'));
  const { dev } = await import(pathToFileURL(require.resolve('astro')).href);
  let viteServer;
  let config;
  devServer = await dev({
    root,
    server: { host: '127.0.0.1', port: 0, open: false },
    vite: { server: { hmr: false } },
    integrations: [{
      name: 'ship-studio-template-entries',
      hooks: {
        'astro:config:done': ({ config: resolved }) => { config = resolved; },
        'astro:server:setup': ({ server }) => { viteServer = server; },
      },
    }],
  });
  try {
    const runner = viteServer?.environments?.ssr?.runner;
    const module = runner?.import
      ? await runner.import(file)
      : await viteServer?.ssrLoadModule?.(file);
    if (!module || typeof module.getStaticPaths !== 'function') {
      throw new Error('This dynamic page does not export getStaticPaths.');
    }
    const routePattern = pattern;
    const paginate = (data, options = {}) => {
      if (!Array.isArray(data)) return [];
      const pageSize = Number(options.pageSize || 10);
      if (!(pageSize > 0)) return [];
      const isCatchallPage = routePattern.includes('[...page]');
      const hasPageParameter = isCatchallPage || routePattern.includes('[page]');
      if (!hasPageParameter) throw new Error('Astro pagination requires a [page] or [...page] route parameter.');
      const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
      return Array.from({ length: Math.min(pageCount, 500) }, (_, index) => ({
        params: { ...(options.params || {}), page: isCatchallPage && index === 0 ? undefined : String(index + 1) },
        props: options.props || {},
      }));
    };
    let timeout;
    const paths = await Promise.race([
      Promise.resolve(module.getStaticPaths({ routePattern, paginate })),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('getStaticPaths took too long to respond.')), 20000); }),
    ]).finally(() => clearTimeout(timeout));
    const names = [...pattern.matchAll(/\[([.]{3})?([^\]]+)\]/g)].map((match) => ({ catchall: !!match[1], name: match[2] }));
    const entries = [];
    const seen = new Set();
    for (const item of Array.isArray(paths) ? paths : []) {
      const params = item?.params;
      if (!params || typeof params !== 'object') continue;
      let route = pattern;
      const labels = [];
      let valid = true;
      for (const part of names) {
        const value = params[part.name];
        if (value === undefined && part.catchall) {
          route = route.replace(`[...${part.name}]`, '');
          continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number' && !(part.catchall && Array.isArray(value))) { valid = false; break; }
        const values = Array.isArray(value) ? value.map(String) : part.catchall && typeof value === 'string' ? value.split('/') : [String(value)];
        if (values.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('?') || segment.includes('#'))) { valid = false; break; }
        route = route.replace(part.catchall ? `[...${part.name}]` : `[${part.name}]`, values.map(encodeURIComponent).join('/'));
        labels.push(values.join('/'));
      }
      if (!valid || /\[[^\]]+\]/.test(route) || seen.has(route)) continue;
      seen.add(route);
      const base = config.base === '/' ? '' : String(config.base || '').replace(/\/$/, '');
      route = `${base}${route}` || '/';
      if (config.trailingSlash === 'always' && route !== '/' && !route.endsWith('/')) route += '/';
      if (config.trailingSlash === 'never' && route.length > 1) route = route.replace(/\/$/, '');
      const label = labels.at(-1) || route;
      entries.push({ route, label });
      if (entries.length >= 500) break;
    }
    process.stdout.write(`\n__SHIPSTUDIO_TEMPLATE_ENTRIES__${JSON.stringify({ entries })}`);
  } finally {
    await devServer.stop();
    devServer = undefined;
  }
} catch (error) {
  if (devServer) await devServer.stop().catch(() => {});
  process.stdout.write(`\n__SHIPSTUDIO_TEMPLATE_ENTRIES__${JSON.stringify({ entries: [], error: error instanceof Error ? error.message : String(error) })}`);
  process.exitCode = 2;
}
"#;

const TEMPLATE_ENTRIES_NEXT_NODE: &str = include_str!("template_entries/next.mjs");
const TEMPLATE_ENTRIES_SVELTEKIT_NODE: &str = include_str!("template_entries/sveltekit.mjs");
const TEMPLATE_ENTRIES_NUXT_NODE: &str = include_str!("template_entries/nuxt.mjs");

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePageEntry {
    pub route: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePageEntries {
    pub entries: Vec<TemplatePageEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProvidedTemplateEntries {
    version: u8,
    #[serde(default)]
    templates: HashMap<String, Vec<TemplatePageEntry>>,
}

/// Resolve concrete entries for dynamic pages using the framework's route
/// conventions, or an explicit project manifest. The child process is bounded.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, route = %route))]
pub async fn list_template_page_entries(
    project_path: String,
    route: String,
) -> Result<TemplatePageEntries, CommandError> {
    let root = validate_project_path(&project_path)?;
    let pages = list_pages_in(&root)?;
    let page = pages
        .iter()
        .find(|page| page.route == route && is_dynamic_route(&page.route))
        .ok_or_else(|| {
            CommandError::expected(
                "This dynamic page is no longer available in the current project.",
            )
        })?;
    if let Some(entries) = read_provided_template_entries(&root, &route)? {
        return Ok(TemplatePageEntries {
            entries,
            error: None,
        });
    }
    let workspace = resolve_workspace_path(&root);
    let workspace = dunce::canonicalize(&workspace).map_err(|e| {
        classify_fs_error("resolve this project's active workspace", &workspace, &e)
    })?;
    let canonical_project = dunce::canonicalize(&root)
        .map_err(|e| classify_fs_error("resolve this project", &root, &e))?;
    if !workspace.starts_with(&canonical_project) {
        return Err(CommandError::expected(
            "Security error: the active workspace resolves outside this project.",
        ));
    }
    let project_type = detection::detect_project_type(&workspace);
    let file = validate_project_file_path(&page.file_path)?;
    let file = dunce::canonicalize(&file)
        .map_err(|e| classify_fs_error("resolve this dynamic page", &file, &e))?;
    if !file.starts_with(&workspace) {
        return Err(CommandError::expected(
            "Security error: this page resolves outside the active workspace.",
        ));
    }
    let (script, runner_name, pattern) = match project_type {
        ProjectType::Astro => {
            let dir = workspace.join("src/pages");
            let root = canonical_pages_root(&dir, &file, "Astro")?;
            let pattern = astro_route_pattern(&root, &file)?;
            (TEMPLATE_ENTRIES_NODE, "Astro getStaticPaths", pattern)
        }
        ProjectType::Sveltekit => {
            let dir = workspace.join("src/routes");
            canonical_pages_root(&dir, &file, "SvelteKit")?;
            (
                TEMPLATE_ENTRIES_SVELTEKIT_NODE,
                "SvelteKit entries",
                route.clone(),
            )
        }
        ProjectType::Nuxt => {
            let dir = nuxt_pages_root(&workspace);
            let root = canonical_pages_root(&dir, &file, "Nuxt")?;
            (
                TEMPLATE_ENTRIES_NUXT_NODE,
                "Nuxt prerender entries",
                nuxt_route_pattern(&root, &file)?,
            )
        }
        ProjectType::Nextjs => {
            let dir = next_pages_root(&workspace, &file).ok_or_else(|| {
                CommandError::expected(
                    "This dynamic page is outside the active Next.js pages directory.",
                )
            })?;
            canonical_pages_root(&dir, &file, "Next.js")?;
            (
                TEMPLATE_ENTRIES_NEXT_NODE,
                "Next.js dynamic entries",
                route.clone(),
            )
        }
        _ => return Ok(TemplatePageEntries {
            entries: vec![],
            error: Some("Add this route's concrete entries to .shipstudio/template-entries.json to preview it.".into()),
        }),
    };
    let mut command = create_command("node");
    command
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .arg(&workspace)
        .arg(&file)
        .arg(&pattern)
        .current_dir(&workspace);
    let output = run_with_timeout(tokio::process::Command::from(command), runner_name, 30).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let payload = stdout
        .rsplit("__SHIPSTUDIO_TEMPLATE_ENTRIES__")
        .next()
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .trim();
    let mut result: TemplatePageEntries =
        serde_json::from_str(payload).unwrap_or(TemplatePageEntries {
            entries: vec![],
            error: Some("The framework could not return the dynamic page entries.".into()),
        });
    if !output.status.success() && result.error.is_none() {
        result.error = Some("The framework could not resolve this dynamic page's entries.".into());
    }
    let mut seen = HashSet::new();
    result.entries = result
        .entries
        .into_iter()
        .filter(|entry| safe_concrete_route(&entry.route) && seen.insert(entry.route.clone()))
        .take(500)
        .map(|entry| TemplatePageEntry {
            label: if entry.label.trim().is_empty() {
                entry.route.clone()
            } else {
                entry.label.trim().chars().take(120).collect()
            },
            route: entry.route,
        })
        .collect();
    Ok(result)
}

fn canonical_pages_root(dir: &Path, file: &Path, framework: &str) -> Result<PathBuf, CommandError> {
    let root = dunce::canonicalize(dir)
        .map_err(|e| classify_fs_error("resolve this project's pages directory", dir, &e))?;
    if !file.starts_with(&root) {
        return Err(CommandError::expected(format!(
            "This dynamic page is outside the active {framework} pages directory."
        )));
    }
    Ok(root)
}

fn nuxt_pages_root(workspace: &Path) -> PathBuf {
    let nuxt4 = workspace.join("app/pages");
    if nuxt4.is_dir() {
        nuxt4
    } else {
        workspace.join("pages")
    }
}

fn next_pages_root(workspace: &Path, file: &Path) -> Option<PathBuf> {
    ["app", "src/app", "pages", "src/pages"]
        .iter()
        .map(|p| workspace.join(p))
        .find(|dir| dunce::canonicalize(dir).is_ok_and(|canonical| file.starts_with(canonical)))
}

fn nuxt_route_pattern(pages_root: &Path, file: &Path) -> Result<String, CommandError> {
    let relative = file.strip_prefix(pages_root).map_err(|_| {
        CommandError::expected("This dynamic page is outside the active Nuxt pages directory.")
    })?;
    let mut segments = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        let segment = component.to_string_lossy();
        if segment.ends_with(".vue") {
            let stem = segment.trim_end_matches(".vue");
            if stem != "index" {
                segments.push(nuxt_segment_pattern(stem));
            }
        } else {
            segments.push(nuxt_segment_pattern(&segment));
        }
    }
    Ok(if segments.is_empty() {
        "/".into()
    } else {
        format!("/{}", segments.join("/"))
    })
}

fn nuxt_segment_pattern(segment: &str) -> String {
    if let Some(name) = segment
        .strip_prefix("[...")
        .and_then(|s| s.strip_suffix(']'))
    {
        format!(":{name}(*)")
    } else if let Some(name) = segment
        .strip_prefix("[[...")
        .and_then(|s| s.strip_suffix("]]"))
    {
        format!(":{name}(*)")
    } else if let Some(name) = segment.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        format!(":{name}")
    } else {
        segment.to_string()
    }
}

fn read_provided_template_entries(
    root: &Path,
    route: &str,
) -> Result<Option<Vec<TemplatePageEntry>>, CommandError> {
    let manifest_path = root.join(".shipstudio").join("template-entries.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let safe_path = validate_project_file_path(&manifest_path.to_string_lossy())?;
    let source = fs::read_to_string(&safe_path).map_err(|error| {
        classify_fs_error("read the project's template entry list", &safe_path, &error)
    })?;
    let manifest: ProvidedTemplateEntries = serde_json::from_str(&source).map_err(|error| {
        CommandError::expected(format!(
            "The project's template entry list is invalid: {error}"
        ))
    })?;
    if manifest.version != 1 {
        return Err(CommandError::expected(
            "The project's template entry list uses an unsupported version.",
        ));
    }
    let Some(entries) = manifest.templates.get(route) else {
        return Ok(None);
    };
    let mut seen = HashSet::new();
    let clean = entries
        .iter()
        .filter(|entry| safe_concrete_route(&entry.route) && seen.insert(entry.route.clone()))
        .take(500)
        .map(|entry| TemplatePageEntry {
            route: entry.route.clone(),
            label: if entry.label.trim().is_empty() {
                entry.route.clone()
            } else {
                entry.label.trim().chars().take(120).collect()
            },
        })
        .collect();
    Ok(Some(clean))
}

fn safe_concrete_route(route: &str) -> bool {
    route.starts_with('/')
        && !route.starts_with("//")
        && !route.contains("//")
        && !route.contains('[')
        && !route.contains(']')
        && !route
            .chars()
            .any(|character| matches!(character, '?' | '#' | '\\'))
        && !route.chars().any(char::is_control)
        && !route
            .split('/')
            .any(|segment| segment == "." || segment == ".." || segment.starts_with(':'))
}

fn is_dynamic_route(route: &str) -> bool {
    (route.contains('[') && route.contains(']')) || route.contains(':') || route.contains('*')
}

fn astro_route_pattern(pages_root: &Path, file: &Path) -> Result<String, CommandError> {
    let relative = file.strip_prefix(pages_root).map_err(|_| {
        CommandError::expected("This dynamic page is outside the Astro pages directory.")
    })?;
    let mut segments = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        segments.push(component.to_string_lossy().into_owned());
    }
    let Some(filename) = segments.pop() else {
        return Err(CommandError::expected(
            "This dynamic page has an invalid source path.",
        ));
    };
    let stem = Path::new(&filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CommandError::expected("This dynamic page has an invalid filename."))?;
    if stem != "index" {
        segments.push(stem.to_string());
    }
    if segments.is_empty() {
        Ok("/".into())
    } else {
        Ok(format!("/{}", segments.join("/")))
    }
}

/// A mutation that changes an Astro page's source route.
///
/// `newRoute` is required only for `duplicate` and `move`. Folder grouping and
/// display names are presentation state owned by the frontend.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PageMutation {
    Create { route: String },
    Duplicate { route: String, new_route: String },
    Move { route: String, new_route: String },
    Delete { route: String },
    Homepage { route: String },
}

/// Apply an Astro page mutation and return the refreshed route inventory.
///
/// Only static Astro routes are mutable. Dynamic routes, locale-prefixed
/// routes, aliases, symlinked page paths, and unsupported frameworks are
/// rejected instead of being guessed at.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn mutate_project_page(
    project_path: String,
    mutation: PageMutation,
) -> Result<Vec<PageInfo>, CommandError> {
    let _guard = PAGE_MUTATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&root);
    let canonical_workspace = dunce::canonicalize(&workspace).map_err(|e| {
        classify_fs_error("resolve this project's active workspace", &workspace, &e)
    })?;

    if detection::detect_project_type(&canonical_workspace) != ProjectType::Astro {
        return Err(CommandError::expected(
            "Page source mutations currently support Astro projects only.",
        ));
    }

    let pages_dir = canonical_workspace.join("src").join("pages");
    let locale_prefixes = crate::commands::i18n::astro_all_locale_prefixes(&canonical_workspace);
    mutate_project_page_in(
        &root,
        &canonical_workspace,
        &pages_dir,
        &locale_prefixes,
        mutation,
    )?;

    list_pages_in(&root)
}

fn mutate_project_page_in(
    project_root: &Path,
    workspace: &Path,
    pages_dir: &Path,
    locale_prefixes: &[String],
    mutation: PageMutation,
) -> Result<(), CommandError> {
    match &mutation {
        PageMutation::Create { route } => {
            validate_static_route(route, locale_prefixes)?;
        }
        PageMutation::Duplicate { route, new_route } | PageMutation::Move { route, new_route } => {
            validate_static_route(route, locale_prefixes)?;
            validate_static_route(new_route, locale_prefixes)?;
        }
        PageMutation::Delete { route } | PageMutation::Homepage { route } => {
            validate_static_route(route, locale_prefixes)?;
        }
    }

    ensure_pages_directory(workspace, pages_dir)?;
    let canonical_pages = dunce::canonicalize(pages_dir)
        .map_err(|e| classify_fs_error("resolve this project's pages directory", pages_dir, &e))?;
    if !canonical_pages.starts_with(workspace) {
        return Err(CommandError::expected(
            "Security error: the Astro pages directory resolves outside the active workspace.",
        ));
    }

    let pages = list_pages_in(project_root)?;
    match mutation {
        PageMutation::Create { route } => {
            let segments = validate_static_route(&route, locale_prefixes)?;
            let destination = destination_for_route(&canonical_pages, &segments, "astro");
            ensure_route_parent(&canonical_pages, &destination)?;
            ensure_route_is_unoccupied(&canonical_pages, &segments, &[])?;
            create_starter_page(&destination)?;
        }
        PageMutation::Duplicate { route, new_route } => {
            let source_segments = validate_static_route(&route, locale_prefixes)?;
            let destination_segments = validate_static_route(&new_route, locale_prefixes)?;
            let source = resolve_page(&canonical_pages, &pages, &route)?;
            let extension = supported_page_extension(&source)?;
            let destination =
                destination_for_route(&canonical_pages, &destination_segments, extension);

            if source == destination {
                return Err(CommandError::expected(
                    "Choose a different route for the duplicate page.",
                ));
            }
            ensure_route_parent(&canonical_pages, &destination)?;
            ensure_route_is_unoccupied(&canonical_pages, &destination_segments, &[])?;
            ensure_route_is_unoccupied(&canonical_pages, &source_segments, &[source.as_path()])?;
            reject_relative_reference_breakage(&source, &destination)?;
            copy_page_no_clobber(&source, &destination)?;
        }
        PageMutation::Move { route, new_route } => {
            let source_segments = validate_static_route(&route, locale_prefixes)?;
            let destination_segments = validate_static_route(&new_route, locale_prefixes)?;
            if route == new_route {
                return Ok(());
            }
            let source = resolve_page(&canonical_pages, &pages, &route)?;
            let extension = supported_page_extension(&source)?;
            let destination =
                destination_for_route(&canonical_pages, &destination_segments, extension);

            if source == destination {
                return Ok(());
            }
            reject_relative_reference_breakage(&source, &destination)?;
            ensure_route_parent(&canonical_pages, &destination)?;
            ensure_route_is_unoccupied(&canonical_pages, &destination_segments, &[])?;
            ensure_route_is_unoccupied(&canonical_pages, &source_segments, &[source.as_path()])?;
            move_page_no_clobber(&source, &destination)?;
        }
        PageMutation::Delete { route } => {
            let segments = validate_static_route(&route, locale_prefixes)?;
            let source = resolve_page(&canonical_pages, &pages, &route)?;
            ensure_route_is_unoccupied(&canonical_pages, &segments, &[source.as_path()])?;
            fs::remove_file(&source)
                .map_err(|e| classify_fs_error("delete this Astro page", &source, &e))?;
        }
        PageMutation::Homepage { route } => {
            let source_segments = validate_static_route(&route, locale_prefixes)?;
            if source_segments.is_empty() {
                return Ok(());
            }

            let source = resolve_page(&canonical_pages, &pages, &route)?;
            let home_pages: Vec<_> = pages.iter().filter(|page| page.route == "/").collect();
            if home_pages.len() > 1 {
                return Err(ambiguous_route("/"));
            }

            if let Some(home_page) = home_pages.first() {
                let incumbent = resolve_page(&canonical_pages, &pages, &home_page.route)?;
                if incumbent == source {
                    return Ok(());
                }
                ensure_route_is_unoccupied(
                    &canonical_pages,
                    &source_segments,
                    &[source.as_path()],
                )?;
                ensure_route_is_unoccupied(&canonical_pages, &[], &[incumbent.as_path()])?;
                let source_extension = supported_page_extension(&source)?;
                let incumbent_extension = supported_page_extension(&incumbent)?;
                let source_destination =
                    destination_for_route(&canonical_pages, &[], source_extension);
                let incumbent_destination =
                    destination_for_route(&canonical_pages, &source_segments, incumbent_extension);
                reject_relative_reference_breakage(&source, &source_destination)?;
                reject_relative_reference_breakage(&incumbent, &incumbent_destination)?;
                swap_page_files(
                    &source,
                    &incumbent,
                    &source_destination,
                    &incumbent_destination,
                )?;
            } else {
                let extension = supported_page_extension(&source)?;
                let destination = destination_for_route(&canonical_pages, &[], extension);
                ensure_route_parent(&canonical_pages, &destination)?;
                ensure_route_is_unoccupied(&canonical_pages, &[], &[])?;
                reject_relative_reference_breakage(&source, &destination)?;
                move_page_no_clobber(&source, &destination)?;
            }
        }
    }

    Ok(())
}

/// Parse a canonical URL route and reject routes this command cannot safely
/// represent as an Astro file path.
fn validate_static_route(
    route: &str,
    locale_prefixes: &[String],
) -> Result<Vec<String>, CommandError> {
    if route == "/" {
        return Ok(Vec::new());
    }
    if !route.starts_with('/') || route.ends_with('/') || route.contains("//") {
        return Err(invalid_route(
            route,
            "use a canonical path such as `/about`",
        ));
    }

    let segments: Vec<String> = route[1..].split('/').map(str::to_owned).collect();
    if segments.is_empty() || segments.iter().any(|segment| !valid_route_segment(segment)) {
        return Err(invalid_route(
            route,
            "dynamic, localized, encoded, and special Astro routes are not supported",
        ));
    }
    if let Some(first) = segments.first() {
        if locale_prefixes.iter().any(|locale| locale == first) {
            return Err(invalid_route(
                route,
                "localized page paths are not mutable from this panel",
            ));
        }
    }
    Ok(segments)
}

fn valid_route_segment(segment: &str) -> bool {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.starts_with('.')
        || segment.starts_with('_')
        || [".astro", ".md", ".mdx", ".html", ".js", ".ts"]
            .iter()
            .any(|extension| segment.ends_with(extension))
    {
        return false;
    }
    segment
        .chars()
        .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~'))
}

fn invalid_route(route: &str, reason: &str) -> CommandError {
    CommandError::expected(format!("Cannot mutate route `{route}`: {reason}."))
}

fn ambiguous_route(route: &str) -> CommandError {
    CommandError::expected(format!(
        "More than one Astro page resolves to `{route}`. Resolve the route collision in the source tree first."
    ))
}

fn ensure_pages_directory(workspace: &Path, pages_dir: &Path) -> Result<(), CommandError> {
    let canonical_workspace = dunce::canonicalize(workspace)
        .map_err(|e| classify_fs_error("resolve this project's active workspace", workspace, &e))?;
    let src_dir = canonical_workspace.join("src");
    ensure_directory_no_symlink(&canonical_workspace, &src_dir)?;
    ensure_directory_no_symlink(&canonical_workspace, pages_dir)?;
    Ok(())
}

fn ensure_directory_no_symlink(root: &Path, directory: &Path) -> Result<(), CommandError> {
    if !directory.starts_with(root) {
        return Err(CommandError::expected(
            "Security error: the Astro page destination escapes the active workspace.",
        ));
    }
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CommandError::expected(format!(
            "Security error: refusing to follow symlinked page directory `{}`.",
            directory.display()
        ))),
        Ok(metadata) if !metadata.is_dir() => Err(CommandError::expected(format!(
            "Cannot create Astro pages because `{}` is not a directory.",
            directory.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(directory).map_err(|e| {
                classify_fs_error("create the Astro pages directory", directory, &e)
            })?;
            Ok(())
        }
        Err(error) => Err(classify_fs_error(
            "inspect the Astro pages directory",
            directory,
            &error,
        )),
    }
}

fn resolve_page(
    pages_dir: &Path,
    pages: &[PageInfo],
    route: &str,
) -> Result<PathBuf, CommandError> {
    let matches: Vec<_> = pages.iter().filter(|page| page.route == route).collect();
    if matches.is_empty() {
        return Err(CommandError::expected(format!(
            "No Astro page was found for `{route}`. Refresh the Pages panel and try again."
        )));
    }
    if matches.len() > 1 {
        return Err(ambiguous_route(route));
    }

    let source = PathBuf::from(&matches[0].file_path);
    let safe_source = validate_project_file_path(&source.to_string_lossy())?;
    let canonical_pages = dunce::canonicalize(pages_dir)
        .map_err(|e| classify_fs_error("resolve this project's pages directory", pages_dir, &e))?;
    let canonical_source = dunce::canonicalize(&safe_source)
        .map_err(|e| classify_fs_error("resolve this Astro page", &safe_source, &e))?;
    if !canonical_source.starts_with(canonical_pages) {
        return Err(CommandError::expected(
            "Security error: the selected page resolves outside this project's pages directory.",
        ));
    }
    let metadata = fs::symlink_metadata(&canonical_source)
        .map_err(|e| classify_fs_error("inspect this Astro page", &canonical_source, &e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(CommandError::expected(
            "The selected Astro page is not a regular source file.",
        ));
    }
    Ok(canonical_source)
}

fn supported_page_extension(path: &Path) -> Result<&'static str, CommandError> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("astro") => Ok("astro"),
        Some("md") => Ok("md"),
        Some("mdx") => Ok("mdx"),
        _ => Err(CommandError::expected(
            "Only Astro, Markdown, and MDX page files can be changed from this panel.",
        )),
    }
}

fn destination_for_route(pages_dir: &Path, segments: &[String], extension: &str) -> PathBuf {
    if segments.is_empty() {
        return pages_dir.join(format!("index.{extension}"));
    }
    let base = segments
        .iter()
        .fold(pages_dir.to_path_buf(), |path, segment| path.join(segment));
    if segments.last().is_some_and(|segment| segment == "index") {
        base.join(format!("index.{extension}"))
    } else {
        append_extension(&base, extension)
    }
}

/// Candidate files that Astro could use for the same route. This includes
/// endpoint extensions which the browsing scanner intentionally omits.
fn route_aliases(pages_dir: &Path, segments: &[String]) -> Vec<PathBuf> {
    const EXTENSIONS: &[&str] = &["astro", "md", "mdx", "html", "js", "ts"];
    let mut bases = Vec::new();
    if segments.is_empty() {
        bases.push(pages_dir.join("index"));
    } else {
        let base = segments
            .iter()
            .fold(pages_dir.to_path_buf(), |path, segment| path.join(segment));
        if segments.last().is_some_and(|segment| segment == "index") {
            bases.push(base.join("index"));
        } else {
            bases.push(base.clone());
            bases.push(base.join("index"));
        }
    }
    bases
        .into_iter()
        .flat_map(|base| {
            EXTENSIONS
                .iter()
                .map(move |extension| append_extension(&base, extension))
        })
        .collect()
}

fn append_extension(path: &Path, extension: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".");
    name.push(extension);
    PathBuf::from(name)
}

fn ensure_route_parent(pages_dir: &Path, destination: &Path) -> Result<(), CommandError> {
    let parent = destination.parent().ok_or_else(|| {
        CommandError::expected("The Astro page destination has no parent directory.")
    })?;
    if !parent.starts_with(pages_dir) {
        return Err(CommandError::expected(
            "Security error: the Astro page destination escapes the pages directory.",
        ));
    }

    let relative = parent
        .strip_prefix(pages_dir)
        .map_err(|_| CommandError::expected("Security error: invalid Astro page destination."))?;
    let mut current = pages_dir.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(CommandError::expected(
                "Security error: invalid Astro page destination component.",
            ));
        };
        current.push(name);
        ensure_directory_no_symlink(pages_dir, &current)?;
        let canonical = dunce::canonicalize(&current)
            .map_err(|e| classify_fs_error("resolve an Astro page directory", &current, &e))?;
        if !canonical.starts_with(pages_dir) {
            return Err(CommandError::expected(
                "Security error: an Astro page directory resolves outside the pages directory.",
            ));
        }
    }
    Ok(())
}

fn ensure_route_is_unoccupied(
    pages_dir: &Path,
    segments: &[String],
    allowed_files: &[&Path],
) -> Result<(), CommandError> {
    let allowed: HashSet<PathBuf> = allowed_files
        .iter()
        .map(|path| path.to_path_buf())
        .collect();
    for candidate in route_aliases(pages_dir, segments) {
        if allowed.contains(&candidate) {
            continue;
        }
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {
                let route = if segments.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", segments.join("/"))
                };
                return Err(CommandError::expected(format!(
                    "The Astro route `{route}` already has a source file at `{}`.",
                    candidate.display()
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(classify_fs_error(
                    "check for an existing Astro route",
                    &candidate,
                    &error,
                ));
            }
        }
    }
    Ok(())
}

fn create_starter_page(destination: &Path) -> Result<(), CommandError> {
    validate_project_file_path(&destination.to_string_lossy())?;
    stage_starter_page_noclobber(destination)
        .map_err(|e| classify_fs_error("create this Astro page", destination, &e))
}

fn stage_starter_page_noclobber(destination: &Path) -> io::Result<()> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(STARTER_ASTRO_PAGE.as_bytes())?;
    staged.flush()?;
    staged
        .persist_noclobber(destination)
        .map_err(|error| error.error)?;
    Ok(())
}

fn copy_page_no_clobber(source: &Path, destination: &Path) -> Result<(), CommandError> {
    validate_project_file_path(&destination.to_string_lossy())?;
    stage_page_copy_noclobber(source, destination)
        .map_err(|e| classify_fs_error("duplicate this Astro page", destination, &e))
}

fn stage_page_copy_noclobber(source: &Path, destination: &Path) -> io::Result<()> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination has no parent directory",
        )
    })?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    let mut input = File::open(source)?;
    let permissions = input.metadata()?.permissions();
    io::copy(&mut input, &mut staged)?;
    staged.as_file().set_permissions(permissions)?;
    staged.flush()?;
    staged
        .persist_noclobber(destination)
        .map_err(|error| error.error)?;
    Ok(())
}

fn move_page_no_clobber(source: &Path, destination: &Path) -> Result<(), CommandError> {
    validate_project_file_path(&destination.to_string_lossy())?;
    move_file_noclobber(source, destination)
        .map_err(|e| classify_fs_error("move this Astro page", source, &e))
}

fn reject_relative_reference_breakage(
    source: &Path,
    destination: &Path,
) -> Result<(), CommandError> {
    if source.parent() == destination.parent() {
        return Ok(());
    }
    let content = fs::read_to_string(source).map_err(|e| {
        classify_fs_error("inspect this Astro page's relative references", source, &e)
    })?;
    if content.contains("./") || content.contains("../") {
        return Err(CommandError::expected(format!(
            "Cannot move this page across folders because `{}` contains relative references. Update its imports or asset paths first.",
            source.display()
        )));
    }
    Ok(())
}

fn swap_page_files(
    source: &Path,
    incumbent: &Path,
    source_destination: &Path,
    incumbent_destination: &Path,
) -> Result<(), CommandError> {
    let parent = source.parent().ok_or_else(|| {
        CommandError::expected("The Astro page does not have a parent directory.")
    })?;
    let temporary = unique_swap_path(parent);
    move_file_noclobber(source, &temporary)
        .map_err(|e| classify_fs_error("prepare the Astro homepage swap", source, &e))?;

    if let Err(error) = move_file_noclobber(incumbent, incumbent_destination) {
        let rollback_source = move_file_noclobber(&temporary, source);
        tracing::error!(
            error = %error,
            rollback_source = ?rollback_source,
            "Astro homepage swap failed and source rollback was attempted"
        );
        return Err(classify_fs_error(
            "swap the Astro homepage",
            incumbent,
            &error,
        ));
    }
    if let Err(error) = move_file_noclobber(&temporary, source_destination) {
        let rollback_incumbent = move_file_noclobber(incumbent_destination, incumbent);
        let rollback_source = move_file_noclobber(&temporary, source);
        tracing::error!(
            error = %error,
            rollback_incumbent = ?rollback_incumbent,
            rollback_source = ?rollback_source,
            "Astro homepage swap failed and rollback was attempted"
        );
        return Err(classify_fs_error(
            "finish the Astro homepage swap",
            source_destination,
            &error,
        ));
    }
    Ok(())
}

fn move_file_noclobber(source: &Path, destination: &Path) -> io::Result<()> {
    stage_page_copy_noclobber(source, destination)?;
    if let Err(remove_error) = fs::remove_file(source) {
        if let Err(rollback_error) = fs::remove_file(destination) {
            tracing::error!(
                source = %source.display(),
                destination = %destination.display(),
                error = %remove_error,
                rollback_error = %rollback_error,
                "failed to roll back the published Astro page after source removal failed"
            );
        }
        return Err(remove_error);
    }
    Ok(())
}

fn unique_swap_path(parent: &Path) -> PathBuf {
    parent.join(format!(
        ".shipstudio-page-swap-{}.tmp",
        uuid::Uuid::new_v4()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn astro_mutations_reject_collisions_and_swap_homepage(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let pages_dir = temp.path().join("src/pages");
        fs::create_dir_all(&pages_dir)?;
        fs::write(pages_dir.join("index.astro"), "home page")?;
        fs::write(pages_dir.join("about.astro"), "about page")?;
        fs::write(pages_dir.join("copy-source.astro"), "source copy")?;
        fs::write(pages_dir.join("copy-target.astro"), "keep this page")?;

        let collision = ensure_route_is_unoccupied(&pages_dir, &["about".into()], &[]);
        assert!(collision.is_err());
        assert_eq!(
            fs::read_to_string(pages_dir.join("about.astro"))?,
            "about page"
        );

        let no_clobber = stage_page_copy_noclobber(
            &pages_dir.join("copy-source.astro"),
            &pages_dir.join("copy-target.astro"),
        );
        assert!(no_clobber.is_err());
        assert_eq!(
            fs::read_to_string(pages_dir.join("copy-target.astro"))?,
            "keep this page"
        );

        swap_page_files(
            &pages_dir.join("about.astro"),
            &pages_dir.join("index.astro"),
            &pages_dir.join("index.astro"),
            &pages_dir.join("about.astro"),
        )?;

        assert_eq!(
            fs::read_to_string(pages_dir.join("index.astro"))?,
            "about page"
        );
        assert_eq!(
            fs::read_to_string(pages_dir.join("about.astro"))?,
            "home page"
        );
        Ok(())
    }

    #[test]
    fn created_astro_page_has_visible_content_without_clobbering(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let destination = temp.path().join("about.astro");

        stage_starter_page_noclobber(&destination)?;

        let content = fs::read_to_string(&destination)?;
        assert!(content.contains("<h1>New page</h1>"));
        assert!(content.contains("<p>Start building your page here.</p>"));

        let collision = stage_starter_page_noclobber(&destination);
        assert!(collision.is_err());
        assert_eq!(fs::read_to_string(destination)?, content);
        Ok(())
    }
}
