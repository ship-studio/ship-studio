//! # AI Generation Commands
//!
//! Commands for AI-powered features like PR description generation.

use crate::agent::{get_active_agent, AgentConfig};
use crate::commands::claude::find_agent_binary;
use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::types::GeneratedPR;
use crate::utils::{create_command, get_extended_path, validate_project_path};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// Timeout for the fast local git context-gathering ops (branch name, commit
/// log) — always cheap regardless of repo size.
const GIT_TIMEOUT_SECS: u64 = 60;

/// Timeout for the diff-shaped ops (`git diff`, `git diff --stat`), whose cost
/// scales with repo and diff size: a three-dot diff computes the merge-base
/// and diffs the whole range, which can legitimately exceed 60s on a big repo
/// on Windows (slower filesystem, antivirus scanning — issue #608, same theme
/// as #421/#461/#527). The timed-out child is killed by run_with_timeout's
/// kill_on_drop, so a slow diff can no longer leak a running git process.
const GIT_DIFF_TIMEOUT_SECS: u64 = 180;

/// How the active agent can answer a one-shot prompt without a TTY.
enum HeadlessInvocation {
    /// A real print mode (Claude `--print -p`, Cursor `-p --print`): the
    /// answer is the process' stdout. When `stdin_prompt` is set the prompt is
    /// fed via stdin instead of argv — a prompt carrying a ~40KB diff as a
    /// single argv element can blow the OS's combined argv+env exec limit
    /// (E2BIG, "Argument list too long", issue #595).
    PrintMode {
        args: Vec<String>,
        stdin_prompt: Option<String>,
    },
    /// Codex `exec`: stdout is a session transcript (which echoes the prompt —
    /// unsafe to parse), so the final message is captured via
    /// `--output-last-message` into a temp file instead. The prompt travels
    /// via stdin (the positional argument is `-`, which `codex exec` documents
    /// as "read instructions from stdin"): besides the E2BIG ceiling, on
    /// Windows Codex resolves to a `.cmd` shim, and Rust's std refuses to
    /// spawn a `.cmd` when an argument can't be safely cmd.exe-escaped —
    /// a prompt embedding a raw git diff (quotes, newlines) failed the whole
    /// generation with "batch file arguments are invalid" (issue #663).
    CodexExec {
        args: Vec<String>,
        output_file: PathBuf,
        stdin_prompt: String,
    },
}

/// Build the headless invocation for `agent`, or `None` when the agent can't
/// run one-shot prompts (Opencode today) — callers surface a friendly
/// "switch your default agent" error instead of spawning an interactive
/// session that dies with "stdin is not a terminal".
fn headless_invocation(agent: &AgentConfig, prompt: &str) -> Option<HeadlessInvocation> {
    if !agent.print_mode_flags.is_empty() {
        let mut args: Vec<String> = agent
            .print_mode_flags
            .iter()
            .map(|f| f.to_string())
            .collect();
        // Claude's `-p`/`--print` reads the query from stdin when no
        // positional argument is given — use that to dodge the argv size
        // ceiling (issue #595). Cursor's print mode isn't verified to accept
        // a stdin prompt, so it keeps the positional argument.
        let stdin_prompt = if agent.id == "claude-code" {
            Some(prompt.to_string())
        } else {
            args.push(prompt.to_string());
            None
        };
        return Some(HeadlessInvocation::PrintMode { args, stdin_prompt });
    }
    if agent.id == "codex" {
        let output_file = std::env::temp_dir().join(format!(
            "shipstudio-ai-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        // --skip-git-repo-check: worktrees/external folders can trip Codex's
        // trusted-directory heuristic even though we always run in a validated
        // project path. The trailing `-` makes Codex read the prompt from
        // stdin — never argv (issues #595's E2BIG class and #663's Windows
        // .cmd escaping failure).
        let args = vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--output-last-message".to_string(),
            output_file.to_string_lossy().to_string(),
            "-".to_string(),
        ];
        return Some(HeadlessInvocation::CodexExec {
            args,
            output_file,
            stdin_prompt: prompt.to_string(),
        });
    }
    None
}

/// Known "environment, not our bug" failure states from the agent CLI itself,
/// matched against the failure detail (stderr, or the exit-code + stdout
/// snippet when stderr is empty — the session-limit refusal arrives on
/// stdout). These are conditions Ship Studio can't fix and shouldn't
/// telemetry-report as bugs; `Expected` keeps them out (same precedent as the
/// missing-binary case above, issue #548).
///
/// - Subscription session/usage/rate limits — "You've hit your session limit
///   · resets 4:40pm (Asia/Dubai)", usage-limit and rate-limit wordings
///   (issue #653). The raw detail is appended so the CLI's reset time
///   survives into the message.
/// - Expired/missing sign-in — "OAuth token has expired · Please run /login"
///   family (issue #653's session-expired sibling).
/// - Untrusted workspace — Claude Code refusing headless runs in a folder the
///   user never opened interactively: "this workspace has not been trusted.
///   Run Claude Code interactively here once and accept the trust dialog, or
///   set projects[…].hasTrustDialogAccepted: true in ~/.claude.json". The raw
///   compound error (trust warning + stdin race + "--print needs input") is a
///   confusing wall of text, so it gets a plain remedy instead (issue #660).
/// - Codex's stale models cache — "failed to load models cache" (logged by
///   `codex_models_manager::cache`): a corrupt/outdated local cache file the
///   user can just delete (issue #689).
/// - Codex's OAuth refresh-token rotation failing — "Failed to refresh token",
///   "refresh_token_reused": the stored credential can't be renewed, so it
///   folds into the expired-sign-in case above (issue #836). Only these
///   distinctive wordings count — a bare "sign in again" is ordinary prose that
///   appears in the transcripts callers pass in.
/// - Org policy disabling subscription access — "Your organization has disabled
///   Claude subscription access … ask your admin to enable access": an
///   account-level setting only the user's admin can change (issue #765).
/// - The agent's skill loader rejecting a user-installed SKILL.md — "failed to
///   load skill …: missing field `description`" (issue #805).
///
/// Callers must pass the FULL failure detail, never a truncated copy — Codex
/// dumps a whole session transcript on failure and the matching line can sit
/// anywhere in it (issues #665/#689). Substring matching handles mid-transcript
/// hits; only the user-facing message is capped.
fn classify_agent_cli_failure(agent_name: &str, detail: &str) -> Option<CommandError> {
    let lower = detail.to_lowercase();
    if lower.contains("session limit")
        || lower.contains("usage limit")
        || lower.contains("rate limit")
        || lower.contains("quota exceeded")
    {
        // The raw detail carries the CLI's reset time — keep it, but capped
        // (head+tail, since it may be a full transcript) so a user-facing
        // message can't balloon.
        let detail = crate::external_command::truncate_output_head_tail(detail);
        return Some(CommandError::expected(format!(
            "{agent_name} hit its usage limit, so AI generation isn't available right now. \
             The limit resets automatically — try again later. ({detail})"
        )));
    }
    if lower.contains("failed to load models cache")
        || lower.contains("codex_models_manager::cache")
    {
        return Some(CommandError::expected(format!(
            "{agent_name}'s local model cache is stale, so AI generation isn't available \
             right now. Delete ~/.codex/models_cache.json and try again."
        )));
    }
    if lower.contains("please run /login")
        || lower.contains("oauth token has expired")
        || lower.contains("session expired")
        // Codex's OAuth refresh-token rotation failing: the stored credential
        // can no longer be renewed and the user has to sign in again — same
        // class as an expired session, different wording (issue #836).
        || lower.contains("failed to refresh token")
        || lower.contains("refresh_token_reused")
    // NOT a bare "sign in again": callers pass whole transcripts through here,
    // and those three ordinary words show up in the user's own prose (or in an
    // agent's advice about some unrelated service), which would misreport a
    // working session as expired. Only distinctive CLI wordings qualify.
    {
        return Some(CommandError::expected(format!(
            "{agent_name} isn't signed in anymore (its session expired). Open an agent \
             terminal and sign in again — for Claude Code, run /login — then try again."
        )));
    }
    // An Anthropic Team/Enterprise admin has turned off subscription-based
    // Claude Code access for the org, so the CLI refuses to run without an API
    // key. An account-policy state, not an app malfunction (issue #765).
    if lower.contains("subscription access") || lower.contains("ask your admin") {
        return Some(CommandError::expected(format!(
            "{agent_name}'s organization has disabled subscription access for this tool. \
             Use an Anthropic API key instead, or ask your admin to enable access."
        )));
    }
    // The agent's own skill loader rejecting a locally-installed SKILL.md
    // (e.g. missing the required `description` frontmatter field). The file is
    // the user's, not something the app wrote (issue #805).
    if lower.contains("failed to load skill") {
        return Some(CommandError::expected(format!(
            "{agent_name} couldn't load one of your installed skills — its SKILL.md is \
             missing a required field. Fix or remove that skill file, then try again."
        )));
    }
    if lower.contains("has not been trusted") || lower.contains("hastrustdialogaccepted") {
        return Some(CommandError::expected(format!(
            "{agent_name} hasn't trusted this project's folder yet, so it won't run \
             non-interactively here. Open an agent terminal in this project once and accept \
             the trust prompt, then try again."
        )));
    }
    None
}

/// Remove the echoed prompt from an agent CLI's failure output.
///
/// `codex exec` writes a session transcript to stderr, which reproduces the
/// prompt we fed it — including the user's entire git diff. The app built that
/// prompt itself, so an exact-substring match is reliable: excise it rather
/// than forwarding the user's own data back as an "error" (issue #665). The
/// prompt is matched trimmed (transcripts may re-render it without the exact
/// leading/trailing whitespace we sent).
fn strip_prompt_echo(output: &str, prompt: &str) -> String {
    let prompt = prompt.trim();
    if prompt.is_empty() || !output.contains(prompt) {
        return output.to_string();
    }
    output.replace(prompt, "[prompt omitted]")
}

/// Run the active agent headlessly with `prompt` in `cwd` and return its final
/// answer text. `extra_envs` is injected on top of the extended PATH.
/// Also used by studio_talk as the non-Claude fallback for cross-project asks.
pub(crate) async fn run_agent_headless(
    agent: &AgentConfig,
    agent_path: &Path,
    prompt: &str,
    cwd: &Path,
    extra_envs: HashMap<String, String>,
    timeout_secs: u64,
) -> Result<String, CommandError> {
    let invocation = headless_invocation(agent, prompt).ok_or_else(|| {
        format!(
            "{} can't generate text non-interactively yet — set Claude Code as your default agent in Settings and try again.",
            agent.display_name
        )
    })?;
    let (args, output_file, stdin_prompt) = match &invocation {
        HeadlessInvocation::PrintMode { args, stdin_prompt } => {
            (args.clone(), None, stdin_prompt.clone())
        }
        HeadlessInvocation::CodexExec {
            args,
            output_file,
            stdin_prompt,
        } => (
            args.clone(),
            Some(output_file.clone()),
            Some(stdin_prompt.clone()),
        ),
    };

    let mut cmd = create_command(agent_path);
    cmd.args(&args)
        .env("PATH", get_extended_path())
        .envs(extra_envs)
        .current_dir(cwd);
    let label = format!("{} CLI", agent.display_name);
    let output = if let Some(prompt_data) = &stdin_prompt {
        // The prompt travels via stdin (piped, written in full, then closed so
        // the CLI sees EOF) instead of argv — see HeadlessInvocation::PrintMode
        // (issue #595) and HeadlessInvocation::CodexExec (issue #663).
        let tokio_cmd = tokio::process::Command::from(cmd);
        crate::external_command::run_with_timeout_stdin(tokio_cmd, prompt_data, label, timeout_secs)
            .await
    } else {
        // No TTY here: an EOF'd stdin keeps agents that read it from waiting
        // on input that will never come.
        cmd.stdin(std::process::Stdio::null());
        let tokio_cmd = tokio::process::Command::from(cmd);
        run_with_timeout(tokio_cmd, label, timeout_secs).await
    };

    // The temp file must not outlive the call, success or not.
    let read_and_cleanup = |file: &Option<PathBuf>| -> Option<String> {
        let file = file.as_ref()?;
        let contents = std::fs::read_to_string(file).ok();
        let _ = std::fs::remove_file(file);
        contents
    };

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            read_and_cleanup(&output_file);
            return Err(e);
        }
    };

    let final_message = read_and_cleanup(&output_file);

    if !output.status.success() {
        // Codex `exec` fails with a full session transcript on stderr — and
        // that transcript echoes the prompt we sent, git diff included. Excise
        // the echo BEFORE any capping or classification: it's the user's own
        // data reflected back as an "error", and it buries the real failure
        // line (issue #665).
        let stderr = strip_prompt_echo(&String::from_utf8_lossy(&output.stderr), prompt);
        // A silent non-zero exit (empty stderr) used to surface as the
        // undiagnosable "Claude Code CLI failed: " — fall back to the exit code
        // and stdout so there's something to act on (issue #269).
        let full_detail = if stderr.trim().is_empty() {
            let stdout = strip_prompt_echo(&String::from_utf8_lossy(&output.stdout), prompt);
            let stdout = stdout.trim();
            if stdout.is_empty() {
                format!("exit code {:?}, no output", output.status.code())
            } else {
                format!("exit code {:?}: {stdout}", output.status.code())
            }
        } else {
            stderr
        };
        // Known environment states (usage limit, expired sign-in, untrusted
        // workspace, stale Codex models cache) are the CLI working as designed
        // — warn, not error, and Expected so they stay out of telemetry
        // (issues #653/#660/#689). Classification sees the FULL detail: the
        // matching line can sit anywhere in a transcript, so classifying a
        // truncated copy would miss it (issue #689).
        // What we forward/log stays capped — but head+tail, not head-only: in
        // transcript-shaped output the actual error is the LAST line, so a
        // head-only cap kept the banner and cut the one useful line
        // (issues #578/#665).
        let detail = crate::external_command::truncate_output_head_tail(&full_detail);
        if let Some(err) = classify_agent_cli_failure(&agent.display_name, &full_detail) {
            warn!(
                "{} CLI failed with an expected condition: {}",
                agent.display_name, detail
            );
            return Err(err);
        }
        error!("{} CLI failed: {}", agent.display_name, detail);
        return Err(format!("{} CLI failed: {}", agent.display_name, detail).into());
    }

    match final_message {
        // Codex: the file carries exactly the final message.
        Some(message) if !message.trim().is_empty() => Ok(message),
        Some(_) => Err(format!("{} returned an empty response", agent.display_name).into()),
        // Print mode: stdout is the answer.
        None => Ok(String::from_utf8_lossy(&output.stdout).to_string()),
    }
}

/// Gather git context and generate a PR title and description using the active
/// agent CLI in headless mode.
#[tauri::command]
#[tracing::instrument(skip(project_path), fields(project = %project_path, base = %base_branch))]
pub async fn generate_pr_description(
    project_path: String,
    base_branch: String,
) -> Result<GeneratedPR, CommandError> {
    let validated_path = validate_project_path(&project_path)?;

    let agent = get_active_agent();
    // A missing agent binary is an "install X first" environment state, not a
    // malfunction — Expected keeps it out of telemetry (issue #548).
    let agent_path = find_agent_binary().ok_or_else(|| {
        CommandError::expected(format!(
            "{} CLI is not installed. Install {} to use AI generation.",
            agent.display_name, agent.display_name
        ))
    })?;

    info!(
        "Generating PR description for {} against {}",
        validated_path.display(),
        base_branch
    );

    // Gather context in parallel-ish (all quick git commands)
    let branch_name = get_branch_name(&validated_path).await?;
    let commits = get_commit_messages(&validated_path, &base_branch).await?;
    let diff_stat = get_diff_stat(&validated_path, &base_branch).await?;
    let diff = get_diff(&validated_path, &base_branch).await?;

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

    // Use the project's workspace creds (Anthropic base URL / API key), not
    // whichever workspace is globally active, so AI generation for a
    // project bills/authenticates against that project's workspace.
    let envs = crate::commands::accounts::get_env_vars_for_project(&validated_path);
    let response = run_agent_headless(
        agent,
        &agent_path,
        &prompt,
        &validated_path,
        envs,
        AGENT_CLI_TIMEOUT_SECS,
    )
    .await?;
    debug!("Agent response length: {} chars", response.len());

    parse_response(&response).map_err(CommandError::from)
}

async fn get_branch_name(path: &std::path::Path) -> Result<String, CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "git rev-parse",
        GIT_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        return Err(("Failed to get current branch name".to_string()).into());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn get_commit_messages(path: &std::path::Path, base: &str) -> Result<String, CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args([
        "--no-pager",
        "log",
        &format!("{base}..HEAD"),
        "--pretty=format:%s",
        "--no-merges",
    ]);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "git log",
        GIT_TIMEOUT_SECS,
    )
    .await?;

    // Not an error if there are no commits - diff might still exist
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn get_diff_stat(path: &std::path::Path, base: &str) -> Result<String, CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(["--no-pager", "diff", &format!("{base}...HEAD"), "--stat"]);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "git diff --stat",
        GIT_DIFF_TIMEOUT_SECS,
    )
    .await?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn get_diff(path: &std::path::Path, base: &str) -> Result<String, CommandError> {
    let mut cmd = crate::utils::git_command_in(path)?;
    cmd.args(["--no-pager", "diff", &format!("{base}...HEAD")]);
    let output = run_with_timeout(
        tokio::process::Command::from(cmd),
        "git diff",
        GIT_DIFF_TIMEOUT_SECS,
    )
    .await?;

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

    // Only agents with a headless mode can run non-interactively (Claude and
    // Cursor via print flags, Codex via `exec`). For the rest, bail before
    // launching an interactive session that would just hang until the timeout.
    if headless_invocation(agent, "").is_none() {
        return Err(format!(
            "{} has no headless mode; cannot auto-generate commit message",
            agent.display_name
        )
        .into());
    }

    // Same "install X first" state as generate_pr_description — Expected,
    // never telemetry (issue #548); resolve_commit_message falls back anyway.
    let agent_path = find_agent_binary().ok_or_else(|| {
        CommandError::expected(format!("{} CLI is not installed", agent.display_name))
    })?;

    // Cheap guard: if nothing changed, skip the agent call entirely.
    let status = git_status_porcelain(path)?;
    if status.trim().is_empty() {
        return Err("No changes to summarize".to_string().into());
    }
    let diff = truncate_diff(&git_working_diff(path));
    let prompt = build_commit_prompt(&status, &diff);

    debug!("Calling {} CLI for commit message", agent.display_name);

    let response = run_agent_headless(
        agent,
        &agent_path,
        &prompt,
        path,
        HashMap::new(),
        COMMIT_MSG_CLI_TIMEOUT_SECS,
    )
    .await
    .map_err(soften_commit_timeout)?;
    parse_commit_message(&response).map_err(CommandError::from)
}

/// The 30s commit-message budget covers the whole CLI run (spawn, the agent's
/// own startup/auth checks, generation), so a cold start or slow disk can blow
/// it even for a tiny prompt — and the publish flow already swallows the error
/// and falls back to [`DEFAULT_COMMIT_MESSAGE`]. That's a best-effort feature
/// degrading as designed, not a malfunction: map `Timeout` to `Expected` (kept
/// out of telemetry) and log at warn (issue #565). Other errors pass through
/// unchanged.
fn soften_commit_timeout(err: CommandError) -> CommandError {
    match err {
        CommandError::Timeout { cmd, secs } => {
            warn!(cmd = %cmd, secs, "commit-message generation timed out; falling back to the default message");
            CommandError::expected(format!("`{cmd}` timed out after {secs}s"))
        }
        other => other,
    }
}

fn git_status_porcelain(path: &std::path::Path) -> Result<String, CommandError> {
    let output = crate::utils::git_command_in(path)?
        .args(["status", "--porcelain"])
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
    let Ok(mut cmd) = crate::utils::git_command_in(path) else {
        return String::new();
    };
    cmd.args(["--no-pager", "diff", "HEAD"])
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
            // `is_char_boundary` also rejects offsets past the end of the
            // string, so it subsumes the length check. When `prefix.len()`
            // lands inside a multi-byte character the message can't start
            // with this ASCII prefix anyway — slicing there would panic
            // ("byte index N is not a char boundary", issue #673).
            if msg.is_char_boundary(prefix.len())
                && msg[..prefix.len()].eq_ignore_ascii_case(prefix)
            {
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
    fn headless_invocation_uses_print_mode_when_available() {
        // Claude: the prompt must NOT be an argv element (E2BIG on large
        // diffs, issue #595) — it travels via stdin.
        let inv = headless_invocation(&crate::agent::CLAUDE_CODE, "hello").unwrap();
        match inv {
            HeadlessInvocation::PrintMode { args, stdin_prompt } => {
                assert_eq!(args, vec!["--print", "-p"]);
                assert_eq!(stdin_prompt.as_deref(), Some("hello"));
            }
            HeadlessInvocation::CodexExec { .. } => panic!("Claude should use print mode"),
        }
    }

    #[test]
    fn headless_invocation_cursor_keeps_argv_prompt() {
        // Cursor's print mode isn't verified to read the prompt from stdin,
        // so it keeps the positional argument (and the E2BIG exposure —
        // revisit if a report ever lands for Cursor).
        let inv = headless_invocation(&crate::agent::CURSOR, "hello").unwrap();
        match inv {
            HeadlessInvocation::PrintMode { args, stdin_prompt } => {
                assert_eq!(args, vec!["-p", "--print", "hello"]);
                assert!(stdin_prompt.is_none());
            }
            HeadlessInvocation::CodexExec { .. } => panic!("Cursor should use print mode"),
        }
    }

    #[test]
    fn headless_invocation_codex_captures_last_message_to_file() {
        // The prompt must NOT be an argv element: on Windows Codex is a .cmd
        // shim, and Rust refuses to spawn a .cmd when an argument (a prompt
        // embedding a raw diff) can't be safely cmd.exe-escaped — "batch file
        // arguments are invalid" (issue #663). `-` tells `codex exec` to read
        // the prompt from stdin instead.
        let inv = headless_invocation(&crate::agent::CODEX, "hello \"quoted\"\nmultiline").unwrap();
        match inv {
            HeadlessInvocation::CodexExec {
                args,
                output_file,
                stdin_prompt,
            } => {
                assert_eq!(args[0], "exec");
                assert!(args.contains(&"--skip-git-repo-check".to_string()));
                let file_arg = args
                    .iter()
                    .position(|a| a == "--output-last-message")
                    .map(|i| &args[i + 1])
                    .expect("has --output-last-message");
                assert_eq!(file_arg, &output_file.to_string_lossy().to_string());
                // The final argument is the stdin sentinel, never the prompt.
                assert_eq!(args.last().unwrap(), "-");
                assert!(!args.iter().any(|a| a.contains("hello")));
                assert_eq!(stdin_prompt, "hello \"quoted\"\nmultiline");
            }
            HeadlessInvocation::PrintMode { .. } => panic!("Codex should use exec mode"),
        }
    }

    // The CLI's subscription session/usage-limit refusal is the environment,
    // not a bug — Expected, with the reset time preserved (issue #653).
    #[test]
    fn classify_agent_cli_failure_session_limit_is_expected() {
        let detail =
            "exit code Some(1): You've hit your session limit · resets 4:40pm (Asia/Dubai)";
        let err = classify_agent_cli_failure("Claude Code", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = format!("{err}");
        assert!(msg.contains("usage limit"), "got: {msg}");
        // The CLI's own reset time must survive into the message.
        assert!(msg.contains("resets 4:40pm"), "got: {msg}");
    }

    #[test]
    fn classify_agent_cli_failure_usage_and_rate_limit_wordings() {
        assert!(
            classify_agent_cli_failure("Claude Code", "Claude AI usage limit reached").is_some()
        );
        assert!(classify_agent_cli_failure("Codex", "Rate limit exceeded, retry later").is_some());
    }

    // Expired sign-in ("run /login") is user-fixable, not a malfunction.
    #[test]
    fn classify_agent_cli_failure_expired_login_is_expected() {
        let err = classify_agent_cli_failure(
            "Claude Code",
            "OAuth token has expired · Please obtain a new token or run /login",
        )
        .expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(format!("{err}").contains("sign in again"));
    }

    // The untrusted-workspace compound error (trust warning + stdin race +
    // "--print needs input") must become one plain remedy (issue #660).
    #[test]
    fn classify_agent_cli_failure_untrusted_workspace_is_expected() {
        let detail = "Ignoring 16 permissions.allow entries from .claude/settings.local.json: \
                      this workspace has not been trusted. Run Claude Code interactively here once \
                      and accept the trust dialog, or set projects[\"<project>\"].hasTrustDialogAccepted: \
                      true in ~/.claude.json.\nError: Input must be provided either through stdin or \
                      as a prompt argument when using --print";
        let err = classify_agent_cli_failure("Claude Code", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = format!("{err}");
        assert!(msg.contains("trust"), "got: {msg}");
        assert!(msg.contains("Open an agent terminal"), "got: {msg}");
    }

    // The #689 shape: Codex refusing to run because its local models cache is
    // stale — the environment, user-fixable by deleting the cache file.
    #[test]
    fn classify_agent_cli_failure_codex_models_cache_is_expected() {
        let detail = "ERROR codex_models_manager::cache: failed to load models cache: \
                      missing field `slug` at line 1 column 2000";
        let err = classify_agent_cli_failure("Codex", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = format!("{err}");
        assert!(msg.contains("model cache is stale"), "got: {msg}");
        assert!(msg.contains("~/.codex/models_cache.json"), "got: {msg}");

        // Either marker alone must classify too.
        assert!(classify_agent_cli_failure("Codex", "failed to load models cache").is_some());
        assert!(
            classify_agent_cli_failure("Codex", "WARN codex_models_manager::cache: boom").is_some()
        );
    }

    // The #836 shape: Codex's OAuth refresh token was already consumed, so the
    // stored credential can't be renewed — the user must sign in again.
    #[test]
    fn classify_agent_cli_failure_refresh_token_reuse_is_expected() {
        let detail = "ERROR codex_login::auth::manager: Failed to refresh token: \
                      401 Unauthorized: {\"error\":{\"message\":\"Your refresh token has \
                      already been used to generate a new access token. Please try signing \
                      in again.\",\"code\":\"refresh_token_reused\"}}";
        let err = classify_agent_cli_failure("Codex", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(
            format!("{err}").contains("isn't signed in anymore"),
            "got: {err}"
        );

        // Either distinctive marker alone must classify too.
        assert!(classify_agent_cli_failure("Codex", "refresh_token_reused").is_some());
        assert!(classify_agent_cli_failure("Codex", "Failed to refresh token").is_some());

        // But "sign in again" on its own must NOT: callers pass whole session
        // transcripts, so those three ordinary words appear in the user's own
        // prose and in advice about unrelated services. Matching them reported
        // a working session as expired and hid the real failure.
        assert!(classify_agent_cli_failure(
            "Codex",
            "The user asked me to check whether they need to sign in again to Vercel."
        )
        .is_none());
        assert!(classify_agent_cli_failure("Codex", "Please log out and sign in again.").is_none());
    }

    // The #765 shape: an org admin disabled subscription-based Claude Code
    // access — an account policy state, not an app malfunction.
    #[test]
    fn classify_agent_cli_failure_org_disabled_subscription_is_expected() {
        let detail = "exit code Some(1): Your organization has disabled Claude subscription \
                      access for Claude Code · Use an Anthropic API key instead, or ask your \
                      admin to enable access";
        let err = classify_agent_cli_failure("Claude Code", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        let msg = format!("{err}");
        assert!(msg.contains("disabled subscription access"), "got: {msg}");
        assert!(msg.contains("Anthropic API key"), "got: {msg}");
    }

    // The #805 shape: the agent's own skill loader rejecting a user-installed
    // SKILL.md whose frontmatter is missing a required field.
    #[test]
    fn classify_agent_cli_failure_invalid_skill_file_is_expected() {
        let detail = "ERROR codex_core::session::session: failed to load skill \
                      ~/.agents/skills/canvas/SKILL.md: missing field `description`";
        let err = classify_agent_cli_failure("Codex", detail).expect("must classify");
        assert!(matches!(err, CommandError::Expected { .. }));
        assert!(format!("{err}").contains("SKILL.md"), "got: {err}");
    }

    // The matching line arrives as the FIRST stderr line of a transcript that
    // continues for thousands of chars — classification runs on the full
    // (untruncated) detail, so it must still fire (interplay with #665's cap).
    #[test]
    fn classify_agent_cli_failure_matches_mid_transcript() {
        let transcript = format!(
            "OpenAI Codex banner\n{}\nERROR codex_models_manager::cache: failed to load models cache\n{}",
            "transcript filler\n".repeat(200),
            "more filler\n".repeat(200)
        );
        assert!(classify_agent_cli_failure("Codex", &transcript).is_some());
    }

    // Genuine unexplained failures must keep flowing to telemetry.
    #[test]
    fn classify_agent_cli_failure_ignores_unknown_failures() {
        assert!(
            classify_agent_cli_failure("Claude Code", "exit code Some(1), no output").is_none()
        );
        assert!(classify_agent_cli_failure("Claude Code", "segmentation fault").is_none());
        assert!(classify_agent_cli_failure("Claude Code", "").is_none());
    }

    // The #665 data-exposure shape: Codex's failure transcript echoes the
    // prompt we sent — git diff included — and it must be excised before the
    // text reaches an error message or telemetry.
    #[test]
    fn strip_prompt_echo_excises_echoed_prompt() {
        let prompt = build_commit_prompt(
            " M src/secret.rs",
            "diff --git a/src/secret.rs b/src/secret.rs\n+const API_KEY: &str = \"sk-secret\";",
        );
        let stderr = format!(
            "OpenAI Codex v0.30 banner\n--------\nuser\n{prompt}\n--------\nERROR: stream disconnected"
        );
        let cleaned = strip_prompt_echo(&stderr, &prompt);
        assert!(!cleaned.contains("sk-secret"), "diff leaked: {cleaned}");
        assert!(cleaned.contains("[prompt omitted]"), "got: {cleaned}");
        // The surrounding transcript (banner + the actual error) survives.
        assert!(cleaned.contains("OpenAI Codex v0.30 banner"));
        assert!(cleaned.contains("ERROR: stream disconnected"));
    }

    #[test]
    fn strip_prompt_echo_leaves_unrelated_output_alone() {
        let stderr = "ERROR: stream disconnected before completion";
        assert_eq!(strip_prompt_echo(stderr, "some prompt"), stderr);
        // An empty/whitespace prompt must never trigger a replace.
        assert_eq!(strip_prompt_echo(stderr, ""), stderr);
        assert_eq!(strip_prompt_echo(stderr, "  \n "), stderr);
    }

    #[test]
    fn headless_invocation_none_for_opencode() {
        // Opencode has no headless mode — callers must show a friendly error
        // instead of spawning an interactive session ("stdin is not a terminal").
        assert!(headless_invocation(&crate::agent::OPENCODE, "hello").is_none());
    }

    // The #565 shape: a commit-message CLI timeout is best-effort noise (the
    // caller falls back to the default message) — Expected, not telemetry.
    #[test]
    fn soften_commit_timeout_maps_timeout_to_expected() {
        let softened = soften_commit_timeout(CommandError::Timeout {
            cmd: "Claude Code CLI".into(),
            secs: 30,
        });
        assert!(matches!(softened, CommandError::Expected { .. }));
        assert_eq!(
            softened.to_string(),
            "`Claude Code CLI` timed out after 30s"
        );
    }

    #[test]
    fn soften_commit_timeout_passes_other_errors_through() {
        let other = soften_commit_timeout(CommandError::Other {
            message: "boom".into(),
        });
        assert!(matches!(other, CommandError::Other { .. }));
    }

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
    fn test_parse_commit_message_multibyte_at_prefix_boundary() {
        // Regression for issue #673: the prefix-stripping loop sliced
        // `msg[..prefix.len()]` without checking that the byte offset lands
        // on a UTF-8 char boundary, panicking when a multi-byte character
        // straddles one of the prefix lengths (6, 7, 8, or 15 bytes).

        // 'á' (2 bytes) at bytes 7..9 — byte 8 straddles "subject:"/"message:"
        // (len 8), the exact panic from the automated report.
        assert_eq!(
            parse_commit_message("Mejorasá bien").unwrap(),
            "Mejorasá bien"
        );
        // 'á' at bytes 6..8 — byte 7 straddles "commit:" (len 7).
        assert_eq!(
            parse_commit_message("Refactá lo básico").unwrap(),
            "Refactá lo básico"
        );
        // Emoji (4 bytes) at bytes 4..8 — straddles "title:" (6), "commit:"
        // (7), and "subject:"/"message:" (8).
        assert_eq!(
            parse_commit_message("Fix 🎉 release flow").unwrap(),
            "Fix 🎉 release flow"
        );
        // CJK (3 bytes each, boundaries at 0/3/6/9/12) — bytes 7 and 8 land
        // mid-character.
        assert_eq!(
            parse_commit_message("修复构建脚本").unwrap(),
            "修复构建脚本"
        );
        // A short multi-byte message where "commit message:" (15) exceeds the
        // string length entirely and shorter prefixes land mid-character.
        assert_eq!(parse_commit_message("ééé").unwrap(), "ééé");
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
            crate::utils::git_command_in(dir)
                .unwrap()
                .args(args)
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
            crate::utils::git_command_in(dir)
                .unwrap()
                .args(args)
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

    /// The git context helpers must run asynchronously through the timeout path
    /// (they were blocking std `.output()` on the async executor). The repo root
    /// is a git repo, so this is deterministic and guards the conversion wiring.
    #[tokio::test]
    async fn get_branch_name_runs_async_with_timeout() {
        let out = get_branch_name(std::path::Path::new("."))
            .await
            .expect("git rev-parse should run within the timeout");
        assert!(!out.is_empty());
    }
}
