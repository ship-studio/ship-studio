import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardProject } from '../lib/project';
import { deleteProject, removeProjectFromApp } from '../lib/project';
import { trackError } from '../lib/analytics';
import { logger } from '../lib/logger';
import { useProjectRemovalActions } from './useProjectRemovalActions';

vi.mock('../lib/project', () => ({
  deleteProject: vi.fn(),
  removeProjectFromApp: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackError: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// jsdom has no window.alert.
vi.stubGlobal('alert', vi.fn());

function makeProject(overrides: Partial<DashboardProject> = {}): DashboardProject {
  const name = overrides.name ?? 'Alpha';
  return {
    name,
    path: overrides.path ?? `/Users/test/ShipStudio/${name.toLowerCase()}`,
    thumbnail: null,
    last_opened: null,
    git_branch: 'main',
    uncommitted_count: 0,
    auto_accept_mode: null,
    hide_main_branch_warning: null,
    is_external: false,
    workspace_subpath: null,
    worktree_count: null,
    ...overrides,
  };
}

const FOLDER_GONE_ERROR = {
  type: 'Other' as const,
  message:
    "The folder 'happy-lipo' no longer exists — it may have been moved, renamed, or deleted outside Harbr",
  expected: true,
};

describe('useProjectRemovalActions', () => {
  const removeProjectFromAppMock = vi.mocked(removeProjectFromApp);
  const deleteProjectMock = vi.mocked(deleteProject);
  const trackErrorMock = vi.mocked(trackError);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
  const loggerErrorMock = vi.mocked(logger.error);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
  const loggerWarnMock = vi.mocked(logger.warn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup() {
    const params = {
      loadAll: vi.fn().mockResolvedValue(undefined),
      showToast: vi.fn(),
      removeProjectFromSelection: vi.fn(),
    };
    const { result } = renderHook(() => useProjectRemovalActions(params));
    return { result, ...params };
  }

  // Issue #878: a project whose folder is already gone (moved/renamed/
  // deleted outside Harbr) is a normal environment change, not a bug —
  // it must be logged as a warning, never routed through trackError /
  // logger.error, which auto-file a bug report.
  it('logs a vanished folder as a warning, not an error, on remove-from-app', async () => {
    removeProjectFromAppMock.mockRejectedValue(FOLDER_GONE_ERROR);
    const { result, showToast } = setup();

    await act(async () => {
      await result.current.handleRemoveFromApp(makeProject());
    });

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(trackErrorMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Failed to remove'), 'error');
  });

  it('logs a vanished folder as a warning, not an error, on delete', async () => {
    deleteProjectMock.mockRejectedValue(FOLDER_GONE_ERROR);
    const { result } = setup();

    await act(async () => {
      await result.current.handleDelete(makeProject());
    });

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(trackErrorMock).not.toHaveBeenCalled();
  });

  it('still reports a real failure as an error on remove-from-app', async () => {
    removeProjectFromAppMock.mockRejectedValue({
      type: 'Other',
      message: 'Disk is full',
    });
    const { result } = setup();

    await act(async () => {
      await result.current.handleRemoveFromApp(makeProject());
    });

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(trackErrorMock).toHaveBeenCalledWith(
      'project_remove_from_app',
      expect.anything(),
      'Dashboard'
    );
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });
});
