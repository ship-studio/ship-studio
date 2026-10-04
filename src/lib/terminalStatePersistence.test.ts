import { describe, expect, it, vi } from 'vitest';
import {
  buildSavedTerminalState,
  flushTerminalSessions,
  persistTerminalSessions,
  registerTerminalSessionSource,
  terminalStateSignature,
  type PersistDeps,
  type TerminalSessionSnapshot,
} from './terminalStatePersistence';

function session(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    projectPath: 'C:\\work\\app',
    activeTabId: 1,
    tabs: [
      { id: 1, agentId: 'claude-code', sessionId: 'sess-a' },
      { id: 2, agentId: 'codex', sessionId: 'sess-b' },
    ],
    ...overrides,
  };
}

function deps(write = vi.fn(async () => {})): PersistDeps & { write: ReturnType<typeof vi.fn> } {
  return {
    write,
    customTitles: () => new Map([[2, 'Review']]),
    signatures: new Map(),
  };
}

describe('buildSavedTerminalState', () => {
  it('keeps session ids, the active tab, and manual titles', () => {
    const saved = buildSavedTerminalState(session({ activeTabId: 2 }), new Map([[2, 'Review']]));
    expect(saved).toEqual({
      active_tab_index: 1,
      tabs: [
        { agent_id: 'claude-code', session_id: 'sess-a', custom_title: undefined },
        { agent_id: 'codex', session_id: 'sess-b', custom_title: 'Review' },
      ],
    });
  });

  it('falls back to the first tab when the active id is gone', () => {
    const saved = buildSavedTerminalState(session({ activeTabId: 99 }), new Map());
    expect(saved?.active_tab_index).toBe(0);
  });

  it('refuses to save an empty list, which would wipe a previous restore', () => {
    expect(buildSavedTerminalState(session({ tabs: [] }), new Map())).toBeNull();
  });
});

describe('terminalStateSignature', () => {
  it('changes when the active tab or a session id changes', () => {
    const first = buildSavedTerminalState(session(), new Map());
    const second = buildSavedTerminalState(session({ activeTabId: 2 }), new Map());
    if (!first || !second) throw new Error('expected a saved terminal state');
    expect(terminalStateSignature(first)).not.toBe(terminalStateSignature(second));
  });
});

describe('persistTerminalSessions', () => {
  it('writes each project once and skips an identical follow-up', async () => {
    const io = deps();
    const sessions = [session(), session({ projectPath: 'C:\\work\\other', activeTabId: 2 })];

    await persistTerminalSessions(sessions, io);
    await persistTerminalSessions(sessions, io);

    expect(io.write).toHaveBeenCalledTimes(2);
    expect(io.write).toHaveBeenCalledWith(
      'C:\\work\\app',
      expect.objectContaining({ active_tab_index: 0 })
    );
    expect(io.write).toHaveBeenCalledWith(
      'C:\\work\\other',
      expect.objectContaining({ active_tab_index: 1 })
    );
  });

  it('retries after a failed write instead of treating it as saved', async () => {
    const write = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const io = deps(write);
    const sessions = [session()];

    await persistTerminalSessions(sessions, io);
    await persistTerminalSessions(sessions, io);

    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe('flushTerminalSessions', () => {
  it('rewrites the registered sessions even when they were just saved', async () => {
    const io = deps();
    const sessions = [session()];
    registerTerminalSessionSource(() => sessions);

    await persistTerminalSessions(sessions, io);
    await flushTerminalSessions(io);

    expect(io.write).toHaveBeenCalledTimes(2);
    registerTerminalSessionSource(null);
  });

  it('does nothing when no source is registered', async () => {
    registerTerminalSessionSource(null);
    const io = deps();
    await flushTerminalSessions(io);
    expect(io.write).not.toHaveBeenCalled();
  });
});
