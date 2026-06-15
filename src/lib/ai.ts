/**
 * AI generation utilities.
 *
 * Provides functions for AI-powered features like PR description generation
 * using the Claude CLI.
 *
 * @module lib/ai
 */

import { invoke } from '@tauri-apps/api/core';

/** AI-generated pull request title and description */
export interface GeneratedPR {
  /** Concise PR title (under 72 characters) */
  title: string;
  /** Markdown-formatted PR description */
  description: string;
}

/**
 * Generate a PR title and description using Claude CLI.
 * Gathers git diff and commit messages, then calls Claude to generate content.
 *
 * @param projectPath - Path to the project directory
 * @param baseBranch - Target branch to diff against (e.g., "main")
 * @returns Generated PR title and description
 * @throws If Claude CLI is not installed or generation fails
 */
export async function generatePRDescription(
  projectPath: string,
  baseBranch: string
): Promise<GeneratedPR> {
  return invoke<GeneratedPR>('generate_pr_description', {
    projectPath,
    baseBranch,
  });
}

/**
 * Generate a single-line commit message summarizing the project's current
 * uncommitted changes, using the active agent CLI in print mode.
 *
 * The publish flow already calls this automatically on the backend; this
 * wrapper exists for UI that wants to preview or regenerate the message.
 *
 * @param projectPath - Path to the project directory
 * @returns A concise commit subject line
 * @throws If no headless agent is available, there are no changes, or the CLI fails
 */
export async function generateCommitMessage(projectPath: string): Promise<string> {
  return invoke<string>('generate_commit_message', { projectPath });
}
