/**
 * Current-branch chip shown beside the Push button.
 *
 * The branch name is always shown — knowing which branch you're about to
 * publish from is the point of the chip, and hiding it on a clean tree let a
 * user hit Publish believing they were on main. What's conditional is the
 * *affordance*: with unsaved changes the chip opens a compact changed-files
 * review (or the shared Push menu, via `opensPushMenu`); with nothing to open
 * it degrades to a plain label rather than a button that does nothing.
 *
 * @module components/branches/BranchIndicator
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BranchIcon, FileIcon, TrashIcon } from '@/components/icons';
import type { ChangedFile, ChangeStatus } from '../../lib/git';
import { discardChanges } from '../../lib/branches';
import { DiffModal } from './DiffModal';
import { Button } from '../primitives/Button';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface BranchIndicatorProps {
  currentBranch: string;
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  projectPath: string;
  onDiscard?: () => void;
  /** Controlled open state used by the header to keep its menus exclusive. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the shared Push menu instead of rendering a second popover. */
  opensPushMenu?: boolean;
  /** Whether the current branch is explicitly known to be the live/default branch. */
  isLive?: boolean;
}

export function BranchIndicator({
  currentBranch,
  hasUncommittedChanges,
  changedFiles,
  projectPath,
  onDiscard,
  isOpen: controlledOpen,
  onOpenChange,
  opensPushMenu = false,
  isLive = false,
}: BranchIndicatorProps) {
  const { showToast } = useOptionalToast();
  const [internalOpen, setInternalOpen] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; status: ChangeStatus } | null>(
    null
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOpen = controlledOpen ?? internalOpen;

  const setOpen = useCallback(
    (open: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(open);
      onOpenChange?.(open);
      if (!open) setConfirmDiscard(false);
    },
    [controlledOpen, onOpenChange]
  );

  const closeFromOutside = useCallback(() => setOpen(false), [setOpen]);
  useClickOutside(wrapperRef, closeFromOutside, isOpen && !opensPushMenu);

  useEffect(() => {
    if (!isOpen || opensPushMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, opensPushMenu, setOpen]);

  // The changed-files popover has nothing to show once the tree is clean.
  // Doesn't apply in push-menu mode: there the open state belongs to the
  // header's Push dropdown, which is still meaningful with no changes.
  useEffect(() => {
    if (hasUncommittedChanges || opensPushMenu) return;
    setOpen(false);
  }, [hasUncommittedChanges, opensPushMenu, setOpen]);

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
      setOpen(false);
    } catch (error) {
      showToast(`Failed to discard changes: ${formatCommandError(asCommandError(error))}`, 'error');
    } finally {
      setIsDiscarding(false);
    }
  };

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
  const visibleStatus = changeCount > 0 ? `${changeCount} unsaved` : 'Unsaved';
  const accessibleStatus =
    changeCount > 0
      ? `${changeCount} unsaved ${changeCount === 1 ? 'change' : 'changes'}`
      : 'unsaved changes';

  // Clean tree and no Push menu behind the chip: there's nothing for a click
  // to open, so render the branch name as a label instead of a dead button.
  if (!hasUncommittedChanges && !opensPushMenu) {
    return (
      <div className="branch-indicator is-clean" data-education-id="branch-indicator">
        <span className="branch-indicator-label">
          <BranchIcon size={14} />
          <span className="branch-name">{currentBranch}</span>
          {isLive && <span className="branch-live-badge">Live</span>}
        </span>
      </div>
    );
  }

  return (
    <>
      <div
        className={`branch-indicator${hasUncommittedChanges ? '' : ' is-clean'}`}
        ref={wrapperRef}
        data-education-id="branch-indicator"
      >
        {opensPushMenu ? (
          <Button
            ref={triggerRef}
            className="branch-indicator-button branch-indicator-push-trigger"
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={
              hasUncommittedChanges
                ? `Open Push options for ${accessibleStatus} on ${currentBranch}`
                : `Open Push options for ${currentBranch}`
            }
            onClick={() => setOpen(!isOpen)}
            leftIcon={<BranchIcon size={14} />}
          >
            <span className="branch-name">{currentBranch}</span>
            {isLive && <span className="branch-live-badge">Live</span>}
            {hasUncommittedChanges && <span className="branch-unsaved-label">{visibleStatus}</span>}
          </Button>
        ) : (
          <Button
            ref={triggerRef}
            className="branch-indicator-button"
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={`Review ${accessibleStatus} on ${currentBranch}`}
            onClick={() => setOpen(!isOpen)}
            leftIcon={<BranchIcon size={14} />}
          >
            <span className="branch-name">{currentBranch}</span>
            {isLive && <span className="branch-live-badge">Live</span>}
            <span className="branch-unsaved-label">{visibleStatus}</span>
          </Button>
        )}

        {isOpen && !opensPushMenu && (
          <div className="branch-changes-dropdown" role="dialog" aria-label="Unsaved changes">
            <div className="branch-changes-header">
              {changeCount} Unsaved {changeCount === 1 ? 'Change' : 'Changes'}
            </div>
            {changeCount > 0 ? (
              <div className="branch-changes-list">
                {changedFiles.map((file) => (
                  <button
                    type="button"
                    key={`${file.status}:${file.path}`}
                    className="branch-changes-item branch-changes-item-clickable"
                    onClick={() => {
                      setOpen(false);
                      setSelectedFile({ path: file.path, status: file.status });
                    }}
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
            <div className="branch-changes-footer">
              <Button
                variant="danger"
                className={`branch-changes-discard-btn ${confirmDiscard ? 'confirming' : ''}`}
                leftIcon={<TrashIcon size={12} />}
                onClick={() => void handleDiscardAll()}
                disabled={isDiscarding}
              >
                {isDiscarding
                  ? 'Discarding...'
                  : confirmDiscard
                    ? 'Click to Confirm'
                    : 'Discard All'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {selectedFile && (
        <DiffModal
          projectPath={projectPath}
          filePath={selectedFile.path}
          fileStatus={selectedFile.status}
          onClose={() => {
            setSelectedFile(null);
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
