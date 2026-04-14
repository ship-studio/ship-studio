/**
 * Preview component that displays a live preview of the Next.js development server.
 *
 * This component provides:
 * - Live iframe preview of the running dev server
 * - Responsive breakpoint switching (desktop/tablet/mobile)
 * - Page navigation with route detection from Next.js app directory
 * - Screenshot capture functionality for Claude Code integration
 * - Region selection tool for cropping screenshots
 * - Automatic dev server health checking with retry logic
 *
 * @module components/Preview
 */

import { useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { usePreviewConnection, SERVER_MAX_RETRIES } from '../hooks/usePreviewConnection';
import { usePreviewCapture } from '../hooks/usePreviewCapture';
import { usePreviewResize, BREAKPOINTS, type Breakpoint } from '../hooks/usePreviewResize';
import { useOptionalToast } from '../contexts/ToastContext';

// SVG icons for breakpoints
const BreakpointIcon = ({ type }: { type: Breakpoint }) => {
  if (type === 'full') {
    // Expand/maximize icon for full width
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    );
  }
  if (type === 'desktop') {
    // Monitor with stand for desktop
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
  }
  if (type === 'laptop') {
    // Laptop icon
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <line x1="2" y1="20" x2="22" y2="20" />
      </svg>
    );
  }
  if (type === 'tablet') {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
      </svg>
    );
  }
  // Mobile
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
    </svg>
  );
};

/** Props for the Preview component */
interface PreviewProps {
  /** Dev server port (default: 3000) */
  port?: number;
  /** Absolute path to the project directory */
  projectPath: string;
  /** Callback fired when dev server becomes reachable */
  onServerReady?: () => void;
  /** Callback fired when user navigates to a different page */
  onPageChange?: (page: string) => void;
  /** Whether crop selection mode is active */
  isCropMode?: boolean;
  /** Callback fired when user starts selecting a crop region */
  onCropStart?: () => void;
  /** Callback fired when crop capture completes (or fails with null) */
  onCropComplete?: (filePath: string | null) => void;
  /** Callback fired when user cancels crop mode (Escape key) */
  onCropCancel?: () => void;
  /** Whether a branch switch is in progress */
  isBranchSwitching?: boolean;
  /** Whether the dev server is restarting */
  isDevServerRestarting?: boolean;
  /** Whether this is a static HTML project (changes loading/error messaging) */
  isStaticProject?: boolean;
  /** Extra toolbar elements to render in the center */
  toolbarExtra?: React.ReactNode;
  /** Callback to send prompt to Claude terminal */
  onSendToClaude?: (prompt: string) => void;
  /** Plugin components rendered in the preview toolbar */
  previewPlugins?: React.ReactNode;
}

/**
 * Handle exposed to parent components via ref.
 * Allows programmatic screenshot capture and refresh.
 */
export interface PreviewHandle {
  /** Capture the current preview viewport and return the saved file path */
  captureForClaude: () => Promise<string | null>;
  /** Capture the full scrollable page by scrolling and stitching */
  captureFullPage: () => Promise<string | null>;
  /** Check if a capture is currently in progress */
  isCapturing: () => boolean;
  /** Force refresh the preview iframe */
  refresh: () => void;
  /** Check if the dev server is ready and responding */
  isServerReady: () => boolean;
}

export const Preview = forwardRef<PreviewHandle, PreviewProps>(function Preview(
  {
    port = 3000,
    projectPath,
    onServerReady,
    onPageChange,
    isCropMode,
    onCropStart,
    onCropComplete,
    onCropCancel,
    isBranchSwitching = false,
    isDevServerRestarting = false,
    isStaticProject = false,
    toolbarExtra,
    onSendToClaude,
    previewPlugins,
  },
  ref
) {
  const { showToast } = useOptionalToast();
  const onToast = (message: string, type?: 'success' | 'error') => showToast(message, type);
  // Server connection, health checks, page navigation (extracted to hook)
  const conn = usePreviewConnection({
    port,
    projectPath,
    isDevServerRestarting,
    isStaticProject,
    onServerReady,
    onPageChange,
    onSendToClaude,
    onToast,
  });

  // Screenshot capture and crop selection (extracted to hook)
  const capture = usePreviewCapture({
    projectPath,
    baseUrl: conn.baseUrl,
    currentPage: conn.currentPage,
    isCropMode,
    onCropStart,
    onCropComplete,
    onCropCancel,
  });

  // Responsive viewport resizing and breakpoint switching (extracted to hook)
  const resize = usePreviewResize({
    iframeWrapperRef: capture.iframeWrapperRef,
  });

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Force refresh the preview iframe with cache busting
  // Uses currentPage (tracked via proxy) so it refreshes the actual visible page,
  // not the stale iframe src attribute (which doesn't update on client-side navigation).
  const refresh = useCallback(() => {
    if (iframeRef.current && conn.serverReady) {
      conn.setIframePath(conn.currentPage);
      const refreshUrl = `${conn.baseUrl}${conn.currentPage === '/' ? '' : conn.currentPage}?_cb=${Date.now()}&shipstudio=1`;
      iframeRef.current.src = 'about:blank';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = refreshUrl;
        }
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specific conn properties are listed; conn object changes on every render
  }, [conn.serverReady, conn.baseUrl, conn.currentPage, conn.setIframePath]);

  // Expose methods to parent
  useImperativeHandle(
    ref,
    () => ({
      captureForClaude: capture.captureForClaude,
      captureFullPage: capture.captureFullPage,
      isCapturing: () => capture.isCapturing,
      refresh,
      isServerReady: () => conn.serverReady,
    }),
    [
      capture.captureForClaude,
      capture.captureFullPage,
      capture.isCapturing,
      refresh,
      conn.serverReady,
    ]
  );

  if (conn.isLoading) {
    return (
      <div className="preview-loading">
        <div className="spinner" />
        <p>{isStaticProject ? 'Starting preview...' : 'Starting dev server...'}</p>
        <p className="hint">Waiting for localhost:{port}</p>
        <p className="hint" style={{ marginTop: 8, fontSize: 11 }}>
          {conn.retryCount > 0 && `Attempt ${conn.retryCount}/${SERVER_MAX_RETRIES}`}
        </p>
      </div>
    );
  }

  if (conn.hasError) {
    return (
      <div className="preview-error">
        <p>{isStaticProject ? 'Could not start preview' : 'Could not connect to dev server'}</p>
        <p className="hint">
          {isStaticProject
            ? 'Make sure the project contains an index.html file'
            : 'Ask Claude to run: npm run dev'}
        </p>
        <button onClick={conn.handleRetry}>Retry</button>
      </div>
    );
  }

  return (
    <div className="preview-container">
      <div className="preview-toolbar">
        {/* Page Switcher */}
        <div className="page-switcher" ref={conn.dropdownRef} data-education-id="page-switcher">
          <button
            className="page-switcher-btn"
            onClick={() => conn.setShowPageDropdown(!conn.showPageDropdown)}
          >
            <span className="page-route">{conn.currentPage}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {conn.showPageDropdown && (
            <div className="page-dropdown">
              <input
                ref={conn.searchInputRef}
                type="text"
                className="page-search"
                placeholder="Search pages..."
                value={conn.pageSearch}
                onChange={(e) => conn.setPageSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && conn.filteredPages.length > 0) {
                    conn.handlePageSelect(conn.filteredPages[0].route);
                  }
                  if (e.key === 'Escape') {
                    conn.setShowPageDropdown(false);
                    conn.setPageSearch('');
                  }
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="page-list">
                {conn.filteredPages.length === 0 ? (
                  <div className="page-list-empty">No pages found</div>
                ) : (
                  conn.filteredPages.map((page) => (
                    <button
                      key={page.route}
                      className={`page-item ${page.route === conn.currentPage ? 'active' : ''}`}
                      onClick={() => conn.handlePageSelect(page.route)}
                    >
                      {page.route}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          className="preview-refresh"
          onClick={conn.handleRefresh}
          title="Refresh preview"
          data-education-id="preview-refresh"
        >
          ↻
        </button>

        {toolbarExtra && <div className="preview-toolbar-center">{toolbarExtra}</div>}

        {previewPlugins}

        <div className="preview-breakpoints" data-education-id="breakpoints">
          {(Object.keys(BREAKPOINTS) as Breakpoint[]).map((bp) => {
            // Always show 'full' - it adapts to any size
            // Hide other breakpoints if they won't fit in the viewport
            if (bp !== 'full') {
              const bpWidth = parseInt(BREAKPOINTS[bp].width, 10);
              if (resize.viewportWidth > 0 && bpWidth > resize.viewportWidth) {
                return null;
              }
            }
            return (
              <button
                key={bp}
                className={`breakpoint-btn ${resize.getActiveBreakpoint() === bp ? 'active' : ''}`}
                onClick={() => resize.handleBreakpointClick(bp)}
                title={`${BREAKPOINTS[bp].label} (${BREAKPOINTS[bp].width})`}
              >
                <BreakpointIcon type={bp} />
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="preview-viewport"
        ref={resize.setViewportRefs}
        data-education-id="preview-viewport"
      >
        {/* Overlay to capture mouse events during resize */}
        {resize.isResizing && <div className="preview-resize-overlay" />}
        <div
          ref={capture.iframeWrapperRef}
          className="preview-iframe-wrapper"
          style={{
            width: resize.customWidth === null ? 'calc(100% - 12px)' : `${resize.customWidth}px`,
            maxWidth: 'calc(100% - 12px)',
          }}
        >
          <iframe
            key={projectPath}
            ref={iframeRef}
            src={conn.serverReady ? conn.currentUrl : 'about:blank'}
            className="preview-iframe"
            title="Preview"
          />
          {/* Branch switching overlay */}
          {isBranchSwitching && (
            <div className="preview-branch-switching-overlay">
              <div className="preview-branch-switching-spinner" />
              <span>Switching branch...</span>
            </div>
          )}
          {/* Dev server restarting overlay */}
          {isDevServerRestarting && (
            <div className="preview-branch-switching-overlay">
              <div className="preview-branch-switching-spinner" />
              <span>Restarting dev server...</span>
            </div>
          )}
          {/* Crop selection overlay */}
          {isCropMode && (
            <div
              ref={capture.cropOverlayRef}
              className="crop-overlay"
              onMouseDown={capture.handleCropMouseDown}
              onMouseMove={capture.handleCropMouseMove}
              onMouseUp={() => void capture.handleCropMouseUp()}
              onMouseLeave={() => {
                if (capture.isSelecting) {
                  void capture.handleCropMouseUp();
                }
              }}
            >
              {/* Selection rectangle */}
              {/* Selection box with box-shadow creating the dark overlay */}
              {capture.selectionStart && capture.selectionEnd && (
                <div
                  className="crop-selection"
                  style={{
                    left: Math.min(capture.selectionStart.x, capture.selectionEnd.x),
                    top: Math.min(capture.selectionStart.y, capture.selectionEnd.y),
                    width: Math.abs(capture.selectionEnd.x - capture.selectionStart.x),
                    height: Math.abs(capture.selectionEnd.y - capture.selectionStart.y),
                  }}
                />
              )}
              {/* Instructions */}
              {!capture.selectionStart && (
                <div className="crop-instructions">
                  Click and drag to select area
                  <span className="crop-hint">Press Esc to cancel</span>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Resize handle */}
        <div className="preview-resize-handle" onMouseDown={resize.handleResizeStart}>
          <div className="preview-resize-handle-bar" />
        </div>
      </div>
    </div>
  );
});
