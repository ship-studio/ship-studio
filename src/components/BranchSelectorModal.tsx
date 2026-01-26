/**
 * Branch selector modal for choosing which branch to work on.
 *
 * Shows when opening a project with multiple branches.
 * Allows selecting an existing branch or creating a new one.
 *
 * @module components/BranchSelectorModal
 */

import { useState, useEffect } from 'react';
import { BranchInfo, formatRelativeTime } from '../lib/branches';

interface BranchSelectorModalProps {
  /** Absolute path to the project */
  projectPath: string;
  /** Project name for display */
  projectName: string;
  /** List of available branches */
  branches: BranchInfo[];
  /** Currently selected branch (may be null if not yet selected) */
  currentBranch: string | null;
  /** GitHub username for auto-prefixing new branches */
  githubUsername: string | null;
  /** Callback when a branch is selected */
  onSelectBranch: (branchName: string) => Promise<void>;
  /** Callback when a new branch is created */
  onCreateBranch: (name: string, fromBranch: string) => Promise<void>;
  /** Callback to close the modal */
  onClose: () => void;
  /** Loading state */
  isLoading?: boolean;
  /** Whether to start in create mode */
  createMode?: boolean;
}

export function BranchSelectorModal({
  projectPath: _projectPath,
  projectName,
  branches,
  currentBranch,
  githubUsername,
  onSelectBranch,
  onCreateBranch,
  onClose,
  isLoading = false,
  createMode = false,
}: BranchSelectorModalProps) {
  const [selectedBranch, setSelectedBranch] = useState<string>(currentBranch || 'main');
  const [showCreateForm, setShowCreateForm] = useState(createMode);
  const [newBranchName, setNewBranchName] = useState('');
  const [fromBranch, setFromBranch] = useState('main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize selected branch
  useEffect(() => {
    if (currentBranch) {
      setSelectedBranch(currentBranch);
    } else if (branches.length > 0) {
      const mainBranch = branches.find((b) => b.isDefault);
      setSelectedBranch(mainBranch?.name || branches[0].name);
    }
  }, [currentBranch, branches]);

  // Auto-prefix new branch name with username if provided
  useEffect(() => {
    if (showCreateForm && githubUsername && !newBranchName) {
      setNewBranchName(`${githubUsername}/`);
    }
  }, [showCreateForm, githubUsername, newBranchName]);

  // Group branches
  const mainBranches = branches.filter((b) => b.isDefault || b.name === 'staging');
  const userBranches = githubUsername
    ? branches.filter(
        (b) => !b.isDefault && b.name !== 'staging' && b.name.startsWith(`${githubUsername}/`)
      )
    : [];
  const otherBranches = branches.filter(
    (b) => !b.isDefault && b.name !== 'staging' && !userBranches.includes(b)
  );

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      if (showCreateForm && newBranchName.trim()) {
        // Create new branch
        const branchName = newBranchName.trim();
        await onCreateBranch(branchName, fromBranch);
      } else {
        // Select existing branch
        await onSelectBranch(selectedBranch);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !isSubmitting) {
      void handleSubmit();
    }
  };

  const canSubmit = showCreateForm
    ? newBranchName.trim().length > 0 && !newBranchName.includes(' ')
    : selectedBranch.length > 0;

  return (
    <div className="branch-selector-modal" onKeyDown={handleKeyDown} onClick={onClose}>
      <div className="branch-selector-content" onClick={(e) => e.stopPropagation()}>
        <div className="branch-selector-header">
          <h2>Choose where to work</h2>
          <p>Select a branch to start editing {projectName}</p>
        </div>

        <div className="branch-selector-list">
          {isLoading ? (
            <div className="branch-selector-loading">
              <div className="branch-item-spinner" />
              <span>Loading branches...</span>
            </div>
          ) : (
            <>
              {/* Main branches */}
              {mainBranches.length > 0 && (
                <div className="branch-selector-section">
                  {mainBranches.map((branch) => (
                    <BranchItem
                      key={branch.name}
                      branch={branch}
                      isSelected={!showCreateForm && selectedBranch === branch.name}
                      onSelect={() => {
                        setShowCreateForm(false);
                        setSelectedBranch(branch.name);
                      }}
                    />
                  ))}
                </div>
              )}

              {/* User's branches */}
              {userBranches.length > 0 && (
                <div className="branch-selector-section">
                  <div className="branch-selector-section-label">Your branches</div>
                  {userBranches.map((branch) => (
                    <BranchItem
                      key={branch.name}
                      branch={branch}
                      isSelected={!showCreateForm && selectedBranch === branch.name}
                      onSelect={() => {
                        setShowCreateForm(false);
                        setSelectedBranch(branch.name);
                      }}
                    />
                  ))}
                </div>
              )}

              {/* Other branches */}
              {otherBranches.length > 0 && (
                <div className="branch-selector-section">
                  <div className="branch-selector-section-label">
                    {userBranches.length > 0 ? 'Team branches' : 'Other branches'}
                  </div>
                  {otherBranches.slice(0, 5).map((branch) => (
                    <BranchItem
                      key={branch.name}
                      branch={branch}
                      isSelected={!showCreateForm && selectedBranch === branch.name}
                      onSelect={() => {
                        setShowCreateForm(false);
                        setSelectedBranch(branch.name);
                      }}
                    />
                  ))}
                  {otherBranches.length > 5 && (
                    <div className="branch-selector-more">
                      +{otherBranches.length - 5} more branches
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Create new branch section */}
        <div className="branch-selector-create">
          {!showCreateForm ? (
            <button className="branch-create-toggle" onClick={() => setShowCreateForm(true)}>
              + Create new branch
            </button>
          ) : (
            <div className="branch-create-form">
              <input
                type="text"
                className="branch-create-input"
                placeholder="my-new-branch"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="branch-create-from">
                <span>from</span>
                <select value={fromBranch} onChange={(e) => setFromBranch(e.target.value)}>
                  {branches
                    .filter((b) => b.isDefault || b.name === 'staging')
                    .map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {error && <div className="branch-selector-error">{error}</div>}

        <div className="branch-selector-footer">
          <button className="branch-selector-cancel" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="branch-selector-submit"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !canSubmit}
          >
            {isSubmitting ? 'Opening...' : showCreateForm ? 'Create & Open' : 'Open Project'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface BranchItemProps {
  branch: BranchInfo;
  isSelected: boolean;
  onSelect: () => void;
}

function BranchItem({ branch, isSelected, onSelect }: BranchItemProps) {
  const showBehindWarning = branch.behindOfMain > 30 && !branch.isDefault;

  return (
    <button className={`branch-selector-item ${isSelected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="branch-selector-radio" />
      <div className="branch-selector-info">
        <div className="branch-selector-name">
          {branch.name}
          {branch.isDefault && <span className="branch-item-badge live">Live</span>}
          {branch.name === 'staging' && <span className="branch-item-badge">staging</span>}
        </div>
        <div className="branch-selector-meta">
          {formatRelativeTime(branch.lastCommitDate)}
          {branch.aheadOfMain > 0 && !branch.isDefault && <> · {branch.aheadOfMain} ahead</>}
        </div>
        {showBehindWarning && (
          <div className="branch-selector-warning">{branch.behindOfMain} commits behind main</div>
        )}
      </div>
    </button>
  );
}
