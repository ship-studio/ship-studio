/**
 * Agent-led onboarding: the agent does the setup work, the app verifies it.
 *
 * The flow inverts the classic wizard. Phase 0 gets exactly one AI agent
 * installed + signed in (the only part that can't be agent-led). Phase 1
 * spawns that agent in a terminal with a prescriptive setup prompt and lets
 * it install everything else (Homebrew/winget, Node, Git, GitHub CLI, GitHub
 * sign-in) while a checklist polls `get_full_setup_status` — the backend's
 * real checks, never the agent's own claims, decide when setup is complete.
 *
 * @module lib/agentOnboarding
 */

import { agentPromptArgs } from './agent';
import { invoke } from '@tauri-apps/api/core';
import { SetupItem, isSetupItemReady, isWindows, TerminalCommand } from './setup';

// ============ Test-mode API ============

/** How the app was launched, for swapping real side effects in test modes. */
export interface OnboardingTestMode {
  /** `SHIPSTUDIO_FORCE_SETUP` is set — statuses are mocked; run the scripted demo. */
  mock: boolean;
  /** `SHIPSTUDIO_FORCE_ONBOARDING` is set — real checks, wizard forced open. */
  forceOnboarding: boolean;
}

export async function getOnboardingTestMode(): Promise<OnboardingTestMode> {
  return invoke<OnboardingTestMode>('get_onboarding_test_mode');
}

/**
 * Flip one item to ready in the backend's mock state (mock mode only).
 * The demo agent session calls this on a timeline so the checklist UI is
 * exercised end-to-end without touching the host machine.
 */
export async function mockMarkSetupItemReady(itemId: string): Promise<void> {
  return invoke('mock_mark_setup_item_ready', { itemId });
}

/**
 * Persist that the user brings their own agent ("Other" in the agent pick).
 * Setup checks then treat the agent requirement as satisfied so the user
 * isn't redirected back to onboarding on every launch.
 */
export async function setExternalAgentOptIn(enabled: boolean): Promise<void> {
  return invoke('set_external_agent_opt_in', { enabled });
}

/**
 * Directory the guided agent session runs in — the projects root
 * (~/ShipStudio), created if missing. Never the user's home: an agent
 * scanning $HOME trips macOS permission prompts (Photos, Desktop, Documents)
 * attributed to Ship Studio, and the pending dialog freezes the agent
 * mid-scan.
 */
export async function ensureAgentWorkdir(): Promise<string> {
  return invoke<string>('ensure_agent_workdir');
}

// ============ Default host ============

/** Hosting providers offered during onboarding. */
export type HostChoice = 'vercel' | 'cloudflare';

/**
 * Persist the workspace-wide default hosting provider. New projects default
 * to this host (the way Vercel is used for all projects today).
 */
export async function setDefaultHost(host: HostChoice): Promise<void> {
  return invoke('set_default_host', { host });
}

/** The persisted default hosting provider, if one was chosen. */
export async function getDefaultHost(): Promise<HostChoice | null> {
  return invoke<HostChoice | null>('get_default_host');
}

// ============ Required items & completion ============

/**
 * Everything the guided phase is responsible for, in install order. The agent
 * pair itself is handled in Phase 0 and checked separately; Vercel stays
 * optional (connectable later from the dashboard), matching the classic
 * wizard's skippable hosting step.
 */
export const AGENT_LED_REQUIRED_ITEM_IDS = [
  'homebrew',
  'node',
  'npm_fix',
  'git',
  'gh',
  'gh_auth',
] as const;

/**
 * Required items that are present in the status and not yet ready.
 * Absent items count as ready (`npm_fix` only exists while ~/.npm is broken).
 */
export function getMissingRequiredItems(items: SetupItem[]): SetupItem[] {
  return AGENT_LED_REQUIRED_ITEM_IDS.map((id) => items.find((i) => i.id === id)).filter(
    (item): item is SetupItem => item !== undefined && item.status !== 'ready'
  );
}

/** Required items already detected as ready — the prompt names these so the
 *  agent confirms them to the user instead of silently skipping them. */
export function getReadyRequiredItems(items: SetupItem[]): SetupItem[] {
  return AGENT_LED_REQUIRED_ITEM_IDS.map((id) => items.find((i) => i.id === id)).filter(
    (item): item is SetupItem => item !== undefined && item.status === 'ready'
  );
}

/**
 * The agent-led flow is complete when every required item is ready AND the
 * chosen agent pair is ready. Computed from items (not `allReady`) so it
 * stays truthful under SHIPSTUDIO_FORCE_ONBOARDING, which pins `allReady`
 * to false while onboarding is open.
 *
 * `agentBinaryId: null` means the "Other" path — an agent we don't manage —
 * so only the required items gate completion. The backend's own `allReady`
 * still requires a known agent pair, so a user going this route will be
 * offered agent setup again from the dashboard; that's honest, not a bug.
 */
export function isAgentLedSetupComplete(items: SetupItem[], agentBinaryId: string | null): boolean {
  const requiredReady = AGENT_LED_REQUIRED_ITEM_IDS.every((id) => isSetupItemReady(items, id));
  if (agentBinaryId === null) return requiredReady;
  const pairReady =
    items.find((i) => i.id === agentBinaryId)?.status === 'ready' &&
    items.find((i) => i.id === `${agentBinaryId}_auth`)?.status === 'ready';
  return requiredReady && pairReady;
}

// ============ Guided prompt ============

/**
 * Per-item install instructions the agent is told to use, phrased as prompt
 * fragments. These mirror the classic wizard's canonical commands
 * (TERMINAL_COMMANDS / installPackages in lib/setup.ts) — the agent gets the
 * wizard's logic as instructions instead of code, so it doesn't improvise.
 */
function itemInstruction(itemId: string, win: boolean): string | null {
  switch (itemId) {
    case 'homebrew':
      return win
        ? 'the winget package manager: it ships with Windows via "App Installer" — check with `winget --version`, and if missing, tell the user to install "App Installer" from the Microsoft Store, then verify again'
        : 'Homebrew: run `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` — warn the user first that macOS will ask for their computer password and that nothing appears on screen while they type it';
    case 'node':
      return win
        ? 'Node.js: run `winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements`'
        : 'Node.js: run `brew install node` (batch it with git/gh into one `brew install` when those are also missing; if Homebrew was installed moments ago, run `eval "$(/opt/homebrew/bin/brew shellenv)"` first on Apple Silicon, or use /usr/local/bin/brew on Intel)';
    case 'npm_fix':
      return win
        ? 'fix npm cache permissions: run `icacls "$env:USERPROFILE\\.npm" /grant "$env:USERNAME:(OI)(CI)F" /T` in PowerShell'
        : 'fix npm cache permissions: run `sudo chown -R $(whoami) ~/.npm` (this needs the computer password again)';
    case 'git':
      return win
        ? 'Git: run `winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements`'
        : 'Git: run `brew install git`';
    case 'gh':
      return win
        ? 'GitHub CLI: run `winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements`'
        : 'GitHub CLI: run `brew install gh`';
    case 'gh_auth':
      return 'GitHub sign-in: run `gh auth login --web --git-protocol https` — tell the user a browser will open where they sign in or create a free GitHub account, and that they should come back here afterwards';
    default:
      return null;
  }
}

/** Friendly names for the prompt's "missing" summary. */
const PROMPT_ITEM_NAMES: Record<string, string> = {
  homebrew: 'a package manager',
  node: 'Node.js',
  npm_fix: 'working npm permissions',
  git: 'Git',
  gh: 'the GitHub CLI',
  gh_auth: 'a GitHub sign-in',
};

/**
 * Build the single-message setup prompt for the guided phase.
 *
 * Deliberately a single line: multi-line argv survives every PTY spawn shape
 * (including the Windows cmd.exe-wrapped .cmd shims) only if there are no
 * newlines to re-parse. Deliberately prescriptive: exact commands, verify
 * before moving on, plain language — the classic wizard rewritten as
 * instructions. The app's own checks decide completion, and the prompt says
 * so, so the agent doesn't overclaim.
 */
export function buildGuidedSetupPrompt(
  missing: SetupItem[],
  host: HostChoice | null = null,
  alreadyReady: SetupItem[] = []
): string {
  const win = isWindows();

  // The agent is the source of discovery: it gets the FULL required list
  // with check commands and verifies everything itself. Our detection rides
  // along only as a reference hint it can override — the app's probes and
  // the agent's terminal can see different PATHs, and the terminal is where
  // the work actually happens.
  const requiredIds: string[] = ['homebrew', 'node', 'git', 'gh', 'gh_auth'];
  // npm_fix is conditional — it only exists while ~/.npm is broken, so it
  // joins the list only when our checks actually surfaced it.
  if (missing.some((i) => i.id === 'npm_fix')) {
    requiredIds.splice(1, 0, 'npm_fix');
  }
  const instructions = requiredIds
    .map((id) => itemInstruction(id, win))
    .filter((s): s is string => s !== null);

  const pkgCheck = win ? '`winget --version`' : '`brew --version`';
  const checkCommands = [
    pkgCheck,
    '`node --version`',
    '`git --version`',
    '`gh --version`',
    '`gh auth status`',
  ];

  // The chosen hosting provider's CLI is installed last (both are npm
  // packages, so Node must land first) and signed in via its browser flow.
  if (host === 'vercel') {
    instructions.push(
      'Vercel CLI (their hosting provider): run `npm install -g vercel --force`, then sign them in with `vercel login` — a browser opens where they sign in or create a free Vercel account'
    );
    checkCommands.push('`vercel whoami`');
  } else if (host === 'cloudflare') {
    instructions.push(
      'Cloudflare Wrangler CLI (their hosting provider): run `npm install -g wrangler --force`, then sign them in with `wrangler login` — a browser opens where they sign in or create a free Cloudflare account'
    );
    checkCommands.push('`wrangler whoami`');
  }

  const missingNames = missing.map((i) => PROMPT_ITEM_NAMES[i.id] ?? i.id).join(', ');
  const readyNames = alreadyReady.map((i) => PROMPT_ITEM_NAMES[i.id] ?? i.id).join(', ');
  const detectionHint =
    missingNames && readyNames
      ? `For reference, Ship Studio's own detection currently reports installed: ${readyNames}; missing: ${missingNames} — but trust what your checks find over this list. `
      : missingNames
        ? `For reference, Ship Studio's own detection currently reports everything missing: ${missingNames} — but trust what your checks find over this list. `
        : "For reference, Ship Studio's own detection reports everything already installed — but trust what your checks find over this list. ";

  const steps = instructions.map((s, idx) => `${String(idx + 1)}) ${s}`).join('; ');

  return (
    'You are helping a brand-new Ship Studio user get their computer ready. ' +
    'Ship Studio is a desktop app for building websites with AI agents, and you are that agent — this is their first impression of you, so be warm, brief, and clear. ' +
    'Assume the user is not technical: before each step, say what you are about to do in one short sentence. ' +
    `Start by checking what is already installed yourself: run ${checkCommands.join(', ')}, then give the user one short summary of what's already good and what's missing. ` +
    detectionHint +
    `Then set up ONLY what is actually missing, one at a time, in this order, using these exact commands as the standard path: ${steps}. ` +
    'Skip any step whose tool already works. ' +
    'When you are asked to approve a command permission, reassure the user it is safe to approve the commands listed above. ' +
    'After each install, verify it actually worked (run the tool with --version, or `gh auth status` for the sign-in) before moving on — a clean exit is a claim, not proof. ' +
    'Your job is to get every listed tool working no matter what this machine throws at you: if a standard command fails, read the error, explain it in plain words, and fix the underlying problem — installing prerequisites (like Xcode Command Line Tools), repairing PATH or npm permissions, or retrying another official install method are all fair game. ' +
    'If the user has to do something themselves (type a password, click through a browser), tell them exactly what to expect. ' +
    'Do not set up anything unrelated to the tools listed above. ' +
    'When everything is verified, tell the user they are all set and to look at the checklist beside this window — Ship Studio runs its own checks and will turn every item green, then show a Continue button.'
  );
}

// ============ Agent spawn mapping ============

/**
 * How to launch each agent CLI as an interactive session seeded with a
 * prompt. Verified against each CLI's --help: claude, codex and cursor-agent
 * take the initial prompt as a positional argument; opencode's positional is
 * a project directory, so it takes `--prompt` instead.
 */
export function guidedAgentSpawn(agentBinaryId: string, prompt: string): TerminalCommand {
  const binary = agentBinaryId === 'cursor' ? 'cursor-agent' : agentBinaryId;
  return { command: binary, args: agentPromptArgs(agentBinaryId, prompt) };
}

/**
 * Plain interactive shell for the "Other" path — the user launches whatever
 * agent CLI they use and pastes the guided prompt themselves.
 */
export function otherAgentShellSpawn(): TerminalCommand {
  return isWindows() ? { command: 'powershell', args: [] } : { command: '/bin/zsh', args: ['-il'] };
}
