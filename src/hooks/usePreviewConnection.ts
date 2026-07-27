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
import {
  decideIframeWatchdogArm,
  isPreviewProofOfLife,
  IFRAME_BLANK_TIMEOUT_MS,
} from './previewIframeWatchdog';
import { probeWordpressSite } from '../lib/wordpress';
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

/** A live site the preview forwards to instead of a local dev server. */
export interface RemotePreviewTarget {
  /** Origin as `https://host`, used for "Open in Browser" and display. */
  origin: string;
  host: string;
  port: number;
  tls: boolean;
}

interface UsePreviewConnectionParams {
  port: number;
  projectPath: string;
  /** When set, the proxy forwards to this live site rather than localhost.
   *  WordPress projects have no local dev server to wait for or probe, so the
   *  readiness loop is skipped entirely — see lib/wordpress. */
  remoteTarget?: RemotePreviewTarget | null;
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
  remoteTarget,
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
  // Bumped to request an imperative iframe reload (Preview watches it). The
  // iframe URL used to carry a `?_cb=<ts>&shipstudio=1` cache-buster instead,
  // but those params leaked into the previewed app — its router, SSR search
  // params, and analytics all saw junk Chrome never sends. Freshness is now the
  // proxy's job (it serves injected HTML with Cache-Control: no-store).
  const [reloadToken, setReloadToken] = useState(0);
  // The iframe never proved it rendered a document (issue #179): the server is
  // healthy top-level, but the subframe load aborted — e.g. an auth-middleware
  // redirect loop — and WebKit renders an empty frame with no error anywhere.
  const [iframeBlank, setIframeBlank] = useState(false);

  // A remote target has no localhost server behind it; its origin stands in
  // for the dev server everywhere the two are interchangeable.
  const devServerUrl = remoteTarget ? remoteTarget.origin : `http://localhost:${port}`;
  const baseUrl = proxyPort ? `http://localhost:${proxyPort}` : devServerUrl;
  const currentUrl = `${baseUrl}${iframePath === '/' ? '' : iframePath}`;
  // URL safe to hand to the user's default browser: real dev server and
  // current iframe path, no proxy. The iframe needs the proxy URL (for
  // navigation tracking and script injection) but external browsers should
  // land on the dev server directly — or, for a remote target, on the live site.
  const externalUrl = `${devServerUrl}${iframePath === '/' ? '' : iframePath}`;

  const wasRestartingRef = useRef(false);
  const healthCheckFailuresRef = useRef(0);
  // Last time the HMR watchdog auto-reloaded the preview — throttles recovery
  // so a flapping HMR socket can't put the iframe in a reload loop.
  const lastHmrRecoveryRef = useRef(0);
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
  // Blank-iframe watchdog: has the current navigation proven life yet, and the
  // pending "no proof arrived" timer. Refs (not state) so the message handler
  // and timer callbacks always see the live values without re-subscribing.
  const iframeAliveRef = useRef(false);
  const iframeWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearIframeWatchdogTimer = useCallback(() => {
    if (iframeWatchdogTimerRef.current) {
      clearTimeout(iframeWatchdogTimerRef.current);
      iframeWatchdogTimerRef.current = null;
    }
  }, []);

  // (Re)start the blank-iframe timer. Fires only if no proof-of-life message
  // arrived in the meantime — a late-but-healthy page clears itself.
  const startIframeWatchdogTimer = useCallback(() => {
    clearIframeWatchdogTimer();
    iframeWatchdogTimerRef.current = setTimeout(() => {
      iframeWatchdogTimerRef.current = null;
      if (!iframeAliveRef.current) {
        logger.warn('[Preview] Iframe never proved it rendered — flagging blank pane', {
          timeoutMs: IFRAME_BLANK_TIMEOUT_MS,
        });
        setIframeBlank(true);
      }
    }, IFRAME_BLANK_TIMEOUT_MS);
  }, [clearIframeWatchdogTimer]);

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
    setReloadToken(0);
    setIframeBlank(false);
    iframeAliveRef.current = false;

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

    invoke<number>('start_preview_proxy', {
      windowLabel,
      targetPort: remoteTarget ? remoteTarget.port : port,
      targetHost: remoteTarget ? remoteTarget.host : null,
      targetTls: remoteTarget ? remoteTarget.tls : false,
      // WordPress emits absolute self-URLs even on localhost (its site URL
      // lives in the database), so its links must be rewritten to stay in
      // the proxy. JS dev servers emit relative URLs and need no rewriting.
      rewriteUrls: !!remoteTarget,
    })
      .then((proxyP) => {
        if (!cancelled) {
          logger.info('[Preview] Proxy started', {
            proxyPort: proxyP,
            // The localhost `port` is an unused placeholder for a remote
            // target — log where the proxy actually forwards.
            target: remoteTarget
              ? `${remoteTarget.host}:${remoteTarget.port}`
              : `localhost:${port}`,
          });
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
    // `remoteTarget` is memoized by useWordpress, so this doesn't re-run per
    // render; a changed site legitimately needs the proxy pointed elsewhere.
  }, [serverReady, port, remoteTarget]);

  // Arm the blank-iframe watchdog on every explicit navigation: initial proxy
  // URL and page select change `currentUrl`, and refresh / same-page select bump
  // `reloadToken` (imperative reload) — each replaces the iframe's document, so
  // the previous proof-of-life no longer stands. Skipped (and cleared) while the
  // server isn't ready or the URL bypasses the injecting proxy, where no page
  // could ever prove life.
  useEffect(() => {
    const action = decideIframeWatchdogArm('navigation', {
      serverReady,
      proxyActive: proxyPort !== null,
      aliveSinceNavigation: false,
    });
    if (action === 'skip') {
      setIframeBlank(false);
      return;
    }
    logger.debug('[Preview] Arming blank-iframe watchdog', { url: currentUrl });
    iframeAliveRef.current = false;
    setIframeBlank(false);
    startIframeWatchdogTimer();
    return clearIframeWatchdogTimer;
  }, [
    currentUrl,
    reloadToken,
    serverReady,
    proxyPort,
    startIframeWatchdogTimer,
    clearIframeWatchdogTimer,
  ]);

  // Give each document hop a fresh window: the iframe's `load` event fires per
  // document (redirect chains, about:blank bounces during refresh). Injected
  // scripts post their proof at parse time — before `load` — so a hop that
  // already proved life must NOT re-arm (it would be falsely flagged blank).
  const handleIframeLoad = useCallback(() => {
    const action = decideIframeWatchdogArm('load', {
      serverReady,
      proxyActive: proxyPort !== null,
      aliveSinceNavigation: iframeAliveRef.current,
    });
    if (action === 'skip') return;
    startIframeWatchdogTimer();
  }, [serverReady, proxyPort, startIframeWatchdogTimer]);

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
      // Any injected-script message (shipstudio:* or the visual editor's ss:*)
      // proves the iframe parsed and ran a real document — feed the blank-pane
      // watchdog. Also self-heals: a page that finishes late (slow on-demand
      // compile) clears an already-shown blank overlay.
      if (data && isPreviewProofOfLife(data.type)) {
        iframeAliveRef.current = true;
        clearIframeWatchdogTimer();
        setIframeBlank(false);
      }
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
      if (data && data.type === 'shipstudio:hmr-down') {
        // The page's HMR socket died and never came back (watchdog in the
        // injected reload-suppress script). The page still renders but no
        // longer receives updates — the classic "stale preview until you
        // restart the dev server". If the server itself is healthy, one
        // reload reconnects everything; if it's down, the health-check flow
        // owns recovery, so do nothing here.
        if (!serverReady) return;
        if (Date.now() - lastHmrRecoveryRef.current < 15000) return;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        fetch(devServerUrl, { mode: 'no-cors', signal: controller.signal })
          .then(() => {
            lastHmrRecoveryRef.current = Date.now();
            logger.warn(
              '[Preview] HMR connection lost while dev server is healthy — auto-reloading preview'
            );
            setReloadToken((t) => t + 1);
          })
          .catch(() => {
            // Server unreachable — the periodic health check will surface it.
          })
          .finally(() => clearTimeout(timeoutId));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    onSendToClaude,
    onToast,
    port,
    proxyPort,
    serverReady,
    devServerUrl,
    clearIframeWatchdogTimer,
  ]);

  // Auto-reload for static HTML projects when files change on disk
  useEffect(() => {
    if (!isStaticProject || !serverReady) return;

    let unlisten: (() => void) | null = null;

    void listen<{ windowLabel: string }>('static-file-changed', () => {
      logger.debug('[Preview] File change detected, reloading preview');
      setReloadToken((t) => t + 1);
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
        if (remoteTarget) {
          // A live site is probed through the backend, not the webview: the
          // origin is cross-origin (so a `no-cors` fetch can't distinguish
          // "reachable" from "blocked") and may sit behind bot protection that
          // rejects anything without browser-like headers.
          const status = await probeWordpressSite(remoteTarget.origin);
          if (status === null) {
            throw new Error(`${remoteTarget.host} did not respond`);
          }
          logger.info('[Preview] Remote site reachable', {
            host: remoteTarget.host,
            status,
          });
        } else {
          await fetch(devServerUrl, { mode: 'no-cors', signal: controller.signal });
        }

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
    if (iframePath === currentPage) {
      // Same URL — a src diff won't reload; request an imperative reload.
      setReloadToken((t) => t + 1);
    } else {
      // Path changed — the src change itself performs a fresh load.
      setIframePath(currentPage);
    }
  }, [currentPage, iframePath]);

  const handlePageSelect = useCallback(
    (route: string) => {
      void trackEvent('preview_page_selected', {
        // Strip dynamic-looking segments (numeric ids, uuids) so the cardinality
        // doesn't explode while still keeping the route shape useful.
        route_pattern: route.replace(/\/(\d+|[0-9a-f-]{8,})/g, '/:id').slice(0, 200),
        depth: route.split('/').filter(Boolean).length,
      });
      setCurrentPage(route);
      setShowPageDropdown(false);
      setPageSearch('');
      if (iframePath === route) {
        // Re-selecting the visible page acts as a refresh.
        setReloadToken((t) => t + 1);
      } else {
        setIframePath(route);
      }
    },
    [iframePath]
  );

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
    iframeBlank,

    // URL state
    baseUrl,
    currentUrl,
    externalUrl,
    reloadToken,

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
    handleIframeLoad,
  };
}
