/**
 * Shared test fixtures for onboarding/setup tests.
 *
 * Pre-built SetupItem arrays and FullSetupStatus objects for common scenarios
 * so each test file doesn't have to reconstruct them from scratch.
 */

import type { SetupItem, FullSetupStatus } from '../../lib/setup';

// ============ Helper to build individual items ============

function item(
  id: string,
  friendlyName: string,
  status: SetupItem['status'],
  extra?: Partial<SetupItem>
): SetupItem {
  return { id, friendlyName, status, ...extra };
}

// ============ Ready items ============

const HOMEBREW_READY = item('homebrew', 'Package Manager', 'ready', { version: '4.2.0' });
const NODE_READY = item('node', 'Node.js', 'ready', { version: 'v20.11.0' });
const GIT_READY = item('git', 'Git', 'ready', { version: 'git version 2.43.0' });
const GH_READY = item('gh', 'GitHub CLI', 'ready', { version: 'gh version 2.40.0' });
const GH_AUTH_READY = item('gh_auth', 'GitHub Account', 'ready', { username: 'testuser' });
const CLAUDE_READY = item('claude', 'Claude Code', 'ready', { version: '1.0.0' });
const CLAUDE_AUTH_READY = item('claude_auth', 'Claude Account', 'ready', {
  username: 'claude-user',
});
const CODEX_READY = item('codex', 'Codex', 'ready', { version: '0.1.0' });
const CODEX_AUTH_READY = item('codex_auth', 'Codex Account', 'ready', { username: 'codex-user' });
const OPENCODE_READY = item('opencode', 'Opencode', 'ready', { version: '0.1.0' });
const VERCEL_READY = item('vercel', 'Vercel CLI', 'ready', { version: '33.0.0' });
const VERCEL_AUTH_READY = item('vercel_auth', 'Vercel Account', 'ready', {
  username: 'vercel-user',
});

// ============ Not-installed items ============

const HOMEBREW_MISSING = item('homebrew', 'Package Manager', 'not_installed');
const NODE_MISSING = item('node', 'Node.js', 'not_installed');
const GIT_MISSING = item('git', 'Git', 'not_installed');
const GH_MISSING = item('gh', 'GitHub CLI', 'not_installed');
const GH_AUTH_MISSING = item('gh_auth', 'GitHub Account', 'not_authenticated');
const CLAUDE_MISSING = item('claude', 'Claude Code', 'not_installed');
const CLAUDE_AUTH_MISSING = item('claude_auth', 'Claude Account', 'not_authenticated');
const CODEX_MISSING = item('codex', 'Codex', 'not_installed');
const CODEX_AUTH_MISSING = item('codex_auth', 'Codex Account', 'not_authenticated');
const OPENCODE_MISSING = item('opencode', 'Opencode', 'not_installed');
const OPENCODE_AUTH_MISSING = item('opencode_auth', 'Opencode Account', 'not_authenticated');
const VERCEL_MISSING = item('vercel', 'Vercel CLI', 'not_installed');
const VERCEL_AUTH_MISSING = item('vercel_auth', 'Vercel Account', 'not_authenticated');

// ============ Pre-built item arrays ============

/** Fresh install — nothing installed */
export const FRESH_INSTALL_ITEMS: SetupItem[] = [
  HOMEBREW_MISSING,
  NODE_MISSING,
  GIT_MISSING,
  GH_MISSING,
  GH_AUTH_MISSING,
  CLAUDE_MISSING,
  CLAUDE_AUTH_MISSING,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_MISSING,
  VERCEL_AUTH_MISSING,
];

/** All ready with Claude Code only (no Codex, no Opencode) */
export const ALL_READY_CLAUDE_ONLY: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_READY,
  CLAUDE_READY,
  CLAUDE_AUTH_READY,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_READY,
  VERCEL_AUTH_READY,
];

/** All ready with Claude and Codex (legacy "both agents" — opencode not installed) */
export const ALL_READY_BOTH_AGENTS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_READY,
  CLAUDE_READY,
  CLAUDE_AUTH_READY,
  CODEX_READY,
  CODEX_AUTH_READY,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_READY,
  VERCEL_AUTH_READY,
];

/** All ready with Codex only (no Claude, no Opencode) */
export const ALL_READY_CODEX_ONLY: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_READY,
  CLAUDE_MISSING,
  CLAUDE_AUTH_MISSING,
  CODEX_READY,
  CODEX_AUTH_READY,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_READY,
  VERCEL_AUTH_READY,
];

/** Base tools ready but no agents at all */
export const BASE_READY_NO_AGENTS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_READY,
  CLAUDE_MISSING,
  CLAUDE_AUTH_MISSING,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_MISSING,
  VERCEL_AUTH_MISSING,
];

/** All tools installed, but no auth configured */
export const AUTH_ONLY_ITEMS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_MISSING,
  CLAUDE_READY,
  CLAUDE_AUTH_MISSING,
  CODEX_READY,
  CODEX_AUTH_MISSING,
  OPENCODE_READY,
  OPENCODE_AUTH_MISSING,
  VERCEL_READY,
  VERCEL_AUTH_MISSING,
];

// ============ FullSetupStatus builders ============

/** Create a FullSetupStatus with sensible defaults and optional overrides */
export function makeSetupStatus(overrides?: Partial<FullSetupStatus>): FullSetupStatus {
  return {
    allReady: false,
    items: FRESH_INSTALL_ITEMS,
    optionalAuths: { githubAuthenticated: false },
    detectedAgents: [],
    ...overrides,
  };
}

/** Convenience: status for a fresh install (nothing ready) */
export const FRESH_STATUS: FullSetupStatus = makeSetupStatus();

/** Convenience: status with everything ready + Claude only */
export const CLAUDE_ONLY_STATUS: FullSetupStatus = makeSetupStatus({
  allReady: true,
  items: ALL_READY_CLAUDE_ONLY,
  optionalAuths: { githubAuthenticated: true },
  detectedAgents: ['claude-code'],
});

/** Convenience: status with everything ready + both agents */
export const BOTH_AGENTS_STATUS: FullSetupStatus = makeSetupStatus({
  allReady: true,
  items: ALL_READY_BOTH_AGENTS,
  optionalAuths: { githubAuthenticated: true },
  detectedAgents: ['claude-code', 'codex'],
});

/** Convenience: status with everything ready + Codex only */
export const CODEX_ONLY_STATUS: FullSetupStatus = makeSetupStatus({
  allReady: true,
  items: ALL_READY_CODEX_ONLY,
  optionalAuths: { githubAuthenticated: true },
  detectedAgents: ['codex'],
});

// ============ Wizard-specific fixtures ============

/** Step 1 complete (homebrew + node ready), rest missing */
export const STEP1_COMPLETE_ITEMS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_MISSING,
  GH_MISSING,
  GH_AUTH_MISSING,
  CLAUDE_MISSING,
  CLAUDE_AUTH_MISSING,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_MISSING,
  VERCEL_AUTH_MISSING,
];

export const STEP1_COMPLETE_STATUS: FullSetupStatus = makeSetupStatus({
  items: STEP1_COMPLETE_ITEMS,
  detectedAgents: [],
});

/** Steps 1+2 complete (homebrew, node, git, gh, gh_auth ready) — lands on step 3 */
export const HAS_BASE_NO_AGENTS_ITEMS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_READY,
  CLAUDE_MISSING,
  CLAUDE_AUTH_MISSING,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_MISSING,
  VERCEL_AUTH_MISSING,
];

export const HAS_BASE_NO_AGENTS_STATUS: FullSetupStatus = makeSetupStatus({
  items: HAS_BASE_NO_AGENTS_ITEMS,
  optionalAuths: { githubAuthenticated: true },
  detectedAgents: [],
});

/** Has Claude Code installed but not GitHub auth — lands on step 2 */
export const HAS_CLAUDE_NO_GITHUB_ITEMS: SetupItem[] = [
  HOMEBREW_READY,
  NODE_READY,
  GIT_READY,
  GH_READY,
  GH_AUTH_MISSING,
  CLAUDE_READY,
  CLAUDE_AUTH_READY,
  CODEX_MISSING,
  CODEX_AUTH_MISSING,
  OPENCODE_MISSING,
  OPENCODE_AUTH_MISSING,
  VERCEL_MISSING,
  VERCEL_AUTH_MISSING,
];

export const HAS_CLAUDE_NO_GITHUB_STATUS: FullSetupStatus = makeSetupStatus({
  items: HAS_CLAUDE_NO_GITHUB_ITEMS,
  detectedAgents: ['claude-code'],
});
