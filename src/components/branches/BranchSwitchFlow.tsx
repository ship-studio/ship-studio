/**
 * Switching branches — the one flow every "switch to X" control goes through.
 *
 * It used to live inside `BranchesTab`, and the header's quick Branches menu
 * called the *post-switch* UI sync (`onBranchSwitch`) directly, as if that were
 * the switch. It never ran `git checkout`: the header showed the new branch,
 * the health check "passed" against unchanged files, and the next status poll
 * snapped it back to the real branch (#1012). Both surfaces now share this.
 */

import { useCallback, useState } from 'react';
import { switchBranch } from '../../lib/branches';
import { getConflictInfo } from '../../lib/conflicts';
import { listWorktrees, type WorktreeInfo } from '../../lib/worktrees';
import { trackError, trackEvent } from '../../lib/analytics';
import {
  asCommandError,
  formatCommandError,
  humanizeGitError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { UnsavedChangesModal } from './UnsavedChangesModal';
import { MergeConflictModal } from './MergeConflictModal';

/** A Tauri-rejected `CommandError` is an object — `String(err)` renders it as
 *  "[object Object]". Format it to the real human message (the git stderr). */
export function errText(e: unknown): string {
  return formatCommandError(asCommandError(e));
}

/** True when git couldn't find the ref — the branch was deleted/renamed and the
 *  UI is showing a stale entry. `e` may be a caught error or a raw message. */
export function isBranchGoneError(e: unknown): boolean {
  const text = typeof e === 'string' ? e : errText(e);
  return /did not match|pathspec|unknown revision or path/i.test(text);
}

export interface BranchSwitchFlowOptions {
  projectPath: string;
  /** Post-switch UI sync. Called only once git has actually switched. */
  onBranchSwitch: (branchName: string) => void;
  /** Re-read branches, e.g. to drop a branch that no longer exists. */
  onRefresh: () => void;
  worktrees?: WorktreeInfo[];
  onOpenWorktree?: (path: string) => void;
  onWorktreesChanged?: () => void;
}

interface MergeConflictState {
  target: string;
  files: string[];
  source: string | null;
}

/** Runs a real branch switch, with the worktree, merge and unsaved-changes handling. */
export function useBranchSwitchFlow({
  projectPath,
  onBranchSwitch,
  onRefresh,
  worktrees = [],
  onOpenWorktree,
  onWorktreesChanged,
}: BranchSwitchFlowOptions) {
  const { showToast } = useOptionalToast();
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // Set when a switch is blocked by a paused merge: the branch the user tried to
  // switch to, the conflicted files, and the branch being merged in (from the
  // conflict markers) for the fix prompt.
  const [mergeConflict, setMergeConflict] = useState<MergeConflictState | null>(null);

  const switchTo = useCallback(
    async (branchName: string) => {
      // Git refuses to check out a branch that's already checked out in another
      // worktree — the faithful move is to go where the branch already lives.
      const homeWorktree = worktrees.find((w) => !w.isCurrent && w.branch === branchName);
      if (homeWorktree && onOpenWorktree) {
        showToast(`${branchName} is checked out in a worktree — opening it`, 'success');
        void trackEvent('worktree_switched', { via: 'branch_switch_redirect' });
        onOpenWorktree(homeWorktree.path);
        return;
      }

      // A paused merge with unresolved conflicts blocks switching. Catch that
      // explicitly and voice it, rather than failing with a raw git error or the
      // misleading "unsaved changes / publish & switch" flow (which would commit
      // conflict markers).
      const conflicts = await getConflictInfo(projectPath).catch(() => []);
      if (conflicts.length > 0) {
        const files = conflicts.map((c) => c.filePath);
        // The incoming/merge-source branch is the label on the `>>>>>>> <branch>`
        // marker (ours is usually just "HEAD", so we take theirs).
        const source = conflicts.map((c) => c.theirsBranch).find((b) => b && b !== 'HEAD') ?? null;
        setMergeConflict({ target: branchName, files, source });
        return;
      }

      setSwitchingBranch(branchName);
      try {
        // Try to switch without auto-stash - backend will tell us if there are uncommitted changes
        const result = await switchBranch(projectPath, branchName, false);
        if (result.success) {
          onBranchSwitch(branchName);
          void trackEvent('branch_switched', { $screen_name: 'Workspace' });
          showToast(
            result.stashApplied
              ? `Switched to ${branchName} and restored your stashed changes`
              : `Switched to ${branchName}`,
            'success'
          );
        } else if (result.error?.includes('Uncommitted changes')) {
          // Show the unsaved changes modal
          setPendingSwitch(branchName);
        } else {
          const raw = result.error ?? 'Failed to switch branch';
          // The worktree redirect above works off a list that can go stale —
          // another tool (an agent CLI managing .claude/worktrees, a manual
          // `git worktree add`) may have claimed the branch since the list
          // loaded. Git's refusal proves the worktree exists NOW: re-fetch and
          // finish the redirect instead of toasting a raw fatal (issue #406).
          if (/already used by worktree|already checked out/i.test(raw) && onOpenWorktree) {
            const fresh = await listWorktrees(projectPath).catch(() => []);
            const home = fresh.find((w) => !w.isCurrent && w.branch === branchName);
            if (home) {
              onWorktreesChanged?.();
              showToast(`${branchName} is checked out in a worktree — opening it`, 'success');
              void trackEvent('worktree_switched', { via: 'branch_switch_redirect' });
              onOpenWorktree(home.path);
              return;
            }
          }
          // Recognized, by-design refusals ride the info channel — an 'error'
          // toast would re-report a failure the backend already classified
          // Expected (issue #690, same pattern as useBranchManagement).
          showToast(
            humanizeGitError(raw, { branch: branchName }),
            isRecognizedGitFailure(raw, { branch: branchName }) ? 'info' : 'error'
          );
          // The branch is gone (deleted/renamed elsewhere) but still showing in a
          // stale list — refresh to drop the phantom entry.
          if (isBranchGoneError(raw)) onRefresh();
        }
      } catch (e) {
        trackError('branch_switch', e, 'Workspace');
        showToast(
          humanizeGitError(e, { branch: branchName }),
          isRecognizedGitFailure(e, { branch: branchName }) ? 'info' : 'error'
        );
        if (isBranchGoneError(errText(e))) onRefresh();
      } finally {
        setSwitchingBranch(null);
      }
    },
    [
      worktrees,
      onOpenWorktree,
      onWorktreesChanged,
      projectPath,
      onBranchSwitch,
      onRefresh,
      showToast,
    ]
  );

  return {
    switchTo,
    switchingBranch,
    pendingSwitch,
    clearPendingSwitch: () => setPendingSwitch(null),
    mergeConflict,
    clearMergeConflict: () => setMergeConflict(null),
  };
}

type BranchSwitchFlow = ReturnType<typeof useBranchSwitchFlow>;

/** The two modals a switch can stop at: unsaved changes, and a paused merge. */
export function BranchSwitchModals({
  flow,
  projectPath,
  currentBranch,
  onBranchSwitch,
  onRefresh,
  onSendToAgent,
}: {
  flow: BranchSwitchFlow;
  projectPath: string;
  currentBranch: string;
  onBranchSwitch: (branchName: string) => void;
  onRefresh: () => void;
  onSendToAgent?: (prompt: string) => void;
}) {
  const { pendingSwitch, clearPendingSwitch, mergeConflict, clearMergeConflict } = flow;
  return (
    <>
      {pendingSwitch && (
        <UnsavedChangesModal
          currentBranch={currentBranch}
          targetBranch={pendingSwitch}
          projectPath={projectPath}
          onSwitchComplete={(branchName) => {
            onBranchSwitch(branchName);
            clearPendingSwitch();
          }}
          onClose={clearPendingSwitch}
        />
      )}

      {mergeConflict && (
        <MergeConflictModal
          projectPath={projectPath}
          currentBranch={currentBranch}
          targetBranch={mergeConflict.target}
          sourceBranch={mergeConflict.source}
          files={mergeConflict.files}
          onSendToAgent={onSendToAgent}
          onAborted={() => {
            clearMergeConflict();
            onRefresh();
          }}
          onClose={clearMergeConflict}
        />
      )}
    </>
  );
}
