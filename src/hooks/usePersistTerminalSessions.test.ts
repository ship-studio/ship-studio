import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushTerminalSessions,
  registerTerminalSessionSource,
  type PersistDeps,
  type TerminalSessionSnapshot,
} from '../lib/terminalStatePersistence';
import { usePersistTerminalSessions } from './usePersistTerminalSessions';

const committed: TerminalSessionSnapshot[] = [
  {
    projectPath: 'C:\\work\\app',
    activeTabId: 1,
    tabs: [{ id: 1, agentId: 'claude-code', sessionId: 'old' }],
  },
];

const live: TerminalSessionSnapshot[] = [
  {
    projectPath: 'C:\\work\\app',
    activeTabId: 2,
    tabs: [
      { id: 1, agentId: 'claude-code', sessionId: 'old' },
      { id: 2, agentId: 'claude-code', sessionId: 'new' },
    ],
  },
];

describe('usePersistTerminalSessions', () => {
  afterEach(() => {
    registerTerminalSessionSource(null);
  });

  it('quit saves the live tab list when React has not committed it yet', async () => {
    renderHook(() => usePersistTerminalSessions(committed, () => live));
    const write = vi.fn(async () => {});
    const io: PersistDeps = {
      write,
      customTitles: () => new Map(),
      signatures: new Map(),
    };

    await flushTerminalSessions(io);

    expect(write).toHaveBeenCalledWith(
      'C:\\work\\app',
      expect.objectContaining({
        active_tab_index: 1,
        tabs: [
          expect.objectContaining({ session_id: 'old' }),
          expect.objectContaining({ session_id: 'new' }),
        ],
      })
    );
  });
});
