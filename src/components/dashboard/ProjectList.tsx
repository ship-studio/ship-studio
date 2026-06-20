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
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  DashboardProject,
  getDashboardProjects,
  setHideMainBranchWarning,
  getProjectThumbnail,
  uploadProjectThumbnail,
  deleteProject,
  renameProject,
  exportProjectAsTemplate,
} from '../../lib/project';
import { unregisterExternalProject } from '../../lib/external-projects';
import { asCommandError, formatCommandError } from '../../lib/errors';
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
import { IntegrationBar } from './IntegrationBar';
import { NewFolderModal } from './NewFolderModal';
import { ProjectGridView } from './ProjectGridView';
import { RenameProjectModal } from './RenameProjectModal';
import { SearchAndSort } from './SearchAndSort';
import { FolderBreadcrumb } from './FolderBreadcrumb';
import { MoveFolderModal } from './MoveFolderModal';
import { MoveWorkspaceModal } from './MoveWorkspaceModal';
import { SettingsModal } from './SettingsModal';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
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
import { useOptionalToast } from '../../contexts/ToastContext';
import { SlackIcon, SettingsIcon, EyeOffIcon, ChevronRightIcon, HistoryIcon } from '../icons';

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
  /** Set of currently pinned project paths. */
  pinnedSet?: ReadonlySet<string>;
  /** Toggle pin state for a project. */
  onTogglePin?: (projectPath: string, pinned: boolean) => void;
  /** Open the workspace switcher (shown as a chip beside "All Projects"). */
  onSwitchAccount?: () => void;
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
  const [deleteConfirm, setDeleteConfirm] = useState<DashboardProject | null>(null);
  const [deleting, setDeleting] = useState(false);
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
              logger.error('Failed to load thumbnail', {
                error: e instanceof Error ? e.message : String(e),
                projectName: project.name,
              });
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
      alert('Failed to delete project: ' + formatCommandError(asCommandError(error)));
    } finally {
      setDeleting(false);
    }
  };

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
      trackError('project_rename', error, 'Dashboard');
      logger.error('Failed to rename project', {
        error: error instanceof Error ? error.message : String(error),
      });
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
      alert('Failed to update main branch warning: ' + String(error));
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
      logger.error('Failed to upload thumbnail', {
        error: error instanceof Error ? error.message : String(error),
      });
      alert('Failed to upload thumbnail: ' + String(error));
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
        {!slackCtaHidden && (
          <div className="slack-cta" data-education-id="slack-cta">
            <div className="slack-cta-content">
              <SlackIcon />
              <span>
                <strong>Join the Slack</strong> — suggest features, share what you're building, and
                shape the future of how we build for the web.
              </span>
            </div>
            <button
              className="slack-cta-join"
              onClick={() =>
                void openUrl(
                  'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g'
                )
              }
            >
              Join Slack
            </button>
            <button
              className="slack-cta-hide"
              onClick={hideSlackCta}
              title="Hide"
              aria-label="Hide community banner"
            >
              <EyeOffIcon size={14} />
            </button>
          </div>
        )}

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
          onSortChange={setSortBy}
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

        <ProjectGridView
          currentFolderId={currentFolderId}
          searchQuery={searchQuery}
          totalCount={totalCount}
          filteredFolders={filteredFolders}
          filteredProjects={filteredProjects}
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
          onRemoveExternal={(project) => void handleRemoveExternal(project)}
          onOpenFolder={(folderId) => setCurrentFolderId(folderId)}
          onRenameFolder={(folder) => setRenamingFolder(folder)}
          onDeleteFolder={(folder) => setDeleteFolderConfirm(folder)}
          pinnedSet={pinnedSet}
          onTogglePin={onTogglePin}
          onCreateProject={onCreateProject}
        />

        <AgentsPanel />

        <section className="dashboard-card">
          <header className="dashboard-card-header">
            <div>
              <h3 className="dashboard-card-title">Preferences</h3>
              <p className="dashboard-card-subtitle">
                Adjust app settings or review recent updates.
              </p>
            </div>
          </header>
          <div className="dashboard-card-rows">
            <button
              type="button"
              className="dashboard-card-row"
              data-education-id="settings-button"
              onClick={() => {
                void trackEvent('settings_opened', { $screen_name: 'Dashboard' });
                setShowSettings(true);
              }}
            >
              <div className="dashboard-card-row-icon">
                <SettingsIcon size={18} />
              </div>
              <div className="dashboard-card-row-main">
                <div className="dashboard-card-row-name">Settings</div>
                <div className="dashboard-card-row-status">
                  Dashboard widgets, compact mode, learn mode
                </div>
              </div>
              <ChevronRightIcon size={14} />
            </button>
            <button
              type="button"
              className="dashboard-card-row"
              onClick={() => {
                void trackEvent('changelog_opened', { $screen_name: 'Dashboard' });
                changelogModal.open();
              }}
            >
              <div className="dashboard-card-row-icon">
                <HistoryIcon size={14} />
              </div>
              <div className="dashboard-card-row-main">
                <div className="dashboard-card-row-name">What's New</div>
                <div className="dashboard-card-row-status">
                  Recent updates and downgrade to older versions
                </div>
              </div>
              <ChevronRightIcon size={14} />
            </button>
          </div>
        </section>

        <IntegrationBar onGitHubConnect={onGitHubConnect} />

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

        {/* Delete Project Confirmation Modal */}
        {deleteConfirm && (
          <DeleteConfirmModal
            title="Delete Project?"
            name={deleteConfirm.name}
            hint="This will delete the local copy from your computer. If this project is connected to GitHub, your code will remain there and you can reimport it at any time."
            deleting={deleting}
            onCancel={() => setDeleteConfirm(null)}
            onDelete={() => void handleDelete(deleteConfirm)}
          />
        )}

        {/* Delete Folder Confirmation Modal */}
        {deleteFolderConfirm && (
          <DeleteConfirmModal
            title="Delete Folder?"
            name={deleteFolderConfirm.name}
            hint="Projects in this folder will not be deleted. They will appear at the root level."
            deleting={deletingFolder}
            onCancel={() => setDeleteFolderConfirm(null)}
            onDelete={() => void handleDeleteFolder(deleteFolderConfirm)}
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

/** Shared delete-confirmation dialog for projects and folders. */
function DeleteConfirmModal({
  title,
  name,
  hint,
  deleting,
  onCancel,
  onDelete,
}: {
  title: string;
  name: string;
  hint: string;
  deleting: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <ModalFrame isOpen onClose={onCancel} title={title} showCloseButton={false}>
      <div style={{ padding: 'var(--spacing-xl)' }}>
        <p>
          Are you sure you want to delete <strong>{name}</strong>?
        </p>
        <p className="hint">{hint}</p>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
