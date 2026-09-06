//! # Browser discovery
//!
//! Finds installed browsers by reading what each app declares in its
//! `Contents/Info.plist`, the same source Launch Services builds the system's
//! "Open With" menu from. Replaces a hardcoded list that made every browser
//! outside {Safari, Chrome, Firefox, Arc, Brave, Edge} invisible.
//!
//! Windows has no equivalent per-app manifest and keeps a curated list.

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::BrowserInfo;
use crate::utils::create_command;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{debug, warn};

#[cfg(target_os = "macos")]
use base64::Engine;
#[cfg(target_os = "macos")]
use std::path::Path;

/// Short enough that a browser installed mid-session still shows up.
const DISCOVERY_TTL: Duration = Duration::from_secs(300);

#[cfg(target_os = "macos")]
const PLUTIL_TIMEOUT_SECS: u64 = 5;

/// The dropdown's 14px slot at 4x, for Retina, at ~5-7KB per icon.
#[cfg(target_os = "macos")]
const ICON_PX: u32 = 64;

/// The path stays backend-side: `open_url_in_browser` re-resolves it from the
/// discovered set, so a frontend-supplied id can't become an arbitrary launch.
#[derive(Clone)]
struct Browser {
    id: String,
    name: String,
    icon: Option<String>,
    path: PathBuf,
}

impl Browser {
    fn to_info(&self) -> BrowserInfo {
        BrowserInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
        }
    }
}

static CACHE: LazyLock<Mutex<Option<(Instant, Vec<Browser>)>>> = LazyLock::new(|| Mutex::new(None));

fn cached() -> Option<Vec<Browser>> {
    let guard = CACHE.lock().ok()?;
    let (stored_at, browsers) = guard.as_ref()?;
    if stored_at.elapsed() >= DISCOVERY_TTL {
        return None;
    }
    debug!(count = browsers.len(), "browser discovery cache hit");
    Some(browsers.clone())
}

fn store(browsers: &[Browser]) {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), browsers.to_vec()));
    }
}

async fn discover() -> Vec<Browser> {
    if let Some(hit) = cached() {
        return hit;
    }
    let found = scan().await;
    debug!(count = found.len(), "browser discovery completed");
    store(&found);
    found
}

// ============ macOS ============

/// Per-user and Setapp installs live outside `/Applications`. Missing roots are
/// skipped silently.
#[cfg(target_os = "macos")]
fn app_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/Applications/Setapp"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

#[cfg(target_os = "macos")]
async fn scan() -> Vec<Browser> {
    let mut bundles: Vec<PathBuf> = Vec::new();
    for root in app_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "app") {
                bundles.push(path);
            }
        }
    }
    bundles.sort();
    bundles.dedup();

    // Sequential on purpose: spawning one `plutil` per app all at once is the
    // process-table pressure behind the EAGAIN spawn failures in #585/#616.
    let mut browsers: Vec<Browser> = Vec::new();
    for bundle in bundles {
        if let Some(browser) = inspect_bundle(&bundle).await {
            browsers.push(browser);
        }
    }

    browsers.sort_by_key(|b| b.name.to_lowercase());
    browsers.dedup_by(|a, b| a.id == b.id);
    browsers
}

#[cfg(target_os = "macos")]
async fn inspect_bundle(bundle: &Path) -> Option<Browser> {
    let plist_path = bundle.join("Contents/Info.plist");
    let raw = std::fs::read(&plist_path).ok()?;

    // A browser's plist necessarily contains the literal "https", and binary
    // plists store short ASCII strings as ASCII, so this drops no real browser
    // while sparing a subprocess for most apps.
    if !raw.windows(5).any(|w| w == b"https") {
        return None;
    }

    let plist = plist_to_json(&plist_path).await?;
    if !declares_web_browsing(&plist) {
        return None;
    }

    let name = display_name(&plist, bundle);
    let id = plist
        .get("CFBundleIdentifier")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| bundle.to_string_lossy().into_owned());

    Some(Browser {
        icon: extract_icon(bundle, &plist).await,
        id,
        name,
        path: bundle.to_path_buf(),
    })
}

/// Info.plist is usually a binary plist; `plutil` is the converter macOS ships,
/// which avoids taking on a plist-parsing dependency.
#[cfg(target_os = "macos")]
async fn plist_to_json(path: &Path) -> Option<serde_json::Value> {
    let mut cmd = create_command("/usr/bin/plutil");
    cmd.args(["-convert", "json", "-o", "-", "--"]);
    cmd.arg(path);

    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "plutil Info.plist",
        PLUTIL_TIMEOUT_SECS,
    )
    .await
    .map_err(|e| debug!(plist = %path.display(), error = %e, "plutil failed"))
    .ok()?;

    if !output.status.success() {
        debug!(plist = %path.display(), "plutil reported a malformed plist");
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Every lowercased URL scheme the bundle claims.
#[cfg(target_os = "macos")]
fn url_schemes(plist: &serde_json::Value) -> Vec<String> {
    plist
        .get("CFBundleURLTypes")
        .and_then(|v| v.as_array())
        .map(|types| {
            types
                .iter()
                .filter_map(|t| t.get("CFBundleURLSchemes")?.as_array())
                .flatten()
                .filter_map(|s| s.as_str())
                .map(str::to_lowercase)
                .collect()
        })
        .unwrap_or_default()
}

/// Browsers split between the modern UTI (Chrome) and the legacy extension list
/// (Safari, Zen), so both count.
#[cfg(target_os = "macos")]
fn opens_html(plist: &serde_json::Value) -> bool {
    let Some(types) = plist
        .get("CFBundleDocumentTypes")
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    types.iter().any(|t| {
        let by_uti = t
            .get("LSItemContentTypes")
            .and_then(|v| v.as_array())
            .is_some_and(|utis| {
                utis.iter()
                    .filter_map(|u| u.as_str())
                    .any(|u| u.eq_ignore_ascii_case("public.html"))
            });
        let by_extension = t
            .get("CFBundleTypeExtensions")
            .and_then(|v| v.as_array())
            .is_some_and(|exts| {
                exts.iter()
                    .filter_map(|e| e.as_str())
                    .any(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
            });
        by_uti || by_extension
    })
}

/// Both signals are required: apps that speak http without rendering HTML are
/// not browsers (Cyberduck registers `http` for WebDAV).
#[cfg(target_os = "macos")]
fn declares_web_browsing(plist: &serde_json::Value) -> bool {
    let schemes = url_schemes(plist);
    let claims_web = schemes.iter().any(|s| s == "http") && schemes.iter().any(|s| s == "https");
    claims_web && opens_html(plist)
}

/// The name the user sees in Finder.
#[cfg(target_os = "macos")]
fn display_name(plist: &serde_json::Value, bundle: &Path) -> String {
    for key in ["CFBundleDisplayName", "CFBundleName"] {
        if let Some(name) = plist.get(key).and_then(|v| v.as_str()) {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    bundle
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Browser".to_string())
}

/// `CFBundleIconFile` may omit the extension (Safari) and may not be named
/// AppIcon (Zen ships `firefox.icns`), hence the fallbacks.
#[cfg(target_os = "macos")]
fn resolve_icns(bundle: &Path, plist: &serde_json::Value) -> Option<PathBuf> {
    let resources = bundle.join("Contents/Resources");

    if let Some(declared) = plist.get("CFBundleIconFile").and_then(|v| v.as_str()) {
        let name = if declared.to_lowercase().ends_with(".icns") {
            declared.to_string()
        } else {
            format!("{declared}.icns")
        };
        let candidate = resources.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let default = resources.join("AppIcon.icns");
    if default.is_file() {
        return Some(default);
    }

    std::fs::read_dir(&resources)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("icns"))
        })
}

/// `sips` writes to a file rather than stdout, so the PNG round-trips through a
/// temp file that is removed either way.
#[cfg(target_os = "macos")]
async fn extract_icon(bundle: &Path, plist: &serde_json::Value) -> Option<String> {
    let icns = resolve_icns(bundle, plist)?;
    let png = std::env::temp_dir().join(format!(
        "shipstudio-browser-icon-{}.png",
        uuid::Uuid::new_v4()
    ));

    let mut cmd = create_command("/usr/bin/sips");
    cmd.args(["-s", "format", "png", "-Z", &ICON_PX.to_string()]);
    cmd.arg(&icns).arg("--out").arg(&png);

    let result = run_with_timeout(
        tokio::process::Command::from(cmd),
        "sips app icon",
        PLUTIL_TIMEOUT_SECS,
    )
    .await;

    let encoded = match result {
        Ok(output) if output.status.success() => std::fs::read(&png)
            .ok()
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        Ok(_) => {
            debug!(icon = %icns.display(), "sips could not convert this icon");
            None
        }
        Err(e) => {
            debug!(icon = %icns.display(), error = %e, "sips failed");
            None
        }
    };

    let _ = std::fs::remove_file(&png);
    encoded.map(|data| format!("data:image/png;base64,{data}"))
}

// ============ Windows ============

/// Curated list, since Windows has no per-app manifest to interrogate.
/// Tuple: (display name, path relative to Program Files / LocalAppData).
#[cfg(target_os = "windows")]
const WINDOWS_BROWSERS: &[(&str, &str)] = &[
    ("Google Chrome", r"Google\Chrome\Application\chrome.exe"),
    ("Microsoft Edge", r"Microsoft\Edge\Application\msedge.exe"),
    (
        "Brave",
        r"BraveSoftware\Brave-Browser\Application\brave.exe",
    ),
    ("Firefox", r"Mozilla Firefox\firefox.exe"),
    (
        "Firefox Developer Edition",
        r"Firefox Developer Edition\firefox.exe",
    ),
    ("Zen", r"Zen Browser\zen.exe"),
    ("Helium", r"Helium\Application\helium.exe"),
    ("Opera", r"Opera\opera.exe"),
    ("Opera GX", r"Opera GX\opera.exe"),
    ("Vivaldi", r"Vivaldi\Application\vivaldi.exe"),
    ("Arc", r"Arc\Application\arc.exe"),
    ("Chromium", r"Chromium\Application\chrome.exe"),
    ("LibreWolf", r"LibreWolf\librewolf.exe"),
    ("Waterfox", r"Waterfox\waterfox.exe"),
    ("Floorp", r"Floorp\floorp.exe"),
    ("Tor Browser", r"Tor Browser\Browser\firefox.exe"),
    ("Yandex", r"Yandex\YandexBrowser\Application\browser.exe"),
];

#[cfg(target_os = "windows")]
async fn scan() -> Vec<Browser> {
    let mut browsers: Vec<Browser> = WINDOWS_BROWSERS
        .iter()
        .filter_map(|(name, relative_path)| {
            let path = super::find_windows_browser(relative_path)?;
            Some(Browser {
                id: path.to_string_lossy().into_owned(),
                name: (*name).to_string(),
                icon: None,
                path,
            })
        })
        .collect();

    browsers.sort_by_key(|b| b.name.to_lowercase());
    browsers.dedup_by(|a, b| a.id == b.id);
    browsers
}

// ============ Other platforms ============

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn scan() -> Vec<Browser> {
    Vec::new()
}

// ============ Commands ============

/// Check which browsers are available on the system. Returns an empty list
/// rather than an error, so the dropdown degrades to a plain "Open" button.
#[tauri::command]
#[tracing::instrument]
pub async fn check_browser_availability() -> Vec<BrowserInfo> {
    discover().await.iter().map(Browser::to_info).collect()
}

/// Open a URL in a specific browser. The id is resolved against the discovered
/// set, so the path always originates here rather than with the caller.
#[tauri::command]
#[tracing::instrument]
pub async fn open_url_in_browser(url: String, browser_id: String) -> Result<(), CommandError> {
    let parsed: url::Url = url
        .parse()
        .map_err(|_| CommandError::expected(format!("Not a valid URL: {url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::expected(format!(
            "Only http and https URLs can be opened in a browser (got \"{}\")",
            parsed.scheme()
        )));
    }

    let browsers = discover().await;
    let Some(browser) = browsers.iter().find(|b| b.id == browser_id) else {
        warn!(browser_id, "requested browser is no longer installed");
        return Err(CommandError::expected(format!(
            "That browser isn't available anymore ({browser_id}). It may have been moved or uninstalled."
        )));
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        // Launch Services reuses a running instance instead of starting a second.
        let mut cmd = create_command("open");
        cmd.arg("-a").arg(&browser.path).arg(&url);
        cmd
    };

    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut cmd = create_command(&browser.path);
        cmd.arg(&url);
        cmd
    };

    // Retried on transient EAGAIN (process-table pressure) and classified
    // Expected when it persists — a bare "Resource temporarily unavailable
    // (os error 35)" was reaching telemetry as an app malfunction (issue #585).
    crate::external_command::spawn_with_pressure_retry(&format!("open {}", browser.name), || {
        cmd.spawn()
    })?;

    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_claiming_http_https_and_html_uti_is_detected() {
        // Shape of Chrome's and Helium's declarations.
        let plist = json!({
            "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["http", "https"] }],
            "CFBundleDocumentTypes": [{ "LSItemContentTypes": ["public.html", "public.xhtml"] }],
        });
        assert!(declares_web_browsing(&plist));
    }

    #[test]
    fn browser_declaring_html_by_extension_is_detected() {
        // Shape of Safari's and Zen's declarations — legacy extension list, no UTI.
        let plist = json!({
            "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["http", "https", "ftp"] }],
            "CFBundleDocumentTypes": [{ "CFBundleTypeExtensions": ["html", "htm", "shtml"] }],
        });
        assert!(declares_web_browsing(&plist));
    }

    #[test]
    fn http_only_utility_without_html_is_rejected() {
        // Shape of Cyberduck: registers http for WebDAV but renders no HTML.
        let plist = json!({
            "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["http", "ftp", "sftp"] }],
            "CFBundleDocumentTypes": [{ "CFBundleTypeExtensions": ["duck"] }],
        });
        assert!(!declares_web_browsing(&plist));
    }

    #[test]
    fn html_viewer_without_web_schemes_is_rejected() {
        // An editor that opens .html files is not somewhere to send a dev server URL.
        let plist = json!({
            "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["vscode"] }],
            "CFBundleDocumentTypes": [{ "CFBundleTypeExtensions": ["html", "css", "js"] }],
        });
        assert!(!declares_web_browsing(&plist));
    }

    #[test]
    fn schemes_are_matched_case_insensitively() {
        let plist = json!({
            "CFBundleURLTypes": [{ "CFBundleURLSchemes": ["HTTP", "HTTPS"] }],
            "CFBundleDocumentTypes": [{ "LSItemContentTypes": ["public.html"] }],
        });
        assert!(declares_web_browsing(&plist));
    }

    #[test]
    fn plist_without_declarations_is_rejected() {
        assert!(!declares_web_browsing(&json!({})));
    }

    #[test]
    fn display_name_prefers_declared_name_over_folder() {
        let bundle = Path::new("/Applications/Brave Browser.app");
        let plist = json!({ "CFBundleDisplayName": "Brave" });
        assert_eq!(display_name(&plist, bundle), "Brave");
    }

    #[test]
    fn display_name_falls_back_to_bundle_name_then_folder() {
        let bundle = Path::new("/Applications/Zen.app");
        assert_eq!(
            display_name(&json!({ "CFBundleName": "Zen" }), bundle),
            "Zen"
        );
        assert_eq!(display_name(&json!({}), bundle), "Zen");
        // A blank declared name must not win over the folder name.
        assert_eq!(
            display_name(&json!({ "CFBundleDisplayName": "  " }), bundle),
            "Zen"
        );
    }
}
