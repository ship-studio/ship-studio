/**
 * FolderCard component that displays a folder in the dashboard grid.
 *
 * Shows a 2x2 grid of project thumbnails, folder name, and project count.
 * Provides click to open folder view and context menu for rename/delete.
 *
 * @module components/FolderCard
 */

import { memo } from 'react';
import { FolderInfo } from '../../lib/folders';
import { FolderIcon, EditIcon, TrashIcon } from '../icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';

/** Props for the FolderCard component */
interface FolderCardProps {
  /** Folder data including name, project count, and preview thumbnails */
  folder: FolderInfo;
  /** Callback when the card is clicked to open the folder */
  onOpen: () => void;
  /** Callback when rename is requested */
  onRename: () => void;
  /** Callback when delete is requested */
  onDelete: () => void;
}

export const FolderCard = memo(function FolderCard({
  folder,
  onOpen,
  onRename,
  onDelete,
}: FolderCardProps) {
  // Create a 2x2 grid of thumbnails
  const thumbnails = folder.preview_thumbnails.slice(0, 4);
  // Pad with nulls to always have 4 slots
  while (thumbnails.length < 4) {
    thumbnails.push(null);
  }

  return (
    <div className="folder-card">
      <div
        className="folder-card-thumbnail"
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="folder-card-grid">
          {thumbnails.map((thumbnail, index) => (
            <div key={index} className="folder-card-grid-item">
              {thumbnail ? (
                <img src={thumbnail} alt="" />
              ) : (
                <div className="folder-card-grid-placeholder">
                  {index === 0 && folder.project_count === 0 && <FolderIcon size={20} />}
                </div>
              )}
            </div>
          ))}
        </div>
        {/* Hover overlay */}
        <div className="folder-card-overlay">
          <span className="folder-card-open-label">Open folder</span>
        </div>
      </div>
      <div className="folder-card-info">
        <div className="folder-card-details">
          <span className="folder-card-name">{folder.name}</span>
          <span className="folder-card-count">
            {folder.project_count} {folder.project_count === 1 ? 'project' : 'projects'}
          </span>
        </div>
        <Dropdown
          align="right"
          trigger={(p) => (
            <button
              className="folder-card-menu-btn"
              title="Folder options"
              aria-label="Folder options"
              {...p}
            >
              &bull;&bull;&bull;
            </button>
          )}
        >
          <DropdownItem icon={<EditIcon size={14} />} onSelect={onRename}>
            Rename
          </DropdownItem>
          <DropdownItem variant="danger" icon={<TrashIcon size={14} />} onSelect={onDelete}>
            Delete
          </DropdownItem>
        </Dropdown>
      </div>
    </div>
  );
});
