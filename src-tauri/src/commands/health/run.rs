//! Health check execution and persisted result storage.
//!
//! These commands run test/lint/typecheck/format scripts in a project and save
//! the results to `.shipstudio/project.json` so the UI can display last-run
//! status across app restarts.

use super::detect_package_manager_internal;
use crate::errors::CommandError;
use crate::types::{
    HealthCheckResult, HealthCheckStatus, PackageManager, ProjectMetadata, ScriptCategory,
};
use crate::utils::{create_command, get_extended_path, validate_project_path};
use std::path::Path;
use std::time::Instant;
use tracing::{error, info, warn};

/// Run a health check script and return the result
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn run_health_script(
    project_path: String,
    category: ScriptCategory,
    script_name: String,
) -> Result<HealthCheckResult, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    // Detect package manager
    let package_manager = detect_package_manager_internal(&validated_path);
    let pm_cmd = match package_manager {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Yarn => "yarn",
        PackageManager::Npm => "npm",
        PackageManager::Bun => "bun",
    };

    info!(
        "Running health check: {} run {} in {}",
        pm_cmd,
        script_name,
        validated_path.display()
    );

    let start = Instant::now();

    // Build the command
    let mut cmd = create_command(pm_cmd);
    cmd.arg("run").arg(&script_name);
    cmd.current_dir(&validated_path);
    cmd.env("PATH", get_extended_path());
    cmd.env("FORCE_COLOR", "0"); // Disable color codes for cleaner output

    // Run the command
    let output = cmd.output().map_err(|e| {
        error!("Failed to execute {} run {}: {}", pm_cmd, script_name, e);
        format!("Failed to run script: {e}")
    })?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let status = if output.status.success() {
        "pass".to_string()
    } else {
        "fail".to_string()
    };

    info!(
        "Health check {} completed: status={}, exit_code={}, duration={}ms",
        script_name, status, exit_code, duration_ms
    );

    let result = HealthCheckResult {
        status,
        last_run: chrono::Utc::now().to_rfc3339(),
        duration_ms,
        stdout,
        stderr,
        exit_code,
        script_name: script_name.clone(),
        category: category.clone(),
    };

    // Save result to project metadata
    if let Err(e) = save_health_result(&validated_path, &category, &result).await {
        warn!("Failed to save health result to metadata: {}", e);
    }

    Ok(result)
}

/// Save a health check result to project metadata
async fn save_health_result(
    project_path: &Path,
    category: &ScriptCategory,
    result: &HealthCheckResult,
) -> Result<(), CommandError> {
    let metadata_path = project_path.join(".shipstudio").join("project.json");

    // Read existing metadata or create default
    let mut metadata = if metadata_path.exists() {
        let contents = std::fs::read_to_string(&metadata_path)
            .map_err(|e| format!("Failed to read metadata: {e}"))?;
        serde_json::from_str::<ProjectMetadata>(&contents).unwrap_or_default()
    } else {
        ProjectMetadata::default()
    };

    // Initialize health status if needed
    if metadata.health.is_none() {
        metadata.health = Some(HealthCheckStatus::default());
    }

    // Update the appropriate category
    if let Some(health) = &mut metadata.health {
        match category {
            ScriptCategory::Test => health.test = Some(result.clone()),
            ScriptCategory::Lint => health.lint = Some(result.clone()),
            ScriptCategory::Typecheck => health.typecheck = Some(result.clone()),
            ScriptCategory::Format => health.format = Some(result.clone()),
        }
    }

    // Ensure .shipstudio directory exists
    let shipstudio_dir = project_path.join(".shipstudio");
    if !shipstudio_dir.exists() {
        std::fs::create_dir_all(&shipstudio_dir)
            .map_err(|e| format!("Failed to create .shipstudio directory: {e}"))?;
    }

    // Write updated metadata
    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write metadata: {e}"))?;

    Ok(())
}

/// Get stored health check status from project metadata
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_health_status(
    project_path: String,
) -> Result<Option<HealthCheckStatus>, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let metadata_path = validated_path.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read metadata: {e}"))?;

    let metadata: ProjectMetadata =
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse metadata: {e}"))?;

    Ok(metadata.health)
}

/// Clear health check results for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn clear_health_status(project_path: String) -> Result<(), CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let metadata_path = validated_path.join(".shipstudio").join("project.json");

    if !metadata_path.exists() {
        return Ok(());
    }

    let contents = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read metadata: {e}"))?;

    let mut metadata: ProjectMetadata =
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse metadata: {e}"))?;

    metadata.health = None;

    let contents = serde_json::to_string_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    std::fs::write(&metadata_path, contents)
        .map_err(|e| format!("Failed to write metadata: {e}"))?;

    Ok(())
}
