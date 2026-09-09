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
import { usePreviewConnection, SERVER_MAX_RETRIES } from '../../hooks/usePreviewConnection';
import { useAgentBridge } from '../../hooks/useAgentBridge';
import { AgentActivityOverlay } from './AgentActivityOverlay';
import { PreviewSizeControl } from './PreviewSizeControl';
import { PreviewCanvas, type CanvasZoom } from './PreviewCanvas';
import { usePreviewCapture } from '../../hooks/usePreviewCapture';
import { usePreviewEditorFrame } from '../../hooks/usePreviewEditorFrame';
import { DEFAULT_DEVICE_HEIGHT, DEVICE_HEIGHTS, type CanvasFrame } from '../../lib/previewCanvas';
import { Button } from '../primitives/Button';
import { MenuButton } from '../primitives/MenuButton';
import { ToggleButton } from '../primitives/ToggleButton';
import {
  usePreviewResize,
  BREAKPOINTS,
  RESIZE_HANDLE_PX,
  type Breakpoint,
} from '../../hooks/usePreviewResize';
import { useOptionalToast } from '../../contexts/ToastContext';
import { DevServerStatus } from '../terminal/DevServerStatus';
import { stripAnsi } from '../../lib/ansi';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { trackEvent } from '../../lib/analytics';
import { type HealthTabPanelRef } from '../code/HealthTabPanel';
import { BrowserDropdown } from './BrowserDropdown';
import { useVisualEditor } from '../../hooks/useVisualEditor';
import { useTextEditing } from '../../hooks/useTextEditing';
import { useElementStructure, type StructureSelection } from '../../hooks/useElementStructure';
import { ElementToolbar } from '../edit/ElementToolbar';
import { PreviewBreadcrumb } from './PreviewBreadcrumb';
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
import { VariablesPanel } from '../edit/VariablesPanel';
import { useElementTree } from '../../hooks/useElementTree';
import { useElementBreadcrumbVisibility } from '../../hooks/useElementBreadcrumbVisibility';
import { PreviewLocaleSwitcher, type PreviewLocaleConfig } from './PreviewLocaleSwitcher';
import {
  CompactIcon,
  ChevronIcon,
  DesktopIcon,
  EditIcon,
  ExpandIcon,
  FullBreakpointIcon,
  GridIcon,
  LaptopIcon,
  MobileIcon,
  PackageIcon,
  RedoIcon,
  ResetIcon,
  TabletIcon,
  TerminalIcon,
  UndoIcon,
} from '@/components/icons';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { Spinner } from '../primitives/Spinner';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import { DockablePanel } from '../primitives/DockablePanel';
import { useOptionalPanelDock, usePanelDockBinding } from '../../contexts/PanelDockContext';
import { isDocked } from '../../lib/workspaceLayout';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { InspectPanel, type InspectTab } from './InspectPanel';
export type { InspectTab } from './InspectPanel';
import { useCanvasCommentsLayer } from '../comments/CanvasComments';
import type { CommentAgent } from '../../lib/canvasComments';
import { pathLocale, switchPathLocale } from '../../lib/i18n';
import { kbd } from '../../lib/shortcuts';
import { useCommands } from '../../commands/useCommands';
import { logger } from '../../lib/logger';
import type { ProjectType } from '../../lib/static-server';
import type { DevServerUnexpectedExit } from '../../hooks/useDevServer';
import { isEditorFramework, resolveEditorMode } from '../../lib/editorGate';
import { Tooltip } from '../primitives/Tooltip';

const BreakpointIcon = ({ type }: { type: Breakpoint }) => {
  if (type === 'full') return <FullBreakpointIcon />;
  if (type === 'desktop') return <DesktopIcon />;
  if (type === 'laptop') return <LaptopIcon />;
  if (type === 'tablet') return <TabletIcon />;
  return <MobileIcon />;
};

const PREVIEW_BREAKPOINTS = Object.keys(BREAKPOINTS) as Breakpoint[];

/** The viewport tab that means "all of them at once". Deliberately not a
 *  breakpoint name, so it cannot collide with one. */
const CANVAS_TAB = 'canvas';

const PREVIEW_BREAKPOINT_OPTIONS = [
  ...PREVIEW_BREAKPOINTS.map((bp) => ({
    value: bp,
    label: BREAKPOINTS[bp].label,
    width: BREAKPOINTS[bp].width,
    icon: <BreakpointIcon type={bp} />,
  })),
  // The canvas is a viewport choice like any other, and this popover is the
  // only way to reach it once the icon strip is hidden at narrow widths.
  {
    value: CANVAS_TAB,
    label: 'Every breakpoint',
    width: '',
    icon: <GridIcon size={14} />,
  },
];

/**
 * A frame reports its selection box in its OWN pixels. Host-side editor chrome
 * draws at screen scale, so on the breakpoint canvas the rect has to come
 * through the canvas scale first. (In focus mode the scale is 1 and this is a
 * no-op.)
 */
const scaleSelection = (
  selection: StructureSelection | null,
  scale: number
): StructureSelection | null => {
  const rect = selection?.rect;
  if (!selection || !rect) return selection;
  return {
    ...selection,
    rect: {
      top: rect.top * scale,
      left: rect.left * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    },
  };
};

/** Props for the Preview component */
interface PreviewProps {
  commentBranch?: string | null;
  commentAgents?: CommentAgent[];
  activeCommentAgentId?: number;
  /** Comments open state lives in the workspace header, which owns the toggle. */
  commentsOpen?: boolean;
  onCommentsOpenChange?: (open: boolean) => void;
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
  /** Whether the preview may probe its port. The Preview shell stays mounted
   *  while project setup is still reserving the real port. */
  previewConnectionEnabled?: boolean;
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
  /** Whether the preview's element tree is visible. */
  elementTreeVisible: boolean;
  /** Whether Elements occupies its preview-side dock or floats over the workspace. */
  elementTreePinned: boolean;
  /** Switch Elements between docked and floating modes. */
  onToggleElementTreePin: () => void;
  /** Hide Elements without changing its docked/floating preference. */
  onCloseElementTree: () => void;
  /** Reports whether the current preview is mounted and able to show the element tree. */
  onElementTreeAvailabilityChange?: (available: boolean) => void;
  /** Whether the standalone project Variables panel is open. */
  variablesPanelVisible?: boolean;
  /** Whether Variables occupies the preview's left-side dock. */
  variablesPanelPinned?: boolean;
  /** Switch Variables between its docked and floating modes. */
  onToggleVariablesPanelPin?: () => void;
  /** Closes the standalone project Variables panel. */
  onCloseVariablesPanel?: () => void;
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
  /** Toggle the active visual editor from a workspace-level shortcut. */
  toggleEditMode: () => void;
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

const ELEMENT_TREE_FLOATING_SIZE = { width: 360, height: 620 };
/** How wide the Elements panel asks to be in its Code (markup-edit) view.
 *  A request, not a rule: the rail uses it only until somebody drags the edge.
 *  Every other docked width now lives in `PANEL_META` — see `workspaceLayout`. */
const TREE_CODE_DEFAULT_WIDTH_PX = 420;

export const Preview = forwardRef<PreviewHandle, PreviewProps>(function Preview(
  {
    commentBranch = null,
    commentAgents = [],
    activeCommentAgentId,
    commentsOpen = false,
    onCommentsOpenChange,
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
    previewConnectionEnabled = true,
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
    elementTreeVisible,
    elementTreePinned,
    onToggleElementTreePin,
    onCloseElementTree,
    onElementTreeAvailabilityChange,
    variablesPanelVisible = false,
    variablesPanelPinned = false,
    onToggleVariablesPanelPin,
    onCloseVariablesPanel = () => undefined,
  },
  ref
) {
  const { showToast } = useOptionalToast();
  // Stable identity: this is threaded into many editor hooks as a dependency. An
  // inline function here would change every render, re-firing their load effects (and
  // wiping optimistic edits like a just-added keyframe step before it saves).
  const onToast = useCallback(
    (message: string, type?: 'success' | 'error' | 'info') => showToast(message, type),
    [showToast]
  );
  // Server connection, health checks, page navigation (extracted to hook)
  const conn = usePreviewConnection({
    port,
    projectPath,
    isDevServerRestarting,
    isStaticProject,
    enabled: previewConnectionEnabled,
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

  // ── Breakpoint canvas ──────────────────────────────────────────────────────
  // Every breakpoint at once, side by side, instead of one resizable frame.
  // Exactly one canvas frame is active: it is interactive, the visual editor
  // binds to it, and its width is the edit-target breakpoint.
  const [canvasMode, setCanvasMode] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState<CanvasZoom>('fit');
  const [canvasFrameId, setCanvasFrameId] = useState<Breakpoint>('desktop');
  const [canvasFrameEl, setCanvasFrameEl] = useState<HTMLIFrameElement | null>(null);
  // The canvas's own frame height, reported back so host-side editor chrome can
  // be clamped to the same box the frames occupy.
  const [canvasFrameStageHeight, setCanvasFrameStageHeight] = useState(0);
  // Device columns, widest first, straight off the toolbar's own presets so the
  // canvas and the breakpoint tabs can never disagree about a width. `full` has
  // no fixed width, so it isn't a column.
  const canvasFrames = useMemo<CanvasFrame[]>(
    () =>
      PREVIEW_BREAKPOINTS.filter((bp) => bp !== 'full').map((bp) => ({
        id: bp,
        label: BREAKPOINTS[bp].label,
        width: parseInt(BREAKPOINTS[bp].width, 10),
        // A frame's height is the viewport the page sees, so it comes from the
        // device, never from the pane.
        height: DEVICE_HEIGHTS[bp] ?? DEFAULT_DEVICE_HEIGHT,
      })),
    []
  );
  const canvasFrameWidth =
    canvasFrames.find((frame) => frame.id === canvasFrameId)?.width ?? canvasFrames[0].width;
  // One way in and out, so leaving the canvas by picking a breakpoint counts
  // the same as leaving it by the toggle. Not inside a state updater: React is
  // free to run one twice, and an analytics event is not something to send
  // twice.
  const setCanvasEnabled = useCallback(
    (next: boolean) => {
      setCanvasMode((current) => {
        if (current !== next) {
          void trackEvent('preview_canvas_toggled', { enabled: next, $screen_name: 'Workspace' });
        }
        return next;
      });
      // Leaving the canvas remounts the single preview frame, and it would open
      // at the path it was last TOLD to load — not where the canvas actually
      // is. Follow the navigation the user did on the canvas.
      if (!next && conn.currentPage !== conn.iframePath) conn.setIframePath(conn.currentPage);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specific conn properties are listed; conn object changes on every render
    [conn.currentPage, conn.iframePath, conn.setIframePath]
  );
  const toggleCanvasMode = useCallback(
    () => setCanvasEnabled(!canvasMode),
    [canvasMode, setCanvasEnabled]
  );
  // Where the activating click landed inside the newly activated frame, held until the
  // editor has finished binding to it (below).
  const pendingCanvasSelectRef = useRef<{ x: number; y: number } | null>(null);
  const activateCanvasFrame = useCallback((frameId: string, point?: { x: number; y: number }) => {
    pendingCanvasSelectRef.current = point ?? null;
    setCanvasFrameId(frameId as Breakpoint);
    void trackEvent('preview_canvas_frame_activated', { breakpoint: frameId });
  }, []);

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
    setViewport: (value) => {
      // A viewport request means one width — leave the canvas so the change is
      // actually visible instead of silently doing nothing behind four frames.
      setCanvasEnabled(false);
      if (typeof value === 'number') resize.previewAtWidth(value);
      else resize.handleBreakpointClick(value);
    },
    // On the canvas the width that matters is the ACTIVE frame's — it is the
    // frame the agent reads, clicks in, and screenshots. `resize.customWidth`
    // there is the stale focus-mode width from before the canvas was opened.
    getViewportWidth: () => (canvasMode ? canvasFrameWidth : resize.customWidth),
    canvasMode,
    // The activity overlay is drawn over the active frame's whole stage; on the
    // canvas only the host knows that box, because the page in there has been
    // told its viewport is a device.
    getOverlayFrameSize: () =>
      canvasMode ? { w: canvasFrameWidth, h: canvasFrameStageHeight } : null,
  });

  // Fullscreen: the rail goes position:fixed over the window below the active
  // workspace chrome (kept visible for navigation and publishing, and to leave
  // room for the macOS traffic lights). The iframe never remounts, so the page
  // state survives entering and leaving. ESC exits. The measurement of where
  // that chrome ends belongs to `WorkspaceDock`, which is what is positioned
  // against it.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen]);

  // Fullscreen is the *rail's* now. It used to be this container going
  // position:fixed, which worked while the docked panels were inside it; they
  // are columns of the workspace rail today, so the rail is what has to rise —
  // and the panels stay beside the canvas instead of being covered by it.
  const dock = useOptionalPanelDock();
  const setPreviewFullscreen = dock?.setPreviewFullscreen;
  useEffect(() => {
    setPreviewFullscreen?.(isFullscreen);
    return () => setPreviewFullscreen?.(false);
  }, [setPreviewFullscreen, isFullscreen]);

  // Dock the editor as a column of the rail instead of floating it over the
  // canvas. This is the layout's answer, not a `visualEditorPinned` flag of its
  // own: it is per project like every other panel's place, and the same
  // preference decides *where* in the rail it goes.
  const editorPinned = dock ? isDocked(dock.layout, 'editor') : false;
  const toggleEditorPinned = useCallback(
    () => dock?.setDocked('editor', !editorPinned),
    [dock, editorPinned]
  );

  // Inspect-panel vertical resize. Null = use the default 1fr split from CSS;
  // a number = explicit panel height in px (overrides via inline grid-template-rows).
  const [inspectPanelHeight, setInspectPanelHeight] = useState<number | null>(null);
  const [isInspectResizing, setIsInspectResizing] = useState(false);
  const inspectPanelRef = useRef<HTMLDivElement | null>(null);

  const computeMaxPanelHeight = useCallback((containerHeight: number) => {
    return Math.max(INSPECT_PANEL_MAX_FALLBACK_PX, containerHeight - INSPECT_VIEWPORT_RESERVE_PX);
  }, []);

  const resizeInspectPanel = useCallback(
    (clientY: number) => {
      const panel = inspectPanelRef.current;
      const container = panel?.parentElement;
      if (!panel || !container) return;

      const maxPanelHeight = computeMaxPanelHeight(container.clientHeight);
      const next = container.getBoundingClientRect().bottom - clientY;
      setInspectPanelHeight(Math.max(INSPECT_PANEL_MIN_HEIGHT_PX, Math.min(next, maxPanelHeight)));
    },
    [computeMaxPanelHeight]
  );

  const resizeInspectPanelBy = useCallback(
    (delta: number) => {
      const panel = inspectPanelRef.current;
      const container = panel?.parentElement;
      if (!panel || !container) return;

      const max = computeMaxPanelHeight(container.clientHeight);
      const current = inspectPanelHeight ?? panel.offsetHeight;
      setInspectPanelHeight(Math.max(INSPECT_PANEL_MIN_HEIGHT_PX, Math.min(current - delta, max)));
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
    // On the breakpoint canvas the active frame IS the width being edited.
    const width = canvasMode
      ? canvasFrameWidth
      : (resize.customWidth ?? (resize.viewportWidth || 1280));
    let active = breakpoints[0];
    for (const bp of breakpoints) if (bp.minPx <= width) active = bp;
    return active;
  }, [canvasMode, canvasFrameWidth, resize.customWidth, resize.viewportWidth, breakpoints]);
  // Keep a pin valid only while it still matches a known breakpoint (project switch).
  // A pin means nothing on the canvas: every breakpoint is on screen, so the
  // frame the user activated is the layer they mean to edit.
  const activeBreakpoint = canvasMode
    ? derivedBreakpoint
    : (pinnedBreakpoint && breakpoints.find((b) => b.name === pinnedBreakpoint.name)) ||
      derivedBreakpoint;
  // The selected edit breakpoint can exceed the width the canvas actually
  // renders at (e.g. a pinned wide layer while the canvas is narrower); edits
  // then apply but aren't visible, so the panel shows a note. A preset wider
  // than the pane does NOT trigger this: it renders at its true CSS width and
  // is only scaled down visually (previewScale), so its media queries hold.
  // On the breakpoint canvas it can never happen — the layer is the frame.
  const renderedWidth = resize.customWidth ?? resize.viewportWidth;
  const breakpointTooWide =
    !canvasMode &&
    activeBreakpoint.minPx > 0 &&
    renderedWidth > 0 &&
    renderedWidth < activeBreakpoint.minPx;

  // Everything frame-bound — the visual editor, the inspector, screenshot
  // cropping — follows the active frame through this one hook.
  const editorFrameRef = usePreviewEditorFrame({
    canvasMode,
    canvasFrameEl,
    focusFrameRef: iframeRef,
    captureTargetRef: capture.iframeWrapperRef,
  });

  // Visual editor (Next.js, Vite/React, Astro). Inert until the user toggles edit mode.
  const editor = useVisualEditor({
    iframeRef: editorFrameRef,
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
    iframeRef: editorFrameRef,
    projectPath,
    enabled: cssEditorEnabled,
    cssModulesHint: projectType === 'nextjs',
    onToast,
  });
  // Settings tab (element tag/classes/attributes) — shares the cascade selection.
  const elementSettings = useElementSettings({
    iframeRef: editorFrameRef,
    projectPath,
    enabled: cssEditorEnabled,
    signature: cssEditor.selection?.signature ?? null,
    onToast,
  });
  // The CSS panel's active view (Style / Settings / Animate), lifted so the Cmd+K
  // palette can open the editor straight to a given view.
  const [cssScope, setCssScope] = useState<'style' | 'settings' | 'animations'>('style');
  // Project-global CSS variables are available from their own workspace panel.
  const cssVariables = useCssVariables({
    iframeRef: editorFrameRef,
    projectPath,
    enabled: editor.editMode || cssEditor.editMode || variablesPanelVisible,
    onToast,
    onVariableDeleted: editor.reconcileDeletedVariable,
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
  useEffect(() => {
    onElementTreeAvailabilityChange?.(true);
    return () => onElementTreeAvailabilityChange?.(false);
  }, [onElementTreeAvailabilityChange]);
  // Inline text editing (double-click copy) is shared by both styling editors —
  // mounted once here, active whenever either editor's edit mode is on, so it
  // works for vanilla-CSS/Astro projects (cssEditor) as well as Tailwind.
  const textEditing = useTextEditing({
    iframeRef: editorFrameRef,
    projectPath,
    enabled: activeEditMode,
    onToast,
  });
  // Structural edits (insert / duplicate / delete / cut / copy / paste) — shared by both styling
  // editors the same way text editing is; drives the canvas toolbar and the
  // element tree's context menu.
  const structure = useElementStructure({
    iframeRef: editorFrameRef,
    projectPath,
    enabled: activeEditMode,
    onToast,
  });
  // Clicking a frame the user isn't working in yet activates it — and, if they
  // were editing, selects what they actually pointed at. Declared AFTER the
  // editor hooks so it runs after their own re-bind effects have posted
  // `ss:activate` to this frame; the script ignores a select while inert.
  useEffect(() => {
    const point = pendingCanvasSelectRef.current;
    if (!point) return;
    pendingCanvasSelectRef.current = null;
    if (!canvasMode || !canvasFrameEl || !activeEditMode) return;
    try {
      canvasFrameEl.contentWindow?.postMessage(
        { type: 'ss:selectAt', x: point.x, y: point.y },
        '*'
      );
    } catch {
      // The frame may have gone away between the click and this effect.
    }
  }, [canvasMode, canvasFrameEl, activeEditMode]);

  // Clicking the canvas background drops the element selection. Until now the
  // only way to get the outline off the design was to leave edit mode, which
  // also takes away the panel you were working in.
  const deselectOnCanvas = useCallback(() => {
    if (!activeEditMode) return;
    try {
      canvasFrameEl?.contentWindow?.postMessage({ type: 'ss:deselect' }, '*');
    } catch {
      // The frame may have gone away between the click and this call.
    }
  }, [activeEditMode, canvasFrameEl]);

  // Imperative opener for the toolbar's insert palette (Cmd+K "Insert element…").
  const openInsertMenuRef = useRef<(() => void) | null>(null);
  const toggleActiveEditor =
    editorMode === 'css' ? cssEditor.toggleEditMode : editor.toggleEditMode;

  // Comments bind to the frame the user is actually in, the same one the editor
  // binds to — on a canvas that is the active frame, not the focus frame.
  const comments = useCanvasCommentsLayer({
    projectPath,
    branch: commentBranch,
    iframeRef: editorFrameRef,
    agents: commentAgents,
    activeAgentId: activeCommentAgentId,
    open: commentsOpen,
    onOpenChange: onCommentsOpenChange ?? (() => undefined),
    currentPage: conn.currentPage,
    navigate: conn.handlePageSelect,
    available: conn.serverReady && !isBranchSwitching && !isCropMode,
    editing: activeEditMode,
    stopEditing: toggleActiveEditor,
  });

  // ── Cmd+K commands for the native CSS editor (vanilla-CSS projects only). The panel
  // is opened by toggling edit mode; the view state lets a command land straight on
  // Variables or Animations. Registered only when this editor applies to the project.
  const cssEditorOn = cssEditor.editMode;
  const cssToggleEditMode = cssEditor.toggleEditMode;
  const openCssEditor = useCallback(
    (scope: 'style' | 'settings' | 'animations') => {
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
                  else openCssEditor('style');
                } catch (err) {
                  const detail = formatCommandError(asCommandError(err));
                  onToast(`Could not toggle the CSS editor: ${detail}`, 'error');
                  logger.error('[Preview] toggle CSS editor failed', { error: detail });
                }
              },
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

  // ── Cmd+K commands for the breakpoint canvas. Always available on a project:
  // the canvas is a view of the preview, not an editor feature.
  useCommands(
    () => [
      {
        id: 'preview.breakpointCanvas',
        title: canvasMode ? 'Focus a single breakpoint' : 'Show every breakpoint',
        category: 'action' as const,
        when: 'project' as const,
        keywords: [
          'breakpoint',
          'canvas',
          'responsive',
          'side by side',
          'devices',
          'mobile',
          'tablet',
          'desktop',
        ],
        run: toggleCanvasMode,
      },
    ],
    [canvasMode, toggleCanvasMode]
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
              shortcut: kbd('mod', 'D'),
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
              shortcut: kbd('⌫'),
              keywords: ['delete', 'remove', 'element'],
              run: () => {
                if (!structureSelection) {
                  onToast('Select an element on the canvas first', 'error');
                  return;
                }
                void structure.remove();
              },
            },
            {
              id: 'edit.cutElement',
              title: 'Cut selected element',
              category: 'action' as const,
              when: 'project' as const,
              shortcut: kbd('mod', 'X'),
              keywords: ['cut', 'move', 'element'],
              run: () => {
                if (!structureSelection) {
                  onToast('Select an element on the canvas first', 'error');
                  return;
                }
                void structure.cut();
              },
            },
            {
              id: 'edit.copyElement',
              title: 'Copy selected element',
              category: 'action' as const,
              when: 'project' as const,
              shortcut: kbd('mod', 'C'),
              keywords: ['copy', 'element', 'children', 'subtree'],
              run: () => {
                if (!structureSelection) {
                  onToast('Select an element on the canvas first', 'error');
                  return;
                }
                void structure.copy();
              },
            },
            ...(structure.hasClipboard
              ? [
                  {
                    id: 'edit.pasteElement',
                    title: 'Paste element inside selection',
                    category: 'action' as const,
                    when: 'project' as const,
                    shortcut: kbd('mod', 'V'),
                    keywords: ['paste', 'element', 'children', 'subtree'],
                    run: () => {
                      if (!structureSelection) {
                        onToast('Select an element on the canvas first', 'error');
                        return;
                      }
                      void structure.paste();
                    },
                  },
                ]
              : []),
          ]
        : [],
    [
      activeEditMode,
      structureSelection,
      structure.duplicate,
      structure.remove,
      structure.cut,
      structure.copy,
      structure.paste,
      structure.hasClipboard,
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

  // Element tree (navigator) — available throughout Preview mode. Structural
  // actions remain exclusive to edit mode; outside it the panel is a read-only
  // view of the rendered page.
  const showTree = elementTreeVisible;
  const variablesPanelDocked = variablesPanelVisible && variablesPanelPinned;
  const [elementBreadcrumbEnabled, setElementBreadcrumbEnabled] = useElementBreadcrumbVisibility();
  useCommands(
    () => [
      {
        id: 'preview.toggleElementBreadcrumb',
        title: elementBreadcrumbEnabled ? 'Hide element breadcrumb' : 'Show element breadcrumb',
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['breadcrumb', 'element', 'path', 'navigation', 'appearance'],
        run: () => setElementBreadcrumbEnabled(!elementBreadcrumbEnabled),
      },
    ],
    [elementBreadcrumbEnabled, setElementBreadcrumbEnabled]
  );
  // The Elements panel's Code (markup-edit) view needs a wider column than the
  // navigator; the tree panel reports its view so we can widen the grid track.
  const [treeCodeView, setTreeCodeView] = useState(false);
  const effectiveTreeCodeView = activeEditMode && treeCodeView;
  /**
   * These three panels' places in the workspace.
   *
   * They render from here — they need the preview's own selection, element tree
   * and CSS state — but they no longer *sit* here. Each binding says which rail
   * slot to portal its placeholder into, and carries the header drag that moves
   * it. Their widths, their resize handles and their order are the rail's
   * business now; this file used to own about a hundred and eighty lines of
   * clamping, persistence and ResizeObservers for exactly three columns.
   */
  const treeDock = usePanelDockBinding('navigator');
  const variablesDock = usePanelDockBinding('variables');
  const editorDock = usePanelDockBinding('editor');
  // The loading/error branches render before the iframe exists. Start the tree
  // subscription when the preview is ready so its initial request reaches the
  // injected script even when the Elements panel is already open.
  const elementTree = useElementTree({
    iframeRef: editorFrameRef,
    enabled: showTree && conn.serverReady,
  });

  // The Code (markup-edit) view needs a wider column than the tree view. Asked
  // for rather than imposed: the rail honours it only while the layout has no
  // width of its own for this panel.
  const setTreeDefaultWidth = treeDock?.setDefaultWidth;
  useEffect(() => {
    setTreeDefaultWidth?.(effectiveTreeCodeView ? TREE_CODE_DEFAULT_WIDTH_PX : undefined);
  }, [setTreeDefaultWidth, effectiveTreeCodeView]);

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
      toggleEditMode: toggleActiveEditor,
    }),
    [
      capture.captureForClaude,
      capture.captureFullPage,
      capture.isCapturing,
      refresh,
      conn.serverReady,
      toggleActiveEditor,
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

  const breadcrumbSignature =
    editorMode === 'css' ? cssEditor.selection?.signature : editor.selection?.signature;
  const breadcrumbPath = breadcrumbSignature
    ? breadcrumbSignature.elementPath?.length
      ? breadcrumbSignature.elementPath
      : [
          {
            tagName: breadcrumbSignature.tagName,
            className: breadcrumbSignature.className,
            domPath: breadcrumbSignature.domPath ?? '',
          },
        ]
    : [];
  const breadcrumbVisible =
    !canvasMode && elementBreadcrumbEnabled && activeEditMode && breadcrumbPath.length > 0;
  const selectBreadcrumbItem = useCallback(
    (item: (typeof breadcrumbPath)[number]) => {
      if (!item.domPath) return;
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'ss:reselect',
          signature: {
            className: item.className,
            tagName: item.tagName,
            domPath: item.domPath,
            ancestorClasses: [],
          },
        },
        '*'
      );
    },
    [iframeRef]
  );

  if (needsInstall) {
    return (
      <div className="preview-install-prompt">
        <div className="preview-install-icon" aria-hidden>
          <PackageIcon size={32} />
        </div>
        <h3>Dependencies not installed</h3>
        <p className="text-style-hint">
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
      <>
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
          processExited={serverProcessGone || conn.serverStale}
          exitCode={devServerUnexpectedExit?.exitCode ?? null}
          onRestartServer={onRestartDevServer}
          onFixWithAgent={handleFixWithAgent && (() => handleFixWithAgent('server-down'))}
          onInput={onDevServerInput}
        />
      </>
    );
  }

  // Blank-page watchdog: the server is healthy top-level but the page never
  // proved it rendered inside an embedded frame — e.g. an auth redirect loop
  // aborted the subframe load (issue #179). Shared by both views; on the canvas
  // it is the difference between "nothing renders" and knowing why.
  const blankPageOverlay =
    conn.iframeBlank && !isBranchSwitching && !isDevServerRestarting ? (
      <div className="preview-iframe-error-overlay" data-education-id="preview-iframe-error">
        <h3>The page isn't rendering in the preview</h3>
        <p>
          The dev server is up, but this page never painted inside the embedded preview. That
          usually means it failed in the iframe — commonly an auth-middleware redirect loop (e.g.
          Clerk development keys) — even though it may load fine in a normal browser.
        </p>
        <div className="preview-iframe-error-actions">
          <Button variant="secondary" onClick={conn.handleRefresh}>
            Retry
          </Button>
          {handleFixWithAgent && (
            <Button variant="primary" onClick={() => handleFixWithAgent('blank-iframe')}>
              Fix with agent
            </Button>
          )}
        </div>
      </div>
    ) : null;

  return (
    // Three rows and one column. Every docked panel that used to be a column of
    // this grid — Variables, Elements, Edit — is a column of the workspace rail
    // now, which is what let eight `grid-template-columns` rules and seven
    // `.preview-toolbar { grid-column }` rules go.
    <div
      className="preview-container"
      data-logs={showLogs ? 'open' : 'closed'}
      style={
        showLogs && inspectPanelHeight !== null
          ? {
              gridTemplateRows: `auto minmax(0, 1fr) var(--handle-size) ${inspectPanelHeight}px`,
            }
          : undefined
      }
    >
      <div className="preview-toolbar">
        <div className="preview-toolbar-actions">
          <div className="preview-toolbar-control-group">
            {editorMode ? (
              <ToggleButton
                type="button"
                className="preview-edit-control"
                variant={activeEditMode ? 'secondary' : 'default'}
                onClick={toggleActiveEditor}
                title="Toggle visual editor"
                pressed={activeEditMode}
                aria-label="Edit"
              >
                <EditIcon size={13} />
                <span
                  className={`preview-edit-toggle-switch ${activeEditMode ? 'is-on' : ''}`}
                  aria-hidden
                />
              </ToggleButton>
            ) : (
              // Preview-capable but not editable: show the toggle grayed out with a
              // shared tooltip explaining why visual editing is unavailable.
              <Tooltip content="Visual editing is unavailable for this project. Supported projects can be edited by clicking elements in the preview.">
                <span className="preview-edit-toggle-wrap preview-edit-control">
                  <Button
                    type="button"
                    className="preview-edit-toggle--disabled"
                    aria-disabled="true"
                    tabIndex={-1}
                    aria-label="Edit"
                  >
                    <EditIcon size={13} />
                  </Button>
                </span>
              </Tooltip>
            )}

            {onToggleLogs && (
              <ToggleButton
                type="button"
                className="preview-inspect-control"
                variant={showLogs ? 'secondary' : 'default'}
                pressed={showLogs}
                onClick={onToggleLogs}
                title={showLogs ? 'Hide inspector' : 'Show inspector'}
                aria-label={showLogs ? 'Hide inspector' : 'Show inspector'}
                leftIcon={<TerminalIcon size={14} />}
              >
                <span
                  className={`preview-logs-toggle-switch ${showLogs ? 'is-on' : ''}`}
                  aria-hidden
                />
              </ToggleButton>
            )}

            {previewPlugins && <div className="preview-toolbar-plugins">{previewPlugins}</div>}

            {conn.serverReady && conn.externalUrl && (
              <BrowserDropdown
                url={conn.externalUrl}
                className="preview-browser-control"
                buttonClassName="preview-browser-control"
                iconOnly
              />
            )}
          </div>
        </div>

        {/* Locale Switcher — only for projects with 2+ configured languages */}
        <PreviewLocaleSwitcher
          projectPath={projectPath}
          currentPage={conn.currentPage}
          onNavigate={conn.handlePageSelect}
          onConfigChange={setLocaleConfig}
        />

        {/* Page Switcher */}
        <div className="page-switcher" data-education-id="page-switcher">
          {/* Controlled rather than uncontrolled: selecting a page with Enter
              from the search field has to close the menu, and the only handle
              on an uncontrolled Dropdown's open state is DropdownItem's own
              click. `showPageDropdown` was already being mirrored here — now
              it's the source of truth, so Enter and Escape can act on it. */}
          <Dropdown
            menuClassName="page-dropdown"
            open={conn.showPageDropdown}
            onOpenChange={(open) => {
              conn.setShowPageDropdown(open);
              if (!open) conn.setPageSearch('');
            }}
            trigger={(triggerProps) => (
              <MenuButton
                {...triggerProps}
                expanded={triggerProps['aria-expanded']}
                variant="default"
                className="page-switcher-trigger"
                rightIcon={<ChevronIcon size={12} />}
              >
                <span className="page-route">{conn.currentPage}</span>
                {conn.currentPage === '/' && <span className="page-route-context">Home</span>}
              </MenuButton>
            )}
          >
            <input
              ref={conn.searchInputRef}
              type="text"
              className="page-search"
              placeholder="Search pages..."
              value={conn.pageSearch}
              onChange={(e) => conn.setPageSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && conn.filteredPages.length > 0) {
                  e.preventDefault();
                  selectPageKeepingLocale(conn.filteredPages[0].route);
                  conn.setShowPageDropdown(false);
                  conn.setPageSearch('');
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
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
                  <DropdownItem
                    key={page.route}
                    active={page.route === conn.currentPage}
                    onSelect={() => selectPageKeepingLocale(page.route)}
                  >
                    <span className="page-item-route">{page.route}</span>
                    {page.route === '/' && <span className="page-item-hint">Home</span>}
                  </DropdownItem>
                ))
              )}
            </div>
          </Dropdown>
        </div>

        {onUndo && (
          <button
            type="button"
            className="preview-fullscreen-btn preview-history-btn"
            onClick={onUndo}
            disabled={!canUndo}
            title={undoTitle ?? `Undo last change (${kbd('mod', 'Z')})`}
            aria-label="Undo"
          >
            <UndoIcon size={14} />
          </button>
        )}
        {onRedo && (
          <button
            type="button"
            className="preview-fullscreen-btn preview-history-btn"
            onClick={onRedo}
            disabled={!canRedo}
            title={redoTitle ?? `Redo (${kbd('mod', 'shift', 'Z')})`}
            aria-label="Redo"
          >
            <RedoIcon size={14} />
          </button>
        )}

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

        <div className="preview-breakpoints" data-education-id="breakpoints">
          <div className="preview-breakpoints__inner">
            <Tabs
              // "Every breakpoint" is one of the viewport choices, not a mode on
              // top of one: it lives in the same segmented control so exactly one
              // thing is ever selected. Highlighting a device tab AND the canvas
              // button at the same time reads as two active states.
              value={canvasMode ? CANVAS_TAB : resize.getActiveBreakpoint()}
              mode="navigation"
              onValueChange={(value) => {
                if (value === CANVAS_TAB) {
                  setCanvasEnabled(true);
                  return;
                }
                setCanvasEnabled(false);
                resize.handleBreakpointClick(value as Breakpoint);
              }}
              className="preview-breakpoint-tabs"
            >
              <TabsList aria-label="Preview viewport sizes">
                {PREVIEW_BREAKPOINTS.map((bp) => (
                  <TabsTab
                    key={bp}
                    // The per-breakpoint modifier drives the responsive toolbar
                    // rules that hide these progressively as the pane narrows.
                    className={`preview-breakpoint-tab preview-breakpoint-tab--${bp} button--icon-only`}
                    value={bp}
                    size="default"
                    aria-label={BREAKPOINTS[bp].label}
                    title={`${BREAKPOINTS[bp].label} (${BREAKPOINTS[bp].width})`}
                  >
                    <BreakpointIcon type={bp} />
                  </TabsTab>
                ))}
                <TabsTab
                  value={CANVAS_TAB}
                  className="preview-breakpoint-tab preview-breakpoint-tab--canvas button--icon-only"
                  size="default"
                  data-education-id="breakpoint-canvas"
                  aria-label="Every breakpoint"
                  title="Every breakpoint, side by side"
                >
                  <GridIcon size={14} />
                </TabsTab>
              </TabsList>
            </Tabs>

            {!canvasMode &&
              iframeSize &&
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
                    activeBreakpoint={canvasMode ? CANVAS_TAB : resize.getActiveBreakpoint()}
                    breakpointOptions={PREVIEW_BREAKPOINT_OPTIONS}
                    onBreakpointChange={(value) => {
                      if (value === CANVAS_TAB) {
                        setCanvasEnabled(true);
                        return;
                      }
                      setCanvasEnabled(false);
                      resize.handleBreakpointClick(value as Breakpoint);
                    }}
                  />
                );
              })()}
          </div>
        </div>
      </div>
      <div
        className={`preview-viewport${breadcrumbVisible ? ' preview-viewport--with-breadcrumb' : ''}`}
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
        {canvasMode ? (
          <>
            {blankPageOverlay}
            <PreviewCanvas
              frames={canvasFrames}
              // Passive frames follow wherever the page actually is; `navSignal`
              // changes only on a deliberate navigation, so a link click inside
              // the active frame doesn't reload that same frame.
              url={`${conn.baseUrl}${conn.currentPage === '/' ? '' : conn.currentPage}`}
              navSignal={conn.iframePath}
              activeFrameId={canvasFrameId}
              reloadToken={conn.reloadToken}
              zoom={canvasZoom}
              onZoomChange={setCanvasZoom}
              onActivateFrame={activateCanvasFrame}
              onActiveFrameElement={setCanvasFrameEl}
              onStageHeightChange={setCanvasFrameStageHeight}
              onBackgroundClick={deselectOnCanvas}
              activeFrameOverlay={(scale) => (
                <>
                  {/* Agent activity layer. On the canvas it belongs to the
                    ACTIVE frame — that is the only frame the agent acts in,
                    and a glow around the whole canvas would claim otherwise. */}
                  <AgentActivityOverlay />
                  {comments.pins(scale, {
                    w: canvasFrameWidth * scale,
                    h: canvasFrameStageHeight * scale,
                  })}
                  {activeEditMode ? (
                    <ElementToolbar
                      // The frame reports the selection box in its OWN pixels; the
                      // toolbar draws at screen scale, so both the rect and the
                      // bounds it is clamped to come through the canvas scale.
                      selection={scaleSelection(structure.selection, scale)}
                      bounds={{
                        w: canvasFrameWidth * scale,
                        h: canvasFrameStageHeight * scale,
                      }}
                      busy={structure.busy}
                      hidden={structure.textEditing}
                      onInsert={(position, kind) => void structure.insert(position, kind)}
                      onDuplicate={() => void structure.duplicate()}
                      onDelete={() => void structure.remove()}
                      openMenuRef={openInsertMenuRef}
                    />
                  ) : null}
                </>
              )}
            />
          </>
        ) : (
          <div
            className={`preview-frame-grid${
              resize.customWidth !== null && resize.customHeight !== null
                ? ' preview-frame-grid--floating'
                : ''
            }${
              // Dragged all the way out (the drag snaps `customWidth` to null):
              // the handle collapses into the pane's own right edge instead of
              // stacking another gutter and two borders beside it.
              resize.customWidth === null ? ' preview-frame-grid--full-width' : ''
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
              // While Inspect is open the bottom resize handle is hidden, so
              // we ignore (but preserve) the user's customHeight to avoid an
              // unreachable floating-iframe state. The value comes back when
              // Inspect closes and the handle returns.
              height:
                resize.customHeight === null || showLogs
                  ? '100%'
                  : `${resize.customHeight + RESIZE_HANDLE_PX}px`,
            }}
          >
            <div
              ref={setIframeWrapperEl}
              className="preview-iframe-wrapper"
              // `overflow: hidden` still makes this a scroll container — one
              // with no scrollbar, so anything that scrolls it strands the
              // frame where the user cannot bring it back. Nothing scrolls it
              // on purpose; the overlays absolutely positioned over the frame
              // (comment composer, element toolbar, plugin panels) do it by
              // accident, because focus() reveals what it focuses. Snap back.
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop !== 0) el.scrollTop = 0;
                if (el.scrollLeft !== 0) el.scrollLeft = 0;
              }}
            >
              <iframe
                key={projectPath}
                ref={iframeRef}
                src={conn.serverReady ? conn.currentUrl : 'about:blank'}
                className="preview-iframe"
                title=""
                data-tooltip-disabled
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
              {/* Pinned comments, tracking their elements in the live frame.
                  The frame reports rects in its OWN pixels while this layer is
                  an unscaled sibling of it, so a shrunk-to-fit preview needs
                  the same previewScale the iframe's transform uses — at 1 the
                  pins and composer drift further from their elements the
                  further down the page they are, and slide at their own rate
                  when it scrolls. previewScale is 1 when nothing is scaled. */}
              {!canvasMode && comments.pins(resize.previewScale, iframeSize)}
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
              {blankPageOverlay}
              {/* Branch switching overlay */}
              {isBranchSwitching && (
                <div className="preview-branch-switching-overlay">
                  <Spinner size="lg" style={{ color: 'var(--accent-active)' }} />
                  <span>Switching branch...</span>
                </div>
              )}
              {/* Dev server restarting overlay */}
              {isDevServerRestarting && (
                <div className="preview-branch-switching-overlay">
                  <Spinner size="lg" style={{ color: 'var(--accent-active)' }} />
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
        )}
        {breadcrumbVisible && (
          <PreviewBreadcrumb path={breadcrumbPath} onSelect={selectBreadcrumbItem} />
        )}
      </div>
      {showLogs && (
        <PanelResizeHandle
          value={
            inspectPanelHeight ??
            inspectPanelRef.current?.offsetHeight ??
            INSPECT_PANEL_MIN_HEIGHT_PX
          }
          min={INSPECT_PANEL_MIN_HEIGHT_PX}
          max={computeMaxPanelHeight(
            inspectPanelRef.current?.parentElement?.clientHeight ?? INSPECT_PANEL_MAX_FALLBACK_PX
          )}
          label="Resize Inspect panel"
          orientation="horizontal"
          onResize={resizeInspectPanel}
          onResizeBy={resizeInspectPanelBy}
          onDragChange={setIsInspectResizing}
        />
      )}
      {isInspectResizing && <div className="panel-resize-overlay" />}
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
        <>
          <DockablePanel
            dock={treeDock}
            docked={elementTreePinned}
            ariaLabel="Elements panel"
            positionKey="elementTreeFloatingPosition"
            sizeKey="elementTreeFloatingSize"
            floatingSize={ELEMENT_TREE_FLOATING_SIZE}
            initialPosition={() => ({ left: 72, top: 96 })}
            surfaceClassName="dockable-panel__surface--preview"
          >
            <ElementTreePanel
              tree={elementTree.tree}
              truncated={elementTree.truncated}
              selectedId={elementTree.selectedId}
              hoveredId={elementTree.hoveredId}
              affectedIds={elementTree.affectedIds}
              onSelect={elementTree.selectNode}
              onHover={elementTree.hoverNode}
              projectPath={projectPath}
              selectedSignature={
                (editorMode === 'css'
                  ? cssEditor.selection?.signature
                  : editor.selection?.signature) ?? null
              }
              onViewChange={(v) => setTreeCodeView(v === 'code')}
              pinned={elementTreePinned}
              onTogglePin={onToggleElementTreePin}
              onClose={onCloseElementTree}
              structure={
                activeEditMode
                  ? {
                      selectAndRun: structure.selectAndRun,
                      insert: (position, kind) => void structure.insert(position, kind),
                      duplicate: () => void structure.duplicate(),
                      remove: () => void structure.remove(),
                      copy: () => void structure.copy(),
                      cut: () => void structure.cut(),
                      paste: () => void structure.paste(),
                      hasClipboard: structure.hasClipboard,
                      clipboardSourceNodeId: structure.clipboardSourceNodeId,
                    }
                  : undefined
              }
            />
          </DockablePanel>
        </>
      )}
      {editor.editMode && (
        // Both presentations are the same `DockablePanel` the other panels use:
        // the surface is portaled to <body> either way (position:fixed is the
        // only way to composite above the iframe in WebKit) and is positioned
        // over a rail slot when docked, over nothing when floating. Before this
        // it hand-rolled its own drag, its own fixed positioning and its own
        // grid cell, which is why it was the one panel you could not reorder.
        <DockablePanel
          dock={editorDock}
          docked={editorPinned}
          ariaLabel="Edit panel"
          positionKey="visualEditorFloatingPosition"
          sizeKey="visualEditorFloatingSize"
          floatingSize={{ width: 300, height: 620 }}
          minFloatingSize={{ width: 240, height: 320 }}
          initialPosition={() => ({ left: Math.max(24, window.innerWidth - 332), top: 76 })}
          surfaceClassName="dockable-panel__surface--preview"
        >
          <VisualEditorPanel
            selection={editor.selection}
            projectPath={projectPath}
            currentClass={editor.currentClass}
            variables={cssVariables.variables}
            tailwindVersion={editor.tailwindVersion}
            utilityPrefix={editor.utilityPrefix ?? undefined}
            spacingScale={editor.spacingScale ?? undefined}
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
            onSetPositionSide={editor.setPositionSide}
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
        </DockablePanel>
      )}
      {cssEditor.editMode && (
        <DockablePanel
          dock={editorDock}
          docked={editorPinned}
          ariaLabel="CSS panel"
          positionKey="cssPanelFloatingPosition"
          sizeKey="cssPanelFloatingSize"
          floatingSize={{ width: 360, height: 680 }}
          initialPosition={() => ({
            left: Math.max(24, window.innerWidth - 384),
            top: 76,
          })}
          surfaceClassName="dockable-panel__surface--preview"
        >
          <CssCascadePanel
            selection={cssEditor.selection}
            rows={cssEditor.rows}
            loading={cssEditor.loading}
            bodies={cssEditor.bodies}
            overridden={cssEditor.overridden}
            onChangeBody={cssEditor.setBody}
            onDeleteRule={(key) => cssEditor.deleteRule(key)}
            onWrapRule={(key, at) => void cssEditor.wrapRule(key, at)}
            onRenameRule={(key, sel) => void cssEditor.renameSelector(key, sel)}
            onRenameAtRule={(key, m) => void cssEditor.renameAtRule(key, m)}
            onAddSelector={(sel, atPrelude) => void cssEditor.addSelector(sel, atPrelude)}
            selectorSuggestions={cssEditor.classSuggestions.map((c) => `.${c}`)}
            existingSelectors={cssEditor.existingSelectors}
            variables={cssEditor.variableSuggestions}
            animations={cssEditor.animationSuggestions}
            settings={elementSettings}
            animationsState={cssAnimations}
            onClose={cssEditor.toggleEditMode}
            pinned={editorPinned}
            onTogglePin={toggleEditorPinned}
            scope={cssScope}
            onScopeChange={setCssScope}
          />
        </DockablePanel>
      )}
      {variablesPanelVisible && (
        <>
          <DockablePanel
            dock={variablesDock}
            docked={variablesPanelDocked}
            ariaLabel="Variables panel"
            positionKey="variablesPanelFloatingPosition"
            sizeKey="variablesPanelFloatingSize"
            floatingSize={{ width: 360, height: 680 }}
            minFloatingSize={{ width: 280, height: 320 }}
            initialPosition={() => ({
              left: Math.max(24, window.innerWidth - 384),
              top: 96,
            })}
            surfaceClassName="dockable-panel__surface--preview"
          >
            <VariablesPanel
              variablesState={cssVariables}
              pinned={variablesPanelDocked}
              onTogglePin={onToggleVariablesPanelPin}
              onClose={onCloseVariablesPanel}
            />
          </DockablePanel>
        </>
      )}
    </div>
  );
});
