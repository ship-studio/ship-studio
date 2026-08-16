/**
 * Branches tab for workspace.
 *
 * Shows all branches organized by:
 * - Current branch (with Revert action)
 * - User's branches
 * - Team branches
 * - Main branches (main, staging)
 *
 * Also includes:
 * - Create new branch functionality
 * - Unsaved changes modal when switching with uncommitted changes
 *
 * @module components/BranchesTab
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BranchInfo,
  PullRequestInfo,
  switchBranch,
  deleteBranch,
  createBranch,
  discardChanges,
  formatRelativeTime,
  getBranchPrefixPreference,
  setBranchPrefixPreference,
  getDefaultBaseBranch,
  pushBranch,
  sanitizeBranchName,
} from '../../lib/branches';
import { gitPull } from '../../lib/git';
import {
  listWorktrees,
  removeWorktree,
  pruneWorktrees,
  type WorktreeInfo,
} from '../../lib/worktrees';
import { openProjectInNewWindow } from '../../lib/project';
import { BranchIcon, PlusIcon, TrashIcon, ExternalLinkIcon } from '../icons';
import { Spinner } from '../primitives/Spinner';
import { BranchGraph } from './BranchGraph';
import { UnsavedChangesModal } from './UnsavedChangesModal';
import { MergeConflictModal } from './MergeConflictModal';
import { getConflictInfo } from '../../lib/conflicts';
import { CreateBranchConflictModal } from './CreateBranchConflictModal';
import { trackEvent, trackError } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  asCommandError,
  formatCommandError,
  humanizeGitError,
  isRecognizedGitFailure,
} from '../../lib/errors';
import { logger } from '../../lib/logger';

/** A Tauri-rejected `CommandError` is an object — `String(err)` renders it as
 *  "[object Object]". Format it to the real human message (the git stderr). */
function errText(e: unknown): string {
  return formatCommandError(asCommandError(e));
}

/** True when a git operation failed because uncommitted changes would be
 *  clobbered by a checkout — git phrases this as "would be overwritten by
 *  checkout" / "commit your changes or stash them". */
function isUncommittedChangesError(e: unknown): boolean {
  return /overwritten by checkout|commit your changes or stash/i.test(errText(e));
}

/** True when git couldn't find the ref — the branch was deleted/renamed and the
 *  UI is showing a stale entry. `e` may be a caught error or a raw message. */
function isBranchGoneError(e: unknown): boolean {
  const text = typeof e === 'string' ? e : errText(e);
  return /did not match|pathspec|unknown revision or path/i.test(text);
}

/** Sanitize a branch name as the user types so it's always a valid git ref —
 *  the backend rejects spaces, `..`, and leading `-`, and git also forbids
 *  `~^:?*[\` and control chars. We convert whitespace to hyphens and strip the
 *  rest so "branch 1" becomes "branch-1" live, mirroring GitHub's own field. */
function sanitizeBranchInput(value: string): string {
  return (
    value
      .replace(/\s+/g, '-') // whitespace → hyphen
      // eslint-disable-next-line no-control-regex
      .replace(/[~^:?*[\]\\\x00-\x1f]/g, '') // illegal git ref characters
      .replace(/\.{2,}/g, '.') // git forbids ".." in ref names
      .replace(/^[-.]+/, '')
  ); // no leading "-" (rejected) or "."
}

interface BranchesTabProps {
  /** List of all branches */
  branches: BranchInfo[];
  /** Current branch name */
  currentBranch: string;
  /** Project path for branch operations */
  projectPath: string;
  /** GitHub username for grouping */
  githubUsername: string | null;
  /** Open pull requests for showing PR status on branches */
  openPRs: PullRequestInfo[];
  /** Callback when branch is switched */
  onBranchSwitch: (branchName: string) => void;
  /** Callback to open submit for review modal */
  onSubmitForReview: (branchName: string) => void;
  /** Callback to navigate to the PRs tab */
  onViewPR?: () => void;
  /** Callback to refresh branch list */
  onRefresh: () => void;
  /** Paste a prompt into the agent terminal (used to hand off a merge conflict). */
  onSendToAgent?: (prompt: string) => void;
  /** Current `git worktree list` for this repository (main worktree first). */
  worktrees?: WorktreeInfo[];
  /** Switch the workspace to a worktree's path (in-place, session stays hot). */
  onOpenWorktree?: (path: string) => void;
  /** Tear down a worktree's hot session (dev server, PTYs) before removal. */
  onCloseWorktreeSession?: (path: string) => void;
  /** Re-query the worktree list after add/remove/prune. */
  onWorktreesChanged?: () => void;
  /** Open the "New worktree" modal. */
  onCreateWorktree?: () => void;
}

export function BranchesTab({
  branches,
  currentBranch,
  projectPath,
  githubUsername,
  openPRs,
  onBranchSwitch,
  onSubmitForReview,
  onViewPR,
  onRefresh,
  onSendToAgent,
  worktrees = [],
  onOpenWorktree,
  onCloseWorktreeSession,
  onWorktreesChanged,
  onCreateWorktree,
}: BranchesTabProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [publishingBranch, setPublishingBranch] = useState<string | null>(null);
  // Branch awaiting the "Send to GitHub" confirm modal.
  const [sendToGitHubBranch, setSendToGitHubBranch] = useState<string | null>(null);
  const [branchToDelete, setBranchToDelete] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // Set when a switch is blocked by a paused merge: the branch the user tried to
  // switch to, the conflicted files, and the branch being merged in (from the
  // conflict markers) for the fix prompt.
  const [mergeConflict, setMergeConflict] = useState<{
    target: string;
    files: string[];
    source: string | null;
  } | null>(null);
  const [isReverting, setIsReverting] = useState(false);
  const [showRevertConfirm, setShowRevertConfirm] = useState(false);

  // New branch creation state
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [prefixUsername, setPrefixUsername] = useState(true);
  // The project's configured default base branch (e.g. "develop"); falls back to
  // the repo's default (main/master). Used as the default when cutting a branch.
  const [defaultBaseBranch, setDefaultBaseBranch] = useState<string | null>(null);
  // The base branch the new branch will be cut from (user-selectable).
  const [baseBranch, setBaseBranch] = useState<string>('');
  // What the typed name becomes after sanitization (e.g. "adjust h2" → "adjust-h2")
  const sanitizedNewBranchName = sanitizeBranchName(newBranchName);
  // Set when create fails because uncommitted changes would be overwritten by
  // the checkout — drives the commit-or-stash modal.
  const [createConflict, setCreateConflict] = useState<{
    targetBranch: string;
    baseBranch: string;
  } | null>(null);

  // Load prefix preference on mount
  useEffect(() => {
    void getBranchPrefixPreference(projectPath)
      .then(setPrefixUsername)
      .catch(() => {}); // Ignore errors, default to true
  }, [projectPath]);

  // Save prefix preference when changed
  const handlePrefixChange = (checked: boolean) => {
    setPrefixUsername(checked);
    void setBranchPrefixPreference(projectPath, checked).catch(() => {}); // Ignore errors
  };

  // Load the configured default base branch on mount.
  useEffect(() => {
    void getDefaultBaseBranch(projectPath)
      .then(setDefaultBaseBranch)
      .catch(() => {}); // Ignore errors, fall back to repo default below
  }, [projectPath]);

  // The base branch to default to when creating: configured default, else the
  // repo's default branch, else the first available branch.
  const effectiveDefaultBase = useMemo(
    () =>
      defaultBaseBranch || branches.find((b) => b.isDefault)?.name || branches[0]?.name || 'main',
    [defaultBaseBranch, branches]
  );

  // Selectable base branches (unique names), default/base ones first.
  const baseBranchOptions = useMemo(() => {
    const names = branches.map((b) => b.name);
    return Array.from(new Set(names)).sort((a, b) => {
      if (a === effectiveDefaultBase) return -1;
      if (b === effectiveDefaultBase) return 1;
      return 0;
    });
  }, [branches, effectiveDefaultBase]);

  // Open the new-branch form, defaulting the base to the effective default.
  const openNewBranchForm = () => {
    setBaseBranch(effectiveDefaultBase);
    setShowNewBranch(true);
  };

  // Group branches (memoized to avoid re-filtering on every render)
  const currentBranchInfo = useMemo(() => branches.find((b) => b.isCurrent), [branches]);
  const userBranches = useMemo(
    () =>
      githubUsername
        ? branches.filter(
            (b) =>
              !b.isCurrent &&
              !b.isDefault &&
              b.name !== 'staging' &&
              b.name.startsWith(`${githubUsername}/`)
          )
        : [],
    [branches, githubUsername]
  );
  const teamBranches = useMemo(
    () =>
      branches.filter(
        (b) => !b.isCurrent && !b.isDefault && b.name !== 'staging' && !userBranches.includes(b)
      ),
    [branches, userBranches]
  );
  const mainBranches = useMemo(
    () => branches.filter((b) => !b.isCurrent && (b.isDefault || b.name === 'staging')),
    [branches]
  );

  const handleSwitch = async (branchName: string) => {
    // Git refuses to check out a branch that's already checked out in another
    // worktree — the faithful move is to go where the branch already lives.
    const homeWorktree = worktrees.find((w) => !w.isCurrent && w.branch === branchName);
    if (homeWorktree && onOpenWorktree) {
      onToast?.(`${branchName} is checked out in a worktree — opening it`, 'success');
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
        onToast?.(
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
            onToast?.(`${branchName} is checked out in a worktree — opening it`, 'success');
            void trackEvent('worktree_switched', { via: 'branch_switch_redirect' });
            onOpenWorktree(home.path);
            return;
          }
        }
        // Recognized, by-design refusals ride the info channel — an 'error'
        // toast would re-report a failure the backend already classified
        // Expected (issue #690, same pattern as useBranchManagement).
        onToast?.(
          humanizeGitError(raw, { branch: branchName }),
          isRecognizedGitFailure(raw, { branch: branchName }) ? 'info' : 'error'
        );
        // The branch is gone (deleted/renamed elsewhere) but still showing in a
        // stale list — refresh to drop the phantom entry.
        if (isBranchGoneError(raw)) onRefresh();
      }
    } catch (e) {
      trackError('branch_switch', e, 'Workspace');
      onToast?.(
        humanizeGitError(e, { branch: branchName }),
        isRecognizedGitFailure(e, { branch: branchName }) ? 'info' : 'error'
      );
      if (isBranchGoneError(errText(e))) onRefresh();
    } finally {
      setSwitchingBranch(null);
    }
  };

  // ---- Worktrees (git worktree remove / prune) ----
  const [worktreeToRemove, setWorktreeToRemove] = useState<WorktreeInfo | null>(null);
  const [isRemovingWorktree, setIsRemovingWorktree] = useState(false);
  const [worktreeRemoveError, setWorktreeRemoveError] = useState<string | null>(null);
  const [isPruningWorktrees, setIsPruningWorktrees] = useState(false);

  /** Git refuses to remove a dirty worktree without `--force` — detect its
   *  phrasing so the confirm modal can escalate to a Force Remove button. */
  const isDirtyWorktreeError = (e: unknown): boolean => {
    const text = typeof e === 'string' ? e : errText(e);
    return /contains modified or untracked files|use --force/i.test(text);
  };

  // Anchor mutation commands at the main worktree: removing the worktree the
  // command's cwd sits inside would fail (or leave a dangling cwd).
  const mainWorktreePath = worktrees.find((w) => w.isMain)?.path ?? projectPath;

  const handleRemoveWorktree = async (force: boolean) => {
    if (!worktreeToRemove) return;
    const wt = worktreeToRemove;
    setIsRemovingWorktree(true);
    setWorktreeRemoveError(null);
    try {
      // Removing the worktree we're standing in: move the workspace to the
      // main worktree first so the teardown below runs on a background path.
      if (wt.isCurrent && onOpenWorktree) {
        onOpenWorktree(mainWorktreePath);
      }
      // Stop its dev server / PTYs and drop the session before the folder goes.
      onCloseWorktreeSession?.(wt.path);
      await removeWorktree(mainWorktreePath, wt.path, force);
      void trackEvent('worktree_removed', { forced: force });
      onToast?.(
        wt.branch ? `Removed worktree — branch ${wt.branch} is kept` : 'Removed worktree',
        'success'
      );
      setWorktreeToRemove(null);
      onWorktreesChanged?.();
    } catch (e) {
      trackError('worktree_remove', e, 'Workspace');
      setWorktreeRemoveError(errText(e));
    } finally {
      setIsRemovingWorktree(false);
    }
  };

  const handlePruneWorktrees = async () => {
    setIsPruningWorktrees(true);
    try {
      await pruneWorktrees(mainWorktreePath);
      void trackEvent('worktree_pruned', { $screen_name: 'Workspace' });
      onToast?.('Cleared stale worktree entries', 'success');
      onWorktreesChanged?.();
    } catch (e) {
      trackError('worktree_prune', e, 'Workspace');
      onToast?.(errText(e), 'error');
    } finally {
      setIsPruningWorktrees(false);
    }
  };

  const handleSendToGitHub = async (branchName: string) => {
    setPublishingBranch(branchName);
    try {
      await pushBranch(projectPath, branchName);
      void trackEvent('branch_published', { $screen_name: 'Workspace' });
      onToast?.(`Sent ${branchName} to GitHub`, 'success');
      setSendToGitHubBranch(null);
      onRefresh();
    } catch (e) {
      trackError('branch_publish', e, 'Workspace');
      onToast?.(
        humanizeGitError(e, { branch: branchName }),
        isRecognizedGitFailure(e, { branch: branchName }) ? 'info' : 'error'
      );
      // Same recovery as handleSwitch: the ref is gone but a stale entry is
      // still listed — refresh to drop the phantom (issue #334).
      if (isBranchGoneError(e)) onRefresh();
    } finally {
      setPublishingBranch(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!branchToDelete) return;

    const branchName = branchToDelete;
    setDeletingBranch(branchName);

    try {
      await deleteBranch(projectPath, branchName, true);
      void trackEvent('branch_deleted', { $screen_name: 'Workspace' });
      onToast?.(`Deleted ${branchName}`, 'success');
      onRefresh();
    } catch (e) {
      trackError('branch_delete', e, 'Workspace');
      onToast?.(
        humanizeGitError(e, { branch: branchName }),
        isRecognizedGitFailure(e, { branch: branchName }) ? 'info' : 'error'
      );
      if (isBranchGoneError(e)) onRefresh();
    } finally {
      setDeletingBranch(null);
      setBranchToDelete(null);
    }
  };

  const handleRevertToGitHub = async () => {
    setIsReverting(true);
    setShowRevertConfirm(false);
    try {
      // Discard all local changes
      await discardChanges(projectPath);

      // Pull latest from remote
      await gitPull(projectPath);

      onToast?.(`Reverted to GitHub version`, 'success');
      onRefresh();
    } catch (e) {
      trackError('branch_revert', e, 'Workspace');
      if (/no tracking information/i.test(errText(e))) {
        // Expected: the branch has never been pushed, so there's no GitHub
        // version to pull — git's normal refusal, not an app malfunction
        // (the backend classifies it Expected too). The discard above already
        // ran, so local edits ARE gone — say so honestly. Info toast + warn
        // log, never the error channels that auto-file bug reports (#539).
        logger.warn('[BranchesTab] Revert pull skipped: branch has no upstream', {
          error: errText(e),
        });
        onToast?.(
          `Your local changes were discarded, but ${currentBranch} has never been pushed to GitHub, so there was no GitHub version to pull. Send the branch to GitHub first if you want a copy to revert to next time.`,
          'info'
        );
        onRefresh();
      } else {
        onToast?.(`Failed to revert: ${humanizeGitError(e, { branch: currentBranch })}`, 'error');
      }
    } finally {
      setIsReverting(false);
    }
  };

  const handleCreateBranch = async () => {
    // Sanitize instead of rejecting: "adjust h2" becomes "adjust-h2"
    let branchName = sanitizeBranchName(newBranchName);
    if (!branchName) return;

    setIsCreatingBranch(true);
    try {
      // Prefix with username if checkbox is checked
      if (prefixUsername && githubUsername) {
        branchName = `${githubUsername}/${branchName}`;
      }

      // Create from the user-selected base branch (defaults to the project's
      // configured default base, else the repo default).
      const fromBranch = baseBranch || effectiveDefaultBase;
      try {
        await createBranch(projectPath, branchName, fromBranch);
      } catch (e) {
        // Uncommitted changes would be overwritten by the checkout, so hand off
        // to the commit-or-stash modal instead of failing with a raw git error.
        if (isUncommittedChangesError(e)) {
          setCreateConflict({ targetBranch: branchName, baseBranch: fromBranch });
          setShowNewBranch(false);
          return;
        }
        throw e;
      }
      void trackEvent('branch_created', { from_branch: fromBranch, $screen_name: 'Workspace' });

      // Switch to the new branch
      const result = await switchBranch(projectPath, branchName, false);
      if (result.success) {
        onBranchSwitch(branchName);
        onToast?.(`Created and switched to ${branchName}`, 'success');
      }

      setNewBranchName('');
      setShowNewBranch(false);
      onRefresh();
    } catch (e) {
      trackError('branch_create', e, 'Workspace');
      onToast?.(humanizeGitError(e), isRecognizedGitFailure(e) ? 'info' : 'error');
      // e.g. the chosen base branch was deleted elsewhere — refresh the list.
      if (isBranchGoneError(e)) onRefresh();
    } finally {
      setIsCreatingBranch(false);
    }
  };

  return (
    <div className="branches-tab">
      {/* Current Branch */}
      {currentBranchInfo && (
        <div className="branches-tab-section">
          <div className="branches-tab-section-header">Current Branch</div>
          <div className="branch-card current">
            <div className="branch-card-info">
              <div className="branch-card-name">
                <BranchIcon size={14} />
                <span className="branch-card-name-text" title={currentBranchInfo.name}>
                  {currentBranchInfo.name}
                </span>
                {currentBranchInfo.isDefault && <span className="branch-live-badge">Live</span>}
                <span
                  className={`branch-sync-badge ${currentBranchInfo.pushed ? 'synced' : 'local'}`}
                  title={
                    currentBranchInfo.pushed
                      ? 'This branch exists on GitHub'
                      : 'This branch is only on your machine. Send it to GitHub to put it there.'
                  }
                >
                  {currentBranchInfo.pushed ? 'On GitHub' : 'Local only'}
                </span>
                <span className="branch-card-current-label">you are here</span>
              </div>
              <div className="branch-card-meta">
                {formatRelativeTime(currentBranchInfo.lastCommitDate)}
                {(currentBranchInfo.isDefault || currentBranchInfo.aheadOfMain > 0) &&
                  currentBranchInfo.lastCommitAuthor &&
                  ` · ${currentBranchInfo.lastCommitAuthor}`}
              </div>
            </div>
            <div className="branch-card-actions">
              {!currentBranchInfo.isDefault &&
                currentBranchInfo.name !== 'staging' &&
                (() => {
                  const existingPR = openPRs.find((pr) => pr.headRef === currentBranchInfo.name);
                  return existingPR ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onViewPR?.()}
                      title={`PR #${existingPR.number}: ${existingPR.title}`}
                    >
                      View PR #{existingPR.number}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => onSubmitForReview(currentBranchInfo.name)}
                    >
                      Submit for Review
                    </Button>
                  );
                })()}
              {!currentBranchInfo.pushed && !currentBranchInfo.isDefault && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSendToGitHubBranch(currentBranchInfo.name)}
                  disabled={publishingBranch === currentBranchInfo.name}
                  title="Push this branch to GitHub (no pull request)"
                >
                  Send to GitHub
                </Button>
              )}
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowRevertConfirm(true)}
                disabled={isReverting}
                title="Discard local changes and pull from GitHub"
              >
                {isReverting ? 'Reverting...' : 'Revert to GitHub'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New Branch */}
      <div className="branches-tab-section">
        {!showNewBranch ? (
          <button className="branches-new-branch-btn" onClick={openNewBranchForm}>
            <PlusIcon size={14} />
            New Branch
          </button>
        ) : (
          <div className="branches-new-branch-form">
            <div className="branches-new-branch-input-wrapper">
              {prefixUsername && githubUsername && (
                <span className="branches-new-branch-prefix">{githubUsername}/</span>
              )}
              <input
                type="text"
                className="branches-new-branch-input"
                placeholder="branch-name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(sanitizeBranchInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateBranch();
                  if (e.key === 'Escape') {
                    setShowNewBranch(false);
                    setNewBranchName('');
                  }
                }}
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            {sanitizedNewBranchName && sanitizedNewBranchName !== newBranchName.trim() && (
              <div className="branches-new-branch-hint">
                will be created as:{' '}
                <span className="branches-new-branch-hint-name">
                  {prefixUsername && githubUsername ? `${githubUsername}/` : ''}
                  {sanitizedNewBranchName}
                </span>
              </div>
            )}
            {baseBranchOptions.length > 0 && (
              <label className="branches-new-branch-base">
                <span className="branches-new-branch-base-label">Branch from</span>
                <select
                  className="branches-new-branch-base-select"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                >
                  {baseBranchOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                      {name === effectiveDefaultBase ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="branches-new-branch-footer">
              {githubUsername && (
                <label className="branches-new-branch-checkbox">
                  <input
                    type="checkbox"
                    checked={prefixUsername}
                    onChange={(e) => handlePrefixChange(e.target.checked)}
                  />
                  <span>Add {githubUsername}/</span>
                </label>
              )}
              <div className="branches-new-branch-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShowNewBranch(false);
                    setNewBranchName('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreateBranch()}
                  disabled={!sanitizedNewBranchName || isCreatingBranch}
                >
                  {isCreatingBranch ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* User's Branches */}
      {userBranches.length > 0 && (
        <div className="branches-tab-section">
          <div className="branches-tab-section-header">Your Branches</div>
          {userBranches.map((branch) => (
            <BranchCard
              key={branch.name}
              branch={branch}
              isCurrent={false}
              onSwitch={() => void handleSwitch(branch.name)}
              onDelete={() => setBranchToDelete(branch.name)}
              onSubmitForReview={() => onSubmitForReview(branch.name)}
              onPublish={() => setSendToGitHubBranch(branch.name)}
              isSwitching={switchingBranch === branch.name}
              isDeleting={deletingBranch === branch.name}
              isPublishing={publishingBranch === branch.name}
              showDelete={true}
              showSubmitForReview={false}
            />
          ))}
        </div>
      )}

      {/* Team Branches */}
      {teamBranches.length > 0 && (
        <div className="branches-tab-section">
          <div className="branches-tab-section-header">Team Branches</div>
          {teamBranches.map((branch) => (
            <BranchCard
              key={branch.name}
              branch={branch}
              isCurrent={false}
              onSwitch={() => void handleSwitch(branch.name)}
              onDelete={() => {}}
              onSubmitForReview={() => {}}
              onPublish={() => setSendToGitHubBranch(branch.name)}
              isSwitching={switchingBranch === branch.name}
              isDeleting={false}
              isPublishing={publishingBranch === branch.name}
              showDelete={false}
              showSubmitForReview={false}
            />
          ))}
        </div>
      )}

      {/* Main Branches */}
      {mainBranches.length > 0 && (
        <div className="branches-tab-section">
          <div className="branches-tab-section-header">Main Branches</div>
          {mainBranches.map((branch) => (
            <BranchCard
              key={branch.name}
              branch={branch}
              isCurrent={false}
              onSwitch={() => void handleSwitch(branch.name)}
              onDelete={() => {}}
              onSubmitForReview={() => {}}
              onPublish={() => setSendToGitHubBranch(branch.name)}
              isSwitching={switchingBranch === branch.name}
              isDeleting={false}
              isPublishing={publishingBranch === branch.name}
              showDelete={false}
              showSubmitForReview={false}
            />
          ))}
        </div>
      )}

      {/* Worktrees — parallel working folders of this repo (`git worktree`).
          Shown whenever the repo has worktree data, so the feature is
          discoverable even with only the main worktree. */}
      {worktrees.length > 0 && (
        <div className="branches-tab-section">
          <div className="branches-tab-section-header worktrees-section-header">
            <span>Worktrees</span>
            <div className="worktrees-section-actions">
              {worktrees.some((w) => w.prunable !== null) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handlePruneWorktrees()}
                  disabled={isPruningWorktrees}
                  title="git worktree prune — clears entries whose folders are gone"
                >
                  {isPruningWorktrees ? 'Pruning…' : 'Prune stale'}
                </Button>
              )}
              {onCreateWorktree && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<PlusIcon size={12} />}
                  onClick={onCreateWorktree}
                >
                  New worktree
                </Button>
              )}
            </div>
          </div>
          {worktrees.map((wt) => (
            <div key={wt.path} className={`worktree-row ${wt.isCurrent ? 'is-current' : ''}`}>
              <div className="worktree-row-info">
                <div className="worktree-row-title">
                  <BranchIcon size={12} />
                  <span className="worktree-row-branch">
                    {wt.branch ?? `detached @ ${wt.head}`}
                  </span>
                  {wt.isMain && <span className="worktree-chip">main worktree</span>}
                  {wt.isCurrent && (
                    <span className="worktree-chip is-current-chip">you are here</span>
                  )}
                  {wt.locked !== null && <span className="worktree-chip">locked</span>}
                  {wt.prunable !== null && (
                    <span className="worktree-chip is-prunable-chip">stale</span>
                  )}
                </div>
                <div className="worktree-row-path" title={wt.path}>
                  {wt.path}
                </div>
              </div>
              <div className="worktree-row-actions">
                {!wt.isCurrent && onOpenWorktree && wt.prunable === null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void trackEvent('worktree_switched', { via: 'branches_tab' });
                      onOpenWorktree(wt.path);
                    }}
                  >
                    Open
                  </Button>
                )}
                {wt.prunable === null && (
                  <button
                    type="button"
                    className="worktree-row-icon-btn"
                    onClick={() => void openProjectInNewWindow(wt.path, wt.branch ?? 'worktree')}
                    title="Open in new window"
                    aria-label="Open worktree in new window"
                  >
                    <ExternalLinkIcon size={12} />
                  </button>
                )}
                {!wt.isMain && (
                  <button
                    type="button"
                    className="worktree-row-icon-btn is-danger"
                    onClick={() => {
                      setWorktreeRemoveError(null);
                      setWorktreeToRemove(wt);
                    }}
                    title="Remove worktree (git worktree remove)"
                    aria-label={`Remove worktree ${wt.branch ?? wt.path}`}
                  >
                    <TrashIcon size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Branch graph — collapsed by default; building it shells out to git
          per branch, so it only loads when someone opens it. */}
      {branches.length > 0 && (
        <div className="branches-tab-section">
          <BranchGraph
            projectPath={projectPath}
            branches={branches}
            currentBranch={currentBranch}
            openPRs={openPRs}
            onSelectBranch={(name) => void handleSwitch(name)}
            onRefresh={onRefresh}
          />
        </div>
      )}

      {/* Delete confirmation modal */}
      {branchToDelete && (
        <ModalFrame
          isOpen
          onClose={() => setBranchToDelete(null)}
          dismissable={!deletingBranch}
          title="Delete Branch?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              Are you sure you want to delete <strong>{branchToDelete}</strong>? This action cannot
              be undone.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setBranchToDelete(null)}
              disabled={!!deletingBranch}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDeleteConfirm()}
              disabled={!!deletingBranch}
            >
              {deletingBranch ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Remove-worktree confirm. Mirrors git: the folder goes, the branch stays.
          A dirty tree makes git refuse — the error escalates the button to Force. */}
      {worktreeToRemove && (
        <ModalFrame
          isOpen
          onClose={() => {
            setWorktreeToRemove(null);
            setWorktreeRemoveError(null);
          }}
          dismissable={!isRemovingWorktree}
          title="Remove Worktree?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This deletes the folder <strong>{worktreeToRemove.path}</strong>
              {worktreeToRemove.branch && (
                <>
                  {' '}
                  where <strong>{worktreeToRemove.branch}</strong> is checked out
                </>
              )}
              .
            </p>
            <p>
              The branch itself is <strong>kept</strong> — only the working folder goes away, same
              as <code>git worktree remove</code>.
            </p>
            {worktreeRemoveError && (
              <div className="worktree-remove-error">
                <p>{worktreeRemoveError}</p>
                {isDirtyWorktreeError(worktreeRemoveError) && (
                  <p>
                    <strong>The worktree has uncommitted changes.</strong> Force-removing discards
                    them permanently.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => {
                setWorktreeToRemove(null);
                setWorktreeRemoveError(null);
              }}
              disabled={isRemovingWorktree}
            >
              Cancel
            </Button>
            {worktreeRemoveError && isDirtyWorktreeError(worktreeRemoveError) ? (
              <Button
                variant="danger"
                onClick={() => void handleRemoveWorktree(true)}
                disabled={isRemovingWorktree}
              >
                {isRemovingWorktree ? 'Removing...' : 'Force Remove'}
              </Button>
            ) : (
              <Button
                variant="danger"
                onClick={() => void handleRemoveWorktree(false)}
                disabled={isRemovingWorktree}
              >
                {isRemovingWorktree ? 'Removing...' : 'Remove'}
              </Button>
            )}
          </div>
        </ModalFrame>
      )}

      {/* Send-to-GitHub confirm — plain-English "here's what happens" */}
      {sendToGitHubBranch && (
        <ModalFrame
          isOpen
          onClose={() => setSendToGitHubBranch(null)}
          dismissable={!publishingBranch}
          title="Send to GitHub?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This puts <strong>{sendToGitHubBranch}</strong> on GitHub so it's saved there and your
              teammates can see it.
            </p>
            <p>
              It <strong>won't</strong> open a pull request or merge anything. It just uploads the
              branch. When you're ready for someone to review and merge it, use{' '}
              <strong>Submit for Review</strong>.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setSendToGitHubBranch(null)}
              disabled={!!publishingBranch}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSendToGitHub(sendToGitHubBranch)}
              disabled={!!publishingBranch}
            >
              {publishingBranch ? 'Sending...' : 'Send to GitHub'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Revert confirmation modal */}
      {showRevertConfirm && (
        <ModalFrame
          isOpen
          onClose={() => setShowRevertConfirm(false)}
          dismissable={!isReverting}
          title="Revert to GitHub?"
          className="post-merge-content"
        >
          <div className="post-merge-body">
            <p>
              This will discard all local changes on <strong>{currentBranch}</strong> and pull the
              latest version from GitHub. This action cannot be undone.
            </p>
          </div>
          <div className="post-merge-footer">
            <Button
              variant="secondary"
              onClick={() => setShowRevertConfirm(false)}
              disabled={isReverting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleRevertToGitHub()}
              disabled={isReverting}
            >
              {isReverting ? 'Reverting...' : 'Revert'}
            </Button>
          </div>
        </ModalFrame>
      )}

      {/* Unsaved changes modal */}
      {pendingSwitch && (
        <UnsavedChangesModal
          currentBranch={currentBranch}
          targetBranch={pendingSwitch}
          projectPath={projectPath}
          onSwitchComplete={(branchName) => {
            onBranchSwitch(branchName);
            setPendingSwitch(null);
          }}
          onClose={() => setPendingSwitch(null)}
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
            setMergeConflict(null);
            onRefresh();
          }}
          onClose={() => setMergeConflict(null)}
        />
      )}

      {createConflict && (
        <CreateBranchConflictModal
          projectPath={projectPath}
          currentBranch={currentBranch}
          targetBranch={createConflict.targetBranch}
          baseBranch={createConflict.baseBranch}
          onCreated={(branchName) => {
            onBranchSwitch(branchName);
            void trackEvent('branch_created', {
              from_branch: createConflict.baseBranch,
              $screen_name: 'Workspace',
            });
            setCreateConflict(null);
            setNewBranchName('');
            onRefresh();
          }}
          onClose={() => setCreateConflict(null)}
        />
      )}
    </div>
  );
}

interface BranchCardProps {
  branch: BranchInfo;
  isCurrent: boolean;
  onSwitch: () => void;
  onDelete: () => void;
  onSubmitForReview: () => void;
  onPublish: () => void;
  isSwitching: boolean;
  isDeleting: boolean;
  isPublishing: boolean;
  showDelete?: boolean;
  showSubmitForReview?: boolean;
}

function BranchCard({
  branch,
  isCurrent,
  onSwitch,
  onDelete,
  onSubmitForReview,
  onPublish,
  isSwitching,
  isDeleting,
  isPublishing,
  showDelete = false,
  showSubmitForReview = false,
}: BranchCardProps) {
  // Non-current cards act as a big "switch to this branch" button.
  const cardIsClickable = !isCurrent && !isSwitching;
  return (
    <div
      className={`branch-card ${isCurrent ? 'current' : ''}${cardIsClickable ? ' clickable' : ''}`}
      onClick={cardIsClickable ? onSwitch : undefined}
      role={cardIsClickable ? 'button' : undefined}
      tabIndex={cardIsClickable ? 0 : undefined}
      title={!isCurrent ? `Switch to ${branch.name}` : undefined}
      onKeyDown={
        cardIsClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSwitch();
              }
            }
          : undefined
      }
    >
      <div className="branch-card-info">
        <div className="branch-card-name">
          <BranchIcon size={14} />
          <span className="branch-card-name-text" title={branch.name}>
            {branch.name}
          </span>
          {branch.isDefault && <span className="branch-live-badge">Live</span>}
          {/* Stupid-simple sync state: is this branch on GitHub yet, or not? */}
          <span
            className={`branch-sync-badge ${branch.pushed ? 'synced' : 'local'}`}
            title={
              branch.pushed
                ? 'This branch exists on GitHub'
                : 'This branch is only on your machine. Send it to GitHub to put it there.'
            }
          >
            {branch.pushed ? 'On GitHub' : 'Local only'}
          </span>
          {isCurrent && <span className="branch-card-current-label">you are here</span>}
        </div>
        <div className="branch-card-meta">
          {formatRelativeTime(branch.lastCommitDate)}
          {(branch.isDefault || branch.aheadOfMain > 0) &&
            branch.lastCommitAuthor &&
            ` · ${branch.lastCommitAuthor}`}
        </div>
        {!branch.isDefault && (branch.aheadOfMain > 0 || branch.behindOfMain > 0) && (
          <div className="branch-card-status">
            {branch.aheadOfMain > 0 && (
              <span className="branch-card-badge ahead">{branch.aheadOfMain} ahead</span>
            )}
            {branch.behindOfMain > 0 && (
              <span className="branch-card-badge behind">{branch.behindOfMain} behind</span>
            )}
          </div>
        )}
      </div>

      <div className="branch-card-actions" onClick={(e) => e.stopPropagation()}>
        {isSwitching && <Spinner size="sm" />}
        {isCurrent && showSubmitForReview && (
          <Button variant="primary" size="sm" onClick={onSubmitForReview}>
            Submit for Review
          </Button>
        )}
        {!branch.pushed && !branch.isDefault && (
          <Button variant="secondary" size="sm" onClick={onPublish} disabled={isPublishing}>
            Send to GitHub
          </Button>
        )}
        {showDelete && (
          <button
            type="button"
            className="branch-card-delete-btn"
            onClick={onDelete}
            disabled={isDeleting}
            title={`Delete ${branch.name}`}
            aria-label={`Delete branch ${branch.name}`}
          >
            {isDeleting ? <Spinner size="sm" /> : <TrashIcon size={15} />}
          </button>
        )}
      </div>
    </div>
  );
}
