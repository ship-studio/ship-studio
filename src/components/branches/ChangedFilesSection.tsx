import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileIcon, TrashIcon } from '@/components/icons';
import type { ChangedFile, ChangeStatus } from '../../lib/git';
import { discardChanges } from '../../lib/branches';
import { DiffModal } from './DiffModal';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface ChangedFilesSectionProps {
  changedFiles: ChangedFile[];
  projectPath: string;
}

interface ChangedFilesActionsProps {
  projectPath: string;
  onDiscard?: () => void;
  primaryAction: ReactNode;
}

/** Renders the bulk actions available for the current changed-file selection. */
export function ChangedFilesActions({
  projectPath,
  onDiscard,
  primaryAction,
}: ChangedFilesActionsProps) {
  const { showToast } = useOptionalToast();
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    },
    []
  );

  const handleDiscardAll = async () => {
    if (isDiscarding) return;
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => setConfirmDiscard(false), 3000);
      return;
    }

    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setConfirmDiscard(false);
    setIsDiscarding(true);
    try {
      await discardChanges(projectPath);
      showToast('All changes discarded', 'success');
      onDiscard?.();
    } catch (error) {
      showToast(`Failed to discard changes: ${formatCommandError(asCommandError(error))}`, 'error');
    } finally {
      setIsDiscarding(false);
    }
  };

  return (
    <div className="publish-actions publish-changes-actions">
      <Button
        variant="danger"
        className={`branch-changes-discard-btn ${confirmDiscard ? 'confirming' : ''}`}
        leftIcon={<TrashIcon size={12} />}
        onClick={() => void handleDiscardAll()}
        disabled={isDiscarding}
      >
        {isDiscarding ? 'Discarding...' : confirmDiscard ? 'Click to Confirm' : 'Discard All'}
      </Button>
      {primaryAction}
    </div>
  );
}

/** Presents changed files for a project with selection and discard controls. */
export function ChangedFilesSection({ changedFiles, projectPath }: ChangedFilesSectionProps) {
  const [selectedFile, setSelectedFile] = useState<{ path: string; status: ChangeStatus } | null>(
    null
  );

  const getStatusIndicator = (status: ChangeStatus) => {
    switch (status) {
      case 'added':
      case 'untracked':
        return <span className="change-status change-added">+</span>;
      case 'deleted':
        return <span className="change-status change-deleted">-</span>;
      case 'renamed':
        return <span className="change-status change-renamed">R</span>;
      default:
        return <span className="change-status change-modified">M</span>;
    }
  };

  const getFileName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? path;
  };

  const getDirectory = (path: string) => {
    const parts = path.split('/');
    return parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
  };

  const changeCount = changedFiles.length;

  return (
    <>
      <section className="publish-changes-section" aria-labelledby="publish-changes-heading">
        <div className="branch-changes-header" id="publish-changes-heading">
          {changeCount} Unsaved {changeCount === 1 ? 'Change' : 'Changes'}
        </div>
        {changeCount > 0 ? (
          <div className="branch-changes-list">
            {changedFiles.map((file) => (
              <button
                type="button"
                key={`${file.status}:${file.path}`}
                className="branch-changes-item branch-changes-item-clickable"
                onClick={() => setSelectedFile({ path: file.path, status: file.status })}
              >
                {getStatusIndicator(file.status)}
                <FileIcon size={12} />
                <span className="branch-changes-path">
                  <span className="branch-changes-dir">{getDirectory(file.path)}</span>
                  <span className="branch-changes-filename">{getFileName(file.path)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="branch-changes-empty">
            Git reports unsaved changes, but no changed-file details are available.
          </div>
        )}
      </section>

      {selectedFile && (
        <DiffModal
          projectPath={projectPath}
          filePath={selectedFile.path}
          fileStatus={selectedFile.status}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </>
  );
}
