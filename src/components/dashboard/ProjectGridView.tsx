/**
 * ProjectGridView — renders the grid of folders + project cards, or the
 * empty-state when nothing matches. Extracted from ProjectList.
 *
 * @module components/ProjectGridView
 */

import { FolderCard } from './FolderCard';
import { ProjectCard } from './ProjectCard';
import { EmptyState } from '../primitives/EmptyState';
import { Button } from '../primitives/Button';
import type { DashboardProject } from '../../lib/project';
import type { FolderInfo } from '../../lib/folders';

interface ProjectWithThumbnail extends DashboardProject {
  thumbnailData: string | null;
}

export interface ProjectGridViewProps {
  currentFolderId: string | null;
  searchQuery: string;
  totalCount: number;
  filteredFolders: FolderInfo[];
  filteredProjects: ProjectWithThumbnail[];

  onSelectProject: (project: ProjectWithThumbnail) => void;
  onDeleteProject: (project: DashboardProject) => void;
  onRenameProject: (project: DashboardProject) => void;
  onToggleMainBranchWarning: (projectPath: string, hidden: boolean) => void;
  onOpenMoveModal: (project: DashboardProject) => void;
  onOpenMoveWorkspaceModal: (project: DashboardProject) => void;
  onExportAsTemplate: (projectPath: string) => void;
  onUploadThumbnail: (project: DashboardProject) => void;
  onRemoveExternal: (project: DashboardProject) => void;

  onOpenFolder: (folderId: string) => void;
  onRenameFolder: (folder: FolderInfo) => void;
  onDeleteFolder: (folder: FolderInfo) => void;

  /** Set of currently pinned project paths (for menu state). */
  pinnedSet?: ReadonlySet<string>;
  /** Toggle pin state for a project. */
  onTogglePin?: (projectPath: string, pinned: boolean) => void;
  /** Start the create-project flow (drives the zero-projects empty-state CTA). */
  onCreateProject?: () => void;
}

export function ProjectGridView({
  currentFolderId,
  searchQuery,
  totalCount,
  filteredFolders,
  filteredProjects,
  onSelectProject,
  onDeleteProject,
  onRenameProject,
  onToggleMainBranchWarning,
  onOpenMoveModal,
  onOpenMoveWorkspaceModal,
  onExportAsTemplate,
  onUploadThumbnail,
  onRemoveExternal,
  onOpenFolder,
  onRenameFolder,
  onDeleteFolder,
  pinnedSet,
  onTogglePin,
  onCreateProject,
}: ProjectGridViewProps) {
  if (totalCount === 0) {
    return (
      <div className="project-list-empty">
        {searchQuery ? (
          <EmptyState title="No items found" description="Try a different search term" />
        ) : currentFolderId ? (
          <EmptyState
            title="This folder is empty"
            description="Move projects here or create a new project"
          />
        ) : (
          <EmptyState
            title="No projects yet"
            description="You don't need a repo or any code to start — pick a template and your AI agent builds it."
            action={
              onCreateProject ? (
                <Button variant="primary" onClick={onCreateProject}>
                  + Create your first project
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="project-grid">
      {/* Render folders first (only at root level) */}
      {!currentFolderId &&
        filteredFolders.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            onOpen={() => onOpenFolder(folder.id)}
            onRename={() => onRenameFolder(folder)}
            onDelete={() => onDeleteFolder(folder)}
          />
        ))}
      {/* Render projects */}
      {filteredProjects.map((project) => (
        <ProjectCard
          key={project.path}
          project={project}
          thumbnailData={project.thumbnailData}
          onSelect={() => onSelectProject(project)}
          onDelete={() => onDeleteProject(project)}
          onToggleMainBranchWarning={(hidden) => onToggleMainBranchWarning(project.path, hidden)}
          onRename={project.is_external ? undefined : () => onRenameProject(project)}
          onMoveToFolder={() => onOpenMoveModal(project)}
          onMoveToWorkspace={() => onOpenMoveWorkspaceModal(project)}
          onExportAsTemplate={() => onExportAsTemplate(project.path)}
          onUploadThumbnail={() => onUploadThumbnail(project)}
          isExternal={project.is_external}
          onRemove={project.is_external ? () => onRemoveExternal(project) : undefined}
          isPinned={pinnedSet?.has(project.path) ?? false}
          onTogglePin={onTogglePin ? (pinned) => onTogglePin(project.path, pinned) : undefined}
        />
      ))}
    </div>
  );
}
