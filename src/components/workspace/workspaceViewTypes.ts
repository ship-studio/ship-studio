import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { AgentConfig } from '../../lib/agent';
import type { BranchInfo, PullRequestInfo } from '../../lib/branches';
import type { PluginThemeData } from '../../contexts/PluginContext';
import type { HealthTabPanelRef } from '../code/HealthTabPanel';
import type { ChangedFile } from '../../lib/git';
import type { DevServerUnexpectedExit, ProjectDevServerSnapshot } from '../../hooks/useDevServer';
import type { AuthTerminalConfig, IntegrationState } from '../../hooks/useIntegrationStatus';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import type { Project } from '../../lib/project';
import type { NotificationSettings } from '../../lib/sounds';
import type { ProjectType } from '../../lib/static-server';
import type { TerminalTab } from '../../hooks/useTerminalManagement';
import type { AgentStatus, TerminalHandle } from '../terminal/Terminal';
import type { Toast, ToastType } from '../../hooks/useToasts';
import type { LoadedPlugin, PluginFailure } from '../../hooks/usePlugins';
import type { PreviewHandle } from '../preview/Preview';
import type { ToggleProjectPinHandler } from './WorkspaceSidebar';

// ---------------------------------------------------------------------------
// Domain-grouped prop interfaces
// ---------------------------------------------------------------------------

interface TerminalSessionView {
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: number;
  sessionEpoch: number;
}

interface TerminalProps {
  terminalTabs: TerminalTab[];
  activeTerminalTab: number;
  terminalSessionId: number;
  /** Every active project's tab state — render Terminal components for
   *  all, hide non-current via CSS so PTYs stay alive. */
  allSessions: TerminalSessionView[];
  terminalRefsMap: MutableRefObject<Map<string, TerminalHandle | null>>;
  maxTerminalTabs: number;
  setActiveTerminalTab: (id: number) => void;
  addTerminalTab: () => void;
  closeTerminalTab: (id: number) => void;
  focusActiveTerminal: () => void;
  switchTabAgent: (tabId: number, agentId: string) => void;
  restartTerminalTab: (tabId: number, projectPath?: string) => void;
  /** Forget a tab's opening prompt once its agent has spawned with it. */
  clearInitialPrompt: (tabId: number, projectPath?: string) => void;
  getActiveTabAgent: () => AgentConfig;
  /** Side-by-side view: tab ids visible in panes, or null when off. */
  splitPaneTabIds: number[] | null;
  /** Width of each pane as a percentage (sums to 100). Null when split off. */
  splitPaneSizes: number[] | null;
  enableSplitView: () => void;
  disableSplitView: () => void;
  setSplitPaneTab: (paneIndex: number, tabId: number) => void;
  addSplitPane: (tabId?: number) => void;
  removeSplitPane: (paneIndex: number) => void;
  setSplitPaneSizes: (sizes: number[]) => void;
}

interface DevServerProps {
  hasDevServer: boolean;
  knownDevServerPort: number | null;
  healthPanelRef: RefObject<HealthTabPanelRef | null>;
  devServerPort: number;
  projectType: ProjectType;
  projectTypeResolved: boolean;
  isRestartingDevServer: boolean;
  /** `custom`: the user-configured dev command. `generic`: what a `generic`
   *  project actually runs — the custom command, else its package.json `dev`
   *  script (#1105); null when it has neither. */
  devCommands: { custom: string | null; generic: string | null };
  devServerOutput: string;
  devServerOutputVersion: number;
  healthOutput: string;
  healthOutputVersion: number;
  handleHealthOutput: (data: string) => void;
  needsInstall: { packageManager: string } | null;
  /** Set when the dev-server process died without Ship Studio stopping it
   *  (crash / external kill). Lets the Preview offer a real process restart. */
  devServerUnexpectedExit: DevServerUnexpectedExit | null;
  onRunInstall: () => void;
  /** Path-scoped install trigger — used to auto-install a fresh worktree's
   *  dependencies without waiting for the Preview CTA click. */
  onRunInstallFor: (projectPath: string, packageManager: string) => void;
  /** Type into the dev-server PTY (interactive CLI prompts in the logs pane). */
  onDevServerInput: (data: string) => void;
  /** Sync the dev-server PTY size to the logs terminal. */
  onDevServerResize: (cols: number, rows: number) => void;
}

interface NotificationProps {
  notificationSettings: NotificationSettings;
  showNotificationSettings: boolean;
  setShowNotificationSettings: (show: boolean) => void;
  attentionTabs: Set<number>;
  setAttentionTabs: Dispatch<SetStateAction<Set<number>>>;
  createTabStatusHandler: (
    projectPath: string,
    tabId: number
  ) => (status: AgentStatus, title: string) => void;
  handleSaveNotificationSettings: (settings: NotificationSettings) => void;
}

interface IntegrationProps {
  integrations: IntegrationState;
  handleGitHubConnect: () => void;
  authTerminalConfig: AuthTerminalConfig | null;
  closeAuthTerminal: () => void;
  handleAuthTerminalExit: (exitCode: number | null, projectPath?: string) => void;
  installTerminalConfig: {
    projectPath: string;
    packageManager: string;
    cwd: string;
    args: string[];
  } | null;
  installTerminalExited: boolean;
  onCloseInstallTerminal: () => void;
  onInstallTerminalExit: (exitCode: number | null, outputTail: string) => void;
}

interface ScreenshotProps {
  isCapturing: boolean;
  isCropMode: boolean;
  setIsCropMode: (mode: boolean) => void;
  isCropCapturing: boolean;
  isFullPageCapturing: boolean;
  screenshotPreviewPath: string | null;
  setScreenshotPreviewPath: (path: string | null) => void;
  showScreenshotModal: boolean;
  setShowScreenshotModal: (show: boolean) => void;
  handleCaptureScreenshot: () => Promise<void>;
  handleCaptureFullPage: () => Promise<void>;
  handleCropStart: () => void;
  handleCropComplete: (filePath: string | null) => void;
  handleCropCancel: () => void;
}

interface LayoutProps {
  showHealthLogs: boolean;
  setShowHealthLogs: (show: boolean) => void;
  isPreviewHidden: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  workspaceTab: 'preview' | 'code' | 'branches' | 'prs';
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
}

interface PluginStateProps {
  pluginTerminal: {
    command: string;
    args: string[];
    title: string;
    resolve: (exitCode: number | null) => void;
  } | null;
  pluginTerminalExited: boolean;
  closePluginTerminal: () => void;
  handlePluginTerminalExit: (exitCode: number | null) => void;
  pluginSuggestion: { pluginName: string; projectPath: string; repoUrl: string } | null;
  setPluginSuggestion: (s: null) => void;
  pluginSuggestionInstalling: boolean;
  installSuggestedPlugin: (
    onSuccess: (msg: string) => void,
    onError: (msg: string) => void,
    reloadPlugins: () => Promise<void>
  ) => Promise<void>;
}

interface ModalProps {
  isEducationMode: boolean;
  setIsEducationMode: (mode: boolean) => void;
  closeEducation: () => void;
}

interface ToastProps {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
}

interface BranchProps {
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  showSubmitReview: string | null;
  setShowSubmitReview: (branch: string | null) => void;
  isBranchSwitching: boolean;
  isPulling: boolean;
  gitError: {
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null;
  setGitError: (
    error: {
      errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
      message: string;
      branchName: string;
    } | null
  ) => void;
  showConflictResolution: boolean;
  setShowConflictResolution: (show: boolean) => void;
  /** Whether the repository is mid-merge, as opposed to whether the resolution
   *  panel is on screen. Polled, so a merge started in a terminal counts. */
  repoHasConflicts: boolean;
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  checkGitStatus: (projectPath: string) => Promise<void>;
  handleBranchSwitch: (branchName: string) => Promise<void>;
  handlePullLatest: () => Promise<void>;
  handlePublishError: (
    error: string,
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic'
  ) => void;
  handleResolveConflicts: (headBranch?: string, baseBranch?: string) => Promise<void>;
  handleConflictsResolved: () => void;
}

interface PluginProps {
  loadedPlugins: LoadedPlugin[];
  pluginFailures: PluginFailure[];
  getSlotPlugins: (slotName: string) => LoadedPlugin[];
  reloadPlugins: () => Promise<void>;
}

interface LifecycleProps {
  autoAcceptMode: boolean;
  setCurrentPreviewPage: (page: string) => void;
  isPublishing: boolean;
  setIsPublishing: (p: boolean) => void;
  forcePublishOpen: boolean;
  setForcePublishOpen: (open: boolean) => void;
  showAutoAcceptWarning: boolean;
  setShowAutoAcceptWarning: (show: boolean) => void;
  handleBackToProjects: () => void;
  handleRestartDevServer: () => Promise<void>;
  /** Start the dev server on demand — fired when the Preview tab is selected
   *  while nothing is running, so picking Preview always yields a preview. */
  handleStartDevServer: () => Promise<void>;
  handleGitHubStatusChange: () => void;
  handlePreviewReady: () => void;
  sendToClaude: (text: string) => unknown;
  handleTerminalExit: (code: number | null) => void;
  handleToolbarAutoAcceptToggle: () => void;
  handleAutoAcceptWarningAccept: () => void;
  handleSaveDevCommand: (command: string | null) => void;
  handleSavePort: (port: number) => void;
}

// ---------------------------------------------------------------------------
// WorkspaceViewProps
// ---------------------------------------------------------------------------

/** Plugin project data as constructed by App.tsx (devServerUrl always present) */
interface WorkspacePluginProject {
  name: string;
  path: string;
  currentBranch: string;
  hasUncommittedChanges: boolean;
  devServerUrl: string;
}

/** Plugin actions as constructed by App.tsx (showToast includes 'info') */
interface WorkspacePluginActions {
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
}

export interface WorkspaceViewProps {
  currentProject: Project;
  previewRef: RefObject<PreviewHandle | null>;
  terminal: TerminalProps;
  devServer: DevServerProps;
  notifications: NotificationProps;
  integrationStatus: IntegrationProps;
  screenshots: ScreenshotProps;
  layout: LayoutProps;
  pluginState: PluginStateProps;
  modals: ModalProps;
  toasts: ToastProps;
  branchMgmt: BranchProps;
  plugins: PluginProps;
  lifecycle: LifecycleProps;
  pluginProject: WorkspacePluginProject | null;
  pluginActions: WorkspacePluginActions;
  pluginTheme: PluginThemeData;
  /** Project list shown in the workspace sidebar. */
  projectRows: PinnedProjectRow[];
  /** Switch to a different project from the sidebar. */
  onSelectProject: (projectPath: string) => void;
  /** Close an active project session from the sidebar. */
  onCloseProject: (projectPath: string) => void;
  /** Rename a project folder from the sidebar context menu. */
  onRenameProject?: (projectPath: string, newName: string) => Promise<void>;
  /** Toggle a project's pin state from the sidebar context menu. */
  onTogglePinProject?: ToggleProjectPinHandler;
  /** Stop a project's dev server from the sidebar context menu. */
  onStopDevServer?: (projectPath: string) => void | Promise<void>;
  /** Switch to another project and focus a specific tab (by session id). */
  onSelectProjectTab: (projectPath: string, tabSessionId: string) => void;
  /** Navigate to the Home (projects) view. */
  onGoHome: () => void;
  /** Home-level destinations, kept reachable from inside a project. */
  homeNav?: {
    onGoWorkflows: () => void;
    onGoInbox: () => void;
    inboxUnreadCount: number;
    /** Switch to Agents mode, from the sidebar's mode toggle or the compact top bar. */
    onGoAgents?: () => void;
  };
  /** Open the project picker modal. */
  onOpenProjectPicker: () => void;
  /** Open the "Switch Workspace" picker from the sidebar footer. */
  onSwitchAccount: () => void;
  /** Unpin a project from the sidebar (used for rows without a live session,
   *  including pins whose folder no longer exists — issue #366). */
  onUnpinProject?: (projectPath: string) => void;
  /** Persist a reordered pinned-project list through the feature adapter. */
  onReorderProjects?: (orderedPaths: string[]) => Promise<void> | void;
  /** Predicate: is a dev server currently tracked for the given project path?
   *  Used by the sidebar to populate background projects' Commands section. */
  isProjectDevServerRunning: (projectPath: string) => boolean;
  /** Known server address/lifecycle for project rows and warm Preview reuse. */
  getProjectDevServerSnapshot: (projectPath: string) => ProjectDevServerSnapshot;
  /** Re-render project rows when background server lifecycles change. */
  devServerLifecycleVersion: number;
  /** Whether the shared project sidebar is in its compact state. */
  isSidebarHidden: boolean;
  /** Toggle the shared project sidebar between full and compact states. */
  onToggleSidebar: () => void;
  /** Whether workspace controls are consolidated into the window titlebar. */
  compactWorkspaceToolbarEnabled: boolean;
}
