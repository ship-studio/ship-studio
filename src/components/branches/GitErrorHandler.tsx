/**
 * Git error handler modal.
 *
 * Shows helpful error messages when git operations fail,
 * with suggested Claude prompts to help resolve issues.
 *
 * @module components/GitErrorHandler
 */

import { WarningIcon, CopyIcon } from '../icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';

interface GitErrorHandlerProps {
  /** Type of git error */
  errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
  /** Raw error message */
  errorMessage: string;
  /** Branch name where error occurred */
  branchName: string;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback to send prompt to Claude (paste into terminal) */
  onSendToClaude?: (prompt: string) => void;
  /** Callback to open conflict resolution UI (only for merge_conflict type) */
  onResolveConflicts?: () => void;
}

export function GitErrorHandler({
  errorType,
  errorMessage,
  branchName,
  onClose,
  onSendToClaude,
  onResolveConflicts,
}: GitErrorHandlerProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const getErrorInfo = () => {
    switch (errorType) {
      case 'push_rejected':
        return {
          title: 'Push was rejected',
          description:
            'Someone else pushed changes to this branch. You need to pull their changes first.',
          claudePrompt: `My git push was rejected with "non-fast-forward" error on branch "${branchName}". Please help me:
1. Pull the latest changes from the remote
2. Resolve any merge conflicts if they occur
3. Push my changes again`,
        };
      case 'auth_error':
        return {
          title: 'Authentication failed',
          description: 'GitHub rejected the connection. Your authentication may have expired.',
          claudePrompt: `I'm getting a GitHub authentication error when trying to push to "${branchName}". Please help me:
1. Check my git credentials
2. Re-authenticate with GitHub if needed
3. Try the push again`,
        };
      case 'merge_conflict':
        return {
          title: 'Merge conflict',
          description:
            'Someone else changed the same files you modified. You can resolve these conflicts visually or ask Claude for help.',
          claudePrompt: `I have merge conflicts on branch "${branchName}". Please help me:
1. Show me which files have conflicts
2. Guide me through resolving them
3. Complete the merge`,
        };
      default:
        return {
          title: 'Git operation failed',
          description: 'Something went wrong with the git operation.',
          claudePrompt: `I got a git error on branch "${branchName}":

${errorMessage}

Please help me understand what went wrong and how to fix it.`,
        };
    }
  };

  const errorInfo = getErrorInfo();
  const { copy } = useCopyToClipboard({
    onCopy: () => onToast?.('Prompt copied to clipboard', 'success'),
    onError: () => onToast?.('Failed to copy to clipboard', 'error'),
  });

  const handleCopyPrompt = () => {
    void copy(errorInfo.claudePrompt);
  };

  const handleSendToClaude = () => {
    if (onSendToClaude) {
      onSendToClaude(errorInfo.claudePrompt);
      onClose();
    }
  };

  return (
    <ModalFrame isOpen onClose={onClose} className="git-error-content" ariaLabel={errorInfo.title}>
      <div className="git-error-header">
        <div className="git-error-icon">
          <WarningIcon size={24} />
        </div>
        <h2>{errorInfo.title}</h2>
      </div>

      <div className="git-error-body">
        <p className="git-error-description">{errorInfo.description}</p>

        <div className="git-error-prompt-section">
          <div className="git-error-prompt-label">Ask Claude to help:</div>
          <div className="git-error-prompt">{errorInfo.claudePrompt}</div>
        </div>
      </div>

      <div className="git-error-footer">
        {errorType === 'merge_conflict' && onResolveConflicts ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<CopyIcon size={12} />}
              onClick={handleCopyPrompt}
            >
              Copy Prompt
            </Button>
            <Button variant="primary" size="sm" onClick={onResolveConflicts}>
              Resolve Conflicts
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<CopyIcon size={12} />}
              onClick={handleCopyPrompt}
            >
              Copy to Clipboard
            </Button>
            {onSendToClaude && (
              <Button variant="primary" size="sm" onClick={handleSendToClaude}>
                Send to Claude
              </Button>
            )}
          </>
        )}
      </div>
    </ModalFrame>
  );
}
