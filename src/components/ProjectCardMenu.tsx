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

import {
  TrashIcon,
  FolderIcon,
  WarningIcon,
  DownloadIcon,
  CloseIcon,
  ImageIcon,
  EditIcon,
} from './icons';
import { Dropdown, DropdownItem, DropdownDivider } from './primitives/Dropdown';

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
  return (
    <div className="project-card-menu-container">
      <Dropdown
        align="right"
        trigger={(p) => (
          <button
            className="project-card-menu"
            title="Project options"
            aria-label="Project options"
            {...p}
          >
            &bull;&bull;&bull;
          </button>
        )}
      >
        <DropdownItem
          icon={<WarningIcon size={14} />}
          onSelect={() => onToggleMainBranchWarning(!hideMainBranchWarning)}
        >
          <span>Main branch warning</span>
          <span className={`toggle-indicator ${!hideMainBranchWarning ? 'on' : 'off'}`}>
            {!hideMainBranchWarning ? 'ON' : 'OFF'}
          </span>
        </DropdownItem>
        {onRename && !isExternal && (
          <DropdownItem icon={<EditIcon size={14} />} onSelect={onRename}>
            <span>Rename project</span>
          </DropdownItem>
        )}
        {onMoveToFolder && (
          <DropdownItem icon={<FolderIcon size={14} />} onSelect={onMoveToFolder}>
            <span>Move to folder</span>
          </DropdownItem>
        )}
        {onExportAsTemplate && (
          <DropdownItem icon={<DownloadIcon size={14} />} onSelect={onExportAsTemplate}>
            <span>Export as template</span>
          </DropdownItem>
        )}
        {onUploadThumbnail && (
          <DropdownItem icon={<ImageIcon size={14} />} onSelect={onUploadThumbnail}>
            <span>Upload new thumbnail</span>
          </DropdownItem>
        )}
        {onTogglePin && (
          <DropdownItem
            icon={
              <span
                aria-hidden="true"
                style={{ width: 14, display: 'inline-block', textAlign: 'center' }}
              >
                {isPinned ? '○' : '●'}
              </span>
            }
            onSelect={() => onTogglePin(!isPinned)}
          >
            <span>{isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}</span>
          </DropdownItem>
        )}
        <DropdownDivider />
        {isExternal && onRemove ? (
          <DropdownItem variant="danger" icon={<CloseIcon size={14} />} onSelect={onRemove}>
            <span>Remove from list</span>
          </DropdownItem>
        ) : (
          <DropdownItem variant="danger" icon={<TrashIcon size={14} />} onSelect={onDelete}>
            <span>Delete project</span>
          </DropdownItem>
        )}
      </Dropdown>
    </div>
  );
}
