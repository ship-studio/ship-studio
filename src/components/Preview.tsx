/**
 * Preview component that displays a live preview of the Next.js development server.
 *
 * This component provides:
 * - Live iframe preview of the running dev server
 * - Responsive breakpoint switching (desktop/tablet/mobile)
 * - Page navigation with route detection from Next.js app directory
 * - Screenshot capture functionality for Claude Code integration
 * - Region selection tool for cropping screenshots
 * - Sanity CMS integration with native webview modal
 * - Automatic dev server health checking with retry logic
 *
 * @module components/Preview
 */

import { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useClickOutside } from '../hooks/useClickOutside';

/** How often to refresh the page list (ms) */
const PAGE_REFRESH_INTERVAL_MS = 5000;
/** Timeout for dev server health check requests (ms) */
const SERVER_CHECK_TIMEOUT_MS = 3000;
/** Maximum retries before showing error state */
const SERVER_MAX_RETRIES = 60;

/** Responsive breakpoint options */
type Breakpoint = 'desktop' | 'tablet' | 'mobile';

/** Information about a Next.js page/route */
interface PageInfo {
  /** The URL route (e.g., "/", "/about", "/blog/[slug]") */
  route: string;
  /** Absolute path to the page file */
  file_path: string;
}

const BREAKPOINTS: Record<Breakpoint, { width: string; label: string }> = {
  desktop: { width: '100%', label: 'Desktop' },
  tablet: { width: '768px', label: 'Tablet' },
  mobile: { width: '375px', label: 'Mobile' },
};

// SVG icons for breakpoints
const BreakpointIcon = ({ type }: { type: Breakpoint }) => {
  if (type === 'desktop') {
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
}

/**
 * Handle exposed to parent components via ref.
 * Allows programmatic screenshot capture and refresh.
 */
export interface PreviewHandle {
  /** Capture the current preview viewport and return the saved file path */
  captureForClaude: () => Promise<string | null>;
  /** Check if a capture is currently in progress */
  isCapturing: () => boolean;
  /** Force refresh the preview iframe */
  refresh: () => void;
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
  },
  ref
) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [serverReady, setServerReady] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPage, setCurrentPage] = useState('/');
  const [hasSanity, setHasSanity] = useState(false);
  const [sanityMissingEnvKeys, setSanityMissingEnvKeys] = useState<string[]>([]);
  const [showEnvWarning, setShowEnvWarning] = useState(false);
  const [showPageDropdown, setShowPageDropdown] = useState(false);
  const [pageSearch, setPageSearch] = useState('');
  const [showCmsModal, setShowCmsModal] = useState(false);
  const [cmsWebviewReady, setCmsWebviewReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  // Crop selection state
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cmsModalRef = useRef<HTMLDivElement>(null);
  const cropOverlayRef = useRef<HTMLDivElement>(null);

  // Dev server URL (for health checks and page loading)
  const devServerUrl = `http://localhost:${port}`;
  // Cache-buster to prevent showing stale content when switching projects
  const [cacheBuster, setCacheBuster] = useState(() => Date.now());
  // For now, always use dev server directly (proxy disabled due to issues)
  // Add shipstudio=1 param so sites can detect they're in Ship Studio preview (e.g., to disable iframe detection)
  const currentUrl = `${devServerUrl}${currentPage === '/' ? '' : currentPage}?_cb=${cacheBuster}&shipstudio=1`;

  // Reset state when project or port changes
  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    setServerReady(false);
    setRetryCount(-1); // -1 = not checking yet
    setCurrentPage('/');
    setPages([]);
    setHasSanity(false);
    setSanityMissingEnvKeys([]);
    setShowEnvWarning(false);
    setShowPageDropdown(false);
    setPageSearch('');
    setShowCmsModal(false);
    setCmsWebviewReady(false);
    setCacheBuster(Date.now()); // New cache-buster for new project

    // Delay server check to allow old dev server to terminate
    const timer = setTimeout(() => setRetryCount(0), 1500);
    return () => clearTimeout(timer);
  }, [projectPath, port]);

  // Load pages
  const loadPages = useCallback(async () => {
    try {
      const pageList = await invoke<PageInfo[]>('list_pages', { projectPath });
      setPages(pageList);
    } catch (error) {
      console.error('Failed to load pages:', error);
    }
  }, [projectPath]);

  // Load pages on mount and periodically
  useEffect(() => {
    void loadPages();
    const interval = setInterval(() => void loadPages(), PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectPath, loadPages]);

  // Check for Sanity CMS (on interval to detect when added)
  useEffect(() => {
    const checkSanity = async () => {
      if (!projectPath) return;
      try {
        const installed = await invoke<boolean>('check_sanity_installed', { projectPath });
        setHasSanity(installed);
        if (installed) {
          const missing = await invoke<string[]>('check_sanity_env_keys', { projectPath });
          setSanityMissingEnvKeys(missing);
        } else {
          setSanityMissingEnvKeys([]);
        }
      } catch {
        setHasSanity(false);
        setSanityMissingEnvKeys([]);
      }
    };

    void checkSanity();
    const interval = setInterval(() => void checkSanity(), PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectPath]);

  // Close dropdown when clicking outside
  const closePageDropdown = useCallback(() => {
    setShowPageDropdown(false);
    setPageSearch('');
  }, []);
  useClickOutside(dropdownRef, closePageDropdown, showPageDropdown);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (showPageDropdown && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showPageDropdown]);

  // Notify parent when server becomes ready
  useEffect(() => {
    if (serverReady && onServerReady) {
      onServerReady();
    }
  }, [serverReady, onServerReady]);

  // Notify parent when page changes
  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  useEffect(() => {
    // Skip if not ready to check yet (-1 means waiting for old server to die)
    if (retryCount < 0) return;

    const checkServer = async () => {
      setIsLoading(true);
      setHasError(false);
      setServerReady(false);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);

        await fetch(devServerUrl, {
          mode: 'no-cors',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        setIsLoading(false);
        setHasError(false);
        setServerReady(true);
      } catch {
        if (retryCount < SERVER_MAX_RETRIES) {
          setTimeout(() => setRetryCount((c) => c + 1), 1000);
        } else {
          setIsLoading(false);
          setHasError(true);
        }
      }
    };

    void checkServer();
  }, [devServerUrl, retryCount]);

  // Periodic health check after server is ready - detect if it crashes
  useEffect(() => {
    if (!serverReady) return;

    const healthCheck = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);

        await fetch(devServerUrl, {
          mode: 'no-cors',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
      } catch {
        // Server stopped responding - show error state
        console.warn('[Preview] Dev server health check failed - server may have crashed');
        setServerReady(false);
        setHasError(true);
        setIsLoading(false);
      }
    };

    // Check every 10 seconds while server is ready
    const interval = setInterval(() => void healthCheck(), 10000);
    return () => clearInterval(interval);
  }, [serverReady, devServerUrl]);

  const handleRefresh = () => {
    setCacheBuster(Date.now());
  };

  const handlePageSelect = (route: string) => {
    setCurrentPage(route);
    setShowPageDropdown(false);
    setPageSearch('');
    // Update cache-buster to force reload with new page
    setCacheBuster(Date.now());
  };

  // Shared helper: capture the current window and return the temp file path
  const captureWindowScreenshot = useCallback(async (): Promise<string | null> => {
    const { getScreenshotableWindows, getWindowScreenshot } =
      await import('tauri-plugin-screenshots-api');

    const windows = await getScreenshotableWindows();
    const ourWindow = windows.find(
      (w) =>
        w.title?.toLowerCase().includes('ship studio') || w.title?.toLowerCase().includes('tauri')
    );

    if (!ourWindow) {
      return null;
    }

    return await getWindowScreenshot(ourWindow.id);
  }, []);

  // Capture preview screenshot using Tauri window capture + crop
  const captureForClaude = useCallback(async (): Promise<string | null> => {
    if (!iframeWrapperRef.current || isCapturing) {
      return null;
    }

    setIsCapturing(true);
    try {
      const tempPath = await captureWindowScreenshot();
      if (!tempPath) return null;

      // Get the iframe's bounding rect and account for device pixel ratio
      const rect = iframeWrapperRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Crop to iframe bounds and save
      const finalPath = await invoke<string>('crop_and_save_screenshot', {
        projectPath,
        sourcePath: tempPath,
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      });

      return finalPath;
    } catch (error) {
      console.error('[Preview] Capture failed:', error);
      return null;
    } finally {
      setIsCapturing(false);
    }
  }, [projectPath, captureWindowScreenshot, isCapturing]);

  // Capture a specific region of the preview
  const captureRegion = useCallback(
    async (
      regionX: number,
      regionY: number,
      regionWidth: number,
      regionHeight: number
    ): Promise<string | null> => {
      if (!iframeWrapperRef.current) {
        return null;
      }

      try {
        const tempPath = await captureWindowScreenshot();
        if (!tempPath) return null;

        // Get the iframe's position relative to the window
        const iframeRect = iframeWrapperRef.current.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Calculate absolute position of the selection within the window
        const absoluteX = Math.round((iframeRect.left + regionX) * dpr);
        const absoluteY = Math.round((iframeRect.top + regionY) * dpr);
        const width = Math.round(regionWidth * dpr);
        const height = Math.round(regionHeight * dpr);

        // Crop to selection bounds and save
        const finalPath = await invoke<string>('crop_and_save_screenshot', {
          projectPath,
          sourcePath: tempPath,
          x: absoluteX,
          y: absoluteY,
          width,
          height,
        });

        return finalPath;
      } catch (error) {
        console.error('[Preview] Region capture failed:', error);
        return null;
      }
    },
    [projectPath, captureWindowScreenshot]
  );

  // Handle crop selection mouse events
  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cropOverlayRef.current) return;
    const rect = cropOverlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSelectionStart({ x, y });
    setSelectionEnd({ x, y });
    setIsSelecting(true);
  }, []);

  const handleCropMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelecting || !cropOverlayRef.current) return;
      const rect = cropOverlayRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
      setSelectionEnd({ x, y });
    },
    [isSelecting]
  );

  const handleCropMouseUp = useCallback(async () => {
    if (!isSelecting || !selectionStart || !selectionEnd) return;
    setIsSelecting(false);

    // Calculate selection bounds
    const x = Math.min(selectionStart.x, selectionEnd.x);
    const y = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);

    // Minimum selection size
    if (width < 10 || height < 10) {
      setSelectionStart(null);
      setSelectionEnd(null);
      return;
    }

    // Store bounds before resetting state
    const bounds = { x, y, width, height };

    // Reset selection state and notify parent immediately (hides overlay, shows loading)
    setSelectionStart(null);
    setSelectionEnd(null);
    onCropStart?.();

    // Capture the selected region
    const filePath = await captureRegion(bounds.x, bounds.y, bounds.width, bounds.height);

    // Notify parent with the result
    onCropComplete?.(filePath);
  }, [isSelecting, selectionStart, selectionEnd, captureRegion, onCropStart, onCropComplete]);

  // Handle escape key to cancel crop mode
  useEffect(() => {
    if (!isCropMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectionStart(null);
        setSelectionEnd(null);
        setIsSelecting(false);
        onCropCancel?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCropMode, onCropCancel]);

  // Reset selection when crop mode changes
  useEffect(() => {
    if (!isCropMode) {
      setSelectionStart(null);
      setSelectionEnd(null);
      setIsSelecting(false);
    }
  }, [isCropMode]);

  // Force refresh the preview iframe with cache busting
  const refresh = useCallback(() => {
    if (iframeRef.current && serverReady) {
      // Parse current URL and add/update cache-busting parameter
      const currentSrc = iframeRef.current.src;
      try {
        const url = new URL(currentSrc);
        // Remove old cache buster if present
        url.searchParams.delete('_refresh');
        // Add new cache buster
        url.searchParams.set('_refresh', Date.now().toString());
        // Set to blank first to ensure full reload
        iframeRef.current.src = 'about:blank';
        setTimeout(() => {
          if (iframeRef.current) {
            iframeRef.current.src = url.toString();
          }
        }, 100);
      } catch {
        // Fallback: just reload current src
        iframeRef.current.src = 'about:blank';
        setTimeout(() => {
          if (iframeRef.current) {
            iframeRef.current.src = currentSrc;
          }
        }, 100);
      }
    }
  }, [serverReady]);

  // Expose methods to parent
  useImperativeHandle(
    ref,
    () => ({
      captureForClaude,
      isCapturing: () => isCapturing,
      refresh,
    }),
    [captureForClaude, isCapturing, refresh]
  );

  // Open CMS modal with native webview
  const handleOpenCms = () => {
    setShowCmsModal(true);
  };

  // Close CMS modal and destroy webview
  const handleCloseCms = async () => {
    try {
      await invoke('destroy_preview_webview');
    } catch (error) {
      console.error('Failed to destroy webview:', error);
    }
    setCmsWebviewReady(false);
    setShowCmsModal(false);
  };

  // Create webview when CMS modal opens
  useEffect(() => {
    if (!showCmsModal || !cmsModalRef.current || !serverReady) return;

    const createCmsWebview = async () => {
      const TITLE_BAR_HEIGHT = 31;
      const MAX_RETRIES = 20;
      const RETRY_DELAY_MS = 50;

      // Wait for modal to have valid dimensions (retry until rect is valid)
      let rect: DOMRect | null = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        rect = cmsModalRef.current?.getBoundingClientRect() ?? null;

        // Check if rect has valid dimensions
        if (rect && rect.width > 0 && rect.height > 0) {
          break;
        }

        // Wait before next retry
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      if (!rect || rect.width === 0 || rect.height === 0) {
        console.error('CMS modal never achieved valid dimensions');
        return;
      }

      try {
        // Load Sanity Studio (use dev server directly, not proxy)
        await invoke('create_preview_webview', {
          url: `${devServerUrl}/studio`,
          x: rect.left,
          y: rect.top + TITLE_BAR_HEIGHT,
          width: rect.width,
          height: rect.height + 2, // Small buffer to prevent gap at bottom
        });
        setCmsWebviewReady(true);
      } catch (error) {
        console.error('Failed to create CMS webview:', error);
      }
    };

    void createCmsWebview();

    // Handle resize
    const handleResize = async () => {
      if (!cmsModalRef.current) return;
      const rect = cmsModalRef.current.getBoundingClientRect();
      const TITLE_BAR_HEIGHT = 31;
      try {
        await invoke('resize_preview_webview', {
          x: rect.left,
          y: rect.top + TITLE_BAR_HEIGHT,
          width: rect.width,
          height: rect.height + 2,
        });
      } catch (error) {
        console.error('Failed to resize webview:', error);
      }
    };

    const wrappedHandleResize = () => void handleResize();
    window.addEventListener('resize', wrappedHandleResize);
    return () => window.removeEventListener('resize', wrappedHandleResize);
  }, [showCmsModal, serverReady, devServerUrl]);

  const filteredPages = pages
    .filter((page) => page.route !== '/studio') // Hide Sanity Studio from page list
    .filter((page) => page.route.toLowerCase().includes(pageSearch.toLowerCase()));

  if (isLoading) {
    return (
      <div className="preview-loading">
        <div className="spinner" />
        <p>Starting dev server...</p>
        <p className="hint">Waiting for localhost:{port}</p>
        <p className="hint" style={{ marginTop: 8, fontSize: 11 }}>
          {retryCount > 0 && `Attempt ${retryCount}/${SERVER_MAX_RETRIES}`}
        </p>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="preview-error">
        <p>Could not connect to dev server</p>
        <p className="hint">Ask Claude to run: npm run dev</p>
        <button onClick={() => setRetryCount(0)}>Retry</button>
      </div>
    );
  }

  return (
    <div className="preview-container">
      <div className="preview-toolbar">
        {/* Page Switcher */}
        <div className="page-switcher" ref={dropdownRef}>
          <button
            className="page-switcher-btn"
            onClick={() => setShowPageDropdown(!showPageDropdown)}
          >
            <span className="page-route">{currentPage}</span>
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
          {showPageDropdown && (
            <div className="page-dropdown">
              <input
                ref={searchInputRef}
                type="text"
                className="page-search"
                placeholder="Search pages..."
                value={pageSearch}
                onChange={(e) => setPageSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filteredPages.length > 0) {
                    handlePageSelect(filteredPages[0].route);
                  }
                  if (e.key === 'Escape') {
                    setShowPageDropdown(false);
                    setPageSearch('');
                  }
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="page-list">
                {filteredPages.length === 0 ? (
                  <div className="page-list-empty">No pages found</div>
                ) : (
                  filteredPages.map((page) => (
                    <button
                      key={page.route}
                      className={`page-item ${page.route === currentPage ? 'active' : ''}`}
                      onClick={() => handlePageSelect(page.route)}
                    >
                      {page.route}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button className="preview-refresh" onClick={handleRefresh} title="Refresh preview">
          ↻
        </button>

        {hasSanity && (
          <div className="cms-button-wrapper">
            <button
              className={`cms-button ${sanityMissingEnvKeys.length > 0 ? 'cms-button-warning' : ''}`}
              onClick={() => {
                if (sanityMissingEnvKeys.length > 0) {
                  setShowEnvWarning(!showEnvWarning);
                } else {
                  handleOpenCms();
                }
              }}
              title={
                sanityMissingEnvKeys.length > 0 ? 'Sanity env vars missing' : 'Open Sanity Studio'
              }
            >
              <svg width="14" height="14" viewBox="30 46 195 163" fill="currentColor">
                <path d="M215.759 152.483L208.799 140.366L175.13 160.88L212.526 113.252L218.179 109.933L216.78 107.831L219.349 104.548L207.549 94.7227L202.147 101.608L93.1263 165.414L133.434 116.925L208.512 75.7566L201.379 61.963L160.486 84.3775L180.623 60.168L169.087 50L123.767 104.513L78.7575 129.206L113.217 83.6335L134.811 72.3909L127.953 58.4438L65.0424 91.2034L82.1978 68.4937L70.2143 58.8926L34 106.839L34.5619 107.288L41.3277 121.07L81.4753 100.155L44.8826 148.539L50.8801 153.345L54.4465 160.242L96.7156 137.06L50.1691 193.061L61.7054 203.229L64.0218 200.442L176.311 134.509L139.031 182.007L139.638 182.515L139.581 182.55L147.31 196.001L196.895 165.781L177.802 196.603L190.6 205L221 155.931L215.759 152.483Z" />
              </svg>
              {sanityMissingEnvKeys.length > 0 ? 'Sanity' : 'Open Sanity'}
              {sanityMissingEnvKeys.length > 0 && <span className="cms-warning-badge">!</span>}
            </button>
            {showEnvWarning && sanityMissingEnvKeys.length > 0 && (
              <div className="cms-env-warning">
                <div className="cms-env-warning-header">
                  <span>Missing Sanity Environment Variables</span>
                  <button onClick={() => setShowEnvWarning(false)}>×</button>
                </div>
                <p>Add these keys to your environment variables:</p>
                <ul>
                  {sanityMissingEnvKeys.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
                <p className="cms-env-warning-hint">
                  Click the Env Vars button in the sidebar to configure.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="preview-breakpoints">
          {(Object.keys(BREAKPOINTS) as Breakpoint[]).map((bp) => (
            <button
              key={bp}
              className={`breakpoint-btn ${breakpoint === bp ? 'active' : ''}`}
              onClick={() => setBreakpoint(bp)}
              title={BREAKPOINTS[bp].label}
            >
              <BreakpointIcon type={bp} />
            </button>
          ))}
        </div>
      </div>
      <div className="preview-viewport">
        <div
          ref={iframeWrapperRef}
          className="preview-iframe-wrapper"
          style={{
            width: BREAKPOINTS[breakpoint].width,
            maxWidth: '100%',
          }}
        >
          <iframe
            key={projectPath}
            ref={iframeRef}
            src={serverReady ? currentUrl : 'about:blank'}
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
          {/* Crop selection overlay */}
          {isCropMode && (
            <div
              ref={cropOverlayRef}
              className="crop-overlay"
              onMouseDown={handleCropMouseDown}
              onMouseMove={handleCropMouseMove}
              onMouseUp={() => void handleCropMouseUp()}
              onMouseLeave={() => {
                if (isSelecting) {
                  void handleCropMouseUp();
                }
              }}
            >
              {/* Selection rectangle */}
              {/* Selection box with box-shadow creating the dark overlay */}
              {selectionStart && selectionEnd && (
                <div
                  className="crop-selection"
                  style={{
                    left: Math.min(selectionStart.x, selectionEnd.x),
                    top: Math.min(selectionStart.y, selectionEnd.y),
                    width: Math.abs(selectionEnd.x - selectionStart.x),
                    height: Math.abs(selectionEnd.y - selectionStart.y),
                  }}
                />
              )}
              {/* Instructions */}
              {!selectionStart && (
                <div className="crop-instructions">
                  Click and drag to select area
                  <span className="crop-hint">Press Esc to cancel</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* CMS Modal with native webview */}
      {showCmsModal && (
        <div className="cms-modal-overlay" onClick={() => void handleCloseCms()}>
          <div className="cms-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cms-modal-header">
              <span className="cms-modal-title">Sanity Studio</span>
              <button className="cms-modal-close" onClick={() => void handleCloseCms()}>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="cms-modal-content" ref={cmsModalRef}>
              {!cmsWebviewReady && (
                <div className="cms-modal-loading">
                  <div className="spinner" />
                  <p>Loading Sanity Studio...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
