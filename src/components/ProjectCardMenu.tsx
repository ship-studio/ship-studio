/**
 * ProjectCardMenu component - dropdown menu for project card actions.
 *
 * Provides options for:
 * - Toggling main branch warning
 * - Moving to folder / exporting as template
 * - Deleting the project
 *
 * @module components/ProjectCardMenu
 */

import { useState, useRef, useCallback } from 'react';
import {
  TrashIcon,
  FolderIcon,
  WarningIcon,
  DownloadIcon,
  CloseIcon,
  ImageIcon,
  EditIcon,
} from './icons';
import { useClickOutside } from '../hooks/useClickOutside';

interface ProjectCardMenuProps {
  /** Whether main branch warning is hidden */
  hideMainBranchWarning: boolean;
  /** Callback when main branch warning toggle is clicked */
  onToggleMainBranchWarning: (hidden: boolean) => void;
  /** Callback to rename the project (non-external projects only). When omitted,
   *  the "Rename project" item is hidden. */
  onRename?: () => void;
  /** Callback to move project to a folder */
  onMoveToFolder?: () => void;
  /** Callback to export project as a template zip */
  onExportAsTemplate?: () => void;
  /** Callback to upload a custom thumbnail image. When set, shows the
   *  "Upload new thumbnail" item; the parent owns the file picker. */
  onUploadThumbnail?: () => void;
  /** Callback when delete is clicked */
  onDelete: () => void;
  /** Whether this is an external project (shows "Remove from list" instead of delete) */
  isExternal?: boolean;
  /** Callback when remove from list is clicked (for external projects) */
  onRemove?: () => void;
  /** Whether the project is currently pinned to the rail. Optional — when
   *  omitted, the pin/unpin row is hidden entirely (legacy callers). */
  isPinned?: boolean;
  /** Toggle pin state. Receives the desired new state. */
  onTogglePin?: (pinned: boolean) => void;
}

export function ProjectCardMenu({
  hideMainBranchWarning,
  onToggleMainBranchWarning,
  onRename,
  onMoveToFolder,
  onExportAsTemplate,
  onUploadThumbnail,
  onDelete,
  isExternal,
  onRemove,
  isPinned,
  onTogglePin,
}: ProjectCardMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);
  useClickOutside(menuRef, closeMenu, isOpen);

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onDelete();
  };

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onRemove?.();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onRename?.();
  };

  const handleMoveToFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onMoveToFolder?.();
  };

  const handleToggleMainBranchWarning = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleMainBranchWarning(!hideMainBranchWarning);
    setIsOpen(false);
  };

  const handleExportAsTemplateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onExportAsTemplate?.();
  };

  const handleUploadThumbnailClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onUploadThumbnail?.();
  };

  const handleMenuButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  return (
    <div className="project-card-menu-container" ref={menuRef}>
      <button className="project-card-menu" onClick={handleMenuButtonClick} title="Project options">
        &bull;&bull;&bull;
      </button>

      {isOpen && (
        <div className="project-card-dropdown">
          <button
            className={`project-card-dropdown-item ${!hideMainBranchWarning ? 'active' : ''}`}
            onClick={handleToggleMainBranchWarning}
          >
            <WarningIcon size={14} />
            <span>Main branch warning</span>
            <span className={`toggle-indicator ${!hideMainBranchWarning ? 'on' : 'off'}`}>
              {!hideMainBranchWarning ? 'ON' : 'OFF'}
            </span>
          </button>
          {onRename && !isExternal && (
            <button className="project-card-dropdown-item" onClick={handleRenameClick}>
              <EditIcon size={14} />
              <span>Rename project</span>
            </button>
          )}
          {onMoveToFolder && (
            <button className="project-card-dropdown-item" onClick={handleMoveToFolderClick}>
              <FolderIcon size={14} />
              <span>Move to folder</span>
            </button>
          )}
          {onExportAsTemplate && (
            <button className="project-card-dropdown-item" onClick={handleExportAsTemplateClick}>
              <DownloadIcon size={14} />
              <span>Export as template</span>
            </button>
          )}
          {onUploadThumbnail && (
            <button className="project-card-dropdown-item" onClick={handleUploadThumbnailClick}>
              <ImageIcon size={14} />
              <span>Upload new thumbnail</span>
            </button>
          )}
          {onTogglePin && (
            <button
              className="project-card-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
                onTogglePin(!isPinned);
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 14, display: 'inline-block', textAlign: 'center' }}
              >
                {isPinned ? '\u25CB' : '\u25CF'}
              </span>
              <span>{isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}</span>
            </button>
          )}
          <div className="project-card-dropdown-divider" />
          {isExternal && onRemove ? (
            <button className="project-card-dropdown-item danger" onClick={handleRemoveClick}>
              <CloseIcon size={14} />
              <span>Remove from list</span>
            </button>
          ) : (
            <button className="project-card-dropdown-item danger" onClick={handleDeleteClick}>
              <TrashIcon size={14} />
              <span>Delete project</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
