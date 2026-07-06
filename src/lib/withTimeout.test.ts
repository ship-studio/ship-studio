/**
 * Tests for the promise timeout helpers used on the boot path (#173).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, withTimeoutFallback, TimeoutError } from './withTimeout';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles before the deadline', async () => {
    const result = withTimeout(Promise.resolve('ok'), 1000, 'test');
    await expect(result).resolves.toBe('ok');
  });

  it('rejects with a TimeoutError when the promise hangs past the deadline', async () => {
    const hang = new Promise<string>(() => {});
    const result = withTimeout(hang, 1000, 'Setup check');
    const assertion = expect(result).rejects.toThrowError(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('includes the label and duration in the timeout message', async () => {
    const hang = new Promise<string>(() => {});
    const result = withTimeout(hang, 500, 'CLI status refresh');
    const assertion = expect(result).rejects.toThrow('CLI status refresh timed out after 500ms');
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('propagates the original rejection unchanged', async () => {
    const boom = new Error('backend exploded');
    const result = withTimeout(Promise.reject(boom), 1000, 'test');
    await expect(result).rejects.toBe(boom);
  });

  it('does not reject after the promise already resolved', async () => {
    const result = withTimeout(Promise.resolve(42), 1000, 'test');
    await expect(result).resolves.toBe(42);
    // Advancing past the deadline must not surface a late unhandled rejection.
    await vi.advanceTimersByTimeAsync(2000);
  });
});

describe('withTimeoutFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the promise settles before the deadline', async () => {
    const result = withTimeoutFallback(Promise.resolve('fast'), 1000, 'fallback');
    await expect(result).resolves.toBe('fast');
  });

  it('resolves with the fallback when the promise hangs past the deadline', async () => {
    const hang = new Promise<string>(() => {});
    const result = withTimeoutFallback(hang, 1000, 'fallback');
    const assertion = expect(result).resolves.toBe('fallback');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('propagates the original rejection unchanged', async () => {
    const boom = new Error('spawn failed');
    const result = withTimeoutFallback(Promise.reject(boom), 1000, 'fallback');
    await expect(result).rejects.toBe(boom);
  });
});
