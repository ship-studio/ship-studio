import { useCallback, useMemo } from 'react';
import { Project } from '../lib/project';

/**
 * Stable wrappers for the async session-lifecycle handlers that AppContents
 * hands to ProjectsView and the workspace.
 *
 * These exist purely to keep referential identity stable: the underlying
 * handlers are async, and passing a fresh `() => void fn()` arrow on every
 * render busts the memoization on every consumer downstream. Wrapping them in
 * useCallback once, here, is what keeps that from happening.
 *
 * Extracted out of App.tsx under the note left on the LOC guard in
 * scripts/check-loc-limits.sh — "extract the session-lifecycle handlers next
 * rather than raising this again". Nothing about the behaviour changed in the
 * move; this is the same six wrappers with the same dependencies.
 */
interface UseProjectsViewCallbacksParams {
  currentProject: Project | null;
  handleSelectProject: (project: Project) => unknown;
  handleImportLocalFolder: () => unknown;
  setShowCreateModal: (open: boolean) => void;
  handleAuthTerminalExit: (exitCode: number | null, projectPath?: string) => unknown;
  saveCustomDevCommand: (projectPath: string, cmd: string | null) => unknown;
  handleSavePort: (port: number) => unknown;
}

export interface ProjectsViewCallbacks {
  handleSelectProjectCallback: (project: Project) => void;
  handleImportLocalFolderCallback: () => void;
  handleCloseCreateModal: () => void;
  handleAuthTerminalExitForProjects: (exitCode: number | null) => void;
  handleSaveDevCommand: (cmd: string | null) => void;
  handleSavePortCallback: (port: number) => void;
}

export function useProjectsViewCallbacks({
  currentProject,
  handleSelectProject,
  handleImportLocalFolder,
  setShowCreateModal,
  handleAuthTerminalExit,
  saveCustomDevCommand,
  handleSavePort,
}: UseProjectsViewCallbacksParams): ProjectsViewCallbacks {
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

  return useMemo(
    () => ({
      handleSelectProjectCallback,
      handleImportLocalFolderCallback,
      handleCloseCreateModal,
      handleAuthTerminalExitForProjects,
      handleSaveDevCommand,
      handleSavePortCallback,
    }),
    [
      handleSelectProjectCallback,
      handleImportLocalFolderCallback,
      handleCloseCreateModal,
      handleAuthTerminalExitForProjects,
      handleSaveDevCommand,
      handleSavePortCallback,
    ]
  );
}
