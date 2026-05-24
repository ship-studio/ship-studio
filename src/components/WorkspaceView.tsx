/**
 * Workspace view component.
 *
 * Renders the full workspace UI including terminal panes, preview panel,
 * branch/PR tabs, compact mode, modals, and plugin slots.
 * Extracted from App.tsx to reduce root component size.
 *
 * Props are grouped by domain to avoid 80+ individual props.
 *
 * @module components/WorkspaceView
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../lib/logger';
import { setTerminalState } from '../lib/project';
import { Terminal } from './Terminal';
import { DevServerLogs } from './DevServerLogs';
import { Preview } from './Preview';
import type { PreviewHandle, InspectTab } from './Preview';
import { SplitPane } from './SplitPane';
import { BranchIndicator } from './BranchIndicator';
import { CodeTab } from './CodeTab';
import { BranchPRTabContainer } from './workspace/BranchPRTabContainer';
import { CompactWorkspace } from './CompactWorkspace';
import { MainBranchBanner } from './MainBranchBanner';
import type { HealthTabPanelRef } from './HealthTabPanel';
import { useIsCompact } from '../hooks/useIsCompact';
import { WorkspaceModals } from './WorkspaceModals';
import { WorkspaceHeader, HOSTING_PLUGIN_IDS } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { PluginSlot } from './PluginSlot';
import { UpdateBanner } from './UpdateBanner';
import { trackEvent } from '../lib/analytics';
import { useWorkspaceCommands } from '../commands/useWorkspaceCommands';
import {
  CameraIcon,
  CodeIcon,
  CropIcon,
  BranchIcon,
  PullRequestIcon,
  EyeIcon,
  EyeOffIcon,
  UndoIcon,
  RedoIcon,
} from './icons';
import { useSnapshots } from '../hooks/useSnapshots';
import { ToolbarDropdown } from './ToolbarDropdown';
import { TerminalSplitHeaders } from './TerminalSplitHeaders';
import { TerminalSplitDividers } from './TerminalSplitDividers';
import { PluginsDropdown } from './PluginsDropdown';
import { getAgentById } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';
import type { Project } from '../lib/project';
import type { ProjectType } from '../lib/static-server';
import type { TerminalTab } from '../hooks/useTerminalManagement';
import type { TerminalHandle } from './Terminal';
import type { Toast, ToastType } from '../hooks/useToasts';
import type { NotificationSettings } from '../lib/sounds';
import type { AgentStatus } from './Terminal';
import type { IntegrationState, AuthTerminalConfig } from '../hooks/useIntegrationStatus';
import type { BranchInfo, PullRequestInfo } from '../lib/branches';
import type { ChangedFile } from '../lib/git';
import type { LoadedPlugin } from '../hooks/usePlugins';
import type { PluginThemeData } from '../contexts/PluginContext';
import type { PinnedProjectRow } from '../hooks/usePinnedProjects';
import { useModal } from '../contexts/ModalContext';
import { sessionRegistry } from '../lib/sessionRegistry';
import '../styles/features/notifications.css';

// ---------------------------------------------------------------------------
// Domain-grouped prop interfaces
// ---------------------------------------------------------------------------

interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

interface TerminalProps {
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  terminalSessionId: number;
  /** Every active project's tab state — render Terminal components for
   *  all, hide non-current via CSS so PTYs stay alive. */
  allSessions: TerminalSessionView[];
  terminalRefsMap: React.MutableRefObject<Map<string, TerminalHandle | null>>;
  maxTerminalTabs: number;
  setActiveTerminalTab: (id: number) => void;
  addTerminalTab: () => void;
  closeTerminalTab: (id: number) => void;
  focusActiveTerminal: () => void;
  switchTabAgent: (tabId: number, agentId: string) => void;
  getActiveTabAgent: () => AgentConfig;
  /** Side-by-side view: tab ids visible in panes, or null when off. */
  splitPaneTabIds: number[] | null;
  /** Width of each pane as a percentage (sums to 100). Null when split off. */
  splitPaneSizes: number[] | null;
  enableSplitView: () => void;
  disableSplitView: () => void;
  setSplitPaneTab: (paneIndex: number, tabId: number) => void;
  addSplitPane: (tabId?: number) => void;
  removeSplitPane: (paneIndex: number) => void;
  setSplitPaneSizes: (sizes: number[]) => void;
}

interface DevServerProps {
  hasDevServer: boolean;
  healthPanelRef: RefObject<HealthTabPanelRef | null>;
  devServerPort: number;
  projectType: ProjectType;
  isRestartingDevServer: boolean;
  customDevCommand: string | null;
  devServerOutput: string;
  devServerOutputVersion: number;
  healthOutput: string;
  healthOutputVersion: number;
  handleHealthOutput: (data: string) => void;
  needsInstall: { packageManager: string } | null;
  onRunInstall: () => void;
}

interface NotificationProps {
  notificationSettings: NotificationSettings;
  showNotificationSettings: boolean;
  setShowNotificationSettings: (show: boolean) => void;
  attentionTabs: Set<number>;
  setAttentionTabs: React.Dispatch<React.SetStateAction<Set<number>>>;
  createTabStatusHandler: (
    projectPath: string,
    tabId: number
  ) => (status: AgentStatus, title: string) => void;
  handleSaveNotificationSettings: (settings: NotificationSettings) => void;
}

interface IntegrationProps {
  integrations: IntegrationState;
  handleGitHubConnect: () => void;
  authTerminalConfig: AuthTerminalConfig | null;
  closeAuthTerminal: () => void;
  handleAuthTerminalExit: (exitCode: number | null, projectPath?: string) => void;
  installTerminalConfig: {
    projectPath: string;
    packageManager: string;
    cwd: string;
    args: string[];
  } | null;
  installTerminalExited: boolean;
  onCloseInstallTerminal: () => void;
  onInstallTerminalExit: (exitCode: number | null) => void;
}

interface ScreenshotProps {
  isCapturing: boolean;
  isCropMode: boolean;
  setIsCropMode: (mode: boolean) => void;
  isCropCapturing: boolean;
  isFullPageCapturing: boolean;
  screenshotPreviewPath: string | null;
  setScreenshotPreviewPath: (path: string | null) => void;
  showScreenshotModal: boolean;
  setShowScreenshotModal: (show: boolean) => void;
  handleCaptureScreenshot: () => Promise<void>;
  handleCaptureFullPage: () => Promise<void>;
  handleCropStart: () => void;
  handleCropComplete: (filePath: string | null) => void;
  handleCropCancel: () => void;
}

interface LayoutProps {
  showHealthLogs: boolean;
  setShowHealthLogs: (show: boolean) => void;
  isPreviewHidden: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  workspaceTab: 'preview' | 'code' | 'branches' | 'prs';
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
}

interface PluginStateProps {
  pluginTerminal: {
    command: string;
    args: string[];
    title: string;
    resolve: (exitCode: number | null) => void;
  } | null;
  pluginTerminalExited: boolean;
  closePluginTerminal: () => void;
  handlePluginTerminalExit: (exitCode: number | null) => void;
  pluginSuggestion: { pluginName: string; projectPath: string; repoUrl: string } | null;
  setPluginSuggestion: (s: null) => void;
  pluginSuggestionInstalling: boolean;
  installSuggestedPlugin: (
    onSuccess: (msg: string) => void,
    onError: (msg: string) => void,
    reloadPlugins: () => Promise<void>
  ) => Promise<void>;
}

interface ModalProps {
  isEducationMode: boolean;
  setIsEducationMode: (mode: boolean) => void;
  closeEducation: () => void;
}

interface ToastProps {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
}

interface BranchProps {
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  showSubmitReview: string | null;
  setShowSubmitReview: (branch: string | null) => void;
  isBranchSwitching: boolean;
  gitError: {
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null;
  setGitError: (
    error: {
      errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
      message: string;
      branchName: string;
    } | null
  ) => void;
  showConflictResolution: boolean;
  setShowConflictResolution: (show: boolean) => void;
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  checkGitStatus: (projectPath: string) => Promise<void>;
  handleBranchSwitch: (branchName: string) => Promise<void>;
  handlePublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  handleResolveConflicts: (headBranch?: string, baseBranch?: string) => Promise<void>;
  handleConflictsResolved: () => void;
}

interface PluginProps {
  loadedPlugins: LoadedPlugin[];
  getSlotPlugins: (slotName: string) => LoadedPlugin[];
  reloadPlugins: () => Promise<void>;
}

interface LifecycleProps {
  autoAcceptMode: boolean;
  setCurrentPreviewPage: (page: string) => void;
  isPublishing: boolean;
  setIsPublishing: (p: boolean) => void;
  forcePublishOpen: boolean;
  setForcePublishOpen: (open: boolean) => void;
  showAutoAcceptWarning: boolean;
  setShowAutoAcceptWarning: (show: boolean) => void;
  handleBackToProjects: () => void;
  handleRestartDevServer: () => Promise<void>;
  handleGitHubStatusChange: () => void;
  handlePreviewReady: () => void;
  sendToClaude: (text: string) => void;
  handleTerminalExit: (code: number | null) => void;
  handleToolbarAutoAcceptToggle: () => void;
  handleAutoAcceptWarningAccept: () => void;
  handleSaveDevCommand: (command: string | null) => void;
  handleSavePort: (port: number) => void;
}

// ---------------------------------------------------------------------------
// WorkspaceViewProps
// ---------------------------------------------------------------------------

/** Plugin project data as constructed by App.tsx (devServerUrl always present) */
interface WorkspacePluginProject {
  name: string;
  path: string;
  currentBranch: string;
  hasUncommittedChanges: boolean;
  devServerUrl: string;
}

/** Plugin actions as constructed by App.tsx (showToast includes 'info') */
interface WorkspacePluginActions {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  refreshGitStatus: () => void;
  refreshBranches: () => void;
  focusTerminal: () => void;
  openUrl: (url: string) => void;
  openTerminal: (
    command: string,
    args: string[],
    options?: { title?: string }
  ) => Promise<number | null>;
}

export interface WorkspaceViewProps {
  currentProject: Project;
  previewRef: RefObject<PreviewHandle | null>;
  terminal: TerminalProps;
  devServer: DevServerProps;
  notifications: NotificationProps;
  integrationStatus: IntegrationProps;
  screenshots: ScreenshotProps;
  layout: LayoutProps;
  pluginState: PluginStateProps;
  modals: ModalProps;
  toasts: ToastProps;
  branchMgmt: BranchProps;
  plugins: PluginProps;
  lifecycle: LifecycleProps;
  pluginProject: WorkspacePluginProject | null;
  pluginActions: WorkspacePluginActions;
  pluginTheme: PluginThemeData;
  /** Project list shown in the workspace sidebar. */
  projectRows: PinnedProjectRow[];
  /** Switch to a different project from the sidebar. */
  onSelectProject: (projectPath: string) => void;
  /** Close an active project session from the sidebar. */
  onCloseProject: (projectPath: string) => void;
  /** Switch to another project and focus a specific tab (by session id). */
  onSelectProjectTab: (projectPath: string, tabSessionId: string) => void;
  /** Navigate to the Home (projects) view. */
  onGoHome: () => void;
  /** Open the project picker modal. */
  onOpenProjectPicker: () => void;
  /** Predicate: is a dev server currently tracked for the given project path?
   *  Used by the sidebar to populate background projects' Commands section. */
  isProjectDevServerRunning: (projectPath: string) => boolean;
}

export const WorkspaceView = memo(function WorkspaceView({
  currentProject,
  previewRef,
  terminal,
  devServer,
  notifications,
  integrationStatus,
  screenshots,
  layout,
  pluginState,
  modals,
  toasts,
  branchMgmt,
  plugins,
  lifecycle,
  pluginProject,
  pluginActions,
  pluginTheme,
  projectRows,
  onSelectProject,
  onCloseProject,
  onSelectProjectTab,
  onGoHome,
  onOpenProjectPicker,
  isProjectDevServerRunning,
}: WorkspaceViewProps) {
  // Window-width gate for the compact layout. Purely reactive — no Tauri
  // resize calls, no pinning. See src/hooks/useIsCompact.ts for the threshold.
  const isCompact = useIsCompact();

  // Destructure domain groups for readability in JSX
  const {
    terminalTabs,
    activeTerminalTab,
    allSessions,
    terminalRefsMap,
    maxTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    focusActiveTerminal,
    getActiveTabAgent,
    splitPaneTabIds,
    splitPaneSizes,
    enableSplitView,
    disableSplitView,
    setSplitPaneTab,
    addSplitPane,
    removeSplitPane,
    setSplitPaneSizes,
  } = terminal;

  // Modal context (Block 6 migration). Modals self-read open state via useModal('id');
  // we register focus side effects here for those that need the terminal re-focused.
  const envEditorModal = useModal('envEditor');
  const backupsModal = useModal('backups');
  const assetsPanelModal = useModal('assetsPanel');
  const helpModal = useModal('help');
  const skillsModal = useModal('skills');
  const mcpModal = useModal('mcp');
  const devCommandModal = useModal('devCommand');
  const projectSettingsModal = useModal('projectSettings');
  const pluginManagerModal = useModal('pluginManager');
  useEffect(() => {
    const cleanups = [
      envEditorModal.registerOnClose(focusActiveTerminal),
      backupsModal.registerOnClose(focusActiveTerminal),
      assetsPanelModal.registerOnClose(focusActiveTerminal),
      devCommandModal.registerOnClose(focusActiveTerminal),
      projectSettingsModal.registerOnClose(focusActiveTerminal),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [
    envEditorModal,
    backupsModal,
    assetsPanelModal,
    devCommandModal,
    projectSettingsModal,
    focusActiveTerminal,
  ]);

  const {
    hasDevServer,
    healthPanelRef,
    devServerPort,
    projectType,
    isRestartingDevServer,
    customDevCommand,
    devServerOutput,
    devServerOutputVersion,
    healthOutput,
    healthOutputVersion,
    handleHealthOutput,
    needsInstall,
    onRunInstall,
  } = devServer;

  const {
    notificationSettings,
    showNotificationSettings,
    setShowNotificationSettings,
    attentionTabs,
    setAttentionTabs,
    createTabStatusHandler,
    handleSaveNotificationSettings,
  } = notifications;

  const {
    integrations,
    handleGitHubConnect,
    authTerminalConfig,
    closeAuthTerminal,
    handleAuthTerminalExit,
    installTerminalConfig,
    installTerminalExited,
    onCloseInstallTerminal,
    onInstallTerminalExit,
  } = integrationStatus;

  const {
    isCapturing,
    isCropMode,
    setIsCropMode,
    isCropCapturing,
    screenshotPreviewPath,
    setScreenshotPreviewPath,
    showScreenshotModal,
    setShowScreenshotModal,
    handleCaptureScreenshot,
    handleCropStart,
    handleCropComplete,
    handleCropCancel,
  } = screenshots;

  const {
    showHealthLogs,
    setShowHealthLogs,
    isPreviewHidden,
    setIsPreviewHidden,
    workspaceTab,
    setWorkspaceTab,
  } = layout;

  // Split view is only meaningful when focus mode is on AND the current
  // project has ≥2 tabs AND the user has opted in (splitPaneTabIds set).
  const canSplit = isPreviewHidden && terminalTabs.length >= 2;
  const isSplitActive = canSplit && !!splitPaneTabIds && splitPaneTabIds.length >= 2;

  // Auto-disable split when preconditions break (focus exited, tab count
  // dropped, project changed). User opted into "disable entirely" — they
  // re-enable manually next time. `disableSplitView` no-ops if already off.
  useEffect(() => {
    if (splitPaneTabIds && !canSplit) {
      disableSplitView();
    }
  }, [canSplit, splitPaneTabIds, disableSplitView]);

  const {
    pluginTerminal,
    pluginTerminalExited,
    closePluginTerminal,
    handlePluginTerminalExit,
    pluginSuggestion,
    setPluginSuggestion,
    pluginSuggestionInstalling,
    installSuggestedPlugin,
  } = pluginState;

  const { isEducationMode, closeEducation } = modals;

  const { toasts: toastList, showToast, dismissToast } = toasts;

  const {
    currentBranch,
    branches,
    openPRs,
    hasUncommittedChanges,
    changedFiles,
    showSubmitReview,
    setShowSubmitReview,
    isBranchSwitching,
    gitError,
    setGitError,
    showConflictResolution,
    setShowConflictResolution,
    fetchBranchInfo,
    checkGitStatus,
    handleBranchSwitch,
    handlePublishError,
    handleResolveConflicts,
    handleConflictsResolved,
  } = branchMgmt;

  const { loadedPlugins, getSlotPlugins, reloadPlugins } = plugins;

  const {
    autoAcceptMode,
    setCurrentPreviewPage,
    isPublishing,
    setIsPublishing,
    forcePublishOpen,
    setForcePublishOpen,
    showAutoAcceptWarning,
    setShowAutoAcceptWarning,
    handleRestartDevServer,
    handleGitHubStatusChange,
    handlePreviewReady,
    sendToClaude,
    handleTerminalExit,
    handleToolbarAutoAcceptToggle,
    handleAutoAcceptWarningAccept,
    handleSaveDevCommand,
  } = lifecycle;

  // Cmd+Shift+S — capture viewport screenshot, Cmd+Shift+C — toggle crop mode
  // Only active when preview is visible (not hidden, and on preview tab for web projects)
  const previewVisible =
    projectType !== 'generic' && workspaceTab === 'preview' && !isPreviewHidden;

  // Listen for native menu accelerators (Cmd+Shift+S / Cmd+Shift+C).
  // Native accelerators work even when the cross-origin preview iframe has focus,
  // unlike window keydown listeners which the iframe swallows.
  useEffect(() => {
    if (!previewVisible) return;
    const unlistenScreenshot = listen('capture-screenshot', () => {
      if (!isCapturing && !isCropMode) {
        void handleCaptureScreenshot();
      }
    });
    const unlistenCrop = listen('toggle-crop', () => {
      if (!isCapturing && !isCropCapturing) {
        setIsCropMode(!isCropMode);
      }
    });
    return () => {
      void unlistenScreenshot.then((f) => f());
      void unlistenCrop.then((f) => f());
    };
  }, [
    previewVisible,
    isCapturing,
    isCropMode,
    isCropCapturing,
    handleCaptureScreenshot,
    setIsCropMode,
  ]);

  // Generic/unknown projects (Tauri apps, CLI tools, blank projects, etc.) don't have a web preview
  const isWebProject = projectType !== 'generic' && projectType !== 'unknown';

  // Reset the preview-side tab to its default whenever the user switches
  // projects. Web projects land on Preview; generic/unknown projects land
  // on Code (no preview available). Without this, switching from a web
  // project while on Branches/PRs would land you on Branches/PRs in the
  // next project too, which reads as "sticky state from the wrong place".
  useEffect(() => {
    setWorkspaceTab(isWebProject ? 'preview' : 'code');
    // Only re-fire on project path change. We deliberately *don't* depend
    // on `workspaceTab` here — that would force-revert every user click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject.path, isWebProject]);

  // Track terminal tab titles from PTY title changes. Titles live in the
  // session registry so (a) they're scoped per-project (tab ids are
  // per-project counters and would collide as a flat numeric map — that
  // collision is what made switching projects reset every tab's title) and
  // (b) background projects keep their titles visible in the sidebar.
  const handleTabTitleChange = useCallback(
    (projectPath: string, tabId: number) => (title: string) => {
      sessionRegistry.setTerminalTabTitle(projectPath, tabId, title);
    },
    []
  );

  // Manual rename from the sidebar's double-click → input flow. Updates the
  // registry (which becomes the display source of truth via `tabTitles`)
  // and writes the full tab list back to .shipstudio/project.json so the
  // rename survives across launches. An empty `name` clears the custom
  // title — useful for "undo my rename, go back to the agent name".
  const handleRenameTab = useCallback(
    (tabId: number, name: string) => {
      const projectPath = currentProject.path;
      sessionRegistry.setTerminalTabCustomTitle(projectPath, tabId, name || null);
      const customTitles = sessionRegistry.getCustomTitles(projectPath);
      const activeIdx = Math.max(
        0,
        terminalTabs.findIndex((t) => t.id === activeTerminalTab)
      );
      void setTerminalState(projectPath, {
        tabs: terminalTabs.map((t) => ({
          agent_id: t.agentId,
          session_id: t.sessionId,
          custom_title: customTitles.get(t.id),
        })),
        active_tab_index: activeIdx,
      }).catch((err) => {
        logger.warn('[RenameTab] Failed to persist custom title', {
          error: String(err),
          tabId,
        });
      });
    },
    [currentProject.path, terminalTabs, activeTerminalTab]
  );
  // Sidebar visibility is workspace-local (not persisted). The home / projects
  // view renders its own sidebar instance unconditionally, so this state does
  // not affect it. Compact mode never renders the full sidebar — the narrow
  // layout owns its own chrome (see `CompactWorkspace`).
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  const effectiveSidebarHidden = isSidebarHidden;
  // Naming note: `showPreviewLogs` is the legacy state for the inspect panel
  // (which hosts dev-server logs + browser tools). The event keeps the
  // generic name so future inspect-only telemetry doesn't have to migrate.
  const [showPreviewLogs, setShowPreviewLogs] = useState(false);
  const [inspectTab, setInspectTabRaw] = useState<InspectTab>('logs');

  // Wrap setters with click tracking. We read previous state from the closure
  // (not a functional updater) to avoid double-firing under React StrictMode.
  const setInspectTab = useCallback(
    (tab: InspectTab) => {
      if (inspectTab !== tab) {
        void trackEvent('inspect_subtab_switched', { from_tab: inspectTab, to_tab: tab });
      }
      setInspectTabRaw(tab);
    },
    [inspectTab]
  );
  const togglePreviewLogs = useCallback(() => {
    void trackEvent('inspect_panel_toggled', { is_open: !showPreviewLogs });
    setShowPreviewLogs(!showPreviewLogs);
  }, [showPreviewLogs]);

  // Workspace-scoped palette commands (branch + PR flows).
  useWorkspaceCommands({
    currentBranch,
    hasUncommittedChanges,
    hasConflicts: showConflictResolution,
    setWorkspaceTab,
    setShowSubmitReview,
    handleResolveConflicts: () => void handleResolveConflicts(),
  });

  // Per-turn working-tree snapshots so users can undo/redo agent edits.
  const {
    canUndo,
    canRedo,
    undo: undoSnapshot,
    redo: redoSnapshot,
  } = useSnapshots(currentProject.path, showToast);

  // Cmd+Z / Cmd+Shift+Z. We let native text-undo handle inputs and
  // contentEditable so a user editing a PR title still gets character-level
  // undo. Anywhere else (terminal, preview, empty space), the snapshot
  // history takes over.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const target = (e.target as HTMLElement | null) ?? null;
      const tag = target?.tagName;
      const isTextField =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false);
      if (isTextField) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        void redoSnapshot();
      } else {
        void undoSnapshot();
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [undoSnapshot, redoSnapshot]);

  const registryVersion = useSyncExternalStore(
    sessionRegistry.subscribeSimple,
    () => sessionRegistry.getVersion(),
    () => 0
  );
  const tabTitles = useMemo<Map<number, string>>(() => {
    void registryVersion;
    const snap = sessionRegistry.snapshot(currentProject.path);
    const map = new Map<number, string>();
    if (snap) {
      for (const t of snap.terminalTabs) {
        // Custom (user-set) title wins over PTY-emitted title so a manual
        // rename is not overwritten on the next title escape from the agent.
        const display = t.customTitle ?? t.title;
        if (display && display.length > 0) map.set(t.id, display);
      }
    }
    return map;
  }, [currentProject.path, registryVersion]);

  // Cmd/Ctrl+1-5 to switch terminal tabs, Cmd/Ctrl+T to add new tab, Cmd/Ctrl+W to close tab
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;

      // Cmd+W — close active terminal tab (instead of closing the window)
      if (e.key === 'w') {
        e.preventDefault();
        if (terminalTabs.length > 1) {
          closeTerminalTab(activeTerminalTab);
        }
        return;
      }

      // Cmd+T — new tab
      if (e.key === 't') {
        e.preventDefault();
        addTerminalTab();
        return;
      }

      const num = parseInt(e.key, 10);
      if (isNaN(num) || num < 1 || num > 5) return;
      e.preventDefault();
      const index = num - 1;
      const tab = terminalTabs[index];
      if (!tab) {
        showToast(`No terminal tab ${num} — you have ${terminalTabs.length} open`, 'error');
        return;
      }
      setActiveTerminalTab(tab.id);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    terminalTabs,
    activeTerminalTab,
    setActiveTerminalTab,
    showToast,
    addTerminalTab,
    closeTerminalTab,
  ]);

  // Listen for native menu "Close Tab" (Cmd+W) event from Tauri
  useEffect(() => {
    const unlisten = listen('close-tab', () => {
      if (terminalTabs.length > 1) {
        closeTerminalTab(activeTerminalTab);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [terminalTabs, activeTerminalTab, closeTerminalTab]);

  // Focus the active terminal tab when switching between existing tabs.
  // For brand-new tabs, the Terminal component auto-focuses itself after init.
  useEffect(() => {
    const ref = terminalRefsMap.current.get(`${currentProject.path}::${activeTerminalTab}`);
    if (ref) {
      ref.focus();
    }
  }, [activeTerminalTab, terminalRefsMap, currentProject.path]);

  // Whenever the user lands on a (project, tab) pair — via sidebar click,
  // cross-project switch, or restore — clear its attention flag in both
  // stores. The user is now looking at it, so the indicator is stale.
  useEffect(() => {
    setAttentionTabs((prev) => {
      if (!prev.has(activeTerminalTab)) return prev;
      const next = new Set(prev);
      next.delete(activeTerminalTab);
      return next;
    });
    sessionRegistry.setTerminalTabAttention(currentProject.path, activeTerminalTab, false);
  }, [currentProject.path, activeTerminalTab, setAttentionTabs]);

  const header = WorkspaceHeader({
    projectPath: currentProject.path,
    projectName: currentProject.name,
    onOpenAssetsPanel: assetsPanelModal.open,
    headerExtras: (
      <PluginsDropdown
        plugins={loadedPlugins.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id))}
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
        onOpenPluginManager={pluginManagerModal.open}
      />
    ),
    isSidebarHidden: effectiveSidebarHidden,
    onToggleSidebar: () => {
      void trackEvent('sidebar_toggled', { is_hidden: !isSidebarHidden });
      setIsSidebarHidden(!isSidebarHidden);
    },
    integrations,
    onGitHubStatusChange: handleGitHubStatusChange,
    onGitHubConnect: handleGitHubConnect,
    focusActiveTerminal,
    currentBranch,
    hasUncommittedChanges,
    isPublishing,
    setIsPublishing,
    onPublishError: handlePublishError,
    onPublishStatusChange: () => {
      void handleGitHubStatusChange();
      void fetchBranchInfo(currentProject.path);
    },
    onCreatePR: () => setShowSubmitReview(currentBranch || 'main'),
    forcePublishOpen,
    onForcePublishOpenHandled: () => setForcePublishOpen(false),
    getSlotPlugins,
    pluginProject,
    pluginActions,
    pluginTheme,
  });

  return (
    <>
      <div className="app workspace">
        <UpdateBanner />
        {!isCompact && header.titlebar}

        {isCompact ? (
          <CompactWorkspace
            currentProject={currentProject}
            allSessions={allSessions}
            terminalTabs={terminalTabs}
            activeTerminalTab={activeTerminalTab}
            terminalRefsMap={terminalRefsMap}
            tabTitles={tabTitles}
            attentionTabs={attentionTabs}
            maxTerminalTabs={maxTerminalTabs}
            onSelectTab={(tabId) => {
              setActiveTerminalTab(tabId);
              setAttentionTabs((prev) => {
                const next = new Set(prev);
                next.delete(tabId);
                return next;
              });
              sessionRegistry.setTerminalTabAttention(currentProject.path, tabId, false);
            }}
            onAddTab={() => addTerminalTab()}
            onCloseTab={closeTerminalTab}
            hasDevServer={hasDevServer}
            projectRows={projectRows}
            onSelectProject={onSelectProject}
            onGoHome={onGoHome}
            autoAcceptMode={autoAcceptMode}
            handleTerminalExit={handleTerminalExit}
            createTabStatusHandler={createTabStatusHandler}
            handleTabTitleChange={handleTabTitleChange}
          />
        ) : (
          <div className={`workspace-body${effectiveSidebarHidden ? ' is-sidebar-hidden' : ''}`}>
            <WorkspaceSidebar
              isHomeActive={false}
              onGoHome={onGoHome}
              onOpenProjectPicker={onOpenProjectPicker}
              projects={projectRows}
              onCloseProject={onCloseProject}
              currentProjectPath={currentProject.path}
              currentProjectName={currentProject.name}
              onSelectProject={onSelectProject}
              onSelectProjectTab={onSelectProjectTab}
              terminalTabs={terminalTabs}
              activeTerminalTab={activeTerminalTab}
              tabTitles={tabTitles}
              attentionTabs={attentionTabs}
              maxTabs={maxTerminalTabs}
              onSelectTab={(tabId) => {
                setShowHealthLogs(false);
                setActiveTerminalTab(tabId);
                setAttentionTabs((prev) => {
                  const next = new Set(prev);
                  next.delete(tabId);
                  return next;
                });
                sessionRegistry.setTerminalTabAttention(currentProject.path, tabId, false);
              }}
              onAddTab={addTerminalTab}
              onCloseTab={closeTerminalTab}
              onRenameTab={handleRenameTab}
              hasDevServer={hasDevServer}
              isRestartingDevServer={isRestartingDevServer}
              devServerRunning={hasDevServer}
              onOpenDevServerLogs={
                isWebProject || hasDevServer
                  ? () => {
                      setWorkspaceTab('preview');
                      setShowPreviewLogs(true);
                      setInspectTab('logs');
                    }
                  : undefined
              }
              onRestartDevServer={
                isWebProject || customDevCommand ? () => void handleRestartDevServer() : undefined
              }
              devServerUrl={
                isWebProject && devServerPort > 0 ? `http://localhost:${devServerPort}` : undefined
              }
              isProjectDevServerRunning={isProjectDevServerRunning}
            />
            <div className="workspace-main">
              {header.toolbar}

              {(currentBranch === 'main' || currentBranch === 'master') && (
                <MainBranchBanner
                  projectPath={currentProject.path}
                  onCreateBranch={() => setWorkspaceTab('branches')}
                />
              )}

              {/* Full-width branch + tabs bar. Historically this lived inside
                the right pane of the SplitPane, but it was lifted up here
                so the branch chip + workspace tabs span the full workspace
                width and stay visible even when the preview pane is
                hidden. The tabs still only control what's rendered in the
                right pane — clicking "Code" / "Branches" / "PRs" swaps
                that content, identical to before. */}
              <div className="preview-tabs-bar">
                {integrations.projectGithub?.status === 'connected' && currentBranch && (
                  <BranchIndicator
                    currentBranch={currentBranch}
                    hasUncommittedChanges={hasUncommittedChanges}
                    changedFiles={changedFiles}
                    projectPath={currentProject.path}
                    isOnBranchesTab={workspaceTab === 'branches' || workspaceTab === 'prs'}
                    isWebProject={isWebProject}
                    onClick={() => {
                      if (workspaceTab === 'branches' || workspaceTab === 'prs') {
                        setWorkspaceTab(isWebProject ? 'preview' : 'code');
                      } else {
                        setWorkspaceTab('branches');
                      }
                    }}
                    onDiscard={() => {
                      void checkGitStatus(currentProject.path);
                    }}
                    onSave={() => setForcePublishOpen(true)}
                  />
                )}
                <div style={{ flex: 1 }} />
                <div className="workspace-tabs">
                  {isWebProject && (
                    <button
                      className={`workspace-tab ${workspaceTab === 'preview' && !isPreviewHidden ? 'active' : ''}`}
                      onClick={() => {
                        setIsPreviewHidden(false);
                        setWorkspaceTab('preview');
                      }}
                    >
                      <EyeIcon size={14} />
                      <span>Preview</span>
                    </button>
                  )}
                  {/* Focus mode — collapses the preview pane so the agent
                    terminal takes the full workspace. Useful when the user
                    is running their own browser as the preview. Active
                    whenever the preview is hidden, regardless of which
                    tab underlies it. */}
                  <button
                    className={`workspace-tab ${isPreviewHidden ? 'active' : ''}`}
                    onClick={() => setIsPreviewHidden(!isPreviewHidden)}
                    title={isPreviewHidden ? 'Exit focus mode' : 'Hide preview — agent only'}
                  >
                    <EyeOffIcon size={14} />
                    <span>Focus</span>
                  </button>
                  <button
                    className={`workspace-tab ${workspaceTab === 'code' && !isPreviewHidden ? 'active' : ''}`}
                    onClick={() => {
                      setIsPreviewHidden(false);
                      setWorkspaceTab('code');
                    }}
                  >
                    <CodeIcon size={14} />
                    <span>Code</span>
                  </button>
                  {integrations.projectGithub?.status === 'connected' && (
                    <>
                      <button
                        className={`workspace-tab ${workspaceTab === 'branches' && !isPreviewHidden ? 'active' : ''}`}
                        onClick={() => {
                          setIsPreviewHidden(false);
                          setWorkspaceTab('branches');
                        }}
                        data-education-id="branches-tab"
                      >
                        <BranchIcon size={14} />
                        <span>Branches</span>
                      </button>
                      <button
                        className={`workspace-tab ${workspaceTab === 'prs' && !isPreviewHidden ? 'active' : ''}`}
                        onClick={() => {
                          setIsPreviewHidden(false);
                          setWorkspaceTab('prs');
                        }}
                        data-education-id="prs-tab"
                      >
                        <PullRequestIcon size={14} />
                        <span>PRs</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="workspace-content">
                <SplitPane
                  defaultSplit={29}
                  minLeft={20}
                  minRight={35}
                  rightCollapsed={isPreviewHidden}
                  left={
                    <div className="terminal-pane">
                      <div className="workspace-terminal-view">
                        <div className="terminal-tabs-bar">
                          {/* Restart-dev-server moved to the sidebar row
                            (Commands → Dev server). "Edit dev command" and
                            "Project settings" moved to the ⌘K palette. */}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="toolbar-icon-btn"
                              onClick={() => void undoSnapshot()}
                              disabled={!canUndo}
                              title="Undo last change (⌘Z)"
                              aria-label="Undo"
                            >
                              <UndoIcon size={12} />
                            </button>
                            <button
                              className="toolbar-icon-btn"
                              onClick={() => void redoSnapshot()}
                              disabled={!canRedo}
                              title="Redo (⌘⇧Z)"
                              aria-label="Redo"
                            >
                              <RedoIcon size={12} />
                            </button>
                          </div>
                          <div style={{ flex: 1 }} />
                          <div className="terminal-tabs-bar-right">
                            {canSplit && (
                              <button
                                type="button"
                                className="toggle-pill-btn"
                                onClick={() =>
                                  isSplitActive ? disableSplitView() : enableSplitView()
                                }
                                title={
                                  isSplitActive
                                    ? 'Exit side-by-side view'
                                    : 'View agents side by side'
                                }
                                aria-label="Toggle side-by-side view"
                                aria-pressed={isSplitActive}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.6"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <rect x="2" y="3" width="12" height="10" rx="1.2" />
                                  <line x1="8" y1="3" x2="8" y2="13" />
                                </svg>
                                <span>Split</span>
                                <span
                                  className={`toggle-pill-switch ${isSplitActive ? 'is-on' : ''}`}
                                  aria-hidden
                                />
                              </button>
                            )}
                            <ToolbarDropdown
                              agent={getActiveTabAgent()}
                              autoAcceptMode={autoAcceptMode}
                              onNotificationSettings={() => setShowNotificationSettings(true)}
                              onSkills={skillsModal.open}
                              onMcp={mcpModal.open}
                              onAutoAcceptToggle={handleToolbarAutoAcceptToggle}
                              onHelp={helpModal.open}
                              terminalPlugins={getSlotPlugins('terminal')}
                              pluginProject={pluginProject}
                              pluginActions={pluginActions}
                              pluginTheme={pluginTheme}
                            />
                          </div>
                        </div>
                        <div
                          className={`terminal-content${isSplitActive ? ' split' : ''}`}
                          data-education-id="claude-terminal"
                        >
                          {isSplitActive && currentProject && splitPaneTabIds && splitPaneSizes && (
                            <>
                              <TerminalSplitHeaders
                                panes={splitPaneTabIds}
                                sizes={splitPaneSizes}
                                tabs={terminalTabs}
                                tabTitles={tabTitles}
                                onSelectTab={setSplitPaneTab}
                                onRemovePane={removeSplitPane}
                                onAddPane={() => addSplitPane()}
                                canAddPane={splitPaneTabIds.length < terminalTabs.length}
                              />
                              <TerminalSplitDividers
                                sizes={splitPaneSizes}
                                onResize={setSplitPaneSizes}
                              />
                            </>
                          )}
                          {allSessions.flatMap((session) =>
                            session.tabs.map((tab) => {
                              const isCurrentProject = session.projectPath === currentProject.path;
                              const paneIdx =
                                isSplitActive && isCurrentProject && splitPaneTabIds
                                  ? splitPaneTabIds.indexOf(tab.id)
                                  : -1;
                              const inSplitPane = paneIdx >= 0;
                              const isVisible =
                                isCurrentProject &&
                                !showHealthLogs &&
                                (isSplitActive ? inSplitPane : activeTerminalTab === tab.id);
                              const refKey = `${session.projectPath}::${tab.id}`;
                              // Anchor both edges to percentages computed from
                              // splitPaneSizes — guarantees the last pane's
                              // right edge hits exactly 100% (no rounding
                              // drift). Reserve 4px next to each drag handle
                              // so the 8px handle sits in clean space. Then
                              // add a 12px content gutter on every edge so
                              // xterm has the same breathing room from the
                              // pane chrome that single-pane mode gives it
                              // from the sidebar. Opencode is full-bleed by
                              // design (its TUI fills the viewport) — skip
                              // the content gutter for it.
                              let paneStyle: React.CSSProperties | undefined;
                              if (inSplitPane && splitPaneSizes) {
                                const leftPct = splitPaneSizes
                                  .slice(0, paneIdx)
                                  .reduce((a, b) => a + b, 0);
                                const rightPct = splitPaneSizes
                                  .slice(paneIdx + 1)
                                  .reduce((a, b) => a + b, 0);
                                const leftAbutsHandle = paneIdx > 0;
                                const rightAbutsHandle = paneIdx < splitPaneSizes.length - 1;
                                const gutter = tab.agentId === 'opencode' ? 0 : 12;
                                const leftOffset = (leftAbutsHandle ? 4 : 0) + gutter;
                                const rightOffset = (rightAbutsHandle ? 4 : 0) + gutter;
                                paneStyle = {
                                  left: `calc(${leftPct}% + ${leftOffset}px)`,
                                  right: `calc(${rightPct}% + ${rightOffset}px)`,
                                  top: 'var(--split-pane-header-height)',
                                };
                              }
                              // Background projects use the same `.terminal-tab-content`
                              // visibility-based hide (position: absolute + visibility: hidden).
                              // `display: none` would zero out xterm's container dims and leave
                              // the renderer desynced when the tab became visible again.
                              return (
                                <div
                                  key={`session-${session.sessionEpoch}-${refKey}`}
                                  className={`terminal-tab-content ${isVisible ? 'active' : ''}${
                                    inSplitPane ? ' in-pane' : ''
                                  }`}
                                  data-agent-id={tab.agentId}
                                  data-pane-idx={inSplitPane ? paneIdx : undefined}
                                  style={paneStyle}
                                  onMouseDownCapture={
                                    inSplitPane && tab.id !== activeTerminalTab
                                      ? () => setActiveTerminalTab(tab.id)
                                      : undefined
                                  }
                                >
                                  <Terminal
                                    ref={(ref) => {
                                      if (ref) {
                                        terminalRefsMap.current.set(refKey, ref);
                                      } else {
                                        terminalRefsMap.current.delete(refKey);
                                      }
                                    }}
                                    agent={getAgentById(tab.agentId)}
                                    projectPath={session.projectPath}
                                    onSpawn={(pid) => {
                                      sessionRegistry.patchTerminalTab(
                                        session.projectPath,
                                        tab.id,
                                        {
                                          status: 'running',
                                          pid,
                                          exitCode: null,
                                        }
                                      );
                                    }}
                                    onExit={(code) => {
                                      handleTerminalExit(code);
                                      sessionRegistry.patchTerminalTab(
                                        session.projectPath,
                                        tab.id,
                                        {
                                          status:
                                            code === 0 || code === null ? 'exited' : 'crashed',
                                          pid: null,
                                          exitCode: code,
                                        }
                                      );
                                    }}
                                    autoAcceptMode={autoAcceptMode}
                                    onStatusChange={createTabStatusHandler(
                                      session.projectPath,
                                      tab.id
                                    )}
                                    onTitleChange={handleTabTitleChange(
                                      session.projectPath,
                                      tab.id
                                    )}
                                    sessionName={tab.sessionId}
                                    isActive={isVisible}
                                    shouldResume={tab.shouldResume}
                                  />
                                </div>
                              );
                            })
                          )}
                          {showHealthLogs && (
                            <div className="terminal-tab-content active">
                              <DevServerLogs
                                output={healthOutput}
                                outputVersion={healthOutputVersion}
                                onSendToAgent={sendToClaude}
                              />
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Screenshot cluster. Only rendered when the
                        Preview tab is the active workspace tab and the
                        project is a web project (same gate as the
                        Preview iframe itself) — the shortcuts these
                        buttons trigger only make sense when there's
                        something to screenshot. */}
                      {workspaceTab === 'preview' && isWebProject && (
                        <div className="terminal-pane-footer">
                          <button
                            className="toolbar-icon-btn"
                            onClick={() => void handleCaptureScreenshot()}
                            disabled={isCapturing || isCropMode}
                            title="Screenshot preview for Claude (⌘⇧S)"
                            data-education-id="screenshot-button"
                          >
                            {isCapturing ? (
                              <div className="capture-spinner" />
                            ) : (
                              <CameraIcon size={14} />
                            )}
                            <span className="capture-label-full">Full Screenshot</span>
                            <span className="capture-label-short">Full</span>
                            <span className="capture-shortcut">&#8984;&#8679;S</span>
                          </button>
                          <button
                            className={`toolbar-icon-btn ${isCropMode ? 'is-open' : ''}`}
                            onClick={() => setIsCropMode(!isCropMode)}
                            disabled={isCapturing || isCropCapturing}
                            title="Crop screenshot for Claude (⌘⇧C)"
                            data-education-id="crop-button"
                          >
                            {isCropCapturing ? (
                              <div className="capture-spinner" />
                            ) : (
                              <CropIcon size={14} />
                            )}
                            <span className="capture-label-full">Crop Screenshot</span>
                            <span className="capture-label-short">Crop</span>
                            <span className="capture-shortcut">&#8984;&#8679;C</span>
                          </button>
                        </div>
                      )}
                    </div>
                  }
                  right={
                    <div className="preview-pane">
                      {/* The .preview-tabs-bar that used to live here was
                        lifted up to the workspace-main level so it spans
                        the full workspace width. Tab switching behavior
                        is unchanged — the content below still swaps
                        based on `workspaceTab`. */}

                      {/* Tab content */}
                      {workspaceTab === 'preview' && isWebProject && (
                        <div style={{ flex: 1, display: 'flex' }}>
                          <Preview
                            key={`${currentProject.path}-${devServerPort}`}
                            ref={previewRef}
                            port={devServerPort}
                            projectPath={currentProject.path}
                            isStaticProject={projectType === 'statichtml'}
                            onServerReady={handlePreviewReady}
                            onPageChange={setCurrentPreviewPage}
                            isCropMode={isCropMode}
                            onCropStart={handleCropStart}
                            onCropComplete={handleCropComplete}
                            onCropCancel={handleCropCancel}
                            isBranchSwitching={isBranchSwitching}
                            isDevServerRestarting={isRestartingDevServer}
                            onSendToClaude={sendToClaude}
                            showLogs={showPreviewLogs}
                            onToggleLogs={hasDevServer ? togglePreviewLogs : undefined}
                            devServerOutput={devServerOutput}
                            devServerOutputVersion={devServerOutputVersion}
                            inspectTab={inspectTab}
                            onInspectTabChange={setInspectTab}
                            healthPanelRef={healthPanelRef}
                            onHealthOutput={handleHealthOutput}
                            needsInstall={needsInstall}
                            onRunInstall={onRunInstall}
                            previewPlugins={
                              <PluginSlot
                                name="preview"
                                plugins={getSlotPlugins('preview')}
                                project={pluginProject}
                                actions={pluginActions}
                                theme={pluginTheme}
                              />
                            }
                          />
                        </div>
                      )}
                      {workspaceTab === 'code' && (
                        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
                          <CodeTab projectPath={currentProject.path} onSendToAgent={sendToClaude} />
                        </div>
                      )}
                      <BranchPRTabContainer
                        workspaceTab={workspaceTab}
                        setWorkspaceTab={setWorkspaceTab}
                        isWebProject={isWebProject}
                        integrations={integrations}
                        branches={branches}
                        openPRs={openPRs}
                        currentBranch={currentBranch}
                        projectPath={currentProject.path}
                        handleBranchSwitch={handleBranchSwitch}
                        handleRestartDevServer={handleRestartDevServer}
                        setShowSubmitReview={setShowSubmitReview}
                        fetchBranchInfo={fetchBranchInfo}
                        handleResolveConflicts={handleResolveConflicts}
                        handleGitHubConnect={handleGitHubConnect}
                      />
                    </div>
                  }
                />
              </div>
            </div>
            {/* .workspace-main */}
          </div>
        )}

        {!isCompact && header.supportPanel}
        <WorkspaceModals
          projectPath={currentProject.path}
          currentProjectPath={currentProject.path}
          onBackupRestore={() => {
            void fetchBranchInfo(currentProject.path);
            void handleGitHubStatusChange();
          }}
          onBackupCreatePR={(branchName) => setShowSubmitReview(branchName)}
          isEducationMode={isEducationMode}
          onCloseEducation={closeEducation}
          toasts={toastList}
          dismissToast={dismissToast}
          screenshotPreviewPath={screenshotPreviewPath}
          showScreenshotModal={showScreenshotModal}
          onDismissScreenshotPreview={() => setScreenshotPreviewPath(null)}
          onViewScreenshotFull={() => setShowScreenshotModal(true)}
          onCloseScreenshotModal={() => {
            setShowScreenshotModal(false);
            setScreenshotPreviewPath(null);
          }}
          showNotificationSettings={showNotificationSettings}
          notificationSettings={notificationSettings}
          onSaveNotificationSettings={handleSaveNotificationSettings}
          onCloseNotificationSettings={() => setShowNotificationSettings(false)}
          agentDisplayName={getActiveTabAgent().displayName}
          agentId={getActiveTabAgent().id}
          activeAgent={getActiveTabAgent()}
          onPluginsChanged={() => void reloadPlugins()}
          loadedPlugins={loadedPlugins}
          pluginSuggestion={pluginSuggestion}
          pluginSuggestionInstalling={pluginSuggestionInstalling}
          onDismissPluginSuggestion={() => setPluginSuggestion(null)}
          onInstallSuggestedPlugin={() => {
            void installSuggestedPlugin(
              (msg) => showToast(msg, 'success'),
              (msg) => showToast(msg, 'error'),
              reloadPlugins
            );
          }}
          showAutoAcceptWarning={showAutoAcceptWarning}
          onCloseAutoAcceptWarning={() => setShowAutoAcceptWarning(false)}
          onAcceptAutoAcceptWarning={handleAutoAcceptWarningAccept}
          showSubmitReview={showSubmitReview}
          branches={branches}
          integrations={integrations}
          onSubmitReviewSuccess={() => {
            showToast('Pull request created', 'success');
            void fetchBranchInfo(currentProject.path);
          }}
          onSubmitReviewBranchSwitch={(branch) => {
            void handleBranchSwitch(branch);
            setTimeout(() => void handleRestartDevServer(), 1500);
          }}
          onSubmitReviewSendToAgent={sendToClaude}
          onSubmitReviewResolveConflicts={(headBranch, baseBranch) =>
            void handleResolveConflicts(headBranch, baseBranch)
          }
          onCloseSubmitReview={() => {
            setShowSubmitReview(null);
            focusActiveTerminal();
          }}
          gitError={gitError}
          onCloseGitError={() => setGitError(null)}
          onSendToClaude={sendToClaude}
          onResolveConflicts={() => void handleResolveConflicts()}
          showConflictResolution={showConflictResolution}
          hasCurrentProject={true}
          onCloseConflictResolution={() => {
            setShowConflictResolution(false);
            focusActiveTerminal();
          }}
          onConflictsResolved={handleConflictsResolved}
          authTerminalConfig={authTerminalConfig}
          onCloseAuthTerminal={() => closeAuthTerminal()}
          onAuthTerminalExit={(exitCode) =>
            void handleAuthTerminalExit(exitCode, currentProject.path)
          }
          installTerminalConfig={installTerminalConfig}
          installTerminalExited={installTerminalExited}
          onCloseInstallTerminal={onCloseInstallTerminal}
          onInstallTerminalExit={onInstallTerminalExit}
          customDevCommand={customDevCommand}
          onSaveDevCommand={handleSaveDevCommand}
          devServerPort={devServerPort}
          onSavePort={lifecycle.handleSavePort}
          isWebProject={isWebProject}
          pluginTerminal={pluginTerminal}
          pluginTerminalExited={pluginTerminalExited}
          onClosePluginTerminal={closePluginTerminal}
          onPluginTerminalExit={handlePluginTerminalExit}
        />
      </div>
    </>
  );
});
