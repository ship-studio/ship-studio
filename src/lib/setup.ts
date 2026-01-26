/**
 * Setup/onboarding types and utilities.
 *
 * Manages the dependency graph and status for all setup items:
 * - Package Manager (Homebrew)
 * - Node.js
 * - Git
 * - GitHub CLI + auth
 * - Claude Code + auth
 * - Vercel CLI + auth
 *
 * @module lib/setup
 */

import { invoke } from '@tauri-apps/api/core';

/** Status of a single setup item */
export type SetupItemStatus =
  | 'ready'
  | 'not_installed'
  | 'not_authenticated'
  | 'in_progress'
  | 'error'
  | 'blocked';

/** Individual setup item */
export interface SetupItem {
  /** Unique identifier */
  id: string;
  /** Human-friendly display name */
  friendlyName: string;
  /** Current status */
  status: SetupItemStatus;
  /** Version string if installed */
  version?: string;
  /** Username if authenticated */
  username?: string;
  /** Error message if status is "error" */
  errorMessage?: string;
}

/** Full setup status from backend */
export interface FullSetupStatus {
  /** All items are ready */
  allReady: boolean;
  /** Individual item statuses */
  items: SetupItem[];
}

/** Progress event emitted during installation */
export interface SetupProgress {
  /** Item being worked on */
  itemId: string;
  /** Human-friendly message */
  message: string;
}

/** Dependency graph: which items must be ready before each item can be installed */
export const SETUP_DEPENDENCIES: Record<string, string[]> = {
  homebrew: [],
  node: ['homebrew'],
  git: ['homebrew'],
  gh: ['homebrew'],
  gh_auth: ['gh'],
  claude: [], // Uses its own installer, no Homebrew dependency
  claude_auth: ['claude'],
  vercel: ['node'],
  vercel_auth: ['vercel'],
};

/** Order to display items (roughly in dependency order) */
export const SETUP_ITEM_ORDER = [
  'homebrew',
  'node',
  'git',
  'gh',
  'gh_auth',
  'claude',
  'claude_auth',
  'vercel',
  'vercel_auth',
];

/** Friendly names for each item */
export const SETUP_FRIENDLY_NAMES: Record<string, string> = {
  homebrew: 'Package Manager',
  node: 'Node.js',
  git: 'Git',
  gh: 'GitHub CLI',
  gh_auth: 'GitHub Account',
  claude: 'Claude Code',
  claude_auth: 'Claude Account',
  vercel: 'Vercel CLI',
  vercel_auth: 'Vercel Account',
};

/** Messages shown while item is in progress */
export const SETUP_PROGRESS_MESSAGES: Record<string, string> = {
  homebrew: 'Installing package manager...',
  node: 'Installing Node.js...',
  git: 'Installing Git...',
  gh: 'Installing GitHub CLI...',
  gh_auth: 'Connecting to GitHub...',
  claude: 'Installing Claude Code...',
  claude_auth: 'Connecting to Claude...',
  vercel: 'Installing Vercel CLI...',
  vercel_auth: 'Connecting to Vercel...',
};

/**
 * Check if an item's dependencies are all ready.
 */
export function areDependenciesReady(itemId: string, items: SetupItem[]): boolean {
  const deps = SETUP_DEPENDENCIES[itemId] || [];
  return deps.every((depId) => {
    const dep = items.find((i) => i.id === depId);
    return dep?.status === 'ready';
  });
}

/**
 * Get the blocking dependency names for an item.
 */
export function getBlockingDependencies(itemId: string, items: SetupItem[]): string[] {
  const deps = SETUP_DEPENDENCIES[itemId] || [];
  return deps
    .filter((depId) => {
      const dep = items.find((i) => i.id === depId);
      return dep?.status !== 'ready';
    })
    .map((depId) => SETUP_FRIENDLY_NAMES[depId] || depId);
}

// ============ Backend API ============

/**
 * Get full setup status for all items.
 */
export async function getFullSetupStatus(): Promise<FullSetupStatus> {
  return invoke<FullSetupStatus>('get_full_setup_status');
}

/**
 * Install Homebrew.
 */
export async function installHomebrew(): Promise<void> {
  return invoke('install_homebrew');
}

/**
 * Install Node.js via Homebrew.
 */
export async function installNode(): Promise<void> {
  return invoke('install_node_via_brew');
}

/**
 * Install Git via Homebrew.
 */
export async function installGit(): Promise<void> {
  return invoke('install_git_via_brew');
}

/**
 * Install GitHub CLI via Homebrew.
 */
export async function installGh(): Promise<void> {
  return invoke('install_gh_via_brew');
}

/**
 * Start GitHub authentication flow (opens browser).
 * Returns a message to display to the user.
 */
export async function startGitHubAuth(): Promise<string> {
  return invoke<string>('start_github_auth');
}

/**
 * Install Claude Code CLI.
 */
export async function installClaude(): Promise<void> {
  return invoke('install_claude_cli');
}

/**
 * Start Claude authentication flow.
 * Returns a message to display to the user.
 */
export async function startClaudeAuth(): Promise<string> {
  return invoke<string>('start_claude_auth');
}

/**
 * Check if Claude is authenticated.
 */
export async function checkClaudeAuthStatus(): Promise<boolean> {
  return invoke<boolean>('check_claude_auth_status');
}

/**
 * Install Vercel CLI.
 */
export async function installVercel(): Promise<void> {
  return invoke('install_vercel_cli');
}

/**
 * Start Vercel authentication flow (opens browser).
 * Returns a message to display to the user.
 */
export async function startVercelAuth(): Promise<string> {
  return invoke<string>('start_vercel_auth');
}

// ============ Terminal Commands ============

/** Terminal command configuration */
export interface TerminalCommand {
  command: string;
  args: string[];
}

/** Terminal commands for interactive installations/auth */
export const TERMINAL_COMMANDS: Record<string, TerminalCommand> = {
  homebrew: {
    command: '/bin/bash',
    args: [
      '-c',
      'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash',
    ],
  },
  gh_auth: {
    command: 'gh',
    args: ['auth', 'login', '--web', '--git-protocol', 'https'],
  },
  claude: {
    command: 'bash',
    args: ['-ic', 'curl -fsSL https://claude.ai/install.sh | bash'],
  },
  claude_auth: {
    command: 'claude',
    args: [],
  },
  vercel_auth: {
    command: 'vercel',
    args: ['login'],
  },
};

/** Set of item IDs that require interactive terminal */
export const USES_TERMINAL = new Set([
  'homebrew',
  'gh_auth',
  'claude',
  'claude_auth',
  'vercel_auth',
]);
