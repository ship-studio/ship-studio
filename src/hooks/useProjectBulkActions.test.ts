import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardProject } from '../lib/project';
import { deleteProject, removeProjectFromApp } from '../lib/project';
import { trackError } from '../lib/analytics';
import {
  describeProjectSelection,
  projectCountLabel,
  useProjectBulkActions,
} from './useProjectBulkActions';

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
  },
}));

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
    ...overrides,
  };
}

describe('useProjectBulkActions', () => {
  const removeProjectFromAppMock = vi.mocked(removeProjectFromApp);
  const deleteProjectMock = vi.mocked(deleteProject);
  const trackErrorMock = vi.mocked(trackError);

  beforeEach(() => {
    vi.clearAllMocks();
    removeProjectFromAppMock.mockResolvedValue(undefined);
    deleteProjectMock.mockResolvedValue(undefined);
  });

  it('formats project counts and compact selection labels', () => {
    expect(projectCountLabel(1)).toBe('1 project');
    expect(projectCountLabel(2)).toBe('2 projects');

    expect(
      describeProjectSelection([
        makeProject({ name: 'Alpha' }),
        makeProject({ name: 'Beta' }),
        makeProject({ name: 'Gamma' }),
        makeProject({ name: 'Delta' }),
      ])
    ).toBe('Alpha, Beta, Gamma and 1 more');
  });

  it('tracks selected visible projects and prunes hidden selections', async () => {
    const alpha = makeProject({ name: 'Alpha' });
    const beta = makeProject({ name: 'Beta' });
    const params = {
      loadAll: vi.fn().mockResolvedValue(undefined),
      showToast: vi.fn(),
    };

    const { result, rerender } = renderHook(
      ({ projects }: { projects: DashboardProject[] }) =>
        useProjectBulkActions({ ...params, filteredProjects: projects }),
      { initialProps: { projects: [alpha, beta] } }
    );

    act(() => {
      result.current.handleToggleProjectSelection(alpha.path);
    });
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.selectedProjectPaths.has(alpha.path)).toBe(true);

    act(() => {
      result.current.handleSelectAllVisible(true);
    });
    expect(result.current.selectedCount).toBe(2);
    expect(result.current.allVisibleSelected).toBe(true);

    rerender({ projects: [beta] });

    await waitFor(() => {
      expect(result.current.selectedCount).toBe(1);
    });
    expect(result.current.selectedProjectPaths.has(beta.path)).toBe(true);
    expect(result.current.selectedProjectPaths.has(alpha.path)).toBe(false);

    rerender({ projects: [alpha, beta] });

    await waitFor(() => {
      expect(result.current.selectedCount).toBe(1);
    });
    expect(result.current.selectedProjectPaths.has(beta.path)).toBe(true);
    expect(result.current.selectedProjectPaths.has(alpha.path)).toBe(false);
  });

  it('removes selected projects from Ship Studio and unpins pinned projects', async () => {
    const alpha = makeProject({ name: 'Alpha' });
    const beta = makeProject({ name: 'Beta' });
    const loadAll = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const onTogglePin = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProjectBulkActions({
        filteredProjects: [alpha, beta],
        pinnedSet: new Set([alpha.path]),
        onTogglePin,
        loadAll,
        showToast,
      })
    );

    act(() => {
      result.current.handleSelectAllVisible(true);
    });
    act(() => {
      result.current.handleBeginBulkProjectAction('remove');
    });

    const confirm = result.current.bulkConfirm;
    expect(confirm).not.toBeNull();

    await act(async () => {
      await result.current.handleBulkProjectAction(confirm!);
    });

    expect(removeProjectFromAppMock).toHaveBeenCalledWith(alpha.path);
    expect(removeProjectFromAppMock).toHaveBeenCalledWith(beta.path);
    expect(deleteProjectMock).not.toHaveBeenCalled();
    expect(onTogglePin).toHaveBeenCalledWith(alpha.path, false);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Removed 2 projects', 'success');
    expect(result.current.selectedCount).toBe(0);
  });

  it('counts successful removals even when optional unpin cleanup fails', async () => {
    const alpha = makeProject({ name: 'Alpha' });
    const loadAll = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const onTogglePin = vi.fn().mockRejectedValue(new Error('pin write failed'));

    const { result } = renderHook(() =>
      useProjectBulkActions({
        filteredProjects: [alpha],
        pinnedSet: new Set([alpha.path]),
        onTogglePin,
        loadAll,
        showToast,
      })
    );

    act(() => {
      result.current.handleToggleProjectSelection(alpha.path);
    });
    act(() => {
      result.current.handleBeginBulkProjectAction('remove');
    });

    const confirm = result.current.bulkConfirm;
    expect(confirm).not.toBeNull();

    await act(async () => {
      await result.current.handleBulkProjectAction(confirm!);
    });

    expect(removeProjectFromAppMock).toHaveBeenCalledWith(alpha.path);
    expect(onTogglePin).toHaveBeenCalledWith(alpha.path, false);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Removed 1 project', 'success');
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove'),
      'error'
    );
    expect(trackErrorMock).toHaveBeenCalledWith(
      'project_bulk_unpin_after_action',
      expect.any(Error),
      'Dashboard'
    );
  });

  it('blocks deleting external projects from the bulk action bar', () => {
    const external = makeProject({
      name: 'External',
      path: '/Users/test/external-project',
      is_external: true,
    });
    const showToast = vi.fn();

    const { result } = renderHook(() =>
      useProjectBulkActions({
        filteredProjects: [external],
        loadAll: vi.fn().mockResolvedValue(undefined),
        showToast,
      })
    );

    act(() => {
      result.current.handleToggleProjectSelection(external.path);
    });
    act(() => {
      result.current.handleBeginBulkProjectAction('delete');
    });

    expect(result.current.bulkConfirm).toBeNull();
    expect(deleteProjectMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'External projects can only be removed from Ship Studio.',
      'error'
    );
  });
});
