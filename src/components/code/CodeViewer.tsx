/**
 * Code viewer for the code browser.
 *
 * Renders the file with a single CodeMirror surface (`CodeFileEditor`) in BOTH
 * read and edit mode, so the view is pixel-identical and only behavior changes:
 * view mode is read-only and reports text selections for the "send to agent"
 * popover; edit mode allows live editing. Shows placeholder states for no file
 * selected, binary files, oversized files, and loading.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FileContent } from '../../lib/code';
import { checkIdeAvailability, openInIde } from '../../lib/ide';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { ChevronIcon, CodeIcon, FileIcon, VSCodeIcon, CursorIcon, CopyIcon } from '../icons';
import { trackEvent } from '../../lib/analytics';
import { fileExtensionForAnalytics } from '../../lib/code';
import { CodeFileEditor } from './CodeFileEditor';
import type { SaveResult } from '../../hooks/useFileTree';

interface CodeViewerProps {
  projectPath: string;
  filePath: string | null;
  fileContent: FileContent | null;
  isLoading: boolean;
  error: string | null;
  onSendToAgent?: (text: string) => void;
  /** A 1-based line to highlight + scroll into view (jump-to-code). */
  revealLine?: number | null;
  // Inline editing (Code tab). When `isEditing`, the read-only view is replaced
  // by an editable CodeMirror surface.
  isEditing?: boolean;
  draft?: string;
  isDirty?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
  /** Discard unsaved edits (re-seeds the draft from disk while edit mode stays on). */
  onCancelEdit?: () => void;
  onDraftChange?: (value: string) => void;
  onSave?: () => Promise<SaveResult>;
  /** Global, persisted "Code tab is editable" opt-in (drives the header toggle). */
  editModeEnabled?: boolean;
  onToggleEditMode?: (enabled: boolean) => void;
}

interface SelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
  mouseX: number;
  mouseY: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CodeViewer({
  projectPath,
  filePath,
  fileContent,
  isLoading,
  error,
  onSendToAgent,
  revealLine,
  isEditing = false,
  draft = '',
  isDirty = false,
  isSaving = false,
  saveError = null,
  onCancelEdit,
  onDraftChange,
  onSave,
  editModeEnabled = false,
  onToggleEditMode,
}: CodeViewerProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  const [openingIde, setOpeningIde] = useState<string | null>(null);
  const { copy } = useCopyToClipboard({
    onCopy: () => onToast?.('Copied to clipboard', 'success'),
  });

  // Selection popover state — fed by the editor's onSelectionChange in view mode.
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [question, setQuestion] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  // ⌘S bypasses the disabled Save button, so guard against overlapping saves
  // whose disk writes could finish out of order and leave a stale draft.
  const saveInFlightRef = useRef(false);

  const dismissPopover = useCallback(() => {
    setSelectionInfo(null);
    setQuestion('');
    setPreviewExpanded(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  useClickOutside(popoverRef, dismissPopover, selectionInfo !== null);

  // The editor reports the current text selection (view mode only). Show the
  // "send to agent" popover for a non-empty selection; dismiss when it clears.
  const handleSelectionChange = useCallback((sel: SelectionInfo | null) => {
    if (!sel) {
      setSelectionInfo(null);
      return;
    }
    setSelectionInfo(sel);
    setQuestion('');
    setPreviewExpanded(false);
  }, []);

  // Check IDE availability on mount
  useEffect(() => {
    void checkIdeAvailability().then(setIdeAvailability);
  }, []);

  const handleOpenInIde = useCallback(
    async (ide: 'vscode' | 'cursor') => {
      if (!filePath) return;
      setOpeningIde(ide);
      try {
        await openInIde(projectPath, ide, filePath);
      } finally {
        setTimeout(() => setOpeningIde(null), 1500);
      }
    },
    [projectPath, filePath]
  );

  // Dismiss the popover when the file changes (scroll + reveal now live in the editor).
  useEffect(() => {
    dismissPopover();
  }, [filePath, dismissPopover]);

  const handleCopy = useCallback(() => {
    if (!selectionInfo || !filePath) return;

    const lineRef =
      selectionInfo.startLine === selectionInfo.endLine
        ? `${filePath}:${selectionInfo.startLine}`
        : `${filePath}:${selectionInfo.startLine}-${selectionInfo.endLine}`;

    const lang = fileContent?.language || '';

    const parts = [lineRef, '```' + lang, selectionInfo.text, '```'];

    if (question.trim()) {
      parts.push('', question.trim());
    }

    const formatted = parts.join('\n');

    // Selections can be inverted (drag from line 10 → line 5); abs ensures the
    // recorded count is always positive.
    const lineCount = Math.abs(selectionInfo.endLine - selectionInfo.startLine) + 1;
    if (onSendToAgent) {
      void trackEvent('code_snippet_sent_to_agent', {
        file_extension: fileExtensionForAnalytics(filePath),
        language: fileContent?.language ?? '',
        line_count: lineCount,
        char_count: formatted.length,
        had_question: question.trim().length > 0,
      });
      onSendToAgent(formatted);
      onToast?.('Sent to agent', 'success');
    } else {
      void trackEvent('code_snippet_copied', {
        file_extension: fileExtensionForAnalytics(filePath),
        line_count: lineCount,
      });
      void copy(formatted);
    }

    setSelectionInfo(null);
    setQuestion('');
    setPreviewExpanded(false);
    // `copy` from useCopyToClipboard is referentially stable across renders;
    // adding it would churn the callback identity with no behavior change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionInfo, filePath, fileContent?.language, question, onToast, onSendToAgent]);

  const handleSave = useCallback(async () => {
    if (!onSave || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      const result = await onSave();
      // 'noop' (read mode / clean buffer) is silent — only a real save toasts.
      if (result === 'saved') showToast('Saved', 'success');
      else if (result === 'error') showToast('Failed to save file', 'error');
    } finally {
      saveInFlightRef.current = false;
    }
  }, [onSave, showToast]);

  // No file selected
  if (!filePath) {
    return (
      <div className="code-viewer-placeholder">
        <CodeIcon size={32} />
        <span>Select a file to view its contents</span>
      </div>
    );
  }

  // Loading
  if (isLoading && !fileContent) {
    return (
      <div className="code-viewer">
        <div className="code-viewer-header">
          <FileIcon size={14} />
          <span className="code-viewer-path">{filePath}</span>
        </div>
        <div className="code-viewer-placeholder">
          <Spinner size="sm" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="code-viewer">
        <div className="code-viewer-header">
          <FileIcon size={14} />
          <span className="code-viewer-path">{filePath}</span>
        </div>
        <div className="code-viewer-placeholder">
          <span>Failed to read file: {error}</span>
        </div>
      </div>
    );
  }

  // File too large
  if (fileContent?.isTruncated) {
    return (
      <div className="code-viewer">
        <div className="code-viewer-header">
          <FileIcon size={14} />
          <span className="code-viewer-path">{filePath}</span>
          <span className="code-viewer-size">{formatSize(fileContent.size)}</span>
        </div>
        <div className="code-viewer-placeholder">
          <span>File is too large to display ({formatSize(fileContent.size)})</span>
        </div>
      </div>
    );
  }

  // Binary file
  if (fileContent?.isBinary) {
    return (
      <div className="code-viewer">
        <div className="code-viewer-header">
          <FileIcon size={14} />
          <span className="code-viewer-path">{filePath}</span>
          <span className="code-viewer-size">{formatSize(fileContent.size)}</span>
        </div>
        <div className="code-viewer-placeholder">
          <span>Binary file — cannot display</span>
        </div>
      </div>
    );
  }

  const hasIde = ideAvailability.vscode || ideAvailability.cursor;

  // Popover position: anchored to the selection end, clamped to viewport
  const popoverWidth = 320;
  const popoverHeight = 160;
  let popoverStyle: React.CSSProperties | undefined;
  if (selectionInfo) {
    const top = Math.max(
      8,
      Math.min(selectionInfo.mouseY + 12, window.innerHeight - popoverHeight - 8)
    );
    const left = Math.max(
      8,
      Math.min(selectionInfo.mouseX - popoverWidth / 2, window.innerWidth - popoverWidth - 8)
    );
    popoverStyle = { top, left };
  }

  const lineRefLabel = selectionInfo
    ? selectionInfo.startLine === selectionInfo.endLine
      ? `${filePath}:${selectionInfo.startLine}`
      : `${filePath}:${selectionInfo.startLine}-${selectionInfo.endLine}`
    : '';

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <FileIcon size={14} />
        <span className="code-viewer-path">{filePath}</span>
        {isDirty && <span className="code-viewer-dirty" title="Unsaved changes" aria-hidden />}
        {fileContent && <span className="code-viewer-size">{formatSize(fileContent.size)}</span>}
        <div className="code-viewer-actions">
          {isEditing && (
            // Contextual edit actions, grouped + divided from the persistent
            // controls so Save/Revert read as their own thing.
            <div className="code-viewer-edit-actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={onCancelEdit}
                disabled={!isDirty || isSaving}
              >
                Revert
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void handleSave()}
                disabled={!isDirty || isSaving}
              >
                {isSaving ? <Spinner size="sm" /> : 'Save'}
              </Button>
            </div>
          )}
          {onToggleEditMode && (
            // Same control as the visual editor's Edit toggle (shared
            // `preview-edit-toggle` classes) so the two read as one feature.
            <button
              type="button"
              className={`preview-edit-toggle${editModeEnabled ? ' active' : ''}`}
              onClick={() => onToggleEditMode(!editModeEnabled)}
              title={
                editModeEnabled
                  ? 'Edit mode on — files open editable. Click to turn off.'
                  : 'Turn on edit mode to edit files in Ship Studio'
              }
              aria-pressed={editModeEnabled}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" />
              </svg>
              <span>Edit</span>
              <span
                className={`preview-edit-toggle-switch ${editModeEnabled ? 'is-on' : ''}`}
                aria-hidden
              />
            </button>
          )}
          {hasIde && (
            // Portal mode: .code-tab clips overflow, so the menu renders fixed
            // in a body portal. Right-aligned — the button sits at the right
            // end of the viewer header (matches the old `right: 0` override).
            <Dropdown
              portal
              align="right"
              trigger={(p) => (
                <button className="code-viewer-open-btn" title="Open in IDE" {...p}>
                  <span>Open with</span>
                  <ChevronIcon size={10} />
                </button>
              )}
            >
              {ideAvailability.vscode && (
                <DropdownItem
                  icon={<VSCodeIcon size={14} />}
                  onSelect={() => void handleOpenInIde('vscode')}
                  disabled={openingIde !== null}
                >
                  {openingIde === 'vscode' ? 'Opening...' : 'VS Code'}
                </DropdownItem>
              )}
              {ideAvailability.cursor && (
                <DropdownItem
                  icon={<CursorIcon size={14} />}
                  onSelect={() => void handleOpenInIde('cursor')}
                  disabled={openingIde !== null}
                >
                  {openingIde === 'cursor' ? 'Opening...' : 'Cursor'}
                </DropdownItem>
              )}
            </Dropdown>
          )}
        </div>
      </div>
      <div className="code-viewer-editor">
        {/* One renderer for both modes — read-only when not editing, editable
            when editing — so the view is pixel-identical and only behavior
            changes. Keyed per file so each open starts a clean editor. */}
        <CodeFileEditor
          key={filePath ?? 'editor'}
          value={isEditing ? draft : (fileContent?.content ?? '')}
          editable={isEditing}
          onChange={(v) => onDraftChange?.(v)}
          language={fileContent?.language ?? 'plaintext'}
          onSave={() => void handleSave()}
          revealLine={revealLine}
          onSelectionChange={handleSelectionChange}
        />
        {isEditing && saveError && (
          <div className="code-viewer-save-error">Save failed: {saveError}</div>
        )}
      </div>
      {!isEditing &&
        selectionInfo &&
        popoverStyle &&
        createPortal(
          <div className="code-selection-popover" ref={popoverRef} style={popoverStyle}>
            <button
              className="code-selection-reference"
              onClick={() => setPreviewExpanded((p) => !p)}
            >
              <span className={`file-tree-chevron${previewExpanded ? ' expanded' : ''}`}>
                <ChevronIcon size={8} />
              </span>
              <span className="code-selection-reference-label">{lineRefLabel}</span>
            </button>
            {previewExpanded && <div className="code-selection-preview">{selectionInfo.text}</div>}
            <input
              className="code-selection-input"
              type="text"
              placeholder="Ask about this code..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCopy();
                if (e.key === 'Escape') dismissPopover();
              }}
              autoFocus
            />
            <div className="code-selection-actions">
              <button className="code-selection-cancel" onClick={dismissPopover}>
                Cancel
              </button>
              <button className="code-selection-copy" onClick={handleCopy}>
                <CopyIcon size={12} />
                Copy to agent
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
