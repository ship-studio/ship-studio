/**
 * Skills command module for Claude Code skills management.
 *
 * Provides commands for:
 * - Listing installed skills from ~/.claude/skills/ and project-level .claude/skills/
 * - Searching for skills via the Skills CLI (npx skills find)
 * - Installing and removing skills via the Skills CLI
 *
 * Skills installed via `npx skills add` are stored in:
 * - ~/.claude/skills/{skill-name}/ (user scope, symlinked from ~/.agents/skills/)
 * - {project}/.claude/skills/{skill-name}/ (project scope)
 *
 * Legacy plugin-based skills are also supported from ~/.claude/plugins/installed_plugins.json
 */
mod install;
mod search;

pub use install::*;
pub use search::*;

/// Strip ANSI escape codes from a string
pub(super) fn strip_ansi_codes(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip until we hit 'm' (end of ANSI sequence)
            while let Some(&next) = chars.peek() {
                chars.next();
                if next == 'm' {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Extract a clean error message from the skills CLI output.
///
/// The skills CLI writes errors to stdout with ANSI codes and box-drawing characters
/// (■, │, └, ◇, ●, etc.). npm/npx may dump unrelated warnings into stderr.
/// This function strips formatting and extracts only error-relevant lines.
pub(super) fn extract_skills_cli_error(stdout: &str, stderr: &str) -> String {
    let clean = strip_ansi_codes(stdout);

    // Replace all non-ASCII characters (box-drawing, spinners) with spaces,
    // then normalize whitespace per line.
    let error_lines: Vec<String> = clean
        .lines()
        .map(|l| {
            l.chars()
                .map(|c| if c.is_ascii() { c } else { ' ' })
                .collect::<String>()
        })
        .map(|l| l.trim().to_string())
        .filter(|l| {
            !l.is_empty()
                && (l.contains("Failed")
                    || l.contains("failed")
                    || l.contains("Authentication")
                    || l.contains("Invalid")
                    || l.contains("No matching")
                    || l.contains("not found")
                    || l.contains("Valid agents")
                    || l.contains("Available skills"))
        })
        .collect();

    if !error_lines.is_empty() {
        return error_lines.join(". ");
    }

    // Fall back to stderr, filtering out npm warning lines
    let filtered_stderr: Vec<&str> = stderr
        .lines()
        .filter(|l| !l.trim_start().starts_with("npm warn") && !l.trim().is_empty())
        .collect();

    if !filtered_stderr.is_empty() {
        return filtered_stderr.join("\n");
    }

    "Unknown error".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_skills_cli_error_from_stdout() {
        let stdout = "\x1b[38;5;250m███████╗\x1b[0m\n│\n■  Failed to clone repository\n│\n│  Authentication failed for https://github.com/foo/bar.git.\n│\n└  Installation failed\n■  Canceled\n";
        let stderr = "npm warn Unknown env config \"_jsr-registry\".\n";
        let result = extract_skills_cli_error(stdout, stderr);
        assert!(
            result.contains("Failed to clone repository"),
            "got: {result}"
        );
        assert!(result.contains("Authentication failed"), "got: {result}");
        assert!(!result.contains("npm warn"), "got: {result}");
    }

    #[test]
    fn test_extract_skills_cli_error_invalid_agent() {
        let stdout = "■  Invalid agents: claude\n●  Valid agents: claude-code, codex\n";
        let stderr = "";
        let result = extract_skills_cli_error(stdout, stderr);
        assert!(result.contains("Invalid agents: claude"), "got: {result}");
        assert!(result.contains("Valid agents:"), "got: {result}");
    }

    #[test]
    fn test_extract_skills_cli_error_filters_npm_warnings() {
        let stdout = "";
        let stderr = "npm warn Unknown env config \"_jsr-registry\".\nnpm warn config\n";
        let result = extract_skills_cli_error(stdout, stderr);
        assert_eq!(result, "Unknown error");
    }

    #[test]
    fn test_strip_ansi_codes() {
        let input = "\x1b[38;5;145mvercel-labs/agent-skills@test\x1b[0m";
        let result = strip_ansi_codes(input);
        assert_eq!(result, "vercel-labs/agent-skills@test");
    }
}
