/**
 * Tests for setup/onboarding pure logic helpers.
 *
 * These are synchronous, no IPC, no rendering — just data-in / data-out.
 */

import { describe, it, expect } from 'vitest';
import {
  getSetupDependencies,
  areDependenciesReady,
  getBlockingDependencies,
  getReadyAgentPairs,
  isAtLeastOneAgentReady,
  mergePluginSetupItems,
  AGENT_ITEM_IDS,
  OPTIONAL_ITEMS,
  SETUP_ITEM_ORDER,
  SETUP_DEPENDENCIES,
  SETUP_FRIENDLY_NAMES,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  PKG_MGR_PACKAGES,
  BREW_PACKAGES,
  WIZARD_STEPS,
  isWizardStepComplete,
  getStepItems,
  findFirstIncompleteStep,
} from './setup';
import {
  FRESH_INSTALL_ITEMS,
  ALL_READY_CLAUDE_ONLY,
  ALL_READY_BOTH_AGENTS,
  ALL_READY_CODEX_ONLY,
  BASE_READY_NO_AGENTS,
  AUTH_ONLY_ITEMS,
  STEP1_COMPLETE_ITEMS,
  HAS_BASE_NO_AGENTS_ITEMS,
  HAS_CLAUDE_NO_GITHUB_ITEMS,
} from '../test/fixtures/setup';

// ============ getSetupDependencies ============

describe('getSetupDependencies', () => {
  it('returns a dependency graph including codex entries', () => {
    const deps = getSetupDependencies();
    expect(deps).toHaveProperty('codex');
    expect(deps).toHaveProperty('codex_auth');
    expect(deps.codex_auth).toEqual(['codex']);
  });

  it('homebrew has no dependencies', () => {
    const deps = getSetupDependencies();
    expect(deps.homebrew).toEqual([]);
  });

  it('node depends on homebrew', () => {
    const deps = getSetupDependencies();
    expect(deps.node).toEqual(['homebrew']);
  });

  it('claude has no dependencies (uses its own installer)', () => {
    const deps = getSetupDependencies();
    expect(deps.claude).toEqual([]);
  });

  it('claude_auth depends on claude', () => {
    const deps = getSetupDependencies();
    expect(deps.claude_auth).toEqual(['claude']);
  });

  it('codex has no dependencies (uses npm global install)', () => {
    const deps = getSetupDependencies();
    expect(deps.codex).toEqual([]);
  });

  it('npm_fix depends on node', () => {
    const deps = getSetupDependencies();
    expect(deps.npm_fix).toEqual(['node']);
  });

  it('gh_auth depends on gh', () => {
    const deps = getSetupDependencies();
    expect(deps.gh_auth).toEqual(['gh']);
  });

  it('vercel has no dependencies (uses npm global install)', () => {
    const deps = getSetupDependencies();
    expect(deps.vercel).toEqual([]);
  });

  it('vercel_auth depends on vercel', () => {
    const deps = getSetupDependencies();
    expect(deps.vercel_auth).toEqual(['vercel']);
  });
});

// ============ SETUP_DEPENDENCIES (const) ============

describe('SETUP_DEPENDENCIES', () => {
  it('has codex entries with correct deps', () => {
    expect(SETUP_DEPENDENCIES.codex).toEqual([]);
    expect(SETUP_DEPENDENCIES.codex_auth).toEqual(['codex']);
  });

  it('has vercel entries with correct deps', () => {
    expect(SETUP_DEPENDENCIES.vercel).toEqual([]);
    expect(SETUP_DEPENDENCIES.vercel_auth).toEqual(['vercel']);
  });
});

// ============ areDependenciesReady ============

describe('areDependenciesReady', () => {
  it('returns true when all deps are ready', () => {
    expect(areDependenciesReady('node', ALL_READY_CLAUDE_ONLY)).toBe(true);
  });

  it('returns false when deps are not met', () => {
    expect(areDependenciesReady('node', FRESH_INSTALL_ITEMS)).toBe(false);
  });

  it('returns true when item has no deps', () => {
    expect(areDependenciesReady('homebrew', FRESH_INSTALL_ITEMS)).toBe(true);
  });

  it('returns true for missing/unknown item (no deps defined)', () => {
    expect(areDependenciesReady('nonexistent', FRESH_INSTALL_ITEMS)).toBe(true);
  });

  it('returns true for claude (no deps) even on fresh install', () => {
    expect(areDependenciesReady('claude', FRESH_INSTALL_ITEMS)).toBe(true);
  });

  it('returns false for claude_auth when claude is not ready', () => {
    expect(areDependenciesReady('claude_auth', FRESH_INSTALL_ITEMS)).toBe(false);
  });

  it('returns true for claude_auth when claude is ready', () => {
    expect(areDependenciesReady('claude_auth', ALL_READY_CLAUDE_ONLY)).toBe(true);
  });
});

// ============ getBlockingDependencies ============

describe('getBlockingDependencies', () => {
  it('returns friendly names of blocking deps', () => {
    const blockers = getBlockingDependencies('node', FRESH_INSTALL_ITEMS);
    expect(blockers).toEqual(['Package Manager']);
  });

  it('returns empty array when all deps are met', () => {
    const blockers = getBlockingDependencies('node', ALL_READY_CLAUDE_ONLY);
    expect(blockers).toEqual([]);
  });

  it('returns empty array when item has no deps', () => {
    const blockers = getBlockingDependencies('homebrew', FRESH_INSTALL_ITEMS);
    expect(blockers).toEqual([]);
  });

  it('returns empty for unknown item', () => {
    const blockers = getBlockingDependencies('nonexistent', FRESH_INSTALL_ITEMS);
    expect(blockers).toEqual([]);
  });

  it('returns blocking dep for codex_auth when codex is missing', () => {
    const blockers = getBlockingDependencies('codex_auth', FRESH_INSTALL_ITEMS);
    expect(blockers).toEqual(['Codex']);
  });
});

// ============ getReadyAgentPairs ============

describe('getReadyAgentPairs', () => {
  it('returns both pairs when claude and codex are ready', () => {
    const pairs = getReadyAgentPairs(ALL_READY_BOTH_AGENTS);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ binaryId: 'claude', authId: 'claude_auth' });
    expect(pairs[1]).toEqual({ binaryId: 'codex', authId: 'codex_auth' });
  });

  it('returns only claude pair when only claude is ready', () => {
    const pairs = getReadyAgentPairs(ALL_READY_CLAUDE_ONLY);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].binaryId).toBe('claude');
  });

  it('returns only codex pair when only codex is ready', () => {
    const pairs = getReadyAgentPairs(ALL_READY_CODEX_ONLY);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].binaryId).toBe('codex');
  });

  it('returns empty when no agents are ready', () => {
    const pairs = getReadyAgentPairs(BASE_READY_NO_AGENTS);
    expect(pairs).toHaveLength(0);
  });

  it('returns empty when binary is ready but auth is not', () => {
    const pairs = getReadyAgentPairs(AUTH_ONLY_ITEMS);
    expect(pairs).toHaveLength(0);
  });

  it('returns empty on fresh install', () => {
    const pairs = getReadyAgentPairs(FRESH_INSTALL_ITEMS);
    expect(pairs).toHaveLength(0);
  });
});

// ============ isAtLeastOneAgentReady ============

describe('isAtLeastOneAgentReady', () => {
  it('returns true when claude only is ready', () => {
    expect(isAtLeastOneAgentReady(ALL_READY_CLAUDE_ONLY)).toBe(true);
  });

  it('returns true when codex only is ready', () => {
    expect(isAtLeastOneAgentReady(ALL_READY_CODEX_ONLY)).toBe(true);
  });

  it('returns true when both agents are ready', () => {
    expect(isAtLeastOneAgentReady(ALL_READY_BOTH_AGENTS)).toBe(true);
  });

  it('returns false when no agents are ready', () => {
    expect(isAtLeastOneAgentReady(BASE_READY_NO_AGENTS)).toBe(false);
  });

  it('returns false on fresh install', () => {
    expect(isAtLeastOneAgentReady(FRESH_INSTALL_ITEMS)).toBe(false);
  });
});

// ============ AGENT_ITEM_IDS ============

describe('AGENT_ITEM_IDS', () => {
  it('contains all 8 agent item IDs', () => {
    expect(AGENT_ITEM_IDS.has('claude')).toBe(true);
    expect(AGENT_ITEM_IDS.has('claude_auth')).toBe(true);
    expect(AGENT_ITEM_IDS.has('codex')).toBe(true);
    expect(AGENT_ITEM_IDS.has('codex_auth')).toBe(true);
    expect(AGENT_ITEM_IDS.has('opencode')).toBe(true);
    expect(AGENT_ITEM_IDS.has('opencode_auth')).toBe(true);
    expect(AGENT_ITEM_IDS.has('cursor')).toBe(true);
    expect(AGENT_ITEM_IDS.has('cursor_auth')).toBe(true);
    expect(AGENT_ITEM_IDS.size).toBe(8);
  });

  it('does not contain non-agent items', () => {
    expect(AGENT_ITEM_IDS.has('homebrew')).toBe(false);
    expect(AGENT_ITEM_IDS.has('node')).toBe(false);
    expect(AGENT_ITEM_IDS.has('gh_auth')).toBe(false);
  });
});

// ============ OPTIONAL_ITEMS ============

describe('OPTIONAL_ITEMS', () => {
  it('contains all expected optional items', () => {
    expect(OPTIONAL_ITEMS.has('gh_auth')).toBe(true);
    expect(OPTIONAL_ITEMS.has('claude')).toBe(true);
    expect(OPTIONAL_ITEMS.has('claude_auth')).toBe(true);
    expect(OPTIONAL_ITEMS.has('codex')).toBe(true);
    expect(OPTIONAL_ITEMS.has('codex_auth')).toBe(true);
    expect(OPTIONAL_ITEMS.has('vercel')).toBe(true);
    expect(OPTIONAL_ITEMS.has('vercel_auth')).toBe(true);
  });

  it('does not contain required items', () => {
    expect(OPTIONAL_ITEMS.has('homebrew')).toBe(false);
    expect(OPTIONAL_ITEMS.has('node')).toBe(false);
    expect(OPTIONAL_ITEMS.has('git')).toBe(false);
    expect(OPTIONAL_ITEMS.has('gh')).toBe(false);
  });
});

// ============ SETUP_ITEM_ORDER ============

describe('SETUP_ITEM_ORDER', () => {
  it('includes codex items after claude items', () => {
    const claudeIdx = SETUP_ITEM_ORDER.indexOf('claude');
    const codexIdx = SETUP_ITEM_ORDER.indexOf('codex');
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(codexIdx).toBeGreaterThan(-1);
    expect(codexIdx).toBeGreaterThan(claudeIdx);
  });

  it('includes all expected items', () => {
    expect(SETUP_ITEM_ORDER).toContain('homebrew');
    expect(SETUP_ITEM_ORDER).toContain('node');
    expect(SETUP_ITEM_ORDER).toContain('npm_fix');
    expect(SETUP_ITEM_ORDER).toContain('git');
    expect(SETUP_ITEM_ORDER).toContain('gh');
    expect(SETUP_ITEM_ORDER).toContain('gh_auth');
    expect(SETUP_ITEM_ORDER).toContain('claude');
    expect(SETUP_ITEM_ORDER).toContain('claude_auth');
    expect(SETUP_ITEM_ORDER).toContain('codex');
    expect(SETUP_ITEM_ORDER).toContain('codex_auth');
    expect(SETUP_ITEM_ORDER).toContain('vercel');
    expect(SETUP_ITEM_ORDER).toContain('vercel_auth');
  });
});

// ============ SETUP_FRIENDLY_NAMES ============

describe('SETUP_FRIENDLY_NAMES', () => {
  it('has entries for all items including codex and vercel', () => {
    expect(SETUP_FRIENDLY_NAMES.homebrew).toBe('Package Manager');
    expect(SETUP_FRIENDLY_NAMES.node).toBe('Node.js');
    expect(SETUP_FRIENDLY_NAMES.npm_fix).toBe('Fix npm Permissions');
    expect(SETUP_FRIENDLY_NAMES.git).toBe('Git');
    expect(SETUP_FRIENDLY_NAMES.gh).toBe('GitHub CLI');
    expect(SETUP_FRIENDLY_NAMES.gh_auth).toBe('GitHub Account');
    expect(SETUP_FRIENDLY_NAMES.claude).toBe('Claude Code');
    expect(SETUP_FRIENDLY_NAMES.claude_auth).toBe('Claude Account');
    expect(SETUP_FRIENDLY_NAMES.codex).toBe('Codex');
    expect(SETUP_FRIENDLY_NAMES.codex_auth).toBe('Codex Account');
    expect(SETUP_FRIENDLY_NAMES.vercel).toBe('Vercel CLI');
    expect(SETUP_FRIENDLY_NAMES.vercel_auth).toBe('Vercel Account');
  });
});

// ============ TERMINAL_COMMANDS ============

describe('TERMINAL_COMMANDS', () => {
  it('has codex entry', () => {
    expect(TERMINAL_COMMANDS.codex).toBeDefined();
  });

  it('has codex_auth entry', () => {
    expect(TERMINAL_COMMANDS.codex_auth).toBeDefined();
    expect(TERMINAL_COMMANDS.codex_auth.command).toBe('codex');
  });

  it('has claude_auth entry', () => {
    expect(TERMINAL_COMMANDS.claude_auth).toBeDefined();
    expect(TERMINAL_COMMANDS.claude_auth.command).toBe('claude');
  });

  it('has vercel entry', () => {
    expect(TERMINAL_COMMANDS.vercel).toBeDefined();
  });

  it('has vercel_auth entry', () => {
    expect(TERMINAL_COMMANDS.vercel_auth).toBeDefined();
    expect(TERMINAL_COMMANDS.vercel_auth.command).toBe('vercel');
    expect(TERMINAL_COMMANDS.vercel_auth.args).toEqual(['login']);
  });
});

// ============ USES_TERMINAL ============

describe('USES_TERMINAL', () => {
  it('includes codex and codex_auth', () => {
    expect(USES_TERMINAL.has('codex')).toBe(true);
    expect(USES_TERMINAL.has('codex_auth')).toBe(true);
  });

  it('includes homebrew and interactive auth items', () => {
    expect(USES_TERMINAL.has('homebrew')).toBe(true);
    expect(USES_TERMINAL.has('gh_auth')).toBe(true);
    expect(USES_TERMINAL.has('claude')).toBe(true);
    expect(USES_TERMINAL.has('claude_auth')).toBe(true);
  });

  it('includes vercel and vercel_auth', () => {
    expect(USES_TERMINAL.has('vercel')).toBe(true);
    expect(USES_TERMINAL.has('vercel_auth')).toBe(true);
  });

  it('does not include non-interactive items', () => {
    // node, git, gh are installed via backend command, not terminal
    expect(USES_TERMINAL.has('node')).toBe(false);
    expect(USES_TERMINAL.has('git')).toBe(false);
    expect(USES_TERMINAL.has('gh')).toBe(false);
  });
});

// ============ PKG_MGR_PACKAGES / BREW_PACKAGES ============

describe('PKG_MGR_PACKAGES', () => {
  it('contains node, git, gh', () => {
    expect(PKG_MGR_PACKAGES.has('node')).toBe(true);
    expect(PKG_MGR_PACKAGES.has('git')).toBe(true);
    expect(PKG_MGR_PACKAGES.has('gh')).toBe(true);
  });

  it('matches BREW_PACKAGES', () => {
    expect(PKG_MGR_PACKAGES).toEqual(BREW_PACKAGES);
  });
});

// ============ mergePluginSetupItems ============

describe('mergePluginSetupItems', () => {
  it('merges plugin items with prefixed IDs', () => {
    const base = { homebrew: [], node: ['homebrew'] };
    const pluginItems = [
      { pluginId: 'my-plugin', id: 'tool', depends_on: [] },
      { pluginId: 'my-plugin', id: 'auth', depends_on: ['tool'] },
    ];

    const merged = mergePluginSetupItems(base, pluginItems);

    expect(merged['my-plugin:tool']).toEqual([]);
    expect(merged['my-plugin:auth']).toEqual(['my-plugin:tool']);
    // Base items untouched
    expect(merged.homebrew).toEqual([]);
    expect(merged.node).toEqual(['homebrew']);
  });

  it('does not modify the base object', () => {
    const base = { homebrew: [] };
    const pluginItems = [{ pluginId: 'p', id: 'x', depends_on: [] }];

    mergePluginSetupItems(base, pluginItems);
    expect(base).toEqual({ homebrew: [] });
  });

  it('preserves cross-plugin deps that already have colons', () => {
    const base = {};
    const pluginItems = [{ pluginId: 'a', id: 'x', depends_on: ['other-plugin:y'] }];

    const merged = mergePluginSetupItems(base, pluginItems);
    expect(merged['a:x']).toEqual(['other-plugin:y']);
  });

  it('handles empty plugin items array', () => {
    const base = { homebrew: [] };
    const merged = mergePluginSetupItems(base, []);
    expect(merged).toEqual({ homebrew: [] });
  });
});

// ============ WIZARD_STEPS ============

describe('WIZARD_STEPS', () => {
  it('has 4 steps in the correct order', () => {
    expect(WIZARD_STEPS).toHaveLength(4);
    expect(WIZARD_STEPS[0].id).toBe('package-manager');
    expect(WIZARD_STEPS[1].id).toBe('git-github');
    expect(WIZARD_STEPS[2].id).toBe('agent');
    expect(WIZARD_STEPS[3].id).toBe('hosting');
  });

  it('hosting step is skippable, others are not', () => {
    expect(WIZARD_STEPS[0].skippable).toBe(false);
    expect(WIZARD_STEPS[1].skippable).toBe(false);
    expect(WIZARD_STEPS[2].skippable).toBe(false);
    expect(WIZARD_STEPS[3].skippable).toBe(true);
  });

  it('hosting step has vercel item IDs', () => {
    expect(WIZARD_STEPS[3].itemIds).toEqual(['vercel', 'vercel_auth']);
  });
});

// ============ getStepItems ============

describe('getStepItems', () => {
  it('returns items for package-manager step', () => {
    const items = getStepItems('package-manager', FRESH_INSTALL_ITEMS);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('homebrew');
    expect(ids).toContain('node');
  });

  it('returns items for git-github step', () => {
    const items = getStepItems('git-github', FRESH_INSTALL_ITEMS);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(['git', 'gh', 'gh_auth']);
  });

  it('returns items for agent step', () => {
    const items = getStepItems('agent', FRESH_INSTALL_ITEMS);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      'claude',
      'claude_auth',
      'codex',
      'codex_auth',
      'opencode',
      'opencode_auth',
    ]);
  });

  it('returns vercel items for hosting step', () => {
    const items = getStepItems('hosting', FRESH_INSTALL_ITEMS);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(['vercel', 'vercel_auth']);
  });

  it('filters out items not in the items array (e.g., npm_fix)', () => {
    // FRESH_INSTALL_ITEMS doesn't have npm_fix
    const items = getStepItems('package-manager', FRESH_INSTALL_ITEMS);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain('npm_fix');
  });
});

// ============ isWizardStepComplete ============

describe('isWizardStepComplete', () => {
  it('package-manager is complete when homebrew + node are ready', () => {
    expect(isWizardStepComplete('package-manager', STEP1_COMPLETE_ITEMS)).toBe(true);
  });

  it('package-manager is incomplete on fresh install', () => {
    expect(isWizardStepComplete('package-manager', FRESH_INSTALL_ITEMS)).toBe(false);
  });

  it('git-github is complete when git + gh + gh_auth are ready', () => {
    expect(isWizardStepComplete('git-github', ALL_READY_CLAUDE_ONLY)).toBe(true);
  });

  it('git-github is incomplete when gh_auth is missing', () => {
    expect(isWizardStepComplete('git-github', HAS_CLAUDE_NO_GITHUB_ITEMS)).toBe(false);
  });

  it('agent step is complete when at least one agent pair is ready', () => {
    expect(isWizardStepComplete('agent', ALL_READY_CLAUDE_ONLY)).toBe(true);
    expect(isWizardStepComplete('agent', ALL_READY_CODEX_ONLY)).toBe(true);
    expect(isWizardStepComplete('agent', ALL_READY_BOTH_AGENTS)).toBe(true);
  });

  it('agent step is incomplete when no agent pair is ready', () => {
    expect(isWizardStepComplete('agent', BASE_READY_NO_AGENTS)).toBe(false);
    expect(isWizardStepComplete('agent', FRESH_INSTALL_ITEMS)).toBe(false);
  });

  it('hosting step is complete when vercel items are ready', () => {
    expect(isWizardStepComplete('hosting', ALL_READY_BOTH_AGENTS)).toBe(true);
    expect(isWizardStepComplete('hosting', ALL_READY_CLAUDE_ONLY)).toBe(true);
  });

  it('hosting step is incomplete when vercel items are not ready', () => {
    expect(isWizardStepComplete('hosting', FRESH_INSTALL_ITEMS)).toBe(false);
  });
});

// ============ findFirstIncompleteStep ============

describe('findFirstIncompleteStep', () => {
  it('returns package-manager for fresh install', () => {
    expect(findFirstIncompleteStep(FRESH_INSTALL_ITEMS)).toBe('package-manager');
  });

  it('returns git-github when step 1 is complete', () => {
    expect(findFirstIncompleteStep(STEP1_COMPLETE_ITEMS)).toBe('git-github');
  });

  it('returns agent when steps 1+2 are complete but no agents', () => {
    expect(findFirstIncompleteStep(HAS_BASE_NO_AGENTS_ITEMS)).toBe('agent');
  });

  it('returns git-github when has claude but no gh_auth', () => {
    expect(findFirstIncompleteStep(HAS_CLAUDE_NO_GITHUB_ITEMS)).toBe('git-github');
  });

  it('returns null when all steps are complete (including vercel)', () => {
    expect(findFirstIncompleteStep(ALL_READY_CLAUDE_ONLY)).toBeNull();
    expect(findFirstIncompleteStep(ALL_READY_BOTH_AGENTS)).toBeNull();
  });

  it('returns hosting when steps 1-3 are complete but vercel is missing', () => {
    const items = HAS_BASE_NO_AGENTS_ITEMS.map((i) => {
      if (i.id === 'claude') return { ...i, status: 'ready' as const, version: '1.0.0' };
      if (i.id === 'claude_auth')
        return { ...i, status: 'ready' as const, username: 'claude-user' };
      return i;
    });
    expect(findFirstIncompleteStep(items)).toBe('hosting');
  });
});
