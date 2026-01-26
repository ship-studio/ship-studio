/**
 * Git error handler modal.
 *
 * Shows helpful error messages when git operations fail,
 * with suggested Claude prompts to help resolve issues.
 *
 * @module components/GitErrorHandler
 */

import { WarningIcon, CopyIcon } from './icons';

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
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
  /** Callback to open conflict resolution UI (only for merge_conflict type) */
  onResolveConflicts?: () => void;
}

export function GitErrorHandler({
  errorType,
  errorMessage,
  branchName,
  onClose,
  onSendToClaude,
  onToast,
  onResolveConflicts,
}: GitErrorHandlerProps) {
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

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(errorInfo.claudePrompt).then(
      () => onToast?.('Prompt copied to clipboard', 'success'),
      () => onToast?.('Failed to copy to clipboard', 'error')
    );
  };

  const handleSendToClaude = () => {
    if (onSendToClaude) {
      onSendToClaude(errorInfo.claudePrompt);
      onClose();
    }
  };

  return (
    <div className="git-error-modal" onClick={onClose}>
      <div className="git-error-content" onClick={(e) => e.stopPropagation()}>
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
              <button className="branch-card-action" onClick={handleCopyPrompt}>
                <CopyIcon size={12} />
                Copy Prompt
              </button>
              <button className="branch-card-action primary" onClick={onResolveConflicts}>
                Resolve Conflicts
              </button>
            </>
          ) : (
            <>
              <button className="branch-card-action" onClick={handleCopyPrompt}>
                <CopyIcon size={12} />
                Copy to Clipboard
              </button>
              {onSendToClaude && (
                <button className="branch-card-action primary" onClick={handleSendToClaude}>
                  Send to Claude
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
