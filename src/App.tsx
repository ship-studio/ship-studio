/**
 * Main application component and state management.
 *
 * This is the root component that orchestrates:
 * - Application views (loading, setup, projects, workspace)
 * - Project management (opening, creating, dev server lifecycle)
 * - Terminal and preview panel coordination
 * - Git branch management and status polling
 *
 * ## State Architecture
 *
 * State has been extracted into custom hooks for better organization:
 * - `ToastProvider` / `useToast` - Toast notification state (app-root context)
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

import { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
import { ProjectsView } from './components/dashboard/ProjectsView';
import { AccountSelectScreen } from './components/accounts/AccountSelectScreen';
import { WorkspaceView } from './components/workspace/WorkspaceView';
import { HomeSidebar } from './components/workspace/HomeSidebar';
import { StandingWorkView } from './components/workspace/StandingWorkView';
import { HANDOFF_DELIVERED_MESSAGE, useWorkflowHandoff } from './hooks/useWorkflowHandoff';
import { WorkspaceSidebar } from './components/workspace/WorkspaceSidebar';
import { WorkspaceNavigation, WorkspaceTitlebar } from './components/workspace/WorkspaceHeader';
import { useProjectRail } from './hooks/useProjectRail';
import { OnboardingRouter } from './components/setup';
import { Project, setTerminalState } from './lib/project';
import { markSetupComplete, getDefaultAgentId as fetchDefaultAgentId } from './lib/setup';
import { initDefaultAgent } from './lib/agent';
import { sessionRegistry } from './lib/sessionRegistry';
import { useCloseProject } from './hooks/useCloseProject';
import { MonorepoPickerModal } from './components/dashboard/MonorepoPickerModal';
import { ThumbnailConsentModal } from './components/preview/ThumbnailConsentModal';
import { QuitConfirmModal } from './components/QuitConfirmModal';
import { Spinner } from './components/primitives/Spinner';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { ModalProvider, useModal } from './contexts/ModalContext';
import { AgentBridgeProvider } from './contexts/AgentBridgeContext';
import { CommandPaletteHost } from './components/CommandPalette/CommandPaletteHost';
import { AppGlobalModals } from './components/AppGlobalModals';
import { BootLoadingScreen } from './components/BootLoadingScreen';
import {
  PaletteContextProvider,
  useOpenPalette,
  useSetPaletteContext,
} from './components/CommandPalette/paletteContext';
import { useAppCommands } from './commands/useAppCommands';
import { useWorkflowCommands } from './commands/useWorkflowCommands';
import { useProjectNumberShortcuts } from './hooks/useProjectNumberShortcuts';
import { ToastList } from './components/primitives/ToastList';
import { TooltipProvider } from './components/primitives/Tooltip';
import { DevDesignSystemTools } from './components/design-system/DevDesignSystemTools';
import { logger } from './lib/logger';
import { asCommandError, formatCommandError } from './lib/errors';
import { trackEvent, trackPageview } from './lib/analytics';
import {
  getSnapshot as getWorkflowsSnapshot,
  subscribe as subscribeWorkflows,
  unreadCount,
} from './lib/workflowsStore';
import { useCompactWorkspaceToolbar } from './hooks/useCompactWorkspaceToolbar';
import { installAppLifecycleTracking, quitAppWithTracking } from './lib/appLifecycle';
import type { AppView } from './lib/types';
import './styles/index.css';

// Boot-path guard: a throw at module scope would leave a black window (#173),
// because this runs before ErrorBoundary exists. Logger/analytics are
// nice-to-have — they must never prevent React from mounting.
try {
  logger.init();
  void trackEvent('app_launched', { $screen_name: 'Dashboard' });
} catch (err) {
  console.error('[Ship Studio] Module-scope init failed', err);
}

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
    <TooltipProvider>
      <ToastProvider>
        <ModalProvider>
          <PaletteContextProvider>
            <AgentBridgeProvider>
              <AppContents initialProjectPath={initialProjectPath} />
              <CommandPaletteHost />
              <AppGlobalModals />
              <DevDesignSystemTools />
            </AgentBridgeProvider>
          </PaletteContextProvider>
        </ModalProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

const EMPTY_TAB_TITLES: Map<number, string> = new Map();
const EMPTY_ATTENTION_TABS: Set<number> = new Set();
const noop = () => {};
const loadingSpinner = <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />; // legacy .spinner look

function AppContents({ initialProjectPath }: AppProps) {
  const [view, setView] = useState<AppView>('loading');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  const [compactWorkspaceToolbarEnabled, updateCompactWorkspaceToolbar] =
    useCompactWorkspaceToolbar();
  const toggleSidebar = useCallback(() => {
    void trackEvent('sidebar_toggled', { is_hidden: !isSidebarHidden });
    setIsSidebarHidden(!isSidebarHidden);
  }, [isSidebarHidden]);
  const isCompact = useIsCompact();
  const setPaletteContext = useSetPaletteContext();
  useEffect(() => {
    if (view === 'workspace' || view === 'project-loading') {
      setPaletteContext({
        kind: 'project',
        currentProjectName: currentProject?.name ?? null,
        currentProjectPath: currentProject?.path ?? null,
      });
    } else if (view === 'projects' || view === 'workflows' || view === 'inbox') {
      // Workflows and the Inbox are home-level screens; left in 'other' their
      // ⌘K armed a palette that couldn't render (see CommandPaletteHost).
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
  const previewRef = useRef<import('./components/preview/Preview').PreviewHandle | null>(null);
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
    restartTerminalTab,
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
    knownDevServerPort,
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
    devServerUnexpectedExit,
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
    showThumbnailConsent,
    resolveThumbnailConsent,
    dismissThumbnailConsent,
    startScreenshotInterval,
    clearScreenshotInterval,
  } = useScreenshotManagement({
    previewRef,
    // Thumbnail capture must only ever target a port that provably belongs
    // to the current project — null (skip) beats the 3000 fallback here.
    devServerPort: knownDevServerPort,
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

  // Toast notifications — state lives in the app-root <ToastProvider>, so
  // `useOptionalToast()` consumers anywhere in the tree share this stack.
  // `toastsProps` is the memoized context value, still prop-drilled into
  // WorkspaceView during the transition off `onToast` prop chains.
  const toastsProps = useToast();
  const { toasts, showToast, dismissToast } = toastsProps;

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
    clearBranchState,
  } = useBranchManagement({
    currentProject,
    previewRef,
    healthPanelRef,
    showToast,
  });

  // Plugin system — lifecycle-hook failures (onActivate/onDeactivate) toast via onError
  const {
    plugins: loadedPlugins,
    failures: pluginFailures,
    getSlotPlugins,
    reloadPlugins,
  } = usePlugins(currentProject?.path ?? null, {
    onError: (name, msg) => showToast(`Plugin "${name}": ${msg}`, 'error'),
  });

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
    handleStartDevServer,
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
      } catch (err) {
        showToast(
          `Couldn't set dev server to port ${newPort}: ${formatCommandError(asCommandError(err))}`,
          'error'
        );
      }
    },
    [currentProject, restartDevServer, showToast, setDevServerPort]
  );

  // Register palette commands with real handlers — see src/commands/useAppCommands.tsx
  // `pinnedPaths` is passed after the rail hook runs; done below.

  const { pinnedProjects, handleTogglePin, handleRailClick, handleRailUnpin } = useProjectRail({
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
    handleStartDevServer,
    isDevServerRunning: isServerRunning,
    isEducationMode,
    setIsEducationMode,
    compactWorkspaceToolbarEnabled,
    setCompactWorkspaceToolbarEnabled: updateCompactWorkspaceToolbar,
    showToast,
  });

  useWorkflowCommands({ setView, showToast });

  const handoffDelivered = useCallback(
    () => showToast(HANDOFF_DELIVERED_MESSAGE, 'success'),
    [showToast]
  );

  // Deliver a queued "Fix with agent" prompt once the opened project actually
  // has a terminal to type into — see hooks/useWorkflowHandoff.
  useWorkflowHandoff(currentProject?.path ?? null, sendToClaude, handoffDelivered);

  // Close an active session from the sidebar (dashboard, collapsed rail, or
  // workspace). Ordering and the auto-open sentinel are load-bearing — see
  // hooks/useCloseProject.
  const handleCloseProject = useCloseProject({
    currentProjectPath: currentProject?.path ?? null,
    currentProjectPathRef,
    stopServer,
    closeAllTerminalsForProject,
    setCurrentProject,
    setView,
  });

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
            await setTerminalState(projectPath, {
              tabs: snap.terminalTabs.map((t) => ({
                agent_id: t.agentId,
                session_id: t.sessionId,
                custom_title: t.customTitle,
              })),
              active_tab_index: idx,
            });
          } catch (err) {
            logger.warn('[SelectProjectTab] Failed to persist active tab', {
              error: formatCommandError(asCommandError(err)),
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
      bgPrimary: 'var(--surface-app)',
      bgSecondary: 'var(--surface-panel)',
      bgTertiary: 'var(--surface-control)',
      textPrimary: 'var(--text-primary)',
      textSecondary: 'var(--text-secondary)',
      textMuted: 'var(--text-muted)',
      border: 'var(--border-default)',
      accent: 'var(--accent-active)',
      accentHover: 'var(--accent-active-hover)',
      action: 'var(--accent-active)',
      actionHover: 'var(--accent-active-hover)',
      actionText: 'var(--text-on-accent)',
      error: 'var(--accent-error)',
      success: 'var(--accent-success)',
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
      devServerUnexpectedExit,
      onRunInstall: handleRunInstallCurrent,
      onRunInstallFor: handleRunInstall,
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
      devServerUnexpectedExit,
      handleRunInstallCurrent,
      handleRunInstall,
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
    ]
  );

  const pluginsProps = useMemo(
    () => ({
      loadedPlugins,
      pluginFailures,
      getSlotPlugins,
      reloadPlugins,
    }),
    [loadedPlugins, pluginFailures, getSlotPlugins, reloadPlugins]
  );

  // Shared configuration for the home-level
  // sidebar, used by the Projects, Workflows, and Inbox screens.
  const workflowsSnapshot = useSyncExternalStore(subscribeWorkflows, getWorkflowsSnapshot);
  const inboxUnread = unreadCount(workflowsSnapshot);

  const homeSidebarProps = useMemo(
    () => ({
      onGoHome: () => setView('projects'),
      onGoWorkflows: () => setView('workflows'),
      onGoInbox: () => setView('inbox'),
      inboxUnreadCount: inboxUnread,
      onOpenProjectPicker: openProjectPicker,
      isSidebarHidden,
      onToggleSidebar: toggleSidebar,
      projects: pinnedProjects.rows,
      onSelectProject: handleRailClick,
      onCloseProject: handleCloseProject,
      onSelectProjectTab: handleSelectProjectTab,
      isProjectDevServerRunning: isServerRunning,
      onSwitchAccount: () => setView('account-select'),
    }),
    [
      inboxUnread,
      openProjectPicker,
      isSidebarHidden,
      toggleSidebar,
      pinnedProjects.rows,
      handleRailClick,
      handleCloseProject,
      handleSelectProjectTab,
      isServerRunning,
      setView,
    ]
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
      handleStartDevServer,
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
      handleStartDevServer,
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
    <QuitConfirmModal
      onCancel={() => setShowQuitConfirm(false)}
      onQuit={() => void quitAppWithTracking()}
    />
  );

  if (view === 'loading') {
    return (
      <>
        <BootLoadingScreen />
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
      // Refresh CLI states and go straight to projects (don't re-enter
      // onboarding). A first-time user only has the Default workspace, so the
      // picker would just be a dead-end click — it's reachable later via
      // "Switch Workspace" once they actually create a second workspace.
      await refreshAllCliStatuses();
      setView('projects');
    };

    return (
      <>
        <div className="app">
          <OnboardingRouter onComplete={() => void handleOnboardingComplete()} />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'account-select') {
    return (
      <>
        <div className="app">
          <AccountSelectScreen onContinue={() => setView('projects')} />
        </div>
        <ToastList toasts={toasts} onDismiss={dismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'projects') {
    return (
      <>
        <div className="app workspace workspace-home">
          <div
            className={`projects-with-rail${isCompact ? ' is-compact' : ''}`}
            key="view-projects"
          >
            {!isCompact && <HomeSidebar {...homeSidebarProps} activeNav="home" />}
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
              onProjectCreated={(path) => void handleProjectCreated(path)}
              importView={importView}
              setImportView={setImportView}
              onProjectImported={(path) => void handleProjectImported(path)}
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
              onSwitchAccount={() => setView('account-select')}
            />
          </div>
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
        <ToastList toasts={toasts} onDismiss={dismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  // Workflows and the Inbox: two home-level screens sharing the home sidebar.
  if (view === 'workflows' || view === 'inbox') {
    return (
      <>
        <StandingWorkView
          view={view}
          isCompact={isCompact}
          sidebarProps={homeSidebarProps}
          currentProjectPath={currentProject?.path ?? null}
          onOpenProject={handleSelectProject}
        />
        <ToastList toasts={toasts} onDismiss={dismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'project-loading') {
    const showCompactWorkspaceTitlebar = !isCompact && compactWorkspaceToolbarEnabled;
    return (
      <>
        <div
          className={`app workspace workspace-home${
            showCompactWorkspaceTitlebar ? ' has-workspace-titlebar workspace--compact-toolbar' : ''
          }`}
        >
          {showCompactWorkspaceTitlebar && (
            <WorkspaceTitlebar>
              <WorkspaceNavigation
                onGoHome={handleBackToProjects}
                isSidebarHidden={isSidebarHidden}
                onToggleSidebar={toggleSidebar}
              />
            </WorkspaceTitlebar>
          )}
          <div className="projects-with-rail" key="view-project-loading">
            <WorkspaceSidebar
              key="sidebar-project-loading"
              isHomeActive={false}
              onGoHome={handleBackToProjects}
              onOpenProjectPicker={openProjectPicker}
              isSidebarHidden={isSidebarHidden}
              onToggleSidebar={toggleSidebar}
              showNavigationControls={!compactWorkspaceToolbarEnabled}
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
              onSwitchAccount={() => setView('account-select')}
            />
            <div className="project-loading-body">
              {loadingSpinner}
              <p>Opening {currentProject?.name}...</p>
            </div>
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
        <div className="app loading">{loadingSpinner}</div>
        {quitConfirmModal}
      </>
    );
  }
  return (
    <>
      <WorkspaceView
        homeNav={homeSidebarProps}
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
        onUnpinProject={handleRailUnpin}
        onSelectProjectTab={handleSelectProjectTab}
        onGoHome={handleBackToProjects}
        onOpenProjectPicker={openProjectPicker}
        onSwitchAccount={() => setView('account-select')}
        isProjectDevServerRunning={isServerRunning}
        isSidebarHidden={isSidebarHidden}
        onToggleSidebar={toggleSidebar}
        compactWorkspaceToolbarEnabled={compactWorkspaceToolbarEnabled}
      />
      <ThumbnailConsentModal
        isOpen={showThumbnailConsent}
        onAllow={() => void resolveThumbnailConsent(true)}
        onDeny={() => void resolveThumbnailConsent(false)}
        onDismiss={dismissThumbnailConsent}
      />
      {quitConfirmModal}
    </>
  );
}

export default App;
