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
import { usePreviewConnection, SERVER_MAX_RETRIES } from '../../hooks/usePreviewConnection';
import { useAgentBridge } from '../../hooks/useAgentBridge';
import { AgentActivityOverlay } from './AgentActivityOverlay';
import { PreviewSizeControl } from './PreviewSizeControl';
import { usePreviewCapture } from '../../hooks/usePreviewCapture';
import {
  usePreviewResize,
  BREAKPOINTS,
  RESIZE_HANDLE_PX,
  type Breakpoint,
} from '../../hooks/usePreviewResize';
import { useOptionalToast } from '../../contexts/ToastContext';
import { DevServerLogs } from '../terminal/DevServerLogs';
import { DevServerStatus } from '../terminal/DevServerStatus';
import { stripAnsi } from '../../lib/ansi';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { trackEvent } from '../../lib/analytics';
import { BrowserTools } from './BrowserTools';
import { HealthTabPanel, type HealthTabPanelRef } from '../code/HealthTabPanel';
import { BrowserDropdown } from './BrowserDropdown';
import { useVisualEditor } from '../../hooks/useVisualEditor';
import { useTextEditing } from '../../hooks/useTextEditing';
import { useElementStructure } from '../../hooks/useElementStructure';
import { ElementToolbar } from '../edit/ElementToolbar';
import { useCssCascadeEditor } from '../../hooks/useCssCascadeEditor';
import { useElementSettings } from '../../hooks/useElementSettings';
import { useCssVariables } from '../../hooks/useCssVariables';
import { useCssAnimations } from '../../hooks/useCssAnimations';
import { CssCascadePanel } from '../edit/CssCascadePanel';
import { useBreakpoints } from '../../hooks/useBreakpoints';
import {
  BASE_BREAKPOINT,
  isTailwindActive,
  projectUsesReact,
  type Breakpoint as TwBreakpoint,
} from '../../lib/edit';
import { VisualEditorPanel } from '../edit/VisualEditorPanel';
import { ElementTreePanel } from '../edit/ElementTreePanel';
import { useElementTree } from '../../hooks/useElementTree';
import { PreviewLocaleSwitcher, type PreviewLocaleConfig } from './PreviewLocaleSwitcher';
import { CompactIcon, ExpandIcon, PanelLeftIcon, ResetIcon, UndoIcon, RedoIcon } from '../icons';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { pathLocale, switchPathLocale } from '../../lib/i18n';
import { kbd } from '../../lib/shortcuts';
import { useCommands } from '../../commands/useCommands';
import { logger } from '../../lib/logger';
import { hubspotExternalOrigin } from '../../lib/hubspot';
import type { ProjectType } from '../../lib/static-server';
import type { DevServerUnexpectedExit } from '../../hooks/useDevServer';
import { isEditorFramework, resolveEditorMode } from '../../lib/editorGate';

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
  /** Set when the managed dev-server process died without Ship Studio
   *  stopping it (crash, or an external kill — e.g. an agent in the terminal
   *  freeing the port). Switches the status card to a "Dev server stopped"
   *  state whose primary action is a real process restart. */
  devServerUnexpectedExit?: DevServerUnexpectedExit | null;
  /** Restart the managed dev-server process (full kill-port → clear-cache →
   *  respawn pipeline). Wired to the status card when the process is dead —
   *  a poll-only Retry can never recover from that (issue #161). */
  onRestartDevServer?: () => void;
  /** Action wired to the install CTA — kicks off the install flow + restart. */
  onRunInstall?: () => void;
  /** Jump to a source file:line in the Code tab (from the visual editor). */
  onOpenInCode?: (file: string, line: number) => void;
  /** Snapshot undo/redo, surfaced in the fullscreen toolbar. */
  canUndo?: boolean;
  canRedo?: boolean;
  undoTitle?: string;
  redoTitle?: string;
  onUndo?: () => void;
  onRedo?: () => void;
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
    devServerUnexpectedExit,
    onRestartDevServer,
    onRunInstall,
    onOpenInCode,
    canUndo,
    canRedo,
    undoTitle,
    redoTitle,
    onUndo,
    onRedo,
  },
  ref
) {
  const { showToast } = useOptionalToast();
  // Stable identity: this is threaded into many editor hooks as a dependency. An
  // inline function here would change every render, re-firing their load effects (and
  // wiping optimistic edits like a just-added keyframe step before it saves).
  const onToast = useCallback(
    (message: string, type?: 'success' | 'error') => showToast(message, type),
    [showToast]
  );
  // Server connection, health checks, page navigation (extracted to hook)
  const conn = usePreviewConnection({
    port,
    projectPath,
    externalOrigin: projectType === 'hubspotcms' ? hubspotExternalOrigin(port) : undefined,
    tlsUpstream: projectType === 'hubspotcms',
    isDevServerRestarting,
    isStaticProject,
    onServerReady,
    onPageChange,
    onSendToClaude,
    onToast,
  });

  // The managed dev-server process is known-dead (the exit watcher saw it die
  // and no respawn has happened since). Static projects are excluded — they
  // serve off the per-window static server, not a PTY-managed process — and a
  // restart in flight means the death is already being handled.
  const serverProcessGone =
    !isStaticProject && !isDevServerRestarting && devServerUnexpectedExit != null;

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

  // Agent preview bridge: an MCP server the workspace agent uses to read the
  // preview's console/network/DOM, click/type/scroll in it, navigate it,
  // resize its viewport, and take screenshots. (Below `resize` because the
  // viewport tool drives it.)
  useAgentBridge({
    projectPath,
    currentUrl: conn.serverReady ? conn.currentUrl : null,
    serverReady: conn.serverReady,
    currentPath: conn.currentPage,
    pages: conn.filteredPages.map((p) => p.route),
    navigate: conn.handlePageSelect,
    reload: conn.handleRefresh,
    setViewport: (value) =>
      typeof value === 'number'
        ? resize.previewAtWidth(value)
        : resize.handleBreakpointClick(value),
    getViewportWidth: () => resize.customWidth,
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

  // Right-click menu forwarded from inside the preview iframe (the injected
  // proxy script intercepts contextmenu). Gives the preview a "back" without
  // adding toolbar chrome: the iframe keeps its own session history, so back
  // is just history.back() executed inside the frame.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent<{ type?: string; x?: number; y?: number }>) => {
      const data = event.data;
      if (!data || data.type !== 'shipstudio:context-menu') return;
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
      setCtxMenu({ x: data.x, y: data.y });
    };
    const dismiss = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const handlePreviewBack = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'shipstudio:go-back' }, '*');
    setCtxMenu(null);
  }, []);
  // The editor only works when Tailwind actually compiles in the project — a bare
  // `@import "tailwindcss"` without the Vite/PostCSS plugin produces dead classes.
  // Gate on a backend check so projects without Tailwind never show the edit button.
  const [tailwindActive, setTailwindActive] = useState(false);
  // Vite is React-flavored? The className→source resolver only indexes
  // `.tsx`/`.jsx`, so a Vite + Vue/Svelte project would get an edit button that
  // can never write back. Gate Vite on React; meta-frameworks below are gated by
  // type. False until the backend check resolves (so the button never flashes).
  const [viteUsesReact, setViteUsesReact] = useState(false);
  useEffect(() => {
    if (projectType !== 'vite' || !projectPath) {
      setViteUsesReact(false);
      return;
    }
    let cancelled = false;
    projectUsesReact(projectPath)
      .then((isReact) => !cancelled && setViteUsesReact(isReact))
      .catch(() => !cancelled && setViteUsesReact(false));
    return () => {
      cancelled = true;
    };
  }, [projectType, projectPath]);
  const editorFramework = isEditorFramework({ projectType, viteUsesReact });
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

  // Visual editor supports className/class string resolution for React (Next.js
  // and Vite), Astro, and Shopify Liquid templates — all resolve the same way in
  // the Rust backend. The Tailwind gate keeps plain-CSS themes from showing an
  // edit button whose class writes would never compile. Which editor a project
  // qualifies for (Tailwind vs code-first CSS) is decided by the pure gate in
  // `lib/editorGate.ts` — the two are mutually exclusive.
  const qualifiedEditorMode = resolveEditorMode({ projectType, tailwindActive, viteUsesReact });
  const editorEnabled = conn.serverReady && qualifiedEditorMode === 'tailwind';

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
  // The selected edit breakpoint can exceed the width the canvas actually
  // renders at (e.g. a pinned wide layer while the canvas is narrower); edits
  // then apply but aren't visible, so the panel shows a note. A preset wider
  // than the pane does NOT trigger this: it renders at its true CSS width and
  // is only scaled down visually (previewScale), so its media queries hold.
  const renderedWidth = resize.customWidth ?? resize.viewportWidth;
  const breakpointTooWide =
    activeBreakpoint.minPx > 0 && renderedWidth > 0 && renderedWidth < activeBreakpoint.minPx;

  // Visual editor (Next.js, Vite/React, Astro). Inert until the user toggles edit mode.
  const editor = useVisualEditor({
    iframeRef,
    projectPath,
    enabled: editorEnabled,
    activeBreakpoint,
    breakpoints,
    onToast,
  });

  // Code-first CSS editor — a SEPARATE feature for vanilla-CSS projects (Astro or
  // Next.js without Tailwind, or plain HTML/CSS). Mutually exclusive with the
  // Tailwind editor above: framework+Tailwind → `editor`; vanilla CSS →
  // `cssEditor`. Same toggle and selection experience; it surfaces the clicked
  // element's full cascade and edits the real `.css` source (not utility classes).
  // For Next.js this covers global stylesheets (e.g. app/globals.css); CSS-Module
  // rules can't be mapped back (hashed class names) and render read-only with an
  // explanation.
  const cssEditorEnabled = conn.serverReady && qualifiedEditorMode === 'css';
  const cssEditor = useCssCascadeEditor({
    iframeRef,
    projectPath,
    enabled: cssEditorEnabled,
    cssModulesHint: projectType === 'nextjs',
    onToast,
  });
  // Settings tab (element tag/classes/attributes) — shares the cascade selection.
  const elementSettings = useElementSettings({
    iframeRef,
    projectPath,
    enabled: cssEditorEnabled,
    signature: cssEditor.selection?.signature ?? null,
    onToast,
  });
  // The CSS panel's active scope (Element / Variables / Animations), lifted so the
  // Cmd+K palette can open the editor straight to a given scope.
  const [cssScope, setCssScope] = useState<'element' | 'variables' | 'animations'>('element');
  // Project-global scopes of the CSS panel: design tokens + animations.
  const cssVariables = useCssVariables({
    iframeRef,
    projectPath,
    enabled: cssEditor.editMode,
    onToast,
  });
  const cssAnimations = useCssAnimations({
    projectPath,
    enabled: cssEditor.editMode,
    onToast,
  });
  // Which editor (if any) the toolbar toggle and panel drive.
  const editorMode: 'tailwind' | 'css' | null = editorEnabled
    ? 'tailwind'
    : cssEditorEnabled
      ? 'css'
      : null;
  const activeEditMode = editor.editMode || cssEditor.editMode;
  // Inline text editing (double-click copy) is shared by both styling editors —
  // mounted once here, active whenever either editor's edit mode is on, so it
  // works for vanilla-CSS/Astro projects (cssEditor) as well as Tailwind.
  const textEditing = useTextEditing({
    iframeRef,
    projectPath,
    enabled: activeEditMode,
    onToast,
  });
  // Structural edits (insert / duplicate / delete) — shared by both styling
  // editors the same way text editing is; drives the canvas toolbar and the
  // element tree's context menu.
  const structure = useElementStructure({
    iframeRef,
    projectPath,
    enabled: activeEditMode,
    onToast,
  });
  // Imperative opener for the toolbar's insert palette (Cmd+K "Insert element…").
  const openInsertMenuRef = useRef<(() => void) | null>(null);
  const toggleActiveEditor =
    editorMode === 'css' ? cssEditor.toggleEditMode : editor.toggleEditMode;

  // ── Cmd+K commands for the native CSS editor (vanilla-CSS projects only). The panel
  // is opened by toggling edit mode; the scope state lets a command land straight on
  // Variables or Animations. Registered only when this editor applies to the project.
  const cssEditorOn = cssEditor.editMode;
  const cssToggleEditMode = cssEditor.toggleEditMode;
  const openCssEditor = useCallback(
    (scope: 'element' | 'variables' | 'animations') => {
      try {
        setCssScope(scope);
        if (!cssEditorOn) cssToggleEditMode();
      } catch (err) {
        const detail = formatCommandError(asCommandError(err));
        onToast(`Could not open the CSS editor: ${detail}`, 'error');
        logger.error('[Preview] openCssEditor failed', { error: detail });
      }
    },
    [cssEditorOn, cssToggleEditMode, onToast]
  );
  useCommands(
    () =>
      cssEditorEnabled
        ? [
            {
              id: 'edit.css',
              title: cssEditorOn ? 'Exit CSS editor' : 'Edit CSS (visual cascade editor)',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['css', 'style', 'cascade', 'edit', 'visual', 'stylesheet'],
              run: () => {
                try {
                  if (cssEditorOn) cssToggleEditMode();
                  else openCssEditor('element');
                } catch (err) {
                  const detail = formatCommandError(asCommandError(err));
                  onToast(`Could not toggle the CSS editor: ${detail}`, 'error');
                  logger.error('[Preview] toggle CSS editor failed', { error: detail });
                }
              },
            },
            {
              id: 'css.variables',
              title: 'CSS variables (design tokens)',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['css', 'variable', 'custom property', 'token', 'theme', '--'],
              run: () => openCssEditor('variables'),
            },
            {
              id: 'css.animations',
              title: 'CSS animations (@keyframes)',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['css', 'animation', 'keyframes', 'motion', 'transition'],
              run: () => openCssEditor('animations'),
            },
          ]
        : [],
    [cssEditorEnabled, cssEditorOn, cssToggleEditMode, openCssEditor, onToast]
  );

  // ── Cmd+K commands for structural editing. Registered only while an edit mode
  // is on; each needs a canvas selection to act on (toast otherwise, so the
  // command never fails silently).
  const structureSelection = structure.selection;
  const structureInsertOpen = useCallback(() => {
    if (!structureSelection) {
      onToast('Select an element on the canvas first', 'error');
      return;
    }
    openInsertMenuRef.current?.();
  }, [structureSelection, onToast]);
  useCommands(
    () =>
      activeEditMode
        ? [
            {
              id: 'edit.insertElement',
              title: 'Insert element…',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['add', 'element', 'div', 'insert', 'new', 'paragraph', 'section'],
              run: structureInsertOpen,
            },
            {
              id: 'edit.duplicateElement',
              title: 'Duplicate selected element',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['duplicate', 'copy', 'element', 'clone'],
              run: () => {
                if (!structureSelection) {
                  onToast('Select an element on the canvas first', 'error');
                  return;
                }
                void structure.duplicate();
              },
            },
            {
              id: 'edit.deleteElement',
              title: 'Delete selected element',
              category: 'action' as const,
              when: 'project' as const,
              keywords: ['delete', 'remove', 'element'],
              run: () => {
                if (!structureSelection) {
                  onToast('Select an element on the canvas first', 'error');
                  return;
                }
                void structure.remove();
              },
            },
          ]
        : [],
    [
      activeEditMode,
      structureSelection,
      structure.duplicate,
      structure.remove,
      structureInsertOpen,
      onToast,
    ]
  );

  // Exact-size popover (dimensions readout). The palette command opens it via
  // a bump signal so the popover state can stay local to the control.
  const [sizePopoverSignal, setSizePopoverSignal] = useState(0);
  useCommands(
    () => [
      {
        id: 'preview.setSize',
        title: 'Set exact preview size…',
        category: 'action' as const,
        when: 'project' as const,
        keywords: [
          'viewport',
          'width',
          'height',
          'breakpoint',
          'resize',
          'dimensions',
          'responsive',
        ],
        run: () => setSizePopoverSignal((s) => s + 1),
      },
    ],
    []
  );

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
  const showTree = isFullscreen && activeEditMode && treeVisible;
  // The Elements panel's Code (markup-edit) view needs a wider column than the
  // navigator; the tree panel reports its view so we can widen the grid track.
  const [treeCodeView, setTreeCodeView] = useState(false);
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

  // Force refresh the preview iframe via an about:blank round-trip (the URL
  // carries no cache-buster, so re-setting the same src wouldn't be a reliable
  // reload; the proxy serves HTML with no-store, so the round-trip refetches).
  // Uses currentPage (tracked via proxy) so it refreshes the actual visible page,
  // not the stale iframe src attribute (which doesn't update on client-side navigation).
  const refresh = useCallback(() => {
    if (iframeRef.current && conn.serverReady) {
      conn.setIframePath(conn.currentPage);
      const refreshUrl = `${conn.baseUrl}${conn.currentPage === '/' ? '' : conn.currentPage}`;
      iframeRef.current.src = 'about:blank';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = refreshUrl;
        }
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specific conn properties are listed; conn object changes on every render
  }, [conn.serverReady, conn.baseUrl, conn.currentPage, conn.setIframePath]);

  // Imperative reload requests from the connection hook (toolbar refresh on the
  // current page, static-project file changes). Token 0 is the "no reload
  // requested" reset on project/port switches — never fire on it.
  const prevReloadTokenRef = useRef(0);
  useEffect(() => {
    if (conn.reloadToken === prevReloadTokenRef.current) return;
    prevReloadTokenRef.current = conn.reloadToken;
    if (conn.reloadToken !== 0) refresh();
  }, [conn.reloadToken, refresh]);

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

  // Agent handoff for preview failures — always-available recovery whenever a
  // Claude terminal is wired up. Two flavors: the server never came up
  // ('server-down', shown by DevServerStatus), and the server is healthy but
  // the page never rendered inside the embedded iframe ('blank-iframe', shown
  // by the watchdog overlay — issue #179, e.g. a Clerk dev-keys redirect loop).
  const handleFixWithAgent = useMemo(() => {
    if (!onSendToClaude) return undefined;
    return (reason: 'server-down' | 'blank-iframe') => {
      const logs = isStaticProject
        ? ''
        : stripAnsi(devServerOutput).split('\n').slice(-200).join('\n').trim();
      let prompt: string;
      if (reason === 'blank-iframe') {
        prompt =
          `My project's dev server on http://localhost:${port} is up and responding, but ` +
          `the page renders BLANK inside Ship Studio's embedded preview iframe. It may ` +
          `still load fine in a regular browser tab — the failure is specific to being ` +
          `framed.\n\n` +
          (logs ? `Recent dev-server output:\n\n\`\`\`\n${logs}\n\`\`\`\n\n` : '') +
          `Likely causes to check, in order:\n` +
          `1. An auth-middleware redirect loop. Clerk DEVELOPMENT keys are the classic ` +
          `case: clerkMiddleware bounces the first visit through ` +
          `<your-app>.clerk.accounts.dev to set a handshake cookie; embedded previews ` +
          `block that third-party cookie, so the page redirects until the browser aborts ` +
          `("too many HTTP redirects") and the frame stays empty. Fix by scoping the ` +
          `middleware matcher to only the routes that need auth, or by using a ` +
          `production auth instance.\n` +
          `2. A client-side crash before first paint (check the code that runs on load).\n` +
          `3. A Content-Security-Policy or framing restriction the app adds itself.\n\n` +
          `Please find the cause and fix it so the page renders inside an iframe.`;
      } else if (isStaticProject) {
        prompt =
          `My site preview isn't loading. Ship Studio is serving this project as static ` +
          `files on http://localhost:${port} but nothing shows up. Please check the project ` +
          `has an index.html at its root (and any files it references) so the preview renders.`;
      } else if (serverProcessGone) {
        // The process demonstrably died out from under us — usually an agent
        // killed the port or crashed the build. Steer the agent AWAY from
        // spawning its own dev server: a second unmanaged server fighting
        // Ship Studio's is exactly what breaks multi-agent workflows (#161).
        const exitCode = devServerUnexpectedExit?.exitCode;
        prompt =
          `Ship Studio runs and manages this project's dev server itself on port ${port}, ` +
          `but the dev-server process just stopped unexpectedly` +
          `${typeof exitCode === 'number' ? ` (exit code ${exitCode})` : ''}.\n\n` +
          (logs
            ? `Its last output was:\n\n\`\`\`\n${logs}\n\`\`\`\n\n`
            : `It produced no output before stopping.\n\n`) +
          `Please find and fix the underlying cause (a crash, a broken build, a corrupted ` +
          `cache, something killing the process). IMPORTANT: do NOT start your own dev ` +
          `server (no \`npm run dev\` or similar) and do NOT kill or free port ${port} — ` +
          `Ship Studio owns the dev server and I will restart it from the preview once ` +
          `the cause is fixed. If another process is already listening on port ${port}, ` +
          `tell me instead of killing it.`;
      } else {
        prompt =
          `My dev server isn't coming up — Ship Studio is waiting on ` +
          `http://localhost:${port} but it never responds.\n\n` +
          (logs
            ? `Recent dev-server output:\n\n\`\`\`\n${logs}\n\`\`\`\n\n`
            : `There's no dev-server output yet.\n\n`) +
          `Please work out why it won't start — a busy port, a crash, a missing ` +
          `dependency, or a wrong or missing dev script — and fix the cause. ` +
          `IMPORTANT: do NOT start a dev server yourself and do NOT kill or free ` +
          `port ${port} — Ship Studio starts and manages the dev server on that port ` +
          `itself, and a second unmanaged server will fight it.`;
      }
      onSendToClaude(prompt);
      void trackEvent('preview_fix_with_agent', {
        has_logs: !!logs,
        is_static: isStaticProject,
        reason,
        process_gone: serverProcessGone,
      });
    };
  }, [
    onSendToClaude,
    isStaticProject,
    devServerOutput,
    port,
    serverProcessGone,
    devServerUnexpectedExit,
  ]);

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
        <Button variant="primary" onClick={onRunInstall} disabled={!onRunInstall}>
          Install with {needsInstall.packageManager}
        </Button>
      </div>
    );
  }

  if (conn.isLoading || conn.isStopped || conn.hasError) {
    return (
      <DevServerStatus
        // A known-dead process escalates straight to the error card — polling
        // a port nothing listens on can only end in the same place, minutes
        // later, so don't make the user sit through the retry loop.
        phase={
          conn.isStopped ? 'stopped' : conn.hasError || serverProcessGone ? 'error' : 'loading'
        }
        isStaticProject={isStaticProject}
        port={port}
        retryCount={conn.retryCount}
        maxRetries={SERVER_MAX_RETRIES}
        devServerOutput={devServerOutput}
        onStop={conn.stopConnecting}
        onRetry={conn.handleRetry}
        processExited={serverProcessGone}
        exitCode={devServerUnexpectedExit?.exitCode ?? null}
        onRestartServer={onRestartDevServer}
        onFixWithAgent={handleFixWithAgent && (() => handleFixWithAgent('server-down'))}
        onInput={onDevServerInput}
      />
    );
  }

  return (
    <div
      className={`preview-container${isFullscreen ? ' preview-container--fullscreen' : ''}${
        activeEditMode && editorPinned ? ' preview-container--editor-pinned' : ''
      }${showTree ? ' preview-container--tree' : ''}${
        showTree && treeCodeView ? ' preview-container--tree-code' : ''
      }`}
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
        {editorMode ? (
          <button
            type="button"
            className={`preview-edit-toggle${activeEditMode ? ' active' : ''}`}
            onClick={toggleActiveEditor}
            title="Toggle visual editor"
            aria-pressed={activeEditMode}
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
            <span className="preview-toolbar-btn-label">Edit</span>
            <span
              className={`preview-edit-toggle-switch ${activeEditMode ? 'is-on' : ''}`}
              aria-hidden
            />
          </button>
        ) : (
          // Preview-capable but not editable: show the toggle grayed out with a
          // tooltip explaining what visual editing is and where it works.
          <span className="preview-edit-toggle-wrap">
            <button
              type="button"
              className="preview-edit-toggle preview-edit-toggle--disabled"
              aria-disabled="true"
              tabIndex={-1}
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
              <span className="preview-toolbar-btn-label">Edit</span>
            </button>
            <span className="preview-edit-tooltip" role="tooltip">
              <strong>Visual editing</strong>
              <span>
                Click elements in the preview to edit their styles — no code. Works with Next.js,
                Astro, Vite (React), and Shopify projects styled with Tailwind, and with Astro or
                plain HTML/CSS projects styled with regular CSS.
              </span>
            </span>
          </span>
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
            <span className="preview-toolbar-btn-label">Inspect</span>
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

        {/* Undo/redo live in the workspace header, which is hidden in fullscreen
            — surface them here so visual edits can be undone while editing. */}
        {isFullscreen && onUndo && (
          <button
            type="button"
            className="preview-fullscreen-btn"
            onClick={onUndo}
            disabled={!canUndo}
            title={undoTitle ?? `Undo last change (${kbd('mod', 'Z')})`}
            aria-label="Undo"
          >
            <UndoIcon size={14} />
          </button>
        )}
        {isFullscreen && onRedo && (
          <button
            type="button"
            className="preview-fullscreen-btn"
            onClick={onRedo}
            disabled={!canRedo}
            title={redoTitle ?? `Redo (${kbd('mod', 'shift', 'Z')})`}
            aria-label="Redo"
          >
            <RedoIcon size={14} />
          </button>
        )}

        <button
          type="button"
          className="preview-fullscreen-btn"
          onClick={() => setIsFullscreen((f) => !f)}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
          aria-pressed={isFullscreen}
        >
          {isFullscreen ? <CompactIcon size={14} /> : <ExpandIcon size={14} />}
        </button>

        {isFullscreen && activeEditMode && (
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

        {iframeSize &&
          iframeSize.w > 0 &&
          iframeSize.h > 0 &&
          (() => {
            // The wrapper reports its VISUAL box; when the frame is scaled to
            // fit, the page actually lays out at the true (unscaled) size —
            // that's the honest number to show (and to let the user set).
            const w = Math.round(iframeSize.w / resize.previewScale);
            const h = Math.round(iframeSize.h / resize.previewScale);
            return (
              <PreviewSizeControl
                width={w}
                height={h}
                hasCustomHeight={resize.customHeight !== null}
                scalePercent={
                  resize.previewScale < 1 ? Math.round(resize.previewScale * 100) : null
                }
                onApply={resize.previewAtSize}
                onFit={() => resize.handleBreakpointClick('full')}
                openSignal={sizePopoverSignal}
              />
            );
          })()}

        <div className="preview-breakpoints" data-education-id="breakpoints">
          {(Object.keys(BREAKPOINTS) as Breakpoint[]).map((bp) => {
            // Every preset is always available — one wider than the pane
            // renders at true size and scales down to fit (previewScale).
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
            // A width wider than the pane keeps its true size in the iframe
            // and shrinks visually via previewScale — the grid (and with it
            // the wrapper, handles, crop overlay and drag math) stays at the
            // VISUAL size so every parent-side measurement remains in screen
            // space.
            width:
              resize.customWidth === null
                ? 'calc(100% - 4px)'
                : `${Math.round(resize.customWidth * resize.previewScale) + RESIZE_HANDLE_PX}px`,
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
              onLoad={conn.handleIframeLoad}
              // Scale-to-fit (Chrome-DevTools style): lay the page out at the
              // true breakpoint width and shrink the rendering to the wrapper.
              // Height is inflated by 1/scale so the scaled result fills the
              // wrapper exactly. In-iframe overlays (visual editor) live in
              // the scaled coordinate space and need no mapping.
              style={
                resize.previewScale < 1 && resize.customWidth !== null
                  ? {
                      width: `${resize.customWidth}px`,
                      height: `${100 / resize.previewScale}%`,
                      transform: `scale(${resize.previewScale})`,
                      transformOrigin: 'top left',
                    }
                  : undefined
              }
            />
            {ctxMenu && (
              <div
                className="preview-context-menu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="preview-context-menu-item"
                  onClick={handlePreviewBack}
                >
                  Back to previous screen
                </button>
              </div>
            )}
            {/* Structural-edit toolbar, tracking the canvas selection box */}
            {activeEditMode && (
              <ElementToolbar
                selection={structure.selection}
                bounds={iframeSize}
                busy={structure.busy}
                hidden={structure.textEditing}
                onInsert={(position, kind) => void structure.insert(position, kind)}
                onDuplicate={() => void structure.duplicate()}
                onDelete={() => void structure.remove()}
                openMenuRef={openInsertMenuRef}
              />
            )}
            {/* Agent activity layer: glow + cursor + action chip while the
                workspace agent drives the preview through the agent bridge. */}
            <AgentActivityOverlay />
            {/* Blank-iframe watchdog overlay: the server is healthy top-level but
                the page never proved it rendered inside the embedded iframe —
                e.g. an auth redirect loop aborted the subframe load (issue #179). */}
            {conn.iframeBlank && !isBranchSwitching && !isDevServerRestarting && (
              <div
                className="preview-iframe-error-overlay"
                data-education-id="preview-iframe-error"
              >
                <h3>The page isn't rendering in the preview</h3>
                <p>
                  The dev server is up, but this page never painted inside the embedded preview.
                  That usually means it failed in the iframe — commonly an auth-middleware redirect
                  loop (e.g. Clerk development keys) — even though it may load fine in a normal
                  browser.
                </p>
                <div className="preview-iframe-error-actions">
                  <Button variant="secondary" size="sm" onClick={conn.handleRefresh}>
                    Retry
                  </Button>
                  {handleFixWithAgent && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleFixWithAgent('blank-iframe')}
                    >
                      Fix with agent
                    </Button>
                  )}
                </div>
              </div>
            )}
            {/* Branch switching overlay */}
            {isBranchSwitching && (
              <div className="preview-branch-switching-overlay">
                <Spinner size="lg" style={{ color: 'var(--accent)' }} />
                <span>Switching branch...</span>
              </div>
            )}
            {/* Dev server restarting overlay */}
            {isDevServerRestarting && (
              <div className="preview-branch-switching-overlay">
                <Spinner size="lg" style={{ color: 'var(--accent)' }} />
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
          projectPath={projectPath}
          selectedSignature={
            (editorMode === 'css' ? cssEditor.selection?.signature : editor.selection?.signature) ??
            null
          }
          onViewChange={(v) => setTreeCodeView(v === 'code')}
          structure={{
            selectAndRun: structure.selectAndRun,
            insert: (position, kind) => void structure.insert(position, kind),
            duplicate: () => void structure.duplicate(),
            remove: () => void structure.remove(),
          }}
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
              textResolution={textEditing.textResolution}
              imageResolution={editor.imageResolution}
              onReplaceImage={editor.replaceImage}
              textBlockedNonce={textEditing.textBlockedNonce}
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
              onStepGap={(dir, step) => editor.stepSpacing('gap', dir, step)}
              onSetSide={editor.setBoxSide}
              onApplyEnum={editor.applyEnum}
              onReset={editor.reset}
              multiTarget={editor.multiTarget}
              onMultiTargetChange={editor.setMultiTarget}
              editTarget={editor.editTarget}
              customClasses={editor.customClasses}
              canCreateClass={editor.classEntryReady}
              onEditElement={editor.editElement}
              onEditClass={editor.editClass}
              onApplyClass={(name) => editor.applyClass(name)}
              onUnapplyClass={(name) => editor.unapplyClass(name)}
              onCreateClass={(name) => void editor.createClassFromStyles(name)}
              onAddFirstClass={(name) => editor.addFirstClass(name)}
              usage={editor.usage}
              onOpenInCode={onOpenInCode}
              onCommit={() => void editor.commit()}
              onClose={editor.toggleEditMode}
              pinned={editorPinned}
              onTogglePin={toggleEditorPinned}
            />
          );
          // Pinned: wrap in a relative "dock" grid cell and absolutely-position
          // the panel inside it. An absolute panel can't grow its grid track, so
          // it's forced to the cell's real (bounded) height and its body scrolls
          // — grid track-sizing was letting the in-flow panel grow past the
          // viewport in WebKit instead.
          return editorPinned ? (
            <div className="ss-edit-panel-dock">{panel}</div>
          ) : (
            createPortal(panel, document.body)
          );
        })()}
      {cssEditor.editMode &&
        (() => {
          // Same floating-vs-pinned strategy as the Tailwind panel above.
          const panel = (
            <CssCascadePanel
              selection={cssEditor.selection}
              rows={cssEditor.rows}
              loading={cssEditor.loading}
              bodies={cssEditor.bodies}
              overridden={cssEditor.overridden}
              onChangeBody={cssEditor.setBody}
              onDeleteRule={(key) => void cssEditor.deleteRule(key)}
              onWrapRule={(key, at) => void cssEditor.wrapRule(key, at)}
              onRenameRule={(key, sel) => void cssEditor.renameSelector(key, sel)}
              onRenameAtRule={(key, m) => void cssEditor.renameAtRule(key, m)}
              onAddSelector={(sel) => void cssEditor.addSelector(sel)}
              selectorSuggestions={cssEditor.classSuggestions.map((c) => `.${c}`)}
              existingSelectors={cssEditor.existingSelectors}
              variables={cssEditor.variableSuggestions}
              animations={cssEditor.animationSuggestions}
              justCreatedKey={cssEditor.justCreatedKey}
              settings={elementSettings}
              variablesState={cssVariables}
              animationsState={cssAnimations}
              onClose={cssEditor.toggleEditMode}
              pinned={editorPinned}
              onTogglePin={toggleEditorPinned}
              scope={cssScope}
              onScopeChange={setCssScope}
            />
          );
          return editorPinned ? (
            <div className="ss-edit-panel-dock">{panel}</div>
          ) : (
            createPortal(panel, document.body)
          );
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
          <BrowserTools onSendToAgent={onSendToAgent} active={!hidden && activeTab === 'browser'} />
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
