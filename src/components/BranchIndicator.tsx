/**
 * Branch indicator component for workspace header.
 *
 * Shows the current branch name with:
 * - Branch icon
 * - Branch name
 * - "Live" badge if on main branch
 * - "Unsaved" badge if there are uncommitted changes
 *
 * When hovering over "Unsaved" badge, shows a dropdown with the list
 * of changed files.
 *
 * When on the Branches/PRs tab, shows "Back to Preview" instead.
 *
 * @module components/BranchIndicator
 */

import { useState, useRef, useCallback } from 'react';
import { BranchIcon, ChevronIcon, FileIcon, TrashIcon } from './icons';
import { ChangedFile, ChangeStatus } from '../lib/git';
import { discardChanges } from '../lib/branches';
import { DiffModal } from './DiffModal';
import { useOptionalToast } from '../contexts/ToastContext';

interface BranchIndicatorProps {
  /** Current branch name */
  currentBranch: string;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
  /** List of files with uncommitted changes */
  changedFiles: ChangedFile[];
  /** Absolute path to the project */
  projectPath: string;
  /** Whether currently showing branches/prs tab */
  isOnBranchesTab: boolean;
  /** Callback when clicked - navigates to Branches tab or back to preview */
  onClick: () => void;
  /** Callback when changes are discarded */
  onDiscard?: () => void;
  /** Callback when Save button is clicked - should open publish dropdown */
  onSave?: () => void;
  /** Whether the project has a preview to return to — web iframe or device
   *  mirror (defaults to true). Gates the "back to preview" affordance. */
  hasPreview?: boolean;
}

export function BranchIndicator({
  currentBranch,
  hasUncommittedChanges,
  changedFiles,
  projectPath,
  isOnBranchesTab,
  onClick,
  onDiscard,
  onSave,
  hasPreview = true,
}: BranchIndicatorProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; status: ChangeStatus } | null>(
    null
  );
  const dropdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';

  const handleMouseEnter = useCallback(() => {
    if (dropdownTimeoutRef.current) {
      clearTimeout(dropdownTimeoutRef.current);
      dropdownTimeoutRef.current = null;
    }
    if (hasUncommittedChanges && changedFiles.length > 0) {
      setShowDropdown(true);
    }
  }, [hasUncommittedChanges, changedFiles.length]);

  const handleMouseLeave = useCallback(() => {
    dropdownTimeoutRef.current = setTimeout(() => {
      setShowDropdown(false);
      setConfirmDiscard(false); // Reset confirmation when dropdown closes
    }, 150);
  }, []);

  const handleDiscardAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDiscarding) return;

    // First click: show confirmation state
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      // Reset confirmation after 3 seconds if not clicked
      if (confirmTimeoutRef.current) {
        clearTimeout(confirmTimeoutRef.current);
      }
      confirmTimeoutRef.current = setTimeout(() => {
        setConfirmDiscard(false);
      }, 3000);
      return;
    }

    // Second click: perform the discard
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
    }
    setConfirmDiscard(false);
    setIsDiscarding(true);
    try {
      await discardChanges(projectPath);
      onToast?.('All changes discarded', 'success');
      onDiscard?.();
      setShowDropdown(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onToast?.(`Failed to discard changes: ${message}`, 'error');
    } finally {
      setIsDiscarding(false);
    }
  };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDropdown(false);
    onSave?.();
  };

  // Get status icon based on change type
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'added':
      case 'untracked':
        return <span className="change-status change-added">+</span>;
      case 'deleted':
        return <span className="change-status change-deleted">-</span>;
      case 'renamed':
        return <span className="change-status change-renamed">R</span>;
      default:
        return <span className="change-status change-modified">M</span>;
    }
  };

  // Get just the filename from the path
  const getFileName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1];
  };

  // Get directory path (without filename)
  const getDirectory = (path: string) => {
    const parts = path.split('/');
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join('/') + '/';
  };

  if (isOnBranchesTab) {
    // Projects with no preview (generic/unknown) have nothing to go back to —
    // hide the back button entirely.
    if (!hasPreview) return null;
    return (
      <div className="branch-indicator">
        <button className="branch-indicator-button branch-indicator-back" onClick={onClick}>
          <ChevronIcon size={14} className="back-chevron" />
          <span>Back to Preview</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="branch-indicator"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-education-id="branch-indicator"
    >
      <button
        className={`branch-indicator-button ${isMainBranch ? 'main-branch' : ''}`}
        onClick={onClick}
      >
        <BranchIcon size={14} />
        <span className="branch-name">{currentBranch}</span>
        {isMainBranch && <span className="branch-live-badge">Live</span>}
        {hasUncommittedChanges && <span className="branch-unsaved-badge">Unsaved</span>}
      </button>

      {showDropdown && changedFiles.length > 0 && (
        <div className="branch-changes-dropdown">
          <div className="branch-changes-header">
            <span>
              {changedFiles.length} Unsaved {changedFiles.length === 1 ? 'Change' : 'Changes'}
            </span>
          </div>
          <div className="branch-changes-list">
            {changedFiles.map((file, index) => (
              <div
                key={index}
                className="branch-changes-item branch-changes-item-clickable"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedFile({ path: file.path, status: file.status });
                }}
              >
                {getStatusIndicator(file.status)}
                <FileIcon size={12} />
                <span className="branch-changes-path">
                  <span className="branch-changes-dir">{getDirectory(file.path)}</span>
                  <span className="branch-changes-filename">{getFileName(file.path)}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="branch-changes-footer">
            <button className="branch-changes-save-btn" onClick={handleSave}>
              Save
            </button>
            <button
              className={`branch-changes-discard-btn ${confirmDiscard ? 'confirming' : ''}`}
              onClick={(e) => {
                void handleDiscardAll(e);
              }}
              disabled={isDiscarding}
            >
              <TrashIcon size={12} />
              {isDiscarding ? 'Discarding...' : confirmDiscard ? 'Click to Confirm' : 'Discard All'}
            </button>
          </div>
        </div>
      )}

      {selectedFile && (
        <DiffModal
          projectPath={projectPath}
          filePath={selectedFile.path}
          fileStatus={selectedFile.status}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}
