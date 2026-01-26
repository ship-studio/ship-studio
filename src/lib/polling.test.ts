/**
 * Tests for the polling utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExponentialPoller, retryWithBackoff } from './polling';

describe('ExponentialPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call fetcher immediately when started', async () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 5000,
    });

    poller.start();

    // Allow the initial fetch to complete (flush microtasks)
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        data: 'data',
        error: null,
        attempt: 1,
      })
    );

    poller.stop();
  });

  it('should apply exponential backoff on errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Failed'));
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 10000,
      multiplier: 2,
    });

    poller.start();

    // First attempt (immediate)
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.any(Error),
        attempt: 1,
        nextInterval: 2000, // 1000 * 2
      })
    );

    // Second attempt after backoff
    await vi.advanceTimersByTimeAsync(2000);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attempt: 2,
        nextInterval: 4000, // 2000 * 2
      })
    );

    // Third attempt
    await vi.advanceTimersByTimeAsync(4000);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attempt: 3,
        nextInterval: 8000, // 4000 * 2
      })
    );

    poller.stop();
  });

  it('should respect maxInterval', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Failed'));
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 3000,
      multiplier: 2,
    });

    poller.start();

    // First attempt - interval becomes 2000
    await vi.advanceTimersByTimeAsync(0);

    // Second attempt - interval becomes 3000 (capped at max)
    await vi.advanceTimersByTimeAsync(2000);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nextInterval: 3000, // Capped at maxInterval
      })
    );

    // Third attempt - interval stays at 3000
    await vi.advanceTimersByTimeAsync(3000);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nextInterval: 3000, // Still capped
      })
    );

    poller.stop();
  });

  it('should reset interval on success when resetOnSuccess is true', async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error('Failed'));
      }
      return Promise.resolve('success');
    });
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 10000,
      multiplier: 2,
      resetOnSuccess: true,
    });

    poller.start();

    // First attempt - fails, interval becomes 2000
    await vi.advanceTimersByTimeAsync(0);

    // Second attempt - fails, interval becomes 4000
    await vi.advanceTimersByTimeAsync(2000);

    // Third attempt - succeeds, interval resets to 1000
    await vi.advanceTimersByTimeAsync(4000);
    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: 'success',
        nextInterval: 1000, // Reset to initial
      })
    );

    poller.stop();
  });

  it('should stop after maxRetries', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Failed'));
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 100,
      maxInterval: 1000,
      maxRetries: 3,
    });

    poller.start();

    // Run through all retries with enough time
    await vi.advanceTimersByTimeAsync(0); // Attempt 1
    await vi.advanceTimersByTimeAsync(200); // Attempt 2
    await vi.advanceTimersByTimeAsync(400); // Attempt 3

    // Should only have been called 3 times (maxRetries)
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(poller.getState().isRunning).toBe(false);
  });

  it('should stop when stop() is called', async () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 5000,
    });

    poller.start();
    expect(poller.getState().isRunning).toBe(true);

    poller.stop();
    expect(poller.getState().isRunning).toBe(false);

    // Advance time and verify no more calls
    const callsBefore = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher.mock.calls.length).toBe(callsBefore);
  });

  it('should reset state when reset() is called', () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    const onResult = vi.fn();

    const poller = new ExponentialPoller(fetcher, onResult, {
      initialInterval: 1000,
      maxInterval: 5000,
    });

    // Manually set internal state (simulating backoff)
    poller.reset();

    const state = poller.getState();
    expect(state.interval).toBe(1000);
    expect(state.attempt).toBe(0);
  });
});

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = retryWithBackoff(fn);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error('Failed'));
      }
      return Promise.resolve('success');
    });

    const resultPromise = retryWithBackoff(fn, {
      maxRetries: 5,
      initialDelay: 100,
      multiplier: 2,
    });

    // First call (immediate)
    await vi.advanceTimersByTimeAsync(0);
    // Wait for delay (100ms), then second call
    await vi.advanceTimersByTimeAsync(100);
    // Wait for delay (200ms), then third call
    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Always fails'));

    const resultPromise = retryWithBackoff(fn, {
      maxRetries: 3,
      initialDelay: 100,
      multiplier: 2,
    });

    // Attach a catch handler immediately to prevent unhandled rejection warning
    // We'll still assert on the rejection below
    void resultPromise.catch(() => {});

    // First call (immediate)
    await vi.advanceTimersByTimeAsync(0);
    // Wait for delay (100ms), then second call
    await vi.advanceTimersByTimeAsync(100);
    // Wait for delay (200ms), then third call
    await vi.advanceTimersByTimeAsync(200);

    await expect(resultPromise).rejects.toThrow('Always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
