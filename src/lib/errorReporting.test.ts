import { describe, it, expect, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { dedupeKey, shouldReport, reportError } from './errorReporting';

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
