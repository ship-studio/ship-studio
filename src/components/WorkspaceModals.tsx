/**
 * Workspace modals container component.
 *
 * Renders all modal overlays, panels, and toast notifications used in the
 * workspace view. Extracted from App.tsx to reduce component size.
 *
 * All visibility state is controlled by the parent — this component does
 * not own any state. It is purely a rendering extraction.
 *
 * @module components/WorkspaceModals
 */

import { EnvEditor } from './EnvEditor';
import { LanguagesModal } from './LanguagesModal';
import { BackupsModal } from './BackupsModal';
import { AssetsPanel } from './AssetsPanel';
import { EducationOverlay } from './EducationOverlay';
import { ScreenshotToast, ScreenshotPreviewModal } from './ScreenshotPreview';
import { NotificationSettingsModal } from './NotificationSettingsModal';
import { SkillsModal } from './SkillsModal';
import { McpModal } from './McpModal';
import { PluginManager } from './PluginManager';
import { DevCommandModal } from './DevCommandModal';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { ShopifyStoreModal } from './ShopifyStoreModal';
import { GitErrorHandler } from './GitErrorHandler';
import { SubmitReviewModal } from './SubmitReviewModal';
import { ConflictResolutionModal } from './ConflictResolutionModal';
import { OnboardingTerminal } from './setup';
import { SuccessIcon, InfoIcon, CloseIcon, DownloadIcon, ZapIcon } from './icons';
import type { Toast } from '../hooks/useToasts';
import type { NotificationSettings } from '../lib/sounds';
import type { AgentConfig } from '../lib/agent';
import type { BranchInfo } from '../lib/branches';
import type { AuthTerminalConfig, IntegrationState } from '../hooks/useIntegrationStatus';
import type { LoadedPlugin } from '../hooks/usePlugins';

export interface WorkspaceModalsProps {
  // Project context
  projectPath: string;
  currentProjectPath: string | undefined;

  // BackupsModal
  onBackupRestore: () => void;
  onBackupCreatePR: (branchName: string) => void;

  // EducationOverlay
  isEducationMode: boolean;
  onCloseEducation: () => void;

  // Toasts
  toasts: Toast[];
  dismissToast: (id: number) => void;

  // Screenshot
  screenshotPreviewPath: string | null;
  showScreenshotModal: boolean;
  onDismissScreenshotPreview: () => void;
  onViewScreenshotFull: () => void;
  onCloseScreenshotModal: () => void;

  // Notification settings
  showNotificationSettings: boolean;
  notificationSettings: NotificationSettings;
  onSaveNotificationSettings: (settings: NotificationSettings) => void;
  onCloseNotificationSettings: () => void;
  agentDisplayName: string;

  // Help modal — read state via useModal('help')

  // Skills modal — read state via useModal('skills')
  agentId: string;
  activeAgent: AgentConfig;

  // MCP modal — read state via useModal('mcp')

  // Plugin manager — read state via useModal('pluginManager')
  onPluginsChanged: () => void;
  loadedPlugins?: LoadedPlugin[];

  // Plugin suggestion
  pluginSuggestion: { pluginName: string; projectPath: string; repoUrl: string } | null;
  pluginSuggestionInstalling: boolean;
  onDismissPluginSuggestion: () => void;
  onInstallSuggestedPlugin: () => void;

  // Auto-accept warning
  showAutoAcceptWarning: boolean;
  onCloseAutoAcceptWarning: () => void;
  onAcceptAutoAcceptWarning: () => void;

  // Submit review
  showSubmitReview: string | null;
  branches: BranchInfo[];
  integrations: IntegrationState;
  onSubmitReviewSuccess: () => void;
  onSubmitReviewBranchSwitch?: (branchName: string) => void;
  onSubmitReviewSendToAgent?: (prompt: string) => void;
  onSubmitReviewResolveConflicts?: (headBranch: string, baseBranch: string) => void;
  onCloseSubmitReview: () => void;

  // Git error handler
  gitError: {
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null;
  onCloseGitError: () => void;
  onSendToClaude: (prompt: string) => void;
  onResolveConflicts: () => void;

  // Conflict resolution
  showConflictResolution: boolean;
  hasCurrentProject: boolean;
  onCloseConflictResolution: () => void;
  onConflictsResolved: () => void;

  // Auth terminal
  authTerminalConfig: AuthTerminalConfig | null;
  onCloseAuthTerminal: () => void;
  onAuthTerminalExit: (exitCode: number | null) => void;

  // Dependency install terminal — shown when the user clicks "Install" on
  // the dev server install CTA. Streams pnpm/npm/yarn output.
  installTerminalConfig: {
    projectPath: string;
    packageManager: string;
    cwd: string;
    args: string[];
  } | null;
  installTerminalExited: boolean;
  onCloseInstallTerminal: () => void;
  onInstallTerminalExit: (exitCode: number | null) => void;

  // Dev command modal — read state via useModal('devCommand')
  customDevCommand: string | null;
  onSaveDevCommand: (command: string | null) => void;

  // Project settings — read state via useModal('projectSettings')
  devServerPort: number;
  onSavePort: (port: number) => void;
  isWebProject: boolean;

  // Shopify store modal — read state via useModal('shopifyStore')
  isShopifyTheme: boolean;
  onShopifyStoreSaved: () => void;

  // Plugin terminal
  pluginTerminal: { command: string; args: string[]; title: string } | null;
  pluginTerminalExited: boolean;
  onClosePluginTerminal: () => void;
  onPluginTerminalExit: (exitCode: number | null) => void;
}

export function WorkspaceModals({
  projectPath,
  currentProjectPath,
  onBackupRestore,
  onBackupCreatePR,
  isEducationMode,
  onCloseEducation,
  toasts,
  dismissToast,
  screenshotPreviewPath,
  showScreenshotModal,
  onDismissScreenshotPreview,
  onViewScreenshotFull,
  onCloseScreenshotModal,
  showNotificationSettings,
  notificationSettings,
  onSaveNotificationSettings,
  onCloseNotificationSettings,
  agentDisplayName,
  agentId,
  activeAgent,
  onPluginsChanged,
  loadedPlugins,
  pluginSuggestion,
  pluginSuggestionInstalling,
  onDismissPluginSuggestion,
  onInstallSuggestedPlugin,
  showAutoAcceptWarning,
  onCloseAutoAcceptWarning,
  onAcceptAutoAcceptWarning,
  showSubmitReview,
  branches,
  integrations,
  onSubmitReviewSuccess,
  onSubmitReviewBranchSwitch,
  onSubmitReviewSendToAgent,
  onSubmitReviewResolveConflicts,
  onCloseSubmitReview,
  gitError,
  onCloseGitError,
  onSendToClaude,
  onResolveConflicts,
  showConflictResolution,
  hasCurrentProject,
  onCloseConflictResolution,
  onConflictsResolved,
  authTerminalConfig,
  onCloseAuthTerminal,
  onAuthTerminalExit,
  installTerminalConfig,
  installTerminalExited,
  onCloseInstallTerminal,
  onInstallTerminalExit,
  customDevCommand,
  onSaveDevCommand,
  devServerPort,
  onSavePort,
  isWebProject,
  isShopifyTheme,
  onShopifyStoreSaved,
  pluginTerminal,
  pluginTerminalExited,
  onClosePluginTerminal,
  onPluginTerminalExit,
}: WorkspaceModalsProps) {
  return (
    <>
      <EnvEditor projectPath={projectPath} />

      <LanguagesModal projectPath={projectPath} onSendToClaude={onSendToClaude} />

      <BackupsModal
        projectPath={projectPath}
        onRestore={onBackupRestore}
        onCreatePR={onBackupCreatePR}
      />

      <AssetsPanel projectPath={projectPath} />

      {/* Education Mode Overlay */}
      {isEducationMode && <EducationOverlay onClose={onCloseEducation} />}

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.type}`}>
              <span className="toast-icon">
                {toast.type === 'success' ? <SuccessIcon size={16} /> : <InfoIcon size={16} />}
              </span>
              <span className="toast-message">{toast.message}</span>
              <button className="toast-close" onClick={() => dismissToast(toast.id)}>
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Screenshot Preview Toast */}
      {screenshotPreviewPath && !showScreenshotModal && (
        <ScreenshotToast
          filePath={screenshotPreviewPath}
          onDismiss={onDismissScreenshotPreview}
          onViewFull={onViewScreenshotFull}
        />
      )}

      {/* Screenshot Preview Modal */}
      {showScreenshotModal && screenshotPreviewPath && (
        <ScreenshotPreviewModal filePath={screenshotPreviewPath} onClose={onCloseScreenshotModal} />
      )}

      {/* Notification Settings Modal */}
      {showNotificationSettings && (
        <NotificationSettingsModal
          settings={notificationSettings}
          onSave={onSaveNotificationSettings}
          onClose={onCloseNotificationSettings}
          agentDisplayName={agentDisplayName}
        />
      )}

      {/* HelpModal is mounted globally in <AppGlobalModals> so the command
          palette can open it from any view. */}

      {/* Skills Modal */}
      <SkillsModal
        projectPath={currentProjectPath}
        agentId={agentId}
        agentDisplayName={agentDisplayName}
      />

      {/* MCP Servers Modal */}
      <McpModal
        projectPath={currentProjectPath}
        agentId={agentId}
        agentDisplayName={agentDisplayName}
        agentBinaryName={activeAgent.binaryName}
      />

      {/* Plugin Manager */}
      <PluginManager
        onPluginsChanged={onPluginsChanged}
        projectPath={currentProjectPath ?? null}
        loadedPlugins={loadedPlugins}
      />

      {/* Plugin Suggestion Popup */}
      {pluginSuggestion && (
        <div className="modal-overlay" onClick={onDismissPluginSuggestion}>
          <div className="modal plugin-suggestion-modal" onClick={(e) => e.stopPropagation()}>
            <div className="plugin-suggestion-icon">
              <svg width={26} height={26} viewBox="0 0 76 65" fill="currentColor">
                <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
              </svg>
            </div>
            <h3>Plugin Available</h3>
            <p className="plugin-suggestion-desc">
              This project uses <strong>{pluginSuggestion.pluginName}</strong>. Install the plugin
              to see deployment information.
            </p>
            <div className="plugin-suggestion-actions">
              <button className="plugin-suggestion-dismiss" onClick={onDismissPluginSuggestion}>
                Not Now
              </button>
              <button
                className="plugin-suggestion-install"
                disabled={pluginSuggestionInstalling}
                onClick={onInstallSuggestedPlugin}
              >
                {pluginSuggestionInstalling ? (
                  <>
                    <span className="plugin-suggestion-spinner" />
                    Installing…
                  </>
                ) : (
                  <>
                    <DownloadIcon size={14} />
                    Install Plugin
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Accept Warning Modal */}
      {showAutoAcceptWarning && (
        <div className="modal-overlay" onClick={onCloseAutoAcceptWarning}>
          <div className="modal auto-accept-warning-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auto-accept-warning-icon">
              <ZapIcon size={32} />
            </div>
            <h3>Enable Auto-Accept Mode?</h3>
            <p>
              This mode allows {agentDisplayName} to execute commands{' '}
              <strong>without asking for permission</strong>. {agentDisplayName} will be able to:
            </p>
            <ul className="auto-accept-warning-list">
              <li>Read and modify any files in your project</li>
              <li>Run shell commands automatically</li>
              <li>Make changes without confirmation</li>
            </ul>
            <p className="auto-accept-warning-disclaimer">
              By enabling this mode, you acknowledge that Ship Studio and Anthropic are{' '}
              <strong>not liable</strong> for any unintended changes or actions taken by the AI.
            </p>
            <div className="modal-actions">
              <button onClick={onCloseAutoAcceptWarning}>Cancel</button>
              <button className="btn-warning" onClick={onAcceptAutoAcceptWarning}>
                I understand, enable it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit for Review Modal */}
      {showSubmitReview && (
        <SubmitReviewModal
          projectPath={projectPath}
          branchName={showSubmitReview}
          baseBranches={branches
            .filter((b) => b.isDefault || b.name === 'staging')
            .map((b) => b.name)}
          aiAvailable={integrations.claude.cliStatus.installed}
          onSuccess={onSubmitReviewSuccess}
          onBranchSwitch={onSubmitReviewBranchSwitch}
          onSendToAgent={onSubmitReviewSendToAgent}
          onResolveConflicts={onSubmitReviewResolveConflicts}
          onClose={onCloseSubmitReview}
        />
      )}

      {/* Git Error Handler */}
      {gitError && (
        <GitErrorHandler
          errorType={gitError.errorType}
          errorMessage={gitError.message}
          branchName={gitError.branchName}
          onClose={onCloseGitError}
          onSendToClaude={onSendToClaude}
          onResolveConflicts={onResolveConflicts}
        />
      )}

      {/* Conflict Resolution Modal */}
      {showConflictResolution && hasCurrentProject && (
        <ConflictResolutionModal
          projectPath={projectPath}
          onClose={onCloseConflictResolution}
          onResolved={onConflictsResolved}
        />
      )}

      {/* Auth Terminal Modal (for GitHub connect from workspace) */}
      {authTerminalConfig && (
        <div className="onboarding-terminal-overlay">
          <div className="onboarding-terminal-modal">
            <div className="onboarding-terminal-header">
              <span className="onboarding-terminal-title">GitHub Account</span>
              <button className="onboarding-terminal-cancel" onClick={onCloseAuthTerminal}>
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

      {/* Dependency install overlay — runs `pnpm/npm/yarn install` and
          auto-restarts the dev server on success. */}
      {installTerminalConfig && (
        <div className="onboarding-terminal-overlay">
          <div className="onboarding-terminal-modal">
            <div className="onboarding-terminal-header">
              <span className="onboarding-terminal-title">
                Installing dependencies ({installTerminalConfig.packageManager})
              </span>
              <button className="onboarding-terminal-cancel" onClick={onCloseInstallTerminal}>
                {installTerminalExited ? 'Close' : 'Cancel'}
              </button>
            </div>
            <OnboardingTerminal
              command={installTerminalConfig.packageManager}
              args={installTerminalConfig.args}
              cwd={installTerminalConfig.cwd}
              onExit={onInstallTerminalExit}
            />
          </div>
        </div>
      )}

      {/* Dev Command Modal (web projects still use standalone for "Edit dev command" button) */}
      <DevCommandModal currentCommand={customDevCommand} onSave={onSaveDevCommand} />

      {/* Shopify store connect/change modal */}
      {isShopifyTheme && (
        <ShopifyStoreModal projectPath={projectPath} onStoreSaved={onShopifyStoreSaved} />
      )}

      {/* Project Settings Modal */}
      <ProjectSettingsModal
        currentPort={devServerPort}
        onSave={onSavePort}
        customDevCommand={customDevCommand}
        onSaveDevCommand={onSaveDevCommand}
        isWebProject={isWebProject}
      />

      {/* Plugin terminal modal — reuses OnboardingTerminal for interactive CLI commands */}
      {pluginTerminal && (
        <div className="onboarding-terminal-overlay">
          <div className="onboarding-terminal-modal">
            <div className="onboarding-terminal-header">
              <span className="onboarding-terminal-title">{pluginTerminal.title}</span>
              <button className="onboarding-terminal-cancel" onClick={onClosePluginTerminal}>
                {pluginTerminalExited ? 'Close' : 'Cancel'}
              </button>
            </div>
            <OnboardingTerminal
              command={pluginTerminal.command}
              args={pluginTerminal.args}
              cwd={currentProjectPath}
              onExit={onPluginTerminalExit}
            />
          </div>
        </div>
      )}
    </>
  );
}
