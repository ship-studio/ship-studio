import { describe, it, expect } from 'vitest';
import { decideAutoCapture, isPermissionDenialError } from './thumbnailGate';

describe('decideAutoCapture', () => {
  it('defers and asks on first run (consent never given)', () => {
    expect(decideAutoCapture(null)).toBe('ask');
  });

  it('never captures when the user opted out', () => {
    expect(decideAutoCapture(false)).toBe('skip');
  });

  it('proceeds when the user allowed thumbnails', () => {
    expect(decideAutoCapture(true)).toBe('proceed');
  });
});

describe('isPermissionDenialError', () => {
  it('detects the explicit macOS screen-recording denial message', () => {
    expect(
      isPermissionDenialError(
        new Error(
          "Ship Studio's window isn't visible to macOS screen capture — Screen Recording permission is likely denied."
        )
      )
    ).toBe(true);
  });

  it('detects plugin errors mentioning ScreenCaptureKit authorization', () => {
    expect(isPermissionDenialError('SCStream error: not authorized to capture')).toBe(true);
    expect(isPermissionDenialError(new Error('TCC denied screen recording for Ship Studio'))).toBe(
      true
    );
  });

  it('detects CommandError objects, not just Error instances', () => {
    expect(
      isPermissionDenialError({
        type: 'Other',
        message: 'Screen recording permission denied by the user',
      })
    ).toBe(true);
  });

  it('does not flag unrelated capture failures', () => {
    expect(isPermissionDenialError('Dev server not responding, skipping thumbnail capture')).toBe(
      false
    );
    expect(isPermissionDenialError(new Error('playwright is not installed'))).toBe(false);
    expect(
      isPermissionDenialError(
        'No supported browser found for screenshots (Chrome, Chromium, or Edge required)'
      )
    ).toBe(false);
  });

  it('does not flag generic filesystem permission errors', () => {
    expect(
      isPermissionDenialError(new Error("EACCES: permission denied, open '/tmp/thumbnail.png'"))
    ).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isPermissionDenialError(null)).toBe(false);
    expect(isPermissionDenialError(undefined)).toBe(false);
  });
});
