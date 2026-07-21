import { useEffect } from 'react';
import { useAsyncState } from './useAsyncState';
import { listWorktrees, type WorktreeInfo } from '../lib/worktrees';

export interface UseWorktreesReturn {
  /** All worktrees of the current project's repository (main first). */
  worktrees: WorktreeInfo[];
  isLoading: boolean;
  /** Re-query `git worktree list` — call after add/remove/prune or branch ops. */
  refresh: () => Promise<WorktreeInfo[] | null>;
}

/**
 * Worktree list for a project path. Loads on mount / path change; callers
 * refresh after mutations (add/remove/prune) and alongside branch refreshes.
 */
export function useWorktrees(projectPath: string | null): UseWorktreesReturn {
  const { data, isLoading, execute } = useAsyncState<WorktreeInfo[]>(async () =>
    projectPath ? listWorktrees(projectPath) : []
  );

  useEffect(() => {
    void execute();
  }, [projectPath, execute]);

  return { worktrees: data ?? [], isLoading, refresh: execute };
}
