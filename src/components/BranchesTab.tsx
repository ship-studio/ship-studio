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

import { useState, useEffect } from 'react';
import {
  BranchInfo,
  switchBranch,
  deleteBranch,
  createBranch,
  discardChanges,
  formatRelativeTime,
} from '../lib/branches';
import { invoke } from '@tauri-apps/api/core';
import { BranchIcon, PlusIcon } from './icons';
import { UnsavedChangesModal } from './UnsavedChangesModal';

interface BranchesTabProps {
  /** List of all branches */
  branches: BranchInfo[];
  /** Current branch name */
  currentBranch: string;
  /** Project path for branch operations */
  projectPath: string;
  /** GitHub username for grouping */
  githubUsername: string | null;
  /** Callback when branch is switched */
  onBranchSwitch: (branchName: string) => void;
  /** Callback to open submit for review modal */
  onSubmitForReview: (branchName: string) => void;
  /** Callback to refresh branch list */
  onRefresh: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function BranchesTab({
  branches,
  currentBranch,
  projectPath,
  githubUsername,
  onBranchSwitch,
  onSubmitForReview,
  onRefresh,
  onToast,
}: BranchesTabProps) {
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
    void invoke<boolean>('get_branch_prefix_preference', { projectPath })
      .then(setPrefixUsername)
      .catch(() => {}); // Ignore errors, default to true
  }, [projectPath]);

  // Save prefix preference when changed
  const handlePrefixChange = (checked: boolean) => {
    setPrefixUsername(checked);
    void invoke('set_branch_prefix_preference', { projectPath, prefix: checked }).catch(() => {}); // Ignore errors
  };

  // Group branches
  const currentBranchInfo = branches.find((b) => b.isCurrent);
  const userBranches = githubUsername
    ? branches.filter(
        (b) =>
          !b.isCurrent &&
          !b.isDefault &&
          b.name !== 'staging' &&
          b.name.startsWith(`${githubUsername}/`)
      )
    : [];
  const teamBranches = branches.filter(
    (b) => !b.isCurrent && !b.isDefault && b.name !== 'staging' && !userBranches.includes(b)
  );
  const mainBranches = branches.filter(
    (b) => !b.isCurrent && (b.isDefault || b.name === 'staging')
  );

  const handleSwitch = async (branchName: string) => {
    setSwitchingBranch(branchName);
    try {
      // Try to switch without auto-stash - backend will tell us if there are uncommitted changes
      const result = await switchBranch(projectPath, branchName, false);
      if (result.success) {
        onBranchSwitch(branchName);
        onToast?.(`Switched to ${branchName}`, 'success');
      } else if (result.error?.includes('Uncommitted changes')) {
        // Show the unsaved changes modal
        setPendingSwitch(branchName);
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
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
      onToast?.(`Deleted ${branchName}`, 'success');
      onRefresh();
    } catch (e) {
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
      await invoke('git_pull', { projectPath });

      onToast?.(`Reverted to GitHub version`, 'success');
      onRefresh();
    } catch (e) {
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
                {currentBranchInfo.name}
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
              {!currentBranchInfo.isDefault && currentBranchInfo.name !== 'staging' && (
                <button
                  className="branch-card-action primary"
                  onClick={() => onSubmitForReview(currentBranchInfo.name)}
                >
                  Submit for Review
                </button>
              )}
              <button
                className="branch-card-action danger-outline"
                onClick={() => setShowRevertConfirm(true)}
                disabled={isReverting}
                title="Discard local changes and pull from GitHub"
              >
                {isReverting ? 'Reverting...' : 'Revert to GitHub'}
              </button>
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
                <button
                  className="branch-card-action"
                  onClick={() => {
                    setShowNewBranch(false);
                    setNewBranchName('');
                  }}
                >
                  Cancel
                </button>
                <button
                  className="branch-card-action primary"
                  onClick={() => void handleCreateBranch()}
                  disabled={!newBranchName.trim() || isCreatingBranch}
                >
                  {isCreatingBranch ? 'Creating...' : 'Create'}
                </button>
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
        <div
          className="post-merge-modal"
          onClick={() => !deletingBranch && setBranchToDelete(null)}
        >
          <div className="post-merge-content" onClick={(e) => e.stopPropagation()}>
            <div className="post-merge-header">
              <h3>Delete Branch?</h3>
            </div>
            <div className="post-merge-body">
              <p>
                Are you sure you want to delete <strong>{branchToDelete}</strong>? This action
                cannot be undone.
              </p>
            </div>
            <div className="post-merge-footer">
              <button
                className="post-merge-btn secondary"
                onClick={() => setBranchToDelete(null)}
                disabled={!!deletingBranch}
              >
                Cancel
              </button>
              <button
                className="post-merge-btn danger"
                onClick={() => void handleDeleteConfirm()}
                disabled={!!deletingBranch}
              >
                {deletingBranch ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revert confirmation modal */}
      {showRevertConfirm && (
        <div
          className="post-merge-modal"
          onClick={() => !isReverting && setShowRevertConfirm(false)}
        >
          <div className="post-merge-content" onClick={(e) => e.stopPropagation()}>
            <div className="post-merge-header">
              <h3>Revert to GitHub?</h3>
            </div>
            <div className="post-merge-body">
              <p>
                This will discard all local changes on <strong>{currentBranch}</strong> and pull the
                latest version from GitHub. This action cannot be undone.
              </p>
            </div>
            <div className="post-merge-footer">
              <button
                className="post-merge-btn secondary"
                onClick={() => setShowRevertConfirm(false)}
                disabled={isReverting}
              >
                Cancel
              </button>
              <button
                className="post-merge-btn danger"
                onClick={() => void handleRevertToGitHub()}
                disabled={isReverting}
              >
                {isReverting ? 'Reverting...' : 'Revert'}
              </button>
            </div>
          </div>
        </div>
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
          onToast={onToast}
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
          {branch.name}
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
          <button className="branch-card-action primary" onClick={onSubmitForReview}>
            Submit for Review
          </button>
        )}
        {!isCurrent && (
          <button className="branch-card-action" onClick={onSwitch} disabled={isSwitching}>
            {isSwitching ? 'Switching...' : 'Switch'}
          </button>
        )}
        {showDelete && (
          <button className="branch-card-action danger" onClick={onDelete} disabled={isDeleting}>
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}
