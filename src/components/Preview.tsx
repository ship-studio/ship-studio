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

import {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
  useState,
  useEffect,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { usePreviewConnection, SERVER_MAX_RETRIES } from '../hooks/usePreviewConnection';
import { usePreviewCapture } from '../hooks/usePreviewCapture';
import {
  usePreviewResize,
  BREAKPOINTS,
  RESIZE_HANDLE_PX,
  type Breakpoint,
} from '../hooks/usePreviewResize';
import { useOptionalToast } from '../contexts/ToastContext';
import { DevServerLogs } from './DevServerLogs';
import { DevServerStatus } from './DevServerStatus';
import { stripAnsi } from '../lib/ansi';
import { trackEvent } from '../lib/analytics';
import { BrowserTools } from './BrowserTools';
import { HealthTabPanel, type HealthTabPanelRef } from './HealthTabPanel';
import { BrowserDropdown } from './BrowserDropdown';
import { useVisualEditor } from '../hooks/useVisualEditor';
import { useBreakpoints } from '../hooks/useBreakpoints';
import { BASE_BREAKPOINT, isTailwindActive, type Breakpoint as TwBreakpoint } from '../lib/edit';
import { VisualEditorPanel } from './edit/VisualEditorPanel';
import { ElementTreePanel } from './edit/ElementTreePanel';
import { useElementTree } from '../hooks/useElementTree';
import { PreviewLocaleSwitcher, type PreviewLocaleConfig } from './PreviewLocaleSwitcher';
import { CompactIcon, ExpandIcon, PanelLeftIcon, ResetIcon } from './icons';
import { pathLocale, switchPathLocale } from '../lib/i18n';
import type { ProjectType } from '../lib/static-server';

// SVG icons for breakpoints
const BreakpointIcon = ({ type }: { type: Breakpoint }) => {
  if (type === 'full') {
    // Horizontal stretch-to-edges for full width — deliberately distinct from
    // the diagonal expand arrows on the fullscreen toolbar button.
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="3" y1="4" x2="3" y2="20" />
        <line x1="21" y1="4" x2="21" y2="20" />
        <line x1="7" y1="12" x2="17" y2="12" />
        <polyline points="10 9 7 12 10 15" />
        <polyline points="14 9 17 12 14 15" />
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
  /** Detected project type; gates the visual editor to Next.js for v1. */
  projectType?: ProjectType;
  /** Callback to send prompt to Claude terminal */
  onSendToClaude?: (prompt: string) => void;
  /** Plugin components rendered in the preview toolbar */
  previewPlugins?: React.ReactNode;
  /** Whether the dev server logs panel is open */
  showLogs?: boolean;
  /** Callback to toggle the dev server logs panel */
  onToggleLogs?: () => void;
  /** Dev server output buffer (passed through to DevServerLogs) */
  devServerOutput?: string;
  /** Version counter that bumps when devServerOutput changes */
  devServerOutputVersion?: number;
  /** Type into the dev-server PTY — answers interactive CLI prompts. */
  onDevServerInput?: (data: string) => void;
  /** Sync the dev-server PTY size to the logs terminal. */
  onDevServerResize?: (cols: number, rows: number) => void;
  /** Controlled inspect-panel sub-tab. Falls back to local state when unset. */
  inspectTab?: InspectTab;
  /** Callback when the user switches inspect-panel sub-tabs. */
  onInspectTabChange?: (tab: InspectTab) => void;
  /** Imperative handle for the Code Health panel hosted in the Inspect "Health" tab. */
  healthPanelRef?: RefObject<HealthTabPanelRef | null>;
  /** Receives stdout/stderr from health checks; piped into the dev-server health buffer. */
  onHealthOutput?: (data: string) => void;
  /** When set, the dev server hasn't been started because dependencies aren't
   *  installed. Render an install CTA in the preview pane instead of the
   *  "Starting dev server..." spinner. */
  needsInstall?: { packageManager: string } | null;
  /** Action wired to the install CTA — kicks off the install flow + restart. */
  onRunInstall?: () => void;
  /** Jump to a source file:line in the Code tab (from the visual editor). */
  onOpenInCode?: (file: string, line: number) => void;
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

/** Smallest the Inspect panel can be dragged to. Below this the tab bar
 *  dominates the panel and the user is better off closing it. */
const INSPECT_PANEL_MIN_HEIGHT_PX = 120;

/** Vertical space reserved above the Inspect panel when computing its
 *  max height — covers the preview toolbar (~40px) plus a usable
 *  viewport floor (~160px) so the iframe never collapses to nothing. */
const INSPECT_VIEWPORT_RESERVE_PX = 200;

/** Floor for the computed max height; ensures the panel stays resizable
 *  in containers small enough that `clientHeight - reserve` would be
 *  negative or absurdly small. */
const INSPECT_PANEL_MAX_FALLBACK_PX = 160;

/** Keyboard arrow-key step. Shift+arrow uses the larger step. */
const INSPECT_PANEL_KEY_STEP_PX = 12;
const INSPECT_PANEL_KEY_STEP_LARGE_PX = 60;

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
    projectType,
    onSendToClaude,
    previewPlugins,
    showLogs = false,
    onToggleLogs,
    devServerOutput = '',
    devServerOutputVersion = 0,
    onDevServerInput,
    onDevServerResize,
    inspectTab,
    onInspectTabChange,
    healthPanelRef,
    onHealthOutput,
    needsInstall,
    onRunInstall,
    onOpenInCode,
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
  // Explicit edit-target breakpoint. Defaults to Base (mobile-first: unprefixed
  // styles apply at every width — the right starting point, and it avoids silently
  // writing prefixed classes just because the canvas is wide). Set when the user
  // picks one from the panel dropdown; cleared whenever the user resizes the canvas
  // (so the active breakpoint then follows the width again).
  const [pinnedBreakpoint, setPinnedBreakpoint] = useState<TwBreakpoint | null>(BASE_BREAKPOINT);

  const resize = usePreviewResize({
    iframeWrapperRef: capture.iframeWrapperRef,
    onUserResize: () => setPinnedBreakpoint(null),
  });

  // Fullscreen: the container goes position:fixed over the window below the
  // workspace header (kept visible — it carries the project name and makes
  // room for the macOS traffic lights). The iframe never remounts, so the
  // page state survives entering/leaving. ESC exits.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Bottom edge of the workspace header — the top of the fullscreen overlay
  // and of the pinned editor sidebar. Measured (the header has no fixed height).
  const [chromeTop, setChromeTop] = useState(0);
  useEffect(() => {
    const measure = () => {
      const header = document.querySelector('.workspace-header');
      setChromeTop(header ? Math.round(header.getBoundingClientRect().bottom) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen]);

  // Pin the visual editor as a sidebar (instead of a floating panel over the
  // canvas) — persisted in localStorage, so it's a cross-project setting.
  // The preview makes room via a class on the container, in both normal and
  // fullscreen modes.
  const [editorPinned, setEditorPinned] = useState(
    () => localStorage.getItem('visualEditorPinned') === '1'
  );
  const toggleEditorPinned = useCallback(() => {
    setEditorPinned((p) => {
      localStorage.setItem('visualEditorPinned', p ? '0' : '1');
      return !p;
    });
  }, []);

  // Inspect-panel vertical resize. Null = use the default 1fr split from CSS;
  // a number = explicit panel height in px (overrides via inline grid-template-rows).
  const [inspectPanelHeight, setInspectPanelHeight] = useState<number | null>(null);
  const [isInspectResizing, setIsInspectResizing] = useState(false);
  const inspectPanelRef = useRef<HTMLDivElement | null>(null);

  const computeMaxPanelHeight = useCallback((containerHeight: number) => {
    return Math.max(INSPECT_PANEL_MAX_FALLBACK_PX, containerHeight - INSPECT_VIEWPORT_RESERVE_PX);
  }, []);

  const handleInspectResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const panel = inspectPanelRef.current;
      const container = panel?.parentElement;
      if (!panel || !container) return;

      setIsInspectResizing(true);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';

      const startY = e.clientY;
      const startHeight = panel.offsetHeight;
      const maxPanelHeight = computeMaxPanelHeight(container.clientHeight);

      let rafId: number | null = null;
      const onMove = (ev: MouseEvent) => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const deltaY = startY - ev.clientY; // up = grow panel
          const next = startHeight + deltaY;
          setInspectPanelHeight(
            Math.max(INSPECT_PANEL_MIN_HEIGHT_PX, Math.min(next, maxPanelHeight))
          );
        });
      };
      const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        setIsInspectResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [computeMaxPanelHeight]
  );

  // Keyboard support for the resize separator: arrow keys nudge, Home/End
  // jump to the bounds. Required for users who can't drag with a pointer.
  const handleInspectResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') {
        return;
      }
      const panel = inspectPanelRef.current;
      const container = panel?.parentElement;
      if (!panel || !container) return;
      e.preventDefault();

      const max = computeMaxPanelHeight(container.clientHeight);
      const current = inspectPanelHeight ?? panel.offsetHeight;
      const step = e.shiftKey ? INSPECT_PANEL_KEY_STEP_LARGE_PX : INSPECT_PANEL_KEY_STEP_PX;

      if (e.key === 'ArrowUp') {
        setInspectPanelHeight(Math.min(current + step, max));
      } else if (e.key === 'ArrowDown') {
        setInspectPanelHeight(Math.max(current - step, INSPECT_PANEL_MIN_HEIGHT_PX));
      } else if (e.key === 'Home') {
        setInspectPanelHeight(INSPECT_PANEL_MIN_HEIGHT_PX);
      } else if (e.key === 'End') {
        setInspectPanelHeight(max);
      }
    },
    [inspectPanelHeight, computeMaxPanelHeight]
  );

  // Reclamp the panel height when the container resizes — without this, a
  // user-set absolute pixel height can outgrow a shrunken window and push
  // the viewport row to zero.
  useEffect(() => {
    if (!showLogs) return;
    const container = inspectPanelRef.current?.parentElement;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const max = computeMaxPanelHeight(container.clientHeight);
      setInspectPanelHeight((prev) => (prev === null || prev <= max ? prev : max));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [showLogs, computeMaxPanelHeight]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The editor only works when Tailwind actually compiles in the project — a bare
  // `@import "tailwindcss"` without the Vite/PostCSS plugin produces dead classes.
  // Gate on a backend check so projects without Tailwind never show the edit button.
  const [tailwindActive, setTailwindActive] = useState(false);
  const editorFramework =
    projectType === 'nextjs' || projectType === 'astro' || projectType === 'shopifytheme';
  useEffect(() => {
    if (!projectPath || !editorFramework) {
      setTailwindActive(false);
      return;
    }
    let cancelled = false;
    isTailwindActive(projectPath)
      .then((active) => !cancelled && setTailwindActive(active))
      .catch(() => !cancelled && setTailwindActive(false));
    return () => {
      cancelled = true;
    };
  }, [projectPath, editorFramework]);

  // Visual editor supports className/class string resolution for React (Next.js),
  // Astro, and Shopify Liquid templates — all resolve the same way in the Rust
  // backend. The Tailwind gate keeps plain-CSS themes from showing an edit
  // button whose class writes would never compile.
  const editorEnabled = conn.serverReady && editorFramework && tailwindActive;

  // Locale config reported by the locale switcher (null when the project has
  // fewer than 2 configured languages). Used to keep page selection inside
  // the language currently being previewed.
  const [localeConfig, setLocaleConfig] = useState<PreviewLocaleConfig | null>(null);
  const selectPageKeepingLocale = (route: string) => {
    if (localeConfig) {
      const active = pathLocale(conn.currentPage, localeConfig.locales, localeConfig.defaultLocale);
      if (active && active !== localeConfig.defaultLocale) {
        conn.handlePageSelect(
          switchPathLocale(route, active, localeConfig.locales, localeConfig.defaultLocale)
        );
        return;
      }
    }
    conn.handlePageSelect(route);
  };

  // The project's Tailwind breakpoints (Base + detected), and the layer edits
  // currently target — DERIVED from the live canvas width (never set on its own,
  // so picking a breakpoint resizes the canvas and resizing updates the layer,
  // with no feedback loop). Largest breakpoint whose min-width ≤ the canvas width.
  const breakpoints = useBreakpoints(projectPath, editorEnabled);
  // Active edit layer: the explicitly-pinned breakpoint if any, else derived from
  // the canvas width (largest breakpoint whose min-width fits). The pin lets you
  // edit a layer the width wouldn't select on its own — e.g. Base at a wide canvas,
  // which must not force a shrink.
  const derivedBreakpoint = useMemo(() => {
    const width = resize.customWidth ?? (resize.viewportWidth || 1280);
    let active = breakpoints[0];
    for (const bp of breakpoints) if (bp.minPx <= width) active = bp;
    return active;
  }, [resize.customWidth, resize.viewportWidth, breakpoints]);
  // Keep a pin valid only while it still matches a known breakpoint (project switch).
  const activeBreakpoint =
    (pinnedBreakpoint && breakpoints.find((b) => b.name === pinnedBreakpoint.name)) ||
    derivedBreakpoint;
  // The selected breakpoint can exceed what the pane can show (the frame caps its
  // visible width at the viewport). When so, edits still apply at that breakpoint
  // but won't be visible here — the panel shows a note.
  const breakpointTooWide =
    activeBreakpoint.minPx > 0 &&
    resize.viewportWidth > 0 &&
    resize.viewportWidth < activeBreakpoint.minPx;

  // Visual editor (Next.js + Astro). Inert until the user toggles edit mode.
  const editor = useVisualEditor({
    iframeRef,
    projectPath,
    enabled: editorEnabled,
    activeBreakpoint,
    breakpoints,
    onToast,
  });

  // Element tree (navigator) — left column in fullscreen edit mode, like
  // Webflow's navigator: read-only, select-only. Toggleable from the toolbar;
  // the choice persists cross-project like the editor pin.
  const [treeVisible, setTreeVisible] = useState(
    () => localStorage.getItem('elementTreeVisible') !== '0'
  );
  const toggleTreeVisible = useCallback(() => {
    setTreeVisible((v) => {
      localStorage.setItem('elementTreeVisible', v ? '0' : '1');
      return !v;
    });
  }, []);
  const showTree = isFullscreen && editor.editMode && treeVisible;
  const elementTree = useElementTree({ iframeRef, enabled: showTree });

  const [iframeSize, setIframeSize] = useState<{ w: number; h: number } | null>(null);
  const iframeSizeObserverRef = useRef<ResizeObserver | null>(null);

  // Callback ref that observes the iframe wrapper's size and forwards the
  // element to the capture hook's ref (used for screenshots and crop math).
  const setIframeWrapperEl = useCallback(
    (el: HTMLDivElement | null) => {
      capture.iframeWrapperRef.current = el;

      if (iframeSizeObserverRef.current) {
        iframeSizeObserverRef.current.disconnect();
        iframeSizeObserverRef.current = null;
      }

      if (el) {
        const ro = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          setIframeSize({
            w: Math.round(entry.contentRect.width),
            h: Math.round(entry.contentRect.height),
          });
        });
        ro.observe(el);
        iframeSizeObserverRef.current = ro;
      } else {
        setIframeSize(null);
      }
    },
    [capture.iframeWrapperRef]
  );

  useEffect(() => {
    return () => {
      iframeSizeObserverRef.current?.disconnect();
    };
  }, []);

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

  if (needsInstall) {
    return (
      <div className="preview-install-prompt">
        <div className="preview-install-icon" aria-hidden>
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
        <h3>Dependencies not installed</h3>
        <p className="hint">
          This project hasn't run <code>{needsInstall.packageManager} install</code> yet.
        </p>
        <button className="btn-primary" onClick={onRunInstall} disabled={!onRunInstall}>
          Install with {needsInstall.packageManager}
        </button>
      </div>
    );
  }

  if (conn.isLoading || conn.isStopped || conn.hasError) {
    // The agent handoff only makes sense for real dev servers (static projects
    // have no server log to diagnose) and when a Claude terminal is wired up.
    const handleFixWithAgent =
      onSendToClaude && !isStaticProject
        ? () => {
            const logs = stripAnsi(devServerOutput).split('\n').slice(-200).join('\n').trim();
            const prompt =
              `My dev server isn't coming up — Ship Studio is waiting on ` +
              `http://localhost:${port} but it never responds.\n\n` +
              (logs
                ? `Recent dev-server output:\n\n\`\`\`\n${logs}\n\`\`\`\n\n`
                : `There's no dev-server output yet.\n\n`) +
              `Please work out why it won't start — a busy port, a crash, a missing ` +
              `dependency, or a wrong or missing dev script — and fix it so it serves on ` +
              `port ${port}.`;
            onSendToClaude(prompt);
            void trackEvent('preview_fix_with_agent', { has_logs: !!logs });
          }
        : undefined;

    return (
      <DevServerStatus
        phase={conn.isStopped ? 'stopped' : conn.hasError ? 'error' : 'loading'}
        isStaticProject={isStaticProject}
        port={port}
        retryCount={conn.retryCount}
        maxRetries={SERVER_MAX_RETRIES}
        devServerOutput={devServerOutput}
        onStop={conn.stopConnecting}
        onRetry={conn.handleRetry}
        onFixWithAgent={handleFixWithAgent}
        onInput={onDevServerInput}
      />
    );
  }

  return (
    <div
      className={`preview-container${isFullscreen ? ' preview-container--fullscreen' : ''}${
        editor.editMode && editorPinned ? ' preview-container--editor-pinned' : ''
      }${showTree ? ' preview-container--tree' : ''}`}
      data-logs={showLogs ? 'open' : 'closed'}
      style={{
        ...(showLogs && inspectPanelHeight !== null
          ? {
              gridTemplateRows: `auto minmax(0, 1fr) var(--handle-size) ${inspectPanelHeight}px`,
            }
          : undefined),
        ...(isFullscreen ? { top: chromeTop } : undefined),
      }}
    >
      <div className="preview-toolbar">
        {editorEnabled && (
          <button
            type="button"
            className={`preview-edit-toggle${editor.editMode ? ' active' : ''}`}
            onClick={editor.toggleEditMode}
            title="Toggle visual editor"
            aria-pressed={editor.editMode}
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
              className={`preview-edit-toggle-switch ${editor.editMode ? 'is-on' : ''}`}
              aria-hidden
            />
          </button>
        )}

        {onToggleLogs && (
          <button
            type="button"
            className={`preview-logs-toggle ${showLogs ? 'active' : ''}`}
            onClick={onToggleLogs}
            title={showLogs ? 'Hide inspector' : 'Show inspector'}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Inspect</span>
            <span className={`preview-logs-toggle-switch ${showLogs ? 'is-on' : ''}`} aria-hidden />
          </button>
        )}

        {/* Locale Switcher — only for projects with 2+ configured languages */}
        <PreviewLocaleSwitcher
          projectPath={projectPath}
          currentPage={conn.currentPage}
          onNavigate={conn.handlePageSelect}
          onConfigChange={setLocaleConfig}
        />

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
                    selectPageKeepingLocale(conn.filteredPages[0].route);
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
                      onClick={() => selectPageKeepingLocale(page.route)}
                    >
                      <span className="page-item-route">{page.route}</span>
                      {page.route === '/' && <span className="page-item-hint">Home</span>}
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
          <ResetIcon size={14} />
        </button>

        <button
          type="button"
          className="preview-fullscreen-btn"
          onClick={() => setIsFullscreen((f) => !f)}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
          aria-pressed={isFullscreen}
        >
          {isFullscreen ? <CompactIcon size={14} /> : <ExpandIcon size={14} />}
        </button>

        {isFullscreen && editor.editMode && (
          <button
            type="button"
            className={`preview-tree-btn${treeVisible ? ' active' : ''}`}
            onClick={toggleTreeVisible}
            title={treeVisible ? 'Hide element tree' : 'Show element tree'}
            aria-pressed={treeVisible}
          >
            <PanelLeftIcon size={14} />
          </button>
        )}

        {previewPlugins}

        {iframeSize && iframeSize.w > 0 && iframeSize.h > 0 && (
          <button
            type="button"
            className="preview-dimensions"
            title={onSendToClaude ? 'Click to send to agent' : undefined}
            disabled={!onSendToClaude}
            aria-label={`Preview dimensions ${iframeSize.w} by ${iframeSize.h}${
              onSendToClaude ? ', click to send to agent' : ''
            }`}
            onClick={() => {
              if (!onSendToClaude) return;
              onSendToClaude(
                `The preview viewport is currently ${iframeSize.w} × ${iframeSize.h} (width × height in CSS pixels).`
              );
            }}
          >
            {iframeSize.w} × {iframeSize.h}
          </button>
        )}

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

        {conn.serverReady && conn.externalUrl && <BrowserDropdown url={conn.externalUrl} />}
      </div>
      <div
        className="preview-viewport"
        ref={resize.setViewportRefs}
        data-education-id="preview-viewport"
      >
        {/* Overlay to capture mouse events during resize */}
        {(resize.isResizing || resize.isVerticalResizing) && (
          <div
            className={`preview-resize-overlay${
              resize.isVerticalResizing ? ' preview-resize-overlay--vertical' : ''
            }`}
          />
        )}
        <div
          className={`preview-frame-grid${
            resize.customWidth !== null && resize.customHeight !== null
              ? ' preview-frame-grid--floating'
              : ''
          }`}
          style={{
            width:
              resize.customWidth === null
                ? 'calc(100% - 4px)'
                : `${resize.customWidth + RESIZE_HANDLE_PX}px`,
            maxWidth: 'calc(100% - 4px)',
            // While Inspect is open the bottom resize handle is hidden, so
            // we ignore (but preserve) the user's customHeight to avoid an
            // unreachable floating-iframe state. The value comes back when
            // Inspect closes and the handle returns.
            height:
              resize.customHeight === null || showLogs
                ? '100%'
                : `${resize.customHeight + RESIZE_HANDLE_PX}px`,
            maxHeight: '100%',
          }}
        >
          <div ref={setIframeWrapperEl} className="preview-iframe-wrapper">
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
          {/* Right (horizontal) resize handle — height tracks iframe via grid */}
          <div className="preview-resize-handle" onMouseDown={resize.handleResizeStart}>
            <div className="preview-resize-handle-bar" />
          </div>
          {/* Bottom (vertical) resize handle — width tracks iframe via grid */}
          <div
            className="preview-resize-handle preview-resize-handle--vertical"
            onMouseDown={resize.handleVerticalResizeStart}
          >
            <div className="preview-resize-handle-bar preview-resize-handle-bar--vertical" />
          </div>
        </div>
      </div>
      {showLogs && (
        <div
          className="inspect-resize-handle"
          onMouseDown={handleInspectResizeStart}
          onKeyDown={handleInspectResizeKey}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize inspect panel"
          tabIndex={0}
        >
          <div className="inspect-resize-handle-bar" />
        </div>
      )}
      {isInspectResizing && <div className="inspect-resize-overlay" />}
      <InspectPanel
        ref={inspectPanelRef}
        hidden={!showLogs}
        projectPath={projectPath}
        devServerOutput={devServerOutput}
        devServerOutputVersion={devServerOutputVersion}
        onClose={onToggleLogs}
        onSendToAgent={onSendToClaude}
        activeTab={inspectTab}
        onActiveTabChange={onInspectTabChange}
        healthPanelRef={healthPanelRef}
        onHealthOutput={onHealthOutput}
        onDevServerInput={onDevServerInput}
        onDevServerResize={onDevServerResize}
      />
      {showTree && (
        <ElementTreePanel
          tree={elementTree.tree}
          truncated={elementTree.truncated}
          selectedId={elementTree.selectedId}
          onSelect={elementTree.selectNode}
          onHover={elementTree.hoverNode}
        />
      )}
      {editor.editMode &&
        (() => {
          // Floating mode portals to <body> (position:fixed is the only way to
          // composite above the iframe in WebKit). Pinned mode renders in-tree
          // as the container's second grid column — it never overlaps the
          // iframe, and the grid guarantees it can't cover surrounding chrome.
          const panel = (
            <VisualEditorPanel
              selection={editor.selection}
              projectPath={projectPath}
              currentClass={editor.currentClass}
              textResolution={editor.textResolution}
              imageResolution={editor.imageResolution}
              onReplaceImage={editor.replaceImage}
              textBlockedNonce={editor.textBlockedNonce}
              breakpoints={breakpoints}
              activeBreakpoint={activeBreakpoint}
              breakpointTooWide={breakpointTooWide}
              onSelectBreakpoint={(bp) => {
                setPinnedBreakpoint(bp);
                // Jump the canvas to a breakpoint's width so you can see it; Base
                // applies at all widths, so leave the canvas where it is.
                if (bp.minPx > 0) resize.previewAtWidth(bp.minPx);
              }}
              autoSave={editor.autoSave}
              onToggleAutoSave={editor.toggleAutoSave}
              onStepGap={(dir) => editor.stepSpacing('gap', dir)}
              onSetSide={editor.setBoxSide}
              onApplyEnum={editor.applyEnum}
              onReset={editor.reset}
              multiTarget={editor.multiTarget}
              onMultiTargetChange={editor.setMultiTarget}
              usage={editor.usage}
              onOpenInCode={onOpenInCode}
              onCommit={() => void editor.commit()}
              onClose={editor.toggleEditMode}
              pinned={editorPinned}
              onTogglePin={toggleEditorPinned}
            />
          );
          return editorPinned ? panel : createPortal(panel, document.body);
        })()}
    </div>
  );
});

export type InspectTab = 'logs' | 'browser' | 'health';

interface InspectPanelProps {
  hidden: boolean;
  projectPath: string;
  devServerOutput: string;
  devServerOutputVersion: number;
  onClose?: () => void;
  onSendToAgent?: (text: string) => void;
  /** Controlled tab. When set, the component is fully controlled. */
  activeTab?: InspectTab;
  onActiveTabChange?: (tab: InspectTab) => void;
  healthPanelRef?: RefObject<HealthTabPanelRef | null>;
  onHealthOutput?: (data: string) => void;
  /** Type into the dev-server PTY — answers interactive CLI prompts. */
  onDevServerInput?: (data: string) => void;
  /** Sync the dev-server PTY size to the logs terminal. */
  onDevServerResize?: (cols: number, rows: number) => void;
}

const InspectPanel = forwardRef<HTMLDivElement, InspectPanelProps>(function InspectPanel(
  {
    hidden,
    projectPath,
    devServerOutput,
    devServerOutputVersion,
    onClose,
    onSendToAgent,
    activeTab: activeTabProp,
    onActiveTabChange,
    healthPanelRef,
    onHealthOutput,
    onDevServerInput,
    onDevServerResize,
  },
  ref
) {
  const [activeTabLocal, setActiveTabLocal] = useState<InspectTab>('logs');
  const activeTab = activeTabProp ?? activeTabLocal;
  const setActiveTab = onActiveTabChange ?? setActiveTabLocal;

  return (
    <div ref={ref} className="preview-logs-panel" aria-hidden={hidden}>
      <div className="preview-logs-header">
        <div className="preview-logs-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'logs'}
            className={`preview-logs-tab ${activeTab === 'logs' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            Server Logs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'browser'}
            className={`preview-logs-tab ${activeTab === 'browser' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('browser')}
          >
            Browser Tools
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'health'}
            className={`preview-logs-tab ${activeTab === 'health' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('health')}
          >
            Health
          </button>
        </div>
        {onClose && (
          <button
            type="button"
            className="preview-logs-close"
            onClick={onClose}
            title="Hide panel"
            aria-label="Hide panel"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {/* Both tab contents stay mounted and stack in the same grid cell.
          Toggling `is-active` swaps visibility via CSS (opacity) so
          DevServerLogs doesn't re-init xterm (and BrowserTools doesn't
          re-subscribe to the store) every time the user switches tabs.
          `inert` on inactive slots blocks keyboard focus and pointer
          events without needing pointer-events: none (which doesn't
          compose cleanly with nested slot hierarchies). */}
      <div className="preview-logs-body">
        <div className={`preview-logs-slot ${activeTab === 'logs' ? 'is-active' : ''}`}>
          <DevServerLogs
            output={devServerOutput}
            outputVersion={devServerOutputVersion}
            onSendToAgent={onSendToAgent}
            onInput={onDevServerInput}
            onResize={onDevServerResize}
          />
        </div>
        <div className={`preview-logs-slot ${activeTab === 'browser' ? 'is-active' : ''}`}>
          <BrowserTools onSendToAgent={onSendToAgent} />
        </div>
        <div className={`preview-logs-slot ${activeTab === 'health' ? 'is-active' : ''}`}>
          <HealthTabPanel
            ref={healthPanelRef}
            projectPath={projectPath}
            onAskClaude={onSendToAgent}
            onHealthOutput={onHealthOutput}
          />
        </div>
      </div>
    </div>
  );
});
