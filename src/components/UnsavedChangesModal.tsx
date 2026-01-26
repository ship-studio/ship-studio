/**
 * Modal for handling unsaved changes when switching branches.
 *
 * Shows options to:
 * - Publish changes and switch
 * - Discard changes and switch
 * - Cancel and stay on current branch
 *
 * @module components/UnsavedChangesModal
 */

import { useState } from 'react';
import { WarningIcon } from './icons';
import { publishBranch, discardChanges, switchBranch } from '../lib/branches';

interface UnsavedChangesModalProps {
  /** Current branch name */
  currentBranch: string;
  /** Target branch to switch to */
  targetBranch: string;
  /** Project path for git operations */
  projectPath: string;
  /** Callback when switch completes successfully */
  onSwitchComplete: (branchName: string) => void;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback for toast notifications */
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function UnsavedChangesModal({
  currentBranch,
  targetBranch,
  projectPath,
  onSwitchComplete,
  onClose,
  onToast,
}: UnsavedChangesModalProps) {
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  const handlePublishAndSwitch = async () => {
    setIsPublishing(true);
    try {
      // First publish the current branch
      await publishBranch(projectPath);
      onToast?.(`Published ${currentBranch}`, 'success');

      // Then switch to target branch
      const result = await switchBranch(projectPath, targetBranch, false);
      if (result.success) {
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      onToast?.(`Failed to publish: ${String(e)}`, 'error');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscardAndSwitch = async () => {
    setIsDiscarding(true);
    try {
      // Discard all changes
      await discardChanges(projectPath);

      // Then switch to target branch
      const result = await switchBranch(projectPath, targetBranch, false);
      if (result.success) {
        onToast?.(`Switched to ${targetBranch}`, 'success');
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      onToast?.(`Failed to discard changes: ${String(e)}`, 'error');
    } finally {
      setIsDiscarding(false);
    }
  };

  const isLoading = isPublishing || isDiscarding;

  return (
    <div className="unsaved-changes-modal" onClick={() => !isLoading && onClose()}>
      <div className="unsaved-changes-content" onClick={(e) => e.stopPropagation()}>
        <div className="unsaved-changes-header">
          <WarningIcon size={20} />
          <h3>Unsaved Changes</h3>
        </div>
        <div className="unsaved-changes-body">
          <p>
            You have uncommitted changes on <strong>{currentBranch}</strong>. What would you like to
            do?
          </p>
        </div>
        <div className="unsaved-changes-actions">
          <button className="unsaved-changes-btn secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button
            className="unsaved-changes-btn danger"
            onClick={() => void handleDiscardAndSwitch()}
            disabled={isLoading}
          >
            {isDiscarding ? 'Discarding...' : 'Discard Changes'}
          </button>
          <button
            className="unsaved-changes-btn primary"
            onClick={() => void handlePublishAndSwitch()}
            disabled={isLoading}
          >
            {isPublishing ? 'Publishing...' : 'Publish & Switch'}
          </button>
        </div>
      </div>
    </div>
  );
}
