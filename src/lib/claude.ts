/**
 * Claude Code CLI integration utilities.
 *
 * Provides functions for:
 * - Checking Claude CLI installation status and version
 * - Installing the Claude CLI globally
 *
 * Claude Code is the AI assistant that powers the terminal experience.
 *
 * @module lib/claude
 */

import { invoke } from '@tauri-apps/api/core';

/** Claude CLI installation status */
export interface ClaudeCliStatus {
  /** Whether claude CLI is installed */
  installed: boolean;
  /** Installed version string (e.g., "2.1.14") or null if not installed */
  version: string | null;
}

/**
 * Check Claude CLI installation status.
 * @returns CLI status with installed flag and version
 */
export async function checkClaudeCliStatus(): Promise<ClaudeCliStatus> {
  return invoke<ClaudeCliStatus>('check_claude_cli_status');
}

/**
 * Install the Claude CLI globally via npm.
 * Runs: npm install -g @anthropic-ai/claude-code
 */
export async function installClaudeCli(): Promise<void> {
  return invoke('install_claude_cli');
}
