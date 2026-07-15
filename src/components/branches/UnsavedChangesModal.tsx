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
import { WarningIcon } from '../icons';
import { publishBranch, discardChanges, switchBranch } from '../../lib/branches';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

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
}

export function UnsavedChangesModal({
  currentBranch,
  targetBranch,
  projectPath,
  onSwitchComplete,
  onClose,
}: UnsavedChangesModalProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  const handlePublishAndSwitch = async () => {
    setIsPublishing(true);
    try {
      await publishBranch(projectPath);
      onToast?.(`Published ${currentBranch}`, 'success');
      const result = await switchBranch(projectPath, targetBranch, false);
      if (result.success) {
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      onToast?.(`Failed to publish: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscardAndSwitch = async () => {
    setIsDiscarding(true);
    try {
      await discardChanges(projectPath);
      const result = await switchBranch(projectPath, targetBranch, false);
      if (result.success) {
        onToast?.(`Switched to ${targetBranch}`, 'success');
        onSwitchComplete(targetBranch);
        onClose();
      } else {
        onToast?.(result.error || 'Failed to switch branch', 'error');
      }
    } catch (e) {
      onToast?.(`Failed to discard changes: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsDiscarding(false);
    }
  };

  const isLoading = isPublishing || isDiscarding;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      dismissable={!isLoading}
      className="unsaved-changes-content"
      title={
        <>
          <WarningIcon size={20} />
          <span>Unsaved Changes</span>
        </>
      }
    >
      <div className="unsaved-changes-body">
        <p>
          You have uncommitted changes on <strong>{currentBranch}</strong>. What would you like to
          do?
        </p>
      </div>
      <div className="unsaved-changes-actions">
        <Button variant="secondary" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void handleDiscardAndSwitch()} disabled={isLoading}>
          {isDiscarding ? 'Discarding...' : 'Discard Changes'}
        </Button>
        <Button
          variant="primary"
          onClick={() => void handlePublishAndSwitch()}
          disabled={isLoading}
        >
          {isPublishing ? 'Publishing...' : 'Publish & Switch'}
        </Button>
      </div>
    </ModalFrame>
  );
}
