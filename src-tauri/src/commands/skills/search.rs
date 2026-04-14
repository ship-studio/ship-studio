//! Skill listing and search commands.

use super::strip_ansi_codes;
use crate::errors::CommandError;
use crate::utils::{create_command, get_extended_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Represents a Claude skill
#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSkill {
    /// Skill name (command without the leading /)
    pub name: String,
    /// Short description extracted from the skill file
    pub description: String,
    /// The plugin this skill belongs to
    pub plugin: String,
    /// Whether this is a user-level or project-level skill
    pub scope: String,
}

/// Plugin installation info from installed_plugins.json
#[derive(Debug, Deserialize)]
struct PluginInstall {
    scope: String,
    #[serde(rename = "installPath")]
    install_path: String,
    #[serde(rename = "projectPath")]
    project_path: Option<String>,
}

/// Structure of installed_plugins.json
#[derive(Debug, Deserialize)]
struct InstalledPlugins {
    plugins: HashMap<String, Vec<PluginInstall>>,
}

/// Parse SKILL.md frontmatter to extract name and description
fn parse_skill_md(content: &str) -> Option<(String, String)> {
    // SKILL.md has YAML frontmatter between --- markers
    let content = content.trim();
    if !content.starts_with("---") {
        return None;
    }

    // Find the closing ---
    let rest = &content[3..];
    let end_marker = rest.find("---")?;
    let frontmatter = &rest[..end_marker];

    let mut name = None;
    let mut description = None;

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("name:") {
            name = Some(val.trim().to_string());
        } else if let Some(val) = line.strip_prefix("description:") {
            description = Some(val.trim().to_string());
        }
    }

    match (name, description) {
        (Some(n), Some(d)) => Some((n, d)),
        (Some(n), None) => Some((n, "Custom skill".to_string())),
        _ => None,
    }
}

/// Read skills from a plugin's skills directory
fn read_skills_from_plugin(plugin_path: &str, plugin_name: &str, scope: &str) -> Vec<ClaudeSkill> {
    let mut skills = Vec::new();
    let skills_dir = PathBuf::from(plugin_path).join("skills");

    if !skills_dir.exists() || !skills_dir.is_dir() {
        return skills;
    }

    if let Ok(entries) = fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            // Look for SKILL.md (case-insensitive)
            let skill_md = path.join("SKILL.md");
            let skill_md_lower = path.join("skill.md");

            let skill_file = if skill_md.exists() {
                Some(skill_md)
            } else if skill_md_lower.exists() {
                Some(skill_md_lower)
            } else {
                None
            };

            if let Some(skill_file) = skill_file {
                if let Ok(content) = fs::read_to_string(&skill_file) {
                    if let Some((name, description)) = parse_skill_md(&content) {
                        skills.push(ClaudeSkill {
                            name,
                            description,
                            plugin: plugin_name.to_string(),
                            scope: scope.to_string(),
                        });
                    }
                }
            }
        }
    }

    // Sort skills alphabetically
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// List all available Claude skills from installed plugins and skills directory
#[tauri::command]
#[tracing::instrument]
pub fn list_claude_skills(
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Vec<ClaudeSkill> {
    let mut all_skills = Vec::new();
    let agent = agent_id
        .as_deref()
        .map(crate::agent::get_agent_by_id)
        .unwrap_or_else(crate::agent::get_active_agent);

    let Some(home) = dirs::home_dir() else {
        return all_skills;
    };

    // 1. Check ~/{auth_config_dir}/skills/ for skills installed via skills CLI (user scope)
    let skills_dir_name = agent.skills_dir_name.unwrap_or("skills");
    let skills_dir = home.join(agent.auth_config_dir).join(skills_dir_name);
    if skills_dir.exists() && skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let skill_name = entry.file_name().to_string_lossy().to_string();

                // Look for SKILL.md
                let skill_md = path.join("SKILL.md");
                if skill_md.exists() {
                    if let Ok(content) = fs::read_to_string(&skill_md) {
                        if let Some((name, description)) = parse_skill_md(&content) {
                            all_skills.push(ClaudeSkill {
                                name,
                                description,
                                plugin: skill_name,
                                scope: "user".to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Check project-level {auth_config_dir}/skills/ if project_path provided
    if let Some(ref proj_path) = project_path {
        let project_skills_dir = PathBuf::from(proj_path)
            .join(agent.auth_config_dir)
            .join(skills_dir_name);
        if project_skills_dir.exists() && project_skills_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&project_skills_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }

                    let skill_name = entry.file_name().to_string_lossy().to_string();

                    // Look for SKILL.md
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Ok(content) = fs::read_to_string(&skill_md) {
                            if let Some((name, description)) = parse_skill_md(&content) {
                                all_skills.push(ClaudeSkill {
                                    name,
                                    description,
                                    plugin: skill_name,
                                    scope: "project".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Check installed_plugins.json for legacy plugin-based skills
    let plugins_json = home
        .join(agent.auth_config_dir)
        .join("plugins")
        .join("installed_plugins.json");

    if plugins_json.exists() {
        if let Ok(content) = fs::read_to_string(&plugins_json) {
            if let Ok(installed) = serde_json::from_str::<InstalledPlugins>(&content) {
                for (plugin_id, installs) in installed.plugins {
                    let plugin_name = plugin_id.split('@').next().unwrap_or(&plugin_id);

                    for install in installs {
                        if install.scope == "project" {
                            if let Some(ref proj_path) = project_path {
                                if let Some(ref plugin_proj_path) = install.project_path {
                                    if proj_path != plugin_proj_path {
                                        continue;
                                    }
                                }
                            } else {
                                continue;
                            }
                        }

                        let plugin_skills = read_skills_from_plugin(
                            &install.install_path,
                            plugin_name,
                            &install.scope,
                        );
                        all_skills.extend(plugin_skills);
                    }
                }
            }
        }
    }

    // Sort all skills alphabetically and deduplicate by name
    all_skills.sort_by(|a, b| a.name.cmp(&b.name));
    all_skills.dedup_by(|a, b| a.name == b.name);
    all_skills
}

/// Represents a skill search result from the Skills CLI
#[derive(Debug, Serialize, Clone)]
pub struct SkillSearchResult {
    /// Skill name
    pub name: String,
    /// Package identifier (e.g., "owner/repo")
    pub package: String,
    /// Short description of the skill
    pub description: String,
    /// Number of installs (if available)
    pub installs: Option<u64>,
}

/// Check if the Skills CLI is available (npx skills --version)
#[tauri::command]
#[tracing::instrument]
pub async fn check_skills_cli() -> bool {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    let output = create_command("npx")
        .args(["--yes", "skills", "--version"])
        .env("PATH", get_extended_path())
        .env("HOME", &home)
        .output();

    match output {
        Ok(result) => result.status.success(),
        Err(_) => false,
    }
}

/// Search for skills using the Skills CLI
/// Runs: npx skills find "<query>"
#[tauri::command]
#[tracing::instrument]
pub async fn search_skills(query: String) -> Result<Vec<SkillSearchResult>, CommandError> {
    // Get HOME directory for proper npm config resolution
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();

    // Use --yes to ensure we always run the latest version
    let output = create_command("npx")
        .args(["--yes", "skills", "find", &query])
        .env("PATH", get_extended_path())
        .env("HOME", &home)
        .env_remove("npm_config__jsr-registry")
        .env_remove("npm_config_npm-globalconfig")
        .env_remove("npm_config_verify-deps-before-run")
        .output()
        .map_err(|e| format!("Failed to run skills CLI: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        // If no results found, return empty array instead of error
        if stderr.contains("No skills found") || stdout.is_empty() {
            return Ok(Vec::new());
        }
        return Err((format!("Skills search failed: {stderr}")).into());
    }

    parse_skills_find_output(&stdout)
}

/// Parse the output of `npx skills find` command
/// The actual format from the CLI is:
/// ```text
/// owner/repo@skill-name
/// └ https://skills.sh/...
/// ```
fn parse_skills_find_output(output: &str) -> Result<Vec<SkillSearchResult>, CommandError> {
    let mut results = Vec::new();

    // Strip ANSI color codes
    let clean_output = strip_ansi_codes(output);

    for line in clean_output.lines() {
        let line = line.trim();

        // Skip empty lines, banner lines, and URL lines
        if line.is_empty()
            || line.starts_with("└")
            || line.starts_with("Install with")
            || line.contains("███")
            || line.contains("═══")
            || line.contains("╔")
            || line.contains("╗")
            || line.contains("╚")
            || line.contains("╝")
        {
            continue;
        }

        // Parse skill entry: owner/repo@skill-name
        if line.contains('/') && line.contains('@') {
            if let Some(result) = parse_skill_entry(line) {
                results.push(result);
            }
        }
    }

    Ok(results)
}

/// Parse a skill entry line: owner/repo@skill-name [<count> installs]
fn parse_skill_entry(line: &str) -> Option<SkillSearchResult> {
    let line = line.trim();

    // The package identifier never contains spaces, so split on first space
    // to separate "owner/repo@skill-name" from optional "98.5K installs"
    let (package_str, rest) = match line.find(' ') {
        Some(idx) => (&line[..idx], Some(line[idx..].trim())),
        None => (line, None),
    };

    let at_pos = package_str.find('@')?;
    let repo_part = &package_str[..at_pos];
    let skill_name = &package_str[at_pos + 1..];

    // Validate repo_part has owner/repo format
    repo_part.find('/')?;

    let package = package_str.to_string();
    let name = skill_name.replace('-', " ").replace(':', " - ");
    let installs = rest.and_then(parse_install_count);

    Some(SkillSearchResult {
        name,
        package,
        description: String::new(),
        installs,
    })
}

/// Parse install count strings like "98.5K installs", "1.2M installs", "1234 installs"
fn parse_install_count(s: &str) -> Option<u64> {
    let s = s.trim().trim_end_matches("installs").trim();
    if s.is_empty() {
        return None;
    }

    let (num_str, multiplier) = if let Some(n) = s.strip_suffix('K') {
        (n, 1_000.0)
    } else if let Some(n) = s.strip_suffix('M') {
        (n, 1_000_000.0)
    } else {
        (s, 1.0)
    };

    num_str.parse::<f64>().ok().map(|n| (n * multiplier) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill_entry() {
        let line = "vercel-labs/agent-skills@vercel-react-best-practices";
        let result = parse_skill_entry(line);
        assert!(result.is_some());
        let skill = result.unwrap();
        assert_eq!(
            skill.package,
            "vercel-labs/agent-skills@vercel-react-best-practices"
        );
        assert_eq!(skill.name, "vercel react best practices");
        assert_eq!(skill.installs, None);
    }

    #[test]
    fn test_parse_skill_entry_with_installs() {
        let line = "anthropic/skills@frontend-design 98.5K installs";
        let result = parse_skill_entry(line);
        assert!(result.is_some());
        let skill = result.unwrap();
        assert_eq!(skill.package, "anthropic/skills@frontend-design");
        assert_eq!(skill.name, "frontend design");
        assert_eq!(skill.installs, Some(98500));
    }

    #[test]
    fn test_parse_skill_entry_with_colon() {
        let line = "google-labs-code/stitch-skills@react:components";
        let result = parse_skill_entry(line);
        assert!(result.is_some());
        let skill = result.unwrap();
        assert_eq!(
            skill.package,
            "google-labs-code/stitch-skills@react:components"
        );
        assert_eq!(skill.name, "react - components");
    }

    #[test]
    fn test_parse_install_count() {
        assert_eq!(parse_install_count("98.5K installs"), Some(98500));
        assert_eq!(parse_install_count("1.2M installs"), Some(1200000));
        assert_eq!(parse_install_count("1234 installs"), Some(1234));
        assert_eq!(parse_install_count(""), None);
        assert_eq!(parse_install_count("installs"), None);
    }

    #[test]
    fn test_parse_skills_find_output() {
        let output = r#"
vercel-labs/agent-skills@vercel-react-best-practices
└ https://skills.sh/vercel-labs/agent-skills

callstackincubator/agent-skills@react-native-best-practices
└ https://skills.sh/callstackincubator/agent-skills
"#;
        let results = parse_skills_find_output(output).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].package,
            "vercel-labs/agent-skills@vercel-react-best-practices"
        );
        assert_eq!(
            results[1].package,
            "callstackincubator/agent-skills@react-native-best-practices"
        );
    }

    #[test]
    fn test_parse_skill_md() {
        let content = r#"---
name: brand-guidelines
description: Applies brand colors and typography to artifacts.
license: MIT
---

# Brand Styling

Content here...
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (name, desc) = result.unwrap();
        assert_eq!(name, "brand-guidelines");
        assert_eq!(desc, "Applies brand colors and typography to artifacts.");
    }

    #[test]
    fn test_parse_skill_md_no_description() {
        let content = r#"---
name: my-skill
---
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (name, desc) = result.unwrap();
        assert_eq!(name, "my-skill");
        assert_eq!(desc, "Custom skill");
    }

    #[test]
    fn test_parse_skill_md_long_description() {
        let content = r#"---
name: verbose-skill
description: This is a very long description that should not be truncated because the frontend handles display truncation via CSS.
---
"#;
        let result = parse_skill_md(content);
        assert!(result.is_some());
        let (_, desc) = result.unwrap();
        assert_eq!(desc, "This is a very long description that should not be truncated because the frontend handles display truncation via CSS.");
    }
}
