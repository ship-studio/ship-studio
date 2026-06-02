import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDevServer, filterProbeChunk, isProbeLine } from './useDevServer';

// Mock external dependencies
vi.mock('../lib/project', () => ({
  startDevServer: vi.fn().mockResolvedValue({
    pty: { kill: vi.fn() },
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  getCustomDevCommand: vi.fn().mockResolvedValue(null),
  setCustomDevCommand: vi.fn().mockResolvedValue(undefined),
  getWorkspaceSubpath: vi.fn().mockResolvedValue(null),
  resolveWorkspacePath: (path: string, subpath: string | null) =>
    subpath ? `${path}/${subpath}` : path,
}));

vi.mock('../lib/static-server', () => ({
  detectProjectType: vi.fn().mockResolvedValue('unknown'),
  startStaticServer: vi.fn().mockResolvedValue(8080),
  stopStaticServer: vi.fn().mockResolvedValue(undefined),
  isMobileProjectType: (type: string) => type === 'reactnative' || type === 'flutter',
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
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks wipes the mockResolvedValue defaults from the factory, so
    // re-apply the ones that the production code awaits unconditionally.
    const project = await import('../lib/project');
    vi.mocked(project.startDevServer).mockResolvedValue({
      pty: { kill: vi.fn() } as never,
      stop: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(project.getCustomDevCommand).mockResolvedValue(null);
    vi.mocked(project.getWorkspaceSubpath).mockResolvedValue(null);
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

    it('does not start a web dev server for native mobile projects', async () => {
      const { detectProjectType } = await import('../lib/static-server');
      const { startDevServer } = await import('../lib/project');
      vi.mocked(detectProjectType).mockResolvedValue('reactnative');

      const { result } = renderHook(() => useDevServer('/path/to/mobile'));

      await act(async () => {
        await result.current.startServerForProject('/path/to/mobile', 'mobile', 3000, 'main');
      });

      expect(result.current.projectType).toBe('reactnative');
      expect(startDevServer).not.toHaveBeenCalled();
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

describe('isProbeLine', () => {
  it('matches a Next.js style GET / line', () => {
    expect(isProbeLine('GET / 200 in 2ms')).toBe(true);
  });

  it('matches a HEAD / probe', () => {
    expect(isProbeLine('HEAD / 304')).toBe(true);
  });

  it('matches a bracket-status timestamp format', () => {
    expect(isProbeLine('17:49:56 [200] / 4ms')).toBe(true);
  });

  it('matches a 304 bracket-status', () => {
    expect(isProbeLine('17:49:56 [304] / 1ms')).toBe(true);
  });

  it('matches an Apache / morgan combined log', () => {
    expect(isProbeLine('127.0.0.1 - - [29/Apr/2026:10:00:00] "GET / HTTP/1.1" 200 -')).toBe(true);
  });

  it('strips ANSI escape sequences before matching', () => {
    expect(isProbeLine('\x1b[32mGET / 200\x1b[0m in 2ms')).toBe(true);
  });

  it('does not match a request to a different path', () => {
    expect(isProbeLine('GET /api/foo 200 in 2ms')).toBe(false);
    expect(isProbeLine('GET /favicon.ico 304')).toBe(false);
  });

  it('does not match narrative log lines that contain "GET /"', () => {
    expect(isProbeLine('Last request was GET / 200')).toBe(false);
    expect(isProbeLine('Cannot GET / on this server')).toBe(false);
  });

  it('does not match a different method', () => {
    expect(isProbeLine('POST / 200')).toBe(false);
  });

  it('does not match an empty or whitespace-only line', () => {
    expect(isProbeLine('')).toBe(false);
    expect(isProbeLine('   ')).toBe(false);
  });
});

describe('filterProbeChunk', () => {
  it('drops a single complete probe line', () => {
    const result = filterProbeChunk('', 'GET / 200 in 2ms\n');
    expect(result.kept).toBe('');
    expect(result.pending).toBe('');
  });

  it('keeps a non-probe line', () => {
    const result = filterProbeChunk('', 'GET /api/foo 200 in 2ms\n');
    expect(result.kept).toBe('GET /api/foo 200 in 2ms\n');
    expect(result.pending).toBe('');
  });

  it('keeps a real line and drops a probe line in the same chunk', () => {
    const chunk = 'GET /api/foo 200\nGET / 200\nGET /bar 200\n';
    const result = filterProbeChunk('', chunk);
    expect(result.kept).toBe('GET /api/foo 200\nGET /bar 200\n');
    expect(result.pending).toBe('');
  });

  it('buffers an incomplete trailing line as pending', () => {
    const result = filterProbeChunk('', 'GET /api/foo');
    expect(result.kept).toBe('');
    expect(result.pending).toBe('GET /api/foo');
  });

  it('joins a probe line split across two chunks and drops it', () => {
    const first = filterProbeChunk('', 'GET /');
    expect(first.kept).toBe('');
    expect(first.pending).toBe('GET /');

    const second = filterProbeChunk(first.pending, ' 200 in 2ms\n');
    expect(second.kept).toBe('');
    expect(second.pending).toBe('');
  });

  it('joins a real line split across two chunks and keeps it', () => {
    const first = filterProbeChunk('', 'GET /api');
    expect(first.kept).toBe('');
    expect(first.pending).toBe('GET /api');

    const second = filterProbeChunk(first.pending, '/foo 200\n');
    expect(second.kept).toBe('GET /api/foo 200\n');
    expect(second.pending).toBe('');
  });

  it('preserves the trailing newline when only probe lines are present', () => {
    const result = filterProbeChunk('', 'GET / 200\nGET / 304\n');
    expect(result.kept).toBe('');
    expect(result.pending).toBe('');
  });

  it('does not filter narrative log lines that mention GET /', () => {
    const result = filterProbeChunk('', 'Last request was GET / 200\n');
    expect(result.kept).toBe('Last request was GET / 200\n');
    expect(result.pending).toBe('');
  });

  it('handles an empty chunk', () => {
    const result = filterProbeChunk('', '');
    expect(result.kept).toBe('');
    expect(result.pending).toBe('');
  });

  it('strips probe lines wrapped in ANSI color codes', () => {
    const chunk = '\x1b[32mGET / 200\x1b[0m in 2ms\n';
    const result = filterProbeChunk('', chunk);
    expect(result.kept).toBe('');
    expect(result.pending).toBe('');
  });
});
