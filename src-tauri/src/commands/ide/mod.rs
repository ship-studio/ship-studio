//! # IDE, Browser, and Webview Commands
//!
//! Commands for IDE integration, browser selection, preview webviews, and screenshots.
//!
//! Organized into submodules:
//! - `browsers` — discovery of installed browsers and opening URLs in a chosen one
//! - `preview` — preview webview creation, navigation, resize, scroll, and JS evaluation
//! - `screenshots` — project thumbnails, Playwright captures, image comparison, cropping, and stitching

mod browsers;
mod preview;
mod screenshots;

pub use browsers::*;
pub use preview::*;
pub use screenshots::*;

use crate::errors::CommandError;
use crate::types::IdeAvailability;
use crate::utils::{create_command, validate_project_path};
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl};

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
        // Brave and Arc are Chromium-based and drive the same --headless=new
        // screenshot flags; the Windows list below already includes Brave. A
        // user with only Brave/Arc installed had no working thumbnail fallback
        // (issues #262/#263). Per-user ~/Applications installs count too.
        let mac_paths = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Arc.app/Contents/MacOS/Arc",
        ];
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
        roots
            .iter()
            .flat_map(|root| mac_paths.iter().map(move |p| root.join(p)))
            .find(|p| p.exists())
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

#[tauri::command]
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

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn open_in_ide(
    project_path: String,
    ide: String,
    file_path: Option<String>,
) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // If a file path is provided, validate it's within the project
    let target_path = if let Some(ref fp) = file_path {
        if crate::utils::has_parent_dir_component(fp) {
            return Err(("Invalid path: path traversal not allowed".to_string()).into());
        }
        let full = validated_path.join(fp);
        let canonical =
            dunce::canonicalize(&full).map_err(|e| crate::commands::code::resolve_error(fp, &e))?;
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

        // Use 'open -a' on macOS which is more reliable. Retried on transient
        // EAGAIN and labeled so a spawn failure is attributable (issue #585).
        let mut cmd = create_command("open");
        cmd.args(["-a", app_name, &target_path]);
        crate::external_command::spawn_with_pressure_retry(&format!("open {ide}"), || cmd.spawn())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let cmd = match ide.as_str() {
            "vscode" => "code",
            "cursor" => "cursor",
            _ => return Err((format!("Unknown IDE: {}", ide)).into()),
        };

        // Resolve the CLI to a full path first: spawning the bare name on
        // Windows misses .cmd shims (VS Code's `code` IS one) and fails with
        // a context-free "program not found" even when the IDE is installed —
        // same class as the git fix in #296/#297 (issue #462).
        let Some(resolved) = crate::utils::find_executable(cmd) else {
            let ide_name = if ide == "vscode" { "VS Code" } else { "Cursor" };
            let hint = if ide == "vscode" {
                " In VS Code, run \"Shell Command: Install 'code' command in PATH\" from the command palette, or reinstall with the CLI option enabled."
            } else {
                " In Cursor, install its shell command from the command palette."
            };
            return Err(crate::errors::CommandError::expected(format!(
                "{ide_name}'s command-line launcher ('{cmd}') isn't on your PATH, so Ship Studio can't open the project in it.{hint}"
            )));
        };

        let mut launch = create_command(&resolved);
        launch.arg(&target_path);
        crate::external_command::spawn_with_pressure_retry(&format!("open {ide}"), || {
            launch.spawn()
        })?;
    }

    Ok(())
}

#[tauri::command]
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
