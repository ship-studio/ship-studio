//! The menu-bar icon, and what quitting would interrupt.
//!
//! Agents run inside Ship Studio, so staying alive is the product: with
//! "Keep running when closed" on, the window hides and the menu bar is the
//! one place left that shows what is going on. The menu lists the agents
//! that need you first, then the ones working with what they are doing, then
//! the app's own actions. The icon gains a dot while anything needs you.
//!
//! The menu is a pure function of the agents and their live status
//! ([`menu_model`]), rebuilt (debounced) whenever the runner reports a status
//! or registry change; [`quit_check`] reads the same snapshot to say what a
//! quit would cut off.
//!
//! Shown by default once the user has actually used Agents (sent any agent a
//! message, or imported agents), or while "Keep running when closed" is on:
//! someone who never touches Agents gets no new icon in a crowded menu bar.
//! `AppState.menu_bar_icon` overrides that either way.
//!
//! Full design: docs/agents.md, "Menu bar, quit guard and quick entry".

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager};

use super::runner::{self, Status};
use super::store::{self, Agent};

const TRAY_ID: &str = "agents";
/// Rows per section; the rest are counted, not listed.
pub const MAX_ROWS: usize = 5;
/// A menu item is one line; NSMenu would otherwise grow as wide as the text.
const MAX_LABEL: usize = 52;
/// Status events arrive per tool call; the menu is rebuilt at most this often.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// The stay-on preferences changed outside the Agents UI (the tray's toggles).
pub const EVENT_STAY_ON: &str = "stay-on://changed";

const ICON: &[u8] = include_bytes!("../../icons/tray/tray.png");
const ICON_ATTENTION: &[u8] = include_bytes!("../../icons/tray/tray-attention.png");

/// One agent as the menu and the quit check see it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub id: String,
    pub name: String,
    pub hidden: bool,
    pub pinned: bool,
    pub last_activity_at: i64,
    pub pending_approvals: u32,
    pub status: Status,
    /// A turn is running or waiting for a slot (`runner::in_turn`).
    pub running: bool,
}

impl Seen {
    pub fn of(agent: &Agent) -> Self {
        Seen {
            id: agent.id.clone(),
            name: agent.name.clone(),
            hidden: agent.hidden,
            pinned: agent.pinned,
            last_activity_at: agent.last_activity_at,
            pending_approvals: agent.pending_approvals,
            status: runner::status_of(&agent.id),
            running: runner::in_turn(&agent.id),
        }
    }

    /// Mid-turn on a card, or paused with one still open (as `needsYou` in the UI).
    pub fn needs_you(&self) -> bool {
        self.status.state == "waiting" || self.pending_approvals > 0
    }

    fn working(&self) -> bool {
        !self.needs_you() && (self.running || self.status.state == "working")
    }
}

pub fn snapshot() -> Vec<Seen> {
    store::list()
        .map(|agents| agents.iter().map(Seen::of).collect())
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub agent_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TrayModel {
    pub needs_you: Vec<Row>,
    /// Needing you beyond [`MAX_ROWS`].
    pub needs_you_more: usize,
    pub working: Vec<Row>,
    pub working_more: usize,
}

impl TrayModel {
    /// Draw the icon's dot.
    pub fn attention(&self) -> bool {
        !self.needs_you.is_empty()
    }

    pub fn tooltip(&self) -> String {
        let needs = self.needs_you.len() + self.needs_you_more;
        let working = self.working.len() + self.working_more;
        match (needs, working) {
            (0, 0) => "Ship Studio".into(),
            (0, w) => format!("Ship Studio · {w} working"),
            (n, 0) => format!("Ship Studio · {n} need you"),
            (n, w) => format!("Ship Studio · {n} need you, {w} working"),
        }
    }
}

/// What the menu lists: agents the sidebar shows (hidden ones stay hidden
/// here too), in the sidebar's order (pinned, then most recent), split into
/// "needs you" and "working". Idle agents aren't listed: the menu is about
/// what is happening, and the app is one click away for the rest.
pub fn menu_model(seen: &[Seen]) -> TrayModel {
    let mut listed: Vec<&Seen> = seen.iter().filter(|s| !s.hidden).collect();
    listed.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.last_activity_at.cmp(&a.last_activity_at))
    });
    let needs: Vec<Row> = listed
        .iter()
        .filter(|s| s.needs_you())
        .map(|s| row(s, &needs_label(s)))
        .collect();
    let working: Vec<Row> = listed
        .iter()
        .filter(|s| s.working())
        .map(|s| row(s, &working_label(s)))
        .collect();
    let (needs_you, needs_you_more) = cap(needs);
    let (working, working_more) = cap(working);
    TrayModel {
        needs_you,
        needs_you_more,
        working,
        working_more,
    }
}

fn cap(mut rows: Vec<Row>) -> (Vec<Row>, usize) {
    let more = rows.len().saturating_sub(MAX_ROWS);
    rows.truncate(MAX_ROWS);
    (rows, more)
}

fn row(s: &Seen, detail: &str) -> Row {
    Row {
        agent_id: s.id.clone(),
        label: truncate(&format!("{} · {detail}", s.name.trim())),
    }
}

fn needs_label(s: &Seen) -> String {
    match s.pending_approvals {
        n if n > 1 => format!("{n} need your OK"),
        _ => "Needs your OK".into(),
    }
}

fn working_label(s: &Seen) -> String {
    s.status
        .activity
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or("Working")
        .to_string()
}

fn truncate(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    if line.chars().count() <= MAX_LABEL {
        return line.to_string();
    }
    let kept: String = line.chars().take(MAX_LABEL - 1).collect();
    format!("{}…", kept.trim_end())
}

/// What quitting now would interrupt. Every agent counts here, hidden ones
/// included: a quit stops their turns all the same.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitCheck {
    /// Agents mid-turn (or queued for a slot) that aren't waiting on you.
    pub working: Vec<String>,
    /// Agents with an approval card open.
    pub waiting: Vec<String>,
}

impl QuitCheck {
    pub fn quiet(&self) -> bool {
        self.working.is_empty() && self.waiting.is_empty()
    }
}

pub fn quit_check(seen: &[Seen]) -> QuitCheck {
    let names = |pick: fn(&Seen) -> bool| {
        seen.iter()
            .filter(|s| pick(s))
            .map(|s| s.name.trim().to_string())
            .collect()
    };
    QuitCheck {
        working: names(|s| s.running && !s.needs_you()),
        waiting: names(Seen::needs_you),
    }
}

// ---------------------------------------------------------------------------
// Native
// ---------------------------------------------------------------------------

/// Whether the icon should be in the menu bar now.
pub fn wanted() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let state = crate::commands::setup::read_app_state();
    state.menu_bar_icon.unwrap_or_else(|| {
        default_wanted(
            state.agents_used == Some(true) || used_before(),
            state.keep_running_when_closed == Some(true),
        )
    })
}

/// Without an explicit setting: shown once Agents has been used, or while
/// the app keeps running in the background.
fn default_wanted(used: bool, keep_running: bool) -> bool {
    used || keep_running
}

/// Agents used before `agents_used` existed: some agent has had a turn.
fn used_before() -> bool {
    store::list().is_ok_and(|agents| agents.iter().any(|a| a.session_id.is_some()))
}

/// Record that the user has used Agents (sent a message, imported agents),
/// and show the icon if that is what it was waiting for. Cheap after the first time.
pub fn mark_used(app: &AppHandle) {
    let state = crate::commands::setup::read_app_state();
    if state.agents_used == Some(true) {
        return;
    }
    if let Err(e) = crate::commands::setup::update_app_state(|s| s.agents_used = Some(true)) {
        tracing::warn!("[Agents] recording first use: {e}");
        return;
    }
    sync(app);
}

/// Start following agents' status, and show the icon if it is wanted.
pub fn init(app: &AppHandle) {
    for event in [runner::EVENT_STATUS, runner::EVENT_REGISTRY] {
        let handle = app.clone();
        app.listen_any(event, move |_| schedule(&handle));
    }
    sync(app);
}

static SCHEDULED: AtomicBool = AtomicBool::new(false);

fn schedule(app: &AppHandle) {
    if app.tray_by_id(TRAY_ID).is_none() || SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        SCHEDULED.store(false, Ordering::SeqCst);
        refresh(&app);
    });
}

/// Add or remove the icon to match [`wanted`], then bring it up to date.
pub fn sync(app: &AppHandle) {
    let present = app.tray_by_id(TRAY_ID).is_some();
    match (wanted(), present) {
        (true, false) => {
            let Some(image) = icon(false) else { return };
            let built = TrayIconBuilder::with_id(TRAY_ID)
                .icon(image)
                .icon_as_template(true)
                .show_menu_on_left_click(true)
                .tooltip("Ship Studio")
                .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
                .build(app);
            if let Err(e) = built {
                tracing::error!("[Agents] menu bar icon: {e}");
                return;
            }
            refresh(app);
        }
        (false, true) => {
            app.remove_tray_by_id(TRAY_ID);
        }
        (true, true) => refresh(app),
        (false, false) => {}
    }
}

/// Embedded at build time and decoded by a unit test, so `None` is never expected.
fn icon(attention: bool) -> Option<tauri::image::Image<'static>> {
    let bytes = if attention { ICON_ATTENTION } else { ICON };
    tauri::image::Image::from_bytes(bytes)
        .map_err(|e| tracing::error!("[Agents] menu bar icon image: {e}"))
        .ok()
}

fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let model = menu_model(&snapshot());
    match build_menu(app, &model) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => tracing::warn!("[Agents] menu bar menu: {e}"),
    }
    if let Some(image) = icon(model.attention()) {
        let _ = tray.set_icon_with_as_template(Some(image), true);
    }
    let _ = tray.set_tooltip(Some(model.tooltip()));
}

type Builder<'a> = MenuBuilder<'a, tauri::Wry, AppHandle>;

/// A titled section of agent rows, then a separator; nothing when empty.
fn section<'a>(
    app: &AppHandle,
    menu: Builder<'a>,
    title: &str,
    rows: &[Row],
    more: usize,
) -> tauri::Result<Builder<'a>> {
    if rows.is_empty() {
        return Ok(menu);
    }
    let mut menu = menu.item(&MenuItemBuilder::new(title).enabled(false).build(app)?);
    for r in rows {
        menu = menu
            .item(&MenuItemBuilder::with_id(format!("agent:{}", r.agent_id), &r.label).build(app)?);
    }
    if more > 0 {
        menu = menu.item(
            &MenuItemBuilder::new(format!("{more} more"))
                .enabled(false)
                .build(app)?,
        );
    }
    Ok(menu.separator())
}

fn build_menu(app: &AppHandle, model: &TrayModel) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let stay = crate::commands::remote_access::get_stay_on().ok();
    let mut menu = MenuBuilder::new(app);
    menu = section(
        app,
        menu,
        "Needs you",
        &model.needs_you,
        model.needs_you_more,
    )?;
    menu = section(app, menu, "Working", &model.working, model.working_more)?;
    menu = menu
        .item(&MenuItemBuilder::with_id("open", "Open Ship Studio").build(app)?)
        .item(&MenuItemBuilder::with_id("quick", "New message to Chief…").build(app)?)
        .separator();
    if let Some(stay) = stay.filter(|s| s.supported) {
        menu = menu
            .item(
                &CheckMenuItemBuilder::with_id("awake", "Keep this Mac awake")
                    .checked(stay.keep_awake)
                    .build(app)?,
            )
            .item(
                &CheckMenuItemBuilder::with_id("keep", "Keep running when closed")
                    .checked(stay.keep_running)
                    .build(app)?,
            )
            .separator();
    }
    menu.item(&MenuItemBuilder::with_id("quit", "Quit Ship Studio").build(app)?)
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    if let Some(agent_id) = id.strip_prefix("agent:") {
        super::notify::open_agent(app, agent_id);
        return;
    }
    match id {
        "open" => show_app(app),
        "quick" => super::quick_entry::show(app),
        "awake" | "keep" => toggle_stay_on(app, id == "awake"),
        "quit" => request_quit(app, true),
        _ => {}
    }
}

fn toggle_stay_on(app: &AppHandle, awake: bool) {
    use crate::commands::remote_access::{get_stay_on, set_stay_on};
    let Ok(now) = get_stay_on() else { return };
    let result = if awake {
        set_stay_on(app.clone(), Some(!now.keep_awake), None, None)
    } else {
        // Turned off from the icon itself: keep the icon, which would
        // otherwise follow "Keep running" out of the menu bar under the
        // pointer that just clicked it.
        if crate::commands::setup::read_app_state()
            .menu_bar_icon
            .is_none()
        {
            let _ = crate::commands::setup::update_app_state(|s| s.menu_bar_icon = Some(true));
        }
        set_stay_on(app.clone(), None, Some(!now.keep_running), None)
    };
    if let Err(e) = result {
        tracing::warn!("[Agents] stay-on from the menu bar: {e:?}");
    }
}

/// Bring Ship Studio forward: what a close hid, else the main window.
pub fn show_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    crate::commands::window::reopen_hidden_windows(app);
}

/// The main window, made visible: the quit dialog is shown in it.
fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows.get("main").cloned().or_else(|| {
        windows
            .into_values()
            .find(|w| w.label() != super::quick_entry::LABEL)
    })
}

/// ⌘Q and the menu bar's Quit. The decision (and the dialog) are the
/// frontend's, in the main window: brought forward first unless a quit from
/// the menu bar has nothing to interrupt, which quits straight away.
pub fn request_quit(app: &AppHandle, from_menu_bar: bool) {
    let quiet = quit_check(&snapshot()).quiet();
    let Some(window) = main_window(app) else {
        app.exit(0);
        return;
    };
    if !(from_menu_bar && quiet) {
        #[cfg(target_os = "macos")]
        let _ = app.show();
        let _ = window.unminimize();
        let _ = window.show();
        crate::commands::window::forget_hidden_window(window.label());
        let _ = window.set_focus();
    }
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        from_menu_bar: bool,
    }
    let _ = window.emit("confirm-quit", Payload { from_menu_bar });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(id: &str, state: &'static str, activity: Option<&str>) -> Seen {
        Seen {
            id: id.into(),
            name: id.to_uppercase(),
            hidden: false,
            pinned: false,
            last_activity_at: 0,
            pending_approvals: 0,
            status: Status {
                state,
                activity: activity.map(str::to_string),
                since: None,
            },
            running: state != "idle",
        }
    }

    #[test]
    fn the_icon_waits_for_agents_to_be_used_or_background_running() {
        assert!(!default_wanted(false, false));
        assert!(default_wanted(true, false));
        assert!(default_wanted(false, true));
    }

    #[test]
    fn a_codex_agent_is_seen_like_any_other() {
        let _lock = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let created = store::create(store::NewAgent {
            name: "Coder".into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap();
        store::update(&created.id, |a| {
            a.switch_engine(crate::agents::engine::Engine::Codex);
            a.session_id = Some("thread-1".into());
            a.pending_approvals = 1;
        })
        .unwrap();
        let seen = snapshot();
        store::set_root_for_tests(None);
        let model = menu_model(&seen);
        assert_eq!(ids(&model.needs_you), vec![created.id.as_str()]);
        assert_eq!(model.needs_you[0].label, "Coder · Needs your OK");
        assert!(seen.iter().any(|s| s.id == created.id));
    }

    fn ids(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|r| r.agent_id.as_str()).collect()
    }

    #[test]
    fn needs_you_comes_first_then_working_with_its_activity() {
        let team = [
            seen("acme", "working", Some("Editing PricingTable.tsx")),
            seen("lead", "waiting", Some("Waiting for your OK")),
            seen("fin", "idle", None),
        ];
        let model = menu_model(&team);
        assert_eq!(ids(&model.needs_you), ["lead"]);
        assert_eq!(model.needs_you[0].label, "LEAD · Needs your OK");
        assert_eq!(ids(&model.working), ["acme"]);
        assert_eq!(model.working[0].label, "ACME · Editing PricingTable.tsx");
        assert!(model.attention());
    }

    #[test]
    fn an_idle_agent_with_an_open_card_still_needs_you() {
        let mut paused = seen("lead", "idle", None);
        paused.pending_approvals = 3;
        let model = menu_model(&[paused]);
        assert_eq!(model.needs_you[0].label, "LEAD · 3 need your OK");
        assert!(model.working.is_empty());
    }

    #[test]
    fn working_without_an_activity_says_working() {
        let model = menu_model(&[seen("acme", "working", Some("  "))]);
        assert_eq!(model.working[0].label, "ACME · Working");
        assert!(!model.attention());
    }

    #[test]
    fn rows_follow_the_sidebar_order_and_skip_hidden_agents() {
        let mut old = seen("old", "working", None);
        old.last_activity_at = 1;
        let mut new = seen("new", "working", None);
        new.last_activity_at = 9;
        let mut pinned = seen("pin", "working", None);
        pinned.pinned = true;
        let mut hidden = seen("hid", "working", None);
        hidden.hidden = true;
        hidden.last_activity_at = 99;
        let model = menu_model(&[old, new, hidden, pinned]);
        assert_eq!(ids(&model.working), ["pin", "new", "old"]);
    }

    #[test]
    fn at_most_five_per_section_and_the_rest_are_counted() {
        let team: Vec<Seen> = (0..8)
            .map(|i| {
                let mut s = seen(&format!("a{i}"), "waiting", None);
                s.last_activity_at = 100 - i;
                s
            })
            .collect();
        let model = menu_model(&team);
        assert_eq!(ids(&model.needs_you), ["a0", "a1", "a2", "a3", "a4"]);
        assert_eq!(model.needs_you_more, 3);
        assert_eq!(model.tooltip(), "Ship Studio · 8 need you");
    }

    #[test]
    fn long_activity_lines_are_cut_to_one_short_line() {
        let long = "Reading /Users/someone/ShipStudio/acme-marketing/src/components/PricingTable.tsx\nmore";
        let label = &menu_model(&[seen("acme", "working", Some(long))]).working[0].label;
        assert_eq!(label.chars().count(), MAX_LABEL);
        assert!(label.ends_with('…'));
        assert!(!label.contains('\n'));
    }

    #[test]
    fn nothing_happening_lists_nothing() {
        let model = menu_model(&[seen("fin", "idle", None)]);
        assert_eq!(model, TrayModel::default());
        assert_eq!(model.tooltip(), "Ship Studio");
    }

    #[test]
    fn the_quit_check_counts_hidden_agents_and_never_twice() {
        let mut hidden = seen("qa", "working", None);
        hidden.hidden = true;
        let waiting = seen("lead", "waiting", None);
        let mut paused = seen("fin", "idle", None);
        paused.pending_approvals = 1;
        let check = quit_check(&[hidden, waiting, paused, seen("x", "idle", None)]);
        assert_eq!(check.working, ["QA"]);
        assert_eq!(check.waiting, ["LEAD", "FIN"]);
        assert!(!check.quiet());
        assert!(quit_check(&[seen("x", "idle", None)]).quiet());
    }

    #[test]
    fn a_turn_queued_for_a_slot_counts_as_working() {
        let mut queued = seen("acme", "idle", None);
        queued.running = true;
        assert_eq!(quit_check(&[queued]).working, ["ACME"]);
    }

    #[test]
    fn both_icons_decode() {
        for bytes in [ICON, ICON_ATTENTION] {
            let image = tauri::image::Image::from_bytes(bytes).unwrap();
            assert_eq!((image.width(), image.height()), (36, 36));
        }
    }
}
