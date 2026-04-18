import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDevServer } from './useDevServer';

// Mock external dependencies
vi.mock('../lib/project', () => ({
  startDevServer: vi.fn().mockResolvedValue({
    pty: { kill: vi.fn() },
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../lib/static-server', () => ({
  detectProjectType: vi.fn().mockResolvedValue('unknown'),
  startStaticServer: vi.fn().mockResolvedValue(8080),
  stopStaticServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/window', () => ({
  getWindowLabel: vi.fn().mockReturnValue('main'),
}));

vi.mock('../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('useDevServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useDevServer('/path/to/project'));

    expect(result.current.devServerPort).toBe(3000);
    expect(result.current.projectType).toBe('unknown');
    expect(result.current.isRestartingDevServer).toBe(false);
    expect(result.current.devServerOutputVersion).toBe(0);
    expect(result.current.healthOutputVersion).toBe(0);
  });

  describe('health output buffering', () => {
    it('accumulates health output', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      act(() => {
        result.current.handleHealthOutput('line 1\n');
      });
      expect(result.current.healthOutputRef.current).toBe('line 1\n');
      expect(result.current.healthOutputVersion).toBe(1);

      act(() => {
        result.current.handleHealthOutput('line 2\n');
      });
      expect(result.current.healthOutputRef.current).toBe('line 1\nline 2\n');
      // Second call is throttled — version bumps after the throttle delay
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.healthOutputVersion).toBe(2);
      vi.useRealTimers();
    });

    it('truncates health output at 100KB', () => {
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      const largeChunk = 'x'.repeat(60000);

      act(() => {
        result.current.handleHealthOutput(largeChunk);
      });
      act(() => {
        result.current.handleHealthOutput(largeChunk);
      });

      expect(result.current.healthOutputRef.current.length).toBe(100000);
    });
  });

  describe('clearOutputBuffers', () => {
    it('clears both output buffers and resets versions', () => {
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      act(() => {
        result.current.handleHealthOutput('data');
      });
      expect(result.current.healthOutputVersion).toBeGreaterThan(0);

      act(() => {
        result.current.clearOutputBuffers();
      });

      expect(result.current.devServerOutputRef.current).toBe('');
      expect(result.current.healthOutputRef.current).toBe('');
      expect(result.current.devServerOutputVersion).toBe(0);
      expect(result.current.healthOutputVersion).toBe(0);
    });
  });

  describe('setDevServerPort', () => {
    it('updates the dev server port', () => {
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      act(() => {
        result.current.setDevServerPort(8080);
      });

      expect(result.current.devServerPort).toBe(8080);
    });
  });

  describe('setProjectType', () => {
    it('updates the project type', () => {
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      act(() => {
        result.current.setProjectType('statichtml');
      });

      expect(result.current.projectType).toBe('statichtml');
    });
  });

  describe('startServerForProject', () => {
    it('detects project type and starts static server for statichtml', async () => {
      const { detectProjectType, startStaticServer } = await import('../lib/static-server');
      vi.mocked(detectProjectType).mockResolvedValue('statichtml');
      vi.mocked(startStaticServer).mockResolvedValue(9090);

      const { result } = renderHook(() => useDevServer('/path/to/project'));

      let detectedType: string | undefined;
      await act(async () => {
        detectedType = await result.current.startServerForProject(
          '/path/to/project',
          'my-project',
          3000,
          'main'
        );
      });

      expect(detectedType).toBe('statichtml');
      expect(result.current.projectType).toBe('statichtml');
      expect(result.current.devServerPort).toBe(9090);
      expect(startStaticServer).toHaveBeenCalledWith('main', '/path/to/project');
    });

    it('starts dev server for non-static projects', async () => {
      const { detectProjectType } = await import('../lib/static-server');
      const { startDevServer } = await import('../lib/project');
      vi.mocked(detectProjectType).mockResolvedValue('nextjs');

      const { result } = renderHook(() => useDevServer('/path/to/project'));

      await act(async () => {
        await result.current.startServerForProject('/path/to/project', 'my-project', 3000, 'main');
      });

      expect(result.current.projectType).toBe('nextjs');
      expect(startDevServer).toHaveBeenCalledWith(
        '/path/to/project',
        3000,
        'main',
        expect.any(Function)
      );
    });

    it('defaults to unknown on detection failure', async () => {
      const { detectProjectType } = await import('../lib/static-server');
      vi.mocked(detectProjectType).mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useDevServer('/path/to/project'));

      let detectedType: string | undefined;
      await act(async () => {
        detectedType = await result.current.startServerForProject(
          '/path/to/project',
          'my-project',
          3000,
          'main'
        );
      });

      expect(detectedType).toBe('unknown');
    });
  });

  describe('stopServer', () => {
    it('clears project type', async () => {
      const { result } = renderHook(() => useDevServer('/path/to/project'));

      act(() => {
        result.current.setProjectType('nextjs');
      });

      await act(async () => {
        await result.current.stopServer();
      });

      expect(result.current.projectType).toBe('unknown');
    });
  });

  describe('per-project state (Slice 3)', () => {
    it('starting a server for one path leaves another path untouched', async () => {
      const { detectProjectType } = await import('../lib/static-server');
      vi.mocked(detectProjectType).mockResolvedValue('nextjs');

      // Hook's "current" project is /a — scalars read from /a's slot.
      const { result, rerender } = renderHook(
        ({ path }: { path: string | null }) => useDevServer(path),
        { initialProps: { path: '/a' } }
      );

      await act(async () => {
        await result.current.startServerForProject('/a', 'a', 3001, 'main');
      });
      await act(async () => {
        await result.current.startServerForProject('/b', 'b', 3002, 'main');
      });

      expect(result.current.isServerRunning('/a')).toBe(true);
      expect(result.current.isServerRunning('/b')).toBe(true);

      // Stop /a; /b's handle should survive.
      await act(async () => {
        await result.current.stopServer('/a');
      });
      expect(result.current.isServerRunning('/a')).toBe(false);
      expect(result.current.isServerRunning('/b')).toBe(true);

      // Switch the "current" view to /b and confirm its scalars are visible.
      rerender({ path: '/b' });
      expect(result.current.devServerPort).toBe(3002);
      expect(result.current.projectType).toBe('nextjs');
    });

    it('stopAllServers reaps every live handle', async () => {
      const { detectProjectType } = await import('../lib/static-server');
      vi.mocked(detectProjectType).mockResolvedValue('nextjs');

      const { result } = renderHook(() => useDevServer('/a'));

      await act(async () => {
        await result.current.startServerForProject('/a', 'a', 3001, 'main');
        await result.current.startServerForProject('/b', 'b', 3002, 'main');
        await result.current.startServerForProject('/c', 'c', 3003, 'main');
      });

      expect(result.current.isServerRunning('/a')).toBe(true);
      expect(result.current.isServerRunning('/b')).toBe(true);
      expect(result.current.isServerRunning('/c')).toBe(true);

      await act(async () => {
        await result.current.stopAllServers();
      });

      expect(result.current.isServerRunning('/a')).toBe(false);
      expect(result.current.isServerRunning('/b')).toBe(false);
      expect(result.current.isServerRunning('/c')).toBe(false);
    });
  });
});
