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
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  DashboardProject,
  getDashboardProjects,
  setHideMainBranchWarning,
  getProjectThumbnail,
  deleteProject,
  exportProjectAsTemplate,
  openProjectInNewWindow,
} from '../lib/project';
import { unregisterExternalProject } from '../lib/external-projects';
import { logger } from '../lib/logger';
import { trackEvent, trackError } from '../lib/analytics';
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
import { SettingsModal } from './SettingsModal';
import { GitHubCalendar } from './GitHubCalendar';
import { getCalendarHidden, setCalendarHidden as persistCalendarHidden } from '../lib/settings';
import { ChevronIcon, CheckIcon, ArrowLeftIcon, SlackIcon } from './icons';
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
type SortOption = 'last_opened' | 'name';

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
  /** GitHub username for contribution calendar */
  githubUsername?: string | null;
  /** Whether the initial auth check has completed */
  isAuthCheckDone?: boolean;
  /** Callback when loading state changes */
  onLoadingChange?: (loading: boolean) => void;
  /** Background cleanup status message (shown below loading spinner) */
  cleanupStatus?: string | null;
}

export function ProjectList({
  onSelectProject,
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
  onGitHubConnect,
  githubUsername,
  isAuthCheckDone = false,
  onLoadingChange,
  cleanupStatus,
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

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [calendarHidden, setCalendarHidden] = useState(false);

  // Load calendar visibility preference
  useEffect(() => {
    void getCalendarHidden().then(setCalendarHidden);
  }, []);

  const hideCalendar = useCallback(() => {
    setCalendarHidden(true);
    void persistCalendarHidden(true);
  }, []);

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
              thumbnailData = await getProjectThumbnail(project.path);
            } catch (e) {
              logger.error('Failed to load thumbnail', {
                error: e instanceof Error ? e.message : String(e),
                projectName: project.name,
              });
            }
          }
          return { ...project, thumbnailData };
        })
      );

      setProjects(projectsWithThumbnails);
    } catch (error) {
      logger.error('Failed to load projects', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const loadFolders = async () => {
    try {
      const folderList = await listFolders();
      setFolders(folderList);

      const paths = await getFiledProjectPaths();
      setFiledPaths(new Set(paths));
    } catch (error) {
      logger.error('Failed to load folders', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadProjects(), loadFolders()]);
    setLoading(false);
  }, []);

  // Notify parent when loading state changes
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

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
      await deleteProject(project.path);
      void trackEvent('project_deleted', { $screen_name: 'Dashboard' });
      setDeleteConfirm(null);
      await loadAll();
    } catch (error) {
      trackError('project_delete', error, 'Dashboard');
      logger.error('Failed to delete project', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to delete project: ' + String(error));
    } finally {
      setDeleting(false);
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
      logger.error('Failed to toggle main branch warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to update main branch warning: ' + String(error));
    }
  };

  const handleExportAsTemplate = async (projectPath: string) => {
    try {
      const result = await exportProjectAsTemplate(projectPath);
      if (result) {
        void trackEvent('project_exported_as_template', { $screen_name: 'Dashboard' });
        alert(`Template exported to:\n${result}`);
      }
      // If result is null, user cancelled the dialog - no action needed
    } catch (error) {
      logger.error('Failed to export template', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to export template: ' + String(error));
    }
  };

  const handleRemoveExternal = async (project: DashboardProject) => {
    try {
      await unregisterExternalProject(project.path);
      await loadAll();
    } catch (error) {
      logger.error('Failed to remove external project', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to remove project: ' + String(error));
    }
  };

  const handleOpenInNewWindow = async (project: DashboardProject) => {
    try {
      await openProjectInNewWindow(project.path, project.name);
      void trackEvent('project_opened_in_new_window', { $screen_name: 'Dashboard' });
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
    void trackEvent('folder_created', { $screen_name: 'Dashboard' });
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
      void trackEvent('folder_deleted', { $screen_name: 'Dashboard' });
      setDeleteFolderConfirm(null);
      await loadAll();
    } catch (error) {
      logger.error('Failed to delete folder', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to delete folder: ' + String(error));
    } finally {
      setDeletingFolder(false);
    }
  };

  const handleMoveProject = async (folderId: string | null) => {
    if (!moveProject) return;
    await moveProjectToFolder(moveProject.path, folderId);
    void trackEvent('project_moved_to_folder', { $screen_name: 'Dashboard' });
    setMoveProject(null);
    setMoveProjectFolderId(null);
    // Refresh data without showing the full loading spinner
    await Promise.all([loadProjects(), loadFolders()]);
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
      <div className="dashboard-scroll-container">
        <div className="project-list dashboard">
          <div className="project-list-loading">
            <div className="spinner" />
            <p>Loading projects...</p>
            {cleanupStatus && <p className="project-list-cleanup-status">{cleanupStatus}</p>}
          </div>
        </div>
      </div>
    );
  }

  const sortLabels: Record<SortOption, string> = {
    last_opened: 'Last opened',
    name: 'Name',
  };

  const totalCount = currentFolderId
    ? filteredProjects.length
    : filteredFolders.length + filteredProjects.length;

  return (
    <div className="dashboard-scroll-container">
      <div className="project-list dashboard">
        <div className="slack-cta">
          <div className="slack-cta-content">
            <SlackIcon />
            <span>
              <strong>Join our community</strong> — suggest features, share what you're building,
              and shape the future of how we build for the web.
            </span>
          </div>
          <button
            className="slack-cta-join"
            onClick={() =>
              void openUrl(
                'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-3ommmu2w4-jtYZzzc9T~9lsEeKQ4E2AQ'
              )
            }
          >
            Join Slack
          </button>
        </div>

        {!calendarHidden && (
          <GitHubCalendar
            username={githubUsername}
            isAuthenticated={isGitHubAuthenticated}
            isAuthCheckDone={isAuthCheckDone}
            onHide={hideCalendar}
          />
        )}

        <DashboardHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCreateProject={onCreateProject}
          onImportProject={onImportProject}
          onCreateFolder={() => setShowNewFolderModal(true)}
          onOpenSettings={() => setShowSettings(true)}
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
                onToggleMainBranchWarning={(hidden) =>
                  void handleToggleMainBranchWarning(project.path, hidden)
                }
                onMoveToFolder={() => void handleOpenMoveModal(project)}
                onExportAsTemplate={() => void handleExportAsTemplate(project.path)}
                onOpenInNewWindow={() => void handleOpenInNewWindow(project)}
                isExternal={project.is_external}
                onRemove={
                  project.is_external ? () => void handleRemoveExternal(project) : undefined
                }
              />
            ))}
          </div>
        )}

        <IntegrationBar onGitHubConnect={onGitHubConnect} />

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

        {/* Settings Modal */}
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          onCalendarHiddenChange={setCalendarHidden}
        />
      </div>
    </div>
  );
}
