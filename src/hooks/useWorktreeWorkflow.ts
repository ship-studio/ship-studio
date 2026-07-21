import { useCallback, useMemo } from 'react';
import { useWorktrees } from './useWorktrees';
import { useModal } from '../contexts/ModalContext';
import { checkDependenciesInstalled } from '../lib/project';
import { detectPackageManager } from '../lib/github';
import type { WorktreeInfo } from '../lib/worktrees';

interface Params {
  projectPath: string;
  showToast: (message: string, type?: 'success' | 'error') => void;
  /** In-place workspace switch — the same handler the sidebar rail uses. */
  onSelectProject: (path: string) => void;
  /** Tear down a session (dev server + PTYs) before a worktree is removed. */
  onCloseProject: (path: string) => void;
  /** Path-scoped dependency install (opens the install terminal overlay). */
  onRunInstallFor: (path: string, packageManager: string) => void;
}

/** Worktree props consumed by BranchPRTabContainer / BranchesTab. */
export interface WorktreeTabProps {
  worktrees: WorktreeInfo[];
  onOpenWorktree: (path: string) => void;
  onCloseWorktreeSession: (path: string) => void;
  onWorktreesChanged: () => void;
  onCreateWorktree: () => void;
}

/**
 * Owns the workspace's worktree wiring: the `git worktree list` state, the
 * create-modal trigger, and the post-create flow (open the new worktree,
 * auto-install its dependencies). WorkspaceView stays a pure orchestrator.
 */
export function useWorktreeWorkflow({
  projectPath,
  showToast,
  onSelectProject,
  onCloseProject,
  onRunInstallFor,
}: Params) {
  const modal = useModal('worktreeCreate');
  const { worktrees, refresh } = useWorktrees(projectPath);
  const openCreate = modal.open;

  const handleCreated = useCallback(
    (path: string) => {
      showToast('Worktree created', 'success');
      void refresh();
      onSelectProject(path);
      // A fresh worktree checkout never has node_modules — start the install
      // immediately instead of waiting for the Preview CTA click.
      void checkDependenciesInstalled(path)
        .then(async (status) => {
          if (status.hasPackageJson && !status.installed) {
            const pm = await detectPackageManager(path).catch(() => 'npm');
            onRunInstallFor(path, pm);
          }
        })
        .catch(() => {
          // Detection failure just falls back to the existing install CTA.
        });
    },
    [showToast, refresh, onSelectProject, onRunInstallFor]
  );

  const tabProps: WorktreeTabProps = useMemo(
    () => ({
      worktrees,
      onOpenWorktree: onSelectProject,
      onCloseWorktreeSession: onCloseProject,
      onWorktreesChanged: () => void refresh(),
      onCreateWorktree: openCreate,
    }),
    [worktrees, onSelectProject, onCloseProject, refresh, openCreate]
  );

  return { worktrees, refresh, openCreate, handleCreated, tabProps };
}
