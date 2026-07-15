import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { usePreviewCapture } from './usePreviewCapture';
import { ToastContext } from '../contexts/ToastContext';
import { trackEvent } from '../lib/analytics';

// Stub Tauri IPC, analytics, and the logger so the test exercises only the
// capture flow. `capture_fullpage_playwright` behavior is set per-test.
const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const showToast = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      {children}
    </ToastContext.Provider>
  );
}

const baseParams = {
  projectPath: '/path/to/project',
  baseUrl: 'http://localhost:8080',
  currentPage: '/',
};

describe('usePreviewCapture full-page capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces a toast and reports fallback_success when playwright capture fails', async () => {
    invokeMock.mockRejectedValue(new Error('playwright is not installed'));

    const { result } = renderHook(() => usePreviewCapture(baseParams), { wrapper });

    let filePath: string | null = 'sentinel';
    await act(async () => {
      filePath = await result.current.captureFullPage();
    });

    // The viewport fallback also fails here (no iframe wrapper mounted), so
    // the whole capture returns null...
    expect(filePath).toBeNull();

    // ...the user is told the full page couldn't be captured...
    expect(showToast).toHaveBeenCalledWith(
      "Full-page capture isn't available — captured the visible area instead.",
      'error'
    );

    // ...and a single fullpage event carries the failure + fallback outcome.
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('screenshot_captured', {
      mode: 'fullpage',
      success: false,
      fell_back: true,
      fallback_success: false,
    });
  });

  it('does not toast when the full-page capture succeeds', async () => {
    invokeMock.mockResolvedValue('/path/to/project/.shipstudio/screenshots/fullpage-1.png');

    const { result } = renderHook(() => usePreviewCapture(baseParams), { wrapper });

    let filePath: string | null = null;
    await act(async () => {
      filePath = await result.current.captureFullPage();
    });

    expect(filePath).toBe('/path/to/project/.shipstudio/screenshots/fullpage-1.png');
    expect(showToast).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('screenshot_captured', {
      mode: 'fullpage',
      success: true,
      fell_back: false,
    });
  });
});
