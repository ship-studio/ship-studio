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
} from '../../lib/branches';
import { gitPull } from '../../lib/git';
import { BranchIcon, PlusIcon } from '../icons';
import { UnsavedChangesModal } from './UnsavedChangesModal';
import { trackEvent, trackError } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';

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
}: BranchesTabProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [branchToDelete, setBranchToDelete] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [isReverting, setIsReverting] = useState(false);
  const [showRevertConfirm, setShowRevertConfirm] = useState(false);

  // New branch creation state
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [prefixUsername, setPrefixUsername] = useState(true);

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
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      trackError('branch_switch', e, 'Workspace');
      onToast?.(`Failed to switch: ${String(e)}`, 'error');
    } finally {
      setSwitchingBranch(null);
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
      onToast?.(`Failed to delete: ${String(e)}`, 'error');
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
      onToast?.(`Failed to revert: ${String(e)}`, 'error');
    } finally {
      setIsReverting(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;

    setIsCreatingBranch(true);
    try {
      // Prefix with username if checkbox is checked
      let branchName = newBranchName.trim();
      if (prefixUsername && githubUsername) {
        branchName = `${githubUsername}/${branchName}`;
      }

      // Create from main by default
      const baseBranch = branches.find((b) => b.isDefault)?.name || 'main';
      await createBranch(projectPath, branchName, baseBranch);
      void trackEvent('branch_created', { from_branch: baseBranch, $screen_name: 'Workspace' });

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
      onToast?.(`Failed to create branch: ${String(e)}`, 'error');
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
          <button className="branches-new-branch-btn" onClick={() => setShowNewBranch(true)}>
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
                onChange={(e) => setNewBranchName(e.target.value)}
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
                  disabled={!newBranchName.trim() || isCreatingBranch}
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
              isSwitching={switchingBranch === branch.name}
              isDeleting={deletingBranch === branch.name}
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
              isSwitching={switchingBranch === branch.name}
              isDeleting={false}
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
              isSwitching={switchingBranch === branch.name}
              isDeleting={false}
              showDelete={false}
              showSubmitForReview={false}
            />
          ))}
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
    </div>
  );
}

interface BranchCardProps {
  branch: BranchInfo;
  isCurrent: boolean;
  onSwitch: () => void;
  onDelete: () => void;
  onSubmitForReview: () => void;
  isSwitching: boolean;
  isDeleting: boolean;
  showDelete?: boolean;
  showSubmitForReview?: boolean;
}

function BranchCard({
  branch,
  isCurrent,
  onSwitch,
  onDelete,
  onSubmitForReview,
  isSwitching,
  isDeleting,
  showDelete = false,
  showSubmitForReview = false,
}: BranchCardProps) {
  return (
    <div className={`branch-card ${isCurrent ? 'current' : ''}`}>
      <div className="branch-card-info">
        <div className="branch-card-name">
          <BranchIcon size={14} />
          <span className="branch-card-name-text" title={branch.name}>
            {branch.name}
          </span>
          {branch.isDefault && <span className="branch-live-badge">Live</span>}
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

      <div className="branch-card-actions">
        {isCurrent && showSubmitForReview && (
          <Button variant="primary" size="sm" onClick={onSubmitForReview}>
            Submit for Review
          </Button>
        )}
        {!isCurrent && (
          <Button variant="secondary" size="sm" onClick={onSwitch} disabled={isSwitching}>
            {isSwitching ? 'Switching...' : 'Switch'}
          </Button>
        )}
        {showDelete && (
          <Button variant="danger" size="sm" onClick={onDelete} disabled={isDeleting}>
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        )}
      </div>
    </div>
  );
}
