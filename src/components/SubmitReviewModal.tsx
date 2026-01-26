/**
 * Submit for Review modal.
 *
 * Creates a pull request from the current branch.
 *
 * @module components/SubmitReviewModal
 */

import { useState } from 'react';
import { createPullRequest } from '../lib/branches';

interface SubmitReviewModalProps {
  /** Project path for PR operations */
  projectPath: string;
  /** Branch to create PR from */
  branchName: string;
  /** Available base branches */
  baseBranches: string[];
  /** Callback when PR is created */
  onSuccess: (prUrl: string) => void;
  /** Callback to close modal */
  onClose: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function SubmitReviewModal({
  projectPath,
  branchName,
  baseBranches,
  onSuccess,
  onClose,
  onToast,
}: SubmitReviewModalProps) {
  const [title, setTitle] = useState(formatBranchAsTitle(branchName));
  const [description, setDescription] = useState('');
  const [baseBranch, setBaseBranch] = useState(baseBranches[0] || 'main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const prUrl = await createPullRequest(
        projectPath,
        title.trim(),
        description.trim() || null,
        baseBranch
      );
      onSuccess(prUrl);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      onToast?.('Failed to create pull request', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="submit-review-modal" onKeyDown={handleKeyDown} onClick={onClose}>
      <div className="submit-review-content" onClick={(e) => e.stopPropagation()}>
        <div className="submit-review-header">
          <h2>Submit for Review</h2>
        </div>

        <div className="submit-review-body">
          <div className="submit-review-field">
            <label className="submit-review-label">Branch</label>
            <div className="publish-branch-info">
              <span className="publish-branch-name">{branchName}</span>
            </div>
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Merging into</label>
            <select
              className="submit-review-input"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            >
              {baseBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Title</label>
            <input
              type="text"
              className="submit-review-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What did you change?"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="submit-review-field">
            <label className="submit-review-label">Description (optional)</label>
            <textarea
              className="submit-review-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any additional context..."
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          {error && <div className="submit-review-error">{error}</div>}
        </div>

        <div className="submit-review-footer">
          <button className="branch-selector-cancel" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="branch-selector-submit"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !title.trim()}
          >
            {isSubmitting ? 'Creating...' : 'Create Pull Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Convert a branch name to a human-readable title.
 * e.g., "julian/update-pricing-page" -> "Update pricing page"
 */
function formatBranchAsTitle(branchName: string): string {
  // Remove username prefix if present
  let name = branchName;
  if (name.includes('/')) {
    name = name.split('/').slice(1).join('/');
  }

  // Replace dashes/underscores with spaces and capitalize
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
