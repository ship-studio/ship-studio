import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewConnection } from './usePreviewConnection';

// The hook reaches for Tauri IPC, the proxy, analytics, and a logger on the
// readiness path; stub them all so the test exercises only the fetch-probe loop.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === 'start_preview_proxy') return Promise.resolve(8080);
    if (cmd === 'list_pages') return Promise.resolve([]);
    return Promise.resolve(undefined);
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/window', () => ({
  getWindowLabel: vi.fn().mockReturnValue('main'),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const baseParams = {
  port: 3000,
  projectPath: '/path/to/project',
  isDevServerRestarting: false,
  isStaticProject: false,
};

/** Hook a controllable fetch that mimics a dev server: the request stays open
 *  (as Next.js / Turbopack holds it during an on-demand compile) and rejects
 *  with an AbortError if its signal fires. Returns helpers to inspect the
 *  in-flight signal and to "finish compiling". */
function installSlowServerFetch() {
  const signals: AbortSignal[] = [];
  let resolveResponse: (() => void) | undefined;

  const fetchMock = vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
    if (opts?.signal) signals.push(opts.signal);
    return new Promise((resolve, reject) => {
      // Latest call wins — the probe we ultimately "finish" is the in-flight one.
      resolveResponse = () => resolve({} as Response);
      opts?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      );
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    callCount: () => signals.length,
    lastSignal: () => signals[signals.length - 1],
    finishCompile: () => resolveResponse?.(),
  };
}

describe('usePreviewConnection readiness probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('rides a slow first compile (>3s) instead of aborting the probe', async () => {
    const server = installSlowServerFetch();
    const { result, unmount } = renderHook(() => usePreviewConnection(baseParams));

    expect(result.current.serverReady).toBe(false);
    expect(result.current.isLoading).toBe(true);

    // The mount effect gates the readiness probe behind a 1.5s settle timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(server.fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.objectContaining({ mode: 'no-cors' })
    );
    const callsWhileCompiling = server.callCount();

    // Advance well past the old 3s timeout (to ~10s) while the server is still
    // compiling (response withheld). The readiness probe must RIDE that single
    // in-flight request — no new probe should fire. This is the exact
    // regression: a 3s timeout aborted the probe at ~3s and the retry backoff
    // fired fresh probes, so the count would climb here and the (slow) success
    // was never observed, even though a plain browser loads the page fine.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500);
    });
    expect(server.callCount()).toBe(callsWhileCompiling);
    expect(result.current.serverReady).toBe(false);

    // The dev server finishes compiling and responds — preview opens. Flush the
    // follow-on effects (proxy start, page load) so their state updates settle
    // inside act() rather than leaking past the assertion.
    await act(async () => {
      server.finishCompile();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.serverReady).toBe(true);
    expect(result.current.isLoading).toBe(false);

    // Tear down inside act() so the effect cleanups (proxy stop, interval clear)
    // don't update state after the test and trip React's act() warning.
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('Stop aborts the in-flight probe instead of leaving a 30s fetch running', async () => {
    const server = installSlowServerFetch();
    const { result, unmount } = renderHook(() => usePreviewConnection(baseParams));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const signal = server.lastSignal();
    expect(signal?.aborted).toBe(false);
    const callsBeforeStop = server.callCount();

    // User hits Stop while the probe is mid-compile.
    await act(async () => {
      result.current.stopConnecting();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(signal?.aborted).toBe(true);
    expect(result.current.isStopped).toBe(true);

    // And no further probe fires afterward — the aborted probe must not schedule
    // a retry behind the user's back, even past the longest backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(server.callCount()).toBe(callsBeforeStop);

    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
