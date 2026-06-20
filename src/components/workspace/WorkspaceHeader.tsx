/**
 * Workspace header bar component.
 *
 * Renders the top header of the workspace view including:
 * - Back button to return to projects
 * - Project name and path
 * - Toolbar action buttons (education, plugins, assets, IDE, env, backups)
 * - GitHub button and publish dropdown
 * - Plugin toolbar/publish slots
 *
 * IDE dropdown state (showIdeDropdown, openingIde, ideAvailability) is managed
 * internally since it is only used within this component.
 *
 * @module components/WorkspaceHeader
 */

import { useState, useCallback, useMemo, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { GitHubButton } from '../branches/GitHubButton';
import { openInFinder } from '../../lib/ide';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PublishBranchDropdown } from '../branches/PublishBranchDropdown';
import { PluginSlot } from '../plugins/PluginSlot';
import { ImageIcon, SlackIcon, PanelLeftIcon } from '../icons';
// SupportPanel is hidden for now (the Support button links straight to Slack) but
// intentionally kept around so we can bring the panel back later.
import { SupportPanel } from '../support/SupportPanel';

/** Ship Studio community Slack invite — the Support button opens this directly. */
const SLACK_INVITE_URL =
  'https://join.slack.com/t/shipstudiocommunity/shared_invite/zt-41vbyaoo0-_pZWNPyMdvMoF6neuDYw7g';
import type { IntegrationState } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginThemeData } from '../../contexts/PluginContext';

export const HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare', 'netlify'];

export interface WorkspaceHeaderProps {
  // Project
  projectPath: string;
  projectName: string;

  // Modal openers — kept here only for Assets (still a toolbar button).
  // Env editor, backups, plugin manager, learn mode, and IDE launch moved
  // to the Cmd+K palette.
  onOpenAssetsPanel: () => void;

  // Extra dropdown node rendered at the end of the left cluster (after the
  // Support button). Currently used for the Plugins dropdown. Provided as a
  // pre-composed node because it needs plugin slot data that lives in
  // WorkspaceView. Omit to hide.
  headerExtras?: ReactNode;

  // Branch chip rendered at the very end of the left cluster (after
  // headerExtras). Pre-composed in WorkspaceView since it needs git/branch
  // state. Omit to hide.
  branchIndicator?: ReactNode;

  // Workspace tabs (Preview/Focus/Code/Branches/PRs) rendered at the start of
  // the right cluster (before the GitHub button). Pre-composed in WorkspaceView
  // since they drive the right-pane tab state. Omit to hide.
  tabs?: ReactNode;

  // Sidebar collapse — lives at the far-left of the header so the health
  // panel row below stays focused on health/logs. Omit `onToggleSidebar`
  // to hide the button entirely (e.g. compact mode or pinned layouts).
  isSidebarHidden?: boolean;
  onToggleSidebar?: () => void;

  // GitHub
  integrations: IntegrationState;
  onGitHubStatusChange: () => void;
  onGitHubConnect: () => void;
  focusActiveTerminal: () => void;

  // Publish
  currentBranch: string | null;
  hasUncommittedChanges: boolean;
  isPublishing: boolean;
  setIsPublishing: (v: boolean) => void;
  onPublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  onPublishStatusChange: () => void;
  onCreatePR: () => void;
  forcePublishOpen: boolean;
  onForcePublishOpenHandled: () => void;

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

export function WorkspaceHeader({
  projectPath,
  projectName,
  onOpenAssetsPanel,
  headerExtras,
  branchIndicator,
  tabs,
  isSidebarHidden,
  onToggleSidebar,
  integrations,
  onGitHubStatusChange,
  onGitHubConnect,
  focusActiveTerminal,
  currentBranch,
  hasUncommittedChanges,
  isPublishing,
  setIsPublishing,
  onPublishError,
  onPublishStatusChange,
  onCreatePR,
  forcePublishOpen,
  onForcePublishOpenHandled,
  getSlotPlugins,
  pluginProject,
  pluginActions,
  pluginTheme,
}: WorkspaceHeaderProps) {
  // Window dragging — only from the title bar (not the toolbar with plugins)
  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  // Split toolbar plugins: hosting plugins (vercel, etc.) go on the right side
  const toolbarPlugins = useMemo(() => {
    const all = getSlotPlugins('toolbar');
    return {
      regular: all.filter((p) => !HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
      hosting: all.filter((p) => HOSTING_PLUGIN_IDS.includes(p.info.manifest.id)),
    };
  }, [getSlotPlugins]);

  // Support panel state
  const [isSupportPanelOpen, setIsSupportPanelOpen] = useState(false);

  // IDE launch, env editor, backups, plugin manager, and learn-mode toggle
  // now live in the Cmd+K palette. See src/commands/useAppCommands.tsx.

  const titlebar = (
    <div className="workspace-titlebar" onMouseDown={handleDrag} onDoubleClick={handleDoubleClick}>
      <h1>{projectName}</h1>
      <button
        className="project-path"
        onClick={() => projectPath && void openInFinder(projectPath)}
        title="Open in Finder"
      >
        {projectPath}
      </button>
    </div>
  );

  const toolbar = (
    <header className="workspace-header">
      {/* Left side — sidebar collapse, Assets, Support. Learn mode, env
          vars, backups, plugin manager, and IDE launch are reachable via
          ⌘K. The sidebar toggle used to live in the health-panel row but
          moved up here so that row can stay focused on health/logs. */}
      <div className="workspace-header-left">
        {onToggleSidebar && (
          <button
            className="toolbar-icon-btn"
            onClick={onToggleSidebar}
            title={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
            aria-label={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
            data-education-id="toggle-sidebar"
          >
            <PanelLeftIcon size={12} />
            <span className="toolbar-btn-label">{isSidebarHidden ? 'Show' : 'Hide'}</span>
          </button>
        )}
        <button
          className="toolbar-icon-btn"
          onClick={onOpenAssetsPanel}
          title="Assets"
          data-education-id="assets-button"
        >
          <ImageIcon size={12} />
          <span className="toolbar-btn-label">Assets</span>
        </button>
        <button
          className="toolbar-icon-btn"
          onClick={() => void openUrl(SLACK_INVITE_URL)}
          title="Join the Ship Studio community on Slack"
          data-education-id="support-button"
        >
          <SlackIcon size={12} />
          <span className="toolbar-btn-label">Support</span>
        </button>
        {headerExtras}
        {branchIndicator}
      </div>

      {/* Right side — workspace tabs, GitHub, Publish slot, hosting plugin, Publish */}
      <div className="workspace-header-right">
        {tabs}
        <span data-education-id="github-button">
          <GitHubButton
            githubState={integrations.github}
            projectStatus={integrations.projectGithub}
            projectPath={projectPath}
            projectName={projectName}
            onStatusChange={onGitHubStatusChange}
            onGitHubConnect={onGitHubConnect}
            onModalClose={focusActiveTerminal}
          />
        </span>
        <PluginSlot
          name="publish"
          plugins={getSlotPlugins('publish')}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
        <PluginSlot
          name="toolbar"
          plugins={toolbarPlugins.hosting}
          project={pluginProject}
          actions={pluginActions}
          theme={pluginTheme}
        />
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
        />
      </div>
    </header>
  );

  const supportPanel = (
    <SupportPanel
      isOpen={isSupportPanelOpen}
      onClose={() => setIsSupportPanelOpen(false)}
      projectPath={projectPath}
      projectName={projectName}
    />
  );

  return { titlebar, toolbar, supportPanel };
}
