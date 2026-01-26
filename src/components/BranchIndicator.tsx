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
import { invoke } from '@tauri-apps/api/core';
import { BranchIcon, ChevronIcon, FileIcon, TrashIcon } from './icons';
import { ChangedFile } from '../lib/git';

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
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function BranchIndicator({
  currentBranch,
  hasUncommittedChanges,
  changedFiles,
  projectPath,
  isOnBranchesTab,
  onClick,
  onDiscard,
  onToast,
}: BranchIndicatorProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const dropdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    }, 150);
  }, []);

  const handleDiscardAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDiscarding) return;

    const confirmed = window.confirm(
      'Are you sure you want to discard all changes? This cannot be undone.'
    );
    if (!confirmed) return;

    setIsDiscarding(true);
    try {
      await invoke('discard_changes', { projectPath });
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

  // Get status icon based on change type
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'added':
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
    >
      <button className="branch-indicator-button" onClick={onClick}>
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
              <div key={index} className="branch-changes-item">
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
            <button
              className="branch-changes-discard-btn"
              onClick={(e) => void handleDiscardAll(e)}
              disabled={isDiscarding}
            >
              <TrashIcon size={12} />
              {isDiscarding ? 'Discarding...' : 'Discard All'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
