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

// Held as standalone spies so assertions never reference `logger.error` as a
// value (lint's unbound-method rule).
const loggerSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../lib/logger', () => ({ logger: loggerSpies }));

// The native screenshot plugin, with a gate the unmount tests hold open so
// they can tear the preview down while the capture is genuinely in flight.
let screenshotGate: Promise<void> = Promise.resolve();
vi.mock('tauri-plugin-screenshots-api', () => ({
  getScreenshotableWindows: async () => {
    await screenshotGate;
    return [{ id: 1, title: 'Harbr' }];
  },
  getWindowScreenshot: () => Promise.resolve('/tmp/shot.png'),
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

/**
 * Issue #914: taking the window screenshot is a dynamic import plus a native
 * round trip. The preview can unmount inside that gap — `handleCropMouseUp`
 * even flips the crop overlay off immediately before awaiting the capture —
 * and dereferencing the ref a second time afterwards threw
 * "null is not an object (evaluating '_.current.getBoundingClientRect')".
 *
 * The throw was caught, so nothing crashed; what it did instead was worse to
 * live with. Every such unmount was logged at error level, which auto-files a
 * bug report, and the viewport path additionally toasted the user about a
 * capture they had already walked away from. Nobody unmounting a preview has
 * done anything wrong, so the tests below assert on the *reporting*, not on
 * whether an exception escaped.
 */
describe('usePreviewCapture when the preview goes away mid-capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    screenshotGate = Promise.resolve();
    invokeMock.mockResolvedValue('/tmp/cropped.png');
  });

  /** Attach a live wrapper element and hand back a detach function. */
  function mountWrapper(result: {
    current: { iframeWrapperRef: { current: HTMLElement | null } };
  }) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    result.current.iframeWrapperRef.current = el;
    return () => {
      result.current.iframeWrapperRef.current = null;
      el.remove();
    };
  }

  /** Hold the screenshot open until the returned function is called. */
  function holdScreenshot() {
    let release!: () => void;
    screenshotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  it('crops normally when the preview stays mounted', async () => {
    const { result } = renderHook(() => usePreviewCapture(baseParams), { wrapper });
    mountWrapper(result);

    let captured: string | null = null;
    await act(async () => {
      captured = await result.current.captureRegion(0, 0, 100, 100);
    });

    expect(captured).toBe('/tmp/cropped.png');
    expect(invokeMock).toHaveBeenCalledWith('crop_and_save_screenshot', expect.anything());
  });

  it('returns null instead of throwing when the preview unmounts mid-region-capture', async () => {
    const release = holdScreenshot();
    const { result } = renderHook(() => usePreviewCapture(baseParams), { wrapper });
    const unmountPreview = mountWrapper(result);

    let captured: string | null = 'unset';
    await act(async () => {
      const pending = result.current.captureRegion(0, 0, 100, 100).then((r) => {
        captured = r;
      });
      unmountPreview();
      release();
      await pending;
    });

    expect(captured).toBeNull();
    // And nothing was cropped from a detached element's all-zero rect.
    expect(invokeMock).not.toHaveBeenCalledWith('crop_and_save_screenshot', expect.anything());
    // Walking away from a capture is not a fault to file.
    expect(loggerSpies.error).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the preview unmounts mid-viewport-capture', async () => {
    const release = holdScreenshot();
    const { result } = renderHook(() => usePreviewCapture(baseParams), { wrapper });
    const unmountPreview = mountWrapper(result);

    let captured: string | null = 'unset';
    await act(async () => {
      const pending = result.current.captureForClaude().then((r) => {
        captured = r;
      });
      unmountPreview();
      release();
      await pending;
    });

    expect(captured).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('crop_and_save_screenshot', expect.anything());
    expect(loggerSpies.error).not.toHaveBeenCalled();
    // …nor to interrupt the user about.
    expect(showToast).not.toHaveBeenCalled();
  });
});
