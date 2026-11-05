//! Quick entry: a system-wide shortcut (⌥Space by default) that opens a small
//! floating composer over whatever app is in front, addressed to the Chief of
//! Staff (or any agent, with @name). Send queues the message and closes it.
//!
//! - The window is created hidden at launch, so the shortcut only shows it:
//!   no webview boots on the keystroke.
//! - The shortcut is released while one of Ship Studio's own windows is in
//!   front (the app's composer is right there, and ⌥Space is its
//!   hold-to-dictate key), and taken again when they lose focus.
//! - Closing hands focus back to the app that had it, if it wasn't us.
//! - "Attach screenshot" hides the composer and runs macOS's own
//!   `screencapture -i` (drag to select; Space to pick a window). macOS asks
//!   for Screen Recording permission the first time.
//!
//! Off by default unless "Keep running when closed" is on, like the menu-bar
//! icon: a global shortcut takes ⌥Space (a non-breaking space in most text
//! fields) from every other app, which nobody should find done without asking.
//!
//! Full design: docs/agents.md, "Menu bar, quit guard and quick entry".

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::errors::CommandError;

pub const LABEL: &str = "quick-entry";
/// Sent to the composer each time it is shown: reset, refocus, refetch.
pub const EVENT_SHOWN: &str = "quick-entry://shown";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
const WIDTH: f64 = 600.0;
const HEIGHT: f64 = 168.0;

/// Ship Studio wasn't in front when the composer opened: give focus back on close.
static RETURN_FOCUS: AtomicBool = AtomicBool::new(false);
/// A screenshot selection is in progress; the composer's blur must not close it.
static CAPTURING: AtomicBool = AtomicBool::new(false);
/// The accelerator registered with the OS, if any.
static REGISTERED: Mutex<Option<String>> = Mutex::new(None);
/// One of Ship Studio's own windows has focus: the shortcut is released.
static IN_APP: AtomicBool = AtomicBool::new(false);
/// Sent: the confirmation stays up briefly without focus; losing focus mustn't close it.
static LINGERING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/// A shortcut as stored (`Ctrl+Alt+Shift+Cmd+<KeyboardEvent.code>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accelerator {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub cmd: bool,
    /// A `KeyboardEvent.code`: `Space`, `KeyK`, `Digit1`, `F5`, `Comma`…
    pub key: String,
}

const PUNCTUATION: [(&str, &str); 11] = [
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
    ("Semicolon", ";"),
    ("Quote", "'"),
    ("BracketLeft", "["),
    ("BracketRight", "]"),
    ("Backslash", "\\"),
    ("Minus", "-"),
    ("Equal", "="),
    ("Backquote", "`"),
];

impl Accelerator {
    pub fn parse(text: &str) -> Option<Self> {
        let mut acc = Accelerator {
            ctrl: false,
            alt: false,
            shift: false,
            cmd: false,
            key: String::new(),
        };
        for part in text.split('+').map(str::trim) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => acc.ctrl = true,
                "alt" | "option" => acc.alt = true,
                "shift" => acc.shift = true,
                "cmd" | "command" | "super" | "meta" => acc.cmd = true,
                _ if acc.key.is_empty() && key_label(part).is_some() => acc.key = part.into(),
                _ => return None,
            }
        }
        (!acc.key.is_empty()).then_some(acc)
    }

    /// What we store and what `global-hotkey` parses.
    pub fn canonical(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for (on, name) in [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.cmd, "Super"),
        ] {
            if on {
                parts.push(name);
            }
        }
        parts.push(&self.key);
        parts.join("+")
    }

    /// As macOS menus write it: ⌃⌥⇧⌘ then the key.
    pub fn label(&self) -> String {
        let mut out = String::new();
        for (on, sym) in [
            (self.ctrl, '⌃'),
            (self.alt, '⌥'),
            (self.shift, '⇧'),
            (self.cmd, '⌘'),
        ] {
            if on {
                out.push(sym);
            }
        }
        out + &key_label(&self.key).unwrap_or_default()
    }

    /// Why this can't be the shortcut, if it can't. Covers what we can know:
    /// shortcuts macOS keeps for itself, and ⌘-letter shortcuts every app uses.
    /// Another app's own global shortcut can only be found by trying
    /// ([`register`] says so when the system refuses).
    pub fn conflict(&self) -> Option<String> {
        let label = self.label();
        if !(self.ctrl || self.alt || self.cmd) {
            return Some("Use ⌃, ⌥ or ⌘ with a key, so typing never opens it.".into());
        }
        let system = match (self.ctrl, self.alt, self.shift, self.cmd, self.key.as_str()) {
            (false, false, false, true, "Space") => Some("Spotlight"),
            (false, true, false, true, "Space") => Some("Finder search"),
            (true, false, false, false, "Space") | (true, true, false, false, "Space") => {
                Some("switching input sources")
            }
            (true, false, false, true, "Space") => Some("the emoji picker"),
            (false, false, true, true, "Digit3" | "Digit4" | "Digit5") => Some("screenshots"),
            (false, false, false, true, "Tab" | "Backquote") => Some("switching apps and windows"),
            (false, true, false, true, "Escape") => Some("Force Quit"),
            (true, false, false, true, "KeyQ") => Some("locking the screen"),
            (true, false, false, true, "KeyF") => Some("full screen"),
            _ => None,
        };
        if let Some(what) = system {
            return Some(format!("{label} is macOS's shortcut for {what}."));
        }
        if self.cmd && !self.ctrl && !self.alt && !self.shift {
            return Some(format!(
                "{label} is used inside most apps. Add ⌥ or ⌃ to make it unique."
            ));
        }
        None
    }
}

fn key_label(code: &str) -> Option<String> {
    if code == "Space" {
        return Some("Space".into());
    }
    if let Some(letter) = code.strip_prefix("Key") {
        return (letter.len() == 1 && letter.chars().all(|c| c.is_ascii_uppercase()))
            .then(|| letter.into());
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return (digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit()))
            .then(|| digit.into());
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        return (1..=12).contains(&n).then(|| code.into());
    }
    PUNCTUATION
        .iter()
        .find(|(name, _)| *name == code)
        .map(|(_, sym)| (*sym).into())
}

/// What Settings shows and changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// macOS only; elsewhere none of this is offered.
    pub supported: bool,
    pub menu_bar_icon: bool,
    pub quick_entry: bool,
    /// Stored form, e.g. `Alt+Space`.
    pub shortcut: String,
    /// As shown, e.g. `⌥Space`.
    pub shortcut_label: String,
}

pub fn settings() -> Settings {
    let state = crate::commands::setup::read_app_state();
    let follows = state.keep_running_when_closed == Some(true);
    let shortcut = state
        .quick_entry_shortcut
        .as_deref()
        .and_then(Accelerator::parse)
        .unwrap_or_else(default_accelerator);
    Settings {
        supported: cfg!(target_os = "macos"),
        menu_bar_icon: super::tray::wanted(),
        quick_entry: cfg!(target_os = "macos") && state.quick_entry.unwrap_or(follows),
        shortcut: shortcut.canonical(),
        shortcut_label: shortcut.label(),
    }
}

fn default_accelerator() -> Accelerator {
    Accelerator {
        ctrl: false,
        alt: true,
        shift: false,
        cmd: false,
        key: "Space".into(),
    }
}

/// Register (or release) the shortcut to match the settings. Called at
/// launch and after every change.
pub fn apply(app: &AppHandle) -> Result<(), CommandError> {
    let s = settings();
    let wanted = (s.quick_entry && !IN_APP.load(Ordering::SeqCst)).then_some(s.shortcut);
    register(app, wanted, &s.shortcut_label)
}

fn register(app: &AppHandle, wanted: Option<String>, label: &str) -> Result<(), CommandError> {
    let mut current = REGISTERED.lock().unwrap_or_else(|e| e.into_inner());
    if *current == wanted {
        return Ok(());
    }
    let shortcuts = app.global_shortcut();
    if let Some(old) = current.take() {
        let _ = shortcuts.unregister(old.as_str());
    }
    if let Some(next) = wanted {
        shortcuts.register(next.as_str()).map_err(|e| {
            tracing::warn!("[Agents] quick entry shortcut {next}: {e}");
            CommandError::expected(format!(
                "macOS didn't let Ship Studio use {label}. Another app may already use it; try another."
            ))
        })?;
        *current = Some(next);
    }
    Ok(())
}

/// A Ship Studio window gained or lost focus. Our own windows get ⌥Space back
/// while they're in front; the composer keeps it, so it toggles itself shut.
pub fn window_focus(app: &AppHandle, label: &str, focused: bool) {
    if label == LABEL {
        // Clicked away: close, but leave focus where the click put it.
        if !focused && !CAPTURING.load(Ordering::SeqCst) && !LINGERING.load(Ordering::SeqCst) {
            RETURN_FOCUS.store(false, Ordering::SeqCst);
            if let Some(w) = window(app) {
                let _ = w.hide();
            }
        }
        return;
    }
    IN_APP.store(focused, Ordering::SeqCst);
    let _ = apply(app);
}

/// The shortcut handler (registered with the plugin at startup).
pub fn on_shortcut(app: &AppHandle, state: ShortcutState) {
    if state == ShortcutState::Pressed {
        toggle(app);
    }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

fn url() -> WebviewUrl {
    match crate::main_webview_url() {
        Ok(WebviewUrl::External(mut url)) => {
            url.set_query(Some("window=quick-entry"));
            WebviewUrl::External(url)
        }
        _ => WebviewUrl::App("index.html?window=quick-entry".into()),
    }
}

/// Build the composer window, hidden, so showing it later is instant.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    if !cfg!(target_os = "macos") || app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, url())
        .title("Message an agent")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        // "Open chat" on the confirmation works on the first click, after
        // focus has already gone back to the other app.
        .accept_first_mouse(true)
        .visible(false)
        .focused(false)
        .build()?;
    Ok(())
}

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(LABEL)
}

pub fn toggle(app: &AppHandle) {
    let open = window(app).is_some_and(|w| w.is_visible().unwrap_or(false));
    if open {
        hide(app);
    } else {
        show(app);
    }
}

/// Show the composer on the display the pointer is on, a third of the way down.
pub fn show(app: &AppHandle) {
    let Some(w) = window(app) else {
        return;
    };
    let ours_in_front = app
        .webview_windows()
        .values()
        .any(|w| w.label() != LABEL && w.is_focused().unwrap_or(false));
    RETURN_FOCUS.store(!ours_in_front, Ordering::SeqCst);
    LINGERING.store(false, Ordering::SeqCst);
    if let Some(monitor) = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
    {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let width = WIDTH * scale;
        let x = f64::from(area.position.x) + (f64::from(area.size.width) - width) / 2.0;
        let y = f64::from(area.position.y) + f64::from(area.size.height) / 4.0;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to(LABEL, EVENT_SHOWN, ());
}

/// A message went: give focus straight back to the app that had it, so
/// typing carries on there, while the confirmation ("Sent · Open chat") stays
/// on screen, unfocused, until the composer hides it a moment later.
pub fn sent(app: &AppHandle) {
    LINGERING.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if RETURN_FOCUS.swap(false, Ordering::SeqCst) {
        let _ = app.run_on_main_thread(deactivate);
    }
}

/// `[NSApp deactivate]`: the next app in line becomes active; our windows
/// stay where they are.
#[cfg(target_os = "macos")]
fn deactivate() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let application: *mut AnyObject =
        unsafe { msg_send![class!(NSApplication), sharedApplication] };
    if !application.is_null() {
        let _: () = unsafe { msg_send![application, deactivate] };
    }
}

/// Hide the composer and give focus back to the app that had it.
pub fn hide(app: &AppHandle) {
    LINGERING.store(false, Ordering::SeqCst);
    if let Some(w) = window(app) {
        let _ = w.hide();
    }
    // Hiding the app (as ⌘H does) is how macOS hands focus back to the app
    // that had it. Its windows come back the moment Ship Studio is activated.
    #[cfg(target_os = "macos")]
    if RETURN_FOCUS.swap(false, Ordering::SeqCst) {
        let _ = app.hide();
    }
}

/// Fit the window to the composer (it grows with its text, up to a limit).
pub fn resize(app: &AppHandle, height: f64) {
    if let Some(w) = window(app) {
        let height = height.clamp(96.0, 480.0);
        let _ = w.set_size(tauri::LogicalSize::new(WIDTH, height));
    }
}

/// Hide the composer, let the user drag out a region (or press Space and pick
/// a window), and return the PNG's path; `None` if they pressed Esc.
pub async fn capture(app: &AppHandle) -> Result<Option<String>, CommandError> {
    // Under the agents' folder, which the composer may show images from;
    // sending copies it into the agent's home, so a day is plenty to keep it.
    let dir = super::store::agents_root()?.join(".quick-entry");
    std::fs::create_dir_all(&dir).map_err(super::err_io)?;
    super::attachments::grant_asset_scope(app);
    forget_old_captures(&dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d at %H.%M.%S");
    let path = dir.join(format!("Screenshot {stamp}.png"));
    CAPTURING.store(true, Ordering::SeqCst);
    if let Some(w) = window(app) {
        let _ = w.hide();
    }
    let mut cmd = tokio::process::Command::new("/usr/sbin/screencapture");
    // -i: interactive (drag, or Space for a window); -o: no window shadow; -x: no sound.
    cmd.args(["-i", "-o", "-x"]).arg(&path);
    let result = crate::external_command::run_with_timeout(cmd, "screencapture -i", 300).await;
    if let Some(w) = window(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    CAPTURING.store(false, Ordering::SeqCst);
    result?;
    // Esc leaves no file behind; that's a cancel, not an error.
    Ok(path.is_file().then(|| path.display().to_string()))
}

fn forget_old_captures(dir: &std::path::Path) {
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(text: &str) -> Accelerator {
        Accelerator::parse(text).unwrap()
    }

    #[test]
    fn the_default_is_option_space_and_round_trips() {
        let a = acc(DEFAULT_SHORTCUT);
        assert_eq!(a, default_accelerator());
        assert_eq!(a.canonical(), "Alt+Space");
        assert_eq!(a.label(), "⌥Space");
        assert!(a.conflict().is_none());
    }

    #[test]
    fn modifiers_are_written_in_macos_order() {
        let a = acc("Super+Shift+Alt+Ctrl+KeyK");
        assert_eq!(a.canonical(), "Ctrl+Alt+Shift+Super+KeyK");
        assert_eq!(a.label(), "⌃⌥⇧⌘K");
        assert_eq!(acc("Cmd+Option+Comma").label(), "⌥⌘,");
        assert_eq!(acc("Ctrl+Alt+Digit1").label(), "⌃⌥1");
        assert_eq!(acc("Alt+F5").label(), "⌥F5");
    }

    #[test]
    fn nonsense_doesnt_parse() {
        for text in [
            "",
            "Alt",
            "Alt+Space+KeyK",
            "Alt+Enter",
            "Alt+F13",
            "Alt+Keyk",
            "Hyper+Space",
        ] {
            assert!(Accelerator::parse(text).is_none(), "{text}");
        }
    }

    #[test]
    fn system_and_everyday_shortcuts_are_refused_with_a_reason() {
        let said = |t: &str| acc(t).conflict().unwrap_or_default();
        assert!(said("Super+Space").contains("Spotlight"));
        assert!(said("Ctrl+Space").contains("input sources"));
        assert!(said("Ctrl+Alt+Space").contains("input sources"));
        assert!(said("Shift+Super+Digit4").contains("screenshots"));
        assert!(said("Super+KeyK").contains("used inside most apps"));
        assert!(said("Shift+KeyK").contains("Use ⌃, ⌥ or ⌘"));
        assert!(said("KeyK").contains("Use ⌃, ⌥ or ⌘"));
    }

    #[test]
    fn distinctive_shortcuts_are_fine() {
        for t in [
            "Ctrl+Alt+KeyM",
            "Alt+Super+KeyK",
            "Shift+Super+Space",
            "Ctrl+Alt+KeyN",
        ] {
            assert!(acc(t).conflict().is_none(), "{t}");
        }
    }
}
