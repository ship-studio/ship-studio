/**
 * ProjectBulkActionConfirm — confirmation content for selected project actions.
 *
 * @module components/ProjectBulkActionConfirm
 */

import { ProjectActionConfirmModal } from './ProjectActionConfirmModal';
import {
  describeProjectSelection,
  projectCountLabel,
  type BulkProjectActionConfirm,
} from '../../hooks/useProjectBulkActions';
import type { DashboardProject } from '../../lib/project';

interface ProjectBulkActionConfirmProps<T extends DashboardProject> {
  confirm: BulkProjectActionConfirm<T>;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Renders the shared project confirmation modal for bulk remove/delete operations.
 * @param props - Current confirmation request and completion callbacks.
 */
export function ProjectBulkActionConfirm<T extends DashboardProject>({
  confirm,
  loading,
  onCancel,
  onConfirm,
}: ProjectBulkActionConfirmProps<T>) {
  const isDelete = confirm.action === 'delete';
  const countLabel = projectCountLabel(confirm.projects.length);
  const selection = describeProjectSelection(confirm.projects);

  return (
    <ProjectActionConfirmModal
      title={isDelete ? 'Delete Selected Files From Computer?' : 'Remove Selected Projects?'}
      body={
        isDelete ? (
          <>
            Permanently delete <strong>{countLabel}</strong> from this computer?
          </>
        ) : (
          <>
            Remove <strong>{countLabel}</strong> from Ship Studio?
          </>
        )
      }
      hint={
        isDelete
          ? `${selection} will be removed from disk. This cannot be undone.`
          : `${selection} will stay on this computer and can be added again later with Import Project, Local Folder.`
      }
      loading={loading}
      confirmLabel={isDelete ? 'Delete files' : 'Remove from Ship Studio'}
      loadingLabel={isDelete ? 'Deleting...' : 'Removing...'}
      confirmVariant={isDelete ? 'danger' : 'primary'}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
