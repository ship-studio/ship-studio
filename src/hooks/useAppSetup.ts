/**
 * Hook for application setup, onboarding, and initialization effects.
 *
 * Manages: setup/onboarding checks, HMR recovery, auto-open project,
 * keyboard shortcuts (help modal), and background setup verification.
 *
 * @module hooks/useAppSetup
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Project } from '../lib/project';
import type { ProjectGitHubStatus } from '../lib/github';
import { getProjectGitHubStatus } from '../lib/github';
import { GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';
import {
  getFullSetupStatus,
  quickSetupCheck,
  markSetupComplete,
  getDefaultAgentId as fetchDefaultAgentId,
} from '../lib/setup';
import { initDefaultAgent } from '../lib/agent';
import { getWindowLabel } from '../lib/window';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { withTimeout } from '../lib/withTimeout';
import type { AppView } from '../lib/types';

/**
 * Boot gates must never hang: each startup await below is capped so a stuck
 * Tauri invoke (e.g. a CLI probe wedged on a broken PATH or network mount)
 * becomes a rejection that routes to onboarding instead of an eternal
 * spinner (#173). Timeouts are generous — these normally settle in <1s.
 */
const BOOT_GATE_TIMEOUT_MS = 15_000;
/** CLI status refresh spawns gh/agent subprocesses — give it a bit longer. */
const CLI_REFRESH_TIMEOUT_MS = 20_000;

export interface UseAppSetupParams {
  view: AppView;
  setView: (view: AppView | ((prev: AppView) => AppView)) => void;
  initialProjectPath?: string | null;
  setCurrentProject: (project: Project | null) => void;
  setDevServerPort: (port: number, projectPath?: string) => void;
  handleSelectProject: (project: Project) => Promise<void>;
  refreshAllCliStatuses: () => Promise<void>;
  setProjectGitHubStatus: (status: ProjectGitHubStatus | null) => void;
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  openHelpModal: () => void;
}

export function useAppSetup({
  view,
  setView,
  initialProjectPath,
  setCurrentProject,
  setDevServerPort,
  handleSelectProject,
  refreshAllCliStatuses,
  setProjectGitHubStatus,
  fetchBranchInfo,
  openHelpModal,
}: UseAppSetupParams) {
  // Track if auto-open has been attempted this session (protects against StrictMode double-invoke)
  const autoOpenAttemptedRef = useRef(false);

  const [projectsLoading, setProjectsLoading] = useState(true);

  // Background verification for optimistic loading
  const verifySetupInBackground = async () => {
    try {
      // Full verification of auth status
      await refreshAllCliStatuses();

      // Check if any auth is now missing
      const setupStatus = await getFullSetupStatus();
      if (!setupStatus.allReady) {
        // Something is no longer configured - redirect to onboarding
        const missingItems = setupStatus.items
          .filter((i) => i.status !== 'ready')
          .map((i) => i.friendlyName);
        logger.warn('Background verification found missing setup items', { missingItems });
        // Redirect to onboarding to fix the issues
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Background setup verification failed', { error });
    }
  };

  const checkSetup = useCallback(async (forceFullCheck = false) => {
    setView('loading');
    try {
      // Hydrate default agent cache from backend
      const defaultAgent = await withTimeout(
        fetchDefaultAgentId(),
        BOOT_GATE_TIMEOUT_MS,
        'Default agent lookup'
      );
      initDefaultAgent(defaultAgent);

      // Always boot straight into the projects view — and, because the active
      // account is persisted, into the user's last-used workspace. The picker
      // is never forced at startup; it's reachable on demand via "Switch
      // Workspace". This keeps launch identical to the pre-Workspaces flow for
      // the ~80% of users who only ever have the Default workspace, and gives
      // multi-workspace users Slack-style "open where you left off" behavior.
      const postSetupView: AppView = 'projects';

      // Fast path: if setup was previously completed, try quick check first
      if (!forceFullCheck) {
        const quickCheck = await withTimeout(
          quickSetupCheck(),
          BOOT_GATE_TIMEOUT_MS,
          'Quick setup check'
        );
        if (quickCheck.setupCompleteCached && quickCheck.allPresent) {
          // Setup was completed before and all binaries still exist
          // Show projects/account picker immediately, verify auth in background
          // Use functional update to avoid overwriting HMR recovery's 'workspace' view
          setView((currentView) =>
            currentView === 'loading' || currentView === 'onboarding' ? postSetupView : currentView
          );
          void verifySetupInBackground();
          return;
        }
      }

      // Slow path: full setup check (first launch or something missing)
      const setupStatus = await withTimeout(
        getFullSetupStatus(),
        BOOT_GATE_TIMEOUT_MS,
        'Full setup status'
      );

      // Check and set all CLI states atomically
      await withTimeout(refreshAllCliStatuses(), CLI_REFRESH_TIMEOUT_MS, 'CLI status refresh');

      // Use full setup status to determine if onboarding is needed
      if (setupStatus.allReady) {
        // Persist setup complete for existing users upgrading to this version
        // (they already completed onboarding but don't have the cached state yet)
        void markSetupComplete();
        // Use functional update to avoid overwriting HMR recovery's 'workspace' view
        setView((currentView) =>
          currentView === 'loading' || currentView === 'onboarding' ? postSetupView : currentView
        );
      } else {
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Failed to check prerequisites', { error });
      setView('onboarding');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; refreshAllCliStatuses and verifySetupInBackground are stable
  }, []);

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  // HMR Recovery for ALL windows (main window and project windows)
  // Checks backend port reservation to detect HMR and restore UI state without restarting dev server
  // This runs BEFORE the auto-open effect and handles the "already have a project open" case
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const storedProjectPath = sessionStorage.getItem(storageKey);
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    // Skip if already in workspace view (state already correct)
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Skip if ref says we've already handled this (prevents double-invoke in StrictMode)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Skip if user explicitly went back to projects
    if (dismissedValue === 'true') {
      return;
    }

    // Check backend for existing port reservation (most reliable HMR indicator).
    // Requires a project path to key on — if we don't have one yet, we can't
    // look up a reservation, so skip the HMR recovery path.
    if (!storedProjectPath) {
      return;
    }
    void (async () => {
      try {
        const existingPort = await invoke<number | null>('get_reserved_port_for_window', {
          windowLabel,
          projectPath: storedProjectPath,
        });

        // If we have a reserved port, this is likely an HMR reload
        if (existingPort !== null && storedProjectPath) {
          // Mark as handled to prevent the auto-open effect from also firing
          autoOpenAttemptedRef.current = true;

          logger.info('[HMR Recovery] Port reserved, restoring UI state', {
            windowLabel,
            port: existingPort,
            projectPath: storedProjectPath,
          });

          // Restore UI state without restarting dev server
          const projectName = storedProjectPath.split('/').pop() || 'Project';
          setCurrentProject({
            name: projectName,
            path: storedProjectPath,
            thumbnail: null,
          });
          setDevServerPort(existingPort, storedProjectPath);
          setView('workspace');

          // Refresh branch info and statuses in background
          // Dispatch each independently so fast results aren't blocked by slow ones
          void fetchBranchInfo(storedProjectPath);
          void getProjectGitHubStatus(storedProjectPath)
            .catch(() => GITHUB_STATUS_FALLBACK)
            .then((status) => setProjectGitHubStatus(status));
        }
      } catch {
        // If backend check fails, let normal flow continue
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchBranchInfo is stable, don't re-run on change
  }, [view]);

  // Auto-open project if initialProjectPath is provided (multi-window support)
  // This handles the case where a NEW project window is opened (not HMR recovery)
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    if (!initialProjectPath) {
      return;
    }

    // Skip if HMR recovery already handled this (ref is set by the HMR recovery effect)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Check if user explicitly went back to projects - don't auto-open again
    if (dismissedValue === 'true') {
      return;
    }

    // Skip if already in workspace view
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Only auto-open when we reach projects or loading view
    if (view === 'projects' || view === 'loading') {
      // Mark as attempted BEFORE any async work to prevent races
      autoOpenAttemptedRef.current = true;

      // Store the project path for HMR recovery (before any async work)
      sessionStorage.setItem(storageKey, initialProjectPath);

      const projectName = initialProjectPath.split('/').pop() || 'Project';
      const project: Project = {
        name: projectName,
        path: initialProjectPath,
        thumbnail: null,
      };
      logger.info('[MultiWindow] Auto-opening project from URL param', {
        path: initialProjectPath,
      });
      void handleSelectProject(project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSelectProject is stable, don't re-run on change
  }, [initialProjectPath, view]);

  // Keyboard shortcut for help modal (Cmd+/ or F1)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+/ (Mac) or Ctrl+/ (Windows) or F1
      if (((e.metaKey || e.ctrlKey) && e.key === '/') || e.key === 'F1') {
        e.preventDefault();
        openHelpModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openHelpModal]);

  return {
    projectsLoading,
    setProjectsLoading,
  };
}
