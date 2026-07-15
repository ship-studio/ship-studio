/**
 * ProjectBulkActionsBar — sticky action surface for selected project rows.
 *
 * @module components/ProjectBulkActionsBar
 */

import { Button } from '../primitives/Button';
import { CloseIcon, TrashIcon } from '../icons';
import { projectCountLabel } from '../../hooks/useProjectBulkActions';

interface ProjectBulkActionsBarProps {
  selectedCount: number;
  selectedIncludesExternalProject: boolean;
  onClear: () => void;
  onRemove: () => void;
  onDelete: () => void;
}

/**
 * Renders bulk remove/delete controls when one or more list-view projects are selected.
 * @param props - Selection state and bulk-action callbacks.
 */
export function ProjectBulkActionsBar({
  selectedCount,
  selectedIncludesExternalProject,
  onClear,
  onRemove,
  onDelete,
}: ProjectBulkActionsBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="project-bulk-actions" role="region" aria-label="Selected project actions">
      <div className="project-bulk-actions-summary">
        <strong>{projectCountLabel(selectedCount)} selected</strong>
        {selectedIncludesExternalProject && (
          <span>External projects can only be removed from Ship Studio.</span>
        )}
      </div>
      <div className="project-bulk-actions-controls">
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
        <Button variant="secondary" size="sm" leftIcon={<CloseIcon size={14} />} onClick={onRemove}>
          Remove
        </Button>
        <Button
          variant="danger"
          size="sm"
          leftIcon={<TrashIcon size={14} />}
          disabled={selectedIncludesExternalProject}
          title={
            selectedIncludesExternalProject
              ? 'External projects can only be removed from Ship Studio'
              : 'Delete selected project folders from this computer'
          }
          onClick={onDelete}
        >
          Delete files
        </Button>
      </div>
    </div>
  );
}
