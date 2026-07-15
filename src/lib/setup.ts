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
 * - Cursor + auth
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
/** macOS only. Gates Mac-only features (e.g. the native mobile preview, which
 *  depends on Xcode/simctl and hasn't been validated on Windows). */
export const isMac = () => platform() === 'macos';

/**
 * The OS's file-manager name, for "Reveal in …" / "Open in …" labels. macOS
 * calls it Finder, Windows calls it File Explorer, most Linux DEs call it Files.
 * Keeps user-facing copy honest instead of saying "Finder" on every platform.
 */
export const fileManagerName = (): string => {
  switch (platform()) {
    case 'macos':
      return 'Finder';
    case 'windows':
      return 'File Explorer';
    default:
      return 'Files';
  }
};

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
  'cursor',
  'cursor_auth',
  'vercel',
  'vercel_auth',
]);

/**
 * Tier classification for a setup item.
 *
 * The app conflated two very different things in one flat list: tools that are
 * installed once on the machine and shared by every workspace, and logins that
 * are isolated per workspace. Splitting them is purely a frontend concern — the
 * id taxonomy already encodes the tier (the five `*_auth` ids are the logins),
 * so we classify here rather than widening the backend SetupItemInfo.
 *
 *  - `machine`   — Homebrew, Node, Git, and the CLI binaries. Installed once.
 *  - `workspace` — the five logins (gh / claude / codex / opencode / vercel),
 *                  isolated per workspace via `get_env_vars_for_account`.
 */
export type SetupTier = 'machine' | 'workspace';

/** The five per-workspace logins (the `*_auth` items). Everything else is machine-tier. */
export const WORKSPACE_LOGIN_ITEM_IDS = new Set([
  'gh_auth',
  'claude_auth',
  'codex_auth',
  'opencode_auth',
  'cursor_auth',
  'vercel_auth',
]);

/** Machine-tier items: runtimes + CLI binaries installed once and shared by every workspace. */
export const MACHINE_ITEM_IDS = new Set([
  'homebrew',
  'node',
  'npm_fix',
  'git',
  'gh',
  'claude',
  'codex',
  'opencode',
  'cursor',
  'vercel',
]);

/** Classify a setup item id as machine- or workspace-tier. */
export function tierOf(itemId: string): SetupTier {
  return WORKSPACE_LOGIN_ITEM_IDS.has(itemId) ? 'workspace' : 'machine';
}

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
    claude: [], // Uses its own installer (native, not npm)
    claude_auth: ['claude'],
    codex: ['node'], // npm global install — fails with a misleading error without Node
    codex_auth: ['codex'],
    // npm-based on Windows; macOS/Linux uses its own curl installer
    opencode: isWindows() ? ['node'] : [],
    opencode_auth: ['opencode'],
    cursor: [], // Uses its own installer (native, not npm)
    cursor_auth: ['cursor'],
    vercel: ['node'], // npm global install — fails with a misleading error without Node
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
  'cursor',
  'cursor_auth',
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
  cursor: 'Cursor',
  cursor_auth: 'Cursor Account',
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
  cursor: 'Installing Cursor...',
  cursor_auth: 'Connecting to Cursor...',
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
  cursor: '~10 sec',
  cursor_auth: '~15 sec',
  vercel: '~10 sec',
  vercel_auth: '~15 sec',
};

// ============ Agent Pair Helpers ============

/** Agent item pairs: binary item ID + auth item ID */
export const AGENT_ITEM_PAIRS = [
  { binaryId: 'claude', authId: 'claude_auth' },
  { binaryId: 'codex', authId: 'codex_auth' },
  { binaryId: 'opencode', authId: 'opencode_auth' },
  { binaryId: 'cursor', authId: 'cursor_auth' },
] as const;

/** Agent item IDs (all binary + auth IDs) */
export const AGENT_ITEM_IDS: Set<string> = new Set(
  AGENT_ITEM_PAIRS.flatMap((p) => [p.binaryId, p.authId])
);

/**
 * Official, verified install/setup docs per agent. Surfaced in the AI Agent
 * step subtitle so users who hit install trouble in-app (e.g. the Windows
 * Claude hiccup) can fall back to the canonical instructions, then restart.
 */
export const AGENT_DOC_LINKS: { binaryId: string; name: string; url: string }[] = [
  { binaryId: 'claude', name: 'Claude Code', url: 'https://code.claude.com/docs/en/setup' },
  { binaryId: 'codex', name: 'Codex', url: 'https://github.com/openai/codex' },
  { binaryId: 'opencode', name: 'opencode', url: 'https://opencode.ai/docs/' },
  { binaryId: 'cursor', name: 'Cursor CLI', url: 'https://cursor.com/docs/cli/overview' },
];

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
 * Check whether an item shows as ready in a (freshly fetched) item list.
 *
 * An item *absent* from the list counts as ready: the backend drops items
 * that are no longer applicable (e.g. `npm_fix` disappears from
 * `get_full_setup_status` once the permissions are actually fixed), and
 * treating that as "not ready" would flag a successful fix as a failure.
 */
export function isSetupItemReady(items: SetupItem[], itemId: string): boolean {
  const item = items.find((i) => i.id === itemId);
  return item === undefined || item.status === 'ready';
}

/**
 * Run a boolean check immediately and then re-check on a staggered schedule
 * before giving up. Auth/token files (and freshly installed binaries) can
 * land a beat *after* the child process exits, so a single immediate check
 * produces false "not completed" failures — the dashboard AgentsPanel
 * re-checks at 600/1500/3000ms after terminal exit for exactly this reason.
 *
 * `delays` are offsets in ms from the first (immediate) check, matching the
 * AgentsPanel schedule. Resolves `true` as soon as any check passes.
 */
export async function recheckWithDelays(
  check: () => Promise<boolean>,
  delays: number[] = [600, 1500, 3000]
): Promise<boolean> {
  if (await check()) return true;
  let waited = 0;
  for (const target of delays) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, target - waited)));
    waited = target;
    if (await check()) return true;
  }
  return false;
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
    subtitle: 'Save your work safely and publish it online. Required.',
    itemIds: ['git', 'gh', 'gh_auth'],
    skippable: false,
  },
  {
    id: 'agent',
    title: 'AI Agent',
    subtitle: 'Install at least one AI coding assistant',
    itemIds: [
      'claude',
      'claude_auth',
      'codex',
      'codex_auth',
      'opencode',
      'opencode_auth',
      'cursor',
      'cursor_auth',
    ],
    skippable: false,
  },
  {
    id: 'hosting',
    title: 'Hosting Provider',
    subtitle: 'Optional. Connect later to put your site on the web.',
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

/** A CLI binary resolved on the backend's extended PATH. */
export interface ResolvedCli {
  /** Absolute path to the binary. */
  path: string;
  /** Directory containing the binary — for appending to a PTY PATH. */
  dir: string;
}

/**
 * Resolve a bare CLI name (e.g. "gh", "vercel") to an absolute path using the
 * same discovery the setup status checks use (login-shell PATH + common
 * install locations). Returns `null` when the binary isn't installed.
 * Terminal spawns use this to fail fast with a clear message instead of
 * launching a PTY that silently produces nothing, and to make the PTY see the
 * exact binary the status checks saw.
 */
export async function resolveCliPath(name: string): Promise<ResolvedCli | null> {
  return invoke<ResolvedCli | null>('resolve_cli_path', { name });
}

/**
 * Windows spawn decision: should this command be wrapped as
 * `cmd.exe /C <command> <args...>`, or spawned directly through the PTY?
 *
 * Only `.cmd`/`.bat` shims (npm, vercel, npx, …) NEED the cmd.exe wrapper —
 * they are batch scripts, not executables. For real executables the wrapper
 * adds a second parse layer with its own quote rules: portable_pty rebuilds
 * a single command-line string from the argv, and `cmd.exe /C` RE-PARSES
 * that string (see the quote-processing rules in `cmd /?`) before the target
 * ever sees it. Spawning the resolved executable directly removes that layer
 * entirely — the target's CRT parses exactly what portable_pty composed.
 *
 * Whether cmd's re-parse actually mangles a piped `-Command` argument is
 * measured (not assumed) by the canary pair in
 * src-tauri/src/commands/pty_session.rs. RECORDED VERDICT (Windows runner,
 * job 85754711506): the piped expression survives BOTH shapes intact — the
 * quote-stripping hazard was a false alarm. (Two earlier CI hangs initially
 * blamed on quote-stripping were the test harness not answering ConPTY's
 * DSR handshake.) Direct spawn is kept as a defensive simplification —
 * strictly more deterministic — not as a bug fix.
 *
 * @param command the command as configured (e.g. "npm", "powershell", "gh")
 * @param resolvedPath absolute path from {@link resolveCliPath}, when
 *   resolution succeeded; `undefined`/`null` when it failed or was skipped
 *   (fail-open), in which case the conservative default is to wrap — except
 *   for PowerShell, which is a real executable on every Windows install.
 */
export function needsCmdExeWrapper(command: string, resolvedPath?: string | null): boolean {
  const base = command.toLowerCase().split(/[\\/]/).pop() ?? '';
  if (
    base === 'powershell' ||
    base === 'powershell.exe' ||
    base === 'pwsh' ||
    base === 'pwsh.exe'
  ) {
    // Always safe to spawn directly — and required for piped -Command args.
    return false;
  }
  // Judge by the binary the spawn will actually hit; fall back to the
  // command string itself if it already names a script.
  const probe = (resolvedPath ?? command).toLowerCase();
  if (probe.endsWith('.cmd') || probe.endsWith('.bat')) {
    return true; // batch shim — only cmd.exe can run it
  }
  if (probe.endsWith('.exe') || probe.endsWith('.com')) {
    return false; // real executable — spawn directly
  }
  // Unresolved, or resolved to something without a recognized executable
  // extension (npm ships an extensionless `npm` sh script NEXT TO npm.cmd,
  // and the backend's extended-PATH probe can return it): keep the historical
  // cmd.exe wrapper as the conservative default — cmd re-searches PATH with
  // PATHEXT and finds the proper .cmd/.exe.
  return true;
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
        // Not applicable on Windows, but keep for compatibility. This is an
        // informational echo that exits 0 on purpose — the wizard's
        // post-success verification re-checks the item and surfaces an error
        // state if winget still isn't detected afterwards.
        command: 'powershell',
        args: [
          '-Command',
          'Write-Host "Winget was not detected. Install \'App Installer\' from the Microsoft Store, then click Install again."',
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
        // Official native installer for Windows (mirrors the macOS install.sh
        // path). `irm | iex` downloads and runs the install script in-session;
        // it is not subject to the .ps1 script execution policy.
        command: 'powershell',
        args: ['-Command', 'irm https://claude.ai/install.ps1 | iex'],
      },
      claude_auth: {
        // Dedicated sign-in flow (`claude auth login` — "Sign in to your
        // Anthropic account"). The bare CLI used to be spawned here, which
        // stranded non-technical users in the chat REPL when the CLI didn't
        // auto-prompt for login (audit #7). The `claude auth` command family
        // is the same one the backend already relies on for status checks
        // (`claude auth status`, src-tauri/src/commands/accounts.rs).
        command: 'claude',
        args: ['auth', 'login'],
      },
      codex: {
        // --force clears EEXIST failures from stale/partial global installs,
        // which npm otherwise reports opaquely (issue #164).
        command: 'npm',
        args: ['install', '-g', '@openai/codex', '--force'],
      },
      codex_auth: {
        // Dedicated login subcommand (`codex login` — "Manage login") instead
        // of the bare CLI, which dropped users into the agent chat UI when it
        // didn't auto-prompt for sign-in (audit #7). Exits when auth completes.
        command: 'codex',
        args: ['login'],
      },
      opencode: {
        // No clean PowerShell one-liner installer exists for Windows; install
        // via npm (Node is set up in step 1, same as Codex below).
        // --force clears EEXIST failures from stale/partial global installs.
        command: 'npm',
        args: ['install', '-g', 'opencode-ai', '--force'],
      },
      opencode_auth: {
        command: 'opencode',
        args: ['auth', 'login'],
      },
      cursor: {
        // Official Windows installer (downloads + runs the install script
        // in-session; not subject to the .ps1 execution policy).
        command: 'powershell',
        args: ['-Command', "irm 'https://cursor.com/install?win32=true' | iex"],
      },
      cursor_auth: {
        command: 'cursor-agent',
        args: ['login'],
      },
      vercel: {
        // --force clears EEXIST failures from stale/partial global installs.
        command: 'npm',
        args: ['install', '-g', 'vercel', '--force'],
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
            // Capture the installer script first so a failed download fails
            // *loudly*: with a bare `bash -c "$(curl …)"`, an offline curl
            // yields an empty substitution and bash exits 0 — a silent
            // dead-end where nothing installed but nothing errored either.
            // Use command substitution instead of a pipe so stdin stays
            // connected to the terminal, allowing the Homebrew installer to
            // interactively prompt for sudo.
            'script="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || { echo "Download failed — check your internet connection and try again."; exit 1; }',
            '[ -n "$script" ] || { echo "Download failed — empty installer. Check your internet connection and try again."; exit 1; }',
            'exec /bin/bash -c "$script"',
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
        // Dedicated sign-in flow (`claude auth login`) — see the Windows entry
        // above for why the bare CLI is not spawned here (audit #7).
        command: 'claude',
        args: ['auth', 'login'],
      },
      codex: {
        // --force clears EEXIST failures from stale/partial global installs,
        // which npm otherwise reports opaquely (issue #164).
        command: '/bin/bash',
        args: ['-c', 'npm install -g @openai/codex --force'],
      },
      codex_auth: {
        // Dedicated login subcommand (`codex login`) — see the Windows entry
        // above for why the bare CLI is not spawned here (audit #7).
        command: 'codex',
        args: ['login'],
      },
      opencode: {
        command: '/bin/bash',
        args: ['-c', 'curl -fsSL https://opencode.ai/install | bash'],
      },
      opencode_auth: {
        command: 'opencode',
        args: ['auth', 'login'],
      },
      cursor: {
        command: '/bin/bash',
        args: ['-c', 'curl https://cursor.com/install -fsS | bash'],
      },
      cursor_auth: {
        command: 'cursor-agent',
        args: ['login'],
      },
      vercel: {
        // --force clears EEXIST failures from stale/partial global installs.
        command: '/bin/bash',
        args: ['-c', 'npm install -g vercel --force'],
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
  'cursor',
  'cursor_auth',
  'vercel',
  'vercel_auth',
]);
