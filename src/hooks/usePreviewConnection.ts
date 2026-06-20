/**
 * Hook for managing preview server connection, health checks, and page navigation.
 *
 * Handles: server health check polling, proxy start/stop,
 * page list loading, navigation event listening, and cache busting.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useClickOutside } from './useClickOutside';
import { logger } from '../lib/logger';
import { getWindowLabel } from '../lib/window';
import { trackEvent } from '../lib/analytics';

/** How often to refresh the page list (ms) */
const PAGE_REFRESH_INTERVAL_MS = 5000;
/** Timeout for the periodic health check once the server is already up (ms).
 *  The server is warm here, so a healthy reply is near-instant; 3s is plenty
 *  and keeps a crashed server from lingering in the "ready" state. */
const HEALTH_CHECK_TIMEOUT_MS = 3000;
/** Timeout for an initial readiness probe (ms).
 *
 *  Must be generous: modern dev servers (Next.js / Turbopack, Vite) compile the
 *  first route ON DEMAND and hold the HTTP request open until that compile
 *  finishes — frequently 10–30s on a cold start with a real dependency tree.
 *  The response headers don't arrive until then, so a short timeout aborts the
 *  probe mid-compile every single attempt and the preview never opens, even
 *  though the server is healthy (a plain browser, which doesn't abort, loads it
 *  fine — just slowly). A genuinely-down server still rejects instantly with
 *  connection-refused, so this longer window only affects the "connected but
 *  still compiling" case it's meant to ride out. */
const SERVER_READY_TIMEOUT_MS = 30000;
/** Maximum retries before showing error state */
export const SERVER_MAX_RETRIES = 60;
/** Consecutive health check failures before marking server as down */
const HEALTH_CHECK_MAX_FAILURES = 3;

/** Information about a page/route */
export interface PageInfo {
  /** The URL route (e.g., "/", "/about", "/blog/[slug]") */
  route: string;
  /** Absolute path to the page file */
  file_path: string;
}

interface UsePreviewConnectionParams {
  port: number;
  projectPath: string;
  isDevServerRestarting: boolean;
  isStaticProject: boolean;
  onServerReady?: () => void;
  onPageChange?: (page: string) => void;
  onSendToClaude?: (prompt: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
}

export function usePreviewConnection({
  port,
  projectPath,
  isDevServerRestarting,
  isStaticProject,
  onServerReady,
  onPageChange,
  onSendToClaude,
  onToast,
}: UsePreviewConnectionParams) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // User pressed "Stop" on the loading screen — halt the retry loop instead of
  // grinding through all SERVER_MAX_RETRIES attempts. Mirrored into a ref so the
  // in-flight checkServer closure can bail before scheduling the next retry.
  const [isStopped, setIsStopped] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPage, setCurrentPage] = useState('/');
  const [iframePath, setIframePath] = useState('/');
  const [showPageDropdown, setShowPageDropdown] = useState(false);
  const [pageSearch, setPageSearch] = useState('');
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [cacheBuster, setCacheBuster] = useState(() => Date.now());

  const devServerUrl = `http://localhost:${port}`;
  const baseUrl = proxyPort ? `http://localhost:${proxyPort}` : devServerUrl;
  const currentUrl = `${baseUrl}${iframePath === '/' ? '' : iframePath}?_cb=${cacheBuster}&shipstudio=1`;
  // URL safe to hand to the user's default browser: real dev server,
  // current iframe path, no proxy and no Ship Studio query params. The
  // iframe needs the proxy URL (for navigation tracking + cache busting)
  // but external browsers should land on the dev server directly.
  const externalUrl = `${devServerUrl}${iframePath === '/' ? '' : iframePath}`;

  const wasRestartingRef = useRef(false);
  const healthCheckFailuresRef = useRef(0);
  const isStoppedRef = useRef(false);
  isStoppedRef.current = isStopped;
  const retryCountRef = useRef(0);
  retryCountRef.current = retryCount;
  // The pending "schedule next attempt" timer, tracked so Stop can cancel it
  // immediately rather than letting one more attempt fire.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The in-flight readiness probe's AbortController. A readiness probe can now
  // ride a compile for up to SERVER_READY_TIMEOUT_MS (30s), so a superseded
  // attempt (Stop, project switch, restart) must be aborted explicitly —
  // otherwise the fetch and its 30s abort timer leak until they fire on a
  // controller nobody is listening to anymore.
  const readyProbeControllerRef = useRef<AbortController | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset state when project or port changes
  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    setServerReady(false);
    setRetryCount(-1);
    setIsStopped(false);
    setCurrentPage('/');
    setIframePath('/');
    setPages([]);
    setShowPageDropdown(false);
    setPageSearch('');
    setCacheBuster(Date.now());

    const timer = setTimeout(() => setRetryCount(0), 1500);
    return () => clearTimeout(timer);
  }, [projectPath, port]);

  // Reset server state when dev server is restarting, start polling when done
  useEffect(() => {
    if (isDevServerRestarting) {
      setServerReady(false);
      setIsLoading(true);
      setHasError(false);
      setRetryCount(-1);
      setIsStopped(false);
      wasRestartingRef.current = true;
    } else if (wasRestartingRef.current) {
      wasRestartingRef.current = false;
      const timer = setTimeout(() => setRetryCount(0), 1000);
      return () => clearTimeout(timer);
    }
  }, [isDevServerRestarting]);

  // Load pages
  const loadPages = useCallback(async () => {
    try {
      const pageList = await invoke<PageInfo[]>('list_pages', { projectPath });
      setPages(pageList);
    } catch (error) {
      logger.error('Failed to load pages', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [projectPath]);

  // Load pages when server is ready and periodically refresh (pauses when window hidden)
  useEffect(() => {
    if (!serverReady) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      void loadPages();
      interval = setInterval(() => void loadPages(), PAGE_REFRESH_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [serverReady, projectPath, loadPages]);

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

  // Start/stop preview proxy for navigation tracking
  useEffect(() => {
    if (!serverReady) {
      setProxyPort(null);
      return;
    }

    let cancelled = false;
    const windowLabel = getWindowLabel();

    invoke<number>('start_preview_proxy', { windowLabel, targetPort: port })
      .then((proxyP) => {
        if (!cancelled) {
          logger.info('[Preview] Proxy started', { proxyPort: proxyP, targetPort: port });
          setProxyPort(proxyP);
        }
      })
      .catch((err) => {
        logger.error('[Preview] Failed to start proxy, using direct URL', { error: err });
      });

    return () => {
      cancelled = true;
      setProxyPort(null);
      invoke('stop_preview_proxy', { windowLabel }).catch(() => {});
    };
  }, [serverReady, port]);

  // Listen for navigation and error events from the injected proxy scripts.
  //
  // SECURITY: these messages originate from the preview iframe, which renders
  // untrusted project content (the user's dev server, its deps, embedded
  // frames). Without an origin check, any script in that page could forge a
  // `shipstudio:send-error-to-claude` message and inject arbitrary text into
  // the AI agent terminal, or silently write to the clipboard. Only accept
  // messages whose origin is the preview's own dev-server / proxy port.
  useEffect(() => {
    const allowedOrigins = new Set<string>([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]);
    if (proxyPort) {
      allowedOrigins.add(`http://localhost:${proxyPort}`);
      allowedOrigins.add(`http://127.0.0.1:${proxyPort}`);
    }

    const handleMessage = (
      event: MessageEvent<{
        type?: string;
        pathname?: string;
        status?: number;
        message?: string;
      }>
    ) => {
      if (!allowedOrigins.has(event.origin)) return;
      const data = event.data;
      if (data && data.type === 'shipstudio:navigate' && typeof data.pathname === 'string') {
        const pathname: string = data.pathname || '/';
        setCurrentPage((prev) => (prev === pathname ? prev : pathname));
      }
      if (data && data.type === 'shipstudio:error') {
        logger.warn('[Preview] Dev server error detected via proxy', {
          status: data.status,
          message: data.message?.substring(0, 200),
        });
      }
      if (data && data.type === 'shipstudio:copy-error' && data.message) {
        navigator.clipboard.writeText(data.message).then(
          () => onToast?.('Error copied to clipboard', 'success'),
          () => onToast?.('Failed to copy to clipboard', 'error')
        );
      }
      if (data && data.type === 'shipstudio:send-error-to-claude' && data.message) {
        const prompt = `My dev server is returning an error:\n\n${data.message}\n\nPlease help me fix this.`;
        onSendToClaude?.(prompt);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onSendToClaude, onToast, port, proxyPort]);

  // Auto-reload for static HTML projects when files change on disk
  useEffect(() => {
    if (!isStaticProject || !serverReady) return;

    let unlisten: (() => void) | null = null;

    void listen<{ windowLabel: string }>('static-file-changed', () => {
      logger.debug('[Preview] File change detected, reloading preview');
      setCacheBuster(Date.now());
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [isStaticProject, serverReady]);

  // Server check polling
  useEffect(() => {
    if (retryCount < 0) {
      logger.info('[Preview] Waiting for old server to die (retryCount=-1)');
      return;
    }
    if (isStopped) {
      // User halted the loop — don't probe or schedule anything.
      return;
    }
    logger.info('[Preview] Starting server check', { retryCount, url: devServerUrl });

    const checkServer = async () => {
      setIsLoading(true);
      setHasError(false);
      setServerReady(false);

      const controller = new AbortController();
      readyProbeControllerRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), SERVER_READY_TIMEOUT_MS);
      try {
        await fetch(devServerUrl, { mode: 'no-cors', signal: controller.signal });

        logger.info('[Preview] Server check succeeded', { port });
        setIsLoading(false);
        setHasError(false);
        setServerReady(true);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.info('[Preview] Server check failed', {
          retry: retryCount,
          maxRetries: SERVER_MAX_RETRIES,
          error: errorMsg,
          url: devServerUrl,
        });
        // The fetch may have resolved after the user hit Stop — don't schedule
        // another attempt or flip into the error state behind their back.
        if (isStoppedRef.current) return;
        // If this probe was superseded (aborted by the effect cleanup on a
        // project/port change or restart, or replaced by a newer attempt), the
        // ref no longer points at our controller. The active attempt owns
        // retrying — bailing here avoids a stray duplicate retry.
        if (readyProbeControllerRef.current !== controller) return;
        if (retryCount < SERVER_MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(1.5, retryCount), 5000);
          retryTimerRef.current = setTimeout(() => setRetryCount((c) => c + 1), delay);
        } else {
          setIsLoading(false);
          setHasError(true);
        }
      } finally {
        clearTimeout(timeoutId);
        if (readyProbeControllerRef.current === controller) {
          readyProbeControllerRef.current = null;
        }
      }
    };

    void checkServer();
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      // Abort a probe left in flight by this attempt (project/port change,
      // restart, or the next retry superseding it) so its long-lived fetch and
      // 30s abort timer don't linger.
      readyProbeControllerRef.current?.abort();
      readyProbeControllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- port is covered by devServerUrl
  }, [devServerUrl, retryCount, isStopped]);

  // Periodic health check after server is ready
  useEffect(() => {
    if (!serverReady) {
      healthCheckFailuresRef.current = 0;
      return;
    }

    const healthCheck = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

        await fetch(devServerUrl, { mode: 'no-cors', signal: controller.signal });

        clearTimeout(timeoutId);
        healthCheckFailuresRef.current = 0;
      } catch {
        healthCheckFailuresRef.current += 1;
        logger.warn(
          `[Preview] Dev server health check failed (${healthCheckFailuresRef.current}/${HEALTH_CHECK_MAX_FAILURES})`
        );

        if (healthCheckFailuresRef.current >= HEALTH_CHECK_MAX_FAILURES) {
          logger.warn(
            '[Preview] Dev server appears to have crashed after multiple failed health checks'
          );
          setServerReady(false);
          setHasError(true);
          setIsLoading(false);
        }
      }
    };

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      interval = setInterval(() => void healthCheck(), 10000);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        void healthCheck();
        startPolling();
      }
    };

    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [serverReady, devServerUrl]);

  // Handlers
  const handleRefresh = useCallback(() => {
    void trackEvent('preview_refreshed', { trigger: 'user' });
    setIframePath(currentPage);
    setCacheBuster(Date.now());
  }, [currentPage]);

  const handlePageSelect = useCallback((route: string) => {
    void trackEvent('preview_page_selected', {
      // Strip dynamic-looking segments (numeric ids, uuids) so the cardinality
      // doesn't explode while still keeping the route shape useful.
      route_pattern: route.replace(/\/(\d+|[0-9a-f-]{8,})/g, '/:id').slice(0, 200),
      depth: route.split('/').filter(Boolean).length,
    });
    setCurrentPage(route);
    setIframePath(route);
    setShowPageDropdown(false);
    setPageSearch('');
    setCacheBuster(Date.now());
  }, []);

  const handleRetry = useCallback(() => {
    setHasError(false);
    setIsStopped(false);
    setIsLoading(true);
    setRetryCount(-1);
    setTimeout(() => setRetryCount(0), 50);
  }, []);

  // Halt the connect loop immediately — cancel any pending retry and drop out of
  // the loading state into a "stopped" state with Retry / Fix-with-agent actions.
  const stopConnecting = useCallback(() => {
    // Set the ref before aborting so the probe's catch sees "stopped" and bails
    // instead of scheduling another attempt (the state update won't have flushed
    // to isStoppedRef by the time abort rejects the in-flight fetch).
    isStoppedRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // Abort the in-flight readiness probe so Stop is honored immediately rather
    // than leaving a 30s fetch running in the background.
    readyProbeControllerRef.current?.abort();
    readyProbeControllerRef.current = null;
    setIsStopped(true);
    setIsLoading(false);
    setHasError(false);
    void trackEvent('preview_connect_stopped', { retry_count: retryCountRef.current });
  }, []);

  const filteredPages = useMemo(
    () => pages.filter((page) => page.route.toLowerCase().includes(pageSearch.toLowerCase())),
    [pages, pageSearch]
  );

  return {
    // Server state
    isLoading,
    hasError,
    retryCount,
    serverReady,
    isStopped,

    // URL state
    baseUrl,
    currentUrl,
    externalUrl,

    // Page navigation
    currentPage,
    iframePath,
    setIframePath,
    showPageDropdown,
    setShowPageDropdown,
    pageSearch,
    setPageSearch,
    filteredPages,

    // Refs (for rendering)
    dropdownRef,
    searchInputRef,

    // Handlers
    handleRefresh,
    handlePageSelect,
    handleRetry,
    stopConnecting,
  };
}
