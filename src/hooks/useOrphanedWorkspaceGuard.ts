/**
 * Recovery for the one view state with no way out: `view === 'workspace'`
 * with no `currentProject`. `AppViewRouter` renders that as a bare,
 * full-window spinner — no sidebar, no navigation — so a user who reaches it
 * can only restart the app, which takes every running agent session with it.
 *
 * Every legitimate path sets the project and the workspace view together, so
 * this state only arises from a race (an in-flight project open committing the
 * workspace view after the user already went home). The races we know of are
 * guarded at their source in `useProjectLifecycle`; this is the backstop:
 * route home and log it so a new one is still visible.
 *
 * @module hooks/useOrphanedWorkspaceGuard
 */

import { useEffect } from 'react';
import type { AppView } from '../lib/types';
import { logger } from '../lib/logger';

export function useOrphanedWorkspaceGuard(
  view: AppView,
  hasCurrentProject: boolean,
  setView: (view: AppView) => void
): void {
  useEffect(() => {
    if (view === 'workspace' && !hasCurrentProject) {
      logger.error('[ViewGuard] Workspace view with no project; returning to projects');
      setView('projects');
    }
  }, [view, hasCurrentProject, setView]);
}
