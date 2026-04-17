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
  supportsSkills: false,
  supportsMcp: true,
  supportsStatusDetection: false,
  loadingMessage: 'Starting Opencode...',
  notFoundMessage: 'Error starting Opencode',
  installHint: 'Make sure Opencode is installed: curl -fsSL https://opencode.ai/install | bash',
};

/** Raw terminal (shell) configuration — not an AI agent. */
export const TERMINAL: AgentConfig = {
  id: 'terminal',
  displayName: 'Terminal',
  binaryName: '/bin/zsh',
  processName: 'zsh',
  autoAcceptFlag: null,
  supportsSkills: false,
  supportsMcp: false,
  supportsStatusDetection: false,
  loadingMessage: 'Starting terminal...',
  notFoundMessage: 'Error starting terminal',
  installHint: 'Could not launch shell',
};

/** All available agents (AI coding assistants). */
export const ALL_AGENTS: AgentConfig[] = [CLAUDE_CODE, CODEX, OPENCODE];

/** All options available in the tab dropdown (agents + terminal). */
export const ALL_TAB_OPTIONS: AgentConfig[] = [CLAUDE_CODE, CODEX, OPENCODE, TERMINAL];

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
