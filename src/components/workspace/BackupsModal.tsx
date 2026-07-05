/**
 * BackupsModal component for viewing and restoring project backups.
 *
 * Shows a list of git commits as "backups" and allows restoring to any point.
 * Uses a safe restore flow that creates a new branch for review via PR.
 *
 * @module components/BackupsModal
 */

import { useEffect, useState, useCallback } from 'react';
import { CheckIcon, PullRequestIcon } from '../icons';
import { getBackups, restoreBackup, Backup, RestoreResult } from '../../lib/backups';
import { trackEvent } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useAsyncState } from '../../hooks/useAsyncState';
import { EmptyState } from '../primitives/EmptyState';
import { Spinner } from '../primitives/Spinner';
import { useModal } from '../../contexts/ModalContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface BackupsModalProps {
  projectPath: string;
  onRestore?: () => void;
  onCreatePR?: (branchName: string) => void;
}

type ModalState =
  | { type: 'list' }
  | { type: 'confirming'; backup: Backup }
  | { type: 'restoring'; backup: Backup }
  | { type: 'success'; result: RestoreResult };

export function BackupsModal({ projectPath, onRestore, onCreatePR }: BackupsModalProps) {
  const { isOpen, close: onClose } = useModal('backups');
  const {
    data: backups,
    isLoading,
    error: loadError,
    execute: fetchBackups,
  } = useAsyncState<Backup[]>(() => getBackups(projectPath, 50), { initial: [] });
  const [actionError, setActionError] = useState<string | null>(null);
  const rawError = actionError ?? (loadError ? loadError.message : null);
  const isNotGitRepo =
    rawError != null &&
    (rawError.includes('not a git repository') ||
      rawError.includes('Failed to get git log') ||
      rawError.includes('does not have any commits'));
  const error = isNotGitRepo ? null : rawError;
  const setError = setActionError;
  const [modalState, setModalState] = useState<ModalState>({ type: 'list' });

  const loadBackups = useCallback(async () => {
    if (!projectPath) return;
    await fetchBackups();
  }, [projectPath, fetchBackups]);

  useEffect(() => {
    if (isOpen) {
      setModalState({ type: 'list' });
      setError(null);
      void loadBackups();
    }
    // setError is stable (plain useState setter); including it would force a
    // stable-reference dance for no runtime benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, loadBackups]);

  const handleRestoreClick = (backup: Backup) => {
    setError(null);
    setModalState({ type: 'confirming', backup });
  };

  const handleConfirmRestore = async () => {
    if (modalState.type !== 'confirming') return;
    const backup = modalState.backup;
    setModalState({ type: 'restoring', backup });
    setError(null);
    try {
      const result = await restoreBackup(projectPath, backup.hash);
      void trackEvent('backup_restored', { $screen_name: 'Backups' });
      setModalState({ type: 'success', result });
      onRestore?.();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
      setModalState({ type: 'list' });
    }
  };

  const handleCancelConfirm = () => setModalState({ type: 'list' });

  const handleCreatePR = () => {
    if (modalState.type !== 'success') return;
    const branchName = modalState.result.branch_name;
    setModalState({ type: 'list' });
    onClose();
    onCreatePR?.(branchName);
  };

  const handleCloseSuccess = () => {
    setModalState({ type: 'list' });
    onClose();
  };

  if (modalState.type === 'confirming' || modalState.type === 'restoring') {
    const backup = modalState.backup;
    const isRestoring = modalState.type === 'restoring';
    return (
      <ModalFrame
        isOpen
        onClose={handleCancelConfirm}
        dismissable={!isRestoring}
        showCloseButton={false}
        className="backups-modal backups-confirm-modal"
      >
        <div className="backups-confirm-content">
          <h3>Restore to this backup?</h3>
          <p className="backups-confirm-description">
            This will create a new branch with the backup. To make it live, you'll need to create a
            pull request and merge it.
          </p>

          <div className="backups-confirm-backup">
            <div className="backup-message">{backup.message}</div>
            <div className="backup-meta">
              <span className="backup-time">{backup.relative_time}</span>
              <span className="backup-hash">{backup.hash}</span>
            </div>
          </div>

          {error && <div className="backups-error">{error}</div>}

          <div className="backups-confirm-actions">
            <Button variant="secondary" onClick={handleCancelConfirm} disabled={isRestoring}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirmRestore()}
              disabled={isRestoring}
              leftIcon={isRestoring ? <Spinner size="sm" /> : undefined}
            >
              {isRestoring ? 'Restoring...' : 'Restore'}
            </Button>
          </div>
        </div>
      </ModalFrame>
    );
  }

  if (modalState.type === 'success') {
    const { branch_name } = modalState.result;
    return (
      <ModalFrame
        isOpen
        onClose={handleCloseSuccess}
        showCloseButton={false}
        className="backups-modal backups-success-modal"
      >
        <div className="backups-success-content">
          <div className="backups-success-icon">
            <CheckIcon size={24} />
          </div>
          <div className="backups-success-branch">
            <span className="backups-badge backups-badge-preview">Preview</span>
            <span className="backups-branch-name">{branch_name}</span>
          </div>
          <p className="backups-success-description">To make this backup live:</p>
          <ol className="backups-success-steps">
            <li>Create a pull request</li>
            <li>Merge it to main</li>
          </ol>

          <div className="backups-success-actions">
            {onCreatePR && (
              <Button
                variant="primary"
                onClick={handleCreatePR}
                leftIcon={<PullRequestIcon size={14} />}
              >
                Create Pull Request
              </Button>
            )}
            <Button variant="secondary" onClick={handleCloseSuccess}>
              Close
            </Button>
          </div>
        </div>
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div>
          <div>Backups</div>
          <div className="backups-modal-subtitle">Restore to any previous version</div>
        </div>
      }
      className="backups-modal"
    >
      <div className="backups-modal-body">
        {error && <div className="backups-error">{error}</div>}

        {isLoading ? (
          <div className="backups-loading">
            <Spinner />
            <span>Loading backups...</span>
          </div>
        ) : isNotGitRepo ? (
          <EmptyState
            title="Not a Git repo yet"
            description="Once this project is connected to GitHub, you can restore to any previous version"
          />
        ) : !backups || backups.length === 0 ? (
          <EmptyState
            title="No backups yet"
            description="Backups are created automatically when you make changes"
          />
        ) : (
          <div className="backups-list">
            {backups.map((backup, index) => (
              <div key={backup.full_hash} className="backup-item">
                <div className="backup-info">
                  <div className="backup-message">{backup.message}</div>
                  <div className="backup-meta">
                    <span className="backup-time">{backup.relative_time}</span>
                    <span className="backup-hash">{backup.hash}</span>
                  </div>
                </div>
                {index > 0 && (
                  <Button variant="secondary" size="sm" onClick={() => handleRestoreClick(backup)}>
                    Restore
                  </Button>
                )}
                {index === 0 && <span className="backup-current">Current</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="backups-footer">
        <span className="backups-footer-hint">
          Restoring creates a new branch for safe review via PR
        </span>
      </div>
    </ModalFrame>
  );
}
