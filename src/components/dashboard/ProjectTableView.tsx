/**
 * ProjectTableView — dense row view for projects with multi-select support.
 *
 * @module components/ProjectTableView
 */

import { useEffect, useRef } from 'react';
import type { DashboardProject } from '../../lib/project';
import { BranchIcon } from '../icons';
import { ProjectCardMenu } from './ProjectCardMenu';

interface ProjectTableViewProps<TProject extends DashboardProject> {
  projects: TProject[];
  selectedProjectPaths: ReadonlySet<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;

  onSelectAllVisible: (selected: boolean) => void;
  onToggleProjectSelection: (projectPath: string) => void;
  onSelectProject: (project: TProject) => void;
  onDeleteProject: (project: DashboardProject) => void;
  onRenameProject: (project: DashboardProject) => void;
  onToggleMainBranchWarning: (projectPath: string, hidden: boolean) => void;
  onOpenMoveModal: (project: DashboardProject) => void;
  onOpenMoveWorkspaceModal: (project: DashboardProject) => void;
  onExportAsTemplate: (projectPath: string) => void;
  onUploadThumbnail: (project: DashboardProject) => void;
  onRemoveProject: (project: DashboardProject) => void;

  pinnedSet?: ReadonlySet<string>;
  onTogglePin?: (projectPath: string, pinned: boolean) => void | Promise<void>;
}

function formatLastOpened(timestamp: number | null): string {
  if (!timestamp) return 'Never opened';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(new Date(timestamp));
}

function formatChanges(count: number | null): string {
  if (count === null) return 'Unknown';
  if (count === 0) return 'Clean';
  return `${count} uncommitted`;
}

/**
 * Renders projects in list/table form with row selection and existing project actions.
 * @param props - Projects, selection state, and dashboard action callbacks.
 */
export function ProjectTableView<TProject extends DashboardProject>({
  projects,
  selectedProjectPaths,
  allVisibleSelected,
  someVisibleSelected,
  onSelectAllVisible,
  onToggleProjectSelection,
  onSelectProject,
  onDeleteProject,
  onRenameProject,
  onToggleMainBranchWarning,
  onOpenMoveModal,
  onOpenMoveWorkspaceModal,
  onExportAsTemplate,
  onUploadThumbnail,
  onRemoveProject,
  pinnedSet,
  onTogglePin,
}: ProjectTableViewProps<TProject>) {
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [allVisibleSelected, someVisibleSelected]);

  return (
    <div className="project-table" role="table" aria-label="Projects">
      <div className="project-table-row project-table-header" role="row">
        <div className="project-table-select-cell" role="columnheader">
          <label aria-label="Select all visible projects">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={projects.length === 0}
              onChange={(event) => onSelectAllVisible(event.target.checked)}
            />
          </label>
        </div>
        <span className="project-table-heading" role="columnheader">
          Name
        </span>
        <span className="project-table-heading" role="columnheader">
          Branch
        </span>
        <span className="project-table-heading" role="columnheader">
          Changes
        </span>
        <span
          className="project-table-heading project-table-last-opened-heading"
          role="columnheader"
        >
          Last Opened
        </span>
        <span
          className="project-table-heading project-table-actions-heading"
          role="columnheader"
          aria-label="Actions"
        />
      </div>

      {projects.map((project) => {
        const isSelected = selectedProjectPaths.has(project.path);
        const hideMainBranchWarning = project.hide_main_branch_warning === true;

        return (
          <div
            key={project.path}
            className={`project-table-row ${isSelected ? 'is-selected' : ''}`}
            role="row"
          >
            <div className="project-table-select-cell" role="cell">
              <label aria-label={`Select ${project.name}`} title={`Select ${project.name}`}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleProjectSelection(project.path)}
                />
              </label>
            </div>

            <div className="project-table-name-cell" role="cell">
              <button
                type="button"
                className="project-table-open"
                onClick={() => onSelectProject(project)}
                title={`Open ${project.name}`}
              >
                <span className="project-table-name-stack">
                  <span className="project-table-name-line">
                    <span className="project-table-name">{project.name}</span>
                    {project.workspace_subpath && (
                      <span className="project-table-workspace" title={project.workspace_subpath}>
                        {project.workspace_subpath}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </div>

            <span
              className="project-table-branch project-table-branch-cell"
              role="cell"
              title={project.git_branch ?? 'No branch'}
            >
              {project.git_branch ? (
                <>
                  <BranchIcon />
                  <span>{project.git_branch}</span>
                </>
              ) : (
                <span className="project-table-muted">No branch</span>
              )}
            </span>

            <span
              role="cell"
              className={
                project.uncommitted_count && project.uncommitted_count > 0
                  ? 'project-table-changes project-table-changes-cell has-changes'
                  : 'project-table-changes project-table-changes-cell'
              }
            >
              {formatChanges(project.uncommitted_count)}
            </span>

            <span
              role="cell"
              className="project-table-muted project-table-last-opened project-table-last-opened-cell"
            >
              {formatLastOpened(project.last_opened)}
            </span>

            <div className="project-table-actions-cell" role="cell">
              <ProjectCardMenu
                hideMainBranchWarning={hideMainBranchWarning}
                onToggleMainBranchWarning={(hidden) =>
                  onToggleMainBranchWarning(project.path, hidden)
                }
                onRename={project.is_external ? undefined : () => onRenameProject(project)}
                onMoveToFolder={() => onOpenMoveModal(project)}
                onMoveToWorkspace={() => onOpenMoveWorkspaceModal(project)}
                onExportAsTemplate={() => onExportAsTemplate(project.path)}
                onUploadThumbnail={() => onUploadThumbnail(project)}
                onDelete={() => onDeleteProject(project)}
                isExternal={project.is_external}
                onRemove={() => onRemoveProject(project)}
                isPinned={pinnedSet?.has(project.path) ?? false}
                onTogglePin={
                  onTogglePin ? (pinned) => onTogglePin(project.path, pinned) : undefined
                }
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
