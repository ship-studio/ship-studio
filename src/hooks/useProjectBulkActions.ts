import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardProject } from '../lib/project';
import { deleteProject, removeProjectFromApp } from '../lib/project';
import { asCommandError, formatCommandError } from '../lib/errors';
import { logger } from '../lib/logger';
import { trackError, trackEvent } from '../lib/analytics';
import { useAsyncState } from './useAsyncState';

/** Bulk action types available from the dashboard list selection bar. */
export type BulkProjectAction = 'remove' | 'delete';

/** Projects and action currently waiting for bulk confirmation. */
export interface BulkProjectActionConfirm<T extends DashboardProject = DashboardProject> {
  action: BulkProjectAction;
  projects: T[];
}

interface UseProjectBulkActionsParams<T extends DashboardProject> {
  filteredProjects: T[];
  pinnedSet?: ReadonlySet<string>;
  onTogglePin?: (projectPath: string, pinned: boolean) => void | Promise<void>;
  loadAll: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/**
 * Formats a project count with the correct singular/plural label.
 * @param count - Number of projects.
 * @returns Human-readable project count.
 */
export function projectCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/**
 * Builds a compact, human-readable label for a selected project set.
 * @param projects - Selected dashboard projects.
 * @returns Up to three project names with an overflow count.
 */
export function describeProjectSelection(projects: DashboardProject[]): string {
  const names = projects.slice(0, 3).map((project) => project.name);
  const remaining = projects.length - names.length;
  return remaining > 0 ? `${names.join(', ')} and ${remaining} more` : names.join(', ');
}

/**
 * Manages list-view project selection and confirmed bulk remove/delete actions.
 * @param params - Visible projects and dashboard callbacks.
 * @returns Selection state, confirmation state, and bulk-action handlers.
 */
export function useProjectBulkActions<T extends DashboardProject>({
  filteredProjects,
  pinnedSet,
  onTogglePin,
  loadAll,
  showToast,
}: UseProjectBulkActionsParams<T>) {
  const [selectedProjectPaths, setSelectedProjectPaths] = useState<Set<string>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState<BulkProjectActionConfirm<T> | null>(null);

  const visibleProjectPathSet = useMemo(
    () => new Set(filteredProjects.map((project) => project.path)),
    [filteredProjects]
  );

  const visibleSelectedProjectPaths = useMemo(
    () => new Set([...selectedProjectPaths].filter((path) => visibleProjectPathSet.has(path))),
    [selectedProjectPaths, visibleProjectPathSet]
  );

  useEffect(() => {
    const hasHiddenSelection = [...selectedProjectPaths].some(
      (path) => !visibleProjectPathSet.has(path)
    );

    if (!hasHiddenSelection) return;

    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      setSelectedProjectPaths((prev) => {
        let changed = false;
        const next = new Set<string>();

        for (const path of prev) {
          if (visibleProjectPathSet.has(path)) {
            next.add(path);
          } else {
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectPaths, visibleProjectPathSet]);

  const selectedProjects = useMemo(
    () => filteredProjects.filter((project) => visibleSelectedProjectPaths.has(project.path)),
    [filteredProjects, visibleSelectedProjectPaths]
  );

  const selectedCount = selectedProjects.length;
  const selectedIncludesExternalProject = selectedProjects.some((project) => project.is_external);
  const allVisibleSelected =
    filteredProjects.length > 0 &&
    filteredProjects.every((project) => selectedProjectPaths.has(project.path));
  const someVisibleSelected = filteredProjects.some((project) =>
    selectedProjectPaths.has(project.path)
  );

  const handleToggleProjectSelection = useCallback((projectPath: string) => {
    setSelectedProjectPaths((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  }, []);

  const handleSelectAllVisible = useCallback(
    (selected: boolean) => {
      setSelectedProjectPaths((prev) => {
        const next = new Set(prev);
        for (const project of filteredProjects) {
          if (selected) {
            next.add(project.path);
          } else {
            next.delete(project.path);
          }
        }
        return next;
      });
    },
    [filteredProjects]
  );

  const handleClearProjectSelection = useCallback(() => {
    setSelectedProjectPaths(new Set());
  }, []);

  const removeProjectFromSelection = useCallback((projectPath: string) => {
    setSelectedProjectPaths((prev) => {
      if (!prev.has(projectPath)) return prev;
      const next = new Set(prev);
      next.delete(projectPath);
      return next;
    });
  }, []);

  const handleBeginBulkProjectAction = useCallback(
    (action: BulkProjectAction) => {
      if (selectedProjects.length === 0) return;
      if (action === 'delete' && selectedIncludesExternalProject) {
        showToast('External projects can only be removed from Ship Studio.', 'error');
        return;
      }
      setBulkConfirm({ action, projects: selectedProjects });
    },
    [selectedIncludesExternalProject, selectedProjects, showToast]
  );

  const { isLoading: bulkActionLoading, execute: executeBulkProjectAction } = useAsyncState<
    void,
    [BulkProjectActionConfirm<T>]
  >(
    async (confirm: BulkProjectActionConfirm<T>) => {
      if (confirm.projects.length === 0) return;
      if (confirm.action === 'delete' && confirm.projects.some((project) => project.is_external)) {
        showToast('External projects can only be removed from Ship Studio.', 'error');
        return;
      }

      const failures: Array<{ project: DashboardProject; error: unknown }> = [];
      let completed = 0;

      for (const project of confirm.projects) {
        try {
          if (confirm.action === 'delete') {
            await deleteProject(project.path);
          } else {
            await removeProjectFromApp(project.path);
          }

          completed += 1;
        } catch (error) {
          failures.push({ project, error });
          trackError(
            confirm.action === 'delete' ? 'project_bulk_delete' : 'project_bulk_remove_from_app',
            error,
            'Dashboard'
          );
          logger.error('Failed bulk project action', {
            action: confirm.action,
            projectName: project.name,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        if (pinnedSet?.has(project.path) && onTogglePin) {
          try {
            await onTogglePin(project.path, false);
          } catch (error) {
            trackError('project_bulk_unpin_after_action', error, 'Dashboard');
            logger.error('Failed to unpin project after successful bulk action', {
              action: confirm.action,
              projectName: project.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (completed > 0) {
        void trackEvent(
          confirm.action === 'delete' ? 'projects_bulk_deleted' : 'projects_bulk_removed_from_app',
          {
            count: completed,
            $screen_name: 'Dashboard',
          }
        );
      }

      setBulkConfirm(null);
      setSelectedProjectPaths(new Set());
      await loadAll();

      const actionPastTense = confirm.action === 'delete' ? 'Deleted' : 'Removed';
      const actionVerb = confirm.action === 'delete' ? 'delete' : 'remove';

      if (failures.length === 0) {
        showToast(`${actionPastTense} ${projectCountLabel(completed)}`, 'success');
      } else {
        const firstFailure = failures[0];
        const firstFailureMessage = firstFailure
          ? formatCommandError(asCommandError(firstFailure.error))
          : 'Unknown error';
        const successPrefix =
          completed > 0 ? `${actionPastTense} ${projectCountLabel(completed)}. ` : '';
        showToast(
          `${successPrefix}Failed to ${actionVerb} ${projectCountLabel(
            failures.length
          )}: ${firstFailureMessage}`,
          'error'
        );
      }
    },
    { onError: (error) => showToast(formatCommandError(asCommandError(error)), 'error') }
  );

  const handleBulkProjectAction = useCallback(
    async (confirm: BulkProjectActionConfirm<T>) => {
      await executeBulkProjectAction(confirm);
    },
    [executeBulkProjectAction]
  );

  return {
    selectedProjectPaths: visibleSelectedProjectPaths,
    selectedCount,
    selectedIncludesExternalProject,
    allVisibleSelected,
    someVisibleSelected,
    bulkConfirm,
    bulkActionLoading,
    setBulkConfirm,
    handleToggleProjectSelection,
    handleSelectAllVisible,
    handleClearProjectSelection,
    removeProjectFromSelection,
    handleBeginBulkProjectAction,
    handleBulkProjectAction,
  };
}
