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
import { logger } from '../../lib/logger';
import { setTerminalState } from '../../lib/project';
import type { PreviewHandle, InspectTab } from '../preview/Preview';
import { TREE_PANEL_MIN_WIDTH_PX } from '../preview/panelSizing';
import { SplitPane } from './SplitPane';
import { CompactWorkspace } from './CompactWorkspace';
import { MainBranchBanner } from '../branches/MainBranchBanner';
import type { HealthTabPanelRef } from '../code/HealthTabPanel';
import type { DevServerUnexpectedExit } from '../../hooks/useDevServer';
import { useIsCompact } from '../../hooks/useIsCompact';
import { WorkspaceModalHost } from './WorkspaceModalHost';
import { WorkspaceModes } from './WorkspaceModes';
import { WorkspacePreviewPane } from './WorkspacePreviewPane';
import { WorkspaceTerminalPane } from './WorkspaceTerminalPane';
import { WorkspaceHeader, HOSTING_PLUGIN_IDS } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { VariablesIcon } from '@/components/icons';
import { trackEvent } from '../../lib/analytics';
import { useWorkspaceCommands } from '../../commands/useWorkspaceCommands';
import { useCommands } from '../../commands/useCommands';
import { useSnapshots } from '../../hooks/useSnapshots';
import { useWorktreeWorkflow } from '../../hooks/useWorktreeWorkflow';
import { PluginsDropdown } from '../plugins/PluginsDropdown';
import type { AgentConfig } from '../../lib/agent';
import type { Project } from '../../lib/project';
import { type ProjectType } from '../../lib/static-server';
import { useShopifyTheme } from '../../hooks/useShopifyTheme';
import { isMac } from '../../lib/setup';
import { kbd } from '../../lib/shortcuts';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { TerminalHandle } from '../terminal/Terminal';
import type { Toast, ToastType } from '../../hooks/useToasts';
import type { NotificationSettings } from '../../lib/sounds';
import type { AgentStatus } from '../terminal/Terminal';
import type { IntegrationState, AuthTerminalConfig } from '../../hooks/useIntegrationStatus';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { ChangedFile } from '../../lib/git';
import type { LoadedPlugin, PluginFailure } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { useModal } from '../../contexts/ModalContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import { defaultWorkspaceTab, workspacePreviewCapabilities } from './workspaceViewState';
import '../../styles/features/notifications.css';

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
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
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
  /** Set when the dev-server process died without Ship Studio stopping it
   *  (crash / external kill). Lets the Preview offer a real process restart. */
  devServerUnexpectedExit: DevServerUnexpectedExit | null;
  onRunInstall: () => void;
  /** Path-scoped install trigger — used to auto-install a fresh worktree's
   *  dependencies without waiting for the Preview CTA click. */
  onRunInstallFor: (projectPath: string, packageManager: string) => void;
  /** Type into the dev-server PTY (interactive CLI prompts in the logs pane). */
  onDevServerInput: (data: string) => void;
  /** Sync the dev-server PTY size to the logs terminal. */
  onDevServerResize: (cols: number, rows: number) => void;
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
  onInstallTerminalExit: (exitCode: number | null, outputTail: string) => void;
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
  isPulling: boolean;
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
  handlePullLatest: () => Promise<void>;
  handlePublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  handleResolveConflicts: (headBranch?: string, baseBranch?: string) => Promise<void>;
  handleConflictsResolved: () => void;
}

interface PluginProps {
  loadedPlugins: LoadedPlugin[];
  pluginFailures: PluginFailure[];
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
  /** Start the dev server on demand — fired when the Preview tab is selected
   *  while nothing is running, so picking Preview always yields a preview. */
  handleStartDevServer: () => Promise<void>;
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
  /** Open the "Switch Workspace" picker from the sidebar footer. */
  onSwitchAccount: () => void;
  /** Unpin a project from the sidebar (used for rows without a live session,
   *  including pins whose folder no longer exists — issue #366). */
  onUnpinProject?: (projectPath: string) => void;
  /** Predicate: is a dev server currently tracked for the given project path?
   *  Used by the sidebar to populate background projects' Commands section. */
  isProjectDevServerRunning: (projectPath: string) => boolean;
  /** Whether the shared project sidebar is in its compact state. */
  isSidebarHidden: boolean;
  /** Toggle the shared project sidebar between full and compact states. */
  onToggleSidebar: () => void;
  /** Whether workspace controls are consolidated into the window titlebar. */
  compactWorkspaceToolbarEnabled: boolean;
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
  onSwitchAccount,
  onUnpinProject,
  onOpenProjectPicker,
  isProjectDevServerRunning,
  isSidebarHidden,
  onToggleSidebar,
  compactWorkspaceToolbarEnabled,
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
    restartTerminalTab,
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
    devServerUnexpectedExit,
    onRunInstall,
    onRunInstallFor,
    onDevServerInput,
    onDevServerResize,
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

  // Jump-to-code: when set, the Code tab opens this file and highlights the line.
  // Driven by openInCode (e.g. the visual editor's source links / usage modal).
  const [codeTarget, setCodeTarget] = useState<{ file: string; line: number } | null>(null);
  const openInCode = useCallback(
    (file: string, line: number) => {
      setCodeTarget({ file, line });
      setWorkspaceTab('code');
    },
    [setWorkspaceTab]
  );

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

  // Worktrees of the current project's repository (state, create-modal
  // trigger, post-create open + auto-install). Logic lives in the hook.
  const worktree = useWorktreeWorkflow({
    projectPath: currentProject.path,
    showToast,
    onSelectProject,
    onCloseProject,
    onRunInstallFor,
  });

  const {
    currentBranch,
    branches,
    openPRs,
    hasUncommittedChanges,
    changedFiles,
    showSubmitReview,
    setShowSubmitReview,
    isBranchSwitching,
    isPulling,
    gitError,
    setGitError,
    showConflictResolution,
    setShowConflictResolution,
    fetchBranchInfo,
    checkGitStatus,
    handleBranchSwitch,
    handlePullLatest,
    handlePublishError,
    handleResolveConflicts,
    handleConflictsResolved,
  } = branchMgmt;

  const { loadedPlugins, pluginFailures, getSlotPlugins, reloadPlugins } = plugins;

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
    handleStartDevServer,
    handleGitHubStatusChange,
    handlePreviewReady,
    sendToClaude,
    handleTerminalExit,
    handleToolbarAutoAcceptToggle,
    handleAutoAcceptWarningAccept,
    handleSaveDevCommand,
  } = lifecycle;

  // Web frameworks always receive the iframe preview. Generic projects only
  // receive it when they have a configured dev command (#691); native mobile
  // projects use the device mirror when the platform supports it.
  const { mobilePreviewAvailable, isWebProject, hasPreview } = workspacePreviewCapabilities(
    projectType,
    isMac(),
    customDevCommand
  );

  // Cmd+Shift+S — capture viewport screenshot, Cmd+Shift+C — toggle crop mode
  // Screenshot accelerators only make sense over the web iframe preview, not
  // the device mirror (which captures a simulator, not localhost) or projects
  // with no preview at all.
  const previewVisible = isWebProject && workspaceTab === 'preview' && !isPreviewHidden;

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

  // Reset the preview-side tab to its default whenever the user switches
  // projects. Web projects land on Preview; generic/unknown projects land
  // on Code (no preview available). Without this, switching from a web
  // project while on Branches/PRs would land you on Branches/PRs in the
  // next project too, which reads as "sticky state from the wrong place".
  useEffect(() => {
    setWorkspaceTab(defaultWorkspaceTab(hasPreview));
    // Only re-fire on project path change. We deliberately *don't* depend
    // on `workspaceTab` here — that would force-revert every user click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject.path, hasPreview]);

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
  // Naming note: `showPreviewLogs` is the legacy state for the inspect panel
  // (which hosts dev-server logs + browser tools). The event keeps the
  // generic name so future inspect-only telemetry doesn't have to migrate.
  const [showPreviewLogs, setShowPreviewLogs] = useState(false);
  const [inspectTab, setInspectTabRaw] = useState<InspectTab>('logs');
  const [isAgentPanelHidden, setIsAgentPanelHidden] = useState(false);
  const [forceBranchesOpen, setForceBranchesOpen] = useState(false);
  const [createBranchRequest, setCreateBranchRequest] = useState(0);
  const [agentPanelPinned, setAgentPanelPinned] = useState(
    () => localStorage.getItem('agentPanelPinned') !== '0'
  );
  const [elementTreePreviewAvailable, setElementTreePreviewAvailable] = useState(false);
  const [elementTreeVisible, setElementTreeVisible] = useState(
    () => localStorage.getItem('elementTreeVisible') !== '0'
  );
  const [elementTreePinned, setElementTreePinned] = useState(
    () => localStorage.getItem('elementTreePinned') !== '0'
  );
  const toggleElementTree = useCallback(() => {
    setElementTreeVisible((visible) => {
      localStorage.setItem('elementTreeVisible', visible ? '0' : '1');
      return !visible;
    });
  }, []);
  const closeElementTree = useCallback(() => {
    localStorage.setItem('elementTreeVisible', '0');
    setElementTreeVisible(false);
  }, []);
  const elementTreeAvailable =
    workspaceTab === 'preview' && !isPreviewHidden && elementTreePreviewAvailable;
  const elementTreePanelVisible = elementTreeAvailable && elementTreeVisible;
  const [variablesPanelVisible, setVariablesPanelVisible] = useState(false);
  const [variablesPanelPinned, setVariablesPanelPinned] = useState(
    () => localStorage.getItem('variablesPanelPinned') === '1'
  );
  const variablesPanelOpen =
    isWebProject && workspaceTab === 'preview' && !isPreviewHidden && variablesPanelVisible;
  useEffect(() => {
    setVariablesPanelVisible(false);
  }, [currentProject.path]);
  const toggleVariablesPanel = useCallback(() => {
    const shouldOpen = !variablesPanelOpen;
    setVariablesPanelVisible(shouldOpen);
    if (shouldOpen) {
      setIsPreviewHidden(false);
      setWorkspaceTab('preview');
      void handleStartDevServer();
    }
  }, [handleStartDevServer, setIsPreviewHidden, setWorkspaceTab, variablesPanelOpen]);
  const toggleAgentPanelPinned = useCallback(() => {
    setAgentPanelPinned((pinned) => {
      localStorage.setItem('agentPanelPinned', pinned ? '0' : '1');
      return !pinned;
    });
  }, []);
  const toggleElementTreePinned = useCallback(() => {
    setElementTreePinned((pinned) => {
      localStorage.setItem('elementTreePinned', pinned ? '0' : '1');
      return !pinned;
    });
  }, []);
  const toggleVariablesPanelPinned = useCallback(() => {
    setVariablesPanelPinned((pinned) => {
      localStorage.setItem('variablesPanelPinned', pinned ? '0' : '1');
      return !pinned;
    });
  }, []);
  const toggleAgentPanel = useCallback(() => {
    if (!isAgentPanelHidden) {
      setIsPreviewHidden(false);
    }
    setIsAgentPanelHidden(!isAgentPanelHidden);
  }, [isAgentPanelHidden, setIsPreviewHidden]);

  useCommands(
    () => [
      {
        id: 'workspace.toggleAgentPanel',
        title: isAgentPanelHidden ? 'Show Agent panel' : 'Hide Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'sidebar'],
        run: toggleAgentPanel,
      },
      {
        id: 'workspace.toggleAgentPanelPin',
        title: agentPanelPinned ? 'Float Agent panel' : 'Dock Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'pin', 'float', 'dock'],
        run: toggleAgentPanelPinned,
      },
      {
        id: 'workspace.toggleElementTreePin',
        title: elementTreePinned ? 'Float Elements panel' : 'Dock Elements panel',
        category: 'action',
        when: 'project',
        keywords: ['elements', 'tree', 'navigator', 'pin', 'float', 'dock'],
        run: toggleElementTreePinned,
      },
      {
        id: 'workspace.toggleVariablesPanelPin',
        title: variablesPanelPinned ? 'Float Variables panel' : 'Dock Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['variables', 'css', 'token', 'pin', 'float', 'dock'],
        run: toggleVariablesPanelPinned,
      },
      {
        id: 'css.variables',
        title: variablesPanelOpen ? 'Hide Variables panel' : 'Show Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['css', 'variable', 'custom property', 'token', 'theme', '--'],
        run: toggleVariablesPanel,
      },
    ],
    [
      isAgentPanelHidden,
      toggleAgentPanel,
      agentPanelPinned,
      toggleAgentPanelPinned,
      elementTreePinned,
      toggleElementTreePinned,
      variablesPanelPinned,
      toggleVariablesPanelPinned,
      isWebProject,
      variablesPanelOpen,
      toggleVariablesPanel,
    ]
  );

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
    openPushDropdown: () => setForcePublishOpen(true),
    openBranchesMenu: () => setForceBranchesOpen(true),
    openCreateBranch: () => {
      setIsPreviewHidden(false);
      setWorkspaceTab('branches');
      setCreateBranchRequest((request) => request + 1);
    },
    handlePullLatest: () => void handlePullLatest(),
    isGitHubConnected: integrations.projectGithub?.status === 'connected',
    openWorktreeCreate: worktree.openCreate,
    hasWorktreeData: worktree.worktrees.length > 0,
  });

  // Shopify themes: preview gate state + palette commands.
  const shopify = useShopifyTheme({
    projectPath: currentProject.path,
    projectType,
    onSendToAgent: sendToClaude,
    showToast,
    restartDevServer: handleRestartDevServer,
  });

  // Per-turn working-tree snapshots so users can undo/redo agent edits.
  const {
    canUndo,
    canRedo,
    isGitRepo,
    undo: undoSnapshot,
    redo: redoSnapshot,
  } = useSnapshots(currentProject.path, showToast);
  // Snapshots use `git stash`, so undo/redo need a git repo — say so in the tooltip
  // when disabled, instead of the usual shortcut hint.
  const snapTitle = (verb: string, enabled: boolean, hint: string, idle: string) =>
    !isGitRepo
      ? `${verb} unavailable — snapshots use git, so this project needs to be a git repo`
      : enabled
        ? hint
        : idle;
  const undoHint = `Undo last change (${kbd('mod', 'Z')})`;
  const redoHint = `Redo (${kbd('mod', 'shift', 'Z')})`;
  const undoTitle = snapTitle('Undo', canUndo, undoHint, 'Nothing to undo yet');
  const redoTitle = snapTitle('Redo', canRedo, redoHint, 'Nothing to redo');

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
        // Guidance about a keystroke, not a malfunction — 'info' skips the
        // error-report pipeline (issue #437).
        showToast(`No terminal tab ${num} — you have ${terminalTabs.length} open`, 'info');
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

  const modesNode = (
    <WorkspaceModes
      hasPreview={hasPreview}
      isPreviewHidden={isPreviewHidden}
      workspaceTab={workspaceTab}
      setIsPreviewHidden={setIsPreviewHidden}
      setIsAgentPanelHidden={setIsAgentPanelHidden}
      setWorkspaceTab={setWorkspaceTab}
      onSelectPreview={() => void handleStartDevServer()}
    />
  );

  const header = WorkspaceHeader({
    projectPath: currentProject.path,
    projectName: currentProject.name,
    onGoHome,
    isSidebarHidden,
    onToggleSidebar,
    compactWorkspaceToolbarEnabled,
    onOpenAssetsPanel: assetsPanelModal.open,
    assetsPanelVisible: assetsPanelModal.isOpen,
    elementTreeVisible: elementTreePanelVisible,
    elementTreeAvailable,
    onToggleElementTree: toggleElementTree,
    agentPanelVisible: !isAgentPanelHidden,
    onToggleAgentPanel: toggleAgentPanel,
    variablesPanelVisible: variablesPanelOpen,
    variablesPanelAvailable: isWebProject,
    onToggleVariablesPanel: toggleVariablesPanel,
    modes: modesNode,
    headerExtras: (
      <PluginsDropdown
        plugins={loadedPlugins.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id))}
        failures={pluginFailures}
        hostingPluginCount={
          loadedPlugins.filter((p) => HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)).length
        }
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
        onOpenPluginManager={pluginManagerModal.open}
      />
    ),
    integrations,
    onGitHubStatusChange: handleGitHubStatusChange,
    onGitHubConnect: handleGitHubConnect,
    focusActiveTerminal,
    currentBranch,
    branches,
    openPRs,
    hasUncommittedChanges,
    changedFiles,
    isPulling,
    isBranchSwitching,
    isRepositoryViewActive: workspaceTab === 'branches' || workspaceTab === 'prs',
    onPullLatest: () => void handlePullLatest(),
    onBranchSwitch: (branch) => void handleBranchSwitch(branch),
    onViewBranches: () => {
      setIsPreviewHidden(false);
      setWorkspaceTab('branches');
    },
    onCreateBranch: () => {
      setIsPreviewHidden(false);
      setWorkspaceTab('branches');
      setCreateBranchRequest((request) => request + 1);
    },
    onViewPRs: () => {
      setIsPreviewHidden(false);
      setWorkspaceTab('prs');
    },
    onDiscardChanges: () => void checkGitStatus(currentProject.path),
    isPublishing,
    setIsPublishing,
    onPublishError: handlePublishError,
    onPublishStatusChange: () => {
      void handleGitHubStatusChange();
      void fetchBranchInfo(currentProject.path);
      void worktree.refresh();
    },
    onCreatePR: (branch) => setShowSubmitReview(branch ?? currentBranch ?? 'main'),
    forcePublishOpen,
    onForcePublishOpenHandled: () => setForcePublishOpen(false),
    forceBranchesOpen,
    onForceBranchesOpenHandled: () => setForceBranchesOpen(false),
    getSlotPlugins,
    pluginProject,
    pluginActions,
    pluginTheme,
  });

  return (
    <>
      <div
        className={`app workspace${
          compactWorkspaceToolbarEnabled ? ' workspace--compact-toolbar' : ''
        }`}
      >
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
            restartTerminalTab={restartTerminalTab}
            createTabStatusHandler={createTabStatusHandler}
            handleTabTitleChange={handleTabTitleChange}
          />
        ) : (
          <div className="workspace-body">
            <WorkspaceSidebar
              isHomeActive={false}
              onGoHome={onGoHome}
              onOpenProjectPicker={onOpenProjectPicker}
              isSidebarHidden={isSidebarHidden}
              onToggleSidebar={onToggleSidebar}
              showNavigationControls={false}
              projects={projectRows}
              onCloseProject={onCloseProject}
              onUnpinProject={onUnpinProject}
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
              worktrees={worktree.worktrees}
              onAddWorktree={worktree.openCreate}
              onSwitchAccount={onSwitchAccount}
            />
            <div className="workspace-main">
              {header.toolbar}

              {(currentBranch === 'main' || currentBranch === 'master') && (
                <MainBranchBanner
                  projectPath={currentProject.path}
                  onCreateBranch={() => {
                    setIsPreviewHidden(false);
                    setWorkspaceTab('branches');
                  }}
                  isGitHubConnected={integrations.projectGithub?.status === 'connected'}
                />
              )}

              <div className="workspace-content">
                <SplitPane
                  defaultSplit={29}
                  minLeft={20}
                  minLeftWidthPx={TREE_PANEL_MIN_WIDTH_PX}
                  minRight={35}
                  persistenceKey="agentPanelDockedSplit"
                  rightCollapsed={isPreviewHidden}
                  leftCollapsed={isAgentPanelHidden || (!agentPanelPinned && !isPreviewHidden)}
                  left={
                    <WorkspaceTerminalPane
                      currentProject={currentProject}
                      allSessions={allSessions}
                      terminalTabs={terminalTabs}
                      activeTerminalTab={activeTerminalTab}
                      setActiveTerminalTab={setActiveTerminalTab}
                      terminalRefsMap={terminalRefsMap}
                      tabTitles={tabTitles}
                      autoAcceptMode={autoAcceptMode}
                      getActiveTabAgent={getActiveTabAgent}
                      handleTerminalExit={handleTerminalExit}
                      createTabStatusHandler={createTabStatusHandler}
                      handleTabTitleChange={handleTabTitleChange}
                      restartTerminalTab={restartTerminalTab}
                      showHealthLogs={showHealthLogs}
                      healthOutput={healthOutput}
                      healthOutputVersion={healthOutputVersion}
                      sendToClaude={sendToClaude}
                      isPreviewHidden={isPreviewHidden}
                      isAgentPanelHidden={isAgentPanelHidden}
                      agentPanelPinned={agentPanelPinned}
                      toggleAgentPanelPinned={toggleAgentPanelPinned}
                      toggleAgentPanel={toggleAgentPanel}
                      splitPaneTabIds={splitPaneTabIds}
                      splitPaneSizes={splitPaneSizes}
                      isSplitActive={isSplitActive}
                      canSplit={canSplit}
                      enableSplitView={enableSplitView}
                      disableSplitView={disableSplitView}
                      setSplitPaneTab={setSplitPaneTab}
                      addSplitPane={addSplitPane}
                      removeSplitPane={removeSplitPane}
                      setSplitPaneSizes={setSplitPaneSizes}
                      canUndo={canUndo}
                      canRedo={canRedo}
                      undoSnapshot={undoSnapshot}
                      redoSnapshot={redoSnapshot}
                      undoTitle={undoTitle}
                      redoTitle={redoTitle}
                      isWebProject={isWebProject}
                      isCapturing={isCapturing}
                      isCropMode={isCropMode}
                      isCropCapturing={isCropCapturing}
                      setIsCropMode={setIsCropMode}
                      handleCaptureScreenshot={handleCaptureScreenshot}
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
                  }
                  right={
                    <WorkspacePreviewPane
                      currentProject={currentProject}
                      previewRef={previewRef}
                      workspaceTab={workspaceTab}
                      setWorkspaceTab={setWorkspaceTab}
                      hasPreview={hasPreview}
                      projectTypeResolved={projectType !== 'unknown'}
                      projectType={projectType}
                      isWebProject={isWebProject}
                      mobilePreviewAvailable={mobilePreviewAvailable}
                      setCurrentPreviewPage={setCurrentPreviewPage}
                      devServerPort={devServerPort}
                      handlePreviewReady={handlePreviewReady}
                      isCropMode={isCropMode}
                      handleCropStart={handleCropStart}
                      handleCropComplete={handleCropComplete}
                      handleCropCancel={handleCropCancel}
                      isBranchSwitching={isBranchSwitching}
                      isRestartingDevServer={isRestartingDevServer}
                      sendToClaude={sendToClaude}
                      showPreviewLogs={showPreviewLogs}
                      togglePreviewLogs={togglePreviewLogs}
                      devServerOutput={devServerOutput}
                      devServerOutputVersion={devServerOutputVersion}
                      onDevServerInput={onDevServerInput}
                      onDevServerResize={onDevServerResize}
                      inspectTab={inspectTab}
                      setInspectTab={setInspectTab}
                      healthPanelRef={healthPanelRef}
                      handleHealthOutput={handleHealthOutput}
                      needsInstall={needsInstall}
                      devServerUnexpectedExit={devServerUnexpectedExit}
                      handleRestartDevServer={handleRestartDevServer}
                      onRunInstall={onRunInstall}
                      openInCode={openInCode}
                      codeTarget={codeTarget}
                      canUndo={canUndo}
                      canRedo={canRedo}
                      undoTitle={undoTitle}
                      redoTitle={redoTitle}
                      undoSnapshot={undoSnapshot}
                      redoSnapshot={redoSnapshot}
                      elementTreeVisible={elementTreeVisible}
                      elementTreePinned={elementTreePinned}
                      toggleElementTreePinned={toggleElementTreePinned}
                      closeElementTree={closeElementTree}
                      setElementTreePreviewAvailable={setElementTreePreviewAvailable}
                      variablesPanelVisible={variablesPanelVisible}
                      variablesPanelPinned={variablesPanelPinned}
                      toggleVariablesPanelPinned={toggleVariablesPanelPinned}
                      closeVariablesPanel={() => setVariablesPanelVisible(false)}
                      pluginProject={pluginProject}
                      pluginActions={pluginActions}
                      pluginTheme={pluginTheme}
                      getSlotPlugins={getSlotPlugins}
                      shopify={shopify}
                      branchTabs={{
                        integrations,
                        branches,
                        openPRs,
                        currentBranch,
                        handleBranchSwitch,
                        handleRestartDevServer,
                        setShowSubmitReview,
                        fetchBranchInfo,
                        handleResolveConflicts,
                        handleGitHubConnect,
                        createBranchRequest,
                        ...worktree.tabProps,
                      }}
                    />
                  }
                />
              </div>
            </div>
            {/* .workspace-main */}
          </div>
        )}

        <WorkspaceModalHost
          projectPath={currentProject.path}
          currentProjectPath={currentProject.path}
          backups={{
            onBackupRestore: () => {
              void fetchBranchInfo(currentProject.path);
              void handleGitHubStatusChange();
            },
            onBackupCreatePR: (branchName) => setShowSubmitReview(branchName),
          }}
          education={{ isEducationMode, onCloseEducation: closeEducation }}
          toasts={{ toasts: toastList, dismissToast }}
          screenshots={{
            screenshotPreviewPath,
            showScreenshotModal,
            onDismissScreenshotPreview: () => setScreenshotPreviewPath(null),
            onViewScreenshotFull: () => setShowScreenshotModal(true),
            onCloseScreenshotModal: () => {
              setShowScreenshotModal(false);
              setScreenshotPreviewPath(null);
            },
          }}
          notification={{
            showNotificationSettings,
            notificationSettings,
            onSaveNotificationSettings: handleSaveNotificationSettings,
            onCloseNotificationSettings: () => setShowNotificationSettings(false),
            agentDisplayName: getActiveTabAgent().displayName,
          }}
          extensions={{
            agentId: getActiveTabAgent().id,
            activeAgent: getActiveTabAgent(),
            onPluginsChanged: () => void reloadPlugins(),
            loadedPlugins,
          }}
          pluginSuggestion={{
            pluginSuggestion,
            pluginSuggestionInstalling,
            onDismissPluginSuggestion: () => setPluginSuggestion(null),
            onInstallSuggestedPlugin: () => {
              void installSuggestedPlugin(
                (msg) => showToast(msg, 'success'),
                (msg) => showToast(msg, 'error'),
                reloadPlugins
              );
            },
          }}
          autoAccept={{
            showAutoAcceptWarning,
            onCloseAutoAcceptWarning: () => setShowAutoAcceptWarning(false),
            onAcceptAutoAcceptWarning: handleAutoAcceptWarningAccept,
          }}
          review={{
            showSubmitReview,
            branches,
            integrations,
            onSubmitReviewSuccess: () => {
              showToast('Pull request created', 'success');
              void fetchBranchInfo(currentProject.path);
            },
            onSubmitReviewBranchSwitch: (branch) => {
              void handleBranchSwitch(branch);
              setTimeout(() => void handleRestartDevServer(), 1500);
            },
            onSubmitReviewSendToAgent: sendToClaude,
            onSubmitReviewResolveConflicts: (headBranch, baseBranch) =>
              void handleResolveConflicts(headBranch, baseBranch),
            onCloseSubmitReview: () => {
              setShowSubmitReview(null);
              focusActiveTerminal();
            },
          }}
          git={{
            gitError,
            onCloseGitError: () => setGitError(null),
            onSendToClaude: sendToClaude,
            onResolveConflicts: () => void handleResolveConflicts(),
          }}
          conflicts={{
            showConflictResolution,
            onCloseConflictResolution: () => {
              setShowConflictResolution(false);
              focusActiveTerminal();
            },
            onConflictsResolved: handleConflictsResolved,
          }}
          authTerminal={{
            authTerminalConfig,
            onCloseAuthTerminal: () => closeAuthTerminal(),
            onAuthTerminalExit: (exitCode) =>
              void handleAuthTerminalExit(exitCode, currentProject.path),
          }}
          installTerminal={{
            installTerminalConfig,
            installTerminalExited,
            onCloseInstallTerminal,
            onInstallTerminalExit,
          }}
          devCommand={{ customDevCommand, onSaveDevCommand: handleSaveDevCommand }}
          projectSettings={{
            devServerPort,
            onSavePort: lifecycle.handleSavePort,
            isWebProject,
          }}
          shopify={{
            isShopifyTheme: shopify.isShopifyTheme,
            onShopifyStoreSaved: shopify.connect,
          }}
          worktree={{
            currentBranch: currentBranch || 'main',
            worktrees: worktree.worktrees,
            onWorktreeCreated: worktree.handleCreated,
          }}
          pluginTerminal={{
            pluginTerminal,
            pluginTerminalExited,
            onClosePluginTerminal: closePluginTerminal,
            onPluginTerminalExit: handlePluginTerminalExit,
          }}
        />
      </div>
    </>
  );
});
