/**
 * Hook for project lifecycle operations.
 *
 * Manages: project selection/opening, back-to-projects, project creation/import,
 * dev server restart, compact mode entry, GitHub status refresh,
 * preview readiness, terminal interactions, and auto-accept mode.
 *
 * @module hooks/useProjectLifecycle
 */

import { useState, useRef, useCallback, type RefObject } from 'react';
import type { DevServerHandle, Project } from '../lib/project';
import type { ProjectType } from '../lib/static-server';
import type { ProjectGitHubStatus } from '../lib/github';
import { getAutoAcceptMode, setAutoAcceptMode as setAutoAcceptModeApi } from '../lib/project';
import { getProjectGitHubStatus } from '../lib/github';
import { GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';
import { registerExternalProject } from '../lib/external-projects';
import {
  setWindowTitle,
  getWindowLabel,
  findAndReservePort,
  releaseReservedPort,
  getProjectWindow,
  focusWindowByLabel,
} from '../lib/window';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent, trackError } from '../lib/analytics';

import type { AppView } from '../lib/types';

/** Preferred port for Next.js dev server (will find available port if taken) */
const PREFERRED_DEV_SERVER_PORT = 3000;

export interface UseProjectLifecycleParams {
  currentProject: Project | null;
  setCurrentProject: (project: Project | null) => void;
  currentProjectPathRef: RefObject<string | null>;
  setView: (view: AppView | ((prev: AppView) => AppView)) => void;
  // Dev server
  devServerRef: RefObject<DevServerHandle | null>;
  devServerPort: number;
  setDevServerPort: (port: number) => void;
  startServerForProject: (
    projectPath: string,
    projectName: string,
    port: number,
    windowLabel: string
  ) => Promise<ProjectType>;
  stopServer: () => Promise<void>;
  restartDevServer: (projectPath: string, portOverride?: number) => Promise<void>;
  enterCompact: (port: number) => Promise<void>;
  // Terminal
  resetTerminals: () => void;
  pasteToActiveTerminal: (text: string) => void;
  terminalTabs: Array<{ id: number; agentId: string; sessionId: string }>;
  activeTerminalTab: number;
  restoreTerminalTabs: (
    tabs: Array<{ agentId: string; sessionId: string }>,
    activeIndex: number
  ) => void;
  // Toast
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  // Cleanup status
  setCleanupStatus: (status: string | null) => void;
  // Screenshot
  clearScreenshotInterval: () => void;
  startScreenshotInterval: (projectPath: string) => void;
  onPreviewReady: (projectPath: string) => void;
  // Layout
  setShowDevServerLogs: (show: boolean) => void;
  setWorkspaceTab: (tab: 'preview' | 'branches' | 'prs') => void;
  resetLayout: () => void;
  // Integrations
  setProjectGitHubStatus: (status: ProjectGitHubStatus | null) => void;
  clearProjectStatuses: () => void;
  // Branches
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  clearBranchState: () => void;
  // Plugin
  checkPluginSuggestion: (projectPath: string) => Promise<void>;
}

export function useProjectLifecycle({
  currentProject,
  setCurrentProject,
  currentProjectPathRef,
  setView,
  devServerRef,
  devServerPort,
  setDevServerPort,
  startServerForProject,
  stopServer,
  restartDevServer,
  enterCompact,
  resetTerminals,
  pasteToActiveTerminal,
  terminalTabs,
  activeTerminalTab,
  restoreTerminalTabs,
  showToast,
  setCleanupStatus,
  clearScreenshotInterval,
  startScreenshotInterval,
  onPreviewReady,
  setShowDevServerLogs,
  setWorkspaceTab,
  resetLayout,
  setProjectGitHubStatus,
  clearProjectStatuses,
  fetchBranchInfo,
  clearBranchState,
  checkPluginSuggestion,
}: UseProjectLifecycleParams) {
  // Auto-accept mode for the terminal agent
  const [autoAcceptMode, setAutoAcceptMode] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Import project view: 'none' | 'picker' | 'github'
  const [importView, setImportView] = useState<'none' | 'picker' | 'github'>('none');

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState('/');

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);
  // Force publish dropdown to open (triggered by Save button in BranchIndicator) - trigger mode
  const [forcePublishOpen, setForcePublishOpen] = useState(false);
  // Compact publish dropdown state - controlled mode for toggle behavior via the compact Publish button
  const [isCompactPublishOpen, setIsCompactPublishOpen] = useState(false);

  // Auto-accept warning modal state
  const [showAutoAcceptWarning, setShowAutoAcceptWarning] = useState(false);

  // Track project path currently being opened to prevent concurrent opens (race condition guard)
  const openingProjectPathRef = useRef<string | null>(null);

  // Navigation version counter — incremented on every navigation action (open project, back to projects).
  // Used to detect when a stale async handleSelectProject should stop modifying view state.
  const navigationVersionRef = useRef(0);

  // Send prompt to Claude terminal
  const sendToClaude = useCallback(
    (prompt: string) => {
      pasteToActiveTerminal(prompt);
    },
    [pasteToActiveTerminal]
  );

  // Handle terminal exit (memoized to prevent re-spawning agent on every render)
  const handleTerminalExit = useCallback((code: number | null) => {
    logger.info('Terminal exited', { code });
  }, []);

  // Handle toolbar auto-accept toggle
  const handleToolbarAutoAcceptToggle = useCallback(() => {
    if (!autoAcceptMode) {
      // Turning ON — always show confirmation
      setShowAutoAcceptWarning(true);
      return;
    }
    // Turning OFF — no confirmation needed
    setAutoAcceptMode(false);
    if (currentProject) {
      void setAutoAcceptModeApi(currentProject.path, false);
    }
  }, [autoAcceptMode, currentProject]);

  const handleAutoAcceptWarningAccept = useCallback(() => {
    setAutoAcceptMode(true);
    setShowAutoAcceptWarning(false);
    if (currentProject) {
      void setAutoAcceptModeApi(currentProject.path, true);
    }
  }, [currentProject]);

  // Handle preview server ready wrapper
  const handlePreviewReady = useCallback(() => {
    if (currentProject) {
      onPreviewReady(currentProject.path);
    }
  }, [currentProject, onPreviewReady]);

  const handleSelectProject = async (project: Project) => {
    const windowLabel = getWindowLabel();
    const totalStart = performance.now();
    let stepStart = performance.now();

    // Claim a new navigation version — any prior handleSelectProject or handleBackToProjects
    // that captured an older version will know it's been superseded.
    const navVersion = ++navigationVersionRef.current;

    logger.info(`[OpenProject] Starting: ${project.name}`, { windowLabel });
    void trackEvent('project_opened', {
      project_name: project.name,
      project_path: project.path,
      $screen_name: 'Workspace',
    });

    // Guard against concurrent opens for the same project (race condition prevention)
    if (openingProjectPathRef.current === project.path) {
      logger.info(`[OpenProject] Already opening ${project.name}, skipping duplicate call`);
      return;
    }
    openingProjectPathRef.current = project.path;

    // ─── IMMEDIATE: Show loading screen before any async work ───
    // This ensures the user sees visual feedback instantly when clicking a project,
    // even if cleanup (kill_port, kill_window_pty, etc.) takes time.
    setCurrentProject(project);
    setCurrentPreviewPage('/');
    currentProjectPathRef.current = project.path;
    clearScreenshotInterval();
    setIsPublishing(false);
    setShowDevServerLogs(false);
    setView('project-loading');

    // Restore saved terminal tabs (non-blocking — don't delay project loading)
    invoke<{
      tabs: Array<{ agent_id: string; session_id: string }>;
      active_tab_index: number;
    } | null>('get_terminal_state', { projectPath: project.path })
      .then((savedState) => {
        if (savedState && savedState.tabs.length > 0) {
          logger.info('[OpenProject] Restoring saved terminal tabs', {
            tabCount: savedState.tabs.length,
            activeIndex: savedState.active_tab_index,
          });
          restoreTerminalTabs(
            savedState.tabs.map((t) => ({ agentId: t.agent_id, sessionId: t.session_id })),
            savedState.active_tab_index
          );
        } else {
          resetTerminals();
        }
      })
      .catch(() => {
        resetTerminals();
      });

    // Store project path for HMR recovery (critical for main window which doesn't have initialProjectPath)
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    sessionStorage.setItem(storageKey, project.path);

    // Set window title to include project name
    void setWindowTitle(`Ship Studio - ${project.name}`).catch((error) => {
      logger.error('Failed to set window title', { error });
    });

    // ─── ASYNC: Cleanup, register, reserve port, then start server ───

    // Check if project is already open in another window
    try {
      const existingWindow = await getProjectWindow(project.path);
      if (existingWindow && existingWindow !== windowLabel) {
        logger.info(`[OpenProject] Project already open in window ${existingWindow}, focusing`);
        try {
          await focusWindowByLabel(existingWindow);
          openingProjectPathRef.current = null; // Clear guard before return
          return; // Successfully focused existing window
        } catch (focusError) {
          // Window no longer exists (stale data), proceed with opening locally
          logger.info(`[OpenProject] Window ${existingWindow} no longer exists, opening locally`, {
            focusError: focusError instanceof Error ? focusError.message : String(focusError),
          });
        }
      }
    } catch (e) {
      logger.warn('[OpenProject] Failed to check for existing window', { error: e });
    }

    // Register this window's project to prevent duplicate windows
    try {
      await invoke('register_project_for_window', {
        windowLabel,
        projectPath: project.path,
      });
    } catch (e) {
      logger.warn('[OpenProject] Failed to register project for window', { error: e });
    }

    // Ensure external projects are registered before any backend commands run.
    // Projects outside ~/ShipStudio can enter the app via session restore, URL params,
    // or direct path — without this, all validate_project_path() calls would fail.
    try {
      const wasRegistered = await invoke<boolean>('ensure_external_project_registered', {
        path: project.path,
      });
      if (wasRegistered) {
        logger.info(`[OpenProject] Auto-registered external project: ${project.path}`);
      }
    } catch (e) {
      logger.warn('[OpenProject] Failed to ensure external project registration', { error: e });
    }

    // Stop any existing dev server first
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }
    logger.info(
      `[OpenProject] Step 1: Stop existing dev server - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Kill any process on our ACTUALLY reserved port (query backend, don't use stale React state)
    // This prevents HMR reload from killing other windows' ports when state resets to 3000
    stepStart = performance.now();
    const actualReservedPort = await invoke<number | null>('get_reserved_port_for_window', {
      windowLabel,
    });
    if (actualReservedPort !== null) {
      try {
        await Promise.race([
          invoke('kill_port', { port: actualReservedPort }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Ignore errors - port may already be free
      }
    }
    logger.info(
      `[OpenProject] Step 2: Kill reserved port ${actualReservedPort ?? 'none'} - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Clean up PTY processes owned by this window (not other windows' PTYs)
    stepStart = performance.now();
    try {
      await invoke('kill_window_pty', { windowLabel: getWindowLabel() });
      await invoke('cleanup_orphaned_processes');
    } catch {
      // Ignore cleanup errors
    }
    logger.info(
      `[OpenProject] Step 3: Kill PTY and cleanup orphaned processes - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Check if navigation was superseded during cleanup
    if (navigationVersionRef.current !== navVersion) {
      logger.info(`[OpenProject] Aborted (superseded) after cleanup: ${project.name}`);
      openingProjectPathRef.current = null;
      return;
    }

    // Load saved dev server port preference
    stepStart = performance.now();
    let preferredPort = PREFERRED_DEV_SERVER_PORT;
    try {
      const savedPort = await invoke<number | null>('get_dev_server_port', {
        projectPath: project.path,
      });
      if (savedPort && savedPort >= 1 && savedPort <= 65535) {
        preferredPort = savedPort;
      }
    } catch {
      // Fall back to default — metadata might not exist yet
    }
    logger.info(
      `[OpenProject] Step 4a: Load saved port preference (${preferredPort}) - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Find and reserve an available port for this window (prevents race conditions in multi-window)
    stepStart = performance.now();
    let port = preferredPort;
    try {
      // Release any previously reserved port for this window before getting a new one
      await releaseReservedPort().catch(() => {});
      port = await findAndReservePort(preferredPort);
    } catch (error) {
      logger.error('Failed to find and reserve port, using default', { error });
    }
    // Kill any orphaned process on the newly reserved port (e.g. from a previous crashed session)
    try {
      await Promise.race([
        invoke('kill_port', { port }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // Ignore - port may already be free
    }
    logger.info(
      `[OpenProject] Step 4: Reserved port ${port} (killed orphans) - ${Math.round(performance.now() - stepStart)}ms`
    );
    setDevServerPort(port);

    // Fetch auto-accept mode preference for this project
    stepStart = performance.now();
    try {
      const autoAccept = await getAutoAcceptMode(project.path);
      setAutoAcceptMode(autoAccept);
    } catch {
      setAutoAcceptMode(false);
    }
    logger.info(
      `[OpenProject] Step 5: Fetch auto-accept mode - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Check if navigation was superseded
    if (navigationVersionRef.current !== navVersion) {
      logger.info(`[OpenProject] Aborted (superseded) after step 5: ${project.name}`);
      openingProjectPathRef.current = null;
      return;
    }

    // Mark project as opened (for sorting by last opened)
    void invoke('mark_project_opened', { projectPath: project.path }).catch((err) =>
      logger.warn('Failed to mark project as opened', { error: err })
    );

    // Ensure .shipstudio/ is gitignored (backwards compat for existing projects)
    void invoke('ensure_gitignore_has_shipstudio', { projectPath: project.path }).catch((err) =>
      logger.warn('Failed to ensure gitignore', { error: err })
    );

    // Fetch branch info (needed for UI before showing workspace)
    stepStart = performance.now();
    await fetchBranchInfo(project.path);
    logger.info(
      `[OpenProject] Step 6: Fetch branch info - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Check again after await
    if (navigationVersionRef.current !== navVersion) {
      logger.info(`[OpenProject] Aborted (superseded) after step 6: ${project.name}`);
      openingProjectPathRef.current = null;
      return;
    }

    // Detect project type and start appropriate server
    stepStart = performance.now();
    const detectedType = await startServerForProject(project.path, project.name, port, windowLabel);
    logger.info(
      `[OpenProject] Step 7: Start dev server - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Final check before committing to workspace view
    if (navigationVersionRef.current !== navVersion) {
      logger.info(`[OpenProject] Aborted (superseded) after step 7: ${project.name}`);
      openingProjectPathRef.current = null;
      return;
    }

    // Generic projects don't have a web preview — default to branches tab
    if (detectedType === 'generic') {
      setWorkspaceTab('branches');
    }

    setView('workspace');
    logger.info(`[OpenProject] Complete - Total: ${Math.round(performance.now() - totalStart)}ms`);

    // Fetch GitHub status in background (non-blocking for faster perceived load)
    void getProjectGitHubStatus(project.path)
      .catch(() => GITHUB_STATUS_FALLBACK)
      .then((ghStatus) => {
        setProjectGitHubStatus(ghStatus);
      });

    // Capture screenshots periodically
    startScreenshotInterval(project.path);

    // Suggest Vercel plugin if project has .vercel config but plugin isn't installed
    void checkPluginSuggestion(project.path);

    // Clear the guard after completion
    openingProjectPathRef.current = null;
  };

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleProjectCreated = (projectPath: string) => {
    setShowCreateModal(false);
    const projectName = projectPath.split('/').pop() || 'project';
    void trackEvent('project_created', {
      project_name: projectName,
      source: 'new',
      $screen_name: 'Create Project',
    });
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportProject = () => {
    setImportView('picker');
  };

  const handleProjectImported = (projectPath: string) => {
    setImportView('none');
    const projectName = projectPath.split('/').pop() || 'project';
    void trackEvent('project_imported', {
      project_name: projectName,
      source: 'github',
      $screen_name: 'Import Project',
    });
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportLocalFolder = async () => {
    setImportView('none');
    try {
      const path = await registerExternalProject();
      if (path) {
        const projectName = path.split('/').pop() || 'project';
        void trackEvent('project_imported', {
          project_name: projectName,
          source: 'local_folder',
          $screen_name: 'Import Project',
        });
        void handleSelectProject({ name: projectName, path, thumbnail: null });
      }
    } catch (error) {
      trackError('local_folder_import', error, 'Dashboard');
      showToast(String(error), 'error');
    }
  };

  const handleBackToProjects = async () => {
    // Save terminal state in background (non-blocking)
    if (currentProject && terminalTabs.length > 0) {
      const activeIdx = terminalTabs.findIndex((t) => t.id === activeTerminalTab);
      invoke('set_terminal_state', {
        projectPath: currentProject.path,
        state: {
          tabs: terminalTabs.map((t) => ({
            agent_id: t.agentId,
            session_id: t.sessionId,
          })),
          active_tab_index: Math.max(0, activeIdx),
        },
      })
        .then(() => {
          logger.info('[BackToProjects] Saved terminal state', { tabCount: terminalTabs.length });
        })
        .catch((err) => {
          logger.warn('[BackToProjects] Failed to save terminal state', { error: String(err) });
        });
    }

    // Mark that user explicitly went back to projects - this prevents auto-open from
    // firing again even after HMR reloads (survives page refresh)
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    sessionStorage.removeItem(storageKey);
    sessionStorage.setItem(dismissedKey, 'true');

    // Bump navigation version to cancel any in-flight handleSelectProject async chains.
    // Capture it so we can check if a new handleSelectProject started during our cleanup.
    const backNavVersion = ++navigationVersionRef.current;

    logger.info('[BackToProjects] Starting');

    // Switch view IMMEDIATELY — all cleanup below is background work
    setCurrentProject(null);
    clearProjectStatuses();
    setView('projects');
    setCleanupStatus('Closing terminals...');

    // Clear the opening guard so handleSelectProject can proceed for a new project
    openingProjectPathRef.current = null;

    // Reset window title when closing project
    void setWindowTitle('Ship Studio').catch(console.error);

    // --- Background cleanup (non-blocking) ---
    // IMPORTANT: Each step checks navVersion before doing destructive work.
    // If the user opens a new project during cleanup, we must stop immediately
    // to avoid killing the new project's dev server or PTY processes.

    let t = performance.now();
    try {
      await invoke('unregister_project_from_window', { windowLabel });
      logger.info('[BackToProjects] unregister_project_from_window', {
        ms: Math.round(performance.now() - t),
      });
    } catch {
      // Ignore - non-critical
    }

    // Bail if user already opened another project
    if (navigationVersionRef.current !== backNavVersion) {
      logger.info('[BackToProjects] Cleanup aborted - new project opened', {
        backNavVersion,
        currentNavVersion: navigationVersionRef.current,
      });
      return;
    }

    // Clear screenshot interval and project ref
    clearScreenshotInterval();
    currentProjectPathRef.current = null;

    // Reset publishing and auto-accept state
    setIsPublishing(false);
    setAutoAcceptMode(false);

    // Clear branch state
    clearBranchState();

    resetLayout();

    // Yield to browser so the projects view renders before heavy terminal cleanup
    await new Promise((resolve) => setTimeout(resolve, 0));

    t = performance.now();
    resetTerminals();
    logger.info('[BackToProjects] resetTerminals', { ms: Math.round(performance.now() - t) });

    // Check again before destructive server/process cleanup
    if (navigationVersionRef.current !== backNavVersion) {
      logger.info('[BackToProjects] Cleanup aborted - new project opened before stopServer', {
        backNavVersion,
        currentNavVersion: navigationVersionRef.current,
      });
      return;
    }

    setCleanupStatus('Stopping server...');
    // Yield again so the status update renders
    await new Promise((resolve) => setTimeout(resolve, 0));
    t = performance.now();
    await stopServer();
    logger.info('[BackToProjects] stopServer', { ms: Math.round(performance.now() - t) });

    // Check again — stopServer may have taken a while
    if (navigationVersionRef.current !== backNavVersion) {
      logger.info('[BackToProjects] Cleanup aborted - new project opened after stopServer', {
        backNavVersion,
        currentNavVersion: navigationVersionRef.current,
      });
      return;
    }

    const currentWindowLabel = getWindowLabel();

    setCleanupStatus('Cleaning up processes...');
    try {
      t = performance.now();
      await invoke('kill_window_pty', { windowLabel: currentWindowLabel });
      logger.info('[BackToProjects] kill_window_pty', { ms: Math.round(performance.now() - t) });
      t = performance.now();
      await invoke('cleanup_orphaned_processes');
      logger.info('[BackToProjects] cleanup_orphaned_processes', {
        ms: Math.round(performance.now() - t),
      });
      // Query backend for the actual reserved port (don't rely on potentially stale React state)
      const actualPort = await invoke<number | null>('get_reserved_port_for_window', {
        windowLabel: currentWindowLabel,
      });
      if (actualPort !== null) {
        await Promise.race([
          invoke('kill_port', { port: actualPort }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    } catch {
      // Ignore cleanup errors
    }

    setCleanupStatus(null);
    logger.info('[BackToProjects] Cleanup completed', { backNavVersion });
  };

  const handleRestartDevServer = async () => {
    if (!currentProject) return;
    await restartDevServer(currentProject.path);
  };

  // Compact mode handler wrapper
  const handleEnterCompactMode = async () => {
    try {
      await enterCompact(devServerPort);
    } catch {
      showToast('Failed to enter compact mode', 'error');
    }
  };

  const handleGitHubStatusChange = () => {
    // Refresh project GitHub status after push/publish
    if (currentProject) {
      void getProjectGitHubStatus(currentProject.path)
        .catch(() => GITHUB_STATUS_FALLBACK)
        .then((status) => setProjectGitHubStatus(status));
    }
  };

  return {
    // State
    autoAcceptMode,
    setAutoAcceptMode,
    showCreateModal,
    setShowCreateModal,
    importView,
    setImportView,
    setCurrentPreviewPage,
    isPublishing,
    setIsPublishing,
    forcePublishOpen,
    setForcePublishOpen,
    isCompactPublishOpen,
    setIsCompactPublishOpen,
    showAutoAcceptWarning,
    setShowAutoAcceptWarning,
    // Handlers
    handleSelectProject,
    handleBackToProjects,
    handleProjectCreated,
    handleImportProject,
    handleProjectImported,
    handleImportLocalFolder,
    handleCreateProject,
    handleRestartDevServer,
    handleEnterCompactMode,
    handleGitHubStatusChange,
    handlePreviewReady,
    sendToClaude,
    handleTerminalExit,
    handleToolbarAutoAcceptToggle,
    handleAutoAcceptWarningAccept,
  };
}
