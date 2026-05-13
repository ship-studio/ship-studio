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
import type { Project, WorkspaceInfo } from '../lib/project';
import type { ProjectType } from '../lib/static-server';
import type { ProjectGitHubStatus } from '../lib/github';
import {
  getAutoAcceptMode,
  setAutoAcceptMode as setAutoAcceptModeApi,
  detectWorkspaces,
  getWorkspaceSubpath,
  setWorkspaceSubpath,
} from '../lib/project';
import type { WorkspacePick } from '../components/MonorepoPickerModal';
import { getProjectGitHubStatus } from '../lib/github';
import { GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';
import {
  registerExternalProject,
  unregisterExternalProject,
  isProjectExternal,
} from '../lib/external-projects';
import { registerProjectSession } from '../lib/projectSessions';
import { sessionRegistry } from '../lib/sessionRegistry';
import { getDefaultAgentId } from '../lib/agent';
import {
  setWindowTitle,
  getWindowLabel,
  findAndReservePort,
  getProjectWindow,
  focusWindowByLabel,
} from '../lib/window';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { trackEvent, trackError, setActiveProject } from '../lib/analytics';
import { asCommandError, formatCommandError } from '../lib/errors';
import { getProjectId } from '../lib/projectIdentity';
import { startProjectSession, endProjectSession } from '../lib/session';

import type { AppView } from '../lib/types';

/** Preferred port for Next.js dev server (will find available port if taken) */
const PREFERRED_DEV_SERVER_PORT = 3000;

export interface UseProjectLifecycleParams {
  currentProject: Project | null;
  setCurrentProject: (project: Project | null) => void;
  currentProjectPathRef: RefObject<string | null>;
  setView: (view: AppView | ((prev: AppView) => AppView)) => void;
  // Dev server
  setDevServerPort: (port: number, projectPath?: string) => void;
  startServerForProject: (
    projectPath: string,
    projectName: string,
    port: number,
    windowLabel: string
  ) => Promise<ProjectType>;
  isServerRunning: (projectPath: string) => boolean;
  restartDevServer: (projectPath: string, portOverride?: number) => Promise<void>;
  /** Drop the dependency-install gate on a project's dev server. Called after
   *  a successful pnpm/npm install so a follow-up startServer actually spawns. */
  clearNeedsInstall: (projectPath: string) => void;
  // Terminal
  pasteToActiveTerminal: (text: string) => void;
  terminalTabs: Array<{ id: number; agentId: string; sessionId: string }>;
  activeTerminalTab: number;
  /** Seed a project's tab list from persisted backend state on first open. */
  restoreTerminalTabs: (
    projectPath: string,
    tabs: Array<{ agentId: string; sessionId: string }>,
    activeIndex: number
  ) => void;
  /** Seed the project with a default tab when no persisted state exists. */
  ensureProjectSeeded: (projectPath: string) => void;
  // Toast
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  // Cleanup status
  setCleanupStatus: (status: string | null) => void;
  // Screenshot
  clearScreenshotInterval: () => void;
  startScreenshotInterval: (projectPath: string) => void;
  onPreviewReady: (projectPath: string) => void;
  // Layout
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
}: UseProjectLifecycleParams) {
  // Auto-accept mode for the terminal agent
  const [autoAcceptMode, setAutoAcceptMode] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Import project view: 'none' | 'picker' | 'github'
  const [importView, setImportView] = useState<'none' | 'picker' | 'github'>('none');

  // Pending monorepo picker — set when an unconfigured monorepo is being
  // opened. The actual project open is deferred until the user commits.
  const [pendingMonorepoPick, setPendingMonorepoPick] = useState<{
    project: Project;
    workspaces: WorkspaceInfo[];
    selectedPick: WorkspacePick | null;
  } | null>(null);

  // Active dependency install — when set, the overlay terminal is visible and
  // running `pnpm install` (or the detected pm) so the user can watch it
  // stream. Cleared on user-cancel or on exit-0 (which also restarts the dev
  // server). Exit-non-zero leaves the overlay up showing the error.
  //
  // `args` lives in state (not a literal in JSX) so its reference is stable
  // across renders — OnboardingTerminal's effect deps include `args`, and a
  // fresh array literal each render would tear down + respawn the PTY in a
  // loop. (Auth flow does the same with `authTerminalConfig.args`.)
  const [installTerminalConfig, setInstallTerminalConfig] = useState<{
    projectPath: string;
    packageManager: string;
    cwd: string;
    args: string[];
  } | null>(null);
  const [installTerminalExited, setInstallTerminalExited] = useState(false);

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState('/');

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);
  // Force publish dropdown to open (triggered by Save button in BranchIndicator) - trigger mode
  const [forcePublishOpen, setForcePublishOpen] = useState(false);
  // Compact publish dropdown state - controlled mode for toggle behavior via the compact Publish button

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

  /** Returns true when the gate paused the open (workspace picker shown). */
  const runMonorepoGate = async (project: Project): Promise<boolean> => {
    let existingSubpath: string | null;
    try {
      existingSubpath = await getWorkspaceSubpath(project.path);
    } catch (err) {
      // A real backend failure here (command missing, validation, etc.) — fall
      // through to open as-is rather than blocking the user, but emit telemetry
      // and a log so we notice. Don't toast: this is internal.
      trackError('workspace_gate_subpath_check', err, 'Dashboard');
      logger.error('[OpenProject] getWorkspaceSubpath failed; opening as-is', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (existingSubpath !== null) return false; // already configured

    let workspaces: WorkspaceInfo[];
    try {
      workspaces = await detectWorkspaces(project.path);
    } catch (err) {
      trackError('workspace_gate_detect', err, 'Dashboard');
      logger.error('[OpenProject] detectWorkspaces failed; opening as-is', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (workspaces.length === 0) return false; // single-package project

    const firstWeb = workspaces.find((w) => w.isWeb) ?? workspaces[0];
    setPendingMonorepoPick({
      project,
      workspaces,
      selectedPick: { kind: 'app', relativePath: firstWeb.relativePath },
    });
    return true;
  };

  const handleSelectProject = async (
    project: Project,
    opts: { skipWorkspaceGate?: boolean } = {}
  ) => {
    const windowLabel = getWindowLabel();
    const totalStart = performance.now();
    let stepStart = performance.now();

    // Pre-flight monorepo gate: runs BEFORE we claim a navigation slot so
    // pausing for the picker doesn't bump the version counter or set the
    // "opening" ref — both would make a concurrent open look superseded
    // when nothing actually opened. `skipWorkspaceGate` lets re-entry from
    // the picker confirm skip the gate without recursion.
    if (!opts.skipWorkspaceGate) {
      const paused = await runMonorepoGate(project);
      if (paused) return;
    }

    // Claim a new navigation version — any prior handleSelectProject or handleBackToProjects
    // that captured an older version will know it's been superseded.
    const navVersion = ++navigationVersionRef.current;

    logger.info(`[OpenProject] Starting: ${project.name}`, { windowLabel });

    // Guard against concurrent opens for the same project (race condition
    // prevention). Must run before any tracking — otherwise a double-click
    // emits project_opened twice.
    if (openingProjectPathRef.current === project.path) {
      logger.info(`[OpenProject] Already opening ${project.name}, skipping duplicate call`);
      return;
    }
    openingProjectPathRef.current = project.path;

    // Set the active project so every subsequent event in this session
    // auto-tags project context. The hash is sync (FNV-1a) so this never
    // blocks the render path. We intentionally do NOT emit the raw
    // project_path — it leaks user filesystem layout to PostHog.
    setActiveProject({ id: getProjectId(project.path), name: project.name });

    // End any prior project session before starting a new one. Switching A→B
    // should record A's session before opening B.
    const priorSession = endProjectSession();
    if (priorSession) {
      void trackEvent('project_session_ended', {
        project_session_id: priorSession.session_id,
        duration_seconds: priorSession.duration_seconds,
        reason: 'project_switched',
      });
    }
    startProjectSession();

    void trackEvent('project_opened', { $screen_name: 'Workspace' });
    void trackEvent('project_session_started', { $screen_name: 'Workspace' });
    // The initial Workspace pageview is fired by useWorkspaceLayout's
    // workspaceTab effect once the resolved tab is known.

    // Every active session is hot: once a project has a dev server, it
    // stays alive until the user explicitly closes it via the sidebar (or
    // quits the app). Pinning is orthogonal — it persists the project in
    // the sidebar across launches, nothing more.
    const outgoingProjectPath = currentProject?.path ?? null;
    const incomingAlreadyRunning = isServerRunning(project.path);
    const reuseIncomingServer = incomingAlreadyRunning;

    // Save the OUTGOING project's terminal state before we clobber it. This
    // is what lets switching A → B → A restore A's tab layout and resume
    // its agents via their persisted session IDs. Fire-and-forget; the
    // write is idempotent and a late failure just means next visit starts
    // with a cold tab list (safe fallback).
    if (currentProject && currentProject.path !== project.path && terminalTabs.length > 0) {
      const outgoingPath = currentProject.path;
      const outgoingTabs = terminalTabs;
      const outgoingActiveIdx = Math.max(
        0,
        outgoingTabs.findIndex((t) => t.id === activeTerminalTab)
      );
      const outgoingCustomTitles = sessionRegistry.getCustomTitles(outgoingPath);
      invoke('set_terminal_state', {
        projectPath: outgoingPath,
        state: {
          tabs: outgoingTabs.map((t) => ({
            agent_id: t.agentId,
            session_id: t.sessionId,
            custom_title: outgoingCustomTitles.get(t.id),
          })),
          active_tab_index: outgoingActiveIdx,
        },
      }).catch((err) => {
        logger.warn('[OpenProject] Failed to save outgoing terminal state', {
          project: outgoingPath,
          error: String(err),
        });
      });
    }

    // Fetch auto-accept BEFORE the workspace renders. The Terminal
    // reads `autoAcceptMode` at spawn time to decide whether to pass
    // `--dangerously-skip-permissions`; if we let the workspace render
    // first and fetch after, the resumed PTY launches with the previous
    // state (typically `false`) and never gets the flag, even though
    // the toolbar toggle shows it as on. ~3ms disk read.
    try {
      setAutoAcceptMode(await getAutoAcceptMode(project.path));
    } catch {
      setAutoAcceptMode(false);
    }

    // ─── IMMEDIATE: Show workspace right away ───
    // We always land in the workspace view so WorkspaceView stays mounted
    // continuously — unmounting it would take every Terminal child (and
    // their PTYs) down with it, killing background sessions. Dev servers
    // for fresh projects spin up asynchronously in the background while
    // the workspace is already visible.
    setCurrentProject(project);
    setCurrentPreviewPage('/');
    currentProjectPathRef.current = project.path;
    clearScreenshotInterval();
    setIsPublishing(false);
    setView('workspace');

    // Restore terminal tabs only on the FIRST open of a project this
    // session. If the project already has in-memory state (hot multi-
    // tasking session), restoreTerminalTabs is a no-op and we just
    // reveal the existing tabs. Fresh opens seed a default tab list.
    invoke<{
      tabs: Array<{ agent_id: string; session_id: string; custom_title?: string | null }>;
      active_tab_index: number;
    } | null>('get_terminal_state', { projectPath: project.path })
      .then((savedState) => {
        if (savedState && savedState.tabs.length > 0) {
          // Always use the current global default agent for restored tabs.
          // "Default agent" applies to every new terminal — including the first
          // tab when a project reopens — so saved per-project agent IDs are
          // ignored in favour of the user's latest preference.
          const currentDefault = getDefaultAgentId();
          logger.info('[OpenProject] Restoring saved terminal tabs', {
            tabCount: savedState.tabs.length,
            activeIndex: savedState.active_tab_index,
            defaultAgent: currentDefault,
          });
          restoreTerminalTabs(
            project.path,
            savedState.tabs.map((t) => ({
              agentId: currentDefault,
              sessionId: t.session_id,
            })),
            savedState.active_tab_index
          );
          // Pre-seed the registry with the saved custom titles. We call
          // `setTerminalTabs` directly (rather than the per-tab title
          // setter, which is a no-op against an empty session) so that
          // when App.tsx's `allSessions` effect fires next render and
          // calls `setTerminalTabs` again with a customTitle-less payload,
          // its merge logic preserves customTitle from this prev snapshot.
          // Hook ids are `i + 1` per `restoreTerminalTabs` semantics.
          sessionRegistry.setTerminalTabs(
            project.path,
            savedState.tabs.map((t, i) => ({
              id: i + 1,
              agentId: currentDefault,
              sessionId: t.session_id,
              customTitle: t.custom_title || undefined,
            })),
            savedState.active_tab_index
          );
        } else {
          ensureProjectSeeded(project.path);
        }
      })
      .catch(() => {
        ensureProjectSeeded(project.path);
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

    // Register the project session — both backend (authority) and frontend
    // (mirror for UI subscriptions). The backend invariant guard rejects if
    // the same project is already owned by another window. Same-window
    // re-registration is idempotent (just bumps last_activity_at).
    //
    // Note (Phase 2b): this runs on every project open today. In Phase 4,
    // when the rail allows in-place project switching, we'll only register
    // when actually creating a new session (not when activating an existing
    // pinned one).
    try {
      await registerProjectSession(project.path, windowLabel);
      sessionRegistry.getOrCreate(project.path);
      // Slice 4 — every active session stays hot (dev server + PTYs all
      // running) until the user explicitly closes. Just resume the one
      // we're switching to; other sessions keep their 'active' status
      // because their processes are still alive in the background.
      sessionRegistry.resume(project.path);
    } catch (e) {
      // Backend may reject with Validation if another window owns this
      // session — in current code paths this shouldn't happen since
      // duplicate-window detection already ran above and would have
      // focused the existing window. Logged for diagnostics.
      logger.warn('[OpenProject] Failed to register project session', { error: e });
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

    // We never stop the outgoing project's dev server on switch — that's
    // the hot-session contract. Only an explicit close button / app quit
    // tears a session down.
    logger.info(
      `[OpenProject] Step 1: Outgoing session preserved (${outgoingProjectPath ?? 'none'}) - ${Math.round(performance.now() - stepStart)}ms`
    );

    // Kill any process on the incoming project's reserved port ONLY when
    // we don't already have a live server on it — otherwise we'd shoot our
    // own foot. Note: other active sessions keep their ports (Slice 1's
    // per-(window, project) reservation makes this safe).
    stepStart = performance.now();
    if (!reuseIncomingServer) {
      const actualReservedPort = await invoke<number | null>('get_reserved_port_for_window', {
        windowLabel,
        projectPath: project.path,
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
    } else {
      logger.info('[OpenProject] Step 2: Reusing live server — skipping port kill');
    }

    // NOTE: we intentionally no longer call `kill_window_pty` or
    // `cleanup_orphaned_processes` on switch. Those kill *every* PTY in
    // the window, which would tear down sibling hot projects' dev servers.
    // PTYs get reaped per-project by `stopServer(path)` on explicit close,
    // and by `stopAllServers()` on window unload.

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

    // Find and reserve an available port for THIS project in THIS window.
    // Per-(window, project) keying means we don't need to release anything
    // for *other* projects — they keep their ports. find_and_reserve_port
    // is idempotent for the same (window, project) pair.
    stepStart = performance.now();
    let port = preferredPort;
    try {
      port = await findAndReservePort(project.path, preferredPort);
    } catch (error) {
      logger.error('Failed to find and reserve port, using default', { error });
    }
    // Kill any orphaned process on the newly reserved port — but only when
    // we aren't reusing a live server. Otherwise we'd kill the very
    // server we were about to reuse.
    if (!reuseIncomingServer) {
      try {
        await Promise.race([
          invoke('kill_port', { port }),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // Ignore - port may already be free
      }
    }
    logger.info(
      `[OpenProject] Step 4: Reserved port ${port}${reuseIncomingServer ? ' (reuse)' : ' (killed orphans)'} - ${Math.round(performance.now() - stepStart)}ms`
    );
    setDevServerPort(port, project.path);

    // Step 5 (fetch auto-accept) used to live here, but the value was
    // already applied synchronously from `project.auto_accept_mode`
    // before the workspace rendered — see the seed above.

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

    // Detect project type and start appropriate server — unless we're
    // reusing an already-running pinned server, in which case the existing
    // state in useDevServer is authoritative.
    stepStart = performance.now();
    let detectedType: ProjectType = 'unknown';
    if (reuseIncomingServer) {
      logger.info(`[OpenProject] Step 7: Reusing live pinned server for ${project.name}`);
    } else {
      detectedType = await startServerForProject(project.path, project.name, port, windowLabel);
      logger.info(
        `[OpenProject] Step 7: Start dev server - ${Math.round(performance.now() - stepStart)}ms`
      );
    }

    // Final check before committing to workspace view
    if (navigationVersionRef.current !== navVersion) {
      logger.info(`[OpenProject] Aborted (superseded) after step 7: ${project.name}`);
      openingProjectPathRef.current = null;
      return;
    }

    // Generic projects don't have a web preview — default to branches tab.
    // We only force this for fresh starts; when reusing a pinned session we
    // preserve whichever tab the user was on.
    if (!reuseIncomingServer && detectedType === 'generic') {
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

  const handleSelectMonorepoPick = (pick: WorkspacePick) => {
    setPendingMonorepoPick((prev) => (prev ? { ...prev, selectedPick: pick } : prev));
  };

  const handleConfirmMonorepoPick = async () => {
    if (!pendingMonorepoPick) return;
    const { project, selectedPick } = pendingMonorepoPick;
    if (!selectedPick) return;
    // Root pick → empty string so we never re-prompt; app pick → its subpath.
    const subpathToSave = selectedPick.kind === 'root' ? '' : selectedPick.relativePath;
    try {
      await setWorkspaceSubpath(project.path, subpathToSave);
    } catch (err) {
      trackError('monorepo_pick_save', err, 'Dashboard');
      logger.error('[OpenProject] Failed to save workspace subpath', {
        error: err instanceof Error ? err.message : String(err),
      });
      showToast(
        `Couldn't save workspace pick: ${formatCommandError(asCommandError(err))}`,
        'error'
      );
      return; // leave modal open so user can retry / cancel explicitly
    }
    setPendingMonorepoPick(null);
    // Skip the gate on re-entry — subpath is now persisted, but avoiding the
    // extra read also rules out any pathological recursion if the get/set
    // round-trip ever lags.
    void handleSelectProject(project, { skipWorkspaceGate: true });
  };

  const handleRunInstall = (projectPath: string, packageManager: string) => {
    setInstallTerminalConfig({
      projectPath,
      packageManager,
      cwd: projectPath,
      args: ['install'],
    });
    setInstallTerminalExited(false);
    void trackEvent('install_dependencies_started', {
      package_manager: packageManager,
      $screen_name: 'Workspace',
    });
  };

  const handleCloseInstallTerminal = () => {
    setInstallTerminalConfig(null);
    setInstallTerminalExited(false);
  };

  const handleInstallTerminalExit = async (exitCode: number | null) => {
    const cfg = installTerminalConfig;
    if (!cfg) return;
    setInstallTerminalExited(true);
    // null = killed mid-run; treat as failure (don't auto-restart).
    if (exitCode !== 0) {
      void trackEvent('install_dependencies_failed', {
        package_manager: cfg.packageManager,
        exit_code: exitCode ?? -1,
        $screen_name: 'Workspace',
      });
      showToast(
        `Install exited with code ${exitCode ?? 'null'}. Check the terminal for details.`,
        'error'
      );
      return; // keep overlay open so user can read stderr + close manually
    }
    void trackEvent('install_dependencies_succeeded', {
      package_manager: cfg.packageManager,
      $screen_name: 'Workspace',
    });
    clearNeedsInstall(cfg.projectPath);
    setInstallTerminalConfig(null);
    setInstallTerminalExited(false);
    showToast('Dependencies installed — starting dev server', 'success');
    // restartDevServer is a no-op when nothing is currently running, but it
    // kicks the full project-type-detect → spawn cycle which is exactly what
    // we want here.
    try {
      await restartDevServer(cfg.projectPath);
    } catch (err) {
      logger.error('[Install] Post-install dev server restart failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCancelMonorepoPick = async () => {
    const pending = pendingMonorepoPick;
    setPendingMonorepoPick(null);
    if (!pending) return;

    // The picker only fires for projects that don't yet have a workspace
    // subpath saved, so cancelling here means the project has never been
    // configured. For external projects, roll back the registration so the
    // user can re-import cleanly — otherwise re-running "Import Local Folder"
    // hits "already registered" and they're stuck.
    try {
      const external = await isProjectExternal(pending.project.path);
      if (external) {
        await unregisterExternalProject(pending.project.path);
        showToast('Import cancelled', 'success');
      }
    } catch (err) {
      logger.warn('[OpenProject] Cancel rollback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      const message = formatCommandError(asCommandError(error));
      logger.error('[ImportLocalFolder] failed', { error: message });
      const friendly = message.includes('already registered')
        ? "This folder is already in Ship Studio. To work on a different workspace from the same folder, clone the repo again via 'Import from GitHub' (each clone is independent), or duplicate the folder on disk first."
        : message;
      showToast(friendly, 'error');
    }
  };

  const handleBackToProjects = () => {
    const leavingProjectPath = currentProject?.path ?? null;

    // Save terminal state in background (non-blocking)
    if (currentProject && terminalTabs.length > 0) {
      const activeIdx = terminalTabs.findIndex((t) => t.id === activeTerminalTab);
      const customTitles = sessionRegistry.getCustomTitles(currentProject.path);
      invoke('set_terminal_state', {
        projectPath: currentProject.path,
        state: {
          tabs: terminalTabs.map((t) => ({
            agent_id: t.agentId,
            session_id: t.sessionId,
            custom_title: customTitles.get(t.id),
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

    // Bump navigation version so any in-flight handleSelectProject chain
    // sees it's been superseded.
    ++navigationVersionRef.current;

    logger.info('[BackToProjects] Leaving session alive', { leavingProjectPath });

    // End the project session. The dev server / PTYs stay alive (see comment
    // below), but for analytics we treat returning to the dashboard as the
    // end of the engaged session.
    const ended = endProjectSession();
    if (ended) {
      void trackEvent('project_session_ended', {
        project_session_id: ended.session_id,
        duration_seconds: ended.duration_seconds,
        reason: 'back_to_projects',
      });
    }
    setActiveProject(null);
    // App.tsx fires the Dashboard pageview when view becomes 'projects'.

    // New model: back-to-projects is a *view switch*, not a teardown. The
    // leaving project's dev server, PTYs, and session registry entry all
    // stay alive so the user can pick up where they left off. The only
    // way to stop a session is the sidebar's close button or app quit.
    setCurrentProject(null);
    clearProjectStatuses();
    setView('projects');
    openingProjectPathRef.current = null;
    currentProjectPathRef.current = null;

    // Reset window title now that no project is focused.
    void setWindowTitle('Ship Studio').catch(console.error);

    // The leaving project's session stays 'active' in the registry —
    // its processes keep running, sidebar dot stays green. No suspend.

    // Clear per-project UI state (screenshots, publishing, auto-accept,
    // branch panel, layout) so returning home doesn't surface stale bits.
    // Crucially we do NOT call resetTerminals — the terminal tabs stay
    // attached to the session and are restored on re-entry.
    clearScreenshotInterval();
    setIsPublishing(false);
    setAutoAcceptMode(false);
    clearBranchState();
    resetLayout();
    setCleanupStatus(null);

    logger.info('[BackToProjects] Done');
  };

  const handleRestartDevServer = async () => {
    if (!currentProject) return;
    await restartDevServer(currentProject.path);
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
    // Handlers
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
  };
}
