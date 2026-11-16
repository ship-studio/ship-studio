/**
 * Issue #1083: Undo/Redo on a project whose folder was moved, renamed or
 * deleted outside Ship Studio is a by-design state the backend classifies
 * Expected. The toast still shows, but must not be filed as a bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSnapshots } from './useSnapshots';
import * as snapshots from '../lib/snapshots';

vi.mock('../lib/snapshots', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));

vi.mock('./useWindowFocused', () => ({ useWindowFocused: () => false }));

const FOLDER_GONE =
  "The folder '<project>' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio";

describe('useSnapshots undo/redo failure toasts (#1083)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(snapshots.getStatus).mockResolvedValue({
      watching: true,
      can_undo: true,
      can_redo: true,
      is_git_repo: true,
      history_size: 1,
      cursor: 0,
      files_changed: [],
    });
  });

  it.each([
    ['undo', 'Undo'],
    ['redo', 'Redo'],
  ] as const)('marks a gone-folder %s failure as expected', async (action, verb) => {
    vi.mocked(snapshots[action]).mockRejectedValue({
      type: 'Other',
      message: FOLDER_GONE,
      expected: true,
    });
    const showToast = vi.fn();
    const { result } = renderHook(() => useSnapshots('/tmp/project', showToast));

    await act(async () => {
      await result.current[action]();
    });

    expect(showToast).toHaveBeenCalledWith(`${verb} failed: ${FOLDER_GONE}`, 'error', undefined, {
      expected: true,
    });
  });

  it('still reports an unclassified undo failure', async () => {
    vi.mocked(snapshots.undo).mockRejectedValue({ type: 'Other', message: 'Something broke' });
    const showToast = vi.fn();
    const { result } = renderHook(() => useSnapshots('/tmp/project', showToast));

    await act(async () => {
      await result.current.undo();
    });

    expect(showToast).toHaveBeenCalledWith('Undo failed: Something broke', 'error', undefined, {
      expected: false,
    });
  });
});
