/**
 * Issue #786: a health check that couldn't even run — e.g. the project's
 * package manager isn't installed — is a known environment gap the backend
 * marks `Expected`, not an app malfunction. `runCheck`'s catch block used to
 * always toast 'error', which re-reports to telemetry and produced the
 * recurring, unhelpfully generic "Test failed" bug reports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCodeHealth } from './useCodeHealth';
import * as health from '../lib/health';
import type { DetectedScripts } from '../lib/health';
import { logger } from '../lib/logger';

vi.mock('../lib/health', async () => {
  const actual = await vi.importActual<typeof import('../lib/health')>('../lib/health');
  return {
    ...actual,
    detectHealthScripts: vi.fn(),
    getHealthStatus: vi.fn(),
    runHealthScript: vi.fn(),
  };
});

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const detectHealthScripts = vi.mocked(health.detectHealthScripts);
const getHealthStatus = vi.mocked(health.getHealthStatus);
const runHealthScript = vi.mocked(health.runHealthScript);

const SCRIPTS: DetectedScripts = {
  packageManager: 'npm',
  hasPackageJson: true,
  test: 'test',
  lint: null,
  typecheck: null,
  format: null,
  suggestions: [],
};

describe('useCodeHealth runCheck error toasts (#786)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectHealthScripts.mockResolvedValue(SCRIPTS);
    getHealthStatus.mockResolvedValue(null);
  });

  it('toasts info, not error, when the backend rejects with an Expected CommandError', async () => {
    runHealthScript.mockRejectedValue({
      type: 'Other',
      message:
        "This project uses bun, but it isn't installed or not on PATH, so health checks can't run.",
      expected: true,
    });
    const onToast = vi.fn<(message: string, type?: 'success' | 'error' | 'info') => void>();
    const { result } = renderHook(() => useCodeHealth({ projectPath: '/tmp/project', onToast }));
    // Let the mount-time script detection resolve before running a check.
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.runCheck('test');
    });

    const toastTypes = onToast.mock.calls.map((call) => call[1]);
    expect(toastTypes).toContain('info');
    expect(toastTypes).not.toContain('error');
  });

  it('still toasts error for a genuine, unclassified failure', async () => {
    runHealthScript.mockRejectedValue({
      type: 'Other',
      message: 'Something actually went wrong',
    });
    const onToast = vi.fn<(message: string, type?: 'success' | 'error' | 'info') => void>();
    const { result } = renderHook(() => useCodeHealth({ projectPath: '/tmp/project', onToast }));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.runCheck('test');
    });

    const toastTypes = onToast.mock.calls.map((call) => call[1]);
    expect(toastTypes).toContain('error');
  });
});

describe('useCodeHealth script detection logging (#1091)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealthStatus.mockResolvedValue(null);
  });

  it('warns, not errors, when the project folder no longer exists', async () => {
    const message =
      "The folder '<project>' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio";
    detectHealthScripts.mockRejectedValue({ type: 'Other', message, expected: true });

    renderHook(() => useCodeHealth({ projectPath: '/tmp/project' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(logger.warn).toHaveBeenCalledWith('Failed to detect health scripts', {
      error: message,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still logs an error for an unclassified detection failure', async () => {
    detectHealthScripts.mockRejectedValue({ type: 'Other', message: 'Something broke' });

    renderHook(() => useCodeHealth({ projectPath: '/tmp/project' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(logger.error).toHaveBeenCalledWith('Failed to detect health scripts', {
      error: 'Something broke',
    });
  });
});
