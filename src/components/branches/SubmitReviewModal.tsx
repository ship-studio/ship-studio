/**
 * Submit for Review modal.
 *
 * Creates a pull request from the current branch.
 * Supports AI-generated PR titles and descriptions via Claude CLI.
 *
 * @module components/SubmitReviewModal
 */

import { useState, useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  createPullRequest,
  mergePullRequest,
  switchBranch,
  deleteBranch,
} from '../../lib/branches';
import { generatePRDescription } from '../../lib/ai';
import { commitChanges } from '../../lib/git';
import { trackEvent, trackError } from '../../lib/analytics';
import { asCommandError, formatCommandError, isMergeConflictError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { GitHubIcon, WarningIcon } from '../icons';
import { useOptionalToast } from '../../contexts/ToastContext';

interface SubmitReviewModalProps {
  /** Project path for PR operations */
  projectPath: string;
  /** Branch to create PR from */
  branchName: string;
  /** Available base branches */
  baseBranches: string[];
  /** Whether the AI agent CLI is available for AI generation */
  aiAvailable: boolean;
  /** Callback when PR is created */
  onSuccess: (prUrl: string) => void;
  /** Callback when the local branch was switched (e.g. after merge cleanup) */
  onBranchSwitch?: (branchName: string) => void;
  /** Paste a prompt into the active agent terminal (e.g. to ask Claude to fix conflicts) */
  onSendToAgent?: (prompt: string) => void;
  /** Open the in-app conflict resolution UI for a head/base branch pair */
  onResolveConflicts?: (headBranch: string, baseBranch: string) => void;
  /** Callback to close modal */
  onClose: () => void;
}

type Phase = 'edit' | 'created' | 'conflict' | 'merged';

function parsePrNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Git branch names are constrained to a safe charset, but be defensive — the
 *  branch is interpolated into a prompt sent to an LLM agent so we don't want
 *  shell-style chars sneaking through and confusing the model. */
function sanitizeBranchName(name: string): string {
  return name.replace(/[`"'\\\n\r]/g, '');
}

function buildConflictPrompt(headBranch: string, baseBranch: string): string {
  const head = sanitizeBranchName(headBranch);
  const base = sanitizeBranchName(baseBranch);
  return `My pull request from "${head}" into "${base}" has merge conflicts. Please help me:
1. Check out "${head}" and pull the latest "${base}"
2. Identify which files have conflicts
3. Resolve the conflicts, prioritising the changes from "${head}" unless context suggests otherwise
4. Commit the resolution and push so the PR can be merged`;
}

export function SubmitReviewModal({
  projectPath,
  branchName,
  baseBranches,
  aiAvailable,
  onSuccess,
  onBranchSwitch,
  onSendToAgent,
  onResolveConflicts,
  onClose,
}: SubmitReviewModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [title, setTitle] = useState(formatBranchAsTitle(branchName));
  const [description, setDescription] = useState('');
  const [baseBranch, setBaseBranch] = useState(baseBranches[0] || 'main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [needsCommit, setNeedsCommit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedAiGeneration, setUsedAiGeneration] = useState(false);
  const [phase, setPhase] = useState<Phase>('edit');
  const [createdPr, setCreatedPr] = useState<{ url: string; number: number } | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  // Track modal open
  useEffect(() => {
    // Branch name omitted on purpose — see PublishBranchDropdown for rationale.
    void trackEvent('submit_review_opened', { $screen_name: 'Workspace' });
  }, [branchName]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setNeedsCommit(false);

    try {
      const result = await generatePRDescription(projectPath, baseBranch);
      setTitle(result.title);
      setDescription(result.description);
      setUsedAiGeneration(true);
      void trackEvent('ai_pr_description_generated', { $screen_name: 'Submit Review' });
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      if (message.includes('No changes found')) {
        setNeedsCommit(true);
      } else {
        trackError('ai_pr_generation', e, 'Submit Review');
        setError(`AI generation failed: ${message}`);
        onToast?.('Failed to generate PR description', 'error');
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCommitAndGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setNeedsCommit(false);

    try {
      const committed = await commitChanges(projectPath, 'Updates from Ship Studio');
      if (!committed) {
        setError('No changes to commit.');
        setIsGenerating(false);
        return;
      }

      const result = await generatePRDescription(projectPath, baseBranch);
      setTitle(result.title);
      setDescription(result.description);
      setUsedAiGeneration(true);
      void trackEvent('ai_pr_description_generated', {
        committed_first: true,
        $screen_name: 'Submit Review',
      });
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      trackError('ai_pr_commit_and_generate', e, 'Submit Review');
      setError(`Failed: ${message}`);
      onToast?.('Failed to generate PR description', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();

    try {
      const prUrl = await createPullRequest(
        projectPath,
        trimmedTitle,
        trimmedDescription || null,
        baseBranch
      );
      void trackEvent('pr_created', {
        base_branch: baseBranch,
        used_ai: usedAiGeneration,
        title_length: trimmedTitle.length,
        description_length: trimmedDescription.length,
        $screen_name: 'Workspace',
      });
      onSuccess(prUrl);
      const prNumber = parsePrNumberFromUrl(prUrl);
      if (prNumber !== null) {
        setCreatedPr({ url: prUrl, number: prNumber });
        setPhase('created');
      } else {
        logger.warn(
          '[SubmitReview] Created PR URL did not match /pull/<n>; skipping merge prompt',
          {
            url: prUrl,
          }
        );
        onToast?.('Pull request created (could not parse number for merge prompt)', 'success');
        onClose();
      }
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      trackError('pr_create', e, 'Submit Review');
      setError(message);
      onToast?.('Failed to create pull request', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMerge = async () => {
    if (!createdPr) return;
    setIsMerging(true);
    setError(null);
    try {
      await mergePullRequest(projectPath, createdPr.number);
      void trackEvent('pr_merged', {
        head_ref: branchName,
        base_ref: baseBranch,
        from_submit_modal: true,
        $screen_name: 'Submit Review',
      });
      onToast?.('Pull request merged', 'success');
      setPhase('merged');
    } catch (e) {
      trackError('pr_merge', e, 'Submit Review');
      if (isMergeConflictError(e)) {
        setPhase('conflict');
        setError(null);
      } else {
        const message = formatCommandError(asCommandError(e));
        setError(message);
        onToast?.(`Failed to merge: ${message}`, 'error');
      }
    } finally {
      setIsMerging(false);
    }
  };

  const handleAskAgentToResolve = () => {
    if (!onSendToAgent) return;
    onSendToAgent(buildConflictPrompt(branchName, baseBranch));
    void trackEvent('pr_conflict_sent_to_agent', {
      head_ref: branchName,
      base_ref: baseBranch,
      $screen_name: 'Submit Review',
    });
    onToast?.('Asked the agent to resolve conflicts', 'success');
    onClose();
  };

  const handleResolveMyself = () => {
    if (!onResolveConflicts) return;
    onResolveConflicts(branchName, baseBranch);
    void trackEvent('pr_conflict_resolve_in_app', {
      head_ref: branchName,
      base_ref: baseBranch,
      $screen_name: 'Submit Review',
    });
    onClose();
  };

  const handlePostMergeCleanup = async () => {
    setIsCleaningUp(true);
    setError(null);
    try {
      const result = await switchBranch(projectPath, baseBranch, true);
      if (!result.success) {
        const msg = result.error || 'Failed to switch branch';
        setError(msg);
        onToast?.(msg, 'error');
        return;
      }
      onBranchSwitch?.(baseBranch);
      await deleteBranch(projectPath, branchName, true);
      void trackEvent('post_merge_cleanup', {
        deleted_branch: branchName,
        $screen_name: 'Submit Review',
      });
      onToast?.(`Switched to ${baseBranch} and deleted ${branchName}`, 'success');
      onClose();
    } catch (e) {
      const message = formatCommandError(asCommandError(e));
      trackError('pr_post_merge_cleanup', e, 'Submit Review');
      setError(message);
      onToast?.(`Cleanup failed: ${message}`, 'error');
    } finally {
      setIsCleaningUp(false);
    }
  };

  const isBusy = isSubmitting || isGenerating || isMerging || isCleaningUp;

  if (phase === 'created' && createdPr) {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title="Pull request created"
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            Your pull request was created. Want to merge <strong>{branchName}</strong> into{' '}
            <strong>{baseBranch}</strong> now?
          </p>
          <a
            className="post-merge-link"
            href={createdPr.url}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(createdPr.url);
            }}
          >
            <GitHubIcon size={14} />
            View on GitHub
          </a>
          {error && <div className="submit-review-error">{error}</div>}
        </div>
        <div className="post-merge-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            Done
          </Button>
          <Button variant="primary" onClick={() => void handleMerge()} disabled={isBusy}>
            {isMerging ? 'Merging...' : `Merge into ${baseBranch}`}
          </Button>
        </div>
      </ModalFrame>
    );
  }

  if (phase === 'conflict') {
    const canAskAgent = !!onSendToAgent && aiAvailable;
    const canResolveInApp = !!onResolveConflicts;
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title={
          <div className="submit-review-title-row">
            <WarningIcon size={16} />
            <span>Merge conflicts</span>
          </div>
        }
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            <strong>{branchName}</strong> can't be cleanly merged into <strong>{baseBranch}</strong>{' '}
            — the base branch has changes that conflict with yours.
          </p>
          <p className="submit-review-conflict-question">
            {canAskAgent
              ? 'Want the agent to fix it, or would you rather resolve it yourself?'
              : 'You can resolve the conflicts in the visual editor.'}
          </p>
        </div>
        <div className="post-merge-footer">
          {canResolveInApp && (
            <Button variant="secondary" onClick={handleResolveMyself} disabled={isBusy}>
              Resolve myself
            </Button>
          )}
          {canAskAgent ? (
            <Button variant="primary" onClick={handleAskAgentToResolve} disabled={isBusy}>
              Ask agent to fix
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose} disabled={isBusy}>
              Done
            </Button>
          )}
        </div>
      </ModalFrame>
    );
  }

  if (phase === 'merged') {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        dismissable={!isBusy}
        title="Branch merged!"
        className="post-merge-content"
      >
        <div className="post-merge-body">
          <p>
            Would you like to switch to <strong>{baseBranch}</strong> and delete the{' '}
            <strong>{branchName}</strong> branch?
          </p>
          {error && <div className="submit-review-error">{error}</div>}
        </div>
        <div className="post-merge-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            No, thanks
          </Button>
          <Button variant="primary" onClick={() => void handlePostMergeCleanup()} disabled={isBusy}>
            {isCleaningUp ? 'Cleaning up...' : 'Yes, clean up'}
          </Button>
        </div>
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isBusy}
      className="submit-review-content"
      title={
        <div className="submit-review-title-row submit-review-title-row-spread">
          <span>Submit for Review</span>
          {aiAvailable && (
            <button
              className="submit-review-generate-btn"
              onClick={() => void handleGenerate()}
              disabled={isBusy}
              title="Generate title and description from your code changes using AI"
            >
              {isGenerating ? (
                <>
                  <Spinner size="sm" />
                  Generating with AI...
                </>
              ) : (
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.4V11h3a4 4 0 0 1 4 4v1a2 2 0 0 1-2 2h-1v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2H5a2 2 0 0 1-2-2v-1a4 4 0 0 1 4-4h3V9.4A4 4 0 0 1 8 6a4 4 0 0 1 4-4z" />
                  </svg>
                  Generate with AI
                </>
              )}
            </button>
          )}
        </div>
      }
    >
      <>
        <div className="submit-review-body">
          {needsCommit && (
            <div className="submit-review-commit-prompt">
              <p>Your changes need to be committed before AI can analyze them.</p>
              <button
                className="submit-review-commit-btn"
                onClick={() => void handleCommitAndGenerate()}
                disabled={isBusy}
              >
                {isGenerating ? (
                  <>
                    <Spinner size="sm" />
                    Committing & generating...
                  </>
                ) : (
                  'Commit & Generate'
                )}
              </button>
            </div>
          )}

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
              disabled={isBusy}
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
              disabled={isGenerating}
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
              disabled={isGenerating}
            />
          </div>

          {error && <div className="submit-review-error">{error}</div>}
        </div>

        <div className="submit-review-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={isBusy || !title.trim()}
          >
            {isSubmitting ? 'Creating...' : 'Create Pull Request'}
          </Button>
        </div>
      </>
    </ModalFrame>
  );
}

/**
 * Convert a branch name to a human-readable title.
 * e.g., "user/update-pricing-page" -> "Update pricing page"
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
