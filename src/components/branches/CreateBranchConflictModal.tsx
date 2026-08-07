/**
 * Shown when creating a branch fails because uncommitted changes would be
 * overwritten by the checkout onto the new branch's base. Offers two ways
 * forward (plus Cancel):
 *
 * - Commit & create — commit the changes on the CURRENT branch first (message
 *   auto-generated from the diff, with a fallback), then create the branch.
 * - Stash & create — set the changes aside with `git stash`, then create the
 *   branch clean. The user restores them later with `git stash pop`.
 *
 * Either path ends by creating the branch (now that the tree is clean) and
 * switching to it. Mirrors the switch-flow `UnsavedChangesModal`.
 *
 * @module components/CreateBranchConflictModal
 */

import { useState } from 'react';
import { WarningIcon } from '../icons';
import { createBranch, switchBranch } from '../../lib/branches';
import { commitChanges, stashChanges } from '../../lib/git';
import { generateCommitMessage } from '../../lib/ai';
import { asCommandError, formatCommandError, humanizeGitError } from '../../lib/errors';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';

/** Commit subject used when AI generation isn't available (no agent / it fails). */
const FALLBACK_COMMIT_MESSAGE = 'Save work in progress';

function errText(e: unknown): string {
  return formatCommandError(asCommandError(e));
}

interface CreateBranchConflictModalProps {
  /** Project path for git operations. */
  projectPath: string;
  /** The current branch the changes live on. */
  currentBranch: string;
  /** The branch name the user is trying to create. */
  targetBranch: string;
  /** The base branch the new branch is created from. */
  baseBranch: string;
  /** Called after the branch is created and switched to. */
  onCreated: (branchName: string) => void;
  /** Close the modal without doing anything. */
  onClose: () => void;
}

export function CreateBranchConflictModal({
  projectPath,
  currentBranch,
  targetBranch,
  baseBranch,
  onCreated,
  onClose,
}: CreateBranchConflictModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isStashing, setIsStashing] = useState(false);
  const isLoading = isCommitting || isStashing;

  /** Create the branch (tree is clean by now) and switch to it. */
  const finishCreate = async (extra?: string) => {
    await createBranch(projectPath, targetBranch, baseBranch);
    // The working tree can pick up new changes between the stash/commit step
    // and this switch (dev-server config writes, background tooling), making
    // the switch fail again with "Uncommitted changes" — a dead end inside the
    // very modal meant to resolve it. Retry once with auto-stash, mirroring
    // UnsavedChangesModal's #273/PR #281 fix (issue #564).
    let result = await switchBranch(projectPath, targetBranch, false);
    if (!result.success && result.error?.includes('Uncommitted changes')) {
      result = await switchBranch(projectPath, targetBranch, true);
    }
    if (result.success) {
      onCreated(targetBranch);
      onToast(`Created and switched to ${targetBranch}${extra ? ` — ${extra}` : ''}`, 'success');
      onClose();
    } else {
      // Even the auto-stash retry failed. The branch exists — re-running this
      // modal's actions would only trip over the existing branch, so don't
      // dead-end here: humanize the failure, point at the path forward
      // (Branches tab), and close.
      const detail = result.error
        ? humanizeGitError(result.error, { branch: targetBranch })
        : '(git reported failure with no detail)';
      onToast(
        `Created "${targetBranch}", but couldn't switch to it: ${detail} You can switch to it from the Branches tab.${extra ? ` (${extra})` : ''}`,
        'error'
      );
      onClose();
    }
  };

  const handleCommitAndCreate = async () => {
    setIsCommitting(true);
    try {
      let message = FALLBACK_COMMIT_MESSAGE;
      try {
        const generated = (await generateCommitMessage(projectPath)).trim();
        if (generated) message = generated;
      } catch {
        // No headless agent / generation failed — fall back to a plain subject.
      }
      await commitChanges(projectPath, message);
      await finishCreate(`changes committed on ${currentBranch}`);
    } catch (e) {
      onToast(`Failed to create branch: ${errText(e)}`, 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  const handleStashAndCreate = async () => {
    setIsStashing(true);
    try {
      await stashChanges(projectPath);
      await finishCreate('your changes are stashed (run `git stash pop` to restore)');
    } catch (e) {
      onToast(`Failed to create branch: ${errText(e)}`, 'error');
    } finally {
      setIsStashing(false);
    }
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isLoading}
      className="unsaved-changes-content"
      title={
        <>
          <WarningIcon size={20} />
          <span>Uncommitted Changes</span>
        </>
      }
    >
      <div className="unsaved-changes-body">
        <p>
          You have uncommitted changes on <strong>{currentBranch}</strong> that would be lost
          creating <strong>{targetBranch}</strong> from <strong>{baseBranch}</strong>. What would
          you like to do with them?
        </p>
      </div>
      <div className="unsaved-changes-actions">
        <Button variant="secondary" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleStashAndCreate()}
          disabled={isLoading}
        >
          {isStashing ? 'Stashing…' : 'Stash & Create'}
        </Button>
        <Button variant="primary" onClick={() => void handleCommitAndCreate()} disabled={isLoading}>
          {isCommitting ? 'Committing…' : 'Commit & Create'}
        </Button>
      </div>
    </ModalFrame>
  );
}
