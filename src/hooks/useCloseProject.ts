/**
 * The one path (besides app quit) that actually reaps a hot project session:
 * the sidebar's per-row close button, on every surface that renders it —
 * the dashboard sidebar, the collapsed rail, and the workspace sidebar.
 *
 * Ordering matters more than it looks. Everything the UI derives a row from
 * is torn down **synchronously**, before any await:
 *
 * - the frontend `sessionRegistry` (source of truth for the "Active" group),
 * - the project's terminal state (source of the `allSessions` mirror that
 *   would otherwise re-create the registry entry on its next sync),
 * - the window's auto-open sentinel,
 * - and, when the project being closed is the open one, the current-project
 *   state itself.
 *
 * Doing that work after `await stopServer(...)` — as this used to — makes a
 * user-visible close hostage to a backend call. Worse, leaving the auto-open
 * sentinel behind meant `useAppSetup`'s HMR-recovery effect fired on the very
 * view change this handler performs, still found a live port reservation for
 * the project, and re-opened the workspace that was just closed. The row came
 * back and the close read as a flicker.
 *
 * @module hooks/useCloseProject
 */

import { useCallback, type MutableRefObject } from 'react';
import type { Project } from '../lib/project';
import type { AppView } from '../lib/types';
import { sessionRegistry } from '../lib/sessionRegistry';
import { closeProjectSession } from '../lib/projectSessions';
import {
  clearStoredAutoOpenProject,
  markAutoOpenDismissed,
  releaseReservedPort,
} from '../lib/window';
import { trackEvent, setActiveProject } from '../lib/analytics';
import { endProjectSession } from '../lib/session';
import { asCommandError, formatCommandError } from '../lib/errors';
import { logger } from '../lib/logger';

export interface UseCloseProjectParams {
  /** Path of the project currently open in this window, or null on home. */
  currentProjectPath: string | null;
  /** Kept in sync with `currentProjectPath` for non-render consumers. */
  currentProjectPathRef: MutableRefObject<string | null>;
  /** Stop the dev/static server for a specific project. */
  stopServer: (projectPath?: string) => Promise<void>;
  /** Kill the project's terminal PTYs and drop its terminal state. */
  closeAllTerminalsForProject: (projectPath: string) => void;
  setCurrentProject: (project: Project | null) => void;
  setView: (view: AppView) => void;
}

/**
 * Returns the close handler wired to the sidebar's per-row close button.
 * Closing the currently open project also ends its session and routes home
 * (matching the pre-redesign behaviour); closing a background project leaves
 * the user exactly where they are.
 */
export function useCloseProject({
  currentProjectPath,
  currentProjectPathRef,
  stopServer,
  closeAllTerminalsForProject,
  setCurrentProject,
  setView,
}: UseCloseProjectParams): (projectPath: string) => void {
  return useCallback(
    (projectPath: string) => {
      const wasCurrent = currentProjectPath === projectPath;
      logger.info('[CloseProject] Closing', { projectPath, wasCurrent });

      // ─── SYNCHRONOUS: everything the UI's source of truth depends on ───
      closeAllTerminalsForProject(projectPath);
      sessionRegistry.destroy(projectPath);
      clearStoredAutoOpenProject(projectPath);
      if (wasCurrent) {
        // The sidebar synthesizes a row for `currentProjectPath` whenever the
        // registry has no entry for it (covering the initial-open gap), so
        // leaving the workspace in this same tick is what actually retires
        // the closed project's row.
        markAutoOpenDismissed();
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
        // App's view-change effect fires the Dashboard pageview.
      }

      // ─── ASYNC: stop the processes the session owned ───
      void (async () => {
        try {
          await stopServer(projectPath);
        } catch (err) {
          logger.warn('[CloseProject] stopServer threw', {
            error: formatCommandError(asCommandError(err)),
          });
        }
        try {
          // Kills any PTY the ref-based teardown above couldn't reach (a
          // background project renders no Terminal components), then drops
          // the backend session entry.
          await closeProjectSession(projectPath);
        } catch (err) {
          logger.warn('[CloseProject] closeProjectSession failed', {
            error: formatCommandError(asCommandError(err)),
          });
        }
        try {
          // Give the port back. Besides being correct once the dev server is
          // gone, a lingering reservation is exactly what HMR recovery reads
          // as "this project is still open in this window".
          await releaseReservedPort(projectPath);
        } catch (err) {
          logger.warn('[CloseProject] releaseReservedPort failed', {
            error: formatCommandError(asCommandError(err)),
          });
        }
      })();
    },
    [
      currentProjectPath,
      currentProjectPathRef,
      stopServer,
      closeAllTerminalsForProject,
      setCurrentProject,
      setView,
    ]
  );
}
