/**
 * ImportTypePicker component - modal with two import options.
 *
 * Presents:
 * - GitHub Repository — Clone from GitHub (existing flow)
 * - Local Folder — Open an existing project from the computer
 *
 * @module components/ImportTypePicker
 */

import { GitHubIcon, FolderIcon, CloseIcon } from '../icons';

interface ImportTypePickerProps {
  /** Callback when user selects GitHub import */
  onSelectGitHub: () => void;
  /** Callback when user selects local folder import */
  onSelectLocalFolder: () => void;
  /** Callback to close the picker */
  onClose: () => void;
}

export function ImportTypePicker({
  onSelectGitHub,
  onSelectLocalFolder,
  onClose,
}: ImportTypePickerProps) {
  return (
    <div className="create-modal-overlay" onClick={onClose}>
      <div className="create-modal import-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-picker-header">
          <h2>Import Project</h2>
          <button className="import-picker-close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="import-picker-options">
          <button className="import-picker-card" onClick={onSelectGitHub}>
            <div className="import-picker-icon">
              <GitHubIcon size={28} />
            </div>
            <div className="import-picker-text">
              <span className="import-picker-title">GitHub Repository</span>
              <span className="import-picker-subtitle">Clone from GitHub</span>
            </div>
          </button>
          <button className="import-picker-card" onClick={onSelectLocalFolder}>
            <div className="import-picker-icon">
              <FolderIcon size={28} />
            </div>
            <div className="import-picker-text">
              <span className="import-picker-title">Local Folder</span>
              <span className="import-picker-subtitle">
                Open an existing project from your computer
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
