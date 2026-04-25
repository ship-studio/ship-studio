/**
 * Custom hook for managing integration states (GitHub, Claude).
 *
 * Extracted from App.tsx to isolate the complex reducer logic for external service
 * integrations. This was a high-value extraction because:
 * - The reducer pattern with multiple action types was adding significant complexity
 * - Auth terminal state and handlers are logically grouped with integration status
 * - Types (GitHubState, ClaudeState) are now exported for use by child components
 *
 * Uses a reducer for atomic updates to prevent race conditions when
 * multiple integration statuses are being updated concurrently.
 *
 * @module hooks/useIntegrationStatus
 */

import { useReducer, useCallback, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import {
  checkGitHubCliStatus,
  getGitHubUsername,
  getProjectGitHubStatus,
  GitHubCliStatus,
  ProjectGitHubStatus,
} from '../lib/github';
import { checkAgentCliStatus, AgentCliStatus } from '../lib/claude';
import { identifyUser } from '../lib/analytics';

// `getVersion` reads a baked-in compile-time constant; cache it so the
// repeated identify path doesn't pay the Tauri IPC cost on every refresh.
let cachedAppVersion: string | null | undefined;
async function getCachedAppVersion(): Promise<string | null> {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  try {
    cachedAppVersion = await getVersion();
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}

/** Global GitHub CLI and authentication state */
export interface GitHubState {
  /** CLI installation and auth status */
  cliStatus: GitHubCliStatus;
  /** Authenticated username or null */
  username: string | null;
}

/** Global Claude CLI state */
export interface ClaudeState {
  /** CLI installation status and version */
  cliStatus: AgentCliStatus;
}

/** Auth terminal configuration for login flows */
export interface AuthTerminalConfig {
  service: 'github';
  command: string;
  args: string[];
}

/**
 * Consolidated integration state for all external services.
 * Managed via useReducer for atomic updates to prevent race conditions.
 */
export interface IntegrationState {
  /** GitHub CLI and auth state */
  github: GitHubState;
  /** Current project's GitHub repo status */
  projectGithub: ProjectGitHubStatus | null;
  /** Claude CLI state */
  claude: ClaudeState;
}

type IntegrationAction =
  | { type: 'SET_GITHUB'; payload: GitHubState }
  | { type: 'SET_PROJECT_GITHUB'; payload: ProjectGitHubStatus | null }
  | { type: 'SET_CLAUDE'; payload: ClaudeState }
  | { type: 'CLEAR_PROJECT_STATUSES' }
  | {
      type: 'SET_ALL_CLI';
      payload: { github: GitHubState; claude: ClaudeState };
    };

const initialIntegrationState: IntegrationState = {
  github: { cliStatus: { installed: false, authenticated: false }, username: null },
  projectGithub: null,
  claude: { cliStatus: { installed: false, version: null } },
};

function integrationReducer(state: IntegrationState, action: IntegrationAction): IntegrationState {
  switch (action.type) {
    case 'SET_GITHUB':
      return { ...state, github: action.payload };
    case 'SET_PROJECT_GITHUB':
      return { ...state, projectGithub: action.payload };
    case 'SET_CLAUDE':
      return { ...state, claude: action.payload };
    case 'CLEAR_PROJECT_STATUSES':
      return { ...state, projectGithub: null };
    case 'SET_ALL_CLI':
      return {
        ...state,
        github: action.payload.github,
        claude: action.payload.claude,
      };
    default:
      return state;
  }
}

/** Return type for useIntegrationStatus hook */
export interface UseIntegrationStatusReturn {
  /** Current integration states */
  integrations: IntegrationState;
  /** Whether the initial CLI status check has completed */
  isInitialCheckDone: boolean;
  /** Dispatch function for direct reducer actions */
  dispatch: React.Dispatch<IntegrationAction>;
  /** Refresh GitHub CLI status */
  refreshGitHubStatus: () => Promise<void>;
  /** Refresh Claude CLI status */
  refreshClaudeStatus: () => Promise<void>;
  /** Refresh all CLI statuses at once */
  refreshAllCliStatuses: () => Promise<void>;
  /** Set project GitHub status */
  setProjectGitHubStatus: (status: ProjectGitHubStatus | null) => void;
  /** Clear project statuses */
  clearProjectStatuses: () => void;
  /** Auth terminal configuration (null when not showing) */
  authTerminalConfig: AuthTerminalConfig | null;
  /** Open GitHub auth terminal */
  handleGitHubConnect: () => void;
  /** Handle auth terminal exit and refresh status */
  handleAuthTerminalExit: (exitCode: number | null, projectPath?: string) => Promise<void>;
  /** Close auth terminal without refreshing */
  closeAuthTerminal: () => void;
  /** Fetch project GitHub status */
  fetchProjectGitHubStatus: (projectPath: string) => Promise<ProjectGitHubStatus>;
}

/** Fallback GitHub status when check fails */
export const GITHUB_STATUS_FALLBACK: ProjectGitHubStatus = {
  status: 'no-remote',
  github_repo: null,
  github_url: null,
};

/**
 * Hook for managing integration states (GitHub, Claude).
 *
 * @example
 * ```tsx
 * const {
 *   integrations,
 *   refreshGitHubStatus,
 *   handleGitHubConnect,
 *   authTerminalConfig,
 * } = useIntegrationStatus();
 *
 * // Check if GitHub is authenticated
 * if (integrations.github.cliStatus.authenticated) {
 *   // User is logged in
 * }
 *
 * // Refresh status after an action
 * await refreshGitHubStatus();
 *
 * // Open auth terminal
 * handleGitHubConnect();
 * ```
 *
 * @returns Integration state and control functions
 */
export function useIntegrationStatus(): UseIntegrationStatusReturn {
  const [integrations, dispatch] = useReducer(integrationReducer, initialIntegrationState);
  const [authTerminalConfig, setAuthTerminalConfig] = useState<AuthTerminalConfig | null>(null);
  const [isInitialCheckDone, setIsInitialCheckDone] = useState(false);

  const refreshGitHubStatus = useCallback(async () => {
    const status = await checkGitHubCliStatus();
    let username: string | null = null;
    if (status.authenticated) {
      try {
        username = await getGitHubUsername();
      } catch {
        // Ignore - username is optional
      }
    }
    dispatch({ type: 'SET_GITHUB', payload: { cliStatus: status, username } });
  }, []);

  const refreshClaudeStatus = useCallback(async () => {
    const status = await checkAgentCliStatus();
    dispatch({ type: 'SET_CLAUDE', payload: { cliStatus: status } });
  }, []);

  const refreshAllCliStatuses = useCallback(async () => {
    const [ghStatus, clStatus] = await Promise.all([checkGitHubCliStatus(), checkAgentCliStatus()]);

    let ghUsername: string | null = null;
    if (ghStatus.authenticated) {
      try {
        ghUsername = await getGitHubUsername();
        if (ghUsername) {
          // Person props ($set) overwrite on every identify; person props
          // ($set_once) only land the first time we see this user.
          const appVersion = await getCachedAppVersion();
          const nowIso = new Date().toISOString();
          const setProps: Record<string, unknown> = {
            github_username: ghUsername,
            last_identified_at: nowIso,
          };
          if (appVersion) setProps.latest_app_version = appVersion;
          const setOnce: Record<string, unknown> = {
            first_identified_at: nowIso,
          };
          if (appVersion) setOnce.first_app_version = appVersion;
          void identifyUser(ghUsername, setProps, setOnce);
        }
      } catch {
        // Ignore - username is optional
      }
    }

    dispatch({
      type: 'SET_ALL_CLI',
      payload: {
        github: { cliStatus: ghStatus, username: ghUsername },
        claude: { cliStatus: clStatus },
      },
    });
    setIsInitialCheckDone(true);
  }, []);

  const setProjectGitHubStatus = useCallback((status: ProjectGitHubStatus | null) => {
    dispatch({ type: 'SET_PROJECT_GITHUB', payload: status });
  }, []);

  const clearProjectStatuses = useCallback(() => {
    dispatch({ type: 'CLEAR_PROJECT_STATUSES' });
  }, []);

  const handleGitHubConnect = useCallback(() => {
    setAuthTerminalConfig({
      service: 'github',
      command: 'gh',
      args: ['auth', 'login', '--web', '--git-protocol', 'https'],
    });
  }, []);

  const handleAuthTerminalExit = useCallback(
    async (exitCode: number | null, projectPath?: string) => {
      setAuthTerminalConfig(null);

      if (exitCode === 0 || exitCode === null) {
        await refreshGitHubStatus();
        if (projectPath) {
          const projectStatus = await getProjectGitHubStatus(projectPath);
          dispatch({ type: 'SET_PROJECT_GITHUB', payload: projectStatus });
        }
      }
    },
    [refreshGitHubStatus]
  );

  const closeAuthTerminal = useCallback(() => {
    setAuthTerminalConfig(null);
  }, []);

  const fetchProjectGitHubStatus = useCallback(async (projectPath: string) => {
    const status = await getProjectGitHubStatus(projectPath).catch(() => GITHUB_STATUS_FALLBACK);
    dispatch({ type: 'SET_PROJECT_GITHUB', payload: status });
    return status;
  }, []);

  return {
    integrations,
    isInitialCheckDone,
    dispatch,
    refreshGitHubStatus,
    refreshClaudeStatus,
    refreshAllCliStatuses,
    setProjectGitHubStatus,
    clearProjectStatuses,
    authTerminalConfig,
    handleGitHubConnect,
    handleAuthTerminalExit,
    closeAuthTerminal,
    fetchProjectGitHubStatus,
  };
}
