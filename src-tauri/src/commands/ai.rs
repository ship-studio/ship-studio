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

/// Timeout for commit-message generation. Shorter than PR generation since this
/// runs on every publish and a commit subject is a small, fast request.
const COMMIT_MSG_CLI_TIMEOUT_SECS: u64 = 30;

/// Fallback commit message used when AI generation is unavailable or fails.
pub const DEFAULT_COMMIT_MESSAGE: &str = "Update from Ship Studio";

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

    let truncated_diff = truncate_diff(&diff);

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

/// Truncate a diff to [`MAX_DIFF_SIZE`] at a newline boundary, appending a
/// marker noting how many bytes were dropped. Returns the diff unchanged when
/// it already fits. The cut is floored to a UTF-8 char boundary so slicing a
/// multi-byte sequence can never panic.
fn truncate_diff(diff: &str) -> String {
    if diff.len() <= MAX_DIFF_SIZE {
        return diff.to_string();
    }
    warn!(
        "Diff is {} bytes, truncating to {}",
        diff.len(),
        MAX_DIFF_SIZE
    );
    let mut end = MAX_DIFF_SIZE;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = &diff[..end];
    // Try to cut at a newline boundary for cleaner output
    match truncated.rfind('\n') {
        Some(pos) => format!(
            "{}\n\n[... diff truncated, {} more bytes ...]",
            &truncated[..pos],
            diff.len() - pos
        ),
        None => format!("{truncated}\n\n[... diff truncated ...]"),
    }
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

// ---------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------

/// Generate a commit message for the project's current uncommitted changes.
///
/// Exposed as a command for potential UI use (e.g. a "regenerate" button); the
/// publish flow generates messages internally via [`resolve_commit_message`].
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path))]
pub async fn generate_commit_message(project_path: String) -> Result<String, CommandError> {
    let validated_path = validate_project_path(&project_path)?;
    generate_commit_message_for_path(&validated_path).await
}

/// Resolve the commit message for a publish action: use the caller-provided
/// message when present and non-empty, otherwise auto-generate one from the
/// working tree, falling back to [`DEFAULT_COMMIT_MESSAGE`] if generation is
/// unavailable (no headless agent, agent not installed, nothing to summarize,
/// CLI failure/timeout). This never errors so publishing always proceeds.
pub async fn resolve_commit_message(path: &std::path::Path, provided: Option<String>) -> String {
    if let Some(message) = provided {
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    match generate_commit_message_for_path(path).await {
        Ok(message) => {
            info!(message = %message, "Auto-generated commit message");
            message
        }
        Err(e) => {
            debug!(error = %e, "Falling back to default commit message");
            DEFAULT_COMMIT_MESSAGE.to_string()
        }
    }
}

/// Generate a concise, single-line commit subject from the project's current
/// uncommitted changes using the active agent CLI in print mode.
///
/// Returns an error (so callers fall back to a static default) when the active
/// agent has no headless print mode (only Claude does today), the agent CLI
/// isn't installed, there's nothing to summarize, or the CLI fails/times out.
pub async fn generate_commit_message_for_path(
    path: &std::path::Path,
) -> Result<String, CommandError> {
    let agent = get_active_agent();

    // Only agents with a real headless print mode can run non-interactively.
    // Codex/Opencode have no print flag today, so we don't risk launching an
    // interactive session that would just hang until the timeout.
    if agent.print_mode_flags.is_empty() {
        return Err(format!(
            "{} has no headless print mode; cannot auto-generate commit message",
            agent.display_name
        )
        .into());
    }

    let agent_path = find_agent_binary()
        .ok_or_else(|| format!("{} CLI is not installed", agent.display_name))?;

    // Cheap guard: if nothing changed, skip the agent call entirely.
    let status = git_status_porcelain(path)?;
    if status.trim().is_empty() {
        return Err("No changes to summarize".to_string().into());
    }
    let diff = truncate_diff(&git_working_diff(path));
    let prompt = build_commit_prompt(&status, &diff);

    debug!("Calling {} CLI for commit message", agent.display_name);

    let mut args: Vec<&str> = agent.print_mode_flags.to_vec();
    args.push(&prompt);

    let mut cmd = create_command(&agent_path);
    cmd.args(&args)
        .env("PATH", get_extended_path())
        .current_dir(path);
    let tokio_cmd = tokio::process::Command::from(cmd);
    let output = run_with_timeout(
        tokio_cmd,
        format!("{} CLI", agent.display_name),
        COMMIT_MSG_CLI_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("{} CLI failed: {}", agent.display_name, stderr);
        return Err(format!("{} CLI failed: {}", agent.display_name, stderr).into());
    }

    let response = String::from_utf8_lossy(&output.stdout).to_string();
    parse_commit_message(&response).map_err(CommandError::from)
}

fn git_status_porcelain(path: &std::path::Path) -> Result<String, CommandError> {
    let output = create_command("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(CommandError::from)?;
    if !output.status.success() {
        return Err("Failed to read git status".to_string().into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Working-tree diff against HEAD (all tracked changes, staged or not). On an
/// unborn branch (no commits) `git diff HEAD` fails; we return whatever stdout
/// it produced (empty) and let the porcelain file list carry the context.
fn git_working_diff(path: &std::path::Path) -> String {
    create_command("git")
        .args(["--no-pager", "diff", "HEAD"])
        .current_dir(path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

fn build_commit_prompt(status: &str, diff: &str) -> String {
    format!(
        r###"Write a single-line git commit message summarizing these uncommitted changes.

## Files changed (git status --porcelain)
{status}

## Diff (git diff HEAD)
{diff}

Rules:
- Output ONLY the commit subject line — no body, no quotes, no backticks, no "TITLE:" or "Subject:" prefix, no surrounding explanation.
- Imperative mood, under 72 characters, capitalized, no trailing period.
- Optionally use a conventional-commit prefix (feat:, fix:, chore:, docs:, refactor:) when it clearly fits.
- Describe what changed and why at a high level; do not just list filenames.
"###
    )
}

/// Extract a clean single-line subject from the agent's raw stdout, stripping
/// the wrappers models tend to add (blank lines, quotes/backticks, label
/// prefixes, trailing period) and capping the length.
fn parse_commit_message(response: &str) -> Result<String, String> {
    // First non-empty line — agents sometimes emit a leading blank line.
    let line = response
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "AI returned an empty commit message".to_string())?;

    // Strip wrappers the model tends to add — surrounding quotes/backticks and a
    // leading label (which may itself be wrapped in quotes). Iterate to a
    // fixpoint so `Subject: "Fix bug"` peels in either order.
    let mut msg = line;
    loop {
        let before = msg;
        msg = msg
            .trim_matches(|c| c == '`' || c == '"' || c == '\'')
            .trim();
        for prefix in [
            "subject:",
            "commit message:",
            "commit:",
            "message:",
            "title:",
        ] {
            if msg.len() >= prefix.len() && msg[..prefix.len()].eq_ignore_ascii_case(prefix) {
                msg = msg[prefix.len()..].trim();
                break;
            }
        }
        if msg == before {
            break;
        }
    }

    // Conventional subjects omit the trailing period.
    let msg = msg.trim_end_matches('.').trim();

    if msg.is_empty() {
        return Err("AI returned an empty commit message".to_string());
    }

    // Hard cap so a runaway response can't produce an enormous subject.
    const MAX_SUBJECT_LEN: usize = 100;
    if msg.chars().count() <= MAX_SUBJECT_LEN {
        return Ok(msg.to_string());
    }
    let truncated: String = msg.chars().take(MAX_SUBJECT_LEN).collect();
    Ok(match truncated.rfind(' ') {
        Some(pos) => truncated[..pos].to_string(),
        None => truncated,
    })
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

    #[test]
    fn test_parse_commit_message_plain() {
        assert_eq!(
            parse_commit_message("Add force_static_serve flag").unwrap(),
            "Add force_static_serve flag"
        );
    }

    #[test]
    fn test_parse_commit_message_strips_wrappers() {
        // leading blank line, surrounding quotes, label prefix, trailing period
        assert_eq!(
            parse_commit_message("\n\nSubject: \"Fix preview proxy crash.\"\n").unwrap(),
            "Fix preview proxy crash"
        );
        assert_eq!(
            parse_commit_message("`feat: add locale switcher`").unwrap(),
            "feat: add locale switcher"
        );
    }

    #[test]
    fn test_parse_commit_message_takes_first_line_only() {
        let response = "Update publish flow\n\nThis is a body paragraph that should be ignored.";
        assert_eq!(
            parse_commit_message(response).unwrap(),
            "Update publish flow"
        );
    }

    #[test]
    fn test_parse_commit_message_caps_length() {
        let long = "word ".repeat(40); // 200 chars
        let result = parse_commit_message(&long).unwrap();
        assert!(result.chars().count() <= 100);
        assert!(!result.ends_with(' '));
    }

    #[test]
    fn test_parse_commit_message_empty() {
        assert!(parse_commit_message("").is_err());
        assert!(parse_commit_message("\n\n  \n").is_err());
        // a line that is *only* wrappers collapses to empty
        assert!(parse_commit_message("\"\"").is_err());
    }

    #[test]
    fn test_truncate_diff_under_limit() {
        let diff = "small diff";
        assert_eq!(truncate_diff(diff), diff);
    }

    #[test]
    fn test_truncate_diff_over_limit_char_boundary() {
        // A diff of multi-byte chars longer than MAX_DIFF_SIZE must not panic
        // when the cut lands mid-codepoint.
        let diff = "é".repeat(MAX_DIFF_SIZE); // 2 bytes each → well over the limit
        let result = truncate_diff(&diff);
        assert!(result.contains("diff truncated"));
    }

    #[tokio::test]
    async fn resolve_uses_provided_message_without_touching_git() {
        // A caller-supplied message short-circuits before any git/agent work,
        // so even a bogus path is fine.
        let msg = resolve_commit_message(
            std::path::Path::new("/definitely/not/a/repo"),
            Some("  Hand-written message  ".to_string()),
        )
        .await;
        assert_eq!(msg, "Hand-written message"); // trimmed
    }

    #[tokio::test]
    async fn resolve_falls_back_to_default_when_nothing_changed() {
        use tempfile::TempDir;
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            create_command("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@e.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "x\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);

        // Clean tree → empty porcelain → generation short-circuits before any
        // agent call → fallback. Non-flaky regardless of agent availability.
        let msg = resolve_commit_message(dir, None).await;
        assert_eq!(msg, DEFAULT_COMMIT_MESSAGE);
    }

    /// End-to-end check that actually shells out to the agent CLI. Ignored by
    /// default (needs Claude installed + authenticated + network); run with
    /// `cargo test --lib commands::ai -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn e2e_generates_real_commit_message() {
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let git = |args: &[&str]| {
            create_command("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("app.js"), "const x = 1;\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);

        // Make a meaningful, describable change against HEAD.
        std::fs::write(
            dir.join("app.js"),
            "function greet(name) {\n  return `Hello, ${name}`;\n}\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# Greeter\n").unwrap();

        let msg = generate_commit_message_for_path(dir)
            .await
            .expect("generation should succeed");
        println!("GENERATED COMMIT MESSAGE: {msg:?}");
        assert!(!msg.is_empty());
        assert_ne!(msg, DEFAULT_COMMIT_MESSAGE);
        assert!(!msg.contains('\n'), "must be a single line");
        assert!(msg.chars().count() <= 100);
    }
}
