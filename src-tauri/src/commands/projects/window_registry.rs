//! Window management commands for multi-window project support.
//!
//! Opening projects in new windows, registering/unregistering windows,
//! and focusing existing project windows.

use crate::errors::CommandError;
use crate::state::{get_window_for_project, register_project_window, unregister_project_window};
use crate::utils::validate_project_path;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Opens a project in a new window.
/// If the project is already open in another window, focuses that window instead.
/// Returns the window label of the new or existing window.
#[tauri::command]
#[tracing::instrument(skip(app), fields(project = %project_path))]
pub async fn open_project_in_new_window(
    app: AppHandle,
    project_path: String,
    project_name: String,
) -> Result<String, CommandError> {
    // Validate the path is within ~/ShipStudio
    let validated_path = validate_project_path(&project_path)?;
    let project_path = validated_path.to_string_lossy().to_string();

    // Check if project already has a window open
    if let Some(existing_label) = get_window_for_project(&project_path) {
        if let Some(window) = app.get_webview_window(&existing_label) {
            tracing::info!(
                "Project {} already open in window {}, focusing",
                project_path,
                existing_label
            );
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(existing_label);
        }
        // Window was closed but not unregistered - clean up stale entry
        unregister_project_window(&project_path);
    }

    // Generate unique window label using timestamp + random suffix
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let window_label = format!("project-{timestamp}");

    // Encode project path for URL parameter
    let encoded_path = urlencoding::encode(&project_path);
    let url = format!("index.html?project={encoded_path}");

    tracing::info!(
        "Creating new window {} for project {}",
        window_label,
        project_path
    );

    // Create the window
    let mut builder = WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App(url.into()))
        .title(format!("{project_name} - Ship Studio"))
        .inner_size(1400.0, 900.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .transparent(true)
        .initialization_script_for_all_frames(crate::webview_scripts::INSPECTOR_SHIM);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create window: {e}"))?;

    // Register this window in global state
    register_project_window(project_path, window_label.clone());

    Ok(window_label)
}

/// Registers a project for the current window.
/// Called when a project is opened in any window (main or new).
/// This ensures duplicate window detection works correctly.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn register_project_for_window(
    window_label: String,
    project_path: String,
) -> Result<(), CommandError> {
    // Validate the path is within ~/ShipStudio
    let validated_path = validate_project_path(&project_path)?;
    let canonical_path = validated_path.to_string_lossy().to_string();

    register_project_window(canonical_path.clone(), window_label.clone());
    tracing::info!(
        "Registered project {} for window {}",
        canonical_path,
        window_label
    );
    Ok(())
}

/// Unregisters the current window from the project registry.
/// Called when a project window navigates back to the projects list.
/// This allows the same project to be opened in a new window via "Open in New Window".
#[tauri::command]
#[tracing::instrument]
pub async fn unregister_project_from_window(window_label: String) -> Result<(), CommandError> {
    crate::state::unregister_window_by_label(&window_label);
    tracing::info!(
        "Unregistered project from window {} (user went back to projects)",
        window_label
    );
    Ok(())
}

/// Check if a project is already open in another window.
/// Returns the window label if open, or null if not.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_project_window(project_path: String) -> Option<String> {
    // Validate the path is within ~/ShipStudio
    let validated_path = match validate_project_path(&project_path) {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!("get_project_window: invalid path '{}': {}", project_path, e);
            return None;
        }
    };
    let canonical_path = validated_path.to_string_lossy().to_string();

    let result = get_window_for_project(&canonical_path);
    tracing::info!(
        "get_project_window called: project_path={}, result={:?}",
        canonical_path,
        result
    );
    result
}

/// Focus a window by its label.
/// Used to bring an existing project window to the front.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn focus_window_by_label(
    app: AppHandle,
    window_label: String,
) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window.set_focus().map_err(|e| e.to_string())?;
        tracing::info!("Focused window {}", window_label);
        Ok(())
    } else {
        Err((format!("Window {window_label} not found")).into())
    }
}

/// Spawn a new blank Ship Studio window pointed at the dashboard
/// (no `?project=` query param). Used by the "Window → New Window" menu
/// item; not a Tauri command, since it's invoked from a menu handler that
/// already has an `AppHandle`. Returns the new window's label.
#[tracing::instrument(skip(app))]
pub fn spawn_blank_window(app: &AppHandle) -> Result<String, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let window_label = format!("window-{timestamp}");

    let mut builder =
        WebviewWindowBuilder::new(app, &window_label, WebviewUrl::App("index.html".into()))
            .title("Ship Studio")
            .inner_size(1400.0, 900.0)
            .min_inner_size(400.0, 300.0)
            .resizable(true)
            .transparent(true)
            .initialization_script_for_all_frames(crate::webview_scripts::INSPECTOR_SHIM);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create window: {e}"))?;

    tracing::info!("Spawned blank window {}", window_label);
    Ok(window_label)
}
