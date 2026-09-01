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

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  DashboardProject,
  getDashboardProjects,
  setHideMainBranchWarning,
  getProjectThumbnail,
  uploadProjectThumbnail,
  renameProject,
  exportProjectAsTemplate,
} from '../../lib/project';
import { asCommandError, formatCommandError, isProjectFolderGoneError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { trackEvent, trackError } from '../../lib/analytics';
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
} from '../../lib/folders';
import { DashboardHeader } from './DashboardHeader';
import { AgentsPanel } from './AgentsPanel';
import { MachineToolsPanel } from './MachineToolsPanel';
import { NewFolderModal } from './NewFolderModal';
import { ProjectGridView } from './ProjectGridView';
import { RenameProjectModal } from './RenameProjectModal';
import { SearchAndSort } from './SearchAndSort';
import { FolderBreadcrumb } from './FolderBreadcrumb';
import { MoveFolderModal } from './MoveFolderModal';
import { MoveWorkspaceModal } from './MoveWorkspaceModal';
import { SettingsModal } from './SettingsModal';
import { ProjectActionConfirmModal } from './ProjectActionConfirmModal';
import { ProjectBulkActionsBar } from './ProjectBulkActionsBar';
import { ProjectBulkActionConfirm } from './ProjectBulkActionConfirm';
import { DashboardPreferencesCard } from './DashboardPreferencesCard';
import { DashboardCommunityBanner } from './DashboardCommunityBanner';
import { Spinner } from '../primitives/Spinner';
import { GitHubCalendar } from './GitHubCalendar';
import { useModal } from '../../contexts/ModalContext';
import {
  getCalendarHidden,
  setCalendarHidden as persistCalendarHidden,
  getSlackCtaHidden,
  setSlackCtaHidden as persistSlackCtaHidden,
} from '../../lib/settings';
import { moveProjectToAccount, getProjectAccountId } from '../../lib/accounts';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useProjectBulkActions } from '../../hooks/useProjectBulkActions';
import { useProjectViewModeCommands } from '../../hooks/useProjectViewModeCommands';
import { useProjectRemovalActions } from '../../hooks/useProjectRemovalActions';
import { useOptionalToast } from '../../contexts/ToastContext';
import { ChevronRightIcon } from '../icons';
import type { ProjectViewMode } from './ProjectGridView';

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

const PROJECT_VIEW_MODE_STORAGE_KEY = 'ship-studio-project-view-mode';

function getInitialProjectViewMode(): ProjectViewMode {
  return localStorage.getItem(PROJECT_VIEW_MODE_STORAGE_KEY) === 'list' ? 'list' : 'grid';
}

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
  /** GitHub username for contribution calendar */
  githubUsername?: string | null;
  /** Whether the initial auth check has completed */
  isAuthCheckDone?: boolean;
  /** Callback when loading state changes */
  onLoadingChange?: (loading: boolean) => void;
  /** Background cleanup status message (shown below loading spinner) */
  cleanupStatus?: string | null;
  /** Set of currently pinned project paths. */
  pinnedSet?: ReadonlySet<string>;
  /** Toggle pin state for a project. */
  onTogglePin?: (projectPath: string, pinned: boolean) => void | Promise<void>;
  /** Open the workspace switcher (shown as a chip beside "All Projects"). */
  onSwitchAccount?: () => void;
}

export function ProjectList({
  onSelectProject,
  onCreateProject,
  onImportProject,
  isGitHubAuthenticated = true,
  onGitHubConnectForImport,
  githubUsername,
  isAuthCheckDone = false,
  onLoadingChange,
  cleanupStatus,
  pinnedSet,
  onTogglePin,
  onSwitchAccount,
}: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectWithThumbnail[]>([]);
  /** Hidden <input type="file"> reused across cards. The current upload
   *  target lives in a ref (not state) so the change handler reads the
   *  freshest path even if the user clicks fast through several cards. */
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const thumbnailTargetPathRef = useRef<string | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [filedPaths, setFiledPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const { showToast } = useOptionalToast();
  // Drives a reload whenever the active workspace changes (see the load effect).
  const { activeAccount, accounts } = useActiveAccount();
  const activeAccountId = activeAccount?.id;
  const hasMultipleWorkspaces = accounts.length > 1;
  const [renameTarget, setRenameTarget] = useState<DashboardProject | null>(null);

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

  // Move to workspace modal state
  const [moveWorkspaceProject, setMoveWorkspaceProject] = useState<DashboardProject | null>(null);
  const [moveWorkspaceCurrentId, setMoveWorkspaceCurrentId] = useState<string | null>(null);

  // Settings / Changelog modal state
  const [showSettings, setShowSettings] = useState(false);
  const changelogModal = useModal('changelog');
  const [calendarHidden, setCalendarHidden] = useState(false);
  const [slackCtaHidden, setSlackCtaHidden] = useState(false);

  // Load visibility preferences
  useEffect(() => {
    void getCalendarHidden().then(setCalendarHidden);
    void getSlackCtaHidden().then(setSlackCtaHidden);
  }, []);

  const hideSlackCta = useCallback(() => {
    setSlackCtaHidden(true);
    void persistSlackCtaHidden(true);
  }, []);

  const hideCalendar = useCallback(() => {
    setCalendarHidden(true);
    void persistCalendarHidden(true);
  }, []);

  // Search and sort state
  // NOTE: search filtering now flows through the Cmd+K palette; this is kept
  // only because downstream grid/folder filters still key off a query string.
  // It's a constant for now (no setter), so it's a plain const rather than
  // dead useState.
  const searchQuery: string = '';
  const [sortBy, setSortBy] = useState<SortOption>('last_opened');
  const [projectViewMode, setProjectViewMode] =
    useState<ProjectViewMode>(getInitialProjectViewMode);

  // Monotonic token so a superseded loadAll() (e.g. the list fetched for the
  // old workspace right before a switch) neither applies its stale results nor
  // clears the loading state — preventing an empty-state flash mid-switch.
  // Only loadAll() passes a seq; bare loadProjects() refreshes apply
  // unconditionally and intentionally don't touch the token or the spinner.
  const loadSeqRef = useRef(0);

  const loadProjects = async (seq?: number) => {
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
              // `get_project_thumbnail` rejects with a plain CommandError
              // object (not an Error instance) — String() renders it as
              // "[object Object]" (issue #685). A gone project folder is a
              // by-design Expected state (canonicalize_tagged), not a bug:
              // warn locally instead of auto-filing a report.
              const message = formatCommandError(asCommandError(e));
              if (isProjectFolderGoneError(e)) {
                logger.warn('Thumbnail unavailable — project folder no longer exists', {
                  error: message,
                  projectName: project.name,
                });
              } else {
                logger.error('Failed to load thumbnail', {
                  error: message,
                  projectName: project.name,
                });
              }
            }
          }
          return { ...project, thumbnailData };
        })
      );

      // A seq'd load (from loadAll) is ignored if a newer one superseded it;
      // a bare refresh (no seq) always applies.
      if (seq === undefined || seq === loadSeqRef.current) {
        setProjects(projectsWithThumbnails);
      }
    } catch (error) {
      logger.error('Failed to load projects', {
        error: formatCommandError(asCommandError(error)),
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
    const seq = ++loadSeqRef.current;
    setLoading(true);
    await Promise.all([loadProjects(seq), loadFolders()]);
    // Only the latest load clears the spinner — a superseded load keeps it up
    // so the list stays in its loading state until the current fetch resolves.
    if (seq === loadSeqRef.current) setLoading(false);
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

  // Load on mount AND whenever the active workspace changes. get_dashboard_projects
  // is scoped to the active workspace server-side, so a switch changes the result
  // set. Keying on the resolved active-account id (rather than a fired event) is
  // deterministic — it reloads even when the switch happened while this list was
  // unmounted (the picker is a separate view), which an event listener would miss.
  useEffect(() => {
    void loadAll();
  }, [loadAll, activeAccountId]);

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

  const {
    selectedProjectPaths,
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
  } = useProjectBulkActions({
    filteredProjects,
    pinnedSet,
    onTogglePin,
    loadAll,
    showToast,
  });

  const handleProjectViewModeChange = useCallback(
    (mode: ProjectViewMode) => {
      setProjectViewMode(mode);
      localStorage.setItem(PROJECT_VIEW_MODE_STORAGE_KEY, mode);
      if (mode === 'grid') {
        handleClearProjectSelection();
      }
    },
    [handleClearProjectSelection]
  );

  useProjectViewModeCommands(handleProjectViewModeChange);

  const {
    deleteConfirm,
    setDeleteConfirm,
    removeConfirm,
    setRemoveConfirm,
    deleting,
    removing,
    handleDelete,
    handleRemoveFromApp,
  } = useProjectRemovalActions({
    pinnedSet,
    onTogglePin,
    loadAll,
    showToast,
    removeProjectFromSelection,
  });

  // Performs the rename and refreshes the dashboard. Throws on failure so the
  // modal can render the backend's reason inline (e.g. "Close this project
  // before renaming it.").
  const handleRename = async (newName: string) => {
    if (!renameTarget) return;
    try {
      await renameProject(renameTarget.path, newName);
      void trackEvent('project_renamed', { $screen_name: 'Dashboard' });
      await loadAll();
    } catch (error) {
      const message = formatCommandError(asCommandError(error));
      // Anticipated refusals (name taken, project open elsewhere) are rendered
      // inline by the modal — they're user states, not malfunctions.
      const isExpectedRefusal =
        message.includes('already exists') || message.includes('Close this project');
      if (isExpectedRefusal) {
        logger.warn('Rename refused', { error: message });
      } else {
        trackError('project_rename', error, 'Dashboard');
        logger.error('Failed to rename project', { error: message });
      }
      throw error;
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
      alert('Failed to update main branch warning: ' + formatCommandError(asCommandError(error)));
    }
  };

  const handleUploadThumbnail = (project: DashboardProject) => {
    thumbnailTargetPathRef.current = project.path;
    // Reset value so selecting the same file twice still triggers `change`.
    if (thumbnailInputRef.current) {
      thumbnailInputRef.current.value = '';
      thumbnailInputRef.current.click();
    }
  };

  const handleThumbnailFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const projectPath = thumbnailTargetPathRef.current;
    thumbnailTargetPathRef.current = null;
    if (!file || !projectPath) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const dataUrl = await uploadProjectThumbnail(projectPath, bytes);
      setProjects((prev) =>
        prev.map((p) =>
          p.path === projectPath
            ? { ...p, thumbnail: '.shipstudio/thumbnail.png', thumbnailData: dataUrl }
            : p
        )
      );
      void trackEvent('project_thumbnail_uploaded', { $screen_name: 'Dashboard' });
    } catch (error) {
      // CommandError rejections are plain objects — String() renders
      // "[object Object]" (issue #823); format to the real message.
      logger.error('Failed to upload thumbnail', {
        error: formatCommandError(asCommandError(error)),
      });
      alert('Failed to upload thumbnail: ' + formatCommandError(asCommandError(error)));
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
      alert('Failed to export template: ' + formatCommandError(asCommandError(error)));
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
      alert('Failed to delete folder: ' + formatCommandError(asCommandError(error)));
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

  const handleMoveProjectToWorkspace = async (accountId: string) => {
    if (!moveWorkspaceProject) return;
    const projectName = moveWorkspaceProject.name;
    const workspaceName = accounts.find((a) => a.id === accountId)?.name ?? 'workspace';
    try {
      await moveProjectToAccount(moveWorkspaceProject.path, accountId);
      void trackEvent('project_moved_to_workspace', { $screen_name: 'Dashboard' });
      showToast(`Moved "${projectName}" to ${workspaceName}`, 'success');
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    } finally {
      setMoveWorkspaceProject(null);
      setMoveWorkspaceCurrentId(null);
      await loadProjects();
    }
  };

  const handleOpenMoveWorkspaceModal = async (project: DashboardProject) => {
    const currentId = await getProjectAccountId(project.path);
    setMoveWorkspaceCurrentId(currentId);
    setMoveWorkspaceProject(project);
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

  const handleDashboardDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDashboardDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  if (loading) {
    return (
      <div className="dashboard-scroll-container">
        <div
          className="dashboard-drag-region"
          onMouseDown={handleDashboardDrag}
          onDoubleClick={handleDashboardDoubleClick}
        />
        <div className="project-list dashboard">
          <div className="project-list-loading">
            <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
            <p>Loading projects...</p>
            {cleanupStatus && <p className="project-list-cleanup-status">{cleanupStatus}</p>}
          </div>
        </div>
      </div>
    );
  }

  const totalCount = currentFolderId
    ? filteredProjects.length
    : filteredFolders.length + filteredProjects.length;

  return (
    <div className="dashboard-scroll-container">
      <div
        className="dashboard-drag-region"
        onMouseDown={handleDashboardDrag}
        onDoubleClick={handleDashboardDoubleClick}
      />
      <div className="project-list dashboard">
        {!slackCtaHidden && <DashboardCommunityBanner onHide={hideSlackCta} />}

        {!calendarHidden && (
          <GitHubCalendar
            username={githubUsername}
            isAuthenticated={isGitHubAuthenticated}
            isAuthCheckDone={isAuthCheckDone}
            onHide={hideCalendar}
          />
        )}

        <DashboardHeader
          onCreateProject={onCreateProject}
          onImportProject={onImportProject}
          isGitHubAuthenticated={isGitHubAuthenticated}
          onGitHubConnectForImport={onGitHubConnectForImport}
        />

        {/* Folder breadcrumb when inside a folder */}
        {currentFolderId && currentFolder && (
          <FolderBreadcrumb
            folderName={currentFolder.name}
            onBack={() => setCurrentFolderId(null)}
          />
        )}

        <SearchAndSort
          title={currentFolderId ? 'Projects' : 'All Projects'}
          totalCount={totalCount}
          sortBy={sortBy}
          viewMode={projectViewMode}
          onSortChange={setSortBy}
          onViewModeChange={handleProjectViewModeChange}
          onNewFolder={() => setShowNewFolderModal(true)}
          titleAccessory={
            !currentFolderId && hasMultipleWorkspaces && activeAccount && onSwitchAccount ? (
              <button
                type="button"
                className="dashboard-workspace-chip"
                onClick={onSwitchAccount}
                title="Switch workspace"
              >
                <span
                  className="dashboard-workspace-chip-dot"
                  style={{ backgroundColor: activeAccount.color }}
                />
                <span className="dashboard-workspace-chip-name">{activeAccount.name}</span>
                <ChevronRightIcon size={12} />
              </button>
            ) : undefined
          }
        />

        {projectViewMode === 'list' && (
          <ProjectBulkActionsBar
            selectedCount={selectedCount}
            selectedIncludesExternalProject={selectedIncludesExternalProject}
            onClear={handleClearProjectSelection}
            onRemove={() => handleBeginBulkProjectAction('remove')}
            onDelete={() => handleBeginBulkProjectAction('delete')}
          />
        )}

        <ProjectGridView
          viewMode={projectViewMode}
          currentFolderId={currentFolderId}
          searchQuery={searchQuery}
          totalCount={totalCount}
          filteredFolders={filteredFolders}
          filteredProjects={filteredProjects}
          selectedProjectPaths={selectedProjectPaths}
          allVisibleSelected={allVisibleSelected}
          someVisibleSelected={someVisibleSelected}
          onSelectAllVisible={handleSelectAllVisible}
          onToggleProjectSelection={handleToggleProjectSelection}
          onSelectProject={(project) => onSelectProject(project)}
          onDeleteProject={(project) => setDeleteConfirm(project)}
          onRenameProject={(project) => setRenameTarget(project)}
          onToggleMainBranchWarning={(path, hidden) =>
            void handleToggleMainBranchWarning(path, hidden)
          }
          onOpenMoveModal={(project) => void handleOpenMoveModal(project)}
          onOpenMoveWorkspaceModal={(project) => void handleOpenMoveWorkspaceModal(project)}
          onExportAsTemplate={(path) => void handleExportAsTemplate(path)}
          onUploadThumbnail={(project) => handleUploadThumbnail(project)}
          onRemoveProject={(project) => setRemoveConfirm(project)}
          onOpenFolder={(folderId) => setCurrentFolderId(folderId)}
          onRenameFolder={(folder) => setRenamingFolder(folder)}
          onDeleteFolder={(folder) => setDeleteFolderConfirm(folder)}
          pinnedSet={pinnedSet}
          onTogglePin={onTogglePin}
          onCreateProject={onCreateProject}
        />

        <AgentsPanel />

        <DashboardPreferencesCard
          onOpenSettings={() => setShowSettings(true)}
          onOpenChangelog={() => changelogModal.open()}
        />

        <MachineToolsPanel />

        {/* Physical bottom spacer — guarantees the Integrations card never
            butts up against the scroll edge, regardless of how the outer
            flex/overflow containers resolve padding. */}
        <div className="dashboard-bottom-spacer" aria-hidden />

        {/* Hidden file picker reused across project cards for "Upload new
            thumbnail". A single input is enough — handleUploadThumbnail
            stashes the target path in a ref, then triggers .click() here. */}
        <input
          ref={thumbnailInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => void handleThumbnailFileSelected(e)}
        />

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

        {/* Move to Workspace Modal */}
        <MoveWorkspaceModal
          isOpen={moveWorkspaceProject !== null}
          onClose={() => {
            setMoveWorkspaceProject(null);
            setMoveWorkspaceCurrentId(null);
          }}
          onSelect={handleMoveProjectToWorkspace}
          projectName={moveWorkspaceProject?.name || ''}
          currentAccountId={moveWorkspaceCurrentId}
        />

        {/* Rename Project Modal */}
        <RenameProjectModal
          isOpen={renameTarget !== null}
          onClose={() => setRenameTarget(null)}
          currentName={renameTarget?.name ?? ''}
          onRename={handleRename}
        />

        {/* Bulk Project Action Confirmation Modal */}
        {bulkConfirm && (
          <ProjectBulkActionConfirm
            confirm={bulkConfirm}
            loading={bulkActionLoading}
            onCancel={() => setBulkConfirm(null)}
            onConfirm={() => void handleBulkProjectAction(bulkConfirm)}
          />
        )}

        {/* Delete Project Confirmation Modal */}
        {deleteConfirm && (
          <ProjectActionConfirmModal
            title="Delete Files From Computer?"
            body={
              <>
                Permanently delete <strong>{deleteConfirm.name}</strong> from this computer?
              </>
            }
            hint="This removes the local project folder and its files. Use Remove from Ship Studio if you only want to hide it from the app."
            loading={deleting}
            confirmLabel="Delete files"
            loadingLabel="Deleting..."
            confirmVariant="danger"
            onCancel={() => setDeleteConfirm(null)}
            onConfirm={() => void handleDelete(deleteConfirm)}
          />
        )}

        {/* Remove Project Confirmation Modal */}
        {removeConfirm && (
          <ProjectActionConfirmModal
            title="Remove From Ship Studio?"
            body={
              <>
                Remove <strong>{removeConfirm.name}</strong> from Ship Studio?
              </>
            }
            hint="Your project folder and files will stay on this computer. You can add it back later with Import Project, Local Folder."
            loading={removing}
            confirmLabel="Remove from Ship Studio"
            loadingLabel="Removing..."
            confirmVariant="primary"
            onCancel={() => setRemoveConfirm(null)}
            onConfirm={() => void handleRemoveFromApp(removeConfirm)}
          />
        )}

        {/* Delete Folder Confirmation Modal */}
        {deleteFolderConfirm && (
          <ProjectActionConfirmModal
            title="Delete Folder?"
            body={
              <>
                Delete the folder <strong>{deleteFolderConfirm.name}</strong>?
              </>
            }
            hint="Projects in this folder will not be deleted. They will appear at the root level."
            loading={deletingFolder}
            confirmLabel="Delete"
            loadingLabel="Deleting..."
            confirmVariant="danger"
            onCancel={() => setDeleteFolderConfirm(null)}
            onConfirm={() => void handleDeleteFolder(deleteFolderConfirm)}
          />
        )}

        {/* Settings Modal */}
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          onCalendarHiddenChange={setCalendarHidden}
          onSlackCtaHiddenChange={setSlackCtaHidden}
          onProjectsRootChanged={() => void loadProjects()}
        />

        {/* What's New Modal */}
        {/* ChangelogModal is mounted globally in <AppGlobalModals>. */}
      </div>
    </div>
  );
}
