import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AppView } from '../lib/types';

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { useOrphanedWorkspaceGuard } from './useOrphanedWorkspaceGuard';

describe('useOrphanedWorkspaceGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a projectless workspace view back to projects', () => {
    const setView = vi.fn();
    renderHook(() => useOrphanedWorkspaceGuard('workspace', false, setView));
    expect(setView).toHaveBeenCalledWith('projects');
  });

  it('leaves a workspace with a project alone', () => {
    const setView = vi.fn();
    renderHook(() => useOrphanedWorkspaceGuard('workspace', true, setView));
    expect(setView).not.toHaveBeenCalled();
  });

  it.each<AppView>(['loading', 'projects', 'project-loading', 'workflows', 'inbox'])(
    'ignores the %s view without a project',
    (view) => {
      const setView = vi.fn();
      renderHook(() => useOrphanedWorkspaceGuard(view, false, setView));
      expect(setView).not.toHaveBeenCalled();
    }
  );
});
