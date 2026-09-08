//! # IDE, Browser, and Webview Commands
//!
//! Commands for IDE integration, browser selection, preview webviews, and screenshots.
//!
//! Organized into submodules:
//! - `preview` — preview webview creation, navigation, resize, scroll, and JS evaluation
//! - `screenshots` — project thumbnails, Playwright captures, image comparison, cropping, and stitching

mod preview;
mod screenshots;

pub use preview::*;
pub use screenshots::*;

use crate::errors::CommandError;
use crate::types::{BrowserInfo, IdeAvailability};
use crate::utils::{create_command, validate_project_path};
use ship_studio_macros::ship_command;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl};

/// Browser configurations for macOS
/// Tuple: (id, display_name, app_path)
#[cfg(target_os = "macos")]
const MACOS_BROWSERS: &[(&str, &str, &str)] = &[
    ("safari", "Safari", "/Applications/Safari.app"),
    ("chrome", "Google Chrome", "/Applications/Google Chrome.app"),
    ("firefox", "Firefox", "/Applications/Firefox.app"),
    ("arc", "Arc", "/Applications/Arc.app"),
    ("brave", "Brave", "/Applications/Brave Browser.app"),
    ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app"),
];

/// Browser configurations for Windows
/// Tuple: (id, display_name, registry_or_path_hint)
#[cfg(target_os = "windows")]
const WINDOWS_BROWSERS: &[(&str, &str, &str)] = &[
    (
        "chrome",
        "Google Chrome",
        r"Google\Chrome\Application\chrome.exe",
    ),
    (
        "edge",
        "Microsoft Edge",
        r"Microsoft\Edge\Application\msedge.exe",
    ),
    (
        "brave",
        "Brave",
        r"BraveSoftware\Brave-Browser\Application\brave.exe",
    ),
    ("firefox", "Firefox", r"Mozilla Firefox\firefox.exe"),
];

/// Browser configurations for Linux
/// Tuple: (id, display_name, accepted executable names)
///
/// Resolved through `PATH` rather than fixed prefixes: distros and packaging
/// formats disagree on the binary name for the same browser (`chromium` on
/// Debian/Arch, `chromium-browser` on Ubuntu and snap builds), and a Flatpak
/// install lands somewhere else entirely. Each entry therefore carries every
/// name we're willing to accept, most canonical first.
///
/// Chromium leads the list because it's the engine the preview is developed
/// against and the one most likely to already be present on a dev box.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LINUX_BROWSERS: &[(&str, &str, &[&str])] = &[
    ("chromium", "Chromium", &["chromium", "chromium-browser"]),
    (
        "chrome",
        "Google Chrome",
        &["google-chrome", "google-chrome-stable"],
    ),
    ("firefox", "Firefox", &["firefox"]),
    ("brave", "Brave", &["brave-browser", "brave"]),
    (
        "edge",
        "Microsoft Edge",
        &["microsoft-edge", "microsoft-edge-stable"],
    ),
];

/// Resolve the first available executable name for a Linux browser entry.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn find_linux_browser(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().find_map(|name| which::which(name).ok())
}

/// Find a browser executable on Windows by checking common install locations.
#[cfg(target_os = "windows")]
fn find_windows_browser(relative_path: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = [
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
        std::env::var("LOCALAPPDATA").ok(),
    ]
    .iter()
    .filter_map(|base| base.as_ref().map(|b| PathBuf::from(b).join(relative_path)))
    .collect();

    candidates.into_iter().find(|p| p.exists())
}

/// Find a Chromium-based browser for headless screenshots (cross-platform).
pub(crate) fn find_chromium_browser() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mac_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        mac_paths.iter().map(PathBuf::from).find(|p| p.exists())
    }

    #[cfg(target_os = "windows")]
    {
        let chromium_hints = [
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
        ];
        chromium_hints
            .iter()
            .find_map(|hint| find_windows_browser(hint))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: check PATH
        which::which("google-chrome")
            .or_else(|_| which::which("chromium"))
            .or_else(|_| which::which("microsoft-edge"))
            .ok()
    }
}

/// Resize a PNG image to the given width (preserving aspect ratio) using the `image` crate.
pub(crate) fn resize_thumbnail_image(path: &Path, target_width: u32) {
    if let Ok(img) = image::open(path) {
        if img.width() > target_width {
            let aspect = img.height() as f64 / img.width() as f64;
            let target_height = (target_width as f64 * aspect) as u32;
            let resized = img.resize(
                target_width,
                target_height,
                image::imageops::FilterType::Lanczos3,
            );
            let _ = resized.save(path);
        }
    }
}

#[ship_command]
#[tracing::instrument]
pub async fn check_ide_availability() -> IdeAvailability {
    #[cfg(target_os = "macos")]
    {
        // Check if apps exist in /Applications
        let vscode = std::path::Path::new("/Applications/Visual Studio Code.app").exists();
        let cursor = std::path::Path::new("/Applications/Cursor.app").exists();
        IdeAvailability { vscode, cursor }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Check if commands are in PATH
        let vscode = which::which("code").is_ok();
        let cursor = which::which("cursor").is_ok();
        IdeAvailability { vscode, cursor }
    }
}

#[ship_command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn open_in_ide(
    project_path: String,
    ide: String,
    file_path: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // If a file path is provided, validate it's within the project
    let target_path = if let Some(ref fp) = file_path {
        if fp.contains("..") {
            return Err(("Invalid path: path traversal not allowed".to_string()).into());
        }
        let full = validated_path.join(fp);
        let canonical = dunce::canonicalize(&full).map_err(|e| format!("File not found: {e}"))?;
        if !canonical.starts_with(&validated_path) {
            return Err(("Security error: path is outside project directory".to_string()).into());
        }
        canonical.to_string_lossy().to_string()
    } else {
        validated_path.to_string_lossy().to_string()
    };

    #[cfg(target_os = "macos")]
    {
        let app_name = match ide.as_str() {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            _ => return Err((format!("Unknown IDE: {ide}")).into()),
        };

        // Use 'open -a' on macOS which is more reliable
        create_command("open")
            .args(["-a", app_name, &target_path])
            .spawn()
            .map_err(|e| format!("Failed to open in {ide}: {e}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let cmd = match ide.as_str() {
            "vscode" => "code",
            "cursor" => "cursor",
            _ => return Err((format!("Unknown IDE: {}", ide)).into()),
        };

        create_command(cmd)
            .arg(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", ide, e))?;
    }

    Ok(())
}

/// Check which browsers are available on the system
#[ship_command]
#[tracing::instrument]
pub async fn check_browser_availability() -> Vec<BrowserInfo> {
    #[cfg(target_os = "macos")]
    {
        MACOS_BROWSERS
            .iter()
            .filter_map(|(id, name, path)| {
                if std::path::Path::new(path).exists() {
                    Some(BrowserInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    #[cfg(target_os = "windows")]
    {
        WINDOWS_BROWSERS
            .iter()
            .filter_map(|(id, name, relative_path)| {
                if find_windows_browser(relative_path).is_some() {
                    Some(BrowserInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        LINUX_BROWSERS
            .iter()
            .filter_map(|(id, name, candidates)| {
                find_linux_browser(candidates).map(|_| BrowserInfo {
                    id: id.to_string(),
                    name: name.to_string(),
                })
            })
            .collect()
    }
}

/// Open a URL in a specific browser
#[ship_command]
#[tracing::instrument]
pub async fn open_url_in_browser(url: String, browser_id: String) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let app_name = MACOS_BROWSERS
            .iter()
            .find(|(id, _, _)| *id == browser_id)
            .map(|(_, name, _)| *name)
            .ok_or_else(|| format!("Unknown browser: {browser_id}"))?;

        create_command("open")
            .args(["-a", app_name, &url])
            .spawn()
            .map_err(|e| format!("Failed to open in {browser_id}: {e}"))?;

        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let relative_path = WINDOWS_BROWSERS
            .iter()
            .find(|(id, _, _)| *id == browser_id)
            .map(|(_, _, path)| *path)
            .ok_or_else(|| format!("Unknown browser: {}", browser_id))?;

        let browser_exe = find_windows_browser(relative_path)
            .ok_or_else(|| format!("Browser not found: {}", browser_id))?;

        create_command(browser_exe)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open in {}: {}", browser_id, e))?;

        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let candidates = LINUX_BROWSERS
            .iter()
            .find(|(id, _, _)| *id == browser_id)
            .map(|(_, _, candidates)| *candidates)
            .ok_or_else(|| format!("Unknown browser: {browser_id}"))?;

        // Re-resolve rather than trusting the id: the browser may have been
        // uninstalled since `check_browser_availability` populated the picker.
        let exe = find_linux_browser(candidates)
            .ok_or_else(|| format!("Browser not found: {browser_id}"))?;

        create_command(exe)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open in {browser_id}: {e}"))?;

        Ok(())
    }
}

#[ship_command]
#[tracing::instrument(skip(app))]
pub async fn open_studio_window(
    app: tauri::AppHandle,
    url: String,
    title: String,
) -> Result<(), CommandError> {
    use tauri::WebviewWindowBuilder;

    // Check if studio window already exists
    if let Some(window) = app.get_webview_window("studio") {
        // Focus existing window and navigate to URL
        window.set_focus().map_err(|e| e.to_string())?;
        let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
        window.navigate(parsed_url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new studio window
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    WebviewWindowBuilder::new(&app, "studio", WebviewUrl::External(parsed_url))
        .title(&title)
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create studio window: {e}"))?;

    Ok(())
}

#[cfg(all(test, not(any(target_os = "macos", target_os = "windows"))))]
mod linux_browser_tests {
    use super::*;

    #[test]
    fn every_entry_is_well_formed() {
        for (id, name, candidates) in LINUX_BROWSERS {
            assert!(!id.is_empty(), "browser id must not be empty");
            assert!(!name.is_empty(), "browser {id} needs a display name");
            assert!(
                !candidates.is_empty(),
                "browser {id} needs at least one executable name to look for"
            );
        }
    }

    #[test]
    fn ids_are_unique() {
        // `open_url_in_browser` resolves by id with `find`, so a duplicate id
        // would make one entry permanently unreachable.
        let mut ids: Vec<&str> = LINUX_BROWSERS.iter().map(|(id, _, _)| *id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate browser id in LINUX_BROWSERS");
    }

    #[test]
    fn chromium_is_offered_first() {
        // The preview is developed against Chromium; it should be the default
        // pick when several browsers are installed.
        assert_eq!(LINUX_BROWSERS[0].0, "chromium");
    }

    #[test]
    fn resolution_finds_a_binary_on_path() {
        // Proves the PATH lookup itself works without requiring a browser on
        // the machine (CI runners and headless servers have none). `sh` is
        // guaranteed present on any POSIX system.
        assert!(
            find_linux_browser(&["definitely-not-a-real-browser-xyz", "sh"]).is_some(),
            "should fall through to the second candidate and resolve it"
        );
    }

    #[test]
    fn resolution_returns_none_when_nothing_matches() {
        assert!(find_linux_browser(&["definitely-not-a-real-browser-xyz"]).is_none());
    }
}
