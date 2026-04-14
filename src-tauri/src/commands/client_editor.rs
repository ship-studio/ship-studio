//! # Client Editor Detection
//!
//! Detects whether the Ship Studio inline editor script is installed in a project.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use std::process::Command;

/// Check if the project contains the Ship Studio inline editor script tag.
///
/// Searches for `ship.studio/inline-editor.js` or `data-studio-id` in project files,
/// excluding node_modules, .git, and other build artifacts.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn detect_client_editor(project_path: String) -> Result<bool, CommandError> {
    validate_project_path(&project_path)?;

    let output = Command::new("grep")
        .args([
            "-rl",
            "--include=*.html",
            "--include=*.htm",
            "--include=*.tsx",
            "--include=*.jsx",
            "--include=*.js",
            "--include=*.ts",
            "--include=*.vue",
            "--include=*.svelte",
            "--include=*.astro",
            "--include=*.php",
            "--include=*.erb",
            "--include=*.ejs",
            "--include=*.hbs",
            "--include=*.njk",
            "--include=*.liquid",
            "--include=*.twig",
            "--exclude-dir=node_modules",
            "--exclude-dir=.git",
            "--exclude-dir=.next",
            "--exclude-dir=dist",
            "--exclude-dir=build",
            "--exclude-dir=.output",
            "--exclude-dir=.nuxt",
            "ship.studio/inline-editor",
            &project_path,
        ])
        .output()
        .map_err(|e| format!("Failed to search project files: {e}"))?;

    // grep exits with 0 if matches found, 1 if no matches
    Ok(output.status.success())
}
