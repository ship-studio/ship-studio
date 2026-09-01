import { describe, it, expect, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { dedupeKey, shouldReport, reportError, isResourcePressureError } from './errorReporting';

afterEach(() => {
  clearMocks();
});

describe('dedupeKey', () => {
  it('prefers the explicit fingerprint', () => {
    expect(
      dedupeKey({ message: 'anything', source: 'publishing', fingerprint: 'publish-io-error' })
    ).toBe('publish-io-error');
  });

  it('falls back to source + message', () => {
    expect(dedupeKey({ message: 'boom', source: 'window-error' })).toBe('window-error:boom');
  });

  it('defaults source to frontend and truncates long messages', () => {
    const key = dedupeKey({ message: 'x'.repeat(500) });
    expect(key).toBe(`frontend:${'x'.repeat(200)}`);
  });
});

describe('shouldReport', () => {
  it('allows the first occurrence and blocks repeats', () => {
    const report = { message: 'unique-dedup-test-error', fingerprint: 'unique-dedup-test' };
    expect(shouldReport(report)).toBe(true);
    expect(shouldReport(report)).toBe(false);
  });

  it('treats different fingerprints independently', () => {
    expect(shouldReport({ message: 'a', fingerprint: 'independent-test-a' })).toBe(true);
    expect(shouldReport({ message: 'a', fingerprint: 'independent-test-b' })).toBe(true);
  });
});

describe('isResourcePressureError', () => {
  const message =
    "Couldn't start `opencode` — your system is temporarily low on process resources or open files. Close some apps or terminal tabs and try again.";

  it('recognizes spawn_resource_pressure_error as a CommandError object (#772/#773/#775)', () => {
    expect(isResourcePressureError({ type: 'Other', message })).toBe(true);
  });

  it('recognizes it as a plain string or Error', () => {
    expect(isResourcePressureError(message)).toBe(true);
    expect(isResourcePressureError(new Error(message))).toBe(true);
  });

  it('leaves genuine spawn failures reporting as bugs', () => {
    expect(isResourcePressureError('binary not found: no viable candidates found in PATH')).toBe(
      false
    );
    expect(isResourcePressureError(undefined)).toBe(false);
  });
});

describe('reportError', () => {
  it('does not invoke the backend in dev/test builds', () => {
    let invoked = false;
    mockIPC(() => {
      invoked = true;
    });
    reportError({ message: 'dev-build error', fingerprint: 'dev-build-gate-test' });
    expect(invoked).toBe(false);
  });

  it('never throws, even with no IPC mock installed', () => {
    expect(() => reportError({ message: 'no-ipc error' })).not.toThrow();
  });
});
