/**
 * Hook that wires the pinned-projects rail into App-level state.
 *
 * Composes `usePinnedProjects` (joined pins + session registry view) with
 * the project-open flow and toast surface so callers at the App level
 * only see a single return value rather than five useCallbacks and a
 * useEffect. Extracted from App.tsx to keep that file under the LOC
 * ceiling — the rail is self-contained enough that lifting it into its
 * own hook doesn't fragment anything.
 *
 * @module hooks/useProjectRail
 */

import { useCallback } from 'react';
import type { Project } from '../lib/project';
import { usePinnedProjects, type UsePinnedProjectsReturn } from './usePinnedProjects';
import { logger } from '../lib/logger';

export interface UseProjectRailParams {
  /** Path of the project the workspace is currently showing, or `null`. */
  currentProjectPath: string | null;
  /** The App's project-open handler — routed to when a rail pin is clicked. */
  handleSelectProject: (project: Project) => void | Promise<void>;
  /** Toast surface for pin/unpin failure notifications. */
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export interface UseProjectRailReturn {
  /** Full pinned-projects state — rows, isLoading, pin/unpin/reorder, etc. */
  pinnedProjects: UsePinnedProjectsReturn;
  /** Pin or unpin a project, surfacing errors via toast. */
  handleTogglePin: (projectPath: string, shouldPin: boolean) => Promise<void>;
  /** Open a pinned project when its rail icon is clicked. */
  handleRailClick: (projectPath: string) => void;
  /** Unpin a project from the rail's context menu. */
  handleRailUnpin: (projectPath: string) => void;
  /** Pin a project from the picker and open it. */
  handleAddProject: (projectPath: string) => void;
}

export function useProjectRail({
  currentProjectPath,
  handleSelectProject,
  showToast,
}: UseProjectRailParams): UseProjectRailReturn {
  const pinnedProjects = usePinnedProjects(currentProjectPath);

  const handleTogglePin = useCallback(
    async (projectPath: string, shouldPin: boolean) => {
      try {
        if (shouldPin) {
          await pinnedProjects.pin(projectPath);
        } else {
          await pinnedProjects.unpin(projectPath);
        }
      } catch (e) {
        showToast(shouldPin ? 'Failed to pin project' : 'Failed to unpin project', 'error');
        logger.error('[useProjectRail] Pin toggle failed', {
          error: String(e),
          projectPath,
          shouldPin,
        });
      }
    },
    [pinnedProjects, showToast]
  );

  const handleRailClick = useCallback(
    (projectPath: string) => {
      // Clicking a pin cold-starts the project today (it's a launcher,
      // not background sessions). Phase 2d–2f will swap this for
      // in-place activation when the session is already alive.
      const projectName = projectPath.split('/').pop() ?? 'project';
      void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
    },
    [handleSelectProject]
  );

  const handleRailUnpin = useCallback(
    (projectPath: string) => {
      void handleTogglePin(projectPath, false);
    },
    [handleTogglePin]
  );

  const handleAddProject = useCallback(
    (projectPath: string) => {
      void (async () => {
        await handleTogglePin(projectPath, true);
        const projectName = projectPath.split('/').pop() ?? 'project';
        void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
      })();
    },
    [handleTogglePin, handleSelectProject]
  );

  return { pinnedProjects, handleTogglePin, handleRailClick, handleRailUnpin, handleAddProject };
}
