//! # AI Generation Commands
//!
//! Commands for AI-powered features like PR description generation.

use crate::agent::get_active_agent;
use crate::commands::claude::find_agent_binary;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::GeneratedPR;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use tracing::{debug, error, info, warn};

/// Maximum diff size in bytes to send to Claude (~40KB)
const MAX_DIFF_SIZE: usize = 40_000;

/// Timeout for the underlying AI agent CLI call. Claude can be slow, so 60s.
const AGENT_CLI_TIMEOUT_SECS: u64 = 60;

/// Gather git context and generate a PR title and description using Claude CLI.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, base = %base_branch))]
pub async fn generate_pr_description(
    project_path: String,
    base_branch: String,
) -> Result<GeneratedPR, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let agent = get_active_agent();
    let agent_path = find_agent_binary().ok_or_else(|| {
        format!(
            "{} CLI is not installed. Install {} to use AI generation.",
            agent.display_name, agent.display_name
        )
    })?;

    info!(
        "Generating PR description for {} against {}",
        validated_path.display(),
        base_branch
    );

    // Gather context in parallel-ish (all quick git commands)
    let branch_name = get_branch_name(&validated_path)?;
    let commits = get_commit_messages(&validated_path, &base_branch)?;
    let diff_stat = get_diff_stat(&validated_path, &base_branch)?;
    let diff = get_diff(&validated_path, &base_branch)?;

    if commits.is_empty() && diff.is_empty() {
        return Err(
            ("No changes found between this branch and the base branch.".to_string()).into(),
        );
    }

    // Truncate diff if too large
    let truncated_diff = if diff.len() > MAX_DIFF_SIZE {
        warn!(
            "Diff is {} bytes, truncating to {}",
            diff.len(),
            MAX_DIFF_SIZE
        );
        let truncated = &diff[..MAX_DIFF_SIZE];
        // Try to cut at a newline boundary
        match truncated.rfind('\n') {
            Some(pos) => format!(
                "{}\n\n[... diff truncated, {} more bytes ...]",
                &truncated[..pos],
                diff.len() - pos
            ),
            None => format!("{truncated}\n\n[... diff truncated ...]"),
        }
    } else {
        diff
    };

    let prompt = build_prompt(
        &branch_name,
        &base_branch,
        &commits,
        &diff_stat,
        &truncated_diff,
    );

    debug!("Calling {} CLI for PR generation", agent.display_name);

    let mut args: Vec<&str> = agent.print_mode_flags.to_vec();
    args.push(&prompt);

    let mut cmd = create_command(&agent_path);
    cmd.args(&args)
        .env("PATH", get_extended_path())
        .current_dir(&validated_path);
    let tokio_cmd = tokio::process::Command::from(cmd);
    let output = run_with_timeout(
        tokio_cmd,
        format!("{} CLI", agent.display_name),
        AGENT_CLI_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("{} CLI failed: {}", agent.display_name, stderr);
        return Err((format!("{} CLI failed: {}", agent.display_name, stderr)).into());
    }

    let response = String::from_utf8_lossy(&output.stdout).to_string();
    debug!("Claude response length: {} chars", response.len());

    parse_response(&response).map_err(CommandError::from)
}

fn get_branch_name(path: &std::path::Path) -> Result<String, CommandError> {
    let output = create_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(("Failed to get current branch name".to_string()).into());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_commit_messages(path: &std::path::Path, base: &str) -> Result<String, String> {
    let output = create_command("git")
        .args([
            "--no-pager",
            "log",
            &format!("{base}..HEAD"),
            "--pretty=format:%s",
            "--no-merges",
        ])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    // Not an error if there are no commits - diff might still exist
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_diff_stat(path: &std::path::Path, base: &str) -> Result<String, String> {
    let output = create_command("git")
        .args(["--no-pager", "diff", &format!("{base}...HEAD"), "--stat"])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_diff(path: &std::path::Path, base: &str) -> Result<String, String> {
    let output = create_command("git")
        .args(["--no-pager", "diff", &format!("{base}...HEAD")])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_prompt(
    branch_name: &str,
    base_branch: &str,
    commits: &str,
    diff_stat: &str,
    diff: &str,
) -> String {
    format!(
        r###"Generate a pull request title and description for these code changes.

Branch: {branch_name}
Base branch: {base_branch}

## Commits
{commits}

## Changed Files
{diff_stat}

## Diff
{diff}

Respond in EXACTLY this format (the TITLE: and DESCRIPTION: prefixes are required):
TITLE: <concise title under 72 chars, imperative mood, no period at end>
DESCRIPTION:
<markdown description with:
- A brief summary (1-2 sentences) explaining what this PR does and why
- A "## Changes" section with a bullet list of key modifications
- A "## Breaking Changes" section only if there are breaking changes, otherwise omit it>
"###
    )
}

fn parse_response(response: &str) -> Result<GeneratedPR, String> {
    let response = response.trim();

    if response.is_empty() {
        return Err("AI returned an empty response".to_string());
    }

    // Find TITLE: line
    let title = if let Some(title_start) = response.find("TITLE:") {
        let after_prefix = &response[title_start + 6..];
        let title_end = after_prefix.find('\n').unwrap_or(after_prefix.len());
        after_prefix[..title_end].trim().to_string()
    } else {
        // Fallback: use the first line as title
        response
            .lines()
            .next()
            .unwrap_or("Update code")
            .trim()
            .to_string()
    };

    // Find DESCRIPTION: section
    let description = if let Some(desc_start) = response.find("DESCRIPTION:") {
        let after_prefix = &response[desc_start + 12..];
        after_prefix.trim().to_string()
    } else {
        // Fallback: use everything after the first line
        let lines: Vec<&str> = response.lines().collect();
        if lines.len() > 1 {
            lines[1..].join("\n").trim().to_string()
        } else {
            String::new()
        }
    };

    if title.is_empty() {
        return Err("Failed to parse AI response: no title found".to_string());
    }

    info!("Generated PR title: {}", title);

    Ok(GeneratedPR { title, description })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_response_standard() {
        let response = "TITLE: Add user authentication flow\nDESCRIPTION:\nThis PR adds a new login page.\n\n## Changes\n- Added login component\n- Added auth service";
        let result = parse_response(response).unwrap();
        assert_eq!(result.title, "Add user authentication flow");
        assert!(result.description.contains("## Changes"));
    }

    #[test]
    fn test_parse_response_with_extra_whitespace() {
        let response =
            "\n  TITLE:   Fix broken tests  \n  DESCRIPTION:\n  Fixed flaky unit tests.\n";
        let result = parse_response(response).unwrap();
        assert_eq!(result.title, "Fix broken tests");
        assert!(result.description.contains("Fixed flaky unit tests"));
    }

    #[test]
    fn test_parse_response_fallback_no_markers() {
        let response = "Some title here\nSome description here\nMore description";
        let result = parse_response(response).unwrap();
        assert_eq!(result.title, "Some title here");
        assert!(result.description.contains("Some description here"));
    }

    #[test]
    fn test_parse_response_empty() {
        let response = "";
        let result = parse_response(response);
        assert!(result.is_err());
    }
}
