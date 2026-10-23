import { commentAgents } from '../../lib/commentAgents';
import type { WorkspaceViewProps } from './workspaceViewTypes';
export type { WorkspaceViewProps } from './workspaceViewTypes';
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

import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../../lib/logger';
import { setTerminalState } from '../../lib/project';
import type { InspectTab } from '../preview/Preview';
import { CompactWorkspace } from './CompactWorkspace';
import { MainBranchBanner } from '../branches/MainBranchBanner';
import { useIsCompact } from '../../hooks/useIsCompact';
import { useLocalStorageFlag } from '../../hooks/useLocalStorageFlag';
import { WorkspaceModalHost } from './WorkspaceModalHost';
import { WorkspaceModes } from './WorkspaceModes';
import { WorkspaceDock } from './WorkspaceDock';
import { WorkspaceLayoutMenu } from './WorkspaceLayoutMenu';
import { WorkspacePreviewPane } from './WorkspacePreviewPane';
import { WorkspaceTerminalPane } from './WorkspaceTerminalPane';
import { PanelDockProvider, usePanelDock } from '../../contexts/PanelDockContext';
import { useLayoutCommands } from '../../commands/useLayoutCommands';
import { isDocked } from '../../lib/workspaceLayout';
import { WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { trackEvent } from '../../lib/analytics';
import { useWorkspaceCommands } from '../../commands/useWorkspaceCommands';
import { useSnapshots } from '../../hooks/useSnapshots';
import { useWorktreeWorkflow } from '../../hooks/useWorktreeWorkflow';
import { WorkspacePluginsSlot } from '../plugins/WorkspacePluginsSlot';
import { useShopifyTheme } from '../../hooks/useShopifyTheme';
import { isMac } from '../../lib/setup';
import { kbd } from '../../lib/shortcuts';
import { useModal } from '../../contexts/ModalContext';
import { sessionRegistry } from '../../lib/sessionRegistry';
import { defaultWorkspaceTab, workspacePreviewCapabilities } from './workspaceViewState';
import { useWorkspaceShortcutControls } from '../../hooks/useWorkspaceShortcutControls';
import { useWorkspacePanelCommands } from '../../hooks/useWorkspacePanelCommands';
import { useWorkspaceComments } from '../../hooks/useWorkspaceComments';
import { useWorkspaceVariablesPanel } from '../../hooks/useWorkspaceVariablesPanel';
import { useWorkspaceTerminalShortcuts } from '../../hooks/useWorkspaceTerminalShortcuts';
import '../../styles/features/notifications.css';

/**
 * The workspace, with a rail around it.
 *
 * The panel layout is a context because five different panels — three of them
 * rendered from inside `Preview` — need to agree on it, and a prop chain
 * through the preview pane to reach the visual editor would have been five
 * levels deep. The provider is a separate component from the view for the
 * ordinary reason: a component cannot consume a context it provides.
 */
export const WorkspaceView = memo(function WorkspaceView(props: WorkspaceViewProps) {
  return (
    <PanelDockProvider
      projectPath={props.currentProject.path}
      focusMode={props.layout.isPreviewHidden}
    >
      <WorkspaceViewInner {...props} />
    </PanelDockProvider>
  );
});

const WorkspaceViewInner = memo(function WorkspaceViewInner({
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
  onRenameProject,
  onTogglePinProject,
  onStopDevServer,
  onSelectProjectTab,
  onGoHome,
  homeNav,
  onSwitchAccount,
  onUnpinProject,
  onReorderProjects,
  onOpenProjectPicker,
  isProjectDevServerRunning,
  getProjectDevServerSnapshot,
  devServerLifecycleVersion,
  isSidebarHidden,
  onToggleSidebar,
  compactWorkspaceToolbarEnabled,
}: WorkspaceViewProps) {
  // Window-width gate for the compact layout. Purely reactive — no Tauri
  // resize calls, no pinning. See src/hooks/useIsCompact.ts for the threshold.
  const isCompact = useIsCompact();
  const currentDevServerSnapshot = getProjectDevServerSnapshot(currentProject.path);

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
    clearInitialPrompt,
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
    knownDevServerPort,
    healthPanelRef,
    devServerPort,
    projectType,
    projectTypeResolved,
    isRestartingDevServer,
    devCommands,
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
    repoHasConflicts,
    fetchBranchInfo,
    checkGitStatus,
    handleBranchSwitch,
    handlePullLatest,
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
  // receive it when they have a dev command to run — a configured custom one
  // (#691) or their package.json `dev` script (#1105); native mobile
  // projects use the device mirror when the platform supports it.
  const { mobilePreviewAvailable, isWebProject, hasPreview } = workspacePreviewCapabilities(
    projectType,
    isMac(),
    devCommands.generic
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
  // projects. While detection is pending, stay on Preview so the workspace
  // does not flash Code before the dev server capability is known. Once
  // resolved, generic/unknown projects land on Code (no preview available).
  // Without this, switching from a web project while on Branches/PRs would
  // land you on Branches/PRs in the next project too, which reads as "sticky
  // state from the wrong place".
  useEffect(() => {
    setWorkspaceTab(defaultWorkspaceTab(hasPreview, projectTypeResolved));
    // Only re-fire on project path change. We deliberately *don't* depend
    // on `workspaceTab` here — that would force-revert every user click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject.path, hasPreview, projectTypeResolved]);

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
  // Where the panels are. `useLocalStorageFlag('agentPanelPinned')` and its four
  // siblings used to answer this one panel at a time; the rail answers all of
  // them, and knows what order they are in as well as which are docked.
  const dock = usePanelDock();
  const agentPanelDocked = isDocked(dock.layout, 'agent');
  const toggleAgentPanelDocked = useCallback(
    () => dock.setDocked('agent', !agentPanelDocked),
    [dock, agentPanelDocked]
  );
  const [elementTreePreviewAvailable, setElementTreePreviewAvailable] = useState(false);
  const [elementTreeVisible, setElementTreeVisible, toggleElementTree] = useLocalStorageFlag(
    'elementTreeVisible',
    true
  );
  const elementTreeDocked = isDocked(dock.layout, 'navigator');
  const toggleElementTreeDocked = useCallback(
    () => dock.setDocked('navigator', !elementTreeDocked),
    [dock, elementTreeDocked]
  );
  const closeElementTree = useCallback(() => {
    setElementTreeVisible(false);
  }, [setElementTreeVisible]);
  const elementTreeAvailable =
    workspaceTab === 'preview' && !isPreviewHidden && elementTreePreviewAvailable;
  const elementTreePanelVisible = elementTreeAvailable && elementTreeVisible;
  const variablesPanelDocked = isDocked(dock.layout, 'variables');
  const toggleVariablesPanelDocked = useCallback(
    () => dock.setDocked('variables', !variablesPanelDocked),
    [dock, variablesPanelDocked]
  );
  const variables = useWorkspaceVariablesPanel({
    isWebProject,
    workspaceTab,
    isPreviewHidden,
    projectPath: currentProject.path,
    setIsPreviewHidden,
    setWorkspaceTab,
    startDevServer: handleStartDevServer,
  });
  const toggleAgentPanel = useCallback(() => {
    if (!isAgentPanelHidden) {
      setIsPreviewHidden(false);
    }
    setIsAgentPanelHidden(!isAgentPanelHidden);
  }, [isAgentPanelHidden, setIsPreviewHidden]);
  const handleSelectPreview = useCallback(() => {
    void handleStartDevServer();
  }, [handleStartDevServer]);

  // Opening the inspect panel is the adoption signal for browser tools; the
  // close and the sub-tab switches are not. Read previous state from the
  // closure (not a functional updater) to avoid double-firing under StrictMode.
  const togglePreviewLogs = useCallback(() => {
    if (!showPreviewLogs) void trackEvent('inspect_panel_opened');
    setShowPreviewLogs(!showPreviewLogs);
  }, [showPreviewLogs]);

  useLayoutCommands();

  useWorkspacePanelCommands({
    isAgentPanelHidden,
    toggleAgentPanel,
    agentPanelDocked,
    toggleAgentPanelDocked,
    elementTreeDocked,
    toggleElementTreeDocked,
    variablesPanelDocked,
    toggleVariablesPanelDocked,
    isWebProject,
    variablesPanelOpen: variables.open,
    toggleVariablesPanel: variables.toggle,
    showPreviewLogs,
    togglePreviewLogs,
  });

  useWorkspaceShortcutControls({
    previewRef,
    hasPreview,
    projectTypeResolved,
    setIsPreviewHidden,
    setWorkspaceTab,
    togglePreviewLogs,
    onSelectPreview: handleSelectPreview,
  });

  // Workspace-scoped palette commands (branch + PR flows).
  useWorkspaceCommands({
    currentBranch,
    hasUncommittedChanges,
    // The repository's actual state, not whether the panel happens to be open.
    // Gating the palette entry on the panel meant "Resolve merge conflicts"
    // only appeared once you had already found your way to the resolution UI,
    // which is precisely when you no longer need a shortcut to it.
    hasConflicts: repoHasConflicts,
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
    projectStatus: integrations.projectGithub ?? null,
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

  // One agent list for both the Team panel's handoff and the preview's pins.
  const agentsForComments = commentAgents(currentProject.path, terminal, tabTitles, setIsAgentPanelHidden); // prettier-ignore
  const team = useWorkspaceComments({
    project: currentProject,
    agents: agentsForComments,
    activeAgentId: activeTerminalTab,
    isWebProject,
    previewRunning: knownDevServerPort !== null,
    setIsPreviewHidden,
    setWorkspaceTab,
    startDevServer: handleStartDevServer,
  });

  useWorkspaceTerminalShortcuts({
    terminalTabs,
    activeTerminalTab,
    setActiveTerminalTab,
    addTerminalTab,
    closeTerminalTab,
    showToast,
  });

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
      projectTypeResolved={projectTypeResolved}
      isPreviewHidden={isPreviewHidden}
      workspaceTab={workspaceTab}
      setIsPreviewHidden={setIsPreviewHidden}
      setWorkspaceTab={setWorkspaceTab}
      onSelectPreview={handleSelectPreview}
    />
  );

  const header = WorkspaceHeader({
    projectPath: currentProject.path,
    projectName: currentProject.name,
    onGoHome,
    onGoWorkflows: homeNav?.onGoWorkflows,
    onGoInbox: homeNav?.onGoInbox,
    inboxUnreadCount: homeNav?.inboxUnreadCount,
    isSidebarHidden,
    onToggleSidebar,
    compactWorkspaceToolbarEnabled,
    onOpenAssetsPanel: assetsPanelModal.open,
    assetsPanelVisible: assetsPanelModal.isOpen,
    isFocusMode: isPreviewHidden,
    elementTreeVisible: elementTreePanelVisible,
    elementTreeAvailable,
    onToggleElementTree: toggleElementTree,
    agentPanelVisible: !isAgentPanelHidden,
    onToggleAgentPanel: toggleAgentPanel,
    variablesPanelVisible: variables.open,
    variablesPanelAvailable: isWebProject,
    onToggleVariablesPanel: variables.toggle,
    layoutMenu: <WorkspaceLayoutMenu />,
    teamPresence: team.presence,
    modes: modesNode,
    headerExtras: (
      <WorkspacePluginsSlot
        plugins={plugins}
        pluginProject={pluginProject}
        pluginActions={pluginActions}
        pluginTheme={pluginTheme}
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
            clearInitialPrompt={clearInitialPrompt}
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
              onReorderProjects={onReorderProjects}
              onRenameProject={onRenameProject}
              onTogglePinProject={onTogglePinProject}
              onStopDevServer={onStopDevServer}
              getProjectDevServerSnapshot={getProjectDevServerSnapshot}
              devServerLifecycleVersion={devServerLifecycleVersion}
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
                      setInspectTabRaw('logs');
                    }
                  : undefined
              }
              onRestartDevServer={
                isWebProject || devCommands.generic
                  ? () => void handleRestartDevServer()
                  : undefined
              }
              devServerUrl={
                isWebProject && currentDevServerSnapshot.address
                  ? `http://${currentDevServerSnapshot.address}`
                  : undefined
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
                {/* Where a panel is written here has no bearing on where it
                    appears: each one's placeholder is portaled into whichever
                    rail slot the layout gives it. This is just the tree. */}
                <WorkspaceDock
                  focusMode={isPreviewHidden}
                  preview={
                    <WorkspacePreviewPane
                      activeCommentAgentId={activeTerminalTab}
                      commentsOpen={team.commentsActive}
                      commentAgents={agentsForComments}
                      currentProject={currentProject}
                      previewRef={previewRef}
                      workspaceTab={workspaceTab}
                      setWorkspaceTab={setWorkspaceTab}
                      hasPreview={hasPreview}
                      projectTypeResolved={projectTypeResolved}
                      previewConnectionEnabled={knownDevServerPort !== null}
                      serverAlreadyRunning={currentDevServerSnapshot.status === 'ready'}
                      serverInstanceId={currentDevServerSnapshot.instanceId}
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
                      setInspectTab={setInspectTabRaw}
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
                      elementTreePinned={elementTreeDocked}
                      toggleElementTreePinned={toggleElementTreeDocked}
                      closeElementTree={closeElementTree}
                      setElementTreePreviewAvailable={setElementTreePreviewAvailable}
                      variablesPanelVisible={variables.open}
                      variablesPanelPinned={variablesPanelDocked}
                      toggleVariablesPanelPinned={toggleVariablesPanelDocked}
                      closeVariablesPanel={() => variables.setVisible(false)}
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
                >
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
                    clearInitialPrompt={clearInitialPrompt}
                    showHealthLogs={showHealthLogs}
                    healthOutput={healthOutput}
                    healthOutputVersion={healthOutputVersion}
                    sendToClaude={sendToClaude}
                    isPreviewHidden={isPreviewHidden}
                    isAgentPanelHidden={isAgentPanelHidden}
                    agentPanelPinned={agentPanelDocked}
                    toggleAgentPanelPinned={toggleAgentPanelDocked}
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
                    isPreviewCaptureAvailable={previewVisible}
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
                  {team.panel}
                </WorkspaceDock>
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
          devCommand={{
            customDevCommand: devCommands.custom,
            onSaveDevCommand: handleSaveDevCommand,
          }}
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
