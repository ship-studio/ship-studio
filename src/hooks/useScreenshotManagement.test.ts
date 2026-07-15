/**
 * Tests for the auto-capture consent gate (#160).
 *
 * The background thumbnail capture must never trigger the macOS
 * "record screen content" prompt without context:
 * - first run (never asked) → defer the capture and show the explainer
 * - opted out → never capture
 * - allowed → capture proceeds
 * - permission-denial failure → persist the opt-out, stop retrying
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useScreenshotManagement } from './useScreenshotManagement';
import type { PreviewHandle } from '../components/preview/Preview';
import { getThumbnailsEnabled, setThumbnailsEnabled } from '../lib/settings';

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/settings', () => ({
  getThumbnailsEnabled: vi.fn(),
  setThumbnailsEnabled: vi.fn().mockResolvedValue(undefined),
}));

const PROJECT = '/Users/test/ShipStudio/demo';

function makeParams() {
  return {
    previewRef: {
      current: { isServerReady: () => true },
    } as unknown as RefObject<PreviewHandle | null>,
    devServerPort: 3000,
    pasteToActiveTerminal: vi.fn(),
    currentProjectPathRef: { current: PROJECT } as unknown as RefObject<string | null>,
  };
}

/** Fire the preview-ready signal and run past the 8s capture delay. */
async function triggerAutoCapture(result: { current: ReturnType<typeof useScreenshotManagement> }) {
  act(() => {
    result.current.handlePreviewReady(PROJECT);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });
}

describe('useScreenshotManagement auto-capture consent gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    invokeMock.mockResolvedValue('/thumb.png');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('first run: defers the capture and shows the explainer instead', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(null);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.showThumbnailConsent).toBe(true);
  });

  it('opted out: never captures and never asks again', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(false);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.showThumbnailConsent).toBe(false);
  });

  it('allowed: capture proceeds without asking', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(true);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);

    expect(result.current.showThumbnailConsent).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('capture_project_thumbnail', {
      projectPath: PROJECT,
      url: 'http://localhost:3000',
    });
  });

  it('"Allow thumbnails": persists opt-in and runs the deferred capture', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);
    expect(result.current.showThumbnailConsent).toBe(true);

    vi.mocked(getThumbnailsEnabled).mockResolvedValue(true);
    await act(async () => {
      await result.current.resolveThumbnailConsent(true);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setThumbnailsEnabled).toHaveBeenCalledWith(true);
    expect(result.current.showThumbnailConsent).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('capture_project_thumbnail', {
      projectPath: PROJECT,
      url: 'http://localhost:3000',
    });
  });

  it('"No thumbnails": persists opt-out and does not capture', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);

    vi.mocked(getThumbnailsEnabled).mockResolvedValue(false);
    await act(async () => {
      await result.current.resolveThumbnailConsent(false);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setThumbnailsEnabled).toHaveBeenCalledWith(false);
    expect(result.current.showThumbnailConsent).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dismissing the explainer defers for the session instead of nagging', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(null);
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);
    expect(result.current.showThumbnailConsent).toBe(true);

    act(() => {
      result.current.dismissThumbnailConsent();
    });

    // Next scheduled capture (e.g. the 5-minute interval) stays silent.
    await triggerAutoCapture(result);
    expect(result.current.showThumbnailConsent).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(setThumbnailsEnabled).not.toHaveBeenCalled();
  });

  it('permission-denial failure: persists opt-out and stops retrying', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(true);
    invokeMock.mockRejectedValue('Screen recording permission denied by TCC');
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);

    expect(setThumbnailsEnabled).toHaveBeenCalledWith(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Past the retry delay: no second attempt was scheduled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('non-denial failure keeps the retry behavior', async () => {
    vi.mocked(getThumbnailsEnabled).mockResolvedValue(true);
    invokeMock.mockRejectedValue('Dev server not responding, skipping thumbnail capture');
    const { result } = renderHook(() => useScreenshotManagement(makeParams()));

    await triggerAutoCapture(result);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Retry fires after the 3s delay and thumbnails stay enabled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(setThumbnailsEnabled).not.toHaveBeenCalled();
  });
});
