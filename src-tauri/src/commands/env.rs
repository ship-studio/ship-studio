//! # Environment Variables Commands
//!
//! Commands for managing .env files in projects.

use crate::errors::CommandError;
use crate::types::{EnvFile, EnvVar};
use crate::utils::validate_project_path;

#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn list_env_files(project_path: String) -> Result<Vec<EnvFile>, CommandError> {
    let project = validate_project_path(&project_path)?;
    let mut env_files = Vec::new();

    // Common env file names to look for
    let env_names = [
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".env.production",
        ".env.production.local",
        ".env.test",
        ".env.test.local",
    ];

    for name in env_names {
        let env_path = project.join(name);
        if env_path.exists() {
            env_files.push(EnvFile {
                name: name.to_string(),
                path: env_path.to_string_lossy().to_string(),
            });
        }
    }

    Ok(env_files)
}

#[tauri::command]
#[tracing::instrument(skip(file_path), fields(file = %file_path))]
pub async fn read_env_file(file_path: String) -> Result<Vec<EnvVar>, CommandError> {
    let contents = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut vars = Vec::new();

    for line in contents.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Parse KEY=VALUE format
        if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim().to_string();
            let value = line[eq_pos + 1..].trim().to_string();

            // Remove surrounding quotes if present
            let value = if (value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\''))
            {
                value[1..value.len() - 1].to_string()
            } else {
                value
            };

            vars.push(EnvVar { key, value });
        }
    }

    Ok(vars)
}

/// Maximum length for env variable names (bytes)
const MAX_ENV_KEY_LENGTH: usize = 256;
/// Maximum length for env variable values (bytes) - 64KB should be plenty
const MAX_ENV_VALUE_LENGTH: usize = 65536;

/// Writes environment variables to a .env file with validation.
/// Validates that variable names are alphanumeric/underscore and don't start with numbers.
/// Auto-quotes values containing spaces or special characters.
#[tauri::command]
#[tracing::instrument(skip(file_path, vars), fields(file = %file_path, var_count = vars.len()))]
pub async fn write_env_file(file_path: String, vars: Vec<EnvVar>) -> Result<(), CommandError> {
    let mut contents = String::new();

    for var in vars {
        // Validate env variable key: must be alphanumeric or underscore, can't start with number
        if var.key.is_empty() {
            return Err(("Environment variable name cannot be empty".to_string()).into());
        }
        if var.key.len() > MAX_ENV_KEY_LENGTH {
            return Err((format!(
                "Environment variable name too long: {} (max {} characters)",
                var.key, MAX_ENV_KEY_LENGTH
            ))
            .into());
        }
        if !var
            .key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err((format!("Invalid environment variable name: {}. Only letters, numbers, and underscores allowed.", var.key)).into());
        }
        if var.key.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return Err((format!(
                "Environment variable name cannot start with a number: {}",
                var.key
            ))
            .into());
        }

        // Validate value length
        if var.value.len() > MAX_ENV_VALUE_LENGTH {
            return Err((format!(
                "Environment variable value for {} too long (max {} bytes)",
                var.key, MAX_ENV_VALUE_LENGTH
            ))
            .into());
        }

        // Quote values that contain spaces or special characters
        let value = if var.value.contains(' ') || var.value.contains('#') || var.value.contains('=')
        {
            format!("\"{}\"", var.value)
        } else {
            var.value
        };
        contents.push_str(&format!("{}={}\n", var.key, value));
    }

    std::fs::write(&file_path, contents).map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates a new .env file in the project directory.
/// Validates both project path (must be in ShipStudio) and filename.
#[tauri::command]
#[tracing::instrument(skip(project_path, file_name), fields(project = %project_path, file = %file_name))]
pub async fn create_env_file(
    project_path: String,
    file_name: String,
) -> Result<String, CommandError> {
    // Validate project path is inside ShipStudio directory
    let project = validate_project_path(&project_path)?;

    // Validate filename to prevent path traversal attacks
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(("Invalid filename: path separators not allowed".to_string()).into());
    }
    if !file_name.starts_with('.') || !file_name.contains("env") {
        return Err(
            ("Invalid filename: must be an env file (e.g., .env, .env.local)".to_string()).into(),
        );
    }

    let env_path = project.join(&file_name);

    // Double-check the resolved path is still within the project
    if !env_path.starts_with(&project) {
        return Err(("Invalid filename: path traversal detected".to_string()).into());
    }

    if env_path.exists() {
        return Err((format!("{file_name} already exists")).into());
    }

    std::fs::write(&env_path, "").map_err(|e| e.to_string())?;
    Ok(env_path.to_string_lossy().to_string())
}

#[tauri::command]
#[tracing::instrument(skip(file_path), fields(file = %file_path))]
pub async fn delete_env_file(file_path: String) -> Result<(), CommandError> {
    // Validate the file is inside ShipStudio directory
    let path = std::path::Path::new(&file_path);
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let shipstudio_dir = home.join("ShipStudio");

    let canonical = dunce::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))?;
    if !canonical.starts_with(&shipstudio_dir) {
        return Err(
            ("Security error: cannot delete files outside ShipStudio directory".to_string()).into(),
        );
    }

    std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    Ok(())
}
