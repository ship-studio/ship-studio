/**
 * Workspace modal host.
 *
 * Keeps the workspace orchestrator focused on state and event wiring while
 * grouping the modal render contract by the domain that supplies it.
 */

import type { WorkspaceModalsProps } from './WorkspaceModals';
import { WorkspaceModals } from './WorkspaceModals';

type ModalGroup<Key extends keyof WorkspaceModalsProps> = Pick<WorkspaceModalsProps, Key>;

/** Props and handlers supplied to workspace-scoped modal flows. */
export interface WorkspaceModalHostProps {
  projectPath: string;
  currentProjectPath: string | undefined;
  backups: ModalGroup<'onBackupRestore' | 'onBackupCreatePR'>;
  education: ModalGroup<'isEducationMode' | 'onCloseEducation'>;
  toasts: ModalGroup<'toasts' | 'dismissToast'>;
  screenshots: ModalGroup<
    | 'screenshotPreviewPath'
    | 'showScreenshotModal'
    | 'onDismissScreenshotPreview'
    | 'onViewScreenshotFull'
    | 'onCloseScreenshotModal'
  >;
  notification: ModalGroup<
    | 'showNotificationSettings'
    | 'notificationSettings'
    | 'onSaveNotificationSettings'
    | 'onCloseNotificationSettings'
    | 'agentDisplayName'
  >;
  extensions: ModalGroup<'agentId' | 'activeAgent' | 'onPluginsChanged' | 'loadedPlugins'>;
  pluginSuggestion: ModalGroup<
    | 'pluginSuggestion'
    | 'pluginSuggestionInstalling'
    | 'onDismissPluginSuggestion'
    | 'onInstallSuggestedPlugin'
  >;
  autoAccept: ModalGroup<
    'showAutoAcceptWarning' | 'onCloseAutoAcceptWarning' | 'onAcceptAutoAcceptWarning'
  >;
  review: ModalGroup<
    | 'showSubmitReview'
    | 'branches'
    | 'integrations'
    | 'onSubmitReviewSuccess'
    | 'onSubmitReviewBranchSwitch'
    | 'onSubmitReviewSendToAgent'
    | 'onSubmitReviewResolveConflicts'
    | 'onCloseSubmitReview'
  >;
  git: ModalGroup<'gitError' | 'onCloseGitError' | 'onSendToClaude' | 'onResolveConflicts'>;
  conflicts: ModalGroup<
    'showConflictResolution' | 'onCloseConflictResolution' | 'onConflictsResolved'
  >;
  authTerminal: ModalGroup<'authTerminalConfig' | 'onCloseAuthTerminal' | 'onAuthTerminalExit'>;
  installTerminal: ModalGroup<
    | 'installTerminalConfig'
    | 'installTerminalExited'
    | 'onCloseInstallTerminal'
    | 'onInstallTerminalExit'
  >;
  devCommand: ModalGroup<'customDevCommand' | 'onSaveDevCommand'>;
  projectSettings: ModalGroup<'devServerPort' | 'onSavePort' | 'isWebProject'>;
  shopify: ModalGroup<'isShopifyTheme' | 'onShopifyStoreSaved'>;
  worktree: ModalGroup<'currentBranch' | 'worktrees' | 'onWorktreeCreated'>;
  pluginTerminal: ModalGroup<
    'pluginTerminal' | 'pluginTerminalExited' | 'onClosePluginTerminal' | 'onPluginTerminalExit'
  >;
}

/** Mounts workspace-scoped modals while keeping their state out of the main view orchestrator. */
export function WorkspaceModalHost({
  projectPath,
  currentProjectPath,
  backups,
  education,
  toasts,
  screenshots,
  notification,
  extensions,
  pluginSuggestion,
  autoAccept,
  review,
  git,
  conflicts,
  authTerminal,
  installTerminal,
  devCommand,
  projectSettings,
  shopify,
  worktree,
  pluginTerminal,
}: WorkspaceModalHostProps) {
  return (
    <WorkspaceModals
      projectPath={projectPath}
      currentProjectPath={currentProjectPath}
      {...backups}
      {...education}
      {...toasts}
      {...screenshots}
      {...notification}
      {...extensions}
      {...pluginSuggestion}
      {...autoAccept}
      {...review}
      {...git}
      {...conflicts}
      hasCurrentProject
      {...authTerminal}
      {...installTerminal}
      {...devCommand}
      {...projectSettings}
      {...shopify}
      {...worktree}
      {...pluginTerminal}
    />
  );
}
