/**
 * Syntax-highlighted code viewer for the code browser.
 *
 * Uses Shiki for syntax highlighting with lazy-loaded grammars.
 * Shows placeholder states for no file selected, binary files,
 * oversized files, and loading.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FileContent } from '../lib/code';
import { checkIdeAvailability, openInIde } from '../lib/ide';
import { useClickOutside } from '../hooks/useClickOutside';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useOptionalToast } from '../contexts/ToastContext';
import { ChevronIcon, CodeIcon, FileIcon, VSCodeIcon, CursorIcon, CopyIcon } from './icons';
import { trackEvent } from '../lib/analytics';
import { fileExtensionForAnalytics } from '../lib/code';

interface CodeViewerProps {
  projectPath: string;
  filePath: string | null;
  fileContent: FileContent | null;
  isLoading: boolean;
  error: string | null;
  onSendToAgent?: (text: string) => void;
}

interface SelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
  mouseX: number;
  mouseY: number;
}

const LINE_HEIGHT = 20;
const CODE_PADDING_TOP = 12;

// Cache the highlighter instance across renders
let highlighterPromise: Promise<import('shiki').Highlighter> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark'],
        langs: [],
      })
    );
  }
  return highlighterPromise;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert a viewport Y coordinate to a 1-based line number within the code area. */
function yToLine(clientY: number, codeEl: HTMLElement, totalLines: number): number {
  const codeRect = codeEl.getBoundingClientRect();
  // Both clientY and codeRect.top are viewport coords — scroll is already accounted for
  const relativeY = clientY - codeRect.top - CODE_PADDING_TOP;
  const line = Math.floor(relativeY / LINE_HEIGHT) + 1;
  return Math.max(1, Math.min(line, totalLines));
}

export function CodeViewer({
  projectPath,
  filePath,
  fileContent,
  isLoading,
  error,
  onSendToAgent,
}: CodeViewerProps) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error' | 'info') =>
    showToast(message, type);
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
  const codeRef = useRef<HTMLDivElement>(null);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  const [showIdeDropdown, setShowIdeDropdown] = useState(false);
  const [openingIde, setOpeningIde] = useState<string | null>(null);
  const { copy } = useCopyToClipboard({
    onCopy: () => onToast?.('Copied to clipboard', 'success'),
  });

  // Selection popover state
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [question, setQuestion] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Line-level highlight overlay
  const [highlightedLines, setHighlightedLines] = useState<{ start: number; end: number } | null>(
    null
  );
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const totalLinesRef = useRef(0);
  const dragStartLineRef = useRef(0);
  const dragTextRef = useRef('');
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const dismissPopover = useCallback(() => {
    setSelectionInfo(null);
    setQuestion('');
    setPreviewExpanded(false);
    setHighlightedLines(null);
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    window.getSelection()?.removeAllRanges();
  }, []);

  useClickOutside(popoverRef, dismissPopover, selectionInfo !== null);

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

  // Scroll to top and dismiss popover when file changes
  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.scrollTop = 0;
    }
    dismissPopover();
  }, [filePath, dismissPopover]);

  // Dismiss popover on scroll
  useEffect(() => {
    const scrollEl = codeRef.current;
    if (!scrollEl || !selectionInfo) return;
    const handleScroll = () => dismissPopover();
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [selectionInfo, dismissPopover]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const codeEl = e.currentTarget as HTMLElement;
      const startLine = yToLine(e.clientY, codeEl, totalLinesRef.current);
      dragStartLineRef.current = startLine;
      dragTextRef.current = '';

      // Clear previous popover/highlight on new drag
      if (selectionInfo) {
        setSelectionInfo(null);
        setQuestion('');
        setPreviewExpanded(false);
      }
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      setHighlightedLines(null);

      const onDragMove = (moveEvent: MouseEvent) => {
        const currentLine = yToLine(moveEvent.clientY, codeEl, totalLinesRef.current);
        setHighlightedLines({
          start: Math.min(dragStartLineRef.current, currentLine),
          end: Math.max(dragStartLineRef.current, currentLine),
        });
        // Snapshot selected text during drag in case DOM changes disrupt selection later
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          dragTextRef.current = sel.toString();
        }
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        dragCleanupRef.current = null;
      };
      dragCleanupRef.current = cleanup;

      const onDragEnd = (upEvent: MouseEvent) => {
        cleanup();

        const endLine = yToLine(upEvent.clientY, codeEl, totalLinesRef.current);
        const startL = Math.min(dragStartLineRef.current, endLine);
        const endL = Math.max(dragStartLineRef.current, endLine);

        // If single-line click (no real drag), treat as click — clear and return
        if (startL === endL && Math.abs(upEvent.clientY - e.clientY) < 3) {
          setHighlightedLines(null);
          window.getSelection()?.removeAllRanges();
          return;
        }

        // Get text: prefer snapshotted drag text, fall back to extracting from content
        let text = dragTextRef.current;
        if (!text.trim() && fileContent?.content) {
          const contentLines = fileContent.content.split('\n');
          text = contentLines.slice(startL - 1, endL).join('\n');
        }

        // Clear browser selection — our overlay handles the visual highlight
        window.getSelection()?.removeAllRanges();

        setHighlightedLines({ start: startL, end: endL });
        setSelectionInfo({
          text,
          startLine: startL,
          endLine: endL,
          mouseX: upEvent.clientX,
          mouseY: upEvent.clientY,
        });
        setQuestion('');
        setPreviewExpanded(false);
      };

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    },
    [selectionInfo, fileContent?.content]
  );

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

    // Close popover but keep highlight visible briefly
    setSelectionInfo(null);
    setQuestion('');
    setPreviewExpanded(false);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedLines(null);
      highlightTimerRef.current = null;
    }, 2000);
    // `copy` from useCopyToClipboard is referentially stable across renders;
    // adding it would churn the callback identity with no behavior change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionInfo, filePath, fileContent?.language, question, onToast, onSendToAgent]);

  // Cleanup timer and drag listeners on unmount
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      dragCleanupRef.current?.();
    };
  }, []);

  // Syntax highlight the content
  useEffect(() => {
    if (!fileContent || fileContent.isBinary || fileContent.isTruncated || !fileContent.content) {
      setHighlightedHtml('');
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const highlighter = await getHighlighter();
        const lang = fileContent.language || 'plaintext';

        const loadedLangs = highlighter.getLoadedLanguages();
        if (!loadedLangs.includes(lang as import('shiki').BundledLanguage)) {
          try {
            await highlighter.loadLanguage(lang as import('shiki').BundledLanguage);
          } catch {
            // Fall back to plaintext if language not supported
          }
        }

        const effectiveLang = highlighter
          .getLoadedLanguages()
          .includes(lang as import('shiki').BundledLanguage)
          ? lang
          : 'plaintext';

        if (
          effectiveLang === 'plaintext' &&
          !highlighter.getLoadedLanguages().includes('plaintext')
        ) {
          try {
            await highlighter.loadLanguage('plaintext');
          } catch {
            // ignore
          }
        }

        const html = highlighter.codeToHtml(fileContent.content, {
          lang: effectiveLang,
          theme: 'github-dark',
        });

        if (!cancelled) {
          setHighlightedHtml(html);
        }
      } catch {
        if (!cancelled) {
          setHighlightedHtml('');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileContent]);

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
          <div className="capture-spinner" />
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

  // Render highlighted code
  const lines = fileContent?.content.split('\n') ?? [];
  totalLinesRef.current = lines.length;
  const hasIde = ideAvailability.vscode || ideAvailability.cursor;

  // Popover position: anchored to mouse release point, clamped to viewport
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
        {fileContent && <span className="code-viewer-size">{formatSize(fileContent.size)}</span>}
        {hasIde && (
          <div
            className="ide-dropdown-container"
            onMouseEnter={() => setShowIdeDropdown(true)}
            onMouseLeave={() => setShowIdeDropdown(false)}
          >
            <button className="code-viewer-open-btn" title="Open in IDE">
              <span>Open with</span>
              <ChevronIcon size={10} />
            </button>
            {showIdeDropdown && (
              <div className="ide-dropdown">
                <div className="ide-dropdown-inner">
                  {ideAvailability.vscode && (
                    <button
                      onClick={() => void handleOpenInIde('vscode')}
                      disabled={openingIde !== null}
                    >
                      <VSCodeIcon size={14} />
                      {openingIde === 'vscode' ? 'Opening...' : 'VS Code'}
                    </button>
                  )}
                  {ideAvailability.cursor && (
                    <button
                      onClick={() => void handleOpenInIde('cursor')}
                      disabled={openingIde !== null}
                    >
                      <CursorIcon size={14} />
                      {openingIde === 'cursor' ? 'Opening...' : 'Cursor'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="code-viewer-content" ref={codeRef}>
        <div className="code-viewer-code-wrapper">
          <div className="code-viewer-gutter">
            {lines.map((_, i) => (
              <div key={i} className="code-viewer-gutter-line">
                {i + 1}
              </div>
            ))}
          </div>
          <div className="code-viewer-code" onMouseDown={handleMouseDown}>
            {highlightedHtml ? (
              <div
                className="code-viewer-highlighted"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            ) : (
              <pre className="code-viewer-plain">{fileContent?.content ?? ''}</pre>
            )}
          </div>
          {highlightedLines && (
            <div className="code-selection-overlay" aria-hidden>
              {Array.from({ length: highlightedLines.end - highlightedLines.start + 1 }, (_, i) => (
                <div
                  key={highlightedLines.start + i}
                  className="code-selection-line"
                  style={{ top: CODE_PADDING_TOP + (highlightedLines.start + i - 1) * LINE_HEIGHT }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {selectionInfo &&
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
