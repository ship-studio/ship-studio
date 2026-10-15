import { describe, expect, it, vi } from 'vitest';
import {
  buildSavedTerminalState,
  flushTerminalSessions,
  persistTerminalSessions,
  registerTerminalSessionSource,
  snapshotTerminalSessions,
  terminalStateSignature,
  type PersistDeps,
  type SavedTerminalState,
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

describe('snapshotTerminalSessions', () => {
  it('copies the store so a later edit does not change the snapshot', () => {
    const tabs = [
      { id: 1, agentId: 'claude-code', sessionId: 'old' },
      { id: 2, agentId: 'claude-code', sessionId: 'new' },
    ];
    const states = new Map([['C:\\work\\app', { activeTabId: 2, tabs }]]);

    const snap = snapshotTerminalSessions(states);
    expect(snap).toEqual([
      {
        projectPath: 'C:\\work\\app',
        activeTabId: 2,
        tabs,
      },
    ]);
    expect(snap[0]?.tabs).not.toBe(tabs);
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

  it('lets a newer tab list win when an older write is still in flight', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const write = vi.fn((_path: string, _state: SavedTerminalState) => {
      calls += 1;
      return calls === 1 ? firstGate : Promise.resolve();
    });
    const io = deps(write);

    const older = persistTerminalSessions([session()], io);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const newer = persistTerminalSessions([session({ activeTabId: 2 })], io);
    releaseFirst();
    await older;
    await newer;

    expect(write.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ active_tab_index: 0 }));
    expect(write.mock.calls[write.mock.calls.length - 1]?.[1]).toEqual(
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

  it('lands after an older in-flight save', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const write = vi.fn((_path: string, _state: SavedTerminalState) => {
      calls += 1;
      return calls === 1 ? firstGate : Promise.resolve();
    });
    const io = deps(write);
    const sessions = [session({ activeTabId: 2 })];
    registerTerminalSessionSource(() => sessions);

    const older = persistTerminalSessions([session()], io);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const flushed = flushTerminalSessions(io);
    releaseFirst();
    await older;
    await flushed;

    expect(write.mock.calls[write.mock.calls.length - 1]?.[1]).toEqual(
      expect.objectContaining({ active_tab_index: 1 })
    );
    registerTerminalSessionSource(null);
  });

  it('does nothing when no source is registered', async () => {
    registerTerminalSessionSource(null);
    const io = deps();
    await flushTerminalSessions(io);
    expect(io.write).not.toHaveBeenCalled();
  });
});
