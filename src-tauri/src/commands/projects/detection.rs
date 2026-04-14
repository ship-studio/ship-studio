//! Project type detection and page scanning.
//!
//! Detects framework types (Next.js, SvelteKit, Astro, Nuxt, static HTML)
//! and scans project directories for page routes.

use crate::errors::CommandError;
use crate::types::{PageInfo, ProjectType};
use crate::utils::validate_project_path;

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

/// Detect the project type from config files and directory structure
pub fn detect_project_type(project_path: &std::path::Path) -> ProjectType {
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
    Ok(detect_project_type(&project))
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

/// Sort pages with root first, then alphabetically
pub(crate) fn sort_pages(pages: &mut [PageInfo]) {
    pages.sort_by(|a, b| {
        if a.route == "/" {
            return std::cmp::Ordering::Less;
        }
        if b.route == "/" {
            return std::cmp::Ordering::Greater;
        }
        a.route.cmp(&b.route)
    });
}
