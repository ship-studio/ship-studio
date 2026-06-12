//! Project type detection and page scanning.
//!
//! Detects framework types (Next.js, SvelteKit, Astro, Nuxt, static HTML)
//! and scans project directories for page routes.

use crate::cache::TtlCache;
use crate::errors::CommandError;
use crate::types::{PageInfo, ProjectType};
use crate::utils::{resolve_workspace_path, validate_project_path};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

/// Cache for project type detection, keyed by (path, mtime-signature).
/// The mtime-signature changes whenever package.json or a lockfile is
/// touched, which is exactly when detection could return a different type.
/// Short TTL (30s) bounds staleness from rename/delete events we don't see.
static PROJECT_TYPE_CACHE: LazyLock<TtlCache<(String, u128), ProjectType>> =
    LazyLock::new(|| TtlCache::new(Duration::from_secs(30)));

/// Compute an mtime fingerprint across the files that determine project type.
/// Returns the max mtime nanos across package.json + common lockfiles. If
/// none exist, returns 0 (directory has no signals — cache keys by path only).
fn detection_signature(project_path: &std::path::Path) -> u128 {
    const SENTINELS: &[&str] = &[
        "package.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "package-lock.json",
        "svelte.config.js",
        "svelte.config.ts",
        "astro.config.mjs",
        "astro.config.ts",
        "nuxt.config.ts",
        "next.config.js",
        "next.config.mjs",
        "next.config.ts",
        "vite.config.js",
        "vite.config.ts",
        // Native mobile signals
        "app.json",
        "app.config.js",
        "app.config.ts",
        "metro.config.js",
        "metro.config.ts",
        "pubspec.yaml",
        // Shopify theme signals (nested paths work — metadata() takes any path)
        "layout/theme.liquid",
        "config/settings_schema.json",
    ];
    let mut max_nanos: u128 = 0;
    for name in SENTINELS {
        if let Ok(metadata) = std::fs::metadata(project_path.join(name)) {
            if let Ok(mtime) = metadata.modified() {
                if let Ok(since) = mtime.duration_since(SystemTime::UNIX_EPOCH) {
                    max_nanos = max_nanos.max(since.as_nanos());
                }
            }
        }
    }
    max_nanos
}

/// Detect if this is a SvelteKit project
pub(crate) fn is_sveltekit_project(project_path: &std::path::Path) -> bool {
    // Check for svelte.config.js or svelte.config.ts
    if project_path.join("svelte.config.js").exists()
        || project_path.join("svelte.config.ts").exists()
    {
        return true;
    }

    // Check package.json for @sveltejs/kit
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"@sveltejs/kit\"") {
                return true;
            }
        }
    }

    false
}

/// Detect if this is an Astro project
pub(crate) fn is_astro_project(project_path: &std::path::Path) -> bool {
    // Check for astro.config.mjs, astro.config.js, or astro.config.ts
    if project_path.join("astro.config.mjs").exists()
        || project_path.join("astro.config.js").exists()
        || project_path.join("astro.config.ts").exists()
    {
        return true;
    }

    // Check package.json for astro
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"astro\"") {
                return true;
            }
        }
    }

    false
}

/// Detect if this is a Nuxt project
pub(crate) fn is_nuxt_project(project_path: &std::path::Path) -> bool {
    // Check for nuxt.config.ts or nuxt.config.js
    if project_path.join("nuxt.config.ts").exists() || project_path.join("nuxt.config.js").exists()
    {
        return true;
    }

    // Check package.json for "nuxt"
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"nuxt\"") {
                return true;
            }
        }
    }

    false
}

/// Detect if this is a Vite project (plain Vite, not a meta-framework that uses Vite)
pub(crate) fn is_vite_project(project_path: &std::path::Path) -> bool {
    // Check for vite.config.{ts,js,mjs}
    if project_path.join("vite.config.ts").exists()
        || project_path.join("vite.config.js").exists()
        || project_path.join("vite.config.mjs").exists()
    {
        return true;
    }

    // Check package.json for "vite" in dependencies or devDependencies
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"vite\"") {
                return true;
            }
        }
    }

    false
}

/// Detect if this is a React Native or Expo project.
///
/// Metro bundler config and Expo's `app.config.*` are RN/Expo-specific, so
/// their presence alone is conclusive. Otherwise we fall back to the dependency
/// list: bare React Native ships `"react-native"`, Expo ships `"expo"`. We
/// deliberately do *not* treat a lone `app.json` as conclusive — other tools
/// use that filename too — but an Expo `app.json` is always paired with the
/// `expo` dependency, so it's still caught via package.json.
pub(crate) fn is_react_native_project(project_path: &std::path::Path) -> bool {
    if project_path.join("metro.config.js").exists()
        || project_path.join("metro.config.ts").exists()
        || project_path.join("app.config.js").exists()
        || project_path.join("app.config.ts").exists()
    {
        return true;
    }

    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"react-native\"") || contents.contains("\"expo\"") {
                return true;
            }
        }
    }

    false
}

/// Detect if a React Native project is specifically an Expo app (vs. bare RN).
/// Expo apps launch with `expo run:ios`; bare RN with the React Native CLI.
pub(crate) fn is_expo_project(project_path: &std::path::Path) -> bool {
    if project_path.join("app.config.js").exists() || project_path.join("app.config.ts").exists() {
        return true;
    }
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"expo\"") {
                return true;
            }
        }
    }
    // app.json with an "expo" key is the canonical Expo marker.
    if let Ok(contents) = std::fs::read_to_string(project_path.join("app.json")) {
        if contents.contains("\"expo\"") {
            return true;
        }
    }
    false
}

/// Detect if this is a Flutter project.
///
/// A Flutter app's `pubspec.yaml` declares the Flutter SDK (`flutter:` section
/// and `sdk: flutter` dependency). A pure-Dart package omits these, so we don't
/// misclassify non-Flutter Dart packages.
pub(crate) fn is_flutter_project(project_path: &std::path::Path) -> bool {
    let pubspec = project_path.join("pubspec.yaml");
    if let Ok(contents) = std::fs::read_to_string(&pubspec) {
        if contents.contains("flutter:") || contents.contains("sdk: flutter") {
            return true;
        }
    }
    false
}

/// Detect if this is a Shopify Liquid theme (Online Store 2.0).
///
/// `layout/theme.liquid` is mandatory in every Shopify theme, and
/// `config/settings_schema.json` exists in any theme that has settings —
/// either is conclusive, and no other project type uses these paths. Checked
/// before the package.json fallbacks so a theme that carries a package.json
/// (e.g. for a Tailwind build step) isn't misclassified as Generic.
pub(crate) fn is_shopify_theme_project(project_path: &std::path::Path) -> bool {
    project_path.join("layout").join("theme.liquid").exists()
        || project_path
            .join("config")
            .join("settings_schema.json")
            .exists()
}

/// Check if a directory contains HTML files in its root
pub fn has_html_files(project_path: &std::path::Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(project_path) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".html") {
                    return true;
                }
            }
        }
    }
    false
}

/// Detect if this is a Next.js project
pub(crate) fn is_nextjs_project(project_path: &std::path::Path) -> bool {
    // Check for next.config.* files
    if project_path.join("next.config.js").exists()
        || project_path.join("next.config.ts").exists()
        || project_path.join("next.config.mjs").exists()
    {
        return true;
    }

    // Check package.json for "next" in dependencies
    let pkg_path = project_path.join("package.json");
    if pkg_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
            if contents.contains("\"next\"") {
                return true;
            }
        }
    }

    false
}

/// Detect the project type from config files and directory structure.
/// Results are cached for 30s keyed on (path, mtime-signature) so that the
/// dashboard's frequent per-tick calls don't re-hit disk for every project.
pub fn detect_project_type(project_path: &std::path::Path) -> ProjectType {
    let path_key = project_path.to_string_lossy().into_owned();
    let sig = detection_signature(project_path);
    let cache_key = (path_key, sig);
    if let Some(cached) = PROJECT_TYPE_CACHE.get(&cache_key) {
        return cached;
    }
    let result = detect_project_type_uncached(project_path);
    PROJECT_TYPE_CACHE.insert(cache_key, result.clone());
    result
}

fn detect_project_type_uncached(project_path: &std::path::Path) -> ProjectType {
    // Native mobile frameworks first — they're specific and must not be
    // mistaken for web projects that happen to share a package.json (Expo
    // apps have one). These never carry next/svelte/astro/nuxt/vite configs.
    if is_flutter_project(project_path) {
        return ProjectType::Flutter;
    }
    if is_react_native_project(project_path) {
        return ProjectType::Reactnative;
    }

    // Shopify themes next — their markers (layout/theme.liquid) are exclusive
    // to themes, and a theme may carry a package.json (Tailwind tooling) that
    // would otherwise fall through to Generic.
    if is_shopify_theme_project(project_path) {
        return ProjectType::Shopifytheme;
    }

    // Check framework-specific configs first
    if is_astro_project(project_path) {
        return ProjectType::Astro;
    }
    if is_sveltekit_project(project_path) {
        return ProjectType::Sveltekit;
    }
    if is_nuxt_project(project_path) {
        return ProjectType::Nuxt;
    }
    if is_nextjs_project(project_path) {
        return ProjectType::Nextjs;
    }

    // Check for Vite (after frameworks, since Next/Svelte/Astro/Nuxt may use Vite internally)
    if is_vite_project(project_path) {
        return ProjectType::Vite;
    }

    // Has package.json but no recognized web framework
    if project_path.join("package.json").exists() {
        return ProjectType::Generic;
    }

    // Check for HTML files in root (static HTML project)
    if has_html_files(project_path) {
        return ProjectType::Statichtml;
    }

    ProjectType::Unknown
}

/// Detect the project type for a given project path
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn detect_project_type_command(
    project_path: String,
) -> Result<ProjectType, CommandError> {
    let project = validate_project_path(&project_path)?;
    let workspace = resolve_workspace_path(&project);
    Ok(detect_project_type(&workspace))
}

/// Scan Next.js pages (app/ directory with page.tsx/js/jsx files)
pub(crate) fn scan_nextjs_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, CommandError> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('_') || dir_name.starts_with('.') || dir_name == "api" {
                continue;
            }

            let mut sub_pages = scan_nextjs_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == "page.tsx" || file_name == "page.js" || file_name == "page.jsx" {
                let parent = path.parent().unwrap_or(&path);
                let relative = parent.strip_prefix(base_dir).unwrap_or(parent);

                // Filter out route group directories (parenthesized like "(dashboard)")
                // These are for organization only and don't affect the URL path.
                // Also drop the `[locale]` segment that i18n setups (next-intl)
                // wrap all routes in — middleware redirects bare paths to the
                // active locale, so `/about` is the navigable form of
                // `app/[locale]/about/page.tsx`.
                let filtered_components: Vec<_> = relative
                    .components()
                    .filter_map(|c| {
                        if let std::path::Component::Normal(s) = c {
                            let segment = s.to_string_lossy();
                            // Skip route groups: directories starting with '(' and ending with ')'
                            if (segment.starts_with('(') && segment.ends_with(')'))
                                || segment == "[locale]"
                            {
                                None
                            } else {
                                Some(segment.to_string())
                            }
                        } else {
                            None
                        }
                    })
                    .collect();

                let route = if filtered_components.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", filtered_components.join("/"))
                };

                let display_route = route.replace('[', ":").replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Scan SvelteKit pages (src/routes/ directory with +page.svelte files)
pub(crate) fn scan_sveltekit_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden directories and SvelteKit special directories
            if dir_name.starts_with('.') {
                continue;
            }

            let mut sub_pages = scan_sveltekit_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // SvelteKit uses +page.svelte for page components
            if file_name == "+page.svelte" {
                let parent = path.parent().unwrap_or(&path);
                let relative = parent.strip_prefix(base_dir).unwrap_or(parent);

                // Filter out route group directories (parenthesized like "(marketing)")
                // These are for organization only and don't affect the URL path
                let filtered_components: Vec<_> = relative
                    .components()
                    .filter_map(|c| {
                        if let std::path::Component::Normal(s) = c {
                            let segment = s.to_string_lossy();
                            // Skip route groups: directories starting with '(' and ending with ')'
                            if segment.starts_with('(') && segment.ends_with(')') {
                                None
                            } else {
                                Some(segment.to_string())
                            }
                        } else {
                            None
                        }
                    })
                    .collect();

                let route = if filtered_components.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", filtered_components.join("/"))
                };

                // Convert SvelteKit dynamic route syntax [slug] to :slug for display
                let display_route = route.replace('[', ":").replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Scan Astro pages (src/pages/ directory with .astro files)
pub(crate) fn scan_astro_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden directories and special directories
            if dir_name.starts_with('.') || dir_name.starts_with('_') {
                continue;
            }

            let mut sub_pages = scan_astro_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Astro uses .astro, .md, and .mdx files for pages
            // index.astro maps to /
            if file_name.ends_with(".astro")
                || file_name.ends_with(".md")
                || file_name.ends_with(".mdx")
            {
                let relative = path.strip_prefix(base_dir).unwrap_or(&path);
                let relative_str = relative.to_string_lossy();

                // Convert file path to route
                let route = if file_name == "index.astro"
                    || file_name == "index.md"
                    || file_name == "index.mdx"
                {
                    // index files map to parent directory route
                    let parent = relative.parent();
                    match parent {
                        Some(p) if p.as_os_str().is_empty() => "/".to_string(),
                        Some(p) => format!("/{}", p.to_string_lossy()),
                        None => "/".to_string(),
                    }
                } else {
                    // Remove extension to get route
                    let without_ext = relative_str
                        .trim_end_matches(".astro")
                        .trim_end_matches(".mdx")
                        .trim_end_matches(".md");
                    format!("/{without_ext}")
                };

                // Convert Astro dynamic route syntax [slug] and [...slug] to :slug
                let display_route = route
                    .replace("[...", ":")
                    .replace('[', ":")
                    .replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Scan Nuxt pages (pages/ directory with .vue files)
pub(crate) fn scan_nuxt_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();

    if !dir.exists() {
        return Ok(pages);
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden directories and underscore directories
            if dir_name.starts_with('.') || dir_name.starts_with('_') {
                continue;
            }

            let mut sub_pages = scan_nuxt_pages(&path, base_dir)?;
            pages.append(&mut sub_pages);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Nuxt uses .vue files for pages
            if file_name.ends_with(".vue") {
                let relative = path.strip_prefix(base_dir).unwrap_or(&path);
                let relative_str = relative.to_string_lossy();

                // Convert file path to route
                let route = if file_name == "index.vue" {
                    // index.vue maps to parent directory route
                    let parent = relative.parent();
                    match parent {
                        Some(p) if p.as_os_str().is_empty() => "/".to_string(),
                        Some(p) => format!("/{}", p.to_string_lossy()),
                        None => "/".to_string(),
                    }
                } else {
                    // Remove .vue extension to get route
                    let without_ext = relative_str.trim_end_matches(".vue");
                    format!("/{without_ext}")
                };

                // Convert Nuxt dynamic route syntax [id] and [...slug] to :id and :slug
                let display_route = route
                    .replace("[...", ":")
                    .replace('[', ":")
                    .replace(']', "");

                pages.push(PageInfo {
                    route: display_route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(pages)
}

/// Scan for HTML files recursively and map them to routes
pub(crate) fn scan_html_pages(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
) -> Result<Vec<PageInfo>, String> {
    let mut pages = Vec::new();
    scan_html_pages_recursive(dir, base_dir, &mut pages)?;
    Ok(pages)
}

fn scan_html_pages_recursive(
    dir: &std::path::Path,
    base_dir: &std::path::Path,
    pages: &mut Vec<PageInfo>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden dirs, node_modules, .git, .shipstudio, etc.
            if dir_name.starts_with('.') || dir_name == "node_modules" {
                continue;
            }
            scan_html_pages_recursive(&path, base_dir, pages)?;
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.ends_with(".html") {
                let relative = path.strip_prefix(base_dir).unwrap_or(&path);
                let relative_str = relative.to_string_lossy();

                let route = if file_name == "index.html" {
                    let parent = relative.parent();
                    match parent {
                        Some(p) if p.as_os_str().is_empty() => "/".to_string(),
                        Some(p) => format!("/{}", p.to_string_lossy()),
                        None => "/".to_string(),
                    }
                } else {
                    // about.html -> /about
                    let without_ext = relative_str.trim_end_matches(".html");
                    format!("/{without_ext}")
                };

                pages.push(PageInfo {
                    route,
                    file_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    Ok(())
}

/// Sort pages with root first, then alphabetically.
/// The equality short-circuit keeps the comparator a total order even with
/// duplicate "/" routes (possible after `[locale]` stripping) — `sort_by`
/// may panic on non-total comparators.
pub(crate) fn sort_pages(pages: &mut [PageInfo]) {
    pages.sort_by(|a, b| {
        if a.route == b.route {
            return std::cmp::Ordering::Equal;
        }
        if a.route == "/" {
            return std::cmp::Ordering::Less;
        }
        if b.route == "/" {
            return std::cmp::Ordering::Greater;
        }
        a.route.cmp(&b.route)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn detects_nextjs_from_config_file() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("next.config.js"), "module.exports = {};").unwrap();
        assert!(is_nextjs_project(tmp.path()));
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Nextjs
        );
    }

    #[test]
    fn detects_nextjs_from_package_json() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"next":"14.0.0"}}"#,
        )
        .unwrap();
        assert!(is_nextjs_project(tmp.path()));
    }

    #[test]
    fn detects_sveltekit_from_config() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("svelte.config.js"), "export default {}").unwrap();
        assert!(is_sveltekit_project(tmp.path()));
    }

    #[test]
    fn detects_astro_precedence_over_vite() {
        // Astro projects use Vite internally — detection must prefer Astro.
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("astro.config.mjs"), "export default {};").unwrap();
        std::fs::write(tmp.path().join("vite.config.ts"), "export default {};").unwrap();
        assert_eq!(detect_project_type_uncached(tmp.path()), ProjectType::Astro);
    }

    #[test]
    fn detects_static_html_when_no_package_json() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("index.html"), "<html></html>").unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Statichtml
        );
    }

    #[test]
    fn detects_generic_when_package_json_but_no_framework() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("package.json"), r#"{"name":"x"}"#).unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Generic
        );
    }

    #[test]
    fn detects_unknown_for_empty_dir() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Unknown
        );
    }

    #[test]
    fn detects_react_native_via_dependency() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"react-native":"0.74"}}"#,
        )
        .unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Reactnative
        );
    }

    #[test]
    fn detects_expo_via_dependency() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"expo":"51"}}"#,
        )
        .unwrap();
        std::fs::write(tmp.path().join("app.json"), r#"{"expo":{"name":"x"}}"#).unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Reactnative
        );
    }

    #[test]
    fn detects_react_native_via_metro_config() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("metro.config.js"), "module.exports = {}").unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Reactnative
        );
    }

    #[test]
    fn detects_shopify_theme_via_layout() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("layout")).unwrap();
        std::fs::write(
            tmp.path().join("layout/theme.liquid"),
            "{{ content_for_layout }}",
        )
        .unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Shopifytheme
        );
    }

    #[test]
    fn detects_shopify_theme_via_settings_schema() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("config")).unwrap();
        std::fs::write(tmp.path().join("config/settings_schema.json"), "[]").unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Shopifytheme
        );
    }

    #[test]
    fn shopify_theme_with_tailwind_package_json_is_not_generic() {
        // A theme using Tailwind tooling has a package.json — the theme
        // markers must win over the Generic fallback.
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("layout")).unwrap();
        std::fs::write(tmp.path().join("layout/theme.liquid"), "").unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"devDependencies":{"tailwindcss":"4.0.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Shopifytheme
        );
    }

    #[test]
    fn detects_flutter_via_pubspec() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("pubspec.yaml"),
            "name: myapp\ndependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Flutter
        );
    }

    #[test]
    fn dart_only_package_is_not_flutter() {
        let tmp = TempDir::new().unwrap();
        // A pure-Dart package: no flutter SDK reference.
        std::fs::write(
            tmp.path().join("pubspec.yaml"),
            "name: dart_cli\ndependencies:\n  args: ^2.0.0\n",
        )
        .unwrap();
        assert_eq!(
            detect_project_type_uncached(tmp.path()),
            ProjectType::Unknown
        );
    }

    /// Integration: detect_project_type caches results. Repeated calls with
    /// the same signature must return the same value and not re-read the
    /// framework. (We verify stability; timing assertions are flaky.)
    #[test]
    fn detect_project_type_cache_returns_stable_value_within_ttl() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"next":"14"}}"#,
        )
        .unwrap();
        let first = detect_project_type(tmp.path());
        // Deleting the signal file between calls should NOT change the cached
        // answer if the mtime-signature stays the same (file is already gone
        // so the signature becomes 0 — different key → recompute → different
        // result). So instead we verify two calls in a row are equal.
        let second = detect_project_type(tmp.path());
        assert_eq!(first, second);
        assert_eq!(first, ProjectType::Nextjs);
    }

    /// The cache key includes the mtime-signature. When we modify
    /// package.json (changing its mtime), the key changes and detection
    /// re-runs. This validates we don't serve stale results after edits.
    #[test]
    fn detect_project_type_picks_up_config_changes_via_signature_key() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("package.json"), r#"{"name":"x"}"#).unwrap();
        let first = detect_project_type(tmp.path());
        assert_eq!(first, ProjectType::Generic);
        // Sleep a tiny bit to ensure mtime differs on filesystems with low
        // resolution, then rewrite to add nextjs.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"dependencies":{"next":"14"}}"#,
        )
        .unwrap();
        let second = detect_project_type(tmp.path());
        assert_eq!(second, ProjectType::Nextjs, "must re-detect after change");
    }

    #[test]
    fn nextjs_scan_strips_locale_segment() {
        // next-intl setups wrap every route in app/[locale]/ — the page
        // selector must show navigable paths, not "/:locale/...".
        let tmp = TempDir::new().unwrap();
        let app = tmp.path().join("app");
        std::fs::create_dir_all(app.join("[locale]/about")).unwrap();
        std::fs::write(app.join("[locale]/page.tsx"), "export default ...").unwrap();
        std::fs::write(app.join("[locale]/about/page.tsx"), "export default ...").unwrap();
        let mut pages = scan_nextjs_pages(&app, &app).unwrap();
        sort_pages(&mut pages);
        let routes: Vec<_> = pages.iter().map(|p| p.route.as_str()).collect();
        assert_eq!(routes, vec!["/", "/about"]);
    }

    #[test]
    fn sort_pages_total_order_with_duplicate_roots() {
        // Two "/" entries can exist after [locale] stripping (alias case);
        // the comparator must stay a total order and keep them adjacent so
        // the caller's dedup works.
        let mut pages = vec![
            PageInfo {
                route: "/".to_string(),
                file_path: "app/page.tsx".to_string(),
            },
            PageInfo {
                route: "/about".to_string(),
                file_path: "app/[locale]/about/page.tsx".to_string(),
            },
            PageInfo {
                route: "/".to_string(),
                file_path: "app/[locale]/page.tsx".to_string(),
            },
        ];
        sort_pages(&mut pages);
        assert_eq!(pages[0].route, "/");
        assert_eq!(pages[1].route, "/");
        assert_eq!(pages[2].route, "/about");
    }

    #[test]
    fn sort_pages_puts_root_first() {
        let mut pages = vec![
            PageInfo {
                route: "/about".to_string(),
                file_path: "about.tsx".to_string(),
            },
            PageInfo {
                route: "/".to_string(),
                file_path: "index.tsx".to_string(),
            },
            PageInfo {
                route: "/blog".to_string(),
                file_path: "blog.tsx".to_string(),
            },
        ];
        sort_pages(&mut pages);
        assert_eq!(pages[0].route, "/");
        assert_eq!(pages[1].route, "/about");
        assert_eq!(pages[2].route, "/blog");
    }

    #[test]
    fn has_html_files_detects_top_level_html() {
        let tmp = TempDir::new().unwrap();
        assert!(!has_html_files(tmp.path()));
        std::fs::write(tmp.path().join("index.html"), "").unwrap();
        assert!(has_html_files(tmp.path()));
    }
}
