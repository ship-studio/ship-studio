//! Dependency and package.json script detection — finds which test/lint/typecheck/format
//! scripts are defined in a project and suggests additions based on installed packages.

use super::detect_package_manager_internal;
use crate::errors::CommandError;
use crate::types::{DetectedScripts, PackageManager, ScriptCategory, ScriptSuggestion};
use crate::utils::validate_project_path;
use serde_json::Value;
use tracing::debug;

/// Script patterns for each category
/// First match wins, so more specific patterns should come first
pub(super) const TEST_PATTERNS: &[&str] = &["test", "test:run", "test:unit", "vitest", "jest"];
pub(super) const LINT_PATTERNS: &[&str] = &["lint", "lint:check", "eslint", "lint:strict"];
pub(super) const TYPECHECK_PATTERNS: &[&str] = &[
    "typecheck",
    "type-check",
    "tsc",
    "tsc:check",
    "check:types",
    "types:check",
    "check", // SvelteKit uses "check" for svelte-check
];
pub(super) const FORMAT_PATTERNS: &[&str] = &[
    "format:check",
    "prettier:check",
    "fmt:check",
    "format",
    "prettier",
];

/// Check if a package is installed in dependencies or devDependencies
fn is_package_installed(package_json: &Value, package_name: &str) -> bool {
    let check_deps = |deps_key: &str| -> bool {
        package_json
            .get(deps_key)
            .and_then(|d| d.as_object())
            .map(|deps| deps.contains_key(package_name))
            .unwrap_or(false)
    };
    check_deps("dependencies") || check_deps("devDependencies")
}

/// Generate suggestions for missing scripts based on installed packages
fn generate_suggestions(
    package_json: &Value,
    existing_test: &Option<String>,
    existing_lint: &Option<String>,
    existing_typecheck: &Option<String>,
    existing_format: &Option<String>,
) -> Vec<ScriptSuggestion> {
    let mut suggestions = Vec::new();

    // Test suggestions
    if existing_test.is_none() {
        if is_package_installed(package_json, "vitest") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Test,
                script_name: "test".to_string(),
                script_command: "vitest run".to_string(),
                reason: "vitest is installed".to_string(),
            });
        } else if is_package_installed(package_json, "jest") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Test,
                script_name: "test".to_string(),
                script_command: "jest".to_string(),
                reason: "jest is installed".to_string(),
            });
        }
    }

    // Lint suggestions
    if existing_lint.is_none() {
        if is_package_installed(package_json, "eslint") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Lint,
                script_name: "lint".to_string(),
                script_command: "eslint .".to_string(),
                reason: "eslint is installed".to_string(),
            });
        } else if is_package_installed(package_json, "biome")
            || is_package_installed(package_json, "@biomejs/biome")
        {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Lint,
                script_name: "lint".to_string(),
                script_command: "biome lint .".to_string(),
                reason: "biome is installed".to_string(),
            });
        }
    }

    // Typecheck suggestions
    if existing_typecheck.is_none() {
        // SvelteKit uses svelte-check
        if is_package_installed(package_json, "svelte-check") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Typecheck,
                script_name: "check".to_string(),
                script_command: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json"
                    .to_string(),
                reason: "svelte-check is installed".to_string(),
            });
        } else if is_package_installed(package_json, "typescript") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Typecheck,
                script_name: "typecheck".to_string(),
                script_command: "tsc --noEmit".to_string(),
                reason: "typescript is installed".to_string(),
            });
        }
    }

    // Format suggestions
    if existing_format.is_none() {
        if is_package_installed(package_json, "prettier") {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Format,
                script_name: "format:check".to_string(),
                script_command: "prettier --check .".to_string(),
                reason: "prettier is installed".to_string(),
            });
        } else if is_package_installed(package_json, "biome")
            || is_package_installed(package_json, "@biomejs/biome")
        {
            suggestions.push(ScriptSuggestion {
                category: ScriptCategory::Format,
                script_name: "format:check".to_string(),
                script_command: "biome format --check .".to_string(),
                reason: "biome is installed".to_string(),
            });
        }
    }

    suggestions
}

/// Find the first matching script name from a list of patterns
fn find_script_match(
    scripts: &serde_json::Map<String, Value>,
    patterns: &[&str],
) -> Option<String> {
    // First, try exact matches
    for pattern in patterns {
        if scripts.contains_key(*pattern) {
            return Some(pattern.to_string());
        }
    }

    // Then try prefix matching (e.g., "test:unit" matches "test" category)
    for (script_name, _) in scripts {
        for pattern in patterns {
            // Check if script starts with pattern followed by ":" or "-"
            if script_name.starts_with(pattern)
                && (script_name.len() == pattern.len()
                    || script_name.chars().nth(pattern.len()) == Some(':')
                    || script_name.chars().nth(pattern.len()) == Some('-'))
            {
                return Some(script_name.clone());
            }
        }
    }

    None
}

/// Detect available scripts from package.json
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn detect_health_scripts(project_path: String) -> Result<DetectedScripts, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let package_json_path = validated_path.join("package.json");

    if !package_json_path.exists() {
        return Ok(DetectedScripts {
            package_manager: PackageManager::Npm,
            test: None,
            lint: None,
            typecheck: None,
            format: None,
            has_package_json: false,
            suggestions: Vec::new(),
        });
    }

    // Read and parse package.json
    let contents = std::fs::read_to_string(&package_json_path)
        .map_err(|e| format!("Failed to read package.json: {e}"))?;

    let package_json: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse package.json: {e}"))?;

    // Get scripts object
    let scripts = package_json
        .get("scripts")
        .and_then(|s| s.as_object())
        .cloned()
        .unwrap_or_default();

    // Detect package manager
    let package_manager = detect_package_manager_internal(&validated_path);

    // Find matching scripts for each category
    let test = find_script_match(&scripts, TEST_PATTERNS);
    let lint = find_script_match(&scripts, LINT_PATTERNS);
    let typecheck = find_script_match(&scripts, TYPECHECK_PATTERNS);
    let format = find_script_match(&scripts, FORMAT_PATTERNS);

    // Generate suggestions for missing scripts based on installed packages
    let suggestions = generate_suggestions(&package_json, &test, &lint, &typecheck, &format);

    debug!(
        "Detected scripts - test: {:?}, lint: {:?}, typecheck: {:?}, format: {:?}, pm: {:?}, suggestions: {}",
        test, lint, typecheck, format, package_manager, suggestions.len()
    );

    Ok(DetectedScripts {
        package_manager,
        test,
        lint,
        typecheck,
        format,
        has_package_json: true,
        suggestions,
    })
}

/// Get the package.json contents for a project
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn get_package_json(project_path: String) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    let package_json_path = validated_path.join("package.json");

    if !package_json_path.exists() {
        return Err(("package.json not found".to_string()).into());
    }

    std::fs::read_to_string(&package_json_path).map_err(|e| CommandError::Io {
        message: format!("Failed to read package.json: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_find_script_match_exact() {
        let scripts: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "test": "vitest",
            "lint": "eslint .",
            "build": "next build"
        }))
        .unwrap();

        assert_eq!(
            find_script_match(&scripts, TEST_PATTERNS),
            Some("test".to_string())
        );
        assert_eq!(
            find_script_match(&scripts, LINT_PATTERNS),
            Some("lint".to_string())
        );
    }

    #[test]
    fn test_find_script_match_prefix() {
        let scripts: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "test:unit": "vitest",
            "test:e2e": "playwright",
            "lint:src": "eslint src/"
        }))
        .unwrap();

        // Should find "test:unit" or "test:e2e" for test patterns
        let test_match = find_script_match(&scripts, TEST_PATTERNS);
        assert!(
            test_match == Some("test:unit".to_string())
                || test_match == Some("test:e2e".to_string())
        );

        // Should find "lint:src" for lint patterns
        assert_eq!(
            find_script_match(&scripts, LINT_PATTERNS),
            Some("lint:src".to_string())
        );
    }

    #[test]
    fn test_find_script_match_no_match() {
        let scripts: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "build": "next build",
            "start": "next start"
        }))
        .unwrap();

        assert_eq!(find_script_match(&scripts, TEST_PATTERNS), None);
        assert_eq!(find_script_match(&scripts, LINT_PATTERNS), None);
    }

    #[test]
    fn test_find_script_match_vitest() {
        let scripts: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "vitest": "vitest run"
        }))
        .unwrap();

        assert_eq!(
            find_script_match(&scripts, TEST_PATTERNS),
            Some("vitest".to_string())
        );
    }

    #[test]
    fn test_is_package_installed() {
        let package_json = json!({
            "devDependencies": {
                "typescript": "^5.0.0",
                "eslint": "^8.0.0"
            },
            "dependencies": {
                "react": "^18.0.0"
            }
        });

        assert!(is_package_installed(&package_json, "typescript"));
        assert!(is_package_installed(&package_json, "eslint"));
        assert!(is_package_installed(&package_json, "react"));
        assert!(!is_package_installed(&package_json, "prettier"));
        assert!(!is_package_installed(&package_json, "vitest"));
    }

    #[test]
    fn test_generate_suggestions_typescript() {
        let package_json = json!({
            "devDependencies": {
                "typescript": "^5.0.0"
            }
        });

        let suggestions = generate_suggestions(&package_json, &None, &None, &None, &None);

        // Should suggest typecheck script
        assert!(suggestions
            .iter()
            .any(|s| matches!(s.category, ScriptCategory::Typecheck)));
        let typecheck_suggestion = suggestions
            .iter()
            .find(|s| matches!(s.category, ScriptCategory::Typecheck))
            .unwrap();
        assert_eq!(typecheck_suggestion.script_command, "tsc --noEmit");
        assert_eq!(typecheck_suggestion.reason, "typescript is installed");
    }

    #[test]
    fn test_generate_suggestions_no_duplicate() {
        // If a script already exists, don't suggest it
        let package_json = json!({
            "devDependencies": {
                "typescript": "^5.0.0",
                "eslint": "^8.0.0"
            }
        });

        // typecheck script exists, so shouldn't be suggested
        let existing_typecheck = Some("typecheck".to_string());
        let suggestions =
            generate_suggestions(&package_json, &None, &None, &existing_typecheck, &None);

        // Should not suggest typecheck since it exists
        assert!(!suggestions
            .iter()
            .any(|s| matches!(s.category, ScriptCategory::Typecheck)));
        // Should suggest lint since eslint is installed
        assert!(suggestions
            .iter()
            .any(|s| matches!(s.category, ScriptCategory::Lint)));
    }

    #[test]
    fn test_generate_suggestions_vitest() {
        let package_json = json!({
            "devDependencies": {
                "vitest": "^1.0.0"
            }
        });

        let suggestions = generate_suggestions(&package_json, &None, &None, &None, &None);

        let test_suggestion = suggestions
            .iter()
            .find(|s| matches!(s.category, ScriptCategory::Test))
            .unwrap();
        assert_eq!(test_suggestion.script_command, "vitest run");
    }

    #[test]
    fn test_generate_suggestions_prettier() {
        let package_json = json!({
            "devDependencies": {
                "prettier": "^3.0.0"
            }
        });

        let suggestions = generate_suggestions(&package_json, &None, &None, &None, &None);

        let format_suggestion = suggestions
            .iter()
            .find(|s| matches!(s.category, ScriptCategory::Format))
            .unwrap();
        assert_eq!(format_suggestion.script_command, "prettier --check .");
    }

    #[test]
    fn test_generate_suggestions_biome() {
        let package_json = json!({
            "devDependencies": {
                "@biomejs/biome": "^1.0.0"
            }
        });

        let suggestions = generate_suggestions(&package_json, &None, &None, &None, &None);

        // Should suggest both lint and format for biome
        let lint_suggestion = suggestions
            .iter()
            .find(|s| matches!(s.category, ScriptCategory::Lint))
            .unwrap();
        assert_eq!(lint_suggestion.script_command, "biome lint .");

        let format_suggestion = suggestions
            .iter()
            .find(|s| matches!(s.category, ScriptCategory::Format))
            .unwrap();
        assert_eq!(format_suggestion.script_command, "biome format --check .");
    }
}
