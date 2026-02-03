/**
 * ProjectList component that displays the main dashboard with all projects.
 *
 * This is the home screen of the application, showing:
 * - Grid of folders and project cards with thumbnails and metadata
 * - Search filtering with Cmd+K keyboard shortcut
 * - Sorting options (last opened, name, last deployed)
 * - Folder navigation with breadcrumb
 * - Integration status bar (GitHub, Vercel, Claude)
 * - Project and folder creation/deletion
 *
 * @module components/ProjectList
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  DashboardProject,
  getDashboardProjects,
  setAutoAcceptMode,
  setHideMainBranchWarning,
} from '../lib/project';
import { logger } from '../lib/logger';
import {
  FolderInfo,
  Folder,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  getFiledProjectPaths,
  getFolderProjects,
  getFolder,
  moveProjectToFolder,
} from '../lib/folders';
import { DashboardHeader } from './DashboardHeader';
import { ProjectCard } from './ProjectCard';
import { FolderCard } from './FolderCard';
import { IntegrationBar } from './IntegrationBar';
import { NewFolderModal } from './NewFolderModal';
import { MoveFolderModal } from './MoveFolderModal';
import { ChevronIcon, CheckIcon, ArrowLeftIcon } from './icons';
import { useClickOutside } from '../hooks/useClickOutside';

/** Basic project info for selection callback */
interface Project {
  name: string;
  path: string;
  thumbnail: string | null;
}

/** Dashboard project with loaded thumbnail data */
interface ProjectWithThumbnail extends DashboardProject {
  /** Base64-encoded thumbnail image data */
  thumbnailData: string | null;
}

/** Available sort options for the project list */
type SortOption = 'last_opened' | 'name' | 'last_deployed';

/** Props for the ProjectList component */
interface ProjectListProps {
  /** Callback when a project is selected to open */
  onSelectProject: (project: Project) => void;
  /** Callback to open the create project wizard */
  onCreateProject: () => void;
  /** Callback to open the import project wizard */
  onImportProject?: () => void;
  /** Whether GitHub is authenticated (import requires GitHub) */
  isGitHubAuthenticated?: boolean;
  /** Callback when user tries to import without GitHub auth */
  onGitHubConnectForImport?: () => void;
  /** Callback to connect GitHub account */
  onGitHubConnect?: () => void;
  /** Callback to connect Vercel account */
  onVercelConnect?: () => void;
}

export function ProjectList({
  onSelectProject,
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
  onGitHubConnect,
  onVercelConnect,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectWithThumbnail[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [filedPaths, setFiledPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<DashboardProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Folder navigation state
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<Folder | null>(null);
  const [folderProjectPaths, setFolderProjectPaths] = useState<string[]>([]);

  // Folder modal state
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FolderInfo | null>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState<FolderInfo | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);

  // Move to folder modal state
  const [moveProject, setMoveProject] = useState<DashboardProject | null>(null);
  const [moveProjectFolderId, setMoveProjectFolderId] = useState<string | null>(null);

  // Search and sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('last_opened');
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const sortDropdownRef = useRef<HTMLDivElement>(null);

  // Close sort dropdown when clicking outside
  const closeSortDropdown = useCallback(() => setShowSortDropdown(false), []);
  useClickOutside(sortDropdownRef, closeSortDropdown, showSortDropdown);

  const loadProjects = async () => {
    try {
      const projectList = await getDashboardProjects();

      // Load thumbnails for each project
      const projectsWithThumbnails = await Promise.all(
        projectList.map(async (project) => {
          let thumbnailData: string | null = null;
          if (project.thumbnail) {
            try {
              thumbnailData = await invoke<string | null>('get_project_thumbnail', {
                projectPath: project.path,
              });
            } catch (e) {
              console.error('Failed to load thumbnail for', project.name, e);
            }
          }
          return { ...project, thumbnailData };
        })
      );

      setProjects(projectsWithThumbnails);
    } catch (error) {
      console.error('Failed to load projects:', error);
    }
  };

  const loadFolders = async () => {
    try {
      const folderList = await listFolders();
      setFolders(folderList);

      const paths = await getFiledProjectPaths();
      setFiledPaths(new Set(paths));
    } catch (error) {
      console.error('Failed to load folders:', error);
    }
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadProjects(), loadFolders()]);
    setLoading(false);
  }, []);

  // Load folder details when navigating into a folder
  useEffect(() => {
    if (currentFolderId) {
      void getFolder(currentFolderId).then((folder) => {
        setCurrentFolder(folder);
      });
      void getFolderProjects(currentFolderId).then((paths) => {
        setFolderProjectPaths(paths);
      });
    } else {
      setCurrentFolder(null);
      setFolderProjectPaths([]);
    }
  }, [currentFolderId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Get projects to display based on current folder
  const displayedProjects = useMemo(() => {
    if (currentFolderId) {
      // Show only projects in this folder
      return projects.filter((p) => folderProjectPaths.includes(p.path));
    } else {
      // Show only unfiled projects (not in any folder)
      return projects.filter((p) => !filedPaths.has(p.path));
    }
  }, [projects, currentFolderId, folderProjectPaths, filedPaths]);

  // Filtered and sorted projects
  const filteredProjects = useMemo(() => {
    // When searching, search ALL projects (not just displayed ones)
    // This lets users find projects inside folders from the root view
    let result = searchQuery ? [...projects] : [...displayedProjects];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'last_deployed':
          // Projects without deployment go last
          if (!a.last_deployed && !b.last_deployed) return a.name.localeCompare(b.name);
          if (!a.last_deployed) return 1;
          if (!b.last_deployed) return -1;
          // Parse relative time for sorting (rough approximation)
          return parseRelativeTime(a.last_deployed) - parseRelativeTime(b.last_deployed);
        case 'last_opened':
        default:
          if (!a.last_opened && !b.last_opened) return a.name.localeCompare(b.name);
          if (!a.last_opened) return 1;
          if (!b.last_opened) return -1;
          return b.last_opened - a.last_opened;
      }
    });

    return result;
  }, [projects, displayedProjects, searchQuery, sortBy]);

  // Filter folders by search query
  const filteredFolders = useMemo(() => {
    if (!searchQuery || currentFolderId) return folders;
    const query = searchQuery.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(query));
  }, [folders, searchQuery, currentFolderId]);

  const handleDelete = async (project: DashboardProject) => {
    setDeleting(true);
    try {
      await invoke('delete_project', { path: project.path });
      setDeleteConfirm(null);
      await loadAll();
    } catch (error) {
      console.error('Failed to delete project:', error);
      alert('Failed to delete project: ' + String(error));
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleAutoAccept = async (projectPath: string, enabled: boolean) => {
    try {
      await setAutoAcceptMode(projectPath, enabled);
      // Update local state immediately for responsive UI
      setProjects((prev) =>
        prev.map((p) => (p.path === projectPath ? { ...p, auto_accept_mode: enabled } : p))
      );
    } catch (error) {
      console.error('Failed to toggle auto-accept mode:', error);
      alert('Failed to update auto-accept mode: ' + String(error));
    }
  };

  const handleToggleMainBranchWarning = async (projectPath: string, hidden: boolean) => {
    try {
      await setHideMainBranchWarning(projectPath, hidden);
      // Update local state immediately for responsive UI
      setProjects((prev) =>
        prev.map((p) => (p.path === projectPath ? { ...p, hide_main_branch_warning: hidden } : p))
      );
    } catch (error) {
      console.error('Failed to toggle main branch warning:', error);
      alert('Failed to update main branch warning: ' + String(error));
    }
  };

  const handleExportAsTemplate = async (projectPath: string) => {
    try {
      const result = await invoke<string | null>('export_project_as_template', {
        projectPath,
      });
      if (result) {
        alert(`Template exported to:\n${result}`);
      }
      // If result is null, user cancelled the dialog - no action needed
    } catch (error) {
      console.error('Failed to export template:', error);
      alert('Failed to export template: ' + String(error));
    }
  };

  const handleOpenInNewWindow = async (project: DashboardProject) => {
    try {
      await invoke('open_project_in_new_window', {
        projectPath: project.path,
        projectName: project.name,
      });
    } catch (error) {
      logger.error('[ProjectList] Failed to open in new window', {
        error,
        projectName: project.name,
        projectPath: project.path,
      });
      alert('Failed to open in new window: ' + String(error));
    }
  };

  const handleCreateFolder = async (name: string) => {
    await createFolder(name);
    await loadFolders();
  };

  const handleRenameFolder = async (name: string) => {
    if (!renamingFolder) return;
    await renameFolder(renamingFolder.id, name);
    await loadFolders();
  };

  const handleDeleteFolder = async (folder: FolderInfo) => {
    setDeletingFolder(true);
    try {
      await deleteFolder(folder.id);
      setDeleteFolderConfirm(null);
      await loadAll();
    } catch (error) {
      console.error('Failed to delete folder:', error);
      alert('Failed to delete folder: ' + String(error));
    } finally {
      setDeletingFolder(false);
    }
  };

  const handleMoveProject = async (folderId: string | null) => {
    if (!moveProject) return;
    await moveProjectToFolder(moveProject.path, folderId);
    setMoveProject(null);
    setMoveProjectFolderId(null);
    await loadAll();
  };

  const handleOpenMoveModal = async (project: DashboardProject) => {
    // Check if project is currently in a folder
    const paths = await getFiledProjectPaths();
    const isInFolder = paths.includes(project.path);

    if (isInFolder) {
      // Find which folder it's in
      for (const folder of folders) {
        const folderPaths = await getFolderProjects(folder.id);
        if (folderPaths.includes(project.path)) {
          setMoveProjectFolderId(folder.id);
          break;
        }
      }
    } else {
      setMoveProjectFolderId(null);
    }

    setMoveProject(project);
  };

  if (loading) {
    return (
      <div className="project-list-loading">
        <div className="spinner" />
        <p>Loading projects...</p>
      </div>
    );
  }

  const sortLabels: Record<SortOption, string> = {
    last_opened: 'Last opened',
    name: 'Name',
    last_deployed: 'Last deployed',
  };

  const totalCount = currentFolderId
    ? filteredProjects.length
    : filteredFolders.length + filteredProjects.length;

  return (
    <div className="dashboard-scroll-container">
      <div className="project-list dashboard">
        <DashboardHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCreateProject={onCreateProject}
          onImportProject={onImportProject}
          onCreateFolder={() => setShowNewFolderModal(true)}
          isGitHubAuthenticated={isGitHubAuthenticated}
          onGitHubConnectForImport={onGitHubConnectForImport}
        />

        {/* Folder breadcrumb when inside a folder */}
        {currentFolderId && currentFolder && (
          <div className="folder-breadcrumb">
            <button className="folder-breadcrumb-back" onClick={() => setCurrentFolderId(null)}>
              <ArrowLeftIcon size={14} />
              All Projects
            </button>
            <span className="folder-breadcrumb-separator">/</span>
            <span className="folder-breadcrumb-current">{currentFolder.name}</span>
          </div>
        )}

        <div className="dashboard-section-header">
          <span className="dashboard-section-title">
            {currentFolderId ? 'Projects' : 'All Projects'} {totalCount > 0 && `(${totalCount})`}
          </span>
          <div className="dashboard-section-controls">
            <div className="sort-dropdown" ref={sortDropdownRef}>
              <button
                className="sort-dropdown-btn"
                onClick={() => setShowSortDropdown(!showSortDropdown)}
              >
                {sortLabels[sortBy]}
                <ChevronIcon />
              </button>
              {showSortDropdown && (
                <div className="sort-dropdown-menu">
                  {(Object.keys(sortLabels) as SortOption[]).map((option) => (
                    <button
                      key={option}
                      className={`sort-dropdown-item ${sortBy === option ? 'active' : ''}`}
                      onClick={() => {
                        setSortBy(option);
                        setShowSortDropdown(false);
                      }}
                    >
                      {sortLabels[option]}
                      {sortBy === option && <CheckIcon />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {totalCount === 0 ? (
          <div className="project-list-empty">
            {searchQuery ? (
              <>
                <p>No items found</p>
                <p className="hint">Try a different search term</p>
              </>
            ) : currentFolderId ? (
              <>
                <p>This folder is empty</p>
                <p className="hint">Move projects here or create a new project</p>
              </>
            ) : (
              <>
                <p>No projects yet</p>
                <p className="hint">Create your first project to get started</p>
              </>
            )}
          </div>
        ) : (
          <div className="project-grid">
            {/* Render folders first (only at root level) */}
            {!currentFolderId &&
              filteredFolders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onOpen={() => setCurrentFolderId(folder.id)}
                  onRename={() => setRenamingFolder(folder)}
                  onDelete={() => setDeleteFolderConfirm(folder)}
                />
              ))}
            {/* Render projects */}
            {filteredProjects.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                thumbnailData={project.thumbnailData}
                onSelect={() => onSelectProject(project)}
                onDelete={() => setDeleteConfirm(project)}
                onToggleAutoAccept={(enabled) => void handleToggleAutoAccept(project.path, enabled)}
                onToggleMainBranchWarning={(hidden) =>
                  void handleToggleMainBranchWarning(project.path, hidden)
                }
                onMoveToFolder={() => void handleOpenMoveModal(project)}
                onExportAsTemplate={() => void handleExportAsTemplate(project.path)}
                onOpenInNewWindow={() => void handleOpenInNewWindow(project)}
                onOpenSite={
                  project.production_url
                    ? () => {
                        const url = project.production_url!;
                        void openUrl(url.startsWith('http') ? url : `https://${url}`);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}

        <IntegrationBar onGitHubConnect={onGitHubConnect} onVercelConnect={onVercelConnect} />

        {/* New Folder Modal */}
        <NewFolderModal
          isOpen={showNewFolderModal}
          onClose={() => setShowNewFolderModal(false)}
          onCreate={handleCreateFolder}
        />

        {/* Rename Folder Modal */}
        <NewFolderModal
          isOpen={renamingFolder !== null}
          onClose={() => setRenamingFolder(null)}
          onCreate={handleRenameFolder}
          initialName={renamingFolder?.name || ''}
          title="Rename Folder"
          buttonLabel="Rename"
        />

        {/* Move to Folder Modal */}
        <MoveFolderModal
          isOpen={moveProject !== null}
          onClose={() => {
            setMoveProject(null);
            setMoveProjectFolderId(null);
          }}
          onSelect={handleMoveProject}
          projectName={moveProject?.name || ''}
          currentFolderId={moveProjectFolderId}
        />

        {/* Delete Project Confirmation Modal */}
        {deleteConfirm && (
          <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Delete Project?</h3>
              <p>
                Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
              </p>
              <p className="hint">
                This will delete the local copy from your computer. If this project is connected to
                GitHub, your code will remain there and you can reimport it at any time.
              </p>
              <div className="modal-actions">
                <button onClick={() => setDeleteConfirm(null)} disabled={deleting}>
                  Cancel
                </button>
                <button
                  className="btn-danger"
                  onClick={() => void handleDelete(deleteConfirm)}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Folder Confirmation Modal */}
        {deleteFolderConfirm && (
          <div className="modal-overlay" onClick={() => setDeleteFolderConfirm(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Delete Folder?</h3>
              <p>
                Are you sure you want to delete <strong>{deleteFolderConfirm.name}</strong>?
              </p>
              <p className="hint">
                Projects in this folder will not be deleted. They will appear at the root level.
              </p>
              <div className="modal-actions">
                <button onClick={() => setDeleteFolderConfirm(null)} disabled={deletingFolder}>
                  Cancel
                </button>
                <button
                  className="btn-danger"
                  onClick={() => void handleDeleteFolder(deleteFolderConfirm)}
                  disabled={deletingFolder}
                >
                  {deletingFolder ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function parseRelativeTime(timeStr: string): number {
  // Parse strings like "2h ago", "3d ago", "5m ago", "just now"
  if (timeStr === 'just now') return 0;
  const match = timeStr.match(/^(\d+)([mhd]) ago$/);
  if (!match) return Infinity;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return value;
    case 'h':
      return value * 60;
    case 'd':
      return value * 60 * 24;
    default:
      return Infinity;
  }
}
