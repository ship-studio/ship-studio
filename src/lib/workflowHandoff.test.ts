import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHandoff, consumeHandoff, peekHandoff, queueHandoff } from './workflowHandoff';

afterEach(() => {
  clearHandoff();
  vi.useRealTimers();
});

describe('workflowHandoff', () => {
  it('returns a queued prompt only for its own project', () => {
    queueHandoff('/p/one', 'fix the thing');
    expect(peekHandoff('/p/one')).toBe('fix the thing');
    expect(peekHandoff('/p/two')).toBeNull();
  });

  it('peeking does not consume, so a retry loop can wait for a terminal', () => {
    queueHandoff('/p/one', 'fix the thing');
    expect(peekHandoff('/p/one')).toBe('fix the thing');
    expect(peekHandoff('/p/one')).toBe('fix the thing');
  });

  it('consuming delivers exactly once', () => {
    queueHandoff('/p/one', 'fix the thing');
    expect(peekHandoff('/p/one')).toBe('fix the thing');
    consumeHandoff();
    expect(peekHandoff('/p/one')).toBeNull();
  });

  it('expires rather than ambushing an unrelated terminal later', () => {
    vi.useFakeTimers();
    queueHandoff('/p/one', 'fix the thing');
    vi.advanceTimersByTime(2 * 60_000);
    expect(peekHandoff('/p/one')).toBe('fix the thing');
    vi.advanceTimersByTime(2 * 60_000);
    expect(peekHandoff('/p/one')).toBeNull();
  });

  it('keeps only the most recent prompt', () => {
    queueHandoff('/p/one', 'first');
    queueHandoff('/p/one', 'second');
    expect(peekHandoff('/p/one')).toBe('second');
  });

  it('queueing for another project replaces the pending one', () => {
    queueHandoff('/p/one', 'first');
    queueHandoff('/p/two', 'second');
    expect(peekHandoff('/p/one')).toBeNull();
    expect(peekHandoff('/p/two')).toBe('second');
  });
});
