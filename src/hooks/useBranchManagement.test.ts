import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBranchManagement, type UseBranchManagementParams } from './useBranchManagement';
import type { RefObject } from 'react';
import type { PreviewHandle } from '../components/Preview';
import type { HealthTabPanelRef } from '../components/HealthTabPanel';

// Mock external dependencies
vi.mock('../lib/branches', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  listBranches: vi.fn().mockResolvedValue([]),
  listPullRequests: vi.fn().mockResolvedValue([]),
  switchBranch: vi.fn().mockResolvedValue({ success: true }),
  pullAndMerge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/git', () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const defaultBranch: import('../lib/branches').BranchInfo = {
  name: 'main',
  isCurrent: true,
  isRemote: false,
  isDefault: true,
  lastCommitDate: Date.now(),
  lastCommitAuthor: 'Test',
  aheadOfMain: 0,
  behindOfMain: 0,
};

function createParams(overrides?: Partial<UseBranchManagementParams>): UseBranchManagementParams {
  return {
    currentProject: { name: 'test-project', path: '/test/path', thumbnail: null },
    previewRef: { current: { refresh: vi.fn() } } as unknown as RefObject<PreviewHandle | null>,
    healthPanelRef: {
      current: {
        refreshScripts: vi.fn().mockResolvedValue(undefined),
        runAllChecks: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as RefObject<HealthTabPanelRef | null>,
    showToast: vi.fn(),
    ...overrides,
  };
}

describe('useBranchManagement', () => {
  let branches: typeof import('../lib/branches');
  let git: typeof import('../lib/git');
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Import mocked modules for per-test configuration
    branches = await import('../lib/branches');
    git = await import('../lib/git');
    core = await import('@tauri-apps/api/core');

    // Default mock responses
    vi.mocked(branches.getCurrentBranch).mockResolvedValue('main');
    vi.mocked(branches.listBranches).mockResolvedValue([defaultBranch]);
    vi.mocked(branches.listPullRequests).mockResolvedValue([]);
    vi.mocked(git.getChangedFiles).mockResolvedValue([]);
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_git_has_changes')
        return Promise.resolve(false) as ReturnType<typeof core.invoke>;
      return Promise.resolve(undefined) as ReturnType<typeof core.invoke>;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes with null/empty state', () => {
    const params = createParams({ currentProject: null });
    const { result } = renderHook(() => useBranchManagement(params));

    expect(result.current.currentBranch).toBeNull();
    expect(result.current.branches).toEqual([]);
    expect(result.current.openPRs).toEqual([]);
    expect(result.current.hasUncommittedChanges).toBe(false);
    expect(result.current.changedFiles).toEqual([]);
    expect(result.current.gitError).toBeNull();
    expect(result.current.showConflictResolution).toBe(false);
  });

  describe('fetchBranchInfo', () => {
    it('fetches current branch and branch list', async () => {
      const featureBranch = { ...defaultBranch, name: 'feature', isCurrent: false };
      vi.mocked(branches.getCurrentBranch).mockResolvedValue('main');
      vi.mocked(branches.listBranches).mockResolvedValue([defaultBranch, featureBranch]);

      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });

      expect(result.current.currentBranch).toBe('main');
      expect(result.current.branches).toHaveLength(2);
    });

    it('handles fetch errors gracefully', async () => {
      vi.mocked(branches.getCurrentBranch).mockRejectedValue(new Error('git error'));
      vi.mocked(branches.listBranches).mockRejectedValue(new Error('git error'));

      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });

      expect(result.current.currentBranch).toBeNull();
      expect(result.current.branches).toEqual([]);
    });

    it('filters PRs to only OPEN state', async () => {
      vi.mocked(branches.listPullRequests).mockResolvedValue([
        {
          number: 1,
          title: 'Open PR',
          state: 'OPEN',
          headRef: 'feat-1',
          baseRef: 'main',
          author: 'user',
          mergeable: true,
          url: '',
          createdAt: '',
        },
        {
          number: 2,
          title: 'Closed PR',
          state: 'CLOSED',
          headRef: 'feat-2',
          baseRef: 'main',
          author: 'user',
          mergeable: null,
          url: '',
          createdAt: '',
        },
        {
          number: 3,
          title: 'Merged PR',
          state: 'MERGED',
          headRef: 'feat-3',
          baseRef: 'main',
          author: 'user',
          mergeable: null,
          url: '',
          createdAt: '',
        },
      ]);

      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
        // Flush microtasks so the non-blocking PR fetch resolves
        // (don't use runAllTimersAsync — it loops on the 3s polling interval)
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.openPRs).toHaveLength(1);
      expect(result.current.openPRs[0].title).toBe('Open PR');
    });
  });

  describe('checkGitStatus', () => {
    it('updates uncommitted changes status', async () => {
      vi.mocked(core.invoke).mockImplementation((cmd: string) => {
        if (cmd === 'check_git_has_changes')
          return Promise.resolve(true) as ReturnType<typeof core.invoke>;
        return Promise.resolve(undefined) as ReturnType<typeof core.invoke>;
      });
      vi.mocked(git.getChangedFiles).mockResolvedValue([
        { path: 'file.ts', status: 'modified' },
      ] as Awaited<ReturnType<typeof git.getChangedFiles>>);

      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.checkGitStatus('/test/path');
      });

      expect(result.current.hasUncommittedChanges).toBe(true);
      expect(result.current.changedFiles).toHaveLength(1);
    });

    it('detects branch change and refreshes branch list', async () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      // Set initial branch
      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });
      expect(result.current.currentBranch).toBe('main');

      // Track calls before the test action
      const callsBefore = vi.mocked(branches.listBranches).mock.calls.length;

      // Simulate branch changed via CLI
      vi.mocked(branches.getCurrentBranch).mockResolvedValue('feature');

      await act(async () => {
        await result.current.checkGitStatus('/test/path');
      });

      expect(result.current.currentBranch).toBe('feature');
      // listBranches should have been called at least once more to refresh
      expect(vi.mocked(branches.listBranches).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  describe('polling', () => {
    it('starts polling when project is open', async () => {
      const params = createParams();
      renderHook(() => useBranchManagement(params));

      // Initial immediate call
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(branches.getCurrentBranch).toHaveBeenCalled();

      const callCount = vi.mocked(branches.getCurrentBranch).mock.calls.length;

      // After 10 seconds, should poll again
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });

      expect(vi.mocked(branches.getCurrentBranch).mock.calls.length).toBeGreaterThan(callCount);
    });

    it('does not poll when no project is set', async () => {
      const params = createParams({ currentProject: null });
      renderHook(() => useBranchManagement(params));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(branches.getCurrentBranch).not.toHaveBeenCalled();
    });
  });

  describe('handlePublishError', () => {
    it('records git error with correct type', async () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      // Set current branch first
      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });

      act(() => {
        result.current.handlePublishError('Push was rejected', 'push_rejected');
      });

      expect(result.current.gitError).toEqual({
        errorType: 'push_rejected',
        message: 'Push was rejected',
        branchName: 'main',
      });
    });

    it('does not record error when no current branch', () => {
      const params = createParams({ currentProject: null });
      const { result } = renderHook(() => useBranchManagement(params));

      act(() => {
        result.current.handlePublishError('Error', 'generic');
      });

      expect(result.current.gitError).toBeNull();
    });
  });

  describe('clearBranchState', () => {
    it('resets all branch state', async () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });
      expect(result.current.currentBranch).toBe('main');

      act(() => {
        result.current.clearBranchState();
      });

      expect(result.current.currentBranch).toBeNull();
      expect(result.current.branches).toEqual([]);
      expect(result.current.hasUncommittedChanges).toBe(false);
      expect(result.current.changedFiles).toEqual([]);
    });
  });

  describe('conflict resolution', () => {
    it('opens conflict resolution directly when no branches specified', async () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      await act(async () => {
        await result.current.handleResolveConflicts();
      });

      expect(result.current.showConflictResolution).toBe(true);
    });

    it('clears git error when resolving conflicts', async () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      // Set up a git error first
      await act(async () => {
        await result.current.fetchBranchInfo('/test/path');
      });
      act(() => {
        result.current.setGitError({
          errorType: 'merge_conflict',
          message: 'Conflicts detected',
          branchName: 'main',
        });
      });
      expect(result.current.gitError).not.toBeNull();

      await act(async () => {
        await result.current.handleResolveConflicts();
      });

      expect(result.current.gitError).toBeNull();
    });

    it('handleConflictsResolved closes modal and refreshes', () => {
      const params = createParams();
      const { result } = renderHook(() => useBranchManagement(params));

      act(() => {
        result.current.setShowConflictResolution(true);
      });
      expect(result.current.showConflictResolution).toBe(true);

      act(() => {
        result.current.handleConflictsResolved();
      });
      expect(result.current.showConflictResolution).toBe(false);
    });
  });
});
