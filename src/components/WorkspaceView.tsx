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

import { memo, useCallback, useEffect, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from './Terminal';
import { DevServerLogs } from './DevServerLogs';
import { Preview } from './Preview';
import type { PreviewHandle } from './Preview';
import { SplitPane } from './SplitPane';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import { BranchIndicator } from './BranchIndicator';
import { CodeTab } from './CodeTab';
import { BranchPRTabContainer } from './workspace/BranchPRTabContainer';
import { CompactActionsRow } from './CompactMode';
import { CompactBranchPRView } from './CompactBranchPRView';
import { MainBranchBanner } from './MainBranchBanner';
import { BrowserDropdown } from './BrowserDropdown';
import type { CodeHealthPanelRef } from './CodeHealthPanel';
import { HealthIndicatorBar } from './workspace/HealthIndicatorBar';
import { CompactModeToggle } from './workspace/CompactModeToggle';
import { WorkspaceModals } from './WorkspaceModals';
import { WorkspaceHeader } from './WorkspaceHeader';
import { PluginSlot } from './PluginSlot';
import { UpdateBanner } from './UpdateBanner';
import {
  CameraIcon,
  CodeIcon,
  CropIcon,
  BranchIcon,
  PullRequestIcon,
  EyeIcon,
  PanelRightIcon,
  TerminalIcon,
  CompactIcon,
  ActivityIcon,
} from './icons';
import { ToolbarDropdown } from './ToolbarDropdown';
import { TerminalTabSelector } from './TerminalTabSelector';
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
import { useModal } from '../contexts/ModalContext';
import '../styles/features/notifications.css';

// ---------------------------------------------------------------------------
// Domain-grouped prop interfaces
// ---------------------------------------------------------------------------

interface TerminalProps {
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  terminalSessionId: number;
  terminalRefsMap: React.MutableRefObject<Map<number, TerminalHandle | null>>;
  maxTerminalTabs: number;
  setActiveTerminalTab: (id: number) => void;
  addTerminalTab: () => void;
  closeTerminalTab: (id: number) => void;
  focusActiveTerminal: () => void;
  switchTabAgent: (tabId: number, agentId: string) => void;
  getActiveTabAgent: () => AgentConfig;
}

interface DevServerProps {
  hasDevServer: boolean;
  healthPanelRef: RefObject<CodeHealthPanelRef | null>;
  devServerPort: number;
  projectType: ProjectType;
  isRestartingDevServer: boolean;
  customDevCommand: string | null;
  devServerOutput: string;
  devServerOutputVersion: number;
  healthOutput: string;
  healthOutputVersion: number;
  handleHealthOutput: (data: string) => void;
}

interface NotificationProps {
  notificationSettings: NotificationSettings;
  showNotificationSettings: boolean;
  setShowNotificationSettings: (show: boolean) => void;
  attentionTabs: Set<number>;
  setAttentionTabs: React.Dispatch<React.SetStateAction<Set<number>>>;
  createTabStatusHandler: (tabId: number) => (status: AgentStatus, title: string) => void;
  handleSaveNotificationSettings: (settings: NotificationSettings) => void;
}

interface IntegrationProps {
  integrations: IntegrationState;
  handleGitHubConnect: () => void;
  authTerminalConfig: AuthTerminalConfig | null;
  closeAuthTerminal: () => void;
  handleAuthTerminalExit: (exitCode: number | null, projectPath?: string) => void;
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
  showDevServerLogs: boolean;
  setShowDevServerLogs: (show: boolean) => void;
  showHealthLogs: boolean;
  setShowHealthLogs: (show: boolean) => void;
  isPreviewHidden: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  workspaceTab: 'preview' | 'code' | 'branches' | 'prs';
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  compactView: 'terminal' | 'branches' | 'prs';
  setCompactView: (view: 'terminal' | 'branches' | 'prs') => void;
  isPinned: boolean;
  handlePinToggle: () => Promise<void>;
  handleExpandToFull: () => Promise<void>;
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
  isCompactPublishOpen: boolean;
  setIsCompactPublishOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showAutoAcceptWarning: boolean;
  setShowAutoAcceptWarning: (show: boolean) => void;
  handleBackToProjects: () => Promise<void>;
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
  handleEnterCompactMode: () => Promise<void>;
  /** Optional left rail rendered below the titlebar. */
  rail?: React.ReactNode;
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
  handleEnterCompactMode,
  rail,
}: WorkspaceViewProps) {
  // Destructure domain groups for readability in JSX
  const {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    terminalRefsMap,
    maxTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    focusActiveTerminal,
    switchTabAgent,
    getActiveTabAgent,
  } = terminal;

  // Modal context (Block 6 migration). Modals self-read open state via useModal('id');
  // we register focus side effects here for those that need the terminal re-focused.
  const envEditorModal = useModal('envEditor');
  const backupsModal = useModal('backups');
  const assetsPanelModal = useModal('assetsPanel');
  const helpModal = useModal('help');
  const skillsModal = useModal('skills');
  const mcpModal = useModal('mcp');
  const pluginManagerModal = useModal('pluginManager');
  const devCommandModal = useModal('devCommand');
  const projectSettingsModal = useModal('projectSettings');
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
    showDevServerLogs,
    setShowDevServerLogs,
    showHealthLogs,
    setShowHealthLogs,
    isPreviewHidden,
    setIsPreviewHidden,
    workspaceTab,
    setWorkspaceTab,
    compactView,
    setCompactView,
    isPinned,
    handlePinToggle,
    handleExpandToFull,
  } = layout;

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

  const { isEducationMode, setIsEducationMode, closeEducation } = modals;

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
    isCompactPublishOpen,
    setIsCompactPublishOpen,
    showAutoAcceptWarning,
    setShowAutoAcceptWarning,
    handleBackToProjects,
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

  // Switch to code tab for non-web projects (blank, generic) since preview is unavailable
  useEffect(() => {
    if (!isWebProject && workspaceTab === 'preview') {
      setWorkspaceTab('code');
    }
  }, [isWebProject, workspaceTab, setWorkspaceTab]);

  // Track terminal tab titles from PTY title changes
  const [tabTitles, setTabTitles] = useState<Map<number, string>>(new Map());
  const handleTabTitleChange = useCallback(
    (tabId: number) => (title: string) => {
      setTabTitles((prev) => {
        if (prev.get(tabId) === title) return prev;
        const next = new Map(prev);
        next.set(tabId, title);
        return next;
      });
    },
    []
  );

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
    const ref = terminalRefsMap.current.get(activeTerminalTab);
    if (ref) {
      ref.focus();
    }
  }, [activeTerminalTab, terminalRefsMap]);

  const header = WorkspaceHeader({
    projectPath: currentProject.path,
    projectName: currentProject.name,
    onBackToProjects: () => void handleBackToProjects(),
    isEducationMode,
    onToggleEducationMode: () => setIsEducationMode(!isEducationMode),
    onOpenPluginManager: pluginManagerModal.open,
    onOpenAssetsPanel: assetsPanelModal.open,
    onOpenEnvEditor: envEditorModal.open,
    onOpenBackupsModal: backupsModal.open,
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
        {header.titlebar}

        <div className="workspace-body">
          {rail}
          <div className="workspace-main">
            {header.toolbar}

            {(currentBranch === 'main' || currentBranch === 'master') && (
              <MainBranchBanner
                projectPath={currentProject.path}
                onCreateBranch={() => setWorkspaceTab('branches')}
              />
            )}

            <div className="workspace-content">
              <SplitPane
                defaultSplit={28}
                minLeft={20}
                minRight={35}
                rightCollapsed={isPreviewHidden}
                left={
                  <div className="terminal-pane">
                    <HealthIndicatorBar
                      projectPath={currentProject.path}
                      healthPanelRef={healthPanelRef}
                      onAskClaude={sendToClaude}
                      onHealthOutput={handleHealthOutput}
                      isWebProject={isWebProject}
                      customDevCommand={customDevCommand}
                      hasDevServer={hasDevServer}
                      projectType={projectType}
                      isRestartingDevServer={isRestartingDevServer}
                      isPreviewHidden={isPreviewHidden}
                      devServerPort={devServerPort}
                      onRestartDevServer={handleRestartDevServer}
                      onOpenDevCommand={devCommandModal.open}
                      onOpenProjectSettings={projectSettingsModal.open}
                      onEnterCompactMode={handleEnterCompactMode}
                      onShowPreview={() => setIsPreviewHidden(false)}
                    />
                    {/* Terminal view - hidden in compact mode when viewing branches/PRs */}
                    <div
                      className={`compact-terminal-view ${compactView !== 'terminal' ? 'compact-hidden' : ''}`}
                    >
                      <div className="terminal-tabs-bar">
                        <div className="terminal-tabs" data-education-id="terminal-tabs">
                          <TerminalTabSelector
                            tabs={terminalTabs}
                            activeTabId={activeTerminalTab}
                            tabTitles={tabTitles}
                            attentionTabs={attentionTabs}
                            maxTabs={maxTerminalTabs}
                            onSelectTab={(tabId) => {
                              setShowDevServerLogs(false);
                              setShowHealthLogs(false);
                              setActiveTerminalTab(tabId);
                              setAttentionTabs((prev) => {
                                const next = new Set(prev);
                                next.delete(tabId);
                                return next;
                              });
                            }}
                            onAddTab={addTerminalTab}
                            onCloseTab={closeTerminalTab}
                            onSwitchAgent={(tabId, agentId) => {
                              setTabTitles((prev) => {
                                const next = new Map(prev);
                                next.delete(tabId);
                                return next;
                              });
                              switchTabAgent(tabId, agentId);
                            }}
                          />
                        </div>
                        <div className="terminal-logs-tabs">
                          {(isWebProject || hasDevServer) && (
                            <>
                              <button
                                className={`workspace-tab icon-only ${showDevServerLogs && !showHealthLogs ? 'active' : ''}`}
                                onClick={() => {
                                  setShowDevServerLogs(true);
                                  setShowHealthLogs(false);
                                }}
                                title="View dev server logs"
                                data-education-id="server-logs"
                              >
                                <TerminalIcon size={12} />
                              </button>
                              <button
                                className={`workspace-tab icon-only ${showHealthLogs ? 'active' : ''}`}
                                onClick={() => {
                                  setShowDevServerLogs(true);
                                  setShowHealthLogs(true);
                                }}
                                title="View health check logs"
                                data-education-id="health-logs"
                              >
                                <ActivityIcon size={12} />
                              </button>
                            </>
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

                        {/* Compact mode controls - visible only at narrow widths via CSS */}
                        <CompactModeToggle
                          isPinned={isPinned}
                          onPinToggle={handlePinToggle}
                          onExpandToFull={handleExpandToFull}
                        />
                      </div>
                      <div className="terminal-content" data-education-id="claude-terminal">
                        {terminalTabs.map((tab) => (
                          <div
                            key={`session-${terminalSessionId}-tab-${tab.id}`}
                            className={`terminal-tab-content ${!showDevServerLogs && activeTerminalTab === tab.id ? 'active' : ''}`}
                            data-agent-id={tab.agentId}
                          >
                            <Terminal
                              ref={(ref) => {
                                if (ref) {
                                  terminalRefsMap.current.set(tab.id, ref);
                                }
                              }}
                              agent={getAgentById(tab.agentId)}
                              projectPath={currentProject.path}
                              onExit={handleTerminalExit}
                              autoAcceptMode={autoAcceptMode}
                              onStatusChange={createTabStatusHandler(tab.id)}
                              onTitleChange={handleTabTitleChange(tab.id)}
                              sessionName={tab.sessionId}
                              isActive={!showDevServerLogs && activeTerminalTab === tab.id}
                              shouldResume={tab.shouldResume}
                            />
                          </div>
                        ))}
                        {showDevServerLogs && !showHealthLogs && (
                          <div className="terminal-tab-content active">
                            <DevServerLogs
                              output={devServerOutput}
                              outputVersion={devServerOutputVersion}
                            />
                          </div>
                        )}
                        {showHealthLogs && (
                          <div className="terminal-tab-content active">
                            <DevServerLogs
                              output={healthOutput}
                              outputVersion={healthOutputVersion}
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    <CompactBranchPRView
                      compactView={compactView}
                      setCompactView={setCompactView}
                      isPinned={isPinned}
                      onPinToggle={handlePinToggle}
                      onExpandToFull={handleExpandToFull}
                      projectPath={currentProject.path}
                      currentBranch={currentBranch || ''}
                      branches={branches}
                      openPRs={openPRs}
                      integrations={integrations}
                      onBranchSwitchFromBranches={(branchName) =>
                        void handleBranchSwitch(branchName)
                      }
                      onBranchSwitchFromPR={(branchName) => {
                        void handleBranchSwitch(branchName);
                        // TODO: chain off handleBranchSwitch promise instead of arbitrary timeout
                        setTimeout(() => void handleRestartDevServer(), 1500);
                      }}
                      onSubmitForReview={(branchName) => setShowSubmitReview(branchName)}
                      onRefresh={() => void fetchBranchInfo(currentProject.path)}
                      onResolveConflicts={(headBranch, baseBranch) =>
                        void handleResolveConflicts(headBranch, baseBranch)
                      }
                    />
                  </div>
                }
                right={
                  <div className="preview-pane">
                    {/* Preview/Branches/PRs Tabs - always show all tabs */}
                    <div className="preview-tabs-bar">
                      {/* Branch Indicator - only show when GitHub is connected and we have branch info */}
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
                            className={`workspace-tab ${workspaceTab === 'preview' ? 'active' : ''}`}
                            onClick={() => setWorkspaceTab('preview')}
                          >
                            <EyeIcon size={14} />
                            <span>Preview</span>
                          </button>
                        )}
                        <button
                          className={`workspace-tab ${workspaceTab === 'code' ? 'active' : ''}`}
                          onClick={() => setWorkspaceTab('code')}
                        >
                          <CodeIcon size={14} />
                          <span>Code</span>
                        </button>
                        {integrations.projectGithub?.status === 'connected' && (
                          <>
                            <button
                              className={`workspace-tab ${workspaceTab === 'branches' ? 'active' : ''}`}
                              onClick={() => setWorkspaceTab('branches')}
                              data-education-id="branches-tab"
                            >
                              <BranchIcon size={14} />
                              <span>Branches</span>
                            </button>
                            <button
                              className={`workspace-tab ${workspaceTab === 'prs' ? 'active' : ''}`}
                              onClick={() => setWorkspaceTab('prs')}
                              data-education-id="prs-tab"
                            >
                              <PullRequestIcon size={14} />
                              <span>PRs</span>
                            </button>
                          </>
                        )}
                      </div>
                      <div className="preview-tabs-divider" />
                      <div className="preview-actions">
                        {isWebProject && (
                          <>
                            <button
                              className="preview-action-btn-icon"
                              onClick={() => void handleEnterCompactMode()}
                              title="Compact Mode"
                              data-education-id="compact-button"
                            >
                              <CompactIcon size={12} />
                            </button>
                            <span data-education-id="browser-button">
                              <BrowserDropdown
                                url={`http://localhost:${devServerPort}`}
                                buttonClassName="preview-action-btn-icon"
                                iconOnly
                              />
                            </span>
                          </>
                        )}
                        <button
                          className="preview-action-btn-icon"
                          onClick={() => setIsPreviewHidden(true)}
                          title="Hide Panel"
                          data-education-id="hide-preview"
                        >
                          <PanelRightIcon size={12} />
                        </button>
                      </div>
                    </div>

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
                          previewPlugins={
                            <PluginSlot
                              name="preview"
                              plugins={getSlotPlugins('preview')}
                              project={pluginProject}
                              actions={pluginActions}
                              theme={pluginTheme}
                            />
                          }
                          toolbarExtra={
                            <div className="agent-toolbar">
                              <button
                                className="agent-capture-btn"
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
                                <span className="capture-shortcut">&#8984;&#8679;S</span>
                              </button>
                              <button
                                className={`agent-capture-btn ${isCropMode ? 'active' : ''}`}
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
                                <span className="capture-shortcut">&#8984;&#8679;C</span>
                              </button>
                            </div>
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

            {/* Compact footer - visible only at narrow window widths via CSS */}
            <div className="compact-footer-container">
              {/* Compact publish dropdown - uses controlled mode (forceOpen synced with state)
              The button is hidden via CSS; only the dropdown menu appears */}
              <div className="compact-publish-dropdown">
                <PublishBranchDropdown
                  currentBranch={currentBranch || 'main'}
                  projectGithubStatus={integrations.projectGithub}
                  projectPath={currentProject.path}
                  hasChangesToSync={hasUncommittedChanges}
                  onStatusChange={() => {
                    void handleGitHubStatusChange();
                    void fetchBranchInfo(currentProject.path);
                  }}
                  onModalClose={() => {
                    setIsCompactPublishOpen(false);
                    focusActiveTerminal();
                  }}
                  isPublishing={isPublishing}
                  setIsPublishing={setIsPublishing}
                  onPublishError={handlePublishError}
                  onCreatePR={() => setShowSubmitReview(currentBranch || 'main')}
                  forceOpen={isCompactPublishOpen}
                  onForceOpenHandled={() => {}}
                  excludeClickOutsideSelector=".compact-publish-btn"
                />
              </div>
              <CompactActionsRow
                serverHealth={
                  projectType === 'statichtml' || projectType === 'generic' || hasDevServer
                    ? 'healthy'
                    : isRestartingDevServer
                      ? 'starting'
                      : 'unhealthy'
                }
                currentBranch={currentBranch}
                hasUncommittedChanges={hasUncommittedChanges}
                prStatus={openPRs.find((pr) => pr.headRef === currentBranch) ? 'open' : 'none'}
                isGitHubConnected={integrations.projectGithub?.status === 'connected'}
                isSynced={!hasUncommittedChanges}
                onRestartServer={() => void handleRestartDevServer()}
                onOpenAssets={assetsPanelModal.open}
                onOpenEnvEditor={envEditorModal.open}
                onCreateRepo={() => {
                  // Button only shows when GitHub not connected, so prompt GitHub connection
                  void handleGitHubConnect();
                }}
                onSwitchBranch={() => {
                  // Toggle between terminal and branches view in compact mode
                  setCompactView(compactView === 'branches' ? 'terminal' : 'branches');
                }}
                onCreatePR={() => {
                  // Toggle between terminal and PRs view in compact mode
                  setCompactView(compactView === 'prs' ? 'terminal' : 'prs');
                }}
                onPublish={() => setIsCompactPublishOpen((prev) => !prev)}
              />
            </div>
          </div>
          {/* .workspace-main */}
        </div>
        {/* .workspace-body */}

        {header.supportPanel}
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
