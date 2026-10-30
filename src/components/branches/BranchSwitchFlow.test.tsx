import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const switchBranch = vi.fn();
const getConflictInfo = vi.fn();
const listWorktrees = vi.fn();
const showToast = vi.fn();

vi.mock('../../lib/branches', () => ({
  switchBranch: (...args: unknown[]) => switchBranch(...args) as unknown,
}));
vi.mock('../../lib/conflicts', () => ({
  getConflictInfo: (...args: unknown[]) => getConflictInfo(...args) as unknown,
}));
vi.mock('../../lib/worktrees', () => ({
  listWorktrees: (...args: unknown[]) => listWorktrees(...args) as unknown,
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../contexts/ToastContext', () => ({ useOptionalToast: () => ({ showToast }) }));
vi.mock('./UnsavedChangesModal', () => ({ UnsavedChangesModal: () => null }));
vi.mock('./MergeConflictModal', () => ({ MergeConflictModal: () => null }));

import { useBranchSwitchFlow } from './BranchSwitchFlow';

const PROJECT = '/Users/dev/ShipStudio/site';

function setup(overrides: Partial<Parameters<typeof useBranchSwitchFlow>[0]> = {}) {
  const onBranchSwitch = vi.fn();
  const onRefresh = vi.fn();
  const hook = renderHook(() =>
    useBranchSwitchFlow({ projectPath: PROJECT, onBranchSwitch, onRefresh, ...overrides })
  );
  return { hook, onBranchSwitch, onRefresh };
}

describe('useBranchSwitchFlow (#1012)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConflictInfo.mockResolvedValue([]);
  });

  it('runs the real checkout before syncing the UI', async () => {
    switchBranch.mockResolvedValue({ success: true, stashApplied: false });
    const { hook, onBranchSwitch } = setup();

    await act(() => hook.result.current.switchTo('feature/a'));

    expect(switchBranch).toHaveBeenCalledWith(PROJECT, 'feature/a', false);
    expect(onBranchSwitch).toHaveBeenCalledWith('feature/a');
    expect(switchBranch.mock.invocationCallOrder[0]).toBeLessThan(
      onBranchSwitch.mock.invocationCallOrder[0]
    );
    expect(showToast).toHaveBeenCalledWith('Switched to feature/a', 'success');
  });

  it('does not claim a switch git refused, and asks about unsaved changes', async () => {
    switchBranch.mockResolvedValue({ success: false, error: 'Uncommitted changes' });
    const { hook, onBranchSwitch } = setup();

    await act(() => hook.result.current.switchTo('feature/a'));

    expect(onBranchSwitch).not.toHaveBeenCalled();
    expect(hook.result.current.pendingSwitch).toBe('feature/a');
  });

  it('opens the worktree that already holds the branch instead of checking out', async () => {
    const onOpenWorktree = vi.fn();
    const { hook, onBranchSwitch } = setup({
      onOpenWorktree,
      worktrees: [{ path: '/wt/a', branch: 'feature/a', isCurrent: false, isMain: false }] as never,
    });

    await act(() => hook.result.current.switchTo('feature/a'));

    expect(onOpenWorktree).toHaveBeenCalledWith('/wt/a');
    expect(switchBranch).not.toHaveBeenCalled();
    expect(onBranchSwitch).not.toHaveBeenCalled();
  });

  it('stops at a paused merge rather than switching', async () => {
    getConflictInfo.mockResolvedValue([{ filePath: 'a.ts', theirsBranch: 'other' }]);
    const { hook, onBranchSwitch } = setup();

    await act(() => hook.result.current.switchTo('feature/a'));

    expect(switchBranch).not.toHaveBeenCalled();
    expect(onBranchSwitch).not.toHaveBeenCalled();
    expect(hook.result.current.mergeConflict).toEqual({
      target: 'feature/a',
      files: ['a.ts'],
      source: 'other',
    });
  });
});
