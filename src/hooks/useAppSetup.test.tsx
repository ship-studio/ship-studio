/**
 * Regression coverage for the "closing a project re-opens it" bug.
 *
 * `useAppSetup`'s HMR-recovery effect re-runs on every `view` change. It
 * restores the workspace whenever two things are still true: the window's
 * sessionStorage sentinel names a project, and the backend still holds a
 * port reservation for it. Closing the current project navigates to
 * `projects` — which is a view change — so unless the close clears that
 * sentinel, the effect immediately re-opens the project that was just
 * closed. The sidebar row survives, and the whole thing reads as a flicker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { useAppSetup } from './useAppSetup';
import { clearStoredAutoOpenProject, markAutoOpenDismissed } from '../lib/window';
import type { AppView } from '../lib/types';

const PROJECT_PATH = '/tmp/closed-project';
const STORAGE_KEY = 'ship-studio-project-loaded-main';
const DISMISSED_KEY = 'ship-studio-auto-open-dismissed-main';

function makeParams() {
  return {
    setView: vi.fn(),
    setCurrentProject: vi.fn(),
    setDevServerPort: vi.fn(),
    handleSelectProject: vi.fn().mockResolvedValue(undefined),
    refreshAllCliStatuses: vi.fn().mockResolvedValue(undefined),
    setProjectGitHubStatus: vi.fn(),
    fetchBranchInfo: vi.fn().mockResolvedValue(undefined),
    openHelpModal: vi.fn(),
  };
}

/** Mount at `workspace` (HMR recovery is a no-op there), then flip to
 *  `projects` the way closing the current project does. */
function renderAcrossClose(params: ReturnType<typeof makeParams>) {
  const { rerender } = renderHook(
    ({ view }: { view: AppView }) => useAppSetup({ ...params, view }),
    { initialProps: { view: 'workspace' as AppView } }
  );
  return { toProjectsView: () => rerender({ view: 'projects' as AppView }) };
}

describe('useAppSetup HMR recovery vs. closing a project', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // The global setup's mocks are cleared after every test — re-arm them
    // here so each case gets a working `invoke` and window label.
    mockWindows('main');
    mockIPC((cmd) => {
      switch (cmd) {
        case 'quick_setup_check':
          return { setupCompleteCached: true, allPresent: true };
        case 'get_full_setup_status':
          return { allReady: true, items: [] };
        case 'get_default_agent':
          return 'claude-code';
        // A reservation outlives the dev server, so this is what the effect
        // sees for any project opened in this window at any point.
        case 'get_reserved_port_for_window':
          return 3000;
        default:
          return undefined;
      }
    });
    sessionStorage.setItem(STORAGE_KEY, PROJECT_PATH);
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('re-opens the project when the sentinel outlives the session (the bug)', async () => {
    const params = makeParams();
    const { toProjectsView } = renderAcrossClose(params);

    toProjectsView();

    await waitFor(() => {
      expect(params.setCurrentProject).toHaveBeenCalledWith(
        expect.objectContaining({ path: PROJECT_PATH })
      );
    });
    expect(params.setView).toHaveBeenCalledWith('workspace');
  });

  it('leaves the user on the dashboard once the close clears the sentinel', async () => {
    const params = makeParams();
    const { toProjectsView } = renderAcrossClose(params);

    // Exactly what handleCloseProject now does for the current project.
    clearStoredAutoOpenProject(PROJECT_PATH);
    markAutoOpenDismissed();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBe('true');

    toProjectsView();

    // Give the effect's async port lookup a chance to (wrongly) resolve.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(params.setCurrentProject).not.toHaveBeenCalled();
    expect(params.setView).not.toHaveBeenCalledWith('workspace');
  });

  it('only clears the sentinel for the project that was actually closed', () => {
    clearStoredAutoOpenProject('/tmp/some-other-project');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(PROJECT_PATH);

    clearStoredAutoOpenProject(PROJECT_PATH);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
