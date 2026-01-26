/**
 * Merge conflict resolution modal.
 *
 * Provides a user-friendly interface for resolving git merge conflicts
 * without requiring users to understand git internals.
 *
 * @module components/ConflictResolutionModal
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ConflictedFile,
  getConflictInfo,
  resolveConflict,
  abortMerge,
  completeMerge,
} from '../lib/conflicts';
import { WarningIcon, CopyIcon, ChevronIcon, InfoIcon } from './icons';

interface ConflictResolutionModalProps {
  projectPath: string;
  onClose: () => void;
  onResolved: () => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

/** Maximum lines to show before truncating with "and X more lines" */
const MAX_PREVIEW_LINES = 20;

export function ConflictResolutionModal({
  projectPath,
  onClose,
  onResolved,
  onToast,
}: ConflictResolutionModalProps) {
  const [files, setFiles] = useState<ConflictedFile[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [showMoreInfo, setShowMoreInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConflicts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const conflictInfo = await getConflictInfo(projectPath);
      setFiles(conflictInfo);
      if (conflictInfo.length === 0) {
        // No conflicts found - merge may already be resolved
        onToast?.('No conflicts found', 'success');
        onResolved();
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, onToast, onResolved, onClose]);

  // Load conflict info on mount
  useEffect(() => {
    void loadConflicts();
  }, [loadConflicts]);

  const currentFile = files[currentFileIndex];
  const currentConflict = currentFile?.conflicts[currentConflictIndex];

  // Calculate total conflicts and current position
  const totalConflicts = files.reduce((sum, f) => sum + f.conflicts.length, 0);
  const currentConflictNumber =
    files.slice(0, currentFileIndex).reduce((sum, f) => sum + f.conflicts.length, 0) +
    currentConflictIndex +
    1;

  const handleResolve = useCallback(
    async (resolution: 'current' | 'incoming') => {
      if (!currentFile || isApplying) return;

      setIsApplying(true);
      try {
        await resolveConflict(projectPath, currentFile.filePath, currentConflictIndex, resolution);

        // Reload conflicts to get updated state
        const updatedFiles = await getConflictInfo(projectPath);
        setFiles(updatedFiles);

        if (updatedFiles.length === 0) {
          // All conflicts resolved - complete the merge
          await completeMerge(projectPath);
          onToast?.('All conflicts resolved!', 'success');
          onResolved();
          onClose();
          return;
        }

        // Find next conflict to resolve
        // First check if current file still has conflicts
        const updatedCurrentFile = updatedFiles.find((f) => f.filePath === currentFile.filePath);

        if (updatedCurrentFile && updatedCurrentFile.conflicts.length > 0) {
          // Stay on this file, reset to first conflict (since indices shift after resolution)
          const newFileIndex = updatedFiles.findIndex((f) => f.filePath === currentFile.filePath);
          setCurrentFileIndex(newFileIndex);
          setCurrentConflictIndex(0);
        } else {
          // Move to next file
          if (currentFileIndex < updatedFiles.length) {
            setCurrentFileIndex(Math.min(currentFileIndex, updatedFiles.length - 1));
            setCurrentConflictIndex(0);
          }
        }
      } catch (e) {
        onToast?.(e instanceof Error ? e.message : 'Failed to resolve conflict', 'error');
      } finally {
        setIsApplying(false);
      }
    },
    [
      currentFile,
      currentFileIndex,
      currentConflictIndex,
      projectPath,
      onClose,
      onResolved,
      onToast,
      isApplying,
    ]
  );

  const handleAbort = useCallback(async () => {
    if (isApplying) return;

    setIsApplying(true);
    try {
      await abortMerge(projectPath);
      onToast?.('Merge aborted', 'success');
      onClose();
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to abort merge', 'error');
    } finally {
      setIsApplying(false);
    }
  }, [projectPath, onClose, onToast, isApplying]);

  // Close handler - abort merge when closing without resolving
  const handleClose = useCallback(() => {
    if (isApplying) return;
    void handleAbort();
  }, [isApplying, handleAbort]);

  const handleCopyForClaude = useCallback(() => {
    if (!currentFile || !currentConflict) return;

    const prompt = `I have a merge conflict in ${currentFile.filePath} that I need help resolving.

**Current version (${currentFile.oursBranch}):**
\`\`\`
${currentConflict.currentContent}
\`\`\`

**Incoming version (${currentFile.theirsBranch}):**
\`\`\`
${currentConflict.incomingContent}
\`\`\`

${currentConflict.contextBefore ? `**Context before:**\n\`\`\`\n${currentConflict.contextBefore}\n\`\`\`\n` : ''}
${currentConflict.contextAfter ? `**Context after:**\n\`\`\`\n${currentConflict.contextAfter}\n\`\`\`\n` : ''}
Please help me understand what each version does and recommend which one to keep, or suggest a manual merge if both changes are needed.`;

    void navigator.clipboard.writeText(prompt);
    onToast?.('Copied to clipboard', 'success');
  }, [currentFile, currentConflict, onToast]);

  const truncateContent = (content: string): { text: string; truncated: number } => {
    const lines = content.split('\n');
    if (lines.length <= MAX_PREVIEW_LINES) {
      return { text: content, truncated: 0 };
    }
    return {
      text: lines.slice(0, MAX_PREVIEW_LINES).join('\n'),
      truncated: lines.length - MAX_PREVIEW_LINES,
    };
  };

  if (isLoading) {
    return (
      <div className="conflict-modal" onClick={handleClose}>
        <div className="conflict-content" onClick={(e) => e.stopPropagation()}>
          <div className="conflict-loading">
            <div className="conflict-spinner" />
            <p>Analyzing conflicts...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="conflict-modal" onClick={handleClose}>
        <div className="conflict-content" onClick={(e) => e.stopPropagation()}>
          <div className="conflict-error">
            <WarningIcon size={32} />
            <p>{error}</p>
            <button className="conflict-btn secondary" onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!currentFile || !currentConflict) {
    return null;
  }

  const currentTruncated = truncateContent(currentConflict.currentContent);
  const incomingTruncated = truncateContent(currentConflict.incomingContent);

  // Check for deleted content
  const isCurrentDeleted = !currentConflict.currentContent.trim();
  const isIncomingDeleted = !currentConflict.incomingContent.trim();

  return (
    <div className="conflict-modal" onClick={handleClose}>
      <div className="conflict-content conflict-content-wide" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="conflict-header">
          <div className="conflict-header-icon">
            <WarningIcon size={20} />
          </div>
          <div className="conflict-header-text">
            <h2>This file has conflicting changes</h2>
            <p className="conflict-file-info">
              <span className="conflict-file-name">{currentFile.filePath}</span>
              <span className="conflict-progress">
                {totalConflicts > 1 && `Conflict ${currentConflictNumber} of ${totalConflicts}`}
              </span>
            </p>
          </div>
        </div>

        {/* Explanation */}
        <div className="conflict-explanation">
          Someone else changed the same part of this file. Choose which version to keep.
        </div>

        {/* Binary file handling */}
        {currentFile.isBinary ? (
          <div className="conflict-binary">
            <p>This is a binary file. You'll need to resolve this conflict manually.</p>
            <button className="conflict-btn secondary" onClick={() => void handleAbort()}>
              Abort Merge
            </button>
          </div>
        ) : (
          <>
            {/* Side-by-side panels */}
            <div className="conflict-panels">
              {/* Current (Ours) panel */}
              <div className="conflict-panel">
                <div className="conflict-panel-header yours">
                  YOUR VERSION
                  <span className="conflict-branch-name">{currentFile.oursBranch}</span>
                </div>
                <div className="conflict-panel-content">
                  {isCurrentDeleted ? (
                    <span className="conflict-deleted">(deleted)</span>
                  ) : (
                    <>
                      <pre>{currentTruncated.text}</pre>
                      {currentTruncated.truncated > 0 && (
                        <div className="conflict-truncated">
                          ... and {currentTruncated.truncated} more lines
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Incoming (Theirs) panel */}
              <div className="conflict-panel">
                <div className="conflict-panel-header theirs">
                  THEIR VERSION
                  <span className="conflict-branch-name">{currentFile.theirsBranch}</span>
                </div>
                <div className="conflict-panel-content">
                  {isIncomingDeleted ? (
                    <span className="conflict-deleted">(deleted)</span>
                  ) : (
                    <>
                      <pre>{incomingTruncated.text}</pre>
                      {incomingTruncated.truncated > 0 && (
                        <div className="conflict-truncated">
                          ... and {incomingTruncated.truncated} more lines
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="conflict-actions">
              <button
                className="conflict-btn yours"
                onClick={() => void handleResolve('current')}
                disabled={isApplying}
              >
                {isApplying ? 'Applying...' : 'Keep Yours'}
              </button>
              <button
                className="conflict-btn theirs"
                onClick={() => void handleResolve('incoming')}
                disabled={isApplying}
              >
                {isApplying ? 'Applying...' : 'Keep Theirs'}
              </button>
            </div>

            {/* Callout tip with Copy for Claude */}
            <div className="conflict-callout">
              <span className="conflict-callout-icon">
                <InfoIcon size={16} />
              </span>
              <span>
                If this is a more complicated conflict and you need both changes, copy the details
                and ask Claude to help merge them manually.
              </span>
              <button className="conflict-copy-btn" onClick={handleCopyForClaude}>
                <CopyIcon size={12} />
                Copy for Claude
              </button>
            </div>

            {/* More information section */}
            <div className="conflict-more-info">
              <button
                className="conflict-more-toggle"
                onClick={() => setShowMoreInfo(!showMoreInfo)}
              >
                <span className={`conflict-toggle-chevron ${showMoreInfo ? 'expanded' : ''}`}>
                  <ChevronIcon size={12} />
                </span>
                More information
              </button>

              {showMoreInfo && (
                <div className="conflict-more-content">
                  {currentConflict.contextBefore && (
                    <div className="conflict-context">
                      <div className="conflict-context-label">Context before:</div>
                      <pre>{currentConflict.contextBefore}</pre>
                    </div>
                  )}

                  <div className="conflict-diff">
                    <div className="conflict-diff-section">
                      <div className="conflict-diff-label yours">Your version:</div>
                      <pre>{currentConflict.currentContent || '(empty)'}</pre>
                    </div>
                    <div className="conflict-diff-section">
                      <div className="conflict-diff-label theirs">Their version:</div>
                      <pre>{currentConflict.incomingContent || '(empty)'}</pre>
                    </div>
                  </div>

                  {currentConflict.contextAfter && (
                    <div className="conflict-context">
                      <div className="conflict-context-label">Context after:</div>
                      <pre>{currentConflict.contextAfter}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="conflict-footer">
          <button
            className="conflict-btn danger-outline"
            onClick={() => void handleAbort()}
            disabled={isApplying}
          >
            Abort Merge
          </button>
        </div>
      </div>
    </div>
  );
}
