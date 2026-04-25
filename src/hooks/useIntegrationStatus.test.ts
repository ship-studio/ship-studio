import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIntegrationStatus, GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';

// Mock external dependencies
vi.mock('../lib/github', () => ({
  checkGitHubCliStatus: vi.fn().mockResolvedValue({ installed: false, authenticated: false }),
  getGitHubUsername: vi.fn().mockResolvedValue(null),
  getProjectGitHubStatus: vi
    .fn()
    .mockResolvedValue({ status: 'no-remote', github_repo: null, github_url: null }),
}));

vi.mock('../lib/claude', () => ({
  checkAgentCliStatus: vi.fn().mockResolvedValue({ installed: false, version: null }),
}));

vi.mock('../lib/analytics', () => ({
  identifyUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('9.9.9'),
}));

describe('useIntegrationStatus', () => {
  let github: typeof import('../lib/github');
  let claude: typeof import('../lib/claude');
  let analytics: typeof import('../lib/analytics');
  let app: typeof import('@tauri-apps/api/app');

  beforeEach(async () => {
    vi.clearAllMocks();
    github = await import('../lib/github');
    claude = await import('../lib/claude');
    analytics = await import('../lib/analytics');
    app = await import('@tauri-apps/api/app');

    vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
      installed: false,
      authenticated: false,
    });
    vi.mocked(claude.checkAgentCliStatus).mockResolvedValue({ installed: false, version: null });
    vi.mocked(github.getGitHubUsername).mockResolvedValue('');
    vi.mocked(github.getProjectGitHubStatus).mockResolvedValue(GITHUB_STATUS_FALLBACK);
    vi.mocked(analytics.identifyUser).mockResolvedValue(undefined);
    // Re-establish each test — global afterEach calls restoreAllMocks which
    // strips the implementation from the top-of-file `vi.mock`.
    vi.mocked(app.getVersion).mockResolvedValue('9.9.9');
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useIntegrationStatus());

    expect(result.current.integrations.github.cliStatus).toEqual({
      installed: false,
      authenticated: false,
    });
    expect(result.current.integrations.github.username).toBeNull();
    expect(result.current.integrations.projectGithub).toBeNull();
    expect(result.current.integrations.claude.cliStatus).toEqual({
      installed: false,
      version: null,
    });
    expect(result.current.isInitialCheckDone).toBe(false);
    expect(result.current.authTerminalConfig).toBeNull();
  });

  describe('refreshGitHubStatus', () => {
    it('updates GitHub state when authenticated', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.mocked(github.getGitHubUsername).mockResolvedValue('testuser');

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshGitHubStatus();
      });

      expect(result.current.integrations.github.cliStatus.authenticated).toBe(true);
      expect(result.current.integrations.github.username).toBe('testuser');
    });

    it('handles username fetch failure gracefully', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.mocked(github.getGitHubUsername).mockRejectedValue(new Error('timeout'));

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshGitHubStatus();
      });

      expect(result.current.integrations.github.cliStatus.authenticated).toBe(true);
      expect(result.current.integrations.github.username).toBeNull();
    });

    it('skips username fetch when not authenticated', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: false,
      });

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshGitHubStatus();
      });

      expect(vi.mocked(github.getGitHubUsername)).not.toHaveBeenCalled();
      expect(result.current.integrations.github.username).toBeNull();
    });
  });

  describe('refreshClaudeStatus', () => {
    it('updates Claude state', async () => {
      vi.mocked(claude.checkAgentCliStatus).mockResolvedValue({
        installed: true,
        version: '1.0.0',
      });

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshClaudeStatus();
      });

      expect(result.current.integrations.claude.cliStatus).toEqual({
        installed: true,
        version: '1.0.0',
      });
    });
  });

  describe('refreshAllCliStatuses', () => {
    it('checks both CLIs in parallel and sets isInitialCheckDone', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.mocked(claude.checkAgentCliStatus).mockResolvedValue({
        installed: true,
        version: '2.0.0',
      });
      vi.mocked(github.getGitHubUsername).mockResolvedValue('devuser');

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshAllCliStatuses();
      });

      expect(result.current.integrations.github.cliStatus.authenticated).toBe(true);
      expect(result.current.integrations.github.username).toBe('devuser');
      expect(result.current.integrations.claude.cliStatus.version).toBe('2.0.0');
      expect(result.current.isInitialCheckDone).toBe(true);
    });

    it('calls identifyUser when username is available', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.mocked(claude.checkAgentCliStatus).mockResolvedValue({ installed: false, version: null });
      vi.mocked(github.getGitHubUsername).mockResolvedValue('myuser');

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.refreshAllCliStatuses();
      });

      const identifyMock = vi.mocked(analytics.identifyUser);
      expect(identifyMock).toHaveBeenCalledTimes(1);
      const [userId, setProps, setOnceProps] = identifyMock.mock.calls[0];
      expect(userId).toBe('myuser');
      expect(setProps).toMatchObject({
        github_username: 'myuser',
        latest_app_version: '9.9.9',
      });
      expect(typeof setProps?.last_identified_at).toBe('string');
      expect(setOnceProps).toMatchObject({ first_app_version: '9.9.9' });
      expect(typeof setOnceProps?.first_identified_at).toBe('string');
    });
  });

  describe('auth terminal', () => {
    it('opens GitHub auth terminal', () => {
      const { result } = renderHook(() => useIntegrationStatus());

      act(() => {
        result.current.handleGitHubConnect();
      });

      expect(result.current.authTerminalConfig).toEqual({
        service: 'github',
        command: 'gh',
        args: ['auth', 'login', '--web', '--git-protocol', 'https'],
      });
    });

    it('closes auth terminal without refreshing', () => {
      const { result } = renderHook(() => useIntegrationStatus());

      act(() => {
        result.current.handleGitHubConnect();
      });
      expect(result.current.authTerminalConfig).not.toBeNull();

      act(() => {
        result.current.closeAuthTerminal();
      });
      expect(result.current.authTerminalConfig).toBeNull();
      expect(vi.mocked(github.checkGitHubCliStatus)).not.toHaveBeenCalled();
    });

    it('refreshes GitHub status on successful exit (code 0)', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.mocked(github.getGitHubUsername).mockResolvedValue('newuser');

      const { result } = renderHook(() => useIntegrationStatus());

      act(() => {
        result.current.handleGitHubConnect();
      });

      await act(async () => {
        await result.current.handleAuthTerminalExit(0);
      });

      expect(result.current.authTerminalConfig).toBeNull();
      expect(vi.mocked(github.checkGitHubCliStatus)).toHaveBeenCalled();
      expect(result.current.integrations.github.cliStatus.authenticated).toBe(true);
    });

    it('refreshes GitHub status on null exit code', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.handleAuthTerminalExit(null);
      });

      expect(vi.mocked(github.checkGitHubCliStatus)).toHaveBeenCalled();
    });

    it('does not refresh on non-zero exit code', async () => {
      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.handleAuthTerminalExit(1);
      });

      expect(vi.mocked(github.checkGitHubCliStatus)).not.toHaveBeenCalled();
    });

    it('fetches project GitHub status on successful exit with projectPath', async () => {
      vi.mocked(github.checkGitHubCliStatus).mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      const projectStatus = {
        status: 'connected' as const,
        github_repo: 'user/repo',
        github_url: 'https://github.com/user/repo',
      };
      vi.mocked(github.getProjectGitHubStatus).mockResolvedValue(projectStatus);

      const { result } = renderHook(() => useIntegrationStatus());

      await act(async () => {
        await result.current.handleAuthTerminalExit(0, '/path/to/project');
      });

      expect(vi.mocked(github.getProjectGitHubStatus)).toHaveBeenCalledWith('/path/to/project');
      expect(result.current.integrations.projectGithub).toEqual(projectStatus);
    });
  });

  describe('project GitHub status', () => {
    it('sets project GitHub status', () => {
      const { result } = renderHook(() => useIntegrationStatus());
      const status = {
        status: 'connected' as const,
        github_repo: 'org/repo',
        github_url: 'https://github.com/org/repo',
      };

      act(() => {
        result.current.setProjectGitHubStatus(status);
      });

      expect(result.current.integrations.projectGithub).toEqual(status);
    });

    it('clears project statuses', () => {
      const { result } = renderHook(() => useIntegrationStatus());

      act(() => {
        result.current.setProjectGitHubStatus({
          status: 'connected',
          github_repo: 'org/repo',
          github_url: 'https://github.com/org/repo',
        });
      });

      act(() => {
        result.current.clearProjectStatuses();
      });

      expect(result.current.integrations.projectGithub).toBeNull();
    });

    it('fetches project status and uses fallback on error', async () => {
      vi.mocked(github.getProjectGitHubStatus).mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() => useIntegrationStatus());

      let status;
      await act(async () => {
        status = await result.current.fetchProjectGitHubStatus('/path/to/project');
      });

      expect(status).toEqual(GITHUB_STATUS_FALLBACK);
      expect(result.current.integrations.projectGithub).toEqual(GITHUB_STATUS_FALLBACK);
    });
  });
});
