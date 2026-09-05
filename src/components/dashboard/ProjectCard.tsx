/**
 * ProjectCard component that displays a single project in the dashboard grid.
 *
 * Shows project thumbnail (or placeholder), name, git branch, uncommitted changes
 * count, and deployment status. Provides hover actions for opening the live site
 * or launching in an IDE.
 *
 * @module components/ProjectCard
 */

import { memo } from 'react';
import { DashboardProject } from '../../lib/project';
import { BranchIcon } from '@/components/icons';
import { ProjectCardMenu } from './ProjectCardMenu';

/** Props for the ProjectCard component */
interface ProjectCardProps {
  /** Project data including name, path, git info, and deployment URLs */
  project: DashboardProject;
  /** Base64-encoded thumbnail image (or null for placeholder) */
  thumbnailData: string | null;
  /** Callback when the card is clicked to open the project */
  onSelect: () => void;
  /** Callback to open settings for this project */
  onOpenSettings?: () => void;
  /** Callback when deleting project files from disk is clicked */
  onDelete: () => void;
  /** Callback when main branch warning is toggled */
  onToggleMainBranchWarning: (hidden: boolean) => void;
  /** Callback to rename the project (non-external projects only) */
  onRename?: () => void;
  /** Callback to move project to a folder */
  onMoveToFolder?: () => void;
  /** Callback to move project to a different workspace */
  onMoveToWorkspace?: () => void;
  /** Callback to export project as a template zip */
  onExportAsTemplate?: () => void;
  /** Callback to upload a custom thumbnail. Parent owns the file picker. */
  onUploadThumbnail?: () => void;
  /** Whether this is an external project */
  isExternal?: boolean;
  /** Callback when remove from Ship Studio is clicked */
  onRemove?: () => void;
  /** Whether the project is currently pinned to the rail. */
  isPinned?: boolean;
  /** Toggle pin state. Receives the desired new state. */
  onTogglePin?: (pinned: boolean) => void | Promise<void>;
}

export const ProjectCard = memo(function ProjectCard({
  project,
  thumbnailData,
  onSelect,
  onOpenSettings,
  onDelete,
  onToggleMainBranchWarning,
  onRename,
  onMoveToFolder,
  onMoveToWorkspace,
  onExportAsTemplate,
  onUploadThumbnail,
  isExternal,
  onRemove,
  isPinned,
  onTogglePin,
}: ProjectCardProps) {
  const hasChanges = project.uncommitted_count !== null && project.uncommitted_count > 0;
  const hideMainBranchWarning = project.hide_main_branch_warning === true;

  return (
    <div className="project-card">
      <div
        className="project-card-thumbnail"
        onClick={onSelect}
        role="button"
        tabIndex={0}
        aria-label={`Open ${project.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        {thumbnailData ? (
          <img src={thumbnailData} alt={project.name} />
        ) : (
          <div className="project-card-placeholder">
            <span>No preview</span>
          </div>
        )}
      </div>
      <div className="project-card-info">
        <div className="project-card-details" onClick={onSelect}>
          <div className="project-card-name-row">
            <span className="project-card-name text-style-body-medium">{project.name}</span>
            {project.workspace_subpath && (
              <span
                className="project-card-workspace text-style-body-medium"
                title={project.workspace_subpath}
              >
                · {project.workspace_subpath}
              </span>
            )}
          </div>
          <div className="project-card-meta text-style-body-medium">
            {project.git_branch && (
              <span className="project-card-branch">
                <BranchIcon />
                <span className="project-card-branch-name">{project.git_branch}</span>
              </span>
            )}
            {hasChanges && (
              <span className="project-card-changes">{project.uncommitted_count} uncommitted</span>
            )}
            {project.worktree_count != null && project.worktree_count > 0 && (
              <span className="project-card-worktrees">
                · {project.worktree_count} {project.worktree_count === 1 ? 'worktree' : 'worktrees'}
              </span>
            )}
          </div>
        </div>
        <ProjectCardMenu
          onOpenSettings={onOpenSettings}
          hideMainBranchWarning={hideMainBranchWarning}
          onToggleMainBranchWarning={onToggleMainBranchWarning}
          onRename={onRename}
          onMoveToFolder={onMoveToFolder}
          onMoveToWorkspace={onMoveToWorkspace}
          onExportAsTemplate={onExportAsTemplate}
          onUploadThumbnail={onUploadThumbnail}
          onDelete={onDelete}
          isExternal={isExternal}
          onRemove={onRemove}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
        />
      </div>
    </div>
  );
});
