//! Skill install/remove commands.

use super::extract_skills_cli_error;
use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path};

/// Install a skill using the Skills CLI
/// Runs: npx skills add <package> -y --agent <agent-id>
#[tauri::command]
#[tracing::instrument]
pub async fn install_skill(
    package: String,
    scope: String,
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let skills_agent_id = agent.skills_agent_id.unwrap_or(agent.id);
    let mut cmd = create_command("npx");
    cmd.args([
        "--yes",
        "skills",
        "add",
        &package,
        "-y",
        "--agent",
        skills_agent_id,
    ])
    .env("PATH", get_extended_path())
    .env("HOME", &home)
    .env_remove("npm_config__jsr-registry")
    .env_remove("npm_config_npm-globalconfig")
    .env_remove("npm_config_verify-deps-before-run");

    // Set working directory based on scope
    if scope == "project" {
        if let Some(ref path) = project_path {
            cmd.current_dir(path);
        } else {
            return Err(
                ("Project path required for project-scoped installation".to_string()).into(),
            );
        }
    } else {
        // For user scope, run from home directory so skills install to ~/.agents/skills
        cmd.current_dir(&home);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {e}"))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let details = extract_skills_cli_error(&stdout, &stderr);
        return Err((format!("Failed to install skill: {details}")).into());
    }

    Ok(())
}

/// Remove a skill using the Skills CLI
/// Runs: npx skills remove <package> --agent <agent-id>
#[tauri::command]
#[tracing::instrument]
pub async fn remove_skill(
    package: String,
    scope: String,
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<(), CommandError> {
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let skills_agent_id = agent.skills_agent_id.unwrap_or(agent.id);
    let mut cmd = create_command("npx");
    cmd.args([
        "--yes",
        "skills",
        "remove",
        &package,
        "-y",
        "--agent",
        skills_agent_id,
    ])
    .env("PATH", get_extended_path())
    .env("HOME", &home)
    .env_remove("npm_config__jsr-registry")
    .env_remove("npm_config_npm-globalconfig")
    .env_remove("npm_config_verify-deps-before-run");

    // Set working directory based on scope
    if scope == "project" {
        if let Some(ref path) = project_path {
            cmd.current_dir(path);
        } else {
            return Err(("Project path required for project-scoped removal".to_string()).into());
        }
    } else {
        // For user scope, run from home directory
        cmd.current_dir(&home);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {e}"))?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let details = extract_skills_cli_error(&stdout, &stderr);
        return Err((format!("Failed to remove skill: {details}")).into());
    }

    Ok(())
}
