/**
 * useProjectRemovalActions — single-project delete / remove-from-app flows for
 * the dashboard: confirm-modal targets, in-flight flags, and the handlers that
 * run once the user confirms. The bulk equivalents live in
 * useProjectBulkActions; both isolate post-action unpin failures the same way.
 */

import { useState } from 'react';
import type { DashboardProject } from '../lib/project';
import { deleteProject, removeProjectFromApp } from '../lib/project';
import { asCommandError, formatCommandError } from '../lib/errors';
import { logger } from '../lib/logger';
import { trackError, trackEvent } from '../lib/analytics';

interface UseProjectRemovalActionsParams {
  pinnedSet?: ReadonlySet<string>;
  onTogglePin?: (projectPath: string, pinned: boolean) => void | Promise<void>;
  loadAll: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Drop the project from the list-view bulk selection after it's gone. */
  removeProjectFromSelection: (projectPath: string) => void;
}

/**
 * Manages the dashboard's single-project delete and non-destructive removal.
 * @param params - Pin state and dashboard refresh/notification callbacks.
 * @returns Confirm-modal state and confirmed-action handlers.
 */
export function useProjectRemovalActions({
  pinnedSet,
  onTogglePin,
  loadAll,
  showToast,
  removeProjectFromSelection,
}: UseProjectRemovalActionsParams) {
  const [deleteConfirm, setDeleteConfirm] = useState<DashboardProject | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<DashboardProject | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Post-action unpin failures must not mask the successful delete/removal —
  // the primary action already happened, so log and fall through to the
  // normal cleanup + reload. Mirrors the bulk handler's isolation.
  const unpinAfter = async (project: DashboardProject, action: 'delete' | 'remove') => {
    if (!pinnedSet?.has(project.path)) return;
    try {
      await onTogglePin?.(project.path, false);
    } catch (unpinError) {
      trackError(`project_unpin_after_${action}`, unpinError, 'Dashboard');
      logger.error(`Failed to unpin project after ${action}`, {
        error: formatCommandError(asCommandError(unpinError)),
      });
    }
  };

  const handleDelete = async (project: DashboardProject) => {
    setDeleting(true);
    try {
      await deleteProject(project.path);
      await unpinAfter(project, 'delete');
      void trackEvent('project_deleted', { count: 1, $screen_name: 'Dashboard' });
      setDeleteConfirm(null);
      removeProjectFromSelection(project.path);
      await loadAll();
    } catch (error) {
      trackError('project_delete', error, 'Dashboard');
      // CommandError rejections are plain tagged objects, not Error instances —
      // String(error) renders them as "[object Object]" (issue #633). Format
      // them the same way the user-facing alert below already does.
      logger.error('Failed to delete project', {
        error: formatCommandError(asCommandError(error)),
      });
      alert('Failed to delete project: ' + formatCommandError(asCommandError(error)));
    } finally {
      setDeleting(false);
    }
  };

  const handleRemoveFromApp = async (project: DashboardProject) => {
    setRemoving(true);
    try {
      await removeProjectFromApp(project.path);
      await unpinAfter(project, 'remove');
      void trackEvent('project_removed_from_app', {
        count: 1,
        is_external: project.is_external,
        $screen_name: 'Dashboard',
      });
      setRemoveConfirm(null);
      removeProjectFromSelection(project.path);
      await loadAll();
      showToast(`${project.name} was removed from Ship Studio`, 'success');
    } catch (error) {
      trackError('project_remove_from_app', error, 'Dashboard');
      logger.error('Failed to remove project from Ship Studio', {
        error: formatCommandError(asCommandError(error)),
      });
      showToast(`Failed to remove project: ${formatCommandError(asCommandError(error))}`, 'error');
    } finally {
      setRemoving(false);
    }
  };

  return {
    deleteConfirm,
    setDeleteConfirm,
    removeConfirm,
    setRemoveConfirm,
    deleting,
    removing,
    handleDelete,
    handleRemoveFromApp,
  };
}
