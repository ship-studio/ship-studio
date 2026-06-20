/**
 * MoveWorkspaceModal — lets the user reassign a project to a different
 * Workspace (Account). Only the project's metadata `account_id` changes;
 * the folder on disk is not moved.
 *
 * @module components/dashboard/MoveWorkspaceModal
 */

import { useState, useEffect } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { CheckIcon } from '../icons';
import { listAccounts, type Account } from '../../lib/accounts';
import { logger } from '../../lib/logger';

interface MoveWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  currentAccountId: string | null;
  onSelect: (accountId: string) => Promise<void>;
}

export function MoveWorkspaceModal({
  isOpen,
  onClose,
  projectName,
  currentAccountId,
  onSelect,
}: MoveWorkspaceModalProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  // The chosen target — selecting a workspace highlights it; nothing moves until
  // the user confirms.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null);
      return;
    }
    setLoading(true);
    listAccounts()
      .then(setAccounts)
      .catch((err) =>
        logger.error('Failed to load workspaces', {
          error: err instanceof Error ? err.message : String(err),
        })
      )
      .finally(() => setLoading(false));
  }, [isOpen]);

  const target = accounts.find((a) => a.id === selectedId) ?? null;

  const handleConfirm = async () => {
    if (selecting || !selectedId || selectedId === currentAccountId) return;
    setSelecting(true);
    try {
      await onSelect(selectedId);
      onClose();
    } catch (err) {
      logger.error('Failed to move project to workspace', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSelecting(false);
    }
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title="Move to Workspace"
      className="move-folder-modal"
      dismissable={!selecting}
    >
      <div style={{ padding: 'var(--spacing-xl)' }}>
        <p className="modal-subtitle">
          Move <strong>{projectName}</strong> to a different workspace:
        </p>

        {loading ? (
          <div className="move-folder-loading">
            <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : (
          <div className="move-folder-list">
            {accounts.map((account) => {
              const isCurrent = account.id === currentAccountId;
              const isSelected = account.id === selectedId;
              return (
                <button
                  key={account.id}
                  className={`move-folder-item ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedId(account.id)}
                  disabled={selecting || isCurrent}
                >
                  <span
                    className="workspace-switch-account-dot"
                    style={{ background: account.color, flexShrink: 0 }}
                  />
                  <span className="move-folder-item-name">{account.name}</span>
                  {isCurrent ? (
                    <span className="move-folder-item-tag">Current</span>
                  ) : (
                    isSelected && <CheckIcon size={16} />
                  )}
                </button>
              );
            })}
          </div>
        )}

        <p className="move-workspace-explainer">
          {target ? (
            <>
              <strong>{projectName}</strong> will use <strong>{target.name}</strong>'s Claude,
              GitHub, and Codex logins and git identity. If {target.name} uses a different projects
              folder, the project's files are moved there too.
            </>
          ) : (
            "Moving a project switches which workspace's logins and credentials its terminals, git, and AI use — and moves it into that workspace's projects folder."
          )}
        </p>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={selecting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={selecting || !target}
          >
            {selecting ? <Spinner size="sm" /> : target ? `Move to ${target.name}` : 'Move'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
