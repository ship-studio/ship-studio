/**
 * Behaviour of the sidebar's per-row close button, end to end from the
 * handler down to the registry / backend calls it makes.
 *
 * The bug this covers: clicking X left the row on screen. Two things kept it
 * alive — the teardown of the UI's source of truth sat behind `await
 * stopServer(...)`, and the window's auto-open sentinel outlived the session,
 * so navigating home re-triggered HMR recovery and re-opened the project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { useCloseProject } from './useCloseProject';
import { sessionRegistry } from '../lib/sessionRegistry';
import type { Project } from '../lib/project';
import type { AppView } from '../lib/types';

const CLOSED = '/tmp/closing-project';
const OTHER = '/tmp/other-project';
const STORAGE_KEY = 'ship-studio-project-loaded-main';
const DISMISSED_KEY = 'ship-studio-auto-open-dismissed-main';

let invoked: string[] = [];

function setup(
  currentProjectPath: string | null,
  overrides: { stopServer?: () => Promise<void> } = {}
) {
  const deps = {
    currentProjectPath,
    currentProjectPathRef: { current: currentProjectPath },
    stopServer: overrides.stopServer ?? vi.fn().mockResolvedValue(undefined),
    closeAllTerminalsForProject: vi.fn(),
    setCurrentProject: vi.fn() as (project: Project | null) => void,
    setView: vi.fn() as (view: AppView) => void,
  };
  const { result } = renderHook(() => useCloseProject(deps));
  return { close: result.current, deps };
}

describe('useCloseProject', () => {
  beforeEach(() => {
    invoked = [];
    sessionStorage.clear();
    mockWindows('main');
    mockIPC((cmd) => {
      invoked.push(cmd);
      if (cmd === 'suspend_project_session') return 2;
      return undefined;
    });
    sessionRegistry._resetForTests();
    sessionRegistry.getOrCreate(CLOSED);
    sessionRegistry.getOrCreate(OTHER);
    sessionStorage.setItem(STORAGE_KEY, CLOSED);
  });

  afterEach(() => {
    sessionStorage.clear();
    sessionRegistry._resetForTests();
  });

  it('drops the closed project from the registry and never touches its siblings', async () => {
    const { close, deps } = setup(OTHER);

    await act(async () => {
      close(CLOSED);
      // Let the async teardown chain settle before asserting on it.
      await Promise.resolve();
    });

    expect(sessionRegistry.snapshot(CLOSED)).toBeUndefined();
    expect(sessionRegistry.snapshot(OTHER)).toBeDefined();
    expect(deps.closeAllTerminalsForProject).toHaveBeenCalledWith(CLOSED);
    // Backend session teardown: PTY sweep, then the registry entry.
    expect(invoked).toContain('suspend_project_session');
    expect(invoked).toContain('unregister_project_session');
    expect(invoked).toContain('release_reserved_port');
    // Closing a background project leaves the user where they are.
    expect(deps.setView).not.toHaveBeenCalled();
    expect(deps.setCurrentProject).not.toHaveBeenCalled();
  });

  it('routes home and retires the auto-open sentinel when closing the open project', async () => {
    const { close, deps } = setup(CLOSED);

    await act(async () => {
      close(CLOSED);
      // Let the async teardown chain settle before asserting on it.
      await Promise.resolve();
    });

    expect(deps.setCurrentProject).toHaveBeenCalledWith(null);
    expect(deps.setView).toHaveBeenCalledWith('projects');
    expect(deps.currentProjectPathRef.current).toBeNull();
    // Without these two, useAppSetup's HMR recovery re-opens the project on
    // the very view change above — the reported "close does nothing" bug.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBe('true');
  });

  it('removes the row even when the dev-server stop never settles', () => {
    // A wedged backend call used to hold the entire teardown hostage: the
    // registry entry (and therefore the row) survived indefinitely.
    const { close, deps } = setup(CLOSED, { stopServer: () => new Promise<void>(() => {}) });

    act(() => {
      close(CLOSED);
    });

    expect(sessionRegistry.snapshot(CLOSED)).toBeUndefined();
    expect(deps.setView).toHaveBeenCalledWith('projects');
  });

  it('leaves another project’s sentinel alone when closing a background project', async () => {
    sessionStorage.setItem(STORAGE_KEY, OTHER);
    const { close } = setup(OTHER);

    await act(async () => {
      close(CLOSED);
      // Let the async teardown chain settle before asserting on it.
      await Promise.resolve();
    });

    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(OTHER);
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBeNull();
  });
});
