/**
 * ProjectGridView — renders the grid of folders + project cards, or the
 * empty-state when nothing matches. Extracted from ProjectList.
 *
 * @module components/ProjectGridView
 */

import { FolderCard } from './FolderCard';
import { ProjectCard } from './ProjectCard';
import { EmptyState } from './primitives/EmptyState';
import type { DashboardProject } from '../lib/project';
import type { FolderInfo } from '../lib/folders';

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
  onExportAsTemplate,
  onUploadThumbnail,
  onRemoveExternal,
  onOpenFolder,
  onRenameFolder,
  onDeleteFolder,
  pinnedSet,
  onTogglePin,
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
            description="Create your first project to get started"
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
