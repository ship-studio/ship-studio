/**
 * Setup/onboarding types and utilities.
 *
 * Manages the dependency graph and status for all setup items:
 * - Package Manager (Homebrew on macOS, Winget on Windows)
 * - Node.js
 * - Git
 * - GitHub CLI + auth
 * - Claude Code + auth
 * - Codex + auth
 * - Opencode + auth
 *
 * @module lib/setup
 */

import { invoke } from '@tauri-apps/api/core';

/** Platform detection helpers using navigator.userAgent as fallback */
const getPlatform = (): string => {
  // Use navigator.userAgent for client-side platform detection
  // Check darwin/mac BEFORE win because 'darwin' contains 'win' as a substring
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('darwin') || userAgent.includes('mac')) return 'macos';
  if (userAgent.includes('win')) return 'windows';
  if (userAgent.includes('linux')) return 'linux';
  return 'unknown';
};

// Cache the platform detection result
let _platform: string | null = null;

const platform = (): string => {
  if (_platform === null) {
    _platform = getPlatform();
  }
  return _platform;
};

/** Platform detection helpers */
export const isWindows = () => platform() === 'windows';

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

/** Optional authentication status (GitHub can be skipped during onboarding) */
interface OptionalAuths {
  /** Whether GitHub is authenticated */
  githubAuthenticated: boolean;
}

/** Full setup status from backend */
export interface FullSetupStatus {
  /** All required items are ready (base tools + at least one agent pair) */
  allReady: boolean;
  /** Individual item statuses */
  items: SetupItem[];
  /** Status of optional authentication items */
  optionalAuths: OptionalAuths;
  /** Agent IDs that are fully set up (installed + authenticated) */
  detectedAgents: string[];
}

/**
 * Items that are optional and can be skipped during onboarding.
 * Individual agent items are "optional" because each one individually is not required,
 * but the backend `allReady` enforces "at least one agent pair".
 */
export const OPTIONAL_ITEMS = new Set([
  'gh_auth',
  'claude',
  'claude_auth',
  'codex',
  'codex_auth',
  'opencode',
  'opencode_auth',
  'vercel',
  'vercel_auth',
]);

/** Quick setup check result (fast Tier-1 check) */
interface QuickSetupCheck {
  /** Whether all binaries and auth files exist */
  allPresent: boolean;
  /** Whether we have a cached setup_complete state */
  setupCompleteCached: boolean;
}

/** Dependency graph: which items must be ready before each item can be installed */
export function getSetupDependencies(): Record<string, string[]> {
  return {
    homebrew: [],
    node: ['homebrew'],
    npm_fix: ['node'], // Conditional: only appears when ~/.npm has bad permissions
    git: ['homebrew'],
    gh: ['homebrew'],
    gh_auth: ['gh'],
    claude: [], // Uses its own installer
    claude_auth: ['claude'],
    codex: [], // Uses npm global install
    codex_auth: ['codex'],
    opencode: [], // Uses its own installer
    opencode_auth: ['opencode'],
    vercel: [], // Uses npm global install
    vercel_auth: ['vercel'],
  };
}

/** Dependency graph for backward compatibility (uses current platform) */
export const SETUP_DEPENDENCIES: Record<string, string[]> = getSetupDependencies();

/** Order to display items (roughly in dependency order) */
export const SETUP_ITEM_ORDER = [
  'homebrew',
  'node',
  'npm_fix',
  'git',
  'gh',
  'gh_auth',
  'claude',
  'claude_auth',
  'codex',
  'codex_auth',
  'opencode',
  'opencode_auth',
  'vercel',
  'vercel_auth',
];

/** Friendly names for each item */
export const SETUP_FRIENDLY_NAMES: Record<string, string> = {
  homebrew: 'Package Manager',
  node: 'Node.js',
  npm_fix: 'Fix npm Permissions',
  git: 'Git',
  gh: 'GitHub CLI',
  gh_auth: 'GitHub Account',
  claude: 'Claude Code',
  claude_auth: 'Claude Account',
  codex: 'Codex',
  codex_auth: 'Codex Account',
  opencode: 'Opencode',
  opencode_auth: 'Opencode Account',
  vercel: 'Vercel CLI',
  vercel_auth: 'Vercel Account',
};

/** Messages shown while item is in progress */
export const SETUP_PROGRESS_MESSAGES: Record<string, string> = {
  homebrew: 'Installing package manager...',
  node: 'Installing Node.js...',
  npm_fix: 'Fixing npm permissions...',
  git: 'Installing Git...',
  gh: 'Installing GitHub CLI...',
  gh_auth: 'Connecting to GitHub...',
  claude: 'Installing Claude Code...',
  claude_auth: 'Connecting to Claude...',
  codex: 'Installing Codex...',
  codex_auth: 'Connecting to Codex...',
  opencode: 'Installing Opencode...',
  opencode_auth: 'Connecting to Opencode...',
  vercel: 'Installing Vercel CLI...',
  vercel_auth: 'Connecting to Vercel...',
};

/** Time estimates for each setup item */
export const SETUP_TIME_ESTIMATES: Record<string, string> = {
  homebrew: '~30 sec',
  node: '~10 sec',
  npm_fix: '~5 sec',
  git: '~5 sec',
  gh: '~1 min',
  gh_auth: '~15 sec',
  claude: '~10 sec',
  claude_auth: '~15 sec',
  codex: '~15 sec',
  codex_auth: '~15 sec',
  opencode: '~15 sec',
  opencode_auth: '~15 sec',
  vercel: '~10 sec',
  vercel_auth: '~15 sec',
};

// ============ Agent Pair Helpers ============

/** Agent item pairs: binary item ID + auth item ID */
export const AGENT_ITEM_PAIRS = [
  { binaryId: 'claude', authId: 'claude_auth' },
  { binaryId: 'codex', authId: 'codex_auth' },
  { binaryId: 'opencode', authId: 'opencode_auth' },
] as const;

/** Agent item IDs (all binary + auth IDs) */
export const AGENT_ITEM_IDS: Set<string> = new Set(
  AGENT_ITEM_PAIRS.flatMap((p) => [p.binaryId, p.authId])
);

/**
 * Returns agent pairs that have both binary and auth ready.
 */
export function getReadyAgentPairs(items: SetupItem[]): (typeof AGENT_ITEM_PAIRS)[number][] {
  return AGENT_ITEM_PAIRS.filter((pair) => {
    const binary = items.find((i) => i.id === pair.binaryId);
    const auth = items.find((i) => i.id === pair.authId);
    return binary?.status === 'ready' && auth?.status === 'ready';
  });
}

/**
 * Returns true if at least one agent pair (binary + auth) is fully ready.
 */
export function isAtLeastOneAgentReady(items: SetupItem[]): boolean {
  return getReadyAgentPairs(items).length > 0;
}

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

/**
 * Merge plugin-contributed setup items into the base dependency graph.
 *
 * Plugin items are prefixed with their plugin ID to avoid key collisions.
 * Existing setup items are untouched — this is purely additive.
 */
export function mergePluginSetupItems(
  baseDeps: Record<string, string[]>,
  pluginItems: Array<{ pluginId: string; id: string; depends_on: string[] }>
): Record<string, string[]> {
  const merged = { ...baseDeps };

  for (const item of pluginItems) {
    const key = `${item.pluginId}:${item.id}`;
    // Prefix dependency IDs with pluginId if they don't already contain ':'
    const deps = item.depends_on.map((d) => (d.includes(':') ? d : `${item.pluginId}:${d}`));
    merged[key] = deps;
  }

  return merged;
}

// ============ Wizard Step Definitions ============

export type WizardStepId = 'package-manager' | 'git-github' | 'agent' | 'hosting';

interface WizardStepDef {
  id: WizardStepId;
  title: string;
  subtitle: string;
  itemIds: string[];
  skippable: boolean;
}

export const WIZARD_STEPS: WizardStepDef[] = [
  {
    id: 'package-manager',
    title: 'Package Manager & Node.js',
    subtitle: 'Install the tools needed to manage dependencies',
    itemIds: ['homebrew', 'node', 'npm_fix'],
    skippable: false,
  },
  {
    id: 'git-github',
    title: 'Git & GitHub',
    subtitle: 'Set up version control and repository hosting',
    itemIds: ['git', 'gh', 'gh_auth'],
    skippable: false,
  },
  {
    id: 'agent',
    title: 'AI Agent',
    subtitle: 'Install at least one AI coding assistant',
    itemIds: ['claude', 'claude_auth', 'codex', 'codex_auth', 'opencode', 'opencode_auth'],
    skippable: false,
  },
  {
    id: 'hosting',
    title: 'Hosting Provider',
    subtitle: 'Deploy your projects to the web',
    itemIds: ['vercel', 'vercel_auth'],
    skippable: true,
  },
];

/**
 * Get the items for a wizard step, filtering out items not present in the current status.
 */
export function getStepItems(stepId: WizardStepId, items: SetupItem[]): SetupItem[] {
  const step = WIZARD_STEPS.find((s) => s.id === stepId);
  if (!step) return [];
  return step.itemIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is SetupItem => i !== undefined);
}

/**
 * Check if a wizard step is complete.
 * - package-manager / git-github: all present items must be ready
 * - agent: at least one agent pair (binary + auth) must be ready
 * - hosting: always complete (placeholder)
 */
export function isWizardStepComplete(stepId: WizardStepId, items: SetupItem[]): boolean {
  if (stepId === 'hosting') {
    // Hosting is complete when both vercel and vercel_auth are ready.
    // If items aren't present (e.g. backend hasn't reported them), treat as incomplete
    // so the step shows up rather than being silently skipped.
    const stepItems = getStepItems(stepId, items);
    return stepItems.length > 0 && stepItems.every((i) => i.status === 'ready');
  }

  if (stepId === 'agent') {
    return isAtLeastOneAgentReady(items);
  }

  const stepItems = getStepItems(stepId, items);
  return stepItems.length > 0 && stepItems.every((i) => i.status === 'ready');
}

/**
 * Find the first incomplete wizard step. Returns null if all are complete.
 */
export function findFirstIncompleteStep(items: SetupItem[]): WizardStepId | null {
  for (const step of WIZARD_STEPS) {
    if (!isWizardStepComplete(step.id, items)) {
      return step.id;
    }
  }
  return null;
}

// ============ Backend API ============

/**
 * Get full setup status for all items.
 */
export async function getFullSetupStatus(): Promise<FullSetupStatus> {
  return invoke<FullSetupStatus>('get_full_setup_status');
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
 * Start agent authentication flow.
 * If agentId is provided, authenticate that specific agent.
 * Returns a message to display to the user.
 */
export async function startClaudeAuth(agentId?: string): Promise<string> {
  return invoke<string>('start_claude_auth', { agentId: agentId ?? null });
}

/**
 * Check if an agent is authenticated.
 * If agentId is provided, check that specific agent.
 */
export async function checkClaudeAuthStatus(agentId?: string): Promise<boolean> {
  return invoke<boolean>('check_claude_auth_status', { agentId: agentId ?? null });
}

/**
 * Quick setup check - only checks binary/file existence (no subprocess calls).
 * Returns in ~10ms vs 2-5 seconds for full setup check.
 */
export async function quickSetupCheck(): Promise<QuickSetupCheck> {
  return invoke<QuickSetupCheck>('quick_setup_check');
}

/**
 * Mark setup as complete (persists to disk).
 * Called when onboarding finishes successfully.
 */
export async function markSetupComplete(): Promise<void> {
  return invoke('mark_setup_complete');
}

/**
 * Get the default agent ID from persisted AppState.
 * Returns null if not set (falls back to Claude Code).
 */
export async function getDefaultAgentId(): Promise<string | null> {
  return invoke<string | null>('get_default_agent_id');
}

/**
 * Set the default agent ID. Persists to AppState and updates in-memory cache.
 */
export async function setDefaultAgentId(agentId: string): Promise<void> {
  return invoke('set_default_agent_id', { agentId });
}

/**
 * Batch install multiple Homebrew packages in a single command.
 * This is faster than individual installs because auto-update only runs once
 * and Homebrew can download bottles in parallel.
 *
 * @param packages - Array of item IDs to install (e.g., ['node', 'git', 'gh'])
 */
async function installBrewPackages(packages: string[]): Promise<void> {
  return invoke('install_brew_packages', { packages });
}

/**
 * Batch install multiple Winget packages (Windows only).
 * Similar to installBrewPackages but for Windows.
 *
 * @param packages - Array of item IDs to install (e.g., ['node', 'git', 'gh'])
 */
async function installWingetPackages(packages: string[]): Promise<void> {
  return invoke('install_winget_packages', { packages });
}

/**
 * Install packages using the appropriate package manager for the current platform.
 * Automatically uses Homebrew on macOS/Linux or Winget on Windows.
 *
 * @param packages - Array of item IDs to install (e.g., ['node', 'git', 'gh'])
 */
export async function installPackages(packages: string[]): Promise<void> {
  if (isWindows()) {
    return installWingetPackages(packages);
  } else {
    return installBrewPackages(packages);
  }
}

/** Brew-installed packages that can be batched */
export const BREW_PACKAGES = new Set(['node', 'git', 'gh']);

/** Package manager-installed packages (Homebrew on macOS, Winget on Windows) */
export const PKG_MGR_PACKAGES = new Set(['node', 'git', 'gh']);

/**
 * Check if the npm cache directory (~/.npm) is writable.
 * Returns "ok" or "not_writable".
 */
export async function checkNpmCachePermissions(): Promise<string> {
  return invoke<string>('check_npm_cache_permissions');
}

// ============ Terminal Commands ============

/** Terminal command configuration */
export interface TerminalCommand {
  command: string;
  args: string[];
}

/** Get terminal commands based on current platform */
export function getTerminalCommands(): Record<string, TerminalCommand> {
  const isWin = isWindows();

  if (isWin) {
    // Windows commands (using PowerShell where needed)
    return {
      homebrew: {
        // Not applicable on Windows, but keep for compatibility
        command: 'powershell',
        args: [
          '-Command',
          'Write-Host "Winget should be pre-installed on Windows 10 21H2+. Please install from Microsoft Store if missing."',
        ],
      },
      npm_fix: {
        command: 'powershell',
        args: [
          '-Command',
          'Write-Host "Fixing npm cache permissions..." ; icacls "$env:USERPROFILE\\.npm" /grant "$env:USERNAME:(OI)(CI)F" /T ; Write-Host "Done! npm permissions fixed."',
        ],
      },
      gh_auth: {
        command: 'gh',
        args: ['auth', 'login', '--web', '--git-protocol', 'https'],
      },
      claude: {
        // Windows requires manual installer download
        command: 'powershell',
        args: [
          '-Command',
          'Write-Host "Please download Claude Code from https://claude.ai"; Start-Process "https://claude.ai"',
        ],
      },
      claude_auth: {
        command: 'claude',
        args: [],
      },
      codex: {
        command: 'npm',
        args: ['install', '-g', '@openai/codex'],
      },
      codex_auth: {
        command: 'codex',
        args: [],
      },
      opencode: {
        command: 'powershell',
        args: [
          '-Command',
          'Write-Host "Please download Opencode from https://opencode.ai"; Start-Process "https://opencode.ai"',
        ],
      },
      opencode_auth: {
        command: 'opencode',
        args: ['auth', 'login'],
      },
      vercel: {
        command: 'npm',
        args: ['install', '-g', 'vercel'],
      },
      vercel_auth: {
        command: 'vercel',
        args: ['login'],
      },
    };
  } else {
    // macOS/Linux commands (using bash)
    return {
      homebrew: {
        command: '/bin/bash',
        args: [
          '-c',
          [
            // Check for admin access before attempting install (Homebrew requires sudo)
            'if ! dseditgroup -o checkmember -m "$(whoami)" admin &>/dev/null; then',
            '  echo "\\033[1;31mError: Homebrew requires administrator access to install.\\033[0m"',
            '  echo ""',
            '  echo "Your macOS user account ($(whoami)) does not have admin privileges."',
            '  echo "To fix this, ask your system administrator to:"',
            '  echo "  1. Open System Settings → Users & Groups"',
            '  echo "  2. Click the ⓘ next to your account"',
            '  echo "  3. Enable \\"Allow this user to administer this computer\\""',
            '  echo ""',
            '  echo "Then restart Ship Studio and try again."',
            '  exit 1',
            'fi',
            // Use command substitution instead of pipe so stdin stays connected to the
            // terminal, allowing the Homebrew installer to interactively prompt for sudo
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          ].join('\n'),
        ],
      },
      npm_fix: {
        command: '/bin/bash',
        args: [
          '-c',
          'echo "Fixing npm cache permissions..." && sudo chown -R $(whoami) ~/.npm && echo "Done! npm permissions fixed."',
        ],
      },
      gh_auth: {
        command: 'gh',
        args: ['auth', 'login', '--web', '--git-protocol', 'https'],
      },
      claude: {
        command: '/bin/bash',
        args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
      },
      claude_auth: {
        command: 'claude',
        args: [],
      },
      codex: {
        command: '/bin/bash',
        args: ['-c', 'npm install -g @openai/codex'],
      },
      codex_auth: {
        command: 'codex',
        args: [],
      },
      opencode: {
        command: '/bin/bash',
        args: ['-c', 'curl -fsSL https://opencode.ai/install | bash'],
      },
      opencode_auth: {
        command: 'opencode',
        args: ['auth', 'login'],
      },
      vercel: {
        command: '/bin/bash',
        args: ['-c', 'npm install -g vercel'],
      },
      vercel_auth: {
        command: 'vercel',
        args: ['login'],
      },
    };
  }
}

/** Terminal commands for interactive installations/auth (uses current platform) */
export const TERMINAL_COMMANDS: Record<string, TerminalCommand> = getTerminalCommands();

/** Set of item IDs that require interactive terminal */
export const USES_TERMINAL = new Set([
  'homebrew',
  'npm_fix',
  'gh_auth',
  'claude',
  'claude_auth',
  'codex',
  'codex_auth',
  'opencode',
  'opencode_auth',
  'vercel',
  'vercel_auth',
]);
