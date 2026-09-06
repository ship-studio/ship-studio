/**
 * Workspace header bar component.
 *
 * Renders the top header of the workspace view including:
 * - Back button to return to projects
 * - Project name and path
 * - Topbar action buttons (education, plugins, assets, IDE, env, backups)
 * - GitHub button and publish dropdown
 * - Plugin toolbar/publish slots
 *
 * IDE dropdown state (showIdeDropdown, openingIde, ideAvailability) is managed
 * internally since it is only used within this component.
 *
 * @module components/WorkspaceHeader
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BranchIndicator } from '../branches/BranchIndicator';
import { BranchesMenu } from '../branches/BranchesMenu';
import { openInFinder } from '../../lib/ide';
import { PublishBranchDropdown } from '../branches/PublishBranchDropdown';
import { PluginSlot } from '../plugins/PluginSlot';
import {
  AgentsIcon,
  BellIcon,
  ElementsIcon,
  FolderOpenIcon,
  HomeIcon,
  ImageIcon,
  PanelLeftIcon,
  VariablesIcon,
  CommentIcon,
  ActivityIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { MiddleTruncate } from '../primitives/MiddleTruncate';
import { ToggleButton } from '../primitives/ToggleButton';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { ChangedFile } from '../../lib/git';

/** Re-exported from lib/plugins so non-UI code can share the list (issue #386). */
export { HOSTING_PLUGIN_IDS } from '../../lib/plugins';
import { HOSTING_PLUGIN_IDS, NATIVE_HOSTING_IDS } from '../../lib/plugins';

/** The subset of hosting plugins whose controls render inside the Push workflow. */
export { NATIVE_HOSTING_IDS } from '../../lib/plugins';

export interface WorkspaceHeaderProps {
  // Project
  projectPath: string;
  projectName: string;
  onGoHome: () => void;
  /** Home-level destinations, kept reachable from inside a project. */
  onGoWorkflows?: () => void;
  onGoInbox?: () => void;
  inboxUnreadCount?: number;
  isSidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Consolidate navigation, tools, modes, and publishing into the titlebar. */
  compactWorkspaceToolbarEnabled: boolean;

  // Workspace tools that remain directly accessible from the topbar.
  // Env editor, backups, plugin manager, learn mode, and IDE launch moved
  // to the Cmd+K palette.
  onOpenAssetsPanel: () => void;
  assetsPanelVisible: boolean;
  elementTreeVisible: boolean;
  elementTreeAvailable: boolean;
  onToggleElementTree: () => void;
  commentsVisible: boolean;
  commentsAvailable: boolean;
  /** Pending notes in the backlog; badges the toggle when non-zero. */
  commentsPendingCount: number;
  onToggleComments: () => void;
  agentPanelVisible: boolean;
  onToggleAgentPanel: () => void;
  variablesPanelVisible: boolean;
  variablesPanelAvailable: boolean;
  onToggleVariablesPanel: () => void;

  // Extra dropdown node rendered after Assets in the left cluster. Currently
  // used for the Plugins dropdown. Provided as a
  // pre-composed node because it needs plugin slot data that lives in
  // WorkspaceView. Omit to hide.
  headerExtras?: ReactNode;

  // Primary workspace modes (Preview/Focus/Code), rendered in the topbar
  // between the project location and repository/publishing actions.
  // Pre-composed in WorkspaceView since they drive the right-pane state.
  modes?: ReactNode;

  // GitHub
  integrations: IntegrationState;
  onGitHubStatusChange: () => void;
  onGitHubConnect: () => void;
  focusActiveTerminal: () => void;

  // Publish
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  isPulling: boolean;
  isBranchSwitching: boolean;
  isRepositoryViewActive: boolean;
  onPullLatest: () => void;
  onBranchSwitch: (branch: string) => void;
  onViewBranches: () => void;
  onCreateBranch: () => void;
  onViewPRs: () => void;
  onDiscardChanges: () => void;
  isPublishing: boolean;
  setIsPublishing: (v: boolean) => void;
  onPublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  onPublishStatusChange: () => void;
  onCreatePR: (branch?: string) => void;
  forcePublishOpen: boolean;
  onForcePublishOpenHandled: () => void;
  forceBranchesOpen: boolean;
  onForceBranchesOpenHandled: () => void;

  // Plugin slots
  getSlotPlugins: (slot: string) => LoadedPlugin[];
  pluginProject: {
    name: string;
    path: string;
    currentBranch: string;
    hasUncommittedChanges: boolean;
    devServerUrl: string;
  } | null;
  pluginActions: {
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    refreshGitStatus: () => void;
    refreshBranches: () => void;
    focusTerminal: () => void;
    openUrl: (url: string) => void;
    openTerminal: (
      command: string,
      args: string[],
      options?: { title?: string }
    ) => Promise<number | null>;
  };
  pluginTheme: PluginThemeData;
}

export interface WorkspaceNavigationProps {
  onGoHome: () => void;
  /** Home-level destinations, reachable from inside a project. */
  onGoWorkflows?: () => void;
  onGoInbox?: () => void;
  inboxUnreadCount?: number;
  isHomeActive?: boolean;
  isSidebarHidden: boolean;
  onToggleSidebar: () => void;
}

/** Shared navigation controls used by the project and home titlebars. */
export function WorkspaceNavigation({
  onGoHome,
  onGoWorkflows,
  onGoInbox,
  // Passed in, exactly as HomeSidebar takes it: this row is presentational,
  // and subscribing to the workflows store from here would start its polling
  // inside every open project to render one badge.
  inboxUnreadCount = 0,
  isHomeActive = false,
  isSidebarHidden,
  onToggleSidebar,
}: WorkspaceNavigationProps) {
  return (
    <div className="workspace-titlebar-navigation" aria-label="Workspace navigation">
      <IconButton
        variant="ghost"
        className="workspace-titlebar-toggle"
        icon={<PanelLeftIcon size={12} />}
        onClick={onToggleSidebar}
        title={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
        aria-label={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
        data-education-id="toggle-sidebar"
      />
      <IconButton
        variant="ghost"
        className="workspace-titlebar-home"
        icon={<HomeIcon size={12} />}
        onClick={onGoHome}
        disabled={isHomeActive}
        aria-current={isHomeActive ? 'page' : undefined}
        title="Home"
        aria-label="Home"
      />
      {/* Workflows and the Inbox are home-level screens, but the work they
          describe happens here. Leaving them behind on Home meant a finding
          filed while you were in a project could only be noticed by going
          looking for it. */}
      {onGoWorkflows && (
        <IconButton
          variant="ghost"
          className="workspace-titlebar-home"
          icon={<ActivityIcon size={12} />}
          onClick={onGoWorkflows}
          title="Workflows"
          aria-label="Workflows"
        />
      )}
      {onGoInbox && (
        <span className="workspace-titlebar-inbox">
          <IconButton
            variant="ghost"
            className="workspace-titlebar-home"
            icon={<BellIcon size={12} />}
            onClick={onGoInbox}
            title="Inbox"
            aria-label={inboxUnreadCount > 0 ? `Inbox — ${inboxUnreadCount} unread` : 'Inbox'}
          />
          {inboxUnreadCount > 0 && (
            <span className="workspace-titlebar-inbox-badge" aria-hidden>
              {inboxUnreadCount > 9 ? '9+' : inboxUnreadCount}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

interface WorkspaceTitlebarProps {
  children: ReactNode;
}

/** Window-drag region shared by the titlebars that sit below macOS traffic lights. */
export function WorkspaceTitlebar({ children }: WorkspaceTitlebarProps) {
  const handleDrag = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest(
        'button, a, input, select, [role="button"], [role="menu"]'
      )
    )
      return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest(
        'button, a, input, select, [role="button"], [role="menu"]'
      )
    )
      return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  return (
    <div className="workspace-titlebar" onMouseDown={handleDrag} onDoubleClick={handleDoubleClick}>
      {children}
    </div>
  );
}

export function WorkspaceHeader({
  projectPath,
  projectName,
  onGoHome,
  onGoWorkflows,
  onGoInbox,
  inboxUnreadCount,
  isSidebarHidden,
  onToggleSidebar,
  compactWorkspaceToolbarEnabled,
  onOpenAssetsPanel,
  assetsPanelVisible,
  elementTreeVisible,
  elementTreeAvailable,
  onToggleElementTree,
  commentsVisible,
  commentsAvailable,
  commentsPendingCount,
  onToggleComments,
  agentPanelVisible,
  onToggleAgentPanel,
  variablesPanelVisible,
  variablesPanelAvailable,
  onToggleVariablesPanel,
  headerExtras,
  modes,
  integrations,
  onGitHubStatusChange,
  onGitHubConnect,
  focusActiveTerminal,
  currentBranch,
  branches,
  openPRs,
  hasUncommittedChanges,
  changedFiles,
  isPulling,
  isBranchSwitching,
  isRepositoryViewActive,
  onPullLatest,
  onBranchSwitch,
  onViewBranches,
  onCreateBranch,
  onViewPRs,
  onDiscardChanges,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onPublishStatusChange,
  onCreatePR,
  forcePublishOpen,
  onForcePublishOpenHandled,
  forceBranchesOpen,
  onForceBranchesOpenHandled,
  getSlotPlugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: WorkspaceHeaderProps) {
  const [openSourceMenu, setOpenSourceMenu] = useState<'branches' | 'push' | null>(null);
  const currentBranchIsLive =
    currentBranch !== null &&
    (branches.find((branch) => branch.name === currentBranch)?.isDefault ?? false);
  // PublishBranchDropdown renders a bare disabled trigger (no menu at all)
  // until the project has a GitHub repo, so anything that claims to "open
  // Push" has to be gated on the same condition or it opens nothing.
  const pushMenuAvailable =
    integrations.projectGithub?.status === 'connected' &&
    Boolean(integrations.projectGithub?.github_repo);
  const projectPathContainerRef = useRef<HTMLDivElement>(null);
  const [expandedProjectPathWidth, setExpandedProjectPathWidth] = useState<number | null>(null);

  const expandProjectPath = useCallback(() => {
    const measure = projectPathContainerRef.current?.querySelector<HTMLElement>(
      '.project-path-expansion-measure'
    );
    if (!measure) return;
    const rect = measure.getBoundingClientRect();
    const width = rect.width || measure.scrollWidth;
    if (width > 0) setExpandedProjectPathWidth(width);
  }, []);

  const collapseProjectPath = useCallback(() => {
    const container = projectPathContainerRef.current;
    if (container?.contains(document.activeElement)) return;
    setExpandedProjectPathWidth(null);
  }, []);

  const handleProjectPathBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setExpandedProjectPathWidth(null);
  }, []);

  // Split toolbar plugins: hosting plugins (vercel, etc.) go on the right side
  const toolbarPlugins = useMemo(() => {
    const all = getSlotPlugins('toolbar');
    return {
      regular: all.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
      hosting: all.filter((p) => HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
    };
  }, [getSlotPlugins]);
  // Hosting is native now (components/hosting), so a hosting plugin no longer
  // renders anywhere. `usePlugins` skips loading them outright — filtering only
  // here would still run their activation and background timers.
  const headerHostingPlugins = useMemo(
    () => toolbarPlugins.hosting.filter((p) => !NATIVE_HOSTING_IDS.includes(p.info.manifest.id)),
    [toolbarPlugins.hosting]
  );

  useEffect(() => {
    if (!forceBranchesOpen) return;
    setOpenSourceMenu('branches');
    onForceBranchesOpenHandled();
  }, [forceBranchesOpen, onForceBranchesOpenHandled]);

  // IDE launch, env editor, backups, plugin manager, and learn-mode toggle
  // now live in the Cmd+K palette. See src/commands/useAppCommands.tsx.

  const sourceControlActions = (
    <div className="source-control-actions">
      <BranchesMenu
        githubState={integrations.github}
        projectStatus={integrations.projectGithub}
        projectPath={projectPath}
        projectName={projectName}
        currentBranch={currentBranch}
        branches={branches}
        openPRs={openPRs}
        isPulling={isPulling}
        isBranchSwitching={isBranchSwitching}
        isRepositoryViewActive={isRepositoryViewActive}
        isOpen={openSourceMenu === 'branches'}
        onOpenChange={(open) => setOpenSourceMenu(open ? 'branches' : null)}
        onPullLatest={onPullLatest}
        onBranchSwitch={onBranchSwitch}
        onViewBranches={onViewBranches}
        onCreateBranch={onCreateBranch}
        onViewPRs={onViewPRs}
        onStartPR={(branch) => onCreatePR(branch)}
        onGitHubConnect={onGitHubConnect}
        onGitHubStatusChange={onGitHubStatusChange}
        onModalClose={focusActiveTerminal}
      />
      <div
        className={`source-control-push${hasUncommittedChanges ? ' has-unsaved-changes' : ''}`}
        onClick={(event) => {
          if (!pushMenuAvailable) return;
          if ((event.target as HTMLElement).closest('button')) return;
          setOpenSourceMenu(openSourceMenu === 'push' ? null : 'push');
        }}
      >
        {/* Always show which branch you're on — that's what makes Publish
            safe to click. Only wire the chip to the Push menu when that menu
            has something to show; otherwise it falls back to the changed-
            files review, or to a plain label on a clean tree. */}
        {currentBranch && (
          <BranchIndicator
            currentBranch={currentBranch}
            hasUncommittedChanges={hasUncommittedChanges}
            changedFiles={changedFiles}
            projectPath={projectPath}
            onDiscard={onDiscardChanges}
            isOpen={openSourceMenu === 'push'}
            onOpenChange={(open) => setOpenSourceMenu(open ? 'push' : null)}
            opensPushMenu={pushMenuAvailable}
            isLive={currentBranchIsLive}
          />
        )}
        <PublishBranchDropdown
          currentBranch={currentBranch || 'main'}
          projectGithubStatus={integrations.projectGithub}
          projectPath={projectPath}
          hasChangesToSync={hasUncommittedChanges}
          onStatusChange={onPublishStatusChange}
          onModalClose={focusActiveTerminal}
          isPublishing={isPublishing}
          setIsPublishing={setIsPublishing}
          onPublishError={onPublishError}
          onCreatePR={onCreatePR}
          forceOpen={forcePublishOpen}
          onForceOpenHandled={onForcePublishOpenHandled}
          open={openSourceMenu === 'push'}
          onOpenChange={(open) => setOpenSourceMenu(open ? 'push' : null)}
          grouped={hasUncommittedChanges}
          changedFiles={changedFiles}
          onDiscardChanges={onDiscardChanges}
          excludeClickOutsideSelector=".source-control-push"
        />
      </div>
    </div>
  );

  const workspaceToolButtons = (
    <>
      <ToggleButton
        variant={agentPanelVisible ? 'secondary' : 'default'}
        className="workspace-panel-toggle"
        pressed={agentPanelVisible}
        onClick={onToggleAgentPanel}
        title="Agent"
        leftIcon={<AgentsIcon size={16} />}
        aria-label="Agent"
      />
      <ToggleButton
        variant={elementTreeVisible ? 'secondary' : 'default'}
        className="workspace-panel-toggle"
        pressed={elementTreeVisible}
        onClick={onToggleElementTree}
        disabled={!elementTreeAvailable}
        title={elementTreeAvailable ? 'Elements' : 'Elements are available in Preview'}
        leftIcon={<ElementsIcon size={16} />}
        aria-label="Elements"
      />
      <ToggleButton
        variant={variablesPanelVisible ? 'secondary' : 'default'}
        className="workspace-panel-toggle"
        pressed={variablesPanelVisible}
        onClick={onToggleVariablesPanel}
        disabled={!variablesPanelAvailable}
        title={variablesPanelAvailable ? 'Variables' : 'Variables are available for web projects'}
        leftIcon={<VariablesIcon size={16} />}
        aria-label="Variables"
      />
      <span className="workspace-comments-toggle-wrap">
        <ToggleButton
          variant={commentsVisible ? 'secondary' : 'default'}
          className="workspace-panel-toggle"
          pressed={commentsVisible}
          onClick={onToggleComments}
          disabled={!commentsAvailable}
          title={commentsAvailable ? 'Comments' : 'Comments are available for web projects'}
          leftIcon={<CommentIcon size={16} />}
          aria-label={
            commentsPendingCount > 0 ? `Comments — ${commentsPendingCount} pending` : 'Comments'
          }
        />
        {commentsPendingCount > 0 && (
          <span className="workspace-comments-badge" aria-hidden>
            {commentsPendingCount > 9 ? '9+' : commentsPendingCount}
          </span>
        )}
      </span>
      <Button
        onClick={onOpenAssetsPanel}
        title="Assets"
        aria-label="Assets"
        aria-pressed={assetsPanelVisible}
        data-education-id="assets-button"
        leftIcon={<ImageIcon size={16} />}
      />
      {headerExtras}
    </>
  );
  const projectTitle = (
    <div className="workspace-title-group">
      <h1>{projectName}</h1>
      <div
        ref={projectPathContainerRef}
        className="project-path-container"
        style={
          expandedProjectPathWidth !== null ? { width: `${expandedProjectPathWidth}px` } : undefined
        }
        onMouseEnter={expandProjectPath}
        onMouseLeave={collapseProjectPath}
        onFocus={expandProjectPath}
        onBlur={handleProjectPathBlur}
      >
        <span className="project-path-expansion-measure" aria-hidden="true">
          <FolderOpenIcon size={14} />
          {projectPath}
        </span>
        <button
          className="project-path"
          onClick={() => projectPath && void openInFinder(projectPath)}
          title="Open in Finder"
          aria-label={`Open ${projectPath} in Finder`}
        >
          <FolderOpenIcon size={14} />
          <span className="project-path-full">
            <MiddleTruncate text={projectPath} />
          </span>
        </button>
      </div>
    </div>
  );
  const publishingActions = (
    <>
      <PluginSlot
        name="publish"
        plugins={getSlotPlugins('publish')}
        project={pluginProject}
        actions={pluginActions}
        theme={pluginTheme}
      />
      <PluginSlot
        name="toolbar"
        plugins={headerHostingPlugins}
        project={pluginProject}
        actions={pluginActions}
        theme={pluginTheme}
      />
      {sourceControlActions}
    </>
  );

  if (!compactWorkspaceToolbarEnabled) {
    return {
      titlebar: (
        <WorkspaceTitlebar>
          <WorkspaceNavigation
            onGoHome={onGoHome}
            onGoWorkflows={onGoWorkflows}
            onGoInbox={onGoInbox}
            inboxUnreadCount={inboxUnreadCount}
            isSidebarHidden={isSidebarHidden}
            onToggleSidebar={onToggleSidebar}
          />
          {projectTitle}
        </WorkspaceTitlebar>
      ),
      toolbar: (
        <header className="workspace-header">
          <div className="workspace-header-left">{workspaceToolButtons}</div>
          <div className="workspace-header-center">{modes}</div>
          <div className="workspace-header-right">{publishingActions}</div>
        </header>
      ),
    };
  }

  return {
    titlebar: (
      <WorkspaceTitlebar>
        <div className="workspace-titlebar-left">
          <WorkspaceNavigation
            onGoHome={onGoHome}
            onGoWorkflows={onGoWorkflows}
            onGoInbox={onGoInbox}
            inboxUnreadCount={inboxUnreadCount}
            isSidebarHidden={isSidebarHidden}
            onToggleSidebar={onToggleSidebar}
          />
          <IconButton
            variant="ghost"
            className="workspace-titlebar-project-location"
            icon={<FolderOpenIcon size={12} />}
            onClick={() => projectPath && void openInFinder(projectPath)}
            title="Open project location"
            aria-label={`Open ${projectPath} in Finder`}
          />
          <div className="workspace-titlebar-divider" aria-hidden="true" />
          <div className="workspace-titlebar-tools">{workspaceToolButtons}</div>
        </div>
        <div className="workspace-titlebar-center">
          <div className="workspace-titlebar-modes">{modes}</div>
        </div>
        <div className="workspace-titlebar-actions">{publishingActions}</div>
      </WorkspaceTitlebar>
    ),
    toolbar: null,
  };
}
