/**
 * Merge conflict modal.
 *
 * Shown when a branch switch is blocked because git paused a merge with
 * unresolved conflicts. It voices the situation in plain language and gives two
 * clear ways out: hand it to the agent (copies a fix prompt and pastes it into
 * the agent terminal) or undo the merge (`git merge --abort`). No "publish" or
 * "discard" here, because neither describes what's actually happening.
 *
 * @module components/MergeConflictModal
 */

import { useState } from 'react';
import { WarningIcon } from '../icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { abortMerge } from '../../lib/conflicts';
import { humanizeGitError } from '../../lib/errors';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';

interface MergeConflictModalProps {
  /** Project path for the abort/merge operations. */
  projectPath: string;
  /** The branch you're currently on (where the paused merge lives). */
  currentBranch: string;
  /** The branch you tried to switch to (why this modal appeared). */
  targetBranch: string;
  /** The branch being merged in, from the conflict markers. Null if unknown. */
  sourceBranch: string | null;
  /** Paths of the files with unresolved conflicts. */
  files: string[];
  /** Paste the fix prompt into the agent terminal (auto-paste on "Copy & Fix"). */
  onSendToAgent?: (prompt: string) => void;
  /** Called after the merge is aborted, to refresh branch state and close. */
  onAborted: () => void;
  /** Close the modal without doing anything. */
  onClose: () => void;
}

/** Build the agent fix prompt, naming the branches and conflicted files. */
function buildFixPrompt(
  currentBranch: string,
  sourceBranch: string | null,
  files: string[]
): string {
  const fileList = files.length ? files.join(', ') : 'the affected files';
  const where = sourceBranch
    ? `I'm merging ${sourceBranch} into ${currentBranch}, and it hit conflicts in ${fileList}.`
    : `There's a paused git merge into ${currentBranch} with conflicts in ${fileList}.`;
  return `${where} Please resolve the conflicts in those files, then stage them and commit to finish the merge.`;
}

export function MergeConflictModal({
  projectPath,
  currentBranch,
  targetBranch,
  sourceBranch,
  files,
  onSendToAgent,
  onAborted,
  onClose,
}: MergeConflictModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [isAborting, setIsAborting] = useState(false);
  const { copy } = useCopyToClipboard({});

  const fixPrompt = buildFixPrompt(currentBranch, sourceBranch, files);

  const handleCopyAndFix = () => {
    void copy(fixPrompt);
    onSendToAgent?.(fixPrompt);
    onToast('Copied and sent to your agent', 'success');
    onClose();
  };

  const handleUndo = async () => {
    setIsAborting(true);
    try {
      await abortMerge(projectPath);
      onToast('Merge undone', 'success');
      onAborted();
    } catch (e) {
      onToast(humanizeGitError(e), 'error');
    } finally {
      setIsAborting(false);
    }
  };

  const fileText = files.length ? files.join(', ') : 'some files';

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isAborting}
      className="git-error-content"
      ariaLabel="Finish this merge before switching"
    >
      <div className="git-error-header">
        <div className="git-error-icon">
          <WarningIcon size={24} />
        </div>
        <h2>Finish this merge before switching</h2>
      </div>

      <div className="git-error-body">
        <p className="git-error-description">
          {sourceBranch ? (
            <>
              <strong>{currentBranch}</strong> is partway through merging in{' '}
              <strong>{sourceBranch}</strong>, and it stopped on a conflict in {fileText}.
            </>
          ) : (
            <>
              <strong>{currentBranch}</strong> has a paused merge that stopped on a conflict in{' '}
              {fileText}.
            </>
          )}{' '}
          Finish it or undo it, then you can switch to <strong>{targetBranch}</strong>.
        </p>

        <div className="git-error-prompt-section">
          <div className="git-error-prompt-label">
            Paste this to your agent and it&apos;ll fix it:
          </div>
          <div className="git-error-prompt">{fixPrompt}</div>
        </div>
      </div>

      <div className="git-error-footer">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleUndo()}
          disabled={isAborting}
        >
          {isAborting ? 'Undoing...' : 'Undo the merge'}
        </Button>
        <Button variant="primary" size="sm" onClick={handleCopyAndFix} disabled={isAborting}>
          Copy &amp; Fix
        </Button>
      </div>
    </ModalFrame>
  );
}
