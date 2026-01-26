/**
 * Main application component and state management.
 *
 * This is the root component that orchestrates:
 * - Application views (loading, setup, projects, workspace)
 * - Integration state (GitHub, Vercel, Claude CLI status)
 * - Project management (opening, creating, dev server lifecycle)
 * - Terminal and preview panel coordination
 * - Periodic screenshot capture for thumbnails
 * - Toast notifications
 *
 * State is managed via React's useReducer for atomic integration updates
 * and useState for simpler local state.
 *
 * @module App
 */

import { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { Terminal, TerminalHandle } from './components/Terminal';
import { DevServerLogs } from './components/DevServerLogs';
import { Preview, PreviewHandle } from './components/Preview';
import { ProjectList } from './components/ProjectList';
import { CreateProject } from './components/CreateProject';
import { ImportProject } from './components/ImportProject';
import { OnboardingScreen } from './components/setup';
import { SplitPane } from './components/SplitPane';
import { GitHubButton } from './components/GitHubButton';
import { VercelButton } from './components/VercelButton';
import { PublishBranchDropdown } from './components/PublishBranchDropdown';
import { EnvEditor } from './components/EnvEditor';
import { AssetsPanel } from './components/AssetsPanel';
import { BranchIndicator } from './components/BranchIndicator';
import { BranchesTab } from './components/BranchesTab';
import { PullRequestsTab } from './components/PullRequestsTab';
import { GitErrorHandler } from './components/GitErrorHandler';
import { SubmitReviewModal } from './components/SubmitReviewModal';
import { ConflictResolutionModal } from './components/ConflictResolutionModal';
import {
  BranchInfo,
  listBranches,
  getCurrentBranch,
  switchBranch,
  pullAndMerge,
} from './lib/branches';
import {
  CodeIcon,
  ChatIcon,
  CameraIcon,
  CropIcon,
  SuccessIcon,
  InfoIcon,
  CloseIcon,
  VSCodeIcon,
  CursorIcon,
  BranchIcon,
  PullRequestIcon,
  EyeIcon,
  PanelRightIcon,
  PlusIcon,
  ImageIcon,
  TerminalIcon,
  ExternalLinkIcon,
} from './components/icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { startDevServer, Project, DevServerHandle } from './lib/project';
import {
  checkGitHubCliStatus,
  getGitHubUsername,
  getProjectGitHubStatus,
  GitHubCliStatus,
  ProjectGitHubStatus,
} from './lib/github';
import { getChangedFiles, ChangedFile } from './lib/git';
import {
  checkVercelCliStatus,
  getVercelUsername,
  getProjectVercelStatus,
  VercelCliStatus,
  ProjectVercelStatus,
} from './lib/vercel';
import { checkClaudeCliStatus, ClaudeCliStatus } from './lib/claude';
import { getFullSetupStatus } from './lib/setup';
import { UpdateBanner } from './components/UpdateBanner';
import { invoke } from '@tauri-apps/api/core';
import { logger } from './lib/logger';
import './styles/index.css';

// Initialize logger
logger.init();

/** Interval between automatic screenshot captures (5 minutes) */
const SCREENSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** Delay after page load before capturing screenshot (2 seconds) */
const SCREENSHOT_DELAY_MS = 2000;
/** Preferred port for Next.js dev server (will find available port if taken) */
const PREFERRED_DEV_SERVER_PORT = 3000;

/** Current application view/screen */
type AppView = 'loading' | 'onboarding' | 'projects' | 'project-loading' | 'workspace';

/** Global GitHub CLI and authentication state */
export interface GitHubState {
  /** CLI installation and auth status */
  cliStatus: GitHubCliStatus;
  /** Authenticated username or null */
  username: string | null;
}

/** Global Vercel CLI and authentication state */
export interface VercelState {
  /** CLI installation and auth status */
  cliStatus: VercelCliStatus;
  /** Authenticated username or null */
  username: string | null;
}

/** Global Claude CLI state */
export interface ClaudeState {
  /** CLI installation status and version */
  cliStatus: ClaudeCliStatus;
}

/**
 * Consolidated integration state for all external services.
 * Managed via useReducer for atomic updates to prevent race conditions.
 */
interface IntegrationState {
  /** GitHub CLI and auth state */
  github: GitHubState;
  /** Current project's GitHub repo status */
  projectGithub: ProjectGitHubStatus | null;
  /** Vercel CLI and auth state */
  vercel: VercelState;
  /** Current project's Vercel deployment status */
  projectVercel: ProjectVercelStatus | null;
  /** Claude CLI state */
  claude: ClaudeState;
}

type IntegrationAction =
  | { type: 'SET_GITHUB'; payload: GitHubState }
  | { type: 'SET_PROJECT_GITHUB'; payload: ProjectGitHubStatus | null }
  | { type: 'SET_VERCEL'; payload: VercelState }
  | { type: 'SET_PROJECT_VERCEL'; payload: ProjectVercelStatus | null }
  | { type: 'SET_CLAUDE'; payload: ClaudeState }
  | { type: 'CLEAR_PROJECT_STATUSES' }
  | {
      type: 'SET_ALL_CLI';
      payload: { github: GitHubState; vercel: VercelState; claude: ClaudeState };
    }
  | {
      type: 'SET_PROJECT_STATUSES';
      payload: { github: ProjectGitHubStatus | null; vercel: ProjectVercelStatus | null };
    };

const initialIntegrationState: IntegrationState = {
  github: { cliStatus: { installed: false, authenticated: false }, username: null },
  projectGithub: null,
  vercel: { cliStatus: { installed: false, authenticated: false }, username: null },
  projectVercel: null,
  claude: { cliStatus: { installed: false, version: null } },
};

function integrationReducer(state: IntegrationState, action: IntegrationAction): IntegrationState {
  switch (action.type) {
    case 'SET_GITHUB':
      return { ...state, github: action.payload };
    case 'SET_PROJECT_GITHUB':
      return { ...state, projectGithub: action.payload };
    case 'SET_VERCEL':
      return { ...state, vercel: action.payload };
    case 'SET_PROJECT_VERCEL':
      return { ...state, projectVercel: action.payload };
    case 'SET_CLAUDE':
      return { ...state, claude: action.payload };
    case 'CLEAR_PROJECT_STATUSES':
      return { ...state, projectGithub: null, projectVercel: null };
    case 'SET_ALL_CLI':
      return {
        ...state,
        github: action.payload.github,
        vercel: action.payload.vercel,
        claude: action.payload.claude,
      };
    case 'SET_PROJECT_STATUSES':
      return {
        ...state,
        projectGithub: action.payload.github,
        projectVercel: action.payload.vercel,
      };
    default:
      return state;
  }
}

function App() {
  const [view, setView] = useState<AppView>('loading');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const devServerRef = useRef<DevServerHandle | null>(null);
  const terminalRefsMap = useRef<Map<number, TerminalHandle | null>>(new Map());
  const previewRef = useRef<PreviewHandle | null>(null);
  const screenshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);

  // Terminal tabs state
  const [terminalTabs, setTerminalTabs] = useState<number[]>([1]);
  const [activeTerminalTab, setActiveTerminalTab] = useState(1);
  const terminalTabCounterRef = useRef(1);
  const [terminalSessionId, setTerminalSessionId] = useState(1); // Changes when project changes to force remount
  const MAX_TERMINAL_TABS = 5;

  // Dev server logs state
  const [showDevServerLogs, setShowDevServerLogs] = useState(false);
  const devServerOutputRef = useRef<string>(''); // Buffer output for when logs tab opens
  const [devServerOutputVersion, setDevServerOutputVersion] = useState(0); // Triggers re-render when output changes

  // Integration states consolidated via reducer for atomic updates
  const [integrations, dispatch] = useReducer(integrationReducer, initialIntegrationState);

  // Capture state for screenshot button
  const [isCapturing, setIsCapturing] = useState(false);
  const [isCropMode, setIsCropMode] = useState(false);
  const [isCropCapturing, setIsCropCapturing] = useState(false);

  // Dev server port (dynamically assigned to avoid conflicts)
  const [devServerPort, setDevServerPort] = useState(PREFERRED_DEV_SERVER_PORT);

  // Env editor modal
  const [showEnvEditor, setShowEnvEditor] = useState(false);

  // Assets panel modal
  const [showAssetsPanel, setShowAssetsPanel] = useState(false);

  // Create project modal
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Import project modal
  const [showImportModal, setShowImportModal] = useState(false);

  // IDE dropdown
  const [showIdeDropdown, setShowIdeDropdown] = useState(false);
  const [ideAvailability, setIdeAvailability] = useState<{ vscode: boolean; cursor: boolean }>({
    vscode: false,
    cursor: false,
  });
  const [openingIde, setOpeningIde] = useState<string | null>(null);

  // Current preview page (tracked for potential future use)
  const [, setCurrentPreviewPage] = useState('/');

  // Toast notifications
  const [toasts, setToasts] = useState<
    Array<{ id: number; message: string; type: 'success' | 'error' }>
  >([]);
  const toastIdRef = useRef(0);

  // Publishing state (lifted from PublishDropdown so button shows "Publishing..." even when dropdown closed)
  const [isPublishing, setIsPublishing] = useState(false);

  // Vercel auto-connecting state (when linking after GitHub repo creation)
  const [isVercelAutoConnecting, setIsVercelAutoConnecting] = useState(false);

  // Branch management state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [showSubmitReview, setShowSubmitReview] = useState<string | null>(null);
  const [isBranchSwitching, setIsBranchSwitching] = useState(false);
  const [gitError, setGitError] = useState<{
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null>(null);

  // Conflict resolution modal state
  const [showConflictResolution, setShowConflictResolution] = useState(false);

  // Workspace tab state (preview/branches/prs)
  const [workspaceTab, setWorkspaceTab] = useState<'preview' | 'branches' | 'prs'>('preview');

  // Preview panel visibility
  const [isPreviewHidden, setIsPreviewHidden] = useState(false);

  // Reset to preview tab if on branches/prs and GitHub is not connected
  useEffect(() => {
    if (integrations.projectGithub?.status !== 'connected' && workspaceTab !== 'preview') {
      setWorkspaceTab('preview');
    }
  }, [integrations.projectGithub?.status, workspaceTab]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => {
      // Keep max 5 toasts, remove oldest if needed
      const updated = [...prev, { id, message, type }];
      return updated.slice(-5);
    });
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Check IDE availability on mount
  useEffect(() => {
    void invoke<{ vscode: boolean; cursor: boolean }>('check_ide_availability')
      .then(setIdeAvailability)
      .catch(() => setIdeAvailability({ vscode: false, cursor: false }));
  }, []);

  // Open project in IDE
  const openInIde = async (ide: 'vscode' | 'cursor') => {
    if (!currentProject) return;
    setOpeningIde(ide);
    try {
      await invoke('open_in_ide', { projectPath: currentProject.path, ide });
      // Command completed (IDE process spawned), reset state
      // Dropdown closes naturally when user moves mouse away
      setOpeningIde(null);
    } catch (e) {
      logger.error(`Failed to open in ${ide}`, { error: e });
      setOpeningIde(null);
    }
  };

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    void checkSetup();
  }, []);

  const checkSetup = async () => {
    setView('loading');
    try {
      // Get full setup status (tools + auth)
      const setupStatus = await getFullSetupStatus();

      // Check GitHub, Vercel, and Claude status in parallel
      const [ghStatus, vcStatus, clStatus] = await Promise.all([
        checkGitHubCliStatus(),
        checkVercelCliStatus(),
        checkClaudeCliStatus(),
      ]);

      let ghUsername: string | null = null;
      if (ghStatus.authenticated) {
        try {
          ghUsername = await getGitHubUsername();
        } catch {
          // Ignore - username is optional
        }
      }

      let vcUsername: string | null = null;
      if (vcStatus.authenticated) {
        try {
          vcUsername = await getVercelUsername();
        } catch {
          // Ignore - username is optional
        }
      }

      // Set all CLI states atomically
      dispatch({
        type: 'SET_ALL_CLI',
        payload: {
          github: { cliStatus: ghStatus, username: ghUsername },
          vercel: { cliStatus: vcStatus, username: vcUsername },
          claude: { cliStatus: clStatus },
        },
      });

      // Use full setup status to determine if onboarding is needed
      if (setupStatus.allReady) {
        setView('projects');
      } else {
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Failed to check prerequisites', { error });
      setView('onboarding');
    }
  };

  // Generic refresh helper for authenticated integrations (GitHub, Vercel)
  const refreshAuthenticatedIntegration = async (
    checkStatus: () => Promise<GitHubCliStatus> | Promise<VercelCliStatus>,
    getUsername: () => Promise<string>,
    actionType: 'SET_GITHUB' | 'SET_VERCEL'
  ) => {
    const status = await checkStatus();
    let username: string | null = null;
    if (status.authenticated) {
      try {
        username = await getUsername();
      } catch {
        // Ignore - username is optional
      }
    }
    dispatch({ type: actionType, payload: { cliStatus: status, username } });
  };

  const refreshGitHubStatus = () =>
    refreshAuthenticatedIntegration(checkGitHubCliStatus, getGitHubUsername, 'SET_GITHUB');

  const refreshVercelStatus = () =>
    refreshAuthenticatedIntegration(checkVercelCliStatus, getVercelUsername, 'SET_VERCEL');

  // Focus terminal (called after modals close)
  const focusTerminal = useCallback(() => {
    terminalRefsMap.current.get(activeTerminalTab)?.focus();
  }, [activeTerminalTab]);

  // Handle capture for Claude - screenshot preview and paste path into terminal
  const handleCaptureForClaude = useCallback(async () => {
    if (isCapturing || !previewRef.current) return;

    setIsCapturing(true);
    try {
      const filePath = await previewRef.current.captureForClaude();
      if (filePath) {
        // Quote path if it contains spaces
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        terminalRefsMap.current.get(activeTerminalTab)?.paste(quotedPath);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, activeTerminalTab]);

  // Handle crop mode start - show loading state
  const handleCropStart = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(true);
  }, []);

  // Handle crop mode completion - paste path into terminal
  const handleCropComplete = useCallback(
    (filePath: string | null) => {
      setIsCropCapturing(false);
      if (filePath) {
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        terminalRefsMap.current.get(activeTerminalTab)?.paste(quotedPath);
      }
    },
    [activeTerminalTab]
  );

  // Handle crop mode cancel
  const handleCropCancel = useCallback(() => {
    setIsCropMode(false);
    setIsCropCapturing(false);
  }, []);

  // Fetch branch info for a project
  const fetchBranchInfo = useCallback(async (projectPath: string) => {
    try {
      const [branch, branchList] = await Promise.all([
        getCurrentBranch(projectPath).catch(() => null),
        listBranches(projectPath).catch(() => []),
      ]);
      setCurrentBranch(branch);
      setBranches(branchList);

      // Check for uncommitted changes using the backend
      void invoke<boolean>('check_git_has_changes', { projectPath })
        .then((hasChanges) => setHasUncommittedChanges(hasChanges))
        .catch(() => setHasUncommittedChanges(false));
    } catch (e) {
      logger.error('Failed to fetch branch info', { error: e });
      setCurrentBranch(null);
      setBranches([]);
    }
  }, []);

  // Check git status (called periodically to sync with CLI changes)
  const checkGitStatus = useCallback(
    async (projectPath: string) => {
      try {
        const [branch, hasChanges, files] = await Promise.all([
          getCurrentBranch(projectPath).catch(() => null),
          invoke<boolean>('check_git_has_changes', { projectPath }).catch(() => false),
          getChangedFiles(projectPath).catch(() => []),
        ]);

        // Update branch if changed (e.g., user switched via CLI)
        if (branch && branch !== currentBranch) {
          setCurrentBranch(branch);
          // Refresh full branch list when branch changes
          void listBranches(projectPath)
            .then(setBranches)
            .catch(() => {});
        }

        setHasUncommittedChanges(hasChanges);
        setChangedFiles(files);
      } catch (e) {
        // Silently ignore errors during periodic checks
        logger.warn('Error checking git status', { error: e });
      }
    },
    [currentBranch]
  );

  // Periodically check git status when a project is open and window is focused
  useEffect(() => {
    if (!currentProject?.path) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      // Check immediately when starting/resuming
      void checkGitStatus(currentProject.path);
      // Then check every 3 seconds
      interval = setInterval(() => {
        void checkGitStatus(currentProject.path);
      }, 3000);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    // Start polling if window is visible
    if (!document.hidden) {
      startPolling();
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentProject?.path, checkGitStatus]);

  // Handle branch switch
  const handleBranchSwitch = useCallback(
    async (branchName: string) => {
      setIsBranchSwitching(true);
      setCurrentBranch(branchName);
      // Reset uncommitted changes immediately - will be updated by fetchBranchInfo
      setHasUncommittedChanges(false);
      if (currentProject) {
        await fetchBranchInfo(currentProject.path);
      }
      // Refresh preview after Next.js has time to detect file changes and rebuild
      setTimeout(() => previewRef.current?.refresh(), 300);
      setTimeout(() => {
        previewRef.current?.refresh();
        setIsBranchSwitching(false);
      }, 2500);
    },
    [currentProject, fetchBranchInfo]
  );

  // Handle publish error
  const handlePublishError = useCallback(
    (error: string, errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic') => {
      if (currentBranch) {
        setGitError({
          errorType,
          message: error,
          branchName: currentBranch,
        });
      }
    },
    [currentBranch]
  );

  // Handle opening conflict resolution modal
  // For PR conflicts: switch to head branch, merge base branch, then show UI
  const handleResolveConflicts = useCallback(
    async (headBranch?: string, baseBranch?: string) => {
      setGitError(null);

      if (!currentProject) return;

      // If we have branch info, we're resolving PR conflicts
      if (headBranch && baseBranch) {
        try {
          showToast('Preparing to resolve conflicts...', 'success');

          // Switch to the PR's head branch
          const switchResult = await switchBranch(currentProject.path, headBranch, true);
          if (!switchResult.success) {
            showToast(switchResult.error || 'Failed to switch branch', 'error');
            return;
          }

          // Update current branch state
          setCurrentBranch(headBranch);

          // Merge the base branch to create conflicts locally
          try {
            await pullAndMerge(currentProject.path, baseBranch);
            // If merge succeeds without conflicts, we're done
            showToast('Branch is up to date, no conflicts!', 'success');
            void fetchBranchInfo(currentProject.path);
            return;
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            if (errorMsg.includes('MERGE_CONFLICT')) {
              // Conflicts created locally - show the UI
              setShowConflictResolution(true);
            } else {
              showToast(`Failed to merge: ${errorMsg}`, 'error');
            }
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          showToast(`Error: ${errorMsg}`, 'error');
        }
      } else {
        // Direct conflict resolution (e.g., from GitErrorHandler after a failed push)
        setShowConflictResolution(true);
      }
    },
    [currentProject, showToast, fetchBranchInfo]
  );

  // Handle conflict resolution completed
  const handleConflictsResolved = useCallback(() => {
    setShowConflictResolution(false);
    if (currentProject) {
      void fetchBranchInfo(currentProject.path);
    }
  }, [currentProject, fetchBranchInfo]);

  // Send prompt to Claude terminal
  const sendToClaude = useCallback(
    (prompt: string) => {
      terminalRefsMap.current.get(activeTerminalTab)?.paste(prompt);
    },
    [activeTerminalTab]
  );

  // Kill all terminal processes
  const killAllTerminals = useCallback(() => {
    terminalRefsMap.current.forEach((ref) => {
      ref?.kill();
    });
    terminalRefsMap.current.clear();
  }, []);

  // Terminal tab management
  const addTerminalTab = useCallback(() => {
    if (terminalTabs.length >= MAX_TERMINAL_TABS) return;
    const newTabId = ++terminalTabCounterRef.current;
    setTerminalTabs((prev) => [...prev, newTabId]);
    setActiveTerminalTab(newTabId);
  }, [terminalTabs.length]);

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      // Don't close if it's the last tab
      if (terminalTabs.length <= 1) return;

      // Kill the PTY process BEFORE removing from state to prevent orphaned processes
      const ref = terminalRefsMap.current.get(tabId);
      if (ref) {
        ref.kill();
      }

      setTerminalTabs((prev) => {
        const newTabs = prev.filter((id) => id !== tabId);
        // If we're closing the active tab, switch to the previous one or the first
        if (tabId === activeTerminalTab) {
          const closedIndex = prev.indexOf(tabId);
          const newActiveIndex = Math.max(0, closedIndex - 1);
          setActiveTerminalTab(newTabs[newActiveIndex]);
        }
        return newTabs;
      });
      // Clean up the ref
      terminalRefsMap.current.delete(tabId);
    },
    [terminalTabs, activeTerminalTab]
  );

  // Handle terminal exit (memoized to prevent re-spawning Claude on every render)
  const handleTerminalExit = useCallback((code: number | null) => {
    logger.info('Terminal exited', { code });
  }, []);

  // Capture project screenshot in background
  const captureScreenshot = useCallback(
    async (projectPath: string) => {
      try {
        await invoke('capture_project_thumbnail', {
          projectPath,
          url: `http://localhost:${devServerPort}`,
        });
      } catch (error) {
        logger.error('Failed to capture thumbnail', { error });
      }
    },
    [devServerPort]
  );

  // Handle preview server ready - capture initial screenshot
  const handlePreviewReady = useCallback(() => {
    if (currentProject) {
      setTimeout(() => {
        void captureScreenshot(currentProject.path);
      }, SCREENSHOT_DELAY_MS);
    }
  }, [currentProject, captureScreenshot]);

  const handleSelectProject = async (project: Project) => {
    // Stop any existing dev server first
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }

    // Kill any process on our previously used port (handles orphaned processes from this session)
    try {
      await invoke('kill_port', { port: devServerPort });
    } catch {
      // Ignore errors - port may already be free
    }

    // Clean up any orphaned PTY processes from previous operations
    try {
      await invoke('kill_all_pty');
      await invoke('cleanup_orphaned_processes');
    } catch {
      // Ignore cleanup errors
    }

    // Find an available port (doesn't kill other apps' processes)
    let port = PREFERRED_DEV_SERVER_PORT;
    try {
      port = await invoke<number>('find_available_port', {
        preferredPort: PREFERRED_DEV_SERVER_PORT,
      });
    } catch (error) {
      logger.error('Failed to find available port, using default', { error });
    }
    setDevServerPort(port);

    // Clear any existing screenshot interval
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }

    // Reset publishing and auto-connecting state when switching projects
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);

    // Kill all terminals and reset tabs
    killAllTerminals();
    terminalTabCounterRef.current = 1;
    setTerminalTabs([1]);
    setActiveTerminalTab(1);
    setTerminalSessionId((prev) => prev + 1);
    setShowDevServerLogs(false);

    setCurrentProject(project);
    setCurrentPreviewPage('/');
    currentProjectPathRef.current = project.path;
    setView('project-loading');

    // Mark project as opened (for sorting by last opened)
    void invoke('mark_project_opened', { projectPath: project.path }).catch(() => {});

    // Ensure .shipstudio/ is gitignored (backwards compat for existing projects)
    void invoke('ensure_gitignore_has_shipstudio', { projectPath: project.path }).catch(() => {});

    // Check project's GitHub and Vercel status in parallel
    try {
      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(project.path).catch(() => null),
        getProjectVercelStatus(project.path).catch(() => null),
      ]);
      dispatch({ type: 'SET_PROJECT_STATUSES', payload: { github: ghStatus, vercel: vcStatus } });
    } catch {
      dispatch({ type: 'CLEAR_PROJECT_STATUSES' });
    }

    // Fetch branch info
    await fetchBranchInfo(project.path);

    // Start dev server in background on the available port
    try {
      // Clear previous output buffer
      devServerOutputRef.current = '';
      setDevServerOutputVersion(0);
      devServerRef.current = await startDevServer(project.path, port, (data) => {
        // Buffer output from the start so it's available when Logs tab opens
        devServerOutputRef.current += data;
        // Limit buffer size to prevent memory issues (keep last 100KB)
        if (devServerOutputRef.current.length > 100000) {
          devServerOutputRef.current = devServerOutputRef.current.slice(-100000);
        }
        // Trigger re-render for DevServerLogs (throttled by React)
        setDevServerOutputVersion((v) => v + 1);
      });
    } catch (error) {
      logger.error('Failed to start dev server', { error });
    }

    setView('workspace');

    // Capture screenshots periodically - check ref to avoid stale closure
    const projectPath = project.path;
    screenshotIntervalRef.current = setInterval(() => {
      // Only capture if this is still the current project
      if (currentProjectPathRef.current === projectPath) {
        void captureScreenshot(projectPath);
      }
    }, SCREENSHOT_INTERVAL_MS);
  };

  const handleCreateProject = () => {
    setShowCreateModal(true);
  };

  const handleProjectCreated = (projectPath: string) => {
    setShowCreateModal(false);
    const projectName = projectPath.split('/').pop() || 'project';
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleImportProject = () => {
    setShowImportModal(true);
  };

  const handleProjectImported = (projectPath: string) => {
    setShowImportModal(false);
    const projectName = projectPath.split('/').pop() || 'project';
    void handleSelectProject({ name: projectName, path: projectPath, thumbnail: null });
  };

  const handleBackToProjects = async () => {
    // Clear screenshot interval and project ref
    if (screenshotIntervalRef.current) {
      clearInterval(screenshotIntervalRef.current);
      screenshotIntervalRef.current = null;
    }
    currentProjectPathRef.current = null;

    // Reset publishing and auto-connecting state
    setIsPublishing(false);
    setIsVercelAutoConnecting(false);

    // Clear branch state
    setCurrentBranch(null);
    setBranches([]);
    setHasUncommittedChanges(false);
    setChangedFiles([]);

    // Kill all terminals and reset tabs
    killAllTerminals();
    terminalTabCounterRef.current = 1;
    setTerminalTabs([1]);
    setActiveTerminalTab(1);
    setTerminalSessionId((prev) => prev + 1);
    setShowDevServerLogs(false);

    // Stop dev server if running
    if (devServerRef.current) {
      await devServerRef.current.stop();
      devServerRef.current = null;
    }

    // Clean up any orphaned PTY processes
    try {
      await invoke('kill_all_pty');
      await invoke('cleanup_orphaned_processes');
      await invoke('kill_port', { port: devServerPort });
    } catch {
      // Ignore cleanup errors
    }

    setCurrentProject(null);
    dispatch({ type: 'CLEAR_PROJECT_STATUSES' });
    setView('projects');
  };

  const handleGitHubStatusChange = async (vercelDeployedUrl?: string) => {
    // Refresh project GitHub and Vercel status after push/publish
    if (currentProject) {
      // If we have a vercel deployed URL, optimistically set Vercel as connected
      // This avoids race conditions where the status check runs before Vercel's state propagates
      if (vercelDeployedUrl) {
        const ghStatus = await getProjectGitHubStatus(currentProject.path).catch(() => null);
        dispatch({
          type: 'SET_PROJECT_STATUSES',
          payload: {
            github: ghStatus,
            vercel: {
              status: 'connected',
              project_name: currentProject.name,
              production_url: vercelDeployedUrl.replace(/^https?:\/\//, ''),
              staging_url: null,
              vercel_org: null,
            },
          },
        });
        return;
      }

      const [ghStatus, vcStatus] = await Promise.all([
        getProjectGitHubStatus(currentProject.path).catch(() => null),
        getProjectVercelStatus(currentProject.path).catch(() => null),
      ]);
      dispatch({ type: 'SET_PROJECT_STATUSES', payload: { github: ghStatus, vercel: vcStatus } });
    }
  };

  const handleVercelStatusChange = async (deployedUrl?: string) => {
    // If we have a deployed URL from a successful deployment, use it directly
    if (deployedUrl && currentProject) {
      dispatch({
        type: 'SET_PROJECT_VERCEL',
        payload: {
          status: 'connected',
          project_name: currentProject.name,
          production_url: deployedUrl,
          staging_url: integrations.projectVercel?.staging_url ?? null,
          vercel_org: integrations.projectVercel?.vercel_org ?? null,
        },
      });
      return;
    }
    // Otherwise refresh project Vercel status
    if (currentProject) {
      const status = await getProjectVercelStatus(currentProject.path).catch(() => null);
      dispatch({ type: 'SET_PROJECT_VERCEL', payload: status });
    }
  };

  if (view === 'loading') {
    return (
      <div className="app loading">
        <img src="/ship_studio_full_noshadow.svg" alt="Ship Studio" className="app-logo" />
        <div className="spinner" />
      </div>
    );
  }

  if (view === 'onboarding') {
    return (
      <div className="app">
        <UpdateBanner />
        <OnboardingScreen onComplete={() => void checkSetup()} />
      </div>
    );
  }

  if (view === 'projects') {
    return (
      <div className="app">
        <UpdateBanner />
        <ProjectList
          onSelectProject={(project) => void handleSelectProject(project)}
          onCreateProject={handleCreateProject}
          onImportProject={handleImportProject}
        />
        {showCreateModal && (
          <CreateProject
            onComplete={handleProjectCreated}
            onCancel={() => setShowCreateModal(false)}
          />
        )}
        {showImportModal && (
          <ImportProject
            onComplete={handleProjectImported}
            onCancel={() => setShowImportModal(false)}
          />
        )}
      </div>
    );
  }

  if (view === 'project-loading') {
    return (
      <div className="app loading">
        <div className="spinner" />
        <p>Opening {currentProject?.name}...</p>
      </div>
    );
  }

  // Workspace view
  return (
    <div className="app workspace">
      <UpdateBanner />
      <header className="workspace-header">
        <button className="back-button" onClick={() => void handleBackToProjects()}>
          ← Projects
        </button>
        <h1>{currentProject?.name}</h1>
        <span className="project-path">{currentProject?.path}</span>

        <div className="workspace-header-actions">
          <button
            className="assets-button"
            onClick={() => setShowAssetsPanel(true)}
            title="Manage Assets"
          >
            <ImageIcon size={14} />
            Assets
          </button>
          <div
            className="ide-dropdown-container"
            onMouseEnter={() => setShowIdeDropdown(true)}
            onMouseLeave={() => setShowIdeDropdown(false)}
          >
            <button className="ide-button" title="Open in IDE">
              <CodeIcon size={14} />
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
          <button
            className="env-button"
            onClick={() => setShowEnvEditor(true)}
            title="Environment Variables"
          >
            <span className="env-button-icon">$</span>
            .env
          </button>
          <GitHubButton
            githubState={integrations.github}
            vercelState={integrations.vercel}
            projectStatus={integrations.projectGithub}
            projectPath={currentProject?.path || ''}
            projectName={currentProject?.name || ''}
            onStatusChange={handleGitHubStatusChange}
            onGitHubConnect={() => void refreshGitHubStatus()}
            onModalClose={focusTerminal}
            onToast={showToast}
            onVercelAutoConnectStart={() => setIsVercelAutoConnecting(true)}
            onVercelAutoConnectEnd={() => setIsVercelAutoConnecting(false)}
          />
          <VercelButton
            vercelState={integrations.vercel}
            projectVercelStatus={integrations.projectVercel}
            projectGithubStatus={integrations.projectGithub}
            projectPath={currentProject?.path || ''}
            projectName={currentProject?.name || ''}
            onStatusChange={(deployedUrl) => void handleVercelStatusChange(deployedUrl)}
            onVercelConnect={() => void refreshVercelStatus()}
            onModalClose={focusTerminal}
            onToast={showToast}
            isAutoConnecting={isVercelAutoConnecting}
          />
          <PublishBranchDropdown
            currentBranch={currentBranch || 'main'}
            projectGithubStatus={integrations.projectGithub}
            projectVercelStatus={integrations.projectVercel}
            projectPath={currentProject?.path || ''}
            hasChangesToSync={hasUncommittedChanges}
            onStatusChange={() => {
              void handleGitHubStatusChange();
              if (currentProject) void fetchBranchInfo(currentProject.path);
            }}
            onModalClose={focusTerminal}
            onToast={showToast}
            isPublishing={isPublishing}
            setIsPublishing={setIsPublishing}
            onPublishError={handlePublishError}
          />
        </div>
      </header>

      <div className="workspace-content">
        <SplitPane
          defaultSplit={28}
          minLeft={20}
          minRight={35}
          rightCollapsed={isPreviewHidden}
          left={
            <div className="terminal-pane">
              <div className="terminal-toolbar">
                <div className="agent-toolbar">
                  <div className="agent-label">
                    <ChatIcon size={14} />
                    <span>Agent</span>
                  </div>
                  <button
                    className="agent-capture-btn"
                    onClick={() => void handleCaptureForClaude()}
                    disabled={isCapturing || isCropMode}
                    title="Screenshot preview for Claude"
                  >
                    {isCapturing ? <div className="capture-spinner" /> : <CameraIcon size={14} />}
                  </button>
                  <button
                    className={`agent-capture-btn ${isCropMode ? 'active' : ''}`}
                    onClick={() => setIsCropMode(!isCropMode)}
                    disabled={isCapturing || isCropCapturing}
                    title="Crop screenshot for Claude"
                  >
                    {isCropCapturing ? <div className="capture-spinner" /> : <CropIcon size={14} />}
                  </button>
                </div>
                {isPreviewHidden && (
                  <div className="preview-hidden-actions">
                    <button
                      className="show-preview-btn"
                      onClick={() => void openUrl(`http://localhost:${devServerPort}`)}
                      title="Open in Browser"
                    >
                      <ExternalLinkIcon size={14} />
                      <span>Open in Browser</span>
                    </button>
                    <button
                      className="show-preview-btn"
                      onClick={() => setIsPreviewHidden(false)}
                      title="Show Preview"
                    >
                      <PanelRightIcon size={14} />
                      <span>Show Preview</span>
                    </button>
                  </div>
                )}
              </div>
              <div className="terminal-tabs-bar">
                <div className="terminal-tabs">
                  {terminalTabs.map((tabId, index) => (
                    <button
                      key={tabId}
                      className={`terminal-tab ${!showDevServerLogs && activeTerminalTab === tabId ? 'active' : ''}`}
                      onClick={() => {
                        setShowDevServerLogs(false);
                        setActiveTerminalTab(tabId);
                      }}
                    >
                      <span className="terminal-tab-number">{index + 1}</span>
                      {terminalTabs.length > 1 && (
                        <span
                          className="terminal-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTerminalTab(tabId);
                          }}
                        >
                          <CloseIcon size={10} />
                        </span>
                      )}
                    </button>
                  ))}
                  {terminalTabs.length < MAX_TERMINAL_TABS && (
                    <button className="terminal-tab-add" onClick={addTerminalTab}>
                      <PlusIcon size={12} />
                    </button>
                  )}
                </div>
                <div className="terminal-tabs-divider" />
                <button
                  className={`terminal-tab logs-tab ${showDevServerLogs ? 'active' : ''}`}
                  onClick={() => setShowDevServerLogs(true)}
                  title="View dev server logs"
                >
                  <TerminalIcon size={12} />
                  <span>Logs</span>
                </button>
              </div>
              <div className="terminal-content">
                {terminalTabs.map((tabId) => (
                  <div
                    key={`session-${terminalSessionId}-tab-${tabId}`}
                    className="terminal-tab-content"
                    style={{
                      display: !showDevServerLogs && activeTerminalTab === tabId ? 'block' : 'none',
                    }}
                  >
                    <Terminal
                      ref={(ref) => {
                        if (ref) {
                          terminalRefsMap.current.set(tabId, ref);
                        }
                      }}
                      projectPath={currentProject?.path || ''}
                      onExit={handleTerminalExit}
                    />
                  </div>
                ))}
                {showDevServerLogs && (
                  <div className="terminal-tab-content" style={{ display: 'block' }}>
                    <DevServerLogs
                      output={devServerOutputRef.current}
                      outputVersion={devServerOutputVersion}
                    />
                  </div>
                )}
              </div>
            </div>
          }
          right={
            <div className="preview-pane">
              {/* Preview/Branches/PRs Tabs - only show branch tabs when GitHub repo exists */}
              {integrations.projectGithub?.status === 'connected' ? (
                <div className="preview-tabs-bar">
                  {/* Branch Indicator - click to toggle between Branches tab and Preview */}
                  {currentBranch && (
                    <BranchIndicator
                      currentBranch={currentBranch}
                      hasUncommittedChanges={hasUncommittedChanges}
                      changedFiles={changedFiles}
                      projectPath={currentProject?.path || ''}
                      isOnBranchesTab={workspaceTab === 'branches' || workspaceTab === 'prs'}
                      onClick={() =>
                        setWorkspaceTab(
                          workspaceTab === 'branches' || workspaceTab === 'prs'
                            ? 'preview'
                            : 'branches'
                        )
                      }
                      onDiscard={() => {
                        if (currentProject) {
                          void checkGitStatus(currentProject.path);
                        }
                      }}
                      onToast={showToast}
                    />
                  )}
                  <div className="workspace-tabs">
                    <button
                      className={`workspace-tab ${workspaceTab === 'preview' ? 'active' : ''}`}
                      onClick={() => setWorkspaceTab('preview')}
                    >
                      <EyeIcon size={14} />
                      <span>Preview</span>
                    </button>
                    <button
                      className={`workspace-tab ${workspaceTab === 'branches' ? 'active' : ''}`}
                      onClick={() => setWorkspaceTab('branches')}
                    >
                      <BranchIcon size={14} />
                      <span>Branches</span>
                    </button>
                    <button
                      className={`workspace-tab ${workspaceTab === 'prs' ? 'active' : ''}`}
                      onClick={() => setWorkspaceTab('prs')}
                    >
                      <PullRequestIcon size={14} />
                      <span>PRs</span>
                    </button>
                  </div>
                  <div className="preview-tabs-divider" />
                  <div className="preview-actions">
                    <button
                      className="preview-action-btn"
                      onClick={() => void openUrl(`http://localhost:${devServerPort}`)}
                      title="Open in Browser"
                    >
                      <ExternalLinkIcon size={14} />
                      <span>Open in Browser</span>
                    </button>
                    <button
                      className="preview-action-btn"
                      onClick={() => setIsPreviewHidden(true)}
                      title="Hide Preview"
                    >
                      <PanelRightIcon size={14} />
                      <span>Hide Preview</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="preview-tabs-bar preview-tabs-bar-simple">
                  <span className="preview-label">Preview</span>
                  <div className="preview-tabs-divider" />
                  <div className="preview-actions">
                    <button
                      className="preview-action-btn"
                      onClick={() => void openUrl(`http://localhost:${devServerPort}`)}
                      title="Open in Browser"
                    >
                      <ExternalLinkIcon size={14} />
                      <span>Open in Browser</span>
                    </button>
                    <button
                      className="preview-action-btn"
                      onClick={() => setIsPreviewHidden(true)}
                      title="Hide Preview"
                    >
                      <PanelRightIcon size={14} />
                      <span>Hide Preview</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Tab content */}
              {workspaceTab === 'preview' && (
                <Preview
                  key={`${currentProject?.path || 'none'}-${devServerPort}`}
                  ref={previewRef}
                  port={devServerPort}
                  projectPath={currentProject?.path || ''}
                  onServerReady={handlePreviewReady}
                  onPageChange={setCurrentPreviewPage}
                  isCropMode={isCropMode}
                  onCropStart={handleCropStart}
                  onCropComplete={handleCropComplete}
                  onCropCancel={handleCropCancel}
                  isBranchSwitching={isBranchSwitching}
                />
              )}
              {workspaceTab === 'branches' && currentProject && (
                <BranchesTab
                  branches={branches}
                  currentBranch={currentBranch || ''}
                  projectPath={currentProject.path}
                  githubUsername={integrations.github.username}
                  onBranchSwitch={(branchName) => void handleBranchSwitch(branchName)}
                  onSubmitForReview={(branchName) => setShowSubmitReview(branchName)}
                  onRefresh={() => void fetchBranchInfo(currentProject.path)}
                  onToast={showToast}
                />
              )}
              {workspaceTab === 'prs' && currentProject && (
                <PullRequestsTab
                  projectPath={currentProject.path}
                  githubUsername={integrations.github.username}
                  onRefresh={() => void fetchBranchInfo(currentProject.path)}
                  onToast={showToast}
                  onBranchSwitch={(branchName) => void handleBranchSwitch(branchName)}
                  onNavigateToBranches={() => setWorkspaceTab('branches')}
                  onResolveConflicts={(headBranch, baseBranch) =>
                    void handleResolveConflicts(headBranch, baseBranch)
                  }
                />
              )}
            </div>
          }
        />
      </div>

      <EnvEditor
        projectPath={currentProject?.path || ''}
        isOpen={showEnvEditor}
        onClose={() => {
          setShowEnvEditor(false);
          focusTerminal();
        }}
        onToast={showToast}
      />

      <AssetsPanel
        projectPath={currentProject?.path || ''}
        isOpen={showAssetsPanel}
        onClose={() => {
          setShowAssetsPanel(false);
          focusTerminal();
        }}
        onToast={showToast}
      />

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

      {/* Submit for Review Modal */}
      {showSubmitReview && (
        <SubmitReviewModal
          projectPath={currentProject?.path || ''}
          branchName={showSubmitReview}
          baseBranches={branches
            .filter((b) => b.isDefault || b.name === 'staging')
            .map((b) => b.name)}
          onSuccess={() => {
            showToast('Pull request created', 'success');
            if (currentProject) void fetchBranchInfo(currentProject.path);
          }}
          onClose={() => {
            setShowSubmitReview(null);
            focusTerminal();
          }}
          onToast={showToast}
        />
      )}

      {/* Git Error Handler */}
      {gitError && (
        <GitErrorHandler
          errorType={gitError.errorType}
          errorMessage={gitError.message}
          branchName={gitError.branchName}
          onClose={() => setGitError(null)}
          onSendToClaude={sendToClaude}
          onToast={showToast}
          onResolveConflicts={() => void handleResolveConflicts()}
        />
      )}

      {/* Conflict Resolution Modal */}
      {showConflictResolution && currentProject && (
        <ConflictResolutionModal
          projectPath={currentProject.path}
          onClose={() => {
            setShowConflictResolution(false);
            focusTerminal();
          }}
          onResolved={handleConflictsResolved}
          onToast={showToast}
        />
      )}
    </div>
  );
}

export default App;
