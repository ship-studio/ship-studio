import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  open: vi.fn(),
  kill: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
  build: vi.fn(),
}));
vi.mock('./ptySession', () => ({ openPtySession: calls.open, killPtySession: calls.kill }));
vi.mock('./project', () => ({
  getAutoAcceptMode: () => Promise.resolve(true),
  getTerminalState: calls.getState,
  setTerminalState: calls.setState,
}));
vi.mock('./agentSpawn', () => ({ buildAgentSpawn: calls.build }));
vi.mock('./agent', () => ({
  getDefaultAgentId: () => 'claude-code',
  getAgentById: (id: string) => ({ id }),
}));

import {
  BACKGROUND_COLS,
  closeInBackground,
  savedWithoutTab,
  savedWithTab,
  startInBackground,
  type BackgroundTabs,
} from './backgroundSessions';

const saved = (ids: string[], active = 0) => ({
  tabs: ids.map((id) => ({ agent_id: 'claude-code', session_id: id })),
  active_tab_index: active,
});

function terminals(tracked: Array<{ id: number; sessionId: string }> | null): BackgroundTabs {
  return {
    maxTerminalTabs: 3,
    tabsForProject: () => tracked,
    adoptTerminalTab: vi.fn(() => tracked !== null),
    closeTerminalTab: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.build.mockResolvedValue({ command: '/bin/claude', args: ['--x'], env: { A: '1' } });
  calls.open.mockResolvedValue({ sessionId: 's', pid: 1, spawned: true });
});

describe('saved tab lists', () => {
  it('add a tab without changing which one is active', () => {
    expect(savedWithTab(saved(['a', 'b'], 1), { agent_id: 'c', session_id: 'n' }, 3)).toEqual({
      tabs: [...saved(['a', 'b']).tabs, { agent_id: 'c', session_id: 'n' }],
      active_tab_index: 1,
    });
    expect(savedWithTab(null, { agent_id: 'c', session_id: 'n' }, 3)?.tabs).toHaveLength(1);
    expect(savedWithTab(saved(['a', 'b', 'c']), { agent_id: 'c', session_id: 'n' }, 3)).toBe(null);
  });

  it('drop a tab like its ×, and never the last', () => {
    expect(savedWithoutTab(saved(['a', 'b', 'c'], 2), 'a')).toEqual(saved(['b', 'c'], 1));
    expect(savedWithoutTab(saved(['a', 'b', 'c'], 1), 'b')).toEqual(saved(['a', 'c'], 0));
    expect(savedWithoutTab(saved(['a', 'b', 'c'], 0), 'c')).toEqual(saved(['a', 'b'], 0));
    expect(savedWithoutTab(saved(['a']), 'a')).toBe(null);
    expect(savedWithoutTab(saved(['a', 'b']), 'zzz')).toBe(null);
  });
});

describe('startInBackground', () => {
  it('spawns with the shared builder and joins the tabs this window tracks', async () => {
    const t = terminals([{ id: 1, sessionId: 'a' }]);
    await expect(startInBackground(t, '/p', 'new', 'Make it blue')).resolves.toEqual({ ok: true });
    expect(calls.build).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: '/p',
        sessionName: 'new',
        autoAccept: true,
        initialPrompt: 'Make it blue',
      })
    );
    expect(calls.open).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'new',
        command: '/bin/claude',
        args: ['--x'],
        cwd: '/p',
        projectPath: '/p',
        agentId: 'claude-code',
        cols: BACKGROUND_COLS,
      })
    );
    expect(t.adoptTerminalTab).toHaveBeenCalledWith('/p', {
      agentId: 'claude-code',
      sessionId: 'new',
    });
    expect(calls.setState).not.toHaveBeenCalled();
  });

  it('joins the saved tabs of a project this window has not opened', async () => {
    calls.getState.mockResolvedValue(saved(['a'], 0));
    await startInBackground(terminals(null), '/p', 'new', 'hi');
    expect(calls.setState).toHaveBeenCalledWith('/p', saved(['a', 'new'], 0));
  });

  it('spawns nothing when the project is out of tab room', async () => {
    const full = [1, 2, 3].map((id) => ({ id, sessionId: String(id) }));
    await expect(startInBackground(terminals(full), '/p', 'n', 'hi')).resolves.toEqual({
      ok: false,
      reason: 'no_room',
    });
    calls.getState.mockResolvedValue(saved(['a', 'b', 'c']));
    await expect(startInBackground(terminals(null), '/p', 'n', 'hi')).resolves.toMatchObject({
      ok: false,
    });
    expect(calls.open).not.toHaveBeenCalled();
  });
});

describe('closeInBackground', () => {
  it('closes a tracked tab in its own project and kills the process', async () => {
    const t = terminals([
      { id: 1, sessionId: 'a' },
      { id: 4, sessionId: 'b' },
    ]);
    await expect(closeInBackground(t, '/p', 'b')).resolves.toEqual({ ok: true });
    expect(t.closeTerminalTab).toHaveBeenCalledWith(4, '/p');
    expect(calls.kill).toHaveBeenCalledWith('b');
  });

  it('never closes the last tab or one that is not there', async () => {
    const one = terminals([{ id: 1, sessionId: 'a' }]);
    await expect(closeInBackground(one, '/p', 'a')).resolves.toEqual({
      ok: false,
      reason: 'last_tab',
    });
    await expect(closeInBackground(one, '/p', 'z')).resolves.toEqual({
      ok: false,
      reason: 'no_such_tab',
    });
    expect(calls.kill).not.toHaveBeenCalled();
  });

  it('drops an untracked project’s saved tab', async () => {
    calls.getState.mockResolvedValue(saved(['a', 'b'], 1));
    await closeInBackground(terminals(null), '/p', 'b');
    expect(calls.setState).toHaveBeenCalledWith('/p', saved(['a'], 0));
    expect(calls.kill).toHaveBeenCalledWith('b');
  });
});
