/**
 * Agent abstraction layer for the frontend.
 *
 * All agent-specific values (binary names, flags, display strings) are
 * centralized here so the rest of the frontend is agent-agnostic.
 *
 * Each terminal tab can independently run a different agent. The toolbar
 * and UI adapt based on the active tab's agent configuration.
 *
 * @module lib/agent
 */

import { isWindows } from './setup';

/** Configuration for an AI coding agent integrated with Ship Studio. */
export interface AgentConfig {
  /** Unique identifier (e.g., "claude-code") */
  id: string;
  /** Human-readable name (e.g., "Claude Code") */
  displayName: string;
  /** Binary name to spawn in terminal (e.g., "claude") */
  binaryName: string;
  /** Process name for display purposes */
  processName: string;
  /** Flag to skip permission prompts, or null if not supported */
  autoAcceptFlag: string | null;
  /**
   * Flag this agent uses to attach an additional working directory (read
   * access + skills), or null if the agent has no equivalent. Ship Studio
   * appends `<flag> <path>` per attached library at launch so the user's
   * cross-project library rides along. Claude Code: `--add-dir` (its skills
   * load and files are readable, but the directory's CLAUDE.md is not loaded).
   */
  additionalDirFlag: string | null;
  /** Whether this agent supports the skills system */
  supportsSkills: boolean;
  /** Whether this agent supports MCP (Model Context Protocol) servers */
  supportsMcp: boolean;
  /** Whether this agent supports status detection via terminal title */
  supportsStatusDetection: boolean;
  /** Loading message shown while terminal starts */
  loadingMessage: string;
  /** Error message shown when binary is not found */
  notFoundMessage: string;
  /** Hint shown after not-found error (install instructions) */
  installHint: string;
}

/** Claude Code agent configuration. */
export const CLAUDE_CODE: AgentConfig = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binaryName: 'claude',
  processName: 'claude',
  autoAcceptFlag: '--dangerously-skip-permissions',
  additionalDirFlag: '--add-dir',
  supportsSkills: true,
  supportsMcp: true,
  supportsStatusDetection: true,
  loadingMessage: 'Starting Claude Code...',
  notFoundMessage: 'Error starting Claude',
  installHint: 'Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code',
};

/** Codex agent configuration. */
export const CODEX: AgentConfig = {
  id: 'codex',
  displayName: 'Codex',
  binaryName: 'codex',
  processName: 'codex',
  autoAcceptFlag: '--yolo',
  // Codex has no `--add-dir` equivalent yet; attached libraries are a no-op.
  additionalDirFlag: null,
  supportsSkills: true,
  supportsMcp: true,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Codex...',
  notFoundMessage: 'Error starting Codex',
  installHint: 'Make sure Codex is installed: npm install -g @openai/codex',
};

/** Opencode agent configuration. */
export const OPENCODE: AgentConfig = {
  id: 'opencode',
  displayName: 'Opencode',
  binaryName: 'opencode',
  processName: 'opencode',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: true,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Opencode...',
  notFoundMessage: 'Error starting Opencode',
  installHint: 'Make sure Opencode is installed: curl -fsSL https://opencode.ai/install | bash',
};

/** Cursor CLI (`cursor-agent`) agent configuration. */
export const CURSOR: AgentConfig = {
  id: 'cursor',
  displayName: 'Cursor',
  binaryName: 'cursor-agent',
  processName: 'cursor-agent',
  autoAcceptFlag: '--force',
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Cursor...',
  notFoundMessage: 'Error starting Cursor',
  installHint: 'Make sure Cursor CLI is installed: curl https://cursor.com/install -fsS | bash',
};

/** GitHub Copilot CLI agent configuration. */
export const COPILOT: AgentConfig = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  binaryName: 'copilot',
  processName: 'copilot',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting GitHub Copilot...',
  notFoundMessage: 'Error starting GitHub Copilot',
  installHint:
    'Make sure Copilot CLI is installed: curl -fsSL https://gh.io/copilot-install | bash',
};

/** Pi agent configuration. */
export const PI: AgentConfig = {
  id: 'pi',
  displayName: 'Pi',
  binaryName: 'pi',
  processName: 'pi',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Pi...',
  notFoundMessage: 'Error starting Pi',
  installHint: 'Make sure Pi is installed: curl -fsSL https://pi.dev/install.sh | sh',
};

/** Hermes Agent configuration. */
export const HERMES: AgentConfig = {
  id: 'hermes',
  displayName: 'Hermes',
  binaryName: 'hermes',
  processName: 'hermes',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Hermes...',
  notFoundMessage: 'Error starting Hermes',
  installHint:
    'Make sure Hermes is installed: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
};

/** Devin CLI agent configuration. */
export const DEVIN: AgentConfig = {
  id: 'devin',
  displayName: 'Devin',
  binaryName: 'devin',
  processName: 'devin',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Devin...',
  notFoundMessage: 'Error starting Devin',
  installHint:
    'Make sure Devin CLI is installed: curl -fsSL https://cli.devin.ai/install.sh | bash',
};

/** Grok Build agent configuration. */
export const GROK: AgentConfig = {
  id: 'grok',
  displayName: 'Grok',
  binaryName: 'grok',
  processName: 'grok',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Grok...',
  notFoundMessage: 'Error starting Grok',
  installHint: 'Make sure Grok CLI is installed: curl -fsSL https://x.ai/cli/install.sh | bash',
};

/** Kimi Code agent configuration. */
export const KIMI_CODE: AgentConfig = {
  id: 'kimi-code',
  displayName: 'Kimi Code',
  binaryName: 'kimi',
  processName: 'kimi',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Kimi Code...',
  notFoundMessage: 'Error starting Kimi Code',
  installHint:
    'Make sure Kimi Code is installed: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
};

/** Antigravity CLI agent configuration. */
export const ANTIGRAVITY_CLI: AgentConfig = {
  id: 'antigravity-cli',
  displayName: 'Antigravity',
  binaryName: 'agy',
  processName: 'agy',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Antigravity...',
  notFoundMessage: 'Error starting Antigravity',
  installHint:
    'Make sure Antigravity CLI is installed: curl -fsSL https://antigravity.google/cli/install.sh | bash',
};

/** Jcode agent configuration. */
export const JCODE: AgentConfig = {
  id: 'jcode',
  displayName: 'Jcode',
  binaryName: 'jcode',
  processName: 'jcode',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Jcode...',
  notFoundMessage: 'Error starting Jcode',
  installHint: 'Make sure Jcode is installed: curl -fsSL https://jcode.sh/install | bash',
};

/** Droid (Factory) agent configuration. */
export const DROID: AgentConfig = {
  id: 'droid',
  displayName: 'Droid',
  binaryName: 'droid',
  processName: 'droid',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Droid...',
  notFoundMessage: 'Error starting Droid',
  installHint: 'Make sure Droid is installed: curl -fsSL https://app.factory.ai/cli | sh',
};

/** Amp (AmpCode) agent configuration. */
export const AMP: AgentConfig = {
  id: 'amp',
  displayName: 'Amp',
  binaryName: 'amp',
  processName: 'amp',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Amp...',
  notFoundMessage: 'Error starting Amp',
  installHint: 'Make sure Amp is installed: curl -fsSL https://ampcode.com/install.sh | bash',
};

/** Qwen Code agent configuration. */
export const QWEN: AgentConfig = {
  id: 'qwen',
  displayName: 'Qwen',
  binaryName: 'qwen',
  processName: 'qwen',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Qwen...',
  notFoundMessage: 'Error starting Qwen',
  installHint:
    'Make sure Qwen is installed: curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
};

/** Raw terminal (shell) configuration — not an AI agent. */
export const TERMINAL: AgentConfig = {
  id: 'terminal',
  displayName: 'Terminal',
  binaryName: isWindows() ? 'powershell.exe' : '/bin/zsh',
  processName: isWindows() ? 'powershell' : 'zsh',
  autoAcceptFlag: null,
  additionalDirFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting terminal...',
  notFoundMessage: 'Error starting terminal',
  installHint: 'Could not launch shell',
};

/** All available agents (AI coding assistants). */
export const ALL_AGENTS: AgentConfig[] = [
  CLAUDE_CODE,
  CODEX,
  OPENCODE,
  CURSOR,
  COPILOT,
  PI,
  HERMES,
  DEVIN,
  GROK,
  KIMI_CODE,
  ANTIGRAVITY_CLI,
  JCODE,
  DROID,
  AMP,
  QWEN,
];

/** All options available in the tab dropdown (agents + terminal). */
export const ALL_TAB_OPTIONS: AgentConfig[] = [
  CLAUDE_CODE,
  CODEX,
  OPENCODE,
  CURSOR,
  COPILOT,
  PI,
  HERMES,
  DEVIN,
  GROK,
  KIMI_CODE,
  ANTIGRAVITY_CLI,
  JCODE,
  DROID,
  AMP,
  QWEN,
  TERMINAL,
];

/** In-memory cache for the default agent ID. Null means unset (falls back to Claude Code). */
let defaultAgentId: string | null = null;

/**
 * Initialize the default agent cache (called on startup from App.tsx).
 */
export function initDefaultAgent(agentId: string | null): void {
  defaultAgentId = agentId;
}

/**
 * Get the cached default agent ID (falls back to Claude Code if unset).
 */
export function getDefaultAgentId(): string {
  return defaultAgentId ?? CLAUDE_CODE.id;
}

/**
 * Look up an agent by its unique ID.
 * Falls back to CLAUDE_CODE if the ID is not recognized.
 */
export function getAgentById(id: string): AgentConfig {
  return ALL_TAB_OPTIONS.find((a) => a.id === id) ?? CLAUDE_CODE;
}

/**
 * Returns the currently active (default) agent configuration.
 *
 * Reads from the in-memory cache. Falls back to CLAUDE_CODE if unset.
 */
export function getActiveAgent(): AgentConfig {
  return getAgentById(getDefaultAgentId());
}
