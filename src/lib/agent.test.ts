/**
 * Tests for agent abstraction layer.
 *
 * Tests the in-memory cache, lookups, and constant declarations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAgentById,
  initDefaultAgent,
  getDefaultAgentId,
  getActiveAgent,
  ALL_AGENTS,
  ALL_TAB_OPTIONS,
  CLAUDE_CODE,
  CODEX,
  OPENCODE,
  TERMINAL,
} from './agent';

// Reset the module-level cache before each test
beforeEach(() => {
  initDefaultAgent(null);
});

// ============ getAgentById ============

describe('getAgentById', () => {
  it('returns CLAUDE_CODE for "claude-code"', () => {
    const agent = getAgentById('claude-code');
    expect(agent.id).toBe('claude-code');
    expect(agent.displayName).toBe('Claude Code');
  });

  it('returns CODEX for "codex"', () => {
    const agent = getAgentById('codex');
    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex');
  });

  it('returns OPENCODE for "opencode"', () => {
    const agent = getAgentById('opencode');
    expect(agent.id).toBe('opencode');
    expect(agent.displayName).toBe('Opencode');
  });

  it('returns TERMINAL for "terminal"', () => {
    const agent = getAgentById('terminal');
    expect(agent.id).toBe('terminal');
    expect(agent.displayName).toBe('Terminal');
  });

  it('falls back to CLAUDE_CODE for unknown ID', () => {
    const agent = getAgentById('unknown-agent');
    expect(agent.id).toBe('claude-code');
  });
});

// ============ initDefaultAgent / getDefaultAgentId ============

describe('initDefaultAgent / getDefaultAgentId', () => {
  it('returns "claude-code" when initialized with null', () => {
    initDefaultAgent(null);
    expect(getDefaultAgentId()).toBe('claude-code');
  });

  it('returns "codex" when initialized with "codex"', () => {
    initDefaultAgent('codex');
    expect(getDefaultAgentId()).toBe('codex');
  });

  it('returns "claude-code" when initialized with "claude-code"', () => {
    initDefaultAgent('claude-code');
    expect(getDefaultAgentId()).toBe('claude-code');
  });
});

// ============ getActiveAgent ============

describe('getActiveAgent', () => {
  it('returns CLAUDE_CODE by default (null cache)', () => {
    const agent = getActiveAgent();
    expect(agent.id).toBe('claude-code');
  });

  it('returns CODEX after initDefaultAgent("codex")', () => {
    initDefaultAgent('codex');
    const agent = getActiveAgent();
    expect(agent.id).toBe('codex');
  });

  it('returns CLAUDE_CODE after initDefaultAgent("claude-code")', () => {
    initDefaultAgent('claude-code');
    const agent = getActiveAgent();
    expect(agent.id).toBe('claude-code');
  });
});

// ============ ALL_AGENTS / ALL_TAB_OPTIONS ============

describe('ALL_AGENTS', () => {
  it('has exactly 4 entries', () => {
    expect(ALL_AGENTS).toHaveLength(4);
  });

  it('contains CLAUDE_CODE, CODEX, OPENCODE, and CURSOR', () => {
    expect(ALL_AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'opencode', 'cursor']);
  });
});

describe('ALL_TAB_OPTIONS', () => {
  it('has exactly 5 entries (agents + terminal)', () => {
    expect(ALL_TAB_OPTIONS).toHaveLength(5);
  });

  it('contains CLAUDE_CODE, CODEX, OPENCODE, CURSOR, and TERMINAL', () => {
    expect(ALL_TAB_OPTIONS.map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'cursor',
      'terminal',
    ]);
  });
});

// ============ Agent config field validation ============

describe('AgentConfig fields', () => {
  it('CLAUDE_CODE has correct specific values', () => {
    expect(CLAUDE_CODE.binaryName).toBe('claude');
    expect(CLAUDE_CODE.processName).toBe('claude');
    expect(CLAUDE_CODE.autoAcceptFlag).toBe('--dangerously-skip-permissions');
    expect(CLAUDE_CODE.supportsSkills).toBe(true);
    expect(CLAUDE_CODE.supportsStatusDetection).toBe(true);
  });

  it('CODEX has correct specific values', () => {
    expect(CODEX.binaryName).toBe('codex');
    expect(CODEX.processName).toBe('codex');
    expect(CODEX.autoAcceptFlag).toBe('--yolo');
    expect(CODEX.supportsSkills).toBe(true);
    expect(CODEX.supportsStatusDetection).toBe(false);
  });

  it('OPENCODE has correct specific values', () => {
    expect(OPENCODE.binaryName).toBe('opencode');
    expect(OPENCODE.processName).toBe('opencode');
    expect(OPENCODE.autoAcceptFlag).toBeNull();
    expect(OPENCODE.supportsSkills).toBe(false);
    expect(OPENCODE.supportsStatusDetection).toBe(false);
  });

  it('TERMINAL has correct specific values', () => {
    expect(TERMINAL.binaryName).toBe('/bin/zsh');
    expect(TERMINAL.autoAcceptFlag).toBeNull();
    expect(TERMINAL.supportsSkills).toBe(false);
    expect(TERMINAL.supportsStatusDetection).toBe(false);
  });

  it('each agent config has required fields', () => {
    for (const agent of ALL_TAB_OPTIONS) {
      expect(agent.id).toBeTruthy();
      expect(agent.displayName).toBeTruthy();
      expect(agent.binaryName).toBeTruthy();
      expect(agent.processName).toBeTruthy();
      expect(agent.loadingMessage).toBeTruthy();
      expect(agent.notFoundMessage).toBeTruthy();
      expect(agent.installHint).toBeTruthy();
    }
  });
});
