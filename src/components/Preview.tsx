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
import { logger } from '../lib/logger';

/** How often to refresh the page list (ms) */
const PAGE_REFRESH_INTERVAL_MS = 5000;
/** Timeout for dev server health check requests (ms) */
const SERVER_CHECK_TIMEOUT_MS = 3000;
/** Maximum retries before showing error state */
const SERVER_MAX_RETRIES = 60;

/** Responsive breakpoint options */
type Breakpoint = 'full' | 'desktop' | 'laptop' | 'tablet' | 'mobile';

/** Information about a Next.js page/route */
interface PageInfo {
  /** The URL route (e.g., "/", "/about", "/blog/[slug]") */
  route: string;
  /** Absolute path to the page file */
  file_path: string;
}

const BREAKPOINTS: Record<Breakpoint, { width: string; label: string }> = {
  full: { width: '100%', label: 'Full' },
  desktop: { width: '1440px', label: 'Desktop' },
  laptop: { width: '1024px', label: 'Laptop' },
  tablet: { width: '768px', label: 'Tablet' },
  mobile: { width: '375px', label: 'Mobile' },
};

/** Pixel widths for fixed breakpoints (excludes 'full' which is 100%) */
const BREAKPOINT_WIDTHS: number[] = [1440, 1024, 768, 375];

/** Space reserved for the resize handle on the right side of the viewport */
const VIEWPORT_PADDING_PX = 12;

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
  /** Extra toolbar elements to render in the center */
  toolbarExtra?: React.ReactNode;
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
    toolbarExtra,
  },
  ref
) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [serverReady, setServerReady] = useState(false);
  const [customWidth, setCustomWidth] = useState<number | null>(null); // null = 100% (desktop)
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
  const viewportRef = useRef<HTMLDivElement | null>(null);

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
      logger.info('[Preview] Server ready, calling onServerReady callback');
      onServerReady();
    }
  }, [serverReady, onServerReady]);

  // Notify parent when page changes
  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  useEffect(() => {
    // Skip if not ready to check yet (-1 means waiting for old server to die)
    if (retryCount < 0) {
      logger.info('[Preview] Waiting for old server to die (retryCount=-1)');
      return;
    }
    logger.info('[Preview] Starting server check', { retryCount, url: devServerUrl });

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
        logger.info('[Preview] Server check succeeded', { port });
        setIsLoading(false);
        setHasError(false);
        setServerReady(true);
      } catch (err) {
        logger.info('[Preview] Server check failed', {
          retry: retryCount,
          maxRetries: SERVER_MAX_RETRIES,
          error: err,
        });
        if (retryCount < SERVER_MAX_RETRIES) {
          setTimeout(() => setRetryCount((c) => c + 1), 1000);
        } else {
          setIsLoading(false);
          setHasError(true);
        }
      }
    };

    void checkServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- port is covered by devServerUrl
  }, [devServerUrl, retryCount]);

  // Periodic health check after server is ready - detect if it crashes
  // Use a ref to track consecutive failures (allows tolerance for temporary slowdowns)
  const healthCheckFailuresRef = useRef(0);
  const HEALTH_CHECK_MAX_FAILURES = 3; // Allow 3 consecutive failures before showing error

  useEffect(() => {
    if (!serverReady) {
      // Reset failure count when server is not ready
      healthCheckFailuresRef.current = 0;
      return;
    }

    const healthCheck = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);

        await fetch(devServerUrl, {
          mode: 'no-cors',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        // Reset failure count on success
        healthCheckFailuresRef.current = 0;
      } catch {
        // Increment failure count
        healthCheckFailuresRef.current += 1;
        console.warn(
          `[Preview] Dev server health check failed (${healthCheckFailuresRef.current}/${HEALTH_CHECK_MAX_FAILURES})`
        );

        // Only show error after consecutive failures (tolerates temporary slowdowns)
        if (healthCheckFailuresRef.current >= HEALTH_CHECK_MAX_FAILURES) {
          console.warn(
            '[Preview] Dev server appears to have crashed after multiple failed health checks'
          );
          setServerReady(false);
          setHasError(true);
          setIsLoading(false);
        }
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

  // Capture viewport screenshot by capturing the window and cropping to iframe bounds
  // This captures what's actually visible on screen (including any navigation the user did in the iframe)
  const captureForClaude = useCallback(async (): Promise<string | null> => {
    if (isCapturing) {
      return null;
    }

    setIsCapturing(true);
    try {
      if (!iframeWrapperRef.current) return null;

      const tempPath = await captureWindowScreenshot();
      if (!tempPath) return null;

      const rect = iframeWrapperRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Account for macOS title bar in window screenshot
      const TITLE_BAR_HEIGHT = 31;

      const finalPath = await invoke<string>('crop_and_save_screenshot', {
        projectPath,
        sourcePath: tempPath,
        x: Math.round(rect.left * dpr),
        y: Math.round((rect.top + TITLE_BAR_HEIGHT) * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      });
      return finalPath;
    } catch (error) {
      console.error('[Preview] Viewport capture failed:', error);
      return null;
    } finally {
      setIsCapturing(false);
    }
  }, [projectPath, captureWindowScreenshot, isCapturing]);

  // Full-page capture using Playwright (scrolls page to trigger lazy content, then captures)
  // Note: Uses currentUrl from page selector state - if user navigated via iframe links,
  // this may not match. Use the page selector dropdown to ensure correct page.
  const captureFullPage = useCallback(async (): Promise<string | null> => {
    if (isCapturing) return null;

    setIsCapturing(true);
    try {
      const filePath = await invoke<string>('capture_fullpage_playwright', {
        projectPath,
        url: currentUrl,
      });
      return filePath;
    } catch (error) {
      console.error('[Preview] Full page capture failed:', error);
      // Fall back to viewport capture if Playwright fails
      return captureForClaude();
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, projectPath, currentUrl, captureForClaude]);

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
        // Account for macOS title bar in window screenshot
        const TITLE_BAR_HEIGHT = 31;

        // Calculate absolute position of the selection within the window
        const absoluteX = Math.round((iframeRect.left + regionX) * dpr);
        const absoluteY = Math.round((iframeRect.top + regionY + TITLE_BAR_HEIGHT) * dpr);
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

  // Determine which breakpoint matches the current width
  const getActiveBreakpoint = useCallback((): Breakpoint => {
    if (customWidth === null) return 'full';
    if (customWidth <= 375) return 'mobile';
    if (customWidth <= 768) return 'tablet';
    if (customWidth <= 1024) return 'laptop';
    if (customWidth <= 1440) return 'desktop';
    return 'full';
  }, [customWidth]);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);

  // Track viewport width to hide breakpoints that won't fit
  // ResizeObserver fires efficiently (not on every frame) so no debouncing needed
  const [viewportWidth, setViewportWidth] = useState<number>(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref to set up ResizeObserver when viewport element mounts/unmounts
  const setViewportRefs = useCallback((node: HTMLDivElement | null) => {
    // Update the regular ref for other code that uses viewportRef
    viewportRef.current = node;

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      // Set initial width (subtract padding for resize handle)
      setViewportWidth(node.offsetWidth - VIEWPORT_PADDING_PX);

      // Observe future size changes
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setViewportWidth(entry.contentRect.width - VIEWPORT_PADDING_PX);
        }
      });
      observerRef.current.observe(node);
    }
  }, []);

  // Auto-switch to a fitting breakpoint if current selection no longer fits
  useEffect(() => {
    if (viewportWidth === 0 || customWidth === null) return;

    if (customWidth > viewportWidth) {
      // Current breakpoint doesn't fit - switch to largest that does
      const fittingWidth = BREAKPOINT_WIDTHS.find((w) => w <= viewportWidth);
      setCustomWidth(fittingWidth ?? null); // null = full width if nothing fits
    }
  }, [viewportWidth, customWidth]);

  // Handle resize drag - like SplitPane
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const startWidth = iframeWrapperRef.current?.offsetWidth || 0;

    const handleMouseMove = (e: MouseEvent) => {
      if (!viewportRef.current) return;

      const deltaX = e.clientX - startX;
      // Multiply by 2 because preview is centered (handle moves half of width change)
      const newWidth = startWidth + deltaX * 2;
      const maxWidth = viewportRef.current.offsetWidth - 12; // Leave space for handle

      if (newWidth >= maxWidth - 10) {
        // Snap to full width (desktop)
        setCustomWidth(null);
      } else {
        setCustomWidth(Math.max(320, Math.min(newWidth, maxWidth)));
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Handle breakpoint button click
  const handleBreakpointClick = useCallback((bp: Breakpoint) => {
    if (bp === 'full') {
      setCustomWidth(null);
    } else if (bp === 'desktop') {
      setCustomWidth(1440);
    } else if (bp === 'laptop') {
      setCustomWidth(1024);
    } else if (bp === 'tablet') {
      setCustomWidth(768);
    } else {
      setCustomWidth(375);
    }
  }, []);

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
      captureFullPage,
      isCapturing: () => isCapturing,
      refresh,
      isServerReady: () => serverReady,
    }),
    [captureForClaude, captureFullPage, isCapturing, refresh, serverReady]
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
        <button
          onClick={() => {
            // Reset state and trigger fresh retry cycle
            // Set to -1 first (useEffect skips negative values), then 0 to ensure re-trigger
            setHasError(false);
            setIsLoading(true);
            setRetryCount(-1);
            setTimeout(() => setRetryCount(0), 50);
          }}
        >
          Retry
        </button>
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

        {toolbarExtra && <div className="preview-toolbar-center">{toolbarExtra}</div>}

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
          {(Object.keys(BREAKPOINTS) as Breakpoint[]).map((bp) => {
            // Always show 'full' - it adapts to any size
            // Hide other breakpoints if they won't fit in the viewport
            if (bp !== 'full') {
              const bpWidth = parseInt(BREAKPOINTS[bp].width, 10);
              if (viewportWidth > 0 && bpWidth > viewportWidth) {
                return null;
              }
            }
            return (
              <button
                key={bp}
                className={`breakpoint-btn ${getActiveBreakpoint() === bp ? 'active' : ''}`}
                onClick={() => handleBreakpointClick(bp)}
                title={`${BREAKPOINTS[bp].label} (${BREAKPOINTS[bp].width})`}
              >
                <BreakpointIcon type={bp} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="preview-viewport" ref={setViewportRefs}>
        {/* Overlay to capture mouse events during resize */}
        {isResizing && <div className="preview-resize-overlay" />}
        <div
          ref={iframeWrapperRef}
          className="preview-iframe-wrapper"
          style={{
            width: customWidth === null ? 'calc(100% - 12px)' : `${customWidth}px`,
            maxWidth: 'calc(100% - 12px)',
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
        {/* Resize handle */}
        <div className="preview-resize-handle" onMouseDown={handleResizeStart}>
          <div className="preview-resize-handle-bar" />
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
