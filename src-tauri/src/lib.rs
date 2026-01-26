//! # Ship Studio Backend
//!
//! This module contains all Tauri commands for the Ship Studio desktop app.
//! Commands are organized into these categories:
//!
//! - **Project Management**: Create, list, delete projects in ~/ShipStudio
//! - **Dev Server & Terminal**: PTY management for Claude Code terminal
//! - **GitHub Integration**: Check status, create repos, commit and push
//! - **Vercel Integration**: Check status, deploy projects
//! - **Environment Variables**: Read/write .env files with validation
//! - **Native Webview**: Child webview for Sanity CMS (OAuth support)
//! - **Utilities**: Screenshots, IDE launcher, prerequisite checks

pub mod cache;
pub mod commands;
pub mod logging;
pub mod types;
pub mod utils;

use std::process::Command;

// Kill orphaned Claude processes spawned by this app
fn cleanup_claude_processes() {
    #[cfg(unix)]
    {
        // Get current process's children and kill them
        let pid = std::process::id();
        let _ = Command::new("pkill")
            .args(["-P", &pid.to_string(), "claude"])
            .output();

        // Kill any orphaned claude processes (parent is init/launchd - PID 1)
        let _ = Command::new("sh")
            .args([
                "-c",
                r#"
                for pid in $(pgrep -x claude 2>/dev/null); do
                    ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
                    if [ "$ppid" = "1" ]; then
                        kill $pid 2>/dev/null
                    fi
                done
            "#,
            ])
            .output();

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
        eprintln!("Failed to initialize logging: {}", e);
    }

    tracing::info!("Ship Studio starting up");

    // Clean up any orphaned Claude processes from previous crashed sessions
    cleanup_claude_processes();
    tracing::debug!("Orphaned Claude processes cleaned up");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                cleanup_claude_processes();
                commands::setup::cleanup_auth_processes_sync();
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
            commands::git::get_branch_status,
            commands::git::reset_to_branch,
            commands::git::list_branches,
            commands::git::get_current_branch,
            commands::git::switch_branch,
            commands::git::get_stash_info,
            commands::git::apply_stash,
            commands::git::drop_stash,
            commands::git::discard_changes,
            commands::git::create_branch,
            commands::git::fetch_all_branches,
            commands::git::git_pull,
            commands::git::pull_and_merge,
            commands::git::delete_branch,
            // Projects
            commands::projects::list_projects,
            commands::projects::get_dashboard_projects,
            commands::projects::list_pages,
            commands::projects::check_sanity_installed,
            commands::projects::read_project_metadata,
            commands::projects::write_project_metadata,
            commands::projects::mark_project_opened,
            commands::projects::get_branch_prefix_preference,
            commands::projects::set_branch_prefix_preference,
            commands::projects::ensure_gitignore_has_shipstudio,
            commands::projects::delete_project,
            // Environment variables
            commands::env::list_env_files,
            commands::env::read_env_file,
            commands::env::write_env_file,
            commands::env::create_env_file,
            commands::env::delete_env_file,
            commands::env::check_sanity_env_keys,
            // IDE & Webviews
            commands::ide::check_ide_availability,
            commands::ide::open_in_ide,
            commands::ide::create_preview_webview,
            commands::ide::navigate_preview_webview,
            commands::ide::resize_preview_webview,
            commands::ide::destroy_preview_webview,
            commands::ide::open_studio_window,
            commands::ide::capture_project_thumbnail,
            commands::ide::get_project_thumbnail,
            commands::ide::crop_and_save_screenshot,
            // Claude integration
            commands::claude::check_claude_cli_status,
            commands::claude::install_claude_cli,
            // Vercel integration
            commands::vercel::check_vercel_cli_status,
            commands::vercel::get_vercel_username,
            commands::vercel::get_vercel_teams,
            commands::vercel::list_vercel_projects,
            commands::vercel::write_vercel_project_json,
            commands::vercel::get_project_vercel_status,
            commands::vercel::link_to_vercel,
            commands::vercel::install_vercel_cli,
            commands::vercel::deploy_to_vercel,
            commands::vercel::get_vercel_deployments,
            commands::vercel::get_deployment_status,
            // GitHub integration
            commands::github::check_github_cli_status,
            commands::github::get_github_username,
            commands::github::get_github_orgs,
            commands::github::get_project_github_status,
            commands::github::push_to_github,
            commands::github::list_github_repos,
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
            // Merge conflict resolution
            commands::conflicts::get_conflict_info,
            commands::conflicts::resolve_conflict,
            commands::conflicts::abort_merge,
            commands::conflicts::complete_merge,
            // PTY & Terminal
            commands::pty::spawn_pty,
            commands::pty::kill_pty,
            commands::pty::kill_all_pty,
            commands::pty::cleanup_orphaned_processes,
            commands::pty::kill_port,
            commands::pty::find_available_port,
            commands::pty::get_shell_path,
            // Setup/Onboarding
            commands::setup::get_full_setup_status,
            commands::setup::install_homebrew,
            commands::setup::install_node_via_brew,
            commands::setup::install_git_via_brew,
            commands::setup::install_gh_via_brew,
            commands::setup::start_github_auth,
            commands::setup::start_claude_auth,
            commands::setup::check_claude_auth_status,
            commands::setup::start_vercel_auth,
            commands::setup::cleanup_auth_processes,
            // Assets
            commands::assets::list_assets,
            commands::assets::upload_asset,
            commands::assets::delete_asset,
            commands::assets::rename_asset,
            commands::assets::create_asset_folder,
            // Logging
            logging::get_log_path,
            logging::log_frontend_event,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
