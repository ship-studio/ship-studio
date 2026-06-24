/**
 * Projects dashboard view.
 *
 * Displays the project list, changelog sidebar, create/import modals,
 * and GitHub auth terminal. Extracted from App.tsx to reduce root component size.
 *
 * @module components/ProjectsView
 */

import { memo } from 'react';
import { ProjectList } from './ProjectList';
import { CreateProject } from './CreateProject';
import { ImportProject } from './ImportProject';
import { ImportTypePicker } from './ImportTypePicker';
import { PluginSlot } from '../plugins/PluginSlot';
import { UpdateBanner } from '../UpdateBanner';
import { OnboardingTerminal } from '../setup';
import type { Project } from '../../lib/project';
import type { AuthTerminalConfig } from '../../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type {
  PluginProjectData,
  PluginAppActions,
  PluginThemeData,
} from '../../contexts/PluginContext';

interface ProjectsViewProps {
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
  onImportProject: () => void;
  onImportLocalFolder: () => void;

  isGitHubAuthenticated: boolean;
  githubUsername: string | null;
  isAuthCheckDone: boolean;
  onGitHubConnect: () => void;

  showCreateModal: boolean;
  onCloseCreateModal: () => void;
  onProjectCreated: (projectPath: string) => void;
  importView: 'none' | 'picker' | 'github';
  setImportView: (view: 'none' | 'picker' | 'github') => void;
  onProjectImported: (projectPath: string) => void;

  authTerminalConfig: AuthTerminalConfig | null;
  closeAuthTerminal: () => void;
  onAuthTerminalExit: (exitCode: number | null) => void;

  pluginProject: PluginProjectData | null;
  pluginActions: PluginAppActions;
  pluginTheme: PluginThemeData;
  getSlotPlugins: (slot: string) => LoadedPlugin[];

  projectsLoading: boolean;
  onLoadingChange: (loading: boolean) => void;
  cleanupStatus?: string | null;

  /** Set of currently pinned project paths (for menu state). */
  pinnedSet?: ReadonlySet<string>;
  /** Toggle pin state for a project. */
  onTogglePin?: (projectPath: string, pinned: boolean) => void;
  /** Open the workspace switcher (chip beside "All Projects"). */
  onSwitchAccount?: () => void;
}

export const ProjectsView = memo(function ProjectsView({
  onSelectProject,
  onCreateProject,
  onImportProject,
  onImportLocalFolder,
  isGitHubAuthenticated,
  githubUsername,
  isAuthCheckDone,
  onGitHubConnect,
  showCreateModal,
  onCloseCreateModal,
  onProjectCreated,
  importView,
  setImportView,
  onProjectImported,
  authTerminalConfig,
  closeAuthTerminal,
  onAuthTerminalExit,
  pluginProject,
  pluginActions,
  pluginTheme,
  getSlotPlugins,
  projectsLoading,
  onLoadingChange,
  cleanupStatus,
  pinnedSet,
  onTogglePin,
  onSwitchAccount,
}: ProjectsViewProps) {
  return (
    <>
      <div className="app">
        <UpdateBanner />
        <div className="dashboard-with-changelog">
          <ProjectList
            onSelectProject={(project) => void onSelectProject(project)}
            onCreateProject={onCreateProject}
            onImportProject={onImportProject}
            isGitHubAuthenticated={isGitHubAuthenticated}
            onGitHubConnectForImport={() => void onGitHubConnect()}
            githubUsername={githubUsername}
            isAuthCheckDone={isAuthCheckDone}
            onLoadingChange={onLoadingChange}
            cleanupStatus={cleanupStatus}
            pinnedSet={pinnedSet}
            onTogglePin={onTogglePin}
            onSwitchAccount={onSwitchAccount}
          />
          {!projectsLoading && (
            <PluginSlot
              name="sidebar"
              plugins={getSlotPlugins('sidebar')}
              project={pluginProject}
              actions={pluginActions}
              theme={pluginTheme}
            />
          )}
        </div>
        {showCreateModal && (
          <CreateProject onComplete={onProjectCreated} onCancel={onCloseCreateModal} />
        )}
        {importView === 'picker' && (
          <ImportTypePicker
            onSelectGitHub={() => setImportView('github')}
            onSelectLocalFolder={() => void onImportLocalFolder()}
            onClose={() => setImportView('none')}
          />
        )}
        {importView === 'github' && (
          <ImportProject onComplete={onProjectImported} onCancel={() => setImportView('none')} />
        )}

        {/* Auth Terminal Modal (for GitHub connect from projects view) */}
        {authTerminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">GitHub Account</span>
                <button className="onboarding-terminal-cancel" onClick={() => closeAuthTerminal()}>
                  Cancel
                </button>
              </div>
              <OnboardingTerminal
                command={authTerminalConfig.command}
                args={authTerminalConfig.args}
                onExit={onAuthTerminalExit}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
});
