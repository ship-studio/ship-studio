/**
 * Tests for the SessionRegistry — the single source of truth for live
 * project sessions in this window.
 *
 * The most important tests here are the **invariant tests**: they enforce
 * "one project path → at most one session, ever." If any of these break,
 * we are at risk of regressing the memory leak that triggered the
 * tightening of terminal lifecycle in the first place.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sessionRegistry } from './sessionRegistry';

beforeEach(() => {
  sessionRegistry._resetForTests();
});

describe('SessionRegistry — invariant: one path, one session', () => {
  it('returns the same instance across repeated getOrCreate for the same path', () => {
    const a = sessionRegistry.getOrCreate('/tmp/proj-a');
    const b = sessionRegistry.getOrCreate('/tmp/proj-a');
    const c = sessionRegistry.getOrCreate('/tmp/proj-a');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(sessionRegistry.snapshotAll()).toHaveLength(1);
  });

  it('does not duplicate sessions under rapid concurrent getOrCreate', () => {
    // Simulate the React StrictMode / HMR scenario where a component remounts
    // and re-runs effects. The registry must not grow.
    for (let i = 0; i < 50; i += 1) {
      sessionRegistry.getOrCreate('/tmp/proj-spam');
    }
    expect(sessionRegistry.snapshotAll()).toHaveLength(1);
  });

  it('after destroy, getOrCreate creates a fresh session for the same path', () => {
    const original = sessionRegistry.getOrCreate('/tmp/proj-d');
    sessionRegistry.destroy('/tmp/proj-d');
    const fresh = sessionRegistry.getOrCreate('/tmp/proj-d');
    expect(fresh).not.toBe(original);
    expect(sessionRegistry.snapshotAll()).toHaveLength(1);
  });

  it('keeps separate sessions for distinct paths', () => {
    sessionRegistry.getOrCreate('/tmp/a');
    sessionRegistry.getOrCreate('/tmp/b');
    sessionRegistry.getOrCreate('/tmp/c');
    expect(sessionRegistry.snapshotAll()).toHaveLength(3);
  });
});

describe('SessionRegistry — lifecycle', () => {
  it('new sessions start in active status with idle agent and zero unread', () => {
    const s = sessionRegistry.getOrCreate('/tmp/p');
    expect(s.status).toBe('active');
    expect(s.lastAgentStatus).toBe('idle');
    expect(s.unreadCount).toBe(0);
    expect(s.memoryBytes).toBe(0);
  });

  it('suspend marks status without removing the session', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.suspend('/tmp/p');
    const snap = sessionRegistry.snapshot('/tmp/p');
    expect(snap?.status).toBe('suspended');
  });

  it('resume returns a suspended session to active', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.suspend('/tmp/p');
    sessionRegistry.resume('/tmp/p');
    expect(sessionRegistry.snapshot('/tmp/p')?.status).toBe('active');
  });

  it('suspend / resume / destroy on missing paths are no-ops', () => {
    expect(() => sessionRegistry.suspend('/tmp/missing')).not.toThrow();
    expect(() => sessionRegistry.resume('/tmp/missing')).not.toThrow();
    expect(() => sessionRegistry.destroy('/tmp/missing')).not.toThrow();
    expect(sessionRegistry.snapshotAll()).toHaveLength(0);
  });

  it('countActive excludes suspended sessions', () => {
    sessionRegistry.getOrCreate('/tmp/a');
    sessionRegistry.getOrCreate('/tmp/b');
    sessionRegistry.getOrCreate('/tmp/c');
    sessionRegistry.suspend('/tmp/b');
    expect(sessionRegistry.countActive()).toBe(2);
  });
});

describe('SessionRegistry — agent status & unread', () => {
  it('does not increment unread when status hits waiting in focused session', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.setAgentStatus('/tmp/p', 'thinking', /* isFocused */ true);
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', /* isFocused */ true);
    expect(sessionRegistry.snapshot('/tmp/p')?.unreadCount).toBe(0);
  });

  it('increments unread when status hits waiting in unfocused session', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.setAgentStatus('/tmp/p', 'thinking', /* isFocused */ false);
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', /* isFocused */ false);
    expect(sessionRegistry.snapshot('/tmp/p')?.unreadCount).toBe(1);
  });

  it('does not double-increment unread when same status is set twice', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', false);
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', false);
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', false);
    expect(sessionRegistry.snapshot('/tmp/p')?.unreadCount).toBe(1);
  });

  it('clearUnread zeroes the badge', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.setAgentStatus('/tmp/p', 'waiting', false);
    sessionRegistry.clearUnread('/tmp/p');
    expect(sessionRegistry.snapshot('/tmp/p')?.unreadCount).toBe(0);
  });
});

describe('SessionRegistry — touch / focus', () => {
  it('touch advances lastFocusedAt', async () => {
    const session = sessionRegistry.getOrCreate('/tmp/p');
    const before = session.lastFocusedAt;
    // Sleep long enough to cross a millisecond boundary deterministically.
    await new Promise((resolve) => setTimeout(resolve, 5));
    sessionRegistry.touch('/tmp/p');
    expect(session.lastFocusedAt).toBeGreaterThan(before);
  });

  it('touch on missing session is a no-op', () => {
    expect(() => sessionRegistry.touch('/tmp/missing')).not.toThrow();
  });
});

describe('SessionRegistry — subscriptions', () => {
  it('notifies subscribers on create with the changed path', () => {
    const subscriber = vi.fn();
    sessionRegistry.subscribe(subscriber);
    sessionRegistry.getOrCreate('/tmp/p');
    expect(subscriber).toHaveBeenCalledWith('/tmp/p', expect.any(Array));
  });

  it('does not notify when getOrCreate hits an existing session', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    const subscriber = vi.fn();
    sessionRegistry.subscribe(subscriber);
    sessionRegistry.getOrCreate('/tmp/p');
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('does not notify when status setters are no-ops', () => {
    sessionRegistry.getOrCreate('/tmp/p');
    sessionRegistry.suspend('/tmp/p');
    const subscriber = vi.fn();
    sessionRegistry.subscribe(subscriber);
    sessionRegistry.suspend('/tmp/p'); // already suspended
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const subscriber = vi.fn();
    const unsubscribe = sessionRegistry.subscribe(subscriber);
    unsubscribe();
    sessionRegistry.getOrCreate('/tmp/p');
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not stop other subscribers', () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    sessionRegistry.subscribe(a);
    sessionRegistry.subscribe(b);
    sessionRegistry.getOrCreate('/tmp/p');
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});

describe('SessionRegistry — snapshots', () => {
  it('snapshotAll is sorted by activatedAt ascending', async () => {
    sessionRegistry.getOrCreate('/tmp/first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    sessionRegistry.getOrCreate('/tmp/second');
    await new Promise((resolve) => setTimeout(resolve, 5));
    sessionRegistry.getOrCreate('/tmp/third');

    const paths = sessionRegistry.snapshotAll().map((s) => s.projectPath);
    expect(paths).toEqual(['/tmp/first', '/tmp/second', '/tmp/third']);
  });

  it('snapshot returns undefined for missing paths', () => {
    expect(sessionRegistry.snapshot('/tmp/missing')).toBeUndefined();
  });
});

describe('SessionRegistry — stale login env', () => {
  const PATH = '/tmp/stale';

  function seedTabs(statuses: Array<import('./sessionRegistry').TabStatus | undefined>) {
    sessionRegistry.getOrCreate(PATH);
    sessionRegistry.setTerminalTabs(
      PATH,
      statuses.map((status, i) => ({
        id: i + 1,
        agentId: 'claude-code',
        sessionId: `s${i + 1}`,
        status,
      })),
      0
    );
  }

  it('flags only running tabs and leaves exited/crashed tabs alone', () => {
    seedTabs(['running', 'exited', 'crashed', 'thinking', undefined]);
    sessionRegistry.markProjectTabsStale(PATH);

    const tabs = sessionRegistry.snapshot(PATH)!.terminalTabs;
    expect(tabs.find((t) => t.id === 1)!.staleEnv).toBe(true); // running
    expect(tabs.find((t) => t.id === 2)!.staleEnv).toBeFalsy(); // exited
    expect(tabs.find((t) => t.id === 3)!.staleEnv).toBeFalsy(); // crashed
    expect(tabs.find((t) => t.id === 4)!.staleEnv).toBe(true); // thinking
    expect(tabs.find((t) => t.id === 5)!.staleEnv).toBe(true); // unknown == starting
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(true);
  });

  it('is a no-op for an unknown project', () => {
    expect(() => sessionRegistry.markProjectTabsStale('/tmp/nope')).not.toThrow();
    expect(sessionRegistry.hasStaleTabs('/tmp/nope')).toBe(false);
  });

  it('clearProjectStaleEnv resets every flagged tab', () => {
    seedTabs(['running', 'running']);
    sessionRegistry.markProjectTabsStale(PATH);
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(true);

    sessionRegistry.clearProjectStaleEnv(PATH);
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(false);
  });

  it('clears a tab’s stale flag when it is restarted (sessionId changes)', () => {
    seedTabs(['running']);
    sessionRegistry.markProjectTabsStale(PATH);
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(true);

    // A restart mints a fresh sessionId for the same tab id — a new PTY that
    // captured the current env, so staleness must clear.
    sessionRegistry.setTerminalTabs(
      PATH,
      [{ id: 1, agentId: 'claude-code', sessionId: 's-restarted', status: 'starting' }],
      0
    );
    expect(sessionRegistry.hasStaleTabs(PATH)).toBe(false);
  });

  it('notifies subscribers when staleness changes, not when it does not', () => {
    seedTabs(['running']);
    const calls: Array<string | null> = [];
    const unsub = sessionRegistry.subscribe((changedPath) => calls.push(changedPath));

    sessionRegistry.markProjectTabsStale(PATH);
    expect(calls).toEqual([PATH]);

    // Already stale — second call changes nothing, so no extra notify.
    sessionRegistry.markProjectTabsStale(PATH);
    expect(calls).toEqual([PATH]);

    unsub();
  });
});
