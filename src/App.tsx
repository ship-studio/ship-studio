/**
 * Main application component and state management.
 *
 * This is the root component that orchestrates:
 * - Application views (loading, setup, projects, workspace)
 * - Project management (opening, creating, dev server lifecycle)
 * - Terminal and preview panel coordination
 * - Periodic screenshot capture for thumbnails
 * - Git branch management and status polling
 *
 * ## State Architecture
 *
 * State has been extracted into custom hooks for better organization:
 * - `useToasts` - Toast notification state
 * - `useTerminalManagement` - Terminal tabs and session state
 * - `useIntegrationStatus` - GitHub/Claude integration state
 * - `useScreenshotManagement` - Screenshot capture, crop, and thumbnail state
 * - `useDevServer` - Dev server lifecycle, output buffering, project type
 * - `useWorkspaceLayout` - Layout tabs, log panels, compact mode, pin state
 * - `usePluginState` - Plugin terminal modal and suggestion popup
 * - `useWorkspaceModals` - Workspace modal visibility state (env editor, backups, assets, etc.)
 *
 * @module App
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useToasts } from './hooks/useToasts';
import { useTerminalManagement } from './hooks/useTerminalManagement';
import { usePlugins } from './hooks/usePlugins';
import { useIntegrationStatus } from './hooks/useIntegrationStatus';
import { useScreenshotManagement } from './hooks/useScreenshotManagement';
import { useDevServer } from './hooks/useDevServer';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout';
import { useIsCompact } from './hooks/useIsCompact';
import { usePluginState } from './hooks/usePluginState';
import { useWorkspaceModals } from './hooks/useWorkspaceModals';
import { useBranchManagement } from './hooks/useBranchManagement';
import { useNotifications } from './hooks/useNotifications';
import { useProjectLifecycle } from './hooks/useProjectLifecycle';
import { useAppSetup } from './hooks/useAppSetup';
import { ProjectsView } from './components/ProjectsView';
import { WorkspaceView } from './components/WorkspaceView';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { useProjectRail } from './hooks/useProjectRail';
import { OnboardingScreen } from './components/setup';
import { Project } from './lib/project';
import { markSetupComplete, getDefaultAgentId as fetchDefaultAgentId } from './lib/setup';
import { initDefaultAgent } from './lib/agent';
import { sessionRegistry } from './lib/sessionRegistry';
import { unregisterProjectSession } from './lib/projectSessions';
import { UpdateBanner } from './components/UpdateBanner';
import { MonorepoPickerModal } from './components/MonorepoPickerModal';
import { ModalFrame } from './components/primitives/ModalFrame';
import { Button } from './components/primitives/Button';
import { ToastContext } from './contexts/ToastContext';
import { ModalProvider, useModal } from './contexts/ModalContext';
import { CommandPaletteHost } from './components/CommandPalette/CommandPaletteHost';
import { AppGlobalModals } from './components/AppGlobalModals';
import {
  PaletteContextProvider,
  useOpenPalette,
  useSetPaletteContext,
} from './components/CommandPalette/paletteContext';
import { useAppCommands } from './commands/useAppCommands';
import { useProjectNumberShortcuts } from './hooks/useProjectNumberShortcuts';
import { SuccessIcon, InfoIcon, CloseIcon } from './components/icons';
import { logger } from './lib/logger';
import { trackEvent, setActiveProject, trackPageview } from './lib/analytics';
import { endProjectSession } from './lib/session';
import { installAppLifecycleTracking, quitAppWithTracking } from './lib/appLifecycle';
import type { AppView } from './lib/types';
import './styles/index.css';

// Initialize logger
logger.init();

// Track app launch
void trackEvent('app_launched', { $screen_name: 'Dashboard' });

/** Props for the App component */
interface AppProps {
  /** Initial project path from URL parameter (for multi-window support) */
  initialProjectPath?: string | null;
}

/**
 * Top-level wrapper. Hosts the Toast and Modal providers so every view
 * (loading, onboarding, projects, workspace) can call `useToast` / `useModal`
 * without crashing. The actual app body lives in `AppContents`.
 */
function App({ initialProjectPath }: AppProps) {
  return (
    <ModalProvider>
      <PaletteContextProvider>
        <AppContents initialProjectPath={initialProjectPath} />
        <CommandPaletteHost />
        <AppGlobalModals />
      </PaletteContextProvider>
    </ModalProvider>
  );
}

const EMPTY_TAB_TITLES: Map<number, string> = new Map();
const EMPTY_ATTENTION_TABS: Set<number> = new Set();
const noop = () => {};

function AppContents({ initialProjectPath }: AppProps) {
  const [view, setView] = useState<AppView>('loading');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const isCompact = useIsCompact();
  const setPaletteContext = useSetPaletteContext();
  useEffect(() => {
    if (view === 'workspace' || view === 'project-loading') {
      setPaletteContext({
        kind: 'project',
        currentProjectName: currentProject?.name ?? null,
        currentProjectPath: currentProject?.path ?? null,
      });
    } else if (view === 'projects') {
      setPaletteContext({ kind: 'home', currentProjectName: null, currentProjectPath: null });
    } else {
      setPaletteContext({ kind: 'other', currentProjectName: null, currentProjectPath: null });
    }
  }, [view, currentProject, setPaletteContext]);

  // Top-level pageviews. Per-step Onboarding pageviews are fired by
  // OnboardingScreen so we don't double-up on entry. Workspace fires its
  // own tab-specific pageviews from useWorkspaceLayout.
  useEffect(() => {
    if (view === 'projects') trackPageview('Dashboard');
    // 'loading', 'project-loading', 'onboarding', and 'workspace' are
    // intentionally not tracked here — they're either transient or
    // handled by the screen itself.
  }, [view]);

  // Install app-lifecycle tracking once (focus/blur, idle, OS close). The
  // empty deps array is intentional — listeners are global and shouldn't
  // re-bind on re-render.
  useEffect(() => {
    return installAppLifecycleTracking();
  }, []);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const previewRef = useRef<import('./components/Preview').PreviewHandle | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);

  // Terminal tabs management — per-project, so switching doesn't destroy
  // background sessions (Slice 4 multitasking).
  const {
    terminalTabs,
    activeTerminalTab,
    terminalSessionId,
    allSessions,
    terminalRefsMap,
    maxTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    closeAllTerminalsForProject,
    focusActiveTerminal,
    pasteToActiveTerminal,
    switchTabAgent,
    getActiveTabAgent,
    restoreTerminalTabs,
    ensureProjectSeeded,
    splitPaneTabIds,
    splitPaneSizes,
    enableSplitView,
    disableSplitView,
    setSplitPaneTab,
    addSplitPane,
    removeSplitPane,
    setSplitPaneSizes,
  } = useTerminalManagement(currentProject?.path ?? null);

  // Mirror EVERY active session's tabs into the session registry so the
  // sidebar reflects both the current project's live tabs and every
  // background project's tabs accurately. Because terminal state is now
  // per-project in the hook, there's no cross-project contamination to
  // guard against.
  useEffect(() => {
    for (const session of allSessions) {
      const activeIdx = Math.max(
        0,
        session.tabs.findIndex((t) => t.id === session.activeTabId)
      );
      sessionRegistry.setTerminalTabs(
        session.projectPath,
        session.tabs.map((t) => ({ id: t.id, agentId: t.agentId, sessionId: t.sessionId })),
        activeIdx
      );
    }
  }, [allSessions]);

  // Listen for Cmd+Q quit confirmation from native menu
  useEffect(() => {
    const unlisten = listen('confirm-quit', () => {
      setShowQuitConfirm(true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Dev server and health check management
  const {
    devServerRef,
    healthPanelRef,
    devServerPort,
    setDevServerPort,
    projectType,
    isRestartingDevServer,
    customDevCommand,
    devServerOutputRef,
    devServerOutputVersion,
    healthOutputRef,
    healthOutputVersion,
    handleHealthOutput,
    handleRestartDevServer: restartDevServer,
    startServerForProject,
    stopServer,
    stopAllServers,
    isServerRunning,
    saveCustomDevCommand,
    needsInstall,
    clearNeedsInstall,
    writeToDevServer,
    resizeDevServer,
  } = useDevServer(currentProject?.path ?? null);

  // Cleanup every live dev server when the window is closed (prevents
  // orphaned processes — there can be more than one hot server at a time
  // when projects are pinned across switches).
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        void stopAllServers();
      } catch {
        // Ignore errors during cleanup
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [stopAllServers]);

  // Notification settings, attention tabs, agent status sound alerts
  const {
    notificationSettings,
    showNotificationSettings,
    setShowNotificationSettings,
    attentionTabs,
    setAttentionTabs,
    createTabStatusHandler,
    handleSaveNotificationSettings,
  } = useNotifications({ activeTerminalTab, currentProjectPath: currentProject?.path ?? null });

  // Integration states consolidated via reducer for atomic updates
  const {
    integrations,
    isInitialCheckDone,
    refreshAllCliStatuses,
    setProjectGitHubStatus,
    clearProjectStatuses,
    authTerminalConfig,
    handleGitHubConnect: handleGitHubConnectFromOverlay,
    handleAuthTerminalExit,
    closeAuthTerminal,
  } = useIntegrationStatus();

  // Screenshot management
  const {
    isCapturing,
    isCropMode,
    setIsCropMode,
    isCropCapturing,
    isFullPageCapturing,
    screenshotPreviewPath,
    setScreenshotPreviewPath,
    showScreenshotModal,
    setShowScreenshotModal,
    handleCaptureScreenshot,
    handleCaptureFullPage,
    handleCropStart,
    handleCropComplete,
    handleCropCancel,
    handlePreviewReady: onPreviewReady,
    startScreenshotInterval,
    clearScreenshotInterval,
  } = useScreenshotManagement({
    previewRef,
    devServerPort,
    pasteToActiveTerminal,
    currentProjectPathRef,
  });

  // Workspace layout
  const {
    showHealthLogs,
    setShowHealthLogs,
    isPreviewHidden,
    setIsPreviewHidden,
    workspaceTab,
    setWorkspaceTab,
    resetLayout,
  } = useWorkspaceLayout({
    isGitHubConnected: integrations.projectGithub?.status === 'connected',
  });

  // Plugin state
  const {
    pluginTerminal,
    pluginTerminalExited,
    openPluginTerminal,
    closePluginTerminal,
    handlePluginTerminalExit,
    pluginSuggestion,
    setPluginSuggestion,
    pluginSuggestionInstalling,
    checkPluginSuggestion,
    installSuggestedPlugin,
  } = usePluginState();

  // Education-mode toggle state (the rest of the modal state lives in ModalContext)
  const { isEducationMode, setIsEducationMode, closeEducation } = useWorkspaceModals({
    focusActiveTerminal,
  });

  // Modal openers from context. App is now wrapped in ModalProvider so this works
  // even on non-workspace views (loading / onboarding / projects).
  const helpModal = useModal('help');

  // Toast notifications
  const { toasts, showToast, dismissToast } = useToasts();

  // Branch management (state, polling, conflict handlers)
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
    clearBranchState,
  } = useBranchManagement({
    currentProject,
    previewRef,
    healthPanelRef,
    showToast,
  });

  // Plugin system
  const {
    plugins: loadedPlugins,
    getSlotPlugins,
    reloadPlugins,
  } = usePlugins(currentProject?.path ?? null);

  // Project lifecycle (selection, creation, import, publish, compact mode, etc.)
  const {
    autoAcceptMode,
    showCreateModal,
    setShowCreateModal,
    importView,
    setImportView,
    pendingMonorepoPick,
    handleSelectMonorepoPick,
    handleConfirmMonorepoPick,
    handleCancelMonorepoPick,
    installTerminalConfig,
    installTerminalExited,
    handleRunInstall,
    handleCloseInstallTerminal,
    handleInstallTerminalExit,
    setCurrentPreviewPage,
    isPublishing,
    setIsPublishing,
    forcePublishOpen,
    setForcePublishOpen,
    showAutoAcceptWarning,
    setShowAutoAcceptWarning,
    handleSelectProject,
    handleBackToProjects,
    handleProjectCreated,
    handleImportProject,
    handleProjectImported,
    handleImportLocalFolder,
    handleCreateProject,
    handleRestartDevServer,
    handleGitHubStatusChange,
    handlePreviewReady,
    sendToClaude,
    handleTerminalExit,
    handleToolbarAutoAcceptToggle,
    handleAutoAcceptWarningAccept,
  } = useProjectLifecycle({
    currentProject,
    setCurrentProject,
    currentProjectPathRef,
    setView,
    setDevServerPort,
    startServerForProject,
    isServerRunning,
    restartDevServer,
    clearNeedsInstall,
    pasteToActiveTerminal,
    terminalTabs,
    activeTerminalTab,
    restoreTerminalTabs,
    ensureProjectSeeded,
    showToast,
    setCleanupStatus,
    clearScreenshotInterval,
    startScreenshotInterval,
    onPreviewReady,
    setWorkspaceTab,
    resetLayout,
    setProjectGitHubStatus,
    clearProjectStatuses,
    fetchBranchInfo,
    clearBranchState,
    checkPluginSuggestion,
  });

  // Save port handler: persist, update state, close modal, restart dev server
  const handleSavePort = useCallback(
    async (newPort: number) => {
      if (!currentProject) return;
      try {
        await invoke('set_dev_server_port', { projectPath: currentProject.path, port: newPort });
        setDevServerPort(newPort);
        // ProjectSettingsModal closes itself via useModal('projectSettings').close()
        // when its save handler returns successfully.
        await restartDevServer(currentProject.path, newPort);
        showToast('Port updated and server restarted', 'success');
      } catch {
        showToast('Failed to save port setting', 'error');
      }
    },
    [currentProject, restartDevServer, showToast, setDevServerPort]
  );

  // Register palette commands with real handlers — see src/commands/useAppCommands.tsx
  // `pinnedPaths` is passed after the rail hook runs; done below.

  const { pinnedProjects, handleTogglePin, handleRailClick } = useProjectRail({
    currentProjectPath: currentProject?.path ?? null,
    handleSelectProject,
    showToast,
  });

  const pinnedPaths = useMemo(
    () => pinnedProjects.rows.map((r) => r.projectPath),
    [pinnedProjects.rows]
  );

  const openPalette = useOpenPalette();
  const openProjectPicker = useCallback(() => {
    // Dedicated picker button only — Cmd+K palette opens are tracked by the
    // palette itself in Phase 3, with `tab` as a property.
    void trackEvent('project_picker_button_clicked');
    openPalette({ tab: 'project' });
  }, [openPalette]);

  // Cmd/Ctrl+1..9 → jump to Nth sidebar project (pinned first, then active).
  useProjectNumberShortcuts({ pinnedPaths, handleSelectProject });

  // Palette commands with real handlers — see src/commands/useAppCommands.tsx
  useAppCommands({
    currentProject,
    pinnedPaths,
    handleSelectProject,
    handleBackToProjects,
    handleCreateProject,
    handleImportProject,
    handleImportLocalFolder,
    handleGitHubConnect: handleGitHubConnectFromOverlay,
    handleRestartDevServer,
    isEducationMode,
    setIsEducationMode,
    showToast,
  });

  // Close an active session from the sidebar: stop its dev server, tear
  // down the registry entry + backend session, and route home if it was
  // the current project. This is the only path (besides app quit) that
  // reaps a hot project.
  const handleCloseProject = useCallback(
    (projectPath: string) => {
      void (async () => {
        logger.info('[CloseProject] Closing', { projectPath });
        try {
          await stopServer(projectPath);
        } catch (err) {
          logger.warn('[CloseProject] stopServer threw', { error: String(err) });
        }
        closeAllTerminalsForProject(projectPath);
        try {
          await unregisterProjectSession(projectPath);
        } catch (err) {
          logger.warn('[CloseProject] unregisterProjectSession failed', {
            error: String(err),
          });
        }
        sessionRegistry.destroy(projectPath);
        if (currentProject?.path === projectPath) {
          // Closing the current project ends its analytics session. Switching
          // away to projects view also clears active project context so any
          // home-screen events that follow aren't tagged with stale project_id.
          const ended = endProjectSession();
          if (ended) {
            void trackEvent('project_session_ended', {
              project_session_id: ended.session_id,
              duration_seconds: ended.duration_seconds,
              reason: 'project_closed',
            });
          }
          setActiveProject(null);
          setCurrentProject(null);
          currentProjectPathRef.current = null;
          setView('projects');
          // The view-change effect above fires the Dashboard pageview.
        }
      })();
    },
    [stopServer, closeAllTerminalsForProject, currentProject, setView]
  );

  // Switch to another project AND focus a specific tab within it. Writes the
  // desired active tab index to backend first so the restore flow on open
  // comes up on the right tab.
  const handleSelectProjectTab = useCallback(
    (projectPath: string, tabSessionId: string) => {
      void (async () => {
        const snap = sessionRegistry.snapshot(projectPath);
        const idx = snap?.terminalTabs.findIndex((t) => t.sessionId === tabSessionId) ?? -1;
        if (snap && idx >= 0) {
          try {
            await invoke('set_terminal_state', {
              projectPath,
              state: {
                tabs: snap.terminalTabs.map((t) => ({
                  agent_id: t.agentId,
                  session_id: t.sessionId,
                  custom_title: t.customTitle,
                })),
                active_tab_index: idx,
              },
            });
          } catch (err) {
            logger.warn('[SelectProjectTab] Failed to persist active tab', {
              error: String(err),
            });
          }
        }
        handleRailClick(projectPath);
      })();
    },
    [handleRailClick]
  );

  // App setup, onboarding, HMR recovery, auto-open, keyboard shortcuts
  const { projectsLoading, setProjectsLoading } = useAppSetup({
    view,
    setView,
    initialProjectPath,
    setCurrentProject,
    setDevServerPort,
    handleSelectProject,
    refreshAllCliStatuses,
    setProjectGitHubStatus,
    fetchBranchInfo,
    openHelpModal: helpModal.open,
  });

  // Plugin data for PluginSlot components (defined before early returns so all views can use them)
  const pluginProject = useMemo(
    () =>
      currentProject
        ? {
            name: currentProject.name,
            path: currentProject.path,
            currentBranch: currentBranch || 'main',
            hasUncommittedChanges,
            devServerUrl: `http://localhost:${String(devServerPort)}`,
            gitRemoteUrl: integrations.projectGithub?.github_url ?? undefined,
          }
        : null,
    [
      currentProject,
      currentBranch,
      hasUncommittedChanges,
      devServerPort,
      integrations.projectGithub?.github_url,
    ]
  );

  const pluginActions = useMemo(
    () => ({
      showToast,
      refreshGitStatus: () => {
        if (currentProject) void fetchBranchInfo(currentProject.path);
      },
      refreshBranches: () => {
        if (currentProject) void fetchBranchInfo(currentProject.path);
      },
      focusTerminal: focusActiveTerminal,
      openUrl: (url: string) => {
        void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url));
      },
      openTerminal: openPluginTerminal,
    }),
    [showToast, currentProject, fetchBranchInfo, focusActiveTerminal, openPluginTerminal]
  );

  const pluginTheme = useMemo(
    () => ({
      bgPrimary: 'var(--bg-primary)',
      bgSecondary: 'var(--bg-secondary)',
      bgTertiary: 'var(--bg-tertiary)',
      textPrimary: 'var(--text-primary)',
      textSecondary: 'var(--text-secondary)',
      textMuted: 'var(--text-muted)',
      border: 'var(--border)',
      accent: 'var(--accent, #10b981)',
      accentHover: 'var(--accent-hover)',
      action: 'var(--action)',
      actionHover: 'var(--action-hover)',
      actionText: 'var(--action-text)',
      error: 'var(--error)',
      success: 'var(--success)',
    }),
    []
  );

  // Memoized prop groups for WorkspaceView to prevent cascade re-renders
  // (Must be before early returns to maintain consistent hook call order)
  const terminalProps = useMemo(
    () => ({
      terminalTabs,
      activeTerminalTab,
      terminalSessionId,
      allSessions,
      terminalRefsMap,
      maxTerminalTabs,
      setActiveTerminalTab,
      addTerminalTab,
      closeTerminalTab,
      focusActiveTerminal,
      switchTabAgent,
      getActiveTabAgent,
      splitPaneTabIds,
      splitPaneSizes,
      enableSplitView,
      disableSplitView,
      setSplitPaneTab,
      addSplitPane,
      removeSplitPane,
      setSplitPaneSizes,
    }),
    [
      terminalTabs,
      activeTerminalTab,
      terminalSessionId,
      allSessions,
      terminalRefsMap,
      maxTerminalTabs,
      setActiveTerminalTab,
      addTerminalTab,
      closeTerminalTab,
      focusActiveTerminal,
      switchTabAgent,
      getActiveTabAgent,
      splitPaneTabIds,
      splitPaneSizes,
      enableSplitView,
      disableSplitView,
      setSplitPaneTab,
      addSplitPane,
      removeSplitPane,
      setSplitPaneSizes,
    ]
  );

  const handleRunInstallCurrent = useCallback(() => {
    if (!currentProject || !needsInstall) return;
    handleRunInstall(currentProject.path, needsInstall.packageManager);
  }, [currentProject, needsInstall, handleRunInstall]);

  const devServerProps = useMemo(
    () => ({
      hasDevServer: !!devServerRef.current,
      healthPanelRef,
      devServerPort,
      projectType,
      isRestartingDevServer,
      customDevCommand,
      devServerOutput: devServerOutputRef.current,
      devServerOutputVersion,
      healthOutput: healthOutputRef.current,
      healthOutputVersion,
      handleHealthOutput,
      needsInstall,
      onRunInstall: handleRunInstallCurrent,
      onDevServerInput: writeToDevServer,
      onDevServerResize: resizeDevServer,
    }),
    [
      devServerRef,
      devServerPort,
      projectType,
      isRestartingDevServer,
      customDevCommand,
      devServerOutputRef,
      devServerOutputVersion,
      healthOutputRef,
      healthOutputVersion,
      handleHealthOutput,
      healthPanelRef,
      needsInstall,
      handleRunInstallCurrent,
      writeToDevServer,
      resizeDevServer,
    ]
  );

  const notificationsProps = useMemo(
    () => ({
      notificationSettings,
      showNotificationSettings,
      setShowNotificationSettings,
      attentionTabs,
      setAttentionTabs,
      createTabStatusHandler,
      handleSaveNotificationSettings,
    }),
    [
      notificationSettings,
      showNotificationSettings,
      setShowNotificationSettings,
      attentionTabs,
      setAttentionTabs,
      createTabStatusHandler,
      handleSaveNotificationSettings,
    ]
  );

  const memoizedHandleAuthTerminalExit = useCallback(
    (exitCode: number | null, projectPath?: string) =>
      void handleAuthTerminalExit(exitCode, projectPath),
    [handleAuthTerminalExit]
  );

  const integrationStatusProps = useMemo(
    () => ({
      integrations,
      handleGitHubConnect: handleGitHubConnectFromOverlay,
      authTerminalConfig,
      closeAuthTerminal,
      handleAuthTerminalExit: memoizedHandleAuthTerminalExit,
      installTerminalConfig,
      installTerminalExited,
      onCloseInstallTerminal: handleCloseInstallTerminal,
      onInstallTerminalExit: handleInstallTerminalExit,
    }),
    [
      integrations,
      handleGitHubConnectFromOverlay,
      authTerminalConfig,
      closeAuthTerminal,
      memoizedHandleAuthTerminalExit,
      installTerminalConfig,
      installTerminalExited,
      handleCloseInstallTerminal,
      handleInstallTerminalExit,
    ]
  );

  const screenshotsProps = useMemo(
    () => ({
      isCapturing,
      isCropMode,
      setIsCropMode,
      isCropCapturing,
      isFullPageCapturing,
      screenshotPreviewPath,
      setScreenshotPreviewPath,
      showScreenshotModal,
      setShowScreenshotModal,
      handleCaptureScreenshot,
      handleCaptureFullPage,
      handleCropStart,
      handleCropComplete,
      handleCropCancel,
    }),
    [
      isCapturing,
      isCropMode,
      setIsCropMode,
      isCropCapturing,
      isFullPageCapturing,
      screenshotPreviewPath,
      setScreenshotPreviewPath,
      showScreenshotModal,
      setShowScreenshotModal,
      handleCaptureScreenshot,
      handleCaptureFullPage,
      handleCropStart,
      handleCropComplete,
      handleCropCancel,
    ]
  );

  const layoutProps = useMemo(
    () => ({
      showHealthLogs,
      setShowHealthLogs,
      isPreviewHidden,
      setIsPreviewHidden,
      workspaceTab,
      setWorkspaceTab,
    }),
    [
      showHealthLogs,
      setShowHealthLogs,
      isPreviewHidden,
      setIsPreviewHidden,
      workspaceTab,
      setWorkspaceTab,
    ]
  );

  const pluginStateProps = useMemo(
    () => ({
      pluginTerminal,
      pluginTerminalExited,
      closePluginTerminal,
      handlePluginTerminalExit,
      pluginSuggestion,
      setPluginSuggestion,
      pluginSuggestionInstalling,
      installSuggestedPlugin,
    }),
    [
      pluginTerminal,
      pluginTerminalExited,
      closePluginTerminal,
      handlePluginTerminalExit,
      pluginSuggestion,
      setPluginSuggestion,
      pluginSuggestionInstalling,
      installSuggestedPlugin,
    ]
  );

  const modalsProps = useMemo(
    () => ({
      isEducationMode,
      setIsEducationMode,
      closeEducation,
    }),
    [isEducationMode, setIsEducationMode, closeEducation]
  );

  const toastsProps = useMemo(
    () => ({
      toasts,
      showToast,
      dismissToast,
    }),
    [toasts, showToast, dismissToast]
  );

  const branchMgmtProps = useMemo(
    () => ({
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
    }),
    [
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
    ]
  );

  const pluginsProps = useMemo(
    () => ({
      loadedPlugins,
      getSlotPlugins,
      reloadPlugins,
    }),
    [loadedPlugins, getSlotPlugins, reloadPlugins]
  );

  // Stable wrappers for async callbacks passed to ProjectsView (prevents memo-busting)
  const handleSelectProjectCallback = useCallback(
    (project: Project) => {
      void handleSelectProject(project);
    },
    [handleSelectProject]
  );

  const handleImportLocalFolderCallback = useCallback(() => {
    void handleImportLocalFolder();
  }, [handleImportLocalFolder]);

  const handleCloseCreateModal = useCallback(() => setShowCreateModal(false), [setShowCreateModal]);

  const handleAuthTerminalExitForProjects = useCallback(
    (exitCode: number | null) => void handleAuthTerminalExit(exitCode, currentProject?.path),
    [handleAuthTerminalExit, currentProject?.path]
  );

  const handleSaveDevCommand = useCallback(
    (cmd: string | null) => {
      if (currentProject) void saveCustomDevCommand(currentProject.path, cmd);
    },
    [currentProject, saveCustomDevCommand]
  );

  const handleSavePortCallback = useCallback(
    (port: number) => {
      void handleSavePort(port);
    },
    [handleSavePort]
  );

  const lifecycleProps = useMemo(
    () => ({
      autoAcceptMode,
      setCurrentPreviewPage,
      isPublishing,
      setIsPublishing,
      forcePublishOpen,
      setForcePublishOpen,
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
      handleSavePort: handleSavePortCallback,
    }),
    [
      autoAcceptMode,
      setCurrentPreviewPage,
      isPublishing,
      setIsPublishing,
      forcePublishOpen,
      setForcePublishOpen,
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
      handleSavePortCallback,
    ]
  );

  const quitConfirmModal = showQuitConfirm && (
    <ModalFrame
      isOpen
      onClose={() => setShowQuitConfirm(false)}
      showCloseButton={false}
      className="quit-confirm-modal"
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') void quitAppWithTracking();
        }}
      >
        <p>Are you sure you want to quit Ship Studio?</p>
        <div className="quit-confirm-actions">
          <Button variant="secondary" onClick={() => setShowQuitConfirm(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void quitAppWithTracking()} autoFocus>
            Quit
          </Button>
        </div>
      </div>
    </ModalFrame>
  );

  if (view === 'loading') {
    return (
      <>
        <div className="app loading">
          <img src="/ship_studio_full_noshadow.svg" alt="Ship Studio" className="app-logo" />
          <div className="spinner" />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'onboarding') {
    const handleOnboardingComplete = async () => {
      // Re-hydrate default agent cache (may have been set during onboarding)
      const defaultAgent = await fetchDefaultAgentId();
      initDefaultAgent(defaultAgent);
      // Persist that setup is complete so future launches are fast
      await markSetupComplete();
      // Refresh CLI states and go to projects directly (don't re-enter onboarding)
      await refreshAllCliStatuses();
      setView('projects');
    };

    return (
      <>
        <div className="app">
          <UpdateBanner />
          <OnboardingScreen onComplete={() => void handleOnboardingComplete()} />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'projects') {
    return (
      <>
        <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-projects">
          {!isCompact && (
            <WorkspaceSidebar
              key="sidebar-projects"
              isHomeActive={true}
              onGoHome={() => {
                /* already on Home */
              }}
              onOpenProjectPicker={openProjectPicker}
              projects={pinnedProjects.rows}
              currentProjectPath={null}
              currentProjectName={null}
              onSelectProject={handleRailClick}
              onCloseProject={handleCloseProject}
              onSelectProjectTab={handleSelectProjectTab}
              terminalTabs={[]}
              activeTerminalTab={0}
              tabTitles={EMPTY_TAB_TITLES}
              attentionTabs={EMPTY_ATTENTION_TABS}
              maxTabs={5}
              onSelectTab={noop}
              onAddTab={noop}
              onCloseTab={noop}
              hasDevServer={false}
              isRestartingDevServer={false}
              devServerRunning={false}
              isProjectDevServerRunning={isServerRunning}
            />
          )}
          <ProjectsView
            onSelectProject={handleSelectProjectCallback}
            onCreateProject={handleCreateProject}
            onImportProject={handleImportProject}
            onImportLocalFolder={handleImportLocalFolderCallback}
            isGitHubAuthenticated={integrations.github.cliStatus.authenticated}
            githubUsername={integrations.github.username}
            isAuthCheckDone={isInitialCheckDone}
            onGitHubConnect={handleGitHubConnectFromOverlay}
            showCreateModal={showCreateModal}
            onCloseCreateModal={handleCloseCreateModal}
            onProjectCreated={handleProjectCreated}
            importView={importView}
            setImportView={setImportView}
            onProjectImported={handleProjectImported}
            authTerminalConfig={authTerminalConfig}
            closeAuthTerminal={closeAuthTerminal}
            onAuthTerminalExit={handleAuthTerminalExitForProjects}
            pluginProject={pluginProject}
            pluginActions={pluginActions}
            pluginTheme={pluginTheme}
            getSlotPlugins={getSlotPlugins}
            projectsLoading={projectsLoading}
            onLoadingChange={setProjectsLoading}
            cleanupStatus={cleanupStatus}
            pinnedSet={pinnedProjects.pinnedSet}
            onTogglePin={(path, pinned) => void handleTogglePin(path, pinned)}
          />
        </div>
        {/* .projects-with-rail */}
        {pendingMonorepoPick && (
          <MonorepoPickerModal
            projectName={pendingMonorepoPick.project.name}
            workspaces={pendingMonorepoPick.workspaces}
            selectedPick={pendingMonorepoPick.selectedPick}
            onSelect={handleSelectMonorepoPick}
            onConfirm={() => void handleConfirmMonorepoPick()}
            onCancel={() => void handleCancelMonorepoPick()}
          />
        )}
        {toasts.length > 0 && (
          <div className="toast-container">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.type}`}>
                <span className="toast-icon">
                  {t.type === 'success' ? <SuccessIcon size={16} /> : <InfoIcon size={16} />}
                </span>
                <span className="toast-message">{t.message}</span>
                <button className="toast-close" onClick={() => dismissToast(t.id)}>
                  <CloseIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'project-loading') {
    return (
      <>
        <div className="projects-with-rail" key="view-project-loading">
          <WorkspaceSidebar
            key="sidebar-project-loading"
            isHomeActive={false}
            onGoHome={handleBackToProjects}
            onOpenProjectPicker={openProjectPicker}
            projects={pinnedProjects.rows}
            currentProjectPath={currentProject?.path ?? null}
            currentProjectName={currentProject?.name ?? null}
            onSelectProject={handleRailClick}
            onCloseProject={handleCloseProject}
            onSelectProjectTab={handleSelectProjectTab}
            terminalTabs={[]}
            activeTerminalTab={0}
            tabTitles={EMPTY_TAB_TITLES}
            attentionTabs={EMPTY_ATTENTION_TABS}
            maxTabs={5}
            onSelectTab={noop}
            onAddTab={noop}
            onCloseTab={noop}
            hasDevServer={false}
            isRestartingDevServer={false}
            devServerRunning={false}
            isProjectDevServerRunning={isServerRunning}
          />
          <div className="project-loading-body">
            <div className="spinner" />
            <p>Opening {currentProject?.name}...</p>
          </div>
        </div>
        {quitConfirmModal}
      </>
    );
  }

  // Workspace view (guard against null during back-navigation transition)
  if (!currentProject) {
    return (
      <>
        <div className="app loading">
          <div className="spinner" />
        </div>
        {quitConfirmModal}
      </>
    );
  }
  return (
    <ToastContext.Provider value={toastsProps}>
      <WorkspaceView
        currentProject={currentProject}
        previewRef={previewRef}
        terminal={terminalProps}
        devServer={devServerProps}
        notifications={notificationsProps}
        integrationStatus={integrationStatusProps}
        screenshots={screenshotsProps}
        layout={layoutProps}
        pluginState={pluginStateProps}
        modals={modalsProps}
        toasts={toastsProps}
        branchMgmt={branchMgmtProps}
        plugins={pluginsProps}
        lifecycle={lifecycleProps}
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
        projectRows={pinnedProjects.rows}
        onSelectProject={handleRailClick}
        onCloseProject={handleCloseProject}
        onSelectProjectTab={handleSelectProjectTab}
        onGoHome={handleBackToProjects}
        onOpenProjectPicker={openProjectPicker}
        isProjectDevServerRunning={isServerRunning}
      />
      {quitConfirmModal}
    </ToastContext.Provider>
  );
}

export default App;
