/**
 * Tests for the project-session teardown wrappers.
 *
 * The close path is the only thing (besides app quit) that reaps a hot
 * project, so it has to be authoritative: the backend PTY sweep must run
 * even though the UI also kills the terminals it has mounted, and the
 * registry entry must be dropped even if that sweep fails.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { closeProjectSession } from './projectSessions';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('closeProjectSession', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('sweeps the project PTYs before unregistering the session', async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(cmd === 'suspend_project_session' ? 2 : undefined);
    });

    const killed = await closeProjectSession('/Users/me/ShipStudio/app');

    expect(calls).toEqual(['suspend_project_session', 'unregister_project_session']);
    expect(invokeMock).toHaveBeenCalledWith('suspend_project_session', {
      projectPath: '/Users/me/ShipStudio/app',
    });
    expect(invokeMock).toHaveBeenCalledWith('unregister_project_session', {
      projectPath: '/Users/me/ShipStudio/app',
    });
    expect(killed).toBe(2);
  });

  it('still unregisters when the PTY sweep fails', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'suspend_project_session'
        ? Promise.reject(new Error('no such session'))
        : Promise.resolve(undefined)
    );

    const killed = await closeProjectSession('/Users/me/ShipStudio/app');

    expect(invokeMock).toHaveBeenCalledWith('unregister_project_session', {
      projectPath: '/Users/me/ShipStudio/app',
    });
    expect(killed).toBe(0);
  });

  it('propagates an unregister failure so the caller can log it', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'suspend_project_session'
        ? Promise.resolve(0)
        : Promise.reject(new Error('registry locked'))
    );

    await expect(closeProjectSession('/Users/me/ShipStudio/app')).rejects.toThrow(
      'registry locked'
    );
  });
});
