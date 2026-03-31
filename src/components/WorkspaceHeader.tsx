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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { GitHubButton } from './GitHubButton';
import { checkIdeAvailability, openInIde as launchIde, openInFinder } from '../lib/ide';
import { PublishBranchDropdown } from './PublishBranchDropdown';
import { PluginSlot } from './PluginSlot';
import {
  CodeIcon,
  VSCodeIcon,
  CursorIcon,
  ImageIcon,
  GraduationCapIcon,
  HistoryIcon,
  DollarIcon,
  PuzzleIcon,
  HelpIcon,
} from './icons';
import { SupportPanel } from './support/SupportPanel';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import type { IntegrationState } from '../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../hooks/usePlugins';
import type { PluginThemeData } from '../contexts/PluginContext';

const HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare', 'netlify'];

export interface WorkspaceHeaderProps {
  // Project
  projectPath: string;
  projectName: string;

  // Navigation
  onBackToProjects: () => void;

  // Education mode
  isEducationMode: boolean;
  onToggleEducationMode: () => void;

  // Modal openers
  onOpenPluginManager: () => void;
  onOpenAssetsPanel: () => void;
  onOpenEnvEditor: () => void;
  onOpenBackupsModal: () => void;

  // GitHub
  integrations: IntegrationState;
  onGitHubStatusChange: () => void;
  onGitHubConnect: () => void;
  focusActiveTerminal: () => void;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;

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
  onBackToProjects,
  isEducationMode,
  onToggleEducationMode,
  onOpenPluginManager,
  onOpenAssetsPanel,
  onOpenEnvEditor,
  onOpenBackupsModal,
  integrations,
  onGitHubStatusChange,
  onGitHubConnect,
  focusActiveTerminal,
  onToast,
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

  // IDE dropdown state (internal to header)
  const [showIdeDropdown, setShowIdeDropdown] = useState(false);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  const [openingIde, setOpeningIde] = useState<string | null>(null);

  // Check IDE availability on mount
  useEffect(() => {
    void checkIdeAvailability()
      .then(setIdeAvailability)
      .catch(() => setIdeAvailability({ vscode: false, cursor: false }));
  }, []);

  // Open project in IDE
  const openInIde = async (ide: 'vscode' | 'cursor') => {
    setOpeningIde(ide);
    try {
      await launchIde(projectPath, ide);
      void trackEvent('ide_opened', {
        ide,
        project_name: projectName,
        $screen_name: 'Workspace',
      });
      setOpeningIde(null);
    } catch (e) {
      logger.error(`Failed to open in ${ide}`, { error: e });
      setOpeningIde(null);
    }
  };

  return (
    <>
      <div
        className="workspace-titlebar"
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      >
        <button className="back-link" onClick={onBackToProjects}>
          ← Projects
        </button>
        <h1>{projectName}</h1>
        <button
          className="project-path"
          onClick={() => projectPath && void openInFinder(projectPath)}
          title="Open in Finder"
        >
          {projectPath}
        </button>
      </div>
      <header className="workspace-header">
        {/* Left side — utility buttons + plugin toolbar slots */}
        <div className="workspace-header-left">
          <button
            className="toolbar-icon-btn"
            onClick={onOpenBackupsModal}
            title="Backups"
            data-education-id="backups-button"
          >
            <HistoryIcon size={12} />
          </button>
          <button
            className="toolbar-icon-btn"
            onClick={onOpenEnvEditor}
            title="Environment Variables"
            data-education-id="env-button"
          >
            <DollarIcon size={12} />
          </button>
          <button
            className="toolbar-icon-btn"
            onClick={() => setIsSupportPanelOpen(true)}
            title="Support"
            data-education-id="support-button"
          >
            <HelpIcon size={12} />
          </button>
          <button
            className="toolbar-icon-btn"
            onClick={onOpenAssetsPanel}
            title="Assets"
            data-education-id="assets-button"
          >
            <ImageIcon size={12} />
          </button>
          <button
            className={`toolbar-icon-btn ${isEducationMode ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleEducationMode();
            }}
            title="Education Mode"
            data-education-id="education-button"
          >
            <GraduationCapIcon size={12} />
          </button>
          <button
            className="toolbar-icon-btn"
            onClick={onOpenPluginManager}
            title="Manage Plugins"
            data-education-id="plugin-manager"
          >
            <PuzzleIcon size={12} />
          </button>
          <div
            className="ide-dropdown-container"
            onMouseEnter={() => setShowIdeDropdown(true)}
            onMouseLeave={() => setShowIdeDropdown(false)}
            data-education-id="ide-button"
          >
            <button className="toolbar-icon-btn" title="Open in IDE">
              <CodeIcon size={12} />
            </button>
            {showIdeDropdown && (
              <div className="ide-dropdown">
                <div className="ide-dropdown-inner">
                  {ideAvailability.vscode && (
                    <button onClick={() => void openInIde('vscode')} disabled={openingIde !== null}>
                      <VSCodeIcon size={14} />
                      {openingIde === 'vscode' ? 'Opening...' : 'VS Code'}
                    </button>
                  )}
                  {ideAvailability.cursor && (
                    <button onClick={() => void openInIde('cursor')} disabled={openingIde !== null}>
                      <CursorIcon size={14} />
                      {openingIde === 'cursor' ? 'Opening...' : 'Cursor'}
                    </button>
                  )}
                  {!ideAvailability.vscode && !ideAvailability.cursor && (
                    <div className="ide-dropdown-empty">No IDEs found</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <PluginSlot
            name="toolbar"
            plugins={toolbarPlugins.regular}
            project={pluginProject}
            actions={pluginActions}
            theme={pluginTheme}
          />
        </div>

        {/* Right side — hosting plugin, GitHub, Publish */}
        <div className="workspace-header-right">
          <PluginSlot
            name="toolbar"
            plugins={toolbarPlugins.hosting}
            project={pluginProject}
            actions={pluginActions}
            theme={pluginTheme}
          />
          <PluginSlot
            name="publish"
            plugins={getSlotPlugins('publish')}
            project={pluginProject}
            actions={pluginActions}
            theme={pluginTheme}
          />
          <span data-education-id="github-button">
            <GitHubButton
              githubState={integrations.github}
              projectStatus={integrations.projectGithub}
              projectPath={projectPath}
              projectName={projectName}
              onStatusChange={onGitHubStatusChange}
              onGitHubConnect={onGitHubConnect}
              onModalClose={focusActiveTerminal}
              onToast={onToast}
            />
          </span>
          <PublishBranchDropdown
            currentBranch={currentBranch || 'main'}
            projectGithubStatus={integrations.projectGithub}
            projectPath={projectPath}
            hasChangesToSync={hasUncommittedChanges}
            onStatusChange={onPublishStatusChange}
            onModalClose={focusActiveTerminal}
            onToast={onToast}
            isPublishing={isPublishing}
            setIsPublishing={setIsPublishing}
            onPublishError={onPublishError}
            onCreatePR={onCreatePR}
            forceOpen={forcePublishOpen}
            onForceOpenHandled={onForcePublishOpenHandled}
          />
        </div>
      </header>
      <SupportPanel
        isOpen={isSupportPanelOpen}
        onClose={() => setIsSupportPanelOpen(false)}
        projectPath={projectPath}
        projectName={projectName}
      />
    </>
  );
}
