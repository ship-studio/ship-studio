/**
 * MoveFolderModal component for moving a project to a folder.
 *
 * Displays a list of available folders and an option to remove from folder.
 *
 * @module components/MoveFolderModal
 */

import { useState, useEffect, useRef } from 'react';
import { FolderInfo, listFolders, createFolder } from '../lib/folders';
import { FolderIcon, CheckIcon, PlusIcon } from './icons';
import { logger } from '../lib/logger';
import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { Spinner } from './primitives/Spinner';

/** Props for the MoveFolderModal component */
interface MoveFolderModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when a folder is selected */
  onSelect: (folderId: string | null) => Promise<void>;
  /** Project name to display */
  projectName: string;
  /** Current folder ID (if project is in a folder) */
  currentFolderId: string | null;
}

export function MoveFolderModal({
  isOpen,
  onClose,
  onSelect,
  projectName,
  currentFolderId,
}: MoveFolderModalProps) {
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Load folders when modal opens
  useEffect(() => {
    if (isOpen) {
      setCreatingFolder(false);
      setNewFolderName('');
      setLoading(true);
      listFolders()
        .then(setFolders)
        .catch((err) =>
          logger.error('Failed to load folders', {
            error: err instanceof Error ? err.message : String(err),
          })
        )
        .finally(() => setLoading(false));
    }
  }, [isOpen]);

  // Focus input when entering create mode
  useEffect(() => {
    if (creatingFolder) {
      newFolderInputRef.current?.focus();
    }
  }, [creatingFolder]);

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;

    try {
      const folder = await createFolder(trimmed);
      setNewFolderName('');
      setCreatingFolder(false);
      // Move the project into the newly created folder
      await handleSelect(folder.id);
    } catch (err) {
      logger.error('Failed to create folder', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSelect = async (folderId: string | null) => {
    if (selecting) return;

    setSelecting(true);
    try {
      await onSelect(folderId);
      onClose();
    } catch (err) {
      logger.error('Failed to move project', {
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
      title="Move to Folder"
      className="move-folder-modal"
      dismissable={!selecting}
    >
      <div style={{ padding: 'var(--spacing-xl)' }}>
        <p className="modal-subtitle">
          Move <strong>{projectName}</strong> to:
        </p>

        {loading ? (
          <div className="move-folder-loading">
            <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : (
          <div className="move-folder-list">
            {/* No Folder option */}
            <button
              className={`move-folder-item ${currentFolderId === null ? 'active' : ''}`}
              onClick={() => void handleSelect(null)}
              disabled={selecting || currentFolderId === null}
            >
              <span className="move-folder-item-name">No Folder (Root)</span>
              {currentFolderId === null && <CheckIcon size={16} />}
            </button>

            {/* Folder options */}
            {folders.map((folder) => (
              <button
                key={folder.id}
                className={`move-folder-item ${currentFolderId === folder.id ? 'active' : ''}`}
                onClick={() => void handleSelect(folder.id)}
                disabled={selecting || currentFolderId === folder.id}
              >
                <FolderIcon size={16} />
                <span className="move-folder-item-name">{folder.name}</span>
                <span className="move-folder-item-count">
                  {folder.project_count} {folder.project_count === 1 ? 'project' : 'projects'}
                </span>
                {currentFolderId === folder.id && <CheckIcon size={16} />}
              </button>
            ))}

            {/* New folder creation */}
            {creatingFolder ? (
              <div className="move-folder-create-input">
                <FolderIcon size={16} />
                <input
                  ref={newFolderInputRef}
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateFolder();
                    if (e.key === 'Escape') {
                      setCreatingFolder(false);
                      setNewFolderName('');
                    }
                  }}
                  placeholder="Folder name"
                  maxLength={50}
                />
                <button
                  className="move-folder-create-confirm"
                  onClick={() => void handleCreateFolder()}
                  disabled={!newFolderName.trim()}
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                className="move-folder-item move-folder-new-btn"
                onClick={() => setCreatingFolder(true)}
                disabled={selecting}
              >
                <PlusIcon size={16} />
                <span className="move-folder-item-name">New Folder</span>
              </button>
            )}
          </div>
        )}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={selecting}>
            Cancel
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
