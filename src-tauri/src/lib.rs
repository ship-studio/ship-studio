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
pub mod logging;
pub mod proxy;
pub mod state;
pub mod static_server;
pub mod types;
pub mod utils;

use tauri::Manager;

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

    tracing::info!("Ship Studio starting up");

    // Clean up any orphaned agent processes from previous crashed sessions
    cleanup_agent_processes();
    tracing::debug!("Orphaned agent processes cleaned up");

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
            commands::projects::remove_git_history,
            commands::projects::delete_project,
            commands::projects::clear_project_cache,
            commands::projects::get_auto_accept_mode,
            commands::projects::set_auto_accept_mode,
            commands::projects::get_hide_main_branch_warning,
            commands::projects::set_hide_main_branch_warning,
            commands::projects::get_custom_dev_command,
            commands::projects::set_custom_dev_command,
            commands::projects::get_dev_server_port,
            commands::projects::set_dev_server_port,
            commands::projects::get_terminal_state,
            commands::projects::set_terminal_state,
            commands::projects::extract_template_zip,
            commands::projects::export_project_as_template,
            commands::projects::open_project_in_new_window,
            commands::projects::register_project_for_window,
            commands::projects::unregister_project_from_window,
            commands::projects::get_project_window,
            commands::projects::focus_window_by_label,
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
            // AI generation
            commands::ai::generate_pr_description,
            // Claude integration
            commands::claude::check_claude_cli_status,
            commands::claude::install_claude_cli,
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
            // Code Browser
            commands::code::list_project_files,
            commands::code::read_project_file,
            // Assets
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
            // Logging
            logging::get_log_path,
            logging::log_frontend_event,
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
