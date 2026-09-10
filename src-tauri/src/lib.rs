//! # Harbr Backend
//!
//! This module contains all Tauri commands for the Harbr desktop app.
//! Commands are organized into these categories:
//!
//! - **Project Management**: Create, list, delete projects in ~/ShipStudio
//! - **Dev Server & Terminal**: PTY management for Claude Code terminal
//! - **GitHub Integration**: Check status, create repos, commit and push
//! - **Environment Variables**: Read/write .env files with validation
//! - **Native Webview**: Child webview for Sanity CMS (OAuth support)
//! - **Utilities**: Screenshots, IDE launcher, prerequisite checks

pub mod agent;
pub mod agent_bridge;
pub mod cache;
pub mod command_manifest;
pub mod commands;
pub mod emit;
pub mod errors;
pub mod external_command;
pub mod logging;
pub mod proxy;
pub mod state;
pub mod static_server;
pub mod types;
pub mod utils;
#[cfg(feature = "web")]
pub mod web;
pub mod webview_scripts;
pub mod workflow_scheduler;

use tauri::generate_handler;
use tauri::Manager;

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(unix)]
use std::process::Command;

// Kill orphaned agent processes spawned by this app
fn cleanup_agent_processes() {
    #[cfg(unix)]
    {
        let pid = std::process::id();

        // Iterate ALL agents to kill children and orphans for each
        for ag in agent::ALL_AGENTS {
            let _ = Command::new("pkill")
                .args(["-P", &pid.to_string(), ag.process_name])
                .output();

            let kill_script = format!(
                r#"
                    for pid in $(pgrep -x {} 2>/dev/null); do
                        ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                        if [ "$ppid" = "1" ]; then
                            kill $pid 2>/dev/null
                        fi
                    done
                "#,
                ag.process_name
            );
            let _ = Command::new("sh").args(["-c", &kill_script]).output();
        }

        // Also kill orphaned node processes running next-server (from dev server)
        let _ = Command::new("sh")
            .args([
                "-c",
                r#"
                for pid in $(pgrep -f 'next-server' 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#,
            ])
            .output();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging first
    if let Err(e) = logging::init_logging() {
        eprintln!("Failed to initialize logging: {e}");
    }

    tracing::info!("Harbr starting up");

    // Clean up any orphaned agent processes from previous crashed sessions
    cleanup_agent_processes();
    tracing::debug!("Orphaned agent processes cleaned up");

    // Reap serve-sim mirror daemons orphaned by a previous hard crash — they pin
    // the mirror port and would otherwise accumulate one per crash.
    #[cfg(target_os = "macos")]
    {
        commands::mobile::reap_orphaned_serve_sim();
        tracing::debug!("Orphaned serve-sim mirrors reaped");
    }

    // Hydrate the default agent cache from persisted AppState
    let app_state = commands::setup::read_app_state();
    agent::init_default_agent(app_state.default_agent_id.as_deref());

    // Initialize local product-event logging (generates a local device id).
    commands::analytics::init_analytics();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // Install the event sink before background services can emit.
            emit::init_tauri(_app.handle().clone());

            // Teach the user's own agent about workflows, and start the tick
            // that fires the armed ones. The skill install is the discovery
            // path for the whole feature (see commands::workflows::skill); it
            // is idempotent and skips agents that aren't installed.
            {
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    commands::skills::install_bundled_skills();
                    workflow_scheduler::spawn(handle);
                });
            }

            // Start the agent preview bridge (global loopback MCP server) at
            // launch so it's listening before any agent session spawns —
            // registrations from previous runs stay valid from second zero.
            {
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = agent_bridge::start_global_agent_bridge(Some(handle)).await {
                        tracing::error!("[AgentBridge] Failed to start global bridge: {}", e);
                    }
                });
            }

            // Point the Android mirror bridge at the bundled scrcpy-server jar (its
            // low-latency video source). If the resource is missing, the bridge
            // falls back to a system scrcpy install, then to screenrecord.
            {
                use tauri::Manager;
                if let Ok(jar) = _app
                    .path()
                    .resolve("scrcpy-server.jar", tauri::path::BaseDirectory::Resource)
                {
                    if jar.is_file() {
                        commands::mobile::set_bundled_scrcpy_jar(jar);
                    }
                }
            }

            // Build the main window programmatically so we can attach an
            // initialization script that runs in all frames (including the
            // cross-origin preview iframe). Config here mirrors what used to
            // live in tauri.conf.json under `app.windows[0]`.
            {
                let mut main_builder = tauri::WebviewWindowBuilder::new(
                    _app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Harbr")
                .inner_size(1400.0, 900.0)
                .min_inner_size(400.0, 300.0)
                .resizable(true)
                .fullscreen(false)
                .transparent(true)
                .background_color(tauri::utils::config::Color(45, 45, 45, 255))
                .initialization_script_for_all_frames(webview_scripts::INSPECTOR_SHIM);

                #[cfg(target_os = "macos")]
                {
                    main_builder = main_builder
                        .decorations(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        // `y` sizes Tao's native titlebar container to 14 + 32 = 46px;
                        // `center_macos_traffic_lights` below performs the missing Y move.
                        .traffic_light_position(tauri::LogicalPosition::new(16.0, 32.0))
                        .hidden_title(true);
                }

                let main_window = main_builder.build()?;

                #[cfg(target_os = "macos")]
                commands::window::center_macos_traffic_lights(&main_window)?;

                let selected_app_icon = commands::settings::get_app_icon()?;
                commands::settings::apply_app_icon(_app.handle(), &selected_app_icon)?;
            }

            // The static asset-protocol scope (tauri.conf.json) only covers
            // ~/ShipStudio. Grant access to registered external project roots at
            // runtime so we don't have to expose all of $HOME/Volumes statically
            // (which would let any main-frame script read ~/.ssh, ~/.aws, etc.).
            commands::external_projects::grant_asset_scope_for_registered(_app.handle());

            // Build a custom menu on macOS that replaces Cmd+W (Close Window)
            // with a custom "Close Tab" action that emits an event to the frontend
            #[cfg(target_os = "macos")]
            {
                let app = _app;
                let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;

                let quit_item = MenuItemBuilder::with_id("confirm_quit", "Quit Harbr")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;

                // Hidden menu items to register native accelerators for screenshot shortcuts.
                // Native accelerators work even when the preview iframe has keyboard focus.
                let screenshot_item =
                    MenuItemBuilder::with_id("capture_screenshot", "Capture Screenshot")
                        .accelerator("CmdOrCtrl+Shift+S")
                        .build(app)?;
                let crop_item = MenuItemBuilder::with_id("toggle_crop", "Crop Screenshot")
                    .accelerator("CmdOrCtrl+Shift+C")
                    .build(app)?;

                let new_window = MenuItemBuilder::with_id("new_window", "New Window")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;

                // Native accelerators keep the project, workspace, mode, and
                // inspector shortcuts working while the cross-origin preview
                // iframe has focus.
                let mut project_shortcuts = Vec::with_capacity(9);
                for number in 1..=9 {
                    project_shortcuts.push(
                        MenuItemBuilder::with_id(
                            format!("switch_project_{number}"),
                            format!("Switch Project {number}"),
                        )
                        .accelerator(format!("CmdOrCtrl+Digit{number}"))
                        .build(app)?,
                    );
                }

                let mut workspace_shortcuts = Vec::with_capacity(9);
                for number in 1..=9 {
                    workspace_shortcuts.push(
                        MenuItemBuilder::with_id(
                            format!("switch_workspace_{number}"),
                            format!("Switch Workspace {number}"),
                        )
                        .accelerator(format!("Alt+Digit{number}"))
                        .build(app)?,
                    );
                }

                let mut terminal_shortcuts = Vec::with_capacity(9);
                for number in 1..=9 {
                    terminal_shortcuts.push(
                        MenuItemBuilder::with_id(
                            format!("switch_terminal_{number}"),
                            format!("Switch Terminal {number}"),
                        )
                        .accelerator(format!("Control+Digit{number}"))
                        .build(app)?,
                    );
                }

                let mut mode_shortcuts = Vec::with_capacity(3);
                for number in 1..=3 {
                    mode_shortcuts.push(
                        MenuItemBuilder::with_id(
                            format!("switch_workspace_mode_{number}"),
                            format!("Switch Workspace Mode {number}"),
                        )
                        .accelerator(format!("CmdOrCtrl+Control+Digit{number}"))
                        .build(app)?,
                    );
                }

                let toggle_edit_mode =
                    MenuItemBuilder::with_id("toggle_edit_mode", "Toggle Edit Mode")
                        .accelerator("CmdOrCtrl+E")
                        .build(app)?;

                let toggle_inspector =
                    MenuItemBuilder::with_id("toggle_inspector", "Toggle Inspector")
                        .accelerator("CmdOrCtrl+I")
                        .build(app)?;

                let app_menu = SubmenuBuilder::new(app, "Harbr")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&close_tab)
                    .separator()
                    .item(&screenshot_item)
                    .item(&crop_item)
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let mut view_menu_builder = SubmenuBuilder::new(app, "View").fullscreen();
                view_menu_builder = view_menu_builder.separator();
                for item in &project_shortcuts {
                    view_menu_builder = view_menu_builder.item(item);
                }
                view_menu_builder = view_menu_builder.separator();
                for item in &workspace_shortcuts {
                    view_menu_builder = view_menu_builder.item(item);
                }
                view_menu_builder = view_menu_builder.separator();
                for item in &terminal_shortcuts {
                    view_menu_builder = view_menu_builder.item(item);
                }
                view_menu_builder = view_menu_builder.separator();
                for item in &mode_shortcuts {
                    view_menu_builder = view_menu_builder.item(item);
                }
                view_menu_builder = view_menu_builder
                    .separator()
                    .item(&toggle_edit_mode)
                    .item(&toggle_inspector);
                let view_menu = view_menu_builder.build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .item(&new_window)
                    .separator()
                    .minimize()
                    .maximize()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(menu)?;

                // Handle custom menu items
                let app_handle = app.handle().clone();
                app.on_menu_event(move |_app, event| {
                    let event_id = event.id().as_ref();
                    // "New Window" spawns a fresh window directly — handled
                    // before the per-window event-emit branch since it does
                    // not require a focused webview to exist.
                    if event_id == "new_window" {
                        if let Err(e) = commands::projects::spawn_blank_window(&app_handle) {
                            tracing::error!("Failed to spawn new window: {}", e);
                        }
                        return;
                    }
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if let Some(number) = event_id
                            .strip_prefix("switch_project_")
                            .and_then(|value| value.parse::<u8>().ok())
                        {
                            let _ = window.emit("switch-project-shortcut", number);
                        } else if let Some(number) = event_id
                            .strip_prefix("switch_workspace_mode_")
                            .and_then(|value| value.parse::<u8>().ok())
                        {
                            let _ = window.emit("switch-workspace-mode-shortcut", number);
                        } else if let Some(number) = event_id
                            .strip_prefix("switch_workspace_")
                            .and_then(|value| value.parse::<u8>().ok())
                        {
                            let _ = window.emit("switch-workspace-shortcut", number);
                        } else if let Some(number) = event_id
                            .strip_prefix("switch_terminal_")
                            .and_then(|value| value.parse::<u8>().ok())
                        {
                            let _ = window.emit("switch-terminal-shortcut", number);
                        } else if event_id == "toggle_edit_mode" {
                            let _ = window.emit("toggle-edit-mode-shortcut", ());
                        } else if event_id == "toggle_inspector" {
                            let _ = window.emit("toggle-inspector-shortcut", ());
                        } else if event_id == "close_tab" {
                            let _ = window.emit("close-tab", ());
                        } else if event_id == "confirm_quit" {
                            let _ = window.emit("confirm-quit", ());
                        } else if event_id == "capture_screenshot" {
                            let _ = window.emit("capture-screenshot", ());
                        } else if event_id == "toggle_crop" {
                            let _ = window.emit("toggle-crop", ());
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                tracing::info!("Window {} destroyed, cleaning up", label);

                // Stop preview proxy and static server for this window (the
                // agent bridge is global — it lives for the app's lifetime)
                proxy::stop_preview_proxy(&label);
                static_server::stop_static_server(&label);

                // Kill PTY processes (dev server, etc.) owned by this window
                let killed = commands::pty::kill_window_pty_sync(&label);
                if killed > 0 {
                    tracing::info!("Killed {} PTY processes for window {}", killed, label);
                }

                // Tear down this window's mobile previews (serve-sim daemon, app
                // build, and any sim we booted). Runs for EVERY closing window,
                // not just main — a non-main project window must not leak its sim.
                commands::mobile::teardown_mobile_previews_for_window_sync(&label);

                // Clean up project window registry
                state::unregister_window_by_label(&label);

                // Only run global cleanup when main window closes or no windows remain
                // This prevents killing processes from other windows
                let is_main = label == "main";
                let remaining_windows = window
                    .app_handle()
                    .webview_windows()
                    .len()
                    .saturating_sub(1); // Subtract 1 because the closing window is still counted

                if is_main || remaining_windows == 0 {
                    tracing::info!(
                        "Running global cleanup (main={}, remaining={})",
                        is_main,
                        remaining_windows
                    );
                    cleanup_agent_processes();
                    commands::setup::cleanup_auth_processes_sync();
                    proxy::stop_all_proxies();
                    static_server::stop_all_static_servers();
                    // Mobile previews are torn down per-window above
                    // (teardown_mobile_previews_for_window_sync), so there's no
                    // global sim shutdown to do here.
                }

                // The agent bridge serves EVERY window (one global MCP server),
                // so it must outlive the main window: project windows still
                // need their preview tools after main closes.
                if remaining_windows == 0 {
                    agent_bridge::stop_all_agent_bridges();
                }
            }
        })
        .invoke_handler(ship_commands!(generate_handler))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // The quit path calls exit(0) after preventDefault() on the
                // close request, so WindowEvent::Destroyed cleanup never runs.
                // This is the only hook that fires for every shutdown — dev
                // servers and agent PTYs must die here or they outlive the app
                // and keep their ports (issue #229: EADDRINUSE on relaunch).
                let ptys = commands::pty::kill_all_pty_sync();
                let sessions = commands::pty_session::kill_all_sessions_sync();
                tracing::info!(ptys, sessions, "App exit: killed tracked PTY processes");
            }
        });
}
