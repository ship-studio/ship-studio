//! # Ship Studio Backend
//!
//! This module contains all Tauri commands for the Ship Studio desktop app.
//! Commands are organized into these categories:
//!
//! - **Project Management**: Create, list, delete projects in ~/ShipStudio
//! - **Dev Server & Terminal**: PTY management for Claude Code terminal
//! - **GitHub Integration**: Check status, create repos, commit and push
//! - **Environment Variables**: Read/write .env files with validation
//! - **Native Webview**: Child webview for Sanity CMS (OAuth support)
//! - **Utilities**: Screenshots, IDE launcher, prerequisite checks

pub mod agent;
pub mod cache;
pub mod commands;
pub mod errors;
pub mod external_command;
pub mod logging;
pub mod proxy;
pub mod state;
pub mod static_server;
pub mod types;
pub mod utils;
pub mod webview_scripts;

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
    // Sentry must init before the tracing subscriber so its layer can attach.
    logging::init_sentry();

    // Initialize logging first
    if let Err(e) = logging::init_logging() {
        eprintln!("Failed to initialize logging: {e}");
    }

    tracing::info!("Ship Studio starting up");

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

    // Initialize PostHog analytics (generates device_id on first launch)
    commands::analytics::init_analytics();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
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
                .title("Ship Studio")
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
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);
                }

                main_builder.build()?;
            }

            // Build a custom menu on macOS that replaces Cmd+W (Close Window)
            // with a custom "Close Tab" action that emits an event to the frontend
            #[cfg(target_os = "macos")]
            {
                let app = _app;
                let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;

                let quit_item = MenuItemBuilder::with_id("confirm_quit", "Quit Ship Studio")
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

                let app_menu = SubmenuBuilder::new(app, "Ship Studio")
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

                let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

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
                    // "New Window" spawns a fresh window directly — handled
                    // before the per-window event-emit branch since it does
                    // not require a focused webview to exist.
                    if event.id() == "new_window" {
                        if let Err(e) = commands::projects::spawn_blank_window(&app_handle) {
                            tracing::error!("Failed to spawn new window: {}", e);
                        }
                        return;
                    }
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if event.id() == "close_tab" {
                            let _ = window.emit("close-tab", ());
                        } else if event.id() == "confirm_quit" {
                            let _ = window.emit("confirm-quit", ());
                        } else if event.id() == "capture_screenshot" {
                            let _ = window.emit("capture-screenshot", ());
                        } else if event.id() == "toggle_crop" {
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

                // Stop preview proxy and static server for this window
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
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Git & Prerequisites
            commands::git::check_prerequisites,
            commands::git::get_shipstudio_dir,
            commands::git::ensure_shipstudio_dir,
            commands::git::init_git_repo,
            commands::git::check_git_has_changes,
            commands::git::get_changed_files,
            commands::git::get_file_diff,
            commands::git::get_branch_status,
            commands::git::reset_to_branch,
            commands::git::list_branches,
            commands::git::get_current_branch,
            commands::git::switch_branch,
            commands::git::get_stash_info,
            commands::git::apply_stash,
            commands::git::drop_stash,
            commands::git::discard_changes,
            commands::git::commit_changes,
            commands::git::create_branch,
            commands::git::fetch_all_branches,
            commands::git::git_pull,
            commands::git::pull_and_merge,
            commands::git::delete_branch,
            commands::git::get_backups,
            commands::git::restore_backup,
            // Projects
            commands::projects::list_projects,
            commands::projects::get_dashboard_projects,
            commands::projects::list_pages,
            commands::projects::open_in_finder,
            commands::projects::read_project_metadata,
            commands::projects::write_project_metadata,
            commands::projects::mark_project_opened,
            commands::projects::has_vercel_config,
            commands::projects::get_branch_prefix_preference,
            commands::projects::set_branch_prefix_preference,
            commands::projects::ensure_gitignore_has_shipstudio,
            commands::projects::create_blank_project,
            commands::projects::remove_git_history,
            commands::projects::delete_project,
            commands::projects::rename_project,
            commands::projects::clear_project_cache,
            commands::projects::get_auto_accept_mode,
            commands::projects::set_auto_accept_mode,
            commands::projects::get_hide_main_branch_warning,
            commands::projects::set_hide_main_branch_warning,
            commands::projects::get_custom_dev_command,
            commands::projects::set_custom_dev_command,
            commands::projects::get_dev_server_port,
            commands::projects::set_dev_server_port,
            commands::projects::get_workspace_subpath,
            commands::projects::set_workspace_subpath,
            commands::projects::check_dependencies_installed,
            commands::edit::resolve_classname_source,
            commands::edit::apply_classname_edit,
            commands::edit::apply_classname_edit_multi,
            commands::edit::resolve_text_source,
            commands::edit::apply_text_edit,
            commands::edit::find_component_usage,
            commands::edit::detect_breakpoints,
            commands::edit::is_tailwind_active,
            commands::projects::get_terminal_state,
            commands::projects::set_terminal_state,
            commands::projects::extract_template_zip,
            commands::projects::export_project_as_template,
            commands::projects::open_project_in_new_window,
            commands::projects::register_project_for_window,
            commands::projects::unregister_project_from_window,
            commands::projects::get_project_window,
            commands::projects::focus_window_by_label,
            // Pinned projects (background sessions rail)
            commands::projects::pin_project,
            commands::projects::unpin_project,
            commands::projects::list_pinned_projects,
            commands::projects::reorder_pins,
            commands::projects::save_pin_session,
            commands::projects::get_pin_session,
            // Project session lifecycle (background sessions rail)
            commands::projects::register_project_session,
            commands::projects::suspend_project_session,
            commands::projects::unregister_project_session,
            commands::projects::touch_project_session,
            commands::projects::list_project_sessions,
            commands::projects::get_project_session_info,
            commands::projects::get_active_session_count,
            commands::projects::get_session_memory,
            // Internationalization (i18n)
            commands::i18n::get_i18n_status,
            commands::i18n::set_i18n_config,
            // Environment variables
            commands::env::list_env_files,
            commands::env::read_env_file,
            commands::env::write_env_file,
            commands::env::create_env_file,
            commands::env::delete_env_file,
            // IDE & Webviews
            commands::ide::check_ide_availability,
            commands::ide::open_in_ide,
            commands::ide::check_browser_availability,
            commands::ide::open_url_in_browser,
            commands::ide::create_preview_webview,
            commands::ide::navigate_preview_webview,
            commands::ide::resize_preview_webview,
            commands::ide::destroy_preview_webview,
            commands::ide::eval_preview_js,
            commands::ide::scroll_preview_webview,
            commands::ide::get_preview_scroll_info,
            commands::ide::check_preview_can_scroll,
            commands::ide::open_studio_window,
            commands::ide::capture_project_thumbnail,
            commands::ide::capture_fullpage_playwright,
            commands::ide::capture_viewport_playwright,
            commands::ide::get_project_thumbnail,
            commands::ide::upload_project_thumbnail,
            commands::ide::get_screenshot_base64,
            commands::ide::crop_and_save_screenshot,
            commands::ide::compare_screenshots,
            commands::ide::stitch_screenshots,
            // Analytics
            commands::analytics::track_event,
            commands::analytics::identify_user,
            commands::analytics::get_analytics_enabled,
            commands::analytics::set_analytics_enabled,
            commands::analytics::get_device_id_command,
            // Settings
            commands::settings::get_calendar_hidden,
            commands::settings::set_calendar_hidden,
            commands::settings::get_slack_cta_hidden,
            commands::settings::set_slack_cta_hidden,
            commands::settings::get_terminal_gpu_enabled,
            commands::settings::set_terminal_gpu_enabled,
            // AI generation
            commands::ai::generate_pr_description,
            // Claude integration
            commands::claude::check_claude_cli_status,
            commands::claude::install_claude_cli,
            commands::claude::claude_session_exists,
            // Claude skills
            commands::skills::list_claude_skills,
            commands::skills::check_skills_cli,
            commands::skills::search_skills,
            commands::skills::install_skill,
            commands::skills::remove_skill,
            // MCP servers
            commands::mcp::list_mcp_servers,
            commands::mcp::add_mcp_server,
            commands::mcp::remove_mcp_server,
            // Plugins
            commands::plugins::list_plugins,
            commands::plugins::install_plugin,
            commands::plugins::uninstall_plugin,
            commands::plugins::update_plugin,
            commands::plugins::check_plugin_update,
            commands::plugins::read_plugin_bundle,
            commands::plugins::read_plugin_manifest,
            commands::plugins::toggle_plugin,
            commands::plugins::exec_plugin_shell,
            commands::plugins::read_plugin_storage,
            commands::plugins::write_plugin_storage,
            commands::plugins::link_dev_plugin,
            commands::plugins::unlink_dev_plugin,
            // GitHub integration
            commands::github::check_github_cli_status,
            commands::github::get_github_username,
            commands::github::get_github_orgs,
            commands::github::get_project_github_status,
            commands::github::push_to_github,
            commands::github::list_github_repos,
            commands::github::list_collaborator_repos,
            commands::github::detect_package_manager,
            // Publishing
            commands::publishing::publish_to_github,
            commands::publishing::publish_to_staging,
            commands::publishing::publish_to_production,
            commands::publishing::publish_branch,
            // Pull requests
            commands::pull_requests::list_pull_requests,
            commands::pull_requests::create_pull_request,
            commands::pull_requests::merge_pull_request,
            commands::pull_requests::checkout_pull_request,
            commands::pull_requests::close_pull_request,
            // Merge conflict resolution
            commands::conflicts::get_conflict_info,
            commands::conflicts::resolve_conflict,
            commands::conflicts::abort_merge,
            commands::conflicts::complete_merge,
            // Preview Proxy
            commands::proxy::start_preview_proxy,
            commands::proxy::stop_preview_proxy,
            // Static File Server
            commands::static_server::start_static_server,
            commands::static_server::stop_static_server,
            // Project Type Detection
            commands::projects::detect_project_type_command,
            // Native Mobile Preview (iOS Simulator via serve-sim)
            commands::mobile::list_booted_simulators,
            commands::mobile::start_mobile_preview,
            commands::mobile::get_simulator_launch_command,
            commands::mobile::simulator_app_running,
            commands::mobile::hide_simulator,
            commands::mobile::list_android_devices,
            commands::mobile::android_app_running,
            commands::mobile::detect_mobile_targets,
            commands::mobile::mobile_platform_support,
            commands::mobile::set_mobile_launch_status,
            // PTY & Terminal
            commands::pty::spawn_pty,
            commands::pty::kill_pty,
            commands::pty::kill_window_pty,
            commands::pty::kill_all_pty,
            commands::pty::cleanup_orphaned_processes,
            commands::pty::kill_port,
            commands::pty::find_available_port,
            commands::pty::find_and_reserve_port,
            commands::pty::get_reserved_port_for_window,
            commands::pty::release_reserved_port,
            commands::pty::get_shell_path,
            commands::pty::get_system_env,
            commands::pty::register_external_pty,
            commands::pty::unregister_external_pty,
            commands::pty::kill_project_pty,
            commands::pty::get_project_pty_pids,
            // Backend-owned PTY sessions (phase 3)
            commands::pty_session::pty_session_open,
            commands::pty_session::pty_session_write,
            commands::pty_session::pty_session_resize,
            commands::pty_session::pty_session_kill,
            commands::pty_session::pty_session_attach,
            commands::pty_session::pty_session_list,
            // Community Templates
            commands::templates::fetch_community_templates,
            commands::templates::download_template_zip,
            // Setup/Onboarding
            commands::setup::get_full_setup_status,
            commands::setup::install_homebrew,
            commands::setup::install_node_via_brew,
            commands::setup::install_git_via_brew,
            commands::setup::install_gh_via_brew,
            commands::setup::install_brew_packages,
            commands::setup::install_winget_packages,
            commands::setup::start_github_auth,
            commands::setup::start_claude_auth,
            commands::setup::check_claude_auth_status,
            commands::setup::check_npm_cache_permissions,
            commands::setup::cleanup_auth_processes,
            commands::setup::get_system_arch,
            commands::setup::install_version,
            commands::setup::quick_setup_check,
            commands::setup::mark_setup_complete,
            commands::setup::reset_setup_state,
            commands::setup::get_default_agent_id,
            commands::setup::set_default_agent_id,
            commands::setup::get_agents_status,
            commands::setup::sign_out_agent,
            commands::setup::uninstall_agent,
            // Client Editor
            commands::client_editor::detect_client_editor,
            // Code Browser
            commands::code::list_project_files,
            commands::code::read_project_file,
            // Assets
            commands::assets::get_assets_root,
            commands::assets::set_assets_root,
            commands::assets::list_assets,
            commands::assets::upload_asset,
            commands::assets::delete_asset,
            commands::assets::rename_asset,
            commands::assets::create_asset_folder,
            // Code Health
            commands::health::detect_health_scripts,
            commands::health::run_health_script,
            commands::health::get_health_status,
            commands::health::clear_health_status,
            commands::health::get_package_json,
            // External Projects
            commands::external_projects::register_external_project,
            commands::external_projects::unregister_external_project,
            commands::external_projects::is_project_external,
            commands::external_projects::ensure_external_project_registered,
            // Monorepo
            commands::monorepo::detect_workspaces,
            // Folders
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::delete_folder,
            commands::folders::add_project_to_folder,
            commands::folders::remove_project_from_folder,
            commands::folders::move_project_to_folder,
            commands::folders::get_project_folder,
            commands::folders::get_filed_project_paths,
            commands::folders::get_folder_projects,
            commands::folders::get_folder,
            // Support (cStar) — identity signing only; tickets use ChatClient SDK
            commands::support::get_support_identity,
            // Logging
            logging::get_log_path,
            logging::log_frontend_event,
            // Snapshots / Undo-Redo
            commands::snapshots::snapshot_start_watching,
            commands::snapshots::snapshot_stop_watching,
            commands::snapshots::snapshot_status,
            commands::snapshots::snapshot_undo,
            commands::snapshots::snapshot_redo,
            // Window / Compact Mode
            commands::window::enter_compact_mode,
            commands::window::exit_compact_mode,
            commands::window::set_always_on_top,
            commands::window::save_compact_position,
            commands::window::get_compact_preferences,
            commands::window::set_compact_expanded,
            commands::window::get_window_position,
            commands::window::set_window_position,
            commands::window::start_window_drag,
            commands::window::focus_window,
            commands::window::set_window_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
